// cockpit as a desktop app. For now it is a window around the same local server as `npm run serve`:
// it picks a project, starts the server on a free port, shows the page, and stops the server on exit.
//   cockpit [project dir]
// Without a directory it reopens the last project, or asks for one; --pick always asks.

use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

use tauri::{RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

/// Process id of the running server, 0 when none.
static SERVER: AtomicI32 = AtomicI32::new(0);

/// Where the cockpit sources live (src/serve.ts, node_modules). Defaults to the checkout this was built from.
fn cockpit_home() -> PathBuf {
    std::env::var_os("COCKPIT_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf())
}

fn last_project_file() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("cockpit").join("last-project"))
}

/// `cockpit <dir>` opens that project, `cockpit --pick` always asks, plain `cockpit` reopens the last one.
fn pick_project(app: &tauri::AppHandle) -> Option<PathBuf> {
    let arg = std::env::args_os().nth(1);
    let pick = arg.as_deref() == Some("--pick".as_ref());
    if let (Some(arg), false) = (&arg, pick) {
        return std::fs::canonicalize(arg).ok();
    }
    let last = last_project_file()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .map(|s| PathBuf::from(s.trim()))
        .filter(|p| p.is_dir() && !pick);
    last.or_else(|| {
        app.dialog()
            .file()
            .set_title("Open a project in cockpit")
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
    })
}

fn remember(project: &Path) {
    if let Some(f) = last_project_file() {
        let _ = std::fs::create_dir_all(f.parent().unwrap());
        let _ = std::fs::write(f, project.to_string_lossy().as_bytes());
    }
}

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn show_message(win: &WebviewWindow, text: &str) {
    let js = format!(
        "document.getElementById('msg').textContent = {}; document.querySelector('.dot').style.animation = 'none';",
        serde_json::to_string(text).unwrap()
    );
    let _ = win.eval(&js);
}

fn stop_server() {
    let pid = SERVER.swap(0, Ordering::SeqCst);
    if pid > 0 {
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
}

/// Runs on its own thread for the life of the server: the server is tied to this thread
/// (it gets SIGTERM if the thread or the app dies), and the thread reports if the server stops.
fn run(app: tauri::AppHandle, win: WebviewWindow) -> Result<(), String> {
    let project = pick_project(&app).ok_or("no project chosen")?;
    remember(&project);
    let name = project.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let _ = win.set_title(&format!("{name} · cockpit"));
    show_message(&win, &format!("starting cockpit for {name}…"));

    let home = cockpit_home();
    let port = free_port().map_err(|e| format!("no free port: {e}"))?;
    // `node --import tsx` keeps it to one process, so stopping it leaves nothing behind.
    let mut child = unsafe {
        Command::new("node")
            .current_dir(&home)
            .args(["--import", "tsx", "src/serve.ts"])
            .arg(&project)
            .args(["--port", &port.to_string()])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            })
            .spawn()
    }
    .map_err(|e| format!("could not start node in {}: {e}", home.display()))?;
    SERVER.store(child.id() as i32, Ordering::SeqCst);

    // Pass the server's output through, and keep the last lines in case it fails.
    let tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    for out in [child.stdout.take().map(|o| Box::new(o) as Box<dyn std::io::Read + Send>),
                child.stderr.take().map(|e| Box::new(e) as Box<dyn std::io::Read + Send>)].into_iter().flatten() {
        let tail = tail.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                eprintln!("[server] {line}");
                let mut t = tail.lock().unwrap();
                t.push(line);
                if t.len() > 12 { t.remove(0); }
            }
        });
    }

    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!("the server stopped ({status}):\n{}", tail.lock().unwrap().join("\n")));
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() { break; }
        if started.elapsed() > Duration::from_secs(60) {
            return Err("the server did not answer within a minute".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let url: Url = format!("http://127.0.0.1:{port}/").parse().unwrap();
    win.navigate(url).map_err(|e| e.to_string())?;

    let status = child.wait().map_err(|e| e.to_string())?;
    if SERVER.swap(0, Ordering::SeqCst) != 0 {
        // Not stopped by us: go back to the loading page and say why.
        let _ = win.navigate("tauri://localhost/".parse().unwrap());
        std::thread::sleep(Duration::from_millis(500));
        return Err(format!("the server stopped ({status}):\n{}", tail.lock().unwrap().join("\n")));
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("cockpit")
                .inner_size(1600.0, 1000.0)
                .min_inner_size(800.0, 500.0)
                .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = run(handle.clone(), win.clone()) {
                    eprintln!("cockpit: {e}");
                    show_message(&win, &e);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not start the app")
        .run(|_, event| {
            if let RunEvent::Exit = event {
                stop_server();
            }
        });
}

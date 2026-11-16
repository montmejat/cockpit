// cockpit as a desktop app. For now it is a window around the same local server as `npm run serve`:
// it picks a project, starts the server on a free port, shows the page, and stops the server on exit.
// The workspace menu switches the window to another project: its own server, started the first time.
//   cockpit [project dir]
// Without a directory it reopens the last project, or asks for one; --pick always asks.

use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::StateFlags;

/// The running servers, one per project opened in this window.
struct Server { project: PathBuf, port: u16, pid: i32, ready: bool }
static SERVERS: Mutex<Vec<Server>> = Mutex::new(Vec::new());
/// The project the window shows (or is starting).
static CURRENT: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Where the cockpit sources live (src/serve.ts, node_modules). Defaults to the checkout this was built from.
fn cockpit_home() -> PathBuf {
    std::env::var_os("COCKPIT_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf())
}

/// The node to run the server with: $COCKPIT_NODE, else node on PATH, else the newest one nvm
/// installed. An app opened from the menu doesn't get the PATH that ~/.bashrc sets up for nvm.
fn find_node() -> PathBuf {
    if let Some(n) = std::env::var_os("COCKPIT_NODE") {
        return PathBuf::from(n);
    }
    let on_path = std::env::var_os("PATH").and_then(|p| {
        std::env::split_paths(&p).map(|d| d.join("node")).find(|n| n.is_file())
    });
    if let Some(n) = on_path {
        return n;
    }
    let nvm = std::env::var_os("NVM_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".nvm")));
    let newest = nvm.and_then(|d| std::fs::read_dir(d.join("versions").join("node")).ok()).and_then(|dirs| {
        let version = |p: &Path| -> Vec<u64> {
            p.file_name().unwrap_or_default().to_string_lossy().trim_start_matches('v')
                .split('.').map(|x| x.parse().unwrap_or(0)).collect()
        };
        dirs.filter_map(|e| e.ok().map(|e| e.path().join("bin").join("node")))
            .filter(|n| n.is_file())
            .max_by_key(|n| version(n.parent().unwrap().parent().unwrap()))
    });
    newest.unwrap_or_else(|| PathBuf::from("node"))
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

/// Stops every server (when the app exits).
fn stop_servers() {
    for s in SERVERS.lock().unwrap().drain(..) {
        unsafe { libc::kill(s.pid, libc::SIGTERM) };
    }
}

fn title_of(project: &Path) -> String {
    project.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The loading page (desktop/loading), saying `msg`.
fn loading_url(msg: &str) -> Url {
    let mut u: Url = "tauri://localhost/index.html".parse().unwrap();
    u.query_pairs_mut().append_pair("msg", msg);
    u
}

/// Shows `project` in the window: its server if one is running, else a new one started on its own thread.
/// The servers of the projects you switch away from keep running (their terminals and agents too),
/// so switching back is instant; they all stop with the app.
fn show_project(win: &WebviewWindow, project: PathBuf) {
    remember(&project);
    *CURRENT.lock().unwrap() = Some(project.clone());
    let name = title_of(&project);
    let _ = win.set_title(&format!("{name} · cockpit"));
    let running = SERVERS.lock().unwrap().iter().find(|s| s.project == project).map(|s| (s.port, s.ready));
    let starting = loading_url(&format!("starting cockpit for {name}…"));
    match running {
        Some((port, true)) => { let _ = win.navigate(format!("http://127.0.0.1:{port}/").parse().unwrap()); return; }
        Some((_, false)) => { let _ = win.navigate(starting); return; } // its thread shows it once it answers
        None => { let _ = win.navigate(starting); }
    }
    let win = win.clone();
    std::thread::spawn(move || {
        if let Err(e) = serve(&win, &project) {
            eprintln!("cockpit: {e}");
            if CURRENT.lock().unwrap().as_ref() == Some(&project) {
                let _ = win.navigate(loading_url(&e));
            }
        }
    });
}

/// Runs on its own thread for the life of the server: the server is tied to this thread
/// (it gets SIGTERM if the thread or the app dies), and the thread reports if the server stops.
fn serve(win: &WebviewWindow, project: &Path) -> Result<(), String> {
    let home = cockpit_home();
    let port = free_port().map_err(|e| format!("no free port: {e}"))?;
    // `node --import tsx` keeps it to one process, so stopping it leaves nothing behind.
    let mut child = unsafe {
        let node = find_node();
        // npm, git and docker are found the same way the server's own child processes look them up.
        let path = match (node.parent(), std::env::var_os("PATH")) {
            (Some(dir), Some(p)) => std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&p))).ok(),
            _ => None,
        };
        let mut cmd = Command::new(&node);
        if let Some(path) = path { cmd.env("PATH", path); }
        cmd
            .current_dir(&home)
            .args(["--import", "tsx", "src/serve.ts"])
            .arg(project)
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
    let pid = child.id() as i32;
    SERVERS.lock().unwrap().push(Server { project: project.to_path_buf(), port, pid, ready: false });
    let forget = || {
        let mut all = SERVERS.lock().unwrap();
        let ours = all.iter().position(|s| s.pid == pid);
        ours.map(|i| all.remove(i)).is_some()
    };

    // Pass the server's output through, and keep the last lines in case it fails.
    let name = title_of(project);
    let tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    for out in [child.stdout.take().map(|o| Box::new(o) as Box<dyn std::io::Read + Send>),
                child.stderr.take().map(|e| Box::new(e) as Box<dyn std::io::Read + Send>)].into_iter().flatten() {
        let tail = tail.clone();
        let name = name.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                eprintln!("[{name}] {line}");
                let mut t = tail.lock().unwrap();
                t.push(line);
                if t.len() > 12 { t.remove(0); }
            }
        });
    }

    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            forget();
            return Err(format!("the server for {name} stopped ({status}):\n{}", tail.lock().unwrap().join("\n")));
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() { break; }
        if started.elapsed() > Duration::from_secs(60) {
            forget();
            unsafe { libc::kill(pid, libc::SIGTERM) };
            return Err(format!("the server for {name} did not answer within a minute"));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if let Some(s) = SERVERS.lock().unwrap().iter_mut().find(|s| s.pid == pid) { s.ready = true; }
    // Only if you haven't switched to another project while it started.
    if CURRENT.lock().unwrap().as_deref() == Some(project) {
        win.navigate(format!("http://127.0.0.1:{port}/").parse().unwrap()).map_err(|e| e.to_string())?;
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if forget() {
        // Not stopped by us: say why (on the loading page, if it is the project on screen).
        return Err(format!("the server for {name} stopped ({status}):\n{}", tail.lock().unwrap().join("\n")));
    }
    Ok(())
}

/// The page's way to switch the window to another project (the workspace menu in Header.svelte).
#[tauri::command]
fn switch_project(window: WebviewWindow, path: String) -> Result<(), String> {
    let project = std::fs::canonicalize(&path).map_err(|e| format!("{path}: {e}"))?;
    if !project.is_dir() { return Err(format!("{path} is not a folder")); }
    show_project(&window, project);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The window opens where you left it, at the size you left it (and maximized if it was).
        // Saved on close, in the app's config dir. Wayland doesn't let an app place its own window,
        // so there only the size and maximized state come back.
        .plugin(tauri_plugin_window_state::Builder::new()
            .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN)
            .build())
        .invoke_handler(tauri::generate_handler![switch_project])
        .setup(|app| {
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("cockpit")
                .decorations(false) // the page's header is the title bar (web/src/components/Header.svelte)
                .inner_size(1600.0, 1000.0)
                .min_inner_size(800.0, 500.0)
                .build()?;
            let handle = app.handle().clone();
            // The folder dialog blocks, so not on the main thread.
            std::thread::spawn(move || match pick_project(&handle) {
                Some(project) => show_project(&win, project),
                None => { let _ = win.navigate(loading_url("no project chosen")); }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not start the app")
        .run(|_, event| {
            if let RunEvent::Exit = event {
                stop_servers();
            }
        });
}

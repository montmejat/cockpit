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

use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::StateFlags;

/// Process id of the running server, 0 when none.
static SERVER: AtomicI32 = AtomicI32::new(0);

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
        let _ = std::fs::write(&f, project.to_string_lossy().as_bytes());
        // The recent projects, newest first, for the page's "Open Folder" menu (src/serve.ts reads it).
        let recent = f.with_file_name("recent-projects");
        let me = project.to_string_lossy().into_owned();
        let mut list: Vec<String> = std::fs::read_to_string(&recent).unwrap_or_default().lines()
            .map(str::to_owned).filter(|l| !l.is_empty() && *l != me).collect();
        list.insert(0, me);
        list.truncate(12);
        let _ = std::fs::write(recent, list.join("\n") + "\n");
    }
}

/// The page's "Open Folder…" (and its recent projects): a folder to open, or a dialog to pick one.
/// The window switches to it: the current server stops, one for the new project starts.
#[tauri::command]
async fn open_project(app: tauri::AppHandle, path: Option<String>) -> Result<bool, String> {
    let project = match path {
        Some(p) => std::fs::canonicalize(&p).map_err(|e| format!("{p}: {e}"))?,
        None => match app.dialog().file().set_title("Open a project in cockpit").blocking_pick_folder() {
            Some(p) => p.into_path().map_err(|e| e.to_string())?,
            None => return Ok(false), // cancelled
        },
    };
    if !project.is_dir() { return Err(format!("{} is not a folder", project.display())); }
    let win = app.get_webview_window("main").ok_or("no window")?;
    stop_server();
    let _ = win.navigate("tauri://localhost/".parse().unwrap());
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = run(handle, win.clone(), Some(project)) {
            eprintln!("cockpit: {e}");
            show_message(&win, &e);
        }
    });
    Ok(true)
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
fn run(app: tauri::AppHandle, win: WebviewWindow, chosen: Option<PathBuf>) -> Result<(), String> {
    let project = chosen.or_else(|| pick_project(&app)).ok_or("no project chosen")?;
    remember(&project);
    let name = project.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let _ = win.set_title(&format!("{name} · cockpit"));
    show_message(&win, &format!("starting cockpit for {name}…"));

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
    let pid = child.id() as i32;
    SERVER.store(pid, Ordering::SeqCst);

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
    // Still the current server, so not stopped by us (stop_server, or a switch to another project).
    if SERVER.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        // Not stopped by us: go back to the loading page and say why.
        let _ = win.navigate("tauri://localhost/".parse().unwrap());
        std::thread::sleep(Duration::from_millis(500));
        return Err(format!("the server stopped ({status}):\n{}", tail.lock().unwrap().join("\n")));
    }
    Ok(())
}

/// Without decorations, GTK draws no frame, so GNOME (Wayland) gives the window no shadow and
/// no resize area around it, unlike the apps next to it. On Wayland, tao already puts an empty
/// title bar in the frame; turning the frame back on brings GTK's shadow (and its resize edges)
/// without a title bar. The page's header stays the title bar.
#[cfg(target_os = "linux")]
fn window_shadow(win: &WebviewWindow) {
    use gtk::prelude::*;
    if let Ok(w) = win.gtk_window() {
        if w.display().backend().is_wayland() {
            w.set_decorated(true);
            // GTK 3's default shadow is heavier than the apps next to it (libadwaita, Firefox,
            // VS Code): use libadwaita's, lighter when the window isn't focused. Same size both
            // ways: a smaller one resizes the window on every focus change (Alt+Tab), and the
            // page flickers as it lays itself out again. Around
            // the same 12px corners the page draws. No ring: the page draws its own hairline.
            // Nothing behind the page, so its rounded corners show through.
            let css = gtk::CssProvider::new();
            let _ = css.load_from_data(
                b"window, window.background { background: transparent; }
                  decoration { border-radius: 12px; box-shadow: 0 2px 8px 2px rgba(0,0,0,.13), 0 3px 20px 10px rgba(0,0,0,.09), 0 6px 32px 16px rgba(0,0,0,.03); }
                  decoration:backdrop { box-shadow: 0 2px 8px 2px rgba(0,0,0,.08), 0 3px 20px 10px rgba(0,0,0,.05), 0 6px 32px 16px rgba(0,0,0,.02); }
                  .maximized decoration, .fullscreen decoration, .tiled decoration { border-radius: 0; }",
            );
            if let Some(screen) = gtk::prelude::GtkWindowExt::screen(&w) {
                gtk::StyleContext::add_provider_for_screen(&screen, &css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
            }
        }
    }
}
#[cfg(not(target_os = "linux"))]
fn window_shadow(_win: &WebviewWindow) {}

/// WebKit holds page rendering near 60fps by default (PreferPageRenderingUpdatesNear60FPS), even
/// on a 120Hz screen. Off, the page draws at the screen's rate when WebKit knows it: on NVIDIA that
/// needs a WebKitGTK with the vblank-timer fix (~/Projects/Forks/webkit-120hz); with the stock one
/// nothing changes (its fallback timer ticks at 60).
#[cfg(target_os = "linux")]
fn full_frame_rate(win: &WebviewWindow) {
    use gtk::glib::object::ObjectType;
    use std::ffi::{c_char, c_void, CStr};
    unsafe extern "C" {
        fn webkit_web_view_get_settings(view: *mut c_void) -> *mut c_void;
        fn webkit_settings_get_all_features() -> *mut c_void;
        fn webkit_feature_list_get_length(list: *mut c_void) -> usize;
        fn webkit_feature_list_get(list: *mut c_void, i: usize) -> *mut c_void;
        fn webkit_feature_list_unref(list: *mut c_void);
        fn webkit_feature_get_identifier(f: *mut c_void) -> *const c_char;
        fn webkit_settings_set_feature_enabled(settings: *mut c_void, f: *mut c_void, enabled: i32);
    }
    let _ = win.with_webview(|wv| unsafe {
        let settings = webkit_web_view_get_settings(wv.inner().as_ptr() as *mut c_void);
        let list = webkit_settings_get_all_features();
        for i in 0..webkit_feature_list_get_length(list) {
            let f = webkit_feature_list_get(list, i);
            if CStr::from_ptr(webkit_feature_get_identifier(f)).to_bytes() == b"PreferPageRenderingUpdatesNear60FPS" {
                webkit_settings_set_feature_enabled(settings, f, 0);
            }
        }
        webkit_feature_list_unref(list);
    });
}
#[cfg(not(target_os = "linux"))]
fn full_frame_rate(_win: &WebviewWindow) {}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_project])
        // The window opens where you left it, at the size you left it (and maximized if it was).
        // Saved on close, in the app's config dir. Wayland doesn't let an app place its own window,
        // so there only the size and maximized state come back.
        .plugin(tauri_plugin_window_state::Builder::new()
            .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN)
            .build())
        .setup(|app| {
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("cockpit")
                .decorations(false) // the page's header is the title bar (web/src/components/Header.svelte)
                .transparent(true) // the page rounds its corners (body.desktop in web/src/app.css)
                .inner_size(1600.0, 1000.0)
                .min_inner_size(800.0, 500.0)
                .build()?;
            window_shadow(&win);
            full_frame_rate(&win);
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = run(handle.clone(), win.clone(), None) {
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

// cockpit as a desktop app: a GTK 4 window around the same local server as `npm run serve`.
// It picks a project, starts the server on a free port, shows the page, and stops the server on exit.
// Open Folder and the workspace menu switch the window to another project: its own server, started
// the first time and kept running while you are elsewhere.
//   cockpit [project dir]
// Without a directory it reopens the last project, or asks for one; --pick always asks.
//
// GTK 4 and libadwaita, not Tauri: Tauri (wry/tao) is GTK 3 on Linux, and GTK 3 draws a
// transparent window (the rounded corners) by copying the whole page through the CPU every frame,
// which held scrolling near 80fps on a 120Hz screen at ~90% of a core. GTK 4 draws the window,
// its rounded corners and its shadow on the GPU: 120fps at a few percent.
//
// The page draws its own title bar (web/src/components/Header.svelte) and talks to this window
// through `window.cockpitDesktop` (BRIDGE below): open another project, move, minimize, maximize,
// close.

use std::cell::RefCell;
use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use adw::prelude::*;
use gtk::{gdk, gio, glib};
use webkit6::prelude::*;
use webkit6::javascriptcore;

/// The running servers, one per project opened in this window.
/// `token` lets the page in (src/auth.ts): the server gets it in COCKPIT_TOKEN, the page in its first URL.
struct Server { project: PathBuf, port: u16, pid: i32, ready: bool, token: String }
static SERVERS: Mutex<Vec<Server>> = Mutex::new(Vec::new());
/// The project the window shows (or is starting).
static CURRENT: Mutex<Option<PathBuf>> = Mutex::new(None);

fn is_current(project: &Path) -> bool {
    CURRENT.lock().unwrap().as_deref() == Some(project)
}

/// The page shown while the server starts, and where errors are told.
const LOADING: &str = include_str!("../loading/index.html");
const LOADING_URI: &str = "cockpit-loading:///";

/// What the page can call (window.cockpitDesktop). Each call is a message to `on_message` and
/// resolves with its JSON answer.
const BRIDGE: &str = r#"(() => {
  const call = (cmd, args) => window.webkit.messageHandlers.cockpit
    .postMessage(JSON.stringify({ cmd, ...args })).then((r) => JSON.parse(r));
  window.cockpitDesktop = {
    openProject: (path) => call("open_project", { path: path ?? null }),
    state: () => call("state"),
    startDragging: () => call("start_drag"),
    minimize: () => call("minimize"),
    toggleMaximize: () => call("toggle_maximize"),
    close: () => call("close"),
  };
})();"#;

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

fn config_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("cockpit"))
}

fn remember(project: &Path) {
    let Some(dir) = config_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join("last-project"), project.to_string_lossy().as_bytes());
    // The recent projects, newest first, for the page's "Open Folder" menu (src/serve.ts reads it).
    let recent = dir.join("recent-projects");
    let me = project.to_string_lossy().into_owned();
    let mut list: Vec<String> = std::fs::read_to_string(&recent).unwrap_or_default().lines()
        .map(str::to_owned).filter(|l| !l.is_empty() && *l != me).collect();
    list.insert(0, me);
    list.truncate(12);
    let _ = std::fs::write(recent, list.join("\n") + "\n");
}

/// `cockpit <dir>` opens that project, plain `cockpit` reopens the last one; None: ask
/// (`--pick`, or nothing to reopen).
fn project_from_args() -> Option<PathBuf> {
    let arg = std::env::args_os().nth(1);
    if arg.as_deref() == Some("--pick".as_ref()) {
        return None;
    }
    if let Some(arg) = arg {
        return std::fs::canonicalize(arg).ok();
    }
    config_dir()
        .and_then(|d| std::fs::read_to_string(d.join("last-project")).ok())
        .map(|s| PathBuf::from(s.trim()))
        .filter(|p| p.is_dir())
}

/// A secret for one server: 24 random bytes, as hex.
fn new_token() -> std::io::Result<String> {
    use std::io::Read;
    let mut b = [0u8; 24];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// The page of a server, with its token: the server swaps it for a cookie and drops it from the URL.
fn page_url(port: u16, token: &str) -> String {
    format!("http://127.0.0.1:{port}/?token={token}")
}

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// Stops every server (when the window closes).
fn stop_servers() {
    for s in SERVERS.lock().unwrap().drain(..) {
        unsafe { libc::kill(s.pid, libc::SIGTERM) };
    }
}

fn title_of(project: &Path) -> String {
    project.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

// ---- The window, on GTK's thread --------------------------------------------------------------

struct Ui {
    win: adw::ApplicationWindow,
    view: webkit6::WebView,
    /// The last mouse press on the page: moving the window starts from it (start_drag).
    press: RefCell<Option<gdk::Event>>,
}

thread_local! {
    static UI: RefCell<Option<std::rc::Rc<Ui>>> = const { RefCell::new(None) };
}

fn ui() -> Option<std::rc::Rc<Ui>> {
    UI.with(|u| u.borrow().clone())
}

/// Run `f` on GTK's thread (from the server's thread).
fn on_ui(f: impl FnOnce(&Ui) + Send + 'static) {
    glib::MainContext::default().invoke(move || {
        if let Some(ui) = ui() { f(&ui) }
    });
}

fn show_loading(ui: &Ui) {
    ui.view.load_html(LOADING, Some(LOADING_URI));
}

/// A line on the loading page: what is happening, or why it stopped.
fn show_message(ui: &Ui, text: &str) {
    let js = format!(
        "document.getElementById('msg').textContent = {}; document.querySelector('.dot').style.animation = 'none';",
        serde_json::to_string(text).unwrap()
    );
    // The loading page may still be loading: try again once it is there.
    let uri = ui.view.uri().map(|u| u.to_string()).unwrap_or_default();
    if uri.starts_with(LOADING_URI) && !ui.view.is_loading() {
        ui.view.evaluate_javascript(&js, None, None, None::<&gio::Cancellable>, |_| {});
    } else {
        let view = ui.view.clone();
        let id: std::rc::Rc<RefCell<Option<glib::SignalHandlerId>>> = Default::default();
        let id2 = id.clone();
        *id.borrow_mut() = Some(ui.view.connect_load_changed(move |v, e| {
            if e == webkit6::LoadEvent::Finished {
                if v.uri().is_some_and(|u| u.starts_with(LOADING_URI)) {
                    v.evaluate_javascript(&js, None, None, None::<&gio::Cancellable>, |_| {});
                }
                if let Some(id) = id2.borrow_mut().take() { view.disconnect(id); }
            }
        }));
    }
}

/// Show `project` in the window: its server if one is running, else a new one started on its own
/// thread. The servers of the projects you switch away from keep running (their terminals and
/// agents too), so switching back is instant; they all stop with the window.
fn open(project: PathBuf) {
    remember(&project);
    *CURRENT.lock().unwrap() = Some(project.clone());
    let name = title_of(&project);
    let running = SERVERS.lock().unwrap().iter().find(|s| s.project == project).map(|s| (s.port, s.ready, s.token.clone()));
    if let Some(ui) = ui() {
        ui.win.set_title(Some(&format!("{name} · cockpit")));
        match running {
            Some((port, true, token)) => return ui.view.load_uri(&page_url(port, &token)),
            _ => { show_loading(&ui); show_message(&ui, &format!("starting cockpit for {name}…")); }
        }
    }
    if running.is_some() { return; } // still starting: its thread shows it once it answers
    std::thread::spawn(move || {
        if let Err(e) = run(&project) {
            eprintln!("cockpit: {e}");
            if is_current(&project) {
                on_ui(move |ui| { show_loading(ui); show_message(ui, &e); });
            }
        }
    });
}

/// Ask for a folder; `done` gets it, or None when cancelled.
fn pick_folder(done: impl FnOnce(Option<PathBuf>) + 'static) {
    let Some(ui) = ui() else { return done(None) };
    let dialog = gtk::FileDialog::builder().title("Open a project in cockpit").modal(true).build();
    dialog.select_folder(Some(&ui.win), None::<&gio::Cancellable>, move |r| {
        done(r.ok().and_then(|f| f.path()));
    });
}

/// Runs on its own thread for the life of the server: the server is tied to this thread
/// (it gets SIGTERM if the thread or the app dies), and the thread reports if the server stops.
fn run(project: &Path) -> Result<(), String> {
    let home = cockpit_home();
    let port = free_port().map_err(|e| format!("no free port: {e}"))?;
    let token = new_token().map_err(|e| format!("no random token: {e}"))?;
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
        cmd.env("COCKPIT_TOKEN", &token);
        // Not ours: the patched WebKit's library path (see README) is for this window only.
        cmd.env_remove("LD_LIBRARY_PATH");
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
    SERVERS.lock().unwrap().push(Server { project: project.to_path_buf(), port, pid, ready: false, token: token.clone() });
    // Whether it was still listed, so not stopped by us (stop_servers).
    let forget = || {
        let mut all = SERVERS.lock().unwrap();
        let ours = all.iter().position(|s| s.pid == pid);
        ours.map(|i| all.remove(i)).is_some()
    };
    let name = title_of(project);

    // Pass the server's output through, and keep the last lines in case it fails.
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
    if is_current(project) {
        let url = page_url(port, &token);
        on_ui(move |ui| ui.view.load_uri(&url));
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if forget() {
        return Err(format!("the server for {name} stopped ({status}):\n{}", tail.lock().unwrap().join("\n")));
    }
    Ok(())
}

// ---- The page's calls (window.cockpitDesktop) ---------------------------------------------------

/// Only the cockpit page (from its local server) and the loading page may drive the window.
fn trusted(view: &webkit6::WebView) -> bool {
    view.uri().is_some_and(|u| u.starts_with("http://127.0.0.1:") || u.starts_with(LOADING_URI))
}

fn on_message(ui: &Ui, msg: &str, reply: webkit6::ScriptMessageReply, ctx: javascriptcore::Context) {
    let answer = move |json: serde_json::Value| {
        reply.return_value(&javascriptcore::Value::new_string(&ctx, Some(&json.to_string())));
    };
    let msg: serde_json::Value = serde_json::from_str(msg).unwrap_or_default();
    let win = &ui.win;
    match msg["cmd"].as_str().unwrap_or("") {
        "state" => answer(serde_json::json!({ "maximized": win.is_maximized(), "fullscreen": win.is_fullscreen() })),
        "minimize" => { win.minimize(); answer(true.into()) }
        "toggle_maximize" => {
            if win.is_maximized() { win.unmaximize() } else { win.maximize() }
            answer(true.into())
        }
        "close" => { win.close(); answer(true.into()) }
        "start_drag" => {
            // From the press that is still down: GNOME moves the window until it's released.
            let press = ui.press.borrow().clone();
            if let (Some(e), Some(surface)) = (press, win.surface()) {
                if let (Some(top), Some(device), Some((x, y))) =
                    (surface.downcast_ref::<gdk::Toplevel>(), e.device(), e.position())
                {
                    let button = e.downcast_ref::<gdk::ButtonEvent>().map(|b| b.button() as i32).unwrap_or(1);
                    top.begin_move(&device, button, x, y, e.time());
                }
            }
            answer(true.into())
        }
        "open_project" => {
            let chosen = move |p: Result<Option<PathBuf>, String>| match p {
                Err(e) => answer(serde_json::json!({ "error": e })),
                Ok(None) => answer(false.into()), // cancelled
                Ok(Some(p)) if !p.is_dir() => answer(serde_json::json!({ "error": format!("{} is not a folder", p.display()) })),
                Ok(Some(p)) => { answer(true.into()); open(p) }
            };
            match msg["path"].as_str() {
                Some(p) => chosen(std::fs::canonicalize(p).map(Some).map_err(|e| format!("{p}: {e}"))),
                None => pick_folder(move |p| chosen(Ok(p))),
            }
        }
        other => answer(serde_json::json!({ "error": format!("unknown call {other:?}") })),
    }
}

// ---- Window size, kept across runs ----------------------------------------------------------------

/// ~/.config/cockpit/window: "width height maximized" (GTK's own size, in logical pixels, without
/// the shadow; Wayland doesn't let an app place its own window, so no position).
mod geometry {
    use super::*;

    fn file() -> Option<PathBuf> { config_dir().map(|d| d.join("window")) }

    pub fn restore(win: &adw::ApplicationWindow) {
        let Some(text) = file().and_then(|f| std::fs::read_to_string(f).ok()) else { return };
        let n: Vec<i32> = text.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if let (Some(&w), Some(&h)) = (n.first(), n.get(1)) {
            if w >= 400 && h >= 300 { win.set_default_size(w, h); }
        }
        if n.get(2) == Some(&1) { win.maximize(); }
    }

    pub fn save(win: &adw::ApplicationWindow) {
        // While maximized, the size to come back to is the default size, which GTK keeps as is.
        let (w, h) = win.default_size();
        if w < 400 || h < 300 { return; }
        if let Some(f) = file() {
            let _ = std::fs::create_dir_all(f.parent().unwrap());
            let _ = std::fs::write(f, format!("{w} {h} {}\n", win.is_maximized() as i32));
        }
    }
}

// ---- Startup -------------------------------------------------------------------------------------

fn build(app: &adw::Application) {
    let content = webkit6::UserContentManager::new();
    content.add_script(&webkit6::UserScript::new(
        BRIDGE,
        webkit6::UserContentInjectedFrames::TopFrame,
        webkit6::UserScriptInjectionTime::Start,
        &[],
        &[],
    ));
    content.register_script_message_handler_with_reply("cockpit", None);

    let settings = webkit6::Settings::new();
    // WebKit holds page rendering near 60fps by default, even on a 120Hz screen. Off, the page
    // draws at the screen's rate when WebKit knows it: on NVIDIA that needs a WebKitGTK with the
    // vblank-timer fix (~/Projects/Forks/webkit-120hz); with the stock one it stays at 60.
    // Set before the page exists: WebKit doesn't re-read it later.
    if let Some(list) = webkit6::Settings::all_features() {
        for i in 0..list.length() {
            if let Some(f) = list.get(i) {
                if f.identifier().as_deref() == Some("PreferPageRenderingUpdatesNear60FPS") {
                    settings.set_feature_enabled(&f, false);
                }
            }
        }
    }
    // Right click → Inspect Element, with COCKPIT_DEVTOOLS=1.
    settings.set_enable_developer_extras(std::env::var_os("COCKPIT_DEVTOOLS").is_some());

    let view = webkit6::WebView::builder().user_content_manager(&content).settings(&settings).build();
    view.set_hexpand(true);
    view.set_vexpand(true);

    let win = adw::ApplicationWindow::builder()
        .application(app)
        .title("cockpit")
        .default_width(1600)
        .default_height(1000)
        .width_request(800)
        .height_request(500)
        .content(&view)
        .build();
    geometry::restore(&win);

    let shared = std::rc::Rc::new(Ui { win: win.clone(), view: view.clone(), press: RefCell::new(None) });
    UI.with(|u| *u.borrow_mut() = Some(shared.clone()));

    // Remember each mouse press on the page, without taking it from the page.
    let click = gtk::GestureClick::builder().button(0).propagation_phase(gtk::PropagationPhase::Capture).build();
    click.connect_pressed(|g, _, _, _| {
        if let Some(ui) = ui() { *ui.press.borrow_mut() = g.current_event(); }
    });
    view.add_controller(click);

    content.connect_script_message_with_reply_received(Some("cockpit"), |_, value, reply| {
        let Some(ui) = ui() else { return false };
        if !trusted(&ui.view) {
            reply.return_error_message("not allowed from this page");
            return true;
        }
        if let Some(ctx) = value.context() {
            on_message(&ui, &value.to_str(), reply.clone(), ctx);
        }
        true
    });

    // Links that would leave cockpit open in the browser (the page itself asks the server for
    // that; this catches the rest, like window.open).
    view.connect_decide_policy(|_, decision, kind| {
        if kind == webkit6::PolicyDecisionType::NewWindowAction {
            if let Some(nav) = decision.downcast_ref::<webkit6::NavigationPolicyDecision>() {
                if let Some(uri) = nav.navigation_action().and_then(|a| a.request()).and_then(|r| r.uri()) {
                    let _ = gio::AppInfo::launch_default_for_uri(&uri, None::<&gio::AppLaunchContext>);
                }
            }
            decision.ignore();
            return true;
        }
        false
    });

    win.connect_close_request(|w| {
        geometry::save(w);
        stop_servers();
        glib::Propagation::Proceed
    });
    win.connect_maximized_notify(geometry::save);

    show_loading(&shared);
    win.present();

    match project_from_args() {
        Some(p) => open(p),
        None => pick_folder(|p| match p {
            Some(p) => open(p),
            None => if let Some(ui) = ui() { show_message(&ui, "no project chosen") },
        }),
    }
}

fn main() -> glib::ExitCode {
    // GTK 4's default renderer (Vulkan) shows WebKit's frames slowly on NVIDIA (~38fps at
    // 300% CPU); its GL renderer draws them at the screen's rate.
    if std::env::var_os("GSK_RENDERER").is_none() {
        unsafe { std::env::set_var("GSK_RENDERER", "gl") };
    }
    let app = adw::Application::builder()
        .application_id("io.github.montmejat.cockpit")
        // Each `cockpit` is its own window and server, not a second window of the first one.
        .flags(gio::ApplicationFlags::NON_UNIQUE)
        .build();
    app.connect_activate(build);
    app.connect_shutdown(|_| stop_servers());
    // The arguments are ours (project_from_args), not GApplication's.
    app.run_with_args::<&str>(&[])
}

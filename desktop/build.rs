fn main() {
    // The page (served from 127.0.0.1) may call open_project: capabilities/default.json allows it.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["open_project"])))
        .expect("tauri build")
}

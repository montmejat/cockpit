fn main() {
    // The page is served from 127.0.0.1, a remote origin for Tauri: the app's own commands must be
    // declared here so capabilities/default.json can allow them for it.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["switch_project"])),
    )
    .expect("tauri build");
}

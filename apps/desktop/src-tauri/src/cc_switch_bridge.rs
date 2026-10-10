use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn read_cc_switch_config(
    app: AppHandle,
    window: WebviewWindow,
    choose_file: bool,
) -> Result<Vec<sourceweft_desktop::cc_switch::Candidate>, String> {
    crate::authorize_desktop_window(&app, &window, true)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = if choose_file {
            app.dialog()
                .file()
                .add_filter("CC Switch SQLite", &["db", "sqlite", "sqlite3"])
                .blocking_pick_file()
                .ok_or("CC_SWITCH_SELECTION_CANCELLED")?
                .into_path()
                .map_err(|_| "CC_SWITCH_INVALID_FILE")?
        } else {
            #[cfg(windows)]
            let home = std::env::var_os("USERPROFILE");
            #[cfg(not(windows))]
            let home = std::env::var_os("HOME");
            std::path::PathBuf::from(home.ok_or("CC_SWITCH_HOME_UNAVAILABLE")?)
                .join(".cc-switch/cc-switch.db")
        };
        sourceweft_desktop::cc_switch::read_database(&path)
    })
    .await
    .map_err(|_| "CC_SWITCH_READ_FAILED".to_owned())?
}

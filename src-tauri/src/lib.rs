mod local_storage;
mod sidecar;

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn show_item_in_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(e) = sidecar::spawn_mongo_api(&handle) {
                eprintln!("[leaf-desk] {}", e);
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_item_in_folder,
            open_path,
            local_storage::import_electron_local_storage,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Leaf Desk");
}

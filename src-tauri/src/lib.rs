mod local_storage;
mod sidecar;

use std::fs;
use std::path::Path;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
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

fn is_gzip(data: &[u8]) -> bool {
    data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b
}

/// 导出备份：按内容弹出保存框。1Panel 是 gz，宝塔是 zip。
/// 同步 command，避免 async 里 blocking_save_file 卡死界面。
#[tauri::command]
fn save_export_file(
    app: tauri::AppHandle,
    file_name: String,
    data: Vec<u8>,
) -> Result<Option<String>, String> {
    let gzip = is_gzip(&data);
    let mut suggested = Path::new(&file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(if gzip { "backup.gz" } else { "backup.zip" })
        .to_string();
    let lower = suggested.to_ascii_lowercase();
    if gzip {
        if lower.ends_with(".zip") {
            suggested.truncate(suggested.len() - 4);
            suggested.push_str(".gz");
        } else if !lower.ends_with(".gz") {
            suggested.push_str(".gz");
        }
    } else if !lower.ends_with(".zip") {
        suggested.push_str(".zip");
    }

    let mut picker = app
        .dialog()
        .file()
        .set_title("保存 MongoDB 备份")
        .set_file_name(&suggested);
    picker = if gzip {
        picker.add_filter("1Panel gzip", &["gz"])
    } else {
        picker.add_filter("ZIP 备份", &["zip"])
    };
    let picked = picker.blocking_save_file();
    let Some(file) = picked else {
        return Ok(None);
    };
    let mut path = file
        .into_path()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();
    if gzip && path.to_ascii_lowercase().ends_with(".zip") {
        path.truncate(path.len() - 4);
        path.push_str(".gz");
    }
    fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(Some(path))
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
            save_export_file,
            local_storage::import_electron_local_storage,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Leaf Desk");
}

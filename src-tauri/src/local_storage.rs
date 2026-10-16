use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const KEYS: &[&str] = &[
    "leaf-desk-route",
    "leaf-desk-pinned-dbs",
    "leaf-desk-pinned-colls",
];

fn electron_leveldb_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("mongodb")
        .join("Local Storage")
        .join("leveldb")
}

fn find_key(data: &[u8], key: &str) -> Option<usize> {
    data.windows(key.len())
        .position(|w| w == key.as_bytes())
}

/// Chromium localStorage 值多为 UTF-16LE JSON 字符串。
fn extract_utf16_value(data: &[u8], key: &str) -> Option<String> {
    let start = find_key(data, key)?;
    let tail = &data[start + key.len()..];
    let rel = tail
        .windows(2)
        .position(|w| w[0] == b'{' || w[0] == b'[' || (w[0] == b'"' && w[1] == 0))?;
    let json_start = start + key.len() + rel;
    let first = data.get(json_start)?;
    let expect_end = if *first == b'[' {
        ']'
    } else if *first == b'{' {
        '}'
    } else {
        '"'
    };

    for end in (json_start + 4..data.len().min(json_start + 200_000)).step_by(2) {
        let slice = &data[json_start..end];
        if slice.len() % 2 != 0 {
            continue;
        }
        let s = String::from_utf16(
            &slice
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect::<Vec<_>>(),
        )
        .ok()?;
        let trimmed = s.trim();
        if trimmed.is_empty() {
            continue;
        }
        if *first == b'"' {
            if trimmed.ends_with('"') && trimmed.len() > 1 {
                return Some(trimmed.trim_matches('"').to_string());
            }
            continue;
        }
        if trimmed.ends_with(expect_end) {
            return Some(trimmed.to_string());
        }
    }
    None
}

#[tauri::command]
pub fn import_electron_local_storage() -> HashMap<String, String> {
    let dir = electron_leveldb_dir();
    if !dir.is_dir() {
        return HashMap::new();
    }
    let mut out = HashMap::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if ext != "log" && ext != "ldb" {
            continue;
        }
        let data = match fs::read(&path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        for &key in KEYS {
            if out.contains_key(key) {
                continue;
            }
            if let Some(val) = extract_utf16_value(&data, key) {
                out.insert(key.to_string(), val);
            }
        }
    }
    out
}

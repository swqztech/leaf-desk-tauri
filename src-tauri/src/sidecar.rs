use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

static API_CHILD: Mutex<Option<Child>> = Mutex::new(None);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn leaf_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Leaf Desk")
}

pub fn spawn_mongo_api(app: &AppHandle) -> Result<(), String> {
    let data = leaf_data_dir();
    let _ = std::fs::create_dir_all(&data);

    if let Ok(resource_dir) = app.path().resource_dir() {
        for api_dir in [
            resource_dir.join("mongo-api"),
            resource_dir.join("resources").join("mongo-api"),
        ] {
            let node = api_dir.join("node.exe");
            let script = api_dir.join("server.cjs");
            if node.is_file() && script.is_file() {
                return spawn_node_process(&node, &script, &api_dir, &data);
            }
        }
    }

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let script = manifest.join("../mongo-server/dist/server.cjs");
    if !script.is_file() {
        return Err("Mongo API not built: run npm run build:api from project root.".into());
    }
    let node = which_node()?;
    let cwd = manifest.join("../mongo-server");
    spawn_node_process(&node, &script, &cwd, &data)
}

fn which_node() -> Result<PathBuf, String> {
    let node = Command::new("where")
        .arg("node")
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout)
                    .ok()
                    .and_then(|s| s.lines().next().map(|l| PathBuf::from(l.trim())))
            } else {
                None
            }
        });
    node.filter(|p| p.is_file())
        .ok_or_else(|| "Node.js not found on PATH (required for dev).".into())
}

fn spawn_node_process(
    node: &Path,
    script: &Path,
    cwd: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let mut cmd = Command::new(node);
    cmd.current_dir(cwd)
        .arg(script)
        .env("PORT", "3001")
        .env("HOST", "127.0.0.1")
        .env("LEAF_DESK_DATA", data_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start Mongo API: {}", e))?;
    if let Ok(mut guard) = API_CHILD.lock() {
        *guard = Some(child);
    }
    wait_health()
}

fn wait_health() -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    for _ in 0..60 {
        if let Ok(res) = client.get("http://127.0.0.1:3001/api/health").send() {
            if res.status().is_success() {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("Mongo API health check timed out.".into())
}

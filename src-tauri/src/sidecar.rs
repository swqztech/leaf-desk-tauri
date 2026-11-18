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

fn mongodump_marker_in(bin_dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        bin_dir.join("mongodump.exe")
    }
    #[cfg(not(windows))]
    {
        bin_dir.join("mongodump")
    }
}

fn mongo_tools_bin_dir(api_dir: &Path) -> Option<PathBuf> {
    let bin = api_dir.join("tools").join("bin");
    if mongodump_marker_in(&bin).is_file() {
        return Some(bin);
    }
    None
}

fn bundled_mongo_api_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("mongo-api")
}

fn bundled_node_file_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn bundled_node_path(dir: &Path) -> PathBuf {
    dir.join(bundled_node_file_name())
}

pub fn spawn_mongo_api(app: &AppHandle) -> Result<(), String> {
    let data = leaf_data_dir();
    let _ = std::fs::create_dir_all(&data);

    if let Ok(resource_dir) = app.path().resource_dir() {
        for api_dir in [
            resource_dir.join("mongo-api"),
            resource_dir.join("resources").join("mongo-api"),
        ] {
            let node = bundled_node_path(&api_dir);
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
    let bundled_api = bundled_mongo_api_dir();
    let bundled_node = bundled_node_path(&bundled_api);
    let (node, script, cwd) = if bundled_node.is_file()
        && bundled_api.join("server.cjs").is_file()
    {
        (
            bundled_node,
            bundled_api.join("server.cjs"),
            bundled_api.clone(),
        )
    } else {
        (node, script, manifest.join("../mongo-server"))
    };
    spawn_node_process(&node, &script, &cwd, &data)
}

fn which_node() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
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
        return node
            .filter(|p| p.is_file())
            .ok_or_else(|| "Node.js not found on PATH (required for dev).".into());
    }
    #[cfg(not(windows))]
    {
        let node = Command::new("which")
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
}

fn augment_path_for_mongo_tools(cmd: &mut Command, tools_bin: Option<&Path>) {
    #[cfg(target_os = "macos")]
    {
        let mut prefix: Vec<String> = Vec::new();
        if let Some(bin) = tools_bin {
            prefix.push(bin.to_string_lossy().into_owned());
        }
        prefix.push("/opt/homebrew/bin".into());
        prefix.push("/usr/local/bin".into());
        let current = std::env::var("PATH").unwrap_or_default();
        let merged = if current.is_empty() {
            prefix.join(":")
        } else {
            format!("{}:{}", prefix.join(":"), current)
        };
        cmd.env("PATH", merged);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (cmd, tools_bin);
    }
}

fn spawn_node_process(
    node: &Path,
    script: &Path,
    cwd: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let mut cmd = Command::new(node);
    let tools_bin = mongo_tools_bin_dir(cwd);
    cmd.current_dir(cwd)
        .arg(script)
        .env("PORT", "3001")
        .env("HOST", "127.0.0.1")
        .env("LEAF_DESK_DATA", data_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(ref bin) = tools_bin {
        cmd.env("MONGO_TOOLS_DIR", bin);
    }
    augment_path_for_mongo_tools(&mut cmd, tools_bin.as_deref());
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

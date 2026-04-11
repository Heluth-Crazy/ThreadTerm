use crate::db;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified: Option<String>,
}

/// Expand `~` to the user's home directory.
fn expand_path(p: &str) -> PathBuf {
    if p.starts_with('~') {
        if let Some(home) = dirs::home_dir() {
            return home.join(p.strip_prefix("~/").unwrap_or(&p[1..]));
        }
    }
    PathBuf::from(p)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fs_list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = expand_path(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }

    let mut entries = Vec::new();
    let read = std::fs::read_dir(&dir).map_err(|e| format!("read_dir failed: {e}"))?;

    for entry in read.flatten() {
        let meta = entry.metadata().ok();
        let name = entry.file_name().to_string_lossy().to_string();
        let full_path = entry.path().to_string_lossy().to_string();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().and_then(|m| if m.is_file() { Some(m.len()) } else { None });
        let modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());

        entries.push(DirEntry {
            name,
            path: full_path,
            is_dir,
            size,
            modified,
        });
    }

    // Sort: directories first, then alphabetically
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));

    Ok(entries)
}

#[tauri::command]
pub async fn fs_read_file(path: String) -> Result<String, String> {
    let p = expand_path(&path);
    std::fs::read_to_string(&p).map_err(|e| format!("read failed: {e}"))
}

#[tauri::command]
pub async fn fs_write_file(path: String, content: String) -> Result<(), String> {
    let p = expand_path(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("write failed: {e}"))
}

#[tauri::command]
pub async fn fs_delete_file(path: String) -> Result<(), String> {
    let p = expand_path(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("rmdir failed: {e}"))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("rm failed: {e}"))
    }
}

#[tauri::command]
pub async fn fs_read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let p = expand_path(&path);
    let bytes = std::fs::read(&p).map_err(|e| format!("read failed: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub async fn get_app_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[tauri::command]
pub async fn settings_get_all() -> Result<serde_json::Value, String> {
    let conn = db::get_db();
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| format!("query failed: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
            ))
        })
        .map_err(|e| format!("query_map failed: {e}"))?;

    let mut map = serde_json::Map::new();
    for row in rows.flatten() {
        let (key, value) = row;
        // Try to parse JSON values, fall back to string
        let json_val = serde_json::from_str(&value).unwrap_or(serde_json::Value::String(value));
        map.insert(key, json_val);
    }

    Ok(serde_json::Value::Object(map))
}

#[tauri::command]
pub async fn settings_set(key: String, value: serde_json::Value) -> Result<(), String> {
    let str_val = match &value {
        serde_json::Value::String(s) => s.clone(),
        other => serde_json::to_string(other).map_err(|e| format!("serialize failed: {e}"))?,
    };
    db::set_setting(&key, &str_val).map_err(|e| format!("set_setting failed: {e}"))
}

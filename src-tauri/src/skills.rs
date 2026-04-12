use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillRoot {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub path: String,
    pub exists: bool,
    pub writable: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub provider: String,
    pub root_id: String,
    pub root_label: String,
    pub root_path: String,
    pub path: String,
    pub file_path: String,
    pub updated_at: String,
    pub writable: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    #[serde(flatten)]
    pub summary: SkillSummary,
    pub content: String,
    pub frontmatter: Option<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsListResult {
    pub roots: Vec<SkillRoot>,
    pub skills: Vec<SkillSummary>,
}

// ---------------------------------------------------------------------------
// Skill root definitions (matches original SKILL_ROOT_DEFINITIONS)
// ---------------------------------------------------------------------------

struct RootDef {
    id: &'static str,
    label: &'static str,
    provider: &'static str,
    dir: &'static str, // relative to home, e.g. ".claude/skills"
}

const ROOT_DEFS: &[RootDef] = &[
    RootDef { id: "claude", label: "Claude", provider: "claude", dir: ".claude/skills" },
    RootDef { id: "claude-switch", label: "Claude Switch", provider: "claude", dir: ".cc-switch/skills" },
    RootDef { id: "codex", label: "Codex", provider: "codex", dir: ".codex/skills" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())
}

fn skill_id_from_path(path: &Path) -> String {
    URL_SAFE_NO_PAD.encode(path.to_string_lossy().as_bytes())
}

fn path_from_skill_id(skill_id: &str) -> Result<PathBuf, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(skill_id)
        .map_err(|e| format!("Invalid skill_id encoding: {e}"))?;
    let s = String::from_utf8(bytes).map_err(|e| format!("Invalid UTF-8 in skill_id: {e}"))?;
    Ok(PathBuf::from(s))
}

/// Parse YAML-ish frontmatter delimited by `---`.
/// Returns (frontmatter_map, body_content).
fn parse_frontmatter(raw: &str) -> (serde_json::Map<String, serde_json::Value>, String) {
    let mut map = serde_json::Map::new();

    let trimmed = raw.trim_start_matches('\u{feff}'); // strip BOM
    if !trimmed.starts_with("---") {
        return (map, raw.to_string());
    }

    // Find the closing ---
    if let Some(end_idx) = trimmed[3..].find("\n---") {
        let fm_block = &trimmed[3..3 + end_idx];
        let body_start = 3 + end_idx + 4; // skip "\n---"
        let body = trimmed[body_start..].trim_start_matches('\n').to_string();

        for line in fm_block.lines() {
            let line = line.trim();
            if line.is_empty() || !line.contains(':') {
                continue;
            }
            if let Some((key, val)) = line.split_once(':') {
                let key = key.trim().to_string();
                let val = val.trim().trim_matches('"').trim_matches('\'').to_string();
                map.insert(key, serde_json::Value::String(val));
            }
        }
        (map, body)
    } else {
        (map, raw.to_string())
    }
}

fn build_roots() -> Result<Vec<SkillRoot>, String> {
    let home = home_dir()?;
    Ok(ROOT_DEFS
        .iter()
        .map(|def| {
            let dir = home.join(def.dir);
            let exists = dir.is_dir();
            let writable = exists
                && std::fs::metadata(&dir)
                    .map(|m| !m.permissions().readonly())
                    .unwrap_or(false);
            SkillRoot {
                id: def.id.to_string(),
                label: def.label.to_string(),
                provider: def.provider.to_string(),
                path: dir.to_string_lossy().to_string(),
                exists,
                writable,
            }
        })
        .collect())
}

fn find_root_def(root_id: &str) -> Result<&'static RootDef, String> {
    ROOT_DEFS
        .iter()
        .find(|d| d.id == root_id)
        .ok_or_else(|| format!("Unknown root_id: {root_id}"))
}

fn read_skill_file(file_path: &Path, root: &SkillRoot, slug: &str) -> Result<SkillRecord, String> {
    let raw = std::fs::read_to_string(file_path)
        .map_err(|e| format!("Cannot read {}: {e}", file_path.display()))?;

    let (fm, body) = parse_frontmatter(&raw);

    let name = fm
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(slug)
        .to_string();
    let description = fm
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let updated_at = std::fs::metadata(file_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
        .unwrap_or_default();

    let writable = std::fs::metadata(file_path)
        .map(|m| !m.permissions().readonly())
        .unwrap_or(false);

    let skill_dir = file_path.parent().unwrap_or(file_path);

    let summary = SkillSummary {
        id: skill_id_from_path(file_path),
        name,
        slug: slug.to_string(),
        description,
        provider: root.provider.clone(),
        root_id: root.id.clone(),
        root_label: root.label.clone(),
        root_path: root.path.clone(),
        path: skill_dir.to_string_lossy().to_string(),
        file_path: file_path.to_string_lossy().to_string(),
        updated_at,
        writable,
    };

    Ok(SkillRecord {
        summary,
        content: body,
        frontmatter: if fm.is_empty() {
            None
        } else {
            Some(serde_json::Value::Object(fm))
        },
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn skills_list() -> Result<SkillsListResult, String> {
    let roots = build_roots()?;
    let mut skills: Vec<SkillSummary> = Vec::new();

    for root in &roots {
        if !root.exists {
            continue;
        }
        let dir = Path::new(&root.path);
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                continue;
            }
            let slug = entry.file_name().to_string_lossy().to_string();
            if slug.starts_with('.') {
                continue;
            }
            let skill_file = entry.path().join("SKILL.md");
            if !skill_file.is_file() {
                continue;
            }
            match read_skill_file(&skill_file, root, &slug) {
                Ok(record) => skills.push(record.summary),
                Err(e) => {
                    tracing::warn!(slug = %slug, error = %e, "Skipping unreadable skill");
                }
            }
        }
    }

    // Sort alphabetically by name
    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(SkillsListResult { roots, skills })
}

#[tauri::command]
pub async fn skills_read(skill_id: String) -> Result<SkillRecord, String> {
    let file_path = path_from_skill_id(&skill_id)?;
    if !file_path.is_file() {
        return Err(format!("Skill file not found: {}", file_path.display()));
    }

    // Determine which root this belongs to
    let roots = build_roots()?;
    let root = roots
        .iter()
        .find(|r| file_path.starts_with(&r.path))
        .ok_or_else(|| "Skill file is not inside any known skill root".to_string())?;

    let slug = file_path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    read_skill_file(&file_path, root, &slug)
}

#[tauri::command]
pub async fn skills_create(
    root_id: String,
    slug: String,
    content: String,
) -> Result<SkillRecord, String> {
    let home = home_dir()?;
    let def = find_root_def(&root_id)?;
    let root_dir = home.join(def.dir);

    // Create root dir if needed
    std::fs::create_dir_all(&root_dir)
        .map_err(|e| format!("Cannot create root dir: {e}"))?;

    let skill_dir = root_dir.join(&slug);
    if skill_dir.exists() {
        return Err(format!("Skill directory already exists: {}", skill_dir.display()));
    }
    std::fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Cannot create skill dir: {e}"))?;

    let file_path = skill_dir.join("SKILL.md");
    std::fs::write(&file_path, &content)
        .map_err(|e| format!("Cannot write SKILL.md: {e}"))?;

    let roots = build_roots()?;
    let root = roots
        .iter()
        .find(|r| r.id == root_id)
        .ok_or("Root not found after creation")?;

    read_skill_file(&file_path, root, &slug)
}

#[tauri::command]
pub async fn skills_update(skill_id: String, content: String) -> Result<SkillRecord, String> {
    let file_path = path_from_skill_id(&skill_id)?;
    if !file_path.is_file() {
        return Err(format!("Skill file not found: {}", file_path.display()));
    }

    std::fs::write(&file_path, &content)
        .map_err(|e| format!("Cannot write SKILL.md: {e}"))?;

    let roots = build_roots()?;
    let root = roots
        .iter()
        .find(|r| file_path.starts_with(&r.path))
        .ok_or("Skill root not found")?;

    let slug = file_path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    read_skill_file(&file_path, root, &slug)
}

#[tauri::command]
pub async fn skills_delete(skill_id: String) -> Result<(), String> {
    let file_path = path_from_skill_id(&skill_id)?;
    let skill_dir = file_path
        .parent()
        .ok_or("Cannot determine skill directory")?;

    if !skill_dir.is_dir() {
        return Err(format!("Skill directory not found: {}", skill_dir.display()));
    }

    // Safety: ensure it's inside a known root
    let roots = build_roots()?;
    if !roots.iter().any(|r| skill_dir.starts_with(&r.path)) {
        return Err("Refusing to delete: directory is not inside a known skill root".to_string());
    }

    std::fs::remove_dir_all(skill_dir)
        .map_err(|e| format!("Cannot remove skill directory: {e}"))?;

    Ok(())
}

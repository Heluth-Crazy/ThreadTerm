use crate::skills::parse_frontmatter;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredCommand {
    pub name: String,
    pub description: String,
    pub provider: String,
    pub scope: String,
    pub file_path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSkill {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub provider: String,
    pub scope: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandDiscoveryResult {
    pub commands: Vec<DiscoveredCommand>,
    pub skills: Vec<DiscoveredSkill>,
}

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())
}

/// Scan a directory for .md files and parse them as commands.
fn scan_command_dir(dir: &Path, provider: &str, scope: &str) -> Vec<DiscoveredCommand> {
    let mut results = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return results,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let name = match path.file_stem().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let description = if let Ok(raw) = std::fs::read_to_string(&path) {
            let (fm, body) = parse_frontmatter(&raw);
            if let Some(serde_json::Value::String(d)) = fm.get("description") {
                d.clone()
            } else {
                body.lines()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or("")
                    .trim_start_matches('#')
                    .trim()
                    .to_string()
            }
        } else {
            String::new()
        };
        results.push(DiscoveredCommand {
            name,
            description,
            provider: provider.to_string(),
            scope: scope.to_string(),
            file_path: path.to_string_lossy().to_string(),
        });
    }
    results
}

/// Scan a skills directory (where each subdirectory has a SKILL.md).
fn scan_skill_dir(dir: &Path, provider: &str, scope: &str) -> Vec<DiscoveredSkill> {
    let mut results = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return results,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let slug = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if slug.starts_with('.') {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        let (display_name, description) = if let Ok(raw) = std::fs::read_to_string(&skill_md) {
            let (fm, _body) = parse_frontmatter(&raw);
            let name = fm
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(&slug)
                .to_string();
            let desc = fm
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            (name, desc)
        } else {
            (slug.clone(), String::new())
        };
        results.push(DiscoveredSkill {
            name: slug,
            display_name,
            description,
            provider: provider.to_string(),
            scope: scope.to_string(),
        });
    }
    results
}

#[tauri::command]
pub async fn commands_discover(
    provider: String,
    project_path: Option<String>,
) -> Result<CommandDiscoveryResult, String> {
    let home = home_dir()?;
    let mut commands: Vec<DiscoveredCommand> = Vec::new();
    let mut skills: Vec<DiscoveredSkill> = Vec::new();

    match provider.as_str() {
        "claude" => {
            let mut user_commands =
                scan_command_dir(&home.join(".claude/commands"), "claude", "user");

            let mut project_commands: Vec<DiscoveredCommand> = Vec::new();
            if let Some(ref proj) = project_path {
                project_commands =
                    scan_command_dir(&PathBuf::from(proj).join(".claude/commands"), "claude", "project");
            }

            // Project-level overrides user-level (same name → project wins)
            let project_names: std::collections::HashSet<String> =
                project_commands.iter().map(|c| c.name.clone()).collect();
            user_commands.retain(|c| !project_names.contains(&c.name));

            user_commands.sort_by(|a, b| a.name.cmp(&b.name));
            project_commands.sort_by(|a, b| a.name.cmp(&b.name));

            commands.extend(user_commands);
            commands.extend(project_commands);

            // Claude skills
            let mut claude_skills =
                scan_skill_dir(&home.join(".claude/skills"), "claude", "user");
            let mut cc_switch_skills =
                scan_skill_dir(&home.join(".cc-switch/skills"), "claude", "user");
            claude_skills.sort_by(|a, b| a.name.cmp(&b.name));
            cc_switch_skills.sort_by(|a, b| a.name.cmp(&b.name));
            skills.extend(claude_skills);
            skills.extend(cc_switch_skills);
        }
        "codex" => {
            // Codex has NO commands/ directory
            let mut user_skills =
                scan_skill_dir(&home.join(".codex/skills"), "codex", "user");
            user_skills.sort_by(|a, b| a.name.cmp(&b.name));
            skills.extend(user_skills);

            let vendor_path = home.join(".codex/vendor_imports/skills/skills/.curated");
            let mut vendor_skills = scan_skill_dir(&vendor_path, "codex", "vendor");
            vendor_skills.sort_by(|a, b| a.name.cmp(&b.name));
            skills.extend(vendor_skills);
        }
        _ => {
            // cursor, unknown: no discovery
        }
    }

    Ok(CommandDiscoveryResult { commands, skills })
}

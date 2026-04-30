use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use similar::{ChangeTag, TextDiff};
use tauri::{path::BaseDirectory, AppHandle, Manager};

const SENTINEL_START: &str = "# >>> threadterm shell integration";
const SENTINEL_END: &str = "# <<< threadterm shell integration";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellIntegrationPreview {
    pub rc_path: String,
    pub before: String,
    pub after: String,
    pub diff: String,
    /// `true` when `before` and `after` are identical — the install would
    /// be a no-op. The settings UI uses this to enable/disable the
    /// "Install" button.
    pub no_changes: bool,
}

#[tauri::command]
pub async fn preview_shell_integration(
    app: AppHandle,
    shell: String,
) -> Result<ShellIntegrationPreview, String> {
    let rc_path = rc_path_for_shell(&shell)?;
    let script_path = resource_script_path(&app, &shell)?;
    let before = fs::read_to_string(&rc_path).unwrap_or_default();
    let after = build_installed_content(&before, &shell, &script_path.to_string_lossy());
    let diff = unified_diff(&before, &after);
    Ok(ShellIntegrationPreview {
        rc_path: rc_path.to_string_lossy().to_string(),
        no_changes: before == after,
        before,
        after,
        diff,
    })
}

#[tauri::command]
pub async fn install_shell_integration(app: AppHandle, shell: String) -> Result<bool, String> {
    let rc_path = rc_path_for_shell(&shell)?;
    let script_path = resource_script_path(&app, &shell)?;
    install_shell_integration_block(&rc_path, &shell, &script_path.to_string_lossy())
}

#[tauri::command]
pub async fn uninstall_shell_integration(shell: String) -> Result<bool, String> {
    let rc_path = rc_path_for_shell(&shell)?;
    remove_shell_integration_block(&rc_path)
}

/// Detect the current login shell, mapping common variants to the
/// installer's canonical names. Returns `None` for unsupported shells so
/// the frontend can surface a helpful "manual install" hint.
#[tauri::command]
pub async fn detect_shell() -> Result<Option<String>, String> {
    Ok(detect_default_shell())
}

fn detect_default_shell() -> Option<String> {
    if cfg!(windows) {
        return Some("pwsh".to_string());
    }
    let raw = std::env::var("SHELL").ok()?;
    let basename = std::path::Path::new(&raw)
        .file_name()
        .and_then(|name| name.to_str())?
        .to_ascii_lowercase();
    match basename.as_str() {
        "zsh" | "bash" | "fish" => Some(basename),
        "pwsh" | "powershell" => Some("pwsh".to_string()),
        _ => None,
    }
}

pub fn install_shell_integration_block(
    rc_path: &Path,
    shell: &str,
    script_path: &str,
) -> Result<bool, String> {
    let original = fs::read_to_string(rc_path).unwrap_or_default();
    let content = build_installed_content(&original, shell, script_path);

    if content == original {
        return Ok(false);
    }

    if let Some(parent) = rc_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create shell config directory: {error}"))?;
    }
    fs::write(rc_path, content)
        .map_err(|error| format!("Failed to write shell integration config: {error}"))?;
    Ok(true)
}

/// Pure content transformation: drop any pre-existing ThreadTerm block and
/// append a fresh sentinel-wrapped `source` line. Shared by the preview
/// command and the actual installer so both produce byte-identical output.
pub fn build_installed_content(original: &str, shell: &str, script_path: &str) -> String {
    let mut content = remove_block_from_content(original);
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&integration_block(shell, script_path));
    content
}

fn unified_diff(before: &str, after: &str) -> String {
    let diff = TextDiff::from_lines(before, after);
    let mut out = String::new();
    for change in diff.iter_all_changes() {
        let sign = match change.tag() {
            ChangeTag::Delete => "-",
            ChangeTag::Insert => "+",
            ChangeTag::Equal => " ",
        };
        out.push_str(sign);
        out.push_str(change.value());
        if !change.value().ends_with('\n') {
            out.push('\n');
        }
    }
    out
}

pub fn remove_shell_integration_block(rc_path: &Path) -> Result<bool, String> {
    let original = fs::read_to_string(rc_path).unwrap_or_default();
    let content = remove_block_from_content(&original);

    if content == original {
        return Ok(false);
    }

    fs::write(rc_path, content)
        .map_err(|error| format!("Failed to write shell integration config: {error}"))?;
    Ok(true)
}

fn integration_block(shell: &str, script_path: &str) -> String {
    let escaped = script_path.replace('\\', "\\\\").replace('"', "\\\"");
    let source_line =
        if shell.eq_ignore_ascii_case("pwsh") || shell.eq_ignore_ascii_case("powershell") {
            format!(". \"{escaped}\"")
        } else {
            format!("source \"{escaped}\"")
        };

    format!("{SENTINEL_START}\n{source_line}\n{SENTINEL_END}\n")
}

fn remove_block_from_content(input: &str) -> String {
    let mut content = input.to_string();

    while let Some(start) = content.find(SENTINEL_START) {
        let Some(end_offset) = content[start..].find(SENTINEL_END) else {
            break;
        };
        let end = start + end_offset + SENTINEL_END.len();
        let after = if content[end..].starts_with("\r\n") {
            end + 2
        } else if content[end..].starts_with('\n') {
            end + 1
        } else {
            end
        };
        content.replace_range(start..after, "");
    }

    content
}

fn rc_path_for_shell(shell: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Unable to resolve home directory".to_string())?;
    match shell.to_ascii_lowercase().as_str() {
        "zsh" => Ok(home.join(".zshrc")),
        "bash" => Ok(home.join(".bashrc")),
        "fish" => Ok(home.join(".config").join("fish").join("config.fish")),
        "pwsh" | "powershell" => Ok(home
            .join("Documents")
            .join("PowerShell")
            .join("Microsoft.PowerShell_profile.ps1")),
        other => Err(format!(
            "Unsupported shell for ThreadTerm integration: {other}"
        )),
    }
}

fn script_name_for_shell(shell: &str) -> Result<&'static str, String> {
    match shell.to_ascii_lowercase().as_str() {
        "zsh" => Ok("zsh.sh"),
        "bash" => Ok("bash.sh"),
        "fish" => Ok("fish.sh"),
        "pwsh" | "powershell" => Ok("pwsh.ps1"),
        other => Err(format!(
            "Unsupported shell for ThreadTerm integration: {other}"
        )),
    }
}

fn resource_script_path(app: &AppHandle, shell: &str) -> Result<PathBuf, String> {
    let script_name = script_name_for_shell(shell)?;
    app.path()
        .resolve(
            Path::new("resources")
                .join("shell-integration")
                .join(script_name),
            BaseDirectory::Resource,
        )
        .map_err(|error| format!("Unable to resolve shell integration resource path: {error}"))
}

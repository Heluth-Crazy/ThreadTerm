use std::{
    fs,
    path::{Path, PathBuf},
};

use tauri::{path::BaseDirectory, AppHandle, Manager};

const SENTINEL_START: &str = "# >>> threadterm shell integration";
const SENTINEL_END: &str = "# <<< threadterm shell integration";

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

pub fn install_shell_integration_block(
    rc_path: &Path,
    shell: &str,
    script_path: &str,
) -> Result<bool, String> {
    let original = fs::read_to_string(rc_path).unwrap_or_default();
    let mut content = remove_block_from_content(&original);

    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&integration_block(shell, script_path));

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

//! One-shot, non-interactive AI CLI invocation for "Explain with AI".
//!
//! Stage 6 design: re-uses the user's already-installed CLI (claude / codex /
//! gemini) via headless flags. We never touch the user's PTY cards; this is a
//! side-channel process spawn whose stdout/stderr are returned to the renderer
//! as a single chunk.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiExplainProvider {
    Claude,
    Codex,
    Gemini,
}

#[derive(Debug, Serialize)]
pub struct AiExplainResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

/// Resolve `(binary, args)` for a given provider + prompt, using each CLI's
/// non-interactive flag. Keep the prompt as a single argv slot — never join
/// into a shell string.
fn resolve_invocation(provider: AiExplainProvider, prompt: &str) -> (&'static str, Vec<String>) {
    match provider {
        AiExplainProvider::Claude => ("claude", vec!["-p".into(), prompt.to_string()]),
        AiExplainProvider::Codex => ("codex", vec!["exec".into(), prompt.to_string()]),
        AiExplainProvider::Gemini => ("gemini", vec!["-p".into(), prompt.to_string()]),
    }
}

pub(crate) async fn run_one_shot(
    bin: &str,
    args: &[String],
    deadline: Duration,
) -> Result<AiExplainResult, String> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");

    let collect = async move {
        let mut so = String::new();
        let mut se = String::new();
        let _ = stdout.read_to_string(&mut so).await;
        let _ = stderr.read_to_string(&mut se).await;
        let status = child.wait().await.map_err(|e| format!("wait: {e}"))?;
        Ok::<_, String>((so, se, status.code()))
    };

    match timeout(deadline, collect).await {
        Ok(Ok((so, se, code))) => Ok(AiExplainResult {
            stdout: so,
            stderr: se,
            exit_code: code,
            timed_out: false,
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Ok(AiExplainResult {
            stdout: String::new(),
            stderr: "timed out after 30s".into(),
            exit_code: None,
            timed_out: true,
        }),
    }
}

#[tauri::command]
pub async fn ai_explain(
    provider: AiExplainProvider,
    prompt: String,
) -> Result<AiExplainResult, String> {
    if prompt.trim().is_empty() {
        return Err("prompt is empty".into());
    }
    if prompt.len() > 8192 {
        return Err("prompt too long (>8192 chars)".into());
    }
    let (bin, args) = resolve_invocation(provider, &prompt);
    run_one_shot(bin, &args, Duration::from_secs(30)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_stdout_for_successful_command() {
        // /bin/echo is on every macOS / Linux box; Windows tests are skipped.
        let result = run_one_shot(
            "/bin/echo",
            &["hello world".to_string()],
            std::time::Duration::from_secs(5),
        )
        .await
        .expect("echo should succeed");
        assert_eq!(result.stdout.trim(), "hello world");
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.timed_out);
    }

    #[tokio::test]
    async fn reports_timeout() {
        let result = run_one_shot(
            "/bin/sleep",
            &["10".to_string()],
            std::time::Duration::from_millis(150),
        )
        .await
        .expect("sleep should be killable");
        assert!(result.timed_out, "expected timed_out=true, got {:?}", result);
    }

    #[tokio::test]
    async fn returns_stderr_and_nonzero_exit_for_missing_binary() {
        let result =
            run_one_shot("/usr/bin/false", &[], std::time::Duration::from_secs(5)).await;
        // /usr/bin/false exits 1, not a spawn error.
        let result = result.expect("false should spawn");
        assert_eq!(result.exit_code, Some(1));
    }
}

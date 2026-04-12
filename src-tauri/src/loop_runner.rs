use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

use crate::ai;
use crate::pty;

// ── Data types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopConfig {
    pub project_path: String,
    pub worker_provider: String,
    pub verifier_provider: String,
    pub task_prompt: String,
    pub verify_prompt: String,
    pub max_iterations: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LoopStatus {
    Running,
    WaitingVerification,
    Passed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopState {
    pub loop_id: String,
    pub config: LoopConfig,
    pub iteration: u32,
    pub worker_pty_id: Option<String>,
    pub verifier_pty_id: Option<String>,
    pub status: LoopStatus,
    pub last_output: String,
}

// ── Global state ─────────────────────────────────────────────────────────────

static LOOPS: Lazy<Mutex<HashMap<String, LoopState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn update_loop(loop_id: &str, updater: impl FnOnce(&mut LoopState)) {
    if let Ok(mut map) = LOOPS.lock() {
        if let Some(state) = map.get_mut(loop_id) {
            updater(state);
        }
    }
}

fn get_loop(loop_id: &str) -> Option<LoopState> {
    LOOPS.lock().ok()?.get(loop_id).cloned()
}

fn emit_loop_state(app: &AppHandle, state: &LoopState) {
    let _ = app.emit("loop-state-changed", state.clone());
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn loop_start(
    app: AppHandle,
    config: LoopConfig,
) -> Result<LoopState, String> {
    let loop_id = uuid::Uuid::new_v4().to_string();
    let max_iterations = if config.max_iterations == 0 { 3 } else { config.max_iterations };

    // Start worker session
    let worker_pty_id = ai::start_session_internal(
        &app,
        config.project_path.clone(),
        config.worker_provider.clone(),
        None,
    )?;

    let state = LoopState {
        loop_id: loop_id.clone(),
        config: LoopConfig {
            max_iterations,
            ..config.clone()
        },
        iteration: 1,
        worker_pty_id: Some(worker_pty_id.clone()),
        verifier_pty_id: None,
        status: LoopStatus::Running,
        last_output: String::new(),
    };

    {
        let mut map = LOOPS.lock().map_err(|e| format!("Lock error: {e}"))?;
        map.insert(loop_id.clone(), state.clone());
    }

    emit_loop_state(&app, &state);

    // Send the initial task prompt after a short delay
    let task_prompt = config.task_prompt.clone();
    let lid = loop_id.clone();
    let worker_id = worker_pty_id.clone();
    let app_clone = app.clone();

    tokio::spawn(async move {
        // Wait for CLI to initialise
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        // Send the task prompt
        if let Err(e) = pty::pty_write_internal(&worker_id, format!("{task_prompt}\n")) {
            tracing::error!(loop_id = %lid, error = %e, "Failed to send task prompt to worker");
            update_loop(&lid, |s| s.status = LoopStatus::Failed);
            if let Some(s) = get_loop(&lid) {
                emit_loop_state(&app_clone, &s);
            }
            return;
        }

        // Poll worker until complete
        run_loop_iteration(app_clone, lid).await;
    });

    Ok(state)
}

/// Background task that polls the worker, then starts verification.
async fn run_loop_iteration(app: AppHandle, loop_id: String) {
    let poll_interval = std::time::Duration::from_secs(2);
    let idle_threshold = std::time::Duration::from_secs(5);
    let mut idle_start: Option<std::time::Instant> = None;

    loop {
        tokio::time::sleep(poll_interval).await;

        let current = match get_loop(&loop_id) {
            Some(s) => s,
            None => return,
        };

        if current.status == LoopStatus::Cancelled {
            return;
        }

        let worker_id = match &current.worker_pty_id {
            Some(id) => id.clone(),
            None => return,
        };

        // Check worker session state
        let sessions = pty::list_sessions_internal();
        let worker_state = sessions
            .iter()
            .find(|(id, _)| id == &worker_id)
            .map(|(_, s)| s.clone());

        match worker_state {
            Some(pty::SessionState::Completed) | Some(pty::SessionState::Failed) => {
                // Worker finished — proceed to verification
                break;
            }
            Some(pty::SessionState::Idle) => {
                // Track how long it's been idle
                if idle_start.is_none() {
                    idle_start = Some(std::time::Instant::now());
                }
                if idle_start.unwrap().elapsed() > idle_threshold {
                    break;
                }
            }
            _ => {
                idle_start = None;
            }
        }
    }

    // Get worker output
    let current = match get_loop(&loop_id) {
        Some(s) => s,
        None => return,
    };

    if current.status == LoopStatus::Cancelled {
        return;
    }

    let worker_id = match &current.worker_pty_id {
        Some(id) => id.clone(),
        None => return,
    };

    let worker_output = pty::get_recent_output(&worker_id).unwrap_or_default();

    update_loop(&loop_id, |s| {
        s.last_output = worker_output.clone();
        s.status = LoopStatus::WaitingVerification;
    });

    if let Some(s) = get_loop(&loop_id) {
        emit_loop_state(&app, &s);
    }

    // Start verifier session
    let config = current.config.clone();
    let verifier_pty_id = match ai::start_session_internal(
        &app,
        config.project_path.clone(),
        config.verifier_provider.clone(),
        None,
    ) {
        Ok(id) => id,
        Err(e) => {
            tracing::error!(loop_id = %loop_id, error = %e, "Failed to start verifier");
            update_loop(&loop_id, |s| s.status = LoopStatus::Failed);
            if let Some(s) = get_loop(&loop_id) {
                emit_loop_state(&app, &s);
            }
            return;
        }
    };

    update_loop(&loop_id, |s| {
        s.verifier_pty_id = Some(verifier_pty_id.clone());
    });

    // Wait, then send verification prompt
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    let verify_msg = format!(
        "{}\n\nWorker output:\n{}\n\nReply APPROVED if the work is complete and correct, or RETRY: <reason> if it needs more work.\n",
        config.verify_prompt,
        worker_output,
    );

    if let Err(e) = pty::pty_write_internal(&verifier_pty_id, verify_msg) {
        tracing::error!(loop_id = %loop_id, error = %e, "Failed to send verify prompt");
        update_loop(&loop_id, |s| s.status = LoopStatus::Failed);
        if let Some(s) = get_loop(&loop_id) {
            emit_loop_state(&app, &s);
        }
        return;
    }

    // Poll verifier until complete
    let poll_interval = std::time::Duration::from_secs(2);
    let idle_threshold = std::time::Duration::from_secs(5);
    let mut idle_start: Option<std::time::Instant> = None;

    loop {
        tokio::time::sleep(poll_interval).await;

        let current = match get_loop(&loop_id) {
            Some(s) => s,
            None => return,
        };

        if current.status == LoopStatus::Cancelled {
            return;
        }

        let sessions = pty::list_sessions_internal();
        let verifier_state = sessions
            .iter()
            .find(|(id, _)| id == &verifier_pty_id)
            .map(|(_, s)| s.clone());

        match verifier_state {
            Some(pty::SessionState::Completed) | Some(pty::SessionState::Failed) => break,
            Some(pty::SessionState::Idle) => {
                if idle_start.is_none() {
                    idle_start = Some(std::time::Instant::now());
                }
                if idle_start.unwrap().elapsed() > idle_threshold {
                    break;
                }
            }
            _ => {
                idle_start = None;
            }
        }
    }

    // Check verifier output
    let verifier_output = pty::get_recent_output(&verifier_pty_id).unwrap_or_default();
    let upper = verifier_output.to_uppercase();

    if upper.contains("APPROVED") {
        update_loop(&loop_id, |s| {
            s.status = LoopStatus::Passed;
            s.last_output = verifier_output.clone();
        });
        if let Some(s) = get_loop(&loop_id) {
            emit_loop_state(&app, &s);
        }
        tracing::info!(loop_id = %loop_id, "Loop passed verification");
    } else {
        // RETRY or ambiguous → retry if iterations remain
        let current = match get_loop(&loop_id) {
            Some(s) => s,
            None => return,
        };

        if current.iteration >= config.max_iterations {
            update_loop(&loop_id, |s| {
                s.status = LoopStatus::Failed;
                s.last_output = verifier_output.clone();
            });
            if let Some(s) = get_loop(&loop_id) {
                emit_loop_state(&app, &s);
            }
            tracing::info!(loop_id = %loop_id, "Loop failed: max iterations reached");
        } else {
            // Extract feedback from verifier
            let feedback = verifier_output
                .lines()
                .find(|l| l.to_uppercase().starts_with("RETRY"))
                .unwrap_or("Verifier requested retry.")
                .to_string();

            // Start a new worker iteration
            let new_worker = match ai::start_session_internal(
                &app,
                config.project_path.clone(),
                config.worker_provider.clone(),
                None,
            ) {
                Ok(id) => id,
                Err(e) => {
                    tracing::error!(loop_id = %loop_id, error = %e, "Failed to start new worker");
                    update_loop(&loop_id, |s| s.status = LoopStatus::Failed);
                    if let Some(s) = get_loop(&loop_id) {
                        emit_loop_state(&app, &s);
                    }
                    return;
                }
            };

            update_loop(&loop_id, |s| {
                s.iteration += 1;
                s.worker_pty_id = Some(new_worker.clone());
                s.verifier_pty_id = None;
                s.status = LoopStatus::Running;
                s.last_output = verifier_output.clone();
            });

            if let Some(s) = get_loop(&loop_id) {
                emit_loop_state(&app, &s);
            }

            // Send retry prompt
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let retry_prompt = format!(
                "{}\n\nPrevious attempt feedback: {}\n",
                config.task_prompt, feedback,
            );
            if let Err(e) = pty::pty_write_internal(&new_worker, retry_prompt) {
                tracing::error!(loop_id = %loop_id, error = %e, "Failed to send retry prompt");
                update_loop(&loop_id, |s| s.status = LoopStatus::Failed);
                if let Some(s) = get_loop(&loop_id) {
                    emit_loop_state(&app, &s);
                }
                return;
            }

            // Recurse into polling again
            Box::pin(run_loop_iteration(app, loop_id)).await;
        }
    }
}

#[tauri::command]
pub async fn loop_cancel(loop_id: String) -> Result<(), String> {
    update_loop(&loop_id, |s| {
        s.status = LoopStatus::Cancelled;
    });

    // Kill worker and verifier PTYs if still running
    if let Some(state) = get_loop(&loop_id) {
        if let Some(wid) = &state.worker_pty_id {
            let _ = pty::pty_kill(wid.clone()).await;
        }
        if let Some(vid) = &state.verifier_pty_id {
            let _ = pty::pty_kill(vid.clone()).await;
        }
    }

    tracing::info!(loop_id = %loop_id, "Loop cancelled");
    Ok(())
}

#[tauri::command]
pub async fn loop_list() -> Result<Vec<LoopState>, String> {
    let map = LOOPS.lock().map_err(|e| format!("Lock error: {e}"))?;
    Ok(map.values().cloned().collect())
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_loop_config_serde() {
        let config = LoopConfig {
            project_path: "/test".to_string(),
            worker_provider: "claude".to_string(),
            verifier_provider: "codex".to_string(),
            task_prompt: "Fix the bug".to_string(),
            verify_prompt: "Review the fix".to_string(),
            max_iterations: 3,
        };

        let json = serde_json::to_string(&config).expect("serialize");
        let parsed: LoopConfig = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.project_path, "/test");
        assert_eq!(parsed.worker_provider, "claude");
        assert_eq!(parsed.max_iterations, 3);
    }

    #[test]
    fn test_loop_state_serde() {
        let state = LoopState {
            loop_id: "test-loop".to_string(),
            config: LoopConfig {
                project_path: "/proj".to_string(),
                worker_provider: "claude".to_string(),
                verifier_provider: "codex".to_string(),
                task_prompt: "task".to_string(),
                verify_prompt: "verify".to_string(),
                max_iterations: 5,
            },
            iteration: 2,
            worker_pty_id: Some("w1".to_string()),
            verifier_pty_id: None,
            status: LoopStatus::Running,
            last_output: "output".to_string(),
        };

        let json = serde_json::to_string(&state).expect("serialize");
        let parsed: LoopState = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.loop_id, "test-loop");
        assert_eq!(parsed.iteration, 2);
        assert_eq!(parsed.status, LoopStatus::Running);
    }

    #[test]
    fn test_loop_status_serde_values() {
        let cases = vec![
            (LoopStatus::Running, "\"running\""),
            (LoopStatus::WaitingVerification, "\"waiting_verification\""),
            (LoopStatus::Passed, "\"passed\""),
            (LoopStatus::Failed, "\"failed\""),
            (LoopStatus::Cancelled, "\"cancelled\""),
        ];
        for (status, expected) in cases {
            let json = serde_json::to_string(&status).expect("serialize");
            assert_eq!(json, expected);
        }
    }
}

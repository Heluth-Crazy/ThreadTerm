use serde::Deserialize;

use super::types::PtyStartupIntent;

/// Additive v2 PTY creation payload.  It deliberately has no `Debug` or
/// `Serialize` implementation because a startup intent can contain a command.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PtyCreateSessionV2Request {
    pub id: String,
    pub working_dir: String,
    pub rows: u16,
    pub cols: u16,
    pub launch_attempt_id: Option<String>,
    pub startup: PtyStartupIntent,
}

impl PtyCreateSessionV2Request {
    /// Validate only stable, privacy-safe request properties.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_empty() {
            return Err("pty_id_required");
        }
        if self.working_dir.is_empty() {
            return Err("working_dir_required");
        }
        if self.rows == 0 || self.cols == 0 {
            return Err("pty_dimensions_invalid");
        }
        self.startup.validate()
    }
}

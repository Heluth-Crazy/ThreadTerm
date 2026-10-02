use serde::{Deserialize, Serialize};

/// Durable, user-facing attention state. This is deliberately independent of
/// `Session.status`: a chat may be transport-idle while still waiting for the
/// user to read a completed reply.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivity {
    pub state: String,
    pub revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl SessionActivity {
    pub fn new(state: &str, revision: i64, turn_id: Option<&str>, reason: Option<&str>) -> Self {
        Self {
            state: state.to_owned(),
            revision,
            turn_id: turn_id.map(str::to_owned),
            reason: reason.map(str::to_owned),
        }
    }
}

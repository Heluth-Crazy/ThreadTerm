use super::TerminalStartupEffectStore;
use crate::managed_state::{ManagedStateStore, TERMINAL_STORE_KEY};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) struct Fixture(PathBuf);
impl Fixture {
    pub(super) fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("threadterm-{label}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    pub(super) fn store(&self) -> TerminalStartupEffectStore {
        TerminalStartupEffectStore::new(ManagedStateStore::new(self.0.clone()))
    }
    pub(super) fn seed(&self, raw: String) {
        ManagedStateStore::new(self.0.clone())
            .set(TERMINAL_STORE_KEY, raw)
            .unwrap();
    }
    pub(super) fn read(&self) -> Value {
        let value = ManagedStateStore::new(self.0.clone())
            .get(TERMINAL_STORE_KEY)
            .unwrap()
            .value
            .unwrap();
        serde_json::from_str(&value).unwrap()
    }
    pub(super) fn raw(&self) -> String {
        ManagedStateStore::new(self.0.clone())
            .get(TERMINAL_STORE_KEY)
            .unwrap()
            .value
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(super) fn token(n: u8) -> String {
    format!("{n:032x}")
}
pub(super) fn card(id: &str, pty: Option<&str>, count: u64, events: Value) -> Value {
    let mut value = json!({"id": id, "messageCount": count, "events": events, "command": "secret", "cwd": "secret"});
    if let Some(pty) = pty {
        value["ptyId"] = json!(pty);
    }
    value
}
pub(super) fn provider_card(id: &str, pty: &str, provider: &str, session: Option<&str>) -> Value {
    let mut value =
        json!({"id":id,"ptyId":pty,"terminalType":provider,"messageCount":0,"events":[]});
    if let Some(session) = session {
        value["providerSessionId"] = json!(session);
    }
    value
}
pub(super) fn envelope(cards: Vec<Value>, archived: Vec<Value>) -> String {
    serde_json::to_string(&json!({"state":{"cards":cards,"archivedCards":archived},"version":22}))
        .unwrap()
}

//! Bounded, on-demand semantic navigation services.

mod adapters;
mod lsp;
mod manager;
mod transport;

use anyhow::Result;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};

use manager::Manager;

/// Runtime-owned manager for the narrow `editorNavigation.*` surface.
pub struct EditorNavigation {
    inner: Arc<Manager>,
    control_connections: Mutex<HashMap<String, usize>>,
}

pub(crate) struct ControlPresence {
    navigation: Arc<EditorNavigation>,
    principal: String,
}

impl EditorNavigation {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            inner: Manager::new(data_dir),
            control_connections: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn connect(self: &Arc<Self>, principal: &str) -> ControlPresence {
        let mut connections = self
            .control_connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *connections.entry(principal.to_owned()).or_default() += 1;
        ControlPresence {
            navigation: Arc::clone(self),
            principal: principal.to_owned(),
        }
    }

    pub fn dispatch(
        &self,
        db: &crate::db::Database,
        principal: &str,
        method: &str,
        params: &Value,
    ) -> Result<Option<Value>> {
        self.inner.dispatch(db, principal, method, params)
    }

    pub fn disconnect(&self, principal: &str) {
        self.inner.disconnect(principal);
    }

    pub fn shutdown(&self) {
        self.inner.shutdown();
    }
}

impl Drop for ControlPresence {
    fn drop(&mut self) {
        let mut connections = self
            .navigation
            .control_connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match connections.get_mut(&self.principal) {
            Some(count) if *count > 1 => *count -= 1,
            Some(_) => {
                connections.remove(&self.principal);
                // Keep the presence lock until the old contexts are gone. A new
                // connection for this principal cannot be counted and then have
                // its freshly prepared contexts removed by this final old drop.
                self.navigation.disconnect(&self.principal);
            }
            None => {}
        }
    }
}

impl Drop for EditorNavigation {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod control_presence_tests {
    use super::*;

    #[test]
    fn auxiliary_control_drop_keeps_the_principal_present_until_the_last_connection() {
        let root = tempfile::tempdir().unwrap();
        let navigation = Arc::new(EditorNavigation::new(root.path()));
        let primary = navigation.connect("desktop");
        let auxiliary = navigation.connect("desktop");
        assert_eq!(
            navigation
                .control_connections
                .lock()
                .unwrap()
                .get("desktop"),
            Some(&2)
        );
        drop(auxiliary);
        assert_eq!(
            navigation
                .control_connections
                .lock()
                .unwrap()
                .get("desktop"),
            Some(&1)
        );
        drop(primary);
        assert!(!navigation
            .control_connections
            .lock()
            .unwrap()
            .contains_key("desktop"));
    }
}

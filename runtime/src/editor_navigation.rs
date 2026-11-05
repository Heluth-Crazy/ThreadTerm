//! Bounded, on-demand semantic navigation services.

mod adapters;
mod lsp;
mod manager;
mod transport;

use anyhow::Result;
use serde_json::Value;
use std::{path::Path, sync::Arc};

use manager::Manager;

/// Runtime-owned manager for the narrow `editorNavigation.*` surface.
pub struct EditorNavigation {
    inner: Arc<Manager>,
}

impl EditorNavigation {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            inner: Manager::new(data_dir),
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

impl Drop for EditorNavigation {
    fn drop(&mut self) {
        self.shutdown();
    }
}

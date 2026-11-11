//! ThreadTerm V3's independently running, SQLite-backed runtime.
//!
//! The runtime has no Electron dependency.  It is the only writer of the V3
//! database and owns interactive processes for their complete lifetime.

// Keep all runtime diagnostics bounded/redacted without coupling the daemon
// to a desktop-owned pipe. Lexical scope covers the modules below.
macro_rules! eprintln {
    () => { $crate::runtime_log::emit(format_args!("")) };
    ($($arg:tt)*) => { $crate::runtime_log::emit(format_args!($($arg)*)) };
}
pub mod runtime_log;
#[cfg(test)]
mod bounded_read_tests;

#[cfg(windows)]
pub mod bootstrap;
// Sheet preview host and its helper loop (design.md §3.3). `sheet_worker` also builds
// without Windows; the host's helper job is Windows-only.
pub mod sheet_preview;
pub mod sheet_worker;
pub mod config;
pub mod agent_review;
#[cfg(test)] mod agent_review_tests;
pub mod code_review;
#[cfg(test)] mod code_review_tests;
mod chat_queue;
pub(crate) mod chat_fork;
#[cfg(test)]
mod chat_queue_tests;
pub(crate) mod chat_tools;
pub(crate) mod chat_repair;
pub mod conpty;
pub(crate) mod data_backup;
pub mod db;
pub mod delegation;
mod delegation_authority;
pub mod devices;
pub mod domain;
pub mod environment;
pub mod file_ops;
pub mod file_references;
pub(crate) mod external_files;
pub(crate) mod desktop_files;
pub mod editor_navigation;
#[cfg(test)]
mod external_files_boundary_tests;
pub mod git_actions;
pub(crate) mod git_undo;
pub mod git_read;
pub(crate) mod git_selected_commit;
pub mod job;
pub(crate) mod idle_release;
pub mod leases;
pub mod output;
pub mod output_loss;
pub(crate) mod retention;
pub mod project_catalog;
pub mod providers;
pub mod quick_launch;
pub(crate) mod terminal_agents;
pub mod usage_ledger;
mod provider_events;
pub mod plugins;
mod plugin_services;
pub mod pty;
pub mod remote_access;
pub(crate) mod iroh_transport;
pub(crate) mod peer;
pub(crate) mod tunnel;
#[cfg(all(test, windows))]
mod peer_tests;
pub mod retry_scheduler;
pub mod review;
pub mod review_drafts;
pub(crate) mod run_detect;
pub(crate) mod run_repo_config;
pub mod service;
pub mod session_activity;
pub mod session_configs;
pub mod session_metrics;
pub mod session_documents;
pub(crate) mod send_trace;
#[cfg(test)] mod session_documents_tests;
pub mod settings_services;
pub mod singleton;
pub mod transport;
#[cfg(windows)]
pub mod windows_security;
pub mod workspace_services;
pub mod host_files;
pub(crate) mod document_read;
pub mod attachments;

pub const PROTOCOL_VERSION: u32 = 1;
/// Semantic contract includes remote-machine peer handshakes and device profiles. Wire HMAC still uses PROTOCOL_VERSION.
pub const PROTOCOL_CONTRACT: u32 = 20;
pub const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod local_client;
pub mod mcp_delegation;
pub(crate) mod preview;
pub(crate) mod browser_tools;
pub mod mcp_host;
pub mod mcp_lazy;

pub mod turn_speed;
pub mod chat_projection;
pub(crate) mod chat_plan;
pub(crate) mod chat_plan_approval;
mod pi_project_trust;
pub(crate) mod chat_questions;
pub mod protocol_contract;

pub(crate) mod group_chat;
mod group_permissions;
mod group_prerequisites;
mod group_guard;
mod group_folder;
mod group_migration;
mod group_outputs;
#[cfg(test)] mod group_chat_tests;

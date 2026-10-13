//! ThreadTerm V3's independently running, SQLite-backed runtime.
//!
//! The runtime has no Electron dependency.  It is the only writer of the V3
//! database and owns interactive processes for their complete lifetime.

#[cfg(windows)]
pub mod bootstrap;
pub mod config;
pub mod agent_review;
#[cfg(test)] mod agent_review_tests;
mod chat_queue;
pub(crate) mod chat_fork;
#[cfg(test)]
mod chat_queue_tests;
pub(crate) mod chat_tools;
pub(crate) mod chat_repair;
pub mod conpty;
pub mod db;
pub mod delegation;
pub mod devices;
pub mod domain;
pub mod environment;
pub mod file_ops;
pub mod file_references;
pub mod git_actions;
pub mod git_read;
pub(crate) mod git_selected_commit;
pub mod job;
pub mod leases;
pub mod output;
pub mod project_catalog;
pub mod providers;
pub mod quick_launch;
mod provider_events;
pub mod plugins;
mod plugin_services;
pub mod pty;
pub mod remote_access;
pub mod retry_scheduler;
pub mod review;
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

pub const PROTOCOL_VERSION: u32 = 1;
/// Semantic contract includes native-history repair, exact selected-commit snapshots, Chat fork, and feedback notes. Wire HMAC still uses PROTOCOL_VERSION.
pub const PROTOCOL_CONTRACT: u32 = 13;
pub const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod local_client;
pub mod mcp_delegation;
pub(crate) mod preview;
pub mod mcp_host;

pub mod chat_projection;
pub(crate) mod chat_plan;
pub(crate) mod chat_plan_approval;
mod pi_project_trust;
pub(crate) mod chat_questions;
pub mod protocol_contract;

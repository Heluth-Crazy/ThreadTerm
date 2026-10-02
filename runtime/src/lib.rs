//! ThreadTerm V3's independently running, SQLite-backed runtime.
//!
//! The runtime has no Electron dependency.  It is the only writer of the V3
//! database and owns interactive processes for their complete lifetime.

#[cfg(windows)]
pub mod bootstrap;
pub mod config;
pub mod db;
pub mod delegation;
pub mod devices;
pub mod domain;
pub mod file_ops;
pub mod file_references;
pub mod git_actions;
pub mod git_read;
pub mod job;
pub mod leases;
pub mod output;
pub mod project_catalog;
pub mod providers;
pub mod pty;
pub mod remote_access;
pub mod retry_scheduler;
pub mod review;
pub mod service;
pub mod session_activity;
pub mod session_configs;
pub mod session_metrics;
pub mod settings_services;
pub mod singleton;
pub mod transport;
#[cfg(windows)]
pub mod windows_security;
pub mod workspace_services;

pub const PROTOCOL_VERSION: u32 = 1;
/// Semantic Chat contract (choiceId approvals and connection status). Wire HMAC still uses PROTOCOL_VERSION.
pub const PROTOCOL_CONTRACT: u32 = 2;
pub const RUNTIME_VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod local_client;
pub mod mcp_delegation;
pub mod mcp_host;

pub mod chat_projection;
pub mod protocol_contract;

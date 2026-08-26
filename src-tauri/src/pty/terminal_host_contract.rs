//! Compatibility re-export for the public terminal-host contract.
//!
//! The protocol crate is its single source of DTOs, exact tokens, defaults and
//! validation; the desktop keeps this module only for the Phase 0 test path.

#[allow(unused_imports)]
pub use terminal_host_protocol::*;

#[cfg(test)]
#[path = "terminal_host_contract_tests.rs"]
mod tests;

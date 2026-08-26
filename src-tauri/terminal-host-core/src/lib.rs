//! Tauri-free terminal host catalog and bootstrap core.

#![forbid(unsafe_code)]

pub mod catalog;
#[cfg(feature = "pty-runtime")]
pub mod pty;

pub use catalog::*;
#[cfg(feature = "pty-runtime")]
pub use pty::*;

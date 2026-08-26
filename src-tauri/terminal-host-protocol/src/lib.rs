//! Stable, Tauri-free terminal-host protocol contracts and framing.
mod contract;
mod framing;
mod ipc;
pub use contract::*;
pub use framing::*;
pub use ipc::*;

#[cfg(test)]
mod tests;

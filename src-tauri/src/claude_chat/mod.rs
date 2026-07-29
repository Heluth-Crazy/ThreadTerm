//! Claude chat channel compatibility facade.
//!
//! Commands remain available as `claude_chat::claude_chat_*`; implementation
//! lives in responsibility-specific modules so command parsing, sidecar
//! lifecycle, and stdio transport can evolve independently.

mod commands;
mod manager;
mod owner;
mod probe;
mod protocol;
mod transport;

pub use commands::{
    claude_chat_decision, claude_chat_history, claude_chat_interrupt, claude_chat_probe,
    claude_chat_send, claude_chat_set_model, claude_chat_set_permission_mode, claude_chat_start,
    claude_chat_stop,
};

// Keep the DTO paths available to Rust callers even though Tauri is their
// current consumer.
#[allow(unused_imports)]
pub use commands::{ClaudeChatImage, ClaudeChatStartResult};

// `tauri::generate_handler!` resolves both the function and a sibling
// `__cmd__<name>` macro at the path passed by `lib.rs`.
pub use commands::{
    __cmd__claude_chat_decision, __cmd__claude_chat_history, __cmd__claude_chat_interrupt,
    __cmd__claude_chat_probe, __cmd__claude_chat_send, __cmd__claude_chat_set_model,
    __cmd__claude_chat_set_permission_mode, __cmd__claude_chat_start, __cmd__claude_chat_stop,
};

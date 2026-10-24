#[cfg(test)]
mod benchmarks;
pub mod discovery;
pub mod facts;
mod incremental;
pub mod live;
pub mod live_fallback;
mod materialized;
mod membership;
mod native_rebuild;
pub mod prices;
pub mod queries;
pub mod readers;
#[cfg(test)]
mod revision_tests;
pub mod scanner;
mod service;
mod session_ranges;
pub mod source_metadata;
pub mod store;
#[cfg(test)]
mod tests;
pub mod time;
mod write_priority;

pub use service::dispatch;
pub use service::schedule_pricing;

pub fn initialize_connection(conn: &rusqlite::Connection) -> anyhow::Result<()> {
    scanner::initialize(conn)?;
    store::initialize(conn)?;
    live::initialize(conn)?;
    Ok(())
}

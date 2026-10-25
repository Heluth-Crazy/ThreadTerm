#[cfg(test)]
mod benchmarks;
#[cfg(test)]
mod accuracy_export;
#[cfg(test)]
mod accuracy_refresh_tests;
#[cfg(test)]
mod accuracy_query_tests;
#[cfg(test)]
mod attribution_accuracy_tests;
pub mod discovery;
pub mod facts;
mod incremental;
pub mod ledger_db;
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

/// Additive schema hook for the main runtime database, called from
/// `Database::open`. The bulk ledger now lives in its own file, so this only
/// keeps the durable live-usage log. Numbered migrations retire UA1 tables.
pub fn initialize_connection(conn: &rusqlite::Connection) -> anyhow::Result<()> {
    live::initialize_log(conn)?;
    Ok(())
}

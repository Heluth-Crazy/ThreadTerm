use anyhow::Result;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use threadterm_v3_runtime::{
    config::RuntimeConfig, db::Database, service::RuntimeService, singleton::RuntimeLock, transport,
};

#[tokio::main]
async fn main() -> Result<()> {
    #[cfg(windows)]
    if std::env::args().any(|argument| argument == "--pty-bootstrap") {
        std::process::exit(threadterm_v3_runtime::bootstrap::run()?);
    }
    let config = RuntimeConfig::load()?;
    let _singleton = RuntimeLock::acquire(&format!(
        "Local\\ThreadTermV3-{}",
        config.pipe_base.replace('\\', "_")
    ))?;
    // A second pipe name must not permit another daemon to recover or write
    // the same database while its jobs are still running.
    let data_identity = std::fs::canonicalize(&config.data_dir)?
        .to_string_lossy()
        .to_lowercase();
    let _data_singleton = RuntimeLock::acquire(&format!(
        "Local\\ThreadTermV3-Data-{}",
        hex::encode(Sha256::digest(data_identity.as_bytes()))
    ))?;
    let credential = config.credential()?;
    let db = Arc::new(Database::open(&config.database_path)?);
    threadterm_v3_runtime::workspace_services::initialize(&db)?;
    threadterm_v3_runtime::project_catalog::initialize(&db)?;
    threadterm_v3_runtime::settings_services::initialize(&db)?;
    threadterm_v3_runtime::session_configs::initialize(&db)?;
    threadterm_v3_runtime::retry_scheduler::initialize(&db)?;
    threadterm_v3_runtime::review::initialize(&db)?;
    db.mark_live_sessions_interrupted()?;
    let service = Arc::new(RuntimeService::new(config, db));
    service.initialize_remote()?;
    service.start_retry_scheduler();
    let result = transport::serve(Arc::clone(&service), credential).await;
    service.shutdown();
    result
}

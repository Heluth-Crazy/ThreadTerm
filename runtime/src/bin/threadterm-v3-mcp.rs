#[tokio::main]
async fn main() {
    if let Err(error) = threadterm_v3_runtime::mcp_host::run_stdio().await {
        eprintln!("threadterm-v3-mcp: {error:#}");
        std::process::exit(1);
    }
}

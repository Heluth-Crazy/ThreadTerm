#[tokio::main]
async fn main() {
    let args = std::env::args_os().collect::<Vec<_>>();
    // The lazy MCP proxy is a stdio process of its own; it must not load the
    // runtime config (and must not be confused with the terminal host below).
    if args
        .get(1)
        .is_some_and(|arg| arg.as_os_str() == std::ffi::OsStr::new("lazy"))
    {
        if let Err(error) = threadterm_v3_runtime::mcp_lazy::run_cli(&args[2..]) {
            eprintln!("threadterm-v3-mcp lazy: {error:#}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(error) = threadterm_v3_runtime::mcp_host::run_stdio().await {
        eprintln!("threadterm-v3-mcp: {error:#}");
        std::process::exit(1);
    }
}

fn main() {
    #[cfg(not(windows))]
    {
        eprintln!("unsupported_platform");
        std::process::exit(2);
    }

    #[cfg(windows)]
    {
        let options = match threadterm_terminal_host::runtime::parse_cli(std::env::args()) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("{}", error.code());
                std::process::exit(2);
            }
        };
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(value) => value,
            Err(_) => {
                eprintln!("internal_error");
                std::process::exit(1);
            }
        };
        match runtime.block_on(threadterm_terminal_host::runtime::run(options)) {
            Ok(value) => println!("{value}"),
            Err(error) => {
                eprintln!("{}", error.code());
                std::process::exit(1);
            }
        }
    }
}

//! OpenWork CLI — connects to the running OpenWork desktop app via HTTP.
//!
//! Usage:
//!   openwork-cli status              Show running OpenWork instance
//!   openwork-cli ls                  List active sessions
//!   openwork-cli send <id> <text>    Send text to a session

use std::process;

const BASE_URL: &str = "http://localhost:3002";

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        print_usage();
        process::exit(1);
    }

    let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
    rt.block_on(async {
        match args[1].as_str() {
            "status" => cmd_status().await,
            "ls" | "list" => cmd_list().await,
            "send" => {
                if args.len() < 4 {
                    eprintln!("Usage: openwork-cli send <session-id> <text>");
                    process::exit(1);
                }
                cmd_send(&args[2], &args[3]).await;
            }
            "--help" | "-h" | "help" => print_usage(),
            cmd => {
                eprintln!("Unknown command: {cmd}");
                print_usage();
                process::exit(1);
            }
        }
    });
}

fn print_usage() {
    eprintln!("Usage: openwork-cli <command> [args...]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  status              Show running OpenWork instance");
    eprintln!("  ls                  List active sessions");
    eprintln!("  send <id> <text>    Send text to a session");
}

async fn cmd_status() {
    match reqwest::get(format!("{BASE_URL}/health")).await {
        Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().await.unwrap_or_default();
            println!("✅ OpenWork is running: {body}");
        }
        Ok(r) => println!("⚠️  OpenWork returned status {}", r.status()),
        Err(_) => {
            println!("❌ OpenWork is not running (http://localhost:3002 unreachable)");
            println!("   Start the OpenWork desktop app first.");
        }
    }
}

async fn cmd_list() {
    match reqwest::get(format!("{BASE_URL}/api/sessions")).await {
        Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().await.unwrap_or_default();
            if let Some(sessions) = body["sessions"].as_array() {
                if sessions.is_empty() {
                    println!("No active sessions.");
                } else {
                    println!("{:<36}  {}", "SESSION ID", "STATE");
                    println!("{}", "-".repeat(50));
                    for s in sessions {
                        println!(
                            "{:<36}  {}",
                            s["id"].as_str().unwrap_or("-"),
                            s["state"].as_str().unwrap_or("-")
                        );
                    }
                }
            }
        }
        _ => eprintln!("❌ Failed to connect to OpenWork"),
    }
}

async fn cmd_send(session_id: &str, text: &str) {
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "text": format!("{text}\n") });
    match client
        .post(format!("{BASE_URL}/api/sessions/{session_id}/send"))
        .json(&body)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => println!("✅ Sent to session {session_id}"),
        Ok(r) => eprintln!("⚠️  Error: {}", r.status()),
        Err(e) => eprintln!("❌ Failed: {e}"),
    }
}

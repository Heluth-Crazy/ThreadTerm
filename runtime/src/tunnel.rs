//! Strict host-loopback targets for desktop peer tunnels. No DNS or client fallback.
use anyhow::{anyhow, Result};
use serde_json::Value;
use std::{
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};
use tokio::net::TcpStream;

pub(crate) fn target(auth: &Value) -> Result<SocketAddr> {
    let ip = match auth.get("loopback").and_then(Value::as_str) {
        Some("127.0.0.1") => IpAddr::V4(Ipv4Addr::LOCALHOST),
        Some("::1") => IpAddr::V6(Ipv6Addr::LOCALHOST),
        _ => return Err(anyhow!("invalid tunnel loopback")),
    };
    let port = auth
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65535).contains(port))
        .ok_or_else(|| anyhow!("invalid tunnel port"))? as u16;
    Ok(SocketAddr::new(ip, port))
}

#[cfg(debug_assertions)]
fn mapped_port(port: u16, mapping: Option<&str>) -> u16 {
    mapping
        .and_then(|mapping| {
            mapping.split(',').find_map(|entry| {
                let (from, to) = entry.trim().split_once(':')?;
                let from = from.parse::<u16>().ok()?;
                let to = to.parse::<u16>().ok()?;
                (from == port && to != 0).then_some(to)
            })
        })
        .unwrap_or(port)
}

pub(crate) async fn connect(target: SocketAddr) -> io::Result<TcpStream> {
    #[cfg(debug_assertions)]
    let target = SocketAddr::new(
        target.ip(),
        mapped_port(
            target.port(),
            std::env::var("THREADTERM_QA_TUNNEL_PORT_MAP")
                .ok()
                .as_deref(),
        ),
    );
    tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(target))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "tunnel connect timed out"))?
}

pub(crate) fn failure_code(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::ConnectionRefused => "connection_refused",
        io::ErrorKind::TimedOut => "connection_timeout",
        _ => "connection_failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_literal_loopback_and_valid_integer_ports() {
        for ip in ["127.0.0.1", "::1"] {
            for port in [1, 5173, 65535] {
                assert_eq!(
                    target(&json!({"loopback":ip,"port":port})).unwrap().port(),
                    port as u16
                );
            }
        }
        for ip in [
            "localhost",
            "127.0.0.2",
            "0.0.0.0",
            "::",
            "[::1]",
            "example.com",
        ] {
            assert!(target(&json!({"loopback":ip,"port":5173})).is_err());
        }
        for port in [
            json!(0),
            json!(65536),
            json!(-1),
            json!(1.5),
            json!("80"),
            Value::Null,
        ] {
            assert!(target(&json!({"loopback":"127.0.0.1","port":port})).is_err());
        }
    }
    #[cfg(debug_assertions)]
    #[test]
    fn qa_mapping_is_opt_in_and_validated() {
        assert_eq!(mapped_port(5173, None), 5173);
        assert_eq!(mapped_port(5173, Some("5173:5190,80:8080")), 5190);
        assert_eq!(mapped_port(5173, Some("80:8080")), 5173);
        assert_eq!(mapped_port(5173, Some("5173:0,5173:65536,bad")), 5173);
    }
}

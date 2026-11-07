use crate::{
    client::{Connections, MachineConnection},
    error::ClientError,
    transport::BoxIo,
    ProxyInfo,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr},
    sync::{Arc, Mutex},
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{watch, Semaphore},
    task::AbortHandle,
};
use url::{Host, Url};

const MAX_PROXY_CONNECTIONS: usize = 64;
const MAX_PROXY_HEADER: usize = 64 * 1024;
const PROXY_HEADER_TIMEOUT: Duration = Duration::from_secs(15);
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) struct Proxies {
    entries: Mutex<HashMap<String, ProxyHandle>>,
}

struct ProxyHandle {
    shutdown: watch::Sender<bool>,
    accept_abort: AbortHandle,
}

impl ProxyHandle {
    fn stop(&self) {
        self.shutdown.send_replace(true);
        self.accept_abort.abort();
    }
}

impl Drop for ProxyHandle {
    fn drop(&mut self) {
        // Concurrent starts can replace an entry after both callers stopped
        // the previous proxy. Dropping the displaced handle must still close
        // its listener and every child carrying this shutdown receiver.
        self.stop();
    }
}

#[derive(Debug)]
struct Target {
    host: String,
    port: u16,
}

struct ParsedRequest {
    method: String,
    target: Target,
    rewritten: Option<Vec<u8>>,
    remainder: Vec<u8>,
}

impl Proxies {
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) async fn start(
        &self,
        machine_id: &str,
        connections: &Connections,
    ) -> Result<ProxyInfo, ClientError> {
        self.stop(machine_id)?;
        let connection = connections
            .entry(machine_id)?
            .filter(|connection| connection.is_active())
            .ok_or_else(|| ClientError::NotConnected("computer is not connected".into()))?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(ClientError::from)?;
        let port = listener.local_addr().map_err(ClientError::from)?.port();
        let mut secret = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut secret);
        let secret = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret);
        let username = "threadterm".to_owned();
        let expected =
            format!("Basic {}", STANDARD.encode(format!("{username}:{secret}"))).into_bytes();
        let (shutdown, receiver) = watch::channel(false);
        let task = tokio::spawn(accept_loop(listener, connection, expected, receiver));
        let info = ProxyInfo {
            port,
            username,
            secret,
        };
        let handle = ProxyHandle {
            shutdown,
            accept_abort: task.abort_handle(),
        };
        self.entries
            .lock()
            .map_err(|_| ClientError::internal("proxy registry lock poisoned"))?
            .insert(machine_id.to_owned(), handle);
        Ok(info)
    }

    pub(crate) fn stop(&self, machine_id: &str) -> Result<(), ClientError> {
        if let Some(handle) = self
            .entries
            .lock()
            .map_err(|_| ClientError::internal("proxy registry lock poisoned"))?
            .remove(machine_id)
        {
            handle.stop();
        }
        Ok(())
    }

    pub(crate) fn stop_all(&self) -> Result<(), ClientError> {
        let handles = std::mem::take(
            &mut *self
                .entries
                .lock()
                .map_err(|_| ClientError::internal("proxy registry lock poisoned"))?,
        );
        for (_, handle) in handles {
            handle.stop();
        }
        Ok(())
    }
}

async fn accept_loop(
    listener: TcpListener,
    connection: Arc<MachineConnection>,
    expected_authorization: Vec<u8>,
    mut shutdown: watch::Receiver<bool>,
) {
    let capacity = Arc::new(Semaphore::new(MAX_PROXY_CONNECTIONS));
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() { break; }
            }
            accepted = listener.accept() => {
                let Ok((socket, _)) = accepted else { break; };
                let Ok(permit) = Arc::clone(&capacity).try_acquire_owned() else {
                    drop(socket);
                    continue;
                };
                let connection = Arc::clone(&connection);
                let expected = expected_authorization.clone();
                let receiver = shutdown.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let _ = serve(socket, connection, &expected, receiver).await;
                });
            }
        }
    }
}

async fn serve(
    mut client: TcpStream,
    connection: Arc<MachineConnection>,
    expected_authorization: &[u8],
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), ClientError> {
    client.set_nodelay(true).map_err(ClientError::from)?;
    let header = tokio::time::timeout(PROXY_HEADER_TIMEOUT, read_header(&mut client))
        .await
        .map_err(|_| ClientError::RequestTimeout("proxy request header timed out".into()))??;
    let request = match parse_request(&header, expected_authorization) {
        Ok(request) => request,
        Err(ProxyParseError::Unauthorized) => {
            client.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"ThreadTerm computer\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.map_err(ClientError::from)?;
            return Ok(());
        }
        Err(ProxyParseError::BadRequest) => {
            client
                .write_all(
                    b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .map_err(ClientError::from)?;
            return Ok(());
        }
    };
    let mut upstream = match dial(&connection, &request.target).await {
        Ok(stream) => stream,
        Err(_) => {
            client
                .write_all(
                    b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .map_err(ClientError::from)?;
            return Ok(());
        }
    };
    if request.method.eq_ignore_ascii_case("CONNECT") {
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .map_err(ClientError::from)?;
    } else if let Some(rewritten) = request.rewritten {
        upstream
            .write_all(&rewritten)
            .await
            .map_err(ClientError::from)?;
    }
    if !request.remainder.is_empty() {
        upstream
            .write_all(&request.remainder)
            .await
            .map_err(ClientError::from)?;
    }
    tokio::select! {
        result = tokio::io::copy_bidirectional(&mut client, &mut upstream) => {
            result.map_err(ClientError::from)?;
        }
        changed = shutdown.changed() => {
            let _ = changed;
        }
    }
    Ok(())
}

async fn read_header(stream: &mut TcpStream) -> Result<Vec<u8>, ClientError> {
    let mut bytes = Vec::with_capacity(2048);
    loop {
        if bytes.len() >= MAX_PROXY_HEADER {
            return Err(ClientError::protocol("proxy request headers are too large"));
        }
        let mut chunk = [0u8; 2048];
        let count = stream.read(&mut chunk).await.map_err(ClientError::from)?;
        if count == 0 {
            return Err(ClientError::protocol("proxy request closed before headers"));
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(header_end) = bytes
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
        {
            if header_end > MAX_PROXY_HEADER {
                return Err(ClientError::protocol("proxy request headers are too large"));
            }
            return Ok(bytes);
        }
        if bytes.len() >= MAX_PROXY_HEADER {
            return Err(ClientError::protocol("proxy request headers are too large"));
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ProxyParseError {
    Unauthorized,
    BadRequest,
}

fn parse_request(
    bytes: &[u8],
    expected_authorization: &[u8],
) -> Result<ParsedRequest, ProxyParseError> {
    let mut headers = [httparse::EMPTY_HEADER; 96];
    let mut parsed = httparse::Request::new(&mut headers);
    let consumed = match parsed
        .parse(bytes)
        .map_err(|_| ProxyParseError::BadRequest)?
    {
        httparse::Status::Complete(consumed) => consumed,
        httparse::Status::Partial => return Err(ProxyParseError::BadRequest),
    };
    let method = parsed.method.ok_or(ProxyParseError::BadRequest)?.to_owned();
    let path = parsed.path.ok_or(ProxyParseError::BadRequest)?;
    if parsed.version != Some(1) || method.len() > 32 || method.chars().any(char::is_control) {
        return Err(ProxyParseError::BadRequest);
    }
    let authorization = parsed
        .headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case("proxy-authorization"))
        .map(|header| trim_ascii(header.value))
        .unwrap_or_default();
    if authorization.len() != expected_authorization.len()
        || !bool::from(authorization.ct_eq(expected_authorization))
    {
        return Err(ProxyParseError::Unauthorized);
    }
    let (target, rewritten) = if method.eq_ignore_ascii_case("CONNECT") {
        (target_from_authority(path)?, None)
    } else {
        let url = Url::parse(path).map_err(|_| ProxyParseError::BadRequest)?;
        if url.scheme() != "http"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(ProxyParseError::BadRequest);
        }
        let target = target_from_url(&url)?;
        let mut rewritten = format!("{method} {} HTTP/1.1\r\n", origin_form(&url)).into_bytes();
        let upgrade = parsed
            .headers
            .iter()
            .any(|header| header.name.eq_ignore_ascii_case("upgrade"));
        for header in parsed.headers.iter() {
            if header.name.eq_ignore_ascii_case("proxy-authorization")
                || header.name.eq_ignore_ascii_case("proxy-connection")
                || header.name.eq_ignore_ascii_case("connection")
                || header.name.eq_ignore_ascii_case("keep-alive")
            {
                continue;
            }
            rewritten.extend_from_slice(header.name.as_bytes());
            rewritten.extend_from_slice(b": ");
            rewritten.extend_from_slice(header.value);
            rewritten.extend_from_slice(b"\r\n");
        }
        if upgrade {
            rewritten.extend_from_slice(b"Connection: Upgrade\r\n");
        } else {
            rewritten.extend_from_slice(b"Connection: close\r\n");
        }
        rewritten.extend_from_slice(b"\r\n");
        (target, Some(rewritten))
    };
    Ok(ParsedRequest {
        method,
        target,
        rewritten,
        remainder: bytes[consumed..].to_vec(),
    })
}

fn trim_ascii(mut value: &[u8]) -> &[u8] {
    while value.first().is_some_and(u8::is_ascii_whitespace) {
        value = &value[1..];
    }
    while value.last().is_some_and(u8::is_ascii_whitespace) {
        value = &value[..value.len() - 1];
    }
    value
}

fn target_from_authority(authority: &str) -> Result<Target, ProxyParseError> {
    if authority.contains('/')
        || authority.contains('?')
        || authority.contains('#')
        || authority.contains('@')
    {
        return Err(ProxyParseError::BadRequest);
    }
    let url =
        Url::parse(&format!("http://{authority}/")).map_err(|_| ProxyParseError::BadRequest)?;
    let mut target = target_from_url(&url)?;
    if url.port().is_none() {
        target.port = 443;
    }
    Ok(target)
}

fn target_from_url(url: &Url) -> Result<Target, ProxyParseError> {
    let host = match url.host().ok_or(ProxyParseError::BadRequest)? {
        Host::Domain(host) => host.trim_end_matches('.').to_ascii_lowercase(),
        Host::Ipv4(host) => host.to_string(),
        Host::Ipv6(host) => host.to_string(),
    };
    if host.is_empty() {
        return Err(ProxyParseError::BadRequest);
    }
    let port = url
        .port_or_known_default()
        .ok_or(ProxyParseError::BadRequest)?;
    if port == 0 {
        return Err(ProxyParseError::BadRequest);
    }
    Ok(Target { host, port })
}

fn origin_form(url: &Url) -> String {
    let mut value = if url.path().is_empty() {
        "/".to_owned()
    } else {
        url.path().to_owned()
    };
    if let Some(query) = url.query() {
        value.push('?');
        value.push_str(query);
    }
    value
}

async fn dial(connection: &MachineConnection, target: &Target) -> Result<BoxIo, ClientError> {
    if let Some(loopback) = literal_loopback(&target.host) {
        return Ok(Box::new(
            connection.open_tunnel(target.port, loopback).await?,
        ));
    }
    let addresses = tokio::time::timeout(
        DIAL_TIMEOUT,
        tokio::net::lookup_host((target.host.as_str(), target.port)),
    )
    .await
    .map_err(|_| ClientError::Unreachable("DNS lookup timed out".into()))?
    .map_err(ClientError::from)?
    .take(32)
    .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(ClientError::Unreachable("address was not found".into()));
    }
    if let Some(loopback) = addresses
        .iter()
        .find_map(|address| ip_loopback(address.ip()))
    {
        return Ok(Box::new(
            connection.open_tunnel(target.port, loopback).await?,
        ));
    }
    let mut last = None;
    for address in addresses {
        match tokio::time::timeout(DIAL_TIMEOUT, TcpStream::connect(address)).await {
            Ok(Ok(stream)) => {
                stream.set_nodelay(true).map_err(ClientError::from)?;
                return Ok(Box::new(stream));
            }
            Ok(Err(error)) => last = Some(error.to_string()),
            Err(_) => last = Some("connection timed out".into()),
        }
    }
    Err(ClientError::Unreachable(
        last.unwrap_or_else(|| "address did not respond".into()),
    ))
}

fn literal_loopback(host: &str) -> Option<&'static str> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return Some("127.0.0.1");
    }
    host.parse::<IpAddr>().ok().and_then(ip_loopback)
}

fn ip_loopback(address: IpAddr) -> Option<&'static str> {
    match address {
        IpAddr::V4(address) if address.octets()[0] == 127 => Some("127.0.0.1"),
        IpAddr::V6(address) if address.is_loopback() => Some("::1"),
        IpAddr::V6(address)
            if address
                .to_ipv4_mapped()
                .is_some_and(|mapped| mapped.octets()[0] == 127) =>
        {
            Some("127.0.0.1")
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth() -> Vec<u8> {
        b"Basic dGhyZWFkdGVybTpzZWNyZXQ=".to_vec()
    }

    #[test]
    fn proxy_requires_exact_authorization_and_rewrites_absolute_http() {
        let request = b"GET http://example.test/a?q=1 HTTP/1.1\r\nHost: example.test\r\nProxy-Authorization: Basic dGhyZWFkdGVybTpzZWNyZXQ=\r\n\r\n";
        let parsed = parse_request(request, &auth()).unwrap();
        let rewritten = String::from_utf8(parsed.rewritten.unwrap()).unwrap();
        assert!(rewritten.starts_with("GET /a?q=1 HTTP/1.1\r\n"));
        assert!(!rewritten
            .to_ascii_lowercase()
            .contains("proxy-authorization"));
        assert!(matches!(
            parse_request(request, b"Basic wrong"),
            Err(ProxyParseError::Unauthorized)
        ));
    }

    #[test]
    fn connect_parsing_canonicalizes_loopback_aliases() {
        for authority in [
            "localhost:3000",
            "app.localhost:3000",
            "127.1:3000",
            "0x7f000001:3000",
            "[::1]:3000",
        ] {
            let target = target_from_authority(authority).unwrap();
            assert!(
                literal_loopback(&target.host).is_some(),
                "{authority} -> {}",
                target.host
            );
        }
        assert_eq!(literal_loopback("example.com"), None);
    }

    #[test]
    fn mapped_ipv6_loopback_never_dials_directly() {
        let mapped: IpAddr = "::ffff:127.0.0.7".parse().unwrap();
        assert_eq!(ip_loopback(mapped), Some("127.0.0.1"));
        assert_eq!(
            ip_loopback(std::net::SocketAddr::from(([8, 8, 8, 8], 53)).ip()),
            None
        );
    }
}

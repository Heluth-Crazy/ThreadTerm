use crate::{
    descriptor::{check_code, normalize_code, PairDescriptor},
    error::ClientError,
    transport::{Dialer, IrohDialer, PinnedTls, HTTP_ALPN},
};
use serde::Deserialize;
use std::time::{Duration, Instant};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use url::Url;

const PAIRING_CONNECTION_TTL: Duration = Duration::from_secs(60);
const MAX_HTTP_HEADERS: usize = 64 * 1024;
const MAX_PAIR_BODY: usize = 1024 * 1024;

pub(crate) struct PendingPairing {
    descriptor: PairDescriptor,
    endpoint: String,
    transport: String,
    stream: PinnedTls,
    created_at: Instant,
}

impl PendingPairing {
    pub(crate) fn is_expired(&self) -> bool {
        self.created_at.elapsed() > PAIRING_CONNECTION_TTL
    }
}

pub(crate) struct PreparedPairing {
    pub pending: PendingPairing,
    pub check_code: String,
    pub endpoint: String,
    pub transport: String,
}

#[derive(Debug)]
pub(crate) struct CompletedPairing {
    pub machine_id: String,
    pub credential: String,
    pub permission: String,
    pub expires_at: String,
    pub endpoint: String,
    pub transport: String,
    pub tls_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    token: String,
    device: PairedDevice,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairedDevice {
    id: String,
    permission: String,
    expires_at: String,
    profile: String,
}

pub(crate) async fn prepare(text: &str, iroh: IrohDialer) -> Result<PreparedPairing, ClientError> {
    let descriptor = PairDescriptor::parse(text)?;
    let endpoint = descriptor.endpoint();
    let transport = if descriptor.iroh.is_some() {
        "iroh"
    } else {
        "tls"
    }
    .to_owned();
    let dialer = Dialer::new(endpoint.clone(), descriptor.tls_fingerprint.clone(), iroh)?;
    // No HTTP or credential byte is written until the certificate DER pin and
    // the exact HTTP ALPN have both been checked by open_tls.
    let stream = dialer.open_tls(HTTP_ALPN).await?;
    Ok(PreparedPairing {
        check_code: check_code(&descriptor.tls_fingerprint)?,
        endpoint: endpoint.clone(),
        transport: transport.clone(),
        pending: PendingPairing {
            descriptor,
            endpoint,
            transport,
            stream,
            created_at: Instant::now(),
        },
    })
}

pub(crate) async fn confirm(
    mut pending: PendingPairing,
    device_name: &str,
) -> Result<CompletedPairing, ClientError> {
    if pending.created_at.elapsed() > PAIRING_CONNECTION_TTL {
        return Err(ClientError::PairingExpired(
            "pairing confirmation window expired".into(),
        ));
    }
    let name = device_name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(ClientError::InvalidPairing("invalid device name".into()));
    }
    let body = serde_json::to_vec(&serde_json::json!({
        "pairingId": pending.descriptor.pairing_id,
        "code": normalize_code(&pending.descriptor.code),
        "deviceName": name,
    }))
    .map_err(ClientError::internal)?;
    let server = Url::parse(&pending.descriptor.server_url)
        .map_err(|_| ClientError::InvalidPairing("invalid server address".into()))?;
    let host = server
        .host_str()
        .map(|host| {
            if host.contains(':') {
                format!("[{host}]")
            } else {
                host.to_owned()
            }
        })
        .ok_or_else(|| ClientError::InvalidPairing("invalid server address".into()))?;
    let host = match server.port_or_known_default() {
        Some(443) => host,
        Some(port) => format!("{host}:{port}"),
        _ => return Err(ClientError::InvalidPairing("invalid server address".into())),
    };
    let request = format!(
        "POST /v1/pair HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    pending
        .stream
        .write_all(request.as_bytes())
        .await
        .map_err(ClientError::from)?;
    pending
        .stream
        .write_all(&body)
        .await
        .map_err(ClientError::from)?;
    pending.stream.flush().await.map_err(ClientError::from)?;
    let (status, response_body) =
        tokio::time::timeout(Duration::from_secs(15), read_response(&mut pending.stream))
            .await
            .map_err(|_| ClientError::RequestTimeout("pairing request timed out".into()))??;
    let value: serde_json::Value = serde_json::from_slice(&response_body)
        .map_err(|_| ClientError::protocol("pairing response was not JSON"))?;
    if status != 200 {
        let code = value
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(|code| code.as_str())
            .or_else(|| value.get("code").and_then(|code| code.as_str()))
            .unwrap_or("invalid_pairing");
        return Err(if code.contains("expired") {
            ClientError::PairingExpired(format!("{code}: pairing failed"))
        } else {
            ClientError::InvalidPairing(format!("{code}: pairing failed"))
        });
    }
    let response: PairResponse = serde_json::from_value(value)
        .map_err(|_| ClientError::protocol("invalid pairing response"))?;
    validate_pair_response(&response)?;
    Ok(CompletedPairing {
        machine_id: response.device.id,
        credential: response.token,
        permission: response.device.permission,
        expires_at: response.device.expires_at,
        endpoint: pending.endpoint,
        transport: pending.transport,
        tls_fingerprint: pending.descriptor.tls_fingerprint,
    })
}

fn validate_pair_response(response: &PairResponse) -> Result<(), ClientError> {
    if uuid::Uuid::parse_str(&response.device.id).is_err()
        || !matches!(
            response.device.permission.as_str(),
            "readonly" | "fullcontrol"
        )
        || response.token.len() < 32
        || response.token.len() > 128
        || response.token.chars().any(char::is_control)
        || response.device.profile != "mobile"
    {
        return Err(ClientError::protocol("invalid pairing response"));
    }
    let expiry = OffsetDateTime::parse(&response.device.expires_at, &Rfc3339)
        .map_err(|_| ClientError::protocol("invalid device expiry"))?;
    if expiry <= OffsetDateTime::now_utc() {
        return Err(ClientError::PairingExpired(
            "paired credential was already expired".into(),
        ));
    }
    Ok(())
}

async fn read_response<R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<(u16, Vec<u8>), ClientError> {
    let mut reader = BufReader::new(stream);
    let status_line = read_header_line(&mut reader, 0).await?;
    let mut parts = status_line.split_whitespace();
    let version = parts.next().unwrap_or_default();
    let status = parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| ClientError::protocol("invalid HTTP status"))?;
    if !matches!(version, "HTTP/1.1" | "HTTP/1.0") || !(100..=599).contains(&status) {
        return Err(ClientError::protocol("invalid HTTP status"));
    }
    let mut total = status_line.len() + 2;
    let mut content_length = None;
    let mut chunked = false;
    let mut transfer_encoding = false;
    let mut header_count = 0;
    loop {
        let line = read_header_line(&mut reader, total).await?;
        total += line.len() + 2;
        if line.is_empty() {
            break;
        }
        header_count += 1;
        if header_count > 100 {
            return Err(ClientError::protocol("too many HTTP headers"));
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| ClientError::protocol("invalid HTTP header"))?;
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(ClientError::protocol("duplicate Content-Length"));
            }
            content_length = Some(
                value
                    .parse::<usize>()
                    .map_err(|_| ClientError::protocol("invalid Content-Length"))?,
            );
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            if transfer_encoding {
                return Err(ClientError::protocol("duplicate Transfer-Encoding"));
            }
            transfer_encoding = true;
            let encodings = value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            if encodings.len() != 1 || !encodings[0].eq_ignore_ascii_case("chunked") {
                return Err(ClientError::protocol("unsupported Transfer-Encoding"));
            }
            chunked = true;
        }
    }
    if chunked && content_length.is_some() {
        return Err(ClientError::protocol("ambiguous HTTP response length"));
    }
    let body = if chunked {
        read_chunked(&mut reader).await?
    } else {
        let length = content_length
            .ok_or_else(|| ClientError::protocol("pairing response omitted Content-Length"))?;
        if length > MAX_PAIR_BODY {
            return Err(ClientError::protocol("pairing response is too large"));
        }
        let mut body = vec![0; length];
        reader
            .read_exact(&mut body)
            .await
            .map_err(ClientError::from)?;
        body
    };
    Ok((status, body))
}

async fn read_header_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    consumed: usize,
) -> Result<String, ClientError> {
    let remaining = MAX_HTTP_HEADERS
        .checked_sub(consumed)
        .ok_or_else(|| ClientError::protocol("HTTP headers are too large"))?;
    let mut bytes = Vec::new();
    let count = reader
        .take((remaining.saturating_add(1)) as u64)
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(ClientError::from)?;
    if count == 0 || count > remaining || !bytes.ends_with(b"\r\n") {
        return Err(ClientError::protocol("invalid HTTP headers"));
    }
    bytes.truncate(bytes.len() - 2);
    String::from_utf8(bytes).map_err(|_| ClientError::protocol("invalid HTTP headers"))
}

async fn read_chunked<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, ClientError> {
    let mut body = Vec::new();
    loop {
        let line = read_header_line(reader, 0).await?;
        let size = usize::from_str_radix(line.split(';').next().unwrap_or_default().trim(), 16)
            .map_err(|_| ClientError::protocol("invalid chunk size"))?;
        if size == 0 {
            let mut trailers = 0;
            loop {
                let line = read_header_line(reader, trailers).await?;
                trailers += line.len() + 2;
                if line.is_empty() {
                    break;
                }
            }
            return Ok(body);
        }
        if body
            .len()
            .checked_add(size)
            .is_none_or(|length| length > MAX_PAIR_BODY)
        {
            return Err(ClientError::protocol("pairing response is too large"));
        }
        let start = body.len();
        body.resize(start + size, 0);
        reader
            .read_exact(&mut body[start..])
            .await
            .map_err(ClientError::from)?;
        let mut ending = [0; 2];
        reader
            .read_exact(&mut ending)
            .await
            .map_err(ClientError::from)?;
        if ending != *b"\r\n" {
            return Err(ClientError::protocol("invalid chunk ending"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    async fn response_result(bytes: &'static [u8]) -> Result<(u16, Vec<u8>), ClientError> {
        let (mut client, mut server) = tokio::io::duplex(2048);
        tokio::spawn(async move {
            server.write_all(bytes).await.unwrap();
        });
        read_response(&mut client).await
    }

    #[tokio::test]
    async fn parses_bounded_content_length_response() {
        assert_eq!(
            response_result(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .await
                .unwrap(),
            (200, b"{}".to_vec())
        );
    }

    #[tokio::test]
    async fn rejects_ambiguous_or_unsupported_response_lengths() {
        for bytes in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}".as_slice(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n{}".as_slice(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n".as_slice(),
        ] {
            assert!(matches!(
                response_result(bytes).await,
                Err(ClientError::Protocol(_))
            ));
        }
    }

    #[test]
    fn pair_response_rejects_non_mobile_profile() {
        let result = PairResponse {
            token: "x".repeat(43),
            device: PairedDevice {
                id: uuid::Uuid::new_v4().to_string(),
                permission: "readonly".into(),
                expires_at: "2999-01-01T00:00:00Z".into(),
                profile: "desktop".into(),
            },
        };
        assert!(validate_pair_response(&result).is_err());
    }
}

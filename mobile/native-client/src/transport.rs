use crate::{descriptor::normalize_pin, error::ClientError, framing};
use iroh::{
    endpoint::{presets, Connection, Endpoint},
    EndpointAddr, EndpointId, RelayUrl, SecretKey,
};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fmt::Debug, str::FromStr, sync::Arc, time::Duration};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::{
    client::TlsStream,
    rustls::{
        self,
        client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
        crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider},
        pki_types::{CertificateDer, ServerName, UnixTime},
        DigitallySignedStruct, SignatureScheme,
    },
    TlsConnector,
};
use url::Url;

pub(crate) const IROH_ALPN: &[u8] = b"threadterm-iroh/1";
pub(crate) const MOBILE_ALPN: &[u8] = b"threadterm-mobile/1";
pub(crate) const HTTP_ALPN: &[u8] = b"http/1.1";

pub(crate) trait AsyncIo: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> AsyncIo for T {}
pub(crate) type BoxIo = Box<dyn AsyncIo>;
pub(crate) type PinnedTls = TlsStream<BoxIo>;

#[derive(Debug)]
struct PinnedVerifier {
    expected: [u8; 32],
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let actual: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
        if actual != self.expected {
            return Err(rustls::Error::General("pin_mismatch".into()));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[derive(Clone)]
pub(crate) struct IrohDialer {
    endpoint: Endpoint,
    cached: Arc<tokio::sync::Mutex<HashMap<EndpointId, Connection>>>,
    secret_hex: String,
}

impl IrohDialer {
    pub(crate) async fn bind(secret: SecretKey) -> Result<Self, ClientError> {
        let secret_hex = hex::encode(secret.to_bytes());
        let endpoint = Endpoint::builder(presets::N0)
            .secret_key(secret)
            .bind()
            .await
            .map_err(|error| ClientError::Internal(format!("starting iroh: {error:#}")))?;
        Ok(Self {
            endpoint,
            cached: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            secret_hex,
        })
    }

    async fn stream(&self, id: EndpointId, relay: Option<RelayUrl>) -> Result<BoxIo, ClientError> {
        let existing = self.cached.lock().await.get(&id).cloned();
        if let Some(connection) = existing {
            if connection.close_reason().is_none() {
                if let Ok(Ok((send, recv))) =
                    tokio::time::timeout(Duration::from_secs(10), connection.open_bi()).await
                {
                    return Ok(Box::new(tokio::io::join(recv, send)));
                }
            }
            self.cached.lock().await.remove(&id);
        }
        let mut address = EndpointAddr::new(id);
        if let Some(relay) = relay {
            address = address.with_relay_url(relay);
        }
        let connection = tokio::time::timeout(
            Duration::from_secs(30),
            self.endpoint.connect(address, IROH_ALPN),
        )
        .await
        .map_err(|_| ClientError::Unreachable("iroh connection timed out".into()))?
        .map_err(|error| ClientError::Unreachable(format!("iroh connection failed: {error:#}")))?;
        let (send, recv) = tokio::time::timeout(Duration::from_secs(10), connection.open_bi())
            .await
            .map_err(|_| ClientError::Unreachable("opening iroh stream timed out".into()))?
            .map_err(|error| ClientError::Unreachable(format!("opening iroh stream: {error:#}")))?;
        self.cached.lock().await.insert(id, connection);
        Ok(Box::new(tokio::io::join(recv, send)))
    }

    pub(crate) fn secret_hex(&self) -> String {
        self.secret_hex.clone()
    }

    pub(crate) async fn close(&self) {
        for (_, connection) in self.cached.lock().await.drain() {
            connection.close(0u32.into(), b"mobile client closed");
        }
        self.endpoint.close().await;
    }
}

#[derive(Clone)]
pub(crate) struct Dialer {
    endpoint: String,
    pin: String,
    iroh: IrohDialer,
}

impl Dialer {
    pub(crate) fn new(
        endpoint: String,
        pin: String,
        iroh: IrohDialer,
    ) -> Result<Self, ClientError> {
        normalize_pin(&pin)?;
        parse_endpoint(&endpoint)?;
        Ok(Self {
            endpoint,
            pin,
            iroh,
        })
    }

    async fn open_raw(&self) -> Result<BoxIo, ClientError> {
        let parsed = parse_endpoint(&self.endpoint)?;
        match parsed {
            ParsedEndpoint::Iroh { id, relay } => self.iroh.stream(id, relay).await,
            ParsedEndpoint::Tls { host, port } => {
                let stream = tokio::time::timeout(
                    Duration::from_secs(10),
                    tokio::net::TcpStream::connect((host.as_str(), port)),
                )
                .await
                .map_err(|_| ClientError::Unreachable("computer connection timed out".into()))?
                .map_err(ClientError::from)?;
                stream.set_nodelay(true).map_err(ClientError::from)?;
                Ok(Box::new(stream))
            }
        }
    }

    pub(crate) async fn open_tls(&self, alpn: &[u8]) -> Result<PinnedTls, ClientError> {
        let expected = normalize_pin(&self.pin)?;
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier = Arc::new(PinnedVerifier {
            expected,
            provider: Arc::clone(&provider),
        });
        let mut config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(ClientError::internal)?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth();
        config.alpn_protocols = vec![alpn.to_vec()];
        let raw = self.open_raw().await?;
        let name =
            ServerName::try_from("threadterm.invalid".to_owned()).expect("static server name");
        let stream = tokio::time::timeout(
            Duration::from_secs(10),
            TlsConnector::from(Arc::new(config)).connect(name, raw),
        )
        .await
        .map_err(|_| ClientError::Unreachable("TLS handshake timed out".into()))?
        .map_err(|error| {
            let text = error.to_string();
            if text.contains("pin_mismatch") {
                ClientError::PinMismatch("computer identity changed".into())
            } else {
                ClientError::Unreachable(format!("TLS handshake failed: {text}"))
            }
        })?;
        if stream.get_ref().1.alpn_protocol() != Some(alpn) {
            return Err(ClientError::AlpnMismatch(
                "computer did not negotiate the required protocol".into(),
            ));
        }
        Ok(stream)
    }
}

enum ParsedEndpoint {
    Iroh {
        id: EndpointId,
        relay: Option<RelayUrl>,
    },
    Tls {
        host: String,
        port: u16,
    },
}

fn parse_endpoint(endpoint: &str) -> Result<ParsedEndpoint, ClientError> {
    let url =
        Url::parse(endpoint).map_err(|_| ClientError::protocol("invalid machine endpoint"))?;
    match url.scheme() {
        "iroh" => {
            if url.port().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
                || !matches!(url.path(), "" | "/")
                || url.fragment().is_some()
            {
                return Err(ClientError::protocol("invalid iroh endpoint"));
            }
            let id = EndpointId::from_str(
                url.host_str()
                    .ok_or_else(|| ClientError::protocol("missing iroh endpoint id"))?,
            )
            .map_err(|_| ClientError::protocol("invalid iroh endpoint id"))?;
            let values = url.query_pairs().collect::<Vec<_>>();
            if values.iter().any(|(key, _)| key != "relay") || values.len() > 1 {
                return Err(ClientError::protocol("invalid iroh endpoint options"));
            }
            let relay = values
                .first()
                .map(|(_, value)| RelayUrl::from_str(value))
                .transpose()
                .map_err(|_| ClientError::protocol("invalid iroh relay"))?;
            Ok(ParsedEndpoint::Iroh { id, relay })
        }
        "https" => {
            if !url.username().is_empty()
                || url.password().is_some()
                || !matches!(url.path(), "" | "/")
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(ClientError::protocol("invalid TLS endpoint"));
            }
            Ok(ParsedEndpoint::Tls {
                host: url
                    .host_str()
                    .ok_or_else(|| ClientError::protocol("missing TLS host"))?
                    .to_owned(),
                port: url
                    .port_or_known_default()
                    .ok_or_else(|| ClientError::protocol("missing TLS port"))?,
            })
        }
        _ => Err(ClientError::protocol("unsupported machine endpoint")),
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Authenticated {
    pub epoch: String,
    pub permission: String,
}

pub(crate) struct AuthenticateRequest<'a> {
    pub credential: &'a str,
    pub channel: &'a str,
    pub machine_id: &'a str,
    pub client_id: &'a str,
    pub epoch: Option<&'a str>,
    pub port: Option<u16>,
    pub loopback: Option<&'a str>,
}

pub(crate) async fn authenticate(
    stream: &mut PinnedTls,
    request: AuthenticateRequest<'_>,
) -> Result<Authenticated, ClientError> {
    let AuthenticateRequest {
        credential,
        channel,
        machine_id,
        client_id,
        epoch,
        port,
        loopback,
    } = request;
    if port.is_some() != loopback.is_some()
        || loopback.is_some_and(|value| !matches!(value, "127.0.0.1" | "::1"))
    {
        return Err(ClientError::protocol(
            "invalid tunnel authentication target",
        ));
    }
    let challenge = tokio::time::timeout(Duration::from_secs(10), framing::read_value(stream))
        .await
        .map_err(|_| ClientError::RequestTimeout("authentication challenge timed out".into()))??;
    if challenge.get("kind").and_then(|v| v.as_str()) == Some("incompatible") {
        return Err(ClientError::Incompatible(format!(
            "host contract {}",
            challenge
                .get("contract")
                .unwrap_or(&serde_json::Value::Null)
        )));
    }
    let nonce = challenge
        .get("nonce")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ClientError::protocol("invalid authentication challenge"))?;
    if challenge.get("protocol").and_then(|v| v.as_u64()) != Some(1)
        || challenge.get("contract").and_then(|v| v.as_u64()) != Some(1)
    {
        return Err(ClientError::Incompatible(
            "mobile protocol contract mismatch".into(),
        ));
    }
    let auth = serde_json::json!({
        "kind":"auth", "protocol":1, "contract":1, "nonce":nonce, "channel":channel,
        "clientId":client_id, "credential":credential, "epoch":epoch,
        "port":port, "loopback":loopback,
    });
    framing::write_value(stream, &auth).await?;
    let response = tokio::time::timeout(Duration::from_secs(10), framing::read_value(stream))
        .await
        .map_err(|_| ClientError::RequestTimeout("authentication response timed out".into()))??;
    if response.get("kind").and_then(|v| v.as_str()) == Some("tunnel_failed") {
        return Err(ClientError::Remote(format!(
            "tunnel_failed:{}",
            response
                .get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        )));
    }
    if response.get("kind").and_then(|v| v.as_str()) == Some("incompatible") {
        return Err(ClientError::Incompatible(
            "mobile protocol contract mismatch".into(),
        ));
    }
    if response.get("kind").and_then(|v| v.as_str()) == Some("authentication_failed") {
        let code = response
            .get("code")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ClientError::protocol("authentication failure omitted code"))?;
        let message = response
            .get("message")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ClientError::protocol("authentication failure omitted message"))?;
        return Err(ClientError::Remote(format!("{code}: {message}")));
    }
    let authenticated_epoch = response
        .get("epoch")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ClientError::protocol("invalid authenticated response"))?;
    let expected_principal = format!("mobile:{machine_id}:{client_id}");
    if response.get("kind").and_then(|v| v.as_str()) != Some("authenticated")
        || response.get("protocol").and_then(|v| v.as_u64()) != Some(1)
        || response.get("contract").and_then(|v| v.as_u64()) != Some(1)
        || epoch.is_some_and(|expected| expected != authenticated_epoch)
        || response.get("principal").and_then(|v| v.as_str()) != Some(expected_principal.as_str())
    {
        return Err(ClientError::Remote("authentication refused".into()));
    }
    let permission = response
        .get("permission")
        .and_then(|v| v.as_str())
        .filter(|value| matches!(*value, "readonly" | "fullcontrol"))
        .ok_or_else(|| ClientError::protocol("authenticated response omitted permission"))?;
    Ok(Authenticated {
        epoch: authenticated_epoch.to_owned(),
        permission: permission.to_owned(),
    })
}

pub(crate) fn secret_from_hex(value: Option<String>) -> Result<SecretKey, ClientError> {
    match value {
        Some(value) => {
            let bytes = hex::decode(value)
                .map_err(|_| ClientError::protocol("invalid saved iroh secret"))?;
            let bytes: [u8; 32] = bytes
                .try_into()
                .map_err(|_| ClientError::protocol("invalid saved iroh secret"))?;
            Ok(SecretKey::from_bytes(&bytes))
        }
        None => Ok(SecretKey::generate()),
    }
}

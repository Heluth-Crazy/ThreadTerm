//! Computers on other networks reach this PC through iroh: QUIC with NAT traversal, and a relay when no direct path
//! exists. iroh carries the same pinned TLS byte stream the TCP listener serves, so nothing above TLS (ALPN split,
//! pairing, credentials, deny list) knows which transport a connection came on.
//!
//! Two things here exist because of proxy TUNs (v2rayN, Clash) on Windows: the UDP socket is bound to the real LAN
//! adapter when a tunnel owns the default route, and relay host names are resolved over DNS-over-HTTPS first, because
//! a TUN's DNS answers with FakeIP addresses or replies that iroh's DNS parser rejects.

use crate::remote_access::{adapter_addresses, install_private_file};
use anyhow::{anyhow, Context, Result};
use iroh::{
    dns::{BoxIter, DnsError, DnsResolver, NameserverConfig, Resolver, TxtRecordData},
    endpoint::{presets, Connection, RecvStream, SendStream},
    Endpoint, EndpointAddr, EndpointId, RelayMode, RelayUrl, SecretKey,
};
use std::{
    collections::HashMap,
    fs,
    future::Future,
    net::{IpAddr, Ipv4Addr, SocketAddrV4},
    path::Path,
    pin::Pin,
    sync::Mutex,
    time::Duration,
};

/// The protocol every ThreadTerm iroh connection speaks: a TLS stream per bi-directional QUIC stream.
pub(crate) const ALPN: &[u8] = b"threadterm-iroh/1";
pub(crate) const IROH_KEY_FILE: &str = "remote-access-iroh.key";
const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------------------------------------------------------
// Identity

/// This PC's iroh key: random per install, created on first use, kept next to the TLS identity and never shared
/// (only its public half goes into pairing offers).
pub(crate) fn load_or_create_secret(data_dir: &Path) -> Result<SecretKey> {
    let path = data_dir.join(IROH_KEY_FILE);
    if let Ok(text) = fs::read_to_string(&path) {
        let bytes: [u8; 32] = hex::decode(text.trim())
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(|| anyhow!("{IROH_KEY_FILE} is damaged; reset the remote identity"))?;
        return Ok(SecretKey::from_bytes(&bytes));
    }
    let secret = SecretKey::generate();
    install_private_file(&path, hex::encode(secret.to_bytes()).as_bytes()).context("saving the iroh key")?;
    Ok(secret)
}

/// Forgets the key; the next use creates a new one. Part of "Reset remote identity".
pub(crate) fn remove_secret(data_dir: &Path) -> Result<()> {
    match fs::remove_file(data_dir.join(IROH_KEY_FILE)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("removing the iroh key"),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// DNS for relay host names

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// FakeIP ranges handed out by proxy TUNs (sing-box, Clash) for every name they intercept.
fn fake_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.octets()[0] == 198 && (ip.octets()[1] & 0xfe) == 18,
        IpAddr::V6(ip) => ip.segments()[0] == 0xfc00 && ip.segments()[1] == 0x0018,
    }
}

/// DNS-over-HTTPS first (AliDNS, then Cloudflare), the system resolver only when that fails; FakeIP answers dropped
/// from either. A TUN can neither intercept nor rewrite the HTTPS lookups.
#[derive(Debug, Clone)]
struct RelayDns {
    doh: DnsResolver,
    system: DnsResolver,
}

impl RelayDns {
    fn new() -> Self {
        let doh = DnsResolver::builder()
            .add_nameserver_config(
                NameserverConfig::https(IpAddr::V4(Ipv4Addr::new(223, 5, 5, 5))).with_tls_server_name("dns.alidns.com"),
            )
            .add_nameserver_config(NameserverConfig::https(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))))
            .disable_fallback()
            .build();
        Self { doh, system: DnsResolver::builder().with_system_defaults().build() }
    }

    async fn addresses<F, Fut, I>(&self, lookup: F) -> Result<Vec<IpAddr>, DnsError>
    where
        F: Fn(DnsResolver) -> Fut,
        Fut: Future<Output = Result<I, DnsError>>,
        I: Iterator<Item = IpAddr>,
    {
        let real = |addresses: I| addresses.filter(|ip| !fake_ip(*ip)).collect::<Vec<_>>();
        match lookup(self.doh.clone()).await {
            Ok(addresses) => {
                let addresses = real(addresses);
                if !addresses.is_empty() {
                    return Ok(addresses);
                }
                Ok(lookup(self.system.clone()).await.map(real).unwrap_or_default())
            }
            Err(doh_error) => lookup(self.system.clone()).await.map(real).map_err(|_| doh_error),
        }
    }
}

impl Resolver for RelayDns {
    fn lookup_ipv4(&self, host: String) -> BoxFuture<Result<BoxIter<Ipv4Addr>, DnsError>> {
        let this = self.clone();
        Box::pin(async move {
            let found = this.addresses(|resolver| {
                let host = host.clone();
                async move { resolver.lookup_ipv4(host, DNS_TIMEOUT).await }
            }).await?;
            Ok(Box::new(found.into_iter().filter_map(|ip| match ip { IpAddr::V4(ip) => Some(ip), IpAddr::V6(_) => None }))
                as BoxIter<Ipv4Addr>)
        })
    }

    fn lookup_ipv6(&self, host: String) -> BoxFuture<Result<BoxIter<std::net::Ipv6Addr>, DnsError>> {
        let this = self.clone();
        Box::pin(async move {
            let found = this.addresses(|resolver| {
                let host = host.clone();
                async move { resolver.lookup_ipv6(host, DNS_TIMEOUT).await }
            }).await?;
            Ok(Box::new(found.into_iter().filter_map(|ip| match ip { IpAddr::V6(ip) => Some(ip), IpAddr::V4(_) => None }))
                as BoxIter<std::net::Ipv6Addr>)
        })
    }

    fn lookup_txt(&self, host: String) -> BoxFuture<Result<BoxIter<TxtRecordData>, DnsError>> {
        let this = self.clone();
        Box::pin(async move {
            let records = match this.doh.lookup_txt(host.clone(), DNS_TIMEOUT).await {
                Ok(records) => records.collect::<Vec<_>>(),
                Err(doh_error) => this.system.lookup_txt(host, DNS_TIMEOUT).await.map_err(|_| doh_error)?.collect(),
            };
            Ok(Box::new(records.into_iter()) as BoxIter<TxtRecordData>)
        })
    }

    fn clear_cache(&self) {
        self.doh.clear_cache();
        self.system.clear_cache();
    }

    fn reset(&self) -> Box<dyn Resolver> {
        Box::new(Self::new())
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Endpoint

/// The IPv4 address to bind UDP to when a tunnel adapter (a proxy TUN, a VPN) has a default gateway: binding to the
/// real Wi-Fi/Ethernet address makes Windows send iroh's packets out of that adapter, so NAT traversal sees the real
/// network. `None` when no tunnel owns a route, and iroh binds every interface as usual.
pub(crate) fn tunnel_bypass_address() -> Option<Ipv4Addr> {
    tunnel_bypass_from(&adapter_addresses())
}

fn tunnel_bypass_from(addresses: &[crate::remote_access::AdapterAddress]) -> Option<Ipv4Addr> {
    let tunnel_route = addresses.iter().any(|address| address.gateway && !address.routed_lan);
    if !tunnel_route {
        return None;
    }
    addresses.iter().find(|address| address.routed_lan && address.ip.is_private()).map(|address| address.ip)
}

/// How this PC's endpoint is reachable.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(test, allow(dead_code))] // tests bind loopback only
pub(crate) enum Reach {
    /// Hosting through n0's relays: publish this key's current relay so paired computers find it.
    PublicRelays,
    /// Hosting through a self-hosted relay: the relay in the offer is fixed, so nothing is published anywhere.
    CustomRelay(RelayUrl),
    /// Dialing only: resolve other computers, publish nothing, accept nothing.
    DialOnly { custom_relay: Option<RelayUrl> },
    /// Tests: loopback only, no relay, no lookups.
    #[cfg(test)]
    Loopback { accept: bool },
}

impl Reach {
    fn accepts(&self) -> bool {
        match self {
            Reach::PublicRelays | Reach::CustomRelay(_) => true,
            Reach::DialOnly { .. } => false,
            #[cfg(test)]
            Reach::Loopback { accept } => *accept,
        }
    }
}

pub(crate) async fn bind(secret: SecretKey, reach: &Reach) -> Result<Endpoint> {
    let alpns = if reach.accepts() { vec![ALPN.to_vec()] } else { Vec::new() };
    let mut builder = match reach {
        Reach::PublicRelays => Endpoint::builder(presets::N0),
        Reach::CustomRelay(relay) => Endpoint::builder(presets::Minimal).relay_mode(RelayMode::custom([relay.clone()])),
        Reach::DialOnly { custom_relay } => {
            let builder = Endpoint::builder(presets::Minimal)
                .address_lookup(iroh::address_lookup::PkarrResolver::n0_dns())
                .address_lookup(iroh::address_lookup::DnsAddressLookup::n0_dns());
            match custom_relay {
                Some(relay) => builder.relay_mode(RelayMode::custom([relay.clone()])),
                None => builder.relay_mode(RelayMode::Default),
            }
        }
        #[cfg(test)]
        Reach::Loopback { .. } => {
            return Endpoint::builder(presets::Minimal)
                .relay_mode(RelayMode::Disabled)
                .secret_key(secret)
                .alpns(alpns)
                .bind_addr(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
                .map_err(|error| anyhow!("{error}"))?
                .bind()
                .await
                .map_err(|error| anyhow!("binding the iroh endpoint: {error}"));
        }
    };
    builder = builder.secret_key(secret).alpns(alpns).dns_resolver(DnsResolver::custom(RelayDns::new()));
    if let Some(address) = tunnel_bypass_address() {
        builder = builder.bind_addr(SocketAddrV4::new(address, 0)).map_err(|error| anyhow!("{error}"))?;
    }
    builder.bind().await.map_err(|error| anyhow!("binding the iroh endpoint: {error}"))
}

/// The public key text a pairing offer carries and a machine endpoint (`iroh://<key>`) names.
pub(crate) fn key_text(id: EndpointId) -> String {
    id.to_string()
}

pub(crate) fn parse_key(text: &str) -> Result<EndpointId> {
    text.parse().map_err(|_| anyhow!("invalid_iroh_key"))
}

// ---------------------------------------------------------------------------------------------------------------
// Dialing

/// One QUIC connection per remote computer, shared by every TLS stream to it (control, output, browser, tunnel).
#[derive(Default)]
pub(crate) struct Connections {
    open: Mutex<HashMap<EndpointId, Connection>>,
}

impl Connections {
    pub(crate) async fn stream(&self, endpoint: &Endpoint, address: EndpointAddr) -> Result<(SendStream, RecvStream)> {
        let id = address.id;
        let existing = self.open.lock().map_err(|_| anyhow!("iroh connections lock poisoned"))?.get(&id).cloned();
        if let Some(connection) = existing {
            if connection.close_reason().is_none() {
                if let Ok(stream) = connection.open_bi().await {
                    return Ok(stream);
                }
            }
        }
        let connection = tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect(address, ALPN))
            .await
            .map_err(|_| anyhow!("iroh_unreachable: the computer did not answer"))?
            .map_err(|error| anyhow!("iroh_unreachable: {error}"))?;
        let stream = connection.open_bi().await.map_err(|error| anyhow!("iroh_unreachable: {error}"))?;
        self.open.lock().map_err(|_| anyhow!("iroh connections lock poisoned"))?.insert(id, connection);
        Ok(stream)
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut open) = self.open.lock() {
            for connection in open.values() {
                connection.close(0u32.into(), b"closing");
            }
            open.clear();
        }
    }
}

/// Bridges one local named pipe to one iroh stream. The desktop opens the pipe, writes the one-time token, then runs
/// its pinned TLS over the pipe. The pipe is limited to this Windows user; the token stops another of the user's own
/// processes from racing the desktop to it.
#[cfg(windows)]
pub(crate) fn bridge_pipe(name: String, token: String, send: SendStream, recv: RecvStream) -> Result<()> {
    use tokio::{io::AsyncReadExt, net::windows::named_pipe::ServerOptions};
    let mut acl = crate::windows_security::SecurityAttributes::current_user_only()?;
    let pipe = unsafe {
        ServerOptions::new()
            .first_pipe_instance(true)
            .max_instances(1)
            .create_with_security_attributes_raw(&name, acl.raw().cast())
    }
    .context("creating the iroh dial pipe")?;
    tokio::spawn(async move {
        let (mut pipe, mut send, mut recv) = (pipe, send, recv);
        let ready = tokio::time::timeout(Duration::from_secs(10), async {
            pipe.connect().await?;
            let mut supplied = vec![0_u8; token.len()];
            pipe.read_exact(&mut supplied).await?;
            Ok::<bool, std::io::Error>(bool::from(subtle::ConstantTimeEq::ct_eq(supplied.as_slice(), token.as_bytes())))
        })
        .await;
        if matches!(ready, Ok(Ok(true))) {
            // A named pipe cannot half-close, so when either side ends, end both: the pipe handle closes (the desktop
            // still reads what was written, then sees the end) and the iroh stream finishes.
            let (mut pipe_read, mut pipe_write) = tokio::io::split(pipe);
            tokio::select! {
                _ = tokio::io::copy(&mut pipe_read, &mut send) => {}
                _ = tokio::io::copy(&mut recv, &mut pipe_write) => {}
            }
        }
        let _ = send.finish();
    });
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn bridge_pipe(_name: String, _token: String, _send: SendStream, _recv: RecvStream) -> Result<()> {
    anyhow::bail!("iroh dialing through a named pipe needs Windows")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_access::AdapterAddress;

    fn adapter(ip: &str, routed_lan: bool, gateway: bool) -> AdapterAddress {
        AdapterAddress { ip: ip.parse().unwrap(), routed_lan, gateway }
    }

    #[test]
    fn fake_ip_covers_tun_ranges_only() {
        for (ip, fake) in [("198.18.0.1", true), ("198.19.255.254", true), ("198.20.0.1", false), ("198.17.0.1", false),
            ("10.0.0.1", false), ("fc00:18::1", true), ("fc00:19::1", false), ("2001:db8::1", false)] {
            assert_eq!(fake_ip(ip.parse().unwrap()), fake, "{ip}");
        }
    }

    #[test]
    fn udp_bypasses_a_tunnel_only_when_one_owns_a_route() {
        // A proxy TUN with a gateway next to Wi-Fi: bind to the Wi-Fi address.
        let tun = [adapter("172.19.0.1", false, true), adapter("10.20.30.40", true, true), adapter("192.168.56.1", false, false)];
        assert_eq!(tunnel_bypass_from(&tun), Some(Ipv4Addr::new(10, 20, 30, 40)));
        // Host-only adapters have no gateway: no tunnel, bind everything.
        let plain = [adapter("192.168.56.1", false, false), adapter("10.20.30.40", true, true)];
        assert_eq!(tunnel_bypass_from(&plain), None);
        // A tunnel but no real LAN adapter: nothing better to bind to.
        assert_eq!(tunnel_bypass_from(&[adapter("172.19.0.1", false, true)]), None);
    }

    #[test]
    fn the_key_is_created_once_restricted_and_reset_by_removal() {
        let directory = tempfile::tempdir().unwrap();
        let first = load_or_create_secret(directory.path()).unwrap();
        let again = load_or_create_secret(directory.path()).unwrap();
        assert_eq!(first.public(), again.public());
        remove_secret(directory.path()).unwrap();
        assert_ne!(load_or_create_secret(directory.path()).unwrap().public(), first.public());
        fs::write(directory.path().join(IROH_KEY_FILE), "not hex").unwrap();
        assert!(load_or_create_secret(directory.path()).is_err());
        assert_eq!(parse_key(&key_text(first.public())).unwrap(), first.public());
        assert!(parse_key("not-a-key").is_err());
    }
}

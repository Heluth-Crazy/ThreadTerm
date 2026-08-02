pub(super) const DEFAULT_BRIDGE_HOST: &str = "127.0.0.1";
pub(super) const DEFAULT_BRIDGE_PORT: u16 = 5174;
pub(super) const DEFAULT_SECURE_BRIDGE_PORT: u16 = 5175;

pub(super) struct PairPublicTarget {
    pub(super) base_url: String,
    pub(super) host: String,
    pub(super) port: u16,
}

pub(super) fn normalize_pair_public_target(
    public_url: Option<&str>,
    local_port: u16,
) -> Result<PairPublicTarget, String> {
    let Some(value) = public_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(PairPublicTarget {
            base_url: format!("http://{DEFAULT_BRIDGE_HOST}:{local_port}"),
            host: DEFAULT_BRIDGE_HOST.to_string(),
            port: local_port,
        });
    };
    if matches!(value, "127.0.0.1" | "localhost") {
        return Ok(PairPublicTarget {
            base_url: format!("http://{DEFAULT_BRIDGE_HOST}:{local_port}"),
            host: DEFAULT_BRIDGE_HOST.to_string(),
            port: local_port,
        });
    }

    let uri = value
        .parse::<axum::http::Uri>()
        .map_err(|_| "Secure tunnel address must be a valid HTTPS origin.".to_string())?;
    let scheme = uri
        .scheme_str()
        .ok_or_else(|| "Secure tunnel address must start with https://.".to_string())?;
    let authority = uri
        .authority()
        .ok_or_else(|| "Secure tunnel address must include a host.".to_string())?;
    let host = authority.host();
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1");
    if scheme != "https" && !(scheme == "http" && loopback) {
        return Err(
            "Phone pairing requires an HTTPS secure tunnel. Plain HTTP is allowed only on this computer."
                .to_string(),
        );
    }
    if uri.path() != "/" || uri.query().is_some() {
        return Err(
            "Secure tunnel address must contain only its origin, without a path or query."
                .to_string(),
        );
    }

    let port = authority
        .port_u16()
        .unwrap_or(if scheme == "https" { 443 } else { local_port });
    Ok(PairPublicTarget {
        base_url: format!("{scheme}://{authority}"),
        host: host.to_string(),
        port,
    })
}

#[cfg(test)]
mod tests {
    use super::normalize_pair_public_target;

    #[test]
    fn pairing_target_requires_https_away_from_loopback() {
        let secure = normalize_pair_public_target(Some("https://threadterm.example.ts.net"), 5174)
            .expect("HTTPS tunnel origin should be accepted");
        assert_eq!(secure.base_url, "https://threadterm.example.ts.net");
        assert_eq!(secure.host, "threadterm.example.ts.net");
        assert_eq!(secure.port, 443);

        let local = normalize_pair_public_target(None, 5174)
            .expect("local-only access should remain available");
        assert_eq!(local.base_url, "http://127.0.0.1:5174");

        assert!(
            normalize_pair_public_target(Some("http://192.168.1.42:5174"), 5174)
                .err()
                .expect("remote plaintext must be rejected")
                .contains("requires an HTTPS secure tunnel")
        );
        assert!(normalize_pair_public_target(
            Some("https://threadterm.example.ts.net/mobile?token=leak"),
            5174,
        )
        .err()
        .expect("tunnel origin must not contain a path or query")
        .contains("without a path or query"));
    }
}

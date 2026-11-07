use crate::error::ClientError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use url::Url;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IrohAddress {
    pub endpoint_id: String,
    pub relay_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PairDescriptor {
    pub v: u8,
    pub server_url: String,
    pub pairing_id: String,
    pub code: String,
    pub tls_fingerprint: String,
    pub profile: Option<String>,
    pub expires_at: Option<String>,
    pub iroh: Option<IrohAddress>,
}

impl PairDescriptor {
    pub(crate) fn parse(input: &str) -> Result<Self, ClientError> {
        if input.len() > 16_384 {
            return Err(ClientError::InvalidPairing(
                "pairing text is too long".into(),
            ));
        }
        let url = Url::parse(input.trim())
            .map_err(|_| ClientError::InvalidPairing("invalid ThreadTerm pairing text".into()))?;
        if url.scheme() != "threadterm"
            || url.host_str() != Some("pair")
            || url.path() != "" && url.path() != "/"
            || url.fragment().is_some()
        {
            return Err(ClientError::InvalidPairing(
                "invalid ThreadTerm pairing URL".into(),
            ));
        }
        let values = url.query_pairs().collect::<Vec<_>>();
        if values.len() != 1 || values[0].0 != "data" {
            return Err(ClientError::InvalidPairing(
                "pairing URL must contain one data value".into(),
            ));
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(values[0].1.as_bytes())
            .map_err(|_| ClientError::InvalidPairing("pairing data is not base64url".into()))?;
        let descriptor: Self = serde_json::from_slice(&bytes)
            .map_err(|_| ClientError::InvalidPairing("pairing data is not valid JSON".into()))?;
        descriptor.validate()?;
        Ok(descriptor)
    }

    fn validate(&self) -> Result<(), ClientError> {
        if !matches!(self.v, 1 | 2)
            || uuid::Uuid::parse_str(&self.pairing_id).is_err()
            || normalize_code(&self.code).len() != 32
            || !normalize_code(&self.code)
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
        {
            return Err(ClientError::InvalidPairing(
                "invalid pairing descriptor".into(),
            ));
        }
        if self.profile.as_deref() != Some("mobile") {
            return Err(ClientError::InvalidPairing(
                "this offer is not for a mobile device".into(),
            ));
        }
        normalize_pin(&self.tls_fingerprint)?;
        let server = Url::parse(&self.server_url)
            .map_err(|_| ClientError::InvalidPairing("invalid server address".into()))?;
        if server.scheme() != "https"
            || server.host_str().is_none()
            || server.path() != "/"
            || server.query().is_some()
            || server.fragment().is_some()
            || !server.username().is_empty()
            || server.password().is_some()
        {
            return Err(ClientError::InvalidPairing("invalid server address".into()));
        }
        match (self.v, &self.iroh) {
            (1, None) => {}
            (2, Some(iroh)) => {
                if iroh.endpoint_id.len() != 64
                    || !iroh.endpoint_id.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return Err(ClientError::InvalidPairing("invalid iroh endpoint".into()));
                }
                if let Some(relay) = &iroh.relay_url {
                    let relay = Url::parse(relay)
                        .map_err(|_| ClientError::InvalidPairing("invalid relay address".into()))?;
                    if relay.scheme() != "https" || relay.host_str().is_none() {
                        return Err(ClientError::InvalidPairing("invalid relay address".into()));
                    }
                }
            }
            _ => {
                return Err(ClientError::InvalidPairing(
                    "pairing descriptor version mismatch".into(),
                ))
            }
        }
        if let Some(expires) = &self.expires_at {
            let expires = OffsetDateTime::parse(expires, &Rfc3339)
                .map_err(|_| ClientError::InvalidPairing("invalid pairing expiry".into()))?;
            if expires <= OffsetDateTime::now_utc() {
                return Err(ClientError::PairingExpired("pairing offer expired".into()));
            }
        }
        Ok(())
    }

    pub(crate) fn endpoint(&self) -> String {
        match &self.iroh {
            Some(iroh) => {
                let mut url =
                    Url::parse(&format!("iroh://{}", iroh.endpoint_id)).expect("validated iroh id");
                if let Some(relay) = &iroh.relay_url {
                    url.query_pairs_mut().append_pair("relay", relay);
                }
                url.to_string()
            }
            None => self.server_url.clone(),
        }
    }
}

pub(crate) fn normalize_pin(value: &str) -> Result<[u8; 32], ClientError> {
    let compact = value.replace([':', ' '], "");
    if compact.len() != 64 || !compact.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ClientError::InvalidPairing(
            "invalid certificate fingerprint".into(),
        ));
    }
    let bytes = hex::decode(compact)
        .map_err(|_| ClientError::InvalidPairing("invalid certificate fingerprint".into()))?;
    bytes
        .try_into()
        .map_err(|_| ClientError::InvalidPairing("invalid certificate fingerprint".into()))
}

pub(crate) fn normalize_code(value: &str) -> String {
    value
        .chars()
        .filter(|c| !matches!(c, '-' | ' ' | '\t' | '\r' | '\n'))
        .collect::<String>()
        .to_uppercase()
}

pub(crate) fn check_code(pin: &str) -> Result<String, ClientError> {
    let bytes = normalize_pin(pin)?;
    let text = hex::encode_upper(bytes);
    Ok(format!("{} {} {}", &text[..4], &text[4..8], &text[8..12]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn descriptor(value: serde_json::Value) -> String {
        format!(
            "threadterm://pair?data={}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap())
        )
    }

    #[test]
    fn accepts_strict_mobile_tcp_and_iroh_descriptors() {
        let base = json!({"v":1,"serverUrl":"https://127.0.0.1:1234","pairingId":uuid::Uuid::new_v4().to_string(),
            "code":"00112233-44556677-8899AABB-CCDDEEFF","tlsFingerprint":"AA:".repeat(31)+"AA","profile":"mobile"});
        assert!(PairDescriptor::parse(&descriptor(base.clone())).is_ok());
        let mut v2 = base;
        v2["v"] = json!(2);
        v2["iroh"] = json!({"endpointId":"a".repeat(64),"relayUrl":"https://relay.example/"});
        assert!(PairDescriptor::parse(&descriptor(v2)).is_ok());
    }

    #[test]
    fn refuses_desktop_unknown_fields_and_cross_version_iroh() {
        let base = json!({"v":1,"serverUrl":"https://127.0.0.1:1234","pairingId":uuid::Uuid::new_v4().to_string(),
            "code":"00".repeat(16),"tlsFingerprint":"AA".repeat(32),"profile":"desktop"});
        assert!(PairDescriptor::parse(&descriptor(base.clone())).is_err());
        let mut extra = base.clone();
        extra["profile"] = json!("mobile");
        extra["credential"] = json!("leak");
        assert!(PairDescriptor::parse(&descriptor(extra)).is_err());
        let mut mismatch = base;
        mismatch["profile"] = json!("mobile");
        mismatch["iroh"] = json!({"endpointId":"a".repeat(64)});
        assert!(PairDescriptor::parse(&descriptor(mismatch)).is_err());
    }
}

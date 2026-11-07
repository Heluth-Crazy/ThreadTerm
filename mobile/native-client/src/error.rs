#[derive(Debug, Clone, thiserror::Error, uniffi::Error)]
pub enum ClientError {
    #[error("invalid_pairing: {0}")]
    InvalidPairing(String),
    #[error("pairing_expired: {0}")]
    PairingExpired(String),
    #[error("pin_mismatch: {0}")]
    PinMismatch(String),
    #[error("alpn_mismatch: {0}")]
    AlpnMismatch(String),
    #[error("unreachable: {0}")]
    Unreachable(String),
    #[error("incompatible: {0}")]
    Incompatible(String),
    #[error("not_connected: {0}")]
    NotConnected(String),
    #[error("request_timeout: {0}")]
    RequestTimeout(String),
    #[error("remote_error: {0}")]
    Remote(String),
    #[error("protocol_error: {0}")]
    Protocol(String),
    #[error("internal_error: {0}")]
    Internal(String),
}

impl ClientError {
    pub(crate) fn protocol(message: impl Into<String>) -> Self {
        Self::Protocol(message.into())
    }
    pub(crate) fn internal(error: impl std::fmt::Display) -> Self {
        Self::Internal(error.to_string())
    }
}

impl From<std::io::Error> for ClientError {
    fn from(value: std::io::Error) -> Self {
        Self::Unreachable(value.to_string())
    }
}

//! Hardened, Tauri-free bootstrap and health/catalog daemon skeleton.

pub mod bootstrap;
pub mod owner;
pub mod service;

#[cfg(windows)]
pub mod runtime;

#[cfg(windows)]
pub mod windows_security;

use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostError {
    UnsupportedPlatform,
    InvalidArguments,
    InvalidEndpoint,
    EndpointTooLarge,
    SecretUnavailable,
    OwnershipUnavailable,
    Unauthorized,
    Timeout,
    QueueFull,
    Io,
    Security,
    Catalog,
}

impl HostError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::InvalidArguments => "invalid_arguments",
            Self::InvalidEndpoint => "invalid_endpoint",
            Self::EndpointTooLarge => "endpoint_too_large",
            Self::SecretUnavailable => "secret_unavailable",
            Self::OwnershipUnavailable => "ownership_unavailable",
            Self::Unauthorized => "unauthorized",
            Self::Timeout => "timeout",
            Self::QueueFull => "queue_full",
            Self::Io => "io_error",
            Self::Security => "security_error",
            Self::Catalog => "catalog_error",
        }
    }
}

impl fmt::Display for HostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for HostError {}

impl From<std::io::Error> for HostError {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}

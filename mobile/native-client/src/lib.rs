mod client;
mod descriptor;
mod error;
mod framing;
mod pairing;
mod proxy;
mod transport;

pub use error::ClientError;
use iroh::SecretKey;
use pairing::PendingPairing;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Clone, uniffi::Record)]
pub struct PairingPreparation {
    pub pending_id: String,
    pub check_code: String,
    pub endpoint: String,
    pub transport: String,
}

#[derive(Clone, uniffi::Record)]
pub struct PairingCompletion {
    pub machine_id: String,
    pub credential: String,
    pub permission: String,
    pub expires_at: String,
    pub endpoint: String,
    pub transport: String,
    pub tls_fingerprint: String,
}

#[derive(Clone, uniffi::Record)]
pub struct MachineCredentials {
    pub machine_id: String,
    pub endpoint: String,
    pub tls_fingerprint: String,
    pub credential: String,
}

#[derive(Clone, uniffi::Record)]
pub struct ConnectionInfo {
    pub epoch: String,
    pub permission: String,
}

#[derive(Clone, uniffi::Record)]
pub struct ProxyInfo {
    pub port: u16,
    pub username: String,
    pub secret: String,
}

#[uniffi::export(foreign)]
pub trait ClientEventListener: Send + Sync {
    fn runtime_event(&self, machine_id: String, event_json: String);
    fn connection_state(&self, machine_id: String, state: String, message: Option<String>);
}

#[derive(uniffi::Object)]
pub struct NativeClient {
    runtime: Arc<tokio::runtime::Runtime>,
    iroh: transport::IrohDialer,
    pending_pairings: Mutex<HashMap<String, PendingPairing>>,
    connections: client::Connections,
    proxies: proxy::Proxies,
}

#[uniffi::export]
impl NativeClient {
    #[uniffi::constructor]
    pub fn new(iroh_secret_hex: Option<String>) -> Result<Self, ClientError> {
        let runtime = Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .thread_name("threadterm-mobile")
                .build()
                .map_err(ClientError::internal)?,
        );
        let secret: SecretKey = transport::secret_from_hex(iroh_secret_hex)?;
        let iroh = runtime.block_on(transport::IrohDialer::bind(secret))?;
        let listener = Arc::new(Mutex::new(None));
        let connections = client::Connections::new(iroh.clone(), listener);
        Ok(Self {
            runtime,
            iroh,
            pending_pairings: Mutex::new(HashMap::new()),
            connections,
            proxies: proxy::Proxies::new(),
        })
    }

    pub fn iroh_secret_hex(&self) -> String {
        self.iroh.secret_hex()
    }

    pub fn set_event_listener(
        &self,
        listener: Arc<dyn ClientEventListener>,
    ) -> Result<(), ClientError> {
        self.connections.set_listener(Some(listener))
    }

    pub fn clear_event_listener(&self) -> Result<(), ClientError> {
        self.connections.set_listener(None)
    }

    pub fn prepare_pairing(&self, text: String) -> Result<PairingPreparation, ClientError> {
        let prepared = self
            .runtime
            .block_on(pairing::prepare(&text, self.iroh.clone()))?;
        let pending_id = uuid::Uuid::new_v4().to_string();
        let mut pending = self
            .pending_pairings
            .lock()
            .map_err(|_| ClientError::internal("pairing registry lock poisoned"))?;
        pending.retain(|_, value| !value.is_expired());
        if pending.len() >= 8 {
            return Err(ClientError::Remote(
                "pairing_capacity: too many pending pairing attempts".into(),
            ));
        }
        pending.insert(pending_id.clone(), prepared.pending);
        Ok(PairingPreparation {
            pending_id,
            check_code: prepared.check_code,
            endpoint: prepared.endpoint,
            transport: prepared.transport,
        })
    }

    pub fn confirm_pairing(
        &self,
        pending_id: String,
        device_name: String,
    ) -> Result<PairingCompletion, ClientError> {
        let pending = self
            .pending_pairings
            .lock()
            .map_err(|_| ClientError::internal("pairing registry lock poisoned"))?
            .remove(&pending_id)
            .ok_or_else(|| ClientError::InvalidPairing("unknown pairing confirmation".into()))?;
        // A failure after dispatch is deliberately returned as uncertain. The
        // one-time pairing mutation is never replayed on another connection.
        let completed = self
            .runtime
            .block_on(pairing::confirm(pending, &device_name))?;
        Ok(PairingCompletion {
            machine_id: completed.machine_id,
            credential: completed.credential,
            permission: completed.permission,
            expires_at: completed.expires_at,
            endpoint: completed.endpoint,
            transport: completed.transport,
            tls_fingerprint: completed.tls_fingerprint,
        })
    }

    pub fn cancel_pairing(&self, pending_id: String) -> Result<(), ClientError> {
        self.pending_pairings
            .lock()
            .map_err(|_| ClientError::internal("pairing registry lock poisoned"))?
            .remove(&pending_id);
        Ok(())
    }

    pub fn connect(&self, machine: MachineCredentials) -> Result<ConnectionInfo, ClientError> {
        self.runtime.block_on(self.connections.connect(machine))
    }

    pub fn disconnect(&self, machine_id: String) -> Result<(), ClientError> {
        let disconnected = self
            .runtime
            .block_on(self.connections.disconnect(&machine_id));
        let proxy_stopped = self.proxies.stop(&machine_id);
        disconnected?;
        proxy_stopped
    }

    pub fn request(
        &self,
        machine_id: String,
        method: String,
        params_json: String,
    ) -> Result<String, ClientError> {
        self.runtime
            .block_on(self.connections.request(&machine_id, &method, &params_json))
    }

    pub fn start_proxy(&self, machine_id: String) -> Result<ProxyInfo, ClientError> {
        self.runtime
            .block_on(self.proxies.start(&machine_id, &self.connections))
    }

    pub fn stop_proxy(&self, machine_id: String) -> Result<(), ClientError> {
        self.proxies.stop(&machine_id)
    }

    pub fn shutdown(&self) -> Result<(), ClientError> {
        self.proxies.stop_all()?;
        self.pending_pairings
            .lock()
            .map_err(|_| ClientError::internal("pairing registry lock poisoned"))?
            .clear();
        self.runtime.block_on(async {
            self.connections.disconnect_all().await?;
            self.iroh.close().await;
            Ok(())
        })
    }
}

uniffi::setup_scaffolding!();

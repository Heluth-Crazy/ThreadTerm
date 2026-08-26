use std::{collections::HashMap, time::Duration};

use terminal_host_protocol::ResponseEnvelope;
use tokio::{sync::oneshot, time::Instant};

use super::reconnect::DaemonClientError;

pub(crate) const DEFAULT_PENDING_LIMIT: usize = 128;

pub(crate) struct PendingRequest {
    pub response: oneshot::Sender<Result<ResponseEnvelope, DaemonClientError>>,
    deadline: Instant,
}

pub(crate) struct RequestMux {
    next_id: u64,
    limit: usize,
    timeout: Duration,
    pending: HashMap<u64, PendingRequest>,
}

impl RequestMux {
    pub fn new(start_id: u64, limit: usize, timeout: Duration) -> Self {
        Self {
            next_id: start_id,
            limit,
            timeout,
            pending: HashMap::with_capacity(limit.min(32)),
        }
    }

    pub fn is_full(&self) -> bool {
        self.pending.len() >= self.limit
    }

    pub fn reserve(
        &mut self,
        response: oneshot::Sender<Result<ResponseEnvelope, DaemonClientError>>,
    ) -> Result<u64, DaemonClientError> {
        if self.pending.len() >= self.limit {
            return Err(DaemonClientError::Busy);
        }
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).unwrap_or(2);
        self.pending.insert(
            id,
            PendingRequest {
                response,
                deadline: Instant::now() + self.timeout,
            },
        );
        Ok(id)
    }

    pub fn take(&mut self, id: u64) -> Option<PendingRequest> {
        self.pending.remove(&id)
    }

    pub fn expire(&mut self, now: Instant) {
        let expired = self
            .pending
            .iter()
            .filter_map(|(id, request)| (request.deadline <= now).then_some(*id))
            .collect::<Vec<_>>();
        for id in expired {
            if let Some(request) = self.pending.remove(&id) {
                let _ = request.response.send(Err(DaemonClientError::Timeout));
            }
        }
    }

    pub fn fail_all(&mut self, error: DaemonClientError) {
        for (_, request) in self.pending.drain() {
            let _ = request.response.send(Err(error.clone()));
        }
    }
}

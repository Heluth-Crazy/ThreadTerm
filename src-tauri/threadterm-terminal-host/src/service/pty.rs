use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Serialize;
use terminal_host_core::{
    CatalogError, CatalogLookup, CatalogSelector, CloseMode as CoreCloseMode, CloseOutcome,
    CreateDisposition as CoreCreateDisposition, DaemonPtyEngine, EventSubscription,
    PresentationTarget, PtyRuntimeError, RequestDigest, RuntimeEvent, TerminalRecord,
    TerminalState,
};
use terminal_host_protocol::{
    ClientClass, CloseMode, CreateDisposition, EffectClassification, EmptyResponse, EnvelopeKind,
    EventEnvelope, EventName, ExitBehavior, IpcError, Method, Placement, ProtocolVersion,
    RequestEnvelope, RequestParams, ResponseEnvelope, ResyncReason, SessionAttachResponse,
    SessionCreateResponse, SessionExitEvent, SessionListResponse, SessionOutputEvent,
    SessionPresentRequest, SessionRecord, SessionResyncRequiredEvent, SessionState,
    SessionStateEvent, SurfaceHiddenRequest, SurfacePresentRequestedEvent, SurfaceReadyRequest,
    TerminalSnapshot, TransportErrorCode,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, oneshot, watch, OwnedSemaphorePermit},
    task::JoinHandle,
    time::timeout,
};

use super::{
    error_response, error_response_with_effect,
    presentation::{map_target, PrepareError, PresentationCoordinator},
    read_frame, write_response, HealthResult, TerminalHostService,
};
use crate::HostError;

const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
const SUBSCRIPTION_POLL: Duration = Duration::from_millis(100);
const PRESENTATION_READY_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) struct RuntimeControl {
    connected_clients: AtomicUsize,
    presentation: PresentationCoordinator,
    shutdown: watch::Sender<bool>,
}

impl RuntimeControl {
    pub(super) fn new() -> Self {
        let (shutdown, _) = watch::channel(false);
        Self {
            connected_clients: AtomicUsize::new(0),
            presentation: PresentationCoordinator::default(),
            shutdown,
        }
    }

    fn connect(self: &Arc<Self>) -> ClientGuard {
        self.connected_clients.fetch_add(1, Ordering::AcqRel);
        ClientGuard {
            control: Arc::clone(self),
            connection_id: None,
            engine: None,
        }
    }

    fn request_shutdown(&self) {
        let _ = self.shutdown.send(true);
    }
}

struct ClientGuard {
    control: Arc<RuntimeControl>,
    connection_id: Option<String>,
    engine: Option<Arc<DaemonPtyEngine>>,
}

impl ClientGuard {
    fn authenticated(&mut self, connection_id: String, engine: Arc<DaemonPtyEngine>) {
        self.connection_id = Some(connection_id);
        self.engine = Some(engine);
    }
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        if let Some(connection_id) = self.connection_id.as_deref() {
            if let Some(engine) = &self.engine {
                let _ = engine.detach_all(connection_id);
            }
            self.control.presentation.disconnect(connection_id);
        }
        self.control
            .connected_clients
            .fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) struct DeliveryState {
    handle: String,
    stream_id: String,
    epoch: u64,
    dirty: bool,
    snapshot_pending: bool,
    snapshot_ack_pending: Option<u64>,
    minimum_seq: u64,
    last_queued_seq: u64,
    last_delivered_seq: u64,
    exit_behavior: ExitBehavior,
}

impl Default for DeliveryState {
    fn default() -> Self {
        Self {
            handle: String::new(),
            stream_id: String::new(),
            epoch: 0,
            dirty: false,
            snapshot_pending: false,
            snapshot_ack_pending: None,
            minimum_seq: 0,
            last_queued_seq: 0,
            last_delivered_seq: 0,
            exit_behavior: ExitBehavior::Keep,
        }
    }
}

pub(super) enum HighFrame {
    Response(ResponseEnvelope, Option<oneshot::Sender<()>>),
    Event(EventEnvelope),
    Exit {
        attach_id: String,
        epoch: u64,
        through_seq: u64,
        event: EventEnvelope,
    },
    Resync {
        version: ProtocolVersion,
        identity: terminal_host_core::StreamIdentity,
        attach_id: String,
        current_seq: u64,
        reason: ResyncReason,
    },
}

struct OutputFrame {
    attach_id: String,
    epoch: u64,
    seq: u64,
    event: EventEnvelope,
}

enum ExitBarrier {
    Pending,
    Ready {
        epoch: u64,
        through_seq: u64,
        exit_behavior: ExitBehavior,
    },
}

struct Dispatch {
    response: ResponseEnvelope,
    subscription: Option<EventSubscription>,
    stop_after_flush: bool,
    release_snapshot: Option<(String, u64)>,
}

struct EffectFailure {
    code: TransportErrorCode,
    effect: EffectClassification,
    request_id: Option<String>,
    handle: Option<String>,
}

struct DispatchClient<'a> {
    connection_id: &'a str,
    client_class: &'a ClientClass,
    deliveries: &'a Arc<Mutex<HashMap<String, DeliveryState>>>,
    high: &'a mpsc::Sender<HighFrame>,
}

impl TerminalHostService {
    pub fn connected_client_count(&self) -> usize {
        self.control.connected_clients.load(Ordering::Acquire)
    }

    pub fn live_session_count(&self) -> usize {
        self.engine
            .as_ref()
            .map_or(0, |engine| engine.session_count())
    }

    pub fn shutdown_receiver(&self) -> watch::Receiver<bool> {
        self.control.shutdown.subscribe()
    }

    pub fn idle_shutdown_duration(&self) -> Duration {
        self.limits.idle_shutdown
    }
}

pub(super) async fn serve_pty_stream<S>(
    service: &TerminalHostService,
    stream: &mut S,
) -> Result<(), HostError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let _connection: OwnedSemaphorePermit = service
        .connections
        .clone()
        .try_acquire_owned()
        .map_err(|_| HostError::QueueFull)?;
    let mut client_guard = service.control.connect();
    let preauth = service
        .preauth
        .clone()
        .try_acquire_owned()
        .map_err(|_| HostError::QueueFull)?;
    let first = timeout(
        service.limits.hello_timeout,
        read_frame(stream, terminal_host_protocol::MAX_HELLO_FRAME_BYTES),
    )
    .await
    .map_err(|_| HostError::Timeout)??;
    let (id, selected, ack, client_class) = match service.authenticate_frame_detailed(&first) {
        Ok(value) => value,
        Err(_) => {
            super::write_unauthorized(stream).await?;
            return Err(HostError::Unauthorized);
        }
    };
    let engine = Arc::clone(service.engine.as_ref().ok_or(HostError::Catalog)?);
    client_guard.authenticated(ack.connection_id.clone(), Arc::clone(&engine));
    write_response(
        stream,
        &ResponseEnvelope {
            version: selected,
            kind: EnvelopeKind::Response,
            id,
            result: Some(serde_json::to_value(&ack).map_err(|_| HostError::Io)?),
            error: None,
        },
    )
    .await?;
    drop(preauth);

    let (mut reader, mut writer) = tokio::io::split(stream);
    let (high_tx, mut high_rx) = mpsc::channel::<HighFrame>(service.limits.writer_queue_capacity);
    let (low_tx, mut low_rx) = mpsc::channel::<OutputFrame>(service.limits.writer_queue_capacity);
    let deliveries = Arc::new(Mutex::new(HashMap::<String, DeliveryState>::new()));
    let cancelled = Arc::new(AtomicBool::new(false));
    let (cancel_tx, mut writer_cancel_rx) = watch::channel(false);
    let mut reader_cancel_rx = cancel_tx.subscribe();
    let event_tasks = Arc::new(Mutex::new(Vec::<JoinHandle<()>>::new()));

    let writer_deliveries = Arc::clone(&deliveries);
    let writer_future = writer_loop(
        &mut writer,
        &mut high_rx,
        &mut low_rx,
        &mut writer_cancel_rx,
        &writer_deliveries,
    );

    let connection_id = ack.connection_id.clone();
    let reader_deliveries = Arc::clone(&deliveries);
    let reader_cancelled = Arc::clone(&cancelled);
    let reader_tasks = Arc::clone(&event_tasks);
    let reader_high = high_tx.clone();
    let reader_low = low_tx.clone();
    let reader_cancel = cancel_tx.clone();
    let reader_engine = Arc::clone(&engine);
    let reader_connection_id = connection_id.clone();
    let reader_future = async move {
        loop {
            let frame = tokio::select! {
                changed = reader_cancel_rx.changed() => {
                    if changed.is_err() || *reader_cancel_rx.borrow() {
                        return Ok::<(), HostError>(());
                    }
                    continue;
                }
                result = read_frame(&mut reader, terminal_host_protocol::MAX_FRAME_BYTES) => {
                    match result {
                        Ok(frame) => frame,
                        Err(_) => return Ok(()),
                    }
                }
            };
            let worker_service = service.clone();
            let worker_engine = Arc::clone(&reader_engine);
            let worker_connection_id = reader_connection_id.clone();
            let worker_client_class = client_class.clone();
            let worker_deliveries = Arc::clone(&reader_deliveries);
            let worker_cancelled = Arc::clone(&reader_cancelled);
            let worker_high = reader_high.clone();
            let dispatch = tokio::task::spawn_blocking(move || {
                let dispatch = dispatch_request(
                    &worker_service,
                    &worker_engine,
                    selected,
                    &frame,
                    DispatchClient {
                        connection_id: &worker_connection_id,
                        client_class: &worker_client_class,
                        deliveries: &worker_deliveries,
                        high: &worker_high,
                    },
                );
                cleanup_cancelled_dispatch(
                    &worker_cancelled,
                    &worker_engine,
                    &worker_connection_id,
                );
                dispatch
            })
            .await
            .map_err(|_| HostError::Io)?;
            let stop_after_flush = dispatch.stop_after_flush;
            let release_snapshot = dispatch.release_snapshot.clone();
            let (receipt_tx, receipt_rx) = oneshot::channel();
            if enqueue_response_then_release(
                &reader_high,
                HighFrame::Response(dispatch.response, Some(receipt_tx)),
                release_snapshot,
                &reader_deliveries,
            )
            .is_err()
            {
                reader_cancelled.store(true, Ordering::Release);
                let _ = reader_cancel.send(true);
                return Err(HostError::QueueFull);
            }
            if let Some(subscription) = dispatch.subscription {
                let task = spawn_event_forwarder(
                    subscription,
                    Arc::clone(&reader_deliveries),
                    reader_high.clone(),
                    reader_low.clone(),
                    Arc::clone(&reader_cancelled),
                    reader_cancel.clone(),
                    selected,
                );
                if let Err(task) = track_event_task(&reader_tasks, task) {
                    task.abort();
                    reader_cancelled.store(true, Ordering::Release);
                    let _ = reader_cancel.send(true);
                    return Err(HostError::Io);
                }
            }
            timeout(service.limits.request_timeout, receipt_rx)
                .await
                .map_err(|_| HostError::Timeout)?
                .map_err(|_| HostError::Io)?;
            if stop_after_flush {
                service.control.request_shutdown();
                return Ok(());
            }
        }
    };

    tokio::pin!(writer_future);
    tokio::pin!(reader_future);
    let result = tokio::select! {
        result = &mut reader_future => result,
        result = &mut writer_future => result,
    };
    cancelled.store(true, Ordering::Release);
    let _ = cancel_tx.send(true);
    drop(high_tx);
    drop(low_tx);
    let tasks = event_tasks
        .lock()
        .map(|mut tasks| std::mem::take(&mut *tasks))
        .unwrap_or_default();
    for task in tasks {
        let _ = task.await;
    }
    let _ = engine.detach_all(&connection_id);
    result
}

fn cleanup_cancelled_dispatch(
    cancelled: &AtomicBool,
    engine: &DaemonPtyEngine,
    connection_id: &str,
) {
    // `spawn_blocking` keeps running after its async JoinHandle is dropped. If
    // the socket writer fails while an attach dispatch is still in flight,
    // the normal connection cleanup can race ahead of that late attachment.
    // Repeating detach-all after the dispatch closes both orderings.
    if cancelled.load(Ordering::Acquire) {
        let _ = engine.detach_all(connection_id);
    }
}

fn track_event_task(
    tasks: &Arc<Mutex<Vec<JoinHandle<()>>>>,
    task: JoinHandle<()>,
) -> Result<(), JoinHandle<()>> {
    let Ok(mut tasks) = tasks.lock() else {
        return Err(task);
    };
    tasks.retain(|existing| !existing.is_finished());
    tasks.push(task);
    Ok(())
}

fn dispatch_request(
    service: &TerminalHostService,
    engine: &DaemonPtyEngine,
    selected: ProtocolVersion,
    frame: &[u8],
    client: DispatchClient<'_>,
) -> Dispatch {
    let DispatchClient {
        connection_id,
        client_class,
        deliveries,
        high,
    } = client;
    let envelope: RequestEnvelope = match serde_json::from_slice(frame) {
        Ok(value) => value,
        Err(_) => return failed(selected, 0, TransportErrorCode::InvalidRequest),
    };
    if let Err(error) = envelope.validate_for(&selected) {
        return failed_for_method(
            selected,
            envelope.id,
            &envelope.method,
            ipc_error_code(error),
        );
    }
    let params = match envelope.decode_params() {
        Ok(params) => params,
        Err(error) => {
            return failed_for_method(
                selected,
                envelope.id,
                &envelope.method,
                ipc_error_code(error),
            )
        }
    };
    let id = envelope.id;
    let is_runtime_stop = envelope.method == Method::RuntimeStop;
    let result = match (envelope.method, params) {
        (Method::Health, RequestParams::Health(_)) => value(HealthResult {
            status: "ok".into(),
            runtime_id: service.endpoint.runtime_id.clone(),
            owner_generation: service.endpoint.owner_generation,
            desktop_available: service.control.presentation.desktop_available(),
        }),
        (Method::SessionCreate, RequestParams::SessionCreate(request)) => {
            match create_session(service, engine, selected, request) {
                Ok(result) => Ok(result),
                Err(error) => return failed_effect(selected, id, error),
            }
        }
        (Method::SessionGet, RequestParams::SessionGet(request)) => {
            let selector = match (request.selector.handle, request.selector.request_id) {
                (Some(handle), None) => CatalogSelector::Handle(handle),
                (None, Some(request_id)) => CatalogSelector::RequestId(request_id),
                _ => return failed(selected, id, TransportErrorCode::InvalidRequest),
            };
            engine
                .lookup(selector)
                .map_err(map_runtime_error)
                .and_then(|lookup| {
                    lookup_record(lookup)
                        .and_then(|record| map_record(engine, record))
                        .and_then(value)
                })
        }
        (Method::SessionList, RequestParams::SessionList(_)) => engine
            .list_page(service.limits.max_list_records as u32)
            .map_err(map_runtime_error)
            .and_then(|page| {
                if page.has_more {
                    Err(TransportErrorCode::InternalError)
                } else {
                    value(SessionListResponse {
                        sessions: page
                            .records
                            .into_iter()
                            .map(|record| map_record(engine, record))
                            .collect::<Result<Vec<_>, _>>()?,
                    })
                }
            }),
        (Method::SessionAttach, RequestParams::SessionAttach(request)) => {
            let reservation = match service
                .control
                .presentation
                .reserve_attachment(connection_id, &request.handle)
            {
                Ok(reservation) => reservation,
                Err(error) => return failed(selected, id, map_prepare_error(error)),
            };
            let exit_behavior = match engine.authoritative_lookup(&request.handle) {
                Ok(record) => record.exit_behavior,
                Err(error) => {
                    if let Some(attempt) = &reservation {
                        service.control.presentation.release_reservation(attempt);
                    }
                    return failed(selected, id, map_runtime_error(error));
                }
            };
            return match engine.attach(&request.handle, connection_id) {
                Ok(attached) => {
                    let attach_id = attached.attach_id.clone();
                    let stream_id = attached.identity.stream_id.clone();
                    let barrier_seq = attached.barrier_seq;
                    let inserted = deliveries
                        .lock()
                        .map_err(|_| TransportErrorCode::InternalError)
                        .map(|mut states| {
                            states.insert(
                                attach_id.clone(),
                                DeliveryState {
                                    handle: attached.identity.handle.clone(),
                                    stream_id: attached.identity.stream_id.clone(),
                                    minimum_seq: barrier_seq,
                                    last_queued_seq: barrier_seq,
                                    last_delivered_seq: barrier_seq,
                                    exit_behavior,
                                    ..DeliveryState::default()
                                },
                            );
                        });
                    if let Err(code) = inserted {
                        let _ = engine.detach(&attach_id, &stream_id);
                        if let Some(attempt) = &reservation {
                            service.control.presentation.release_reservation(attempt);
                        }
                        return failed(selected, id, code);
                    }
                    if let Some(attempt) = &reservation {
                        if service
                            .control
                            .presentation
                            .bind_attachment(attempt, attach_id.clone(), stream_id.clone())
                            .is_err()
                        {
                            let _ = engine.detach(&attach_id, &stream_id);
                            if let Ok(mut states) = deliveries.lock() {
                                states.remove(&attach_id);
                            }
                            service.control.presentation.release_reservation(attempt);
                            return failed(selected, id, TransportErrorCode::SurfaceFailed);
                        }
                    }
                    match value(map_attach(&attached)) {
                        Ok(response) => Dispatch {
                            response: success(selected, id, response),
                            subscription: Some(attached.subscription),
                            stop_after_flush: false,
                            release_snapshot: None,
                        },
                        Err(code) => {
                            let _ = engine.detach(&attach_id, &stream_id);
                            if let Ok(mut states) = deliveries.lock() {
                                states.remove(&attach_id);
                            }
                            service.control.presentation.release_attachment(
                                connection_id,
                                &attach_id,
                                &stream_id,
                            );
                            failed(selected, id, code)
                        }
                    }
                }
                Err(error) => {
                    if let Some(attempt) = &reservation {
                        service.control.presentation.release_reservation(attempt);
                    }
                    failed(selected, id, map_runtime_error(error))
                }
            };
        }
        (Method::SessionDetach, RequestParams::SessionDetach(request)) => {
            if !owns_attachment(deliveries, &request.attach_id) {
                Err(TransportErrorCode::InvalidRequest)
            } else {
                let result = engine
                    .detach(&request.attach_id, &request.stream_id)
                    .map_err(map_runtime_error)
                    .and_then(|_| empty());
                if result.is_ok() {
                    if let Ok(mut states) = deliveries.lock() {
                        states.remove(&request.attach_id);
                    }
                    service.control.presentation.release_attachment(
                        connection_id,
                        &request.attach_id,
                        &request.stream_id,
                    );
                }
                result
            }
        }
        (Method::SessionInput, RequestParams::SessionInput(request)) => {
            if !owns_attachment(deliveries, &request.attach_id) {
                Err(TransportErrorCode::InvalidRequest)
            } else {
                BASE64
                    .decode(request.data_base64)
                    .map_err(|_| TransportErrorCode::InvalidRequest)
                    .and_then(|bytes| {
                        engine
                            .input(&request.attach_id, &request.stream_id, bytes)
                            .map_err(map_runtime_error)
                    })
                    .and_then(|_| empty())
            }
        }
        (Method::SessionResize, RequestParams::SessionResize(request)) => {
            if !owns_attachment(deliveries, &request.attach_id) {
                Err(TransportErrorCode::InvalidRequest)
            } else {
                engine
                    .resize(
                        &request.attach_id,
                        &request.stream_id,
                        request.rows,
                        request.cols,
                    )
                    .map_err(map_runtime_error)
                    .and_then(|_| empty())
            }
        }
        (Method::SessionAck, RequestParams::SessionAck(request)) => {
            if !owns_attachment(deliveries, &request.attach_id) {
                Err(TransportErrorCode::InvalidRequest)
            } else {
                engine
                    .acknowledge(&request.attach_id, &request.stream_id, request.through_seq)
                    .map_err(map_runtime_error)
                    .and_then(|_| {
                        record_delivery_ack(deliveries, &request.attach_id, request.through_seq)
                            .and_then(|_| empty())
                    })
            }
        }
        (Method::SessionResync, RequestParams::SessionResync(request)) => {
            if !owns_attachment(deliveries, &request.attach_id) {
                Err(TransportErrorCode::InvalidRequest)
            } else {
                return deliveries
                    .lock()
                    .map_err(|_| TransportErrorCode::InternalError)
                    .and_then(|mut states| {
                        let state = states
                            .get_mut(&request.attach_id)
                            .ok_or(TransportErrorCode::InvalidRequest)?;
                        state.epoch = state.epoch.wrapping_add(1);
                        state.dirty = true;
                        state.snapshot_pending = true;
                        let epoch = state.epoch;
                        engine
                            .resync(&request.attach_id, &request.stream_id)
                            .map_err(map_runtime_error)
                            .and_then(|(barrier_seq, snapshot)| {
                                state.minimum_seq = barrier_seq;
                                state.last_queued_seq = barrier_seq;
                                state.last_delivered_seq = barrier_seq;
                                state.snapshot_ack_pending = Some(barrier_seq);
                                let handle = state.handle.clone();
                                let stream_id = state.stream_id.clone();
                                value(SessionAttachResponse {
                                    runtime_id: service.endpoint.runtime_id.clone(),
                                    handle,
                                    stream_id,
                                    attach_id: request.attach_id.clone(),
                                    barrier_seq,
                                    snapshot: map_snapshot(snapshot),
                                })
                                .map(|value| (value, epoch))
                            })
                    })
                    .map(|(response, epoch)| Dispatch {
                        response: success(selected, id, response),
                        subscription: None,
                        stop_after_flush: false,
                        release_snapshot: Some((request.attach_id.clone(), epoch)),
                    })
                    .unwrap_or_else(|code| {
                        if let Ok(mut states) = deliveries.lock() {
                            if let Some(state) = states.get_mut(&request.attach_id) {
                                state.snapshot_pending = false;
                            }
                        }
                        failed(selected, id, code)
                    });
            }
        }
        (Method::SessionClose, RequestParams::SessionClose(request)) => {
            let handle = request.handle.clone();
            let result = engine
                .close(
                    &request.handle,
                    match request.mode {
                        CloseMode::Graceful => CoreCloseMode::Graceful {
                            timeout: CLOSE_TIMEOUT,
                        },
                        CloseMode::Force => CoreCloseMode::Force {
                            timeout: CLOSE_TIMEOUT,
                        },
                    },
                )
                .map_err(map_runtime_error)
                .and_then(close_outcome_result);
            if result.is_ok() {
                service.control.presentation.session_closed(&handle);
            }
            result
        }
        (Method::SessionPresent, RequestParams::SessionPresent(request)) => {
            present_session(service, engine, selected, request)
        }
        (Method::DesktopRegister, RequestParams::DesktopRegister(request)) => {
            if client_class != &ClientClass::Desktop {
                Err(TransportErrorCode::InvalidRequest)
            } else {
                service
                    .control
                    .presentation
                    .register(
                        connection_id.to_owned(),
                        request,
                        high.clone(),
                        Arc::clone(deliveries),
                    )
                    .map_err(map_prepare_error)
                    .and_then(|_| empty())
            }
        }
        (Method::SurfaceReady, RequestParams::SurfaceReady(request)) => surface_ready(
            service,
            engine,
            connection_id,
            client_class,
            deliveries,
            request,
        ),
        (Method::SurfaceHidden, RequestParams::SurfaceHidden(request)) => surface_hidden(
            service,
            engine,
            connection_id,
            client_class,
            deliveries,
            request,
        ),
        (Method::RuntimeStop, RequestParams::RuntimeStop(request)) => {
            stop_runtime(engine, request.terminate_live_sessions).and_then(|_| empty())
        }
        _ => Err(TransportErrorCode::InvalidMethod),
    };
    match result {
        Ok(result) => Dispatch {
            response: success(selected, id, result),
            subscription: None,
            stop_after_flush: is_runtime_stop,
            release_snapshot: None,
        },
        Err(code) => failed(selected, id, code),
    }
}

fn create_session(
    service: &TerminalHostService,
    engine: &DaemonPtyEngine,
    selected: ProtocolVersion,
    request: terminal_host_protocol::SessionCreateRequest,
) -> Result<serde_json::Value, EffectFailure> {
    let request_id = request.request_id.clone();
    let placement = request.placement.clone();
    let presentation = request.presentation.clone();
    let normalized = normalize_create_request(service, request).map_err(|code| EffectFailure {
        code,
        effect: EffectClassification::NoEffect,
        request_id: Some(request_id.clone()),
        handle: None,
    })?;
    let existing = engine.lookup(CatalogSelector::RequestId(request_id.clone()));
    let can_reuse = matches!(existing, Ok(CatalogLookup::ActiveOrTombstone { .. }));
    if !can_reuse
        && !service
            .control
            .presentation
            .is_available(&placement, &presentation)
    {
        return Err(EffectFailure {
            code: TransportErrorCode::AppUnavailable,
            effect: EffectClassification::NoEffect,
            request_id: Some(request_id),
            handle: None,
        });
    }
    let created = engine.create(normalized).map_err(|error| EffectFailure {
        code: map_runtime_error(error),
        effect: EffectClassification::NoEffect,
        request_id: Some(request_id.clone()),
        handle: None,
    })?;
    let disposition = match created.disposition {
        CoreCreateDisposition::Created => CreateDisposition::Created,
        CoreCreateDisposition::Reused => CreateDisposition::Reused,
    };
    let handle = created.identity.handle;
    let record = engine
        .authoritative_lookup(&handle)
        .map_err(|error| EffectFailure {
            code: map_runtime_error(error),
            effect: EffectClassification::SessionCreated,
            request_id: Some(request_id.clone()),
            handle: Some(handle.clone()),
        })?;
    if !record.surface_hidden
        && matches!(
            record.state,
            TerminalState::Creating | TerminalState::Running
        )
    {
        present_record(service, engine, selected, &record).map_err(|code| EffectFailure {
            code,
            effect: EffectClassification::SessionCreated,
            request_id: Some(request_id.clone()),
            handle: Some(handle.clone()),
        })?;
    }
    let final_record = engine
        .authoritative_lookup(&handle)
        .map_err(|error| EffectFailure {
            code: map_runtime_error(error),
            effect: EffectClassification::SessionCreated,
            request_id: Some(request_id.clone()),
            handle: Some(handle.clone()),
        })?;
    let session = map_record(engine, final_record).map_err(|code| EffectFailure {
        code,
        effect: EffectClassification::SessionCreated,
        request_id: Some(request_id.clone()),
        handle: Some(handle.clone()),
    })?;
    value(SessionCreateResponse {
        disposition,
        session,
    })
    .map_err(|code| EffectFailure {
        code,
        effect: EffectClassification::SessionCreated,
        request_id: Some(request_id),
        handle: Some(handle),
    })
}

fn present_session(
    service: &TerminalHostService,
    engine: &DaemonPtyEngine,
    selected: ProtocolVersion,
    request: SessionPresentRequest,
) -> Result<serde_json::Value, TransportErrorCode> {
    let current = engine
        .authoritative_lookup(&request.handle)
        .map_err(map_runtime_error)?;
    if !service
        .control
        .presentation
        .is_available(&request.placement, &request.presentation)
    {
        return Err(TransportErrorCode::AppUnavailable);
    }
    let workspace_target = match request.placement {
        Placement::Workspace => {
            let path = request
                .workspace_target
                .or(current.workspace_target.clone())
                .ok_or(TransportErrorCode::InvalidRequest)?;
            let canonical = std::fs::canonicalize(PathBuf::from(path))
                .map_err(|_| TransportErrorCode::InvalidRequest)?;
            if !canonical.is_dir() {
                return Err(TransportErrorCode::InvalidRequest);
            }
            Some(canonical.to_string_lossy().into_owned())
        }
        Placement::Window => None,
    };
    let target = map_target(&request.placement, workspace_target).map_err(map_prepare_error)?;
    let transition = engine
        .set_desired_presentation(
            &request.handle,
            target,
            request.presentation,
            current.revision,
        )
        .map_err(map_runtime_error)?;
    present_record(service, engine, selected, &transition.record)?;
    let record = engine
        .authoritative_lookup(&request.handle)
        .map_err(map_runtime_error)?;
    map_record(engine, record).and_then(value)
}

fn present_record(
    service: &TerminalHostService,
    engine: &DaemonPtyEngine,
    selected: ProtocolVersion,
    record: &TerminalRecord,
) -> Result<(), TransportErrorCode> {
    let event = SurfacePresentRequestedEvent {
        handle: record.handle.clone(),
        revision: record.revision,
        placement: record.placement.clone(),
        workspace_target: record.workspace_target.clone(),
        presentation: record.presentation.clone(),
    };
    let attempt = service
        .control
        .presentation
        .prepare(engine, selected, event)
        .map_err(|_| TransportErrorCode::SurfaceFailed)?;
    let ready = attempt.wait(PRESENTATION_READY_TIMEOUT);
    service.control.presentation.finish_wait(engine, &attempt);
    ready.then_some(()).ok_or(TransportErrorCode::SurfaceFailed)
}

fn surface_ready(
    service: &TerminalHostService,
    engine: &DaemonPtyEngine,
    connection_id: &str,
    client_class: &ClientClass,
    deliveries: &Arc<Mutex<HashMap<String, DeliveryState>>>,
    request: SurfaceReadyRequest,
) -> Result<serde_json::Value, TransportErrorCode> {
    if client_class != &ClientClass::Desktop || !owns_surface_attachment(deliveries, &request) {
        return Err(TransportErrorCode::InvalidRequest);
    }
    let record = engine
        .authoritative_lookup(&request.handle)
        .map_err(map_runtime_error)?;
    if record.revision != request.revision || record.surface_hidden {
        return Err(TransportErrorCode::StalePresentation);
    }
    if !service.control.presentation.connection_supports(
        connection_id,
        &record.placement,
        &record.presentation,
    ) {
        return Err(TransportErrorCode::AppUnavailable);
    }
    service
        .control
        .presentation
        .ready(
            connection_id,
            &request.handle,
            request.revision,
            request.attach_id,
            request.stream_id,
        )
        .map_err(map_prepare_error)?;
    map_record(engine, record).and_then(value)
}

fn surface_hidden(
    service: &TerminalHostService,
    engine: &DaemonPtyEngine,
    connection_id: &str,
    client_class: &ClientClass,
    deliveries: &Arc<Mutex<HashMap<String, DeliveryState>>>,
    request: SurfaceHiddenRequest,
) -> Result<serde_json::Value, TransportErrorCode> {
    if client_class != &ClientClass::Desktop
        || !owns_surface_hidden_attachment(deliveries, &request)
    {
        return Err(TransportErrorCode::InvalidRequest);
    }
    service
        .control
        .presentation
        .lease(
            connection_id,
            &request.handle,
            request.revision,
            &request.attach_id,
            &request.stream_id,
        )
        .map_err(|_| TransportErrorCode::StalePresentation)?;
    let transition = engine
        .set_surface_hidden(&request.handle, request.revision)
        .map_err(map_runtime_error)?;
    engine
        .detach(&request.attach_id, &request.stream_id)
        .map_err(map_runtime_error)?;
    if let Ok(mut states) = deliveries.lock() {
        states.remove(&request.attach_id);
    }
    service
        .control
        .presentation
        .remove_lease(&request.handle, request.revision);
    map_record(engine, transition.record).and_then(value)
}

fn normalize_create_request(
    service: &TerminalHostService,
    request: terminal_host_protocol::SessionCreateRequest,
) -> Result<terminal_host_core::CreatePtyRequest, TransportErrorCode> {
    let cwd = std::fs::canonicalize(PathBuf::from(&request.cwd))
        .map_err(|_| TransportErrorCode::InvalidRequest)?;
    if !cwd.is_dir() {
        return Err(TransportErrorCode::InvalidRequest);
    }
    let cwd_wire = cwd.to_string_lossy().into_owned();
    let title = request
        .title
        .and_then(|value| (!value.trim().is_empty()).then_some(value));
    let placement =
        serde_json::to_vec(&request.placement).map_err(|_| TransportErrorCode::InternalError)?;
    let presentation =
        serde_json::to_vec(&request.presentation).map_err(|_| TransportErrorCode::InternalError)?;
    let exit_behavior = serde_json::to_vec(&request.exit_behavior)
        .map_err(|_| TransportErrorCode::InternalError)?;
    let rows = request.rows.to_le_bytes();
    let cols = request.cols.to_le_bytes();
    let mut owned = Vec::<Vec<u8>>::with_capacity(request.args.len() + 8);
    owned.push(request.executable.as_bytes().to_vec());
    owned.push(cwd_wire.as_bytes().to_vec());
    owned.push(title.as_deref().unwrap_or("").as_bytes().to_vec());
    owned.push(placement);
    owned.push(presentation);
    owned.push(exit_behavior);
    owned.push(rows.to_vec());
    owned.push(cols.to_vec());
    owned.extend(
        request
            .args
            .iter()
            .map(|argument| argument.as_bytes().to_vec()),
    );
    let fields = owned.iter().map(Vec::as_slice).collect::<Vec<_>>();
    let digest = RequestDigest::new(service.secret.derive_create_digest(&fields));
    let target = match request.placement {
        terminal_host_protocol::Placement::Workspace => PresentationTarget::Workspace {
            normalized_path: cwd_wire.clone(),
        },
        terminal_host_protocol::Placement::Window => PresentationTarget::Window,
    };
    Ok(terminal_host_core::CreatePtyRequest {
        request_id: request.request_id,
        digest,
        executable: PathBuf::from(request.executable),
        args: request.args,
        cwd,
        rows: request.rows,
        cols: request.cols,
        title,
        target,
        presentation: request.presentation,
        exit_behavior: request.exit_behavior,
    })
}

fn stop_runtime(
    engine: &DaemonPtyEngine,
    terminate_live_sessions: bool,
) -> Result<(), TransportErrorCode> {
    if engine.session_count() == 0 {
        return Ok(());
    }
    if !terminate_live_sessions {
        return Err(TransportErrorCode::RuntimeBusy);
    }
    let page = engine
        .list_page(terminal_host_core::MAX_LIST_PAGE_SIZE)
        .map_err(map_runtime_error)?;
    for record in page.records {
        if matches!(
            record.state,
            TerminalState::Creating | TerminalState::Running | TerminalState::Closing
        ) {
            engine
                .close(
                    &record.handle,
                    CoreCloseMode::Force {
                        timeout: CLOSE_TIMEOUT,
                    },
                )
                .map_err(map_runtime_error)?;
        }
    }
    (engine.session_count() == 0)
        .then_some(())
        .ok_or(TransportErrorCode::RuntimeBusy)
}

fn spawn_event_forwarder(
    subscription: EventSubscription,
    deliveries: Arc<Mutex<HashMap<String, DeliveryState>>>,
    high: mpsc::Sender<HighFrame>,
    low: mpsc::Sender<OutputFrame>,
    cancelled: Arc<AtomicBool>,
    cancel: watch::Sender<bool>,
    version: ProtocolVersion,
) -> JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        let mut held_event = None;
        while !cancelled.load(Ordering::Acquire) {
            let snapshot_pending = deliveries
                .lock()
                .ok()
                .and_then(|states| {
                    states
                        .get(&subscription.attach_id)
                        .map(|state| state.snapshot_pending)
                })
                .unwrap_or(false);
            if snapshot_pending {
                std::thread::sleep(Duration::from_millis(1));
                continue;
            }
            let event = match held_event
                .take()
                .or_else(|| subscription.recv_timeout(SUBSCRIPTION_POLL))
            {
                Some(event) => event,
                None if subscription.is_finished() => break,
                None => continue,
            };
            let snapshot_pending = deliveries
                .lock()
                .ok()
                .and_then(|states| {
                    states
                        .get(&subscription.attach_id)
                        .map(|state| state.snapshot_pending)
                })
                .unwrap_or(false);
            if snapshot_pending {
                held_event = Some(event);
                continue;
            }
            match event {
                RuntimeEvent::Output {
                    identity,
                    attach_id,
                    seq,
                    bytes,
                } => {
                    let (epoch, should_send) = match deliveries.lock() {
                        Ok(states) => match states.get(&attach_id) {
                            Some(state) => (state.epoch, !state.dirty && seq > state.minimum_seq),
                            None => break,
                        },
                        Err(_) => {
                            cancelled.store(true, Ordering::Release);
                            let _ = cancel.send(true);
                            break;
                        }
                    };
                    if !should_send {
                        continue;
                    }
                    let event = event_envelope(
                        version,
                        EventName::SessionOutput,
                        SessionOutputEvent {
                            runtime_id: identity.runtime_id.clone(),
                            handle: identity.handle.clone(),
                            stream_id: identity.stream_id.clone(),
                            attach_id: attach_id.clone(),
                            seq,
                            data_base64: BASE64.encode(bytes),
                        },
                    );
                    if low
                        .try_send(OutputFrame {
                            attach_id: attach_id.clone(),
                            epoch,
                            seq,
                            event,
                        })
                        .is_ok()
                    {
                        if let Ok(mut states) = deliveries.lock() {
                            if let Some(state) = states.get_mut(&attach_id) {
                                if state.epoch == epoch {
                                    state.last_queued_seq = seq;
                                }
                            }
                        }
                        continue;
                    }
                    let resync = match deliveries.lock() {
                        Ok(mut states) => match states.get_mut(&attach_id) {
                            Some(state) if !state.dirty && state.epoch == epoch => {
                                state.dirty = true;
                                Some(())
                            }
                            _ => None,
                        },
                        Err(_) => None,
                    };
                    if resync.is_some()
                        && high
                            .try_send(HighFrame::Resync {
                                version,
                                identity,
                                attach_id,
                                current_seq: seq,
                                reason: ResyncReason::QueueOverflow,
                            })
                            .is_err()
                    {
                        cancelled.store(true, Ordering::Release);
                        let _ = cancel.send(true);
                        break;
                    }
                }
                RuntimeEvent::State {
                    identity,
                    revision,
                    state,
                } => send_control(
                    &high,
                    &cancelled,
                    &cancel,
                    event_envelope(
                        version,
                        EventName::SessionState,
                        SessionStateEvent {
                            runtime_id: identity.runtime_id,
                            handle: identity.handle,
                            stream_id: identity.stream_id,
                            state: map_state(state),
                            revision,
                        },
                    ),
                ),
                RuntimeEvent::Exit {
                    identity,
                    revision,
                    exit_code,
                } => {
                    let barrier = loop {
                        if cancelled.load(Ordering::Acquire) {
                            break None;
                        }
                        match exit_barrier(&deliveries, &subscription.attach_id) {
                            Some(ExitBarrier::Ready {
                                epoch,
                                through_seq,
                                exit_behavior,
                            }) => break Some((epoch, through_seq, exit_behavior)),
                            Some(ExitBarrier::Pending) => {
                                std::thread::sleep(Duration::from_millis(1));
                            }
                            None => break None,
                        }
                    };
                    let Some((epoch, through_seq, exit_behavior)) = barrier else {
                        break;
                    };
                    if high
                        .try_send(HighFrame::Exit {
                            attach_id: subscription.attach_id.clone(),
                            epoch,
                            through_seq,
                            event: event_envelope(
                                version,
                                EventName::SessionExit,
                                SessionExitEvent {
                                    runtime_id: identity.runtime_id,
                                    handle: identity.handle,
                                    stream_id: identity.stream_id,
                                    revision,
                                    exit_code,
                                    exit_behavior,
                                },
                            ),
                        })
                        .is_err()
                    {
                        cancelled.store(true, Ordering::Release);
                        let _ = cancel.send(true);
                        break;
                    }
                }
                RuntimeEvent::ResyncRequired {
                    identity,
                    attach_id,
                    last_delivered_seq: _,
                    current_seq,
                    reason,
                } => {
                    let should_send = deliveries
                        .lock()
                        .ok()
                        .and_then(|mut states| {
                            states.get_mut(&attach_id).map(|state| {
                                let first = !state.dirty;
                                state.dirty = true;
                                first
                            })
                        })
                        .unwrap_or(false);
                    if should_send {
                        let reason = match reason {
                            terminal_host_core::ResyncReason::QueueOverflow => {
                                ResyncReason::QueueOverflow
                            }
                            terminal_host_core::ResyncReason::ReplayTruncated => {
                                ResyncReason::SequenceGap
                            }
                        };
                        if high
                            .try_send(HighFrame::Resync {
                                version,
                                identity,
                                attach_id,
                                current_seq,
                                reason,
                            })
                            .is_err()
                        {
                            cancelled.store(true, Ordering::Release);
                            let _ = cancel.send(true);
                            break;
                        }
                    }
                }
            }
        }
    })
}

fn exit_barrier(
    deliveries: &Arc<Mutex<HashMap<String, DeliveryState>>>,
    attach_id: &str,
) -> Option<ExitBarrier> {
    deliveries.lock().ok().and_then(|states| {
        states.get(attach_id).map(|state| {
            if state.dirty || state.snapshot_pending || state.snapshot_ack_pending.is_some() {
                ExitBarrier::Pending
            } else {
                ExitBarrier::Ready {
                    epoch: state.epoch,
                    through_seq: state.last_queued_seq,
                    exit_behavior: state.exit_behavior.clone(),
                }
            }
        })
    })
}

fn record_delivery_ack(
    deliveries: &Arc<Mutex<HashMap<String, DeliveryState>>>,
    attach_id: &str,
    through_seq: u64,
) -> Result<(), TransportErrorCode> {
    let mut states = deliveries
        .lock()
        .map_err(|_| TransportErrorCode::InternalError)?;
    if let Some(state) = states.get_mut(attach_id) {
        if state
            .snapshot_ack_pending
            .is_some_and(|barrier| through_seq >= barrier)
        {
            state.snapshot_ack_pending = None;
        }
    }
    Ok(())
}

fn send_control(
    high: &mpsc::Sender<HighFrame>,
    cancelled: &AtomicBool,
    cancel: &watch::Sender<bool>,
    event: EventEnvelope,
) {
    if high.try_send(HighFrame::Event(event)).is_err() {
        cancelled.store(true, Ordering::Release);
        let _ = cancel.send(true);
    }
}

fn enqueue_response_then_release(
    high: &mpsc::Sender<HighFrame>,
    response: HighFrame,
    release_snapshot: Option<(String, u64)>,
    deliveries: &Arc<Mutex<HashMap<String, DeliveryState>>>,
) -> Result<(), HostError> {
    high.try_send(response).map_err(|_| HostError::QueueFull)?;
    if let Some((attach_id, epoch)) = release_snapshot {
        let mut states = deliveries.lock().map_err(|_| HostError::Io)?;
        if let Some(state) = states.get_mut(&attach_id) {
            if state.epoch == epoch {
                state.snapshot_pending = false;
                state.dirty = false;
            }
        }
    }
    Ok(())
}

async fn writer_loop<S: AsyncWrite + Unpin>(
    writer: &mut S,
    high_rx: &mut mpsc::Receiver<HighFrame>,
    low_rx: &mut mpsc::Receiver<OutputFrame>,
    cancel_rx: &mut watch::Receiver<bool>,
    deliveries: &Arc<Mutex<HashMap<String, DeliveryState>>>,
) -> Result<(), HostError> {
    loop {
        while let Ok(frame) = high_rx.try_recv() {
            write_high(writer, frame, low_rx, deliveries).await?;
        }
        if high_rx.is_closed() && high_rx.is_empty() && low_rx.is_closed() && low_rx.is_empty() {
            return Ok(());
        }
        tokio::select! {
            biased;
            changed = cancel_rx.changed() => {
                if changed.is_err() || *cancel_rx.borrow() {
                    return Ok(());
                }
            }
            high = high_rx.recv(), if !(high_rx.is_closed() && high_rx.is_empty()) => match high {
                Some(frame) => write_high(writer, frame, low_rx, deliveries).await?,
                None if low_rx.is_closed() && low_rx.is_empty() => return Ok(()),
                None => {}
            },
            low = low_rx.recv(), if !(low_rx.is_closed() && low_rx.is_empty()) => match low {
                Some(frame) => {
                    write_output(writer, frame, deliveries).await?;
                }
                None if high_rx.is_closed() && high_rx.is_empty() => return Ok(()),
                None => {}
            }
        }
    }
}

async fn write_high<S: AsyncWrite + Unpin>(
    writer: &mut S,
    frame: HighFrame,
    low_rx: &mut mpsc::Receiver<OutputFrame>,
    deliveries: &Arc<Mutex<HashMap<String, DeliveryState>>>,
) -> Result<(), HostError> {
    match frame {
        HighFrame::Response(response, receipt) => {
            write_response(writer, &response).await?;
            if let Some(receipt) = receipt {
                let _ = receipt.send(());
            }
        }
        HighFrame::Event(event) => write_json_frame(writer, &event).await?,
        HighFrame::Exit {
            attach_id,
            epoch,
            through_seq,
            event,
        } => {
            loop {
                let pending = deliveries.lock().ok().and_then(|states| {
                    states.get(&attach_id).map(|state| {
                        state.epoch == epoch
                            && !state.dirty
                            && state.last_delivered_seq < through_seq
                    })
                });
                if pending != Some(true) {
                    break;
                }
                let frame = low_rx.recv().await.ok_or(HostError::Io)?;
                write_output(writer, frame, deliveries).await?;
            }
            write_json_frame(writer, &event).await?;
        }
        HighFrame::Resync {
            version,
            identity,
            attach_id,
            current_seq,
            reason,
        } => {
            let last_delivered_seq = deliveries
                .lock()
                .ok()
                .and_then(|states| states.get(&attach_id).map(|state| state.last_delivered_seq));
            if let Some(last_delivered_seq) = last_delivered_seq {
                let event = event_envelope(
                    version,
                    EventName::SessionResyncRequired,
                    SessionResyncRequiredEvent {
                        runtime_id: identity.runtime_id,
                        handle: identity.handle,
                        stream_id: identity.stream_id,
                        attach_id,
                        last_delivered_seq: last_delivered_seq.min(current_seq),
                        current_seq,
                        reason,
                    },
                );
                write_json_frame(writer, &event).await?;
            }
        }
    }
    Ok(())
}

async fn write_output<S: AsyncWrite + Unpin>(
    writer: &mut S,
    frame: OutputFrame,
    deliveries: &Arc<Mutex<HashMap<String, DeliveryState>>>,
) -> Result<(), HostError> {
    let current = deliveries.lock().ok().and_then(|states| {
        states
            .get(&frame.attach_id)
            .map(|state| (state.epoch, state.dirty))
    });
    if current == Some((frame.epoch, false)) {
        write_json_frame(writer, &frame.event).await?;
        if let Ok(mut states) = deliveries.lock() {
            if let Some(state) = states.get_mut(&frame.attach_id) {
                if state.epoch == frame.epoch {
                    state.last_delivered_seq = frame.seq;
                }
            }
        }
    }
    Ok(())
}

async fn write_json_frame<S: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut S,
    value: &T,
) -> Result<(), HostError> {
    let body = serde_json::to_vec(value).map_err(|_| HostError::Io)?;
    if body.len() > terminal_host_protocol::MAX_FRAME_BYTES {
        return Err(HostError::Io);
    }
    writer
        .write_u32_le(body.len() as u32)
        .await
        .map_err(|_| HostError::Io)?;
    writer.write_all(&body).await.map_err(|_| HostError::Io)?;
    writer.flush().await.map_err(|_| HostError::Io)
}

fn lookup_record(lookup: CatalogLookup) -> Result<TerminalRecord, TransportErrorCode> {
    match lookup {
        CatalogLookup::ActiveOrTombstone { terminal, .. } => Ok(*terminal),
        CatalogLookup::Collected(_) => Err(TransportErrorCode::TerminalNotFound),
    }
}

fn close_outcome_result(outcome: CloseOutcome) -> Result<serde_json::Value, TransportErrorCode> {
    match outcome {
        CloseOutcome::Exited => empty(),
        CloseOutcome::Pending => Err(TransportErrorCode::RuntimeBusy),
    }
}

fn map_record(
    engine: &DaemonPtyEngine,
    record: TerminalRecord,
) -> Result<SessionRecord, TransportErrorCode> {
    let child_pid = engine
        .live_child_pid(&record.handle)
        .map_err(map_runtime_error)?;
    Ok(SessionRecord {
        runtime_id: record.runtime_id,
        handle: record.handle,
        stream_id: record.stream_id,
        state: map_state(record.state),
        revision: record.revision,
        placement: record.placement,
        presentation: record.presentation,
        exit_behavior: record.exit_behavior,
        workspace_target: record.workspace_target,
        surface_hidden: record.surface_hidden,
        exit_code: record.exit_code,
        child_pid,
    })
}

fn map_attach(attached: &terminal_host_core::AttachResult) -> SessionAttachResponse {
    SessionAttachResponse {
        runtime_id: attached.identity.runtime_id.clone(),
        handle: attached.identity.handle.clone(),
        stream_id: attached.identity.stream_id.clone(),
        attach_id: attached.attach_id.clone(),
        barrier_seq: attached.barrier_seq,
        snapshot: map_snapshot(attached.snapshot.clone()),
    }
}

fn map_snapshot(snapshot: terminal_host_core::PtySnapshot) -> TerminalSnapshot {
    TerminalSnapshot {
        content_base64: BASE64.encode(snapshot.content),
        rows: snapshot.rows,
        cols: snapshot.cols,
        cursor_row: snapshot.cursor_row,
        cursor_col: snapshot.cursor_col,
        history_base64: None,
    }
}

fn map_state(state: TerminalState) -> SessionState {
    match state {
        TerminalState::Creating => SessionState::Creating,
        TerminalState::Running => SessionState::Running,
        TerminalState::Exited => SessionState::Exited,
        TerminalState::Closing => SessionState::Closing,
        TerminalState::Closed => SessionState::Closed,
        TerminalState::Lost => SessionState::Lost,
    }
}

fn owns_attachment(
    deliveries: &Arc<Mutex<HashMap<String, DeliveryState>>>,
    attach_id: &str,
) -> bool {
    deliveries
        .lock()
        .is_ok_and(|states| states.contains_key(attach_id))
}

fn owns_surface_attachment(
    deliveries: &Arc<Mutex<HashMap<String, DeliveryState>>>,
    request: &SurfaceReadyRequest,
) -> bool {
    deliveries.lock().is_ok_and(|states| {
        states.get(&request.attach_id).is_some_and(|state| {
            state.handle == request.handle && state.stream_id == request.stream_id
        })
    })
}

fn owns_surface_hidden_attachment(
    deliveries: &Arc<Mutex<HashMap<String, DeliveryState>>>,
    request: &SurfaceHiddenRequest,
) -> bool {
    deliveries.lock().is_ok_and(|states| {
        states.get(&request.attach_id).is_some_and(|state| {
            state.handle == request.handle && state.stream_id == request.stream_id
        })
    })
}

fn empty() -> Result<serde_json::Value, TransportErrorCode> {
    value(EmptyResponse {})
}

fn value<T: Serialize>(value: T) -> Result<serde_json::Value, TransportErrorCode> {
    serde_json::to_value(value).map_err(|_| TransportErrorCode::InternalError)
}

fn success(version: ProtocolVersion, id: u64, result: serde_json::Value) -> ResponseEnvelope {
    ResponseEnvelope {
        version,
        kind: EnvelopeKind::Response,
        id,
        result: Some(result),
        error: None,
    }
}

fn failed(version: ProtocolVersion, id: u64, code: TransportErrorCode) -> Dispatch {
    Dispatch {
        response: error_response(version, id, code),
        subscription: None,
        stop_after_flush: false,
        release_snapshot: None,
    }
}

fn failed_for_method(
    version: ProtocolVersion,
    id: u64,
    method: &Method,
    code: TransportErrorCode,
) -> Dispatch {
    if method == &Method::SessionCreate {
        failed_effect(
            version,
            id,
            EffectFailure {
                code,
                effect: EffectClassification::NoEffect,
                request_id: None,
                handle: None,
            },
        )
    } else {
        failed(version, id, code)
    }
}

fn failed_effect(version: ProtocolVersion, id: u64, error: EffectFailure) -> Dispatch {
    Dispatch {
        response: error_response_with_effect(
            version,
            id,
            error.code,
            Some(error.effect),
            error.request_id,
            error.handle,
        ),
        subscription: None,
        stop_after_flush: false,
        release_snapshot: None,
    }
}

fn ipc_error_code(error: IpcError) -> TransportErrorCode {
    match error {
        IpcError::UnsupportedVersion => TransportErrorCode::UnsupportedVersion,
        IpcError::InvalidKind => TransportErrorCode::InvalidKind,
        IpcError::InvalidProtocolRange | IpcError::InvalidRequest | IpcError::InvalidResponse => {
            TransportErrorCode::InvalidRequest
        }
    }
}

fn map_runtime_error(error: PtyRuntimeError) -> TransportErrorCode {
    match error {
        PtyRuntimeError::InvalidRequest
        | PtyRuntimeError::StaleAttachment
        | PtyRuntimeError::InvalidAcknowledgement => TransportErrorCode::InvalidRequest,
        PtyRuntimeError::SessionNotFound => TransportErrorCode::TerminalNotFound,
        PtyRuntimeError::SpawnFailed => TransportErrorCode::SpawnFailed,
        PtyRuntimeError::RegistryFull
        | PtyRuntimeError::AttachmentLimit
        | PtyRuntimeError::QueueFull => TransportErrorCode::RuntimeBusy,
        PtyRuntimeError::Catalog(CatalogError::RequestConflict) => {
            TransportErrorCode::RequestConflict
        }
        PtyRuntimeError::Catalog(CatalogError::TerminalNotFound) => {
            TransportErrorCode::TerminalNotFound
        }
        PtyRuntimeError::Catalog(CatalogError::StalePresentation) => {
            TransportErrorCode::StalePresentation
        }
        PtyRuntimeError::Catalog(CatalogError::QueueFull | CatalogError::Timeout) => {
            TransportErrorCode::RuntimeBusy
        }
        PtyRuntimeError::InvalidConfiguration
        | PtyRuntimeError::Io
        | PtyRuntimeError::Catalog(_) => TransportErrorCode::InternalError,
    }
}

fn map_prepare_error(error: PrepareError) -> TransportErrorCode {
    match error {
        PrepareError::Unavailable => TransportErrorCode::AppUnavailable,
        PrepareError::SurfaceFailed => TransportErrorCode::SurfaceFailed,
    }
}

fn event_envelope<T: Serialize>(
    version: ProtocolVersion,
    event: EventName,
    payload: T,
) -> EventEnvelope {
    EventEnvelope {
        version,
        kind: EnvelopeKind::Event,
        event,
        payload: serde_json::to_value(payload).unwrap_or(serde_json::Value::Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use terminal_host_core::{PtyRuntimeConfig, RuntimeIdentity};
    use terminal_host_protocol::{
        ExitBehavior, Placement, Presentation, SessionCreateRequest, SessionCreateResponse,
        SessionGetRequest, SessionSelector, PROTOCOL_VERSION,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn endpoint() -> crate::bootstrap::RuntimeEndpoint {
        crate::bootstrap::RuntimeEndpoint {
            schema_version: crate::bootstrap::ENDPOINT_SCHEMA_VERSION,
            protocol_min: PROTOCOL_VERSION,
            protocol_max: PROTOCOL_VERSION,
            runtime_id: "runtime".into(),
            pid: 42,
            process_start_time: "123".into(),
            pipe_name: r"\\.\pipe\ThreadTerm.TerminalHost.pty-test".into(),
            daemon_version: "test".into(),
            launch_nonce: "nonce".into(),
            owner_generation: 1,
        }
    }

    fn service() -> (tempfile::TempDir, TerminalHostService, Arc<DaemonPtyEngine>) {
        let temp = tempfile::tempdir().unwrap();
        let (engine, reconciliation) = DaemonPtyEngine::open(
            temp.path().join("runtime.sqlite"),
            RuntimeIdentity {
                runtime_id: "runtime".into(),
                launch_nonce: "nonce".into(),
            },
            PtyRuntimeConfig::default(),
        )
        .unwrap();
        let mut endpoint = endpoint();
        endpoint.owner_generation = reconciliation.generation;
        let engine = Arc::new(engine);
        let service = TerminalHostService {
            endpoint,
            secret: crate::bootstrap::Secret::from_bytes([7; 32]),
            catalog: None,
            engine: Some(Arc::clone(&engine)),
            control: Arc::new(RuntimeControl::new()),
            limits: super::super::ServiceLimits::default(),
            preauth: Arc::new(tokio::sync::Semaphore::new(16)),
            connections: Arc::new(tokio::sync::Semaphore::new(64)),
        };
        (temp, service, engine)
    }

    fn create_request(request_id: &str, cwd: &str) -> SessionCreateRequest {
        SessionCreateRequest {
            request_id: request_id.into(),
            executable: "cmd.exe".into(),
            args: vec!["/D".into(), "/Q".into(), "/K".into()],
            cwd: cwd.into(),
            title: Some(" Phase 3 ".into()),
            placement: Placement::Workspace,
            presentation: Presentation::Background,
            exit_behavior: ExitBehavior::Keep,
            rows: 24,
            cols: 80,
        }
    }

    fn dispatch<T: Serialize>(
        service: &TerminalHostService,
        engine: &DaemonPtyEngine,
        deliveries: &Arc<Mutex<HashMap<String, DeliveryState>>>,
        client: ClientClass,
        id: u64,
        method: Method,
        params: T,
    ) -> Dispatch {
        let (high, _high_rx) = mpsc::channel(8);
        dispatch_for(
            service,
            engine,
            deliveries,
            "connection-a",
            client,
            id,
            method,
            params,
            &high,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn dispatch_for<T: Serialize>(
        service: &TerminalHostService,
        engine: &DaemonPtyEngine,
        deliveries: &Arc<Mutex<HashMap<String, DeliveryState>>>,
        connection_id: &str,
        client: ClientClass,
        id: u64,
        method: Method,
        params: T,
        high: &mpsc::Sender<HighFrame>,
    ) -> Dispatch {
        let request = RequestEnvelope {
            version: PROTOCOL_VERSION,
            kind: EnvelopeKind::Request,
            id,
            method,
            params: serde_json::to_value(params).unwrap(),
        };
        dispatch_request(
            service,
            engine,
            PROTOCOL_VERSION,
            &serde_json::to_vec(&request).unwrap(),
            DispatchClient {
                connection_id,
                client_class: &client,
                deliveries,
                high,
            },
        )
    }

    async fn read_wire(stream: &mut tokio::io::DuplexStream) -> serde_json::Value {
        let length = stream.read_u32_le().await.unwrap() as usize;
        let mut body = vec![0; length];
        stream.read_exact(&mut body).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    async fn send_wire<T: Serialize>(stream: &mut tokio::io::DuplexStream, value: &T) {
        let body = serde_json::to_vec(value).unwrap();
        stream.write_u32_le(body.len() as u32).await.unwrap();
        stream.write_all(&body).await.unwrap();
    }

    #[test]
    fn create_digest_covers_every_spawn_field_and_excludes_request_id() {
        let (temp, service, _) = service();
        let cwd = temp.path().to_string_lossy();
        let baseline_request = create_request("consumer:a", &cwd);
        let first = normalize_create_request(&service, baseline_request.clone()).unwrap();
        let mut request_id_only = baseline_request.clone();
        request_id_only.request_id = "consumer:b".into();
        assert_eq!(
            first.digest,
            normalize_create_request(&service, request_id_only)
                .unwrap()
                .digest
        );

        let other_cwd = temp.path().join("other");
        std::fs::create_dir(&other_cwd).unwrap();
        let mut variants = Vec::new();
        let mut changed = baseline_request.clone();
        changed.executable = "other.exe".into();
        variants.push(("executable", changed));
        let mut changed = baseline_request.clone();
        changed.args[0] = "/C".into();
        variants.push(("argument content", changed));
        let mut changed = baseline_request.clone();
        changed.args.swap(0, 1);
        variants.push(("argument order", changed));
        let mut changed = baseline_request.clone();
        changed.args.push("extra".into());
        variants.push(("argument count", changed));
        let mut changed = baseline_request.clone();
        changed.cwd = other_cwd.to_string_lossy().into_owned();
        variants.push(("canonical cwd", changed));
        let mut changed = baseline_request.clone();
        changed.title = None;
        variants.push(("title presence", changed));
        let mut changed = baseline_request.clone();
        changed.title = Some("different".into());
        variants.push(("title content", changed));
        let mut changed = baseline_request.clone();
        changed.rows += 1;
        variants.push(("rows", changed));
        let mut changed = baseline_request.clone();
        changed.cols += 1;
        variants.push(("cols", changed));
        let mut changed = baseline_request.clone();
        changed.placement = Placement::Window;
        variants.push(("placement", changed));
        let mut changed = baseline_request.clone();
        changed.presentation = Presentation::Focused;
        variants.push(("presentation", changed));
        let mut changed = baseline_request.clone();
        changed.exit_behavior = ExitBehavior::CloseOnExit;
        variants.push(("exit behavior", changed));

        for (field, changed) in variants {
            let digest = normalize_create_request(&service, changed).unwrap().digest;
            assert_ne!(first.digest, digest, "digest omitted {field}");
        }
        assert_eq!(
            first.target,
            PresentationTarget::Workspace {
                normalized_path: std::fs::canonicalize(temp.path())
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            }
        );
    }

    #[test]
    fn create_digest_normalizes_absent_and_blank_titles_equally() {
        let (temp, service, _) = service();
        let cwd = temp.path().to_string_lossy();
        let mut absent = create_request("consumer:a", &cwd);
        absent.title = None;
        let mut empty = absent.clone();
        empty.title = Some(String::new());
        let mut whitespace = absent.clone();
        whitespace.title = Some("   ".into());
        let absent = normalize_create_request(&service, absent).unwrap();
        let empty = normalize_create_request(&service, empty).unwrap();
        let whitespace = normalize_create_request(&service, whitespace).unwrap();
        assert_eq!(absent.digest, empty.digest);
        assert_eq!(absent.digest, whitespace.digest);
        assert_eq!(absent.title, None);
        assert_eq!(empty.title, None);
        assert_eq!(whitespace.title, None);
    }

    #[test]
    fn collected_lookup_maps_to_terminal_not_found() {
        let lookup = CatalogLookup::Collected(terminal_host_core::DurableClaim {
            request_id: "consumer:collected".into(),
            digest: RequestDigest::new([1; 32]),
            handle: "collected-handle".into(),
            created_at_ms: 1,
        });
        assert_eq!(
            lookup_record(lookup),
            Err(TransportErrorCode::TerminalNotFound)
        );
    }

    #[test]
    fn close_only_succeeds_after_exit_is_proven() {
        assert!(close_outcome_result(CloseOutcome::Exited).is_ok());
        assert_eq!(
            close_outcome_result(CloseOutcome::Pending),
            Err(TransportErrorCode::RuntimeBusy)
        );
    }

    #[test]
    fn connection_guard_owns_attachments_and_desktop_registration_is_class_gated() {
        let (_temp, service, engine) = service();
        assert!(!service
            .capabilities(&ClientClass::McpBridge)
            .contains(&"desktop.register".to_owned()));
        assert!(service
            .capabilities(&ClientClass::Desktop)
            .contains(&"desktop.register".to_owned()));
        let deliveries = Arc::new(Mutex::new(HashMap::new()));
        let (desktop_high, _desktop_events) = mpsc::channel(8);
        let denied = dispatch(
            &service,
            &engine,
            &deliveries,
            ClientClass::McpBridge,
            1,
            Method::DesktopRegister,
            terminal_host_protocol::DesktopRegisterRequest {
                surface_protocol_version: terminal_host_protocol::SURFACE_PRESENTATION_V1.into(),
                placements: vec![Placement::Workspace, Placement::Window],
                background_presentation: true,
            },
        );
        assert_eq!(
            denied.response.error.unwrap().code,
            TransportErrorCode::InvalidRequest
        );
        let allowed = dispatch_for(
            &service,
            &engine,
            &deliveries,
            "connection-a",
            ClientClass::Desktop,
            2,
            Method::DesktopRegister,
            terminal_host_protocol::DesktopRegisterRequest {
                surface_protocol_version: terminal_host_protocol::SURFACE_PRESENTATION_V1.into(),
                placements: vec![Placement::Workspace, Placement::Window],
                background_presentation: true,
            },
            &desktop_high,
        );
        assert!(allowed.response.error.is_none());
        assert!(service
            .control
            .presentation
            .is_available(&Placement::Window, &Presentation::Background));

        let mut guard = service.control.connect();
        guard.authenticated("connection-b".into(), Arc::clone(&engine));
        assert_eq!(service.connected_client_count(), 1);
        drop(guard);
        assert_eq!(service.connected_client_count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn create_without_registered_desktop_is_no_effect_and_does_not_spawn() {
        let (temp, service, engine) = service();
        let deliveries = Arc::new(Mutex::new(HashMap::new()));
        let request_id = "consumer:no-desktop";
        let response = dispatch(
            &service,
            &engine,
            &deliveries,
            ClientClass::McpBridge,
            1,
            Method::SessionCreate,
            create_request(request_id, &temp.path().to_string_lossy()),
        )
        .response;
        let error = response.error.unwrap();
        assert_eq!(error.code, TransportErrorCode::AppUnavailable);
        assert_eq!(error.effect, Some(EffectClassification::NoEffect));
        assert_eq!(error.request_id.as_deref(), Some(request_id));
        assert!(error.handle.is_none());
        assert_eq!(engine.session_count(), 0);
        assert!(!matches!(
            engine.lookup(CatalogSelector::RequestId(request_id.into())),
            Ok(CatalogLookup::ActiveOrTombstone { .. })
        ));
    }

    #[test]
    fn malformed_create_is_strict_no_effect_and_does_not_spawn() {
        let (_temp, service, engine) = service();
        let deliveries = Arc::new(Mutex::new(HashMap::new()));
        let (high, _events) = mpsc::channel(8);
        let request = RequestEnvelope {
            version: PROTOCOL_VERSION,
            kind: EnvelopeKind::Request,
            id: 17,
            method: Method::SessionCreate,
            params: serde_json::json!({
                "request_id": "consumer:malformed",
                "executable": "cmd.exe",
                "args": [],
                "cwd": ".",
                "placement": "window",
                "presentation": "focused",
                "exit_behavior": "keep",
                "rows": 24,
                "cols": 80,
                "unexpected": true
            }),
        };
        let response = dispatch_request(
            &service,
            &engine,
            PROTOCOL_VERSION,
            &serde_json::to_vec(&request).unwrap(),
            DispatchClient {
                connection_id: "connection-mcp",
                client_class: &ClientClass::McpBridge,
                deliveries: &deliveries,
                high: &high,
            },
        )
        .response;
        let error = response.error.unwrap();
        assert_eq!(error.code, TransportErrorCode::InvalidRequest);
        assert_eq!(error.effect, Some(EffectClassification::NoEffect));
        assert!(error.request_id.is_none());
        assert!(error.handle.is_none());
        assert!(error.validate().is_ok());
        assert_eq!(engine.session_count(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn timed_out_presentation_reclaims_its_reserved_attachment() {
        let (temp, service, engine) = service();
        let normalized = normalize_create_request(
            &service,
            create_request("consumer:timeout-cleanup", &temp.path().to_string_lossy()),
        )
        .unwrap();
        let created = engine.create(normalized).unwrap();
        let record = engine
            .authoritative_lookup(&created.identity.handle)
            .unwrap();
        let deliveries = Arc::new(Mutex::new(HashMap::new()));
        let (desktop_high, mut desktop_events) = mpsc::channel(8);
        service
            .control
            .presentation
            .register(
                "desktop-timeout".into(),
                terminal_host_protocol::DesktopRegisterRequest {
                    surface_protocol_version: terminal_host_protocol::SURFACE_PRESENTATION_V1
                        .into(),
                    placements: vec![Placement::Workspace, Placement::Window],
                    background_presentation: true,
                },
                desktop_high.clone(),
                Arc::clone(&deliveries),
            )
            .unwrap();
        let attempt = service
            .control
            .presentation
            .prepare(
                &engine,
                PROTOCOL_VERSION,
                SurfacePresentRequestedEvent {
                    handle: record.handle.clone(),
                    revision: record.revision,
                    placement: record.placement,
                    workspace_target: record.workspace_target,
                    presentation: record.presentation,
                },
            )
            .unwrap();
        assert!(matches!(
            desktop_events.blocking_recv(),
            Some(HighFrame::Event(_))
        ));
        let mut attached = dispatch_for(
            &service,
            &engine,
            &deliveries,
            "desktop-timeout",
            ClientClass::Desktop,
            18,
            Method::SessionAttach,
            terminal_host_protocol::SessionAttachRequest {
                handle: created.identity.handle.clone(),
            },
            &desktop_high,
        );
        let attached: SessionAttachResponse =
            serde_json::from_value(attached.response.result.take().unwrap()).unwrap();
        assert_eq!(deliveries.lock().unwrap().len(), 1);
        assert!(!attempt.wait(Duration::ZERO));
        service.control.presentation.finish_wait(&engine, &attempt);
        assert!(deliveries.lock().unwrap().is_empty());
        assert!(!engine
            .detach(&attached.attach_id, &attached.stream_id)
            .unwrap());
        engine
            .close(
                &created.identity.handle,
                CoreCloseMode::Force {
                    timeout: CLOSE_TIMEOUT,
                },
            )
            .unwrap();
    }

    #[tokio::test]
    async fn snapshot_response_is_queued_before_epoch_release_and_low_output() {
        let deliveries = Arc::new(Mutex::new(HashMap::from([(
            "attach".into(),
            DeliveryState {
                epoch: 9,
                dirty: true,
                snapshot_pending: true,
                ..DeliveryState::default()
            },
        )])));
        let (high_tx, mut high_rx) = mpsc::channel(1);
        let response = success(PROTOCOL_VERSION, 7, serde_json::json!({}));
        enqueue_response_then_release(
            &high_tx,
            HighFrame::Response(response, None),
            Some(("attach".into(), 9)),
            &deliveries,
        )
        .unwrap();
        assert!(matches!(high_rx.try_recv(), Ok(HighFrame::Response(_, _))));
        let states = deliveries.lock().unwrap();
        let state = states.get("attach").unwrap();
        assert!(!state.snapshot_pending);
        assert!(!state.dirty);
    }

    #[tokio::test]
    async fn writer_advances_only_written_watermark_and_resync_reports_it() {
        let deliveries = Arc::new(Mutex::new(HashMap::from([(
            "attach".into(),
            DeliveryState {
                epoch: 1,
                ..DeliveryState::default()
            },
        )])));
        let (high_tx, mut high_rx) = mpsc::channel(4);
        let (low_tx, mut low_rx) = mpsc::channel(4);
        let (_cancel_tx, mut cancel_rx) = watch::channel(false);
        low_tx
            .send(OutputFrame {
                attach_id: "attach".into(),
                epoch: 1,
                seq: 4,
                event: event_envelope(
                    PROTOCOL_VERSION,
                    EventName::SessionOutput,
                    SessionOutputEvent {
                        runtime_id: "runtime".into(),
                        handle: "handle".into(),
                        stream_id: "stream".into(),
                        attach_id: "attach".into(),
                        seq: 4,
                        data_base64: BASE64.encode(b"written"),
                    },
                ),
            })
            .await
            .unwrap();
        assert_eq!(deliveries.lock().unwrap()["attach"].last_delivered_seq, 0);
        drop(high_tx);
        drop(low_tx);
        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        writer_loop(
            &mut server,
            &mut high_rx,
            &mut low_rx,
            &mut cancel_rx,
            &deliveries,
        )
        .await
        .unwrap();
        let output = read_wire(&mut client).await;
        assert_eq!(output["event"], "session.output");
        assert_eq!(deliveries.lock().unwrap()["attach"].last_delivered_seq, 4);

        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        let (_low_tx, mut low_rx) = mpsc::channel(1);
        write_high(
            &mut server,
            HighFrame::Resync {
                version: PROTOCOL_VERSION,
                identity: terminal_host_core::StreamIdentity {
                    runtime_id: "runtime".into(),
                    handle: "handle".into(),
                    stream_id: "stream".into(),
                },
                attach_id: "attach".into(),
                current_seq: 9,
                reason: ResyncReason::QueueOverflow,
            },
            &mut low_rx,
            &deliveries,
        )
        .await
        .unwrap();
        let resync = read_wire(&mut client).await;
        assert_eq!(resync["payload"]["last_delivered_seq"], 4);
        assert_eq!(resync["payload"]["current_seq"], 9);
    }

    #[tokio::test]
    async fn writer_serializes_exit_control_and_retained_tail_output() {
        let deliveries = Arc::new(Mutex::new(HashMap::from([(
            "attach".into(),
            DeliveryState {
                epoch: 1,
                last_queued_seq: 5,
                exit_behavior: ExitBehavior::CloseOnExit,
                ..DeliveryState::default()
            },
        )])));
        let (high_tx, mut high_rx) = mpsc::channel(2);
        let (low_tx, mut low_rx) = mpsc::channel(2);
        let (_cancel_tx, mut cancel_rx) = watch::channel(false);
        high_tx
            .send(HighFrame::Exit {
                attach_id: "attach".into(),
                epoch: 1,
                through_seq: 5,
                event: event_envelope(
                    PROTOCOL_VERSION,
                    EventName::SessionExit,
                    SessionExitEvent {
                        runtime_id: "runtime".into(),
                        handle: "handle".into(),
                        stream_id: "stream".into(),
                        revision: 2,
                        exit_code: Some(0),
                        exit_behavior: ExitBehavior::CloseOnExit,
                    },
                ),
            })
            .await
            .unwrap();
        low_tx
            .send(OutputFrame {
                attach_id: "attach".into(),
                epoch: 1,
                seq: 5,
                event: event_envelope(
                    PROTOCOL_VERSION,
                    EventName::SessionOutput,
                    SessionOutputEvent {
                        runtime_id: "runtime".into(),
                        handle: "handle".into(),
                        stream_id: "stream".into(),
                        attach_id: "attach".into(),
                        seq: 5,
                        data_base64: BASE64.encode(b"tail"),
                    },
                ),
            })
            .await
            .unwrap();
        drop(high_tx);
        drop(low_tx);
        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        writer_loop(
            &mut server,
            &mut high_rx,
            &mut low_rx,
            &mut cancel_rx,
            &deliveries,
        )
        .await
        .unwrap();
        assert_eq!(read_wire(&mut client).await["event"], "session.output");
        let exit = read_wire(&mut client).await;
        assert_eq!(exit["event"], "session.exit");
        assert_eq!(exit["payload"]["exit_behavior"], "close-on-exit");
    }

    #[test]
    fn exit_barrier_waits_for_resync_snapshot_ack_before_releasing_exit() {
        let deliveries = Arc::new(Mutex::new(HashMap::from([(
            "attach".into(),
            DeliveryState {
                epoch: 2,
                dirty: true,
                snapshot_pending: true,
                snapshot_ack_pending: Some(9),
                minimum_seq: 9,
                last_queued_seq: 9,
                last_delivered_seq: 9,
                exit_behavior: ExitBehavior::CloseOnExit,
                ..DeliveryState::default()
            },
        )])));

        assert!(matches!(
            exit_barrier(&deliveries, "attach"),
            Some(ExitBarrier::Pending)
        ));
        {
            let mut states = deliveries.lock().unwrap();
            let state = states.get_mut("attach").unwrap();
            state.snapshot_pending = false;
            state.dirty = false;
        }
        assert!(matches!(
            exit_barrier(&deliveries, "attach"),
            Some(ExitBarrier::Pending)
        ));
        record_delivery_ack(&deliveries, "attach", 8).unwrap();
        assert!(matches!(
            exit_barrier(&deliveries, "attach"),
            Some(ExitBarrier::Pending)
        ));
        record_delivery_ack(&deliveries, "attach", 9).unwrap();
        assert!(matches!(
            exit_barrier(&deliveries, "attach"),
            Some(ExitBarrier::Ready {
                epoch: 2,
                through_seq: 9,
                exit_behavior: ExitBehavior::CloseOnExit,
            })
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn authenticated_output_only_connection_has_no_five_second_idle_timeout() {
        let (_temp, service, _) = service();
        let (mut client, mut server) = tokio::io::duplex(128 * 1024);
        let secret = service.secret.encoded();
        let task = tokio::spawn(async move { service.serve_stream(&mut server).await });
        send_wire(
            &mut client,
            &RequestEnvelope {
                version: PROTOCOL_VERSION,
                kind: EnvelopeKind::Request,
                id: 1,
                method: Method::Hello,
                params: serde_json::to_value(terminal_host_protocol::HelloRequest {
                    protocol: terminal_host_protocol::ProtocolRange {
                        min: PROTOCOL_VERSION,
                        max: PROTOCOL_VERSION,
                    },
                    client: ClientClass::Desktop,
                    capabilities: vec![],
                    secret,
                })
                .unwrap(),
            },
        )
        .await;
        let _ = read_wire(&mut client).await;
        tokio::time::advance(Duration::from_secs(6)).await;
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        drop(client);
        assert_eq!(task.await.unwrap(), Ok(()));
    }

    #[tokio::test]
    async fn high_queue_overflow_signals_connection_cancellation() {
        let (high_tx, _high_rx) = mpsc::channel(1);
        let cancelled = AtomicBool::new(false);
        let (cancel, cancel_rx) = watch::channel(false);
        high_tx
            .try_send(HighFrame::Event(event_envelope(
                PROTOCOL_VERSION,
                EventName::SessionState,
                SessionStateEvent {
                    runtime_id: "runtime".into(),
                    handle: "handle".into(),
                    stream_id: "stream".into(),
                    state: SessionState::Running,
                    revision: 1,
                },
            )))
            .unwrap();
        send_control(
            &high_tx,
            &cancelled,
            &cancel,
            event_envelope(
                PROTOCOL_VERSION,
                EventName::SessionState,
                SessionStateEvent {
                    runtime_id: "runtime".into(),
                    handle: "handle".into(),
                    stream_id: "stream".into(),
                    state: SessionState::Exited,
                    revision: 2,
                },
            ),
        );
        assert!(cancelled.load(Ordering::Acquire));
        assert!(*cancel_rx.borrow());
    }

    #[tokio::test]
    async fn completed_event_tasks_are_reaped_on_the_next_attach() {
        let tasks = Arc::new(Mutex::new(Vec::new()));
        let completed = tokio::spawn(async {});
        while !completed.is_finished() {
            tokio::task::yield_now().await;
        }
        tasks.lock().unwrap().push(completed);

        let (release, wait) = oneshot::channel::<()>();
        let active = tokio::spawn(async move {
            let _ = wait.await;
        });
        track_event_task(&tasks, active).unwrap();
        assert_eq!(tasks.lock().unwrap().len(), 1);
        let _ = release.send(());
        let task = tasks.lock().unwrap().pop().unwrap();
        task.await.unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn typed_create_get_attach_input_resync_and_stop_mapping_uses_real_conpty() {
        let (temp, service, engine) = service();
        let deliveries = Arc::new(Mutex::new(HashMap::new()));
        let cwd = temp.path().to_string_lossy();
        let (desktop_high, mut desktop_events) = mpsc::channel(8);
        let registered = dispatch_for(
            &service,
            &engine,
            &deliveries,
            "connection-a",
            ClientClass::Desktop,
            0,
            Method::DesktopRegister,
            terminal_host_protocol::DesktopRegisterRequest {
                surface_protocol_version: terminal_host_protocol::SURFACE_PRESENTATION_V1.into(),
                placements: vec![Placement::Workspace, Placement::Window],
                background_presentation: true,
            },
            &desktop_high,
        );
        assert!(registered.response.error.is_none());
        let (mcp_high, _mcp_events) = mpsc::channel(8);
        let (created, mut active_surface) = std::thread::scope(|scope| {
            let create = scope.spawn(|| {
                dispatch_for(
                    &service,
                    &engine,
                    &Arc::new(Mutex::new(HashMap::new())),
                    "connection-mcp",
                    ClientClass::McpBridge,
                    1,
                    Method::SessionCreate,
                    create_request("consumer:real", &cwd),
                    &mcp_high,
                )
            });
            let HighFrame::Event(event) = desktop_events.blocking_recv().unwrap() else {
                panic!("expected surface presentation event")
            };
            let requested = match event.decode_payload().unwrap() {
                terminal_host_protocol::EventPayload::SurfacePresentRequested(requested) => {
                    requested
                }
                _ => panic!("expected surface presentation payload"),
            };
            let mut surface_attach = dispatch_for(
                &service,
                &engine,
                &deliveries,
                "connection-a",
                ClientClass::Desktop,
                10,
                Method::SessionAttach,
                terminal_host_protocol::SessionAttachRequest {
                    handle: requested.handle.clone(),
                },
                &desktop_high,
            );
            let attached: SessionAttachResponse =
                serde_json::from_value(surface_attach.response.result.take().unwrap()).unwrap();
            let ready = dispatch_for(
                &service,
                &engine,
                &deliveries,
                "connection-a",
                ClientClass::Desktop,
                11,
                Method::SurfaceReady,
                terminal_host_protocol::SurfaceReadyRequest {
                    handle: requested.handle,
                    revision: requested.revision,
                    attach_id: attached.attach_id.clone(),
                    stream_id: attached.stream_id.clone(),
                },
                &desktop_high,
            );
            assert!(ready.response.error.is_none());
            (create.join().unwrap(), attached)
        });
        let created: SessionCreateResponse =
            serde_json::from_value(created.response.result.unwrap()).unwrap();
        assert_eq!(created.disposition, CreateDisposition::Created);
        let record = created.session;
        assert_eq!(record.state, SessionState::Running);
        let reused = dispatch_for(
            &service,
            &engine,
            &Arc::new(Mutex::new(HashMap::new())),
            "connection-mcp",
            ClientClass::McpBridge,
            9,
            Method::SessionCreate,
            create_request("consumer:real", &cwd),
            &mcp_high,
        );
        let reused: SessionCreateResponse =
            serde_json::from_value(reused.response.result.unwrap()).unwrap();
        assert_eq!(reused.disposition, CreateDisposition::Reused);
        assert_eq!(reused.session.handle, record.handle);
        let mut revision = reused.session.revision;
        for iteration in 0..20 {
            let placement = if iteration % 2 == 0 {
                Placement::Window
            } else {
                Placement::Workspace
            };
            let workspace_target = (placement == Placement::Workspace)
                .then(|| temp.path().to_string_lossy().into_owned());
            let (presented, next_surface) = std::thread::scope(|scope| {
                let present = scope.spawn(|| {
                    dispatch_for(
                        &service,
                        &engine,
                        &Arc::new(Mutex::new(HashMap::new())),
                        "connection-mcp",
                        ClientClass::McpBridge,
                        100 + iteration * 3,
                        Method::SessionPresent,
                        SessionPresentRequest {
                            handle: record.handle.clone(),
                            placement,
                            workspace_target,
                            presentation: Presentation::Background,
                        },
                        &mcp_high,
                    )
                });
                let HighFrame::Event(event) = desktop_events.blocking_recv().unwrap() else {
                    panic!("expected transfer presentation event")
                };
                let requested = match event.decode_payload().unwrap() {
                    terminal_host_protocol::EventPayload::SurfacePresentRequested(requested) => {
                        requested
                    }
                    _ => panic!("expected transfer presentation payload"),
                };
                let mut next_attach = dispatch_for(
                    &service,
                    &engine,
                    &deliveries,
                    "connection-a",
                    ClientClass::Desktop,
                    101 + iteration * 3,
                    Method::SessionAttach,
                    terminal_host_protocol::SessionAttachRequest {
                        handle: requested.handle.clone(),
                    },
                    &desktop_high,
                );
                let attached: SessionAttachResponse =
                    serde_json::from_value(next_attach.response.result.take().unwrap()).unwrap();
                let ready = dispatch_for(
                    &service,
                    &engine,
                    &deliveries,
                    "connection-a",
                    ClientClass::Desktop,
                    102 + iteration * 3,
                    Method::SurfaceReady,
                    SurfaceReadyRequest {
                        handle: requested.handle,
                        revision: requested.revision,
                        attach_id: attached.attach_id.clone(),
                        stream_id: attached.stream_id.clone(),
                    },
                    &desktop_high,
                );
                assert!(ready.response.error.is_none());
                (present.join().unwrap(), attached)
            });
            let presented: SessionRecord =
                serde_json::from_value(presented.response.result.unwrap()).unwrap();
            assert!(presented.revision > revision);
            revision = presented.revision;
            active_surface = next_surface;
            assert_eq!(deliveries.lock().unwrap().len(), 1);
        }
        let stale_ready = dispatch_for(
            &service,
            &engine,
            &deliveries,
            "connection-a",
            ClientClass::Desktop,
            500,
            Method::SurfaceReady,
            SurfaceReadyRequest {
                handle: record.handle.clone(),
                revision: revision - 1,
                attach_id: active_surface.attach_id.clone(),
                stream_id: active_surface.stream_id.clone(),
            },
            &desktop_high,
        );
        assert_eq!(
            stale_ready.response.error.unwrap().code,
            TransportErrorCode::StalePresentation
        );
        let hidden = dispatch_for(
            &service,
            &engine,
            &deliveries,
            "connection-a",
            ClientClass::Desktop,
            501,
            Method::SurfaceHidden,
            SurfaceHiddenRequest {
                handle: record.handle.clone(),
                revision,
                attach_id: active_surface.attach_id,
                stream_id: active_surface.stream_id,
            },
            &desktop_high,
        );
        let hidden: SessionRecord =
            serde_json::from_value(hidden.response.result.unwrap()).unwrap();
        assert!(hidden.surface_hidden);
        assert_eq!(engine.session_count(), 1);
        assert!(deliveries.lock().unwrap().is_empty());
        let fetched = dispatch(
            &service,
            &engine,
            &deliveries,
            ClientClass::Desktop,
            2,
            Method::SessionGet,
            SessionGetRequest {
                selector: SessionSelector {
                    handle: None,
                    request_id: Some("consumer:real".into()),
                },
            },
        );
        let fetched: SessionRecord =
            serde_json::from_value(fetched.response.result.unwrap()).unwrap();
        assert_eq!(fetched.handle, record.handle);

        let mut attached = dispatch(
            &service,
            &engine,
            &deliveries,
            ClientClass::Desktop,
            3,
            Method::SessionAttach,
            terminal_host_protocol::SessionAttachRequest {
                handle: record.handle.clone(),
            },
        );
        let attach: SessionAttachResponse =
            serde_json::from_value(attached.response.result.take().unwrap()).unwrap();
        let subscription = attached.subscription.take().unwrap();
        let input = dispatch(
            &service,
            &engine,
            &deliveries,
            ClientClass::Desktop,
            4,
            Method::SessionInput,
            terminal_host_protocol::SessionInputRequest {
                attach_id: attach.attach_id.clone(),
                stream_id: attach.stream_id.clone(),
                data_base64: BASE64.encode(b"echo PHASE3_SERVICE_SENTINEL\r\n"),
            },
        );
        assert!(input.response.error.is_none());
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut observed = false;
        let mut observed_seq = attach.barrier_seq;
        while std::time::Instant::now() < deadline {
            if let Some(RuntimeEvent::Output { bytes, seq, .. }) =
                subscription.recv_timeout(Duration::from_millis(100))
            {
                observed |= String::from_utf8_lossy(&bytes).contains("PHASE3_SERVICE_SENTINEL");
                observed_seq = seq;
                if observed {
                    break;
                }
            }
        }
        assert!(observed);
        let acknowledged = dispatch(
            &service,
            &engine,
            &deliveries,
            ClientClass::Desktop,
            5,
            Method::SessionAck,
            terminal_host_protocol::SessionAckRequest {
                attach_id: attach.attach_id.clone(),
                stream_id: attach.stream_id.clone(),
                through_seq: observed_seq,
            },
        );
        assert!(acknowledged.response.error.is_none());
        let resized = dispatch(
            &service,
            &engine,
            &deliveries,
            ClientClass::Desktop,
            6,
            Method::SessionResize,
            terminal_host_protocol::SessionResizeRequest {
                attach_id: attach.attach_id.clone(),
                stream_id: attach.stream_id.clone(),
                rows: 30,
                cols: 100,
            },
        );
        assert!(resized.response.error.is_none());

        let resynced = dispatch(
            &service,
            &engine,
            &deliveries,
            ClientClass::Desktop,
            7,
            Method::SessionResync,
            terminal_host_protocol::SessionResyncRequest {
                attach_id: attach.attach_id.clone(),
                stream_id: attach.stream_id.clone(),
            },
        );
        assert!(resynced.response.error.is_none());
        let cancelled = AtomicBool::new(true);
        cleanup_cancelled_dispatch(&cancelled, &engine, "connection-a");
        assert!(matches!(
            engine.input(&attach.attach_id, &attach.stream_id, vec![b'x']),
            Err(PtyRuntimeError::StaleAttachment)
        ));
        assert_eq!(
            stop_runtime(&engine, false),
            Err(TransportErrorCode::RuntimeBusy)
        );
        assert_eq!(stop_runtime(&engine, true), Ok(()));
        assert_eq!(engine.session_count(), 0);
    }
}

use crate::{is_valid_request_id, ProtocolVersion, SessionSelector};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use std::{error::Error, fmt};

pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion { major: 1, minor: 0 };
pub const MAX_HELLO_CAPABILITIES: usize = 64;
pub const MAX_CAPABILITY_BYTES: usize = 128;
pub const MAX_IDENTITY_BYTES: usize = 128;
pub const MAX_COMMAND_BYTES: usize = 32 * 1024;
pub const MAX_ARGUMENTS: usize = 256;
pub const MAX_TITLE_BYTES: usize = 1024;
pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SESSION_LIST_ENTRIES: usize = 4096;
pub const SURFACE_PRESENTATION_V1: &str = "surface-presentation/v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolRange {
    pub min: ProtocolVersion,
    pub max: ProtocolVersion,
}
impl ProtocolRange {
    pub fn validate(&self) -> Result<(), IpcError> {
        (self.min.major == self.max.major && self.min.minor <= self.max.minor)
            .then_some(())
            .ok_or(IpcError::InvalidProtocolRange)
    }
    pub fn negotiate(&self, peer: &Self) -> Option<ProtocolVersion> {
        self.validate().ok()?;
        peer.validate().ok()?;
        if self.min.major != peer.min.major
            || self.max.major != self.min.major
            || peer.max.major != peer.min.major
        {
            return None;
        }
        let min = self.min.minor.max(peer.min.minor);
        let max = self.max.minor.min(peer.max.minor);
        (min <= max).then_some(ProtocolVersion {
            major: self.min.major,
            minor: max,
        })
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClientClass {
    Desktop,
    McpBridge,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HelloRequest {
    pub protocol: ProtocolRange,
    pub client: ClientClass,
    pub capabilities: Vec<String>,
    pub secret: String,
}
impl HelloRequest {
    pub fn validate(&self) -> Result<(), IpcError> {
        self.protocol.validate()?;
        validate_capabilities(&self.capabilities)
    }
}
impl fmt::Debug for HelloRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HelloRequest")
            .field("protocol", &self.protocol)
            .field("client", &self.client)
            .field("capability_count", &self.capabilities.len())
            .field("secret", &"[redacted]")
            .finish()
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HelloResponse {
    pub protocol: ProtocolVersion,
    pub runtime_id: String,
    pub connection_id: String,
    pub capabilities: Vec<String>,
}
impl fmt::Debug for HelloResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HelloResponse")
            .field("protocol", &self.protocol)
            .field("runtime_id", &self.runtime_id)
            .field("connection_id", &"[redacted]")
            .field("capability_count", &self.capabilities.len())
            .finish()
    }
}
impl HelloResponse {
    pub fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.runtime_id) && valid_identity(&self.connection_id))
            .then_some(())
            .ok_or(IpcError::InvalidRequest)?;
        validate_capabilities(&self.capabilities)
    }
}
fn validate_capabilities(capabilities: &[String]) -> Result<(), IpcError> {
    (capabilities.len() <= MAX_HELLO_CAPABILITIES
        && capabilities
            .iter()
            .all(|v| valid_bounded(v, MAX_CAPABILITY_BYTES)))
    .then_some(())
    .ok_or(IpcError::InvalidRequest)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Method {
    #[serde(rename = "runtime.hello")]
    Hello,
    #[serde(rename = "runtime.health")]
    Health,
    #[serde(rename = "runtime.stop")]
    RuntimeStop,
    #[serde(rename = "session.create")]
    SessionCreate,
    #[serde(rename = "session.get")]
    SessionGet,
    #[serde(rename = "session.list")]
    SessionList,
    #[serde(rename = "session.attach")]
    SessionAttach,
    #[serde(rename = "session.detach")]
    SessionDetach,
    #[serde(rename = "session.input")]
    SessionInput,
    #[serde(rename = "session.resize")]
    SessionResize,
    #[serde(rename = "session.ack")]
    SessionAck,
    #[serde(rename = "session.resync")]
    SessionResync,
    #[serde(rename = "session.close")]
    SessionClose,
    #[serde(rename = "session.present")]
    SessionPresent,
    #[serde(rename = "desktop.register")]
    DesktopRegister,
    #[serde(rename = "surface.ready")]
    SurfaceReady,
    #[serde(rename = "surface.hidden")]
    SurfaceHidden,
}
impl Method {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Hello => "runtime.hello",
            Self::Health => "runtime.health",
            Self::RuntimeStop => "runtime.stop",
            Self::SessionCreate => "session.create",
            Self::SessionGet => "session.get",
            Self::SessionList => "session.list",
            Self::SessionAttach => "session.attach",
            Self::SessionDetach => "session.detach",
            Self::SessionInput => "session.input",
            Self::SessionResize => "session.resize",
            Self::SessionAck => "session.ack",
            Self::SessionResync => "session.resync",
            Self::SessionClose => "session.close",
            Self::SessionPresent => "session.present",
            Self::DesktopRegister => "desktop.register",
            Self::SurfaceReady => "surface.ready",
            Self::SurfaceHidden => "surface.hidden",
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnvelopeKind {
    Request,
    Response,
    Event,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestEnvelope {
    pub version: ProtocolVersion,
    pub kind: EnvelopeKind,
    pub id: u64,
    pub method: Method,
    pub params: serde_json::Value,
}
impl RequestEnvelope {
    pub fn validate(&self) -> Result<(), IpcError> {
        self.validate_for(&PROTOCOL_VERSION)
    }
    pub fn validate_for(&self, selected: &ProtocolVersion) -> Result<(), IpcError> {
        if self.kind != EnvelopeKind::Request {
            return Err(IpcError::InvalidKind);
        }
        if &self.version != selected {
            return Err(IpcError::UnsupportedVersion);
        }
        Ok(())
    }
    pub fn decode_params(&self) -> Result<RequestParams, IpcError> {
        let parsed = match self.method {
            Method::Hello => RequestParams::Hello(decode(&self.params)?),
            Method::Health => RequestParams::Health(decode(&self.params)?),
            Method::RuntimeStop => RequestParams::RuntimeStop(decode(&self.params)?),
            Method::SessionCreate => RequestParams::SessionCreate(decode(&self.params)?),
            Method::SessionGet => RequestParams::SessionGet(decode(&self.params)?),
            Method::SessionList => RequestParams::SessionList(decode(&self.params)?),
            Method::SessionAttach => RequestParams::SessionAttach(decode(&self.params)?),
            Method::SessionDetach => RequestParams::SessionDetach(decode(&self.params)?),
            Method::SessionInput => RequestParams::SessionInput(decode(&self.params)?),
            Method::SessionResize => RequestParams::SessionResize(decode(&self.params)?),
            Method::SessionAck => RequestParams::SessionAck(decode(&self.params)?),
            Method::SessionResync => RequestParams::SessionResync(decode(&self.params)?),
            Method::SessionClose => RequestParams::SessionClose(decode(&self.params)?),
            Method::SessionPresent => RequestParams::SessionPresent(decode(&self.params)?),
            Method::DesktopRegister => RequestParams::DesktopRegister(decode(&self.params)?),
            Method::SurfaceReady => RequestParams::SurfaceReady(decode(&self.params)?),
            Method::SurfaceHidden => RequestParams::SurfaceHidden(decode(&self.params)?),
        };
        parsed.validate()?;
        Ok(parsed)
    }
}
impl fmt::Debug for RequestEnvelope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RequestEnvelope")
            .field("version", &self.version)
            .field("kind", &self.kind)
            .field("id", &self.id)
            .field("method", &self.method)
            .field("params", &"[redacted]")
            .finish()
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResponseEnvelope {
    pub version: ProtocolVersion,
    pub kind: EnvelopeKind,
    pub id: u64,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<TransportError>,
}
impl ResponseEnvelope {
    pub fn validate(&self) -> Result<(), IpcError> {
        self.validate_for(&PROTOCOL_VERSION)
    }
    pub fn validate_for(&self, selected: &ProtocolVersion) -> Result<(), IpcError> {
        if self.kind != EnvelopeKind::Response {
            return Err(IpcError::InvalidKind);
        }
        if &self.version != selected {
            return Err(IpcError::UnsupportedVersion);
        }
        (self.result.is_some() ^ self.error.is_some())
            .then_some(())
            .ok_or(IpcError::InvalidResponse)?;
        self.error.as_ref().map_or(Ok(()), TransportError::validate)
    }
    pub fn decode_result(&self, method: Method) -> Result<ResponseResult, IpcError> {
        self.validate()?;
        let value = self.result.as_ref().ok_or(IpcError::InvalidResponse)?;
        let parsed = match method {
            Method::Hello | Method::Health | Method::RuntimeStop => {
                ResponseResult::Empty(decode(value)?)
            }
            Method::SessionCreate => ResponseResult::SessionCreate(decode(value)?),
            Method::SessionGet => ResponseResult::SessionGet(decode(value)?),
            Method::SessionList => ResponseResult::SessionList(decode(value)?),
            Method::SessionAttach => ResponseResult::SessionAttach(decode(value)?),
            Method::SessionDetach => ResponseResult::SessionDetach(decode(value)?),
            Method::SessionInput => ResponseResult::SessionInput(decode(value)?),
            Method::SessionResize => ResponseResult::SessionResize(decode(value)?),
            Method::SessionAck => ResponseResult::SessionAck(decode(value)?),
            Method::SessionResync => ResponseResult::SessionResync(decode(value)?),
            Method::SessionClose => ResponseResult::SessionClose(decode(value)?),
            Method::DesktopRegister => ResponseResult::DesktopRegister(decode(value)?),
            Method::SessionPresent => ResponseResult::SessionPresent(decode(value)?),
            Method::SurfaceReady => ResponseResult::SurfaceReady(decode(value)?),
            Method::SurfaceHidden => ResponseResult::SurfaceHidden(decode(value)?),
        };
        parsed.validate()?;
        Ok(parsed)
    }
}
impl fmt::Debug for ResponseEnvelope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResponseEnvelope")
            .field("version", &self.version)
            .field("kind", &self.kind)
            .field("id", &self.id)
            .field("result", &self.result.as_ref().map(|_| "[redacted]"))
            .field("error", &self.error.as_ref().map(|_| "[redacted]"))
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum EventName {
    #[serde(rename = "session.output")]
    SessionOutput,
    #[serde(rename = "session.state")]
    SessionState,
    #[serde(rename = "session.exit")]
    SessionExit,
    #[serde(rename = "session.resync_required")]
    SessionResyncRequired,
    #[serde(rename = "surface.present_requested")]
    SurfacePresentRequested,
}
impl EventName {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SessionOutput => "session.output",
            Self::SessionState => "session.state",
            Self::SessionExit => "session.exit",
            Self::SessionResyncRequired => "session.resync_required",
            Self::SurfacePresentRequested => "surface.present_requested",
        }
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EventEnvelope {
    pub version: ProtocolVersion,
    pub kind: EnvelopeKind,
    pub event: EventName,
    pub payload: serde_json::Value,
}
impl EventEnvelope {
    pub fn validate(&self) -> Result<(), IpcError> {
        self.validate_for(&PROTOCOL_VERSION)
    }
    pub fn validate_for(&self, selected: &ProtocolVersion) -> Result<(), IpcError> {
        if self.kind != EnvelopeKind::Event {
            return Err(IpcError::InvalidKind);
        }
        if &self.version != selected {
            return Err(IpcError::UnsupportedVersion);
        }
        self.decode_payload().map(|_| ())
    }
    pub fn decode_payload(&self) -> Result<EventPayload, IpcError> {
        let parsed = match self.event {
            EventName::SessionOutput => EventPayload::SessionOutput(decode(&self.payload)?),
            EventName::SessionState => EventPayload::SessionState(decode(&self.payload)?),
            EventName::SessionExit => EventPayload::SessionExit(decode(&self.payload)?),
            EventName::SessionResyncRequired => {
                EventPayload::SessionResyncRequired(decode(&self.payload)?)
            }
            EventName::SurfacePresentRequested => {
                EventPayload::SurfacePresentRequested(decode(&self.payload)?)
            }
        };
        parsed.validate()?;
        Ok(parsed)
    }
}
impl fmt::Debug for EventEnvelope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EventEnvelope")
            .field("version", &self.version)
            .field("kind", &self.kind)
            .field("event", &self.event)
            .field("payload", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub enum RequestParams {
    Hello(HelloRequest),
    Health(EmptyRequest),
    RuntimeStop(RuntimeStopRequest),
    SessionCreate(SessionCreateRequest),
    SessionGet(SessionGetRequest),
    SessionList(SessionListRequest),
    SessionAttach(SessionAttachRequest),
    SessionDetach(SessionDetachRequest),
    SessionInput(SessionInputRequest),
    SessionResize(SessionResizeRequest),
    SessionAck(SessionAckRequest),
    SessionResync(SessionResyncRequest),
    SessionClose(SessionCloseRequest),
    SessionPresent(SessionPresentRequest),
    DesktopRegister(DesktopRegisterRequest),
    SurfaceReady(SurfaceReadyRequest),
    SurfaceHidden(SurfaceHiddenRequest),
}
impl RequestParams {
    pub fn validate(&self) -> Result<(), IpcError> {
        match self {
            Self::Hello(v) => v.validate(),
            Self::Health(v) => v.validate(),
            Self::RuntimeStop(v) => v.validate(),
            Self::SessionCreate(v) => v.validate(),
            Self::SessionGet(v) => v.validate(),
            Self::SessionList(v) => v.validate(),
            Self::SessionAttach(v) => v.validate(),
            Self::SessionDetach(v) => v.validate(),
            Self::SessionInput(v) => v.validate(),
            Self::SessionResize(v) => v.validate(),
            Self::SessionAck(v) => v.validate(),
            Self::SessionResync(v) => v.validate(),
            Self::SessionClose(v) => v.validate(),
            Self::SessionPresent(v) => v.validate(),
            Self::DesktopRegister(v) => v.validate(),
            Self::SurfaceReady(v) => v.validate(),
            Self::SurfaceHidden(v) => v.validate(),
        }
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionCreateRequest {
    pub request_id: String,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub title: Option<String>,
    pub placement: crate::Placement,
    pub presentation: crate::Presentation,
    pub exit_behavior: crate::ExitBehavior,
    pub rows: u16,
    pub cols: u16,
}
impl SessionCreateRequest {
    fn validate(&self) -> Result<(), IpcError> {
        (is_valid_request_id(&self.request_id)
            && valid_bounded(&self.executable, MAX_COMMAND_BYTES)
            && valid_bounded(&self.cwd, MAX_COMMAND_BYTES)
            && self.args.len() <= MAX_ARGUMENTS
            && self.args.iter().all(|v| v.len() <= MAX_COMMAND_BYTES)
            && self.rows > 0
            && self.cols > 0
            && self
                .title
                .as_ref()
                .map_or(true, |v| valid_bounded(v, MAX_TITLE_BYTES)))
        .then_some(())
        .ok_or(IpcError::InvalidRequest)
    }
}
impl fmt::Debug for SessionCreateRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionCreateRequest")
            .field("request_id", &"[redacted]")
            .field("executable", &"[redacted]")
            .field("args", &"[redacted]")
            .field("cwd", &"[redacted]")
            .field("title", &self.title.as_ref().map(|_| "[redacted]"))
            .field("placement", &self.placement)
            .field("presentation", &self.presentation)
            .field("exit_behavior", &self.exit_behavior)
            .finish()
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionGetRequest {
    pub selector: SessionSelector,
}
impl SessionGetRequest {
    fn validate(&self) -> Result<(), IpcError> {
        self.selector
            .validate()
            .map_err(|_| IpcError::InvalidRequest)
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionListRequest {}
impl SessionListRequest {
    fn validate(&self) -> Result<(), IpcError> {
        Ok(())
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionAttachRequest {
    pub handle: String,
}
impl SessionAttachRequest {
    fn validate(&self) -> Result<(), IpcError> {
        valid_identity(&self.handle)
            .then_some(())
            .ok_or(IpcError::InvalidRequest)
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionDetachRequest {
    pub attach_id: String,
    pub stream_id: String,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionInputRequest {
    pub attach_id: String,
    pub stream_id: String,
    pub data_base64: String,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionResizeRequest {
    pub attach_id: String,
    pub stream_id: String,
    pub rows: u16,
    pub cols: u16,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionAckRequest {
    pub attach_id: String,
    pub stream_id: String,
    pub through_seq: u64,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionResyncRequest {
    pub attach_id: String,
    pub stream_id: String,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionCloseRequest {
    pub handle: String,
    pub mode: CloseMode,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionPresentRequest {
    pub handle: String,
    pub placement: crate::Placement,
    #[serde(default)]
    pub workspace_target: Option<String>,
    pub presentation: crate::Presentation,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopRegisterRequest {
    pub surface_protocol_version: String,
    pub placements: Vec<crate::Placement>,
    pub background_presentation: bool,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyRequest {}
impl EmptyRequest {
    fn validate(&self) -> Result<(), IpcError> {
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeStopRequest {
    #[serde(default)]
    pub terminate_live_sessions: bool,
}
impl RuntimeStopRequest {
    fn validate(&self) -> Result<(), IpcError> {
        Ok(())
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceReadyRequest {
    pub handle: String,
    pub revision: u64,
    pub attach_id: String,
    pub stream_id: String,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceHiddenRequest {
    pub handle: String,
    pub revision: u64,
    pub attach_id: String,
    pub stream_id: String,
}
impl SurfaceReadyRequest {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.handle)
            && valid_identity(&self.attach_id)
            && valid_identity(&self.stream_id)
            && self.revision > 0)
            .then_some(())
            .ok_or(IpcError::InvalidRequest)
    }
}
impl SurfaceHiddenRequest {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.handle)
            && valid_identity(&self.attach_id)
            && valid_identity(&self.stream_id)
            && self.revision > 0)
            .then_some(())
            .ok_or(IpcError::InvalidRequest)
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseMode {
    Graceful,
    Force,
}
impl SessionDetachRequest {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.attach_id) && valid_identity(&self.stream_id))
            .then_some(())
            .ok_or(IpcError::InvalidRequest)
    }
}
impl SessionInputRequest {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.attach_id)
            && valid_identity(&self.stream_id)
            && valid_bytes(&self.data_base64, MAX_INPUT_BYTES))
        .then_some(())
        .ok_or(IpcError::InvalidRequest)
    }
}
impl SessionResizeRequest {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.attach_id)
            && valid_identity(&self.stream_id)
            && self.rows > 0
            && self.cols > 0)
            .then_some(())
            .ok_or(IpcError::InvalidRequest)
    }
}
impl SessionAckRequest {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.attach_id) && valid_identity(&self.stream_id))
            .then_some(())
            .ok_or(IpcError::InvalidRequest)
    }
}
impl SessionResyncRequest {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.attach_id) && valid_identity(&self.stream_id))
            .then_some(())
            .ok_or(IpcError::InvalidRequest)
    }
}
impl SessionCloseRequest {
    fn validate(&self) -> Result<(), IpcError> {
        valid_identity(&self.handle)
            .then_some(())
            .ok_or(IpcError::InvalidRequest)
    }
}
impl SessionPresentRequest {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.handle)
            && valid_presentation_target(self.placement.clone(), self.workspace_target.as_deref()))
        .then_some(())
        .ok_or(IpcError::InvalidRequest)
    }
}
impl DesktopRegisterRequest {
    fn validate(&self) -> Result<(), IpcError> {
        (self.surface_protocol_version == SURFACE_PRESENTATION_V1
            && !self.placements.is_empty()
            && self.placements.len() <= 2
            && self.placements.iter().all(|placement| {
                self.placements
                    .iter()
                    .filter(|candidate| *candidate == placement)
                    .count()
                    == 1
            }))
        .then_some(())
        .ok_or(IpcError::InvalidRequest)
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub enum ResponseResult {
    Empty(EmptyResponse),
    SessionCreate(SessionCreateResponse),
    SessionGet(SessionRecord),
    SessionList(SessionListResponse),
    SessionAttach(SessionAttachResponse),
    SessionDetach(EmptyResponse),
    SessionInput(EmptyResponse),
    SessionResize(EmptyResponse),
    SessionAck(EmptyResponse),
    SessionResync(SessionAttachResponse),
    SessionClose(EmptyResponse),
    SessionPresent(SessionRecord),
    DesktopRegister(EmptyResponse),
    SurfaceReady(SessionRecord),
    SurfaceHidden(SessionRecord),
}
impl ResponseResult {
    fn validate(&self) -> Result<(), IpcError> {
        match self {
            Self::SessionCreate(v) => v.validate(),
            Self::SessionGet(v)
            | Self::SessionPresent(v)
            | Self::SurfaceReady(v)
            | Self::SurfaceHidden(v) => v.validate(),
            Self::SessionList(v) => v.validate(),
            Self::SessionAttach(v) | Self::SessionResync(v) => v.validate(),
            _ => Ok(()),
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CreateDisposition {
    Created,
    Reused,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionCreateResponse {
    pub disposition: CreateDisposition,
    pub session: SessionRecord,
}
impl SessionCreateResponse {
    fn validate(&self) -> Result<(), IpcError> {
        self.session.validate()
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Creating,
    Running,
    Exited,
    Closing,
    Closed,
    Lost,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRecord {
    pub runtime_id: String,
    pub handle: String,
    pub stream_id: String,
    pub state: SessionState,
    pub revision: u64,
    pub placement: crate::Placement,
    pub presentation: crate::Presentation,
    pub exit_behavior: crate::ExitBehavior,
    #[serde(default)]
    pub workspace_target: Option<String>,
    pub surface_hidden: bool,
    #[serde(default)]
    pub child_pid: Option<u32>,
    #[serde(default)]
    pub exit_code: Option<i32>,
}
impl SessionRecord {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.runtime_id)
            && valid_identity(&self.handle)
            && valid_identity(&self.stream_id)
            && self
                .workspace_target
                .as_ref()
                .map_or(true, |path| valid_bounded(path, MAX_COMMAND_BYTES))
            && valid_presentation_target(self.placement.clone(), self.workspace_target.as_deref())
            && self.child_pid.map_or(true, |pid| pid > 0))
        .then_some(())
        .ok_or(IpcError::InvalidRequest)
    }
}
impl fmt::Debug for SessionRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionRecord")
            .field("runtime_id", &self.runtime_id)
            .field("handle", &self.handle)
            .field("stream_id", &self.stream_id)
            .field("state", &self.state)
            .field("revision", &self.revision)
            .field(
                "workspace_target",
                &self.workspace_target.as_ref().map(|_| "[redacted]"),
            )
            .finish()
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionListResponse {
    pub sessions: Vec<SessionRecord>,
}
impl SessionListResponse {
    fn validate(&self) -> Result<(), IpcError> {
        (self.sessions.len() <= MAX_SESSION_LIST_ENTRIES)
            .then_some(())
            .ok_or(IpcError::InvalidRequest)?;
        self.sessions.iter().try_for_each(SessionRecord::validate)
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalSnapshot {
    pub content_base64: String,
    pub rows: u16,
    pub cols: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
    #[serde(default)]
    pub history_base64: Option<String>,
}
impl TerminalSnapshot {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_bytes_allow_empty(&self.content_base64, MAX_SNAPSHOT_BYTES)
            && self.rows > 0
            && self.cols > 0
            && self.cursor_row < self.rows
            && self.cursor_col < self.cols
            && self
                .history_base64
                .as_ref()
                .map_or(true, |v| valid_bytes_allow_empty(v, MAX_SNAPSHOT_BYTES)))
        .then_some(())
        .ok_or(IpcError::InvalidRequest)
    }
}
impl fmt::Debug for TerminalSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TerminalSnapshot")
            .field("content_base64", &"[redacted]")
            .finish()
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionAttachResponse {
    pub runtime_id: String,
    pub handle: String,
    pub stream_id: String,
    pub attach_id: String,
    pub barrier_seq: u64,
    pub snapshot: TerminalSnapshot,
}
impl SessionAttachResponse {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.runtime_id)
            && valid_identity(&self.handle)
            && valid_identity(&self.stream_id)
            && valid_identity(&self.attach_id))
        .then_some(())
        .ok_or(IpcError::InvalidRequest)?;
        self.snapshot.validate()
    }
}
impl fmt::Debug for SessionAttachResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionAttachResponse")
            .field("runtime_id", &self.runtime_id)
            .field("handle", &self.handle)
            .field("stream_id", &self.stream_id)
            .field("attach_id", &"[redacted]")
            .field("barrier_seq", &self.barrier_seq)
            .field("snapshot", &"[redacted]")
            .finish()
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyResponse {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum EventPayload {
    SessionOutput(SessionOutputEvent),
    SessionState(SessionStateEvent),
    SessionExit(SessionExitEvent),
    SessionResyncRequired(SessionResyncRequiredEvent),
    SurfacePresentRequested(SurfacePresentRequestedEvent),
}
impl EventPayload {
    fn validate(&self) -> Result<(), IpcError> {
        match self {
            Self::SessionOutput(v) => v.validate(),
            Self::SessionState(v) => v.validate(),
            Self::SessionExit(v) => v.validate(),
            Self::SessionResyncRequired(v) => v.validate(),
            Self::SurfacePresentRequested(v) => v.validate(),
        }
    }
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionOutputEvent {
    pub runtime_id: String,
    pub handle: String,
    pub stream_id: String,
    pub attach_id: String,
    pub seq: u64,
    pub data_base64: String,
}
impl SessionOutputEvent {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.runtime_id)
            && valid_identity(&self.handle)
            && valid_identity(&self.stream_id)
            && valid_identity(&self.attach_id)
            && valid_bytes_allow_empty(&self.data_base64, MAX_INPUT_BYTES))
        .then_some(())
        .ok_or(IpcError::InvalidRequest)
    }
}
impl fmt::Debug for SessionOutputEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionOutputEvent")
            .field("runtime_id", &self.runtime_id)
            .field("handle", &self.handle)
            .field("stream_id", &self.stream_id)
            .field("seq", &self.seq)
            .field("data_base64", &"[redacted]")
            .finish()
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionStateEvent {
    pub runtime_id: String,
    pub handle: String,
    pub stream_id: String,
    pub state: SessionState,
    pub revision: u64,
}
impl SessionStateEvent {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.runtime_id)
            && valid_identity(&self.handle)
            && valid_identity(&self.stream_id))
        .then_some(())
        .ok_or(IpcError::InvalidRequest)
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionExitEvent {
    pub runtime_id: String,
    pub handle: String,
    pub stream_id: String,
    pub revision: u64,
    pub exit_code: Option<i32>,
    pub exit_behavior: crate::ExitBehavior,
}
impl SessionExitEvent {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.runtime_id)
            && valid_identity(&self.handle)
            && valid_identity(&self.stream_id))
        .then_some(())
        .ok_or(IpcError::InvalidRequest)
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResyncReason {
    QueueOverflow,
    SequenceGap,
    StreamRebuilt,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionResyncRequiredEvent {
    pub runtime_id: String,
    pub handle: String,
    pub stream_id: String,
    pub attach_id: String,
    pub last_delivered_seq: u64,
    pub current_seq: u64,
    pub reason: ResyncReason,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SurfacePresentRequestedEvent {
    pub handle: String,
    pub revision: u64,
    pub placement: crate::Placement,
    #[serde(default)]
    pub workspace_target: Option<String>,
    pub presentation: crate::Presentation,
}
impl fmt::Debug for SurfacePresentRequestedEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SurfacePresentRequestedEvent")
            .field("handle", &"[redacted]")
            .field("revision", &self.revision)
            .field("placement", &self.placement)
            .field(
                "workspace_target",
                &self.workspace_target.as_ref().map(|_| "[redacted]"),
            )
            .field("presentation", &self.presentation)
            .finish()
    }
}
impl SurfacePresentRequestedEvent {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.handle)
            && self.revision > 0
            && valid_presentation_target(self.placement.clone(), self.workspace_target.as_deref()))
        .then_some(())
        .ok_or(IpcError::InvalidRequest)
    }
}
impl SessionResyncRequiredEvent {
    fn validate(&self) -> Result<(), IpcError> {
        (valid_identity(&self.runtime_id)
            && valid_identity(&self.handle)
            && valid_identity(&self.stream_id)
            && valid_identity(&self.attach_id)
            && self.last_delivered_seq <= self.current_seq)
            .then_some(())
            .ok_or(IpcError::InvalidRequest)
    }
}

fn decode<T: for<'de> Deserialize<'de>>(value: &serde_json::Value) -> Result<T, IpcError> {
    serde_json::from_value(value.clone()).map_err(|_| IpcError::InvalidRequest)
}
fn valid_bounded(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max
}
fn valid_identity(value: &str) -> bool {
    valid_bounded(value, MAX_IDENTITY_BYTES)
}
fn valid_presentation_target(placement: crate::Placement, target: Option<&str>) -> bool {
    match placement {
        crate::Placement::Window => target.is_none(),
        crate::Placement::Workspace => {
            target.map_or(true, |value| valid_bounded(value, MAX_COMMAND_BYTES))
        }
    }
}
fn valid_bytes(value: &str, max_decoded: usize) -> bool {
    value.len() <= max_decoded.saturating_mul(4).div_ceil(3)
        && BASE64
            .decode(value)
            .is_ok_and(|bytes| !bytes.is_empty() && bytes.len() <= max_decoded)
}
fn valid_bytes_allow_empty(value: &str, max_decoded: usize) -> bool {
    value.len() <= max_decoded.saturating_mul(4).div_ceil(3)
        && BASE64
            .decode(value)
            .is_ok_and(|bytes| bytes.len() <= max_decoded)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportErrorCode {
    UnsupportedVersion,
    InvalidKind,
    InvalidMethod,
    InvalidRequest,
    RequestConflict,
    TerminalNotFound,
    SpawnFailed,
    AppUnavailable,
    SurfaceFailed,
    IncompatibleRuntime,
    StalePresentation,
    RuntimeBusy,
    InternalError,
}
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TransportError {
    pub code: TransportErrorCode,
    pub message: String,
    #[serde(default)]
    pub effect: Option<crate::EffectClassification>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub handle: Option<String>,
    pub retryable: bool,
}
impl TransportError {
    pub fn validate(&self) -> Result<(), IpcError> {
        let valid_ids = self
            .request_id
            .as_ref()
            .map_or(true, |request_id| is_valid_request_id(request_id))
            && self
                .handle
                .as_ref()
                .map_or(true, |handle| valid_identity(handle));
        let valid_effect = match self.effect {
            None => self.request_id.is_none() && self.handle.is_none(),
            Some(crate::EffectClassification::NoEffect) => self.handle.is_none(),
            Some(crate::EffectClassification::SessionCreated) => {
                self.request_id.is_some() && self.handle.is_some()
            }
            Some(crate::EffectClassification::OutcomeUnknown) => {
                self.request_id.is_some() && self.handle.is_none()
            }
        };
        (valid_ids && valid_effect)
            .then_some(())
            .ok_or(IpcError::InvalidResponse)
    }
}
impl fmt::Debug for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TransportError")
            .field("code", &self.code)
            .field("retryable", &self.retryable)
            .finish()
    }
}
impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self.code {
            TransportErrorCode::UnsupportedVersion => "unsupported_version",
            TransportErrorCode::InvalidKind => "invalid_kind",
            TransportErrorCode::InvalidMethod => "invalid_method",
            TransportErrorCode::InvalidRequest => "invalid_request",
            TransportErrorCode::RequestConflict => "request_conflict",
            TransportErrorCode::TerminalNotFound => "terminal_not_found",
            TransportErrorCode::SpawnFailed => "spawn_failed",
            TransportErrorCode::AppUnavailable => "app_unavailable",
            TransportErrorCode::SurfaceFailed => "surface_failed",
            TransportErrorCode::IncompatibleRuntime => "incompatible_runtime",
            TransportErrorCode::StalePresentation => "stale_presentation",
            TransportErrorCode::RuntimeBusy => "runtime_busy",
            TransportErrorCode::InternalError => "internal_error",
        })
    }
}
impl Error for TransportError {}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IpcError {
    UnsupportedVersion,
    InvalidProtocolRange,
    InvalidKind,
    InvalidRequest,
    InvalidResponse,
}
impl fmt::Display for IpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::UnsupportedVersion => "unsupported_version",
            Self::InvalidProtocolRange => "invalid_protocol_range",
            Self::InvalidKind => "invalid_kind",
            Self::InvalidRequest => "invalid_request",
            Self::InvalidResponse => "invalid_response",
        })
    }
}
impl Error for IpcError {}

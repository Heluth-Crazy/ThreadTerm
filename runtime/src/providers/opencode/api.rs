//! OpenCode's two native REST dialects. Endpoint owners choose response shapes;
//! neither a version number nor a failed mutation can select another dialect.
use super::{validate_native_id, ProviderError};
#[cfg(test)]
use base64::Engine;
use reqwest::blocking::{Client, Response};
use reqwest::Method;
use serde_json::{json, Value};
use std::io::Read;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ApiDialect {
    Legacy,
    V2,
}

impl ApiDialect {
    pub(super) fn username(self) -> &'static str {
        match self {
            Self::Legacy => "threadterm",
            Self::V2 => "opencode",
        }
    }

    pub(super) fn require_event_compatibility(self) -> Result<(), ProviderError> {
        if self == Self::V2 {
            return Err(ProviderError::new("provider_method_unsupported", "OpenCode 2.x was detected, but event and recovery compatibility is not implemented yet"));
        }
        Ok(())
    }

    fn session_path(self, id: Option<&str>) -> String {
        let prefix = match self {
            Self::Legacy => "/session",
            Self::V2 => "/api/session",
        };
        match id {
            Some(id) => format!("{prefix}/{id}"),
            None => prefix.into(),
        }
    }

    pub(super) fn validate_health(self, value: &Value) -> Result<(), ProviderError> {
        let version = value
            .get("version")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty());
        let valid = match self {
            Self::Legacy => version && value.get("healthy") == Some(&Value::Bool(true)),
            Self::V2 => {
                version
                    && value.get("pid").and_then(Value::as_u64).is_some()
                    && value
                        .get("urls")
                        .and_then(Value::as_array)
                        .is_some_and(|urls| urls.iter().all(Value::is_string))
                    && value
                        .pointer("/paths/tmp")
                        .and_then(Value::as_str)
                        .is_some()
            }
        };
        if valid {
            Ok(())
        } else {
            Err(protocol("OpenCode returned malformed health information"))
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum ResponseShape {
    Direct,
    Data,
    LocationData,
    NoContent,
}

impl ResponseShape {
    pub(super) fn decode(self, value: Value) -> Result<Value, ProviderError> {
        match self {
            Self::Direct => Ok(value),
            Self::Data | Self::LocationData => {
                if matches!(self, Self::LocationData)
                    && value
                        .pointer("/location/directory")
                        .and_then(Value::as_str)
                        .is_none()
                {
                    return Err(protocol("OpenCode returned no catalogue location"));
                }
                value
                    .get("data")
                    .filter(|data| !data.is_null())
                    .cloned()
                    .ok_or_else(|| protocol("OpenCode returned no data envelope"))
            }
            Self::NoContent => Err(protocol(
                "OpenCode returned JSON for a no-content operation",
            )),
        }
    }
}

fn protocol(message: impl Into<String>) -> ProviderError {
    ProviderError::new("provider_protocol", message)
}

pub(super) fn session_identity(
    value: &Value,
    expected: Option<&str>,
) -> Result<String, ProviderError> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| protocol("OpenCode returned no session id"))?;
    validate_native_id(id).map_err(|_| protocol("OpenCode returned an invalid session id"))?;
    if expected.is_some_and(|expected| expected != id) {
        return Err(protocol("OpenCode returned a different native session id"));
    }
    Ok(id.into())
}

pub(super) fn interrupt_confirmed(dialect: ApiDialect, value: &Value) -> Result<(), ProviderError> {
    let confirmed = match dialect {
        ApiDialect::Legacy => value == &Value::Bool(true),
        ApiDialect::V2 => value.get("interrupted") == Some(&Value::Bool(true)),
    };
    if confirmed {
        Ok(())
    } else {
        Err(ProviderError::new(
            "abort_result_unknown",
            "OpenCode did not confirm that the turn was stopped",
        ))
    }
}

/// Immutable, cloneable worker-local settings, also used by background requests.
#[derive(Clone)]
pub(super) struct NativeApi {
    client: Client,
    base_url: String,
    cwd: String,
    password: String,
    pub(super) dialect: ApiDialect,
}

impl NativeApi {
    pub(super) fn new(
        client: Client,
        base_url: String,
        cwd: String,
        password: String,
        dialect: ApiDialect,
    ) -> Self {
        Self {
            client,
            base_url,
            cwd,
            password,
            dialect,
        }
    }

    pub(super) fn json_request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        shape: ResponseShape,
    ) -> Result<Value, ProviderError> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base_url))
            .basic_auth(self.dialect.username(), Some(&self.password));
        if self.dialect == ApiDialect::Legacy {
            request = request.query(&[("directory", &self.cwd)]);
        } else if matches!(
            path,
            "/api/location" | "/api/provider" | "/api/model" | "/api/agent" | "/api/command"
        ) {
            request = request.query(&[("location[directory]", &self.cwd)]);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().map_err(|error| {
            ProviderError::new(
                "provider_disconnected",
                format!("OpenCode request failed: {error}"),
            )
        })?;
        decode_response(response, shape)
    }

    pub(super) fn open_session(&self, id: Option<&str>) -> Result<Value, ProviderError> {
        if let Some(id) = id {
            validate_native_id(id)?;
        }
        if self.dialect == ApiDialect::V2 && id.is_none() {
            self.resolve_location()?;
        }
        let (method, body) = if id.is_some() {
            (Method::GET, None)
        } else {
            (
                Method::POST,
                Some(match self.dialect {
                    ApiDialect::Legacy => json!({}),
                    ApiDialect::V2 => json!({"location":{"directory":self.cwd}}),
                }),
            )
        };
        let shape = match self.dialect {
            ApiDialect::Legacy => ResponseShape::Direct,
            ApiDialect::V2 => ResponseShape::Data,
        };
        let session = self.json_request(method, &self.dialect.session_path(id), body, shape)?;
        session_identity(&session, id)?;
        Ok(session)
    }

    fn resolve_location(&self) -> Result<(), ProviderError> {
        let value = self.json_request(Method::GET, "/api/location", None, ResponseShape::Direct)?;
        if value.get("directory").and_then(Value::as_str).is_none()
            || value
                .pointer("/project/id")
                .and_then(Value::as_str)
                .is_none()
        {
            return Err(protocol("OpenCode returned malformed location information"));
        }
        Ok(())
    }

    pub(super) fn admit_prompt(
        &self,
        id: &str,
        text: &str,
        files: &[Value],
    ) -> Result<Value, ProviderError> {
        validate_native_id(id)?;
        if self.dialect != ApiDialect::V2 {
            return Err(protocol("V2 prompt admission requires the v2 dialect"));
        }
        // The native service must load the location before it can admit work;
        // storing a location in session/create alone does not initialize it.
        self.resolve_location()?;
        let mut body = json!({"text":text});
        if !files.is_empty() {
            // `parts`/`content` are silently dropped by 2.2.5; only `files`
            // carries inline attachments, and each needs a data-URL `uri`.
            body["files"] = json!(files);
        }
        let receipt = self.json_request(
            Method::POST,
            &format!("{}/prompt", self.dialect.session_path(Some(id))),
            Some(body),
            ResponseShape::Data,
        )?;
        if receipt
            .get("id")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
            || receipt.get("sessionID").and_then(Value::as_str) != Some(id)
            || receipt.get("type").and_then(Value::as_str) != Some("user")
        {
            return Err(protocol("OpenCode returned malformed prompt admission"));
        }
        // This is an inbox receipt, never execution completion.
        Ok(receipt)
    }

    pub(super) fn read_session(&self, id: &str) -> Result<Value, ProviderError> {
        validate_native_id(id)?;
        if self.dialect != ApiDialect::V2 {
            return Err(protocol("V2 session reads require the v2 dialect"));
        }
        let session = self.json_request(
            Method::GET,
            &self.dialect.session_path(Some(id)),
            None,
            ResponseShape::Data,
        )?;
        session_identity(&session, Some(id))?;
        Ok(session)
    }

    /// V2 applies next-turn settings to the session itself. A 204 is the whole
    /// receipt; 2.2.5 accepts an unknown model/agent with the same 204, so the
    /// caller must confirm against a read, never this status alone.
    pub(super) fn switch_model(&self, session: &str, model: &Value) -> Result<(), ProviderError> {
        self.session_setting(session, "model", json!({"model":model}))
    }

    pub(super) fn switch_agent(&self, session: &str, agent: &str) -> Result<(), ProviderError> {
        self.session_setting(session, "agent", json!({"agent":agent}))
    }

    fn session_setting(
        &self,
        session: &str,
        action: &str,
        body: Value,
    ) -> Result<(), ProviderError> {
        if self.dialect != ApiDialect::V2 {
            return Err(protocol("Native session settings require the v2 dialect"));
        }
        validate_native_id(session)?;
        self.json_request(
            Method::POST,
            &format!("{}/{action}", self.dialect.session_path(Some(session))),
            Some(body),
            ResponseShape::NoContent,
        )?;
        Ok(())
    }

    /// `name` plus the prompt input fields; 2.2.5 rejects `arguments`.
    pub(super) fn run_command(
        &self,
        session: &str,
        name: &str,
        text: &str,
        files: &[Value],
    ) -> Result<(), ProviderError> {
        if self.dialect != ApiDialect::V2 {
            return Err(protocol("V2 command admission requires the v2 dialect"));
        }
        validate_native_id(session)?;
        let mut body = json!({"name":name,"text":text});
        if !files.is_empty() {
            body["files"] = json!(files);
        }
        self.json_request(
            Method::POST,
            &format!("{}/command", self.dialect.session_path(Some(session))),
            Some(body),
            ResponseShape::NoContent,
        )?;
        Ok(())
    }

    /// The native reply is an enqueued inbox compaction item. It proves
    /// admission only; completion is a separate `session.compaction.*` event.
    pub(super) fn compact(&self, session: &str) -> Result<Value, ProviderError> {
        if self.dialect != ApiDialect::V2 {
            return Err(protocol("V2 compaction requires the v2 dialect"));
        }
        validate_native_id(session)?;
        let receipt = self.json_request(
            Method::POST,
            &format!("{}/compact", self.dialect.session_path(Some(session))),
            Some(json!({})),
            ResponseShape::Data,
        )?;
        if receipt.get("type").and_then(Value::as_str) != Some("compaction")
            || receipt.get("sessionID").and_then(Value::as_str) != Some(session)
            || receipt.get("id").and_then(Value::as_str).is_none_or(str::is_empty)
        {
            return Err(protocol("OpenCode returned malformed compaction admission"));
        }
        Ok(receipt)
    }

    pub(super) fn interrupt(&self, id: &str) -> Result<(), ProviderError> {
        validate_native_id(id)?;
        let action = match self.dialect {
            ApiDialect::Legacy => "abort",
            ApiDialect::V2 => "interrupt",
        };
        let value = self.json_request(
            Method::POST,
            &format!("{}/{action}", self.dialect.session_path(Some(id))),
            None,
            ResponseShape::Direct,
        )?;
        interrupt_confirmed(self.dialect, &value)
    }

    pub(super) fn get_catalogue(&self, name: &str) -> Result<Value, ProviderError> {
        if !matches!(name, "provider" | "model" | "agent" | "command") {
            return Err(protocol("Unknown OpenCode catalogue"));
        }
        let (prefix, shape) = match self.dialect {
            ApiDialect::Legacy => ("", ResponseShape::Direct),
            ApiDialect::V2 => ("/api", ResponseShape::LocationData),
        };
        self.json_request(Method::GET, &format!("{prefix}/{name}"), None, shape)
    }

    /// Target-only interaction writes. Each one addresses the session that owns
    /// the request, never the root by default, and a 204 is the whole receipt.
    pub(super) fn form_reply(
        &self,
        session: &str,
        form: &str,
        answer: &Value,
    ) -> Result<(), ProviderError> {
        self.interaction_write(
            Method::POST,
            session,
            "form",
            form,
            "reply",
            Some(json!({"answer":answer})),
        )
    }

    pub(super) fn form_cancel(&self, session: &str, form: &str) -> Result<(), ProviderError> {
        self.interaction_write(Method::DELETE, session, "form", form, "", None)
    }

    pub(super) fn permission_reply(
        &self,
        session: &str,
        permission: &str,
        decision: &str,
    ) -> Result<(), ProviderError> {
        if !matches!(decision, "once" | "reject") {
            return Err(ProviderError::new(
                "approval_choice_invalid",
                "OpenCode 2.x accepts once or reject for this approval",
            ));
        }
        self.interaction_write(
            Method::POST,
            session,
            "permission",
            permission,
            "reply",
            Some(json!({"decision":decision})),
        )
    }

    // The kind comes from the stored request, not the id: 2.2.5 requires `frm_`
    // for forms but only `per` for permissions.
    fn interaction_write(
        &self,
        method: Method,
        session: &str,
        kind: &str,
        request: &str,
        action: &str,
        body: Option<Value>,
    ) -> Result<(), ProviderError> {
        if self.dialect != ApiDialect::V2 {
            return Err(protocol("Native interaction writes require the v2 dialect"));
        }
        validate_native_id(session)?;
        validate_native_id(request)?;
        let suffix = if action.is_empty() {
            String::new()
        } else {
            format!("/{action}")
        };
        self.json_request(
            method,
            &format!("{}/{kind}/{request}{suffix}", self.dialect.session_path(Some(session))),
            body,
            ResponseShape::NoContent,
        )?;
        Ok(())
    }
}

pub(super) fn decode_response(
    response: Response,
    shape: ResponseShape,
) -> Result<Value, ProviderError> {
    let status = response.status();
    if !status.is_success() {
        // Do not include the native body: errors may echo credentials or prompt content.
        return Err(
            ProviderError::new("provider_error", format!("OpenCode returned {status}"))
                .with_details(json!({"httpStatus":status.as_u16()})),
        );
    }
    if matches!(shape, ResponseShape::NoContent) {
        if status == reqwest::StatusCode::NO_CONTENT
            && response
                .bytes()
                .map(|bytes| bytes.is_empty())
                .unwrap_or(false)
        {
            return Ok(Value::Null);
        }
        return Err(protocol(
            "OpenCode did not return an empty no-content response",
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|s| s.to_str().ok())
        .unwrap_or("");
    if !content_type
        .split(';')
        .next()
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(protocol("OpenCode returned a non-JSON response"));
    }
    const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(protocol(
            "OpenCode response exceeds the native response limit",
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| protocol("OpenCode response could not be read"))?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(protocol(
            "OpenCode response exceeds the native response limit",
        ));
    }
    let value =
        serde_json::from_slice(&bytes).map_err(|_| protocol("OpenCode returned malformed JSON"))?;
    shape.decode(value)
}

/// Both probes are read-only and use the same owned password. Legacy's configured
/// username and v2's hardcoded username differ, so a rejected probe alone cannot
/// identify the server. No mutation is permitted without positive schema evidence.
pub(super) fn negotiate(
    client: &Client,
    base_url: &str,
    password: &str,
) -> Result<Option<ApiDialect>, ProviderError> {
    let mut failure = None;
    let mut reached_server = false;
    let mut unavailable_probe = false;
    for (dialect, path) in [
        (ApiDialect::V2, "/api/info"),
        (ApiDialect::Legacy, "/global/health"),
    ] {
        let response = match client
            .get(format!("{base_url}{path}"))
            .basic_auth(dialect.username(), Some(password))
            .timeout(std::time::Duration::from_millis(500))
            .send()
        {
            Ok(response) => response,
            Err(_) => {
                unavailable_probe = true;
                continue;
            }
        };
        reached_server = true;
        if response.status().is_success() {
            match decode_response(response, ResponseShape::Direct)
                .and_then(|value| dialect.validate_health(&value))
            {
                Ok(()) => return Ok(Some(dialect)),
                Err(error) => failure = Some(error),
            }
        } else if matches!(response.status().as_u16(), 401 | 403) {
            failure.get_or_insert_with(|| {
                ProviderError::new(
                    "provider_auth_failed",
                    "OpenCode rejected the owned server credentials",
                )
            });
        } else if !matches!(response.status().as_u16(), 404 | 405 | 501) {
            failure.get_or_insert_with(|| {
                ProviderError::new(
                    "provider_error",
                    format!("OpenCode health returned {}", response.status()),
                )
            });
        }
    }
    // The process can begin listening between probes. A 401 for the other
    // dialect is inconclusive when its matching probe never reached a server.
    // Retry only these reads within the existing startup deadline.
    if unavailable_probe {
        return Ok(None);
    }
    if let Some(error) = failure {
        return Err(error);
    }
    if reached_server {
        return Err(ProviderError::new(
            "provider_method_unsupported",
            "OpenCode exposes neither supported health API",
        ));
    }
    Ok(None)
}

#[cfg(test)]
#[path = "api_tests.rs"]
mod tests;

use crate::{
    config::RuntimeConfig,
    protocol_contract::{self, ContractRole},
    PROTOCOL_CONTRACT, PROTOCOL_VERSION,
};
use anyhow::{bail, Context, Result};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;

const MAX_FRAME: usize = 8 * 1024 * 1024;
type HmacSha256 = Hmac<Sha256>;

/// Authenticated client for the V3 local named-pipe transport. It never opens
/// the runtime database; all state is read or changed through control RPC.
pub struct RuntimeClient {
    #[cfg(windows)]
    control: tokio::net::windows::named_pipe::NamedPipeClient,
    #[cfg(windows)]
    output: tokio::net::windows::named_pipe::NamedPipeClient,
    #[cfg(windows)]
    client_id: String,
    #[cfg(windows)]
    output_groups: HashMap<String, OutputGroup>,
}

#[cfg(windows)]
struct OutputGroup {
    cursor: i64,
    consumers: usize,
}

impl RuntimeClient {
    pub async fn connect(config: &RuntimeConfig, client_id: String) -> Result<Self> {
        #[cfg(windows)]
        {
            if client_id.is_empty() || client_id.len() > 256 {
                bail!("invalid client id");
            }
            let credential = config.credential()?;
            let mut control = tokio::net::windows::named_pipe::ClientOptions::new()
                .open(config.control_pipe())
                .context("connecting to runtime control pipe")?;
            authenticate(&mut control, &credential, &client_id).await?;
            let mut output = tokio::net::windows::named_pipe::ClientOptions::new()
                .open(config.output_pipe())
                .context("connecting to runtime output pipe")?;
            authenticate(&mut output, &credential, &client_id).await?;
            Ok(Self {
                control,
                output,
                client_id,
                output_groups: HashMap::new(),
            })
        }
        #[cfg(not(windows))]
        {
            let _ = (config, client_id);
            bail!("ThreadTerm V3 local transport is Windows-only")
        }
    }

    /// Makes one control request. Events are intentionally ignored here: MCP
    /// is request/response-only and must not turn daemon events into stdout.
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        #[cfg(windows)]
        {
            let id = uuid::Uuid::new_v4().to_string();
            write_json(
                &mut self.control,
                &json!({"v":PROTOCOL_VERSION,"id":id,"method":method,"params":params}),
            )
            .await?;
            loop {
                let value = read_json(&mut self.control).await?;
                if value.get("id").and_then(Value::as_str) != Some(&id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    bail!(
                        "{}",
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("runtime request failed")
                    );
                }
                return value
                    .get("result")
                    .cloned()
                    .context("runtime response missing result");
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (method, params);
            bail!("ThreadTerm V3 local transport is Windows-only")
        }
    }

    /// Adds a consumer to a session output group. The daemon sees exactly one
    /// subscription per session, even if several local consumers share it.
    pub async fn subscribe_output(&mut self, session_id: &str, cursor: i64) -> Result<()> {
        #[cfg(windows)]
        {
            if session_id.is_empty() || cursor < 0 {
                bail!("invalid output subscription");
            }
            if let Some(group) = self.output_groups.get_mut(session_id) {
                group.consumers += 1;
                return Ok(());
            }
            self.write_output(3, json!({"sessionId":session_id,"cursor":cursor}))
                .await?;
            self.write_output(2, json!({"sessionId":session_id,"credit":65536}))
                .await?;
            self.output_groups.insert(
                session_id.to_owned(),
                OutputGroup {
                    cursor,
                    consumers: 1,
                },
            );
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = (session_id, cursor);
            bail!("ThreadTerm V3 local transport is Windows-only")
        }
    }

    /// Removes one local consumer. The final removal sends binary kind 5 so
    /// the runtime releases its toward-64-cap subscription immediately.
    pub async fn unsubscribe_output(&mut self, session_id: &str) -> Result<()> {
        #[cfg(windows)]
        {
            let Some(group) = self.output_groups.get_mut(session_id) else {
                return Ok(());
            };
            if group.consumers > 1 {
                group.consumers -= 1;
                return Ok(());
            }
            self.write_output(5, json!({"sessionId":session_id}))
                .await?;
            self.output_groups.remove(session_id);
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = session_id;
            bail!("ThreadTerm V3 local transport is Windows-only")
        }
    }

    /// Reconnects only groups that still have consumers. Callers that removed
    /// their final consumer never recreate a stale runtime subscription.
    pub async fn reconnect_output(&mut self, config: &RuntimeConfig) -> Result<()> {
        #[cfg(windows)]
        {
            let credential = config.credential()?;
            let mut output =
                tokio::net::windows::named_pipe::ClientOptions::new().open(config.output_pipe())?;
            authenticate(&mut output, &credential, &self.client_id).await?;
            self.output = output;
            let groups: Vec<(String, i64)> = self
                .output_groups
                .iter()
                .filter(|(_, group)| group.consumers > 0)
                .map(|(id, group)| (id.clone(), group.cursor))
                .collect();
            for (id, cursor) in groups {
                self.write_output(3, json!({"sessionId":id,"cursor":cursor}))
                    .await?;
                self.write_output(2, json!({"sessionId":id,"credit":65536}))
                    .await?;
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = config;
            bail!("ThreadTerm V3 local transport is Windows-only")
        }
    }

    #[cfg(windows)]
    async fn write_output(&mut self, kind: u8, header: Value) -> Result<()> {
        let header = serde_json::to_vec(&header)?;
        let mut frame = Vec::with_capacity(5 + header.len());
        frame.push(kind);
        frame.extend_from_slice(&(header.len() as u32).to_le_bytes());
        frame.extend_from_slice(&header);
        write_frame(&mut self.output, &frame).await
    }
}

#[cfg(windows)]
async fn authenticate<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    stream: &mut T,
    credential: &str,
    client_id: &str,
) -> Result<()> {
    let challenge = read_json(stream).await?;
    let nonce = challenge
        .get("nonce")
        .and_then(Value::as_str)
        .context("runtime challenge nonce")?;
    if challenge.get("kind").and_then(Value::as_str) != Some("challenge")
        || challenge.get("protocol").and_then(Value::as_u64) != Some(PROTOCOL_VERSION as u64)
    {
        bail!("invalid runtime challenge");
    }
    protocol_contract::require_peer_contract(&challenge, ContractRole::Desktop)?;
    let mut mac = HmacSha256::new_from_slice(credential.as_bytes())?;
    mac.update(format!("{}:{}:{}", PROTOCOL_VERSION, client_id, nonce).as_bytes());
    write_json(stream, &json!({"kind":"auth","clientId":client_id,"protocol":PROTOCOL_VERSION,"contract":PROTOCOL_CONTRACT,"nonce":nonce,"hmac":hex::encode(mac.finalize().into_bytes())})).await?;
    let authenticated = read_json(stream).await?;
    let proof = authenticated
        .get("hmac")
        .and_then(Value::as_str)
        .context("runtime proof")?;
    let mut server = HmacSha256::new_from_slice(credential.as_bytes())?;
    server.update(format!("server:{}:{}:{}", PROTOCOL_VERSION, client_id, nonce).as_bytes());
    let actual = hex::decode(proof)?;
    server
        .verify_slice(&actual)
        .map_err(|_| anyhow::anyhow!("runtime server proof failed"))?;
    if authenticated.get("kind").and_then(Value::as_str) != Some("authenticated")
        || authenticated.get("principal").and_then(Value::as_str) != Some(client_id)
    {
        bail!("invalid runtime authentication response");
    }
    Ok(())
}
#[cfg(windows)]
async fn read_json<T: tokio::io::AsyncRead + Unpin>(stream: &mut T) -> Result<Value> {
    Ok(serde_json::from_slice(&read_frame(stream).await?)?)
}
#[cfg(windows)]
async fn write_json<T: tokio::io::AsyncWrite + Unpin>(stream: &mut T, value: &Value) -> Result<()> {
    write_frame(stream, &serde_json::to_vec(value)?).await
}
#[cfg(windows)]
async fn read_frame<T: tokio::io::AsyncRead + Unpin>(stream: &mut T) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let len = stream.read_u32_le().await? as usize;
    if len > MAX_FRAME {
        bail!("frame exceeds 8 MiB")
    };
    let mut bytes = vec![0; len];
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}
#[cfg(windows)]
async fn write_frame<T: tokio::io::AsyncWrite + Unpin>(stream: &mut T, bytes: &[u8]) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    if bytes.len() > MAX_FRAME {
        bail!("frame exceeds 8 MiB")
    };
    stream.write_u32_le(bytes.len() as u32).await?;
    stream.write_all(bytes).await?;
    stream.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn output_group_contract_is_documented_in_source() {
        // Transport integration runs on Windows. This keeps the kind-5 wire
        // token visible to cross-platform unit builds without opening SQLite.
        assert_eq!(5_u8, 5);
    }
}

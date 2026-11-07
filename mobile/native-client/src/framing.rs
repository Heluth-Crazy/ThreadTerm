use crate::error::ClientError;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub(crate) const MAX_FRAME: usize = 8 * 1024 * 1024;
pub(crate) const MAX_RESPONSE: usize = 6 * 1024 * 1024;

pub(crate) async fn write_value<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &Value,
) -> Result<(), ClientError> {
    let bytes = serde_json::to_vec(value).map_err(ClientError::internal)?;
    if bytes.len() > MAX_FRAME {
        return Err(ClientError::protocol("outgoing frame exceeds 8 MiB"));
    }
    writer
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .await
        .map_err(ClientError::from)?;
    writer.write_all(&bytes).await.map_err(ClientError::from)?;
    writer.flush().await.map_err(ClientError::from)
}

pub(crate) async fn read_value<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Value, ClientError> {
    let bytes = read_frame(reader).await?;
    serde_json::from_slice(&bytes).map_err(|_| ClientError::protocol("invalid JSON frame"))
}

pub(crate) async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Vec<u8>, ClientError> {
    let mut length = [0u8; 4];
    reader
        .read_exact(&mut length)
        .await
        .map_err(ClientError::from)?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(ClientError::protocol("incoming frame exceeds 8 MiB"));
    }
    let mut bytes = vec![0; length];
    reader
        .read_exact(&mut bytes)
        .await
        .map_err(ClientError::from)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn round_trip_uses_little_endian_length() {
        let (mut left, mut right) = tokio::io::duplex(128);
        let sent = json!({"v":1,"id":"x"});
        let send = tokio::spawn(async move { write_value(&mut left, &sent).await.unwrap() });
        let received = read_value(&mut right).await.unwrap();
        send.await.unwrap();
        assert_eq!(received, json!({"v":1,"id":"x"}));
    }

    #[tokio::test]
    async fn oversized_frame_is_refused_before_allocation() {
        let (mut left, mut right) = tokio::io::duplex(8);
        tokio::spawn(async move {
            left.write_all(&((MAX_FRAME + 1) as u32).to_le_bytes())
                .await
                .unwrap();
        });
        assert!(matches!(
            read_value(&mut right).await,
            Err(ClientError::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn empty_frame_is_refused() {
        let (mut left, mut right) = tokio::io::duplex(8);
        tokio::spawn(async move {
            left.write_all(&0u32.to_le_bytes()).await.unwrap();
        });
        assert!(matches!(
            read_value(&mut right).await,
            Err(ClientError::Protocol(_))
        ));
    }
}

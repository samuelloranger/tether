use bytes::Bytes;
use russh::{ChannelMsg, ChannelReadHalf};
use tether_core::connect::ConnectError;
use tether_core::zmx::shell_quote;

use crate::connection::RusshConnection;

fn t(e: impl std::fmt::Display) -> ConnectError {
    ConnectError::Transport(e.to_string())
}

fn error_line(pending: &[u8]) -> Option<String> {
    let nl = pending.iter().skip(1).position(|b| *b == b'\n')? + 1;
    Some(String::from_utf8_lossy(&pending[1..nl]).trim().to_string())
}

async fn ack(read: &mut ChannelReadHalf, pending: &mut Vec<u8>) -> Result<(), ConnectError> {
    loop {
        if let Some(&code) = pending.first() {
            if code == 0 {
                pending.remove(0);
                return Ok(());
            }
            if let Some(msg) = error_line(pending) {
                return Err(ConnectError::Transport(msg));
            }
        }
        match read.wait().await {
            Some(ChannelMsg::Data { data }) => pending.extend_from_slice(&data),
            Some(ChannelMsg::Failure) => {
                return Err(ConnectError::Transport("the host refused scp".into()));
            }
            Some(ChannelMsg::Close) | None => {
                return Err(ConnectError::Transport("scp closed early".into()));
            }
            Some(_) => {}
        }
    }
}

impl RusshConnection {
    pub async fn scp_send(&self, remote_path: &str, bytes: &[u8]) -> Result<(), ConnectError> {
        let channel = {
            let handle = self.handle.read().await;
            handle.channel_open_session().await.map_err(t)?
        };
        let (mut read, write) = channel.split();
        let mut pending = Vec::new();
        write
            .exec(true, format!("scp -t -- {}", shell_quote(remote_path)))
            .await
            .map_err(t)?;
        ack(&mut read, &mut pending).await?;
        let name = remote_path
            .rsplit('/')
            .next()
            .unwrap_or(remote_path)
            .replace('\n', " ");
        write
            .data_bytes(Bytes::from(format!("C0644 {} {name}\n", bytes.len())))
            .await
            .map_err(t)?;
        ack(&mut read, &mut pending).await?;
        write
            .data_bytes(Bytes::copy_from_slice(bytes))
            .await
            .map_err(t)?;
        write
            .data_bytes(Bytes::from_static(&[0]))
            .await
            .map_err(t)?;
        ack(&mut read, &mut pending).await?;
        write.eof().await.map_err(t)?;
        while let Some(msg) = read.wait().await {
            if matches!(msg, ChannelMsg::Close) {
                break;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::error_line;

    #[test]
    fn a_leading_newline_is_not_a_panic() {
        assert_eq!(error_line(b"\n"), None);
        assert_eq!(error_line(b"\nrest\n"), Some("rest".into()));
    }

    #[test]
    fn the_message_follows_the_code_byte() {
        assert_eq!(error_line(b"\x01no space\n"), Some("no space".into()));
        assert_eq!(error_line(b"\x01partial"), None);
    }
}

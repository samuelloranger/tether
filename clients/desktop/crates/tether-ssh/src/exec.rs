use std::sync::{Arc, Mutex};

use bytes::Bytes;
use russh::{ChannelMsg, ChannelWriteHalf, client};
use tether_core::connect::ConnectError;
use tokio::sync::mpsc;

use crate::connection::RusshConnection;

const EVENTS_CAPACITY: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecEvent {
    Data(Vec<u8>),
    Exit(u32),
    Closed,
}

/// A command with its stdin and stdout held open, for a long-lived program such as the chat holder.
pub struct ExecChannel {
    pub writer: ExecWriter,
    pub events: mpsc::Receiver<ExecEvent>,
}

#[derive(Clone)]
pub struct ExecWriter {
    half: Arc<Mutex<Option<Arc<ChannelWriteHalf<client::Msg>>>>>,
    events: mpsc::Sender<ExecEvent>,
}

impl ExecWriter {
    fn active(&self) -> Option<Arc<ChannelWriteHalf<client::Msg>>> {
        self.half.lock().unwrap().clone()
    }

    pub async fn write(&self, bytes: &[u8]) -> Result<(), ConnectError> {
        let half = self
            .active()
            .ok_or_else(|| ConnectError::Transport("the channel is closed".into()))?;
        half.data_bytes(Bytes::copy_from_slice(bytes))
            .await
            .map_err(|e| ConnectError::Transport(e.to_string()))
    }

    pub async fn close(&self) {
        let Some(half) = self.half.lock().unwrap().take() else {
            return;
        };
        let _ = half.eof().await;
        let _ = half.close().await;
        // A channel closed from this side never wakes the reader.
        let _ = self.events.send(ExecEvent::Closed).await;
    }
}

impl RusshConnection {
    /// stderr is dropped: the holder speaks one JSON object per stdout line.
    pub async fn open_exec(&self, command: &str) -> Result<ExecChannel, ConnectError> {
        let t = |e: russh::Error| ConnectError::Transport(e.to_string());
        let channel = {
            let handle = self.handle.read().await;
            handle.channel_open_session().await.map_err(t)?
        };
        let (mut read, write) = channel.split();
        write.exec(true, command).await.map_err(t)?;
        // Output can race the reply to the request; it belongs to the stream.
        let first = loop {
            match read.wait().await {
                Some(ChannelMsg::Success) => break None,
                Some(ChannelMsg::Failure) => {
                    return Err(ConnectError::Transport(
                        "the host refused the command".into(),
                    ));
                }
                Some(ChannelMsg::Data { data }) => break Some(data.to_vec()),
                Some(_) => continue,
                None => return Err(ConnectError::Transport("the channel closed".into())),
            }
        };
        let (tx, rx) = mpsc::channel(EVENTS_CAPACITY);
        let events = tx.clone();
        self.runtime.spawn(async move {
            if let Some(bytes) = first
                && tx.send(ExecEvent::Data(bytes)).await.is_err()
            {
                return;
            }
            while let Some(msg) = read.wait().await {
                let event = match msg {
                    ChannelMsg::Data { data } => ExecEvent::Data(data.to_vec()),
                    ChannelMsg::ExitStatus { exit_status } => ExecEvent::Exit(exit_status),
                    ChannelMsg::Close => break,
                    _ => continue,
                };
                if tx.send(event).await.is_err() {
                    return;
                }
            }
            let _ = tx.send(ExecEvent::Closed).await;
        });
        Ok(ExecChannel {
            writer: ExecWriter {
                half: Arc::new(Mutex::new(Some(Arc::new(write)))),
                events,
            },
            events: rx,
        })
    }
}

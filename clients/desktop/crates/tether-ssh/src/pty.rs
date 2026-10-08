use std::sync::{Arc, Mutex};

use bytes::Bytes;
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf, client};
use tether_core::connect::ConnectError;
use tether_core::resize::GridSize;
use tokio::sync::mpsc;

use crate::connection::RusshConnection;

pub const PTY_TERM: &str = "xterm-256color";
const EVENTS_CAPACITY: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    Data(Vec<u8>),
    Closed,
}

pub struct PtyChannel {
    pub writer: PtyWriter,
    pub events: mpsc::Receiver<PtyEvent>,
}

#[derive(Clone)]
pub struct PtyWriter {
    half: Arc<Mutex<Option<Arc<ChannelWriteHalf<client::Msg>>>>>,
    events: mpsc::Sender<PtyEvent>,
}

impl PtyWriter {
    fn active(&self) -> Option<Arc<ChannelWriteHalf<client::Msg>>> {
        self.half.lock().unwrap().clone()
    }

    pub async fn write(&self, bytes: &[u8]) {
        let Some(half) = self.active() else {
            return;
        };
        if let Err(e) = half.data_bytes(Bytes::copy_from_slice(bytes)).await {
            tracing::debug!("pty write dropped: {e}");
        }
    }

    pub async fn resize(&self, size: GridSize) {
        let Some(half) = self.active() else {
            return;
        };
        let r = half
            .window_change(
                size.cols.into(),
                size.rows.into(),
                size.width_px,
                size.height_px,
            )
            .await;
        if let Err(e) = r {
            tracing::debug!("pty resize dropped: {e}");
        }
    }

    pub async fn close(&self) {
        let Some(half) = self.half.lock().unwrap().take() else {
            return;
        };
        let _ = half.eof().await;
        let _ = half.close().await;
        let _ = self.events.send(PtyEvent::Closed).await;
    }
}

async fn expect_success(read: &mut ChannelReadHalf, what: &str) -> Result<(), ConnectError> {
    loop {
        match read.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure) => {
                return Err(ConnectError::Transport(format!(
                    "the host refused the {what}"
                )));
            }
            Some(_) => continue,
            None => return Err(ConnectError::Transport("the channel closed".into())),
        }
    }
}

impl RusshConnection {
    pub async fn open_pty(&self, size: GridSize) -> Result<PtyChannel, ConnectError> {
        let channel = {
            let handle = self.handle.read().await;
            handle
                .channel_open_session()
                .await
                .map_err(|e| ConnectError::Transport(e.to_string()))?
        };
        let (mut read, write) = channel.split();
        let t = |e: russh::Error| ConnectError::Transport(e.to_string());
        write
            .request_pty(
                true,
                PTY_TERM,
                size.cols.into(),
                size.rows.into(),
                size.width_px,
                size.height_px,
                &[],
            )
            .await
            .map_err(t)?;
        expect_success(&mut read, "terminal").await?;
        write.request_shell(true).await.map_err(t)?;
        expect_success(&mut read, "shell").await?;
        let (tx, rx) = mpsc::channel(EVENTS_CAPACITY);
        let reader_tx = tx.clone();
        self.runtime.spawn(async move {
            loop {
                let Some(msg) = read.wait().await else {
                    break;
                };
                match msg {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        if reader_tx.send(PtyEvent::Data(data.to_vec())).await.is_err() {
                            return;
                        }
                    }
                    ChannelMsg::Close | ChannelMsg::Eof => break,
                    _ => {}
                }
            }
            let _ = reader_tx.send(PtyEvent::Closed).await;
        });
        write
            .window_change(
                size.cols.into(),
                size.rows.into(),
                size.width_px,
                size.height_px,
            )
            .await
            .map_err(t)?;
        // Give the shared session task a tick to flush the window-change before we return.
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        Ok(PtyChannel {
            writer: PtyWriter {
                half: Arc::new(Mutex::new(Some(Arc::new(write)))),
                events: tx.clone(),
            },
            events: rx,
        })
    }
}

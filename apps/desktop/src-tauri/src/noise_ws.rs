use futures_util::{SinkExt, StreamExt};
use tether_core::noise::driver::Transport;
use tether_core::noise::NoiseError;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// WebSocket transport for the Noise handshake drivers: binary frames only.
pub struct NoiseWs {
    sink: futures_util::stream::SplitSink<WsStream, Message>,
    stream: futures_util::stream::SplitStream<WsStream>,
}

impl NoiseWs {
    pub fn new(ws: WsStream) -> Self {
        let (sink, stream) = ws.split();
        Self { sink, stream }
    }

    pub async fn connect(address: &str) -> Result<Self, NoiseError> {
        let (ws, _) = tokio_tungstenite::connect_async(address)
            .await
            .map_err(|_| NoiseError::Transport)?;
        Ok(Self::new(ws))
    }
}

impl Transport for NoiseWs {
    async fn send(&mut self, frame: Vec<u8>) -> Result<(), NoiseError> {
        self.sink
            .send(Message::Binary(frame))
            .await
            .map_err(|_| NoiseError::Transport)
    }

    async fn recv(&mut self) -> Result<Vec<u8>, NoiseError> {
        loop {
            match self.stream.next().await {
                Some(Ok(Message::Binary(data))) => return Ok(data),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                Some(Ok(Message::Frame(_))) => continue,
                Some(Ok(Message::Text(_) | Message::Close(_))) | None | Some(Err(_)) => {
                    return Err(NoiseError::Transport);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    async fn spawn_echo_server() -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            while let Some(Ok(msg)) = ws.next().await {
                match msg {
                    Message::Binary(data) => {
                        ws.send(Message::Binary(data)).await.unwrap();
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });
        (format!("ws://{addr}"), handle)
    }

    #[tokio::test]
    async fn binary_frames_roundtrip() {
        let (url, server) = spawn_echo_server().await;
        let mut t = NoiseWs::connect(&url).await.unwrap();
        t.send(vec![1, 2, 3]).await.unwrap();
        assert_eq!(t.recv().await.unwrap(), vec![1, 2, 3]);
        t.send(vec![9, 9]).await.unwrap();
        assert_eq!(t.recv().await.unwrap(), vec![9, 9]);
        drop(t);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn peer_close_is_a_transport_error() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let ws = accept_async(stream).await.unwrap();
            drop(ws);
        });
        let mut t = NoiseWs::connect(&format!("ws://{addr}")).await.unwrap();
        let err = t.recv().await.expect_err("closed socket must error");
        assert!(matches!(err, NoiseError::Transport));
        server.await.unwrap();
    }
}

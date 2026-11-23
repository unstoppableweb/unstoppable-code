//! One account socket, multiplexed into independent peer sessions.
//! Mirrors `lib/device_link/desktop/relay.dart`: presence, per-peer channels,
//! 10 s pings with a 30 s idle limit, and `probe` liveness checks.
use crate::{
    auth::secure_url,
    error::{Error, Result, field},
};
use cc_app::ports::{Notice, Notify};
use cc_protocol::{
    relay::{
        INVALID_MESSAGE, MAX_TEXT_UNITS, OFFLINE, OUTDATED, STREAM_FAILED, UNREACHABLE, UNREADABLE,
        computer, frame_peer, is_computer, unreadable_peer, utf16_len,
    },
    secure,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    time::{Instant, MissedTickBehavior, interval_at, sleep, timeout},
};
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{Message, client::IntoClientRequest},
};

/// What a peer channel receives: a whole relay frame, or why it ended.
pub(crate) enum Inbound {
    Frame(Vec<u8>),
    Closed { code: &'static str, reason: String },
}

/// How long one write may wait for the socket before the relay closes.
const WRITE_LIMIT: Duration = Duration::from_secs(30);
/// How long a closing relay keeps flushing, and then closing, its socket.
const CLOSE_LIMIT: Duration = Duration::from_secs(2);
const CLOSED: &str = "Relay closed the socket.";
const STALLED: &str = "The relay stopped accepting messages.";

type Channels = Arc<Mutex<HashMap<String, (u64, mpsc::UnboundedSender<Inbound>)>>>;

/// The byte stream for one peer. Dropping it releases the peer's slot.
pub(crate) struct Socket {
    peer: String,
    token: u64,
    tx: mpsc::Sender<Message>,
    ended: watch::Receiver<bool>,
    rx: mpsc::UnboundedReceiver<Inbound>,
    channels: Channels,
}
impl Socket {
    /// Queues a frame, waiting while the queue is full. Fails once the relay
    /// ended, also while waiting.
    pub(crate) async fn send(&mut self, frame: Vec<u8>) -> Result<()> {
        let closed = || Error::local("relay_closed", "The relay disconnected.");
        tokio::select! {
            biased;
            _ = self.ended.wait_for(|ended| *ended) => Err(closed()),
            sent = self.tx.send(Message::Binary(frame.into())) => sent.map_err(|_| closed()),
        }
    }
    pub(crate) async fn next(&mut self) -> Option<Inbound> {
        self.rx.recv().await
    }
}
impl Drop for Socket {
    fn drop(&mut self) {
        if let Ok(mut channels) = self.channels.lock()
            && channels
                .get(&self.peer)
                .is_some_and(|(t, _)| *t == self.token)
        {
            channels.remove(&self.peer);
        }
    }
}

#[derive(Default)]
struct Life {
    announced: bool,
    ended: bool,
}
struct Shared {
    peers: Mutex<Vec<Value>>,
    channels: Channels,
    life: Mutex<Life>,
    notify: Notify,
    closing: AtomicBool,
}
impl Shared {
    fn peers(&self) -> Vec<Value> {
        self.peers.lock().map(|p| p.clone()).unwrap_or_default()
    }
    fn changed(&self) {
        let peers = self.peers();
        if let Ok(life) = self.life.lock()
            && life.announced
            && !life.ended
        {
            (self.notify)(Notice::Peers(peers));
        }
    }
    fn close_channel(&self, peer: &str, code: &'static str, reason: &str) {
        let channel = self.channels.lock().ok().and_then(|mut c| c.remove(peer));
        if let Some((_, channel)) = channel {
            let _ = channel.send(Inbound::Closed {
                code,
                reason: reason.into(),
            });
        }
    }
}

enum Control {
    Probe(oneshot::Sender<bool>),
    Close(String),
}

pub(crate) struct Relay {
    tx: mpsc::Sender<Message>,
    ended: watch::Receiver<bool>,
    control: mpsc::UnboundedSender<Control>,
    shared: Arc<Shared>,
    tokens: AtomicU64,
    task: tokio::task::JoinHandle<()>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
impl Relay {
    pub(crate) async fn open(
        token: &Value,
        seed: [u8; 32],
        name: &str,
        platform: &str,
        notify: Notify,
    ) -> Result<Self> {
        let opening = || Error::local("relay_connect", "Could not open the device relay.");
        let mut url = secure_url(field(token, "relayUrl")?, true)
            .map_err(|_| Error::local("invalid_relay", "Invalid relay URL."))?;
        url.set_path("/v2/connect");
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| Error::local("invalid_relay", "Invalid relay URL."))?;
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            format!(
                "canopy-device-relay.v2, canopy-relay-token.{}",
                field(token, "token")?
            )
            .parse()
            .map_err(|_| Error::new("invalid_token"))?,
        );
        let (mut socket, response) = timeout(
            Duration::from_secs(15),
            connect_async_tls_with_config(
                request,
                None,
                false,
                crate::tls::websocket_connector().ok().flatten(),
            ),
        )
        .await
        .map_err(|_| opening())?
        .map_err(|_| opening())?;
        let registered: Result<Vec<Value>> = async {
            if response
                .headers()
                .get("Sec-WebSocket-Protocol")
                .and_then(|h| h.to_str().ok())
                != Some("canopy-device-relay.v2")
            {
                return Err(Error::local(
                    "relay_protocol",
                    "Unsupported relay protocol.",
                ));
            }
            let key = secure::encode(
                &ed25519_dalek::SigningKey::from_bytes(&seed)
                    .verifying_key()
                    .to_bytes(),
            );
            let id = secure::device_id(&key)?;
            let hello = cc_protocol::relay::hello(&id, &key, name, platform);
            timeout(
                Duration::from_secs(15),
                socket.send(Message::Text(hello.to_string().into())),
            )
            .await
            .map_err(|_| opening())?
            .map_err(|_| opening())?;
            let before = || Error::local("relay_closed", "The relay closed before registration.");
            let raw = timeout(Duration::from_secs(15), async {
                loop {
                    match socket.next().await {
                        Some(Ok(Message::Text(raw))) => return Ok(raw),
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                        _ => return Err(before()),
                    }
                }
            })
            .await
            .map_err(|_| before())??;
            if utf16_len(&raw) > MAX_TEXT_UNITS {
                return Err(before());
            }
            let ready: Value = serde_json::from_str(&raw).map_err(|_| before())?;
            if ready["type"] != "ready" || ready["deviceId"] != id || !ready["peers"].is_array() {
                return Err(before());
            }
            if !ready["features"]
                .as_array()
                .is_some_and(|a| a.contains(&json!("device-kind")))
            {
                return Err(Error::local("relay_outdated", OUTDATED));
            }
            let mut peers = Vec::new();
            for peer in ready["peers"].as_array().into_iter().flatten() {
                // Dart closes the relay, so the opening fails as "closed before
                // registration".
                if computer(peer).map_err(|_| before())? {
                    peers.push(peer.clone());
                }
            }
            Ok(peers)
        }
        .await;
        let peers = match registered {
            Ok(peers) => peers,
            Err(error) => {
                let _ = timeout(Duration::from_secs(2), socket.close(None)).await;
                return Err(error);
            }
        };
        let shared = Arc::new(Shared {
            peers: Mutex::new(peers),
            channels: Arc::new(Mutex::new(HashMap::new())),
            life: Mutex::new(Life::default()),
            notify,
            closing: AtomicBool::new(false),
        });
        let (sink, stream) = socket.split();
        let (tx, rx) = mpsc::channel(256);
        let (control, control_rx) = mpsc::unbounded_channel();
        let (writer_done, writer_done_rx) = oneshot::channel();
        let (end, ended) = watch::channel(false);
        tokio::spawn(write(sink, rx, writer_done, ended.clone()));
        let task = tokio::spawn(run(
            stream,
            tx.clone(),
            control_rx,
            writer_done_rx,
            end,
            shared.clone(),
        ));
        Ok(Self {
            tx,
            ended,
            control,
            shared,
            tokens: AtomicU64::new(1),
            task,
        })
    }
    pub(crate) fn alive(&self) -> bool {
        !self.task.is_finished() && !self.shared.closing.load(Ordering::SeqCst)
    }
    /// Marks the socket as opened and reports it with its peers, unless it
    /// already ended. Every announced relay later reports `Closed`.
    pub(crate) fn announce(&self) -> bool {
        let peers = self.shared.peers();
        let Ok(mut life) = self.shared.life.lock() else {
            return false;
        };
        if life.ended || self.shared.closing.load(Ordering::SeqCst) {
            return false;
        }
        life.announced = true;
        (self.shared.notify)(Notice::Opened(peers));
        true
    }
    pub(crate) fn peers(&self) -> Vec<Value> {
        if self.alive() {
            self.shared.peers()
        } else {
            Vec::new()
        }
    }
    pub(crate) fn peer(&self, id: &str) -> Option<Value> {
        self.shared
            .peers()
            .into_iter()
            .find(|p| p["deviceId"] == id)
    }
    /// One session per computer. Close the old session first to replace it.
    pub(crate) fn channel(&self, peer: &str) -> Result<Socket> {
        if !self.alive() {
            return Err(Error::local("relay_closed", "The relay disconnected."));
        }
        let mut channels = self
            .shared
            .channels
            .lock()
            .map_err(|_| Error::new("relay_closed"))?;
        if channels.contains_key(peer) {
            return Err(Error::local(
                "session_exists",
                "This computer already has a session.",
            ));
        }
        let token = self.tokens.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::unbounded_channel();
        channels.insert(peer.into(), (token, tx));
        Ok(Socket {
            peer: peer.into(),
            token,
            tx: self.tx.clone(),
            ended: self.ended.clone(),
            rx,
            channels: self.shared.channels.clone(),
        })
    }
    pub(crate) fn close(&self, reason: &str) {
        self.shared.closing.store(true, Ordering::SeqCst);
        let _ = self.control.send(Control::Close(reason.into()));
    }
    /// Checks the socket still reaches the relay. Closes it when no matching
    /// pong arrives in time.
    pub(crate) async fn probe(&self, limit: Duration) -> bool {
        if !self.alive() {
            return false;
        }
        let (reply, answered) = oneshot::channel();
        if self.control.send(Control::Probe(reply)).is_err() {
            return false;
        }
        match timeout(limit, answered).await {
            Ok(answer) => answer.unwrap_or(false),
            Err(_) => {
                self.close("The relay did not answer a liveness check.");
                false
            }
        }
    }
}
impl Drop for Relay {
    fn drop(&mut self) {
        self.close("Closed by this device.");
    }
}

type Sink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;
type Stream = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;

/// Writes queued messages until the relay ends, then flushes for at most
/// `CLOSE_LIMIT` and closes the socket. Reports why it stopped.
async fn write(
    mut sink: Sink,
    mut rx: mpsc::Receiver<Message>,
    done: oneshot::Sender<&'static str>,
    mut ended: watch::Receiver<bool>,
) {
    let reason = tokio::select! {
        reason = flush(&mut sink, &mut rx) => reason,
        () = async {
            let _ = ended.wait_for(|ended| *ended).await;
            sleep(CLOSE_LIMIT).await;
        } => CLOSED,
    };
    drop(rx);
    let _ = timeout(CLOSE_LIMIT, sink.close()).await;
    let _ = done.send(reason);
}

async fn flush(sink: &mut Sink, rx: &mut mpsc::Receiver<Message>) -> &'static str {
    while let Some(message) = rx.recv().await {
        let last = matches!(message, Message::Close(_));
        match timeout(WRITE_LIMIT, sink.send(message)).await {
            Err(_) => return STALLED,
            Ok(Err(_)) => return CLOSED,
            Ok(Ok(())) if last => break,
            Ok(Ok(())) => {}
        }
    }
    CLOSED
}

async fn run(
    mut stream: Stream,
    tx: mpsc::Sender<Message>,
    mut control: mpsc::UnboundedReceiver<Control>,
    mut writer_done: oneshot::Receiver<&'static str>,
    end: watch::Sender<bool>,
    shared: Arc<Shared>,
) {
    let mut ping = interval_at(
        Instant::now() + Duration::from_secs(10),
        Duration::from_secs(10),
    );
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_inbound = Instant::now();
    let mut last_sent = 0u64;
    let mut sent_at = || {
        last_sent = now_ms().max(last_sent + 1);
        last_sent
    };
    let mut probe: Option<(u64, Vec<oneshot::Sender<bool>>)> = None;
    let reason: String = loop {
        tokio::select! {
            message = stream.next() => {
                last_inbound = Instant::now();
                match message {
                    Some(Ok(Message::Binary(b))) => if let Err(reason) = route(&shared, &b) { break reason.into(); },
                    Some(Ok(Message::Text(t))) => match text(&shared, &t, &mut probe) {
                        Ok(()) => {}
                        Err(reason) => break reason.into(),
                    },
                    Some(Ok(Message::Close(frame))) => break match frame {
                        Some(f) if !f.reason.is_empty() => format!("Relay closed the socket (code {}, {}).", u16::from(f.code), f.reason),
                        Some(f) => format!("Relay closed the socket (code {}).", u16::from(f.code)),
                        None => CLOSED.into(),
                    },
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break STREAM_FAILED.into(),
                    None => break CLOSED.into(),
                }
            }
            command = control.recv() => match command {
                Some(Control::Probe(reply)) => match &mut probe {
                    Some((_, waiters)) => waiters.push(reply),
                    None => {
                        let at = sent_at();
                        if tx.try_send(Message::Text(json!({"type":"ping","sentAt":at}).to_string().into())).is_err() {
                            let _ = reply.send(false);
                        } else {
                            probe = Some((at, vec![reply]));
                        }
                    }
                },
                Some(Control::Close(reason)) => break reason,
                None => break "Closed by this device.".into(),
            },
            _ = ping.tick() => {
                if last_inbound.elapsed() > Duration::from_secs(30) {
                    break "No relay traffic for 30 seconds.".into();
                }
                let at = sent_at();
                let _ = tx.try_send(Message::Text(json!({"type":"ping","sentAt":at}).to_string().into()));
            }
            reason = &mut writer_done => break reason.unwrap_or(CLOSED).into(),
        }
    };
    shared.closing.store(true, Ordering::SeqCst);
    let channels: Vec<_> = shared
        .channels
        .lock()
        .map(|mut c| c.drain().collect())
        .unwrap_or_default();
    for (_, (_, channel)) in channels {
        let _ = channel.send(Inbound::Closed {
            code: "relay_closed",
            reason: reason.clone(),
        });
    }
    for waiter in probe.into_iter().flat_map(|(_, w)| w) {
        let _ = waiter.send(false);
    }
    if let Ok(mut life) = shared.life.lock() {
        life.ended = true;
        if life.announced {
            (shared.notify)(Notice::Closed(reason));
        }
    }
    let _ = tx.try_send(Message::Close(None));
    end.send_replace(true);
}

fn route(shared: &Shared, b: &[u8]) -> std::result::Result<(), &'static str> {
    let peer = frame_peer(b)?;
    if let Ok(channels) = shared.channels.lock()
        && let Some((_, channel)) = channels.get(peer)
    {
        let _ = channel.send(Inbound::Frame(b.to_vec()));
    }
    Ok(())
}

fn text(
    shared: &Shared,
    raw: &str,
    probe: &mut Option<(u64, Vec<oneshot::Sender<bool>>)>,
) -> std::result::Result<(), &'static str> {
    if utf16_len(raw) > MAX_TEXT_UNITS {
        return Err(UNREADABLE);
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| UNREADABLE)?;
    if !value.is_object() {
        return Err(INVALID_MESSAGE);
    }
    match value["type"].as_str() {
        Some("peer.online") => {
            if is_computer(&value["peer"]) {
                if let Some(reason) = unreadable_peer(&value["peer"]) {
                    return Err(reason);
                }
                if let Ok(mut peers) = shared.peers.lock() {
                    let id = &value["peer"]["deviceId"];
                    match peers.iter_mut().find(|p| &p["deviceId"] == id) {
                        Some(existing) => *existing = value["peer"].clone(),
                        None => peers.push(value["peer"].clone()),
                    }
                }
                shared.changed();
            }
        }
        Some("peer.offline") => {
            let id = value["deviceId"].as_str();
            if let (Some(id), Ok(mut peers)) = (id, shared.peers.lock()) {
                peers.retain(|p| p["deviceId"] != id);
            }
            shared.changed();
            if let Some(id) = id {
                shared.close_channel(id, "peer_offline", OFFLINE);
            }
        }
        Some("undeliverable") => {
            if let Some(id) = value["deviceId"].as_str() {
                shared.close_channel(id, "undeliverable", UNREACHABLE);
            }
        }
        Some("pong") => {
            if let Some((at, _)) = probe
                && value["sentAt"].as_u64() == Some(*at)
                && let Some((_, waiters)) = probe.take()
            {
                for waiter in waiters {
                    let _ = waiter.send(true);
                }
            }
        }
        Some("error") => return Err("The relay refused this connection."),
        _ => return Err(UNREADABLE),
    }
    Ok(())
}

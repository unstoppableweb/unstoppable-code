//! The account's relay and per-computer sessions. No core-wide lock is held
//! across a network wait: sessions and the relay are actors, connects are
//! cancellable, and every call completes on its own. Session calls are taken
//! in submission order by one dispatcher task.
use crate::{
    account::{self, Scope},
    api::{BridgeEvent, BridgeMessage, CoreFailure, IdentityImport, SessionCall},
    cache::Cache,
    chats::Peer,
    computers::{Msg, Signal},
    error::{Error, Result, field, required},
    interest::{self, Arbiter, Holder},
    outbox::Outbox,
    overview,
    ports::{
        AuthPort, AuthSession, Command, Emit, Notice, PeerSession, RelayConnector, RelayPort,
        Responder, StorePort,
    },
    push::Fanout,
};
use cc_protocol::rpc::{
    self, LOCAL_CLOSE, MIN_PROTOCOL, check_version, hello_params, no_session, not_connected,
    not_sent, read_version,
};
use futures_util::future::join_all;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard, Weak,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    runtime::Handle,
    sync::oneshot,
    sync::{mpsc, watch},
    task::JoinHandle,
    time::timeout,
};

const OFFLINE_OR_OFF: &str = "This computer is offline or remote access is turned off.";
const STOP_LIMIT: Duration = Duration::from_secs(5);
const MAX_TIMEOUT_MS: u64 = 900_000;
const MAX_JSON_DEPTH: usize = 2048;

/// The surfaces a core service talks on: the desktop's main window and
/// its Orchestrator (`app-advisor`) renderer.
pub(crate) const MAIN: &str = "main";
pub(crate) const APP_ADVISOR: &str = "app-advisor";

/// The compatibility path without a session of its scope: Dart's
/// `not_connected`, or `account_changed` once the scope ended.
fn connect_first(error: Error) -> Error {
    if error.code == "account_changed" {
        error
    } else {
        not_connected()
    }
}
fn cancelled() -> Error {
    Error::local("cancelled", "Connection cancelled.")
}
pub(crate) fn shutdown_failure() -> Error {
    Error::local("shutdown", "The connection ended.")
}
/// A connect's abort signal fired: set, or its sender dropped.
fn fired(abort: &watch::Receiver<bool>) -> bool {
    *abort.borrow() || abort.has_changed().is_err()
}
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}
pub(crate) fn computer_id(id: &str) -> Result<&str> {
    if !cc_domain::computers::valid_computer_id(id) {
        return Err(Error::new("invalid_input"));
    }
    Ok(id)
}

enum Slot {
    Connecting {
        generation: u64,
        /// `Some(polite)` cancels; `polite` sends `close` to a session that
        /// already has a secure channel, as Dart's repository `disconnect`.
        cancel: watch::Sender<Option<bool>>,
        done: watch::Receiver<bool>,
    },
    /// A finished task means the session ended on its own; requests then fail
    /// `not_sent` until `disconnect` or `connect`, as in Dart.
    Connected {
        /// Its connect's generation, as [`Inner::newest`] numbers it.
        generation: u64,
        commands: mpsc::UnboundedSender<Command>,
        task: JoinHandle<()>,
        /// Set when the session ended in a way that also closed Dart's relay
        /// channel for the computer (relay closed, computer offline or
        /// unreachable). Otherwise the ended session keeps the channel until
        /// `disconnect`, and another connection to the computer is refused.
        released: Arc<AtomicBool>,
        relay: Weak<dyn RelayPort>,
        /// The session's events; also its `closed` when it is aborted.
        emit: Emit,
    },
}
impl Slot {
    /// Dart's `channelFor` refuses a second channel for a computer while
    /// this one holds it.
    fn holds_channel(&self) -> bool {
        match self {
            Slot::Connecting { .. } => true,
            Slot::Connected {
                task,
                released,
                relay,
                ..
            } => {
                !task.is_finished()
                    || (!released.load(Ordering::SeqCst)
                        && relay.upgrade().is_some_and(|r| r.alive()))
            }
        }
    }
}

/// The connect step a cancellation interrupted, as Dart words it.
const STEP_RELAY: u8 = 0;
const STEP_HANDSHAKE: u8 = 1;
const STEP_REQUEST: u8 = 2;
fn cancelled_at(step: u8) -> Error {
    let (name, message) = match step {
        // A handshake ends under `_establish`: session.dart:103-105.
        STEP_HANDSHAKE => ("handshake", "The secure connection did not finish."),
        // A waiting `pair.request` or `session.hello`: session.dart:359-371.
        STEP_REQUEST => ("request", rpc::ENDED),
        // Relay open or between steps: repository.dart generation checks.
        _ => ("relay", "Connection cancelled."),
    };
    let mut error = Error::local("cancelled", message);
    error.step = Some(name);
    error
}

/// The sessions and relay [`Inner::take_all`] took, for
/// [`Inner::end_taken`].
pub(crate) struct Taken {
    slots: Vec<(String, Slot)>,
    relay: Option<Arc<dyn RelayPort>>,
}

#[derive(Default)]
struct RelaySlot {
    current: Option<Arc<dyn RelayPort>>,
    generation: u64,
    /// The relays opened so far; each opening's notices carry its number.
    openings: u64,
}

/// Which relay's notices reach the services and the app.
#[derive(Default)]
struct Reporting {
    /// The opening announced last. A relay it replaced, or one taken and
    /// closed later, reports nothing more: its late `Closed` must not clear
    /// what its replacement found.
    opening: u64,
    /// The notices forwarded so far; each forwarded notice is numbered.
    seq: u64,
}

/// The relay as the account service sees it once notice `seq` applied.
#[derive(Default)]
pub(crate) struct RelaySnapshot {
    pub(crate) seq: u64,
    /// Its peers with `paired`; `None` while no relay is open.
    pub(crate) peers: Option<Vec<Value>>,
}

pub(crate) struct Inner {
    pub(crate) auth: Arc<dyn AuthPort>,
    pub(crate) store: Arc<dyn StorePort>,
    relays: Arc<dyn RelayConnector>,
    pub(crate) cache: Cache,
    relay: Mutex<RelaySlot>,
    reporting: Mutex<Reporting>,
    relay_open: tokio::sync::Mutex<()>,
    sessions: Mutex<HashMap<String, Slot>>,
    /// Each computer's newest session, by its connect's generation: only
    /// its events are delivered, never those of an earlier session that is
    /// still ending, and none after its `closed` (0: no session's).
    newest: Mutex<HashMap<String, Arc<Mutex<u64>>>>,
    visibility: Mutex<HashMap<String, bool>>,
    /// This core, for work that must outlive a cancelled call.
    this: Weak<Inner>,
    generation: AtomicU64,
    /// The account scope and its account; leaving the account moves it on.
    pub(crate) scopes: watch::Sender<Arc<account::Epoch>>,
    /// The current scope's record writes.
    pub(crate) writers: Mutex<account::Writers>,
    /// The latest scope whose earlier scopes stored their records.
    pub(crate) settled: Arc<watch::Sender<u64>>,
    /// The services that store their records when asked.
    pub(crate) flushers: Mutex<Vec<account::Flusher>>,
    /// Replies to session calls and every event, in emission order.
    pub(crate) outbox: Outbox<BridgeMessage>,
    /// Session calls with the account scope each was made in.
    calls: mpsc::UnboundedSender<(i64, Scope, SessionCall)>,
    shutdown_tx: watch::Sender<bool>,
    shutdown: watch::Receiver<bool>,
    /// The account service's inbox: relay and session signals.
    signals: Mutex<Option<mpsc::UnboundedSender<Msg>>>,
    /// The single writer of every computer's chat interest.
    interest: Mutex<Arbiter>,
    /// Each computer's current overview service; a newer one replaces it.
    overviews: Mutex<HashMap<String, (account::Scope, mpsc::UnboundedSender<overview::Msg>)>>,
    /// Desktop pushes and new sessions, fanned out to the stores.
    pub(crate) pushes: Fanout,
    /// The hosted API origin saved records name.
    pub(crate) origin: String,
    name: String,
    platform: String,
}

/// A session event from the port's JSON form.
fn event(v: &Value) -> Option<BridgeEvent> {
    let computer_id = v["computerId"].as_str().unwrap_or_default().to_owned();
    match v["event"].as_str()? {
        "event" => Some(BridgeEvent::Message {
            computer_id,
            message_json: v["message"].to_string(),
        }),
        "closed" => Some(BridgeEvent::Closed {
            computer_id,
            code: v["code"].as_str().unwrap_or_default().into(),
            reason: v["reason"].as_str().unwrap_or_default().into(),
        }),
        "pairingCode" => Some(BridgeEvent::PairingCode {
            computer_id,
            code: v["code"].as_str().unwrap_or_default().into(),
        }),
        _ => None,
    }
}

/// Parses JSON. Nesting is bounded here instead of by serde's recursion
/// limit, so values nested as deep as Dart's writer allows (128 V8 levels
/// plus bridge wrappers and the call envelope) parse. `depth` is the nesting
/// the value already has in its call.
pub(crate) fn parse_json(raw: &[u8], depth: usize) -> Result<Value> {
    let (mut depth, mut deepest, mut in_string, mut escaped) = (depth, depth, false, false);
    for &b in raw {
        if in_string {
            match (escaped, b) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    if deepest > MAX_JSON_DEPTH {
        return Err(Error::new("invalid_json"));
    }
    let mut de = serde_json::Deserializer::from_slice(raw);
    de.disable_recursion_limit();
    let value = <Value as serde::Deserialize>::deserialize(&mut de)
        .map_err(|_| Error::new("invalid_json"))?;
    de.end().map_err(|_| Error::new("invalid_json"))?;
    Ok(value)
}

/// A session call with its arguments parsed.
enum Parsed {
    Connect {
        computer_id: String,
        allow_pairing: bool,
        visible: Option<bool>,
    },
    Invoke {
        computer_id: String,
        channel: String,
        args: Value,
        surface: Option<String>,
        timeout_ms: Option<u64>,
    },
    HostInfo {
        computer_id: String,
    },
    Visible {
        computer_id: String,
        visible: bool,
    },
}
fn parse(call: SessionCall) -> Result<Parsed> {
    Ok(match call {
        SessionCall::Connect {
            computer_id,
            allow_pairing,
            visible,
        } => Parsed::Connect {
            computer_id,
            allow_pairing: allow_pairing.unwrap_or(true),
            visible,
        },
        SessionCall::Invoke {
            computer_id,
            channel,
            args_json,
            surface,
            timeout_ms,
        } => Parsed::Invoke {
            computer_id,
            channel,
            // `args` sits inside the call object.
            args: parse_json(args_json.as_bytes(), 1)?,
            surface,
            timeout_ms,
        },
        SessionCall::HostInfo { computer_id } => Parsed::HostInfo { computer_id },
        SessionCall::SetOrchestratorVisible {
            computer_id,
            visible,
        } => Parsed::Visible {
            computer_id,
            visible,
        },
    })
}
fn parse_large(call: &SessionCall) -> bool {
    matches!(call, SessionCall::Invoke { args_json, .. } if args_json.len() > 256 * 1024)
}

/// Takes session calls in submission order. Requests are queued on their
/// session here, before the next call is read; a connect runs as its own
/// task. Each call acts only in the account scope it was made in.
async fn dispatch(
    inner: Weak<Inner>,
    mut calls: mpsc::UnboundedReceiver<(i64, Scope, SessionCall)>,
) {
    while let Some((id, scope, call)) = calls.recv().await {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        let parsed = if parse_large(&call) {
            tokio::task::spawn_blocking(move || parse(call))
                .await
                .unwrap_or_else(|_| Err(Error::new("native_panic")))
        } else {
            parse(call)
        };
        let parsed = match parsed {
            Ok(parsed) => parsed,
            Err(error) => {
                inner.reply_in(&scope, id, Err(error));
                continue;
            }
        };
        if let Parsed::Connect {
            computer_id,
            allow_pairing,
            visible,
        } = parsed
        {
            let task = inner.clone();
            // A panic fails only this call.
            tokio::spawn(async move {
                let (worker, opened) = (task.clone(), scope.clone());
                let result = tokio::spawn(async move {
                    let replier = worker.clone();
                    worker
                        .guarded(worker.open_session(
                            &opened,
                            &computer_id,
                            allow_pairing,
                            visible,
                            None,
                            |hello| replier.reply_in(&opened, id, Ok(hello)),
                        ))
                        .await
                })
                .await;
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => task.reply_in(&scope, id, Err(error)),
                    Err(_) => task.reply_in(&scope, id, Err(Error::new("native_panic"))),
                }
            });
            continue;
        }
        let queued = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            inner.enqueue(id, &scope, parsed)
        }))
        .unwrap_or_else(|_| Queued::Ready(Err(Error::new("native_panic"))));
        match queued {
            Queued::Ready(result) => inner.reply_in(&scope, id, result),
            // The session answers through its responder, in its own order.
            Queued::Sent => {}
        }
    }
}

/// A session operation handed to its session in submission order: answered
/// at once, or later by the session itself.
enum Queued {
    Ready(Result<Value>),
    Sent,
}

impl Inner {
    pub(crate) fn new(
        auth: Arc<dyn AuthPort>,
        store: Arc<dyn StorePort>,
        relays: Arc<dyn RelayConnector>,
        origin: String,
        name: String,
        platform: String,
        runtime: &Handle,
    ) -> Arc<Self> {
        let (shutdown_tx, shutdown) = watch::channel(false);
        let (calls, calls_rx) = mpsc::unbounded_channel();
        let inner = Arc::new_cyclic(|this: &Weak<Inner>| Inner {
            auth,
            store,
            relays,
            cache: Cache::default(),
            relay: Mutex::new(RelaySlot::default()),
            reporting: Mutex::default(),
            relay_open: tokio::sync::Mutex::new(()),
            sessions: Mutex::new(HashMap::new()),
            newest: Mutex::default(),
            visibility: Mutex::new(HashMap::new()),
            this: this.clone(),
            generation: AtomicU64::new(1),
            scopes: watch::Sender::new(account::Epoch::new(0, None)),
            writers: Mutex::default(),
            settled: Arc::new(watch::Sender::new(0)),
            flushers: Mutex::default(),
            outbox: Outbox::new(),
            calls,
            shutdown_tx,
            shutdown,
            signals: Mutex::new(None),
            interest: Mutex::new(Arbiter::default()),
            overviews: Mutex::new(HashMap::new()),
            pushes: Fanout::default(),
            origin,
            name,
            platform,
        });
        runtime.spawn(dispatch(Arc::downgrade(&inner), calls_rx));
        inner
    }

    /// Starts session call `id` in the current account scope. Its result
    /// arrives as a [`BridgeMessage`]: `account_changed` once that scope
    /// ended, also when it ended before the result came.
    pub(crate) fn submit(&self, id: i64, call: SessionCall) {
        if self.calls.send((id, self.scope(), call)).is_err() {
            self.reply(id, Err(shutdown_failure()));
        }
    }

    /// Stops accepting work and fails waiting calls with `shutdown`.
    pub(crate) fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
        self.outbox.close();
    }

    /// A notice of relay `opening`. Only the opening announced last
    /// reports; its notices are numbered and forwarded under one lock, so
    /// the services and the app get them in that order.
    fn notice(&self, opening: u64, notice: Notice) {
        let mut reporting = lock(&self.reporting);
        // Only `announce` reports `Opened`, for the relay being installed.
        if matches!(notice, Notice::Opened(_)) {
            reporting.opening = opening;
        } else if reporting.opening != opening {
            return;
        }
        if matches!(notice, Notice::Closed(_)) {
            // An announced relay's last notice.
            reporting.opening = 0;
        }
        reporting.seq += 1;
        let event = match &notice {
            Notice::Opened(peers) => BridgeEvent::RelayOpened {
                peers_json: Value::from(self.annotate(peers.clone())).to_string(),
            },
            Notice::Peers(peers) => BridgeEvent::Peers {
                peers_json: Value::from(self.annotate(peers.clone())).to_string(),
            },
            Notice::Closed(reason) => BridgeEvent::RelayClosed {
                reason: reason.clone(),
            },
        };
        self.signal(Signal::Relay(reporting.seq, notice));
        self.outbox.send(BridgeMessage::Event(event));
    }
    /// A session event: to the account service and the stores, then the
    /// bridge.
    fn deliver(&self, v: &Value) {
        let Some(event) = event(v) else {
            return;
        };
        self.session_signal(&event);
        // Stores see a message before the bridge does, on the session's
        // task (wire order).
        if let BridgeEvent::Message { computer_id, .. } = &event {
            self.pushes.message(computer_id, &v["message"]);
        }
        self.outbox.send(BridgeMessage::Event(event));
    }
    /// `peer`'s newest session.
    fn newest(&self, peer: &str) -> Arc<Mutex<u64>> {
        lock(&self.newest)
            .entry(peer.to_owned())
            .or_default()
            .clone()
    }
    /// The events of `peer`'s session `generation`, delivered while it is
    /// the computer's newest session.
    fn session_emit(&self, newest: Arc<Mutex<u64>>, generation: u64) -> Emit {
        let this = self.this.clone();
        Arc::new(move |v: Value| {
            let mut newest = lock(&newest);
            if *newest == generation
                && let Some(inner) = this.upgrade()
            {
                inner.deliver(&v);
                // A session's `closed` is its last event.
                if v["event"] == "closed" {
                    *newest = 0;
                }
            }
        })
    }

    /// Routes relay and session signals to the account service from now on.
    pub(crate) fn observe_signals(&self, inbox: mpsc::UnboundedSender<Msg>) {
        *lock(&self.signals) = Some(inbox);
    }
    pub(crate) fn signal(&self, signal: Signal) {
        if let Some(inbox) = lock(&self.signals).as_ref() {
            let _ = inbox.send(Msg::Signal(signal));
        }
    }
    fn session_signal(&self, event: &BridgeEvent) {
        match event {
            BridgeEvent::Closed { computer_id, .. } => self.signal(Signal::SessionClosed {
                computer: computer_id.clone(),
            }),
            BridgeEvent::PairingCode { computer_id, code } => self.signal(Signal::PairingCode {
                computer: computer_id.clone(),
                code: code.clone(),
            }),
            _ => {}
        }
    }
    /// An `ipc.invoke` on `peer`'s session and surface for a core service,
    /// answered through `reply` in the session's order. `Err` when there is
    /// no session of `peer`'s scope to take it (`reply` is then dropped
    /// unanswered): `account_changed` once the scope ended, otherwise a
    /// `NotSent` failure, since nothing left this device.
    pub(crate) fn invoke(
        &self,
        peer: &Peer,
        channel: &str,
        args: Vec<Value>,
        limit: Duration,
        reply: Responder,
    ) -> Result<()> {
        let commands = match self.session_in(peer) {
            Ok(commands) => commands,
            Err(error) => {
                reply.cancel();
                return Err(error);
            }
        };
        let sent = commands.send(Command::Request {
            method: "ipc.invoke".into(),
            params: json!({"channel": channel, "args": args, "surface": peer.surface}),
            timeout: limit,
            reply,
        });
        if let Err(mpsc::error::SendError(command)) = sent {
            if let Command::Request { reply, .. } = command {
                reply.cancel();
            }
            return Err(not_sent());
        }
        Ok(())
    }
    /// Opens the relay in its own task: cancelling a connect does not stop
    /// the account socket from opening, as Dart's hub keeps opening it.
    async fn ensure_relay_detached(&self) -> Result<Arc<dyn RelayPort>> {
        if let Some(relay) = self.current_relay() {
            return Ok(relay);
        }
        let this = self.this.upgrade().ok_or_else(shutdown_failure)?;
        tokio::spawn(async move { this.ensure_relay().await })
            .await
            .unwrap_or_else(|_| Err(Error::new("native_panic")))
    }
    /// Call `id`'s result, for a call made in `scope`: `account_changed`
    /// once the scope ended, so nothing a left account's session answered
    /// reaches its caller.
    fn reply_in(&self, scope: &Scope, id: i64, result: Result<Value>) {
        self.reply(id, scope.check().and(result));
    }
    fn reply(&self, id: i64, result: Result<Value>) {
        self.outbox.send(match result {
            Ok(value) => BridgeMessage::Reply {
                id,
                value_json: value.to_string(),
            },
            Err(error) => BridgeMessage::Failed {
                id,
                failure: CoreFailure::from(error),
            },
        });
    }
    pub(crate) async fn guarded<T>(&self, work: impl Future<Output = Result<T>>) -> Result<T> {
        let mut shutdown = self.shutdown.clone();
        tokio::select! {
            biased;
            _ = shutdown.wait_for(|s| *s) => Err(shutdown_failure()),
            result = work => result,
        }
    }

    pub(crate) fn annotate(&self, mut peers: Vec<Value>) -> Vec<Value> {
        let pins = self.store.pins().unwrap_or_default();
        for peer in &mut peers {
            let paired = peer["deviceId"]
                .as_str()
                .is_some_and(|id| pins.contains_key(id));
            peer["paired"] = json!(paired);
        }
        peers
    }

    // ---- Relay ----

    fn current_relay(&self) -> Option<Arc<dyn RelayPort>> {
        lock(&self.relay)
            .current
            .clone()
            .filter(|relay| relay.alive())
    }
    async fn ensure_relay(&self) -> Result<Arc<dyn RelayPort>> {
        if let Some(relay) = self.current_relay() {
            return Ok(relay);
        }
        let opening = self.relay_open.lock().await;
        if let Some(relay) = self.current_relay() {
            return Ok(relay);
        }
        let (generation, number) = {
            let mut slot = lock(&self.relay);
            slot.openings += 1;
            (slot.generation, slot.openings)
        };
        let identity = self.store.identity()?;
        let token = match self.auth.relay_token(&identity.device_id).await {
            Ok(token) => token,
            Err(error) => {
                // One authoritative session check after an access failure,
                // unless the app owns the session (Dart's Computer Connect
                // reports the failure and leaves the session to the app).
                if !self.auth.app_owned()
                    && (error.status == Some(401)
                        || (error.status == Some(403) && error.code != "entitlement_denied"))
                    && let Ok(AuthSession::SignedOut) =
                        self.auth.revalidate_after_auth_failure().await
                {
                    // Auth cleared the session: its account goes with it,
                    // as with any sign-out.
                    drop(opening);
                    self.leave_account("signed_out").await;
                }
                return Err(error);
            }
        };
        let this = self.this.clone();
        let relay = self
            .relays
            .open(
                &token,
                *identity.seed,
                &self.name,
                &self.platform,
                Arc::new(move |notice| {
                    // Emitted synchronously, so a `peers` change precedes the
                    // `closed` of a session it ends, as in Dart.
                    if let Some(inner) = this.upgrade() {
                        inner.notice(number, notice);
                    }
                }),
            )
            .await?;
        let mut slot = lock(&self.relay);
        if slot.generation != generation || !relay.announce() {
            relay.close("Connection cancelled.");
            return Err(cancelled());
        }
        slot.current = Some(relay.clone());
        Ok(relay)
    }
    /// Opens the relay when needed and lists its peers with `paired`.
    pub(crate) async fn computers(&self) -> Result<Vec<Value>> {
        self.computer_account().await?;
        let relay = self.ensure_relay().await?;
        Ok(self.annotate(relay.peers()))
    }
    /// [`Inner::computers`] for the account service: the relay as of its
    /// latest notice.
    pub(crate) async fn discover(&self) -> Result<RelaySnapshot> {
        self.computer_account().await?;
        self.ensure_relay().await?;
        Ok(self.relay_snapshot())
    }
    /// The relay and its peers, read in order with its notices: every
    /// notice numbered after `seq` comes later.
    pub(crate) fn relay_snapshot(&self) -> RelaySnapshot {
        let (seq, peers) = {
            let slot = lock(&self.relay);
            let reporting = lock(&self.reporting);
            let peers = slot
                .current
                .as_ref()
                .filter(|relay| relay.alive())
                .map(|relay| relay.peers());
            (reporting.seq, peers)
        };
        RelaySnapshot {
            seq,
            peers: peers.map(|peers| self.annotate(peers)),
        }
    }
    pub(crate) fn relay_status(&self) -> (bool, Vec<Value>) {
        let relay = self.current_relay();
        let peers = relay
            .as_ref()
            .map(|relay| self.annotate(relay.peers()))
            .unwrap_or_default();
        (relay.is_some(), peers)
    }
    pub(crate) async fn relay_probe(&self, timeout_ms: Option<u64>) -> Result<bool> {
        let limit = match timeout_ms {
            None => 3000,
            Some(t) => Some(t)
                .filter(|t| (1..=60_000).contains(t))
                .ok_or_else(|| Error::new("invalid_input"))?,
        };
        Ok(match self.current_relay() {
            Some(relay) => relay.probe(Duration::from_millis(limit)).await,
            None => false,
        })
    }

    // ---- Sessions ----

    /// Ends a session or cancels its connect. Waits (bounded) until `close`
    /// was sent (when `polite`) and the relay channel released.
    async fn stop_slot(
        &self,
        peer: &str,
        slot: Option<Slot>,
        code: &'static str,
        polite: bool,
    ) -> bool {
        match slot {
            Some(Slot::Connecting {
                cancel, mut done, ..
            }) => {
                let _ = cancel.send(Some(polite));
                let _ = timeout(STOP_LIMIT, done.wait_for(|d| *d)).await;
                true
            }
            Some(Slot::Connected {
                commands,
                mut task,
                emit,
                ..
            }) => {
                let _ = commands.send(Command::Close { code, polite });
                // An ended session's task may already have been awaited.
                if !task.is_finished() && timeout(STOP_LIMIT, &mut task).await.is_err() {
                    task.abort();
                    emit(
                        json!({"event":"closed","computerId":peer,"code":code,"reason":LOCAL_CLOSE}),
                    );
                }
                true
            }
            None => false,
        }
    }
    /// Ends every session and the relay without `close`, as dropping Dart's
    /// account socket does (hub `disconnect`/`dispose`).
    /// A connected session stays as an ended one: as with Dart's repository,
    /// whose ended session outlives the socket, its requests fail `not_sent`
    /// until `disconnect` or the next `connect`.
    pub(crate) async fn disconnect_all(&self, code: &'static str) {
        let taken = self.take_all(code);
        self.end_taken(taken, code).await;
    }
    /// The first, synchronous half of [`Inner::disconnect_all`]: takes
    /// every session and the relay, cancels a relay open in flight and
    /// clears the caches (suspending keeps them, as Dart does). What is
    /// opened or cached afterwards is not ended with them, so leaving an
    /// account takes them together with ending its scope.
    pub(crate) fn take_all(&self, code: &'static str) -> Taken {
        let slots = lock(&self.sessions).drain().collect();
        let relay = {
            let mut slot = lock(&self.relay);
            slot.generation += 1;
            slot.current.take()
        };
        if code != "suspended" {
            self.cache.clear();
        }
        Taken { slots, relay }
    }
    /// [`Inner::take_all`] as the account scope ends, under the writers
    /// lock: what the ended scope's sessions and relay report ends with it,
    /// and its interest claims are forgotten.
    /// Each session still reporting gets its `closed` now, and its relay
    /// its `Closed`; nothing either reports later is delivered. So the
    /// stream shows the left account's sessions ending before anything of
    /// the next account's, even one on the same computer, and nothing of
    /// theirs after it.
    pub(crate) fn take_scope(&self, code: &'static str) -> Taken {
        let taken = self.take_all(code);
        // The scope's interest claims go with its sessions: the next
        // account's services and sessions claim their own.
        *lock(&self.interest) = Arbiter::default();
        for (peer, slot) in &taken.slots {
            let newest = self.newest(peer);
            let mut newest = lock(&newest);
            match slot {
                Slot::Connected { generation, .. } if *newest == *generation => {
                    self.deliver(
                        &json!({"event":"closed","computerId":peer,"code":code,"reason":LOCAL_CLOSE}),
                    );
                    *newest = 0;
                }
                // A connect reports no `closed`, as in Dart.
                Slot::Connecting { generation, .. } if *newest == *generation => *newest = 0,
                _ => {}
            }
        }
        if taken.relay.is_some() {
            let opening = lock(&self.reporting).opening;
            if opening != 0 {
                self.notice(opening, Notice::Closed(LOCAL_CLOSE.into()));
            }
        }
        taken
    }
    /// Ends what [`Inner::take_all`] took: the sessions, without `close`,
    /// then the relay.
    pub(crate) async fn end_taken(&self, taken: Taken, code: &'static str) {
        let Taken { slots, relay } = taken;
        let ended = join_all(slots.into_iter().map(|(peer, slot)| async move {
            match slot {
                Slot::Connected {
                    generation,
                    commands,
                    mut task,
                    released,
                    relay,
                    emit,
                } => {
                    let _ = commands.send(Command::Close {
                        code,
                        polite: false,
                    });
                    // An ended session's task may already have been awaited.
                    if !task.is_finished() && timeout(STOP_LIMIT, &mut task).await.is_err() {
                        task.abort();
                        emit(
                            json!({"event":"closed","computerId":peer,"code":code,"reason":LOCAL_CLOSE}),
                        );
                    }
                    Some((
                        peer,
                        Slot::Connected {
                            generation,
                            commands,
                            task,
                            released,
                            relay,
                            emit,
                        },
                    ))
                }
                connecting => {
                    self.stop_slot(&peer, Some(connecting), code, false).await;
                    None
                }
            }
        }))
        .await;
        {
            let mut sessions = lock(&self.sessions);
            for (peer, slot) in ended.into_iter().flatten() {
                sessions.entry(peer).or_insert(slot);
            }
        }
        if let Some(relay) = relay {
            relay.close(LOCAL_CLOSE);
        }
    }
    /// `peer`'s session while its account scope lasts: `account_changed`
    /// once the scope ended, `no_session` without one. Checked under the
    /// sessions lock, under which leaving the account takes the scope's
    /// sessions only after the scope ended, so the session found here is
    /// the scope's own, never one the next account opened on the same
    /// computer.
    fn session_in(&self, peer: &Peer) -> Result<mpsc::UnboundedSender<Command>> {
        let sessions = lock(&self.sessions);
        peer.scope.check()?;
        match sessions.get(&peer.computer) {
            Some(Slot::Connected { commands, .. }) => Ok(commands.clone()),
            _ => Err(no_session()),
        }
    }

    /// Pairs if needed and opens the computer's control session for
    /// `scope`. `on_open` gets the hello once the session is installed,
    /// before any of its events. `abort` (set, or its sender dropped)
    /// cancels the connect at any step, including before it owns a slot; no
    /// session is installed after it fired. The connect owns a slot only
    /// while `scope` lasts (`account_changed` otherwise): leaving the
    /// account takes the slot with the scope, so a left account's connect
    /// never installs a session for the next.
    pub(crate) async fn open_session(
        &self,
        scope: &Scope,
        peer: &str,
        allow_pairing: bool,
        visible: Option<bool>,
        abort: Option<watch::Receiver<bool>>,
        on_open: impl FnOnce(Value) + Send,
    ) -> Result<()> {
        let peer = computer_id(peer)?.to_string();
        // Validated before this connect owns a slot: an account change tears
        // every session down.
        self.computer_account().await?;
        scope.check()?;
        if abort.as_ref().is_some_and(fired) {
            return Err(cancelled_at(STEP_RELAY));
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst);
        let newest = self.newest(&peer);
        let emit = self.session_emit(newest.clone(), generation);
        let (cancel, mut cancelled_rx) = watch::channel(None);
        let (done_tx, done) = watch::channel(false);
        // Dart: one relay channel per computer. Another connection's session
        // (or connect) keeps it, and this connect fails `session_exists` at
        // the step Dart's `channelFor` does.
        // Under the writers lock, under which the scope ends and its
        // sessions and Orchestrator states are taken.
        let (taken, stale) = {
            let _writers = lock(&self.writers);
            scope.check()?;
            let mut sessions = lock(&self.sessions);
            if sessions.get(&peer).is_some_and(Slot::holds_channel) {
                (true, None)
            } else {
                // From now on the events of an earlier session, one still
                // ending, are no longer this computer's.
                *lock(&newest) = generation;
                let stale = sessions.insert(
                    peer.clone(),
                    Slot::Connecting {
                        generation,
                        cancel,
                        done,
                    },
                );
                // The caller's Orchestrator state for this session, as
                // Dart's repository sends its own after connecting; a
                // refused connect does not touch another caller's session.
                if let Some(visible) = visible {
                    lock(&self.visibility).insert(peer.clone(), visible);
                }
                (false, stale)
            }
        };
        if taken {
            let (relay, _, _) = self.precheck(&peer, allow_pairing).await?;
            drop(relay);
            return Err(Error::local(
                "session_exists",
                "This computer already has a session.",
            ));
        }
        // A session that ended and released its channel.
        self.stop_slot(&peer, stale, "closed", false).await;
        let mut holder: Option<Box<dyn PeerSession>> = None;
        let step = AtomicU8::new(STEP_RELAY);
        let mut polite = true;
        let abort_wait = async {
            match abort.clone() {
                Some(mut abort) => {
                    let _ = abort.wait_for(|a| *a).await;
                }
                None => std::future::pending().await,
            }
        };
        let result = tokio::select! {
            biased;
            p = cancelled_rx.wait_for(Option::is_some) => {
                polite = p.map(|p| p.unwrap_or(true)).unwrap_or(true);
                Err(cancelled_at(step.load(Ordering::SeqCst)))
            }
            () = abort_wait => Err(cancelled_at(step.load(Ordering::SeqCst))),
            result = self.connect_flow(&peer, allow_pairing, &mut holder, &step, &emit) => result,
        };
        let outcome = match result {
            Ok((hello, version, relay)) => {
                let leftover = {
                    let mut sessions = lock(&self.sessions);
                    let current = matches!(
                        sessions.get(&peer),
                        Some(Slot::Connecting { generation: g, .. }) if *g == generation
                    );
                    let aborted = abort.as_ref().is_some_and(fired);
                    if current && aborted {
                        sessions.remove(&peer);
                    }
                    match holder.take() {
                        Some(mut session) if current && !aborted => {
                            session.set_visible(
                                lock(&self.visibility).get(&peer).copied().unwrap_or(false),
                            );
                            let (commands, rx) = mpsc::unbounded_channel();
                            let released = Arc::new(AtomicBool::new(false));
                            let flag = released.clone();
                            // The result precedes every event of the new session.
                            on_open(hello);
                            let task = tokio::spawn(async move {
                                let end = session.run(version, rx).await;
                                flag.store(
                                    matches!(
                                        end.code,
                                        "peer_offline" | "undeliverable" | "relay_closed"
                                    ),
                                    Ordering::SeqCst,
                                );
                            });
                            sessions.insert(
                                peer.clone(),
                                Slot::Connected {
                                    generation,
                                    commands,
                                    task,
                                    released,
                                    relay: Arc::downgrade(&relay),
                                    emit: emit.clone(),
                                },
                            );
                            self.session_opened(&peer);
                            None
                        }
                        session => Some(session),
                    }
                };
                match leftover {
                    None => Ok(()),
                    Some(session) => {
                        if let Some(mut session) = session {
                            session.close().await;
                        }
                        Err(cancelled_at(STEP_RELAY))
                    }
                }
            }
            Err(error) => {
                {
                    let mut sessions = lock(&self.sessions);
                    if matches!(
                        sessions.get(&peer),
                        Some(Slot::Connecting { generation: g, .. }) if *g == generation
                    ) {
                        sessions.remove(&peer);
                    }
                }
                if let Some(mut session) = holder.take()
                    && polite
                {
                    session.close().await;
                }
                Err(error)
            }
        };
        let _ = done_tx.send(true);
        outcome
    }

    /// Dart's checks before `channelFor`: relay, presence, remote access and
    /// pin. Returns the relay, the computer's key and its pin.
    async fn precheck(
        &self,
        peer: &str,
        allow_pairing: bool,
    ) -> Result<(Arc<dyn RelayPort>, String, Option<String>)> {
        let relay = self.ensure_relay_detached().await?;
        let target = relay
            .peer(peer)
            .ok_or_else(|| Error::local("peer_offline", OFFLINE_OR_OFF))?;
        if target["acceptsRemoteControl"] != true {
            return Err(Error::local("remote_access_off", OFFLINE_OR_OFF));
        }
        let public = field(&target, "publicKey")?.to_string();
        let pin = self.store.pin(peer)?;
        if pin.is_none() && !allow_pairing {
            return Err(Error::local(
                "pairing_required",
                "Pair this computer again to connect.",
            ));
        }
        if pin.as_ref().is_some_and(|p| p != &public) {
            return Err(Error::local(
                "peer_identity_changed",
                "The computer identity changed.",
            ));
        }
        Ok((relay, public, pin))
    }

    async fn connect_flow(
        &self,
        peer: &str,
        allow_pairing: bool,
        holder: &mut Option<Box<dyn PeerSession>>,
        step: &AtomicU8,
        emit: &Emit,
    ) -> Result<(Value, u64, Arc<dyn RelayPort>)> {
        let (relay, public, pin) = self.precheck(peer, allow_pairing).await?;
        let seed = self.store.identity()?.seed;
        let session = holder.insert(relay.open_session(peer, &public, *seed, emit.clone())?);
        if pin.is_none() {
            step.store(STEP_HANDSHAKE, Ordering::SeqCst);
            let code = session.establish("pair").await?;
            emit(json!({"event":"pairingCode","computerId":peer,"code":code}));
            step.store(STEP_REQUEST, Ordering::SeqCst);
            // `kind` is the relay token's device kind, as in Dart.
            let result = session
                .call(
                    "pair.request",
                    json!({"name":self.name,"platform":"darwin","kind":"mobile"}),
                    Duration::from_secs(125),
                )
                .await?;
            step.store(STEP_RELAY, Ordering::SeqCst);
            if result["approved"] != true {
                return Err(Error::local(
                    "pairing_declined",
                    "Pairing was declined or expired.",
                ));
            }
            // Saved right after approval, before the control session opens.
            self.store.remember_pin(peer, &public)?;
        }
        step.store(STEP_HANDSHAKE, Ordering::SeqCst);
        session.establish("control").await?;
        step.store(STEP_REQUEST, Ordering::SeqCst);
        let opened = async {
            let mut hello = session
                .call(
                    "session.hello",
                    hello_params(MIN_PROTOCOL),
                    Duration::from_secs(15),
                )
                .await?;
            let version = read_version(&hello)?;
            // An unmatched hello grants no IPC; repeat it at the host's version.
            if version != MIN_PROTOCOL {
                hello = session
                    .call(
                        "session.hello",
                        hello_params(version),
                        Duration::from_secs(15),
                    )
                    .await?;
                check_version(&hello, version)?;
            }
            Ok((hello, version))
        }
        .await;
        match opened {
            Ok((hello, version)) => Ok((hello, version, relay)),
            Err(error) => {
                session.fail("control_failed", "The control session could not open.");
                Err(error)
            }
        }
    }

    /// Emits call `id`'s result when the session settles it, as
    /// [`Inner::reply_in`] for a call made in `scope`.
    fn responder(&self, id: i64, scope: &Scope) -> Responder {
        let (this, scope) = (self.this.clone(), scope.clone());
        Responder::new(move |result| {
            if let Some(inner) = this.upgrade() {
                inner.reply_in(&scope, id, result);
            }
        })
    }

    /// Session operations, handed to the session synchronously so they keep
    /// submission order.
    fn enqueue(&self, id: i64, scope: &Scope, call: Parsed) -> Queued {
        match self.session_command(id, scope, call) {
            Ok(queued) => queued,
            Err(error) => Queued::Ready(Err(error)),
        }
    }

    /// A compatibility call made in `scope` reaches only that scope's
    /// session ([`Inner::session_in`]); once the scope ended it fails
    /// `account_changed`, and nothing is sent.
    fn session_command(&self, id: i64, scope: &Scope, call: Parsed) -> Result<Queued> {
        let peer_in = |peer: &str, surface: &'static str| -> Result<Peer> {
            Ok(Peer {
                computer: computer_id(peer)?.to_owned(),
                surface,
                scope: scope.clone(),
            })
        };
        match call {
            Parsed::Connect { .. } => Err(Error::new("unknown_operation")),
            Parsed::Visible {
                computer_id: peer,
                visible,
            } => {
                self.set_visible(&peer_in(&peer, MAIN)?, visible)?;
                Ok(Queued::Ready(Ok(Value::Null)))
            }
            Parsed::HostInfo { computer_id: peer } => {
                let commands = self
                    .session_in(&peer_in(&peer, MAIN)?)
                    .map_err(connect_first)?;
                if let Err(mpsc::error::SendError(command)) = commands.send(Command::HostInfo {
                    reply: self.responder(id, scope),
                }) {
                    if let Command::HostInfo { reply } = command {
                        reply.cancel();
                    }
                    return Err(not_connected());
                }
                Ok(Queued::Sent)
            }
            Parsed::Invoke {
                computer_id: peer,
                channel,
                args,
                surface,
                timeout_ms,
            } => {
                let surface = match surface.as_deref().unwrap_or(MAIN) {
                    MAIN => MAIN,
                    APP_ADVISOR => APP_ADVISOR,
                    _ => return Err(Error::new("invalid_surface")),
                };
                let peer = peer_in(&peer, surface)?;
                let limit = match timeout_ms {
                    None => 15_000,
                    Some(t) => Some(t)
                        .filter(|t| (1..=MAX_TIMEOUT_MS).contains(t))
                        .ok_or_else(|| Error::new("invalid_input"))?,
                };
                let channel = required(&channel)?.to_string();
                let args = match args {
                    Value::Array(args) => args,
                    _ => Vec::new(),
                };
                // Dart's repository throws a `DeviceLinkException` here
                // (repository.dart:153,173); core services get `no_session`.
                let commands = self.session_in(&peer).map_err(connect_first)?;
                let request = |args: Vec<Value>| Command::Request {
                    method: "ipc.invoke".into(),
                    params: json!({"channel":channel,"args":args,"surface":surface}),
                    timeout: Duration::from_millis(limit),
                    reply: self.responder(id, scope),
                };
                // A Dart feature's interest write is the bridge's claim; it
                // is sent as is, in the arbiter's order.
                let sent = if interest::owned(&channel) {
                    let mut arbiter = lock(&self.interest);
                    // Leaving the account clears the arbiter under its lock.
                    scope.check()?;
                    arbiter.bridge_write(
                        &peer.computer,
                        surface,
                        &channel,
                        &Value::Array(args.clone()),
                    );
                    commands.send(request(args))
                } else {
                    commands.send(request(args))
                };
                if let Err(mpsc::error::SendError(command)) = sent {
                    // The session already ended: answer here, once.
                    if let Command::Request { reply, .. } = command {
                        reply.cancel();
                    }
                    return Err(not_sent());
                }
                Ok(Queued::Sent)
            }
        }
    }

    // ---- Services ----

    /// The Orchestrator window state the desktop sees on `peer`'s session,
    /// kept for its next session (`setOrchestratorVisible`), while `peer`'s
    /// scope lasts: under the writers lock, under which leaving the
    /// account forgets these states and takes its sessions, so a left
    /// account's state never reaches the next account's session or its
    /// next one.
    pub(crate) fn set_visible(&self, peer: &Peer, visible: bool) -> Result<()> {
        self.in_scope(&peer.scope, || {
            lock(&self.visibility).insert(peer.computer.clone(), visible);
            if let Ok(commands) = self.session_in(peer) {
                let _ = commands.send(Command::Visible(visible));
            }
            Ok(())
        })
    }

    /// Forgets every computer's Orchestrator window state: it is the left
    /// account's, and the next account's sessions start hidden.
    pub(crate) fn clear_visibility(&self) {
        lock(&self.visibility).clear();
    }

    /// Sends `channel` on `peer`'s session and surface for a core service,
    /// only while `peer`'s account scope lasts ([`Inner::session_in`]). The
    /// receiver gets the reply in session order. A request no session
    /// writer takes fails `NotSent`: its caller may send it again after a
    /// reconnect.
    pub(crate) fn request(
        &self,
        peer: &Peer,
        channel: &str,
        args: Vec<Value>,
    ) -> Result<oneshot::Receiver<Result<Value>>> {
        let commands = self.session_in(peer)?;
        Self::send_request(&commands, peer.surface, channel, args)
    }
    fn send_request(
        commands: &mpsc::UnboundedSender<Command>,
        surface: &str,
        channel: &str,
        args: Vec<Value>,
    ) -> Result<oneshot::Receiver<Result<Value>>> {
        let (tx, rx) = oneshot::channel();
        commands
            .send(Command::Request {
                method: "ipc.invoke".into(),
                params: json!({"channel":channel,"args":args,"surface":surface}),
                timeout: Duration::from_millis(15_000),
                reply: Responder::new(move |result| {
                    let _ = tx.send(result);
                }),
            })
            .map_err(|_| not_sent())?;
        Ok(rx)
    }

    /// `holder` claims `args` for `channel` on `peer`'s main surface, while
    /// its scope lasts. The reply of the write, or `None` when the desktop
    /// already has it.
    pub(crate) fn claim_interest(
        &self,
        peer: &Peer,
        holder: Holder,
        channel: &str,
        args: Vec<Value>,
    ) -> Result<Option<oneshot::Receiver<Result<Value>>>> {
        let commands = self.session_in(peer)?;
        let computer = peer.computer.as_str();
        let mut arbiter = lock(&self.interest);
        // Leaving the account clears the arbiter under its lock.
        peer.scope.check()?;
        match arbiter.claim(computer, "main", holder, channel, Value::Array(args)) {
            None => Ok(None),
            Some(Value::Array(args)) => match Self::send_request(&commands, MAIN, channel, args) {
                Ok(rx) => Ok(Some(rx)),
                Err(error) => {
                    arbiter.unsent(computer, "main", channel);
                    Err(error)
                }
            },
            Some(_) => Ok(None),
        }
    }
    /// `holder` writes `args` for `channel` on `peer`'s surface, sent even
    /// when the desktop already has it, while its scope lasts; the reply of
    /// the write.
    pub(crate) fn write_interest_on(
        &self,
        peer: &Peer,
        holder: Holder,
        channel: &str,
        args: Vec<Value>,
    ) -> Result<oneshot::Receiver<Result<Value>>> {
        self.write_interest_while(peer, holder, channel, args, || true)?
            .ok_or_else(not_sent)
    }
    /// [`Inner::write_interest_on`] only while `current()` holds; `None`
    /// when it no longer does. `current` is read under the arbiter's lock,
    /// right before the send: a write a newer one superseded first is
    /// never sent, and one sent before it stays ahead of it on the wire.
    pub(crate) fn write_interest_while(
        &self,
        peer: &Peer,
        holder: Holder,
        channel: &str,
        args: Vec<Value>,
        current: impl FnOnce() -> bool,
    ) -> Result<Option<oneshot::Receiver<Result<Value>>>> {
        let commands = self.session_in(peer)?;
        let (computer, surface) = (peer.computer.as_str(), peer.surface);
        let mut arbiter = lock(&self.interest);
        // Leaving the account clears the arbiter under its lock.
        peer.scope.check()?;
        if !current() {
            return Ok(None);
        }
        arbiter.write(
            computer,
            surface,
            holder,
            channel,
            &Value::Array(args.clone()),
        );
        Self::send_request(&commands, surface, channel, args)
            .map(Some)
            .inspect_err(|_| {
                arbiter.unsent(computer, surface, channel);
            })
    }
    /// A service's write failed; the next claim is sent again. Only while
    /// `peer`'s scope lasts, as [`Inner::release_interest`].
    pub(crate) fn interest_unsent(&self, peer: &Peer, channel: &str) {
        let mut arbiter = lock(&self.interest);
        if peer.scope.live() {
            arbiter.unsent(&peer.computer, MAIN, channel);
        }
    }
    /// `holder` stops claiming on `peer`'s computer, only while `peer`'s
    /// scope lasts: leaving the account cleared the scope's claims, and a
    /// holder of the next account's scope has the same name.
    pub(crate) fn release_interest(&self, peer: &Peer, holder: Holder) {
        let mut arbiter = lock(&self.interest);
        if peer.scope.live() {
            arbiter.release(&peer.computer, holder);
        }
    }

    /// Makes `inbox` `peer`'s overview. The overview it replaces stops: one
    /// overview writes a computer's interest.
    pub(crate) fn observe_overview(
        &self,
        peer: &Peer,
        inbox: mpsc::UnboundedSender<overview::Msg>,
    ) {
        let previous =
            lock(&self.overviews).insert(peer.computer.clone(), (peer.scope.clone(), inbox));
        if let Some((_, previous)) = previous {
            let _ = previous.send(overview::Msg::Replaced);
        }
    }
    /// `peer`'s current overview, for a service that refreshes it after a
    /// write (P8: archive, clone): only one started in `peer`'s scope,
    /// while that scope lasts, never the next account's.
    pub(crate) fn overview_inbox(
        &self,
        peer: &Peer,
    ) -> Option<mpsc::UnboundedSender<overview::Msg>> {
        lock(&self.overviews)
            .get(&peer.computer)
            .filter(|(scope, _)| scope.same(&peer.scope) && scope.live())
            .map(|(_, inbox)| inbox.clone())
    }
    /// Forgets `inbox`, unless a newer overview replaced it.
    pub(crate) fn forget_overview(&self, peer: &str, inbox: &mpsc::UnboundedSender<overview::Msg>) {
        let mut overviews = lock(&self.overviews);
        if overviews
            .get(peer)
            .is_some_and(|(_, tx)| tx.same_channel(inbox))
        {
            overviews.remove(peer);
        }
    }
    fn session_opened(&self, peer: &str) {
        lock(&self.interest).session_opened(peer);
        self.pushes.opened(peer);
    }

    /// Takes `peer`'s slot when `take` selects it, only while `scope`
    /// lasts (`account_changed` otherwise). Under the sessions lock, as
    /// [`Inner::session_in`]: the slot is the scope's own, never one the
    /// next account opened on the same computer.
    fn take_slot(
        &self,
        scope: &Scope,
        peer: &str,
        take: impl FnOnce(&Slot) -> bool,
    ) -> Result<Option<Slot>> {
        let mut sessions = lock(&self.sessions);
        scope.check()?;
        Ok(match sessions.get(peer) {
            Some(slot) if take(slot) => sessions.remove(peer),
            _ => None,
        })
    }
    /// Cancels `scope`'s connect to `peer`; false when there was none.
    pub(crate) async fn cancel_connect(&self, scope: &Scope, peer: &str) -> Result<bool> {
        let peer = computer_id(peer)?;
        let slot = self.take_slot(scope, peer, |slot| matches!(slot, Slot::Connecting { .. }))?;
        Ok(self.stop_slot(peer, slot, "cancelled", true).await)
    }
    /// Releases `scope`'s session of `peer` when it already ended on its
    /// own, as Dart's repository `connect` starts with `disconnect()`: the
    /// channel an ended session kept is freed for this link's next connect.
    /// A live session or a connect in flight is left alone.
    pub(crate) async fn release_ended(&self, scope: &Scope, peer: &str) {
        let slot = self.take_slot(
            scope,
            peer,
            |slot| matches!(slot, Slot::Connected { task, .. } if task.is_finished()),
        );
        if let Ok(slot @ Some(_)) = slot {
            self.stop_slot(peer, slot, "closed", false).await;
        }
    }
    /// Ends `scope`'s session of the computer and clears the scope's
    /// caches of it; `forget` also drops its pin. `account_changed` once
    /// the scope ended, when leaving the account already took its session
    /// and caches: the next account's are left alone.
    pub(crate) async fn disconnect(&self, scope: &Scope, peer: &str, forget: bool) -> Result<()> {
        let peer = computer_id(peer)?;
        let slot = self.take_slot(scope, peer, |_| true)?;
        self.stop_slot(peer, slot, "closed", true).await;
        self.in_scope(scope, || {
            if let Some(account) = scope.account() {
                self.cache.clear_computer(&account, peer);
            }
            if forget {
                self.store.forget_pin(peer)?;
            }
            Ok(())
        })
    }
    pub(crate) async fn import_identity(
        &self,
        source: IdentityImport,
        force: bool,
    ) -> Result<Value> {
        let before = self.store.existing_identity()?.map(|i| i.public());
        let result = match source {
            IdentityImport::DartRecord { record } => {
                self.store.identity_import_dart(&record, force)?
            }
            IdentityImport::Seed { seed, pins_json } => {
                let seed = required(&seed)?.to_string();
                let pins = match pins_json {
                    Some(raw) => parse_json(raw.as_bytes(), 1)?,
                    None => Value::Null,
                };
                self.store.identity_import(&seed, &pins, force)?
            }
        };
        let after = self.store.identity()?.public();
        if before.is_some_and(|b| b != after) {
            self.disconnect_all("identity_changed").await;
        }
        Ok(result)
    }
}

/// The developer console's cache operations, each for the account scope it
/// was made in: a read is refused once the scope ended, a write or clear
/// applies under the writers lock while it lasts, and the next account's
/// entries are never read or touched.
#[cfg(feature = "diagnostics")]
impl Inner {
    pub(crate) fn cache_read(&self, scope: &Scope, peer: &str, key: &str) -> Result<Option<Value>> {
        let account = self.account_in(scope)?;
        let key = Cache::key(&account, computer_id(peer)?, required(key)?);
        Ok(self.cache.get(&key))
    }
    pub(crate) fn cache_write(
        &self,
        scope: &Scope,
        peer: &str,
        key: &str,
        value: Value,
    ) -> Result<()> {
        self.in_scope(scope, || {
            let account = self.account_in(scope)?;
            let key = Cache::key(&account, computer_id(peer)?, required(key)?);
            self.cache.put(key, value);
            Ok(())
        })
    }
    pub(crate) fn cache_clear(&self, scope: &Scope, which: crate::api::CacheScope) -> Result<()> {
        self.in_scope(scope, || {
            self.cache_clear_in(&self.account_in(scope)?, which)
        })
    }
    fn cache_clear_in(&self, account: &str, scope: crate::api::CacheScope) -> Result<()> {
        use crate::api::CacheScope;
        let account = account.to_owned();
        match scope {
            CacheScope::Account => self.cache.clear_account(&account),
            CacheScope::Computer { computer_id: peer } => {
                self.cache.clear_computer(&account, computer_id(&peer)?)
            }
            CacheScope::Entry {
                computer_id: peer,
                key,
            } => {
                let key = Cache::key(&account, computer_id(&peer)?, required(&key)?);
                self.cache.remove(&key);
            }
        }
        Ok(())
    }
}

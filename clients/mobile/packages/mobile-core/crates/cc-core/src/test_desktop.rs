//! A scripted computer for the Flutter goldens (feature `test-desktop`,
//! never in an Android or iOS build). [`open`] runs the real core over the
//! real encrypted store and hosted auth; only the account relay is
//! replaced, by one that lists a single paired computer and mints no
//! tokens. That computer's sessions carry the session envelopes to the
//! host instead of the secure channel: every request,
//! `{kind: "request", id, method, params}`, goes to `requests` in order,
//! and the host sends the responses, `{kind: "response", id, ok, value}` or
//! `{..., ok: false, error}`, and the computer's events,
//! `{kind: "event", name, payload}`, through [`TestDesktop::deliver`], so
//! they reach the session in the order the host delivered them. Values are
//! in the bridge form (`value_codec.dart`).
use crate::{Config, Core, CoreFailure, assemble, failure, prepare};
use cc_app::ports::{
    AuthPort, AuthSession, BoxFuture, Command, Emit, Notice, Notify, PeerSession, RelayConnector,
    RelayPort, Responder, SessionEnd, SignInStep,
};
use cc_protocol::{FailureKind, Result, RpcFailure, rpc, secure, v8};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::mpsc,
    time::{Instant, sleep_until},
};

/// Hands one request envelope (JSON) to the host.
pub type Requests = Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// The computer's relay key; its device id derives from it.
const PUBLIC_KEY: [u8; 32] = [7; 32];
const NAME: &str = "Test computer";

/// The host's side of the scripted computer.
#[derive(Clone)]
pub struct TestDesktop {
    computer_id: String,
    wire: Arc<Wire>,
}

struct Wire {
    /// Request envelopes, handed to the host one at a time.
    requests: mpsc::UnboundedSender<String>,
    /// The current session's inbox.
    inbox: Mutex<Option<mpsc::UnboundedSender<Value>>>,
}

impl TestDesktop {
    /// The computer's device id, as the account lists it.
    pub fn computer_id(&self) -> String {
        self.computer_id.clone()
    }
    /// Delivers one envelope to the computer's current session. Fails
    /// `invalid_input` for anything but a JSON map and `not_connected`
    /// without a session.
    pub fn deliver(&self, message_json: &str) -> std::result::Result<(), CoreFailure> {
        let message = serde_json::from_str::<Value>(message_json)
            .ok()
            .filter(|m| v8::as_map(m).is_some())
            .ok_or_else(|| failure("invalid_input"))?;
        let inbox = self
            .wire
            .inbox
            .lock()
            .map_err(|_| failure("not_connected"))?;
        match inbox.as_ref() {
            Some(session) if session.send(message).is_ok() => Ok(()),
            _ => Err(failure("not_connected")),
        }
    }
}

/// [`crate::open`] with the scripted computer in place of the relay. The
/// computer is paired before the core starts.
pub fn open(
    config: Config,
    requests: Requests,
) -> std::result::Result<(Core, TestDesktop), CoreFailure> {
    let (runtime, mut connectors) = prepare(&config)?;
    let public = secure::encode(&PUBLIC_KEY);
    let computer_id = secure::device_id(&public)?;
    connectors.store.remember_pin(&computer_id, &public)?;
    let (forward, mut pending) = mpsc::unbounded_channel::<String>();
    runtime.spawn(async move {
        while let Some(request) = pending.recv().await {
            requests(request).await;
        }
    });
    let wire = Arc::new(Wire {
        requests: forward,
        inbox: Mutex::new(None),
    });
    connectors.auth = Arc::new(TestAuth(connectors.auth));
    connectors.relays = Arc::new(TestRelays {
        computer_id: computer_id.clone(),
        public,
        wire: wire.clone(),
    });
    Ok((
        assemble(runtime, connectors, config),
        TestDesktop { computer_id, wire },
    ))
}

/// Hosted auth, except that the relay token is a placeholder: the
/// scripted relay takes any.
struct TestAuth(Arc<dyn AuthPort>);

impl AuthPort for TestAuth {
    fn status(&self) -> Result<Value> {
        self.0.status()
    }
    fn restore(&self) -> BoxFuture<'_, Result<AuthSession>> {
        self.0.restore()
    }
    fn ensure_valid(&self) -> BoxFuture<'_, Result<AuthSession>> {
        self.0.ensure_valid()
    }
    fn revalidate_after_auth_failure(&self) -> BoxFuture<'_, Result<AuthSession>> {
        self.0.revalidate_after_auth_failure()
    }
    fn adopt<'a>(
        &'a self,
        token: &'a str,
        proof: Option<&'a str>,
    ) -> BoxFuture<'a, Result<AuthSession>> {
        self.0.adopt(token, proof)
    }
    fn adopt_app_session(
        &self,
        token: &str,
        proof: Option<&str>,
        account_id: &str,
    ) -> Result<AuthSession> {
        self.0.adopt_app_session(token, proof, account_id)
    }
    fn app_owned(&self) -> bool {
        self.0.app_owned()
    }
    fn forget(&self) -> Result<()> {
        self.0.forget()
    }
    fn forget_if_token(&self, token: &str) -> Result<bool> {
        self.0.forget_if_token(token)
    }
    fn sign_out(&self) -> BoxFuture<'_, Result<()>> {
        self.0.sign_out()
    }
    fn cancel_sign_in(&self) {
        self.0.cancel_sign_in();
    }
    fn begin_oauth(&self, provider: &str, callback_url: &str) -> Result<Value> {
        self.0.begin_oauth(provider, callback_url)
    }
    fn oauth_callback<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<SignInStep>> {
        self.0.oauth_callback(url)
    }
    fn apple_begin(&self) -> Value {
        self.0.apple_begin()
    }
    fn apple_complete<'a>(
        &'a self,
        identity_token: &'a str,
        name: Option<&'a str>,
    ) -> BoxFuture<'a, Result<SignInStep>> {
        self.0.apple_complete(identity_token, name)
    }
    fn two_factor<'a>(
        &'a self,
        challenge: &'a str,
        code: &'a str,
    ) -> BoxFuture<'a, Result<SignInStep>> {
        self.0.two_factor(challenge, code)
    }
    fn email_sign_in<'a>(
        &'a self,
        email: &'a str,
        password: &'a str,
    ) -> BoxFuture<'a, Result<SignInStep>> {
        self.0.email_sign_in(email, password)
    }
    fn email_action<'a>(
        &'a self,
        action: &'a str,
        body: &'a Value,
    ) -> BoxFuture<'a, Result<Value>> {
        self.0.email_action(action, body)
    }
    fn relay_token<'a>(&'a self, _device_id: &'a str) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async { Ok(json!({"token": "test", "relayUrl": "wss://relay.invalid"})) })
    }
    fn http_request<'a>(&'a self, request: &'a Value) -> BoxFuture<'a, Result<Value>> {
        self.0.http_request(request)
    }
    fn cleanup_legacy_key<'a>(&'a self, account: &'a str) -> BoxFuture<'a, Result<Value>> {
        self.0.cleanup_legacy_key(account)
    }
}

struct TestRelays {
    computer_id: String,
    public: String,
    wire: Arc<Wire>,
}

impl RelayConnector for TestRelays {
    fn open<'a>(
        &'a self,
        _token: &'a Value,
        _seed: [u8; 32],
        _name: &'a str,
        _platform: &'a str,
        notify: Notify,
    ) -> BoxFuture<'a, Result<Arc<dyn RelayPort>>> {
        let relay: Arc<dyn RelayPort> = Arc::new(TestRelay {
            computer_id: self.computer_id.clone(),
            public: self.public.clone(),
            wire: self.wire.clone(),
            notify,
            closed: AtomicBool::new(false),
        });
        Box::pin(async move { Ok(relay) })
    }
}

/// An account relay that lists the one computer while it is open.
struct TestRelay {
    computer_id: String,
    public: String,
    wire: Arc<Wire>,
    notify: Notify,
    closed: AtomicBool,
}

impl TestRelay {
    fn computer(&self) -> Value {
        json!({
            "deviceId": self.computer_id,
            "publicKey": self.public,
            "name": NAME,
            "platform": "darwin",
            "kind": "desktop",
            "acceptsRemoteControl": true,
        })
    }
}

impl RelayPort for TestRelay {
    fn alive(&self) -> bool {
        !self.closed.load(Ordering::SeqCst)
    }
    fn announce(&self) -> bool {
        if !self.alive() {
            return false;
        }
        (self.notify)(Notice::Opened(self.peers()));
        true
    }
    fn peers(&self) -> Vec<Value> {
        if self.alive() {
            vec![self.computer()]
        } else {
            Vec::new()
        }
    }
    fn peer(&self, id: &str) -> Option<Value> {
        (self.alive() && id == self.computer_id).then(|| self.computer())
    }
    fn open_session(
        &self,
        peer: &str,
        _public: &str,
        _seed: [u8; 32],
        emit: Emit,
    ) -> Result<Box<dyn PeerSession>> {
        if self.peer(peer).is_none() {
            return Err(RpcFailure::local(
                "peer_offline",
                "The computer is offline.",
            ));
        }
        let (session, inbox) = mpsc::unbounded_channel();
        if let Ok(mut current) = self.wire.inbox.lock() {
            *current = Some(session);
        }
        Ok(Box::new(TestSession {
            peer: peer.to_owned(),
            emit,
            wire: self.wire.clone(),
            inbox,
            next_id: 1,
        }))
    }
    fn close(&self, reason: &str) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            (self.notify)(Notice::Closed(reason.to_owned()));
        }
    }
    fn probe(&self, _limit: Duration) -> BoxFuture<'_, bool> {
        Box::pin(async move { self.alive() })
    }
}

/// One session with the computer: request envelopes out to the host,
/// responses and events in from [`TestDesktop::deliver`].
struct TestSession {
    peer: String,
    emit: Emit,
    wire: Arc<Wire>,
    inbox: mpsc::UnboundedReceiver<Value>,
    next_id: u64,
}

enum Received {
    Response(u64, Result<Value>),
    Ended,
    Nothing,
}

fn end(code: &'static str, reason: &str) -> SessionEnd {
    SessionEnd {
        code,
        reason: reason.to_owned(),
    }
}

fn timed_out() -> RpcFailure {
    RpcFailure::of(FailureKind::Timeout, "timeout", rpc::NO_ANSWER)
}

impl TestSession {
    fn send(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({"kind": "request", "id": id, "method": method, "params": params});
        let _ = self.wire.requests.send(request.to_string());
        id
    }

    /// A response, or the end; an event is emitted here, in delivery order.
    fn read(&self, message: &Value) -> Received {
        let Some(envelope) = v8::as_map(message) else {
            return Received::Nothing;
        };
        match envelope["kind"].as_str() {
            Some("response") => match envelope["id"].as_u64() {
                Some(id) => Received::Response(
                    id,
                    if envelope["ok"] == true {
                        Ok(envelope["value"].clone())
                    } else {
                        Err(rpc::refusal(v8::plain(&envelope["error"])))
                    },
                ),
                None => Received::Nothing,
            },
            Some("event") if envelope["name"] == "session.ended" => Received::Ended,
            Some("event") => {
                (self.emit)(json!({"event": "event", "computerId": self.peer, "message": message}));
                Received::Nothing
            }
            _ => Received::Nothing,
        }
    }
}

impl PeerSession for TestSession {
    fn set_visible(&mut self, _visible: bool) {}
    fn fail(&mut self, _code: &'static str, _reason: &str) {}
    fn establish<'a>(&'a mut self, _purpose: &'a str) -> BoxFuture<'a, Result<String>> {
        Box::pin(async { Ok(String::new()) })
    }
    fn call<'a>(
        &'a mut self,
        method: &'a str,
        params: Value,
        limit: Duration,
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            let id = self.send(method, params);
            let deadline = Instant::now() + limit;
            loop {
                let message = tokio::select! {
                    message = self.inbox.recv() => message,
                    _ = sleep_until(deadline) => return Err(timed_out()),
                };
                match message.as_ref().map(|m| self.read(m)) {
                    None | Some(Received::Ended) => return Err(rpc::ended("session_ended")),
                    Some(Received::Response(answered, result)) if answered == id => return result,
                    Some(_) => {}
                }
            }
        })
    }
    fn close(&mut self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
    fn run(
        self: Box<Self>,
        version: u64,
        mut commands: mpsc::UnboundedReceiver<Command>,
    ) -> BoxFuture<'static, SessionEnd> {
        let mut session = *self;
        Box::pin(async move {
            // Dropped unanswered, a reply fails as an ended session.
            let mut pending: HashMap<u64, (Responder, Instant)> = HashMap::new();
            let ended = loop {
                let next = pending.values().map(|(_, deadline)| *deadline).min();
                tokio::select! {
                    command = commands.recv() => match command {
                        None => break end("closed", rpc::LOCAL_CLOSE),
                        Some(Command::Request { method, params, timeout, reply }) => {
                            let id = session.send(&method, params);
                            pending.insert(id, (reply, Instant::now() + timeout));
                        }
                        Some(Command::HostInfo { reply }) => {
                            let id = session.send("session.hello", rpc::hello_params(version));
                            pending.insert(id, (reply, Instant::now() + Duration::from_secs(15)));
                        }
                        Some(Command::Visible(_)) => {}
                        Some(Command::Close { code, .. }) => break end(code, rpc::LOCAL_CLOSE),
                    },
                    message = session.inbox.recv() => match message.as_ref().map(|m| session.read(m)) {
                        None | Some(Received::Ended) => {
                            break end("session_ended", "The computer ended the session.");
                        }
                        Some(Received::Response(id, result)) => {
                            if let Some((reply, _)) = pending.remove(&id) {
                                reply.send(result);
                            }
                        }
                        Some(Received::Nothing) => {}
                    },
                    _ = sleep_until(next.unwrap_or_else(Instant::now)), if next.is_some() => {
                        let now = Instant::now();
                        let expired: Vec<u64> = pending
                            .iter()
                            .filter(|(_, (_, deadline))| *deadline <= now)
                            .map(|(id, _)| *id)
                            .collect();
                        for id in expired {
                            if let Some((reply, _)) = pending.remove(&id) {
                                reply.send(Err(timed_out()));
                            }
                        }
                    }
                }
            };
            drop(pending);
            session.inbox.close();
            if let Ok(mut current) = session.wire.inbox.lock()
                && current.as_ref().is_some_and(|inbox| inbox.is_closed())
            {
                *current = None;
            }
            (session.emit)(json!({
                "event": "closed",
                "computerId": session.peer,
                "code": ended.code,
                "reason": ended.reason,
            }));
            ended
        })
    }
}

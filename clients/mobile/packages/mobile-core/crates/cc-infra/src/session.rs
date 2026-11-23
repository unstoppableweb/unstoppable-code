//! Session and RPC for one computer, mirroring `desktop/session.dart` and
//! `request_queue.dart`. One owner serializes crypto counters and writes.
use crate::{
    error::{Error, Kind, Result},
    relay::{Inbound, Socket},
};
use cc_app::ports::{Command, Emit, Responder, SessionEnd as End};
use cc_protocol::{
    rpc::{
        self, ENDED, LOCAL_CLOSE, NO_ANSWER, NOT_SENT_MESSAGE, check_version, ended, envelope,
        hello_params, not_connected, not_sent,
    },
    secure::{Channel, Handshake},
    v8::{self, Assembler},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    time::Duration,
};
use tokio::{
    sync::mpsc,
    time::{Instant, Interval, MissedTickBehavior, interval_at, sleep, sleep_until, timeout},
};

const MAX_IN_FLIGHT: usize = 8;
const KEEPALIVE: Duration = Duration::from_secs(15);

fn end(code: &'static str, reason: &str) -> End {
    End {
        code,
        reason: reason.into(),
    }
}

enum SendError {
    /// The value could not be encoded: only this message fails.
    Encode,
    End(End),
}

/// What a wait on the wire produced. Waiting is cancel-safe; processing is not
/// and always runs outside `select!`.
pub(crate) enum Wire {
    Inbound(Option<Inbound>),
    Keepalive,
}
enum Received {
    Nothing,
    Response { id: u64, result: Result<Value> },
    Ended(End),
}

struct Secure {
    handshake: Handshake,
    channel: Channel,
    assembler: Assembler,
    keepalive: Interval,
}

pub(crate) struct Session {
    peer: String,
    public: String,
    seed: [u8; 32],
    socket: Socket,
    secure: Option<Secure>,
    next_id: u64,
    visible: bool,
    /// Set once the session ended on its own; no `close` is sent after that.
    pub end: Option<End>,
    emit: Emit,
}

impl Session {
    pub(crate) fn new(
        socket: Socket,
        peer: &str,
        public: &str,
        seed: [u8; 32],
        emit: Emit,
    ) -> Self {
        Self {
            peer: peer.into(),
            public: public.into(),
            seed,
            socket,
            secure: None,
            next_id: 1,
            visible: false,
            end: None,
            emit,
        }
    }
    pub(crate) fn set_visible(&mut self, visible: bool) {
        self.visible = visible;
    }
    /// Marks the session ended without sending `close`, as Dart's `_end`.
    pub(crate) fn fail(&mut self, code: &'static str, reason: &str) {
        if self.end.is_none() {
            self.end = Some(end(code, reason));
        }
    }

    /// Runs a handshake for `purpose` and returns the pairing code. Any
    /// failure ends the session, as in Dart.
    pub(crate) async fn establish(&mut self, purpose: &str) -> Result<String> {
        let unfinished = |code: &str| Error::local(code, "The secure connection did not finish.");
        if self.secure.is_some()
            && let Err(error) = self
                .send(&json!({"kind":"close","reason":"new_session"}))
                .await
        {
            return Err(match error {
                SendError::Encode => unfinished("handshake_failed"),
                SendError::End(end) => {
                    let code = end.code;
                    self.end = Some(end);
                    unfinished(code)
                }
            });
        }
        self.secure = None;
        let mut handshake = Handshake::new(self.seed, &self.peer, &self.public, purpose)
            .map_err(|_| unfinished("peer_identity"))?;
        let hello = handshake.start()?;
        let result = timeout(Duration::from_secs(15), async {
            let frame = envelope(
                &self.peer,
                &handshake.session,
                16,
                hello.to_string().as_bytes(),
            )?;
            self.socket
                .send(frame)
                .await
                .map_err(|_| unfinished("relay_closed"))?;
            loop {
                let b = match self.socket.next().await {
                    Some(Inbound::Frame(b)) => b,
                    Some(Inbound::Closed { code, reason }) => {
                        self.end = Some(End {
                            code,
                            reason: reason.clone(),
                        });
                        return Err(unfinished(code));
                    }
                    None => return Err(unfinished("relay_closed")),
                };
                if b.len() < 41 || b[25..41] != handshake.session {
                    continue;
                }
                let value: Value =
                    serde_json::from_slice(&b[41..]).map_err(|_| unfinished("handshake_failed"))?;
                match b[24] {
                    17 => {
                        let reply = handshake.hello2(value).map_err(|e| unfinished(&e.code))?;
                        let frame = envelope(
                            &self.peer,
                            &handshake.session,
                            18,
                            reply.to_string().as_bytes(),
                        )?;
                        self.socket
                            .send(frame)
                            .await
                            .map_err(|_| unfinished("relay_closed"))?;
                    }
                    19 => {
                        let (channel, code) =
                            handshake.hello4(value).map_err(|e| unfinished(&e.code))?;
                        return Ok((channel, code));
                    }
                    _ => return Err(unfinished("handshake_order")),
                }
            }
        })
        .await
        .map_err(|_| unfinished("handshake_timeout"))
        .flatten();
        let (channel, code) = match result {
            Ok(v) => v,
            Err(error) => {
                if self.end.is_none() {
                    self.end = Some(end(
                        "handshake_failed",
                        "The secure handshake did not finish.",
                    ));
                }
                return Err(error);
            }
        };
        let mut keepalive = interval_at(Instant::now() + KEEPALIVE, KEEPALIVE);
        keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);
        self.secure = Some(Secure {
            handshake,
            channel,
            assembler: Assembler::default(),
            keepalive,
        });
        Ok(code)
    }

    async fn send(&mut self, value: &Value) -> std::result::Result<(), SendError> {
        if let Some(end) = &self.end {
            return Err(SendError::End(end.clone()));
        }
        let fragments = v8::encode(value).map_err(|_| SendError::Encode)?;
        let secure = self
            .secure
            .as_mut()
            .ok_or_else(|| SendError::End(end("not_secure", ENDED)))?;
        let session = secure.handshake.session;
        let aad = [&[32], session.as_slice()].concat();
        for fragment in fragments {
            let failed = |_| SendError::End(end("channel_failed", ENDED));
            let sealed = secure.channel.seal(&fragment, &aad).map_err(failed)?;
            let frame = envelope(&self.peer, &session, 32, &sealed).map_err(failed)?;
            self.socket
                .send(frame)
                .await
                .map_err(|_| SendError::End(end("relay_closed", "The relay disconnected.")))?;
        }
        Ok(())
    }

    /// Cancel-safe wait for the next frame or keepalive tick.
    pub(crate) async fn wait(&mut self) -> Wire {
        match self.secure.as_mut() {
            Some(secure) => tokio::select! {
                inbound = self.socket.next() => Wire::Inbound(inbound),
                _ = secure.keepalive.tick() => Wire::Keepalive,
            },
            None => Wire::Inbound(self.socket.next().await),
        }
    }

    async fn process(&mut self, wire: Wire) -> Received {
        let received = match wire {
            Wire::Keepalive => match self
                .send(&json!({"kind":"event","name":"rpc.keepalive","payload":null}))
                .await
            {
                Ok(()) => Received::Nothing,
                Err(_) => {
                    Received::Ended(end("keepalive_failed", "A keepalive could not be sent."))
                }
            },
            Wire::Inbound(None) => Received::Ended(end("relay_closed", "The relay channel ended.")),
            Wire::Inbound(Some(Inbound::Closed { code, reason })) => {
                Received::Ended(End { code, reason })
            }
            Wire::Inbound(Some(Inbound::Frame(frame))) => self.receive(frame).await,
        };
        if let Received::Ended(end) = &received {
            self.end = Some(end.clone());
        }
        received
    }

    async fn receive(&mut self, frame: Vec<u8>) -> Received {
        let Some(secure) = self.secure.as_mut() else {
            return Received::Nothing;
        };
        if frame.len() < 41 || frame[25..41] != secure.handshake.session {
            // A reply to the just-closed pairing session can still arrive.
            return Received::Nothing;
        }
        if frame[24] != 32 {
            return Received::Ended(end("secure_channel_ended", "The secure connection ended."));
        }
        // Dart's reasons: a codec FormatException, or the channel's own.
        let unreadable = || {
            Received::Ended(end(
                "malformed_message",
                "Unreadable message from the computer (FormatException).",
            ))
        };
        let aad = [&[32], secure.handshake.session.as_slice()].concat();
        let Ok(clear) = secure.channel.open(&frame[41..], &aad) else {
            return Received::Ended(end(
                "malformed_message",
                "The encrypted message could not be verified.",
            ));
        };
        let value = match secure.assembler.push(&clear) {
            Ok(Some(value)) => value,
            Ok(None) => return Received::Nothing,
            Err(_) => return unreadable(),
        };
        // `deviceLinkObject`: the message must be a map. The forwarded event
        // keeps the bridge form; fields are read from the map.
        let message = value;
        let Some(value) = v8::as_map(&message) else {
            return Received::Ended(end(
                "malformed_message",
                "The peer sent an invalid message.",
            ));
        };
        let unsupported =
            || Received::Ended(end("unsupported_message", "Unsupported peer message."));
        let int_id = value["id"].is_i64() || value["id"].is_u64();
        match value["kind"].as_str() {
            Some("response") if int_id => match value["id"].as_u64() {
                Some(id) => Received::Response {
                    id,
                    result: if value["ok"] == true {
                        Ok(value["value"].clone())
                    } else {
                        Err(rpc::refusal(v8::plain(&value["error"])))
                    },
                },
                // No request has a negative id.
                None => Received::Nothing,
            },
            Some("event") => {
                if value["name"] == "session.ended" {
                    return Received::Ended(end(
                        "session_ended",
                        "The computer ended the session.",
                    ));
                }
                if value["name"] != "rpc.keepalive" {
                    (self.emit)(json!({"event":"event","computerId":self.peer,"message":message}));
                }
                Received::Nothing
            }
            Some("request") => {
                let state = rpc::window_state(
                    value["method"].as_str().unwrap_or(""),
                    v8::plain(&value["params"]),
                    self.visible,
                );
                let response = match state {
                    Some(state) => {
                        json!({"kind":"response","id":value["id"],"ok":true,"value":state})
                    }
                    None => {
                        json!({"kind":"response","id":value["id"],"ok":false,"error":{"message":"This request is unavailable on mobile.","code":"remote_unknown_method"}})
                    }
                };
                match self.send(&response).await {
                    Ok(()) => Received::Nothing,
                    Err(SendError::End(end)) => Received::Ended(end),
                    Err(SendError::Encode) => unsupported(),
                }
            }
            Some("close") => {
                Received::Ended(end("peer_closed", "The computer closed the session."))
            }
            _ => unsupported(),
        }
    }

    /// One request awaited inline, used while connecting. Inbound events,
    /// host requests and keepalives are served while it waits.
    pub(crate) async fn call(
        &mut self,
        method: &str,
        params: Value,
        limit: Duration,
    ) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        match self
            .send(&json!({"kind":"request","id":id,"method":method,"params":params}))
            .await
        {
            Ok(()) => {}
            Err(SendError::Encode) => return Err(Error::local("send_failed", NOT_SENT_MESSAGE)),
            Err(SendError::End(end)) => {
                self.end = Some(end);
                return Err(Error::local("send_failed", NOT_SENT_MESSAGE));
            }
        }
        let deadline = sleep(limit);
        tokio::pin!(deadline);
        loop {
            let wire = tokio::select! {
                wire = self.wait() => wire,
                _ = &mut deadline => return Err(Error::of(Kind::Timeout, "timeout", NO_ANSWER)),
            };
            match self.process(wire).await {
                Received::Response { id: reply, result } if reply == id => return result,
                Received::Ended(end) => return Err(ended(end.code)),
                _ => {}
            }
        }
    }

    pub(crate) async fn window_state(&mut self) -> std::result::Result<(), End> {
        let state = json!({"open":self.visible,"focused":self.visible});
        match self
            .send(&json!({"kind":"event","name":"appAdvisor.windowState","payload":state}))
            .await
        {
            Ok(()) => Ok(()),
            Err(SendError::End(end)) => Err(end),
            Err(SendError::Encode) => Ok(()),
        }
    }

    /// Sends `close` when the secure channel is still usable, bounded.
    pub(crate) async fn close(&mut self) {
        if self.end.is_none() && self.secure.is_some() {
            let _ = timeout(
                Duration::from_secs(2),
                self.send(&json!({"kind":"close","reason":"closed"})),
            )
            .await;
        }
    }
}

enum Reply {
    Call(Responder),
    HostInfo(Responder),
}
impl Reply {
    fn send(self, result: Result<Value>) {
        match self {
            Reply::Call(tx) | Reply::HostInfo(tx) => tx.send(result),
        }
    }
    /// The session could not write it. A request never reached the desktop;
    /// host info keeps Dart's `send_failed` (`session.dart:260`).
    fn unwritten(self) {
        let error = match &self {
            Reply::Call(_) => rpc::unwritten(),
            Reply::HostInfo(_) => Error::local("send_failed", NOT_SENT_MESSAGE),
        };
        self.send(Err(error));
    }
    /// The session ended before writing it.
    fn unsent(self) {
        let error = match &self {
            Reply::Call(_) => not_sent(),
            Reply::HostInfo(_) => not_connected(),
        };
        self.send(Err(error));
    }
}
struct Queued {
    method: String,
    params: Value,
    timeout: Duration,
    reply: Reply,
}
struct Pending {
    reply: Reply,
    deadline: Instant,
}

/// What the session has not written: its queue and its unread commands.
/// Whatever is left when the actor stops fails as never sent, also when
/// its task is aborted or panics; dropped, a reply would report a request
/// that may have run.
struct Unsent {
    queue: VecDeque<Queued>,
    commands: mpsc::UnboundedReceiver<Command>,
}
impl Unsent {
    fn fail(&mut self) {
        self.commands.close();
        while let Ok(command) = self.commands.try_recv() {
            match command {
                Command::Request { reply, .. } => Reply::Call(reply).unsent(),
                Command::HostInfo { reply } => Reply::HostInfo(reply).unsent(),
                _ => {}
            }
        }
        for request in self.queue.drain(..) {
            request.reply.unsent();
        }
    }
}
impl Drop for Unsent {
    fn drop(&mut self) {
        self.fail();
    }
}

enum Step {
    Command(Option<Command>),
    Wire(Wire),
    Expire,
}

/// The connected-session actor. Admits at most 8 requests at once, in FIFO
/// order; a request's timeout starts at admission. Returns why it ended and
/// whether this device closed it. Emits `closed` exactly once.
pub(crate) async fn run(
    mut session: Session,
    version: u64,
    commands: mpsc::UnboundedReceiver<Command>,
) -> (End, bool) {
    let mut unsent = Unsent {
        queue: VecDeque::new(),
        commands,
    };
    let mut pending: HashMap<u64, Pending> = HashMap::new();
    let host_info_failed = || {
        end(
            "host_info_failed",
            "Host information could not be refreshed.",
        )
    };
    let (end, local) = 'session: {
        if let Err(end) = session.window_state().await {
            break 'session (end, false);
        }
        loop {
            while pending.len() < MAX_IN_FLIGHT
                && let Some(next) = unsent.queue.pop_front()
            {
                let id = session.next_id;
                session.next_id += 1;
                let request =
                    json!({"kind":"request","id":id,"method":next.method,"params":next.params});
                match session.send(&request).await {
                    Ok(()) => {
                        pending.insert(
                            id,
                            Pending {
                                reply: next.reply,
                                deadline: Instant::now() + next.timeout,
                            },
                        );
                    }
                    Err(SendError::Encode) => next.reply.unwritten(),
                    Err(SendError::End(end)) => {
                        next.reply.unwritten();
                        session.end = Some(end.clone());
                        break 'session (end, false);
                    }
                }
            }
            let next_deadline = pending.values().map(|p| p.deadline).min();
            let step = tokio::select! {
                command = unsent.commands.recv() => Step::Command(command),
                wire = session.wait() => Step::Wire(wire),
                _ = sleep_until(next_deadline.unwrap_or_else(Instant::now)), if next_deadline.is_some() => Step::Expire,
            };
            match step {
                Step::Command(None) => {
                    session.close().await;
                    break 'session (end("closed", LOCAL_CLOSE), true);
                }
                Step::Command(Some(Command::Request {
                    method,
                    params,
                    timeout,
                    reply,
                })) => unsent.queue.push_back(Queued {
                    method,
                    params,
                    timeout,
                    reply: Reply::Call(reply),
                }),
                Step::Command(Some(Command::HostInfo { reply })) => {
                    unsent.queue.push_back(Queued {
                        method: "session.hello".into(),
                        params: hello_params(version),
                        timeout: Duration::from_secs(15),
                        reply: Reply::HostInfo(reply),
                    })
                }
                Step::Command(Some(Command::Visible(visible))) => {
                    session.visible = visible;
                    if let Err(end) = session.window_state().await {
                        break 'session (end, false);
                    }
                }
                Step::Command(Some(Command::Close { code, polite })) => {
                    if polite {
                        session.close().await;
                    }
                    break 'session (end(code, LOCAL_CLOSE), true);
                }
                Step::Wire(wire) => match session.process(wire).await {
                    Received::Nothing => {}
                    Received::Ended(end) => break 'session (end, false),
                    Received::Response { id, result } => {
                        let Some(request) = pending.remove(&id) else {
                            continue;
                        };
                        match request.reply {
                            Reply::Call(tx) => {
                                tx.send(result);
                            }
                            Reply::HostInfo(tx) => {
                                let checked = result.and_then(|hello| {
                                    check_version(&hello, version).map(|()| hello)
                                });
                                let failed = checked.is_err();
                                tx.send(checked);
                                // Dart's `_end`: the session ends here and
                                // sends nothing.
                                if failed {
                                    break 'session (host_info_failed(), false);
                                }
                            }
                        }
                    }
                },
                Step::Expire => {
                    let now = Instant::now();
                    let expired: Vec<u64> = pending
                        .iter()
                        .filter(|(_, p)| p.deadline <= now)
                        .map(|(id, _)| *id)
                        .collect();
                    let mut host_info = false;
                    for id in expired {
                        if let Some(request) = pending.remove(&id) {
                            host_info |= matches!(request.reply, Reply::HostInfo(_));
                            request
                                .reply
                                .send(Err(Error::of(Kind::Timeout, "timeout", NO_ANSWER)));
                        }
                    }
                    if host_info {
                        break 'session (host_info_failed(), false);
                    }
                }
            }
        }
    };
    unsent.fail();
    for (_, request) in pending.drain() {
        request.reply.send(Err(ended(end.code)));
    }
    (session.emit)(
        json!({"event":"closed","computerId":session.peer,"code":end.code,"reason":end.reason}),
    );
    (end, local)
}

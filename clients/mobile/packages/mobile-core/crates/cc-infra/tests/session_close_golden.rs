//! Golden: Computer Connect wire contract (Rust), lost, late and refused
//! requests.
//!
//! A connected session over the production relay socket and session actor,
//! against a local relay whose desktop completes the handshake and answers
//! only what the test scripts.
//!
//! - With 8 requests in flight, a 9th queued and a 10th still waiting to be
//!   read, the session closes: the sent requests fail as `Ended` with the
//!   session's end code (they may have run), the others as `NotSent` (safe
//!   to retry), and the desktop never received them.
//! - A request the desktop withholds its answer to fails as `Timeout` once
//!   its own deadline passes, both inline while connecting and in the
//!   session actor, and the session stays usable: a late answer to it is
//!   dropped, a desktop refusal reaches the caller as `Refused` with the
//!   desktop's code and its message cut to 4096 UTF-16 units, and an answer
//!   reaches its caller.
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use cc_app::ports::{Command, Notify, PeerSession, RelayPort, Responder};
use cc_protocol::{
    FailureKind, RpcFailure,
    rpc::{ENDED, envelope},
    secure,
    v8::{self, Assembler},
};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    net::TcpListener,
    sync::mpsc,
    task::JoinHandle,
    time::{Instant, timeout},
};
use tokio_tungstenite::tungstenite::{
    Message,
    handshake::server::{Callback, ErrorResponse, Request, Response},
};
use x25519_dalek::{PublicKey, StaticSecret};

const PROTOCOL: &str = "canopy-remote-control/1";
const PHONE_SEED: [u8; 32] = [7; 32];
const DESKTOP_SEED: [u8; 32] = [9; 32];
const IN_FLIGHT: usize = 8;
const WAIT: Duration = Duration::from_secs(10);
/// A withheld request's own limit: short, so the golden stays fast.
const LIMIT: Duration = Duration::from_millis(300);
const NO_ANSWER: &str = "The desktop peer did not answer. Reconnect to try again.";

fn b64<const N: usize>(value: &Value) -> [u8; N] {
    secure::decode(value.as_str().expect("base64url")).expect("base64url")
}

/// Accepts the relay v2 subprotocol, as the relay does.
struct RelayProtocol;
impl Callback for RelayProtocol {
    fn on_request(self, _: &Request, mut response: Response) -> Result<Response, ErrorResponse> {
        response.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            "canopy-device-relay.v2".parse().expect("header"),
        );
        Ok(response)
    }
}

enum Event {
    Phone(Message),
    Answer(Value),
    Ended,
}

/// The desktop side of one relay connection: registers the phone, answers
/// the handshake as `HandshakeResponder` does, then opens every message the
/// phone sends and reports it. It sends the phone only the messages scripted
/// on `answers`, sealed as the desktop seals them.
async fn desktop(
    listener: TcpListener,
    desktop_key: String,
    seen: mpsc::UnboundedSender<Value>,
    mut answers: mpsc::UnboundedReceiver<Value>,
) {
    let (stream, _) = listener.accept().await.expect("accept");
    let mut socket = tokio_tungstenite::accept_hdr_async(stream, RelayProtocol)
        .await
        .expect("websocket");
    let Some(Ok(Message::Text(hello))) = socket.next().await else {
        panic!("relay hello");
    };
    let hello: Value = serde_json::from_str(hello.as_str()).expect("hello");
    let desktop_id = secure::device_id(&desktop_key).expect("device id");
    let peer = json!({"deviceId": desktop_id, "publicKey": desktop_key, "name": "Fixture Mac",
        "platform": "darwin", "acceptsRemoteControl": true, "kind": "desktop"});
    let ready = json!({"type": "ready", "deviceId": hello["device"]["deviceId"],
        "peers": [peer], "features": ["device-kind"]});
    socket
        .send(Message::Text(ready.to_string().into()))
        .await
        .expect("ready");

    let identity = SigningKey::from_bytes(&DESKTOP_SEED);
    let ephemeral = StaticSecret::from([5; 32]);
    let responder_ephemeral = PublicKey::from(&ephemeral).to_bytes();
    let responder_nonce = [6u8; 32];
    let mut hello1 = Value::Null;
    let mut receive: Option<(Aes256Gcm, u64)> = None;
    let mut send: Option<(Aes256Gcm, u64, [u8; 16])> = None;
    let mut assembler = Assembler::default();
    loop {
        let event = tokio::select! {
            message = socket.next() => match message {
                Some(Ok(message)) => Event::Phone(message),
                _ => Event::Ended,
            },
            Some(answer) = answers.recv(), if send.is_some() => Event::Answer(answer),
        };
        let message = match event {
            Event::Ended => break,
            Event::Phone(message) => message,
            Event::Answer(answer) => {
                let (key, counter, session) = send.as_mut().expect("secure channel");
                let aad = [&[32u8][..], session.as_slice()].concat();
                for fragment in v8::encode(&answer).expect("answer encodes") {
                    let mut nonce = [0u8; 12];
                    nonce[4..].copy_from_slice(&counter.to_be_bytes());
                    let sealed = key
                        .encrypt(
                            Nonce::from_slice(&nonce),
                            Payload {
                                msg: &fragment,
                                aad: &aad,
                            },
                        )
                        .expect("seals");
                    let body = [counter.to_be_bytes().as_slice(), &sealed].concat();
                    *counter += 1;
                    let frame = envelope(&desktop_id, session, 32, &body).expect("frame");
                    socket
                        .send(Message::Binary(frame.into()))
                        .await
                        .expect("answer sent");
                }
                continue;
            }
        };
        let Message::Binary(frame) = message else {
            continue;
        };
        let session: [u8; 16] = frame[25..41].try_into().expect("session");
        let reply = |kind: u8, body: Value| {
            Message::Binary(
                envelope(&desktop_id, &session, kind, body.to_string().as_bytes())
                    .expect("frame")
                    .into(),
            )
        };
        match frame[24] {
            16 => {
                hello1 = serde_json::from_slice(&frame[41..]).expect("hello1");
                let hello2 = json!({"responderKey": desktop_key,
                    "ephemeral": secure::encode(&responder_ephemeral),
                    "nonce": secure::encode(&responder_nonce)});
                socket.send(reply(17, hello2)).await.expect("hello2");
            }
            18 => {
                let hello3: Value = serde_json::from_slice(&frame[41..]).expect("hello3");
                let initiator_ephemeral = b64::<32>(&hello3["ephemeral"]);
                let mut transcript = Vec::new();
                for part in [
                    PROTOCOL.as_bytes(),
                    hello1["purpose"].as_str().expect("purpose").as_bytes(),
                    &session,
                    &b64::<32>(&hello1["initiatorKey"]),
                    &identity.verifying_key().to_bytes(),
                    &b64::<32>(&hello1["commitment"]),
                    &initiator_ephemeral,
                    &b64::<32>(&hello3["nonce"]),
                    &responder_ephemeral,
                    &responder_nonce,
                ] {
                    transcript.extend((part.len() as u32).to_be_bytes());
                    transcript.extend(part);
                }
                let hash: [u8; 32] = Sha256::digest(transcript).into();
                let signature = identity.sign(&[b"responder".as_slice(), &hash].concat());
                let shared = ephemeral.diffie_hellman(&PublicKey::from(initiator_ephemeral));
                let mut traffic = [0; 64];
                Hkdf::<Sha256>::new(Some(&hash), shared.as_bytes())
                    .expand(format!("{PROTOCOL} traffic").as_bytes(), &mut traffic)
                    .expect("traffic keys");
                // The phone sends with the first key, the desktop with the
                // second.
                receive = Some((Aes256Gcm::new_from_slice(&traffic[..32]).expect("key"), 0));
                send = Some((
                    Aes256Gcm::new_from_slice(&traffic[32..]).expect("key"),
                    0,
                    session,
                ));
                let hello4 = json!({"signature": secure::encode(&signature.to_bytes())});
                socket.send(reply(19, hello4)).await.expect("hello4");
            }
            32 => {
                let (key, counter) = receive.as_mut().expect("secure channel");
                let mut nonce = [0u8; 12];
                nonce[4..].copy_from_slice(&counter.to_be_bytes());
                assert_eq!(frame[41..49], counter.to_be_bytes(), "phone counter");
                *counter += 1;
                let aad = [&[32u8][..], &session].concat();
                let clear = key
                    .decrypt(
                        Nonce::from_slice(&nonce),
                        Payload {
                            msg: &frame[49..],
                            aad: &aad,
                        },
                    )
                    .expect("phone frame opens");
                if let Some(value) = assembler.push(&clear).expect("phone message reads") {
                    let _ = seen.send(value);
                }
            }
            kind => panic!("unexpected frame kind {kind}"),
        }
    }
}

fn failure(result: &Result<Value, RpcFailure>) -> (FailureKind, &str, Option<&str>) {
    let error = result.as_ref().expect_err("the request failed");
    (error.kind, error.code.as_str(), error.message.as_deref())
}

/// The phone side, connected through the production relay socket and
/// secure session to the scripted desktop.
struct Connected {
    session: Box<dyn PeerSession>,
    /// What the desktop opened, in order.
    seen: mpsc::UnboundedReceiver<Value>,
    /// What the desktop sends the phone next.
    answers: mpsc::UnboundedSender<Value>,
    server: JoinHandle<()>,
    relay: Arc<dyn RelayPort>,
    connectors: cc_infra::Connectors,
    dir: PathBuf,
}

async fn connect(name: &str) -> Connected {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listen");
    let port = listener.local_addr().expect("port").port();
    let desktop_key = secure::encode(
        &SigningKey::from_bytes(&DESKTOP_SEED)
            .verifying_key()
            .to_bytes(),
    );
    let desktop_id = secure::device_id(&desktop_key).expect("device id");
    let (seen_tx, seen) = mpsc::unbounded_channel();
    let (answers, answers_rx) = mpsc::unbounded_channel();
    let server = tokio::spawn(desktop(listener, desktop_key.clone(), seen_tx, answers_rx));

    let dir = std::env::temp_dir().join(format!("cc-session-golden-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let connectors = cc_infra::open(
        "https://app.canopy.invalid",
        dir.join("core.sqlite").to_str().expect("path"),
        &secure::encode(&[0x11; 32]),
        None,
        None,
    )
    .expect("connectors");
    let notify: Notify = Arc::new(|_| {});
    let relay = connectors
        .relays
        .open(
            &json!({"relayUrl": format!("ws://127.0.0.1:{port}"), "token": "relay-token"}),
            PHONE_SEED,
            "Fixture Phone",
            "ios",
            notify,
        )
        .await
        .expect("relay opens");
    let mut session = relay
        .open_session(&desktop_id, &desktop_key, PHONE_SEED, Arc::new(|_| {}))
        .expect("session");
    timeout(WAIT, session.establish("control"))
        .await
        .expect("handshake in time")
        .expect("secure session");
    Connected {
        session,
        seen,
        answers,
        server,
        relay,
        connectors,
        dir,
    }
}

/// The next request the desktop opened.
async fn next_request(seen: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    loop {
        let message = timeout(WAIT, seen.recv())
            .await
            .expect("desktop message in time")
            .expect("desktop running");
        if message["kind"] == "request" {
            return message;
        }
    }
}

type Settled = (String, Result<Value, RpcFailure>);

/// A request whose result is reported on `results` under its method.
fn request(results: &mpsc::UnboundedSender<Settled>, method: &str, limit: Duration) -> Command {
    let results = results.clone();
    let key = method.to_owned();
    Command::Request {
        method: method.into(),
        params: json!({}),
        timeout: limit,
        reply: Responder::new(move |result| {
            let _ = results.send((key, result));
        }),
    }
}

async fn next_settled(results: &mut mpsc::UnboundedReceiver<Settled>) -> Settled {
    timeout(WAIT, results.recv())
        .await
        .expect("settles in time")
        .expect("a result")
}

#[tokio::test]
async fn closing_fails_sent_requests_as_ended_and_unsent_ones_as_not_sent() {
    let Connected {
        session,
        mut seen,
        answers: _answers,
        server,
        relay,
        connectors,
        dir,
    } = connect("close").await;

    let (commands, rx) = mpsc::unbounded_channel();
    let run = tokio::spawn(session.run(7, rx));
    let (results_tx, mut results) = mpsc::unbounded_channel();
    let request = |method: String| request(&results_tx, &method, Duration::from_secs(600));
    for i in 0..IN_FLIGHT {
        commands.send(request(format!("sent.{i}"))).expect("send");
    }
    commands.send(request("queued".into())).expect("send");

    // The desktop holds every admitted request, then the session closes with
    // one more still unread in its command channel.
    let mut received = Vec::new();
    while received.len() < IN_FLIGHT {
        let message = next_request(&mut seen).await;
        received.push(message["method"].as_str().expect("method").to_owned());
    }
    commands
        .send(Command::Close {
            code: "closed",
            polite: true,
        })
        .expect("close");
    commands.send(request("unread".into())).expect("send");
    let end = timeout(WAIT, run)
        .await
        .expect("closes in time")
        .expect("run");
    assert_eq!(end.code, "closed");

    drop(results_tx);
    let mut settled = BTreeMap::new();
    while let Some((method, result)) = results.recv().await {
        assert!(
            settled.insert(method.clone(), result).is_none(),
            "{method} settled once"
        );
    }
    assert_eq!(settled.len(), IN_FLIGHT + 2);
    for i in 0..IN_FLIGHT {
        assert_eq!(
            failure(&settled[&format!("sent.{i}")]),
            (FailureKind::Ended, "closed", Some(ENDED)),
            "sent.{i}: sent and lost"
        );
    }
    for method in ["queued", "unread"] {
        assert_eq!(
            failure(&settled[method]),
            (FailureKind::NotSent, "session_ended", Some(ENDED)),
            "{method}: never sent"
        );
    }

    // The desktop got the 8 sent requests and the close, nothing else.
    drop(relay);
    drop(connectors);
    timeout(WAIT, server)
        .await
        .expect("relay ends in time")
        .expect("desktop");
    while let Ok(message) = seen.try_recv() {
        match message["kind"].as_str() {
            Some("request") => received.push(message["method"].as_str().expect("method").into()),
            Some("close") => received.push("close".into()),
            _ => {}
        }
    }
    let mut expected: Vec<String> = (0..IN_FLIGHT).map(|i| format!("sent.{i}")).collect();
    expected.push("close".into());
    assert_eq!(received, expected);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_withheld_answer_times_out_and_the_session_keeps_serving() {
    let Connected {
        mut session,
        mut seen,
        answers,
        server,
        relay,
        connectors,
        dir,
    } = connect("timeout").await;
    let timed_out = (FailureKind::Timeout, "timeout", Some(NO_ANSWER));

    // While connecting: an inline call the desktop does not answer.
    let started = Instant::now();
    let inline = timeout(WAIT, session.call("session.hello", json!({}), LIMIT))
        .await
        .expect("the call ends in time");
    assert!(started.elapsed() >= LIMIT, "not before its deadline");
    assert_eq!(failure(&inline), timed_out, "inline call");
    let hello = next_request(&mut seen).await;
    assert_eq!(hello["method"], "session.hello");

    // Connected: an admitted request the desktop does not answer.
    let (commands, rx) = mpsc::unbounded_channel();
    let run = tokio::spawn(session.run(7, rx));
    let (results_tx, mut results) = mpsc::unbounded_channel();
    let started = Instant::now();
    commands
        .send(request(&results_tx, "withheld", LIMIT))
        .expect("send");
    let withheld = next_request(&mut seen).await;
    assert_eq!(withheld["method"], "withheld");
    let (method, result) = next_settled(&mut results).await;
    assert!(started.elapsed() >= LIMIT, "not before its deadline");
    assert_eq!(method, "withheld");
    assert_eq!(failure(&result), timed_out, "session request");

    // Late answers to both are dropped, and the session keeps serving.
    for late in [&hello, &withheld] {
        answers
            .send(json!({"kind": "response", "id": late["id"], "ok": true, "value": "late"}))
            .expect("late answer");
    }
    // A refusal keeps the desktop's code and the first 4096 UTF-16 units of
    // its message, never splitting a surrogate pair.
    commands
        .send(request(&results_tx, "refused", WAIT))
        .expect("send");
    let refused = next_request(&mut seen).await;
    let long = format!("{}🦀tail", "a".repeat(4095));
    answers
        .send(json!({"kind": "response", "id": refused["id"], "ok": false,
            "error": {"code": "remote_channel_unavailable", "message": long}}))
        .expect("refusal");
    let (method, result) = next_settled(&mut results).await;
    assert_eq!(method, "refused");
    assert_eq!(
        failure(&result),
        (
            FailureKind::Refused,
            "remote_channel_unavailable",
            Some("a".repeat(4095).as_str())
        )
    );
    commands
        .send(request(&results_tx, "answered", WAIT))
        .expect("send");
    let answered = next_request(&mut seen).await;
    answers
        .send(json!({"kind": "response", "id": answered["id"], "ok": true,
            "value": {"done": true}}))
        .expect("answer");
    let (method, result) = next_settled(&mut results).await;
    assert_eq!(method, "answered");
    assert_eq!(result.expect("answered"), json!({"done": true}));

    commands
        .send(Command::Close {
            code: "closed",
            polite: true,
        })
        .expect("close");
    let end = timeout(WAIT, run)
        .await
        .expect("closes in time")
        .expect("run");
    assert_eq!(end.code, "closed", "the late answers did not end it");
    drop(results_tx);
    assert!(
        results.recv().await.is_none(),
        "a late answer settles nothing"
    );

    drop(relay);
    drop(connectors);
    timeout(WAIT, server)
        .await
        .expect("relay ends in time")
        .expect("desktop");
    let _ = std::fs::remove_dir_all(&dir);
}

//! The JSON-over-C-callback ABI (feature `legacy-json`), kept for scratch
//! tooling until cleanup C3. It maps `{op, ...}` calls onto the typed facade
//! and its results back to the contract-v2 JSON shapes.
//!
//! Calls are submitted with a caller id and complete through the host
//! callback with `{id, ok, value|error}`; events use the same callback as
//! `{event, ...}`. The callback receives a NUL-terminated UTF-8 JSON string
//! and its byte length; the host frees the string with `cc_free_string`. One
//! dispatcher thread invokes the callback, so messages arrive in emission
//! order. After `cc_close` returns, the callback is never invoked again.
use cc_core::{
    AuthSession, AuthStatus, BridgeEvent, BridgeMessage, CacheScope, Config, Core, CoreFailure,
    FailureKind, HttpRequest, IdentityImport, SessionCall, SignInStep, SignedInView,
};
use serde_json::{Value, json};
use std::{
    ffi::{CStr, CString, c_char},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::mpsc,
    thread::JoinHandle,
};
use tokio::runtime::Runtime;

type Callback = extern "C" fn(*mut c_char, usize);

struct Handle {
    core: Core,
    runtime: Option<Runtime>,
    out: mpsc::Sender<Option<String>>,
    pump: Option<JoinHandle<()>>,
    dispatcher: Option<JoinHandle<()>>,
}

const MAX_INPUT: usize = 24 * 1024 * 1024;
const MAX_JSON_DEPTH: usize = 2048;

fn local(code: &str) -> CoreFailure {
    CoreFailure {
        kind: FailureKind::Local,
        code: code.into(),
        message: None,
        status: None,
        protocol_version: None,
        retry_after: None,
        step: None,
    }
}

fn error_json(e: &CoreFailure) -> Value {
    let kind = match e.kind {
        FailureKind::Local => "local",
        FailureKind::Refused => "refused",
        FailureKind::NotSent => "not_sent",
        FailureKind::Timeout => "timeout",
        FailureKind::Ended => "ended",
        FailureKind::Http => "http",
    };
    let mut v = json!({"kind": kind, "code": e.code});
    if let Some(m) = &e.message {
        v["message"] = json!(m);
    }
    if let Some(s) = e.status {
        v["status"] = json!(s);
    }
    if let Some(p) = e.protocol_version {
        v["protocolVersion"] = json!(p);
    }
    if let Some(r) = e.retry_after {
        v["retryAfter"] = json!(r);
    }
    if let Some(s) = &e.step {
        v["step"] = json!(s);
    }
    v
}

fn quote(s: &str) -> String {
    Value::from(s).to_string()
}

/// A bridge message in its contract-v2 JSON form; bridge values are
/// embedded as they are, without a second parse.
fn message_json(message: BridgeMessage) -> String {
    match message {
        BridgeMessage::Reply { id, value_json } => {
            format!(r#"{{"id":{id},"ok":true,"value":{value_json}}}"#)
        }
        BridgeMessage::Failed { id, failure } => {
            json!({"id":id,"ok":false,"error":error_json(&failure)}).to_string()
        }
        BridgeMessage::Event(event) => match event {
            BridgeEvent::PairingCode { computer_id, code } => {
                json!({"event":"pairingCode","computerId":computer_id,"code":code}).to_string()
            }
            BridgeEvent::Message {
                computer_id,
                message_json,
            } => format!(
                r#"{{"event":"event","computerId":{},"message":{message_json}}}"#,
                quote(&computer_id)
            ),
            BridgeEvent::Closed {
                computer_id,
                code,
                reason,
            } => json!({"event":"closed","computerId":computer_id,"code":code,"reason":reason})
                .to_string(),
            BridgeEvent::RelayOpened { peers_json } => {
                format!(r#"{{"event":"relay","state":"opened","peers":{peers_json}}}"#)
            }
            BridgeEvent::RelayClosed { reason } => {
                json!({"event":"relay","state":"closed","reason":reason}).to_string()
            }
            BridgeEvent::Peers { peers_json } => {
                format!(r#"{{"event":"peers","peers":{peers_json}}}"#)
            }
        },
    }
}

fn response(result: Result<Value, CoreFailure>) -> *mut c_char {
    CString::new(
        match result {
            Ok(v) => json!({"ok":true,"value":v}),
            Err(e) => json!({"ok":false,"error":error_json(&e)}),
        }
        .to_string(),
    )
    .expect("JSON contains no NUL")
    .into_raw()
}
unsafe fn bytes<'a>(raw: *const c_char) -> Result<&'a [u8], CoreFailure> {
    if raw.is_null() {
        return Err(local("null_input"));
    }
    let bytes = unsafe { CStr::from_ptr(raw) }.to_bytes();
    if bytes.len() > MAX_INPUT {
        return Err(local("input_too_large"));
    }
    Ok(bytes)
}

/// Parses a call. JSON nesting is bounded here instead of by serde's
/// recursion limit, as the core bounds it.
fn parse_call(raw: &[u8]) -> Result<Value, CoreFailure> {
    let (mut depth, mut deepest, mut in_string, mut escaped) = (0usize, 0usize, false, false);
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
        return Err(local("invalid_json"));
    }
    let mut de = serde_json::Deserializer::from_slice(raw);
    de.disable_recursion_limit();
    let value =
        <Value as serde::Deserialize>::deserialize(&mut de).map_err(|_| local("invalid_json"))?;
    de.end().map_err(|_| local("invalid_json"))?;
    Ok(value)
}

fn string(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_owned()
}
/// A non-null JSON value as text.
fn json_text(v: &Value) -> Option<String> {
    (!v.is_null()).then(|| v.to_string())
}
/// `null` means absent; anything else must be an unsigned integer.
fn millis(v: &Value) -> Option<u64> {
    (!v.is_null()).then(|| v.as_u64().unwrap_or(0))
}
fn signed_in(s: &SignedInView) -> Value {
    json!({
        "status": "signedIn",
        "user": serde_json::from_str::<Value>(&s.user_json).unwrap_or(Value::Null),
        "accountChanged": s.account_changed,
        "hasAccount": s.has_account,
    })
}
fn session(s: AuthSession) -> Value {
    match s {
        AuthSession::SignedIn(s) => signed_in(&s),
        AuthSession::SignedOut => json!({"status": "signedOut"}),
    }
}
fn step(s: SignInStep) -> Value {
    match s {
        SignInStep::SignedIn(s) => signed_in(&s),
        SignInStep::TwoFactorRequired { challenge } => json!({
            "status": "twoFactorRequired", "twoFactorRequired": true, "challenge": challenge,
        }),
        SignInStep::VerificationRequired => {
            json!({"status": "verificationRequired", "verificationRequired": true})
        }
        SignInStep::Cancelled => json!({"status": "cancelled", "cancelled": true}),
    }
}

/// The session call `op` names, if it is one.
fn session_call(op: &str, v: &Value) -> Option<SessionCall> {
    let computer_id = string(v, "computerId");
    Some(match op {
        "connect" => SessionCall::Connect {
            computer_id,
            allow_pairing: v["allowPairing"].as_bool(),
            visible: v["visible"].as_bool(),
        },
        "ipc.invoke" => SessionCall::Invoke {
            computer_id,
            channel: string(v, "channel"),
            args_json: v["args"].to_string(),
            surface: v["surface"].as_str().map(String::from),
            timeout_ms: millis(&v["timeoutMs"]),
        },
        "host.info" => SessionCall::HostInfo { computer_id },
        "orchestrator.setVisible" => SessionCall::SetOrchestratorVisible {
            computer_id,
            visible: v["visible"].as_bool()?,
        },
        _ => return None,
    })
}

/// Runs one non-session operation through the facade.
async fn command(core: Core, op: String, v: Value) -> Result<Value, CoreFailure> {
    let auth = core.auth();
    let bridge = core.transport_bridge();
    let diagnostics = core.diagnostics();
    let force = v["force"].as_bool().unwrap_or(false);
    let null = |r: Result<(), CoreFailure>| r.map(|()| Value::Null);
    let parsed = |raw: Option<String>| {
        raw.map(|s| serde_json::from_str::<Value>(&s).unwrap_or(Value::Null))
            .unwrap_or(Value::Null)
    };
    match op.as_str() {
        "auth.restore" => auth.restore().await.map(session),
        "auth.status" => auth.status().await.map(|s| match s {
            AuthStatus::SignedIn(s) => signed_in(&s),
            AuthStatus::Unverified { last_user_json } => {
                json!({"status": "unverified", "hasAccount": false, "lastUser": parsed(last_user_json)})
            }
            AuthStatus::SignedOut => json!({"status": "signedOut", "hasAccount": false}),
        }),
        "auth.adopt" => auth
            .adopt(
                string(&v, "token"),
                v["twoFactorProof"].as_str().map(String::from),
                v["accountId"].as_str().map(String::from),
            )
            .await
            .map(session),
        "auth.forget" => null(auth.forget().await),
        "pins.list" => bridge.pins().await.map(|pins| {
            Value::Object(
                pins.into_iter()
                    .map(|p| (p.computer_id, Value::String(p.public_key)))
                    .collect(),
            )
        }),
        "auth.begin" => auth
            .begin_oauth(string(&v, "provider"), string(&v, "callbackUrl"))
            .await
            .map(|s| json!({"authorizeUrl": s.authorize_url, "callbackUrl": s.callback_url})),
        "auth.callback" => auth.complete_oauth(string(&v, "url")).await.map(step),
        "auth.apple.begin" => auth
            .begin_apple()
            .await
            .map(|s| json!({"nonceHash": s.nonce_hash})),
        "auth.apple.complete" => auth
            .complete_apple(
                string(&v, "identityToken"),
                v["name"].as_str().map(String::from),
            )
            .await
            .map(step),
        "auth.two_factor" => auth
            .two_factor(string(&v, "challenge"), string(&v, "code"))
            .await
            .map(step),
        "auth.email.begin" => auth
            .email_sign_in(string(&v, "email"), string(&v, "password"))
            .await
            .map(step),
        "auth.email.request" => {
            let body = &v["body"];
            let valid = |s: &str| !s.is_empty() && s.len() <= 4096;
            let otp = || {
                let otp = string(body, "otp");
                if valid(&otp) { otp } else { string(body, "code") }
            };
            let done = |r: Result<(), CoreFailure>| r.map(|()| json!({}));
            match v["action"].as_str().filter(|a| valid(a)) {
                None => Err(local("invalid_input")),
                Some("available") => auth
                    .email_available()
                    .await
                    .map(|enabled| json!({ "enabled": enabled })),
                Some("sign_up") => done(
                    auth.email_sign_up(string(body, "email"), string(body, "password"))
                        .await,
                ),
                Some("verify") => done(auth.email_verify(string(body, "email"), otp()).await),
                Some("forgot") => done(auth.email_forgot(string(body, "email")).await),
                Some("reset") => done(
                    auth.email_reset(string(body, "email"), otp(), string(body, "password"))
                        .await,
                ),
                Some(_) => Err(local("unknown_operation")),
            }
        }
        "auth.cancel" => null(auth.cancel().await),
        "auth.sign_out" => null(auth.sign_out().await),
        "http.request" => diagnostics
            .http_request(HttpRequest {
                method: string(&v, "method"),
                path: string(&v, "path"),
                body_json: json_text(&v["body"]),
                retry_transient: (v["retryTransient"] == false).then_some(false),
                timeout_ms: v["timeoutMs"].as_u64(),
            })
            .await
            .map(|r| {
                let headers: serde_json::Map<String, Value> = r
                    .headers
                    .into_iter()
                    .map(|h| (h.name, Value::String(h.value)))
                    .collect();
                json!({"status": r.status, "headers": headers, "body": r.body})
            }),
        "legacy.cleanup" => bridge
            .cleanup_legacy_key()
            .await
            .map(|r| json!({"revoked": r.revoked, "cleared": r.cleared})),
        "identity" => bridge
            .identity()
            .await
            .map(|i| json!({"deviceId": i.device_id, "publicKey": i.public_key})),
        "identity.import" => {
            let source = match v["record"].as_str() {
                Some(record) => IdentityImport::DartRecord {
                    record: record.into(),
                },
                None => IdentityImport::Seed {
                    seed: string(&v, "seed"),
                    pins_json: json_text(&v["pins"]),
                },
            };
            bridge.import_identity(source, force).await.map(|r| {
                json!({"deviceId": r.device_id, "publicKey": r.public_key, "pins": r.pins, "replaced": r.replaced})
            })
        }
        "state.read" => diagnostics
            .read_state(string(&v, "key"))
            .await
            .map(parsed),
        "state.write" => null(
            diagnostics
                .write_state(string(&v, "key"), v["value"].to_string())
                .await,
        ),
        "saved.read" => bridge.saved_computers().await.map(parsed),
        "saved.write" => bridge
            .save_computers(v["record"].to_string(), force)
            .await
            .map(|r| parsed(Some(r))),
        "saved.import" => bridge
            .import_saved_computers(string(&v, "raw"), force)
            .await
            .map(|r| parsed(Some(r))),
        "cache.read" => diagnostics
            .cache_read(string(&v, "computerId"), string(&v, "key"))
            .await
            .map(parsed),
        "cache.write" => null(
            diagnostics
                .cache_write(
                    string(&v, "computerId"),
                    string(&v, "key"),
                    v["value"].to_string(),
                )
                .await,
        ),
        "cache.clear" => {
            let scope = if v["computerId"].is_null() {
                CacheScope::Account
            } else if v["key"].is_null() {
                CacheScope::Computer {
                    computer_id: string(&v, "computerId"),
                }
            } else {
                CacheScope::Entry {
                    computer_id: string(&v, "computerId"),
                    key: string(&v, "key"),
                }
            };
            null(diagnostics.cache_clear(scope).await)
        }
        "computers.list" => bridge
            .computers()
            .await
            .map(|peers| parsed(Some(peers))),
        "relay.status" => bridge
            .relay_status()
            .await
            .map(|s| json!({"open": s.open, "peers": parsed(Some(s.peers_json))})),
        "relay.probe" => bridge
            .relay_probe(millis(&v["timeoutMs"]))
            .await
            .map(Value::Bool),
        "connect.cancel" => bridge
            .cancel_connect(string(&v, "computerId"))
            .await
            .map(Value::Bool),
        "disconnect" => null(bridge.disconnect(string(&v, "computerId")).await),
        "forget" => null(bridge.forget(string(&v, "computerId")).await),
        "suspend" => null(bridge.suspend().await),
        _ => Err(local("unknown_operation")),
    }
}

fn config(v: &Value) -> Config {
    Config {
        origin: string(v, "origin"),
        database_path: string(v, "databasePath"),
        wrapping_key: string(v, "wrappingKey"),
        device_name: string(v, "deviceName"),
        platform: string(v, "platform"),
        client_version: v["clientVersion"].as_str().map(String::from),
        user_agent: v["userAgent"].as_str().map(String::from),
    }
}

/// Opens a core. Returns `{ok, value: handle}` synchronously; the host frees it.
///
/// # Safety
/// `raw` is a NUL-terminated UTF-8 string or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_open(raw: *const c_char, callback: Option<Callback>) -> *mut c_char {
    response(
        catch_unwind(AssertUnwindSafe(|| {
            let callback = callback.ok_or_else(|| local("null_callback"))?;
            let v: Value = serde_json::from_slice(unsafe { bytes(raw) }?)
                .map_err(|_| local("invalid_json"))?;
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(1)
                .thread_name("cc-legacy-json")
                .enable_all()
                .build()
                .map_err(|_| local("runtime_init"))?;
            let core = cc_core::open(config(&v))?;
            let (out, rx) = mpsc::channel::<Option<String>>();
            let mut messages = core.transport_bridge().messages();
            let forward = out.clone();
            let pump = std::thread::Builder::new()
                .name("computer-connect-events".into())
                .spawn(move || {
                    while let Some(message) = messages.blocking_next() {
                        let _ = forward.send(Some(message_json(message)));
                    }
                })
                .map_err(|_| local("runtime_init"))?;
            let dispatcher = std::thread::Builder::new()
                .name("computer-connect-callback".into())
                .spawn(move || {
                    while let Ok(Some(message)) = rx.recv() {
                        let length = message.len();
                        if let Ok(message) = CString::new(message) {
                            callback(message.into_raw(), length);
                        }
                    }
                })
                .map_err(|_| local("runtime_init"))?;
            let address = Box::into_raw(Box::new(Handle {
                core,
                runtime: Some(runtime),
                out,
                pump: Some(pump),
                dispatcher: Some(dispatcher),
            })) as usize;
            // A decimal string, not a JSON number: Android tags heap pointers
            // in the top byte, so addresses exceed both 2^53 and 2^63.
            Ok(json!(address.to_string()))
        }))
        .unwrap_or_else(|_| Err(local("native_panic"))),
    )
}

/// Submits `{op, ...}` as call `id`. Never blocks on work; the result arrives
/// through the callback, including input errors.
///
/// # Safety
/// `address` is a handle from `cc_open` not yet closed; `raw` is a
/// NUL-terminated UTF-8 string or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_submit(address: usize, id: i64, raw: *const c_char) {
    if address == 0 {
        return;
    }
    let handle = unsafe { &*(address as *const Handle) };
    let reply = |result: Result<Value, CoreFailure>| {
        let message = match result {
            Ok(value) => json!({"id":id,"ok":true,"value":value}),
            Err(error) => json!({"id":id,"ok":false,"error":error_json(&error)}),
        };
        let _ = handle.out.send(Some(message.to_string()));
    };
    let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<(), CoreFailure> {
        let v = parse_call(unsafe { bytes(raw) }?)?;
        let op = v["op"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 4096)
            .ok_or_else(|| local("invalid_input"))?
            .to_owned();
        if let Some(call) = session_call(&op, &v) {
            handle.core.transport_bridge().submit(id, call);
            return Ok(());
        }
        if op == "orchestrator.setVisible" {
            // A computer id is checked before `visible`, as the core does.
            return Err(local("invalid_input"));
        }
        let Some(runtime) = &handle.runtime else {
            return Err(local("shutdown"));
        };
        let core = handle.core.clone();
        let out = handle.out.clone();
        runtime.spawn(async move {
            let result = command(core, op, v).await;
            let message = match result {
                Ok(value) => json!({"id":id,"ok":true,"value":value}),
                Err(error) => json!({"id":id,"ok":false,"error":error_json(&error)}),
            };
            let _ = out.send(Some(message.to_string()));
        });
        Ok(())
    }));
    match outcome {
        Ok(Ok(())) => {}
        Ok(Err(error)) => reply(Err(error)),
        Err(_) => reply(Err(local("native_panic"))),
    }
}

/// # Safety
/// `raw` is a string this ABI returned, or null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_free_string(raw: *mut c_char) {
    if !raw.is_null() {
        drop(unsafe { CString::from_raw(raw) });
    }
}

/// Waits, at most 3 s, until the account services stored the records they
/// still held, then stops all work without waiting for network I/O. Send
/// `suspend` first to close sessions politely. Messages emitted before this call are delivered;
/// none after it returns.
///
/// # Safety
/// `address` is a handle from `cc_open`, closed at most once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cc_close(address: usize) {
    if address == 0 {
        return;
    }
    let mut handle = unsafe { Box::from_raw(address as *mut Handle) };
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if let Some(runtime) = handle.runtime.take() {
            runtime.block_on(handle.core.close());
            runtime.shutdown_background();
        }
        if let Some(pump) = handle.pump.take() {
            let _ = pump.join();
        }
        let _ = handle.out.send(None);
        if let Some(dispatcher) = handle.dispatcher.take() {
            let _ = dispatcher.join();
        }
    }));
}

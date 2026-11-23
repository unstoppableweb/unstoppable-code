//! RPC rules of a desktop session (`desktop/session.dart`, `version.dart`):
//! frame envelopes, the hello and version negotiation, refusal mapping and
//! the failures a session reports, with the Dart transport's wording.
use crate::{FailureKind as Kind, Result, RpcFailure as Error, v8};
use serde_json::{Value, json};

/// The lowest desktop protocol version this client speaks.
pub const MIN_PROTOCOL: u64 = 7;
/// `appVersion` in the session hello and the relay registration.
pub const APP_VERSION: &str = "mobile-prototype";
pub const ENDED: &str = "The connection to the computer ended.";
pub const LOCAL_CLOSE: &str = "Closed by this device.";
pub const NO_ANSWER: &str = "The desktop peer did not answer. Reconnect to try again.";
pub const NOT_SENT_MESSAGE: &str = "The request could not be sent.";

/// A request that was sent and then lost with its session.
pub fn ended(code: &str) -> Error {
    Error::of(Kind::Ended, code, ENDED)
}
/// A request that never reached the session writer (safe to retry).
pub fn not_sent() -> Error {
    Error::of(Kind::NotSent, "session_ended", ENDED)
}
pub fn not_connected() -> Error {
    Error::local("not_connected", "Connect to a computer first.")
}
/// A core service's request found no session writer to take it: with
/// [`not_connected`]'s code and words, but nothing was sent (safe to retry).
pub fn no_session() -> Error {
    Error::of(
        Kind::NotSent,
        "not_connected",
        "Connect to a computer first.",
    )
}
pub fn timed_out() -> Error {
    Error::of(Kind::Timeout, "timeout", NO_ANSWER)
}
pub fn send_failed() -> Error {
    Error::local("send_failed", NOT_SENT_MESSAGE)
}
/// A connected session's request it could not write: it failed to encode,
/// or the channel ended before its last fragment was queued, so the
/// desktop never got it (safe to retry).
pub fn unwritten() -> Error {
    Error::of(Kind::NotSent, "send_failed", NOT_SENT_MESSAGE)
}

/// A relay frame for `peer`: `[1, 22, peer(22), kind, session(16), body]`,
/// at most 64 KiB.
pub fn envelope(peer: &str, session: &[u8; 16], kind: u8, body: &[u8]) -> Result<Vec<u8>> {
    let mut frame = vec![1, 22];
    frame.extend(peer.as_bytes());
    frame.push(kind);
    frame.extend(session);
    frame.extend(body);
    if peer.len() != 22 || frame.len() > 65536 {
        return Err(Error::new("invalid_frame"));
    }
    Ok(frame)
}

/// A desktop `ok: false` response: its code (`desktop_refused` when it has
/// none) and message, cut to the first 4096 UTF-16 code units as Dart does.
pub fn refusal(error: &Value) -> Error {
    let message = match error["message"].as_str() {
        Some(message) => {
            let mut units = 0;
            message
                .chars()
                .take_while(|c| {
                    units += c.len_utf16();
                    units <= 4096
                })
                .collect::<String>()
        }
        None => "The desktop refused the request.".into(),
    };
    Error::of(
        Kind::Refused,
        error["code"].as_str().unwrap_or("desktop_refused"),
        &message,
    )
}

pub fn hello_params(version: u64) -> Value {
    json!({"version":{"protocolVersion":version,"appVersion":APP_VERSION}})
}

/// `readDesktopRemoteProtocolVersion` in `version.dart`.
pub fn read_version(hello: &Value) -> Result<u64> {
    let version = v8::plain(&v8::plain(hello)["version"])["protocolVersion"]
        .as_u64()
        .filter(|v| *v >= 1)
        .ok_or_else(|| {
            Error::local(
                "unreadable_version",
                "The computer sent an unreadable connection version. Update the desktop app and try again.",
            )
        })?;
    if version < MIN_PROTOCOL {
        let mut error = Error::local(
            "desktop_update_required",
            &format!(
                "Update the desktop app to connect to this computer. Desktop protocol: {version}. Mobile requires {MIN_PROTOCOL} or later."
            ),
        );
        error.protocol_version = Some(version);
        return Err(error);
    }
    Ok(version)
}
pub fn check_version(hello: &Value, expected: u64) -> Result<()> {
    if read_version(hello)? != expected {
        return Err(Error::local(
            "protocol_changed",
            "The computer connection version changed. Reconnect to try again.",
        ));
    }
    Ok(())
}

/// `DesktopOrchestratorWindow.handle`: the answer to a desktop
/// `appAdvisor.window` request. Desktop requests may prepare the route but
/// cannot claim it was shown or hidden; `None` for any other request.
pub fn window_state(method: &str, params: &Value, visible: bool) -> Option<Value> {
    if method != "appAdvisor.window" || !params.is_object() {
        return None;
    }
    if !matches!(
        params["action"].as_str(),
        Some("open" | "ensure" | "close" | "focus_main")
    ) {
        return None;
    }
    Some(json!({"open":visible,"focused":visible}))
}

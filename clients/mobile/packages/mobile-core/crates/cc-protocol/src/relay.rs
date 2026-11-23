//! Device relay v2 message rules (`lib/device_link/desktop/relay.dart`):
//! registration, peer validation, frame routing checks and the relay's
//! user-facing reasons.
use crate::{Result, RpcFailure as Error, field, rpc::APP_VERSION, secure};
use serde_json::{Value, json};

pub const OFFLINE: &str = "The computer went offline.";
pub const UNREACHABLE: &str = "The relay could not reach the computer.";
pub const STREAM_FAILED: &str = "Relay stream failed.";
/// Dart's relay reasons for an unreadable relay message: a `FormatException`
/// from parsing, or `deviceLinkObject`/`deviceLinkString`'s own message.
pub const UNREADABLE: &str = "Relay stream failed (FormatException).";
pub const INVALID_MESSAGE: &str = "The peer sent an invalid message.";
pub const OUTDATED: &str = "The connection service is out of date. Try again later.";
/// The largest relay text message, in UTF-16 code units.
pub const MAX_TEXT_UNITS: usize = 128 * 1024;

pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The registration `hello` for this device.
pub fn hello(device_id: &str, public_key: &str, name: &str, platform: &str) -> Value {
    json!({"type":"hello","device":{"deviceId":device_id,"publicKey":public_key,"name":name,"platform":platform,"kind":"mobile","appVersion":APP_VERSION,"acceptsRemoteControl":false}})
}

/// The peer a binary relay frame comes from, or why the frame ends the
/// relay.
pub fn frame_peer(b: &[u8]) -> std::result::Result<&str, &'static str> {
    if b.len() < 41 || b.len() > 65536 || b[..2] != [1, 22] {
        return Err("Invalid device frame.");
    }
    let peer = std::str::from_utf8(&b[2..24]).map_err(|_| "Invalid peer identity.")?;
    if !cc_domain::computers::valid_computer_id(peer) {
        return Err("Invalid peer identity.");
    }
    Ok(peer)
}

/// `DesktopRelayPeer.isComputer`.
pub fn is_computer(peer: &Value) -> bool {
    peer["kind"].is_null() || peer["kind"] == "desktop"
}

/// Why `DesktopRelayPeer.parse` rejects a computer, in its order and words.
pub fn unreadable_peer(peer: &Value) -> Option<&'static str> {
    let text = |key: &str| {
        peer[key]
            .as_str()
            .filter(|s| !s.is_empty() && utf16_len(s) <= 4096)
    };
    if !peer.is_object() {
        return Some(INVALID_MESSAGE);
    }
    let (Some(id), Some(key)) = (text("deviceId"), text("publicKey")) else {
        return Some(INVALID_MESSAGE);
    };
    if secure::device_id(key).ok().as_deref() != Some(id)
        || !matches!(
            peer["platform"].as_str(),
            Some("darwin" | "win32" | "linux")
        )
        || !peer["acceptsRemoteControl"].is_boolean()
    {
        return Some(UNREADABLE);
    }
    if text("name").is_none() {
        return Some(INVALID_MESSAGE);
    }
    None
}

/// Phones, browsers and hosted agents share the account relay; only desktops
/// (no kind is a legacy desktop) are computers. Invalid computers are errors.
pub fn computer(peer: &Value) -> Result<bool> {
    if !peer["kind"].is_null() && peer["kind"] != "desktop" {
        return Ok(false);
    }
    let invalid = || Error::local("peer_identity", "The peer sent an invalid message.");
    let name = peer["name"].as_str().ok_or_else(invalid)?;
    if name.is_empty() || utf16_len(name) > 4096 {
        return Err(invalid());
    }
    if secure::device_id(field(peer, "publicKey").map_err(|_| invalid())?)?
        != field(peer, "deviceId").map_err(|_| invalid())?
        || !matches!(
            peer["platform"].as_str(),
            Some("darwin" | "win32" | "linux")
        )
        || !peer["acceptsRemoteControl"].is_boolean()
    {
        return Err(invalid());
    }
    Ok(true)
}

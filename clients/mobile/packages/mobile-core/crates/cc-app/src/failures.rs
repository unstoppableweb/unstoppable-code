//! Which wording a core failure reads as on the account and connection
//! surfaces (`lib/device_link/rust_core/failures.dart` and
//! `desktop_link_model.dart` `describe`). Codes stay here; the words are in
//! `copy::computers`.
use crate::copy::computers::{CopyKey, FailureText, failure_text, text};
use cc_protocol::{FailureKind, RpcFailure};

/// The connection's own cancellation (`account.dart` `_token`).
pub(crate) fn cancelled() -> RpcFailure {
    RpcFailure::local("cancelled", failure_text(FailureText::Cancelled))
}

/// The wording for a local code the core sent without a message
/// (`failures.dart` `rustLocalMessages`).
fn local(code: &str) -> Option<FailureText> {
    Some(match code {
        "not_connected" => FailureText::NotConnected,
        "send_failed" => FailureText::NotSent,
        "cancelled" => FailureText::Cancelled,
        "peer_offline" | "remote_access_off" => FailureText::OfflineOrOff,
        "pairing_required" => FailureText::PairingRequired,
        "peer_identity_changed" => FailureText::IdentityChanged,
        "session_exists" => FailureText::SessionExists,
        "pairing_declined" => FailureText::PairingDeclined,
        "protocol_changed" => FailureText::ProtocolChanged,
        "unreadable_version" => FailureText::UnreadableVersion,
        "relay_connect" => FailureText::RelayConnect,
        "relay_protocol" => FailureText::RelayProtocol,
        "relay_outdated" => FailureText::RelayOutdated,
        "invalid_relay" => FailureText::InvalidRelay,
        "relay_closed" => FailureText::RelayClosed,
        "relay_auth_failed" | "invalid_token" => FailureText::RelayAuthentication,
        "shutdown" => FailureText::Shutdown,
        "identity_unreadable" => FailureText::IdentityUnreadable,
        "handshake_failed" | "handshake_timeout" | "handshake_order" | "peer_identity"
        | "peer_signature" => FailureText::SecureConnection,
        _ => return None,
    })
}

/// Codes only a broken caller or a core bug produce; Dart surfaces them as a
/// `StateError`, which each surface words generically.
fn contract(code: &str) -> bool {
    matches!(
        code,
        "invalid_input" | "invalid_json" | "invalid_surface" | "unknown_operation" | "native_panic"
    )
}

/// The HTTP status of an access failure (`DesktopRelayAccessException`):
/// sign-in, plan or account problems the relay-token route reports.
pub(crate) fn access_status(f: &RpcFailure) -> Option<u16> {
    match f.kind {
        FailureKind::Http if f.code == "sign_in_required" => Some(f.status.unwrap_or(401)),
        FailureKind::Http if matches!(f.status, Some(401 | 403 | 404)) => f.status,
        FailureKind::Local if f.code == "account_required" => Some(403),
        _ => None,
    }
}

/// What a failure reads as; `None` for a contract failure.
fn described(f: &RpcFailure) -> Option<String> {
    let words = |t: FailureText| failure_text(t).to_owned();
    let message = f.message.clone();
    Some(match f.kind {
        FailureKind::Refused => message.unwrap_or_else(|| words(FailureText::Refused)),
        FailureKind::NotSent => message.unwrap_or_else(|| words(FailureText::Ended)),
        FailureKind::Timeout => words(FailureText::NoAnswer),
        FailureKind::Ended => words(FailureText::Ended),
        FailureKind::Http if access_status(f).is_some() => words(FailureText::Access),
        FailureKind::Http => match message {
            Some(m) if f.code == "relay_unavailable" => m,
            _ => words(FailureText::RelayAuthentication),
        },
        FailureKind::Local if contract(&f.code) => return None,
        FailureKind::Local if f.code == "account_required" => words(FailureText::Access),
        // Transport messages already carry the Dart wording (cc-protocol).
        FailureKind::Local => message
            .or_else(|| local(&f.code).map(words))
            .unwrap_or_else(|| words(FailureText::ConnectionFailed)),
    })
}

/// What a desktop read's failure reads as where Dart shows a
/// `DeviceLinkException`'s message (`_describe`); `None` for a contract
/// failure, which each surface words itself.
pub(crate) fn read_failure(f: &RpcFailure) -> Option<String> {
    described(f)
}

/// A connection's failure (`DesktopLinkModel.describe`).
pub(crate) fn connection_failure(f: &RpcFailure) -> String {
    described(f).unwrap_or_else(|| failure_text(FailureText::ConnectionFailed).into())
}

/// A discovery failure (`ComputerConnectAccount.findComputers`).
pub(crate) fn discovery_failure(f: &RpcFailure) -> String {
    described(f).unwrap_or_else(|| text(CopyKey::DiscoveryFailed).into())
}

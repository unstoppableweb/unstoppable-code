//! Account, computers and connection copy, from
//! `lib/ui/features/device_link/computer_connect/{account,connection_view,computer_switcher}.dart`,
//! `lib/ui/features/device_link/desktop_link_model.dart` and the failure
//! messages of `lib/device_link/rust_core/failures.dart`.
use cc_domain::computers::{SetupStatus, SwitcherStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyKey {
    SavedUnreadable,
    SignInExpired,
    AccessUnavailable,
    DiscoveryFailed,
    ComputerUnavailable,
    SaveConnectionFailed,
    SaveDisconnectFailed,
    ForgetFailed,
}

pub(crate) fn text(key: CopyKey) -> &'static str {
    match key {
        CopyKey::SavedUnreadable => {
            "Saved connection settings could not be read. They were preserved. Try again."
        }
        CopyKey::SignInExpired => "Your sign-in expired. Sign in again to connect your computers.",
        CopyKey::AccessUnavailable => {
            "Computer connection is unavailable for this account. Check your account access and try again."
        }
        CopyKey::DiscoveryFailed => "Could not connect. Your saved settings were kept. Try again.",
        CopyKey::ComputerUnavailable => "This computer is offline or Remote access is off.",
        CopyKey::SaveConnectionFailed => "Could not save this connection. Try again.",
        CopyKey::SaveDisconnectFailed => "Could not save the disconnect. Try again.",
        CopyKey::ForgetFailed => "Could not forget this computer. Try again.",
    }
}

pub(crate) fn setup_status(status: SetupStatus) -> &'static str {
    match status {
        SetupStatus::Connected => "Connected",
        SetupStatus::Reconnecting => "Reconnecting…",
        SetupStatus::WaitingForApproval => "Waiting for approval…",
        SetupStatus::Connecting => "Connecting…",
        SetupStatus::Disconnected => "Disconnected",
        SetupStatus::NeedsAttention => "Connection needs attention",
        SetupStatus::Offline => "Computer offline",
        SetupStatus::RemoteAccessOff => "Remote access is off",
        SetupStatus::CouldNotConnect => "Could not connect",
        SetupStatus::ReadyToConnect => "Ready to connect",
        SetupStatus::ReadyToPair => "Ready to pair",
    }
}

pub(crate) fn switcher_status(status: SwitcherStatus) -> &'static str {
    match status {
        SwitcherStatus::Connected => "Connected",
        SwitcherStatus::Connecting => "Connecting…",
        SwitcherStatus::WaitingForApproval => "Waiting for approval",
        SwitcherStatus::Reconnecting => "Reconnecting…",
        SwitcherStatus::Offline => "Offline",
    }
}

/// The wording of a connection or discovery failure. Which failure maps to
/// which text is decided in `crate::failures`, outside `copy/`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailureText {
    /// `DesktopRelayAccessException.message`.
    Access,
    /// `desktop_link_model.dart` `describe` for a failure without a message.
    ConnectionFailed,
    RelayAuthentication,
    Ended,
    NoAnswer,
    Refused,
    SecureConnection,
    OfflineOrOff,
    NotConnected,
    NotSent,
    Cancelled,
    PairingRequired,
    IdentityChanged,
    SessionExists,
    PairingDeclined,
    ProtocolChanged,
    UnreadableVersion,
    RelayConnect,
    RelayProtocol,
    RelayOutdated,
    InvalidRelay,
    RelayClosed,
    Shutdown,
    IdentityUnreadable,
}

/// The Dart transport's wording (`failures.dart`, `desktop_link_model.dart`).
pub(crate) fn failure_text(text: FailureText) -> &'static str {
    match text {
        FailureText::Access => "Connection access is unavailable. Try again or check your account.",
        FailureText::ConnectionFailed => "The connection could not complete. Try again.",
        FailureText::RelayAuthentication => "Could not authenticate with the device relay.",
        FailureText::Ended => "The connection to the computer ended.",
        FailureText::NoAnswer => "The desktop peer did not answer. Reconnect to try again.",
        FailureText::Refused => "The desktop refused the request.",
        FailureText::SecureConnection => "The secure connection did not finish.",
        FailureText::OfflineOrOff => "This computer is offline or remote access is turned off.",
        FailureText::NotConnected => "Connect to a computer first.",
        FailureText::NotSent => "The request could not be sent.",
        FailureText::Cancelled => "Connection cancelled.",
        FailureText::PairingRequired => "Pair this computer again to connect.",
        FailureText::IdentityChanged => "The computer identity changed.",
        FailureText::SessionExists => "This computer already has a session.",
        FailureText::PairingDeclined => "Pairing was declined or expired.",
        FailureText::ProtocolChanged => {
            "The computer connection version changed. Reconnect to try again."
        }
        FailureText::UnreadableVersion => {
            "The computer sent an unreadable connection version. Update the desktop app and try again."
        }
        FailureText::RelayConnect => "Could not open the device relay.",
        FailureText::RelayProtocol => "Unsupported relay protocol.",
        FailureText::RelayOutdated => "The connection service is out of date. Try again later.",
        FailureText::InvalidRelay => "Invalid relay URL.",
        FailureText::RelayClosed => "The relay disconnected.",
        FailureText::Shutdown => "The connection ended.",
        FailureText::IdentityUnreadable => {
            "The saved device identity could not be read. It was preserved."
        }
    }
}

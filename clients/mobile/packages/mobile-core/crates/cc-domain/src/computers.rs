//! Computer identifiers, the field rules of a saved computer
//! (`lib/device_link/desktop/saved_connection.dart`), and the status and
//! timing rules of the account and its connections
//! (`lib/ui/features/device_link/computer_connect/`).

/// A desktop device id: `^[A-Za-z0-9_-]{22}$` (base64url of 16 bytes).
pub fn valid_computer_id(id: &str) -> bool {
    id.len() == 22
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `deviceLinkString`: a non-empty string of at most 4096 characters.
pub fn valid_link_string(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= 4096
}

/// A computer connection's phase (`DesktopLinkPhase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkPhase {
    Disconnected,
    Connecting,
    Pairing,
    Connected,
    Reconnecting,
    Failed,
}

impl LinkPhase {
    /// A connect, pairing or recovery is in progress (`DesktopLinkModel.busy`).
    pub fn busy(self) -> bool {
        matches!(self, Self::Connecting | Self::Pairing | Self::Reconnecting)
    }
}

/// How a status reads at a glance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusTone {
    Success,
    Active,
    Warning,
    Neutral,
}

/// A computer's status in setup's list (`connection_view.dart`), in
/// precedence order, plus the unsaved online computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStatus {
    Connected,
    Reconnecting,
    WaitingForApproval,
    Connecting,
    Disconnected,
    NeedsAttention,
    Offline,
    RemoteAccessOff,
    CouldNotConnect,
    ReadyToConnect,
    ReadyToPair,
}

impl SetupStatus {
    pub fn tone(self) -> StatusTone {
        match self {
            Self::Connected => StatusTone::Success,
            Self::Reconnecting
            | Self::WaitingForApproval
            | Self::Connecting
            | Self::ReadyToConnect
            | Self::ReadyToPair => StatusTone::Active,
            Self::NeedsAttention | Self::CouldNotConnect => StatusTone::Warning,
            Self::Disconnected | Self::Offline | Self::RemoteAccessOff => StatusTone::Neutral,
        }
    }
}

/// What a computer's setup status depends on.
#[derive(Debug, Clone, Copy)]
pub struct SetupInputs {
    /// The computer's connection, when it has one.
    pub phase: Option<LinkPhase>,
    /// The connection's last attempt failed with a message.
    pub link_error: bool,
    /// The saved computer's `reconnect`, when saved.
    pub reconnect: Option<bool>,
    pub access_denied: bool,
    /// The relay lists the computer.
    pub listed: bool,
    /// The relay lists it with remote access on.
    pub accepts_control: bool,
}

/// `_status` of `connection_view.dart`: the first matching rule wins.
pub fn setup_status(i: SetupInputs) -> SetupStatus {
    match i.phase {
        Some(LinkPhase::Connected) => return SetupStatus::Connected,
        Some(LinkPhase::Reconnecting) => return SetupStatus::Reconnecting,
        Some(LinkPhase::Pairing) => return SetupStatus::WaitingForApproval,
        Some(LinkPhase::Connecting) => return SetupStatus::Connecting,
        _ => {}
    }
    if i.reconnect == Some(false) {
        SetupStatus::Disconnected
    } else if i.access_denied {
        SetupStatus::NeedsAttention
    } else if !i.listed {
        SetupStatus::Offline
    } else if !i.accepts_control {
        SetupStatus::RemoteAccessOff
    } else if i.link_error {
        SetupStatus::CouldNotConnect
    } else {
        SetupStatus::ReadyToConnect
    }
}

/// A saved computer's status in the switcher menu (`computer_switcher.dart`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwitcherStatus {
    Connected,
    Connecting,
    WaitingForApproval,
    Reconnecting,
    Offline,
}

/// `available` is `None` while the relay is closed or not yet open.
pub fn switcher_status(phase: Option<LinkPhase>, available: Option<bool>) -> SwitcherStatus {
    if phase == Some(LinkPhase::Connected) {
        return SwitcherStatus::Connected;
    }
    // An absent peer on a live relay is offline even while retries continue.
    if available == Some(false) {
        return SwitcherStatus::Offline;
    }
    match phase {
        Some(LinkPhase::Connected) => SwitcherStatus::Connected,
        Some(LinkPhase::Connecting) => SwitcherStatus::Connecting,
        Some(LinkPhase::Pairing) => SwitcherStatus::WaitingForApproval,
        Some(LinkPhase::Reconnecting) => SwitcherStatus::Reconnecting,
        _ => SwitcherStatus::Offline,
    }
}

/// The six-character pairing code as the phone shows it: `ABC DEF`.
pub fn pairing_code(code: &str) -> String {
    let split = code.char_indices().nth(3).map_or(code.len(), |(i, _)| i);
    format!("{} {}", &code[..split], &code[split..])
}

/// Timing policies of the account and its connections. Each cites the Dart
/// source it pins (review checks the values; the comparison checks order).
pub mod policy {
    use std::time::Duration;

    /// How long the app may stay in the background before its sessions
    /// close (`account.dart` `backgroundGrace`). The relay drops a phone
    /// that stops answering after about 20 seconds.
    pub const BACKGROUND_GRACE: Duration = Duration::from_secs(15);
    /// Discovery retries (`account.dart` `_schedule`), the last repeating.
    pub const DISCOVERY_DELAYS: [u64; 4] = [2, 5, 15, 30];
    /// Per-outage recovery attempts (`desktop_link_recovery.dart`); the
    /// first is immediate because most drops recover with one.
    pub const RECOVERY_DELAYS: [u64; 4] = [0, 2, 5, 10];
    /// One outage has one deadline (`desktop_link_recovery.dart`).
    pub const RECOVERY_DEADLINE: Duration = Duration::from_secs(60);
    /// The selected computer reads offline after this long
    /// (`reconnect_status.dart`).
    pub const OFFLINE_GRACE: Duration = Duration::from_secs(30);
    /// A foreground reconnect stays quiet this long
    /// (`reconnect_notice_delay.dart`).
    pub const RECONNECT_NOTICE_DELAY: Duration = Duration::from_secs(5);

    /// The delay before discovery retry `attempt` (0-based).
    pub fn discovery_delay(attempt: usize) -> Duration {
        Duration::from_secs(DISCOVERY_DELAYS[attempt.min(DISCOVERY_DELAYS.len() - 1)])
    }
    /// The delay before recovery attempt `attempt` (0-based).
    pub fn recovery_delay(attempt: usize) -> Duration {
        Duration::from_secs(RECOVERY_DELAYS[attempt.min(RECOVERY_DELAYS.len() - 1)])
    }
}

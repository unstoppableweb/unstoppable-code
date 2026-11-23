//! The signed-in account's computers and their connections. Every intent
//! resolves with the view right after it applied; outcomes of network work
//! arrive on [`AccountService::watch`].
use super::{core::CoreFailure, handler};
use crate::frb_generated::StreamSink;
use flutter_rust_bridge::frb;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppLifecycle {
    Resumed,
    Inactive,
    Hidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkPhase {
    Disconnected,
    Connecting,
    Pairing,
    Connected,
    Reconnecting,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusTone {
    Success,
    Active,
    Warning,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeCode {
    SavedUnreadable,
    SignInExpired,
    AccessUnavailable,
    ComputerUnavailable,
    SaveFailed,
    ForgetFailed,
    Transport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub code: NoticeCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedComputerView {
    pub computer_id: String,
    pub name: String,
    pub reconnect: bool,
}

/// One row of setup's list: saved computers, then unsaved online ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupRow {
    pub computer_id: String,
    pub name: String,
    pub saved: bool,
    pub reconnect: bool,
    pub busy: bool,
    pub label: String,
    pub tone: StatusTone,
    pub pairing_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitcherRow {
    pub computer_id: String,
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionView {
    pub computer_id: String,
    pub phase: LinkPhase,
    pub pairing_code: Option<String>,
    pub host_name: Option<String>,
    pub error: Option<String>,
    pub can_reconnect: bool,
    pub recovery_expired: bool,
    pub reconnect_notice_visible: bool,
    /// Counts the sessions this computer opened; the latest is the live
    /// one. Views coalesce, so a connected view with another count than
    /// the connected view before it is a new session even when no other
    /// phase was seen between them.
    pub session: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountView {
    pub revision: u64,
    pub binding: u64,
    pub ready: bool,
    pub busy: bool,
    pub finding: bool,
    pub access_denied: bool,
    pub access_status: Option<u16>,
    pub discovered: bool,
    pub offline: bool,
    pub error: Option<Notice>,
    pub setup_notice: Option<String>,
    pub selected: Option<String>,
    pub selected_name: Option<String>,
    pub has_selected_computer: bool,
    pub saved: Vec<SavedComputerView>,
    pub selectable: Vec<String>,
    pub connected: Vec<String>,
    pub setup_rows: Vec<SetupRow>,
    pub switcher: Vec<SwitcherRow>,
    pub connections: Vec<ConnectionView>,
}

impl From<cc_core::LinkPhase> for LinkPhase {
    fn from(p: cc_core::LinkPhase) -> Self {
        use cc_core::LinkPhase as P;
        match p {
            P::Disconnected => Self::Disconnected,
            P::Connecting => Self::Connecting,
            P::Pairing => Self::Pairing,
            P::Connected => Self::Connected,
            P::Reconnecting => Self::Reconnecting,
            P::Failed => Self::Failed,
        }
    }
}

impl From<cc_core::StatusTone> for StatusTone {
    fn from(t: cc_core::StatusTone) -> Self {
        use cc_core::StatusTone as T;
        match t {
            T::Success => Self::Success,
            T::Active => Self::Active,
            T::Warning => Self::Warning,
            T::Neutral => Self::Neutral,
        }
    }
}

impl From<cc_core::NoticeCode> for NoticeCode {
    fn from(c: cc_core::NoticeCode) -> Self {
        use cc_core::NoticeCode as C;
        match c {
            C::SavedUnreadable => Self::SavedUnreadable,
            C::SignInExpired => Self::SignInExpired,
            C::AccessUnavailable => Self::AccessUnavailable,
            C::ComputerUnavailable => Self::ComputerUnavailable,
            C::SaveFailed => Self::SaveFailed,
            C::ForgetFailed => Self::ForgetFailed,
            C::Transport => Self::Transport,
        }
    }
}

impl From<cc_core::AccountView> for AccountView {
    fn from(v: cc_core::AccountView) -> Self {
        Self {
            revision: v.revision,
            binding: v.binding,
            ready: v.ready,
            busy: v.busy,
            finding: v.finding,
            access_denied: v.access_denied,
            access_status: v.access_status,
            discovered: v.discovered,
            offline: v.offline,
            error: v.error.map(|n| Notice {
                code: n.code.into(),
                message: n.message,
            }),
            setup_notice: v.setup_notice,
            selected: v.selected,
            selected_name: v.selected_name,
            has_selected_computer: v.has_selected_computer,
            saved: v
                .saved
                .into_iter()
                .map(|c| SavedComputerView {
                    computer_id: c.computer_id,
                    name: c.name,
                    reconnect: c.reconnect,
                })
                .collect(),
            selectable: v.selectable,
            connected: v.connected,
            setup_rows: v
                .setup_rows
                .into_iter()
                .map(|r| SetupRow {
                    computer_id: r.computer_id,
                    name: r.name,
                    saved: r.saved,
                    reconnect: r.reconnect,
                    busy: r.busy,
                    label: r.label,
                    tone: r.tone.into(),
                    pairing_code: r.pairing_code,
                })
                .collect(),
            switcher: v
                .switcher
                .into_iter()
                .map(|r| SwitcherRow {
                    computer_id: r.computer_id,
                    name: r.name,
                    status: r.status,
                })
                .collect(),
            connections: v
                .connections
                .into_iter()
                .map(|c| ConnectionView {
                    computer_id: c.computer_id,
                    phase: c.phase.into(),
                    pairing_code: c.pairing_code,
                    host_name: c.host_name,
                    error: c.error,
                    can_reconnect: c.can_reconnect,
                    recovery_expired: c.recovery_expired,
                    reconnect_notice_visible: c.reconnect_notice_visible,
                    session: c.session,
                })
                .collect(),
        }
    }
}

type Viewed = Result<AccountView, CoreFailure>;

fn viewed(r: Result<cc_core::AccountView, cc_core::CoreFailure>) -> Viewed {
    r.map(Into::into).map_err(Into::into)
}

/// Every account and connection intent takes the `binding` its account
/// restored. Once the account scope it restored in ended (signed out, or
/// another account signed in), it fails with `account_changed` before any
/// effect, also after the same account signs in again and restores.
#[frb(opaque)]
#[derive(Clone)]
pub struct AccountService {
    inner: cc_core::AccountService,
}

impl AccountService {
    pub(crate) fn new(inner: cc_core::AccountService) -> Self {
        Self { inner }
    }

    /// The current view, then every change (latest wins).
    pub fn watch(&self, sink: StreamSink<AccountView>) {
        let mut views = self.inner.watch();
        handler::runtime().spawn(async move {
            while let Some(view) = views.next().await {
                if sink.add(view.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// Binds the service to `account_id` (the account the host signed in
    /// and the core adopted) and restores its saved computers. Another
    /// account resets every computer and session first.
    ///
    /// Resolves when applied, with the binding to pass with the account's
    /// intents and to [`AccountService::close`]; reconnects follow on the
    /// stream.
    pub async fn restore(&self, account_id: String) -> Viewed {
        viewed(self.inner.restore(account_id).await)
    }
    /// Opens the relay and lists the account's computers, retrying with
    /// the discovery backoff.
    ///
    /// Resolves when applied (`finding` set); the computers found follow on
    /// the stream.
    pub async fn find_computers(&self, binding: u64) -> Viewed {
        viewed(self.inner.find_computers(binding).await)
    }
    /// Connects (pairing if needed) and saves the computer once connected.
    ///
    /// Resolves when applied (the attempt started); the pairing code and
    /// the outcome follow on the stream.
    pub async fn connect(&self, computer_id: String, binding: u64) -> Viewed {
        viewed(self.inner.connect(computer_id, binding).await)
    }
    /// Makes the computer the selected one.
    ///
    /// Resolves when applied.
    pub async fn select(&self, computer_id: String, binding: u64) -> Viewed {
        viewed(self.inner.select(computer_id, binding).await)
    }
    /// Saves `reconnect: false` first, then disconnects.
    ///
    /// Resolves when applied; the session's end follows on the stream.
    pub async fn disconnect(&self, computer_id: String, binding: u64) -> Viewed {
        viewed(self.inner.disconnect(computer_id, binding).await)
    }
    /// Disconnects; a computer saved with `reconnect: false` is then
    /// removed with its pairing.
    ///
    /// Resolves when applied; the session's end follows on the stream.
    pub async fn forget(&self, computer_id: String, binding: u64) -> Viewed {
        viewed(self.inner.forget(computer_id, binding).await)
    }
    /// Cancels the attempt shown on the computer's setup row.
    ///
    /// Resolves when applied.
    pub async fn cancel_connect(&self, computer_id: String, binding: u64) -> Viewed {
        viewed(self.inner.cancel_connect(computer_id, binding).await)
    }
    /// The app's lifecycle: `Hidden` starts the background grace,
    /// `Resumed` probes and reconnects, `Inactive` hides reconnect notices.
    /// It describes the app, so it takes no binding: it applies with no
    /// account restored, and the account restored next starts in it.
    ///
    /// Resolves when applied; the grace and reconnects follow on the stream.
    pub async fn app_lifecycle(&self, state: AppLifecycle) -> Viewed {
        let state = match state {
            AppLifecycle::Resumed => cc_core::AppLifecycle::Resumed,
            AppLifecycle::Inactive => cc_core::AppLifecycle::Inactive,
            AppLifecycle::Hidden => cc_core::AppLifecycle::Hidden,
        };
        viewed(self.inner.app_lifecycle(state).await)
    }
    /// Stores the chat and Home drafts every service holds now instead of
    /// after their 500 ms debounce, as the app leaves the foreground.
    /// Resolves once they are stored, or after 3 s.
    pub async fn flush_drafts(&self) -> Result<(), CoreFailure> {
        Ok(self.inner.flush_drafts().await?)
    }
    /// Releases binding `binding`: its sessions and the relay close. A newer
    /// binding (the next account scope) is kept.
    ///
    /// Resolves when applied; the sessions close in the background.
    pub async fn close(&self, binding: u64) -> Viewed {
        viewed(self.inner.close(binding).await)
    }
    /// A fresh chat read path of the computer (P5a); it lives until its
    /// `ChatIntent.close`.
    #[frb(sync)]
    pub fn chats(&self, computer_id: String) -> Result<super::chats::ChatsService, CoreFailure> {
        self.inner
            .chats(computer_id)
            .map(super::chats::ChatsService::new)
            .map_err(Into::into)
    }
    /// The computer's files (P6): file tab roots and viewer reads.
    #[frb(sync)]
    pub fn files(&self, computer_id: String) -> Result<super::files::FilesService, CoreFailure> {
        self.inner
            .files(computer_id)
            .map(super::files::FilesService::new)
            .map_err(Into::into)
    }
    /// The computer's worktree creation and archive (P8). Lives until its
    /// `WorktreesIntent.close`.
    #[frb(sync)]
    pub fn worktrees(
        &self,
        computer_id: String,
    ) -> Result<super::worktrees::WorktreesService, CoreFailure> {
        self.inner
            .worktrees(computer_id)
            .map(super::worktrees::WorktreesService::new)
            .map_err(Into::into)
    }
    /// The computer's project clones (P8). Lives until its
    /// `ProjectsIntent.close`.
    #[frb(sync)]
    pub fn projects(
        &self,
        computer_id: String,
    ) -> Result<super::projects::ProjectsService, CoreFailure> {
        self.inner
            .projects(computer_id)
            .map(super::projects::ProjectsService::new)
            .map_err(Into::into)
    }
    /// The computer's Home: launcher options, choices and drafts (P8).
    /// Lives until its `HomeIntent.close`.
    #[frb(sync)]
    pub fn home(&self, computer_id: String) -> Result<super::home::HomeService, CoreFailure> {
        self.inner
            .home(computer_id)
            .map(super::home::HomeService::new)
            .map_err(Into::into)
    }
    /// The computer's Orchestrator and its chat on the `app-advisor`
    /// surface (P9). Lives until its `OrchestratorIntent.close` (and the
    /// chat's `ChatIntent.close`).
    #[frb(sync)]
    pub fn orchestrator(
        &self,
        computer_id: String,
    ) -> Result<super::orchestrator::OrchestratorService, CoreFailure> {
        self.inner
            .orchestrator(computer_id)
            .map(super::orchestrator::OrchestratorService::new)
            .map_err(Into::into)
    }
    /// A fresh overview of the computer (P4), replacing an earlier one.
    #[frb(sync)]
    pub fn overview(
        &self,
        computer_id: String,
        locale: String,
    ) -> Result<super::overview::OverviewService, CoreFailure> {
        self.inner
            .overview(computer_id, locale)
            .map(super::overview::OverviewService::new)
            .map_err(Into::into)
    }
    /// The computer's connection for the account `binding` restored.
    #[frb(sync)]
    pub fn connection(&self, computer_id: String, binding: u64) -> ConnectionService {
        ConnectionService {
            inner: self.inner.connection(computer_id, binding),
        }
    }
}

/// One computer's connection for one account binding. Once the account
/// scope the binding was restored in ended, its intents fail with
/// `account_changed` before any effect.
#[frb(opaque)]
#[derive(Clone)]
pub struct ConnectionService {
    inner: cc_core::ConnectionService,
}

impl ConnectionService {
    /// Connects, pairing if the computer has no pin.
    ///
    /// Resolves when applied; the outcome follows on the account stream.
    pub async fn connect(&self) -> Viewed {
        viewed(self.inner.connect().await)
    }
    /// Cancels an attempt or ends the session; recovery stops.
    ///
    /// Resolves when applied.
    pub async fn cancel(&self) -> Viewed {
        viewed(self.inner.cancel().await)
    }
    /// Retries a recovering connection now.
    ///
    /// Resolves when applied; the outcome follows on the account stream.
    pub async fn retry_now(&self) -> Viewed {
        viewed(self.inner.retry_now().await)
    }
    /// Reconnects to the computer last connected.
    ///
    /// Resolves when applied; the outcome follows on the account stream.
    pub async fn reconnect(&self) -> Viewed {
        viewed(self.inner.reconnect().await)
    }
    /// [`ConnectionService::cancel`], and forgets the computer to reconnect to.
    ///
    /// Resolves when applied.
    pub async fn disconnect_and_clear(&self) -> Viewed {
        viewed(self.inner.disconnect_and_clear().await)
    }
    /// [`ConnectionService::cancel`], then forgets the computer's pairing.
    ///
    /// Resolves when applied.
    pub async fn forget(&self) -> Viewed {
        viewed(self.inner.forget().await)
    }
}

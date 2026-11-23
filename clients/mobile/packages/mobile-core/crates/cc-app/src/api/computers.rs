//! The signed-in account's computers and their connections (architecture
//! §3.2): saved computers and selection, discovery, connecting and pairing,
//! recovery, access denial and the app lifecycle. Statuses, notices and
//! labels are computed here; a host maps the view's fields to widgets.
//!
//! Every intent resolves with the [`AccountView`] right after it applied,
//! so a caller that awaits it reads its own write; its network outcome
//! arrives on [`AccountService::watch`]. Views carry a monotonic
//! `revision`.
use super::{CoreFailure, CoreInner, Subscription};
use crate::computers::{Command, Handle, Intent, LinkIntent};
pub use cc_domain::computers::{LinkPhase, StatusTone};
use std::sync::Arc;

/// The app's lifecycle as the account sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppLifecycle {
    /// In the foreground: reconnect and rediscover.
    Resumed,
    /// Visible but not focused: reconnect notices stay hidden.
    Inactive,
    /// In the background: sessions close after the grace.
    Hidden,
}

/// What an account notice is about, for hosts that localize.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeCode {
    SavedUnreadable,
    SignInExpired,
    AccessUnavailable,
    ComputerUnavailable,
    SaveFailed,
    ForgetFailed,
    /// A connection or discovery failure, worded by the transport.
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
    /// Reconnects on its own; false after an explicit disconnect.
    pub reconnect: bool,
}

/// One row of setup's computer list: saved computers in saved order, then
/// unsaved online computers by name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupRow {
    pub computer_id: String,
    pub name: String,
    pub saved: bool,
    pub reconnect: bool,
    /// A connection attempt is in progress; it can be cancelled.
    pub busy: bool,
    pub label: String,
    pub tone: StatusTone,
    /// The code to compare, as `ABC DEF`, while pairing.
    pub pairing_code: Option<String>,
}

/// A saved computer as the switcher menu shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitcherRow {
    pub computer_id: String,
    pub name: String,
    pub status: String,
}

/// One remembered computer's connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionView {
    pub computer_id: String,
    pub phase: LinkPhase,
    pub pairing_code: Option<String>,
    /// The computer's name from its hello, while known.
    pub host_name: Option<String>,
    pub error: Option<String>,
    /// There is a computer to reconnect to.
    pub can_reconnect: bool,
    /// The last outage did not recover within its deadline.
    pub recovery_expired: bool,
    /// A foreground reconnect has lasted long enough to mention.
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
    /// The binding [`AccountService::restore`] made; pass it with the
    /// account's intents and to [`AccountService::close`].
    pub binding: u64,
    /// Saved settings were read.
    pub ready: bool,
    pub busy: bool,
    pub finding: bool,
    pub access_denied: bool,
    pub access_status: Option<u16>,
    /// Discovery reached the relay at least once.
    pub discovered: bool,
    /// The selected computer has been unreachable for the offline grace.
    pub offline: bool,
    pub error: Option<Notice>,
    /// The account's notice, else the selected computer's failure.
    pub setup_notice: Option<String>,
    pub selected: Option<String>,
    pub selected_name: Option<String>,
    pub has_selected_computer: bool,
    pub saved: Vec<SavedComputerView>,
    /// Saved computers the switcher offers.
    pub selectable: Vec<String>,
    /// Saved computers with a live or recovering session.
    pub connected: Vec<String>,
    pub setup_rows: Vec<SetupRow>,
    pub switcher: Vec<SwitcherRow>,
    /// Every remembered computer's connection, in remembered order.
    pub connections: Vec<ConnectionView>,
}

/// Every account and connection intent takes the `binding` its account
/// restored. Once the account scope it restored in ended (signed out, or
/// another account signed in), it fails with `account_changed` before any
/// effect, also after the same account signs in again and restores.
#[derive(Clone)]
pub struct AccountService {
    core: Arc<CoreInner>,
}

impl AccountService {
    pub(crate) fn new(core: Arc<CoreInner>) -> Self {
        Self { core }
    }
    fn handle(&self) -> Handle {
        self.core.account().clone()
    }
    async fn request(&self, intent: Intent) -> Result<AccountView, CoreFailure> {
        let handle = self.handle();
        let view = self
            .core
            .run(async move { handle.request(intent).await })
            .await?;
        Ok(AccountView::clone(&view))
    }
    async fn command(&self, binding: u64, command: Command) -> Result<AccountView, CoreFailure> {
        self.request(Intent::Account { binding, command }).await
    }

    /// The current view first, then every change (latest wins).
    pub fn watch(&self) -> Subscription<AccountView> {
        Subscription::watch(self.handle().view())
    }
    /// Binds the service to `account_id` (the account the host signed in
    /// and the core adopted) and restores its saved computers. Another
    /// account resets every computer and session first.
    ///
    /// Resolves when applied, with the binding to pass with the account's
    /// intents and to [`AccountService::close`]; reconnects follow on the
    /// stream.
    pub async fn restore(&self, account_id: String) -> Result<AccountView, CoreFailure> {
        let app = self.core.app.clone();
        if app.account()? != account_id {
            return Err(crate::error::Error::new("account_changed").into());
        }
        let view = self
            .request(Intent::Restore {
                account: account_id.clone(),
            })
            .await?;
        if app.account()? != account_id {
            return Err(crate::error::Error::new("account_changed").into());
        }
        Ok(view)
    }
    /// Opens the relay and lists the account's computers, retrying with
    /// the discovery backoff.
    ///
    /// Resolves when applied (`finding` set); the computers found follow on
    /// the stream.
    pub async fn find_computers(&self, binding: u64) -> Result<AccountView, CoreFailure> {
        self.command(binding, Command::FindComputers).await
    }
    /// Connects (pairing if needed) and saves the computer once connected.
    ///
    /// Resolves when applied (the attempt started); the pairing code and
    /// the outcome follow on the stream.
    pub async fn connect(
        &self,
        computer_id: String,
        binding: u64,
    ) -> Result<AccountView, CoreFailure> {
        self.command(binding, Command::Connect(computer_id)).await
    }
    /// Makes the computer the selected one.
    ///
    /// Resolves when applied.
    pub async fn select(
        &self,
        computer_id: String,
        binding: u64,
    ) -> Result<AccountView, CoreFailure> {
        self.command(binding, Command::Select(computer_id)).await
    }
    /// Saves `reconnect: false` first, then disconnects.
    ///
    /// Resolves when applied; the session's end follows on the stream.
    pub async fn disconnect(
        &self,
        computer_id: String,
        binding: u64,
    ) -> Result<AccountView, CoreFailure> {
        self.command(binding, Command::Disconnect(computer_id))
            .await
    }
    /// Disconnects; a computer saved with `reconnect: false` is then
    /// removed with its pairing.
    ///
    /// Resolves when applied; the session's end follows on the stream.
    pub async fn forget(
        &self,
        computer_id: String,
        binding: u64,
    ) -> Result<AccountView, CoreFailure> {
        self.command(binding, Command::Forget(computer_id)).await
    }
    /// Cancels the attempt shown on the computer's setup row.
    ///
    /// Resolves when applied.
    pub async fn cancel_connect(
        &self,
        computer_id: String,
        binding: u64,
    ) -> Result<AccountView, CoreFailure> {
        self.command(binding, Command::CancelConnect(computer_id))
            .await
    }
    /// The app's lifecycle: `Hidden` starts the background grace,
    /// `Resumed` probes and reconnects, `Inactive` hides reconnect notices.
    /// It describes the app, so it takes no binding: it applies with no
    /// account restored, and the account restored next starts in it.
    ///
    /// Resolves when applied; the grace and reconnects follow on the stream.
    pub async fn app_lifecycle(&self, state: AppLifecycle) -> Result<AccountView, CoreFailure> {
        self.request(Intent::Lifecycle(state)).await
    }
    /// Stores the chat and Home drafts every service holds now instead of
    /// after their 500 ms debounce, as the app leaves the foreground.
    /// Resolves once they are stored, or after 3 s.
    pub async fn flush_drafts(&self) -> Result<(), CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .run(async move {
                app.flushed(None).await;
                Ok(())
            })
            .await
    }
    /// Releases binding `binding`: its sessions and the relay close. A newer
    /// binding (the next account scope) is kept.
    ///
    /// Resolves when applied; the sessions close in the background.
    pub async fn close(&self, binding: u64) -> Result<AccountView, CoreFailure> {
        self.request(Intent::Close { binding }).await
    }
    /// A fresh overview of `computer_id` (P4), replacing an earlier one:
    /// one host view model per computer drives it. `locale` (BCP 47, the
    /// system locale) collates worktree titles.
    /// A fresh chat read path of the computer (P5a). Each lives until its
    /// [`super::ChatIntent::Close`].
    pub fn chats(&self, computer_id: String) -> Result<super::ChatsService, CoreFailure> {
        crate::bridge::computer_id(&computer_id).map_err(CoreFailure::from)?;
        let handle = crate::chats::Handle::start(
            &self.core.app,
            self.core.handle(),
            computer_id,
            crate::bridge::MAIN,
        );
        Ok(super::ChatsService::new(self.core.clone(), handle))
    }
    /// The computer's files (P6): file tab roots and viewer reads.
    pub fn files(&self, computer_id: String) -> Result<super::FilesService, CoreFailure> {
        crate::bridge::computer_id(&computer_id).map_err(CoreFailure::from)?;
        Ok(super::FilesService::new(
            self.core.clone(),
            crate::chats::Peer::main(computer_id, self.core.app.scope()),
        ))
    }
    pub fn overview(
        &self,
        computer_id: String,
        locale: String,
    ) -> Result<super::OverviewService, CoreFailure> {
        crate::bridge::computer_id(&computer_id).map_err(CoreFailure::from)?;
        let handle = crate::overview::Handle::start(
            &self.core.app,
            self.core.handle(),
            computer_id,
            &locale,
            self.handle().view(),
        );
        Ok(super::OverviewService::new(self.core.clone(), handle))
    }
    /// The computer's worktree creation and archive (P8). One per host
    /// controller; each lives until its `WorktreesIntent::Close`.
    pub fn worktrees(&self, computer_id: String) -> Result<super::WorktreesService, CoreFailure> {
        crate::bridge::computer_id(&computer_id).map_err(CoreFailure::from)?;
        let handle = crate::worktrees::Handle::start(
            &self.core.app,
            self.core.handle(),
            computer_id,
            self.handle().view(),
        );
        Ok(super::WorktreesService::new(self.core.clone(), handle))
    }
    /// The computer's project clones (P8). One per host controller; each
    /// lives until its `ProjectsIntent::Close`.
    pub fn projects(&self, computer_id: String) -> Result<super::ProjectsService, CoreFailure> {
        crate::bridge::computer_id(&computer_id).map_err(CoreFailure::from)?;
        let handle = crate::projects::Handle::start(
            &self.core.app,
            self.core.handle(),
            computer_id,
            self.handle().view(),
        );
        Ok(super::ProjectsService::new(self.core.clone(), handle))
    }
    /// The computer's Home: launcher options, choices and drafts (P8).
    /// Each lives until its `HomeIntent::Close`.
    pub fn home(&self, computer_id: String) -> Result<super::HomeService, CoreFailure> {
        crate::bridge::computer_id(&computer_id).map_err(CoreFailure::from)?;
        let handle = crate::home::Handle::start(&self.core.app, self.core.handle(), computer_id);
        Ok(super::HomeService::new(self.core.clone(), handle))
    }
    /// The computer's Orchestrator (P9) and its chat on the `app-advisor`
    /// surface. Each lives until its `OrchestratorIntent::Close` (and the
    /// chat's `ChatIntent::Close`).
    pub fn orchestrator(
        &self,
        computer_id: String,
    ) -> Result<super::OrchestratorService, CoreFailure> {
        crate::bridge::computer_id(&computer_id).map_err(CoreFailure::from)?;
        let chats = crate::chats::Handle::start(
            &self.core.app,
            self.core.handle(),
            computer_id.clone(),
            crate::bridge::APP_ADVISOR,
        );
        let handle = crate::orchestrator::Handle::start(
            &self.core.app,
            self.core.handle(),
            computer_id.clone(),
        );
        Ok(super::OrchestratorService::new(
            self.core.clone(),
            handle,
            super::ChatsService::new(self.core.clone(), chats),
        ))
    }
    /// The computer's connection for the account `binding` restored.
    pub fn connection(&self, computer_id: String, binding: u64) -> ConnectionService {
        ConnectionService {
            account: self.clone(),
            computer_id,
            binding,
        }
    }
}

/// One computer's connection for one account binding. Once the account
/// scope the binding was restored in ended, its intents fail with
/// `account_changed` before any effect.
#[derive(Clone)]
pub struct ConnectionService {
    account: AccountService,
    computer_id: String,
    binding: u64,
}

impl ConnectionService {
    async fn link(&self, intent: LinkIntent) -> Result<AccountView, CoreFailure> {
        self.account
            .command(
                self.binding,
                Command::Link(self.computer_id.clone(), intent),
            )
            .await
    }
    /// Connects, pairing if the computer has no pin.
    ///
    /// Resolves when applied; the outcome follows on the account stream.
    pub async fn connect(&self) -> Result<AccountView, CoreFailure> {
        self.link(LinkIntent::Connect).await
    }
    /// Cancels an attempt or ends the session; recovery stops.
    ///
    /// Resolves when applied.
    pub async fn cancel(&self) -> Result<AccountView, CoreFailure> {
        self.link(LinkIntent::Cancel).await
    }
    /// Retries a recovering connection now.
    ///
    /// Resolves when applied; the outcome follows on the account stream.
    pub async fn retry_now(&self) -> Result<AccountView, CoreFailure> {
        self.link(LinkIntent::RetryNow).await
    }
    /// Reconnects to the computer last connected.
    ///
    /// Resolves when applied; the outcome follows on the account stream.
    pub async fn reconnect(&self) -> Result<AccountView, CoreFailure> {
        self.link(LinkIntent::Reconnect).await
    }
    /// [`ConnectionService::cancel`], and forgets the computer to reconnect to.
    ///
    /// Resolves when applied.
    pub async fn disconnect_and_clear(&self) -> Result<AccountView, CoreFailure> {
        self.link(LinkIntent::DisconnectAndClear).await
    }
    /// [`ConnectionService::cancel`], then forgets the computer's pairing.
    ///
    /// Resolves when applied.
    pub async fn forget(&self) -> Result<AccountView, CoreFailure> {
        self.link(LinkIntent::Forget).await
    }
}

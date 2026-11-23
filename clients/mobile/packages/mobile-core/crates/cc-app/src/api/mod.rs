//! The public facade of the Computer Connect core: service handles, their
//! DTOs and errors. Bindings (`cc-ffi-dart`, a future UniFFI crate) wrap only
//! this module. Every type is owned and plain: no lifetimes, generics in
//! signatures or trait objects.
//!
//! Surface: [`AuthService`] (hosted sign-in and the adopted app session),
//! [`AccountService`] and [`ConnectionService`] (the account's computers
//! and their connections, P2), [`ProviderUsageService`] (the selected
//! computer's provider usage, P3), [`OverviewService`] (a computer's
//! overview read models and its desktop interest, P4), the migration-only
//! [`TransportBridge`] (the
//! session operations the Dart features not yet ported still drive), and
//! [`Diagnostics`] for the developer console (feature `diagnostics`).
mod activity;
mod auth;
mod bridge;
mod chats;
mod composer;
mod computers;
mod diagnostics;
mod errors;
mod files;
mod home;
mod orchestrator;
mod overview;
mod pipelines;
mod projects;
mod usage;
mod worktrees;

pub use crate::outbox::Subscription;
pub use activity::{
    ActivityFailure, ActivityIntent, ActivityService, ActivitySettled, ActivityView, ActivityViews,
    ChangedFileView, DiffLineKind, DiffLineView, DiffPhase, DiffTargetView, DiffViews,
    FileDiffView, FileEntryView, FileGroupView, FileSectionView, FilesStatus, HookView, PlanView,
    PrActionKind, PrCheckState, PrCheckView, PrCreationPhase, PrCreationStepView, PrCreationView,
    PrIdentityView, PrMergePhase, PrMergeStepView, PrMergeView, PrProgressView, PrQueuePhase,
    PrQueueView, PrRepoView, PrView, RunView, ScriptRunView, ScriptView, SummaryView, TodoItemView,
    TodoListView,
};
pub use auth::{
    AppleStart, AuthService, AuthSession, AuthStatus, OAuthStart, SignInStep, SignedInView,
};
pub use bridge::{
    BridgeEvent, BridgeMessage, IdentityImport, IdentityImported, LegacyCleanup, Pin,
    PublicIdentity, RelayStatus, SessionCall, TransportBridge,
};
pub use chats::{
    AttachmentView, ChatFailure, ChatFailureKind, ChatFrame, ChatFrames, ChatHeaderView,
    ChatIntent, ChatOutcome, ChatRole, ChatSettled, ChatStateFrame, ChatTabView, ChatsService,
    DraftView, FeedFrame, FeedItem, FeedOp, FeedRow, MessageRef, MessageStatus, MessageView,
    PartView, PendingSendView, RawMessageView, ResultsRef, SelectionFrame, StepCategoryView,
    StepCountView, StepRef, TimerView, ToolResultView, ToolResultsView, WatcherEntryView,
    WatcherFiredView,
};
pub use composer::{
    AgentModelView, AgentSelectionView, AutoRowView, AvailabilityView, CatalogStatusView,
    CommandLimitView, CommandRowView, CommandRunView, CommandSearchRow, ComposerSource,
    ComposerView, ControlsView, HarnessChoiceView, ModelRowView, PickerRowView, PickerSectionView,
    PickerTabKind, PickerTabView, PickerView, QuestionAnswerView, QuestionItemView, QuestionView,
    SettingsFailureView, SettingsPick, SourceScopeView, SpeedView, command_runs, limit_commands,
    search_commands, search_models,
};
/// The catalog row view of a model, shared with Home's options (P8).
pub(crate) use composer::{model_row, question_item};
pub use computers::{
    AccountService, AccountView, AppLifecycle, ConnectionService, ConnectionView, LinkPhase,
    Notice, NoticeCode, SavedComputerView, SetupRow, StatusTone, SwitcherRow,
};
pub use diagnostics::{CacheScope, Diagnostics, HttpHeader, HttpRequest, HttpResponse};
pub use errors::{CoreFailure, FailureKind};
pub use files::{
    FileBytesOutcome, FileLocationView, FileProblem, FileReader, FileTabView, FileTextOutcome,
    FilesService, LocateOutcome,
};
pub use home::{
    HomeAttachmentView, HomeChoicesView, HomeDraftClearView, HomeDraftView, HomeIntent,
    HomeInventoryView, HomeLaunchView, HomeModelView, HomeOptionsView, HomeOutcome, HomePick,
    HomeProjectView, HomeService, HomeSettled, HomeView, HomeViews, HomeWorktreeView, LauncherView,
    NewTaskRequest, NewTaskView, NewTaskViews, ProviderAvailabilityView, SentAttachmentView,
    TaskFailure, TaskFailureKind, TaskModelView, TaskStep, TaskStepResult,
};
pub use orchestrator::{
    OrchestratorEntryView, OrchestratorIntent, OrchestratorOutcome, OrchestratorService,
    OrchestratorSettled, OrchestratorView, OrchestratorViews, ToolQuestionView,
};
pub use overview::{
    AttentionEntryView, AttentionView, CatalogView, CatalogWorkspaceView, ChatRefView,
    ContextScopeView, CoworkChatView, CoworkScopeView, MergeQueueView, NotificationSpaceView,
    OverviewService, OverviewView, OwnerView, PrStatusView, ProjectView, RecentAttention,
    RecentChatView, RecentsView, WorktreeChatsView, WorktreeLoad, WorktreeRowView, WorktreeStatus,
    WorktreeView,
};
pub use pipelines::{
    ChatActivityView, ChatActivityViews, DispatchFormView, FormRulesView, PipelineAction,
    PipelineChatTurnView, PipelineContentChunkView, PipelineContentSource, PipelineControlView,
    PipelineDescriptorView, PipelineDocumentView, PipelineDotStatus, PipelineDotView,
    PipelineFailure, PipelineFailureKind, PipelineFollowUpView, PipelineGroupStepView,
    PipelineGroupView, PipelineInputErrorView, PipelineInputType, PipelineInputValue,
    PipelineInputView, PipelineJobView, PipelineNumberView, PipelineOrigin, PipelinePauseView,
    PipelineProgressView, PipelineRunDisplayView, PipelineRunNoteView, PipelineRunView,
    PipelineScopeView, PipelineScopeViews, PipelineStatusReasonView, PipelineStepView,
    PipelineTierView, PipelineTurnView, PipelineVariantView, PipelinesIntent, PipelinesOutcome,
    PipelinesService, PipelinesSettled, WorkAction, WorkActionLabelView, WorkDetailView,
    WorkDrawerView, WorkDrawerViews, WorkGroup, WorkGroupCountView, WorkItemView, WorkKind,
    WorkTone,
};
pub use projects::{
    ClonePhaseView, CloneRowView, ClonesView, ClonesViews, ProjectsIntent, ProjectsOutcome,
    ProjectsService, ProjectsSettled,
};
pub use usage::{
    CreditUnit, OpenCodeAccount, OpenCodeAccountUsage, OpenCodeAccounts, OpenCodeMethod,
    OpenCodeProvider, OpenCodeUsageWindow, ProviderUsage, ProviderUsageService, RefreshFailure,
    UsageAccount, UsageAccountSource, UsageAccountStatus, UsageAuthState, UsageCredits,
    UsageDelivery, UsageError, UsageErrorKind, UsageProjection, UsageProvider, UsageSpend,
    UsageView, UsageWindow,
};
pub use worktrees::{
    AttemptView, CreatedWorktreeView, WorktreesIntent, WorktreesService, WorktreesSettled,
    WorktreesView, WorktreesViews, WriteFailure, WriteFailureKind,
};

use crate::{account::Scope, bridge::Inner};
use std::{
    future::Future,
    sync::{Arc, Mutex, OnceLock},
};
use tokio::{
    runtime::{Handle, Runtime},
    sync::oneshot,
};

/// What the host supplies at open.
#[derive(Debug, Clone)]
pub struct Config {
    /// The hosted API origin (`https://...`, or loopback `http`).
    pub origin: String,
    /// An app-private SQLite path.
    pub database_path: String,
    /// The OS-keystore wrapping key, unpadded base64url of 32 bytes.
    pub wrapping_key: String,
    pub device_name: String,
    /// The relay platform: `darwin` or `linux`.
    pub platform: String,
    /// The app version, sent as `x-canopy-client-version`.
    pub client_version: Option<String>,
    /// Sent as `user-agent`.
    pub user_agent: Option<String>,
}

/// One open core: its own runtime, store, auth and relay.
#[derive(Clone)]
pub struct Core {
    inner: Arc<CoreInner>,
}

pub(crate) struct CoreInner {
    runtime: Mutex<Option<Runtime>>,
    handle: Handle,
    pub(crate) app: Arc<Inner>,
    account: OnceLock<crate::computers::Handle>,
    usage: OnceLock<crate::usage::Handle>,
}

impl Drop for CoreInner {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl CoreInner {
    pub(crate) fn new(runtime: Runtime, app: Arc<Inner>) -> Self {
        Self {
            handle: runtime.handle().clone(),
            runtime: Mutex::new(Some(runtime)),
            app,
            account: OnceLock::new(),
            usage: OnceLock::new(),
        }
    }
    /// The account service's actor, started on first use.
    pub(crate) fn account(&self) -> &crate::computers::Handle {
        self.account
            .get_or_init(|| crate::computers::Handle::start(&self.app, &self.handle))
    }
    pub(crate) fn handle(&self) -> &Handle {
        &self.handle
    }
    /// The provider usage actor, started on first use; it follows the
    /// account service's selection.
    pub(crate) fn usage(&self) -> &crate::usage::Handle {
        self.usage.get_or_init(|| {
            crate::usage::Handle::start(&self.app, self.account().view(), &self.handle)
        })
    }
    fn shutdown(&self) {
        self.app.shutdown();
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(runtime) = runtime {
            runtime.shutdown_background();
        }
    }
    /// Runs `work` on the core runtime, stopped by [`Core::close`]. A panic
    /// fails only this call (`native_panic`).
    pub(crate) async fn run<T, F>(&self, work: F) -> Result<T, CoreFailure>
    where
        T: Send + 'static,
        F: Future<Output = cc_protocol::Result<T>> + Send + 'static,
    {
        let app = self.app.clone();
        match self
            .handle
            .spawn(async move { app.guarded(work).await })
            .await
        {
            Ok(result) => result.map_err(CoreFailure::from),
            Err(error) if error.is_panic() => Err(CoreFailure::local("native_panic")),
            Err(_) => {
                Err(cc_protocol::RpcFailure::local("shutdown", "The connection ended.").into())
            }
        }
    }
    /// The outcome of a ticket an actor started in `scope` answers:
    /// `account_changed` once the scope ended, also when it ended before
    /// the outcome came, so no outcome of a left account reaches the
    /// caller; `shutdown` when the actor stopped without answering or the
    /// ticket is unknown.
    pub(crate) async fn ticket<T: Send + 'static>(
        &self,
        scope: &Scope,
        rx: Option<oneshot::Receiver<T>>,
    ) -> Result<T, CoreFailure> {
        self.run(scope.within(async move {
            match rx {
                Some(rx) => rx.await.map_err(|_| crate::bridge::shutdown_failure()),
                None => Err(crate::bridge::shutdown_failure()),
            }
        }))
        .await
    }
    /// [`CoreInner::call`] for the account scope current now, which `work`
    /// gets: refused (`account_changed`) once that scope ended, and its
    /// result dropped when the scope ended before it completed, so a call
    /// made for one account never answers with, or acts on, the next one's.
    pub(crate) async fn scoped<T, F>(
        &self,
        work: impl FnOnce(Arc<Inner>, Scope) -> F,
    ) -> Result<T, CoreFailure>
    where
        T: Send + 'static,
        F: Future<Output = cc_protocol::Result<T>> + Send + 'static,
    {
        let scope = self.app.scope();
        let work = scope.within(work(self.app.clone(), scope.clone()));
        self.call(work).await
    }
    /// [`CoreInner::run`], then waits until the events the operation caused
    /// reached the bridge subscriber, so they precede its result.
    pub(crate) async fn call<T, F>(&self, work: F) -> Result<T, CoreFailure>
    where
        T: Send + 'static,
        F: Future<Output = cc_protocol::Result<T>> + Send + 'static,
    {
        let result = self.run(work).await;
        self.app.outbox.flush().await;
        result
    }
}

impl Core {
    pub(crate) fn from_inner(inner: CoreInner) -> Self {
        Self {
            inner: Arc::new(inner),
        }
    }
    pub fn auth(&self) -> AuthService {
        AuthService::new(self.inner.clone())
    }
    pub fn account(&self) -> AccountService {
        AccountService::new(self.inner.clone())
    }
    pub fn usage(&self) -> ProviderUsageService {
        ProviderUsageService::new(self.inner.clone())
    }
    pub fn transport_bridge(&self) -> TransportBridge {
        TransportBridge::new(self.inner.clone())
    }
    pub fn diagnostics(&self) -> Diagnostics {
        Diagnostics::new(self.inner.clone())
    }
    /// Closes every account service and waits until the records they still
    /// held (chat and Home drafts and choices) are stored, at most 3 s, so a
    /// core opened next on the same store reads them. Then stops all work
    /// without waiting for network I/O: waiting calls fail with `shutdown`
    /// and the bridge subscription ends. Suspend first to close sessions
    /// politely.
    pub async fn close(&self) {
        let app = self.inner.app.clone();
        // On the core runtime, where those services run; one already
        // stopped has nothing left to store.
        let _ = self
            .inner
            .handle
            .spawn(async move { app.store_records().await })
            .await;
        self.inner.shutdown();
    }
}

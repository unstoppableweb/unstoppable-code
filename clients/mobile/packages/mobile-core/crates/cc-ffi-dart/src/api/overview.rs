//! One computer's overview read models (P4): the worktree roster and
//! rows, context scopes and attention, Cowork chat states, Recents and the
//! catalog. Intents resolve when their work finished, with the view then;
//! [`OverviewService::watch`] streams every change (latest wins).
use super::{core::CoreFailure, handler};
use crate::frb_generated::StreamSink;
use flutter_rust_bridge::frb;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerView {
    /// `None` for Personal.
    pub organization_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectView {
    pub id: String,
    pub name: String,
    /// `single-repo`, `multi-repo` or `cowork`, as the desktop sends it.
    pub kind: String,
    pub color: Option<String>,
    pub temporary: bool,
    pub always_show: bool,
    /// `None` when ownership could not be established.
    pub owner: Option<OwnerView>,
    pub order: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatRefView {
    pub project_id: String,
    pub worktree_id: String,
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MergeQueueView {
    pub in_queue: bool,
    pub position: Option<i64>,
    pub phase: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PrStatusView {
    pub repo_id: Option<String>,
    pub pr_number: Option<i64>,
    pub state: String,
    pub url: Option<String>,
    pub title: Option<String>,
    pub base_ref_name: Option<String>,
    pub check_status: Option<String>,
    pub review_status: Option<String>,
    pub has_conflicts: Option<bool>,
    pub merge_ready: Option<bool>,
    pub comment_count: Option<i64>,
    pub unresolved_review_thread_count: Option<i64>,
    pub merge_queue: Option<MergeQueueView>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorktreeRowView {
    pub local_id: String,
    pub workspace_local_id: String,
    pub branch: String,
    pub label: Option<String>,
    pub order: Option<f64>,
    pub status: Option<String>,
    pub busy: Option<bool>,
    pub is_streaming: Option<bool>,
    pub background_tasks: Option<i64>,
    pub has_unread: Option<bool>,
    pub hidden: Option<bool>,
    pub awaiting_approval: Option<bool>,
    pub pipeline_status: Option<String>,
    pub script_status: Option<String>,
    pub hook_status: Option<String>,
    pub terminal_status: Option<String>,
    pub setup_phase: Option<String>,
    pub last_activity_at: Option<String>,
    pub created_at: Option<String>,
    pub insertions: Option<i64>,
    pub deletions: Option<i64>,
    pub pr_statuses: Vec<PrStatusView>,
    pub merging_pr: bool,
    pub merge_pr_phase: Option<String>,
    pub notification_space_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeStatus {
    Loading,
    Unavailable,
    NeedsInput,
    Working,
    Failed,
    Done,
    Idle,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorktreeChatsView {
    pub sequence: u64,
    pub chats: Vec<ChatRefView>,
    pub active_chat_id: Option<String>,
    pub status: WorktreeStatus,
    pub unread: bool,
    pub pending_question: bool,
    pub pending_approval: bool,
    pub is_streaming: bool,
    pub working_chats: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorktreeView {
    /// `projectId/id`.
    pub key: String,
    pub project_id: String,
    pub project_name: String,
    pub id: String,
    pub name: String,
    pub saved_status: Option<String>,
    pub order: Option<f64>,
    pub hidden: bool,
    pub pipeline_status: Option<String>,
    /// The roster read that built this row; pass it back to
    /// [`OverviewService::load_worktree`].
    pub instance: u64,
    pub chats: WorktreeChatsView,
    pub code_graph_building: bool,
    pub row: WorktreeRowView,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionEntryView {
    pub worktree_key: String,
    pub workspace_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionView {
    pub awaiting_approval: Vec<AttentionEntryView>,
    pub unread_chats: Vec<AttentionEntryView>,
    pub in_progress: Vec<AttentionEntryView>,
    pub pipelines_running: Vec<AttentionEntryView>,
    pub pipelines_finished: Vec<AttentionEntryView>,
    pub entries: Vec<AttentionEntryView>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextScopeView {
    pub owner: OwnerView,
    pub project_ids: Vec<String>,
    /// Visible worktrees: browser, search and Recents.
    pub worktree_keys: Vec<String>,
    /// Hidden ones too.
    pub all_worktree_keys: Vec<String>,
    pub cowork_project_ids: Vec<String>,
    pub attention: AttentionView,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogWorkspaceView {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoworkChatView {
    pub chat_id: String,
    pub unread: bool,
    pub working: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoworkScopeView {
    pub scope_key: String,
    pub chats: Vec<CoworkChatView>,
}

/// The notification space of a Cowork chat's Work Entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationSpaceView {
    pub chat_id: String,
    pub space_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecentAttention {
    None,
    Unread,
    AwaitingAnswer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentChatView {
    pub chat: ChatRefView,
    pub worktree_name: Option<String>,
    pub activity_at_ms: Option<i64>,
    pub attention: RecentAttention,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentsView {
    pub owner: OwnerView,
    pub chats: Vec<RecentChatView>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OverviewView {
    pub revision: u64,
    pub loading: bool,
    /// Ownership is being re-read; actions must wait.
    pub scope_pending: bool,
    /// The connected account session this view was computed for.
    pub session: Option<u64>,
    /// The catalog completed a successful read in this session.
    pub catalog_current: bool,
    pub error: Option<String>,
    pub has_inventory: bool,
    /// How many refreshes started: hosts that read beside the overview
    /// (clone jobs) re-read on each.
    pub refreshes: u64,
    pub projects: Vec<ProjectView>,
    pub worktrees: Vec<WorktreeView>,
    pub code_project_ids: Vec<String>,
    /// Some project's ownership is unknown.
    pub has_unknown_owners: bool,
    pub scopes: Vec<ContextScopeView>,
    /// Bumped when the catalog was read again.
    pub catalog_revision: u64,
    pub catalog: Vec<ChatRefView>,
    pub catalog_workspaces: Vec<CatalogWorkspaceView>,
    pub cowork: Vec<CoworkScopeView>,
    pub has_recents: bool,
    pub recents: Vec<RecentsView>,
    /// Cowork chats' Work Entry notification spaces, from the session
    /// snapshot (the search catalog does not carry them).
    pub notification_spaces: Vec<NotificationSpaceView>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogView {
    pub chats: Vec<ChatRefView>,
    pub workspaces: Vec<CatalogWorkspaceView>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum WorktreeLoad {
    Loaded(WorktreeChatsView),
    /// The read failed or was unreadable: only the status changes.
    Unavailable,
    /// A newer roster or a reconnect superseded the read: nothing changes.
    Stale,
    SessionLost,
}

impl From<cc_core::OwnerView> for OwnerView {
    fn from(v: cc_core::OwnerView) -> Self {
        Self {
            organization_id: v.organization_id,
        }
    }
}

impl From<cc_core::ProjectView> for ProjectView {
    fn from(v: cc_core::ProjectView) -> Self {
        Self {
            id: v.id,
            name: v.name,
            kind: v.kind,
            color: v.color,
            temporary: v.temporary,
            always_show: v.always_show,
            owner: v.owner.map(Into::into),
            order: v.order,
        }
    }
}

impl From<cc_core::ChatRefView> for ChatRefView {
    fn from(v: cc_core::ChatRefView) -> Self {
        Self {
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            id: v.id,
            title: v.title,
        }
    }
}

impl From<cc_core::MergeQueueView> for MergeQueueView {
    fn from(v: cc_core::MergeQueueView) -> Self {
        Self {
            in_queue: v.in_queue,
            position: v.position,
            phase: v.phase,
        }
    }
}

impl From<cc_core::PrStatusView> for PrStatusView {
    fn from(v: cc_core::PrStatusView) -> Self {
        Self {
            repo_id: v.repo_id,
            pr_number: v.pr_number,
            state: v.state,
            url: v.url,
            title: v.title,
            base_ref_name: v.base_ref_name,
            check_status: v.check_status,
            review_status: v.review_status,
            has_conflicts: v.has_conflicts,
            merge_ready: v.merge_ready,
            comment_count: v.comment_count,
            unresolved_review_thread_count: v.unresolved_review_thread_count,
            merge_queue: v.merge_queue.map(Into::into),
        }
    }
}

impl From<cc_core::WorktreeRowView> for WorktreeRowView {
    fn from(v: cc_core::WorktreeRowView) -> Self {
        Self {
            local_id: v.local_id,
            workspace_local_id: v.workspace_local_id,
            branch: v.branch,
            label: v.label,
            order: v.order,
            status: v.status,
            busy: v.busy,
            is_streaming: v.is_streaming,
            background_tasks: v.background_tasks,
            has_unread: v.has_unread,
            hidden: v.hidden,
            awaiting_approval: v.awaiting_approval,
            pipeline_status: v.pipeline_status,
            script_status: v.script_status,
            hook_status: v.hook_status,
            terminal_status: v.terminal_status,
            setup_phase: v.setup_phase,
            last_activity_at: v.last_activity_at,
            created_at: v.created_at,
            insertions: v.insertions,
            deletions: v.deletions,
            pr_statuses: v.pr_statuses.into_iter().map(Into::into).collect(),
            merging_pr: v.merging_pr,
            merge_pr_phase: v.merge_pr_phase,
            notification_space_id: v.notification_space_id,
        }
    }
}

impl From<cc_core::WorktreeStatus> for WorktreeStatus {
    fn from(v: cc_core::WorktreeStatus) -> Self {
        match v {
            cc_core::WorktreeStatus::Loading => Self::Loading,
            cc_core::WorktreeStatus::Unavailable => Self::Unavailable,
            cc_core::WorktreeStatus::NeedsInput => Self::NeedsInput,
            cc_core::WorktreeStatus::Working => Self::Working,
            cc_core::WorktreeStatus::Failed => Self::Failed,
            cc_core::WorktreeStatus::Done => Self::Done,
            cc_core::WorktreeStatus::Idle => Self::Idle,
        }
    }
}

impl From<cc_core::WorktreeChatsView> for WorktreeChatsView {
    fn from(v: cc_core::WorktreeChatsView) -> Self {
        Self {
            sequence: v.sequence,
            chats: v.chats.into_iter().map(Into::into).collect(),
            active_chat_id: v.active_chat_id,
            status: v.status.into(),
            unread: v.unread,
            pending_question: v.pending_question,
            pending_approval: v.pending_approval,
            is_streaming: v.is_streaming,
            working_chats: v.working_chats,
        }
    }
}

impl From<cc_core::WorktreeView> for WorktreeView {
    fn from(v: cc_core::WorktreeView) -> Self {
        Self {
            key: v.key,
            project_id: v.project_id,
            project_name: v.project_name,
            id: v.id,
            name: v.name,
            saved_status: v.saved_status,
            order: v.order,
            hidden: v.hidden,
            pipeline_status: v.pipeline_status,
            instance: v.instance,
            chats: v.chats.into(),
            code_graph_building: v.code_graph_building,
            row: v.row.into(),
        }
    }
}

impl From<cc_core::AttentionEntryView> for AttentionEntryView {
    fn from(v: cc_core::AttentionEntryView) -> Self {
        Self {
            worktree_key: v.worktree_key,
            workspace_name: v.workspace_name,
        }
    }
}

impl From<cc_core::AttentionView> for AttentionView {
    fn from(v: cc_core::AttentionView) -> Self {
        Self {
            awaiting_approval: v.awaiting_approval.into_iter().map(Into::into).collect(),
            unread_chats: v.unread_chats.into_iter().map(Into::into).collect(),
            in_progress: v.in_progress.into_iter().map(Into::into).collect(),
            pipelines_running: v.pipelines_running.into_iter().map(Into::into).collect(),
            pipelines_finished: v.pipelines_finished.into_iter().map(Into::into).collect(),
            entries: v.entries.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::ContextScopeView> for ContextScopeView {
    fn from(v: cc_core::ContextScopeView) -> Self {
        Self {
            owner: v.owner.into(),
            project_ids: v.project_ids,
            worktree_keys: v.worktree_keys,
            all_worktree_keys: v.all_worktree_keys,
            cowork_project_ids: v.cowork_project_ids,
            attention: v.attention.into(),
        }
    }
}

impl From<cc_core::CatalogWorkspaceView> for CatalogWorkspaceView {
    fn from(v: cc_core::CatalogWorkspaceView) -> Self {
        Self {
            id: v.id,
            name: v.name,
        }
    }
}

impl From<cc_core::CoworkChatView> for CoworkChatView {
    fn from(v: cc_core::CoworkChatView) -> Self {
        Self {
            chat_id: v.chat_id,
            unread: v.unread,
            working: v.working,
        }
    }
}

impl From<cc_core::CoworkScopeView> for CoworkScopeView {
    fn from(v: cc_core::CoworkScopeView) -> Self {
        Self {
            scope_key: v.scope_key,
            chats: v.chats.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::RecentAttention> for RecentAttention {
    fn from(v: cc_core::RecentAttention) -> Self {
        match v {
            cc_core::RecentAttention::None => Self::None,
            cc_core::RecentAttention::Unread => Self::Unread,
            cc_core::RecentAttention::AwaitingAnswer => Self::AwaitingAnswer,
        }
    }
}

impl From<cc_core::RecentChatView> for RecentChatView {
    fn from(v: cc_core::RecentChatView) -> Self {
        Self {
            chat: v.chat.into(),
            worktree_name: v.worktree_name,
            activity_at_ms: v.activity_at_ms,
            attention: v.attention.into(),
        }
    }
}

impl From<cc_core::RecentsView> for RecentsView {
    fn from(v: cc_core::RecentsView) -> Self {
        Self {
            owner: v.owner.into(),
            chats: v.chats.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::OverviewView> for OverviewView {
    fn from(v: cc_core::OverviewView) -> Self {
        Self {
            revision: v.revision,
            loading: v.loading,
            scope_pending: v.scope_pending,
            session: v.session,
            catalog_current: v.catalog_current,
            error: v.error,
            has_inventory: v.has_inventory,
            refreshes: v.refreshes,
            projects: v.projects.into_iter().map(Into::into).collect(),
            worktrees: v.worktrees.into_iter().map(Into::into).collect(),
            code_project_ids: v.code_project_ids,
            has_unknown_owners: v.has_unknown_owners,
            scopes: v.scopes.into_iter().map(Into::into).collect(),
            catalog_revision: v.catalog_revision,
            catalog: v.catalog.into_iter().map(Into::into).collect(),
            catalog_workspaces: v.catalog_workspaces.into_iter().map(Into::into).collect(),
            cowork: v.cowork.into_iter().map(Into::into).collect(),
            has_recents: v.has_recents,
            recents: v.recents.into_iter().map(Into::into).collect(),
            notification_spaces: v
                .notification_spaces
                .into_iter()
                .map(|n| NotificationSpaceView {
                    chat_id: n.chat_id,
                    space_id: n.space_id,
                })
                .collect(),
        }
    }
}

impl From<cc_core::CatalogView> for CatalogView {
    fn from(v: cc_core::CatalogView) -> Self {
        Self {
            chats: v.chats.into_iter().map(Into::into).collect(),
            workspaces: v.workspaces.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::WorktreeLoad> for WorktreeLoad {
    fn from(v: cc_core::WorktreeLoad) -> Self {
        match v {
            cc_core::WorktreeLoad::Loaded(x) => Self::Loaded(x.into()),
            cc_core::WorktreeLoad::Unavailable => Self::Unavailable,
            cc_core::WorktreeLoad::Stale => Self::Stale,
            cc_core::WorktreeLoad::SessionLost => Self::SessionLost,
        }
    }
}

type Overviewed = Result<OverviewView, CoreFailure>;

fn overviewed(r: Result<cc_core::OverviewView, cc_core::CoreFailure>) -> Overviewed {
    r.map(Into::into).map_err(Into::into)
}

#[frb(opaque)]
#[derive(Clone)]
pub struct OverviewService {
    pub(super) inner: cc_core::OverviewService,
}

impl OverviewService {
    /// Indexes of recent rows, newest first, with a cap per computer.
    #[frb(sync)]
    pub fn recent_order(computers: Vec<Vec<Option<i64>>>, limit: u32) -> Vec<u32> {
        cc_core::OverviewService::recent_order(computers, limit as usize)
            .into_iter()
            .map(|index| u32::try_from(index).expect("recent row index fits in u32"))
            .collect()
    }

    pub(crate) fn new(inner: cc_core::OverviewService) -> Self {
        Self { inner }
    }
    /// The current view, then every change (latest wins).
    pub fn watch(&self, sink: StreamSink<OverviewView>) {
        let mut views = self.inner.watch();
        handler::runtime().spawn(async move {
            while let Some(view) = views.next().await {
                if sink.add(view.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// The overview is shown: claims every chat scope, then refreshes.
    ///
    /// Resolves when settled: after the claim's write and the refresh it
    /// starts finished (at once when offline).
    pub async fn watch_overview(&self) -> Overviewed {
        overviewed(self.inner.watch_overview().await)
    }
    /// A chat takes over: stops overview reads and releases the claim
    /// without writing.
    ///
    /// Resolves when applied.
    pub async fn enter_chat(&self) -> Overviewed {
        overviewed(self.inner.enter_chat().await)
    }
    /// Re-reads inventory, ownership, the catalog, Cowork states and
    /// Recents. Does nothing while a refresh runs or while offline.
    ///
    /// Resolves when settled: once the refresh it started finished; at once
    /// when it started none.
    pub async fn refresh(&self) -> Overviewed {
        overviewed(self.inner.refresh().await)
    }
    /// [`Self::refresh`], or once more after the running one.
    ///
    /// Resolves when settled when it starts a refresh; while one runs it
    /// resolves when applied (the extra refresh is queued).
    pub async fn refresh_soon(&self) -> Overviewed {
        overviewed(self.inner.refresh_soon().await)
    }
    /// Re-reads the worktree roster only.
    ///
    /// Resolves when settled: once the roster read finished.
    pub async fn reload_worktrees(&self) -> Overviewed {
        overviewed(self.inner.reload_worktrees().await)
    }
    /// The collation locale for worktree order (BCP 47, the system locale).
    ///
    /// Resolves when applied.
    pub async fn set_locale(&self, tag: String) -> Overviewed {
        overviewed(self.inner.set_locale(tag).await)
    }
    /// Re-reads one worktree's chats. A row of the current roster with
    /// `instance` takes the result too.
    ///
    /// Resolves when settled, with the read's outcome.
    pub async fn load_worktree(
        &self,
        project_id: String,
        worktree_id: String,
        saved_status: Option<String>,
        instance: u64,
    ) -> Result<WorktreeLoad, CoreFailure> {
        self.inner
            .load_worktree(project_id, worktree_id, saved_status, instance)
            .await
            .map(Into::into)
            .map_err(Into::into)
    }
    /// Reads the search catalog once, for the chats feature's own list,
    /// from a session of the account the overview was opened in only: it
    /// fails `account_changed` once that account was left, also while it
    /// read.
    ///
    /// Resolves when settled, with the catalog read.
    pub async fn read_catalog(&self) -> Result<CatalogView, CoreFailure> {
        self.inner
            .read_catalog()
            .await
            .map(Into::into)
            .map_err(Into::into)
    }
    /// Stops this overview: no more reads, its claim released.
    ///
    /// Resolves when applied.
    pub async fn close(&self) -> Overviewed {
        overviewed(self.inner.close().await)
    }
}

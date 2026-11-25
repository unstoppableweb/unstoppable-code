//! One computer's overview read models (architecture §3.3, P4): the
//! worktree roster and rows, context scopes and attention, Cowork chat
//! states, Recents and the chat catalog, read from the desktop beside the
//! computer's chats. While shown, the overview claims every chat scope
//! through the computer's interest arbiter.
//!
//! [`OverviewService::watch`] streams [`OverviewView`]s (latest wins).
//! Intents resolve when their work finished, with the view at that point:
//! `refresh` once the read completed, `watch_overview` once its claim was
//! written and its refresh completed.
use super::{CoreFailure, CoreInner, Subscription};
use crate::overview::{Handle, Intent, LoadOutcome};
use std::sync::Arc;

/// Who owns a project: Personal, or an organization by id.
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

/// The shared worktree row's input (`RemoteWorktree`).
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

/// What a worktree's chats are doing.
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

/// A worktree's chats as its last `chat:get-state` read showed them.
#[derive(Debug, Clone, PartialEq)]
pub struct WorktreeChatsView {
    /// Sequence of the successful read within this overview.
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

/// The shared attention sections, plus the phone's deduplicated queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionView {
    pub awaiting_approval: Vec<AttentionEntryView>,
    pub unread_chats: Vec<AttentionEntryView>,
    pub in_progress: Vec<AttentionEntryView>,
    pub pipelines_running: Vec<AttentionEntryView>,
    pub pipelines_finished: Vec<AttentionEntryView>,
    pub entries: Vec<AttentionEntryView>,
}

/// One context's slice of the roster. A context without a scope here owns
/// nothing on this computer.
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

/// A Cowork chat's flags in its entry's state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoworkChatView {
    pub chat_id: String,
    pub unread: bool,
    pub working: bool,
}

/// One Cowork entry's read state (`projectId/entryId`).
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

/// A context's Recents on this computer, unordered.
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

/// The search catalog as one read returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogView {
    pub chats: Vec<ChatRefView>,
    pub workspaces: Vec<CatalogWorkspaceView>,
}

/// How an explicit worktree read ended.
#[derive(Debug, Clone, PartialEq)]
pub enum WorktreeLoad {
    Loaded(WorktreeChatsView),
    /// The read failed or was unreadable: only the status changes.
    Unavailable,
    /// A newer roster or a reconnect superseded the read: nothing changes.
    Stale,
    SessionLost,
}

/// One computer's overview. Built by [`super::AccountService::overview`].
#[derive(Clone)]
pub struct OverviewService {
    inner: Arc<CoreInner>,
    handle: Handle,
}

impl OverviewService {
    /// Orders the account's recent rows by activity with a cap per computer.
    pub fn recent_order(computers: Vec<Vec<Option<i64>>>, limit: usize) -> Vec<usize> {
        cc_domain::overview::interleave_recents(computers, limit)
    }

    pub(crate) fn new(inner: Arc<CoreInner>, handle: Handle) -> Self {
        Self { inner, handle }
    }
    /// The current view, then every change (latest wins).
    pub fn watch(&self) -> Subscription<OverviewView> {
        Subscription::view(self.handle.view())
    }
    async fn view(
        &self,
        intent: impl FnOnce(crate::overview::Waiter) -> Intent + Send + 'static,
    ) -> Result<OverviewView, CoreFailure> {
        let handle = self.handle.clone();
        let view = self
            .inner
            .run(async move { handle.request(intent).await })
            .await?;
        Ok(OverviewView::clone(&view))
    }
    /// The overview is shown: claims every chat scope, then refreshes.
    ///
    /// Resolves when settled: after the claim's write and the refresh it
    /// starts finished (at once when offline).
    pub async fn watch_overview(&self) -> Result<OverviewView, CoreFailure> {
        self.view(Intent::Watch).await
    }
    /// A chat takes over: stops overview reads and releases the claim
    /// without writing.
    ///
    /// Resolves when applied.
    pub async fn enter_chat(&self) -> Result<OverviewView, CoreFailure> {
        self.view(Intent::EnterChat).await
    }
    /// Re-reads inventory, ownership, the catalog, Cowork states and
    /// Recents. Does nothing while a refresh runs or while offline.
    ///
    /// Resolves when settled: once the refresh it started finished; at once
    /// when it started none.
    pub async fn refresh(&self) -> Result<OverviewView, CoreFailure> {
        self.view(Intent::Refresh).await
    }
    /// [`Self::refresh`], or once more after the running one.
    ///
    /// Resolves when settled when it starts a refresh; while one runs it
    /// resolves when applied (the extra refresh is queued).
    pub async fn refresh_soon(&self) -> Result<OverviewView, CoreFailure> {
        self.view(Intent::RefreshSoon).await
    }
    /// Re-reads the worktree roster only.
    ///
    /// Resolves when settled: once the roster read finished.
    pub async fn reload_worktrees(&self) -> Result<OverviewView, CoreFailure> {
        self.view(Intent::Reload).await
    }
    /// The collation locale for worktree order (BCP 47, the system locale).
    ///
    /// Resolves when applied.
    pub async fn set_locale(&self, tag: String) -> Result<OverviewView, CoreFailure> {
        self.view(move |waiter| Intent::SetLocale(tag, waiter))
            .await
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
        let handle = self.handle.clone();
        let outcome = self
            .inner
            .run(async move {
                handle
                    .load(project_id, worktree_id, saved_status, instance)
                    .await
            })
            .await?;
        Ok(match outcome {
            LoadOutcome::Loaded(chats, sequence) => {
                WorktreeLoad::Loaded(crate::overview::chats_view(&chats, sequence))
            }
            LoadOutcome::Unavailable => WorktreeLoad::Unavailable,
            LoadOutcome::Stale => WorktreeLoad::Stale,
            LoadOutcome::SessionLost => WorktreeLoad::SessionLost,
        })
    }
    /// Reads the search catalog once, for the chats feature's own list,
    /// from a session of the account the overview was opened in only: it
    /// fails `account_changed` once that account was left, also while it
    /// read.
    ///
    /// Resolves when settled, with the catalog read.
    pub async fn read_catalog(&self) -> Result<CatalogView, CoreFailure> {
        let handle = self.handle.clone();
        self.inner
            .run(async move { handle.read_catalog().await })
            .await
    }
    /// Stops this overview: no more reads, its claim released.
    ///
    /// Resolves when applied.
    pub async fn close(&self) -> Result<OverviewView, CoreFailure> {
        self.view(Intent::Close).await
    }
}

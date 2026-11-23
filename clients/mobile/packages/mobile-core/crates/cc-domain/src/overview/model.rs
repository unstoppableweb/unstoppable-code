//! The overview's domain values, as the Dart repositories hold them.

/// Who owns a workspace (`WorkspaceContext`). A project whose owner could
/// not be established has `None` instead (`DeviceProject.ownerContext`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Owner {
    Personal,
    Organization(String),
}

/// A listed project (`DeviceProject`).
#[derive(Debug, Clone, PartialEq)]
pub struct Project {
    pub id: String,
    pub name: String,
    /// The wire type: `single-repo`, `multi-repo` or `cowork`.
    pub kind: String,
    pub color: Option<String>,
    pub temporary: bool,
    pub always_show: bool,
    /// `None`: ownership unknown (absent snapshot row or unrecognized owner).
    pub owner: Option<Owner>,
    pub order: Option<f64>,
}

impl Project {
    pub fn is_cowork(&self) -> bool {
        self.kind == "cowork"
    }
}

/// A merge queue entry (`RemotePrMergeQueue`).
#[derive(Debug, Clone, PartialEq)]
pub struct MergeQueue {
    pub in_queue: bool,
    pub position: Option<i64>,
    /// The wire phase, or `unknown` for an unrecognized one; `None` when
    /// not queued or absent.
    pub phase: Option<String>,
}

/// One repo's PR observation (`RemoteWorktreePr` from `lastKnownPrStatus`).
#[derive(Debug, Clone, PartialEq)]
pub struct PrStatus {
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
    pub merge_queue: Option<MergeQueue>,
}

/// The shared worktree row's input (`RemoteWorktree`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct WorktreeRow {
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
    /// `running`, `unseen`, `unseen-failure` or `paused`.
    pub pipeline_status: Option<String>,
    pub script_status: Option<String>,
    pub hook_status: Option<String>,
    pub terminal_status: Option<String>,
    /// `idle`, `git-pending`, `running-setup` or `running-teardown`.
    pub setup_phase: Option<String>,
    pub last_activity_at: Option<String>,
    pub created_at: Option<String>,
    pub insertions: Option<i64>,
    pub deletions: Option<i64>,
    pub pr_statuses: Vec<PrStatus>,
    pub merging_pr: bool,
    pub merge_pr_phase: Option<String>,
    pub notification_space_id: Option<String>,
}

/// A chat a worktree, Cowork entry or catalog lists (`DeviceChatRef`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatRef {
    pub project_id: String,
    pub worktree_id: String,
    pub id: String,
    pub title: String,
}

impl ChatRef {
    /// `projectId/worktreeId/id`.
    pub fn key(&self) -> String {
        format!("{}/{}/{}", self.project_id, self.worktree_id, self.id)
    }
    /// `projectId/worktreeId`.
    pub fn scope_key(&self) -> String {
        format!("{}/{}", self.project_id, self.worktree_id)
    }
}

/// A workspace the chat catalog offers (`DeviceChatWorkspace`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogWorkspace {
    pub id: String,
    pub name: String,
}

/// The search catalog's live chats and the chat workspaces.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Catalog {
    pub chats: Vec<ChatRef>,
    pub workspaces: Vec<CatalogWorkspace>,
}

/// What a worktree's chats are doing (`DeviceWorktree.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatStatus {
    Loading,
    Unavailable,
    NeedsInput,
    Working,
    Failed,
    Done,
    Idle,
}

impl ChatStatus {
    /// The row shows chat-derived flags only once they were read.
    pub fn known(self) -> bool {
        !matches!(self, Self::Loading | Self::Unavailable)
    }
}

/// A worktree's chat state, read from its `chat:get-state`.
#[derive(Debug, Clone, PartialEq)]
pub struct WorktreeChats {
    pub chats: Vec<ChatRef>,
    pub active_chat_id: Option<String>,
    pub status: ChatStatus,
    pub unread: bool,
    pub pending_question: bool,
    pub pending_approval: bool,
    pub is_streaming: bool,
    /// Chat ids with a live runtime, in the desktop's order.
    pub working_chats: Vec<String>,
}

impl Default for WorktreeChats {
    fn default() -> Self {
        Self {
            chats: Vec::new(),
            active_chat_id: None,
            status: ChatStatus::Loading,
            unread: false,
            pending_question: false,
            pending_approval: false,
            is_streaming: false,
            working_chats: Vec::new(),
        }
    }
}

/// A non-archived worktree of the roster (`DeviceWorktree`).
#[derive(Debug, Clone, PartialEq)]
pub struct Worktree {
    pub project_id: String,
    pub project_name: String,
    pub id: String,
    pub name: String,
    pub saved_status: Option<String>,
    pub order: Option<f64>,
    pub hidden: bool,
    pub pipeline_status: Option<String>,
    /// The row from inventory and the session projection, before the chat
    /// state is applied (`deviceWorktreeRow` without the chat fields).
    pub base_row: WorktreeRow,
    pub chats: WorktreeChats,
    /// Which roster read built this row. A chat read started on one roster
    /// never changes another's rows (Dart mutates only its own object).
    pub instance: u64,
}

impl Worktree {
    /// `projectId/id`.
    pub fn key(&self) -> String {
        format!("{}/{}", self.project_id, self.id)
    }
}

/// One tab of a chat scope's `chat:get-state`.
#[derive(Debug, Clone, PartialEq)]
pub struct ScopeTab {
    /// `None` when the tab's id is not a string.
    pub id: Option<String>,
    /// The id when it is a valid link string (`deviceLinkString`).
    pub link_id: Option<String>,
    /// The tab map was empty.
    pub empty: bool,
    pub is_file: bool,
    pub archived: bool,
    pub unread: bool,
    pub plan_exit: bool,
    pub title: String,
}

/// A pending question of a chat scope.
#[derive(Debug, Clone, PartialEq)]
pub struct ScopeQuestion {
    pub open: bool,
}

/// A chat scope's `chat:get-state`, decoded.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ScopeSnapshot {
    pub tabs: Vec<ScopeTab>,
    pub active_tab_id: Option<String>,
    /// Each runtime that is an object: its chat id and wire status.
    pub runtime: Vec<(String, Option<String>)>,
    pub approvals: usize,
    pub questions: Vec<ScopeQuestion>,
}

/// One row of `pipelines:list-executions`.
#[derive(Debug, Clone, PartialEq)]
pub struct Execution {
    pub project_id: String,
    pub worktree_id: String,
    pub id: String,
    pub status: Option<String>,
}

/// A workspace of the session snapshot, as Recents reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotWorkspace {
    pub local_id: String,
    pub owner: Option<Owner>,
    pub placeholder: bool,
    pub hidden: bool,
    /// `single-repo`, `multi-repo` or `cowork`; `None` when unrecognized.
    pub kind: Option<String>,
}

/// A worktree of the session snapshot, as Recents reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotWorktree {
    pub local_id: String,
    pub workspace_local_id: String,
    pub branch: String,
    pub label: Option<String>,
    pub hidden: Option<bool>,
}

/// A chat summary of the session snapshot (`RemoteChatSummary`).
#[derive(Debug, Clone, PartialEq)]
pub struct ChatSummary {
    pub chat_id: String,
    /// `worktree` or `standalone`; `None` when absent or unrecognized.
    pub scope: Option<String>,
    pub display_title: String,
    pub workspace_local_id: Option<String>,
    pub worktree_local_id: Option<String>,
    pub created_at: Option<String>,
    pub last_message_at: Option<String>,
    /// `None` when the summary carries no question list.
    pub open_question: Option<bool>,
    pub has_unread: Option<bool>,
}

/// A Cowork chat of the session snapshot (`RemoteStandaloneChat`).
#[derive(Debug, Clone, PartialEq)]
pub struct StandaloneChat {
    pub local_id: String,
    pub project_local_id: String,
    pub display_title: String,
    pub work_entry_id: Option<String>,
    /// The server notification space of the chat's Work Entry, once the
    /// computer registered one.
    pub work_entry_notification_space_id: Option<String>,
    pub archived: Option<bool>,
    pub last_message_at: Option<String>,
    pub has_unread: Option<bool>,
}

/// What Recents reads from `desktop:session-snapshot`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RecentSnapshot {
    pub workspaces: Vec<SnapshotWorkspace>,
    pub worktrees: Vec<SnapshotWorktree>,
    pub standalone_chats: Vec<StandaloneChat>,
    pub chat_summaries: Vec<ChatSummary>,
}

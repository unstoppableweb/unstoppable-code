//! One computer's worktree activity and changed-file diffs (P6): changed
//! files grouped for the Files tab, summary, plans, scripts, hooks, todos,
//! pull requests with their progress and guarded actions, and each
//! changed file's diff. [`ActivityService::watch`] streams one chat's
//! worktree view and [`ActivityService::watch_diff`] one file's diff;
//! intents are queued in call order and each variant of
//! [`ActivityIntent`] says when it settles.
use super::{core::CoreFailure, handler, overview::ChatRefView};
use crate::frb_generated::StreamSink;
use flutter_rust_bridge::frb;

/// `RemotePrAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrActionKind {
    Refresh,
    Create,
    Merge,
}

/// `RemotePrActionIdentity`: the repository identity shown when an action
/// was chosen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrIdentityView {
    pub base_branch: String,
    pub head_branch: String,
    pub pr_number: Option<i64>,
}

/// A changed file whose diff is read; the line counts are the list's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffTargetView {
    pub project_id: String,
    pub worktree_id: String,
    pub repo_id: Option<String>,
    pub path: String,
    pub committed: bool,
    pub insertions: Option<i64>,
    pub deletions: Option<i64>,
}

/// What the host asks of the activity. Queued in call order.
#[derive(Debug, Clone)]
pub enum ActivityIntent {
    /// The session became usable or ended; a connect re-reads every
    /// watched worktree.
    ///
    /// Resolves when settled: the loads it started finished.
    SetConnected { connected: bool },
    /// Shows `chat`'s worktree (the drawer opened): reads its activity
    /// and pull requests. `token` names the watch for [`Self::Release`].
    ///
    /// Resolves when applied.
    Watch { chat: ChatRefView, token: u64 },
    /// Ends the watch `token`.
    ///
    /// Resolves when applied.
    Release { token: u64 },
    /// Reads `chat`'s worktree activity and configured hooks again.
    ///
    /// Resolves when settled: both reads finished (at once offline).
    Load { chat: ChatRefView },
    /// Sets a configured hook's paused state; writes serialize per
    /// worktree.
    ///
    /// Resolves when settled: the write and the hook read after it
    /// finished, or failed into the view's hook error.
    SetHookPaused {
        chat: ChatRefView,
        hook_key: String,
        paused: bool,
    },
    /// Refreshes pull requests, or creates or merges one.
    ///
    /// Resolves when settled: the desktop answered (the settled outcome
    /// carries its result), or the action failed or was discarded.
    RunPr {
        chat: ChatRefView,
        action: PrActionKind,
        repo_id: Option<String>,
        identity: Option<PrIdentityView>,
        confirm_unresolved_comments: bool,
    },
    /// Shows `target`'s diff and reads it. `token` names the watch.
    ///
    /// Resolves when applied.
    WatchDiff { target: DiffTargetView, token: u64 },
    /// Ends the diff watch `token`.
    ///
    /// Resolves when applied.
    ReleaseDiff { token: u64 },
    /// Reads `target`'s diff again.
    ///
    /// Resolves when settled: the read finished (at once offline).
    RefreshDiff { target: DiffTargetView },
    /// Stops this activity.
    ///
    /// Resolves when applied.
    Close,
}

/// A failure the host rethrows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityFailure {
    pub message: String,
    /// A `DeviceLinkException` with `message`; otherwise the host words it.
    pub link: bool,
}

/// How a requested intent ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivitySettled {
    pub failure: Option<ActivityFailure>,
    /// A PR action's result map, in bridge form.
    pub result_json: Option<String>,
    /// A PR action finished after newer state; its result is not used.
    pub discarded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFileView {
    pub path: String,
    pub status: String,
    pub committed: bool,
    pub repo_id: Option<String>,
    pub repo_name: Option<String>,
    pub insertions: Option<i64>,
    pub deletions: Option<i64>,
}

/// A file under its directory header; `index` is its place in
/// [`ActivityView::changed_files`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntryView {
    pub index: u32,
    pub name: String,
}

/// Files sharing a parent directory (and repository).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileGroupView {
    pub repo_id: Option<String>,
    pub repo_name: Option<String>,
    /// Without a trailing slash; empty for the repository root.
    pub directory: String,
    pub files: Vec<FileEntryView>,
}

/// The Uncommitted or Committed section of the Files tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileSectionView {
    pub committed: bool,
    pub file_count: u32,
    pub insertions: i64,
    pub deletions: i64,
    pub groups: Vec<FileGroupView>,
}

/// Where the changed files stand while connected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilesStatus {
    Loading,
    Loaded,
    Failed { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryView {
    pub title: String,
    pub description: String,
    pub generated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanView {
    pub title: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoItemView {
    pub id: String,
    pub content: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoListView {
    pub chat_id: String,
    pub items: Vec<TodoItemView>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptView {
    pub key: String,
    pub script_name: String,
    pub name: String,
    pub target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptRunView {
    pub script: ScriptView,
    pub status: String,
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunView {
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookView {
    pub name: String,
    pub hook_key: String,
    pub trigger_name: String,
    pub paused: bool,
    pub run_disabled: bool,
    pub run_disabled_reason: Option<String>,
}

/// `PrCheckDisplayState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrCheckState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
    TimedOut,
    Skipped,
    ActionRequired,
    Neutral,
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrCheckView {
    pub name: String,
    pub status: Option<String>,
    pub execution_state: Option<String>,
    pub details_url: Option<String>,
    pub state: PrCheckState,
    /// The state's word.
    pub label: String,
    /// The row's screen-reader label.
    pub semantics: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrQueuePhase {
    Queued,
    AwaitingChecks,
    Mergeable,
    Locked,
    Unmergeable,
    Unknown,
}

/// A PR's merge queue entry and its words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrQueueView {
    pub in_queue: bool,
    pub position: Option<i64>,
    pub phase: Option<PrQueuePhase>,
    pub phase_label: Option<String>,
    /// Appended to the `PR #N` badge.
    pub badge: String,
    pub semantics: String,
    /// The card's detail line.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrView {
    pub repo_id: Option<String>,
    pub number: Option<i64>,
    pub url: Option<String>,
    pub state: String,
    pub title: Option<String>,
    pub base_ref_name: Option<String>,
    pub check_status: Option<String>,
    pub checks: Vec<PrCheckView>,
    pub review_status: Option<String>,
    pub merge_ready: Option<bool>,
    pub has_conflicts: Option<bool>,
    pub comment_count: Option<i64>,
    pub unresolved_review_thread_count: Option<i64>,
    pub merge_queue: Option<PrQueueView>,
    /// `Checks (X/Y passed)`.
    pub checks_header: String,
    pub checks_expanded: bool,
    /// The queue state an action's PR shows (`mergeQueueForActionPr`).
    pub action_queue: Option<PrQueueView>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrRepoView {
    pub repo_id: String,
    pub repo_name: String,
    pub pr: Option<PrView>,
    pub base_branch: Option<String>,
    pub head_branch: Option<String>,
    pub published: Option<bool>,
    pub can_create: bool,
    pub can_merge: bool,
    pub merge_warning: bool,
    pub create_blocked_reason: Option<String>,
    pub merge_blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrCreationPhase {
    GatheringChanges,
    Summarizing,
    Pushing,
    CreatingPr,
    Skipped,
    Done,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrMergePhase {
    Queued,
    CheckingMergeability,
    WaitingMergeability,
    Merging,
    RefreshingPrStatus,
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrCreationStepView {
    pub phase: PrCreationPhase,
    pub repo_name: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrMergeStepView {
    pub phase: PrMergePhase,
    pub repo_id: Option<String>,
    pub repo_name: Option<String>,
    pub queue_position: Option<i64>,
    pub queue_length: Option<i64>,
    pub retry_delay_ms: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrCreationView {
    pub current: PrCreationPhase,
    pub steps: Vec<PrCreationStepView>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrMergeView {
    pub current: PrMergePhase,
    pub steps: Vec<PrMergeStepView>,
}

/// The creation and merge feeds; either may be absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrProgressView {
    pub creation: Option<PrCreationView>,
    pub merge: Option<PrMergeView>,
}

/// One chat's worktree activity as the drawer shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityView {
    pub revision: u64,
    pub loading: bool,
    pub files_error: Option<String>,
    /// The activity reads' failures, in the order they failed.
    pub errors: Vec<String>,
    /// Uncommitted first, then committed, as the desktop lists them.
    pub changed_files: Vec<ChangedFileView>,
    pub file_sections: Vec<FileSectionView>,
    pub files_status: FilesStatus,
    /// The changed files' line totals.
    pub insertions: i64,
    pub deletions: i64,
    pub summary: Option<SummaryView>,
    pub plans: Vec<PlanView>,
    pub todo_lists: Vec<TodoListView>,
    /// Why the chat's todos are not shown, when they are not.
    pub todo_unavailable: Option<String>,
    pub scripts: Vec<ScriptView>,
    pub script_runs: Vec<ScriptRunView>,
    pub hooks: Vec<HookView>,
    pub hook_runs: Vec<RunView>,
    pub hook_error: Option<String>,
    /// `None` until pull requests were read.
    pub prs: Option<Vec<PrRepoView>>,
    pub pr_busy: bool,
    pub pr_progress: Option<PrProgressView>,
    pub pr_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffLineKind {
    Add,
    Del,
    Hunk,
    Meta,
    Context,
}

/// One classified patch line, with its marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLineView {
    pub kind: DiffLineKind,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffPhase {
    /// Nothing to show yet; the first read runs.
    Loading,
    /// The read failed before any diff was shown.
    Failed { message: String },
    /// The lines below (perhaps none).
    Shown,
}

/// One changed file's diff as its screen shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDiffView {
    pub phase: DiffPhase,
    /// File headers stripped, at most 5,000 lines of at most 1,000
    /// characters.
    pub lines: Vec<DiffLineView>,
    /// Lines past 5,000 were left out.
    pub truncated: bool,
    /// A line was cut.
    pub line_length_truncated: bool,
    pub notice: Option<String>,
}

impl From<cc_core::PrActionKind> for PrActionKind {
    fn from(v: cc_core::PrActionKind) -> Self {
        match v {
            cc_core::PrActionKind::Refresh => Self::Refresh,
            cc_core::PrActionKind::Create => Self::Create,
            cc_core::PrActionKind::Merge => Self::Merge,
        }
    }
}

impl From<PrActionKind> for cc_core::PrActionKind {
    fn from(v: PrActionKind) -> Self {
        match v {
            PrActionKind::Refresh => Self::Refresh,
            PrActionKind::Create => Self::Create,
            PrActionKind::Merge => Self::Merge,
        }
    }
}

impl From<cc_core::PrIdentityView> for PrIdentityView {
    fn from(v: cc_core::PrIdentityView) -> Self {
        Self {
            base_branch: v.base_branch,
            head_branch: v.head_branch,
            pr_number: v.pr_number,
        }
    }
}

impl From<PrIdentityView> for cc_core::PrIdentityView {
    fn from(v: PrIdentityView) -> Self {
        Self {
            base_branch: v.base_branch,
            head_branch: v.head_branch,
            pr_number: v.pr_number,
        }
    }
}

impl From<cc_core::DiffTargetView> for DiffTargetView {
    fn from(v: cc_core::DiffTargetView) -> Self {
        Self {
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            repo_id: v.repo_id,
            path: v.path,
            committed: v.committed,
            insertions: v.insertions,
            deletions: v.deletions,
        }
    }
}

impl From<DiffTargetView> for cc_core::DiffTargetView {
    fn from(v: DiffTargetView) -> Self {
        Self {
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            repo_id: v.repo_id,
            path: v.path,
            committed: v.committed,
            insertions: v.insertions,
            deletions: v.deletions,
        }
    }
}

impl From<cc_core::ActivityIntent> for ActivityIntent {
    fn from(v: cc_core::ActivityIntent) -> Self {
        match v {
            cc_core::ActivityIntent::SetConnected { connected } => Self::SetConnected { connected },
            cc_core::ActivityIntent::Watch { chat, token } => Self::Watch {
                chat: chat.into(),
                token,
            },
            cc_core::ActivityIntent::Release { token } => Self::Release { token },
            cc_core::ActivityIntent::Load { chat } => Self::Load { chat: chat.into() },
            cc_core::ActivityIntent::SetHookPaused {
                chat,
                hook_key,
                paused,
            } => Self::SetHookPaused {
                chat: chat.into(),
                hook_key,
                paused,
            },
            cc_core::ActivityIntent::RunPr {
                chat,
                action,
                repo_id,
                identity,
                confirm_unresolved_comments,
            } => Self::RunPr {
                chat: chat.into(),
                action: action.into(),
                repo_id,
                identity: identity.map(Into::into),
                confirm_unresolved_comments,
            },
            cc_core::ActivityIntent::WatchDiff { target, token } => Self::WatchDiff {
                target: target.into(),
                token,
            },
            cc_core::ActivityIntent::ReleaseDiff { token } => Self::ReleaseDiff { token },
            cc_core::ActivityIntent::RefreshDiff { target } => Self::RefreshDiff {
                target: target.into(),
            },
            cc_core::ActivityIntent::Close => Self::Close,
        }
    }
}

impl From<ActivityIntent> for cc_core::ActivityIntent {
    fn from(v: ActivityIntent) -> Self {
        match v {
            ActivityIntent::SetConnected { connected } => Self::SetConnected { connected },
            ActivityIntent::Watch { chat, token } => Self::Watch {
                chat: chat.into(),
                token,
            },
            ActivityIntent::Release { token } => Self::Release { token },
            ActivityIntent::Load { chat } => Self::Load { chat: chat.into() },
            ActivityIntent::SetHookPaused {
                chat,
                hook_key,
                paused,
            } => Self::SetHookPaused {
                chat: chat.into(),
                hook_key,
                paused,
            },
            ActivityIntent::RunPr {
                chat,
                action,
                repo_id,
                identity,
                confirm_unresolved_comments,
            } => Self::RunPr {
                chat: chat.into(),
                action: action.into(),
                repo_id,
                identity: identity.map(Into::into),
                confirm_unresolved_comments,
            },
            ActivityIntent::WatchDiff { target, token } => Self::WatchDiff {
                target: target.into(),
                token,
            },
            ActivityIntent::ReleaseDiff { token } => Self::ReleaseDiff { token },
            ActivityIntent::RefreshDiff { target } => Self::RefreshDiff {
                target: target.into(),
            },
            ActivityIntent::Close => Self::Close,
        }
    }
}

impl From<cc_core::ActivityFailure> for ActivityFailure {
    fn from(v: cc_core::ActivityFailure) -> Self {
        Self {
            message: v.message,
            link: v.link,
        }
    }
}

impl From<ActivityFailure> for cc_core::ActivityFailure {
    fn from(v: ActivityFailure) -> Self {
        Self {
            message: v.message,
            link: v.link,
        }
    }
}

impl From<cc_core::ActivitySettled> for ActivitySettled {
    fn from(v: cc_core::ActivitySettled) -> Self {
        Self {
            failure: v.failure.map(Into::into),
            result_json: v.result_json,
            discarded: v.discarded,
        }
    }
}

impl From<ActivitySettled> for cc_core::ActivitySettled {
    fn from(v: ActivitySettled) -> Self {
        Self {
            failure: v.failure.map(Into::into),
            result_json: v.result_json,
            discarded: v.discarded,
        }
    }
}

impl From<cc_core::ChangedFileView> for ChangedFileView {
    fn from(v: cc_core::ChangedFileView) -> Self {
        Self {
            path: v.path,
            status: v.status,
            committed: v.committed,
            repo_id: v.repo_id,
            repo_name: v.repo_name,
            insertions: v.insertions,
            deletions: v.deletions,
        }
    }
}

impl From<ChangedFileView> for cc_core::ChangedFileView {
    fn from(v: ChangedFileView) -> Self {
        Self {
            path: v.path,
            status: v.status,
            committed: v.committed,
            repo_id: v.repo_id,
            repo_name: v.repo_name,
            insertions: v.insertions,
            deletions: v.deletions,
        }
    }
}

impl From<cc_core::FileEntryView> for FileEntryView {
    fn from(v: cc_core::FileEntryView) -> Self {
        Self {
            index: v.index,
            name: v.name,
        }
    }
}

impl From<FileEntryView> for cc_core::FileEntryView {
    fn from(v: FileEntryView) -> Self {
        Self {
            index: v.index,
            name: v.name,
        }
    }
}

impl From<cc_core::FileGroupView> for FileGroupView {
    fn from(v: cc_core::FileGroupView) -> Self {
        Self {
            repo_id: v.repo_id,
            repo_name: v.repo_name,
            directory: v.directory,
            files: v.files.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<FileGroupView> for cc_core::FileGroupView {
    fn from(v: FileGroupView) -> Self {
        Self {
            repo_id: v.repo_id,
            repo_name: v.repo_name,
            directory: v.directory,
            files: v.files.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::FileSectionView> for FileSectionView {
    fn from(v: cc_core::FileSectionView) -> Self {
        Self {
            committed: v.committed,
            file_count: v.file_count,
            insertions: v.insertions,
            deletions: v.deletions,
            groups: v.groups.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<FileSectionView> for cc_core::FileSectionView {
    fn from(v: FileSectionView) -> Self {
        Self {
            committed: v.committed,
            file_count: v.file_count,
            insertions: v.insertions,
            deletions: v.deletions,
            groups: v.groups.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::FilesStatus> for FilesStatus {
    fn from(v: cc_core::FilesStatus) -> Self {
        match v {
            cc_core::FilesStatus::Loading => Self::Loading,
            cc_core::FilesStatus::Loaded => Self::Loaded,
            cc_core::FilesStatus::Failed { message } => Self::Failed { message },
        }
    }
}

impl From<FilesStatus> for cc_core::FilesStatus {
    fn from(v: FilesStatus) -> Self {
        match v {
            FilesStatus::Loading => Self::Loading,
            FilesStatus::Loaded => Self::Loaded,
            FilesStatus::Failed { message } => Self::Failed { message },
        }
    }
}

impl From<cc_core::SummaryView> for SummaryView {
    fn from(v: cc_core::SummaryView) -> Self {
        Self {
            title: v.title,
            description: v.description,
            generated_at: v.generated_at,
        }
    }
}

impl From<SummaryView> for cc_core::SummaryView {
    fn from(v: SummaryView) -> Self {
        Self {
            title: v.title,
            description: v.description,
            generated_at: v.generated_at,
        }
    }
}

impl From<cc_core::PlanView> for PlanView {
    fn from(v: cc_core::PlanView) -> Self {
        Self {
            title: v.title,
            status: v.status,
        }
    }
}

impl From<PlanView> for cc_core::PlanView {
    fn from(v: PlanView) -> Self {
        Self {
            title: v.title,
            status: v.status,
        }
    }
}

impl From<cc_core::TodoItemView> for TodoItemView {
    fn from(v: cc_core::TodoItemView) -> Self {
        Self {
            id: v.id,
            content: v.content,
            status: v.status,
        }
    }
}

impl From<TodoItemView> for cc_core::TodoItemView {
    fn from(v: TodoItemView) -> Self {
        Self {
            id: v.id,
            content: v.content,
            status: v.status,
        }
    }
}

impl From<cc_core::TodoListView> for TodoListView {
    fn from(v: cc_core::TodoListView) -> Self {
        Self {
            chat_id: v.chat_id,
            items: v.items.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<TodoListView> for cc_core::TodoListView {
    fn from(v: TodoListView) -> Self {
        Self {
            chat_id: v.chat_id,
            items: v.items.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::ScriptView> for ScriptView {
    fn from(v: cc_core::ScriptView) -> Self {
        Self {
            key: v.key,
            script_name: v.script_name,
            name: v.name,
            target: v.target,
        }
    }
}

impl From<ScriptView> for cc_core::ScriptView {
    fn from(v: ScriptView) -> Self {
        Self {
            key: v.key,
            script_name: v.script_name,
            name: v.name,
            target: v.target,
        }
    }
}

impl From<cc_core::ScriptRunView> for ScriptRunView {
    fn from(v: cc_core::ScriptRunView) -> Self {
        Self {
            script: v.script.into(),
            status: v.status,
            started_at: v.started_at,
        }
    }
}

impl From<ScriptRunView> for cc_core::ScriptRunView {
    fn from(v: ScriptRunView) -> Self {
        Self {
            script: v.script.into(),
            status: v.status,
            started_at: v.started_at,
        }
    }
}

impl From<cc_core::RunView> for RunView {
    fn from(v: cc_core::RunView) -> Self {
        Self {
            name: v.name,
            status: v.status,
        }
    }
}

impl From<RunView> for cc_core::RunView {
    fn from(v: RunView) -> Self {
        Self {
            name: v.name,
            status: v.status,
        }
    }
}

impl From<cc_core::HookView> for HookView {
    fn from(v: cc_core::HookView) -> Self {
        Self {
            name: v.name,
            hook_key: v.hook_key,
            trigger_name: v.trigger_name,
            paused: v.paused,
            run_disabled: v.run_disabled,
            run_disabled_reason: v.run_disabled_reason,
        }
    }
}

impl From<HookView> for cc_core::HookView {
    fn from(v: HookView) -> Self {
        Self {
            name: v.name,
            hook_key: v.hook_key,
            trigger_name: v.trigger_name,
            paused: v.paused,
            run_disabled: v.run_disabled,
            run_disabled_reason: v.run_disabled_reason,
        }
    }
}

impl From<cc_core::PrCheckState> for PrCheckState {
    fn from(v: cc_core::PrCheckState) -> Self {
        match v {
            cc_core::PrCheckState::Queued => Self::Queued,
            cc_core::PrCheckState::Running => Self::Running,
            cc_core::PrCheckState::Succeeded => Self::Succeeded,
            cc_core::PrCheckState::Failed => Self::Failed,
            cc_core::PrCheckState::Canceled => Self::Canceled,
            cc_core::PrCheckState::TimedOut => Self::TimedOut,
            cc_core::PrCheckState::Skipped => Self::Skipped,
            cc_core::PrCheckState::ActionRequired => Self::ActionRequired,
            cc_core::PrCheckState::Neutral => Self::Neutral,
            cc_core::PrCheckState::Pending => Self::Pending,
        }
    }
}

impl From<PrCheckState> for cc_core::PrCheckState {
    fn from(v: PrCheckState) -> Self {
        match v {
            PrCheckState::Queued => Self::Queued,
            PrCheckState::Running => Self::Running,
            PrCheckState::Succeeded => Self::Succeeded,
            PrCheckState::Failed => Self::Failed,
            PrCheckState::Canceled => Self::Canceled,
            PrCheckState::TimedOut => Self::TimedOut,
            PrCheckState::Skipped => Self::Skipped,
            PrCheckState::ActionRequired => Self::ActionRequired,
            PrCheckState::Neutral => Self::Neutral,
            PrCheckState::Pending => Self::Pending,
        }
    }
}

impl From<cc_core::PrCheckView> for PrCheckView {
    fn from(v: cc_core::PrCheckView) -> Self {
        Self {
            name: v.name,
            status: v.status,
            execution_state: v.execution_state,
            details_url: v.details_url,
            state: v.state.into(),
            label: v.label,
            semantics: v.semantics,
        }
    }
}

impl From<PrCheckView> for cc_core::PrCheckView {
    fn from(v: PrCheckView) -> Self {
        Self {
            name: v.name,
            status: v.status,
            execution_state: v.execution_state,
            details_url: v.details_url,
            state: v.state.into(),
            label: v.label,
            semantics: v.semantics,
        }
    }
}

impl From<cc_core::PrQueuePhase> for PrQueuePhase {
    fn from(v: cc_core::PrQueuePhase) -> Self {
        match v {
            cc_core::PrQueuePhase::Queued => Self::Queued,
            cc_core::PrQueuePhase::AwaitingChecks => Self::AwaitingChecks,
            cc_core::PrQueuePhase::Mergeable => Self::Mergeable,
            cc_core::PrQueuePhase::Locked => Self::Locked,
            cc_core::PrQueuePhase::Unmergeable => Self::Unmergeable,
            cc_core::PrQueuePhase::Unknown => Self::Unknown,
        }
    }
}

impl From<PrQueuePhase> for cc_core::PrQueuePhase {
    fn from(v: PrQueuePhase) -> Self {
        match v {
            PrQueuePhase::Queued => Self::Queued,
            PrQueuePhase::AwaitingChecks => Self::AwaitingChecks,
            PrQueuePhase::Mergeable => Self::Mergeable,
            PrQueuePhase::Locked => Self::Locked,
            PrQueuePhase::Unmergeable => Self::Unmergeable,
            PrQueuePhase::Unknown => Self::Unknown,
        }
    }
}

impl From<cc_core::PrQueueView> for PrQueueView {
    fn from(v: cc_core::PrQueueView) -> Self {
        Self {
            in_queue: v.in_queue,
            position: v.position,
            phase: v.phase.map(Into::into),
            phase_label: v.phase_label,
            badge: v.badge,
            semantics: v.semantics,
            detail: v.detail,
        }
    }
}

impl From<PrQueueView> for cc_core::PrQueueView {
    fn from(v: PrQueueView) -> Self {
        Self {
            in_queue: v.in_queue,
            position: v.position,
            phase: v.phase.map(Into::into),
            phase_label: v.phase_label,
            badge: v.badge,
            semantics: v.semantics,
            detail: v.detail,
        }
    }
}

impl From<cc_core::PrView> for PrView {
    fn from(v: cc_core::PrView) -> Self {
        Self {
            repo_id: v.repo_id,
            number: v.number,
            url: v.url,
            state: v.state,
            title: v.title,
            base_ref_name: v.base_ref_name,
            check_status: v.check_status,
            checks: v.checks.into_iter().map(Into::into).collect(),
            review_status: v.review_status,
            merge_ready: v.merge_ready,
            has_conflicts: v.has_conflicts,
            comment_count: v.comment_count,
            unresolved_review_thread_count: v.unresolved_review_thread_count,
            merge_queue: v.merge_queue.map(Into::into),
            checks_header: v.checks_header,
            checks_expanded: v.checks_expanded,
            action_queue: v.action_queue.map(Into::into),
        }
    }
}

impl From<PrView> for cc_core::PrView {
    fn from(v: PrView) -> Self {
        Self {
            repo_id: v.repo_id,
            number: v.number,
            url: v.url,
            state: v.state,
            title: v.title,
            base_ref_name: v.base_ref_name,
            check_status: v.check_status,
            checks: v.checks.into_iter().map(Into::into).collect(),
            review_status: v.review_status,
            merge_ready: v.merge_ready,
            has_conflicts: v.has_conflicts,
            comment_count: v.comment_count,
            unresolved_review_thread_count: v.unresolved_review_thread_count,
            merge_queue: v.merge_queue.map(Into::into),
            checks_header: v.checks_header,
            checks_expanded: v.checks_expanded,
            action_queue: v.action_queue.map(Into::into),
        }
    }
}

impl From<cc_core::PrRepoView> for PrRepoView {
    fn from(v: cc_core::PrRepoView) -> Self {
        Self {
            repo_id: v.repo_id,
            repo_name: v.repo_name,
            pr: v.pr.map(Into::into),
            base_branch: v.base_branch,
            head_branch: v.head_branch,
            published: v.published,
            can_create: v.can_create,
            can_merge: v.can_merge,
            merge_warning: v.merge_warning,
            create_blocked_reason: v.create_blocked_reason,
            merge_blocked_reason: v.merge_blocked_reason,
        }
    }
}

impl From<PrRepoView> for cc_core::PrRepoView {
    fn from(v: PrRepoView) -> Self {
        Self {
            repo_id: v.repo_id,
            repo_name: v.repo_name,
            pr: v.pr.map(Into::into),
            base_branch: v.base_branch,
            head_branch: v.head_branch,
            published: v.published,
            can_create: v.can_create,
            can_merge: v.can_merge,
            merge_warning: v.merge_warning,
            create_blocked_reason: v.create_blocked_reason,
            merge_blocked_reason: v.merge_blocked_reason,
        }
    }
}

impl From<cc_core::PrCreationPhase> for PrCreationPhase {
    fn from(v: cc_core::PrCreationPhase) -> Self {
        match v {
            cc_core::PrCreationPhase::GatheringChanges => Self::GatheringChanges,
            cc_core::PrCreationPhase::Summarizing => Self::Summarizing,
            cc_core::PrCreationPhase::Pushing => Self::Pushing,
            cc_core::PrCreationPhase::CreatingPr => Self::CreatingPr,
            cc_core::PrCreationPhase::Skipped => Self::Skipped,
            cc_core::PrCreationPhase::Done => Self::Done,
            cc_core::PrCreationPhase::Error => Self::Error,
        }
    }
}

impl From<PrCreationPhase> for cc_core::PrCreationPhase {
    fn from(v: PrCreationPhase) -> Self {
        match v {
            PrCreationPhase::GatheringChanges => Self::GatheringChanges,
            PrCreationPhase::Summarizing => Self::Summarizing,
            PrCreationPhase::Pushing => Self::Pushing,
            PrCreationPhase::CreatingPr => Self::CreatingPr,
            PrCreationPhase::Skipped => Self::Skipped,
            PrCreationPhase::Done => Self::Done,
            PrCreationPhase::Error => Self::Error,
        }
    }
}

impl From<cc_core::PrMergePhase> for PrMergePhase {
    fn from(v: cc_core::PrMergePhase) -> Self {
        match v {
            cc_core::PrMergePhase::Queued => Self::Queued,
            cc_core::PrMergePhase::CheckingMergeability => Self::CheckingMergeability,
            cc_core::PrMergePhase::WaitingMergeability => Self::WaitingMergeability,
            cc_core::PrMergePhase::Merging => Self::Merging,
            cc_core::PrMergePhase::RefreshingPrStatus => Self::RefreshingPrStatus,
            cc_core::PrMergePhase::Done => Self::Done,
            cc_core::PrMergePhase::Error => Self::Error,
        }
    }
}

impl From<PrMergePhase> for cc_core::PrMergePhase {
    fn from(v: PrMergePhase) -> Self {
        match v {
            PrMergePhase::Queued => Self::Queued,
            PrMergePhase::CheckingMergeability => Self::CheckingMergeability,
            PrMergePhase::WaitingMergeability => Self::WaitingMergeability,
            PrMergePhase::Merging => Self::Merging,
            PrMergePhase::RefreshingPrStatus => Self::RefreshingPrStatus,
            PrMergePhase::Done => Self::Done,
            PrMergePhase::Error => Self::Error,
        }
    }
}

impl From<cc_core::PrCreationStepView> for PrCreationStepView {
    fn from(v: cc_core::PrCreationStepView) -> Self {
        Self {
            phase: v.phase.into(),
            repo_name: v.repo_name,
            error: v.error,
        }
    }
}

impl From<PrCreationStepView> for cc_core::PrCreationStepView {
    fn from(v: PrCreationStepView) -> Self {
        Self {
            phase: v.phase.into(),
            repo_name: v.repo_name,
            error: v.error,
        }
    }
}

impl From<cc_core::PrMergeStepView> for PrMergeStepView {
    fn from(v: cc_core::PrMergeStepView) -> Self {
        Self {
            phase: v.phase.into(),
            repo_id: v.repo_id,
            repo_name: v.repo_name,
            queue_position: v.queue_position,
            queue_length: v.queue_length,
            retry_delay_ms: v.retry_delay_ms,
            error: v.error,
        }
    }
}

impl From<PrMergeStepView> for cc_core::PrMergeStepView {
    fn from(v: PrMergeStepView) -> Self {
        Self {
            phase: v.phase.into(),
            repo_id: v.repo_id,
            repo_name: v.repo_name,
            queue_position: v.queue_position,
            queue_length: v.queue_length,
            retry_delay_ms: v.retry_delay_ms,
            error: v.error,
        }
    }
}

impl From<cc_core::PrCreationView> for PrCreationView {
    fn from(v: cc_core::PrCreationView) -> Self {
        Self {
            current: v.current.into(),
            steps: v.steps.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<PrCreationView> for cc_core::PrCreationView {
    fn from(v: PrCreationView) -> Self {
        Self {
            current: v.current.into(),
            steps: v.steps.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::PrMergeView> for PrMergeView {
    fn from(v: cc_core::PrMergeView) -> Self {
        Self {
            current: v.current.into(),
            steps: v.steps.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<PrMergeView> for cc_core::PrMergeView {
    fn from(v: PrMergeView) -> Self {
        Self {
            current: v.current.into(),
            steps: v.steps.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::PrProgressView> for PrProgressView {
    fn from(v: cc_core::PrProgressView) -> Self {
        Self {
            creation: v.creation.map(Into::into),
            merge: v.merge.map(Into::into),
        }
    }
}

impl From<PrProgressView> for cc_core::PrProgressView {
    fn from(v: PrProgressView) -> Self {
        Self {
            creation: v.creation.map(Into::into),
            merge: v.merge.map(Into::into),
        }
    }
}

impl From<cc_core::ActivityView> for ActivityView {
    fn from(v: cc_core::ActivityView) -> Self {
        Self {
            revision: v.revision,
            loading: v.loading,
            files_error: v.files_error,
            errors: v.errors,
            changed_files: v.changed_files.into_iter().map(Into::into).collect(),
            file_sections: v.file_sections.into_iter().map(Into::into).collect(),
            files_status: v.files_status.into(),
            insertions: v.insertions,
            deletions: v.deletions,
            summary: v.summary.map(Into::into),
            plans: v.plans.into_iter().map(Into::into).collect(),
            todo_lists: v.todo_lists.into_iter().map(Into::into).collect(),
            todo_unavailable: v.todo_unavailable,
            scripts: v.scripts.into_iter().map(Into::into).collect(),
            script_runs: v.script_runs.into_iter().map(Into::into).collect(),
            hooks: v.hooks.into_iter().map(Into::into).collect(),
            hook_runs: v.hook_runs.into_iter().map(Into::into).collect(),
            hook_error: v.hook_error,
            prs: v.prs.map(|x| x.into_iter().map(Into::into).collect()),
            pr_busy: v.pr_busy,
            pr_progress: v.pr_progress.map(Into::into),
            pr_error: v.pr_error,
        }
    }
}

impl From<ActivityView> for cc_core::ActivityView {
    fn from(v: ActivityView) -> Self {
        Self {
            revision: v.revision,
            loading: v.loading,
            files_error: v.files_error,
            errors: v.errors,
            changed_files: v.changed_files.into_iter().map(Into::into).collect(),
            file_sections: v.file_sections.into_iter().map(Into::into).collect(),
            files_status: v.files_status.into(),
            insertions: v.insertions,
            deletions: v.deletions,
            summary: v.summary.map(Into::into),
            plans: v.plans.into_iter().map(Into::into).collect(),
            todo_lists: v.todo_lists.into_iter().map(Into::into).collect(),
            todo_unavailable: v.todo_unavailable,
            scripts: v.scripts.into_iter().map(Into::into).collect(),
            script_runs: v.script_runs.into_iter().map(Into::into).collect(),
            hooks: v.hooks.into_iter().map(Into::into).collect(),
            hook_runs: v.hook_runs.into_iter().map(Into::into).collect(),
            hook_error: v.hook_error,
            prs: v.prs.map(|x| x.into_iter().map(Into::into).collect()),
            pr_busy: v.pr_busy,
            pr_progress: v.pr_progress.map(Into::into),
            pr_error: v.pr_error,
        }
    }
}

impl From<cc_core::DiffLineKind> for DiffLineKind {
    fn from(v: cc_core::DiffLineKind) -> Self {
        match v {
            cc_core::DiffLineKind::Add => Self::Add,
            cc_core::DiffLineKind::Del => Self::Del,
            cc_core::DiffLineKind::Hunk => Self::Hunk,
            cc_core::DiffLineKind::Meta => Self::Meta,
            cc_core::DiffLineKind::Context => Self::Context,
        }
    }
}

impl From<DiffLineKind> for cc_core::DiffLineKind {
    fn from(v: DiffLineKind) -> Self {
        match v {
            DiffLineKind::Add => Self::Add,
            DiffLineKind::Del => Self::Del,
            DiffLineKind::Hunk => Self::Hunk,
            DiffLineKind::Meta => Self::Meta,
            DiffLineKind::Context => Self::Context,
        }
    }
}

impl From<cc_core::DiffLineView> for DiffLineView {
    fn from(v: cc_core::DiffLineView) -> Self {
        Self {
            kind: v.kind.into(),
            text: v.text,
        }
    }
}

impl From<DiffLineView> for cc_core::DiffLineView {
    fn from(v: DiffLineView) -> Self {
        Self {
            kind: v.kind.into(),
            text: v.text,
        }
    }
}

impl From<cc_core::DiffPhase> for DiffPhase {
    fn from(v: cc_core::DiffPhase) -> Self {
        match v {
            cc_core::DiffPhase::Loading => Self::Loading,
            cc_core::DiffPhase::Failed { message } => Self::Failed { message },
            cc_core::DiffPhase::Shown => Self::Shown,
        }
    }
}

impl From<DiffPhase> for cc_core::DiffPhase {
    fn from(v: DiffPhase) -> Self {
        match v {
            DiffPhase::Loading => Self::Loading,
            DiffPhase::Failed { message } => Self::Failed { message },
            DiffPhase::Shown => Self::Shown,
        }
    }
}

impl From<cc_core::FileDiffView> for FileDiffView {
    fn from(v: cc_core::FileDiffView) -> Self {
        Self {
            phase: v.phase.into(),
            lines: v.lines.into_iter().map(Into::into).collect(),
            truncated: v.truncated,
            line_length_truncated: v.line_length_truncated,
            notice: v.notice,
        }
    }
}

impl From<FileDiffView> for cc_core::FileDiffView {
    fn from(v: FileDiffView) -> Self {
        Self {
            phase: v.phase.into(),
            lines: v.lines.into_iter().map(Into::into).collect(),
            truncated: v.truncated,
            line_length_truncated: v.line_length_truncated,
            notice: v.notice,
        }
    }
}

/// One computer's activity. Built by `ChatsService.activity`; the chat
/// todos follow that read path's selection.
#[frb(opaque)]
#[derive(Clone)]
pub struct ActivityService {
    inner: cc_core::ActivityService,
}

impl ActivityService {
    pub(crate) fn new(inner: cc_core::ActivityService) -> Self {
        Self { inner }
    }
    /// `chat`'s worktree view now, then on every change, until the watch
    /// `token` is released.
    pub fn watch(&self, chat: ChatRefView, token: u64, sink: StreamSink<ActivityView>) {
        let mut views = self.inner.watch(chat.into(), token);
        handler::runtime().spawn(async move {
            while let Some(view) = views.next().await {
                if sink.add(view.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// `file`'s diff view now, then on every change, until the diff watch
    /// `token` is released.
    pub fn watch_diff(&self, file: DiffTargetView, token: u64, sink: StreamSink<FileDiffView>) {
        let mut views = self.inner.watch_diff(file.into(), token);
        handler::runtime().spawn(async move {
            while let Some(view) = views.next().await {
                if sink.add(view.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// Queues `intent`; its outcome is not reported.
    #[frb(sync)]
    pub fn send(&self, intent: ActivityIntent) {
        self.inner.send(intent.into());
    }
    /// Queues `intent` and returns the ticket `settled` takes.
    #[frb(sync)]
    pub fn request(&self, intent: ActivityIntent) -> u64 {
        self.inner.request(intent.into())
    }
    /// The outcome of a requested intent. Fails when the core shut down,
    /// and `account_changed` once the account the service was opened in
    /// was left, also while the intent ran.
    pub async fn settled(&self, ticket: u64) -> Result<ActivitySettled, CoreFailure> {
        self.inner
            .settled(ticket)
            .await
            .map(Into::into)
            .map_err(Into::into)
    }
}

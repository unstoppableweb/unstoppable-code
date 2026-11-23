//! One computer's worktree activity and changed-file diffs (architecture
//! §3.5, P6): changed files grouped for the Files tab, the summary,
//! tracked plans, scripts and hook runs, configured hooks and their pause
//! writes, chat todos, pull requests with their progress feeds and
//! guarded actions, and each changed file's diff.
//!
//! [`ActivityService::watch`] streams one chat's worktree view;
//! [`ActivityService::watch_diff`] one file's diff view. Intents are
//! queued in call order ([`ActivityService::send`]);
//! [`ActivityService::request`] also returns a ticket whose outcome
//! [`ActivityService::settled`] waits for. Each [`ActivityIntent`] variant
//! says when it settles.
use super::{ChatRefView, CoreFailure, CoreInner};
use crate::account::View;
use crate::activity::{
    self, DiffKey, DiffState, Handle, HookState, Outcome, PrAction, PrIdentity, PrState, Published,
    Snapshot, worktree_key,
};
use crate::copy::activity::{self as copy, CopyKey};
use crate::owners::End;
use cc_domain::{
    activity::{
        Check, CheckState, CreationPhase, MergePhase, MergeQueue, MergeQueuePhase,
        MergeQueuePhaseKey, PrRepo, PrStatus, Todos, check_state, checks_expanded_by_default,
        checks_passed, merge_queue_for_action_pr,
    },
    chat::ChatRef,
    files::{self, ChangedFile, DiffLineKind as Kind},
};
use cc_protocol::dto;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;

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

/// One computer's activity. Built by [`super::ChatsService::activity`];
/// the chat todos follow that read path's selection.
#[derive(Clone)]
pub struct ActivityService {
    inner: Arc<CoreInner>,
    handle: Handle,
    tickets: Arc<Mutex<Tickets>>,
}

type Tickets = (u64, HashMap<u64, oneshot::Receiver<Outcome>>);

fn chat_ref(v: ChatRefView) -> ChatRef {
    ChatRef {
        project_id: v.project_id,
        worktree_id: v.worktree_id,
        id: v.id,
        title: v.title,
    }
}

fn target(v: DiffTargetView) -> activity::DiffTarget {
    activity::DiffTarget {
        key: DiffKey {
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            repo_id: v.repo_id,
            path: v.path,
            committed: v.committed,
        },
        insertions: v.insertions,
        deletions: v.deletions,
    }
}

fn intent(i: ActivityIntent) -> activity::Intent {
    use activity::Intent as I;
    match i {
        ActivityIntent::SetConnected { connected } => I::SetConnected(connected),
        ActivityIntent::Watch { chat, token } => I::Watch {
            chat: chat_ref(chat),
            token,
        },
        ActivityIntent::Release { token } => I::Release { token },
        ActivityIntent::Load { chat } => I::Load(chat_ref(chat)),
        ActivityIntent::SetHookPaused {
            chat,
            hook_key,
            paused,
        } => I::SetHookPaused {
            chat: chat_ref(chat),
            hook_key,
            paused,
        },
        ActivityIntent::RunPr {
            chat,
            action,
            repo_id,
            identity,
            confirm_unresolved_comments,
        } => I::RunPr {
            chat: chat_ref(chat),
            action: match action {
                PrActionKind::Refresh => PrAction::Refresh,
                PrActionKind::Create => PrAction::Create,
                PrActionKind::Merge => PrAction::Merge,
            },
            repo_id,
            identity: identity.map(|i| PrIdentity {
                base_branch: i.base_branch,
                head_branch: i.head_branch,
                pr_number: i.pr_number,
            }),
            confirm: confirm_unresolved_comments,
        },
        ActivityIntent::WatchDiff { target: t, token } => I::WatchDiff {
            target: target(t),
            token,
        },
        ActivityIntent::ReleaseDiff { token } => I::ReleaseDiff { token },
        ActivityIntent::RefreshDiff { target: t } => I::RefreshDiff(target(t)),
        ActivityIntent::Close => I::Close,
    }
}

impl ActivityService {
    pub(crate) fn new(inner: Arc<CoreInner>, handle: Handle) -> Self {
        Self {
            inner,
            handle,
            tickets: Arc::default(),
        }
    }
    /// `chat`'s worktree view now, then on every change, until the
    /// [`ActivityIntent::Watch`] `token` is released.
    pub fn watch(&self, chat: ChatRefView, token: u64) -> ActivityViews {
        ActivityViews {
            view: self.handle.view(),
            end: self.handle.watch_end(token),
            chat: chat_ref(chat),
            last: None,
        }
    }
    /// `file`'s diff view now, then on every change, until the
    /// [`ActivityIntent::WatchDiff`] `token` is released.
    pub fn watch_diff(&self, file: DiffTargetView, token: u64) -> DiffViews {
        DiffViews {
            view: self.handle.view(),
            end: self.handle.diff_end(token),
            target: file,
            last: None,
        }
    }
    /// Queues `intent`; its outcome is not reported.
    pub fn send(&self, intent: ActivityIntent) {
        let _ = self.handle.send(self::intent(intent), None);
    }
    /// Queues `intent` and returns the ticket [`Self::settled`] takes.
    pub fn request(&self, intent: ActivityIntent) -> u64 {
        let (tx, rx) = oneshot::channel();
        let mut tickets = self.tickets.lock().unwrap_or_else(|p| p.into_inner());
        tickets.0 += 1;
        let ticket = tickets.0;
        if self.handle.send(self::intent(intent), Some(tx)).is_ok() {
            tickets.1.insert(ticket, rx);
        }
        ticket
    }
    /// The outcome of a [`Self::request`]ed intent. Fails when the core
    /// shut down (or the ticket is unknown), and `account_changed` once
    /// the account the service was opened in was left, also while the
    /// intent ran.
    pub async fn settled(&self, ticket: u64) -> Result<ActivitySettled, CoreFailure> {
        let rx = self
            .tickets
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .1
            .remove(&ticket);
        let outcome = self.inner.ticket(self.handle.scope(), rx).await?;
        Ok(match outcome {
            Outcome::Done => ActivitySettled {
                failure: None,
                result_json: None,
                discarded: false,
            },
            Outcome::Failed(f) => ActivitySettled {
                failure: Some(ActivityFailure {
                    message: f.message,
                    link: f.link,
                }),
                result_json: None,
                discarded: false,
            },
            Outcome::Result(result) => ActivitySettled {
                failure: None,
                result_json: Some(dto::bridge_value(&result).to_string()),
                discarded: false,
            },
            Outcome::Discarded => ActivitySettled {
                failure: None,
                result_json: None,
                discarded: true,
            },
        })
    }
}

/// An [`ActivityService::watch`] stream.
pub struct ActivityViews {
    view: View<Published>,
    end: End,
    chat: ChatRef,
    last: Option<ActivityView>,
}

impl ActivityViews {
    /// The next changed view; `None` once the watch was released or the
    /// activity stopped.
    pub async fn next(&mut self) -> Option<ActivityView> {
        loop {
            if self.last.is_some() {
                self.end.or_changed(&mut self.view).await?;
            } else if self.end.reached() {
                return None;
            }
            let published = self.view.latest()?;
            let view = activity_view(&published, &self.chat);
            let same = self.last.as_ref().is_some_and(|last| {
                ActivityView {
                    revision: view.revision,
                    ..last.clone()
                } == view
            });
            if !same {
                self.last = Some(view.clone());
                return Some(view);
            }
        }
    }
}

/// An [`ActivityService::watch_diff`] stream.
pub struct DiffViews {
    view: View<Published>,
    end: End,
    target: DiffTargetView,
    last: Option<FileDiffView>,
}

impl DiffViews {
    /// The next changed view; `None` once the watch was released or the
    /// activity stopped.
    pub async fn next(&mut self) -> Option<FileDiffView> {
        loop {
            if self.last.is_some() {
                self.end.or_changed(&mut self.view).await?;
            } else if self.end.reached() {
                return None;
            }
            let published = self.view.latest()?;
            let key = DiffKey {
                project_id: self.target.project_id.clone(),
                worktree_id: self.target.worktree_id.clone(),
                repo_id: self.target.repo_id.clone(),
                path: self.target.path.clone(),
                committed: self.target.committed,
            };
            let state = published
                .diffs
                .get(&key)
                .map(|s| (**s).clone())
                .unwrap_or_default();
            let view = diff_view(&state, &self.target);
            if self.last.as_ref() != Some(&view) {
                self.last = Some(view.clone());
                return Some(view);
            }
        }
    }
}

// ---- Views ----

fn changed_view(f: &ChangedFile) -> ChangedFileView {
    ChangedFileView {
        path: f.path.clone(),
        status: f.status.clone(),
        committed: f.committed,
        repo_id: f.repo_id.clone(),
        repo_name: f.repo_name.clone(),
        insertions: f.insertions,
        deletions: f.deletions,
    }
}

/// The Files tab's sections: uncommitted then committed, each grouped by
/// repository and directory.
fn sections(changed: &[ChangedFile]) -> Vec<FileSectionView> {
    let mut out = Vec::new();
    for committed in [false, true] {
        let indexed: Vec<(usize, &ChangedFile)> = changed
            .iter()
            .enumerate()
            .filter(|(_, f)| f.committed == committed)
            .collect();
        if indexed.is_empty() {
            continue;
        }
        let only: Vec<&ChangedFile> = indexed.iter().map(|(_, f)| *f).collect();
        let summary = files::summarize(&only);
        out.push(FileSectionView {
            committed,
            file_count: u32::try_from(summary.file_count).unwrap_or(u32::MAX),
            insertions: summary.insertions,
            deletions: summary.deletions,
            groups: files::group_by_directory(&only)
                .into_iter()
                .map(|g| FileGroupView {
                    repo_id: g.repo_id,
                    repo_name: g.repo_name,
                    directory: g.directory,
                    files: g
                        .files
                        .into_iter()
                        .map(|(i, name)| FileEntryView {
                            index: u32::try_from(indexed[i].0).unwrap_or(u32::MAX),
                            name,
                        })
                        .collect(),
                })
                .collect(),
        });
    }
    out
}

fn check_view(check: &Check) -> PrCheckView {
    let state = check_state(check);
    let label = copy::check_state(state);
    let semantics = copy::render(
        copy::text(CopyKey::CheckSemantics),
        &[("name", &check.name), ("state", label)],
    );
    PrCheckView {
        name: check.name.clone(),
        status: check.status.clone(),
        execution_state: check.execution_state.clone(),
        details_url: check.details_url.clone(),
        state: match state {
            CheckState::Queued => PrCheckState::Queued,
            CheckState::Running => PrCheckState::Running,
            CheckState::Succeeded => PrCheckState::Succeeded,
            CheckState::Failed => PrCheckState::Failed,
            CheckState::Canceled => PrCheckState::Canceled,
            CheckState::TimedOut => PrCheckState::TimedOut,
            CheckState::Skipped => PrCheckState::Skipped,
            CheckState::ActionRequired => PrCheckState::ActionRequired,
            CheckState::Neutral => PrCheckState::Neutral,
            CheckState::Pending => PrCheckState::Pending,
        },
        label: label.into(),
        semantics: if check.details_url.is_some() {
            copy::render(
                copy::text(CopyKey::CheckOpensInBrowser),
                &[("label", &semantics)],
            )
        } else {
            semantics
        },
    }
}

fn queue_view(queue: &MergeQueue) -> PrQueueView {
    let phase_label = MergeQueuePhaseKey::of(queue.phase).map(copy::queue_phase);
    let position = queue.position.map(|p| p.to_string());
    let badge = match &position {
        Some(p) => copy::render(copy::text(CopyKey::QueueBadgePosition), &[("position", p)]),
        None => copy::text(CopyKey::QueueBadge).into(),
    };
    let located = match &position {
        Some(p) => copy::render(
            copy::text(CopyKey::QueueSemanticsPosition),
            &[("position", p)],
        ),
        None => copy::text(CopyKey::QueueSemantics).into(),
    };
    let semantics = match phase_label {
        Some(phase) => copy::render(
            copy::text(CopyKey::QueueSemanticsPhase),
            &[("position", &located), ("phase", phase)],
        ),
        None => located,
    };
    let mut parts = Vec::new();
    if let Some(p) = &position {
        parts.push(copy::render(
            copy::text(CopyKey::QueueDetailPosition),
            &[("position", p)],
        ));
    }
    if let Some(phase) = phase_label {
        parts.push(phase.to_owned());
    }
    PrQueueView {
        in_queue: queue.in_queue,
        position: queue.position,
        phase: queue.phase.map(|p| match p {
            MergeQueuePhase::Queued => PrQueuePhase::Queued,
            MergeQueuePhase::AwaitingChecks => PrQueuePhase::AwaitingChecks,
            MergeQueuePhase::Mergeable => PrQueuePhase::Mergeable,
            MergeQueuePhase::Locked => PrQueuePhase::Locked,
            MergeQueuePhase::Unmergeable => PrQueuePhase::Unmergeable,
            MergeQueuePhase::Unknown => PrQueuePhase::Unknown,
        }),
        phase_label: phase_label.map(str::to_owned),
        badge,
        semantics,
        detail: (!parts.is_empty()).then(|| parts.join(" · ")),
    }
}

fn pr_view(pr: &PrStatus, row: &[&PrStatus]) -> PrView {
    let passed = checks_passed(&pr.checks).to_string();
    let total = pr.checks.len().to_string();
    PrView {
        repo_id: pr.repo_id.clone(),
        number: pr.number,
        url: pr.url.clone(),
        state: pr.state.clone(),
        title: pr.title.clone(),
        base_ref_name: pr.base_ref_name.clone(),
        check_status: pr.check_status.clone(),
        checks: pr.checks.iter().map(check_view).collect(),
        review_status: pr.review_status.clone(),
        merge_ready: pr.merge_ready,
        has_conflicts: pr.has_conflicts,
        comment_count: pr.comment_count,
        unresolved_review_thread_count: pr.unresolved_review_thread_count,
        merge_queue: pr.merge_queue.as_ref().map(queue_view),
        checks_header: copy::render(
            copy::text(CopyKey::ChecksHeader),
            &[("passed", &passed), ("total", &total)],
        ),
        checks_expanded: checks_expanded_by_default(pr.check_status.as_deref()),
        action_queue: merge_queue_for_action_pr(pr, row.iter().copied())
            .as_ref()
            .map(queue_view),
    }
}

fn repo_view(repo: &PrRepo, row: &[&PrStatus]) -> PrRepoView {
    PrRepoView {
        repo_id: repo.repo_id.clone(),
        repo_name: repo.repo_name.clone(),
        pr: repo.pr.as_ref().map(|pr| pr_view(pr, row)),
        base_branch: repo.base_branch.clone(),
        head_branch: repo.head_branch.clone(),
        published: repo.published,
        can_create: repo.can_create,
        can_merge: repo.can_merge,
        merge_warning: repo.merge_warning,
        create_blocked_reason: repo.create_blocked_reason.clone(),
        merge_blocked_reason: repo.merge_blocked_reason.clone(),
    }
}

fn creation_phase(p: CreationPhase) -> PrCreationPhase {
    match p {
        CreationPhase::GatheringChanges => PrCreationPhase::GatheringChanges,
        CreationPhase::Summarizing => PrCreationPhase::Summarizing,
        CreationPhase::Pushing => PrCreationPhase::Pushing,
        CreationPhase::CreatingPr => PrCreationPhase::CreatingPr,
        CreationPhase::Skipped => PrCreationPhase::Skipped,
        CreationPhase::Done => PrCreationPhase::Done,
        CreationPhase::Error => PrCreationPhase::Error,
    }
}

fn merge_phase(p: MergePhase) -> PrMergePhase {
    match p {
        MergePhase::Queued => PrMergePhase::Queued,
        MergePhase::CheckingMergeability => PrMergePhase::CheckingMergeability,
        MergePhase::WaitingMergeability => PrMergePhase::WaitingMergeability,
        MergePhase::Merging => PrMergePhase::Merging,
        MergePhase::RefreshingPrStatus => PrMergePhase::RefreshingPrStatus,
        MergePhase::Done => PrMergePhase::Done,
        MergePhase::Error => PrMergePhase::Error,
    }
}

fn pr_part(state: &PrState) -> (Option<Vec<PrRepoView>>, Option<PrProgressView>) {
    let row: Vec<&PrStatus> = state
        .repos
        .iter()
        .flatten()
        .filter_map(|r| r.pr.as_ref())
        .collect();
    let repos = state
        .repos
        .as_ref()
        .map(|repos| repos.iter().map(|r| repo_view(r, &row)).collect());
    let progress = state.progress.as_ref().map(|p| PrProgressView {
        creation: p.creation.as_ref().map(|c| PrCreationView {
            current: creation_phase(c.current),
            steps: c
                .steps
                .iter()
                .map(|s| PrCreationStepView {
                    phase: creation_phase(s.phase),
                    repo_name: s.repo_name.clone(),
                    error: s.error.clone(),
                })
                .collect(),
        }),
        merge: p.merge.as_ref().map(|m| PrMergeView {
            current: merge_phase(m.current),
            steps: m
                .steps
                .iter()
                .map(|s| PrMergeStepView {
                    phase: merge_phase(s.phase),
                    repo_id: s.repo_id.clone(),
                    repo_name: s.repo_name.clone(),
                    queue_position: s.queue_position,
                    queue_length: s.queue_length,
                    retry_delay_ms: s.retry_delay_ms,
                    error: s.error.clone(),
                })
                .collect(),
        }),
    });
    (repos, progress)
}

/// `chat`'s worktree as the drawer shows it (`snapshot(ref)`,
/// `prs.state(ref)`, `hooks.state(ref).error`, `todoUnavailableReason`).
fn activity_view(p: &Published, chat: &ChatRef) -> ActivityView {
    let key = worktree_key(&chat.project_id, &chat.worktree_id);
    let snapshot = p.snapshots.get(&key).map_or_else(
        || Snapshot {
            loading: true,
            ..Snapshot::default()
        },
        |s| (**s).clone(),
    );
    let hooks = p.hooks.get(&key).map(|h| (**h).clone()).unwrap_or_default();
    let HookState {
        hooks: configured,
        error: hook_error,
    } = hooks;
    let activity = snapshot.activity;
    let shown_hooks = configured.unwrap_or(activity.hooks);
    let pr = p.prs.get(&key).map(|s| (**s).clone()).unwrap_or_default();
    let (prs, pr_progress) = pr_part(&pr);
    let todo_unavailable =
        Todos::unavailable_for(p.todos.get(&key).map(|t| &**t), &chat.id).map(|outdated| {
            copy::text(if outdated {
                CopyKey::TodosOutdated
            } else {
                CopyKey::TodosLoading
            })
            .to_owned()
        });
    let files_status = match (&snapshot.files_error, snapshot.loading) {
        (Some(message), _) => FilesStatus::Failed {
            message: message.clone(),
        },
        (None, true) => FilesStatus::Loading,
        (None, false) => FilesStatus::Loaded,
    };
    let script_view = |s: &cc_domain::activity::ScriptDescriptor| ScriptView {
        key: s.key.clone(),
        script_name: s.script_name.clone(),
        name: s.name.clone(),
        target: s.target.clone(),
    };
    ActivityView {
        revision: p.revision,
        loading: snapshot.loading,
        files_error: snapshot.files_error,
        errors: snapshot.errors,
        file_sections: sections(&activity.changed_files),
        insertions: activity
            .changed_files
            .iter()
            .map(|f| f.insertions.unwrap_or(0))
            .sum(),
        deletions: activity
            .changed_files
            .iter()
            .map(|f| f.deletions.unwrap_or(0))
            .sum(),
        changed_files: activity.changed_files.iter().map(changed_view).collect(),
        files_status,
        summary: activity.summary.map(|s| SummaryView {
            title: s.title,
            description: s.description,
            generated_at: s.generated_at,
        }),
        plans: activity
            .plans
            .into_iter()
            .map(|p| PlanView {
                title: p.title,
                status: p.status,
            })
            .collect(),
        todo_lists: activity
            .todo_lists
            .into_iter()
            .map(|l| TodoListView {
                chat_id: l.chat_id,
                items: l
                    .items
                    .into_iter()
                    .map(|i| TodoItemView {
                        id: i.id,
                        content: i.content,
                        status: i.status,
                    })
                    .collect(),
            })
            .collect(),
        todo_unavailable,
        scripts: activity.scripts.iter().map(script_view).collect(),
        script_runs: activity
            .script_runs
            .iter()
            .map(|r| ScriptRunView {
                script: script_view(&r.script),
                status: r.status.clone(),
                started_at: r.started_at.clone(),
            })
            .collect(),
        hooks: shown_hooks
            .into_iter()
            .map(|h| HookView {
                name: h.name,
                hook_key: h.hook_key,
                trigger_name: h.trigger_name,
                paused: h.paused,
                run_disabled: h.run_disabled,
                run_disabled_reason: h.run_disabled_reason,
            })
            .collect(),
        hook_runs: activity
            .hook_runs
            .into_iter()
            .map(|r| RunView {
                name: r.name,
                status: r.status,
            })
            .collect(),
        hook_error,
        prs,
        pr_busy: pr.busy,
        pr_progress,
        pr_error: pr.error,
    }
}

/// The diff screen (`file_diff_screen.dart` `build`).
fn diff_view(state: &DiffState, target: &DiffTargetView) -> FileDiffView {
    let empty = |phase| FileDiffView {
        phase,
        lines: Vec::new(),
        truncated: false,
        line_length_truncated: false,
        notice: None,
    };
    let patch = state.patch.as_deref();
    if patch.is_none() && state.refreshing {
        return empty(DiffPhase::Loading);
    }
    if let (None, Some(error)) = (patch, &state.error) {
        return empty(DiffPhase::Failed {
            message: error.clone(),
        });
    }
    let shown = files::display_lines(patch.map_or("", String::as_str));
    let mut notices: Vec<String> = Vec::new();
    if state.stale && patch.is_some() {
        notices.push(copy::text(CopyKey::DiffStale).into());
    }
    if let Some(error) = &state.error {
        notices.push(error.clone());
    }
    if state.truncated {
        notices.push(copy::text(CopyKey::DiffPartial).into());
    }
    // The list counted lines, but the file now matches.
    if !state.stale
        && patch.is_some_and(|p| p.is_empty())
        && target.insertions.unwrap_or(0) + target.deletions.unwrap_or(0) > 0
    {
        notices.push(
            copy::text(if target.committed {
                CopyKey::DiffLeftBranch
            } else {
                CopyKey::DiffCommitted
            })
            .into(),
        );
    }
    FileDiffView {
        phase: DiffPhase::Shown,
        lines: shown
            .lines
            .into_iter()
            .map(|l| DiffLineView {
                kind: match l.kind {
                    Kind::Add => DiffLineKind::Add,
                    Kind::Del => DiffLineKind::Del,
                    Kind::Hunk => DiffLineKind::Hunk,
                    Kind::Meta => DiffLineKind::Meta,
                    Kind::Context => DiffLineKind::Context,
                },
                text: l.text,
            })
            .collect(),
        truncated: shown.truncated,
        line_length_truncated: shown.line_length_truncated,
        notice: (!notices.is_empty()).then(|| notices.join(" ")),
    }
}

//! Activity and files copy (P6), from `device_link/activity/{repository,
//! hook_repository,pr_repository,workspace}.dart`,
//! `device_link/files/repository.dart`, `data/models/text_diff.dart`, the
//! diff screen's notices (`computer_connect/file_diff_screen.dart`) and
//! the PR display rules of `ui/core/activity/{pr_check_display,
//! pr_merge_queue_display}.dart`. The drawer's and screens' static labels
//! (tab names, empty states, buttons) stay in Dart with those widgets.
pub(crate) use super::render;
use cc_domain::activity::{CheckState, Fallbacks, MergeQueuePhaseKey};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyKey {
    /// The selected chat's todos are not known yet.
    TodosLoading,
    /// The desktop is too old to send todos.
    TodosOutdated,
    /// The changed files could not be read.
    FilesFailed,
    /// A load threw while reading its replies.
    ActivityFailed,
    /// A desktop without the read's channel; `{label}` names the read.
    ReadOutdated,
    /// A read failed; `{label}` names the read.
    ReadFailed,
    /// The configured scripts could not be read.
    ScriptsFailed,
    /// A plan without a title.
    UntitledPlan,
    /// A hook run without a trigger name.
    HookFallback,
    /// A multi-repo hook outside a repository.
    WorkspaceRoot,
    /// A pull request row without a repository name.
    RepositoryFallback,
    /// An action while the computer is not connected.
    ConnectFirst,
    /// The connection changed during a hook read.
    ConnectionChanged,
    /// A hook write for a hook the last read did not list.
    RefreshHooks,
    /// The configured hooks could not be read.
    HooksFailed,
    /// A hook write failed.
    HookChangeFailed,
    /// The worktree is gone from the computer's projects.
    WorktreeGone,
    /// A reply did not have the shape the reader requires.
    InvalidMessage,
    /// Pull requests could not be read.
    PrsFailed,
    /// A PR action without one repository and its identity.
    SelectRepository,
    /// Another PR action is running for the worktree.
    PrActionRunning,
    /// A `get_actions` reply without its fields.
    InvalidPrState,
    /// A diff while the computer is not connected.
    DiffReconnect,
    /// The patch line of a binary file.
    BinaryDiffers,
    /// The diff's edit region is over the comparison bound.
    DiffTooLarge,
    /// A diff read failed for a reason the transport does not word.
    DiffFailed,
    /// A stale diff is shown while it refreshes.
    DiffStale,
    /// The desktop cut the diff.
    DiffPartial,
    /// A committed file's changes left the branch.
    DiffLeftBranch,
    /// An uncommitted file's changes were committed or discarded.
    DiffCommitted,
    /// `Checks ({passed}/{total} passed)`.
    ChecksHeader,
    /// `{name}, {state}` for a check row.
    CheckSemantics,
    /// `{label}, opens in browser`.
    CheckOpensInBrowser,
    /// `Queued` without a position.
    QueueBadge,
    /// `Queued #{position}`.
    QueueBadgePosition,
    /// `In merge queue`.
    QueueSemantics,
    /// `In merge queue, position {position}`.
    QueueSemanticsPosition,
    /// `{position}. {phase}`.
    QueueSemanticsPhase,
    /// `Position #{position}`.
    QueueDetailPosition,
}

pub(crate) fn text(key: CopyKey) -> &'static str {
    match key {
        CopyKey::TodosLoading => "Todos are loading…",
        CopyKey::TodosOutdated => "Update your computer to load todos.",
        CopyKey::FilesFailed => "Could not load changed files. Refresh to retry.",
        CopyKey::ActivityFailed => "Could not read activity from this computer. Refresh to retry.",
        CopyKey::ReadOutdated => "Update your computer to load {label}.",
        CopyKey::ReadFailed => "Could not load {label}. Refresh to retry.",
        CopyKey::ScriptsFailed => "Could not load configured scripts. Refresh to retry.",
        CopyKey::UntitledPlan => "Untitled plan",
        CopyKey::HookFallback => "Hook",
        CopyKey::WorkspaceRoot => "Workspace root",
        CopyKey::RepositoryFallback => "Repository",
        CopyKey::ConnectFirst => "Connect to a computer first.",
        CopyKey::ConnectionChanged => "The computer connection changed. Refresh to retry.",
        CopyKey::RefreshHooks => "Refresh hooks before changing this hook.",
        CopyKey::HooksFailed => "Could not load configured hooks. Refresh to retry.",
        CopyKey::HookChangeFailed => "Could not change this hook. Refresh to check its state.",
        CopyKey::WorktreeGone => "This worktree is no longer available.",
        CopyKey::InvalidMessage => "The peer sent an invalid message.",
        CopyKey::PrsFailed => "Could not load pull requests. Refresh to retry.",
        CopyKey::SelectRepository => "Refresh and select one repository before continuing.",
        CopyKey::PrActionRunning => "A PR action is already running.",
        CopyKey::InvalidPrState => "The computer sent invalid pull request state.",
        CopyKey::DiffReconnect => "Reconnect to your computer to update this diff.",
        CopyKey::BinaryDiffers => "Binary files differ",
        CopyKey::DiffTooLarge => {
            "This diff is too large to compare on this device. Open it on your computer."
        }
        CopyKey::DiffFailed => "Could not load the diff.",
        CopyKey::DiffStale => "Showing the previously loaded diff.",
        CopyKey::DiffPartial => {
            "The computer returned a partial diff. Open it on your computer to see all changes."
        }
        CopyKey::DiffLeftBranch => "These changes are no longer on this branch.",
        CopyKey::DiffCommitted => "These changes were committed or discarded on your computer.",
        CopyKey::ChecksHeader => "Checks ({passed}/{total} passed)",
        CopyKey::CheckSemantics => "{name}, {state}",
        CopyKey::CheckOpensInBrowser => "{label}, opens in browser",
        CopyKey::QueueBadge => "Queued",
        CopyKey::QueueBadgePosition => "Queued #{position}",
        CopyKey::QueueSemantics => "In merge queue",
        CopyKey::QueueSemanticsPosition => "In merge queue, position {position}",
        CopyKey::QueueSemanticsPhase => "{position}. {phase}",
        CopyKey::QueueDetailPosition => "Position #{position}",
    }
}

/// The names `ReadOutdated` and `ReadFailed` put in `{label}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadLabel {
    ChangedFiles,
    Summary,
    Plans,
    ScriptRuns,
    HookRuns,
}

fn read_label(label: ReadLabel) -> &'static str {
    match label {
        ReadLabel::ChangedFiles => "changed files",
        ReadLabel::Summary => "summary",
        ReadLabel::Plans => "plans",
        ReadLabel::ScriptRuns => "script runs",
        ReadLabel::HookRuns => "hook runs",
    }
}

/// A read's failure: the desktop lacks the channel, or anything else.
pub(crate) fn read_error(label: ReadLabel, outdated: bool) -> String {
    let key = if outdated {
        CopyKey::ReadOutdated
    } else {
        CopyKey::ReadFailed
    };
    render(text(key), &[("label", read_label(label))])
}

/// The words the activity readers put where the desktop sent none.
pub(crate) fn fallbacks() -> Fallbacks {
    Fallbacks {
        untitled_plan: text(CopyKey::UntitledPlan).into(),
        hook: text(CopyKey::HookFallback).into(),
        workspace_root: text(CopyKey::WorkspaceRoot).into(),
        repository: text(CopyKey::RepositoryFallback).into(),
    }
}

/// `PrCheckDisplayState.label`.
pub(crate) fn check_state(state: CheckState) -> &'static str {
    match state {
        CheckState::Queued => "Queued",
        CheckState::Running => "Running",
        CheckState::Succeeded => "Succeeded",
        CheckState::Failed => "Failed",
        CheckState::Canceled => "Canceled",
        CheckState::TimedOut => "Timed out",
        CheckState::Skipped => "Skipped",
        CheckState::ActionRequired => "Action required",
        CheckState::Neutral => "Neutral",
        CheckState::Pending => "Pending",
    }
}

/// `mergeQueuePhaseLabel`.
pub(crate) fn queue_phase(key: MergeQueuePhaseKey) -> &'static str {
    match key {
        MergeQueuePhaseKey::Queued => "Waiting in queue",
        MergeQueuePhaseKey::AwaitingChecks => "Awaiting queue checks",
        MergeQueuePhaseKey::Mergeable => "Queue checks passed",
        MergeQueuePhaseKey::Locked => "Locked for merge",
        MergeQueuePhaseKey::Unmergeable => "Can't merge from queue",
    }
}

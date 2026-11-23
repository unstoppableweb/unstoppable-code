//! Display rules of a pull request's checks and merge queue
//! (`pr_check_display.dart`, `pr_merge_queue_display.dart`). The words
//! are in `cc-app::copy::activity`.
use super::{Check, MergeQueue, MergeQueuePhase, PrStatus};

/// `PrCheckDisplayState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckState {
    Queued,
    Running,
    Succeeded,
    Failed,
    Canceled,
    TimedOut,
    Skipped,
    ActionRequired,
    Neutral,
    /// Only from an older desktop's four-value status.
    Pending,
}

/// `prCheckDisplayState`: the detailed state wins; any value this build
/// does not know reads as Neutral.
pub fn check_state(check: &Check) -> CheckState {
    match check.execution_state.as_deref() {
        Some("queued") => CheckState::Queued,
        Some("running") => CheckState::Running,
        Some("success") => CheckState::Succeeded,
        Some("failure") => CheckState::Failed,
        Some("cancelled") => CheckState::Canceled,
        Some("timed_out") => CheckState::TimedOut,
        Some("skipped") => CheckState::Skipped,
        Some("action_required") => CheckState::ActionRequired,
        Some("neutral") => CheckState::Neutral,
        None => match check.status.as_deref() {
            Some("success") => CheckState::Succeeded,
            Some("failure") => CheckState::Failed,
            Some("pending") => CheckState::Pending,
            _ => CheckState::Neutral,
        },
        Some(_) => CheckState::Neutral,
    }
}

/// `prChecksHeaderLabel`'s X: the checks that succeeded.
pub fn checks_passed(checks: &[Check]) -> usize {
    checks
        .iter()
        .filter(|c| check_state(c) == CheckState::Succeeded)
        .count()
}

/// `prChecksExpandedByDefault`: open while the summary CI status needs
/// attention.
pub fn checks_expanded_by_default(check_status: Option<&str>) -> bool {
    matches!(check_status, Some("failing" | "pending"))
}

/// `mergeQueuePhaseLabel`'s keys; none for an unknown or absent phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeQueuePhaseKey {
    Queued,
    AwaitingChecks,
    Mergeable,
    Locked,
    Unmergeable,
}

impl MergeQueuePhaseKey {
    pub fn of(phase: Option<MergeQueuePhase>) -> Option<Self> {
        Some(match phase? {
            MergeQueuePhase::Queued => Self::Queued,
            MergeQueuePhase::AwaitingChecks => Self::AwaitingChecks,
            MergeQueuePhase::Mergeable => Self::Mergeable,
            MergeQueuePhase::Locked => Self::Locked,
            MergeQueuePhase::Unmergeable => Self::Unmergeable,
            MergeQueuePhase::Unknown => return None,
        })
    }
}

/// `isSameRemotePr`: the same URL, or the same number when `pr` has none.
fn same_pr(pr: &PrStatus, candidate: &PrStatus) -> bool {
    match pr.url.as_deref() {
        Some(url) if !url.is_empty() => candidate.url.as_deref() == Some(url),
        _ => pr.number.is_some() && candidate.number == pr.number,
    }
}

/// `mergeQueueForActionPr`: an action's open PR reads its queue state
/// from the worktree row's matching PR.
pub fn merge_queue_for_action_pr<'a>(
    pr: &PrStatus,
    row: impl IntoIterator<Item = &'a PrStatus>,
) -> Option<MergeQueue> {
    if pr.state != "open" {
        return None;
    }
    let found = row.into_iter().find(|r| same_pr(pr, r))?;
    if found.in_merge_queue() {
        found.merge_queue.clone()
    } else {
        None
    }
}

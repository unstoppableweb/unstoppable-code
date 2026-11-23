//! Work drawer copy (P7), from `device_link/work_drawer/{projection,
//! repository}.dart` and the group labels of `data/models/composer_work.dart`.
use cc_domain::work::{Word, WorkGroup};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyKey {
    /// Some reads failed after their retries.
    LoadFailed,
    /// A read the desktop does not have.
    UpdateComputer,
    /// Offline with work listed.
    Reconnect,
    /// `{ok: false}` without an error.
    Refused,
    /// A stop answered with something else.
    TaskStopUnconfirmed,
    /// A delegate stop without `ok`.
    DelegatesStopUnconfirmed,
    /// A watcher deletion without `ok`.
    WatcherDeleteUnconfirmed,
    /// Any other failure.
    ActionUnconfirmed,
}

pub(crate) fn text(key: CopyKey) -> &'static str {
    match key {
        CopyKey::LoadFailed => "Couldn't load some background work. The rest is listed.",
        CopyKey::UpdateComputer => "Update your computer to show all background work.",
        CopyKey::Reconnect => "Reconnect to update background work.",
        CopyKey::Refused => "The computer refused this action.",
        CopyKey::TaskStopUnconfirmed => {
            "Could not confirm that this task stopped. Refresh to check its state."
        }
        CopyKey::DelegatesStopUnconfirmed => {
            "Could not confirm that the delegates stopped. Refresh to check their state."
        }
        CopyKey::WatcherDeleteUnconfirmed => {
            "Could not confirm watcher deletion. Refresh to check its state."
        }
        CopyKey::ActionUnconfirmed => "Could not confirm the action. Refresh to check its state.",
    }
}

/// `WorkGroup.label`.
pub(crate) fn group_label(group: WorkGroup) -> &'static str {
    match group {
        WorkGroup::NeedsYou => "Needs you",
        WorkGroup::Queued => "Queued",
        WorkGroup::Running => "Running",
        WorkGroup::PullRequests => "Pull requests",
        WorkGroup::Watching => "Watching",
    }
}

fn template(word: Word) -> &'static str {
    match word {
        Word::Unknown => "Unknown",
        Word::Succeeded => "Succeeded",
        Word::Failed => "Failed",
        Word::Running => "Running",
        Word::Queued => "Queued",
        Word::NeedsInput => "Needs input",
        Word::QueuedMessage => "Queued message",
        Word::SwitchProvider => "Switch provider to send this",
        Word::WaitingBackgroundWork => "Waiting for background work",
        Word::WaitingCurrentStep => "Waiting for current step",
        Word::TryAgain => "Try again",
        Word::Interrupt => "Interrupt",
        Word::RunNow => "Run now",
        Word::Message => "Message",
        Word::SettingsWaiting => "Settings waiting to apply",
        Word::Sending => "Sending",
        Word::InterruptNote => {
            "Interrupt stops the current reply. This message still waits for background work."
        }
        Word::WaitingFor => "Waiting for",
        Word::BackgroundWorkToFinish => "Background work to finish",
        Word::Attachments => "Attachments",
        Word::BackgroundTask => "Background task",
        Word::Paused => "Paused",
        Word::Progress => "Progress",
        Word::Phase => "Phase",
        Word::Tokens => "Tokens",
        Word::ToolCalls => "Tool calls",
        Word::Duration => "Duration",
        Word::Seconds => "{seconds}s",
        Word::Delegate => "Delegate",
        Word::NeedsApproval => "Needs approval",
        Word::Prompt => "Prompt",
        Word::Model => "Model",
        Word::MoreDelegate => "{count} more delegate",
        Word::MoreDelegates => "{count} more delegates",
        Word::OneDelegate => "{count} delegate",
        Word::Delegates => "{count} delegates",
        Word::CountRunning => "{count} running",
        Word::CountQueued => "{count} queued",
        Word::Watching => "Watching",
        Word::Trigger => "Trigger",
        Word::Status => "Status",
        Word::FollowUp => "Follow-up",
        Word::SourceError => "Source error",
        Word::DeliveryError => "Delivery error",
        Word::Resumes => "Resumes",
        Word::SourceUnavailable => "Source unavailable",
        Word::DeliveryFailed => "Delivery failed",
        Word::Attempt => "Attempt {attempts}",
        Word::AttemptNext => "Attempt {attempts}, next {next}",
        Word::ScheduledWakeup => "Scheduled wakeup",
        Word::Command => "Command",
        Word::Pipeline => "Pipeline",
        Word::Hook => "Hook",
        Word::Chat => "Chat",
        Word::NewChats => "New chats",
        Word::Automation => "Automation",
        Word::GithubRuns => "GitHub runs",
        Word::PullRequests => "Pull requests",
        Word::ChatActivity => "Chat activity",
        Word::Project => "Project",
        Word::Branch => "Branch",
        Word::Description => "Description",
        Word::Execution => "Execution",
        Word::Repository => "Repository",
        Word::ScheduledFor => "Scheduled for",
        Word::Delay => "Delay",
        Word::CountSeconds => "{count} seconds",
        Word::CheckInterval => "Check interval",
        Word::AttemptLimit => "Attempt limit",
        Word::Directory => "Directory",
        Word::InMergeQueue => "In merge queue",
        Word::InMergeQueueAt => "In merge queue · {position}",
        Word::Queue => "Queue",
        Word::BaseBranch => "Base branch",
        Word::Added => "Added",
        Word::Removed => "Removed",
        Word::Plus => "+{count}",
        Word::Minus => "-{count}",
        Word::LastChecked => "Last checked",
        Word::PrTitle => "#{number}",
        Word::Run => "Run",
        Word::RunTitle => "{name} #{number}",
        Word::RunTitleAttempt => "{name} #{number} · attempt {attempt}",
        Word::Cancelled => "Cancelled",
        Word::Completed => "Completed",
        Word::Output => "Output",
    }
}

/// The projection's words with their arguments filled.
pub(crate) fn words(word: Word, args: &[(&str, &str)]) -> String {
    super::render(template(word), args)
}

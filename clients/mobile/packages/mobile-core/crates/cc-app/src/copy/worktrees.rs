//! Worktree creation and archive copy (P8), from
//! `device_link/worktrees/{creation,archive}.dart`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyKey {
    /// A creation while the computer is not connected.
    ConnectFirst,
    /// A creation in a project whose last creation was not confirmed.
    CreationNotConfirmed,
    /// Another attempt is creating a worktree in the project.
    AlreadyCreating,
    /// The project is no longer listed (or hidden, or archived).
    ProjectGone,
    /// A Cowork project has no worktrees.
    ChooseCodeProject,
    /// The connection changed while a creation was running.
    ConnectionChanged,
    /// The created worktree's setup needs the desktop.
    SetupNeedsAttention,
    /// The desktop reported a failed worktree setup.
    SetupFailed,
    /// The computer went offline while a creation waited for its setup.
    ReconnectToCheck,
    /// A created worktree without a branch name.
    NewTask,
    /// The worktree to archive is no longer listed.
    WorktreeGone,
    /// The desktop answered an archive with `success: false`.
    ArchiveFailed,
    /// A reply did not have the shape the reader requires.
    InvalidMessage,
}

pub(crate) fn text(key: CopyKey) -> &'static str {
    match key {
        CopyKey::ConnectFirst => "Connect to a computer first.",
        CopyKey::CreationNotConfirmed => {
            "Creation was not confirmed. Check your computer before starting another task."
        }
        CopyKey::AlreadyCreating => "A task is already being created in this project.",
        CopyKey::ProjectGone => "This project is no longer available.",
        CopyKey::ChooseCodeProject => "Choose a code project to create a worktree.",
        CopyKey::ConnectionChanged => "The computer connection changed. Refresh before continuing.",
        CopyKey::SetupNeedsAttention => "Worktree setup needs attention on your computer.",
        CopyKey::SetupFailed => "Worktree setup failed. Check your computer before retrying.",
        CopyKey::ReconnectToCheck => "Reconnect to check the created worktree.",
        CopyKey::NewTask => "New task",
        CopyKey::WorktreeGone => "This worktree is no longer available.",
        CopyKey::ArchiveFailed => "Your computer could not archive the worktree.",
        CopyKey::InvalidMessage => "The peer sent an invalid message.",
    }
}

//! Project clone copy (P8), from `device_link/projects/clone_repository.dart`.
//! Raw git errors can name local paths, so they are never shown; only the
//! computer's own path-free copy is.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyKey {
    /// An add while the computer is not connected.
    ConnectFirst,
    /// The computer cannot add projects (`remote_channel_unavailable`).
    Unsupported,
    /// The folder lookup did not reach the computer.
    Unreachable,
    /// The computer gave no folder for new projects.
    NoDestination,
    /// The computer's own clone failure copy.
    CloneFailed,
    /// A folder lookup or a clone is running.
    WaitForClone,
    /// A result is unknown and the user has not accepted a duplicate.
    Unconfirmed,
    /// The connection or context changed during the folder lookup.
    ConnectionChanged,
    /// The clone request was not sent.
    NotSent,
    /// A clone row whose URL has no repository name.
    Repository,
}

pub(crate) fn text(key: CopyKey) -> &'static str {
    match key {
        CopyKey::ConnectFirst => "Connect to your computer first.",
        CopyKey::Unsupported => "This computer doesn't support adding projects from your phone.",
        CopyKey::Unreachable => "Couldn't reach your computer. Try again.",
        CopyKey::NoDestination => "Your computer didn't provide a folder for new projects.",
        CopyKey::CloneFailed => {
            "Failed to clone the repository. Check the URL and access, then try again."
        }
        CopyKey::WaitForClone => "Wait for the current clone to finish.",
        CopyKey::Unconfirmed => {
            "Your computer hasn't confirmed the last clone yet. Check Projects on your computer."
        }
        CopyKey::ConnectionChanged => "The computer connection changed. Try again.",
        CopyKey::NotSent => "Couldn't send the request to your computer. Try again.",
        // `repositoryNameFromCloneUrl`'s fallback, shared with the desktop.
        CopyKey::Repository => "repository",
    }
}

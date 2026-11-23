//! Overview copy, from `computer_connect/controller.dart` (`_describe`),
//! `device_link/protocol.dart` (`deviceLinkObject`), `worktrees/repository.dart`
//! (`_worktreeName`), `chats/{models,title}.dart` and
//! `data/models/{remote_session,remote_chat}.dart` (fallback titles).
use cc_protocol::desktop::Fallbacks;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyKey {
    /// A read failed for a reason the transport does not word.
    ReadFailed,
    /// A reply did not have the shape the reader requires.
    InvalidMessage,
}

pub(crate) fn text(key: CopyKey) -> &'static str {
    match key {
        CopyKey::ReadFailed => "Could not read your computer. Try again.",
        CopyKey::InvalidMessage => "The peer sent an invalid message.",
    }
}

/// The fallback names and titles decoders fill in.
pub(crate) fn fallbacks() -> Fallbacks {
    Fallbacks {
        worktree: "Worktree".into(),
        chat: "Chat".into(),
        untitled_chat: "Untitled chat".into(),
        detached: "Detached worktree".into(),
    }
}

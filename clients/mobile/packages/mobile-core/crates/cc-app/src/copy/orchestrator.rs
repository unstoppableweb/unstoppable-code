//! Orchestrator copy (P9), from `device_link/orchestrator/{catalog,questions}.dart`
//! and `computer_connect/orchestrator/controller.dart`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyKey {
    /// The Orchestrator's chat workspace (`DeviceChatWorkspace`).
    Workspace,
    /// A work entry without a title.
    EntryFallback,
    /// The entry's active chat could not be read.
    LoadFailed,
    /// A new tab in an entry without one could not be created.
    CreateFailed,
    /// An answer to a question that is no longer pending.
    NoLongerWaiting,
    /// An answer without exactly one choice for the question.
    AnswerFirst,
}

pub(crate) fn text(key: CopyKey) -> &'static str {
    match key {
        CopyKey::Workspace => "Orchestrator",
        CopyKey::EntryFallback => "New chat",
        CopyKey::LoadFailed => "Couldn't load this task.",
        CopyKey::CreateFailed => "Couldn't create this chat.",
        CopyKey::NoLongerWaiting => "This question is no longer waiting for an answer.",
        CopyKey::AnswerFirst => "Answer the question before continuing.",
    }
}

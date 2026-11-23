//! Home and new task copy (final sweep), from
//! `computer_connect/{home_model,home_launcher,new_task_model,new_task_screen}.dart`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyKey {
    /// The launcher options read failed with an unexpected error.
    OptionsFailed,
    /// Home's choices were not stored.
    ChoicesNotSaved,
    /// Home's draft was not stored before a launch.
    DraftNotSaved,
    /// The pending chat is outside the selected account context.
    OutsideContext,
    /// The pending chat did not open.
    OpenFailed,
    /// The context's projects changed after the target was made.
    ProjectsChangedCheck,
    /// The context's projects changed before the target was made.
    ProjectsChangedChoose,
    /// A send is still unconfirmed.
    CheckDelivery,
    /// The admitted launch's project or worktree is gone.
    PrepareFailed,
    /// The created worktree could not be read.
    CreatedUnavailable,
    /// The chosen model left the created chat's catalog.
    ModelGone,
    /// A creation that reached the desktop has not finished setting up.
    StillSettingUp,
    /// A creation whose answer is unknown.
    CreationNotConfirmed,
    /// The created chat is no longer the open one.
    ChatNotOpen,
    /// A send failed with an unexpected error.
    SendFailed,
    /// A Home file was not stored: `{filename}`, then the reason.
    AttachFailed,
    /// The reason when the computer gave none.
    TryAgain,
    /// The status while no worktree exists yet.
    CreatingWorktree,
    /// The status once the desktop answered the create.
    SettingUpWorktree,
}

pub(crate) fn text(key: CopyKey) -> &'static str {
    match key {
        CopyKey::OptionsFailed => "Couldn't load chat options.",
        CopyKey::ChoicesNotSaved => "Selections could not be saved. They will reset next time.",
        CopyKey::DraftNotSaved => {
            "The draft could not be saved. It may not survive an app restart."
        }
        CopyKey::OutsideContext => "This chat is not available in the selected account context.",
        CopyKey::OpenFailed => "Could not open the chat. Check the account context and try again.",
        CopyKey::ProjectsChangedCheck => "Projects changed. Return home to check the created chat.",
        CopyKey::ProjectsChangedChoose => {
            "Projects changed. Return home and choose the destination again."
        }
        CopyKey::CheckDelivery => {
            "Check delivery of the previous message before starting another chat."
        }
        CopyKey::PrepareFailed => "Could not prepare the chat. Try again.",
        CopyKey::CreatedUnavailable => {
            "Could not load the created task. Refresh to try opening it again."
        }
        CopyKey::ModelGone => {
            "This model is no longer available. Return home and choose another model."
        }
        CopyKey::StillSettingUp => {
            "Still setting up on your computer. Try again to check the same task."
        }
        CopyKey::CreationNotConfirmed => {
            "Creation was not confirmed. Check your computer before starting another task."
        }
        CopyKey::ChatNotOpen => {
            "This chat is no longer open. Try again to send your message to it."
        }
        CopyKey::SendFailed => "Could not send the message. Check delivery before retrying.",
        CopyKey::AttachFailed => "Could not attach {filename}. {reason}",
        CopyKey::TryAgain => "Try again.",
        CopyKey::CreatingWorktree => "Creating worktree…",
        CopyKey::SettingUpWorktree => "Setting up worktree…",
    }
}

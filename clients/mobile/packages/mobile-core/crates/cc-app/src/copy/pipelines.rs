//! Pipeline copy (P7), from `device_link/pipelines/{repository,
//! existing_ipc}.dart` and the run words of `ui/core/activity/
//! pipeline_run_display.dart` and `ui/core/pipelines/pipeline_input_form.dart`
//! (shared with Remote Control, which keeps the Dart copies).
use cc_domain::pipelines::{
    InputError,
    presentation::{StatusLabel, Trigger},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyKey {
    /// A request while the computer is not connected.
    ConnectFirst,
    /// A reply arrived after the connection changed.
    ConnectionChanged,
    /// A failure that is not a link failure (`errorMessage`).
    RequestUnconfirmed,
    /// The desktop has no such pipeline channel.
    Unavailable,
    /// A parsed run belongs to another worktree.
    DifferentWorktreeState,
    /// A start of the same pipeline is still unconfirmed.
    StartUnconfirmed,
    /// `success: false` without an error.
    RequestFailed,
    /// Neither `success: true` nor `false`.
    InvalidReply,
    /// An execution row of another worktree.
    DifferentWorktree,
    /// The connection changed before a mutation was sent.
    LinkChanged,
    /// A control's reply belongs to another worktree.
    ControlChanged,
    /// A log read of a step the execution no longer has.
    StepGone,
    /// `deviceLinkObject` / `deviceLinkString`.
    InvalidMessage,
}

pub(crate) fn text(key: CopyKey) -> &'static str {
    match key {
        CopyKey::ConnectFirst => "Connect to a computer first.",
        CopyKey::ConnectionChanged => "The computer connection changed. Refresh to retry.",
        CopyKey::RequestUnconfirmed => {
            "The request could not be confirmed. Refresh to check its state."
        }
        CopyKey::Unavailable => "This pipeline operation is unavailable on the connected computer.",
        CopyKey::DifferentWorktreeState => {
            "The computer sent pipeline state for a different worktree."
        }
        CopyKey::StartUnconfirmed => {
            "The previous start is unconfirmed. Check pipeline runs before starting another run."
        }
        CopyKey::RequestFailed => "The computer could not complete this pipeline request.",
        CopyKey::InvalidReply => "The computer sent an invalid pipeline reply.",
        CopyKey::DifferentWorktree => "The computer sent a pipeline for a different worktree.",
        CopyKey::LinkChanged => "The computer connection changed.",
        CopyKey::ControlChanged => "The pipeline connection changed. Refresh its state.",
        CopyKey::StepGone => "This pipeline step is no longer available.",
        CopyKey::InvalidMessage => "The peer sent an invalid message.",
    }
}

/// `pipelineRunStatusLabel(status)`.
pub(crate) fn status_label(label: StatusLabel, status: &str) -> String {
    match label {
        StatusLabel::Running => "Running",
        StatusLabel::Restarting => "Restarting",
        StatusLabel::Paused => "Paused",
        StatusLabel::Succeeded => "Succeeded",
        StatusLabel::Failed => "Failed",
        StatusLabel::Canceled => "Canceled",
        StatusLabel::Queued => "Queued",
        StatusLabel::Skipped => "Skipped",
        StatusLabel::Unknown => "Unknown",
        StatusLabel::Raw => return status.to_owned(),
    }
    .to_owned()
}

/// `pipelineTriggerLabel(trigger)`.
pub(crate) fn trigger_label(trigger: Trigger) -> &'static str {
    match trigger {
        Trigger::Hook => "Started by a hook",
        Trigger::Chat => "Started from a chat",
        Trigger::Plan => "Started from a plan",
        Trigger::Manual => "Started manually",
    }
}

/// `validatePipelineInputs`'s messages.
pub(crate) fn input_error(error: &InputError) -> String {
    match error {
        InputError::Required => "This field is required".into(),
        InputError::InvalidNumber => "Must be a valid number".into(),
        InputError::AtLeast(min) => {
            super::render("Must be at least {min}", &[("min", &min.dart_string())])
        }
        InputError::AtMost(max) => {
            super::render("Must be at most {max}", &[("max", &max.dart_string())])
        }
        InputError::OneOf(options) => super::render(
            "Must be one of: {options}",
            &[("options", &options.join(", "))],
        ),
    }
}

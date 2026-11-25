//! One computer's pipelines and composer work drawers (architecture §3.6,
//! P7): each worktree's runs (with their display facts), dispatchable
//! pipelines, errors and controls in flight; the run panels of a chat's
//! feed; and each mounted chat's work drawer.
//!
//! [`PipelinesService::watch`] streams one worktree's view,
//! [`PipelinesService::watch_chat_activity`] one follower's turn panels
//! and [`PipelinesService::watch_drawer`] one drawer. Intents are queued
//! in call order ([`PipelinesService::send`]);
//! [`PipelinesService::request`] also returns a ticket whose outcome
//! [`PipelinesService::settled`] waits for. Each [`PipelinesIntent`]
//! variant says when it settles.
use super::{ChatRefView, CoreFailure, CoreInner};
use crate::account::View;
use crate::copy::{pipelines as copy, work as work_copy};
use crate::owners::End;
use crate::pipelines::{
    self, Control, Document, DrawerShown, FailureKind, FollowShown, Handle, Outcome, Published,
    ScopeShown, Source, scope_key,
};
use cc_domain::{
    chat::ChatRef,
    pipelines::{
        DispatchForm, InputDefinition, InputType, Number, Origin, Run,
        dispatch::{initial_values, payload, validate, visible_inputs},
        presentation::{self, DotStatus},
    },
    work::{self, WorkAction as Action, WorkGroup as Group, WorkKind as Kind, WorkTone as Tone},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;

/// `RemotePipelineOrigin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineOrigin {
    Bundled,
    User,
    Project,
    Shared,
    Curated,
}

/// `RemotePipelineRunAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineAction {
    Cancel,
    Retry,
    Resume,
}

/// What a content read reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipelineContentSource {
    /// One step's output; `job_id` is the physical job (a matrix
    /// variant's own id).
    StepOutput { job_id: String, step_id: String },
    /// The run's saved report.
    Report,
}

/// A form value or payload entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineInputValue {
    pub name: String,
    pub value: String,
}

/// `WorkAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkAction {
    StopTask,
    StopDelegate,
    StopDelegates,
    DeleteWatcher,
    CancelQueued,
    ForceQueued,
    SteerQueued,
}

/// What the host asks of the pipelines. Queued in call order.
#[derive(Debug, Clone)]
pub enum PipelinesIntent {
    /// The session became usable or ended: reads and controls in flight
    /// are forgotten; a connect reloads every watched worktree.
    ///
    /// Resolves when applied.
    SetConnected { connected: bool },
    /// Shows `chat`'s worktree and loads it; `token` names the watch for
    /// [`Self::Release`].
    ///
    /// Resolves when applied.
    Watch { chat: ChatRefView, token: u64 },
    /// Ends the watch `token`.
    ///
    /// Resolves when applied.
    Release { token: u64 },
    /// Reads the worktree's runs and pipelines (one load at a time).
    ///
    /// Resolves when settled: the load finished (its failure is the view's
    /// error).
    Load { chat: ChatRefView },
    /// Reads one run.
    ///
    /// Resolves when settled: the read finished; the outcome carries the
    /// run, or none when it failed (the failure is the run's error).
    Get { chat: ChatRefView, id: String },
    /// Selects a step and reads its output tail onto the run.
    ///
    /// Resolves when settled: the read finished or failed.
    Log {
        chat: ChatRefView,
        id: String,
        job_id: String,
        step_id: String,
    },
    /// Forgets the run's selected step.
    ///
    /// Resolves when applied.
    ClearLogSelection { chat: ChatRefView, id: String },
    /// Cancels, retries or resumes a run, sent at most once while one is in
    /// flight for it.
    ///
    /// Resolves when settled: the desktop answered (or the control
    /// failed into the view's action error).
    Control {
        chat: ChatRefView,
        id: String,
        action: PipelineAction,
    },
    /// Clears a run's action error.
    ///
    /// Resolves when applied.
    ClearActionError { chat: ChatRefView, id: String },
    /// Reads a pipeline's dispatch form.
    ///
    /// Resolves when settled: the outcome carries the form, or the
    /// failure.
    Form {
        chat: ChatRefView,
        pipeline_id: String,
        origin: PipelineOrigin,
    },
    /// Starts a pipeline: `pipelines:execute` at most once. An unconfirmed
    /// start blocks the next start of that pipeline.
    ///
    /// Resolves when settled: the run was started and read (the outcome
    /// carries its id), or the start failed.
    Start {
        chat: ChatRefView,
        pipeline_id: String,
        origin: PipelineOrigin,
        inputs: Vec<PipelineInputValue>,
    },
    /// Reads a step's output or the run's report.
    ///
    /// Resolves when settled: the outcome carries the document, or the
    /// failure.
    Content {
        chat: ChatRefView,
        id: String,
        source: PipelineContentSource,
    },
    /// A feed's run panels follow `chat` (none for a chat without a
    /// worktree): they watch its worktree and read the runs its turns
    /// link. `token` names the follower.
    ///
    /// Resolves when applied.
    Follow {
        token: u64,
        chat: Option<ChatRefView>,
        online: bool,
    },
    /// Ends the follower `token`.
    ///
    /// Resolves when applied.
    Unfollow { token: u64 },
    /// The work drawer `token` shows `chat` (`update`).
    ///
    /// Resolves when applied.
    DrawerUpdate {
        token: u64,
        chat: ChatRefView,
        online: bool,
        ready: bool,
    },
    /// Clears the drawer's action errors and reads again.
    ///
    /// Resolves when settled: the read it started or joined finished.
    DrawerRetry { token: u64 },
    /// Runs an item's action.
    ///
    /// Resolves when settled: the action and the read after it finished
    /// (a failure is the drawer's error).
    DrawerAct {
        token: u64,
        item_id: String,
        action: WorkAction,
        notify_subscriber: bool,
    },
    /// Ends the drawer `token`.
    ///
    /// Resolves when applied.
    DrawerClose { token: u64 },
    /// Stops the pipelines.
    ///
    /// Resolves when applied.
    Close,
}

/// Which exception a failure was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineFailureKind {
    /// `RemoteControlException`.
    Remote,
    /// `DeviceLinkException`.
    Link,
    /// Anything else; the message is the generic wording.
    Other,
}

/// A failure the host rethrows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineFailure {
    pub message: String,
    pub kind: PipelineFailureKind,
}

/// What a settled intent produced.
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)] // Crosses the binding by value.
pub enum PipelinesOutcome {
    Run {
        run: Option<PipelineRunView>,
    },
    Form {
        form: DispatchFormView,
    },
    Started {
        id: String,
    },
    Content {
        chunks: Vec<PipelineContentChunkView>,
    },
}

/// How a requested intent ended.
#[derive(Debug, Clone, PartialEq)]
pub struct PipelinesSettled {
    pub failure: Option<PipelineFailure>,
    pub outcome: Option<PipelinesOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineProgressView {
    pub completed_steps: i64,
    pub total_steps: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineStepView {
    pub step_id: String,
    pub name: String,
    pub status: String,
    pub attempt: Option<i64>,
    pub iteration: Option<i64>,
    pub recovery: Option<i64>,
    pub output_tail: Option<String>,
}

/// A matrix variant (its matrix values are not drawn).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineVariantView {
    pub job_id: String,
    pub name: String,
    pub status: String,
    pub steps: Vec<PipelineStepView>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineJobView {
    pub job_id: String,
    pub name: String,
    pub status: String,
    /// `None`: the desktop sent no `needs`.
    pub needs: Option<Vec<String>>,
    pub steps: Vec<PipelineStepView>,
    pub variants: Vec<PipelineVariantView>,
    pub expansion: Option<String>,
    pub expansion_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineStatusReasonView {
    pub id: String,
    pub kind: String,
    pub code: String,
    pub provider: Option<String>,
    pub resets_at: Option<String>,
}

/// A checkpoint the desktop waits on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelinePauseView {
    pub id: String,
    pub kind: String,
    pub job_id: String,
    pub step_id: String,
    pub title: Option<String>,
    pub message: Option<String>,
    pub field_labels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineChatTurnView {
    pub chat_id: String,
    pub user_message_id: String,
    pub relation: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineFollowUpView {
    pub plan_available: bool,
    pub report_available: bool,
}

/// A step row of a group, with its physical job id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineGroupStepView {
    pub job_id: String,
    pub step_id: String,
    pub status_label: String,
}

/// An expandable group: a job, or a matrix variant one level under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineGroupView {
    pub job_id: String,
    pub name: String,
    pub status: String,
    pub status_label: String,
    pub depth: u32,
    pub is_variant: bool,
    pub steps: Vec<PipelineGroupStepView>,
}

/// `PipelineRunDotStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineDotStatus {
    Pending,
    Running,
    Success,
    Failure,
    Paused,
    Cancelled,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineDotView {
    pub job_id: String,
    pub name: String,
    pub status: PipelineDotStatus,
}

/// Jobs that can run in parallel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineTierView {
    pub dots: Vec<PipelineDotView>,
}

/// What the run surfaces show for a run, computed here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineRunDisplayView {
    pub status_label: String,
    pub trigger_label: String,
    pub can_cancel: bool,
    pub can_resume: bool,
    pub can_retry: bool,
    pub groups: Vec<PipelineGroupView>,
    pub tiers: Vec<PipelineTierView>,
}

/// One pipeline execution (`RemotePipelineRun`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineRunView {
    pub local_id: String,
    pub pipeline_id: Option<String>,
    pub pipeline_name: String,
    pub workspace_local_id: Option<String>,
    pub worktree_local_id: Option<String>,
    pub status: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub parent_execution_id: Option<String>,
    pub trigger_source: Option<String>,
    pub hidden: bool,
    pub truncated: bool,
    pub output_tail: Option<String>,
    pub progress: Option<PipelineProgressView>,
    pub status_reasons: Vec<PipelineStatusReasonView>,
    pub pending_pauses: Vec<PipelinePauseView>,
    /// `None`: this desktop sent no detail.
    pub jobs: Option<Vec<PipelineJobView>>,
    /// `None`: no update said.
    pub chat_turns: Option<Vec<PipelineChatTurnView>>,
    pub chat_follow_up: Option<PipelineFollowUpView>,
    pub display: PipelineRunDisplayView,
}

/// A pipeline the worktree can start (`RemotePipelineDescriptor`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineDescriptorView {
    pub pipeline_id: String,
    pub name: String,
    pub description: Option<String>,
    pub origin: PipelineOrigin,
    pub trigger_types: Vec<String>,
    pub scopes: Vec<String>,
}

/// `RemotePipelineInputType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PipelineInputType {
    String,
    Boolean,
    Number,
    Choice,
}

/// A wire number with its `int`/`double` kind.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PipelineNumberView {
    pub value: f64,
    pub integer: bool,
}

/// One declared dispatch input.
#[derive(Debug, Clone, PartialEq)]
pub struct PipelineInputView {
    pub name: String,
    pub description: Option<String>,
    pub required: bool,
    pub default_value: Option<String>,
    pub input_type: PipelineInputType,
    pub options: Vec<String>,
    pub min: Option<PipelineNumberView>,
    pub max: Option<PipelineNumberView>,
    pub hide_in_ui: bool,
}

/// A pipeline's dispatch form (`RemotePipelineDispatchForm`).
#[derive(Debug, Clone, PartialEq)]
pub struct DispatchFormView {
    pub inputs: Vec<PipelineInputView>,
    pub inputs_omitted: bool,
    pub unsupported_reason: Option<String>,
    pub can_dispatch: bool,
}

/// A form field's error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineInputErrorView {
    pub name: String,
    pub message: String,
}

/// The form rules over a form and its values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormRulesView {
    /// Indexes of the inputs the form shows.
    pub visible: Vec<u32>,
    pub initial: Vec<PipelineInputValue>,
    pub errors: Vec<PipelineInputErrorView>,
    pub payload: Vec<PipelineInputValue>,
}

/// A piece of a document as laid out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineContentChunkView {
    pub markdown: bool,
    pub text: String,
}

/// A run's note (its read error or action error).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineRunNoteView {
    pub id: String,
    pub message: String,
}

/// A control in flight.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineControlView {
    pub id: String,
    pub action: PipelineAction,
}

/// One worktree's pipelines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineScopeView {
    pub revision: u64,
    /// Listed runs, newest first.
    pub runs: Vec<PipelineRunView>,
    /// Runs the list hides (child runs).
    pub hidden_runs: Vec<PipelineRunView>,
    pub pipelines: Vec<PipelineDescriptorView>,
    /// The worktree's load error.
    pub error: Option<String>,
    pub run_errors: Vec<PipelineRunNoteView>,
    pub action_errors: Vec<PipelineRunNoteView>,
    /// Runs with a read in flight.
    pub pending: Vec<String>,
    pub controls: Vec<PipelineControlView>,
}

/// One turn's runs, oldest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineTurnView {
    pub turn: String,
    pub runs: Vec<PipelineRunView>,
}

/// A feed's run panels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatActivityView {
    pub revision: u64,
    pub turns: Vec<PipelineTurnView>,
    /// The turn expanded by default.
    pub latest: Option<String>,
}

/// `WorkGroup`, in the drawer's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkGroup {
    NeedsYou,
    Queued,
    Running,
    PullRequests,
    Watching,
}

/// `WorkKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkKind {
    Agent,
    Command,
    Workflow,
    Task,
    Pipeline,
    Github,
    PullRequest,
    Watcher,
    Message,
}

/// `WorkTone`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkTone {
    Neutral,
    Running,
    Attention,
    Success,
    Failed,
    Merged,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkDetailView {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkActionLabelView {
    pub action: WorkAction,
    pub label: String,
}

/// One row of the work drawer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkItemView {
    pub id: String,
    pub group: WorkGroup,
    pub kind: WorkKind,
    pub title: String,
    pub subtitle: Option<String>,
    pub status: Option<String>,
    pub tone: WorkTone,
    pub details: Vec<WorkDetailView>,
    pub action: Option<WorkAction>,
    pub action_id: Option<String>,
    pub url: Option<String>,
    pub pipeline_id: Option<String>,
    pub watcher_count: i64,
    pub count: i64,
    pub finished: bool,
    pub extra_actions: Vec<WorkAction>,
    pub action_labels: Vec<WorkActionLabelView>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkGroupCountView {
    pub group: WorkGroup,
    pub count: i64,
}

/// One chat's work drawer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkDrawerView {
    pub revision: u64,
    /// The key of the chat it shows, so a host that changed the chat shows
    /// none of the previous chat's work before this view comes.
    pub chat_key: Option<String>,
    pub items: Vec<WorkItemView>,
    pub errors: Vec<String>,
    /// Items with an action running.
    pub busy: Vec<String>,
    /// Unfinished work exists (errors alone never show the drawer).
    pub visible: bool,
    /// `Queued 2 | Running 1`.
    pub summary: String,
    /// Unfinished items per group, in the drawer's order.
    pub counts: Vec<WorkGroupCountView>,
}

/// One computer's pipelines. Built by [`super::ChatsService::pipelines`];
/// the feed panels and drawers follow that read path's chat.
#[derive(Clone)]
pub struct PipelinesService {
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

fn origin(o: PipelineOrigin) -> Origin {
    match o {
        PipelineOrigin::Bundled => Origin::Bundled,
        PipelineOrigin::User => Origin::User,
        PipelineOrigin::Project => Origin::Project,
        PipelineOrigin::Shared => Origin::Shared,
        PipelineOrigin::Curated => Origin::Curated,
    }
}

fn origin_view(o: Origin) -> PipelineOrigin {
    match o {
        Origin::Bundled => PipelineOrigin::Bundled,
        Origin::User => PipelineOrigin::User,
        Origin::Project => PipelineOrigin::Project,
        Origin::Shared => PipelineOrigin::Shared,
        Origin::Curated => PipelineOrigin::Curated,
    }
}

fn control(a: PipelineAction) -> Control {
    match a {
        PipelineAction::Cancel => Control::Cancel,
        PipelineAction::Retry => Control::Retry,
        PipelineAction::Resume => Control::Resume,
    }
}

fn control_view(a: Control) -> PipelineAction {
    match a {
        Control::Cancel => PipelineAction::Cancel,
        Control::Retry => PipelineAction::Retry,
        Control::Resume => PipelineAction::Resume,
    }
}

fn action(a: WorkAction) -> Action {
    match a {
        WorkAction::StopTask => Action::StopTask,
        WorkAction::StopDelegate => Action::StopDelegate,
        WorkAction::StopDelegates => Action::StopDelegates,
        WorkAction::DeleteWatcher => Action::DeleteWatcher,
        WorkAction::CancelQueued => Action::CancelQueued,
        WorkAction::ForceQueued => Action::ForceQueued,
        WorkAction::SteerQueued => Action::SteerQueued,
    }
}

fn action_view(a: Action) -> WorkAction {
    match a {
        Action::StopTask => WorkAction::StopTask,
        Action::StopDelegate => WorkAction::StopDelegate,
        Action::StopDelegates => WorkAction::StopDelegates,
        Action::DeleteWatcher => WorkAction::DeleteWatcher,
        Action::CancelQueued => WorkAction::CancelQueued,
        Action::ForceQueued => WorkAction::ForceQueued,
        Action::SteerQueued => WorkAction::SteerQueued,
    }
}

fn intent(i: PipelinesIntent) -> pipelines::Intent {
    use pipelines::{DrawerIntent as D, Intent as I};
    match i {
        PipelinesIntent::SetConnected { connected } => I::SetConnected(connected),
        PipelinesIntent::Watch { chat, token } => I::Watch {
            chat: chat_ref(chat),
            token,
        },
        PipelinesIntent::Release { token } => I::Release { token },
        PipelinesIntent::Load { chat } => I::Load(chat_ref(chat)),
        PipelinesIntent::Get { chat, id } => I::Get {
            chat: chat_ref(chat),
            id,
        },
        PipelinesIntent::Log {
            chat,
            id,
            job_id,
            step_id,
        } => I::Log {
            chat: chat_ref(chat),
            id,
            job: job_id,
            step: step_id,
        },
        PipelinesIntent::ClearLogSelection { chat, id } => I::ClearLogSelection {
            chat: chat_ref(chat),
            id,
        },
        PipelinesIntent::Control { chat, id, action } => I::Control {
            chat: chat_ref(chat),
            id,
            action: control(action),
        },
        PipelinesIntent::ClearActionError { chat, id } => I::ClearActionError {
            chat: chat_ref(chat),
            id,
        },
        PipelinesIntent::Form {
            chat,
            pipeline_id,
            origin: o,
        } => I::Form {
            chat: chat_ref(chat),
            pipeline_id,
            origin: origin(o),
        },
        PipelinesIntent::Start {
            chat,
            pipeline_id,
            origin: o,
            inputs,
        } => I::Start {
            chat: chat_ref(chat),
            pipeline_id,
            origin: origin(o),
            inputs: inputs.into_iter().map(|v| (v.name, v.value)).collect(),
        },
        PipelinesIntent::Content { chat, id, source } => I::Content {
            chat: chat_ref(chat),
            id,
            source: match source {
                PipelineContentSource::StepOutput { job_id, step_id } => {
                    Source::StepOutput { job_id, step_id }
                }
                PipelineContentSource::Report => Source::Report,
            },
        },
        PipelinesIntent::Follow {
            token,
            chat,
            online,
        } => I::Follow {
            token,
            chat: chat.map(chat_ref),
            online,
        },
        PipelinesIntent::Unfollow { token } => I::Unfollow { token },
        PipelinesIntent::DrawerUpdate {
            token,
            chat,
            online,
            ready,
        } => I::Drawer(D::Update {
            token,
            chat: chat_ref(chat),
            online,
            ready,
        }),
        PipelinesIntent::DrawerRetry { token } => I::Drawer(D::Retry { token }),
        PipelinesIntent::DrawerAct {
            token,
            item_id,
            action: a,
            notify_subscriber,
        } => I::Drawer(D::Act {
            token,
            item: item_id,
            action: action(a),
            notify_subscriber,
        }),
        PipelinesIntent::DrawerClose { token } => I::Drawer(D::Close { token }),
        PipelinesIntent::Close => I::Close,
    }
}

// ---- Views ----

fn step_view(s: &cc_domain::pipelines::Step) -> PipelineStepView {
    PipelineStepView {
        step_id: s.step_id.clone(),
        name: s.name.clone(),
        status: s.status.clone(),
        attempt: s.attempt,
        iteration: s.iteration,
        recovery: s.recovery,
        output_tail: s.output_tail.clone(),
    }
}

fn status_label(status: &str) -> String {
    copy::status_label(presentation::status_label(status), status)
}

fn display_view(run: &Run) -> PipelineRunDisplayView {
    let jobs = run.jobs.as_deref().unwrap_or_default();
    PipelineRunDisplayView {
        status_label: status_label(&run.status),
        trigger_label: copy::trigger_label(presentation::trigger(run.trigger_source.as_deref()))
            .into(),
        can_cancel: presentation::can_cancel(run),
        can_resume: presentation::can_resume(run),
        can_retry: presentation::can_retry(run),
        groups: presentation::groups(jobs)
            .into_iter()
            .map(|g| PipelineGroupView {
                status_label: status_label(&g.status),
                job_id: g.job_id,
                name: g.name,
                status: g.status,
                depth: g.depth,
                is_variant: g.is_variant,
                steps: g
                    .steps
                    .into_iter()
                    .map(|(job_id, step)| PipelineGroupStepView {
                        job_id,
                        status_label: status_label(&step.status),
                        step_id: step.step_id,
                    })
                    .collect(),
            })
            .collect(),
        tiers: presentation::dot_tiers(jobs)
            .into_iter()
            .map(|tier| PipelineTierView {
                dots: tier
                    .into_iter()
                    .map(|d| PipelineDotView {
                        job_id: d.job_id,
                        name: d.name,
                        status: match d.status {
                            DotStatus::Pending => PipelineDotStatus::Pending,
                            DotStatus::Running => PipelineDotStatus::Running,
                            DotStatus::Success => PipelineDotStatus::Success,
                            DotStatus::Failure => PipelineDotStatus::Failure,
                            DotStatus::Paused => PipelineDotStatus::Paused,
                            DotStatus::Cancelled => PipelineDotStatus::Cancelled,
                            DotStatus::Skipped => PipelineDotStatus::Skipped,
                        },
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn run_view(run: &Run) -> PipelineRunView {
    PipelineRunView {
        local_id: run.local_id.clone(),
        pipeline_id: run.pipeline_id.clone(),
        pipeline_name: run.pipeline_name.clone(),
        workspace_local_id: run.workspace_local_id.clone(),
        worktree_local_id: run.worktree_local_id.clone(),
        status: run.status.clone(),
        started_at: run.started_at.clone(),
        finished_at: run.finished_at.clone(),
        parent_execution_id: run.parent_execution_id.clone(),
        trigger_source: run.trigger_source.clone(),
        hidden: run.hidden,
        truncated: run.truncated,
        output_tail: run.output_tail.clone(),
        progress: run.progress.as_ref().map(|p| PipelineProgressView {
            completed_steps: p.completed_steps,
            total_steps: p.total_steps,
        }),
        status_reasons: run
            .status_reasons
            .iter()
            .map(|r| PipelineStatusReasonView {
                id: r.id.clone(),
                kind: r.kind.clone(),
                code: r.code.clone(),
                provider: r.provider.clone(),
                resets_at: r.resets_at.clone(),
            })
            .collect(),
        pending_pauses: run
            .pending_pauses
            .iter()
            .map(|p| PipelinePauseView {
                id: p.id.clone(),
                kind: p.kind.clone(),
                job_id: p.job_id.clone(),
                step_id: p.step_id.clone(),
                title: p.title.clone(),
                message: p.message.clone(),
                field_labels: p.field_labels.clone(),
            })
            .collect(),
        jobs: run.jobs.as_ref().map(|jobs| {
            jobs.iter()
                .map(|j| PipelineJobView {
                    job_id: j.job_id.clone(),
                    name: j.name.clone(),
                    status: j.status.clone(),
                    needs: j.needs.clone(),
                    steps: j.steps.iter().map(step_view).collect(),
                    variants: j
                        .variants
                        .iter()
                        .map(|v| PipelineVariantView {
                            job_id: v.job_id.clone(),
                            name: v.name.clone(),
                            status: v.status.clone(),
                            steps: v.steps.iter().map(step_view).collect(),
                        })
                        .collect(),
                    expansion: j.expansion.clone(),
                    expansion_error: j.expansion_error.clone(),
                })
                .collect()
        }),
        chat_turns: run.chat_turns.as_ref().map(|turns| {
            turns
                .iter()
                .map(|t| PipelineChatTurnView {
                    chat_id: t.chat_id.clone(),
                    user_message_id: t.user_message_id.clone(),
                    relation: t.relation.clone(),
                })
                .collect()
        }),
        chat_follow_up: run.chat_follow_up.map(|f| PipelineFollowUpView {
            plan_available: f.plan_available,
            report_available: f.report_available,
        }),
        display: display_view(run),
    }
}

fn number_view(n: Number) -> PipelineNumberView {
    PipelineNumberView {
        value: n.value,
        integer: n.integer,
    }
}

fn input_view(i: &InputDefinition) -> PipelineInputView {
    PipelineInputView {
        name: i.name.clone(),
        description: i.description.clone(),
        required: i.required,
        default_value: i.default_value.clone(),
        input_type: match i.input_type {
            InputType::String => PipelineInputType::String,
            InputType::Boolean => PipelineInputType::Boolean,
            InputType::Number => PipelineInputType::Number,
            InputType::Choice => PipelineInputType::Choice,
        },
        options: i.options.clone(),
        min: i.min.map(number_view),
        max: i.max.map(number_view),
        hide_in_ui: i.hide_in_ui,
    }
}

fn input(v: &PipelineInputView) -> InputDefinition {
    InputDefinition {
        name: v.name.clone(),
        description: v.description.clone(),
        required: v.required,
        default_value: v.default_value.clone(),
        input_type: match v.input_type {
            PipelineInputType::String => InputType::String,
            PipelineInputType::Boolean => InputType::Boolean,
            PipelineInputType::Number => InputType::Number,
            PipelineInputType::Choice => InputType::Choice,
        },
        options: v.options.clone(),
        min: v.min.map(|n| Number {
            value: n.value,
            integer: n.integer,
        }),
        max: v.max.map(|n| Number {
            value: n.value,
            integer: n.integer,
        }),
        hide_in_ui: v.hide_in_ui,
    }
}

fn form_view(form: &DispatchForm) -> DispatchFormView {
    DispatchFormView {
        inputs: form.inputs.iter().map(input_view).collect(),
        inputs_omitted: form.inputs_omitted,
        unsupported_reason: form.unsupported_reason.clone(),
        can_dispatch: form.can_dispatch(),
    }
}

fn scope_view(revision: u64, shown: &ScopeShown) -> PipelineScopeView {
    let notes = |rows: &[(String, String)]| {
        rows.iter()
            .map(|(id, message)| PipelineRunNoteView {
                id: id.clone(),
                message: message.clone(),
            })
            .collect()
    };
    PipelineScopeView {
        revision,
        runs: shown.runs.iter().map(|r| run_view(r)).collect(),
        hidden_runs: shown.hidden.iter().map(|r| run_view(r)).collect(),
        pipelines: shown
            .pipelines
            .iter()
            .map(|d| PipelineDescriptorView {
                pipeline_id: d.pipeline_id.clone(),
                name: d.name.clone(),
                description: d.description.clone(),
                origin: origin_view(d.origin),
                trigger_types: d.trigger_types.clone(),
                scopes: d.scopes.clone(),
            })
            .collect(),
        error: shown.error.clone(),
        run_errors: notes(&shown.run_errors),
        action_errors: notes(&shown.action_errors),
        pending: shown.pending.clone(),
        controls: shown
            .actions
            .iter()
            .map(|(id, a)| PipelineControlView {
                id: id.clone(),
                action: control_view(*a),
            })
            .collect(),
    }
}

fn group_view(g: Group) -> WorkGroup {
    match g {
        Group::NeedsYou => WorkGroup::NeedsYou,
        Group::Queued => WorkGroup::Queued,
        Group::Running => WorkGroup::Running,
        Group::PullRequests => WorkGroup::PullRequests,
        Group::Watching => WorkGroup::Watching,
    }
}

fn item_view(i: &work::WorkItem) -> WorkItemView {
    WorkItemView {
        id: i.id.clone(),
        group: group_view(i.group),
        kind: match i.kind {
            Kind::Agent => WorkKind::Agent,
            Kind::Command => WorkKind::Command,
            Kind::Workflow => WorkKind::Workflow,
            Kind::Task => WorkKind::Task,
            Kind::Pipeline => WorkKind::Pipeline,
            Kind::Github => WorkKind::Github,
            Kind::PullRequest => WorkKind::PullRequest,
            Kind::Watcher => WorkKind::Watcher,
            Kind::Message => WorkKind::Message,
        },
        title: i.title.clone(),
        subtitle: i.subtitle.clone(),
        status: i.status.clone(),
        tone: match i.tone {
            Tone::Neutral => WorkTone::Neutral,
            Tone::Running => WorkTone::Running,
            Tone::Attention => WorkTone::Attention,
            Tone::Success => WorkTone::Success,
            Tone::Failed => WorkTone::Failed,
            Tone::Merged => WorkTone::Merged,
            Tone::Info => WorkTone::Info,
        },
        details: i
            .details
            .iter()
            .map(|(label, value)| WorkDetailView {
                label: label.clone(),
                value: value.clone(),
            })
            .collect(),
        action: i.action.map(action_view),
        action_id: i.action_id.clone(),
        url: i.url.clone(),
        pipeline_id: i.pipeline_id.clone(),
        watcher_count: i.watcher_count,
        count: i.count,
        finished: i.finished,
        extra_actions: i.extra_actions.iter().copied().map(action_view).collect(),
        action_labels: i
            .action_labels
            .iter()
            .map(|(a, label)| WorkActionLabelView {
                action: action_view(*a),
                label: label.clone(),
            })
            .collect(),
    }
}

/// The drawer as it shows: counts, visibility and summary computed here
/// (`WorkDrawerState`).
fn drawer_view(revision: u64, shown: &DrawerShown) -> WorkDrawerView {
    let counts: Vec<WorkGroupCountView> = Group::ALL
        .iter()
        .map(|g| WorkGroupCountView {
            group: group_view(*g),
            count: work::count(&shown.items, *g),
        })
        .collect();
    let summary = [
        Group::Queued,
        Group::Running,
        Group::PullRequests,
        Group::Watching,
        Group::NeedsYou,
    ]
    .iter()
    .filter_map(|g| {
        let count = work::count(&shown.items, *g);
        (count > 0).then(|| format!("{} {count}", work_copy::group_label(*g)))
    })
    .collect::<Vec<_>>()
    .join(" | ");
    WorkDrawerView {
        revision,
        chat_key: shown.chat.clone(),
        items: shown.items.iter().map(item_view).collect(),
        errors: shown.errors.clone(),
        busy: shown.busy.clone(),
        visible: work::visible(&shown.items),
        summary,
        counts,
    }
}

fn activity_view(revision: u64, shown: &FollowShown) -> ChatActivityView {
    ChatActivityView {
        revision,
        turns: shown
            .turns
            .iter()
            .map(|t| PipelineTurnView {
                turn: t.turn.clone(),
                runs: t.runs.iter().map(run_view).collect(),
            })
            .collect(),
        latest: shown.latest.clone(),
    }
}

impl PipelinesService {
    pub(crate) fn new(inner: Arc<CoreInner>, handle: Handle) -> Self {
        Self {
            inner,
            handle,
            tickets: Arc::default(),
        }
    }
    /// The worktree's view now, then on every change.
    pub fn watch(&self, project_id: String, worktree_id: String) -> PipelineScopeViews {
        PipelineScopeViews {
            view: self.handle.view(),
            scope: scope_key(&project_id, &worktree_id),
            last: None,
        }
    }
    /// The follower `token`'s turn panels now, then on every change,
    /// until it is unfollowed.
    pub fn watch_chat_activity(&self, token: u64) -> ChatActivityViews {
        ChatActivityViews {
            view: self.handle.view(),
            end: self.handle.follower_end(token),
            token,
            last: None,
        }
    }
    /// The drawer `token` now, then on every change, until it is closed.
    pub fn watch_drawer(&self, token: u64) -> WorkDrawerViews {
        WorkDrawerViews {
            view: self.handle.view(),
            end: self.handle.drawer_end(token),
            token,
            last: None,
        }
    }
    /// Queues `intent`; its outcome is not reported.
    pub fn send(&self, intent: PipelinesIntent) {
        let _ = self.handle.send(self::intent(intent), None);
    }
    /// Queues `intent` and returns the ticket [`Self::settled`] takes.
    pub fn request(&self, intent: PipelinesIntent) -> u64 {
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
    pub async fn settled(&self, ticket: u64) -> Result<PipelinesSettled, CoreFailure> {
        let rx = self
            .tickets
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .1
            .remove(&ticket);
        let outcome = self.inner.ticket(self.handle.scope(), rx).await?;
        let settled = |outcome| PipelinesSettled {
            failure: None,
            outcome: Some(outcome),
        };
        Ok(match outcome {
            Outcome::Done => PipelinesSettled {
                failure: None,
                outcome: None,
            },
            Outcome::Failed(f) => PipelinesSettled {
                failure: Some(PipelineFailure {
                    message: f.message,
                    kind: match f.kind {
                        FailureKind::Remote => PipelineFailureKind::Remote,
                        FailureKind::Link => PipelineFailureKind::Link,
                        FailureKind::Other => PipelineFailureKind::Other,
                    },
                }),
                outcome: None,
            },
            Outcome::Run(run) => settled(PipelinesOutcome::Run {
                run: run.as_deref().map(run_view),
            }),
            Outcome::Form(form) => settled(PipelinesOutcome::Form {
                form: form_view(&form),
            }),
            Outcome::Started(id) => settled(PipelinesOutcome::Started { id }),
            Outcome::Content(Document { markdown, text }) => settled(PipelinesOutcome::Content {
                chunks: if cc_domain::chat::trim(&text).is_empty() {
                    Vec::new()
                } else {
                    presentation::content_chunks(markdown, &text)
                        .into_iter()
                        .map(|(markdown, text)| PipelineContentChunkView { markdown, text })
                        .collect()
                },
            }),
        })
    }
    /// The dispatch form's rules over `values`: the inputs shown, the
    /// initial values, the errors and the payload a start sends.
    pub fn form_rules(
        &self,
        form: DispatchFormView,
        values: Vec<PipelineInputValue>,
    ) -> FormRulesView {
        let inputs: Vec<InputDefinition> = form.inputs.iter().map(input).collect();
        let values: Vec<(String, String)> = values.into_iter().map(|v| (v.name, v.value)).collect();
        let pair = |(name, value)| PipelineInputValue { name, value };
        let visible = visible_inputs(&inputs);
        let displayed: Vec<InputDefinition> = visible.iter().map(|&i| inputs[i].clone()).collect();
        FormRulesView {
            visible: visible
                .into_iter()
                .map(|i| u32::try_from(i).unwrap_or(u32::MAX))
                .collect(),
            initial: initial_values(&inputs).into_iter().map(pair).collect(),
            errors: validate(&displayed, &values)
                .into_iter()
                .map(|(name, error)| PipelineInputErrorView {
                    name,
                    message: copy::input_error(&error),
                })
                .collect(),
            payload: payload(&displayed, &values).into_iter().map(pair).collect(),
        }
    }
}

/// A [`PipelinesService::watch`] stream.
pub struct PipelineScopeViews {
    view: View<Published>,
    scope: String,
    last: Option<Arc<ScopeShown>>,
}

impl PipelineScopeViews {
    /// The next changed view; `None` once the pipelines stopped.
    pub async fn next(&mut self) -> Option<PipelineScopeView> {
        loop {
            if self.last.is_some() {
                self.view.changed().await.ok()?;
            }
            let published = self.view.latest()?;
            let shown = published
                .scopes
                .get(&self.scope)
                .cloned()
                .unwrap_or_default();
            if self
                .last
                .as_ref()
                .is_some_and(|last| Arc::ptr_eq(last, &shown) || **last == *shown)
            {
                continue;
            }
            self.last = Some(shown.clone());
            return Some(scope_view(published.revision, &shown));
        }
    }
}

/// A [`PipelinesService::watch_chat_activity`] stream.
pub struct ChatActivityViews {
    view: View<Published>,
    end: End,
    token: u64,
    last: Option<Arc<FollowShown>>,
}

impl ChatActivityViews {
    /// The next changed view; `None` once the follower was unfollowed or
    /// the pipelines stopped.
    pub async fn next(&mut self) -> Option<ChatActivityView> {
        loop {
            if self.last.is_some() {
                self.end.or_changed(&mut self.view).await?;
            } else if self.end.reached() {
                return None;
            }
            let published = self.view.latest()?;
            let shown = published
                .follows
                .get(&self.token)
                .cloned()
                .unwrap_or_default();
            if self
                .last
                .as_ref()
                .is_some_and(|last| Arc::ptr_eq(last, &shown) || **last == *shown)
            {
                continue;
            }
            self.last = Some(shown.clone());
            return Some(activity_view(published.revision, &shown));
        }
    }
}

/// A [`PipelinesService::watch_drawer`] stream.
pub struct WorkDrawerViews {
    view: View<Published>,
    end: End,
    token: u64,
    last: Option<Arc<DrawerShown>>,
}

impl WorkDrawerViews {
    /// The next changed view; `None` once the drawer was closed or the
    /// pipelines stopped.
    pub async fn next(&mut self) -> Option<WorkDrawerView> {
        loop {
            if self.last.is_some() {
                self.end.or_changed(&mut self.view).await?;
            } else if self.end.reached() {
                return None;
            }
            let published = self.view.latest()?;
            let shown = published
                .drawers
                .get(&self.token)
                .cloned()
                .unwrap_or_default();
            if self
                .last
                .as_ref()
                .is_some_and(|last| Arc::ptr_eq(last, &shown) || **last == *shown)
            {
                continue;
            }
            self.last = Some(shown.clone());
            return Some(drawer_view(published.revision, &shown));
        }
    }
}

//! One computer's pipelines and composer work drawers (P7): each
//! worktree's runs with their display facts, dispatchable pipelines,
//! errors and controls in flight; a chat feed's run panels; and each
//! mounted chat's work drawer. [`PipelinesService::watch`] streams one
//! worktree, [`PipelinesService::watch_chat_activity`] one follower and
//! [`PipelinesService::watch_drawer`] one drawer; intents are queued in
//! call order and each variant of [`PipelinesIntent`] says when it
//! settles.
use super::{core::CoreFailure, handler, overview::ChatRefView};
use crate::frb_generated::StreamSink;
use flutter_rust_bridge::frb;

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

impl From<cc_core::PipelineOrigin> for PipelineOrigin {
    fn from(v: cc_core::PipelineOrigin) -> Self {
        match v {
            cc_core::PipelineOrigin::Bundled => Self::Bundled,
            cc_core::PipelineOrigin::User => Self::User,
            cc_core::PipelineOrigin::Project => Self::Project,
            cc_core::PipelineOrigin::Shared => Self::Shared,
            cc_core::PipelineOrigin::Curated => Self::Curated,
        }
    }
}

impl From<PipelineOrigin> for cc_core::PipelineOrigin {
    fn from(v: PipelineOrigin) -> Self {
        match v {
            PipelineOrigin::Bundled => Self::Bundled,
            PipelineOrigin::User => Self::User,
            PipelineOrigin::Project => Self::Project,
            PipelineOrigin::Shared => Self::Shared,
            PipelineOrigin::Curated => Self::Curated,
        }
    }
}

impl From<cc_core::PipelineAction> for PipelineAction {
    fn from(v: cc_core::PipelineAction) -> Self {
        match v {
            cc_core::PipelineAction::Cancel => Self::Cancel,
            cc_core::PipelineAction::Retry => Self::Retry,
            cc_core::PipelineAction::Resume => Self::Resume,
        }
    }
}

impl From<PipelineAction> for cc_core::PipelineAction {
    fn from(v: PipelineAction) -> Self {
        match v {
            PipelineAction::Cancel => Self::Cancel,
            PipelineAction::Retry => Self::Retry,
            PipelineAction::Resume => Self::Resume,
        }
    }
}

impl From<cc_core::PipelineContentSource> for PipelineContentSource {
    fn from(v: cc_core::PipelineContentSource) -> Self {
        match v {
            cc_core::PipelineContentSource::StepOutput { job_id, step_id } => {
                Self::StepOutput { job_id, step_id }
            }
            cc_core::PipelineContentSource::Report => Self::Report,
        }
    }
}

impl From<PipelineContentSource> for cc_core::PipelineContentSource {
    fn from(v: PipelineContentSource) -> Self {
        match v {
            PipelineContentSource::StepOutput { job_id, step_id } => {
                Self::StepOutput { job_id, step_id }
            }
            PipelineContentSource::Report => Self::Report,
        }
    }
}

impl From<cc_core::PipelineInputValue> for PipelineInputValue {
    fn from(v: cc_core::PipelineInputValue) -> Self {
        Self {
            name: v.name,
            value: v.value,
        }
    }
}

impl From<PipelineInputValue> for cc_core::PipelineInputValue {
    fn from(v: PipelineInputValue) -> Self {
        Self {
            name: v.name,
            value: v.value,
        }
    }
}

impl From<cc_core::WorkAction> for WorkAction {
    fn from(v: cc_core::WorkAction) -> Self {
        match v {
            cc_core::WorkAction::StopTask => Self::StopTask,
            cc_core::WorkAction::StopDelegate => Self::StopDelegate,
            cc_core::WorkAction::StopDelegates => Self::StopDelegates,
            cc_core::WorkAction::DeleteWatcher => Self::DeleteWatcher,
            cc_core::WorkAction::CancelQueued => Self::CancelQueued,
            cc_core::WorkAction::ForceQueued => Self::ForceQueued,
            cc_core::WorkAction::SteerQueued => Self::SteerQueued,
        }
    }
}

impl From<WorkAction> for cc_core::WorkAction {
    fn from(v: WorkAction) -> Self {
        match v {
            WorkAction::StopTask => Self::StopTask,
            WorkAction::StopDelegate => Self::StopDelegate,
            WorkAction::StopDelegates => Self::StopDelegates,
            WorkAction::DeleteWatcher => Self::DeleteWatcher,
            WorkAction::CancelQueued => Self::CancelQueued,
            WorkAction::ForceQueued => Self::ForceQueued,
            WorkAction::SteerQueued => Self::SteerQueued,
        }
    }
}

impl From<cc_core::PipelinesIntent> for PipelinesIntent {
    fn from(v: cc_core::PipelinesIntent) -> Self {
        match v {
            cc_core::PipelinesIntent::SetConnected { connected } => {
                Self::SetConnected { connected }
            }
            cc_core::PipelinesIntent::Watch { chat, token } => Self::Watch {
                chat: chat.into(),
                token,
            },
            cc_core::PipelinesIntent::Release { token } => Self::Release { token },
            cc_core::PipelinesIntent::Load { chat } => Self::Load { chat: chat.into() },
            cc_core::PipelinesIntent::Get { chat, id } => Self::Get {
                chat: chat.into(),
                id,
            },
            cc_core::PipelinesIntent::Log {
                chat,
                id,
                job_id,
                step_id,
            } => Self::Log {
                chat: chat.into(),
                id,
                job_id,
                step_id,
            },
            cc_core::PipelinesIntent::ClearLogSelection { chat, id } => Self::ClearLogSelection {
                chat: chat.into(),
                id,
            },
            cc_core::PipelinesIntent::Control { chat, id, action } => Self::Control {
                chat: chat.into(),
                id,
                action: action.into(),
            },
            cc_core::PipelinesIntent::ClearActionError { chat, id } => Self::ClearActionError {
                chat: chat.into(),
                id,
            },
            cc_core::PipelinesIntent::Form {
                chat,
                pipeline_id,
                origin,
            } => Self::Form {
                chat: chat.into(),
                pipeline_id,
                origin: origin.into(),
            },
            cc_core::PipelinesIntent::Start {
                chat,
                pipeline_id,
                origin,
                inputs,
            } => Self::Start {
                chat: chat.into(),
                pipeline_id,
                origin: origin.into(),
                inputs: inputs.into_iter().map(Into::into).collect(),
            },
            cc_core::PipelinesIntent::Content { chat, id, source } => Self::Content {
                chat: chat.into(),
                id,
                source: source.into(),
            },
            cc_core::PipelinesIntent::Follow {
                token,
                chat,
                online,
            } => Self::Follow {
                token,
                chat: chat.map(Into::into),
                online,
            },
            cc_core::PipelinesIntent::Unfollow { token } => Self::Unfollow { token },
            cc_core::PipelinesIntent::DrawerUpdate {
                token,
                chat,
                online,
                ready,
            } => Self::DrawerUpdate {
                token,
                chat: chat.into(),
                online,
                ready,
            },
            cc_core::PipelinesIntent::DrawerRetry { token } => Self::DrawerRetry { token },
            cc_core::PipelinesIntent::DrawerAct {
                token,
                item_id,
                action,
                notify_subscriber,
            } => Self::DrawerAct {
                token,
                item_id,
                action: action.into(),
                notify_subscriber,
            },
            cc_core::PipelinesIntent::DrawerClose { token } => Self::DrawerClose { token },
            cc_core::PipelinesIntent::Close => Self::Close,
        }
    }
}

impl From<PipelinesIntent> for cc_core::PipelinesIntent {
    fn from(v: PipelinesIntent) -> Self {
        match v {
            PipelinesIntent::SetConnected { connected } => Self::SetConnected { connected },
            PipelinesIntent::Watch { chat, token } => Self::Watch {
                chat: chat.into(),
                token,
            },
            PipelinesIntent::Release { token } => Self::Release { token },
            PipelinesIntent::Load { chat } => Self::Load { chat: chat.into() },
            PipelinesIntent::Get { chat, id } => Self::Get {
                chat: chat.into(),
                id,
            },
            PipelinesIntent::Log {
                chat,
                id,
                job_id,
                step_id,
            } => Self::Log {
                chat: chat.into(),
                id,
                job_id,
                step_id,
            },
            PipelinesIntent::ClearLogSelection { chat, id } => Self::ClearLogSelection {
                chat: chat.into(),
                id,
            },
            PipelinesIntent::Control { chat, id, action } => Self::Control {
                chat: chat.into(),
                id,
                action: action.into(),
            },
            PipelinesIntent::ClearActionError { chat, id } => Self::ClearActionError {
                chat: chat.into(),
                id,
            },
            PipelinesIntent::Form {
                chat,
                pipeline_id,
                origin,
            } => Self::Form {
                chat: chat.into(),
                pipeline_id,
                origin: origin.into(),
            },
            PipelinesIntent::Start {
                chat,
                pipeline_id,
                origin,
                inputs,
            } => Self::Start {
                chat: chat.into(),
                pipeline_id,
                origin: origin.into(),
                inputs: inputs.into_iter().map(Into::into).collect(),
            },
            PipelinesIntent::Content { chat, id, source } => Self::Content {
                chat: chat.into(),
                id,
                source: source.into(),
            },
            PipelinesIntent::Follow {
                token,
                chat,
                online,
            } => Self::Follow {
                token,
                chat: chat.map(Into::into),
                online,
            },
            PipelinesIntent::Unfollow { token } => Self::Unfollow { token },
            PipelinesIntent::DrawerUpdate {
                token,
                chat,
                online,
                ready,
            } => Self::DrawerUpdate {
                token,
                chat: chat.into(),
                online,
                ready,
            },
            PipelinesIntent::DrawerRetry { token } => Self::DrawerRetry { token },
            PipelinesIntent::DrawerAct {
                token,
                item_id,
                action,
                notify_subscriber,
            } => Self::DrawerAct {
                token,
                item_id,
                action: action.into(),
                notify_subscriber,
            },
            PipelinesIntent::DrawerClose { token } => Self::DrawerClose { token },
            PipelinesIntent::Close => Self::Close,
        }
    }
}

impl From<cc_core::PipelineFailureKind> for PipelineFailureKind {
    fn from(v: cc_core::PipelineFailureKind) -> Self {
        match v {
            cc_core::PipelineFailureKind::Remote => Self::Remote,
            cc_core::PipelineFailureKind::Link => Self::Link,
            cc_core::PipelineFailureKind::Other => Self::Other,
        }
    }
}

impl From<PipelineFailureKind> for cc_core::PipelineFailureKind {
    fn from(v: PipelineFailureKind) -> Self {
        match v {
            PipelineFailureKind::Remote => Self::Remote,
            PipelineFailureKind::Link => Self::Link,
            PipelineFailureKind::Other => Self::Other,
        }
    }
}

impl From<cc_core::PipelineFailure> for PipelineFailure {
    fn from(v: cc_core::PipelineFailure) -> Self {
        Self {
            message: v.message,
            kind: v.kind.into(),
        }
    }
}

impl From<PipelineFailure> for cc_core::PipelineFailure {
    fn from(v: PipelineFailure) -> Self {
        Self {
            message: v.message,
            kind: v.kind.into(),
        }
    }
}

impl From<cc_core::PipelinesOutcome> for PipelinesOutcome {
    fn from(v: cc_core::PipelinesOutcome) -> Self {
        match v {
            cc_core::PipelinesOutcome::Run { run } => Self::Run {
                run: run.map(Into::into),
            },
            cc_core::PipelinesOutcome::Form { form } => Self::Form { form: form.into() },
            cc_core::PipelinesOutcome::Started { id } => Self::Started { id },
            cc_core::PipelinesOutcome::Content { chunks } => Self::Content {
                chunks: chunks.into_iter().map(Into::into).collect(),
            },
        }
    }
}

impl From<PipelinesOutcome> for cc_core::PipelinesOutcome {
    fn from(v: PipelinesOutcome) -> Self {
        match v {
            PipelinesOutcome::Run { run } => Self::Run {
                run: run.map(Into::into),
            },
            PipelinesOutcome::Form { form } => Self::Form { form: form.into() },
            PipelinesOutcome::Started { id } => Self::Started { id },
            PipelinesOutcome::Content { chunks } => Self::Content {
                chunks: chunks.into_iter().map(Into::into).collect(),
            },
        }
    }
}

impl From<cc_core::PipelinesSettled> for PipelinesSettled {
    fn from(v: cc_core::PipelinesSettled) -> Self {
        Self {
            failure: v.failure.map(Into::into),
            outcome: v.outcome.map(Into::into),
        }
    }
}

impl From<PipelinesSettled> for cc_core::PipelinesSettled {
    fn from(v: PipelinesSettled) -> Self {
        Self {
            failure: v.failure.map(Into::into),
            outcome: v.outcome.map(Into::into),
        }
    }
}

impl From<cc_core::PipelineProgressView> for PipelineProgressView {
    fn from(v: cc_core::PipelineProgressView) -> Self {
        Self {
            completed_steps: v.completed_steps,
            total_steps: v.total_steps,
        }
    }
}

impl From<PipelineProgressView> for cc_core::PipelineProgressView {
    fn from(v: PipelineProgressView) -> Self {
        Self {
            completed_steps: v.completed_steps,
            total_steps: v.total_steps,
        }
    }
}

impl From<cc_core::PipelineStepView> for PipelineStepView {
    fn from(v: cc_core::PipelineStepView) -> Self {
        Self {
            step_id: v.step_id,
            name: v.name,
            status: v.status,
            attempt: v.attempt,
            iteration: v.iteration,
            recovery: v.recovery,
            output_tail: v.output_tail,
        }
    }
}

impl From<PipelineStepView> for cc_core::PipelineStepView {
    fn from(v: PipelineStepView) -> Self {
        Self {
            step_id: v.step_id,
            name: v.name,
            status: v.status,
            attempt: v.attempt,
            iteration: v.iteration,
            recovery: v.recovery,
            output_tail: v.output_tail,
        }
    }
}

impl From<cc_core::PipelineVariantView> for PipelineVariantView {
    fn from(v: cc_core::PipelineVariantView) -> Self {
        Self {
            job_id: v.job_id,
            name: v.name,
            status: v.status,
            steps: v.steps.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<PipelineVariantView> for cc_core::PipelineVariantView {
    fn from(v: PipelineVariantView) -> Self {
        Self {
            job_id: v.job_id,
            name: v.name,
            status: v.status,
            steps: v.steps.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::PipelineJobView> for PipelineJobView {
    fn from(v: cc_core::PipelineJobView) -> Self {
        Self {
            job_id: v.job_id,
            name: v.name,
            status: v.status,
            needs: v.needs,
            steps: v.steps.into_iter().map(Into::into).collect(),
            variants: v.variants.into_iter().map(Into::into).collect(),
            expansion: v.expansion,
            expansion_error: v.expansion_error,
        }
    }
}

impl From<PipelineJobView> for cc_core::PipelineJobView {
    fn from(v: PipelineJobView) -> Self {
        Self {
            job_id: v.job_id,
            name: v.name,
            status: v.status,
            needs: v.needs,
            steps: v.steps.into_iter().map(Into::into).collect(),
            variants: v.variants.into_iter().map(Into::into).collect(),
            expansion: v.expansion,
            expansion_error: v.expansion_error,
        }
    }
}

impl From<cc_core::PipelineStatusReasonView> for PipelineStatusReasonView {
    fn from(v: cc_core::PipelineStatusReasonView) -> Self {
        Self {
            id: v.id,
            kind: v.kind,
            code: v.code,
            provider: v.provider,
            resets_at: v.resets_at,
        }
    }
}

impl From<PipelineStatusReasonView> for cc_core::PipelineStatusReasonView {
    fn from(v: PipelineStatusReasonView) -> Self {
        Self {
            id: v.id,
            kind: v.kind,
            code: v.code,
            provider: v.provider,
            resets_at: v.resets_at,
        }
    }
}

impl From<cc_core::PipelinePauseView> for PipelinePauseView {
    fn from(v: cc_core::PipelinePauseView) -> Self {
        Self {
            id: v.id,
            kind: v.kind,
            job_id: v.job_id,
            step_id: v.step_id,
            title: v.title,
            message: v.message,
            field_labels: v.field_labels,
        }
    }
}

impl From<PipelinePauseView> for cc_core::PipelinePauseView {
    fn from(v: PipelinePauseView) -> Self {
        Self {
            id: v.id,
            kind: v.kind,
            job_id: v.job_id,
            step_id: v.step_id,
            title: v.title,
            message: v.message,
            field_labels: v.field_labels,
        }
    }
}

impl From<cc_core::PipelineChatTurnView> for PipelineChatTurnView {
    fn from(v: cc_core::PipelineChatTurnView) -> Self {
        Self {
            chat_id: v.chat_id,
            user_message_id: v.user_message_id,
            relation: v.relation,
        }
    }
}

impl From<PipelineChatTurnView> for cc_core::PipelineChatTurnView {
    fn from(v: PipelineChatTurnView) -> Self {
        Self {
            chat_id: v.chat_id,
            user_message_id: v.user_message_id,
            relation: v.relation,
        }
    }
}

impl From<cc_core::PipelineFollowUpView> for PipelineFollowUpView {
    fn from(v: cc_core::PipelineFollowUpView) -> Self {
        Self {
            plan_available: v.plan_available,
            report_available: v.report_available,
        }
    }
}

impl From<PipelineFollowUpView> for cc_core::PipelineFollowUpView {
    fn from(v: PipelineFollowUpView) -> Self {
        Self {
            plan_available: v.plan_available,
            report_available: v.report_available,
        }
    }
}

impl From<cc_core::PipelineGroupStepView> for PipelineGroupStepView {
    fn from(v: cc_core::PipelineGroupStepView) -> Self {
        Self {
            job_id: v.job_id,
            step_id: v.step_id,
            status_label: v.status_label,
        }
    }
}

impl From<PipelineGroupStepView> for cc_core::PipelineGroupStepView {
    fn from(v: PipelineGroupStepView) -> Self {
        Self {
            job_id: v.job_id,
            step_id: v.step_id,
            status_label: v.status_label,
        }
    }
}

impl From<cc_core::PipelineGroupView> for PipelineGroupView {
    fn from(v: cc_core::PipelineGroupView) -> Self {
        Self {
            job_id: v.job_id,
            name: v.name,
            status: v.status,
            status_label: v.status_label,
            depth: v.depth,
            is_variant: v.is_variant,
            steps: v.steps.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<PipelineGroupView> for cc_core::PipelineGroupView {
    fn from(v: PipelineGroupView) -> Self {
        Self {
            job_id: v.job_id,
            name: v.name,
            status: v.status,
            status_label: v.status_label,
            depth: v.depth,
            is_variant: v.is_variant,
            steps: v.steps.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::PipelineDotStatus> for PipelineDotStatus {
    fn from(v: cc_core::PipelineDotStatus) -> Self {
        match v {
            cc_core::PipelineDotStatus::Pending => Self::Pending,
            cc_core::PipelineDotStatus::Running => Self::Running,
            cc_core::PipelineDotStatus::Success => Self::Success,
            cc_core::PipelineDotStatus::Failure => Self::Failure,
            cc_core::PipelineDotStatus::Paused => Self::Paused,
            cc_core::PipelineDotStatus::Cancelled => Self::Cancelled,
            cc_core::PipelineDotStatus::Skipped => Self::Skipped,
        }
    }
}

impl From<PipelineDotStatus> for cc_core::PipelineDotStatus {
    fn from(v: PipelineDotStatus) -> Self {
        match v {
            PipelineDotStatus::Pending => Self::Pending,
            PipelineDotStatus::Running => Self::Running,
            PipelineDotStatus::Success => Self::Success,
            PipelineDotStatus::Failure => Self::Failure,
            PipelineDotStatus::Paused => Self::Paused,
            PipelineDotStatus::Cancelled => Self::Cancelled,
            PipelineDotStatus::Skipped => Self::Skipped,
        }
    }
}

impl From<cc_core::PipelineDotView> for PipelineDotView {
    fn from(v: cc_core::PipelineDotView) -> Self {
        Self {
            job_id: v.job_id,
            name: v.name,
            status: v.status.into(),
        }
    }
}

impl From<PipelineDotView> for cc_core::PipelineDotView {
    fn from(v: PipelineDotView) -> Self {
        Self {
            job_id: v.job_id,
            name: v.name,
            status: v.status.into(),
        }
    }
}

impl From<cc_core::PipelineTierView> for PipelineTierView {
    fn from(v: cc_core::PipelineTierView) -> Self {
        Self {
            dots: v.dots.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<PipelineTierView> for cc_core::PipelineTierView {
    fn from(v: PipelineTierView) -> Self {
        Self {
            dots: v.dots.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::PipelineRunDisplayView> for PipelineRunDisplayView {
    fn from(v: cc_core::PipelineRunDisplayView) -> Self {
        Self {
            status_label: v.status_label,
            trigger_label: v.trigger_label,
            can_cancel: v.can_cancel,
            can_resume: v.can_resume,
            can_retry: v.can_retry,
            groups: v.groups.into_iter().map(Into::into).collect(),
            tiers: v.tiers.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<PipelineRunDisplayView> for cc_core::PipelineRunDisplayView {
    fn from(v: PipelineRunDisplayView) -> Self {
        Self {
            status_label: v.status_label,
            trigger_label: v.trigger_label,
            can_cancel: v.can_cancel,
            can_resume: v.can_resume,
            can_retry: v.can_retry,
            groups: v.groups.into_iter().map(Into::into).collect(),
            tiers: v.tiers.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::PipelineRunView> for PipelineRunView {
    fn from(v: cc_core::PipelineRunView) -> Self {
        Self {
            local_id: v.local_id,
            pipeline_id: v.pipeline_id,
            pipeline_name: v.pipeline_name,
            workspace_local_id: v.workspace_local_id,
            worktree_local_id: v.worktree_local_id,
            status: v.status,
            started_at: v.started_at,
            finished_at: v.finished_at,
            parent_execution_id: v.parent_execution_id,
            trigger_source: v.trigger_source,
            hidden: v.hidden,
            truncated: v.truncated,
            output_tail: v.output_tail,
            progress: v.progress.map(Into::into),
            status_reasons: v.status_reasons.into_iter().map(Into::into).collect(),
            pending_pauses: v.pending_pauses.into_iter().map(Into::into).collect(),
            jobs: v.jobs.map(|x| x.into_iter().map(Into::into).collect()),
            chat_turns: v
                .chat_turns
                .map(|x| x.into_iter().map(Into::into).collect()),
            chat_follow_up: v.chat_follow_up.map(Into::into),
            display: v.display.into(),
        }
    }
}

impl From<PipelineRunView> for cc_core::PipelineRunView {
    fn from(v: PipelineRunView) -> Self {
        Self {
            local_id: v.local_id,
            pipeline_id: v.pipeline_id,
            pipeline_name: v.pipeline_name,
            workspace_local_id: v.workspace_local_id,
            worktree_local_id: v.worktree_local_id,
            status: v.status,
            started_at: v.started_at,
            finished_at: v.finished_at,
            parent_execution_id: v.parent_execution_id,
            trigger_source: v.trigger_source,
            hidden: v.hidden,
            truncated: v.truncated,
            output_tail: v.output_tail,
            progress: v.progress.map(Into::into),
            status_reasons: v.status_reasons.into_iter().map(Into::into).collect(),
            pending_pauses: v.pending_pauses.into_iter().map(Into::into).collect(),
            jobs: v.jobs.map(|x| x.into_iter().map(Into::into).collect()),
            chat_turns: v
                .chat_turns
                .map(|x| x.into_iter().map(Into::into).collect()),
            chat_follow_up: v.chat_follow_up.map(Into::into),
            display: v.display.into(),
        }
    }
}

impl From<cc_core::PipelineDescriptorView> for PipelineDescriptorView {
    fn from(v: cc_core::PipelineDescriptorView) -> Self {
        Self {
            pipeline_id: v.pipeline_id,
            name: v.name,
            description: v.description,
            origin: v.origin.into(),
            trigger_types: v.trigger_types,
            scopes: v.scopes,
        }
    }
}

impl From<PipelineDescriptorView> for cc_core::PipelineDescriptorView {
    fn from(v: PipelineDescriptorView) -> Self {
        Self {
            pipeline_id: v.pipeline_id,
            name: v.name,
            description: v.description,
            origin: v.origin.into(),
            trigger_types: v.trigger_types,
            scopes: v.scopes,
        }
    }
}

impl From<cc_core::PipelineInputType> for PipelineInputType {
    fn from(v: cc_core::PipelineInputType) -> Self {
        match v {
            cc_core::PipelineInputType::String => Self::String,
            cc_core::PipelineInputType::Boolean => Self::Boolean,
            cc_core::PipelineInputType::Number => Self::Number,
            cc_core::PipelineInputType::Choice => Self::Choice,
        }
    }
}

impl From<PipelineInputType> for cc_core::PipelineInputType {
    fn from(v: PipelineInputType) -> Self {
        match v {
            PipelineInputType::String => Self::String,
            PipelineInputType::Boolean => Self::Boolean,
            PipelineInputType::Number => Self::Number,
            PipelineInputType::Choice => Self::Choice,
        }
    }
}

impl From<cc_core::PipelineNumberView> for PipelineNumberView {
    fn from(v: cc_core::PipelineNumberView) -> Self {
        Self {
            value: v.value,
            integer: v.integer,
        }
    }
}

impl From<PipelineNumberView> for cc_core::PipelineNumberView {
    fn from(v: PipelineNumberView) -> Self {
        Self {
            value: v.value,
            integer: v.integer,
        }
    }
}

impl From<cc_core::PipelineInputView> for PipelineInputView {
    fn from(v: cc_core::PipelineInputView) -> Self {
        Self {
            name: v.name,
            description: v.description,
            required: v.required,
            default_value: v.default_value,
            input_type: v.input_type.into(),
            options: v.options,
            min: v.min.map(Into::into),
            max: v.max.map(Into::into),
            hide_in_ui: v.hide_in_ui,
        }
    }
}

impl From<PipelineInputView> for cc_core::PipelineInputView {
    fn from(v: PipelineInputView) -> Self {
        Self {
            name: v.name,
            description: v.description,
            required: v.required,
            default_value: v.default_value,
            input_type: v.input_type.into(),
            options: v.options,
            min: v.min.map(Into::into),
            max: v.max.map(Into::into),
            hide_in_ui: v.hide_in_ui,
        }
    }
}

impl From<cc_core::DispatchFormView> for DispatchFormView {
    fn from(v: cc_core::DispatchFormView) -> Self {
        Self {
            inputs: v.inputs.into_iter().map(Into::into).collect(),
            inputs_omitted: v.inputs_omitted,
            unsupported_reason: v.unsupported_reason,
            can_dispatch: v.can_dispatch,
        }
    }
}

impl From<DispatchFormView> for cc_core::DispatchFormView {
    fn from(v: DispatchFormView) -> Self {
        Self {
            inputs: v.inputs.into_iter().map(Into::into).collect(),
            inputs_omitted: v.inputs_omitted,
            unsupported_reason: v.unsupported_reason,
            can_dispatch: v.can_dispatch,
        }
    }
}

impl From<cc_core::PipelineInputErrorView> for PipelineInputErrorView {
    fn from(v: cc_core::PipelineInputErrorView) -> Self {
        Self {
            name: v.name,
            message: v.message,
        }
    }
}

impl From<PipelineInputErrorView> for cc_core::PipelineInputErrorView {
    fn from(v: PipelineInputErrorView) -> Self {
        Self {
            name: v.name,
            message: v.message,
        }
    }
}

impl From<cc_core::FormRulesView> for FormRulesView {
    fn from(v: cc_core::FormRulesView) -> Self {
        Self {
            visible: v.visible,
            initial: v.initial.into_iter().map(Into::into).collect(),
            errors: v.errors.into_iter().map(Into::into).collect(),
            payload: v.payload.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<FormRulesView> for cc_core::FormRulesView {
    fn from(v: FormRulesView) -> Self {
        Self {
            visible: v.visible,
            initial: v.initial.into_iter().map(Into::into).collect(),
            errors: v.errors.into_iter().map(Into::into).collect(),
            payload: v.payload.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::PipelineContentChunkView> for PipelineContentChunkView {
    fn from(v: cc_core::PipelineContentChunkView) -> Self {
        Self {
            markdown: v.markdown,
            text: v.text,
        }
    }
}

impl From<PipelineContentChunkView> for cc_core::PipelineContentChunkView {
    fn from(v: PipelineContentChunkView) -> Self {
        Self {
            markdown: v.markdown,
            text: v.text,
        }
    }
}

impl From<cc_core::PipelineRunNoteView> for PipelineRunNoteView {
    fn from(v: cc_core::PipelineRunNoteView) -> Self {
        Self {
            id: v.id,
            message: v.message,
        }
    }
}

impl From<PipelineRunNoteView> for cc_core::PipelineRunNoteView {
    fn from(v: PipelineRunNoteView) -> Self {
        Self {
            id: v.id,
            message: v.message,
        }
    }
}

impl From<cc_core::PipelineControlView> for PipelineControlView {
    fn from(v: cc_core::PipelineControlView) -> Self {
        Self {
            id: v.id,
            action: v.action.into(),
        }
    }
}

impl From<PipelineControlView> for cc_core::PipelineControlView {
    fn from(v: PipelineControlView) -> Self {
        Self {
            id: v.id,
            action: v.action.into(),
        }
    }
}

impl From<cc_core::PipelineScopeView> for PipelineScopeView {
    fn from(v: cc_core::PipelineScopeView) -> Self {
        Self {
            revision: v.revision,
            runs: v.runs.into_iter().map(Into::into).collect(),
            hidden_runs: v.hidden_runs.into_iter().map(Into::into).collect(),
            pipelines: v.pipelines.into_iter().map(Into::into).collect(),
            error: v.error,
            run_errors: v.run_errors.into_iter().map(Into::into).collect(),
            action_errors: v.action_errors.into_iter().map(Into::into).collect(),
            pending: v.pending,
            controls: v.controls.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<PipelineScopeView> for cc_core::PipelineScopeView {
    fn from(v: PipelineScopeView) -> Self {
        Self {
            revision: v.revision,
            runs: v.runs.into_iter().map(Into::into).collect(),
            hidden_runs: v.hidden_runs.into_iter().map(Into::into).collect(),
            pipelines: v.pipelines.into_iter().map(Into::into).collect(),
            error: v.error,
            run_errors: v.run_errors.into_iter().map(Into::into).collect(),
            action_errors: v.action_errors.into_iter().map(Into::into).collect(),
            pending: v.pending,
            controls: v.controls.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::PipelineTurnView> for PipelineTurnView {
    fn from(v: cc_core::PipelineTurnView) -> Self {
        Self {
            turn: v.turn,
            runs: v.runs.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<PipelineTurnView> for cc_core::PipelineTurnView {
    fn from(v: PipelineTurnView) -> Self {
        Self {
            turn: v.turn,
            runs: v.runs.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::ChatActivityView> for ChatActivityView {
    fn from(v: cc_core::ChatActivityView) -> Self {
        Self {
            revision: v.revision,
            turns: v.turns.into_iter().map(Into::into).collect(),
            latest: v.latest,
        }
    }
}

impl From<ChatActivityView> for cc_core::ChatActivityView {
    fn from(v: ChatActivityView) -> Self {
        Self {
            revision: v.revision,
            turns: v.turns.into_iter().map(Into::into).collect(),
            latest: v.latest,
        }
    }
}

impl From<cc_core::WorkGroup> for WorkGroup {
    fn from(v: cc_core::WorkGroup) -> Self {
        match v {
            cc_core::WorkGroup::NeedsYou => Self::NeedsYou,
            cc_core::WorkGroup::Queued => Self::Queued,
            cc_core::WorkGroup::Running => Self::Running,
            cc_core::WorkGroup::PullRequests => Self::PullRequests,
            cc_core::WorkGroup::Watching => Self::Watching,
        }
    }
}

impl From<WorkGroup> for cc_core::WorkGroup {
    fn from(v: WorkGroup) -> Self {
        match v {
            WorkGroup::NeedsYou => Self::NeedsYou,
            WorkGroup::Queued => Self::Queued,
            WorkGroup::Running => Self::Running,
            WorkGroup::PullRequests => Self::PullRequests,
            WorkGroup::Watching => Self::Watching,
        }
    }
}

impl From<cc_core::WorkKind> for WorkKind {
    fn from(v: cc_core::WorkKind) -> Self {
        match v {
            cc_core::WorkKind::Agent => Self::Agent,
            cc_core::WorkKind::Command => Self::Command,
            cc_core::WorkKind::Workflow => Self::Workflow,
            cc_core::WorkKind::Task => Self::Task,
            cc_core::WorkKind::Pipeline => Self::Pipeline,
            cc_core::WorkKind::Github => Self::Github,
            cc_core::WorkKind::PullRequest => Self::PullRequest,
            cc_core::WorkKind::Watcher => Self::Watcher,
            cc_core::WorkKind::Message => Self::Message,
        }
    }
}

impl From<WorkKind> for cc_core::WorkKind {
    fn from(v: WorkKind) -> Self {
        match v {
            WorkKind::Agent => Self::Agent,
            WorkKind::Command => Self::Command,
            WorkKind::Workflow => Self::Workflow,
            WorkKind::Task => Self::Task,
            WorkKind::Pipeline => Self::Pipeline,
            WorkKind::Github => Self::Github,
            WorkKind::PullRequest => Self::PullRequest,
            WorkKind::Watcher => Self::Watcher,
            WorkKind::Message => Self::Message,
        }
    }
}

impl From<cc_core::WorkTone> for WorkTone {
    fn from(v: cc_core::WorkTone) -> Self {
        match v {
            cc_core::WorkTone::Neutral => Self::Neutral,
            cc_core::WorkTone::Running => Self::Running,
            cc_core::WorkTone::Attention => Self::Attention,
            cc_core::WorkTone::Success => Self::Success,
            cc_core::WorkTone::Failed => Self::Failed,
            cc_core::WorkTone::Merged => Self::Merged,
            cc_core::WorkTone::Info => Self::Info,
        }
    }
}

impl From<WorkTone> for cc_core::WorkTone {
    fn from(v: WorkTone) -> Self {
        match v {
            WorkTone::Neutral => Self::Neutral,
            WorkTone::Running => Self::Running,
            WorkTone::Attention => Self::Attention,
            WorkTone::Success => Self::Success,
            WorkTone::Failed => Self::Failed,
            WorkTone::Merged => Self::Merged,
            WorkTone::Info => Self::Info,
        }
    }
}

impl From<cc_core::WorkDetailView> for WorkDetailView {
    fn from(v: cc_core::WorkDetailView) -> Self {
        Self {
            label: v.label,
            value: v.value,
        }
    }
}

impl From<WorkDetailView> for cc_core::WorkDetailView {
    fn from(v: WorkDetailView) -> Self {
        Self {
            label: v.label,
            value: v.value,
        }
    }
}

impl From<cc_core::WorkActionLabelView> for WorkActionLabelView {
    fn from(v: cc_core::WorkActionLabelView) -> Self {
        Self {
            action: v.action.into(),
            label: v.label,
        }
    }
}

impl From<WorkActionLabelView> for cc_core::WorkActionLabelView {
    fn from(v: WorkActionLabelView) -> Self {
        Self {
            action: v.action.into(),
            label: v.label,
        }
    }
}

impl From<cc_core::WorkItemView> for WorkItemView {
    fn from(v: cc_core::WorkItemView) -> Self {
        Self {
            id: v.id,
            group: v.group.into(),
            kind: v.kind.into(),
            title: v.title,
            subtitle: v.subtitle,
            status: v.status,
            tone: v.tone.into(),
            details: v.details.into_iter().map(Into::into).collect(),
            action: v.action.map(Into::into),
            action_id: v.action_id,
            url: v.url,
            pipeline_id: v.pipeline_id,
            watcher_count: v.watcher_count,
            count: v.count,
            finished: v.finished,
            extra_actions: v.extra_actions.into_iter().map(Into::into).collect(),
            action_labels: v.action_labels.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<WorkItemView> for cc_core::WorkItemView {
    fn from(v: WorkItemView) -> Self {
        Self {
            id: v.id,
            group: v.group.into(),
            kind: v.kind.into(),
            title: v.title,
            subtitle: v.subtitle,
            status: v.status,
            tone: v.tone.into(),
            details: v.details.into_iter().map(Into::into).collect(),
            action: v.action.map(Into::into),
            action_id: v.action_id,
            url: v.url,
            pipeline_id: v.pipeline_id,
            watcher_count: v.watcher_count,
            count: v.count,
            finished: v.finished,
            extra_actions: v.extra_actions.into_iter().map(Into::into).collect(),
            action_labels: v.action_labels.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::WorkGroupCountView> for WorkGroupCountView {
    fn from(v: cc_core::WorkGroupCountView) -> Self {
        Self {
            group: v.group.into(),
            count: v.count,
        }
    }
}

impl From<WorkGroupCountView> for cc_core::WorkGroupCountView {
    fn from(v: WorkGroupCountView) -> Self {
        Self {
            group: v.group.into(),
            count: v.count,
        }
    }
}

impl From<cc_core::WorkDrawerView> for WorkDrawerView {
    fn from(v: cc_core::WorkDrawerView) -> Self {
        Self {
            revision: v.revision,
            chat_key: v.chat_key,
            items: v.items.into_iter().map(Into::into).collect(),
            errors: v.errors,
            busy: v.busy,
            visible: v.visible,
            summary: v.summary,
            counts: v.counts.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<WorkDrawerView> for cc_core::WorkDrawerView {
    fn from(v: WorkDrawerView) -> Self {
        Self {
            revision: v.revision,
            chat_key: v.chat_key,
            items: v.items.into_iter().map(Into::into).collect(),
            errors: v.errors,
            busy: v.busy,
            visible: v.visible,
            summary: v.summary,
            counts: v.counts.into_iter().map(Into::into).collect(),
        }
    }
}

/// One computer's pipelines. Built by `ChatsService.pipelines`; the feed
/// panels and drawers follow that read path's chat.
#[frb(opaque)]
#[derive(Clone)]
pub struct PipelinesService {
    inner: cc_core::PipelinesService,
}

impl PipelinesService {
    pub(crate) fn new(inner: cc_core::PipelinesService) -> Self {
        Self { inner }
    }
    /// The worktree's view now, then on every change.
    pub fn watch(
        &self,
        project_id: String,
        worktree_id: String,
        sink: StreamSink<PipelineScopeView>,
    ) {
        let mut views = self.inner.watch(project_id, worktree_id);
        handler::runtime().spawn(async move {
            while let Some(view) = views.next().await {
                if sink.add(view.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// The follower `token`'s turn panels now, then on every change,
    /// until it is unfollowed.
    pub fn watch_chat_activity(&self, token: u64, sink: StreamSink<ChatActivityView>) {
        let mut views = self.inner.watch_chat_activity(token);
        handler::runtime().spawn(async move {
            while let Some(view) = views.next().await {
                if sink.add(view.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// The drawer `token` now, then on every change, until it is closed.
    pub fn watch_drawer(&self, token: u64, sink: StreamSink<WorkDrawerView>) {
        let mut views = self.inner.watch_drawer(token);
        handler::runtime().spawn(async move {
            while let Some(view) = views.next().await {
                if sink.add(view.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// Queues `intent`; its outcome is not reported.
    #[frb(sync)]
    pub fn send(&self, intent: PipelinesIntent) {
        self.inner.send(intent.into());
    }
    /// Queues `intent` and returns the ticket `settled` takes.
    #[frb(sync)]
    pub fn request(&self, intent: PipelinesIntent) -> u64 {
        self.inner.request(intent.into())
    }
    /// The outcome of a requested intent. Fails when the core shut down,
    /// and `account_changed` once the account the service was opened in
    /// was left, also while the intent ran.
    pub async fn settled(&self, ticket: u64) -> Result<PipelinesSettled, CoreFailure> {
        self.inner
            .settled(ticket)
            .await
            .map(Into::into)
            .map_err(Into::into)
    }
    /// The dispatch form's rules over `values`: the inputs shown, the
    /// initial values, the errors and the payload a start sends.
    #[frb(sync)]
    pub fn form_rules(
        &self,
        form: DispatchFormView,
        values: Vec<PipelineInputValue>,
    ) -> FormRulesView {
        self.inner
            .form_rules(form.into(), values.into_iter().map(Into::into).collect())
            .into()
    }
}

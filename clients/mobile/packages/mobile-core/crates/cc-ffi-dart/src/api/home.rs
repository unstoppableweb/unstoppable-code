//! One computer's Home (P8, final sweep): the launcher options of a
//! project (branch targets, the model catalog, the saved default model,
//! provider runtimes), Home's remembered choices and composer drafts in
//! the encrypted store, the choice models Home's composer reads, the
//! launcher's admission and delivery observation, and the new task flow.
//! Intents are queued in call order and each variant of [`HomeIntent`] says
//! when it settles.
use super::{
    chats::ChatsService,
    composer::ModelRowView,
    core::CoreFailure,
    handler,
    overview::ChatRefView,
    worktrees::{CreatedWorktreeView, WorktreesService, WriteFailure},
};
use crate::frb_generated::StreamSink;
use flutter_rust_bridge::frb;

/// `ProviderAvailability`: `None` is unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ProviderAvailabilityView {
    pub claude: Option<bool>,
    pub codex: Option<bool>,
    pub ollama: Option<bool>,
    pub cursor: Option<bool>,
    pub copilot: Option<bool>,
}

/// What Home can start a chat with in one project (`DeviceChatHomeOptions`).
#[derive(Debug, Clone, PartialEq)]
pub struct HomeOptionsView {
    /// The computer lists the project's branch targets.
    pub branches_supported: bool,
    pub branches: Vec<String>,
    pub default_branch: Option<String>,
    /// The model catalog (the projection's rows, else the registry's), as
    /// the chat composer's rows.
    pub models: Vec<ModelRowView>,
    pub default_model_id: Option<String>,
    pub default_thinking_level: Option<String>,
    pub provider_availability: ProviderAvailabilityView,
}

/// Home's remembered choices in one navigation context. They never
/// authorize anything: Home resolves them against the computer's current
/// inventory.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HomeChoicesView {
    pub project_id: Option<String>,
    pub worktree_id: Option<String>,
    pub base_branch: Option<String>,
    pub model_id: Option<String>,
    pub execution_harness: Option<String>,
    pub thinking_level: Option<String>,
}

/// One context's Home draft.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeDraftView {
    /// `personal` or `organization:<id>`.
    pub context: String,
    pub text: String,
}

/// One project of the context's scope, as the host's controller lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeProjectView {
    pub id: String,
    /// The project's `type`: `single-repo`, `multi-repo` or `cowork`.
    pub kind: String,
}

/// One worktree of the context's scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeWorktreeView {
    pub project_id: String,
    pub id: String,
}

/// What the host's controller showed for one navigation context when it
/// last notified: whether its computer is the selected one, online, whose
/// ownership is still being read and whose overview is loading, and the
/// context's projects and worktrees (`scopeFor(context)`, empty while the
/// scope is pending or the computer not selected). Home resolves every
/// remembered choice against it; nothing in it authorizes anything.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HomeInventoryView {
    pub active: bool,
    pub online: bool,
    pub scope_pending: bool,
    pub loading: bool,
    pub projects: Vec<HomeProjectView>,
    pub worktrees: Vec<HomeWorktreeView>,
}

/// One mounted Home composer's choices (`ComputerChatHomeModel`), resolved
/// against the context's inventory and the project's launcher options.
#[derive(Debug, Clone, PartialEq)]
pub struct HomeModelView {
    pub id: u64,
    pub loading: bool,
    /// The options read failed; Retry reads them again.
    pub error: Option<String>,
    /// The choices were not stored.
    pub save_error: Option<String>,
    pub choices: HomeChoicesView,
    pub branches_supported: bool,
    pub branches: Vec<String>,
    /// Bumped whenever `models` or `provider_availability` change.
    pub options_revision: u64,
    pub models: Vec<ModelRowView>,
    pub provider_availability: Option<ProviderAvailabilityView>,
    /// The row the model choice resolves to (`effectiveModelOption`).
    pub selected_model: Option<ModelRowView>,
    /// The effort shown: the chosen level clamped to `effort_levels`
    /// (empty when the model does not think).
    pub effort_level: String,
    pub effort_levels: Vec<String>,
    pub can_start: bool,
}

/// What a started launch carries to the new task screen.
#[derive(Debug, Clone, PartialEq)]
pub struct HomeLaunchView {
    pub context: String,
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub base_branch: Option<String>,
    /// The chosen model as the first send applies it.
    pub model: Option<ModelRowView>,
    pub thinking_level: Option<String>,
    pub text: String,
    /// The delivery that observes the launch's first message.
    pub delivery: u64,
}

/// A Home draft the launcher cleared once its message was confirmed: the
/// host clears its composer if it still shows `text`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeDraftClearView {
    pub seq: u64,
    pub context: String,
    pub text: String,
}

/// The launcher (`ComputerHomeLauncher`): launch admission, its error, the
/// chat whose message is still unconfirmed, and confirmed drafts to clear.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LauncherView {
    pub busy: bool,
    pub error: Option<String>,
    /// The computer's unconfirmed send (its chat), which blocks a launch.
    pub pending: Option<ChatRefView>,
    pub draft_clear: Option<HomeDraftClearView>,
}

/// One new task attempt (`DeviceNewTaskModel`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewTaskView {
    pub id: u64,
    /// Bumped by every change of this view.
    pub revision: u64,
    pub ready: bool,
    pub sending: bool,
    pub error: Option<String>,
    pub can_retry: bool,
    /// A Cowork project: its chat is created on the first send.
    pub flat: bool,
    pub created: Option<CreatedWorktreeView>,
    /// The worktree the creation got from the desktop, once it answered.
    pub attempt_worktree_id: Option<String>,
    /// "Creating worktree…" until the desktop answered, then "Setting up
    /// worktree…".
    pub status_label: String,
    /// The chat the first message goes to.
    pub target: Option<ChatRefView>,
    /// The first message was confirmed.
    pub confirmed: bool,
}

/// Every mounted model, the launcher and every task of the computer.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HomeView {
    pub revision: u64,
    pub models: Vec<HomeModelView>,
    pub launcher: LauncherView,
    pub tasks: Vec<NewTaskView>,
}

/// A file staged on Home before its chat existed. The host read its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeAttachmentView {
    pub local_id: String,
    pub filename: String,
    pub media_type: String,
    pub bytes: Vec<u8>,
}

/// A Home file the first message named: the host keeps its preview and
/// tells Home the file is spent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentAttachmentView {
    pub local_id: String,
    pub path: String,
}

/// The model a new task applies before its first send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskModelView {
    pub id: String,
    pub provider: String,
    pub harness: Option<String>,
}

/// A new task attempt as the screen starts it.
#[derive(Debug, Clone, PartialEq)]
pub struct NewTaskRequest {
    pub project: HomeProjectView,
    /// An existing worktree: the first chat is a new tab there.
    pub worktree_id: Option<String>,
    pub base_branch: Option<String>,
    pub model: Option<TaskModelView>,
    pub thinking_level: Option<String>,
    /// The launch's delivery; none makes the task observe its own.
    pub delivery: Option<u64>,
    /// The screen has a navigation context, whose projects must keep
    /// owning the project.
    pub scoped: bool,
    pub inventory: HomeInventoryView,
    pub attachments: Vec<HomeAttachmentView>,
}

/// A step that needs the host's chat model, overview, or composer UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskStep {
    /// Open `chat` in the chat model.
    Open { chat: ChatRefView },
    /// Create a new tab in a worktree and open it.
    CreateTab {
        project_id: String,
        worktree_id: String,
    },
    /// Create a Cowork chat and open it.
    CreateChat { project_id: String },
    /// Re-read the created worktree's chats into its overview row.
    LoadWorktree {
        project_id: String,
        worktree_id: String,
        name: String,
    },
    /// Re-read the open chat.
    Refresh,
    /// Put the screen composer's text (`None`) or `text` into `chat`'s
    /// draft, or the selected chat's without one.
    SetDraft {
        chat: Option<ChatRefView>,
        text: Option<String>,
    },
    /// Tell the chat's activity the project's kind.
    SetWorkspaceKind { project_id: String, kind: String },
    /// The first message named these Home files.
    Sent {
        attachments: Vec<SentAttachmentView>,
    },
}

/// The exception a host step threw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskFailureKind {
    /// A `DeviceLinkException` (refusals included): show its message.
    Link,
    /// A `DeviceChatCreationNotSent`.
    CreationNotSent,
    /// A `DesktopIpcNotSent`.
    NotSent,
    /// Another error; the task words it.
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskFailure {
    pub kind: TaskFailureKind,
    pub message: String,
}

/// How a host step went.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TaskStepResult {
    pub failure: Option<TaskFailure>,
    /// The chat a creation made (reported even when its open failed).
    pub created: Option<ChatRefView>,
    /// `LoadWorktree`: the row's status is `Unavailable`.
    pub unavailable: bool,
    /// `LoadWorktree`: the row's chats and its active one.
    pub chats: Vec<ChatRefView>,
    pub active_chat_id: Option<String>,
    pub online: bool,
}

/// A Home intent. Each variant's doc ends with when it resolves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HomeIntent {
    /// Reads the launcher options of project `workspace_id`: branch
    /// targets, the model catalog, the saved default model and the provider
    /// runtimes, in Dart's order. Creates nothing.
    ///
    /// Resolves when settled: `Options`, or `Failed` with the exception
    /// the Dart read threw.
    LoadOptions { workspace_id: String },
    /// `context`'s remembered choices (all empty when none).
    ///
    /// Resolves when applied: `Choices`.
    Choices { context: String },
    /// Replaces `context`'s choices and writes the record.
    ///
    /// Resolves when settled: `Saved{stored}` once the write finished.
    SaveChoices {
        context: String,
        choices: HomeChoicesView,
    },
    /// Every context's draft, as stored when the service started.
    ///
    /// Resolves when applied: `Drafts`.
    Drafts,
    /// Sets `context`'s draft (empty removes it); written 500 ms after the
    /// last change.
    ///
    /// Resolves when applied.
    SetDraft { context: String, text: String },
    /// Writes pending draft changes now.
    ///
    /// Resolves when settled: `Saved{stored}`; a failed write keeps the
    /// drafts for the next try.
    FlushDrafts,
    /// Writes pending drafts and stops the service.
    ///
    /// Resolves when settled.
    Close,
    /// What the host's controller shows for the model's context now; sent
    /// whenever it notifies (`_inventoryChanged`).
    ///
    /// Resolves when applied.
    Inventory {
        model: u64,
        inventory: HomeInventoryView,
    },
    /// Restores the context's saved choices and reads the project's
    /// options (`load`).
    ///
    /// Resolves when settled: the options read it started finished.
    Load { model: u64 },
    /// Reads the project's options again (`refreshChoices`).
    ///
    /// Resolves when settled: the options read finished.
    RefreshChoices { model: u64 },
    /// Chooses a project, worktree (`None`: a new one), base branch,
    /// model or effort, and saves the choices.
    ///
    /// Resolves when settled: `Selected{accepted}` once the choices were
    /// written (and a project's options read).
    Select { model: u64, pick: HomePick },
    /// The model's screen left.
    ///
    /// Resolves when applied.
    Unmount { model: u64 },
    /// Starts a launch from `model` with the composer's `text`: admission,
    /// then the choices and drafts are saved.
    ///
    /// Resolves when settled: `Launch`, or `NotStarted`.
    Begin { model: u64, text: String },
    /// Opens the unconfirmed send's chat in `inventory`'s context.
    ///
    /// Resolves when applied: `Open{chat}` for the host to open, or
    /// `NotStarted`.
    Resume { inventory: HomeInventoryView },
    /// The host's open of a resumed chat finished.
    ///
    /// Resolves when applied: `Resumed{opened}`; when not opened the host
    /// finishes.
    Resumed {
        opened: bool,
        inventory: HomeInventoryView,
    },
    /// The host left the launched or resumed chat.
    ///
    /// Resolves when applied.
    Finished,
    /// The admitted launch's project or worktree left the host's inventory
    /// before the host started it: the launch is released and Home shows a
    /// retryable error. The draft stays.
    ///
    /// Resolves when applied.
    LaunchGone,
    /// What the host's controller shows for the task's context now.
    ///
    /// Resolves when applied.
    TaskInventory {
        task: u64,
        inventory: HomeInventoryView,
    },
    /// Makes the task's chat (`prepare`).
    ///
    /// Resolves when settled: `Step` for each host step, then `Task`.
    Prepare { task: u64 },
    /// Sends the composer's `text` as the first message, preparing first.
    ///
    /// Resolves when settled: `Step` for each host step, then `Task`.
    TaskSend { task: u64, text: String },
    /// Retry after a failure (`retryCreation`).
    ///
    /// Resolves when settled: `Step` for each host step, then `Task`.
    Retry { task: u64, text: String },
    /// How the last `Step` went.
    ///
    /// Resolves when settled: the next `Step`, or `Task`.
    StepDone { task: u64, result: TaskStepResult },
    /// The task's screen left: Home files no send named are deleted.
    ///
    /// Resolves when applied.
    TaskDispose { task: u64 },
}

/// A choice on Home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HomePick {
    Project {
        id: String,
    },
    Worktree {
        id: Option<String>,
    },
    Branch {
        id: String,
    },
    Model {
        id: String,
        execution_harness: Option<String>,
    },
    Effort {
        level: String,
    },
}

/// A requested intent's outcome.
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)] // Crosses the binding by value.
pub enum HomeOutcome {
    Options {
        options: HomeOptionsView,
    },
    Choices {
        choices: HomeChoicesView,
    },
    Drafts {
        drafts: Vec<HomeDraftView>,
    },
    Saved {
        stored: bool,
    },
    Failed {
        failure: WriteFailure,
    },
    Done,
    /// `Select`: whether the choice was taken.
    Selected {
        accepted: bool,
    },
    Launch {
        launch: HomeLaunchView,
    },
    NotStarted,
    /// `Resume`: the host opens `chat`.
    Open {
        chat: ChatRefView,
    },
    /// `Resumed`: whether the chat is shown.
    Resumed {
        opened: bool,
    },
    /// The host takes `step` for `task`, then reports `StepDone`.
    Step {
        task: u64,
        step: TaskStep,
    },
    /// The task's flow settled; `view` shows the result.
    Task {
        task: u64,
        view: Option<NewTaskView>,
    },
}

/// A requested intent's outcome and the `HomeView` revision that shows
/// it (0 for the P8 intents, which change no view).
#[derive(Debug, Clone, PartialEq)]
pub struct HomeSettled {
    pub revision: u64,
    pub outcome: HomeOutcome,
}

impl From<cc_core::ProviderAvailabilityView> for ProviderAvailabilityView {
    fn from(v: cc_core::ProviderAvailabilityView) -> Self {
        Self {
            claude: v.claude,
            codex: v.codex,
            ollama: v.ollama,
            cursor: v.cursor,
            copilot: v.copilot,
        }
    }
}

impl From<ProviderAvailabilityView> for cc_core::ProviderAvailabilityView {
    fn from(v: ProviderAvailabilityView) -> Self {
        Self {
            claude: v.claude,
            codex: v.codex,
            ollama: v.ollama,
            cursor: v.cursor,
            copilot: v.copilot,
        }
    }
}

impl From<cc_core::HomeOptionsView> for HomeOptionsView {
    fn from(v: cc_core::HomeOptionsView) -> Self {
        Self {
            branches_supported: v.branches_supported,
            branches: v.branches,
            default_branch: v.default_branch,
            models: v.models.into_iter().map(Into::into).collect(),
            default_model_id: v.default_model_id,
            default_thinking_level: v.default_thinking_level,
            provider_availability: v.provider_availability.into(),
        }
    }
}

impl From<HomeOptionsView> for cc_core::HomeOptionsView {
    fn from(v: HomeOptionsView) -> Self {
        Self {
            branches_supported: v.branches_supported,
            branches: v.branches,
            default_branch: v.default_branch,
            models: v.models.into_iter().map(Into::into).collect(),
            default_model_id: v.default_model_id,
            default_thinking_level: v.default_thinking_level,
            provider_availability: v.provider_availability.into(),
        }
    }
}

impl From<cc_core::HomeChoicesView> for HomeChoicesView {
    fn from(v: cc_core::HomeChoicesView) -> Self {
        Self {
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            base_branch: v.base_branch,
            model_id: v.model_id,
            execution_harness: v.execution_harness,
            thinking_level: v.thinking_level,
        }
    }
}

impl From<HomeChoicesView> for cc_core::HomeChoicesView {
    fn from(v: HomeChoicesView) -> Self {
        Self {
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            base_branch: v.base_branch,
            model_id: v.model_id,
            execution_harness: v.execution_harness,
            thinking_level: v.thinking_level,
        }
    }
}

impl From<cc_core::HomeDraftView> for HomeDraftView {
    fn from(v: cc_core::HomeDraftView) -> Self {
        Self {
            context: v.context,
            text: v.text,
        }
    }
}

impl From<HomeDraftView> for cc_core::HomeDraftView {
    fn from(v: HomeDraftView) -> Self {
        Self {
            context: v.context,
            text: v.text,
        }
    }
}

impl From<cc_core::HomeProjectView> for HomeProjectView {
    fn from(v: cc_core::HomeProjectView) -> Self {
        Self {
            id: v.id,
            kind: v.kind,
        }
    }
}

impl From<HomeProjectView> for cc_core::HomeProjectView {
    fn from(v: HomeProjectView) -> Self {
        Self {
            id: v.id,
            kind: v.kind,
        }
    }
}

impl From<cc_core::HomeWorktreeView> for HomeWorktreeView {
    fn from(v: cc_core::HomeWorktreeView) -> Self {
        Self {
            project_id: v.project_id,
            id: v.id,
        }
    }
}

impl From<HomeWorktreeView> for cc_core::HomeWorktreeView {
    fn from(v: HomeWorktreeView) -> Self {
        Self {
            project_id: v.project_id,
            id: v.id,
        }
    }
}

impl From<cc_core::HomeInventoryView> for HomeInventoryView {
    fn from(v: cc_core::HomeInventoryView) -> Self {
        Self {
            active: v.active,
            online: v.online,
            scope_pending: v.scope_pending,
            loading: v.loading,
            projects: v.projects.into_iter().map(Into::into).collect(),
            worktrees: v.worktrees.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<HomeInventoryView> for cc_core::HomeInventoryView {
    fn from(v: HomeInventoryView) -> Self {
        Self {
            active: v.active,
            online: v.online,
            scope_pending: v.scope_pending,
            loading: v.loading,
            projects: v.projects.into_iter().map(Into::into).collect(),
            worktrees: v.worktrees.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::HomeModelView> for HomeModelView {
    fn from(v: cc_core::HomeModelView) -> Self {
        Self {
            id: v.id,
            loading: v.loading,
            error: v.error,
            save_error: v.save_error,
            choices: v.choices.into(),
            branches_supported: v.branches_supported,
            branches: v.branches,
            options_revision: v.options_revision,
            models: v.models.into_iter().map(Into::into).collect(),
            provider_availability: v.provider_availability.map(Into::into),
            selected_model: v.selected_model.map(Into::into),
            effort_level: v.effort_level,
            effort_levels: v.effort_levels,
            can_start: v.can_start,
        }
    }
}

impl From<HomeModelView> for cc_core::HomeModelView {
    fn from(v: HomeModelView) -> Self {
        Self {
            id: v.id,
            loading: v.loading,
            error: v.error,
            save_error: v.save_error,
            choices: v.choices.into(),
            branches_supported: v.branches_supported,
            branches: v.branches,
            options_revision: v.options_revision,
            models: v.models.into_iter().map(Into::into).collect(),
            provider_availability: v.provider_availability.map(Into::into),
            selected_model: v.selected_model.map(Into::into),
            effort_level: v.effort_level,
            effort_levels: v.effort_levels,
            can_start: v.can_start,
        }
    }
}

impl From<cc_core::HomeLaunchView> for HomeLaunchView {
    fn from(v: cc_core::HomeLaunchView) -> Self {
        Self {
            context: v.context,
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            base_branch: v.base_branch,
            model: v.model.map(Into::into),
            thinking_level: v.thinking_level,
            text: v.text,
            delivery: v.delivery,
        }
    }
}

impl From<HomeLaunchView> for cc_core::HomeLaunchView {
    fn from(v: HomeLaunchView) -> Self {
        Self {
            context: v.context,
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            base_branch: v.base_branch,
            model: v.model.map(Into::into),
            thinking_level: v.thinking_level,
            text: v.text,
            delivery: v.delivery,
        }
    }
}

impl From<cc_core::HomeDraftClearView> for HomeDraftClearView {
    fn from(v: cc_core::HomeDraftClearView) -> Self {
        Self {
            seq: v.seq,
            context: v.context,
            text: v.text,
        }
    }
}

impl From<HomeDraftClearView> for cc_core::HomeDraftClearView {
    fn from(v: HomeDraftClearView) -> Self {
        Self {
            seq: v.seq,
            context: v.context,
            text: v.text,
        }
    }
}

impl From<cc_core::LauncherView> for LauncherView {
    fn from(v: cc_core::LauncherView) -> Self {
        Self {
            busy: v.busy,
            error: v.error,
            pending: v.pending.map(Into::into),
            draft_clear: v.draft_clear.map(Into::into),
        }
    }
}

impl From<LauncherView> for cc_core::LauncherView {
    fn from(v: LauncherView) -> Self {
        Self {
            busy: v.busy,
            error: v.error,
            pending: v.pending.map(Into::into),
            draft_clear: v.draft_clear.map(Into::into),
        }
    }
}

impl From<cc_core::NewTaskView> for NewTaskView {
    fn from(v: cc_core::NewTaskView) -> Self {
        Self {
            id: v.id,
            revision: v.revision,
            ready: v.ready,
            sending: v.sending,
            error: v.error,
            can_retry: v.can_retry,
            flat: v.flat,
            created: v.created.map(Into::into),
            attempt_worktree_id: v.attempt_worktree_id,
            status_label: v.status_label,
            target: v.target.map(Into::into),
            confirmed: v.confirmed,
        }
    }
}

impl From<NewTaskView> for cc_core::NewTaskView {
    fn from(v: NewTaskView) -> Self {
        Self {
            id: v.id,
            revision: v.revision,
            ready: v.ready,
            sending: v.sending,
            error: v.error,
            can_retry: v.can_retry,
            flat: v.flat,
            created: v.created.map(Into::into),
            attempt_worktree_id: v.attempt_worktree_id,
            status_label: v.status_label,
            target: v.target.map(Into::into),
            confirmed: v.confirmed,
        }
    }
}

impl From<cc_core::HomeView> for HomeView {
    fn from(v: cc_core::HomeView) -> Self {
        Self {
            revision: v.revision,
            models: v.models.into_iter().map(Into::into).collect(),
            launcher: v.launcher.into(),
            tasks: v.tasks.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<HomeView> for cc_core::HomeView {
    fn from(v: HomeView) -> Self {
        Self {
            revision: v.revision,
            models: v.models.into_iter().map(Into::into).collect(),
            launcher: v.launcher.into(),
            tasks: v.tasks.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::HomeAttachmentView> for HomeAttachmentView {
    fn from(v: cc_core::HomeAttachmentView) -> Self {
        Self {
            local_id: v.local_id,
            filename: v.filename,
            media_type: v.media_type,
            bytes: v.bytes,
        }
    }
}

impl From<HomeAttachmentView> for cc_core::HomeAttachmentView {
    fn from(v: HomeAttachmentView) -> Self {
        Self {
            local_id: v.local_id,
            filename: v.filename,
            media_type: v.media_type,
            bytes: v.bytes,
        }
    }
}

impl From<cc_core::SentAttachmentView> for SentAttachmentView {
    fn from(v: cc_core::SentAttachmentView) -> Self {
        Self {
            local_id: v.local_id,
            path: v.path,
        }
    }
}

impl From<SentAttachmentView> for cc_core::SentAttachmentView {
    fn from(v: SentAttachmentView) -> Self {
        Self {
            local_id: v.local_id,
            path: v.path,
        }
    }
}

impl From<cc_core::TaskModelView> for TaskModelView {
    fn from(v: cc_core::TaskModelView) -> Self {
        Self {
            id: v.id,
            provider: v.provider,
            harness: v.harness,
        }
    }
}

impl From<TaskModelView> for cc_core::TaskModelView {
    fn from(v: TaskModelView) -> Self {
        Self {
            id: v.id,
            provider: v.provider,
            harness: v.harness,
        }
    }
}

impl From<cc_core::NewTaskRequest> for NewTaskRequest {
    fn from(v: cc_core::NewTaskRequest) -> Self {
        Self {
            project: v.project.into(),
            worktree_id: v.worktree_id,
            base_branch: v.base_branch,
            model: v.model.map(Into::into),
            thinking_level: v.thinking_level,
            delivery: v.delivery,
            scoped: v.scoped,
            inventory: v.inventory.into(),
            attachments: v.attachments.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<NewTaskRequest> for cc_core::NewTaskRequest {
    fn from(v: NewTaskRequest) -> Self {
        Self {
            project: v.project.into(),
            worktree_id: v.worktree_id,
            base_branch: v.base_branch,
            model: v.model.map(Into::into),
            thinking_level: v.thinking_level,
            delivery: v.delivery,
            scoped: v.scoped,
            inventory: v.inventory.into(),
            attachments: v.attachments.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::TaskStep> for TaskStep {
    fn from(v: cc_core::TaskStep) -> Self {
        match v {
            cc_core::TaskStep::Open { chat } => Self::Open { chat: chat.into() },
            cc_core::TaskStep::CreateTab {
                project_id,
                worktree_id,
            } => Self::CreateTab {
                project_id,
                worktree_id,
            },
            cc_core::TaskStep::CreateChat { project_id } => Self::CreateChat { project_id },
            cc_core::TaskStep::LoadWorktree {
                project_id,
                worktree_id,
                name,
            } => Self::LoadWorktree {
                project_id,
                worktree_id,
                name,
            },
            cc_core::TaskStep::Refresh => Self::Refresh,
            cc_core::TaskStep::SetDraft { chat, text } => Self::SetDraft {
                chat: chat.map(Into::into),
                text,
            },
            cc_core::TaskStep::SetWorkspaceKind { project_id, kind } => {
                Self::SetWorkspaceKind { project_id, kind }
            }
            cc_core::TaskStep::Sent { attachments } => Self::Sent {
                attachments: attachments.into_iter().map(Into::into).collect(),
            },
        }
    }
}

impl From<TaskStep> for cc_core::TaskStep {
    fn from(v: TaskStep) -> Self {
        match v {
            TaskStep::Open { chat } => Self::Open { chat: chat.into() },
            TaskStep::CreateTab {
                project_id,
                worktree_id,
            } => Self::CreateTab {
                project_id,
                worktree_id,
            },
            TaskStep::CreateChat { project_id } => Self::CreateChat { project_id },
            TaskStep::LoadWorktree {
                project_id,
                worktree_id,
                name,
            } => Self::LoadWorktree {
                project_id,
                worktree_id,
                name,
            },
            TaskStep::Refresh => Self::Refresh,
            TaskStep::SetDraft { chat, text } => Self::SetDraft {
                chat: chat.map(Into::into),
                text,
            },
            TaskStep::SetWorkspaceKind { project_id, kind } => {
                Self::SetWorkspaceKind { project_id, kind }
            }
            TaskStep::Sent { attachments } => Self::Sent {
                attachments: attachments.into_iter().map(Into::into).collect(),
            },
        }
    }
}

impl From<cc_core::TaskFailureKind> for TaskFailureKind {
    fn from(v: cc_core::TaskFailureKind) -> Self {
        match v {
            cc_core::TaskFailureKind::Link => Self::Link,
            cc_core::TaskFailureKind::CreationNotSent => Self::CreationNotSent,
            cc_core::TaskFailureKind::NotSent => Self::NotSent,
            cc_core::TaskFailureKind::Other => Self::Other,
        }
    }
}

impl From<TaskFailureKind> for cc_core::TaskFailureKind {
    fn from(v: TaskFailureKind) -> Self {
        match v {
            TaskFailureKind::Link => Self::Link,
            TaskFailureKind::CreationNotSent => Self::CreationNotSent,
            TaskFailureKind::NotSent => Self::NotSent,
            TaskFailureKind::Other => Self::Other,
        }
    }
}

impl From<cc_core::TaskFailure> for TaskFailure {
    fn from(v: cc_core::TaskFailure) -> Self {
        Self {
            kind: v.kind.into(),
            message: v.message,
        }
    }
}

impl From<TaskFailure> for cc_core::TaskFailure {
    fn from(v: TaskFailure) -> Self {
        Self {
            kind: v.kind.into(),
            message: v.message,
        }
    }
}

impl From<cc_core::TaskStepResult> for TaskStepResult {
    fn from(v: cc_core::TaskStepResult) -> Self {
        Self {
            failure: v.failure.map(Into::into),
            created: v.created.map(Into::into),
            unavailable: v.unavailable,
            chats: v.chats.into_iter().map(Into::into).collect(),
            active_chat_id: v.active_chat_id,
            online: v.online,
        }
    }
}

impl From<TaskStepResult> for cc_core::TaskStepResult {
    fn from(v: TaskStepResult) -> Self {
        Self {
            failure: v.failure.map(Into::into),
            created: v.created.map(Into::into),
            unavailable: v.unavailable,
            chats: v.chats.into_iter().map(Into::into).collect(),
            active_chat_id: v.active_chat_id,
            online: v.online,
        }
    }
}

impl From<cc_core::HomeIntent> for HomeIntent {
    fn from(v: cc_core::HomeIntent) -> Self {
        match v {
            cc_core::HomeIntent::LoadOptions { workspace_id } => Self::LoadOptions { workspace_id },
            cc_core::HomeIntent::Choices { context } => Self::Choices { context },
            cc_core::HomeIntent::SaveChoices { context, choices } => Self::SaveChoices {
                context,
                choices: choices.into(),
            },
            cc_core::HomeIntent::Drafts => Self::Drafts,
            cc_core::HomeIntent::SetDraft { context, text } => Self::SetDraft { context, text },
            cc_core::HomeIntent::FlushDrafts => Self::FlushDrafts,
            cc_core::HomeIntent::Close => Self::Close,
            cc_core::HomeIntent::Inventory { model, inventory } => Self::Inventory {
                model,
                inventory: inventory.into(),
            },
            cc_core::HomeIntent::Load { model } => Self::Load { model },
            cc_core::HomeIntent::RefreshChoices { model } => Self::RefreshChoices { model },
            cc_core::HomeIntent::Select { model, pick } => Self::Select {
                model,
                pick: pick.into(),
            },
            cc_core::HomeIntent::Unmount { model } => Self::Unmount { model },
            cc_core::HomeIntent::Begin { model, text } => Self::Begin { model, text },
            cc_core::HomeIntent::Resume { inventory } => Self::Resume {
                inventory: inventory.into(),
            },
            cc_core::HomeIntent::Resumed { opened, inventory } => Self::Resumed {
                opened,
                inventory: inventory.into(),
            },
            cc_core::HomeIntent::Finished => Self::Finished,
            cc_core::HomeIntent::LaunchGone => Self::LaunchGone,
            cc_core::HomeIntent::TaskInventory { task, inventory } => Self::TaskInventory {
                task,
                inventory: inventory.into(),
            },
            cc_core::HomeIntent::Prepare { task } => Self::Prepare { task },
            cc_core::HomeIntent::TaskSend { task, text } => Self::TaskSend { task, text },
            cc_core::HomeIntent::Retry { task, text } => Self::Retry { task, text },
            cc_core::HomeIntent::StepDone { task, result } => Self::StepDone {
                task,
                result: result.into(),
            },
            cc_core::HomeIntent::TaskDispose { task } => Self::TaskDispose { task },
        }
    }
}

impl From<HomeIntent> for cc_core::HomeIntent {
    fn from(v: HomeIntent) -> Self {
        match v {
            HomeIntent::LoadOptions { workspace_id } => Self::LoadOptions { workspace_id },
            HomeIntent::Choices { context } => Self::Choices { context },
            HomeIntent::SaveChoices { context, choices } => Self::SaveChoices {
                context,
                choices: choices.into(),
            },
            HomeIntent::Drafts => Self::Drafts,
            HomeIntent::SetDraft { context, text } => Self::SetDraft { context, text },
            HomeIntent::FlushDrafts => Self::FlushDrafts,
            HomeIntent::Close => Self::Close,
            HomeIntent::Inventory { model, inventory } => Self::Inventory {
                model,
                inventory: inventory.into(),
            },
            HomeIntent::Load { model } => Self::Load { model },
            HomeIntent::RefreshChoices { model } => Self::RefreshChoices { model },
            HomeIntent::Select { model, pick } => Self::Select {
                model,
                pick: pick.into(),
            },
            HomeIntent::Unmount { model } => Self::Unmount { model },
            HomeIntent::Begin { model, text } => Self::Begin { model, text },
            HomeIntent::Resume { inventory } => Self::Resume {
                inventory: inventory.into(),
            },
            HomeIntent::Resumed { opened, inventory } => Self::Resumed {
                opened,
                inventory: inventory.into(),
            },
            HomeIntent::Finished => Self::Finished,
            HomeIntent::LaunchGone => Self::LaunchGone,
            HomeIntent::TaskInventory { task, inventory } => Self::TaskInventory {
                task,
                inventory: inventory.into(),
            },
            HomeIntent::Prepare { task } => Self::Prepare { task },
            HomeIntent::TaskSend { task, text } => Self::TaskSend { task, text },
            HomeIntent::Retry { task, text } => Self::Retry { task, text },
            HomeIntent::StepDone { task, result } => Self::StepDone {
                task,
                result: result.into(),
            },
            HomeIntent::TaskDispose { task } => Self::TaskDispose { task },
        }
    }
}

impl From<cc_core::HomePick> for HomePick {
    fn from(v: cc_core::HomePick) -> Self {
        match v {
            cc_core::HomePick::Project { id } => Self::Project { id },
            cc_core::HomePick::Worktree { id } => Self::Worktree { id },
            cc_core::HomePick::Branch { id } => Self::Branch { id },
            cc_core::HomePick::Model {
                id,
                execution_harness,
            } => Self::Model {
                id,
                execution_harness,
            },
            cc_core::HomePick::Effort { level } => Self::Effort { level },
        }
    }
}

impl From<HomePick> for cc_core::HomePick {
    fn from(v: HomePick) -> Self {
        match v {
            HomePick::Project { id } => Self::Project { id },
            HomePick::Worktree { id } => Self::Worktree { id },
            HomePick::Branch { id } => Self::Branch { id },
            HomePick::Model {
                id,
                execution_harness,
            } => Self::Model {
                id,
                execution_harness,
            },
            HomePick::Effort { level } => Self::Effort { level },
        }
    }
}

impl From<cc_core::HomeOutcome> for HomeOutcome {
    fn from(v: cc_core::HomeOutcome) -> Self {
        match v {
            cc_core::HomeOutcome::Options { options } => Self::Options {
                options: options.into(),
            },
            cc_core::HomeOutcome::Choices { choices } => Self::Choices {
                choices: choices.into(),
            },
            cc_core::HomeOutcome::Drafts { drafts } => Self::Drafts {
                drafts: drafts.into_iter().map(Into::into).collect(),
            },
            cc_core::HomeOutcome::Saved { stored } => Self::Saved { stored },
            cc_core::HomeOutcome::Failed { failure } => Self::Failed {
                failure: failure.into(),
            },
            cc_core::HomeOutcome::Done => Self::Done,
            cc_core::HomeOutcome::Selected { accepted } => Self::Selected { accepted },
            cc_core::HomeOutcome::Launch { launch } => Self::Launch {
                launch: (*launch).into(),
            },
            cc_core::HomeOutcome::NotStarted => Self::NotStarted,
            cc_core::HomeOutcome::Open { chat } => Self::Open { chat: chat.into() },
            cc_core::HomeOutcome::Resumed { opened } => Self::Resumed { opened },
            cc_core::HomeOutcome::Step { task, step } => Self::Step {
                task,
                step: step.into(),
            },
            cc_core::HomeOutcome::Task { task, view } => Self::Task {
                task,
                view: view.map(|v| (*v).into()),
            },
        }
    }
}

impl From<HomeOutcome> for cc_core::HomeOutcome {
    fn from(v: HomeOutcome) -> Self {
        match v {
            HomeOutcome::Options { options } => Self::Options {
                options: options.into(),
            },
            HomeOutcome::Choices { choices } => Self::Choices {
                choices: choices.into(),
            },
            HomeOutcome::Drafts { drafts } => Self::Drafts {
                drafts: drafts.into_iter().map(Into::into).collect(),
            },
            HomeOutcome::Saved { stored } => Self::Saved { stored },
            HomeOutcome::Failed { failure } => Self::Failed {
                failure: failure.into(),
            },
            HomeOutcome::Done => Self::Done,
            HomeOutcome::Selected { accepted } => Self::Selected { accepted },
            HomeOutcome::Launch { launch } => Self::Launch {
                launch: Box::new(launch.into()),
            },
            HomeOutcome::NotStarted => Self::NotStarted,
            HomeOutcome::Open { chat } => Self::Open { chat: chat.into() },
            HomeOutcome::Resumed { opened } => Self::Resumed { opened },
            HomeOutcome::Step { task, step } => Self::Step {
                task,
                step: step.into(),
            },
            HomeOutcome::Task { task, view } => Self::Task {
                task,
                view: view.map(|v| Box::new(v.into())),
            },
        }
    }
}

impl From<cc_core::HomeSettled> for HomeSettled {
    fn from(v: cc_core::HomeSettled) -> Self {
        Self {
            revision: v.revision,
            outcome: v.outcome.into(),
        }
    }
}

impl From<HomeSettled> for cc_core::HomeSettled {
    fn from(v: HomeSettled) -> Self {
        Self {
            revision: v.revision,
            outcome: v.outcome.into(),
        }
    }
}

/// One computer's Home. Built by `AccountService.home`.
#[frb(opaque)]
#[derive(Clone)]
pub struct HomeService {
    inner: cc_core::HomeService,
}

impl HomeService {
    pub(crate) fn new(inner: cc_core::HomeService) -> Self {
        Self { inner }
    }
    /// Queues `intent`; its outcome is not reported.
    #[frb(sync)]
    pub fn send(&self, intent: HomeIntent) {
        self.inner.send(intent.into());
    }
    /// Queues `intent` and returns the ticket `settled` takes.
    #[frb(sync)]
    pub fn request(&self, intent: HomeIntent) -> u64 {
        self.inner.request(intent.into())
    }
    /// The models and the launcher: the view now, then every change
    /// (latest wins).
    pub fn watch(&self, sink: StreamSink<HomeView>) {
        let mut views = self.inner.watch();
        handler::runtime().spawn(async move {
            while let Some(view) = views.next().await {
                if sink.add(view.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// Follows `chats` (the computer's main read path) for the computer's
    /// unconfirmed send, and runs the new tasks' chat steps on it.
    #[frb(sync)]
    pub fn bind_chats(&self, chats: &ChatsService) {
        self.inner.bind_chats(&chats.inner);
    }
    /// Runs the new tasks' worktree creations on `worktrees`.
    #[frb(sync)]
    pub fn bind_worktrees(&self, worktrees: &WorktreesService) {
        self.inner.bind_worktrees(&worktrees.inner);
    }
    /// A new choice model for `context` (`personal` or
    /// `organization:<id>`), with the inventory its controller shows now,
    /// applied before any intent queued after it.
    #[frb(sync)]
    pub fn model(&self, context: String, inventory: HomeInventoryView) -> u64 {
        self.inner.model(context, inventory.into())
    }
    /// A new task attempt, applied before any intent queued after it;
    /// `watch_task` streams its view.
    #[frb(sync)]
    pub fn task(&self, request: NewTaskRequest) -> u64 {
        self.inner.task(request.into())
    }
    /// `task`'s view now, then every change; it ends with the task.
    pub fn watch_task(&self, task: u64, sink: StreamSink<NewTaskView>) {
        let mut views = self.inner.watch_task(task);
        handler::runtime().spawn(async move {
            while let Some(view) = views.next().await {
                if sink.add(view.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// The outcome of a requested intent. Fails when the core shut down,
    /// and `account_changed` once the account the service was opened in
    /// was left, also while the intent ran.
    pub async fn settled(&self, ticket: u64) -> Result<HomeSettled, CoreFailure> {
        self.inner
            .settled(ticket)
            .await
            .map(Into::into)
            .map_err(Into::into)
    }
}

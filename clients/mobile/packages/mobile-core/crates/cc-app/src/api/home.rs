//! `HomeService` (P8, final sweep): one computer's Home. The launcher
//! options, Home's choices and composer drafts in the encrypted store
//! (P8); the choice models Home's composer reads, the launcher's admission
//! and delivery observation, and the new task flow (final sweep). Intents
//! queue in call order; `request` returns a ticket whose outcome `settled`
//! reports, and `watch` streams the models, the launcher and the tasks.
use super::{
    ChatRefView, ChatsService, CoreFailure, CreatedWorktreeView, ModelRowView, WorktreesService,
    WriteFailure,
};
use crate::{
    account::View,
    api::CoreInner,
    chats::SendGate,
    home::{Handle, Intent, Outcome},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::oneshot;
use tokio::sync::watch;

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
    // ---- Choice models (`ComputerChatHomeModel`) ----
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
    // ---- The launcher (`ComputerHomeLauncher`) ----
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
    // ---- New tasks (`DeviceNewTaskModel`) ----
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
        launch: Box<HomeLaunchView>,
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
        view: Option<Box<NewTaskView>>,
    },
}

type Tickets = (u64, HashMap<u64, oneshot::Receiver<Outcome>>);
type Tasks = Mutex<HashMap<u64, TaskRegistration>>;

struct TaskRegistration {
    view: View<NewTaskView>,
    send_gate: SendGate,
}

/// One computer's Home. Built by `AccountService::home`.
#[derive(Clone)]
pub struct HomeService {
    inner: Arc<CoreInner>,
    handle: Handle,
    tickets: Arc<Mutex<Tickets>>,
    /// The last model and task ids issued.
    ids: Arc<AtomicU64>,
    tasks: Arc<Tasks>,
}

impl HomeService {
    pub(crate) fn new(inner: Arc<CoreInner>, handle: Handle) -> Self {
        Self {
            inner,
            handle,
            tickets: Arc::default(),
            ids: Arc::default(),
            tasks: Arc::default(),
        }
    }
    /// The models and the launcher: the current view, then each change.
    pub fn watch(&self) -> HomeViews {
        HomeViews {
            view: self.handle.view(),
            first: true,
        }
    }
    /// Follows `chats` (the computer's main read path) for the computer's
    /// unconfirmed send, and runs the new tasks' chat steps on it.
    ///
    /// Resolves when applied.
    pub fn bind_chats(&self, chats: &ChatsService) {
        let _ = self
            .handle
            .send(Intent::BindChats(chats.handle().clone()), None);
    }
    /// Runs the new tasks' worktree creations on `worktrees`.
    ///
    /// Resolves when applied.
    pub fn bind_worktrees(&self, worktrees: &WorktreesService) {
        let _ = self
            .handle
            .send(Intent::BindWorktrees(worktrees.clone()), None);
    }
    /// A new choice model for `context` (`personal` or
    /// `organization:<id>`), with the inventory its controller shows now.
    /// Its view is in [`HomeView::models`] until `Unmount`.
    ///
    /// Resolves when applied.
    pub fn model(&self, context: String, inventory: HomeInventoryView) -> u64 {
        let model = self.ids.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.handle.send(
            Intent::Mount {
                model,
                context,
                inventory: crate::home::inventory(inventory),
            },
            None,
        );
        model
    }
    /// A new task attempt; [`Self::watch_task`] streams its view.
    ///
    /// Resolves when applied.
    pub fn task(&self, request: NewTaskRequest) -> u64 {
        let task = self.ids.fetch_add(1, Ordering::SeqCst) + 1;
        let (publish, view) = watch::channel(Arc::new(NewTaskView {
            id: task,
            revision: 0,
            ready: false,
            sending: false,
            error: None,
            can_retry: false,
            flat: request.project.kind == "cowork",
            created: None,
            attempt_worktree_id: None,
            status_label: crate::copy::home::text(crate::copy::home::CopyKey::CreatingWorktree)
                .into(),
            target: None,
            confirmed: false,
        }));
        let view = View::new(view, self.handle.scope().clone());
        let send_gate = SendGate::default();
        self.tasks.lock().unwrap_or_else(|p| p.into_inner()).insert(
            task,
            TaskRegistration {
                view: view.clone(),
                send_gate: send_gate.clone(),
            },
        );
        // The view leaves the registry once the task's actor ended (or the
        // account was left), however the host disposed of the task.
        let tasks = Arc::downgrade(&self.tasks);
        let mut ended = view;
        self.inner.handle().spawn(async move {
            while ended.changed().await.is_ok() {}
            if let Some(tasks) = tasks.upgrade() {
                tasks
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&task);
            }
        });
        let _ = self.handle.send(
            Intent::StartTask {
                task,
                request: Box::new(request),
                publish,
                send_gate,
            },
            None,
        );
        task
    }
    /// `task`'s view, then each change; it ends when the task is disposed
    /// and its flows finished.
    pub fn watch_task(&self, task: u64) -> NewTaskViews {
        let view = self
            .tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&task)
            .map(|entry| entry.view.clone());
        NewTaskViews { view, first: true }
    }
    /// Queues `intent`; its outcome is not reported.
    pub fn send(&self, intent: HomeIntent) {
        let _ = self.handle.send(self::intent(intent, &self.tasks), None);
    }
    /// Queues `intent` and returns the ticket [`Self::settled`] takes.
    pub fn request(&self, intent: HomeIntent) -> u64 {
        let (tx, rx) = oneshot::channel();
        let mut tickets = self.tickets.lock().unwrap_or_else(|p| p.into_inner());
        tickets.0 += 1;
        let ticket = tickets.0;
        if self
            .handle
            .send(self::intent(intent, &self.tasks), Some(tx))
            .is_ok()
        {
            tickets.1.insert(ticket, rx);
        }
        ticket
    }
    /// The outcome of a [`Self::request`]ed intent. Fails when the core
    /// shut down (or the ticket is unknown), and `account_changed` once
    /// the account the service was opened in was left, also while the
    /// intent ran.
    pub async fn settled(&self, ticket: u64) -> Result<HomeSettled, CoreFailure> {
        let rx = self
            .tickets
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .1
            .remove(&ticket);
        let outcome = self.inner.ticket(self.handle.scope(), rx).await?;
        let outcome = match outcome {
            Outcome::Options(options) => HomeOutcome::Options { options: *options },
            Outcome::Choices(choices) => HomeOutcome::Choices { choices },
            Outcome::Drafts(drafts) => HomeOutcome::Drafts {
                drafts: drafts
                    .into_iter()
                    .map(|(context, text)| HomeDraftView { context, text })
                    .collect(),
            },
            Outcome::Saved(stored) => HomeOutcome::Saved { stored },
            Outcome::Failed(failure) => HomeOutcome::Failed {
                failure: failure.into(),
            },
            Outcome::Done => HomeOutcome::Done,
            Outcome::Flow(outcome, revision) => {
                return Ok(HomeSettled {
                    revision,
                    outcome: *outcome,
                });
            }
        };
        Ok(HomeSettled {
            revision: 0,
            outcome,
        })
    }
}

/// A requested intent's outcome and the [`HomeView`] revision that shows
/// it (0 for the P8 intents, which change no view).
#[derive(Debug, Clone, PartialEq)]
pub struct HomeSettled {
    pub revision: u64,
    pub outcome: HomeOutcome,
}

pub struct HomeViews {
    view: View<HomeView>,
    first: bool,
}

impl HomeViews {
    pub async fn next(&mut self) -> Option<HomeView> {
        if !self.first {
            self.view.changed().await.ok()?;
        }
        self.first = false;
        Some(self.view.latest()?.as_ref().clone())
    }
}

pub struct NewTaskViews {
    view: Option<View<NewTaskView>>,
    first: bool,
}

impl NewTaskViews {
    pub async fn next(&mut self) -> Option<NewTaskView> {
        let view = self.view.as_mut()?;
        if !self.first {
            view.changed().await.ok()?;
        }
        self.first = false;
        Some(view.latest()?.as_ref().clone())
    }
}

// Disposal closes the send gate before a pending Home write can delay cleanup.
fn intent(intent: HomeIntent, tasks: &Tasks) -> Intent {
    match intent {
        HomeIntent::LoadOptions { workspace_id } => Intent::Options { workspace_id },
        HomeIntent::Choices { context } => Intent::Choices { context },
        HomeIntent::SaveChoices { context, choices } => Intent::SaveChoices { context, choices },
        HomeIntent::Drafts => Intent::Drafts,
        HomeIntent::SetDraft { context, text } => Intent::SetDraft { context, text },
        HomeIntent::FlushDrafts => Intent::FlushDrafts,
        HomeIntent::Close => {
            for entry in tasks.lock().unwrap_or_else(|p| p.into_inner()).values() {
                entry.send_gate.cancel();
            }
            Intent::Close
        }
        HomeIntent::TaskDispose { task } => {
            if let Some(entry) = tasks.lock().unwrap_or_else(|p| p.into_inner()).get(&task) {
                entry.send_gate.cancel();
            }
            Intent::Flow(Box::new(HomeIntent::TaskDispose { task }))
        }
        other => Intent::Flow(Box::new(other)),
    }
}

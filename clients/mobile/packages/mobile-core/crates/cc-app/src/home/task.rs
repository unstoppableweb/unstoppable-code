//! One new task attempt, ported from `computer_connect/new_task_model.dart`
//! (`DeviceNewTaskModel`): it makes the first chat (a new worktree, a new
//! tab in an existing one, or a Cowork chat), applies Home's model and
//! effort, uploads Home's files, then sends the first message and observes
//! its delivery. Comments cite the Dart rule they keep.
//!
//! One actor task per attempt owns its state by value. A flow (`prepare`,
//! `send`) runs inline and awaits two kinds of steps: the core's own
//! (worktree creation on the worktrees actor; settings, picks and file
//! imports and sends on the chats actor) and host steps ([`TaskStep`])
//! for navigation, overview rows, and composer state.
//! A host step settles the request that drives the flow with
//! `Step`; the host's `StepDone` request carries the result and drives the
//! rest. While a flow waits, the actor still applies inventory, disposal
//! and delivery messages, and joins or queues further intents as Dart's
//! shared `_preparation` future did.
use super::{Msg as HomeMsg, Outcome, Waiter};
use crate::{
    account::View,
    api::{
        ChatRefView, CreatedWorktreeView, HomeAttachmentView, HomeOutcome, NewTaskRequest,
        NewTaskView, OverviewService, SentAttachmentView, TaskFailureKind, TaskModelView, TaskStep,
        TaskStepResult, WorktreeLoad, WorktreesService, WorktreesView,
    },
    chats::{
        self, ComposerIntent, FailKind as ChatFailKind, Intent as ChatIntent,
        Outcome as ChatOutcome, Published as ChatsPublished,
    },
    copy::{
        self,
        home::{CopyKey, text},
    },
    worktrees::{FailKind as WriteFailKind, Intent as WorktreesIntent},
};
use cc_domain::{
    chat::ChatRef,
    composer::selection::{resolve_effort, selection_model_option},
    dart::{Dv, DvMap},
    home::{Inventory, Project},
};
use std::{collections::VecDeque, future::Future, sync::Arc, time::Duration};
use tokio::{
    sync::{mpsc, oneshot, watch},
    time::Instant,
};

/// How long a closed attempt waits for the host to report the step it was
/// taking: twice a desktop request's 15 s limit. Past it the step's outcome
/// is unknown, so a send keeps its uploads.
const CLOSED_STEP_LIMIT: Duration = Duration::from_secs(30);

pub(crate) enum TaskMsg {
    Prepare(Option<Waiter>),
    Send {
        text: String,
        waiter: Option<Waiter>,
    },
    Retry {
        text: String,
        waiter: Option<Waiter>,
    },
    StepDone {
        result: TaskStepResult,
        waiter: Option<Waiter>,
    },
    Inventory(Inventory),
    /// The task's own delivery was confirmed (`onSent`).
    Confirmed,
    Dispose,
}

/// A failure as the flow throws it: Dart's exception kind and its message.
#[derive(Debug, Clone)]
struct Thrown {
    kind: TaskFailureKind,
    message: String,
}

impl Thrown {
    fn link(key: CopyKey) -> Self {
        Self {
            kind: TaskFailureKind::Link,
            message: text(key).into(),
        }
    }
    fn other() -> Self {
        Self {
            kind: TaskFailureKind::Other,
            message: String::new(),
        }
    }
    fn chat(f: &chats::Failure) -> Self {
        Self {
            kind: match f.kind {
                ChatFailKind::Link | ChatFailKind::Refused => TaskFailureKind::Link,
                ChatFailKind::NotSent => TaskFailureKind::NotSent,
                ChatFailKind::CreationNotSent => TaskFailureKind::CreationNotSent,
                ChatFailKind::Other => TaskFailureKind::Other,
            },
            message: f.message.clone(),
        }
    }
    /// `DeviceLinkException` (every kind but `Other`).
    fn is_link(&self) -> bool {
        self.kind != TaskFailureKind::Other
    }
}

/// Where a flow stopped early.
enum Stop {
    /// `return` (disposed or offline): nothing shown.
    Quiet,
    Thrown(Thrown),
}

impl From<Thrown> for Stop {
    fn from(t: Thrown) -> Self {
        Stop::Thrown(t)
    }
}

type Flow<T = ()> = Result<T, Stop>;

/// Why a host step has no result.
enum Unanswered {
    /// No request drives the flow, so the host was never asked.
    Unasked,
    /// The host did not report, because Home closed or a closed attempt
    /// waited [`CLOSED_STEP_LIMIT`]: the step may have run.
    Dropped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Prep {
    Idle,
    Running,
    /// Finished with the chat ready.
    Done,
}

enum Queued {
    Prepare(Option<Waiter>),
    /// A send; `joined` when it already joined the preparation that ran.
    Send {
        text: String,
        waiter: Option<Waiter>,
        joined: bool,
    },
}

pub(crate) struct Deps {
    pub(crate) id: u64,
    pub(crate) home: mpsc::UnboundedSender<HomeMsg>,
    pub(crate) publish: watch::Sender<Arc<NewTaskView>>,
    pub(crate) chats: Option<chats::Handle>,
    pub(crate) worktrees: Option<WorktreesService>,
    pub(crate) overview: Option<OverviewService>,
    pub(crate) delivery: u64,
    pub(crate) send_gate: chats::SendGate,
}

pub(crate) struct Handle {
    pub(crate) inbox: mpsc::UnboundedSender<TaskMsg>,
    send_gate: chats::SendGate,
}

impl Handle {
    pub(crate) fn dispose(&self) {
        self.send_gate.cancel();
        let _ = self.inbox.send(TaskMsg::Dispose);
    }
}

pub(crate) fn start(deps: Deps, request: NewTaskRequest) -> Handle {
    let (inbox_tx, inbox) = mpsc::unbounded_channel();
    let send_gate = deps.send_gate;
    let project = Project {
        id: request.project.id.clone(),
        kind: request.project.kind.clone(),
    };
    // `late final _attempt`: Dart begins it on the first read, which the
    // screen's first build makes.
    let attempt = deps
        .worktrees
        .as_ref()
        .map(|w| w.begin_attempt(request.project.id.clone(), request.base_branch.clone()));
    let wt_view = deps.worktrees.as_ref().map(WorktreesService::view);
    let chats_view = deps.chats.as_ref().map(chats::Handle::view);
    let task = Task {
        id: deps.id,
        inbox,
        home: deps.home,
        publish: deps.publish,
        chats: deps.chats,
        chats_view,
        worktrees: deps.worktrees,
        overview: deps.overview,
        wt_view,
        attempt,
        delivery: deps.delivery,
        send_gate: send_gate.clone(),
        project,
        worktree_id: request.worktree_id,
        model: request.model,
        thinking_level: request.thinking_level,
        scoped: request.scoped,
        inv: super::inventory(request.inventory),
        attachments: request.attachments,
        uploaded: Vec::new(),
        uploads_spent: false,
        prep: Prep::Idle,
        created: None,
        ready: false,
        sending: false,
        creation_not_sent: false,
        send_requested: false,
        error: None,
        disposed: false,
        settling: false,
        confirmed: false,
        target: None,
        driver: None,
        joiners: Vec::new(),
        queue: VecDeque::new(),
    };
    task.publish();
    let (id, home) = (task.id, task.home.clone());
    tokio::spawn(async move {
        task.run().await;
        let _ = home.send(HomeMsg::TaskEnded(id));
    });
    Handle {
        inbox: inbox_tx,
        send_gate,
    }
}

struct Task {
    id: u64,
    inbox: mpsc::UnboundedReceiver<TaskMsg>,
    home: mpsc::UnboundedSender<HomeMsg>,
    publish: watch::Sender<Arc<NewTaskView>>,
    chats: Option<chats::Handle>,
    chats_view: Option<View<ChatsPublished>>,
    worktrees: Option<WorktreesService>,
    overview: Option<OverviewService>,
    wt_view: Option<View<WorktreesView>>,
    attempt: Option<u64>,
    delivery: u64,
    send_gate: chats::SendGate,
    project: Project,
    worktree_id: Option<String>,
    model: Option<TaskModelView>,
    thinking_level: Option<String>,
    scoped: bool,
    inv: Inventory,
    attachments: Vec<HomeAttachmentView>,
    /// Computer paths by Home file, kept across retries in the same target.
    uploaded: Vec<(String, String)>,
    /// A send that has or may have reached the computer named the uploads.
    uploads_spent: bool,
    prep: Prep,
    created: Option<CreatedWorktreeView>,
    ready: bool,
    sending: bool,
    creation_not_sent: bool,
    send_requested: bool,
    error: Option<String>,
    disposed: bool,
    /// The computer has or may have the first message: the steps that
    /// settle it run also once the attempt closed.
    settling: bool,
    confirmed: bool,
    target: Option<ChatRef>,
    /// The request the running flow's next step or end settles.
    driver: Option<Waiter>,
    /// `prepare` callers that joined the running preparation.
    joiners: Vec<Waiter>,
    queue: VecDeque<Queued>,
}

fn chat_view(c: &ChatRef) -> ChatRefView {
    ChatRefView {
        project_id: c.project_id.clone(),
        worktree_id: c.worktree_id.clone(),
        id: c.id.clone(),
        title: c.title.clone(),
    }
}

fn chat_ref(c: &ChatRefView) -> ChatRef {
    ChatRef {
        project_id: c.project_id.clone(),
        worktree_id: c.worktree_id.clone(),
        id: c.id.clone(),
        title: c.title.clone(),
    }
}

fn answer(waiter: Option<Waiter>, outcome: HomeOutcome) {
    if let Some(waiter) = waiter {
        let _ = waiter.send(Outcome::Flow(Box::new(outcome), 0));
    }
}

impl Task {
    fn flat(&self) -> bool {
        self.project.kind == "cowork"
    }

    fn attempt_view(&self) -> Option<crate::api::AttemptView> {
        let id = self.attempt?;
        self.wt_view
            .as_ref()?
            .current()?
            .attempts
            .iter()
            .find(|a| a.id == id)
            .cloned()
    }

    fn can_retry(&self) -> bool {
        self.target.is_some()
            || if self.worktree_id.is_some() || self.flat() {
                self.creation_not_sent
            } else {
                self.attempt_view().is_some_and(|a| a.can_retry)
            }
    }

    fn view(&self) -> NewTaskView {
        let attempt = self.attempt_view();
        let worktree = attempt.as_ref().and_then(|a| a.worktree_id.clone());
        NewTaskView {
            id: self.id,
            revision: 0,
            ready: self.ready,
            sending: self.sending,
            error: self.error.clone(),
            can_retry: self.can_retry(),
            flat: self.flat(),
            created: self.created.clone(),
            status_label: text(if worktree.is_none() {
                CopyKey::CreatingWorktree
            } else {
                CopyKey::SettingUpWorktree
            })
            .into(),
            attempt_worktree_id: worktree,
            target: self.target.as_ref().map(chat_view),
            confirmed: self.confirmed,
        }
    }

    /// The flow's end, with the view that shows it.
    fn done(&self) -> HomeOutcome {
        HomeOutcome::Task {
            task: self.id,
            view: Some(Box::new(self.publish.borrow().as_ref().clone())),
        }
    }

    fn publish(&self) {
        let mut view = self.view();
        self.publish.send_if_modified(|current| {
            view.revision = current.revision;
            if **current == view {
                return false;
            }
            view.revision += 1;
            *current = Arc::new(view);
            true
        });
    }

    /// `_scopeValid`.
    fn scope_valid(&self) -> bool {
        !self.scoped
            || (self.inv.active && !self.inv.scope_pending && self.inv.owns(&self.project.id))
    }

    /// `_requireScope`.
    fn require_scope(&self) -> Flow {
        if self.scope_valid() {
            Ok(())
        } else {
            Err(Thrown::link(CopyKey::ProjectsChangedCheck).into())
        }
    }

    /// `if (_disposed || !model.online) return;`.
    fn live(&self) -> Flow {
        if self.disposed || !self.inv.online {
            Err(Stop::Quiet)
        } else {
            Ok(())
        }
    }

    async fn run(mut self) {
        loop {
            if self.disposed && self.queue.is_empty() {
                // Late intents get their answers until the inbox closes.
                while let Ok(msg) = self.inbox.try_recv() {
                    self.idle(msg);
                }
                return;
            }
            let msg = match self.queue.pop_front() {
                Some(Queued::Prepare(waiter)) => {
                    self.driver = waiter;
                    self.prepare().await;
                    self.finish();
                    continue;
                }
                Some(Queued::Send {
                    text,
                    waiter,
                    joined,
                }) => {
                    self.driver = waiter;
                    self.send_after_prepare(text, joined).await;
                    self.finish();
                    continue;
                }
                None => match self.next().await {
                    Some(msg) => msg,
                    None => return,
                },
            };
            match msg {
                TaskMsg::Prepare(waiter) => {
                    self.driver = waiter;
                    self.prepare().await;
                    self.finish();
                }
                TaskMsg::Send { text, waiter } => {
                    self.driver = waiter;
                    self.send(text).await;
                    self.finish();
                }
                TaskMsg::Retry { text, waiter } => {
                    self.driver = waiter;
                    // `retryCreation`.
                    if self.can_retry() {
                        if self.flat() || self.send_requested {
                            self.send(text).await;
                        } else {
                            self.prepare().await;
                        }
                    }
                    self.finish();
                }
                other => self.idle(other),
            }
        }
    }

    /// The next message, also waking when the attempt's view changed.
    async fn next(&mut self) -> Option<TaskMsg> {
        loop {
            let changed = async {
                match self.wt_view.as_mut() {
                    Some(view) => view.changed().await.is_ok(),
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                msg = self.inbox.recv() => return msg,
                alive = changed => {
                    if !alive {
                        self.wt_view = None;
                    }
                    // Dart's attempt notified the task when the computer
                    // answered its create.
                    self.publish();
                }
            }
        }
    }

    /// Settles the flow's driver once the flow ended.
    fn finish(&mut self) {
        self.publish();
        answer(self.driver.take(), self.done());
    }

    /// A message while no flow runs, or one a flow does not wait for.
    fn idle(&mut self, msg: TaskMsg) {
        match msg {
            TaskMsg::Inventory(inv) => self.inv = inv,
            TaskMsg::Confirmed => self.confirmed = true,
            TaskMsg::Dispose => self.dispose(),
            TaskMsg::StepDone { waiter, .. } => {
                answer(waiter, self.done());
            }
            TaskMsg::Prepare(waiter) => match self.prep {
                // `_preparation` is the running future: join it.
                Prep::Running => {
                    if let Some(w) = waiter {
                        self.joiners.push(w);
                    }
                }
                // A ready preparation stays.
                Prep::Done => answer(waiter, self.done()),
                Prep::Idle => self.queue.push_back(Queued::Prepare(waiter)),
            },
            TaskMsg::Send { text, waiter } => {
                // `send()`'s synchronous start, then it awaits `prepare()`.
                if text.trim().is_empty() || self.sending || !self.inv.online {
                    answer(waiter, self.done());
                } else {
                    self.send_requested = true;
                    self.sending = true;
                    let joined = self.prep == Prep::Running;
                    self.queue.push_back(Queued::Send {
                        text,
                        waiter,
                        joined,
                    });
                }
            }
            TaskMsg::Retry { text, waiter } => {
                if !self.can_retry() {
                    answer(waiter, self.done());
                } else if self.flat() || self.send_requested {
                    self.idle(TaskMsg::Send { text, waiter });
                } else {
                    self.idle(TaskMsg::Prepare(waiter));
                }
            }
        }
        self.publish();
    }

    /// Awaits `work` while applying the messages that arrive meanwhile.
    async fn wait<T>(&mut self, work: impl Future<Output = T>) -> T {
        tokio::pin!(work);
        loop {
            let changed = async {
                match self.wt_view.as_mut() {
                    Some(view) => view.changed().await.is_ok(),
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                out = &mut work => return out,
                msg = self.inbox.recv() => match msg {
                    Some(msg) => self.idle(msg),
                    None => return work.await,
                },
                alive = changed => {
                    if !alive {
                        self.wt_view = None;
                    }
                    // Dart's attempt notified the task when the computer
                    // answered its create.
                    self.publish();
                }
            }
        }
    }

    /// Asks the host to take `step` and waits for its result.
    async fn ask(&mut self, step: TaskStep) -> Result<TaskStepResult, Unanswered> {
        self.publish();
        // A closed attempt takes no chat action: it only settles a send.
        if self.disposed && !self.settling {
            return Err(Unanswered::Unasked);
        }
        let Some(driver) = self.driver.take() else {
            return Err(Unanswered::Unasked);
        };
        let _ = driver.send(Outcome::Flow(
            Box::new(HomeOutcome::Step {
                task: self.id,
                step,
            }),
            0,
        ));
        let mut limit = None;
        loop {
            if self.disposed && limit.is_none() {
                limit = Some(Instant::now() + CLOSED_STEP_LIMIT);
            }
            let msg = match limit {
                None => self.next().await,
                Some(limit) => match tokio::time::timeout_at(limit, self.next()).await {
                    Ok(msg) => msg,
                    Err(_) => return Err(Unanswered::Dropped),
                },
            };
            match msg {
                Some(TaskMsg::StepDone { result, waiter }) => {
                    self.driver = waiter;
                    self.inv.online = result.online;
                    return Ok(result);
                }
                Some(other) => self.idle(other),
                None => return Err(Unanswered::Dropped),
            }
        }
    }

    /// [`Task::ask`], failing a step the host did not answer.
    async fn host(&mut self, step: TaskStep) -> TaskStepResult {
        let failure = Some(crate::api::TaskFailure {
            kind: TaskFailureKind::Other,
            message: String::new(),
        });
        match self.ask(step).await {
            Ok(result) => result,
            Err(Unanswered::Unasked) => TaskStepResult {
                failure,
                online: self.inv.online,
            },
            Err(Unanswered::Dropped) => TaskStepResult {
                failure,
                ..TaskStepResult::default()
            },
        }
    }

    /// A host step that throws its failure.
    async fn host_ok(&mut self, step: TaskStep) -> Flow<TaskStepResult> {
        let result = self.host(step).await;
        if let Some(f) = &result.failure {
            return Err(Thrown {
                kind: f.kind,
                message: f.message.clone(),
            }
            .into());
        }
        Ok(result)
    }

    /// A chats-actor intent, its failure thrown as Dart's `settle` threw.
    async fn chat(&mut self, intent: ChatIntent) -> Flow<Option<ChatOutcome>> {
        let Some(chats) = self.chats.clone() else {
            return Err(Thrown::other().into());
        };
        let (tx, rx) = oneshot::channel();
        match self.send_gate.dispatch(|| chats.send(intent, Some(tx))) {
            Some(Ok(())) => {}
            Some(Err(_)) => return Err(Thrown::other().into()),
            None => return Err(Stop::Quiet),
        }
        let settled = self
            .wait(rx)
            .await
            .map_err(|_| Stop::from(Thrown::other()))?;
        if let Some(f) = &settled.failure {
            return Err(Thrown::chat(f).into());
        }
        Ok(settled.outcome)
    }

    fn published(&self) -> Option<Arc<ChatsPublished>> {
        self.chats_view.as_ref().and_then(View::current)
    }

    /// The task's target, while the chats actor still has it selected.
    fn state_ref(&self) -> Flow<ChatRef> {
        let selected = self
            .published()
            .and_then(|view| view.selected.as_ref().map(|selected| selected.chat.clone()));
        selected
            .filter(|selected| {
                self.target
                    .as_ref()
                    .is_some_and(|target| target.key() == selected.key())
            })
            .ok_or_else(|| Thrown::link(CopyKey::ChatNotOpen).into())
    }

    async fn delivery(&mut self, msg: super::DeliveryCmd) -> bool {
        let tracking = matches!(msg, super::DeliveryCmd::Track(..));
        let (tx, rx) = oneshot::channel();
        if self
            .home
            .send(HomeMsg::Delivery(self.delivery, msg, tx))
            .is_err()
        {
            return false;
        }
        let accepted = rx.await.unwrap_or(false);
        if tracking && accepted {
            // Home can forward a cancellation before acknowledging tracking.
            while let Ok(msg) = self.inbox.try_recv() {
                self.idle(msg);
            }
        }
        accepted
    }

    // ---- prepare ----

    /// `prepare()`: joins the running preparation, keeps a ready one.
    async fn prepare(&mut self) {
        match self.prep {
            Prep::Done => return,
            // Joined: the queue runs it after the running flow.
            Prep::Running => return,
            Prep::Idle => {}
        }
        self.prep = Prep::Running;
        self.prepare_target().await;
        if !self.ready {
            self.prep = Prep::Idle;
        } else {
            self.prep = Prep::Done;
        }
        for w in std::mem::take(&mut self.joiners) {
            answer(Some(w), self.done());
        }
    }

    /// `_prepareTarget`, with its `catch`.
    async fn prepare_target(&mut self) {
        match self.prepare_steps().await {
            Ok(()) | Err(Stop::Quiet) => {}
            Err(Stop::Thrown(error)) => {
                if !self.disposed {
                    self.creation_not_sent = error.kind == TaskFailureKind::CreationNotSent
                        || (self.worktree_id.is_some() && error.kind == TaskFailureKind::NotSent);
                    self.error = Some(if error.is_link() {
                        error.message
                    } else if self.attempt_view().and_then(|a| a.worktree_id).is_some() {
                        text(CopyKey::StillSettingUp).into()
                    } else {
                        text(CopyKey::CreationNotConfirmed).into()
                    });
                    self.publish();
                }
            }
        }
    }

    async fn prepare_steps(&mut self) -> Flow {
        self.error = None;
        self.creation_not_sent = false;
        self.publish();
        if !self.scope_valid() {
            return Err(Thrown::link(CopyKey::ProjectsChangedChoose).into());
        }
        if self.target.is_none() && self.published().is_some_and(|p| p.pending.is_some()) {
            return Err(Thrown::link(CopyKey::CheckDelivery).into());
        }
        let expected = self.selection_generation()?;
        if let Some(target) = self.target.clone() {
            self.open(target, expected).await?;
        } else if let Some(tree) = self.worktree_id.clone() {
            self.create_chat(Some(tree), expected).await?;
        } else if self.flat() {
            self.create_chat(None, expected).await?;
        } else {
            self.create_worktree(expected).await?;
        }
        self.live()?;
        self.require_scope()?;
        self.state_ref()?;
        // Resolve options from the created chat before applying the first
        // send's settings, including when the composer inherited the
        // desktop model.
        let settings = self.model.is_some() || self.thinking_level.is_some();
        if settings {
            self.chat(ChatIntent::Composer(ComposerIntent::LoadSettings {
                report: false,
            }))
            .await?;
            self.live()?;
            self.require_scope()?;
        }
        if let Some(choice) = self.model.clone() {
            let models = self
                .published()
                .map(|p| p.composer.catalog.models.clone())
                .unwrap_or_default();
            let Some(current) =
                selection_model_option(&models, Some(&choice.id), choice.harness.as_deref())
            else {
                return Err(Thrown::link(CopyKey::ModelGone).into());
            };
            let chat = self.state_ref()?;
            let outcome = self
                .chat(ChatIntent::Composer(ComposerIntent::SelectModel {
                    chat,
                    id: current.id,
                    provider: current.provider,
                    harness: current.harness,
                }))
                .await?;
            // `_saved`: a save without its revision threw.
            if !matches!(outcome, Some(ChatOutcome::Saved { .. })) {
                return Err(Thrown::other().into());
            }
        }
        self.live()?;
        self.require_scope()?;
        if let Some(level) = self.thinking_level.clone() {
            let published = self.published();
            let empty = DvMap::new();
            let selected = self.state_ref()?;
            let tab = published
                .as_ref()
                .and_then(|p| p.selected.as_ref())
                .filter(|s| selected.key() == s.chat.key())
                .map_or(&empty, |s| &s.state.tab);
            let models = published
                .as_ref()
                .map(|p| p.composer.catalog.models.as_slice())
                .unwrap_or_default();
            let field = |key: &str| tab.get(key).as_str();
            let choice = self.model.as_ref();
            let effort = resolve_effort(
                models,
                choice.map(|m| m.id.as_str()).or_else(|| field("model")),
                choice
                    .and_then(|m| m.harness.as_deref())
                    .or_else(|| field("executionHarness")),
                choice
                    .map(|m| m.provider.as_str())
                    .or_else(|| field("providerType")),
                &level,
                None,
                None,
            );
            if !effort.levels.is_empty() {
                let chat = self.state_ref()?;
                let mut patch = DvMap::new();
                patch.insert("thinkingLevel".into(), Dv::Str(effort.level));
                let outcome = self
                    .chat(ChatIntent::Composer(ComposerIntent::Patch { chat, patch }))
                    .await?;
                if !matches!(outcome, Some(ChatOutcome::Saved { .. })) {
                    return Err(Thrown::other().into());
                }
            }
        }
        self.live()?;
        self.require_scope()?;
        if settings {
            let chat = self.state_ref()?;
            let generation = self.selection_generation()?;
            self.chat(ChatIntent::Refresh { chat, generation }).await?;
        }
        self.live()?;
        self.require_scope()?;
        self.state_ref()?;
        // Home's files upload before the chat is shown, so a refusal keeps
        // this creation view with its error and Retry, and the chat
        // composer cannot send the text without them.
        self.upload_attachments().await?;
        self.live()?;
        self.require_scope()?;
        self.host_ok(TaskStep::SetDraft {
            chat: self.target.as_ref().map(chat_view),
        })
        .await?;
        self.host_ok(TaskStep::SetWorkspaceKind {
            project_id: self.project.id.clone(),
            kind: self.project.kind.clone(),
        })
        .await?;
        self.ready = true;
        self.publish();
        Ok(())
    }

    fn selection_generation(&self) -> Flow<u64> {
        self.published()
            .map(|view| view.generation)
            .ok_or_else(|| Thrown::other().into())
    }

    async fn open(&mut self, chat: ChatRef, expected: u64) -> Flow {
        let opened = self
            .chat(ChatIntent::OpenCurrent { chat, expected })
            .await?;
        if !matches!(opened, Some(ChatOutcome::Opened { selected: true, .. })) {
            return Err(Thrown::link(CopyKey::ChatNotOpen).into());
        }
        Ok(())
    }

    async fn create_chat(&mut self, worktree: Option<String>, expected: u64) -> Flow {
        self.live()?;
        self.require_scope()?;
        let project = self.project.id.clone();
        let intent = match worktree {
            Some(worktree_id) => ChatIntent::CreateTab {
                expected: Some(expected),
                project_id: project,
                worktree_id,
            },
            None => ChatIntent::CreateChat {
                expected: Some(expected),
                workspace: project,
                title: None,
            },
        };
        let Some(ChatOutcome::Created(chat)) = self.chat(intent).await? else {
            return Err(Thrown::link(CopyKey::ChatNotOpen).into());
        };
        self.target = Some(chat.clone());
        self.publish();
        self.live()?;
        self.require_scope()?;
        self.open(chat, expected).await
    }

    /// The code project branch: create the worktree, load it, open its
    /// active chat or a new tab.
    async fn create_worktree(&mut self, expected: u64) -> Flow {
        let (Some(worktrees), Some(attempt)) = (self.worktrees.clone(), self.attempt) else {
            return Err(Thrown::other().into());
        };
        let (tx, rx) = oneshot::channel();
        if worktrees
            .handle()
            .send(WorktreesIntent::Create { attempt }, Some(tx))
            .is_err()
        {
            return Err(Thrown::other().into());
        }
        let settled = self
            .wait(rx)
            .await
            .map_err(|_| Stop::from(Thrown::other()))?;
        if let Some(f) = settled.failure {
            return Err(Thrown {
                kind: match f.kind {
                    WriteFailKind::Link | WriteFailKind::Refused => TaskFailureKind::Link,
                    WriteFailKind::NotSent => TaskFailureKind::NotSent,
                    WriteFailKind::Other => TaskFailureKind::Other,
                },
                message: f.message,
            }
            .into());
        }
        let Some(created) = settled.created else {
            return Err(Thrown::other().into());
        };
        self.live()?;
        self.created = Some(created.clone());
        let overview = self.overview.clone().ok_or_else(Thrown::other)?;
        let loaded = self
            .wait(overview.load_worktree(
                created.project_id.clone(),
                created.id.clone(),
                Some("active".into()),
                0,
            ))
            .await;
        self.live()?;
        self.require_scope()?;
        let chat = match loaded {
            Ok(WorktreeLoad::Loaded(chats)) => chats
                .chats
                .iter()
                .find(|c| Some(&c.id) == chats.active_chat_id.as_ref())
                .or_else(|| chats.chats.first())
                .map(chat_ref),
            Ok(WorktreeLoad::Unavailable | WorktreeLoad::SessionLost) => {
                return Err(Thrown::link(CopyKey::CreatedUnavailable).into());
            }
            Ok(WorktreeLoad::Stale) | Err(_) => None,
        };
        match chat {
            None => self.create_chat(Some(created.id), expected).await,
            Some(chat) => {
                self.target = Some(chat.clone());
                self.open(chat, expected).await
            }
        }
    }

    /// `_uploadAttachments`: each Home file not yet stored in the target,
    /// one at a time.
    async fn upload_attachments(&mut self) -> Flow {
        let Some(target) = self.target.clone() else {
            return Ok(());
        };
        for draft in self.attachments.clone() {
            if self.uploaded.iter().any(|(id, _)| *id == draft.local_id) {
                continue;
            }
            let result = self
                .chat(ChatIntent::ImportAttachment {
                    scope: target.clone(),
                    filename: draft.filename.clone(),
                    bytes: draft.bytes.clone(),
                })
                .await;
            match result {
                Ok(Some(ChatOutcome::Stored { path, .. })) => {
                    if self.disposed {
                        // This attempt is gone; nothing will send the late
                        // copy.
                        self.delete_upload(&target, &path);
                        return Ok(());
                    }
                    self.uploaded.push((draft.local_id.clone(), path));
                }
                failed => {
                    let reason = match failed {
                        Err(Stop::Thrown(t)) if t.is_link() => t.message,
                        _ => text(CopyKey::TryAgain).into(),
                    };
                    return Err(Thrown {
                        kind: TaskFailureKind::Link,
                        message: copy::render(
                            text(CopyKey::AttachFailed),
                            &[("filename", &draft.filename), ("reason", &reason)],
                        ),
                    }
                    .into());
                }
            }
        }
        Ok(())
    }

    /// Best effort: a copy left behind only takes space in the chat's
    /// folder. The stored name is the path's last segment.
    fn delete_upload(&self, scope: &ChatRef, path: &str) {
        let Some(chats) = &self.chats else {
            return;
        };
        let filename = path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned();
        let _ = chats.send(
            ChatIntent::DeleteAttachment {
                scope: scope.clone(),
                filename,
            },
            None,
        );
    }

    fn delete_uploads(&mut self) {
        let Some(target) = &self.target else {
            return;
        };
        for (_, path) in std::mem::take(&mut self.uploaded) {
            self.delete_upload(target, &path);
        }
    }

    fn dispose(&mut self) {
        if self.disposed {
            return;
        }
        self.disposed = true;
        if !self.uploads_spent {
            self.delete_uploads();
        }
        let _ = self
            .home
            .send(HomeMsg::DeliveryDropped(self.delivery, self.id));
        if let (Some(worktrees), Some(attempt)) = (&self.worktrees, self.attempt) {
            let _ = worktrees
                .handle()
                .send(WorktreesIntent::Release { attempt }, None);
        }
    }

    // ---- send ----

    /// `send()`.
    async fn send(&mut self, text: String) {
        if text.trim().is_empty() || self.sending || !self.inv.online {
            return;
        }
        self.send_requested = true;
        self.sending = true;
        self.publish();
        let joined = self.prep == Prep::Running;
        self.send_after_prepare(text, joined).await;
    }

    /// The rest of `send()` from its `await prepare()`.
    async fn send_after_prepare(&mut self, text: String, joined: bool) {
        let text = text.trim().to_owned();
        if !joined {
            self.prepare().await;
        }
        if self.disposed || !self.ready {
            self.sending = false;
            self.publish();
            return;
        }
        // The first message must reach the chat this attempt created or
        // opened: the draft and send name it, and the send fails if another
        // chat is open by then.
        let target = self.target.clone();
        let selection = self.published().and_then(|view| {
            view.selected
                .as_ref()
                .map(|selected| (selected.chat.key(), view.generation))
        });
        let Some((target, generation)) =
            target
                .zip(selection)
                .and_then(|(target, (selected, generation))| {
                    (target.key() == selected).then_some((target, generation))
                })
        else {
            self.ready = false;
            self.prep = Prep::Idle;
            self.error = Some(self::text(CopyKey::ChatNotOpen).into());
            self.sending = false;
            self.publish();
            return;
        };
        // Set once the computer may have the message.
        let mut reached = false;
        let spent = self.uploads_spent;
        let attachments: Vec<SentAttachmentView> = self
            .attachments
            .iter()
            .filter_map(|draft| {
                self.uploaded
                    .iter()
                    .find(|(id, _)| *id == draft.local_id)
                    .map(|(local_id, path)| SentAttachmentView {
                        local_id: local_id.clone(),
                        path: path.clone(),
                    })
            })
            .collect();
        let result: Flow = async {
            self.chat(ChatIntent::SetDraft {
                chat: target.clone(),
                text: text.clone(),
                seq: 0,
            })
            .await?;
            if !self
                .delivery(super::DeliveryCmd::Track(target.clone(), text.clone()))
                .await
            {
                // Delivery tracking belongs to one chat and prompt.
                return Err(Thrown::other().into());
            }
            self.live()?;
            self.require_scope()?;
            let chats = self.chats.as_ref().ok_or_else(Thrown::other)?;
            let (tx, rx) = oneshot::channel();
            chats
                .send(
                    ChatIntent::Send(chats::SendIntent {
                        chat: Some(target.clone()),
                        generation: Some(generation),
                        gate: Some(self.send_gate.clone()),
                        text: text.clone(),
                        retry: false,
                        dictated: false,
                        attachment_paths: attachments.iter().map(|a| a.path.clone()).collect(),
                    }),
                    Some(tx),
                )
                .map_err(|_| Thrown::other())?;

            // Keep the uploads while the send is outstanding, including
            // if the screen closes or the actor disappears before replying.
            reached = true;
            self.uploads_spent = true;
            let settled = self.wait(rx).await.map_err(|_| Thrown::other())?;
            if let Some(failure) = settled.failure {
                reached = false;
                return Err(Thrown::chat(&failure).into());
            }
            if settled.outcome.is_none() {
                reached = false;
                self.dispose();
                return Err(Stop::Quiet);
            }
            if matches!(settled.outcome, Some(ChatOutcome::Sent { .. })) && !attachments.is_empty()
            {
                self.settling = true;
                self.host(TaskStep::Sent { attachments }).await;
            }
            Ok(())
        }
        .await;
        self.settling = false;
        if let Err(stop) = result {
            let error = match stop {
                Stop::Thrown(t) => t,
                Stop::Quiet => Thrown::other(),
            };
            // The computer does not have this message: only an earlier send
            // can name the uploads.
            if !reached {
                self.uploads_spent = spent;
                if self.disposed && !spent {
                    self.delete_uploads();
                }
                // Only this view's Retry can send an edited prompt.
                if !self.attachments.is_empty() {
                    self.delivery(super::DeliveryCmd::Release).await;
                }
            }
            if !self.disposed {
                // The chat's own composer cannot carry Home's files, and
                // another open chat is not this attempt's: return to this
                // view, whose Retry opens the chat and resends.
                let still_open = self.published().is_some_and(|p| {
                    p.generation == generation
                        && p.selected
                            .as_ref()
                            .is_some_and(|s| s.chat.key() == target.key())
                });
                if !self.attachments.is_empty() || !still_open {
                    self.ready = false;
                    self.prep = Prep::Idle;
                }
                self.error = Some(if error.is_link() {
                    error.message
                } else {
                    self::text(CopyKey::SendFailed).into()
                });
            }
        }
        self.sending = false;
        self.publish();
    }
}

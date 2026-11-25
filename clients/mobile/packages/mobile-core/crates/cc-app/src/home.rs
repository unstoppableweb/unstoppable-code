//! One computer's Home (architecture §3.7, P8): the launcher options read,
//! ported from `device_link/chats/home_options.dart` (the model catalog and
//! saved default with the chat composer's `composer::registry` rules), and
//! Home's two records in the encrypted store,
//! which replace Dart's `ComputerChatSelectionStore` (choices) and the
//! `computer:home:*` drafts in the account's draft file (D9: Dart's are not
//! imported). Comments cite the Dart rule they keep.
//!
//! One actor task owns the records: intents apply in order, store reads and
//! writes run on the blocking pool and finish before the next intent, and
//! drafts are written 500 ms after the last change (`FileChatDraftStore`'s
//! debounce), on `FlushDrafts` and at close. A failed draft write keeps the
//! drafts and is retried with the next change or flush. The options read
//! needs no state and runs on its own.
//!
//! Since the final sweep the actor also runs Home's choice models
//! (`model`), the launcher with the delivery observers of its launches, and
//! starts one actor per new task (`task`). It follows the chats actor's
//! published selection (`bind_chats`) for the computer's unconfirmed send.
//!
//! Records: drafts `{"v": 1, "drafts": {"<context>": {"text": "…",
//! "updatedAtMs": <ms>}}}`; choices `{"v": 1, "choices": {"<context>":
//! {"projectId": …, "worktreeId": …, "baseBranch": …, "modelId": …,
//! "executionHarness": …, "thinkingLevel": …}}}` (absent fields are null).
mod model;
mod task;

use crate::{
    account::{Flusher, Inbox, Scope, View, Writes},
    api::{
        ChatRefView, HomeChoicesView, HomeDraftClearView, HomeIntent, HomeInventoryView,
        HomeLaunchView, HomeModelView, HomeOptionsView, HomeOutcome, HomePick, HomeView,
        LauncherView, NewTaskRequest, NewTaskView, OverviewService, ProviderAvailabilityView,
        WorktreesService, model_row,
    },
    bridge::{Inner, shutdown_failure},
    chats::{self, Peer, Published as ChatsPublished},
    copy::home::{CopyKey, text as copy_text},
    error::Result,
    ports::HomeRecord,
    worktrees::{FailKind, Failure, call},
};
use cc_domain::{
    chat::{ChatRef, Thrown, object},
    composer::selection::selection_model_option,
    composer::{ModelOption, registry},
    dart::{Dv, DvMap},
    drafts::{Draft, DraftBook},
    home::{self as domain, Inventory},
};
use cc_protocol::{FailureKind, dto};
use model::{Changed, Model, Options};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Weak},
    time::Duration,
};
use task::TaskMsg;
use tokio::{
    runtime::Handle as Runtime,
    sync::{mpsc, oneshot, watch},
};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// `FileChatDraftStore`'s write debounce.
const DEBOUNCE: Duration = Duration::from_millis(500);
const VERSION: u64 = 1;

pub(crate) enum Intent {
    Options {
        workspace_id: String,
    },
    Choices {
        context: String,
    },
    SaveChoices {
        context: String,
        choices: HomeChoicesView,
    },
    Drafts,
    SetDraft {
        context: String,
        text: String,
    },
    FlushDrafts,
    Close,
    /// The final sweep's intents, as the API declares them.
    Flow(Box<HomeIntent>),
    /// A new choice model (`ComputerChatHomeModel`'s constructor).
    Mount {
        model: u64,
        context: String,
        inventory: Inventory,
    },
    /// A new task attempt; its view goes to `publish`.
    StartTask {
        task: u64,
        request: Box<NewTaskRequest>,
        publish: watch::Sender<Arc<NewTaskView>>,
        send_gate: chats::SendGate,
    },
    BindChats(chats::Handle),
    BindWorktrees(WorktreesService),
    BindOverview(OverviewService),
}

pub(crate) enum Outcome {
    Options(Box<HomeOptionsView>),
    Choices(HomeChoicesView),
    Drafts(Vec<(String, String)>),
    /// Whether a write reached the store.
    Saved(bool),
    Failed(Failure),
    Done,
    /// A final-sweep outcome and the view revision that shows it.
    Flow(Box<HomeOutcome>, u64),
}

pub(crate) type Waiter = oneshot::Sender<Outcome>;

/// A task's message about the delivery of its first message.
pub(crate) enum DeliveryCmd {
    /// `track(ref, text)`; answers `false` when the delivery already
    /// tracks another chat or prompt (Dart threw).
    Track(ChatRef, String),
    /// `release()`.
    Release,
}

pub(crate) enum Msg {
    Intent(Intent, Option<Waiter>),
    Timer(u64),
    /// The options read of `model`'s `generation` for a project of `kind`.
    Options {
        model: u64,
        generation: u64,
        kind: String,
        result: std::result::Result<Box<Options>, Option<String>>,
    },
    /// `load()` after its `await store.read()`: the saved choices of
    /// `model`, applied behind the inventory changes that arrived while
    /// the read ran.
    Restore {
        model: u64,
        saved: HomeChoicesView,
        waiter: Option<Waiter>,
    },
    Chats(Arc<ChatsPublished>),
    Delivery(u64, DeliveryCmd, oneshot::Sender<bool>),
    /// Task `.1` left; its own delivery `.0` goes with it.
    DeliveryDropped(u64, u64),
    /// The task's actor ended. A task that left keeps its inbox until
    /// then, so the host still reports the step it was taking.
    TaskEnded(u64),
}

impl Msg {
    /// Draft edits and choice saves still apply when queued as the account
    /// is left, so their records keep them. A project pick saves only
    /// after a read of the computer, which the account no longer reaches.
    fn saves(&self) -> bool {
        match self {
            Self::Intent(
                Intent::SetDraft { .. } | Intent::FlushDrafts | Intent::SaveChoices { .. },
                _,
            ) => true,
            Self::Intent(Intent::Flow(intent), _) => matches!(
                &**intent,
                HomeIntent::Select { pick, .. } if !matches!(pick, HomePick::Project { .. })
            ),
            _ => false,
        }
    }
}

#[derive(Clone)]
pub(crate) struct Handle {
    inbox: mpsc::UnboundedSender<Msg>,
    view: View<HomeView>,
}

impl Handle {
    pub(crate) fn start(inner: &Arc<Inner>, runtime: &Runtime, computer: String) -> Self {
        let (scope, writes) = inner.writing_scope();
        let (inbox, rx) = mpsc::unbounded_channel();
        // A service closing on the same records stores them before this
        // one reads them.
        let records = format!("home/{computer}");
        let earlier = inner.flushed(Some(&records));
        inner.flushes(Flusher::new(records, &inbox, |tx| {
            Msg::Intent(Intent::FlushDrafts, Some(tx))
        }));
        let (publish, view) = watch::channel(Arc::new(HomeView::default()));
        let actor = Actor {
            inner: Arc::downgrade(inner),
            inbox: inbox.clone(),
            computer: Peer::main(computer, scope.clone()),
            account: None,
            loaded: false,
            drafts: DraftBook::default(),
            dirty: false,
            timer: 0,
            choices: None,
            disposed: false,
            publish,
            models: BTreeMap::new(),
            after: Vec::new(),
            chats: None,
            published: None,
            worktrees: None,
            overview: None,
            launcher: Launcher::default(),
            deliveries: BTreeMap::new(),
            deliveries_issued: 0,
            tasks: HashMap::new(),
            done: Vec::new(),
            _writes: writes,
        };
        let settled = inner.settled(&scope);
        runtime.spawn(actor.run(
            Inbox::new(rx, scope.clone()).keeping(Msg::saves),
            scope.clone(),
            async move {
                settled.await;
                earlier.await;
            },
        ));
        Self {
            inbox,
            view: View::new(view, scope),
        }
    }
    pub(crate) fn view(&self) -> View<HomeView> {
        self.view.clone()
    }
    pub(crate) fn scope(&self) -> &Scope {
        self.view.scope()
    }
    pub(crate) fn send(&self, intent: Intent, waiter: Option<Waiter>) -> Result<()> {
        self.view.scope().check()?;
        self.inbox
            .send(Msg::Intent(intent, waiter))
            .map_err(|_| shutdown_failure())
    }
}

struct Actor {
    inner: Weak<Inner>,
    inbox: mpsc::UnboundedSender<Msg>,
    /// The computer in Home's account scope: its reads reach only a
    /// session of that scope.
    computer: Peer,
    /// The account the records belong to; none keeps them in memory.
    account: Option<String>,
    loaded: bool,
    drafts: DraftBook,
    dirty: bool,
    /// The pending debounce's token.
    timer: u64,
    /// The choices record, read on first use.
    choices: Option<BTreeMap<String, HomeChoicesView>>,
    disposed: bool,
    publish: watch::Sender<Arc<HomeView>>,
    // ---- The final sweep: models, launcher, deliveries, tasks ----
    models: BTreeMap<u64, Model>,
    /// What runs once a model's refresh of a generation finished.
    after: Vec<(u64, u64, After)>,
    chats: Option<chats::Handle>,
    /// The chats actor's last published selection.
    published: Option<Arc<ChatsPublished>>,
    worktrees: Option<WorktreesService>,
    overview: Option<OverviewService>,
    launcher: Launcher,
    deliveries: BTreeMap<u64, Delivery>,
    deliveries_issued: u64,
    tasks: HashMap<u64, task::Handle>,
    /// Waiters to answer after this message's view is published.
    done: Vec<(Waiter, HomeOutcome)>,
    /// Holds the account's sign-out until the records are stored.
    _writes: Writes,
}

/// What follows a model's refresh.
enum After {
    Settle(Option<Waiter>, HomeOutcome),
    /// `save()`, then settle.
    Save(Option<Waiter>, HomeOutcome),
}

/// `ComputerHomeLauncher`'s state.
#[derive(Default)]
struct Launcher {
    busy: bool,
    error: Option<String>,
    /// The launch's delivery (`_delivery`).
    delivery: Option<u64>,
    /// The chat a resume opens.
    resuming: Option<ChatRef>,
    clears: u64,
    draft_clear: Option<HomeDraftClearView>,
}

/// Who a delivery reports its confirmation to.
enum Owner {
    /// The launcher: clear the context's Home draft if it still holds the
    /// launched text.
    Launcher { context: String, text: String },
    /// A task's own delivery (`onSent`).
    Task(u64),
}

/// `DeviceChatDelivery`: one submitted prompt observed on its chat.
struct Delivery {
    owner: Owner,
    target: Option<ChatRef>,
    text: Option<String>,
    confirmed: bool,
    was_pending: bool,
}

impl Delivery {
    fn new(owner: Owner) -> Self {
        Self {
            owner,
            target: None,
            text: None,
            confirmed: false,
            was_pending: false,
        }
    }
    fn matches(&self, send: Option<&cc_domain::chat::send::PendingSend>) -> bool {
        match (send, &self.target) {
            (Some(send), Some(target)) => {
                send.chat.key() == target.key() && Some(&send.text) == self.text.as_ref()
            }
            _ => false,
        }
    }
    fn pending(&self, published: Option<&ChatsPublished>) -> bool {
        !self.confirmed && self.matches(published.and_then(|p| p.pending.as_ref()))
    }
}

pub(crate) fn inventory(v: HomeInventoryView) -> Inventory {
    Inventory {
        active: v.active,
        online: v.online,
        scope_pending: v.scope_pending,
        loading: v.loading,
        projects: v
            .projects
            .into_iter()
            .map(|p| domain::Project {
                id: p.id,
                kind: p.kind,
            })
            .collect(),
        worktrees: v
            .worktrees
            .into_iter()
            .map(|w| domain::Worktree {
                project_id: w.project_id,
                id: w.id,
            })
            .collect(),
    }
}

/// `_allowed(ref, context)`.
fn allowed(chat: &ChatRef, inv: &Inventory) -> bool {
    inv.active && inv.online && !inv.scope_pending && inv.owns(&chat.project_id)
}

impl Actor {
    async fn run(mut self, mut rx: Inbox<Msg>, scope: Scope, settled: impl Future<Output = ()>) {
        // What the scopes before this one, and the services closing on the
        // same records, still wrote is stored first.
        settled.await;
        self.load(&scope).await;
        while let Some(msg) = rx.recv(|| Msg::Intent(Intent::Close, None)).await {
            match msg {
                Msg::Intent(Intent::Options { workspace_id }, waiter) => {
                    // No state: the read runs on its own.
                    let (Some(inner), computer) = (self.inner.upgrade(), self.computer.clone())
                    else {
                        continue;
                    };
                    tokio::spawn(async move {
                        let outcome = match load_options(&inner, &computer, &workspace_id).await {
                            Ok(options) => Outcome::Options(Box::new(options_view(&options))),
                            Err(failure) => Outcome::Failed(failure),
                        };
                        if let Some(waiter) = waiter {
                            let _ = waiter.send(outcome);
                        }
                    });
                }
                Msg::Intent(Intent::Flow(intent), waiter) => self.flow(*intent, waiter).await,
                Msg::Intent(intent, waiter) => {
                    let outcome = self.intent(intent).await;
                    if let (Some(waiter), Some(outcome)) = (waiter, outcome) {
                        let _ = waiter.send(outcome);
                    }
                }
                Msg::Timer(token) => {
                    if token == self.timer {
                        self.write_drafts().await;
                    }
                }
                Msg::Options {
                    model,
                    generation,
                    kind,
                    result,
                } => self.options_read(model, generation, &kind, result).await,
                Msg::Restore {
                    model,
                    saved,
                    waiter,
                } => self.restore_model(model, &saved, waiter).await,
                Msg::Chats(published) => self.chats_changed(published),
                Msg::Delivery(id, cmd, reply) => {
                    let _ = reply.send(self.delivery_cmd(id, cmd));
                }
                Msg::TaskEnded(task) => {
                    self.tasks.remove(&task);
                }
                Msg::DeliveryDropped(id, task) => {
                    if matches!(
                        self.deliveries.get(&id).map(|d| &d.owner),
                        Some(Owner::Task(t)) if *t == task
                    ) {
                        self.deliveries.remove(&id);
                    }
                }
            }
            self.publish_view();
            let revision = self.publish.borrow().revision;
            for (waiter, outcome) in self.done.drain(..) {
                let _ = waiter.send(Outcome::Flow(Box::new(outcome), revision));
            }
            if self.disposed {
                break;
            }
        }
    }

    /// Reads the drafts record and prunes it (`FileChatDraftStore.open`);
    /// an unreadable one starts empty. They, the choices and every later
    /// write belong to `scope`'s account, also when auth took another
    /// account meanwhile; nothing is read while auth reports another
    /// account and the scope lasts.
    async fn load(&mut self, scope: &Scope) {
        self.loaded = true;
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        self.account = inner.records_account(scope).await;
        if self.account.is_none() {
            return;
        }
        let record = self.read(HomeRecord::Drafts).await;
        if let Some(record) = record
            && record.get("v").and_then(Value::as_u64) == Some(VERSION)
            && let Some(drafts) = record.get("drafts").and_then(Value::as_object)
        {
            for (key, value) in drafts {
                if let (Some(text), Some(updated_ms)) = (
                    value.get("text").and_then(Value::as_str),
                    value.get("updatedAtMs").and_then(Value::as_i64),
                ) {
                    self.drafts.restore(
                        key.clone(),
                        Draft {
                            text: text.to_owned(),
                            updated_ms,
                        },
                    );
                }
            }
        }
        self.drafts.prune(now_ms());
    }

    async fn read(&self, kind: HomeRecord) -> Option<Value> {
        let (inner, account) = (self.inner.upgrade()?, self.account.clone()?);
        let computer = self.computer.computer.clone();
        let store = inner.store.clone();
        tokio::task::spawn_blocking(move || store.home(&account, &computer, kind))
            .await
            .ok()
            .and_then(std::result::Result::ok)
            .flatten()
    }

    async fn write(&self, kind: HomeRecord, record: Value) -> bool {
        let (Some(inner), Some(account)) = (self.inner.upgrade(), self.account.clone()) else {
            // No account: kept in memory, as an unbound Dart store.
            return true;
        };
        let computer = self.computer.computer.clone();
        let store = inner.store.clone();
        tokio::task::spawn_blocking(move || {
            store.put_home(&account, &computer, kind, &record).is_ok()
        })
        .await
        .unwrap_or(false)
    }

    async fn intent(&mut self, intent: Intent) -> Option<Outcome> {
        Some(match intent {
            // Spawned in `run`.
            Intent::Options { .. } => return None,
            Intent::Choices { context } => {
                let choices = self.choices().await;
                Outcome::Choices(choices.get(&context).cloned().unwrap_or_default())
            }
            Intent::SaveChoices { context, choices } => {
                Outcome::Saved(self.save_choices(context, choices).await)
            }
            Intent::Drafts => Outcome::Drafts(
                self.drafts
                    .iter()
                    .map(|(k, d)| (k.clone(), d.text.clone()))
                    .collect(),
            ),
            Intent::SetDraft { context, text } => {
                self.set_draft(&context, &text);
                Outcome::Done
            }
            Intent::FlushDrafts => Outcome::Saved(self.write_drafts().await),
            Intent::Close => {
                self.disposed = true;
                for task in self.tasks.values() {
                    task.dispose();
                }
                self.write_drafts().await;
                Outcome::Done
            }
            Intent::Mount {
                model,
                context,
                inventory,
            } => {
                self.models
                    .insert(model, Model::new(model, context, inventory));
                Outcome::Done
            }
            Intent::BindChats(handle) => {
                let inbox = self.inbox.clone();
                let mut view = handle.view();
                tokio::spawn(async move {
                    while let Some(published) = view.latest() {
                        if inbox.send(Msg::Chats(published)).is_err()
                            || view.changed().await.is_err()
                        {
                            return;
                        }
                    }
                });
                self.chats = Some(handle);
                Outcome::Done
            }
            Intent::BindWorktrees(worktrees) => {
                self.worktrees = Some(worktrees);
                Outcome::Done
            }
            Intent::BindOverview(overview) => {
                self.overview = Some(overview);
                Outcome::Done
            }
            Intent::StartTask {
                task,
                request,
                publish,
                send_gate,
            } => {
                let delivery = match request.delivery {
                    Some(d) => d,
                    None => self.new_delivery(Owner::Task(task)),
                };
                let handle = task::start(
                    task::Deps {
                        id: task,
                        home: self.inbox.clone(),
                        publish,
                        chats: self.chats.clone(),
                        worktrees: self.worktrees.clone(),
                        overview: self.overview.clone(),
                        delivery,
                        send_gate,
                    },
                    *request,
                );
                self.tasks.insert(task, handle);
                Outcome::Done
            }
            // Routed in `run`.
            Intent::Flow(_) => return None,
        })
    }

    // ---- The final sweep: models, launcher, deliveries, tasks ----

    fn publish_view(&self) {
        let models: Vec<HomeModelView> = self.models.values().map(Model::view).collect();
        let launcher = LauncherView {
            busy: self.launcher.busy,
            error: self.launcher.error.clone(),
            pending: self.pending().map(|c| ChatRefView {
                project_id: c.project_id.clone(),
                worktree_id: c.worktree_id.clone(),
                id: c.id.clone(),
                title: c.title.clone(),
            }),
            draft_clear: self.launcher.draft_clear.clone(),
        };
        self.publish.send_if_modified(|current| {
            if current.models == models && current.launcher == launcher {
                return false;
            }
            *current = Arc::new(HomeView {
                revision: current.revision + 1,
                models,
                launcher,
                tasks: Vec::new(),
            });
            true
        });
    }

    /// The computer's unconfirmed send's chat (`pendingSend?.ref`).
    fn pending(&self) -> Option<&ChatRef> {
        self.published
            .as_ref()
            .and_then(|p| p.pending.as_ref())
            .map(|p| &p.chat)
    }

    /// Answers `waiter` once this message's view is published.
    fn settle(&mut self, waiter: Option<Waiter>, outcome: HomeOutcome) {
        if let Some(waiter) = waiter {
            self.done.push((waiter, outcome));
        }
    }

    async fn flow(&mut self, intent: HomeIntent, waiter: Option<Waiter>) {
        match intent {
            HomeIntent::Inventory { model, inventory } => {
                let changed = match self.models.get_mut(&model) {
                    Some(m) => m.inventory_changed(self::inventory(inventory)),
                    None => Changed::Nothing,
                };
                match changed {
                    Changed::Nothing => {}
                    Changed::Load => self.load_model(model, None).await,
                    Changed::Refresh => {
                        self.refresh(model, After::Settle(None, HomeOutcome::Done))
                            .await;
                    }
                }
                self.settle(waiter, HomeOutcome::Done);
            }
            HomeIntent::Load { model } => self.load_model(model, waiter).await,
            HomeIntent::RefreshChoices { model } => {
                self.refresh(model, After::Settle(waiter, HomeOutcome::Done))
                    .await;
            }
            HomeIntent::Select { model, pick } => self.select(model, pick, waiter).await,
            HomeIntent::Unmount { model } => {
                // `dispose`: late reads change nothing.
                self.models.remove(&model);
                self.settle(waiter, HomeOutcome::Done);
            }
            HomeIntent::Begin { model, text } => {
                let outcome = self.begin(model, text).await;
                self.settle(waiter, outcome);
            }
            HomeIntent::Resume { inventory } => {
                let outcome = self.resume(&self::inventory(inventory));
                self.settle(waiter, outcome);
            }
            HomeIntent::Resumed { opened, inventory } => {
                let inv = self::inventory(inventory);
                let shown = opened
                    && self
                        .launcher
                        .resuming
                        .as_ref()
                        .is_some_and(|c| allowed(c, &inv));
                if !shown {
                    self.launcher.error = Some(copy_text(CopyKey::OpenFailed).into());
                }
                self.settle(waiter, HomeOutcome::Resumed { opened: shown });
            }
            HomeIntent::Finished => {
                self.launcher.busy = false;
                self.launcher.resuming = None;
                self.settle(waiter, HomeOutcome::Done);
            }
            HomeIntent::LaunchGone => {
                self.launcher.busy = false;
                if let Some(delivery) = self.launcher.delivery.take() {
                    self.deliveries.remove(&delivery);
                }
                self.launcher.error = Some(copy_text(CopyKey::PrepareFailed).into());
                self.settle(waiter, HomeOutcome::Done);
            }
            HomeIntent::TaskInventory { task, inventory } => {
                self.forward_task(task, TaskMsg::Inventory(self::inventory(inventory)), None);
                self.settle(waiter, HomeOutcome::Done);
            }
            HomeIntent::Prepare { task } => self.forward_task(task, TaskMsg::Prepare(None), waiter),
            HomeIntent::TaskSend { task, text } => {
                self.forward_task(task, TaskMsg::Send { text, waiter: None }, waiter)
            }
            HomeIntent::Retry { task, text } => {
                self.forward_task(task, TaskMsg::Retry { text, waiter: None }, waiter)
            }
            HomeIntent::StepDone { task, result } => self.forward_task(
                task,
                TaskMsg::StepDone {
                    result,
                    waiter: None,
                },
                waiter,
            ),
            HomeIntent::TaskDispose { task } => {
                if let Some(handle) = self.tasks.get(&task) {
                    handle.dispose();
                }
                self.settle(waiter, HomeOutcome::Done);
            }
            // The P8 intents arrive as their own variants.
            other => {
                let _ = other;
                self.settle(waiter, HomeOutcome::Done);
            }
        }
    }

    /// Forwards `msg` to `task`, which settles `waiter` (when it takes one).
    fn forward_task(&mut self, task: u64, msg: TaskMsg, waiter: Option<Waiter>) {
        let msg = match msg {
            TaskMsg::Prepare(_) => TaskMsg::Prepare(waiter),
            TaskMsg::Send { text, .. } => TaskMsg::Send { text, waiter },
            TaskMsg::Retry { text, .. } => TaskMsg::Retry { text, waiter },
            TaskMsg::StepDone { result, .. } => TaskMsg::StepDone { result, waiter },
            other => other,
        };
        if let Some(handle) = self.tasks.get(&task)
            && let Err(mpsc::error::SendError(msg)) = handle.inbox.send(msg)
        {
            self.tasks.remove(&task);
            self.answer_dropped(task, msg);
        } else if !self.tasks.contains_key(&task) {
            // `msg` was moved only when sent; nothing to answer here.
        }
    }

    fn answer_dropped(&mut self, task: u64, msg: TaskMsg) {
        let waiter = match msg {
            TaskMsg::Prepare(w)
            | TaskMsg::Send { waiter: w, .. }
            | TaskMsg::Retry { waiter: w, .. }
            | TaskMsg::StepDone { waiter: w, .. } => w,
            _ => None,
        };
        self.settle(waiter, HomeOutcome::Task { task, view: None });
    }

    /// `load()` up to its `await store.read()`. Like Dart, a load while
    /// another one reads changes nothing, and the rest (`restore_model`)
    /// runs as a message of its own, so it sees the inventory the host
    /// reported meanwhile, as Dart's `load` reads the controller after the
    /// read.
    async fn load_model(&mut self, id: u64, waiter: Option<Waiter>) {
        let context = match self.models.get_mut(&id) {
            Some(m) if !(m.disposed || m.loading_saved || m.inv.scope_pending || !m.inv.online) => {
                m.loading_saved = true;
                m.context.clone()
            }
            _ => return self.settle(waiter, HomeOutcome::Done),
        };
        let saved = self
            .choices()
            .await
            .get(&context)
            .cloned()
            .unwrap_or_default();
        let _ = self.inbox.send(Msg::Restore {
            model: id,
            saved,
            waiter,
        });
    }

    /// The rest of `load()`: restores the saved choices, then refreshes,
    /// unless the scope went pending or offline while the read ran.
    async fn restore_model(&mut self, id: u64, saved: &HomeChoicesView, waiter: Option<Waiter>) {
        match self.models.get_mut(&id) {
            Some(m) => {
                m.loading_saved = false;
                if m.disposed || m.inv.scope_pending || !m.inv.online {
                    return self.settle(waiter, HomeOutcome::Done);
                }
                m.restore(saved);
            }
            None => return self.settle(waiter, HomeOutcome::Done),
        }
        self.refresh(id, After::Settle(waiter, HomeOutcome::Done))
            .await;
    }

    /// `refreshChoices()`, then `after` once it finished.
    async fn refresh(&mut self, id: u64, after: After) {
        let Some(m) = self.models.get_mut(&id) else {
            return self.run_after(id, after).await;
        };
        let (generation, target) = m.begin_refresh();
        let Some((project, kind)) = target else {
            return self.run_after(id, after).await;
        };
        self.after.push((id, generation, after));
        let (Some(inner), computer, inbox) = (
            self.inner.upgrade(),
            self.computer.clone(),
            self.inbox.clone(),
        ) else {
            return;
        };
        tokio::spawn(async move {
            let result = match load_options(&inner, &computer, &project).await {
                Ok(options) => Ok(Box::new(options)),
                // `cause is DeviceLinkException ? cause.message : …`.
                Err(f) if f.kind == FailKind::Other => Err(None),
                Err(f) => Err(Some(f.message)),
            };
            let _ = inbox.send(Msg::Options {
                model: id,
                generation,
                kind,
                result,
            });
        });
    }

    async fn options_read(
        &mut self,
        id: u64,
        generation: u64,
        kind: &str,
        result: std::result::Result<Box<Options>, Option<String>>,
    ) {
        if let Some(m) = self.models.get_mut(&id) {
            m.apply_options(generation, kind, result.map(|o| *o));
        }
        let (now, later): (Vec<_>, Vec<_>) = std::mem::take(&mut self.after)
            .into_iter()
            .partition(|(m, g, _)| *m == id && *g == generation);
        self.after = later;
        for (_, _, after) in now {
            self.run_after(id, after).await;
        }
    }

    async fn run_after(&mut self, id: u64, after: After) {
        match after {
            After::Settle(waiter, outcome) => self.settle(waiter, outcome),
            After::Save(waiter, outcome) => {
                self.save_model(id).await;
                self.settle(waiter, outcome);
            }
        }
    }

    /// `save()`.
    async fn save_model(&mut self, id: u64) {
        let Some((context, choices)) = self
            .models
            .get(&id)
            .map(|m| (m.context.clone(), m.c.clone()))
        else {
            return;
        };
        let stored = self.save_choices(context, choices).await;
        if let Some(m) = self.models.get_mut(&id) {
            m.saved(stored);
        }
    }

    async fn select(&mut self, id: u64, pick: HomePick, waiter: Option<Waiter>) {
        let Some(m) = self.models.get_mut(&id) else {
            return self.settle(waiter, HomeOutcome::Selected { accepted: false });
        };
        let accepted = HomeOutcome::Selected { accepted: true };
        match pick {
            HomePick::Project { id: project } => {
                if m.select_project(&project) {
                    self.refresh(id, After::Save(waiter, accepted)).await;
                } else {
                    self.settle(waiter, HomeOutcome::Selected { accepted: false });
                }
                return;
            }
            HomePick::Worktree { id: tree } => {
                if !m.select_worktree(tree.as_deref()) {
                    return self.settle(waiter, HomeOutcome::Selected { accepted: false });
                }
            }
            HomePick::Branch { id: branch } => {
                if !m.select_branch(&branch) {
                    return self.settle(waiter, HomeOutcome::Selected { accepted: false });
                }
            }
            HomePick::Model {
                id: model,
                execution_harness,
            } => {
                if !m.select_model(&model, execution_harness) {
                    return self.settle(waiter, HomeOutcome::Selected { accepted: false });
                }
            }
            HomePick::Effort { level } => {
                if !m.select_effort(&level) {
                    return self.settle(waiter, HomeOutcome::Selected { accepted: false });
                }
            }
        }
        // `_notify()` before the save.
        self.publish_view();
        self.run_after(id, After::Save(waiter, accepted)).await;
    }

    /// `begin(choices)`: launch admission, then the choices and drafts are
    /// saved.
    async fn begin(&mut self, id: u64, text: String) -> HomeOutcome {
        let startable = self.models.get(&id).is_some_and(Model::can_start);
        if self.launcher.busy || self.pending().is_some() || !startable {
            return HomeOutcome::NotStarted;
        }
        if text.trim().is_empty() {
            return HomeOutcome::NotStarted;
        }
        self.launcher.busy = true;
        self.launcher.error = None;
        self.publish_view();
        self.save_model(id).await;
        let saved = self.write_drafts().await;
        let startable = self.models.get(&id).is_some_and(Model::can_start);
        if self.pending().is_some() || !startable {
            self.launcher.busy = false;
            return HomeOutcome::NotStarted;
        }
        if !saved {
            self.launcher.error = Some(copy_text(CopyKey::DraftNotSaved).into());
        }
        let Some(m) = self.models.get(&id) else {
            self.launcher.busy = false;
            return HomeOutcome::NotStarted;
        };
        let (context, c) = (m.context.clone(), m.c.clone());
        let model = selection_model_option(
            &m.models,
            c.model_id.as_deref(),
            c.execution_harness.as_deref(),
        )
        .as_ref()
        .map(model_row);
        if let Some(previous) = self.launcher.delivery.take() {
            self.deliveries.remove(&previous);
        }
        let delivery = self.new_delivery(Owner::Launcher {
            context: context.clone(),
            text: text.clone(),
        });
        self.launcher.delivery = Some(delivery);
        HomeOutcome::Launch {
            launch: Box::new(HomeLaunchView {
                context,
                project_id: c.project_id.unwrap_or_default(),
                worktree_id: c.worktree_id,
                base_branch: c.base_branch,
                model,
                thinking_level: c.thinking_level,
                text,
                delivery,
            }),
        }
    }

    /// `resume(context)`: the unconfirmed send's chat, if the context may
    /// open it.
    fn resume(&mut self, inv: &Inventory) -> HomeOutcome {
        let Some(chat) = self.pending().cloned() else {
            return HomeOutcome::NotStarted;
        };
        if self.launcher.busy {
            return HomeOutcome::NotStarted;
        }
        if !allowed(&chat, inv) {
            self.launcher.error = Some(copy_text(CopyKey::OutsideContext).into());
            return HomeOutcome::NotStarted;
        }
        self.launcher.busy = true;
        self.launcher.error = None;
        let open = ChatRefView {
            project_id: chat.project_id.clone(),
            worktree_id: chat.worktree_id.clone(),
            id: chat.id.clone(),
            title: chat.title.clone(),
        };
        self.launcher.resuming = Some(chat);
        HomeOutcome::Open { chat: open }
    }

    fn new_delivery(&mut self, owner: Owner) -> u64 {
        self.deliveries_issued += 1;
        let id = self.deliveries_issued;
        self.deliveries.insert(id, Delivery::new(owner));
        id
    }

    fn delivery_cmd(&mut self, id: u64, cmd: DeliveryCmd) -> bool {
        let published = self.published.clone();
        let Some(d) = self.deliveries.get_mut(&id) else {
            // A disposed delivery tracks nothing (Dart's `_disposed`).
            return true;
        };
        match cmd {
            DeliveryCmd::Track(chat, text) => {
                if let Some(target) = &d.target {
                    return target.key() == chat.key() && d.text.as_ref() == Some(&text);
                }
                d.target = Some(chat);
                d.text = Some(text);
                true
            }
            DeliveryCmd::Release => {
                if !(d.pending(published.as_deref()) || d.confirmed) {
                    d.target = None;
                    d.text = None;
                }
                true
            }
        }
    }

    /// `_observe` for every delivery, on each published selection.
    fn chats_changed(&mut self, published: Arc<ChatsPublished>) {
        self.published = Some(published.clone());
        let mut confirmed = Vec::new();
        for (id, d) in &mut self.deliveries {
            if d.target.is_none() {
                continue;
            }
            let newly = !d.confirmed && d.matches(published.confirmed.as_ref());
            if newly {
                d.confirmed = true;
                confirmed.push(*id);
            }
            let next = d.pending(Some(&published));
            if next != d.was_pending || newly {
                d.was_pending = next;
            }
        }
        for id in confirmed {
            match self.deliveries.get(&id).map(|d| &d.owner) {
                Some(Owner::Launcher { context, text }) => {
                    let (context, text) = (context.clone(), text.clone());
                    // `if (draft.text == text) draft.clear()`.
                    let stored = self
                        .drafts
                        .iter()
                        .find(|(k, _)| **k == context)
                        .map(|(_, d)| d.text.clone());
                    if stored.as_deref() == Some(text.as_str()) {
                        self.set_draft(&context, "");
                        self.launcher.clears += 1;
                        self.launcher.draft_clear = Some(HomeDraftClearView {
                            seq: self.launcher.clears,
                            context,
                            text,
                        });
                    }
                }
                Some(Owner::Task(task)) => {
                    if let Some(handle) = self.tasks.get(task) {
                        let _ = handle.inbox.send(TaskMsg::Confirmed);
                    }
                }
                None => {}
            }
        }
    }

    /// Sets `context`'s draft; written 500 ms after the last change.
    fn set_draft(&mut self, context: &str, text: &str) {
        if self.drafts.set(context, text, now_ms()) {
            self.dirty = true;
            self.timer += 1;
            let (token, inbox) = (self.timer, self.inbox.clone());
            tokio::spawn(async move {
                tokio::time::sleep(DEBOUNCE).await;
                let _ = inbox.send(Msg::Timer(token));
            });
        }
    }

    /// Replaces `context`'s choices and writes the record; whether it was
    /// stored.
    async fn save_choices(&mut self, context: String, choices: HomeChoicesView) -> bool {
        let mut all = self.choices().await.clone();
        all.insert(context, choices);
        self.choices = Some(all.clone());
        let mut map = Map::new();
        for (context, c) in &all {
            map.insert(
                context.clone(),
                json!({
                    "projectId": c.project_id,
                    "worktreeId": c.worktree_id,
                    "baseBranch": c.base_branch,
                    "modelId": c.model_id,
                    "executionHarness": c.execution_harness,
                    "thinkingLevel": c.thinking_level,
                }),
            );
        }
        self.write(HomeRecord::Choices, json!({"v": VERSION, "choices": map}))
            .await
    }

    /// The choices record by context, read on first use; an unreadable one
    /// is empty, as Dart ignored an unreadable record.
    async fn choices(&mut self) -> &BTreeMap<String, HomeChoicesView> {
        if self.choices.is_none() {
            let record = self.read(HomeRecord::Choices).await;
            let mut all = BTreeMap::new();
            if let Some(record) = record
                && record.get("v").and_then(Value::as_u64) == Some(VERSION)
                && let Some(map) = record.get("choices").and_then(Value::as_object)
            {
                for (context, c) in map {
                    let field = |key: &str| c.get(key).and_then(Value::as_str).map(str::to_owned);
                    all.insert(
                        context.clone(),
                        HomeChoicesView {
                            project_id: field("projectId"),
                            worktree_id: field("worktreeId"),
                            base_branch: field("baseBranch"),
                            model_id: field("modelId"),
                            execution_harness: field("executionHarness"),
                            thinking_level: field("thinkingLevel"),
                        },
                    );
                }
            }
            self.choices = Some(all);
        }
        self.choices.get_or_insert_with(BTreeMap::new)
    }

    /// Writes the drafts record when it changed; whether every change is
    /// stored.
    async fn write_drafts(&mut self) -> bool {
        self.timer += 1;
        if !self.dirty {
            return true;
        }
        self.dirty = false;
        let now = now_ms();
        self.drafts.prune(now);
        let mut drafts = Map::new();
        for (key, draft) in self.drafts.iter() {
            drafts.insert(
                key.clone(),
                json!({"text": draft.text, "updatedAtMs": draft.updated_ms}),
            );
        }
        let record = if drafts.is_empty() {
            Value::Null
        } else {
            json!({"v": VERSION, "drafts": drafts})
        };
        let written = self.write(HomeRecord::Drafts, record).await;
        if !written {
            self.dirty = true;
        }
        written
    }
}

/// `DeviceChatHomeOptionsService.load`: the reads in Dart's order. Sequential
/// reads leave headroom in the session's eight-request budget.
pub(crate) async fn load_options(
    inner: &Inner,
    computer: &Peer,
    workspace_id: &str,
) -> std::result::Result<Options, Failure> {
    let read = |result: Result<Value>| -> std::result::Result<DvMap, Failure> {
        let value = dto::desktop_value(&result.map_err(|e| Failure::transport(&e))?);
        object(&value).cloned().map_err(Failure::thrown)
    };
    let branch = match call(
        inner,
        computer,
        "home:list-branch-targets",
        vec![json!({"workspaceId": workspace_id})],
        None,
    )
    .await
    {
        Err(e) if e.kind == FailureKind::Refused && e.code == "remote_channel_unavailable" => None,
        result => Some(read(result)?),
    };
    let registry = read(call(inner, computer, "model-registry:get", vec![], None).await)?;
    // Older hosts may omit the scoped read.
    let projection = call(
        inner,
        computer,
        "desktop:session-snapshot",
        vec![json!({"workspaceLocalId": workspace_id})],
        None,
    )
    .await
    .ok()
    .map(|v| dto::desktop_value(&v))
    .and_then(|v| match v {
        Dv::Map(map) => Some(map),
        _ => None,
    });
    let models = match projection.as_ref().map(|p| p.get("availableModels")) {
        // `ModelOption.fromJson(deviceLinkObject(row))`.
        Some(Dv::List(rows)) => rows
            .iter()
            .map(|row| object(row).map(ModelOption::from_json))
            .collect::<std::result::Result<Vec<_>, _>>(),
        // A `Uint8List` is a list of ints, none of them an object.
        Some(Dv::Bytes(bytes)) if !bytes.is_empty() => Err(Thrown::Invalid),
        Some(Dv::Bytes(_)) => Ok(Vec::new()),
        _ => registry::registry_models(&registry),
    }
    .map_err(Failure::thrown)?;
    let defaults = default_model(inner, computer, workspace_id, &registry).await;
    let cursor = runtime_available(inner, computer, "cursor-connection:status").await;
    let copilot = runtime_available(inner, computer, "copilot-connection:status").await;
    let targets = domain::branch_targets(branch.as_ref()).map_err(Failure::thrown)?;
    let availability = domain::availability(projection.as_ref(), cursor, copilot);
    Ok(Options {
        branches_supported: targets.supported,
        branches: targets.branches,
        default_branch: targets.default_branch,
        models,
        default_model_id: defaults.as_ref().map(|d| d.model_id.clone()),
        default_thinking_level: defaults.and_then(|d| d.thinking_level),
        provider_availability: ProviderAvailabilityView {
            claude: availability.claude,
            codex: availability.codex,
            ollama: availability.ollama,
            cursor: availability.cursor,
            copilot: availability.copilot,
        },
    })
}

/// The options as `HomeService`'s `LoadOptions` reports them.
fn options_view(o: &Options) -> HomeOptionsView {
    HomeOptionsView {
        branches_supported: o.branches_supported,
        branches: o.branches.clone(),
        default_branch: o.default_branch.clone(),
        models: o.models.iter().map(model_row).collect(),
        default_model_id: o.default_model_id.clone(),
        default_thinking_level: o.default_thinking_level.clone(),
        provider_availability: o.provider_availability,
    }
}

/// `readDeviceDefaultModel`: any failure reads as no default.
async fn default_model(
    inner: &Inner,
    computer: &Peer,
    project_id: &str,
    registry: &DvMap,
) -> Option<registry::SavedDefault> {
    if project_id == "app-advisor" {
        let preferences = call(inner, computer, "preferences:load", vec![], None)
            .await
            .ok()?;
        return registry::orchestrator_default(registry, &dto::desktop_value(&preferences));
    }
    // `Future.wait`: both requests leave before either answer.
    let preferences = inner.request(computer, "preferences:load", vec![]);
    let projects = inner.request(computer, "projects:load", vec![]);
    let answer = |rx: Result<oneshot::Receiver<Result<Value>>>| async move {
        rx?.await
            .unwrap_or_else(|_| Err(cc_protocol::rpc::ended("session_ended")))
    };
    let (preferences, projects) = futures_util::join!(answer(preferences), answer(projects));
    // `DeviceChatRef(projectId: workspaceId, worktreeId: '', id: '')`.
    let chat = ChatRef {
        project_id: project_id.to_owned(),
        worktree_id: String::new(),
        id: String::new(),
        title: String::new(),
    };
    registry::saved_default(
        registry,
        &chat,
        &dto::desktop_value(&preferences.ok()?),
        &dto::desktop_value(&projects.ok()?),
    )
}

/// `_runtimeAvailable`: optional on older hosts, so any failure is unknown.
async fn runtime_available(inner: &Inner, computer: &Peer, channel: &str) -> Option<bool> {
    let status = call(inner, computer, channel, vec![], None).await.ok()?;
    domain::runtime_available(&dto::desktop_value(&status))
}

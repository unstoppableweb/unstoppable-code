//! One computer's pipelines and the composer work drawers of its mounted
//! chats (architecture §3.6, P7). Ported from `device_link/pipelines/
//! {repository,existing_ipc,chat_activity}.dart`, `ui/features/
//! device_link/pipelines/chat_activity_controller.dart` and
//! `device_link/work_drawer/{repository,projection}.dart`; comments cite
//! the Dart rule they keep.
//!
//! One actor task owns every worktree's runs, dispatchable pipelines,
//! errors, row and event versions, reads in flight, unconfirmed starts,
//! controls, selected logs and the 500 ms push refresh, plus each chat
//! activity follower (the feed's run panels) and each work drawer. The
//! drawers read the runs synchronously, as the Dart drawer read its
//! repository, so they share the actor. Chat content (messages and the
//! queued message ids) comes from the chat read path's published
//! selection, a cross-store read. Intents, pushes from the fan-out, timer
//! fires and the results of the calls it spawns apply in order on one
//! inbox; every applied message publishes one [`Published`] snapshot.
use crate::chats::Peer;
mod drawer;
pub(crate) mod flows;

pub(crate) use drawer::{DrawerIntent, DrawerShown};
pub(crate) use flows::{Control, Document, Source, Thrown};

use crate::{
    account::{Inbox, Scope, View},
    bridge::{Inner, shutdown_failure},
    chats::Published as ChatsPublished,
    copy::pipelines::CopyKey,
    error::Result,
    owners::{End, Owners},
    push::{self, Delivery, Filter},
};
use cc_domain::{
    chat::{ChatRef, ChatState},
    dart::{Dv, DvMap, sort::sort},
    pipelines::{Descriptor, DispatchForm, Origin, Run, TurnRuns, chat_activity, compare_recency},
};
use flows::{Listed, Shared, Started, Thrown2};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Weak, atomic::Ordering},
    time::Duration,
};
use tokio::{
    runtime::Handle as Runtime,
    sync::{mpsc, oneshot, watch},
};

/// The pushes the runs and the drawers read.
const OBSERVED: [&str; 7] = [
    "pipelines:execution-event",
    "pipelines:step-output-event",
    "chat:state-changed",
    "activity:live-bg-tasks-changed",
    "managed-delegation:activity-changed",
    "app-advisor:watchers-changed",
    "chat:queue-updated",
];
/// `_queue`'s refresh delay.
const REFRESH: Duration = Duration::from_millis(500);

/// A failure the host rethrows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(crate) message: String,
    pub(crate) kind: FailureKind,
}

/// Which Dart exception a failure was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailureKind {
    /// `RemoteControlException`.
    Remote,
    /// `DeviceLinkException` (refusals and not-sent included).
    Link,
    /// Anything else; `message` is the generic wording.
    Other,
}

impl Failure {
    fn of(thrown: &Thrown) -> Self {
        Self {
            message: thrown.message(),
            kind: match thrown {
                Thrown::Remote(_) => FailureKind::Remote,
                Thrown::Other => FailureKind::Other,
                _ => FailureKind::Link,
            },
        }
    }
}

/// How a requested intent ended.
#[derive(Debug, Clone)]
pub(crate) enum Outcome {
    Done,
    Failed(Failure),
    /// `get`'s run (`None` when the read failed).
    Run(Option<Arc<Run>>),
    Form(DispatchForm),
    /// A started execution's id.
    Started(String),
    Content(Document),
}

pub(crate) type Waiter = oneshot::Sender<Outcome>;

/// What the host asks of the pipelines.
pub(crate) enum Intent {
    SetConnected(bool),
    Watch {
        chat: ChatRef,
        token: u64,
    },
    Release {
        token: u64,
    },
    Load(ChatRef),
    Get {
        chat: ChatRef,
        id: String,
    },
    Log {
        chat: ChatRef,
        id: String,
        job: String,
        step: String,
    },
    ClearLogSelection {
        chat: ChatRef,
        id: String,
    },
    Control {
        chat: ChatRef,
        id: String,
        action: Control,
    },
    ClearActionError {
        chat: ChatRef,
        id: String,
    },
    Form {
        chat: ChatRef,
        pipeline_id: String,
        origin: Origin,
    },
    Start {
        chat: ChatRef,
        pipeline_id: String,
        origin: Origin,
        inputs: Vec<(String, String)>,
    },
    Content {
        chat: ChatRef,
        id: String,
        source: Source,
    },
    Follow {
        token: u64,
        chat: Option<ChatRef>,
        online: bool,
    },
    Unfollow {
        token: u64,
    },
    Drawer(drawer::DrawerIntent),
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TimerKind {
    Refresh,
    DrawerRetry(u64),
}

pub(crate) enum Msg {
    Intent(Intent, Option<Waiter>),
    Push(push::Push),
    Lagged,
    Chats(Arc<ChatsPublished>),
    Timer(TimerKind, u64),
    Loaded {
        op: u64,
        result: Thrown2<(Vec<DvMap>, Vec<Dv>)>,
        lookups: Vec<(String, serde_json::Value)>,
    },
    Got {
        op: u64,
        result: Thrown2<DvMap>,
    },
    Logged {
        op: u64,
        result: Thrown2<DvMap>,
    },
    Controlled {
        op: u64,
        result: Thrown2<DvMap>,
    },
    Formed {
        op: u64,
        result: Thrown2<DispatchForm>,
    },
    Ran {
        op: u64,
        started: Started,
    },
    Read {
        op: u64,
        result: Thrown2<Document>,
    },
    Drawer(drawer::DrawerMsg),
}

/// One worktree as its surfaces show it.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ScopeShown {
    /// `runs(ref)`: listed runs, newest first (Dart's unstable sort).
    pub(crate) runs: Vec<Arc<Run>>,
    /// Runs the list hides (child runs), in stored order.
    pub(crate) hidden: Vec<Arc<Run>>,
    pub(crate) pipelines: Vec<Descriptor>,
    pub(crate) error: Option<String>,
    /// `error(ref, id)` per run.
    pub(crate) run_errors: Vec<(String, String)>,
    pub(crate) action_errors: Vec<(String, String)>,
    /// Runs with a `get` in flight.
    pub(crate) pending: Vec<String>,
    pub(crate) actions: Vec<(String, Control)>,
}

/// One chat activity follower's turn panels.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct FollowShown {
    pub(crate) scope: Option<String>,
    pub(crate) turns: Vec<TurnRuns>,
    /// The last message that opens a turn with runs (expanded by default).
    pub(crate) latest: Option<String>,
}

/// Everything the pipelines show, once per applied message.
#[derive(Debug, Default)]
pub(crate) struct Published {
    pub(crate) revision: u64,
    pub(crate) scopes: HashMap<String, Arc<ScopeShown>>,
    pub(crate) follows: HashMap<u64, Arc<FollowShown>>,
    pub(crate) drawers: HashMap<u64, Arc<DrawerShown>>,
}

/// The service's handle: its inbox, published snapshot and the owners of
/// the follower and drawer streams.
#[derive(Clone)]
pub(crate) struct Handle {
    inbox: mpsc::UnboundedSender<Msg>,
    view: View<Published>,
    owners: StreamOwners,
}

/// The follower and drawer tokens, which `Unfollow` and the drawer's
/// `Close` end.
#[derive(Clone, Default)]
struct StreamOwners {
    followers: Owners,
    drawers: Owners,
}

impl Handle {
    pub(crate) fn start(
        inner: &Arc<Inner>,
        runtime: &Runtime,
        peer: Peer,
        mut chats: View<ChatsPublished>,
    ) -> Self {
        let scope = chats.scope().clone();
        let (inbox, rx) = mpsc::unbounded_channel();
        let owners = StreamOwners::default();
        let mut actor = Actor::new(
            Arc::downgrade(inner),
            inbox.clone(),
            peer.clone(),
            owners.clone(),
        );
        let (publish, view) = watch::channel(Arc::new(Published::default()));
        let pushes = inbox.clone();
        actor.pushes = Some(inner.pushes.subscribe(
            Filter {
                computer: Some(peer.computer.clone()),
                channels: &OBSERVED,
                unreadable: false,
                sessions: false,
            },
            Box::new(move |delivery| {
                pushes
                    .send(match delivery {
                        Delivery::Push(push) => Msg::Push(push),
                        Delivery::Lagged { .. } | Delivery::Opened => Msg::Lagged,
                    })
                    .is_ok()
            }),
        ));
        // The chat read path's selection: the mounted chat's messages and
        // runtime, latest wins.
        let selection = inbox.clone();
        runtime.spawn(async move {
            while let Some(published) = chats.latest() {
                if selection.send(Msg::Chats(published)).is_err() || chats.changed().await.is_err()
                {
                    return;
                }
            }
        });
        runtime.spawn(actor.run(Inbox::new(rx, scope.clone()), publish));
        Self {
            inbox,
            view: View::new(view, scope),
            owners,
        }
    }
    pub(crate) fn view(&self) -> View<Published> {
        self.view.clone()
    }
    pub(crate) fn scope(&self) -> &Scope {
        self.view.scope()
    }
    /// Reached once the follower `token` is unfollowed.
    pub(crate) fn follower_end(&self, token: u64) -> End {
        self.owners.followers.end(token)
    }
    /// Reached once the drawer `token` is closed.
    pub(crate) fn drawer_end(&self, token: u64) -> End {
        self.owners.drawers.end(token)
    }
    /// Queues `intent` in call order; `waiter` gets its outcome.
    pub(crate) fn send(&self, intent: Intent, waiter: Option<Waiter>) -> Result<()> {
        self.view.scope().check()?;
        self.inbox
            .send(Msg::Intent(intent, waiter))
            .map_err(|_| shutdown_failure())
    }
}

/// `'$projectId/$worktreeId'`.
pub(crate) fn scope_key(project: &str, worktree: &str) -> String {
    format!("{project}/{worktree}")
}

fn scope_of(chat: &ChatRef) -> String {
    scope_key(&chat.project_id, &chat.worktree_id)
}

/// `'$scope/$id'`.
fn run_key(chat: &ChatRef, id: &str) -> String {
    format!("{}/{id}", scope_of(chat))
}

/// What waits for a `get`.
enum GetWaiter {
    Host(Waiter),
    /// `start` answers with the id once its `get` finished.
    Start(Waiter, String),
    /// `_queue`'s flush: a log read follows when a step is selected.
    Queue,
}

struct LoadOp {
    scope: String,
    chat: ChatRef,
    generation: u64,
    revision: u64,
    waiters: Vec<Waiter>,
    /// Drawer reads waiting for this load (`await pipelines.load`).
    drawers: Vec<(u64, u64)>,
}

struct GetOp {
    key: String,
    chat: ChatRef,
    id: String,
    generation: u64,
    row_version: u64,
    event_version: u64,
    waiters: Vec<GetWaiter>,
}

struct LogOp {
    key: String,
    chat: ChatRef,
    id: String,
    generation: u64,
    row_version: u64,
    event_version: u64,
    waiter: Option<Waiter>,
}

struct ControlOp {
    key: String,
    chat: ChatRef,
    id: String,
    generation: u64,
    row_version: u64,
    event_version: u64,
    waiter: Option<Waiter>,
}

struct StartOp {
    key: String,
    chat: ChatRef,
    generation: u64,
    waiter: Option<Waiter>,
}

/// One chat activity follower (`DevicePipelineChatActivityController`).
struct Follower {
    chat: Option<ChatRef>,
    online: bool,
    /// The watch it holds on its chat's worktree.
    watch: Option<u64>,
    requested: HashSet<String>,
    connected_generation: Option<u64>,
}

struct Actor {
    inner: Weak<Inner>,
    inbox: mpsc::UnboundedSender<Msg>,
    /// The session and surface this activity reads on (P9: the
    /// Orchestrator chat's own on `app-advisor`).
    peer: Peer,
    owners: StreamOwners,
    shared: Arc<Shared>,
    pushes: Option<push::Subscription>,
    connected: bool,
    generation: u64,
    disposed: bool,
    ops: u64,
    timers: u64,
    /// Whether this message notified (`_notify`).
    notified: bool,
    // ---- `DevicePipelineRepository` ----
    /// Runs per worktree, in Dart's map order.
    runs: HashMap<String, Vec<(String, Arc<Run>)>>,
    pipelines: HashMap<String, Vec<Descriptor>>,
    /// `_errors`, keyed by worktree or run key.
    errors: HashMap<String, String>,
    row_versions: HashMap<String, u64>,
    event_versions: HashMap<String, u64>,
    revision: u64,
    /// `_pending`: the `get` in flight per run.
    pending: HashMap<String, u64>,
    gets: HashMap<u64, GetOp>,
    starts: HashSet<String>,
    start_ops: HashMap<u64, StartOp>,
    /// `_loads`: the load in flight per worktree.
    loads: HashMap<String, u64>,
    load_ops: HashMap<u64, LoadOp>,
    action_errors: HashMap<String, String>,
    /// `_actions`, in insertion order.
    actions: Vec<(String, Control)>,
    control_ops: HashMap<u64, ControlOp>,
    log_ops: HashMap<u64, LogOp>,
    form_ops: HashMap<u64, (u64, Option<Waiter>)>,
    read_ops: HashMap<u64, (u64, Option<Waiter>)>,
    /// `_watching`: per worktree, its latest ref and watch count.
    watching: HashMap<String, (ChatRef, u64)>,
    /// Watch tokens to their worktree.
    tokens: HashMap<u64, String>,
    selected_logs: HashMap<String, (String, String)>,
    /// `_dirty`, in insertion order.
    dirty: Vec<(String, ChatRef, String)>,
    refresh: Option<u64>,
    /// `DevicePipelineIpc._lookups`.
    lookups: HashMap<String, serde_json::Value>,
    // ---- Chat activity followers and drawers ----
    /// The mounted chat's state from the chat read path, by chat key.
    chat: Option<Arc<ChatState>>,
    followers: HashMap<u64, Follower>,
    drawers: HashMap<u64, drawer::Drawer>,
    /// Watch tokens the actor itself issued (followers, drawers).
    own_tokens: u64,
    /// Waiters to answer after this message's snapshot is published.
    done: Vec<(Waiter, Outcome)>,
    /// The last published views, reused while unchanged.
    shown: Published,
}

impl Actor {
    fn new(
        inner: Weak<Inner>,
        inbox: mpsc::UnboundedSender<Msg>,
        peer: Peer,
        owners: StreamOwners,
    ) -> Self {
        Self {
            inner,
            inbox,
            peer,
            owners,
            shared: Arc::default(),
            pushes: None,
            connected: false,
            generation: 0,
            disposed: false,
            ops: 0,
            timers: 0,
            notified: false,
            runs: HashMap::new(),
            pipelines: HashMap::new(),
            errors: HashMap::new(),
            row_versions: HashMap::new(),
            event_versions: HashMap::new(),
            revision: 0,
            pending: HashMap::new(),
            gets: HashMap::new(),
            starts: HashSet::new(),
            start_ops: HashMap::new(),
            loads: HashMap::new(),
            load_ops: HashMap::new(),
            action_errors: HashMap::new(),
            actions: Vec::new(),
            control_ops: HashMap::new(),
            log_ops: HashMap::new(),
            form_ops: HashMap::new(),
            read_ops: HashMap::new(),
            watching: HashMap::new(),
            tokens: HashMap::new(),
            selected_logs: HashMap::new(),
            dirty: Vec::new(),
            refresh: None,
            lookups: HashMap::new(),
            chat: None,
            followers: HashMap::new(),
            drawers: HashMap::new(),
            own_tokens: 0,
            done: Vec::new(),
            shown: Published::default(),
        }
    }

    async fn run(mut self, mut rx: Inbox<Msg>, publish: watch::Sender<Arc<Published>>) {
        let mut revision = 0;
        while let Some(msg) = rx.recv(|| Msg::Intent(Intent::Close, None)).await {
            self.notified = false;
            self.apply(msg);
            if self.notified {
                // The followers listen to the repository's updates.
                self.sync_followers();
            }
            revision += 1;
            let published = self.published(revision);
            publish.send_replace(Arc::new(published));
            for (waiter, outcome) in self.done.drain(..) {
                let _ = waiter.send(outcome);
            }
            if self.disposed {
                break;
            }
        }
        self.pushes = None;
    }

    fn next_op(&mut self) -> u64 {
        self.ops += 1;
        self.ops
    }

    fn settle(&mut self, waiter: Option<Waiter>, outcome: Outcome) {
        if let Some(waiter) = waiter {
            self.done.push((waiter, outcome));
        }
    }

    /// `_notify()`.
    fn notify(&mut self) {
        if !self.disposed {
            self.notified = true;
        }
    }

    /// Runs `work` on the runtime and posts its message.
    fn spawn<F>(&self, work: impl FnOnce(Arc<Inner>, Peer, Arc<Shared>) -> F + Send + 'static)
    where
        F: std::future::Future<Output = Msg> + Send + 'static,
    {
        let (Some(inner), inbox, computer, shared) = (
            self.inner.upgrade(),
            self.inbox.clone(),
            self.peer.clone(),
            self.shared.clone(),
        ) else {
            return;
        };
        tokio::spawn(async move {
            let msg = work(inner, computer, shared).await;
            let _ = inbox.send(msg);
        });
    }

    /// Starts a timer; its fire arrives as `Msg::Timer(kind, token)`.
    fn timer(&mut self, kind: TimerKind, delay: Duration) -> u64 {
        self.timers += 1;
        let token = self.timers;
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = inbox.send(Msg::Timer(kind, token));
        });
        token
    }

    fn apply(&mut self, msg: Msg) {
        match msg {
            Msg::Intent(intent, waiter) => self.intent(intent, waiter),
            Msg::Push(push) => self.push(&push.message),
            Msg::Lagged => self.lagged(),
            Msg::Chats(published) => self.follow_chats(&published),
            Msg::Timer(kind, token) => self.fired(kind, token),
            Msg::Loaded {
                op,
                result,
                lookups,
            } => self.loaded(op, result, lookups),
            Msg::Got { op, result } => self.got(op, result),
            Msg::Logged { op, result } => self.logged(op, result),
            Msg::Controlled { op, result } => self.controlled(op, result),
            Msg::Formed { op, result } => self.formed(op, result),
            Msg::Ran { op, started } => self.ran(op, started),
            Msg::Read { op, result } => self.read(op, result),
            Msg::Drawer(msg) => self.drawer_msg(msg),
        }
    }

    fn intent(&mut self, intent: Intent, waiter: Option<Waiter>) {
        match intent {
            Intent::SetConnected(connected) => {
                self.set_connected(connected);
                self.settle(waiter, Outcome::Done);
            }
            Intent::Watch { chat, token } => {
                self.watch(&chat, token);
                self.settle(waiter, Outcome::Done);
            }
            Intent::Release { token } => {
                self.release(token);
                self.settle(waiter, Outcome::Done);
            }
            Intent::Load(chat) => {
                self.load(&chat, waiter.map(LoadWaiter::Host));
            }
            Intent::Get { chat, id } => self.get(&chat, &id, waiter.map(GetWaiter::Host)),
            Intent::Log {
                chat,
                id,
                job,
                step,
            } => self.log(&chat, &id, job, step, waiter),
            Intent::ClearLogSelection { chat, id } => {
                self.selected_logs.remove(&run_key(&chat, &id));
                self.settle(waiter, Outcome::Done);
            }
            Intent::Control { chat, id, action } => self.control(&chat, &id, action, waiter),
            Intent::ClearActionError { chat, id } => {
                self.action_errors.remove(&run_key(&chat, &id));
                self.notify();
                self.settle(waiter, Outcome::Done);
            }
            Intent::Form {
                chat,
                pipeline_id,
                origin,
            } => self.form(&chat, &pipeline_id, origin, waiter),
            Intent::Start {
                chat,
                pipeline_id,
                origin,
                inputs,
            } => self.start(&chat, pipeline_id, origin, inputs, waiter),
            Intent::Content { chat, id, source } => self.content(&chat, &id, source, waiter),
            Intent::Follow {
                token,
                chat,
                online,
            } => {
                self.follow(token, chat, online);
                self.settle(waiter, Outcome::Done);
            }
            Intent::Unfollow { token } => {
                self.owners.followers.close(token);
                if let Some(follower) = self.followers.remove(&token)
                    && let Some(watch) = follower.watch
                {
                    self.release(watch);
                }
                self.settle(waiter, Outcome::Done);
            }
            Intent::Drawer(intent) => self.drawer_intent(intent, waiter),
            Intent::Close => {
                self.dispose();
                self.settle(waiter, Outcome::Done);
            }
        }
    }

    fn fired(&mut self, kind: TimerKind, token: u64) {
        match kind {
            TimerKind::Refresh if self.refresh == Some(token) => {
                self.refresh = None;
                for (_, chat, id) in std::mem::take(&mut self.dirty) {
                    self.get(&chat, &id, Some(GetWaiter::Queue));
                }
            }
            TimerKind::DrawerRetry(drawer) => self.drawer_retry_fired(drawer, token),
            TimerKind::Refresh => {}
        }
    }

    fn dispose(&mut self) {
        self.disposed = true;
        self.generation += 1;
        self.shared.disposed.store(true, Ordering::SeqCst);
        self.shared
            .generation
            .store(self.generation, Ordering::SeqCst);
        self.refresh = None;
        self.pushes = None;
        for token in self.drawers.keys().copied().collect::<Vec<_>>() {
            self.drawer_dispose(token);
        }
    }

    fn own_token(&mut self) -> u64 {
        // Host tokens count up from 1; the actor's own count down.
        self.own_tokens += 1;
        u64::MAX - self.own_tokens
    }

    // ---- Connection (`setConnected`) ----

    fn set_connected(&mut self, connected: bool) {
        self.connected = connected;
        self.generation += 1;
        self.shared.connected.store(connected, Ordering::SeqCst);
        self.shared
            .generation
            .store(self.generation, Ordering::SeqCst);
        self.pending.clear();
        self.loads.clear();
        self.actions.clear();
        self.dirty.clear();
        self.selected_logs.clear();
        self.refresh = None;
        if connected {
            let mut watched: Vec<ChatRef> =
                self.watching.values().map(|(c, _)| c.clone()).collect();
            watched.sort_by_key(ChatRef::key);
            for chat in watched {
                self.load(&chat, None);
            }
        }
        self.notify();
    }

    // ---- Watching (`watch`) ----

    fn watch(&mut self, chat: &ChatRef, token: u64) {
        let key = scope_of(chat);
        let count = self.watching.get(&key).map_or(0, |(_, c)| *c);
        self.watching.insert(key.clone(), (chat.clone(), count + 1));
        self.tokens.insert(token, key);
        self.load(chat, None);
    }

    fn release(&mut self, token: u64) {
        let Some(key) = self.tokens.remove(&token) else {
            return;
        };
        match self.watching.get_mut(&key) {
            Some((_, count)) if *count > 1 => *count -= 1,
            Some(_) => {
                self.watching.remove(&key);
            }
            None => {}
        }
    }

    // ---- Reads ----

    fn run_of(&self, chat: &ChatRef, id: &str) -> Option<Arc<Run>> {
        self.runs
            .get(&scope_of(chat))
            .and_then(|rows| rows.iter().find(|(i, _)| i == id))
            .map(|(_, run)| run.clone())
    }

    /// `runs(ref)`: listed runs, newest first.
    fn listed(&self, scope: &str) -> Vec<Arc<Run>> {
        let mut rows: Vec<Arc<Run>> = self
            .runs
            .get(scope)
            .map(|rows| {
                rows.iter()
                    .filter(|(_, run)| !run.hidden)
                    .map(|(_, run)| run.clone())
                    .collect()
            })
            .unwrap_or_default();
        sort(&mut rows, &|a, b| compare_recency(a, b));
        rows
    }

    fn version(map: &HashMap<String, u64>, key: &str) -> u64 {
        map.get(key).copied().unwrap_or(0)
    }

    /// `_parse(ref, row, id)`.
    fn parse(chat: &ChatRef, row: &DvMap, id: Option<&str>) -> Thrown2<Run> {
        match Run::from_json(row) {
            Some(next)
                if id.is_none_or(|id| next.local_id == id)
                    && next.workspace_local_id.as_deref() == Some(chat.project_id.as_str())
                    && next.worktree_local_id.as_deref() == Some(chat.worktree_id.as_str()) =>
            {
                Ok(next)
            }
            _ => Err(Thrown::remote(CopyKey::DifferentWorktreeState)),
        }
    }

    /// `_put(ref, next)`.
    fn put(&mut self, chat: &ChatRef, next: Run) {
        let rows = self.runs.entry(scope_of(chat)).or_default();
        match rows.iter_mut().find(|(id, _)| *id == next.local_id) {
            Some(slot) => slot.1 = Arc::new(slot.1.merge_with(&next)),
            None => rows.push((next.local_id.clone(), Arc::new(next.clone()))),
        }
        self.revision += 1;
        self.row_versions
            .insert(run_key(chat, &next.local_id), self.revision);
    }

    /// `load(ref)`: one load per worktree at a time.
    fn load(&mut self, chat: &ChatRef, waiter: Option<LoadWaiter>) -> Option<u64> {
        let key = scope_of(chat);
        if let Some(op) = self.loads.get(&key).copied()
            && let Some(load) = self.load_ops.get_mut(&op)
        {
            match waiter {
                Some(LoadWaiter::Host(w)) => load.waiters.push(w),
                Some(LoadWaiter::Drawer(token, read)) => load.drawers.push((token, read)),
                None => {}
            }
            return Some(op);
        }
        let op = self.next_op();
        let generation = self.generation;
        let mut load = LoadOp {
            scope: key.clone(),
            chat: chat.clone(),
            generation,
            revision: self.revision,
            waiters: Vec::new(),
            drawers: Vec::new(),
        };
        match waiter {
            Some(LoadWaiter::Host(w)) => load.waiters.push(w),
            Some(LoadWaiter::Drawer(token, read)) => load.drawers.push((token, read)),
            None => {}
        }
        self.load_ops.insert(op, load);
        self.loads.insert(key, op);
        if !self.connected || self.disposed {
            // `_request` threw before any call.
            self.loaded(op, Err(Thrown::remote(CopyKey::ConnectFirst)), Vec::new());
            return Some(op);
        }
        let target = chat.clone();
        self.spawn(move |inner, computer, _| async move {
            // `Future.wait([executions, list])`: the first failure in time.
            let first: std::sync::Mutex<Option<Thrown>> = std::sync::Mutex::new(None);
            let note = |e: &Thrown| {
                let mut slot = first.lock().unwrap_or_else(|p| p.into_inner());
                if slot.is_none() {
                    *slot = Some(e.clone());
                }
            };
            let (executions, listed) = futures_util::join!(
                async {
                    let r = flows::executions(&inner, &computer, &target).await;
                    if let Err(e) = &r {
                        note(e);
                    }
                    r
                },
                async {
                    let listed: Listed = flows::list_pipelines(&inner, &computer, &target).await;
                    if let Err(e) = &listed.rows {
                        note(e);
                    }
                    listed
                },
            );
            let result = match first.into_inner().unwrap_or_else(|p| p.into_inner()) {
                Some(error) => Err(error),
                None => match (executions, listed.rows) {
                    (Ok(runs), Ok(rows)) => Ok((runs, rows)),
                    (Err(e), _) | (_, Err(e)) => Err(e),
                },
            };
            Msg::Loaded {
                op,
                result,
                lookups: listed.lookups,
            }
        });
        Some(op)
    }

    /// `_load`'s end.
    fn loaded(
        &mut self,
        op: u64,
        result: Thrown2<(Vec<DvMap>, Vec<Dv>)>,
        lookups: Vec<(String, serde_json::Value)>,
    ) {
        let Some(load) = self.load_ops.remove(&op) else {
            return;
        };
        let current = load.generation == self.generation && !self.disposed;
        if current {
            // A load of an earlier connection can finish after this one's:
            // its lookups (the worktree path among them) are not kept.
            self.lookups.extend(lookups);
            let applied = result
                .map_err(Thrown::requested)
                .and_then(|(rows, pipelines)| self.store_loaded(&load, &rows, &pipelines));
            if let Err(error) = applied {
                self.errors.insert(load.scope.clone(), error.message());
            }
            self.notify();
        }
        if self.loads.get(&load.scope) == Some(&op) {
            self.loads.remove(&load.scope);
        }
        for waiter in load.waiters {
            self.done.push((waiter, Outcome::Done));
        }
        for (token, read) in load.drawers {
            self.drawer_load_finished(token, read);
        }
    }

    fn store_loaded(&mut self, load: &LoadOp, rows: &[DvMap], pipelines: &[Dv]) -> Thrown2<()> {
        let held = self.runs.get(&load.scope).cloned().unwrap_or_default();
        let mut next: Vec<(String, Arc<Run>)> = Vec::new();
        for raw in rows {
            let run = Self::parse(&load.chat, raw, None)?;
            let merged = match held.iter().find(|(id, _)| *id == run.local_id) {
                Some((_, existing)) => existing.merge_with(&run),
                None => run,
            };
            match next.iter_mut().find(|(id, _)| *id == merged.local_id) {
                Some(slot) => slot.1 = Arc::new(merged),
                None => next.push((merged.local_id.clone(), Arc::new(merged))),
            }
        }
        // Rows written after the load started keep their newer observation.
        for (id, current) in &held {
            if Self::version(&self.row_versions, &run_key(&load.chat, id)) > load.revision {
                match next.iter_mut().find(|(i, _)| i == id) {
                    Some(slot) => slot.1 = current.clone(),
                    None => next.push((id.clone(), current.clone())),
                }
            }
        }
        for (id, _) in &next {
            self.revision += 1;
            self.row_versions
                .insert(run_key(&load.chat, id), self.revision);
        }
        self.runs.insert(load.scope.clone(), next);
        self.pipelines
            .insert(load.scope.clone(), flows::dispatchable(pipelines));
        self.errors.remove(&load.scope);
        Ok(())
    }

    /// `get(ref, id)`: one read per run at a time.
    fn get(&mut self, chat: &ChatRef, id: &str, waiter: Option<GetWaiter>) {
        let key = run_key(chat, id);
        if let Some(op) = self.pending.get(&key).copied()
            && let Some(get) = self.gets.get_mut(&op)
        {
            get.waiters.extend(waiter);
            return;
        }
        let op = self.next_op();
        self.gets.insert(
            op,
            GetOp {
                key: key.clone(),
                chat: chat.clone(),
                id: id.to_owned(),
                generation: self.generation,
                row_version: Self::version(&self.row_versions, &key),
                event_version: Self::version(&self.event_versions, &key),
                waiters: waiter.into_iter().collect(),
            },
        );
        self.pending.insert(key, op);
        self.notify();
        if !self.connected || self.disposed {
            self.got(op, Err(Thrown::remote(CopyKey::ConnectFirst)));
            return;
        }
        let (target, id) = (chat.clone(), id.to_owned());
        self.spawn(move |inner, computer, _| async move {
            let result = flows::get(&inner, &computer, &target, &id).await;
            Msg::Got { op, result }
        });
    }

    fn got(&mut self, op: u64, result: Thrown2<DvMap>) {
        let Some(get) = self.gets.remove(&op) else {
            return;
        };
        let same_generation = get.generation == self.generation;
        let mut superseded = false;
        let result = if same_generation && !self.disposed {
            result.map_err(Thrown::requested)
        } else {
            Err(Thrown::remote(CopyKey::ConnectionChanged))
        };
        let run = match result.and_then(|row| Self::parse(&get.chat, &row, Some(&get.id))) {
            Ok(next) => {
                // Pushes invalidate reads but do not install a newer
                // observation: re-read if a push arrived.
                if get.row_version != Self::version(&self.row_versions, &get.key) {
                    superseded = true;
                    self.run_of(&get.chat, &get.id)
                } else {
                    self.put(&get.chat, next);
                    self.errors.remove(&get.key);
                    self.run_of(&get.chat, &get.id)
                }
            }
            Err(error) => {
                if same_generation
                    && get.row_version == Self::version(&self.row_versions, &get.key)
                    && get.event_version == Self::version(&self.event_versions, &get.key)
                    && !self.disposed
                {
                    self.errors.insert(get.key.clone(), error.message());
                }
                None
            }
        };
        if self.pending.get(&get.key) == Some(&op) {
            self.pending.remove(&get.key);
        }
        if same_generation
            && (superseded || get.event_version != Self::version(&self.event_versions, &get.key))
            && self.watching.contains_key(&scope_of(&get.chat))
        {
            self.queue(&get.chat, &get.id);
        }
        self.notify();
        for waiter in get.waiters {
            match waiter {
                GetWaiter::Host(w) => self.done.push((w, Outcome::Run(run.clone()))),
                GetWaiter::Start(w, id) => self.done.push((w, Outcome::Started(id))),
                GetWaiter::Queue => {
                    if run.is_some()
                        && let Some((job, step)) = self.selected_logs.get(&get.key).cloned()
                    {
                        self.log(&get.chat, &get.id, job, step, None);
                    }
                }
            }
        }
    }

    /// `log(ref, id, job, step)`: the step's output tail on the run.
    fn log(&mut self, chat: &ChatRef, id: &str, job: String, step: String, waiter: Option<Waiter>) {
        let key = run_key(chat, id);
        let op = self.next_op();
        self.log_ops.insert(
            op,
            LogOp {
                key: key.clone(),
                chat: chat.clone(),
                id: id.to_owned(),
                generation: self.generation,
                row_version: Self::version(&self.row_versions, &key),
                event_version: Self::version(&self.event_versions, &key),
                waiter,
            },
        );
        self.selected_logs.insert(key, (job.clone(), step.clone()));
        if !self.connected || self.disposed {
            self.logged(op, Err(Thrown::remote(CopyKey::ConnectFirst)));
            return;
        }
        let (target, id) = (chat.clone(), id.to_owned());
        self.spawn(move |inner, computer, _| async move {
            let result = flows::log(&inner, &computer, &target, &id, &job, &step).await;
            Msg::Logged { op, result }
        });
    }

    fn logged(&mut self, op: u64, result: Thrown2<DvMap>) {
        let Some(log) = self.log_ops.remove(&op) else {
            return;
        };
        let result = result.map_err(Thrown::requested);
        let result = if log.generation == self.generation && !self.disposed && self.connected {
            result
        } else {
            result.and(Err(Thrown::remote(CopyKey::ConnectionChanged)))
        };
        let outcome = match result {
            Err(error) => Outcome::Failed(Failure::of(&error)),
            Ok(_)
                if log.row_version != Self::version(&self.row_versions, &log.key)
                    || log.event_version != Self::version(&self.event_versions, &log.key) =>
            {
                Outcome::Done
            }
            Ok(run) => match Self::parse(&log.chat, &run, Some(&log.id)) {
                Ok(next) => {
                    self.put(&log.chat, next);
                    self.notify();
                    Outcome::Done
                }
                Err(error) => Outcome::Failed(Failure::of(&error)),
            },
        };
        self.settle(log.waiter, outcome);
    }

    /// `control(ref, id, action)`: a cancel, retry or resume sent at most
    /// once; its late reply never replaces a newer observation.
    fn control(&mut self, chat: &ChatRef, id: &str, action: Control, waiter: Option<Waiter>) {
        let key = run_key(chat, id);
        if self.actions.iter().any(|(k, _)| *k == key) {
            self.settle(waiter, Outcome::Done);
            return;
        }
        let op = self.next_op();
        self.control_ops.insert(
            op,
            ControlOp {
                key: key.clone(),
                chat: chat.clone(),
                id: id.to_owned(),
                generation: self.generation,
                row_version: Self::version(&self.row_versions, &key),
                event_version: Self::version(&self.event_versions, &key),
                waiter,
            },
        );
        self.actions.push((key, action));
        self.notify();
        if !self.connected || self.disposed {
            self.controlled(op, Err(Thrown::remote(CopyKey::ConnectFirst)));
            return;
        }
        let (target, id, generation) = (chat.clone(), id.to_owned(), self.generation);
        self.spawn(move |inner, computer, shared| async move {
            let result =
                flows::control(&inner, &computer, &target, &shared, generation, &id, action).await;
            Msg::Controlled { op, result }
        });
    }

    fn controlled(&mut self, op: u64, result: Thrown2<DvMap>) {
        let Some(control) = self.control_ops.remove(&op) else {
            return;
        };
        let same_generation = control.generation == self.generation;
        let result = result.map_err(Thrown::requested);
        let result = if same_generation && !self.disposed && self.connected {
            result
        } else {
            result.and(Err(Thrown::remote(CopyKey::ConnectionChanged)))
        };
        match result.and_then(|row| Self::parse(&control.chat, &row, Some(&control.id))) {
            Ok(next) => {
                if control.row_version == Self::version(&self.row_versions, &control.key) {
                    self.put(&control.chat, next);
                    if control.event_version != Self::version(&self.event_versions, &control.key) {
                        self.queue(&control.chat, &control.id);
                    }
                } else {
                    // The mutation was sent once. Reconcile its outcome by
                    // reading, without letting its late reply replace a
                    // newer observation.
                    self.queue(&control.chat, &control.id);
                }
                self.action_errors.remove(&control.key);
            }
            Err(error) => {
                if same_generation && !self.disposed {
                    self.action_errors
                        .insert(control.key.clone(), error.message());
                }
            }
        }
        if same_generation {
            self.actions.retain(|(k, _)| *k != control.key);
        }
        self.notify();
        self.settle(control.waiter, Outcome::Done);
    }

    /// `form(ref, pipelineId, origin)`.
    fn form(&mut self, chat: &ChatRef, pipeline_id: &str, origin: Origin, waiter: Option<Waiter>) {
        if !self.connected || self.disposed {
            let failure = Failure::of(&Thrown::remote(CopyKey::ConnectFirst));
            self.settle(waiter, Outcome::Failed(failure));
            return;
        }
        let op = self.next_op();
        self.form_ops.insert(op, (self.generation, waiter));
        let lookup = self
            .lookups
            .get(&flows::lookup_key(chat, pipeline_id, origin.name()))
            .cloned();
        let pipeline_id = pipeline_id.to_owned();
        self.spawn(move |inner, computer, _| async move {
            let result = flows::form(&inner, &computer, &pipeline_id, origin, lookup).await;
            Msg::Formed { op, result }
        });
    }

    fn formed(&mut self, op: u64, result: Thrown2<DispatchForm>) {
        let Some((generation, waiter)) = self.form_ops.remove(&op) else {
            return;
        };
        let result = result.map_err(Thrown::requested);
        let result = if generation == self.generation && !self.disposed && self.connected {
            result
        } else {
            result.and(Err(Thrown::remote(CopyKey::ConnectionChanged)))
        };
        let outcome = match result {
            Ok(form) => Outcome::Form(form),
            Err(error) => Outcome::Failed(Failure::of(&error)),
        };
        self.settle(waiter, outcome);
    }

    /// `start(ref, pipelineId, inputs, origin)`: one `pipelines:execute`;
    /// an unconfirmed one blocks the next start of that pipeline.
    fn start(
        &mut self,
        chat: &ChatRef,
        pipeline_id: String,
        origin: Origin,
        inputs: Vec<(String, String)>,
        waiter: Option<Waiter>,
    ) {
        let key = format!("{}/{}/{pipeline_id}", scope_of(chat), origin.name());
        if self.starts.contains(&key) {
            let failure = Failure::of(&Thrown::remote(CopyKey::StartUnconfirmed));
            self.settle(waiter, Outcome::Failed(failure));
            return;
        }
        if !self.connected || self.disposed {
            // `_request` threw before the mutation: the key is released.
            let failure = Failure::of(&Thrown::remote(CopyKey::ConnectFirst));
            self.settle(waiter, Outcome::Failed(failure));
            return;
        }
        self.starts.insert(key.clone());
        let op = self.next_op();
        let generation = self.generation;
        self.start_ops.insert(
            op,
            StartOp {
                key,
                chat: chat.clone(),
                generation,
                waiter,
            },
        );
        let lookup = self
            .lookups
            .get(&flows::lookup_key(chat, &pipeline_id, origin.name()))
            .cloned();
        let target = chat.clone();
        self.spawn(move |inner, computer, shared| async move {
            let started = flows::run(
                &inner,
                &computer,
                &target,
                &shared,
                generation,
                (&pipeline_id, origin, lookup, &inputs),
            )
            .await;
            Msg::Ran { op, started }
        });
    }

    fn ran(&mut self, op: u64, started: Started) {
        let Some(start) = self.start_ops.remove(&op) else {
            return;
        };
        let result = match started.result {
            Ok(id) if start.generation == self.generation && !self.disposed && self.connected => {
                Ok(id)
            }
            Ok(_) => Err(Thrown::remote(CopyKey::ConnectionChanged)),
            Err(error) => Err(error.requested()),
        };
        match result {
            Ok(id) => {
                self.starts.remove(&start.key);
                let chat = start.chat.clone();
                match start.waiter {
                    Some(w) => self.get(&chat, &id.clone(), Some(GetWaiter::Start(w, id))),
                    None => self.get(&chat, &id, None),
                }
            }
            Err(error) => {
                let released = matches!(error, Thrown::NotSent(_) | Thrown::Refusal { .. })
                    || !started.mutation_sent;
                if released {
                    self.starts.remove(&start.key);
                }
                self.settle(start.waiter, Outcome::Failed(Failure::of(&error)));
            }
        }
    }

    /// `content(ref, id, source)`.
    fn content(&mut self, chat: &ChatRef, id: &str, source: Source, waiter: Option<Waiter>) {
        if !self.connected || self.disposed {
            let failure = Failure::of(&Thrown::remote(CopyKey::ConnectFirst));
            self.settle(waiter, Outcome::Failed(failure));
            return;
        }
        let op = self.next_op();
        self.read_ops.insert(op, (self.generation, waiter));
        let (target, id) = (chat.clone(), id.to_owned());
        self.spawn(move |inner, computer, _| async move {
            let result = flows::content(&inner, &computer, &target, &id, &source).await;
            Msg::Read { op, result }
        });
    }

    fn read(&mut self, op: u64, result: Thrown2<Document>) {
        let Some((generation, waiter)) = self.read_ops.remove(&op) else {
            return;
        };
        let outcome = if generation != self.generation || self.disposed || !self.connected {
            Outcome::Failed(Failure::of(&Thrown::remote(CopyKey::ConnectionChanged)))
        } else {
            match result {
                Ok(document) => Outcome::Content(document),
                Err(error) => Outcome::Failed(Failure::of(&error)),
            }
        };
        self.settle(waiter, outcome);
    }

    // ---- Pushes (`_event`, `_queue`) ----

    fn push(&mut self, message: &serde_json::Value) {
        let dto = cc_protocol::dto::desktop_value(message);
        if !self.peer.sees(&dto) {
            return;
        }
        if !dto.get("name").is_str("ipc.push") {
            return;
        }
        let payload = dto.get("payload");
        let Some(channel) = payload.get("channel").as_str() else {
            return;
        };
        let channel = channel.to_owned();
        if matches!(
            channel.as_str(),
            "pipelines:execution-event" | "pipelines:step-output-event"
        ) {
            self.run_event(payload);
        } else {
            self.drawer_push(&channel, payload);
        }
    }

    fn run_event(&mut self, payload: &Dv) {
        if !self.connected || !payload.is_map() {
            return;
        }
        let Some(args) = payload.get("args").elements() else {
            return;
        };
        let Some(Dv::Map(row)) = args.first() else {
            return;
        };
        let Dv::Str(id) = row.get("executionId") else {
            return;
        };
        let state = row.get("state");
        let mut watched: Vec<ChatRef> = self.watching.values().map(|(c, _)| c.clone()).collect();
        watched.sort_by_key(ChatRef::key);
        for chat in watched {
            let skip = match state {
                Dv::Map(state) => {
                    !state.get("project_id").is_str(&chat.project_id)
                        || !state.get("worktree_id").is_str(&chat.worktree_id)
                }
                _ => self.run_of(&chat, id).is_none(),
            };
            if skip {
                continue;
            }
            let key = run_key(&chat, id);
            *self.event_versions.entry(key).or_insert(0) += 1;
            self.queue(&chat, id);
        }
    }

    /// `_queue(ref, id)`: a re-read 500 ms after the first dirty run.
    fn queue(&mut self, chat: &ChatRef, id: &str) {
        let key = run_key(chat, id);
        match self.dirty.iter_mut().find(|(k, _, _)| *k == key) {
            Some(slot) => {
                slot.1 = chat.clone();
            }
            None => self.dirty.push((key, chat.clone(), id.to_owned())),
        }
        if self.refresh.is_none() {
            self.refresh = Some(self.timer(TimerKind::Refresh, REFRESH));
        }
    }

    /// Pushes were dropped: re-read what they cover.
    fn lagged(&mut self) {
        if !self.connected || self.disposed {
            return;
        }
        let mut watched: Vec<ChatRef> = self.watching.values().map(|(c, _)| c.clone()).collect();
        watched.sort_by_key(ChatRef::key);
        for chat in watched {
            self.load(&chat, None);
        }
        self.drawers_lagged();
    }

    // ---- Chat activity followers ----

    fn follow_chats(&mut self, published: &ChatsPublished) {
        if self.disposed {
            return;
        }
        let Some(selected) = &published.selected else {
            return;
        };
        let changed = match &self.chat {
            Some(held) => {
                held.chat.key() != selected.state.chat.key()
                    || held.revision != selected.state.revision
                    || held.transcript_revision != selected.state.transcript_revision
                    || held.messages.len() != selected.state.messages.len()
                    || held
                        .messages
                        .iter()
                        .zip(&selected.state.messages)
                        .any(|(a, b)| a.uid != b.uid)
                    || held.runtime != selected.state.runtime
            }
            None => true,
        };
        if changed {
            self.chat = Some(Arc::new(selected.state.clone()));
            // A rebuild of the feed re-ran the controller's hydrate, and the
            // drawer re-projects its chat.
            self.sync_followers_refresh(false);
            self.drawers_chat_changed();
        }
    }

    /// The chat state of `chat`, when it is the mounted one.
    fn chat_state(&self, chat: &ChatRef) -> Option<Arc<ChatState>> {
        self.chat
            .as_ref()
            .filter(|state| state.chat.key() == chat.key())
            .cloned()
    }

    /// `update(ref, messages, online)`.
    fn follow(&mut self, token: u64, chat: Option<ChatRef>, online: bool) {
        let previous = self.followers.remove(&token);
        let mut follower = previous.unwrap_or(Follower {
            chat: None,
            online: false,
            watch: None,
            requested: HashSet::new(),
            connected_generation: None,
        });
        let changed = follower.chat.as_ref().map(ChatRef::key) != chat.as_ref().map(ChatRef::key);
        follower.chat = chat;
        follower.online = online;
        if changed {
            if let Some(watch) = follower.watch.take() {
                self.release(watch);
            }
            follower.requested.clear();
            if let Some(chat) = follower.chat.clone() {
                let watch = self.own_token();
                self.watch(&chat, watch);
                follower.watch = Some(watch);
            }
        }
        self.followers.insert(token, follower);
        self.sync_follower(token, changed);
    }

    fn sync_followers(&mut self) {
        self.sync_followers_refresh(false);
    }

    fn sync_followers_refresh(&mut self, refresh: bool) {
        let mut tokens: Vec<u64> = self.followers.keys().copied().collect();
        tokens.sort_unstable();
        for token in tokens {
            self.sync_follower(token, refresh);
        }
    }

    /// `_syncConnection(refresh)` then `_hydrate`.
    fn sync_follower(&mut self, token: u64, refresh: bool) {
        let (connected, generation) = (self.connected, self.generation);
        let Some(follower) = self.followers.get_mut(&token) else {
            return;
        };
        let current = (follower.online && connected).then_some(generation);
        let reconnected = current.is_some() && current != follower.connected_generation;
        follower.connected_generation = current;
        if reconnected {
            follower.requested.clear();
        }
        let refresh = refresh || reconnected;
        if !follower.online || !connected {
            return;
        }
        let Some(chat) = follower.chat.clone() else {
            return;
        };
        let activity = self.activity_of(&chat);
        let mut wanted = Vec::new();
        if let Some(follower) = self.followers.get_mut(&token) {
            for turn in &activity {
                for run in &turn.runs {
                    if (refresh || !run.has_detail())
                        && follower.requested.insert(run.local_id.clone())
                    {
                        wanted.push(run.local_id.clone());
                    }
                }
            }
        }
        for id in wanted {
            self.get(&chat, &id, None);
        }
    }

    /// `devicePipelineChatActivity(ref, messages, runs(ref))`.
    fn activity_of(&self, chat: &ChatRef) -> Vec<TurnRuns> {
        let listed = self.listed(&scope_of(chat));
        let state = self.chat_state(chat);
        let messages = state.as_ref().map_or(&[][..], |s| &s.messages[..]);
        chat_activity(chat, messages, listed.iter().map(AsRef::as_ref)).unwrap_or_default()
    }

    // ---- Published ----

    fn scope_shown(&self, scope: &str) -> ScopeShown {
        let prefix = format!("{scope}/");
        let in_scope = |key: &str| key.strip_prefix(&prefix).map(str::to_owned);
        let mut run_errors: Vec<(String, String)> = self
            .errors
            .iter()
            .filter_map(|(k, v)| in_scope(k).map(|id| (id, v.clone())))
            .collect();
        run_errors.sort();
        let mut action_errors: Vec<(String, String)> = self
            .action_errors
            .iter()
            .filter_map(|(k, v)| in_scope(k).map(|id| (id, v.clone())))
            .collect();
        action_errors.sort();
        let mut pending: Vec<String> = self.pending.keys().filter_map(|k| in_scope(k)).collect();
        pending.sort();
        ScopeShown {
            runs: self.listed(scope),
            hidden: self
                .runs
                .get(scope)
                .map(|rows| {
                    rows.iter()
                        .filter(|(_, r)| r.hidden)
                        .map(|(_, r)| r.clone())
                        .collect()
                })
                .unwrap_or_default(),
            pipelines: self.pipelines.get(scope).cloned().unwrap_or_default(),
            error: self.errors.get(scope).cloned(),
            run_errors,
            action_errors,
            pending,
            actions: self
                .actions
                .iter()
                .filter_map(|(k, a)| in_scope(k).map(|id| (id, *a)))
                .collect(),
        }
    }

    fn published(&mut self, revision: u64) -> Published {
        // Every worktree something is known of: the first two segments of
        // a worktree or run key (ids carry no slash).
        let mut scopes: Vec<String> = Vec::new();
        for key in self
            .runs
            .keys()
            .chain(self.pipelines.keys())
            .chain(self.watching.keys())
            .chain(self.errors.keys())
            .chain(self.loads.keys())
            .chain(self.pending.keys())
            .chain(self.action_errors.keys())
            .chain(self.actions.iter().map(|(k, _)| k))
        {
            let scope: String = key.splitn(3, '/').take(2).collect::<Vec<_>>().join("/");
            if !scopes.contains(&scope) {
                scopes.push(scope);
            }
        }
        let mut out = Published {
            revision,
            ..Published::default()
        };
        for scope in scopes {
            let shown = self.scope_shown(&scope);
            let reused = self
                .shown
                .scopes
                .get(&scope)
                .filter(|previous| ***previous == shown)
                .cloned();
            out.scopes
                .insert(scope, reused.unwrap_or_else(|| Arc::new(shown)));
        }
        for (token, follower) in &self.followers {
            let shown = match &follower.chat {
                Some(chat) => {
                    let turns = self.activity_of(chat);
                    let latest = self.chat_state(chat).and_then(|state| {
                        state
                            .messages
                            .iter()
                            .rev()
                            .filter_map(|m| m.id().ok())
                            .find(|id| turns.iter().any(|t| t.turn == *id))
                            .map(str::to_owned)
                    });
                    FollowShown {
                        scope: Some(scope_of(chat)),
                        turns,
                        latest,
                    }
                }
                None => FollowShown::default(),
            };
            let reused = self
                .shown
                .follows
                .get(token)
                .filter(|previous| ***previous == shown)
                .cloned();
            out.follows
                .insert(*token, reused.unwrap_or_else(|| Arc::new(shown)));
        }
        let tokens: Vec<u64> = self.drawers.keys().copied().collect();
        for token in tokens {
            let shown = self.drawer_shown(token);
            let reused = self
                .shown
                .drawers
                .get(&token)
                .filter(|previous| ***previous == shown)
                .cloned();
            out.drawers
                .insert(token, reused.unwrap_or_else(|| Arc::new(shown)));
        }
        self.shown = Published {
            revision,
            scopes: out.scopes.clone(),
            follows: out.follows.clone(),
            drawers: out.drawers.clone(),
        };
        out
    }
}

/// What waits for a `load`.
enum LoadWaiter {
    Host(Waiter),
    /// A drawer read (`token`, read op) that awaits the load.
    Drawer(u64, u64),
}

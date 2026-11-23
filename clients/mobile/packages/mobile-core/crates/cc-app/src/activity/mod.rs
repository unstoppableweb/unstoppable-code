//! One computer's worktree activity and changed-file diffs (architecture
//! §3.5, P6). Ported from `device_link/activity/{repository,
//! hook_repository,pr_repository,todos}.dart` and
//! `device_link/files/repository.dart` (with `cache/observable_lru.dart`);
//! comments cite the Dart rule they keep.
//!
//! One actor task owns every worktree's activity snapshot, configured
//! hooks and their serialized writes, pull request observations, progress
//! feeds and guarded actions, the chat todos (from the chat read path's
//! published selection, a cross-store read) and the diff cache. Intents,
//! pushes from the fan-out, timer fires and the results of the reads it
//! spawns apply in order on one inbox; every applied message publishes one
//! [`Published`] snapshot, from which each subscriber's pump
//! (`api::activity`) builds its view. Reads re-check the connection
//! generation between their awaits, as Dart's did.
use crate::chats::Peer;
mod diffs;
mod flows;
mod prs;

pub(crate) use diffs::{DiffKey, DiffState, Target as DiffTarget};
pub(crate) use prs::{PrAction, PrIdentity, PrState};

use crate::{
    account::{Inbox, Scope, View},
    bridge::{Inner, shutdown_failure},
    chats::Published as ChatsPublished,
    copy::activity::{self as copy, CopyKey},
    error::{Error, Result},
    failures,
    owners::{End, Owners},
    push::{self, Delivery, Filter},
};
use cc_domain::{
    activity::{
        Hook, Loaded, Plan, Run, ScriptDescriptor, ScriptRun, Summary, Thrown, TodoList, Todos,
        device_todos,
    },
    chat::ChatRef,
    dart::Dv,
    files::ChangedFile,
};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    runtime::Handle as Runtime,
    sync::{mpsc, oneshot, watch},
};

/// The pushes that schedule an activity reload (`_event`).
const ACTIVITY_PUSHES: [&str; 8] = [
    "worktrees:file-changed",
    "workspace:worktrees-updated",
    "worktree-summary:updated",
    "tracked-plans:updated",
    "script:started",
    "script:complete",
    "hook:started",
    "hook:complete",
];
/// The pushes the PR observations read.
const PR_PUSHES: [&str; 4] = [
    "worktree:branch-changed",
    "github:pr-status-event",
    "github:pr-creation-progress",
    "github:merge-pr-progress",
];
const OBSERVED: [&str; 12] = [
    "worktrees:file-changed",
    "workspace:worktrees-updated",
    "worktree-summary:updated",
    "tracked-plans:updated",
    "script:started",
    "script:complete",
    "hook:started",
    "hook:complete",
    "worktree:branch-changed",
    "github:pr-status-event",
    "github:pr-creation-progress",
    "github:merge-pr-progress",
];
/// The activity's and the PRs' push debounce.
const DEBOUNCE: Duration = Duration::from_secs(2);

/// A failure the host rethrows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(crate) message: String,
    /// A `DeviceLinkException` with `message`; otherwise the host words it.
    pub(crate) link: bool,
}

/// How a requested intent ended.
#[derive(Debug, Clone)]
pub(crate) enum Outcome {
    Done,
    Failed(Failure),
    /// A PR action's result map.
    Result(Dv),
    /// A PR action finished after newer state (`remotePrActionDiscardedResult`).
    Discarded,
}

pub(crate) type Waiter = oneshot::Sender<Outcome>;

/// What a Dart flow threw: a `DeviceLinkException` with its message, or
/// anything else (which each caller words).
#[derive(Debug, Clone)]
pub(crate) enum Fail {
    Link(String),
    Other,
}

impl Fail {
    pub(crate) fn rpc(error: &Error) -> Self {
        match failures::read_failure(error) {
            Some(message) => Self::Link(message),
            None => Self::Other,
        }
    }
    pub(crate) fn thrown(thrown: Thrown) -> Self {
        match thrown {
            Thrown::Invalid => Self::Link(copy::text(CopyKey::InvalidMessage).into()),
            Thrown::Cast => Self::Other,
        }
    }
    pub(crate) fn link(key: CopyKey) -> Self {
        Self::Link(copy::text(key).into())
    }
    /// `error is DeviceLinkException ? error.message : fallback`.
    pub(crate) fn message_or(&self, fallback: CopyKey) -> String {
        match self {
            Self::Link(message) => message.clone(),
            Self::Other => copy::text(fallback).into(),
        }
    }
    pub(crate) fn failure(&self) -> Failure {
        match self {
            Self::Link(message) => Failure {
                message: message.clone(),
                link: true,
            },
            Self::Other => Failure {
                message: copy::text(CopyKey::ActivityFailed).into(),
                link: false,
            },
        }
    }
}

/// A worktree's stored activity (`RemoteWorktreeActivity` of a
/// `DeviceActivitySnapshot`).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Stored {
    pub(crate) changed_files: Vec<ChangedFile>,
    pub(crate) summary: Option<Summary>,
    pub(crate) plans: Vec<Plan>,
    pub(crate) scripts: Vec<ScriptDescriptor>,
    pub(crate) script_runs: Vec<ScriptRun>,
    pub(crate) hook_runs: Vec<Run>,
    /// Hook descriptors a snapshot captured (`snapshot()` overlays the
    /// configured hooks when they were read).
    pub(crate) hooks: Vec<Hook>,
    pub(crate) todo_lists: Vec<TodoList>,
}

/// `DeviceActivitySnapshot`.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Snapshot {
    pub(crate) activity: Stored,
    pub(crate) files_error: Option<String>,
    pub(crate) errors: Vec<String>,
    pub(crate) loading: bool,
}

/// `DeviceHookState`.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct HookState {
    pub(crate) hooks: Option<Vec<Hook>>,
    pub(crate) error: Option<String>,
}

/// Everything the activity shows, once per applied message.
#[derive(Debug, Default)]
pub(crate) struct Published {
    pub(crate) revision: u64,
    pub(crate) snapshots: HashMap<String, Arc<Snapshot>>,
    pub(crate) hooks: HashMap<String, Arc<HookState>>,
    pub(crate) prs: HashMap<String, Arc<PrState>>,
    pub(crate) todos: HashMap<String, Arc<Todos>>,
    pub(crate) diffs: HashMap<DiffKey, Arc<DiffState>>,
}

/// What the host asks of the activity.
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
    SetHookPaused {
        chat: ChatRef,
        hook_key: String,
        paused: bool,
    },
    RunPr {
        chat: ChatRef,
        action: PrAction,
        repo_id: Option<String>,
        identity: Option<PrIdentity>,
        confirm: bool,
    },
    WatchDiff {
        target: DiffTarget,
        token: u64,
    },
    ReleaseDiff {
        token: u64,
    },
    RefreshDiff(DiffTarget),
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TimerKind {
    Activity,
    Prs,
    Diffs,
}

pub(crate) enum Msg {
    Intent(Intent, Option<Waiter>),
    Push(push::Push),
    Lagged,
    Chats(Arc<ChatsPublished>),
    Timer(TimerKind, u64),
    Loaded {
        op: u64,
        result: Option<flows::LoadResult>,
    },
    HooksRead {
        op: u64,
        result: std::result::Result<Vec<Hook>, Fail>,
    },
    HookWritten {
        key: String,
        op: u64,
        result: std::result::Result<Vec<Hook>, Fail>,
    },
    Pr(u64, prs::Step),
    Diff {
        key: DiffKey,
        op: u64,
        result: Result<serde_json::Value>,
    },
}

/// What the spawned reads check between their awaits.
#[derive(Default)]
pub(crate) struct Shared {
    pub(crate) generation: AtomicU64,
    pub(crate) connected: AtomicBool,
    pub(crate) disposed: AtomicBool,
}

/// The service's handle: its inbox, published snapshot and the owners of
/// the watch streams.
#[derive(Clone)]
pub(crate) struct Handle {
    inbox: mpsc::UnboundedSender<Msg>,
    view: View<Published>,
    owners: StreamOwners,
}

/// The worktree and diff watch tokens, which `Release` and `ReleaseDiff`
/// end.
#[derive(Clone, Default)]
struct StreamOwners {
    watches: Owners,
    diffs: Owners,
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
        // The chat read path's selection, latest wins (`updateChats`).
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
    /// Reached once the watch `token` is released.
    pub(crate) fn watch_end(&self, token: u64) -> End {
        self.owners.watches.end(token)
    }
    /// Reached once the diff watch `token` is released.
    pub(crate) fn diff_end(&self, token: u64) -> End {
        self.owners.diffs.end(token)
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
pub(crate) fn worktree_key(project: &str, worktree: &str) -> String {
    format!("{project}/{worktree}")
}

fn key_of(chat: &ChatRef) -> String {
    worktree_key(&chat.project_id, &chat.worktree_id)
}

/// The watches of each worktree, by token in watch order: a worktree stays
/// watched until its last watch is released, for the chat watched last.
#[derive(Default)]
struct Watching(HashMap<String, Vec<(u64, ChatRef)>>);

impl Watching {
    fn watch(&mut self, chat: ChatRef, token: u64) {
        self.0.entry(key_of(&chat)).or_default().push((token, chat));
    }
    fn release(&mut self, token: u64) {
        self.0.retain(|_, watches| {
            watches.retain(|(t, _)| *t != token);
            !watches.is_empty()
        });
    }
    /// The chat watched last in worktree `key`.
    fn get(&self, key: &str) -> Option<&ChatRef> {
        self.0.get(key)?.last().map(|(_, chat)| chat)
    }
    /// Each watched worktree's chat.
    fn chats(&self) -> Vec<ChatRef> {
        self.0
            .values()
            .filter_map(|watches| watches.last().map(|(_, chat)| chat.clone()))
            .collect()
    }
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// One `load(ref)`: the activity read and the hook read it waits for
/// (`Future.wait([_load(ref), hooks.load(ref)])`).
struct LoadOp {
    key: String,
    generation: u64,
    /// The activity read's changed files when it started (`previous`).
    previous: Vec<ChangedFile>,
    activity_done: bool,
    hooks_done: bool,
    threw: bool,
    waiters: Vec<Waiter>,
    joins: Vec<u64>,
}

/// One `hooks.load(ref)`.
struct HookRead {
    key: String,
    generation: u64,
    version: u64,
    loads: Vec<u64>,
}

/// One queued `hooks.setPaused`.
struct HookWrite {
    chat: ChatRef,
    hook_key: String,
    paused: bool,
    generation: u64,
    waiter: Option<Waiter>,
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
    // ---- Activity (`DeviceActivityRepository`) ----
    /// The activity and pull requests of these worktrees follow pushes.
    watching: Watching,
    snapshots: HashMap<String, Arc<Snapshot>>,
    /// The `load` in flight per worktree.
    reads: HashMap<String, u64>,
    loads: HashMap<u64, LoadOp>,
    /// `setConnected` callers waiting for the loads it started.
    joins: HashMap<u64, (usize, Option<Waiter>)>,
    refresh: Option<u64>,
    todos: HashMap<String, Arc<Todos>>,
    // ---- Hooks (`DeviceHookRepository`) ----
    hooks: HashMap<String, Arc<HookState>>,
    hook_reads: HashMap<String, u64>,
    hook_ops: HashMap<u64, HookRead>,
    hook_writes: HashMap<String, VecDeque<HookWrite>>,
    /// The worktrees with a write running (the queue's head).
    hook_writing: HashMap<String, (u64, HookWrite)>,
    /// Writes still running from an earlier connection: they finish on
    /// their own and no longer hold up a worktree's queue.
    hook_orphans: HashMap<u64, (String, HookWrite)>,
    hook_versions: HashMap<String, u64>,
    // ---- Pull requests (`DevicePrRepository`) ----
    prs: prs::Prs,
    // ---- Diffs (`DeviceFileDiffRepository`) ----
    diffs: diffs::Diffs,
    /// Waiters to answer after this message's snapshot is published.
    done: Vec<(Waiter, Outcome)>,
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
            watching: Watching::default(),
            snapshots: HashMap::new(),
            reads: HashMap::new(),
            loads: HashMap::new(),
            joins: HashMap::new(),
            refresh: None,
            todos: HashMap::new(),
            hooks: HashMap::new(),
            hook_reads: HashMap::new(),
            hook_ops: HashMap::new(),
            hook_writes: HashMap::new(),
            hook_writing: HashMap::new(),
            hook_orphans: HashMap::new(),
            hook_versions: HashMap::new(),
            prs: prs::Prs::default(),
            diffs: diffs::Diffs::default(),
            done: Vec::new(),
        }
    }

    async fn run(mut self, mut rx: Inbox<Msg>, publish: watch::Sender<Arc<Published>>) {
        let mut revision = 0;
        while let Some(msg) = rx.recv(|| Msg::Intent(Intent::Close, None)).await {
            self.apply(msg);
            revision += 1;
            publish.send_replace(Arc::new(self.published(revision)));
            for (waiter, outcome) in self.done.drain(..) {
                let _ = waiter.send(outcome);
            }
            if self.disposed {
                break;
            }
        }
        self.pushes = None;
    }

    fn published(&self, revision: u64) -> Published {
        Published {
            revision,
            snapshots: self.snapshots.clone(),
            hooks: self.hooks.clone(),
            prs: self.prs.states.clone(),
            todos: self.todos.clone(),
            diffs: self.diffs.published(),
        }
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
            Msg::Loaded { op, result } => self.loaded(op, result),
            Msg::HooksRead { op, result } => self.hooks_read(op, result),
            Msg::HookWritten { key, op, result } => self.hook_written(&key, op, result),
            Msg::Pr(op, step) => self.pr_step(op, step),
            Msg::Diff { key, op, result } => self.diff_read(key, op, result),
        }
    }

    fn intent(&mut self, intent: Intent, waiter: Option<Waiter>) {
        match intent {
            Intent::SetConnected(connected) => self.set_connected(connected, waiter),
            Intent::Watch { chat, token } => {
                self.watch(chat, token);
                self.settle(waiter, Outcome::Done);
            }
            Intent::Release { token } => {
                self.owners.watches.close(token);
                self.release(token);
                self.settle(waiter, Outcome::Done);
            }
            Intent::Load(chat) => {
                self.load(&chat, waiter);
            }
            Intent::SetHookPaused {
                chat,
                hook_key,
                paused,
            } => self.set_hook_paused(chat, hook_key, paused, waiter),
            Intent::RunPr {
                chat,
                action,
                repo_id,
                identity,
                confirm,
            } => self.run_pr(&chat, action, repo_id, identity, confirm, waiter),
            Intent::WatchDiff { target, token } => {
                self.watch_diff(target, token);
                self.settle(waiter, Outcome::Done);
            }
            Intent::ReleaseDiff { token } => {
                self.owners.diffs.close(token);
                self.release_diff(token);
                self.settle(waiter, Outcome::Done);
            }
            Intent::RefreshDiff(target) => self.refresh_diff(&target, waiter),
            Intent::Close => {
                self.dispose();
                self.settle(waiter, Outcome::Done);
            }
        }
    }

    fn fired(&mut self, kind: TimerKind, token: u64) {
        match kind {
            TimerKind::Activity if self.refresh == Some(token) => {
                self.refresh = None;
                for chat in self.watching.chats() {
                    self.load(&chat, None);
                }
            }
            TimerKind::Prs if self.prs.refresh == Some(token) => {
                self.prs.refresh = None;
                self.reload_watched_prs();
            }
            TimerKind::Diffs if self.diffs.refresh == Some(token) => {
                self.diffs.refresh = None;
                self.refresh_watched_diffs();
            }
            _ => {}
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
        self.prs.refresh = None;
        self.diffs.refresh = None;
        self.pushes = None;
    }

    // ---- Connection (`setConnected`) ----

    fn set_connected(&mut self, connected: bool, waiter: Option<Waiter>) {
        self.generation += 1;
        self.connected = connected;
        self.shared
            .generation
            .store(self.generation, Ordering::SeqCst);
        self.shared.connected.store(connected, Ordering::SeqCst);
        self.diffs_connected(connected);
        self.prs_connected(connected);
        // `hooks.setConnected`: reads and writes of the old connection end.
        self.hook_reads.clear();
        // Queued writes of the old connection do nothing; a running one
        // finishes on its own.
        for (_, queue) in std::mem::take(&mut self.hook_writes) {
            for write in queue {
                self.settle(write.waiter, Outcome::Done);
            }
        }
        for (key, (op, write)) in std::mem::take(&mut self.hook_writing) {
            self.hook_orphans.insert(op, (key, write));
        }
        self.reads.clear();
        self.refresh = None;
        let mut started = Vec::new();
        if connected {
            for chat in self.watching.chats() {
                if let Some(op) = self.load(&chat, None) {
                    started.push(op);
                }
            }
        }
        // `await Future.wait(_reads.values)`.
        let pending: Vec<u64> = started
            .into_iter()
            .filter(|op| self.loads.contains_key(op))
            .collect();
        if pending.is_empty() {
            self.settle(waiter, Outcome::Done);
            return;
        }
        let join = self.next_op();
        for op in &pending {
            if let Some(load) = self.loads.get_mut(op) {
                load.joins.push(join);
            }
        }
        self.joins.insert(join, (pending.len(), waiter));
    }

    // ---- Watching (`watch`) ----

    fn watch(&mut self, chat: ChatRef, token: u64) {
        self.watching.watch(chat.clone(), token);
        self.reload_pr(&chat);
        self.load(&chat, None);
    }

    fn release(&mut self, token: u64) {
        self.watching.release(token);
    }

    // ---- Todos (`updateChats`) ----

    fn follow_chats(&mut self, published: &ChatsPublished) {
        if self.disposed {
            return;
        }
        let Some(selected) = &published.selected else {
            return;
        };
        let key = key_of(&selected.chat);
        let next = device_todos(&selected.state.scope.tabs);
        if self.todos.get(&key).is_some_and(|t| **t == next) {
            return;
        }
        let lists = next.lists.clone();
        self.todos.insert(key.clone(), Arc::new(next));
        let mut snapshot = self.snapshot(&key);
        snapshot.activity.todo_lists = lists;
        self.snapshots.insert(key, Arc::new(snapshot));
    }

    /// `snapshot(ref)`: the stored snapshot (loading when none), with the
    /// configured hooks once they were read.
    fn snapshot(&self, key: &str) -> Snapshot {
        let mut current = self.snapshots.get(key).map_or_else(
            || Snapshot {
                loading: true,
                ..Snapshot::default()
            },
            |s| (**s).clone(),
        );
        if let Some(hooks) = self.hooks.get(key).and_then(|h| h.hooks.clone()) {
            current.activity.hooks = hooks;
        }
        current
    }

    // ---- Loads (`load`, `_load`) ----

    /// `load(ref)`. Returns the load it started or joined.
    fn load(&mut self, chat: &ChatRef, waiter: Option<Waiter>) -> Option<u64> {
        if !self.connected || self.disposed {
            self.settle(waiter, Outcome::Done);
            return None;
        }
        let key = key_of(chat);
        if let Some(op) = self.reads.get(&key).copied()
            && let Some(load) = self.loads.get_mut(&op)
        {
            load.waiters.extend(waiter);
            return Some(op);
        }
        let op = self.next_op();
        // `_load` marks the snapshot loading before its first await.
        let previous = self.snapshot(&key).activity;
        let changed = previous.changed_files.clone();
        self.snapshots.insert(
            key.clone(),
            Arc::new(Snapshot {
                activity: previous,
                loading: true,
                ..Snapshot::default()
            }),
        );
        let generation = self.generation;
        let target = chat.clone();
        self.spawn(move |inner, computer, shared| async move {
            let result = flows::load(&inner, &computer, &target, &shared, generation).await;
            Msg::Loaded { op, result }
        });
        self.loads.insert(
            op,
            LoadOp {
                key: key.clone(),
                generation,
                previous: changed,
                activity_done: false,
                hooks_done: false,
                threw: false,
                waiters: waiter.into_iter().collect(),
                joins: Vec::new(),
            },
        );
        self.reads.insert(key.clone(), op);
        self.load_hooks(chat, Some(op));
        Some(op)
    }

    /// `_load`'s end.
    fn loaded(&mut self, op: u64, result: Option<flows::LoadResult>) {
        let Some(load) = self.loads.get(&op) else {
            return;
        };
        let (key, generation, previous) =
            (load.key.clone(), load.generation, load.previous.clone());
        let mut threw = false;
        // Superseded between awaits: Dart's `_load` returned.
        if let Some(result) = result
            && !self.disposed
            && generation == self.generation
        {
            match result.loaded {
                Ok(loaded) => self.store_loaded(&key, loaded, previous, result.errors),
                Err(_) => threw = true,
            }
        }
        if let Some(load) = self.loads.get_mut(&op) {
            load.activity_done = true;
            load.threw = threw;
        }
        self.finish_load(op);
    }

    fn store_loaded(
        &mut self,
        key: &str,
        loaded: Loaded,
        previous: Vec<ChangedFile>,
        errors: Vec<String>,
    ) {
        let todo_lists = match self.todos.get(key) {
            Some(todos) => todos.lists.clone(),
            None => self.snapshot(key).activity.todo_lists,
        };
        let files_error = loaded
            .changed_files
            .is_none()
            .then(|| copy::text(CopyKey::FilesFailed).to_owned());
        let activity = Stored {
            changed_files: loaded.changed_files.unwrap_or(previous),
            summary: loaded.summary,
            plans: loaded.plans,
            scripts: loaded.scripts,
            script_runs: loaded.script_runs,
            hook_runs: loaded.hook_runs,
            hooks: Vec::new(),
            todo_lists,
        };
        self.snapshots.insert(
            key.to_owned(),
            Arc::new(Snapshot {
                activity,
                files_error,
                errors,
                loading: false,
            }),
        );
    }

    /// The end of `Future.wait([_load, hooks.load])`: its `catchError` and
    /// `whenComplete`.
    fn finish_load(&mut self, op: u64) {
        let Some(load) = self.loads.get(&op) else {
            return;
        };
        if !(load.activity_done && load.hooks_done) {
            return;
        }
        let Some(load) = self.loads.remove(&op) else {
            return;
        };
        let current = self.reads.get(&load.key) == Some(&op);
        if load.threw && !self.disposed && current {
            let previous = self.snapshot(&load.key).activity;
            self.snapshots.insert(
                load.key.clone(),
                Arc::new(Snapshot {
                    activity: previous,
                    files_error: Some(copy::text(CopyKey::FilesFailed).into()),
                    errors: vec![copy::text(CopyKey::ActivityFailed).into()],
                    loading: false,
                }),
            );
        }
        if current {
            self.reads.remove(&load.key);
        }
        for waiter in load.waiters {
            self.done.push((waiter, Outcome::Done));
        }
        for join in load.joins {
            if let Some((left, _)) = self.joins.get_mut(&join) {
                *left -= 1;
                if *left == 0
                    && let Some((_, waiter)) = self.joins.remove(&join)
                {
                    self.settle(waiter, Outcome::Done);
                }
            }
        }
    }

    // ---- Hooks (`DeviceHookRepository`) ----

    fn hook_version(&self, key: &str) -> u64 {
        self.hook_versions.get(key).copied().unwrap_or(0)
    }

    fn hook_state(&self, key: &str) -> HookState {
        self.hooks
            .get(key)
            .map(|h| (**h).clone())
            .unwrap_or_default()
    }

    /// `hooks.load(ref)`; `load` is the activity load that waits for it.
    fn load_hooks(&mut self, chat: &ChatRef, load: Option<u64>) {
        let key = key_of(chat);
        if let Some(op) = self.hook_reads.get(&key).copied()
            && let Some(read) = self.hook_ops.get_mut(&op)
        {
            read.loads.extend(load);
            return;
        }
        let op = self.next_op();
        let generation = self.generation;
        self.hook_ops.insert(
            op,
            HookRead {
                key: key.clone(),
                generation,
                version: self.hook_version(&key),
                loads: load.into_iter().collect(),
            },
        );
        self.hook_reads.insert(key, op);
        let target = chat.clone();
        self.spawn(move |inner, computer, shared| async move {
            let result = flows::hooks(&inner, &computer, &target, &shared, generation, None).await;
            Msg::HooksRead { op, result }
        });
    }

    fn hooks_read(&mut self, op: u64, result: std::result::Result<Vec<Hook>, Fail>) {
        let Some(read) = self.hook_ops.remove(&op) else {
            return;
        };
        let key = read.key.clone();
        // A read of an earlier connection can answer after this one's.
        let current = read.generation == self.generation && !self.disposed;
        let same_version = read.version == self.hook_version(&key);
        match result {
            Ok(hooks) if current && same_version => {
                self.hooks.insert(
                    key.clone(),
                    Arc::new(HookState {
                        hooks: Some(hooks),
                        error: None,
                    }),
                );
            }
            Ok(_) => {}
            Err(fail) => {
                if current && same_version {
                    let hooks = self.hook_state(&key).hooks;
                    self.hooks.insert(
                        key.clone(),
                        Arc::new(HookState {
                            hooks,
                            error: Some(fail.message_or(CopyKey::HooksFailed)),
                        }),
                    );
                }
            }
        }
        if self.hook_reads.get(&key) == Some(&op) {
            self.hook_reads.remove(&key);
        }
        for load in read.loads {
            if let Some(l) = self.loads.get_mut(&load) {
                l.hooks_done = true;
            }
            self.finish_load(load);
        }
    }

    /// `hooks.setPaused`: writes serialize per worktree.
    fn set_hook_paused(
        &mut self,
        chat: ChatRef,
        hook_key: String,
        paused: bool,
        waiter: Option<Waiter>,
    ) {
        let key = key_of(&chat);
        let write = HookWrite {
            chat,
            hook_key,
            paused,
            generation: self.generation,
            waiter,
        };
        self.hook_writes
            .entry(key.clone())
            .or_default()
            .push_back(write);
        if !self.hook_writing.contains_key(&key) {
            self.next_hook_write(&key);
        }
    }

    fn next_hook_write(&mut self, key: &str) {
        while let Some(write) = self.hook_writes.get_mut(key).and_then(VecDeque::pop_front) {
            if write.generation != self.generation || self.disposed {
                self.settle(write.waiter, Outcome::Done);
                continue;
            }
            *self.hook_versions.entry(key.to_owned()).or_insert(0) += 1;
            let (target, hook_key, paused, generation) = (
                write.chat.clone(),
                write.hook_key.clone(),
                write.paused,
                write.generation,
            );
            let owned = key.to_owned();
            let op = self.next_op();
            self.hook_writing.insert(owned.clone(), (op, write));
            self.spawn(move |inner, computer, shared| async move {
                let result = flows::hooks(
                    &inner,
                    &computer,
                    &target,
                    &shared,
                    generation,
                    Some((hook_key, paused)),
                )
                .await;
                Msg::HookWritten {
                    key: owned,
                    op,
                    result,
                }
            });
            return;
        }
        if self.hook_writes.get(key).is_some_and(VecDeque::is_empty) {
            self.hook_writes.remove(key);
        }
    }

    fn hook_written(&mut self, key: &str, op: u64, result: std::result::Result<Vec<Hook>, Fail>) {
        let (write, queued) = if self.hook_writing.get(key).is_some_and(|(o, _)| *o == op) {
            match self.hook_writing.remove(key) {
                Some((_, write)) => (write, true),
                None => return,
            }
        } else {
            match self.hook_orphans.remove(&op) {
                Some((_, write)) => (write, false),
                None => return,
            }
        };
        // A write of an earlier connection can pass its generation check
        // and still answer after the reconnect's reload: it only settles.
        if write.generation == self.generation && !self.disposed {
            let state = match result {
                Ok(hooks) => HookState {
                    hooks: Some(hooks),
                    error: None,
                },
                Err(fail) => HookState {
                    hooks: self.hook_state(key).hooks,
                    error: Some(fail.message_or(CopyKey::HookChangeFailed)),
                },
            };
            self.hooks.insert(key.to_owned(), Arc::new(state));
        }
        self.settle(write.waiter, Outcome::Done);
        if queued {
            self.next_hook_write(key);
        }
    }

    // ---- Pushes ----

    fn push(&mut self, message: &serde_json::Value) {
        let dto = cc_protocol::dto::desktop_value(message);
        if !self.peer.sees(&dto) {
            return;
        }
        let payload = dto.get("payload");
        let Some(channel) = payload.get("channel").as_str() else {
            return;
        };
        let channel = channel.to_owned();
        if !payload.is_map() {
            return;
        }
        // The diffs listen first: they were subscribed first in Dart.
        if matches!(
            channel.as_str(),
            "worktrees:file-changed" | "workspace:worktrees-updated"
        ) {
            self.invalidate_diffs();
        }
        if PR_PUSHES.contains(&channel.as_str()) {
            self.pr_push(&channel, payload);
        }
        if ACTIVITY_PUSHES.contains(&channel.as_str())
            && self.connected
            && !self.watching.is_empty()
            && !self.disposed
        {
            self.refresh = Some(self.timer(TimerKind::Activity, DEBOUNCE));
        }
    }

    /// Pushes were dropped: re-read what they cover.
    fn lagged(&mut self) {
        if !self.connected || self.disposed {
            return;
        }
        self.invalidate_diffs();
        if !self.watching.is_empty() {
            self.refresh = Some(self.timer(TimerKind::Activity, DEBOUNCE));
        }
        if !self.watching.is_empty() {
            self.prs.refresh = Some(self.timer(TimerKind::Prs, DEBOUNCE));
        }
    }
}

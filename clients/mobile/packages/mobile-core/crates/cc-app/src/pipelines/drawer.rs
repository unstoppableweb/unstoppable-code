//! The composer work drawer of one mounted chat
//! (`DeviceWorkDrawerRepository`): six sequential reads (one drawer read
//! in flight keeps the session's request slots for the chat), quiet
//! retries after 1, 2 and 4 s, push invalidation with a dirty pass, the
//! stop, queue and watcher actions, and the observations its `state`
//! remembers.
use super::{Actor, LoadWaiter, Msg, Outcome, TimerKind, Waiter, scope_of};
use crate::chats::Peer;
use crate::{
    bridge::Inner,
    chats::command_call,
    copy::work::{self as copy, CopyKey},
    failures,
};
use cc_domain::{
    chat::{ChatRef, ChatState},
    dart::{Dv, DvMap},
    pipelines::Run,
    work::{self, Inputs, Observations, WorkAction, WorkItem},
};
use cc_protocol::{FailureKind, dto};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

/// Reads fail transiently while chat hydration fills the session's
/// request slots; retry quietly before reporting.
const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

/// What the host asks of a drawer.
pub(crate) enum DrawerIntent {
    /// `update(chat, online, ready)`. Resolves when applied.
    Update {
        token: u64,
        chat: ChatRef,
        online: bool,
        ready: bool,
    },
    /// `retry()`. Resolves when settled: the read it started or joined
    /// finished.
    Retry { token: u64 },
    /// `act(item, action, notifySubscriber)`. Resolves when settled: the
    /// action and the read after it finished.
    Act {
        token: u64,
        item: String,
        action: WorkAction,
        notify_subscriber: bool,
    },
    /// `dispose()`. Resolves when applied.
    Close { token: u64 },
}

/// Why an action failed.
pub(crate) enum ActFail {
    /// A `DeviceLinkException` with its message.
    Link(String),
    Other,
}

pub(crate) enum DrawerMsg {
    Read {
        token: u64,
        op: u64,
        values: Vec<Option<Dv>>,
        failed: bool,
        unavailable: bool,
    },
    Acted {
        token: u64,
        op: u64,
        result: Result<Dv, ActFail>,
    },
}

/// What a drawer shows.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct DrawerShown {
    /// The key of the chat it shows.
    pub(crate) chat: Option<String>,
    pub(crate) items: Vec<WorkItem>,
    pub(crate) errors: Vec<String>,
    pub(crate) busy: Vec<String>,
}

/// What the spawned reads check between their awaits.
#[derive(Default)]
struct DrawerShared {
    generation: AtomicU64,
    online: AtomicBool,
    ready: AtomicBool,
    disposed: AtomicBool,
}

impl DrawerShared {
    fn current(&self, generation: u64) -> bool {
        !self.disposed.load(Ordering::SeqCst)
            && self.generation.load(Ordering::SeqCst) == generation
            && self.online.load(Ordering::SeqCst)
            && self.ready.load(Ordering::SeqCst)
    }
}

/// What waits for a drawer read.
enum Cont {
    Host(Waiter),
    /// An action's `finally`, after its `await refresh()`.
    Act(u64),
}

struct ReadOp {
    generation: u64,
    chat: ChatRef,
    retry_after: Option<Duration>,
    conts: Vec<Cont>,
}

struct ActOp {
    generation: u64,
    item: String,
    waiter: Option<Waiter>,
}

pub(crate) struct Drawer {
    chat: Option<ChatRef>,
    /// The chat's state from the read path (`_chat`).
    state: Option<Arc<ChatState>>,
    online: bool,
    ready: bool,
    generation: u64,
    attempt: usize,
    retry: Option<u64>,
    read: Option<u64>,
    dirty: bool,
    tasks: Vec<DvMap>,
    watchers: Vec<DvMap>,
    delegations: Vec<DvMap>,
    agents: Vec<DvMap>,
    queue: Vec<DvMap>,
    errors: Vec<String>,
    /// `_actionErrors`, in insertion order.
    action_errors: Vec<(String, String)>,
    observations: Observations,
    busy: Vec<String>,
    pipeline_watch: Option<u64>,
    shared: Arc<DrawerShared>,
    reads: std::collections::HashMap<u64, ReadOp>,
    acts: std::collections::HashMap<u64, ActOp>,
    /// The last projected items, for actions by id.
    items: Vec<WorkItem>,
}

impl Drawer {
    fn new() -> Self {
        Self {
            chat: None,
            state: None,
            online: false,
            ready: false,
            generation: 0,
            attempt: 0,
            retry: None,
            read: None,
            dirty: false,
            tasks: Vec::new(),
            watchers: Vec::new(),
            delegations: Vec::new(),
            agents: Vec::new(),
            queue: Vec::new(),
            errors: Vec::new(),
            action_errors: Vec::new(),
            observations: Observations::default(),
            busy: Vec::new(),
            pipeline_watch: None,
            shared: Arc::default(),
            reads: std::collections::HashMap::new(),
            acts: std::collections::HashMap::new(),
            items: Vec::new(),
        }
    }
    fn sync_shared(&self) {
        self.shared
            .generation
            .store(self.generation, Ordering::SeqCst);
        self.shared.online.store(self.online, Ordering::SeqCst);
        self.shared.ready.store(self.ready, Ordering::SeqCst);
    }
    /// `_cancelRetry()`.
    fn cancel_retry(&mut self) {
        self.retry = None;
        self.attempt = 0;
    }
}

fn scope(chat: &ChatRef) -> Value {
    json!({"projectId": chat.project_id, "worktreeId": chat.worktree_id})
}

fn target(chat: &ChatRef) -> serde_json::Map<String, Value> {
    let mut target = serde_json::Map::new();
    target.insert("projectId".into(), json!(chat.project_id));
    target.insert("worktreeId".into(), json!(chat.worktree_id));
    target.insert("chatId".into(), json!(chat.id));
    target
}

async fn invoke(
    inner: &Inner,
    computer: &Peer,
    channel: &str,
    args: Vec<Value>,
) -> crate::error::Result<Dv> {
    let rx = inner.request(computer, channel, args)?;
    rx.await
        .unwrap_or_else(|_| Err(cc_protocol::rpc::ended("session_ended")))
        .map(|v| dto::desktop_value(&v))
}

/// `refresh()`'s `readSnapshot`: one read at a time, each skipped once the
/// drawer moved on.
async fn read_snapshot(
    inner: &Inner,
    computer: &Peer,
    chat: &ChatRef,
    shared: &DrawerShared,
    generation: u64,
) -> (Vec<Option<Dv>>, bool, bool) {
    let mut failed = false;
    let mut unavailable = false;
    let mut values = Vec::new();
    let reads: [(&str, Vec<Value>); 6] = [
        ("activity:list-live-bg-tasks", vec![scope(chat)]),
        (
            "app-advisor:watchers-list",
            vec![json!({"destination": Value::Object(target(chat))})],
        ),
        ("app-advisor:watchers-completed-list", Vec::new()),
        ("managed-delegation:activity-list", Vec::new()),
        ("managed-delegation:tree", vec![Value::Object(target(chat))]),
        ("chat:queue-get-snapshot", vec![scope(chat)]),
    ];
    for (channel, args) in reads {
        if !shared.current(generation) {
            values.push(None);
            continue;
        }
        let value = match invoke(inner, computer, channel, args).await {
            Ok(value) => {
                let valid = match channel {
                    "activity:list-live-bg-tasks" => work::object(&value).get("chats").is_map(),
                    "managed-delegation:tree" => {
                        let tree = work::object(&value);
                        tree.get("ok").is_true() && tree.get("entries").is_list()
                    }
                    _ => value.is_list(),
                };
                if valid {
                    Some(value)
                } else {
                    failed = true;
                    None
                }
            }
            Err(error) => {
                if error.kind == FailureKind::Refused && error.code == "remote_channel_unavailable"
                {
                    unavailable = true;
                } else {
                    failed = true;
                }
                None
            }
        };
        values.push(value);
    }
    (values, failed, unavailable)
}

/// The action's desktop call.
async fn act_call(
    inner: &Inner,
    computer: &Peer,
    chat: &ChatRef,
    action: WorkAction,
    action_id: Option<String>,
    notify_subscriber: bool,
) -> Result<Dv, ActFail> {
    let rpc = |e: crate::error::Error| match failures::read_failure(&e) {
        Some(message) => ActFail::Link(message),
        None => ActFail::Other,
    };
    let mut args = target(chat);
    let (channel, args) = match action {
        WorkAction::StopTask => {
            args.insert("taskId".into(), json!(action_id));
            ("activity:stop-bg-process", Value::Object(args))
        }
        WorkAction::StopDelegates => ("managed-delegation:stop-all", Value::Object(args)),
        WorkAction::StopDelegate => {
            args.insert("delegationId".into(), json!(action_id));
            ("managed-delegation:stop", Value::Object(args))
        }
        WorkAction::DeleteWatcher => (
            "app-advisor:watcher-delete",
            json!({"watcherId": action_id, "notifySubscriber": notify_subscriber}),
        ),
        WorkAction::CancelQueued | WorkAction::ForceQueued | WorkAction::SteerQueued => {
            let kind = match action {
                WorkAction::CancelQueued => "chat.cancel_queued_message",
                WorkAction::ForceQueued => "chat.force_queued_message",
                _ => "chat.steer_queued_message",
            };
            let command = json!({
                "type": kind,
                "chatId": chat.id,
                "queuedMessageId": action_id,
            });
            let peer = computer.clone();
            return match command_call(inner, &peer, chat, command).await {
                Ok(()) => {
                    let mut ok = DvMap::new();
                    ok.insert("ok".into(), Dv::Bool(true));
                    Ok(Dv::Map(ok))
                }
                Err(error) => Err(match error.link_message() {
                    Some(message) => ActFail::Link(message),
                    None => ActFail::Other,
                }),
            };
        }
    };
    invoke(inner, computer, channel, vec![args])
        .await
        .map_err(rpc)
}

impl Actor {
    pub(super) fn drawer_intent(&mut self, intent: DrawerIntent, waiter: Option<Waiter>) {
        match intent {
            DrawerIntent::Update {
                token,
                chat,
                online,
                ready,
            } => {
                self.drawer_update(token, chat, online, ready);
                self.settle(waiter, Outcome::Done);
            }
            DrawerIntent::Retry { token } => self.drawer_retry(token, waiter),
            DrawerIntent::Act {
                token,
                item,
                action,
                notify_subscriber,
            } => self.drawer_act(token, &item, action, notify_subscriber, waiter),
            DrawerIntent::Close { token } => {
                self.owners.drawers.close(token);
                self.drawer_dispose(token);
                self.settle(waiter, Outcome::Done);
            }
        }
    }

    pub(super) fn drawer_msg(&mut self, msg: DrawerMsg) {
        match msg {
            DrawerMsg::Read {
                token,
                op,
                values,
                failed,
                unavailable,
            } => self.drawer_read(token, op, values, failed, unavailable),
            DrawerMsg::Acted { token, op, result } => self.drawer_acted(token, op, result),
        }
    }

    /// `update(chat, online, ready)`.
    fn drawer_update(&mut self, token: u64, chat: ChatRef, online: bool, ready: bool) {
        let state = self.chat_state(&chat);
        let drawer = self.drawers.entry(token).or_insert_with(Drawer::new);
        let changed = drawer.chat.as_ref().map(ChatRef::key) != Some(chat.key());
        let reconnect = online && !drawer.online;
        let disconnected = !online && drawer.online;
        let became_ready = online && ready && !drawer.ready;
        drawer.chat = Some(chat.clone());
        if state.is_some() || changed {
            drawer.state = state;
        }
        drawer.online = online;
        drawer.ready = ready;
        if changed || disconnected || reconnect {
            drawer.generation += 1;
            drawer.read = None;
            drawer.dirty = false;
            drawer.busy.clear();
            drawer.cancel_retry();
        }
        drawer.sync_shared();
        let mut release = None;
        if changed {
            drawer.tasks.clear();
            drawer.watchers.clear();
            drawer.delegations.clear();
            drawer.agents.clear();
            drawer.queue.clear();
            drawer.errors.clear();
            drawer.action_errors.clear();
            drawer.observations = Observations::default();
            release = drawer.pipeline_watch.take();
        }
        // Same-chat transcript recovery pauses reads without invalidating
        // actions already sent to this connection.
        if online && !ready && drawer.read.is_some() {
            drawer.dirty = true;
        }
        let start = online && ready && (changed || reconnect || became_ready);
        let watch = start && drawer.pipeline_watch.is_none();
        if let Some(watch) = release {
            self.release(watch);
        }
        if watch {
            let watch = self.own_token();
            if let Some(drawer) = self.drawers.get_mut(&token) {
                drawer.pipeline_watch = Some(watch);
            }
            self.watch(&chat, watch);
        }
        if start {
            self.drawer_refresh(token, None);
        }
    }

    /// The mounted chat changed on the read path: drawers on it re-read
    /// their chat state.
    pub(super) fn drawers_chat_changed(&mut self) {
        let Some(state) = self.chat.clone() else {
            return;
        };
        for drawer in self.drawers.values_mut() {
            if drawer
                .chat
                .as_ref()
                .is_some_and(|c| c.key() == state.chat.key())
            {
                drawer.state = Some(state.clone());
            }
        }
    }

    /// `retry()`.
    fn drawer_retry(&mut self, token: u64, waiter: Option<Waiter>) {
        let Some(drawer) = self.drawers.get_mut(&token) else {
            self.settle(waiter, Outcome::Done);
            return;
        };
        if !drawer.online || !drawer.ready {
            self.settle(waiter, Outcome::Done);
            return;
        }
        drawer.action_errors.clear();
        drawer.cancel_retry();
        self.drawer_refresh(token, waiter.map(Cont::Host));
    }

    /// `refresh()`: joins the read in flight, else starts one.
    fn drawer_refresh(&mut self, token: u64, cont: Option<Cont>) {
        let Some(drawer) = self.drawers.get_mut(&token) else {
            self.resolve(token, cont);
            return;
        };
        let Some(chat) = drawer.chat.clone() else {
            self.resolve(token, cont);
            return;
        };
        if !drawer.online || !drawer.ready {
            self.resolve(token, cont);
            return;
        }
        if let Some(read) = drawer.read
            && let Some(op) = drawer.reads.get_mut(&read)
        {
            op.conts.extend(cont);
            return;
        }
        // A fresh read supersedes a scheduled retry; its own failure
        // reschedules.
        drawer.retry = None;
        self.ops += 1;
        let op = self.ops;
        let generation = drawer.generation;
        let shared = drawer.shared.clone();
        drawer.read = Some(op);
        drawer.reads.insert(
            op,
            ReadOp {
                generation,
                chat: chat.clone(),
                retry_after: None,
                conts: cont.into_iter().collect(),
            },
        );
        self.spawn(move |inner, computer, _| async move {
            let (values, failed, unavailable) =
                read_snapshot(&inner, &computer, &chat, &shared, generation).await;
            Msg::Drawer(DrawerMsg::Read {
                token,
                op,
                values,
                failed,
                unavailable,
            })
        });
    }

    /// Answers what waited for a read that did not run.
    fn resolve(&mut self, token: u64, cont: Option<Cont>) {
        match cont {
            Some(Cont::Host(waiter)) => self.settle(Some(waiter), Outcome::Done),
            Some(Cont::Act(op)) => self.drawer_act_finished(token, op),
            None => {}
        }
    }

    /// `refresh()`'s `.then`.
    fn drawer_read(
        &mut self,
        token: u64,
        op: u64,
        values: Vec<Option<Dv>>,
        failed: bool,
        unavailable: bool,
    ) {
        let Some(drawer) = self.drawers.get_mut(&token) else {
            return;
        };
        let Some(read) = drawer.reads.get(&op) else {
            return;
        };
        if read.generation != drawer.generation {
            self.drawer_read_done(token, op);
            return;
        }
        if !drawer.ready {
            drawer.dirty = true;
            self.drawer_read_done(token, op);
            return;
        }
        let chat = read.chat.clone();
        let value = |i: usize| values.get(i).cloned().flatten();
        if let Some(tasks) = value(0).filter(Dv::is_map) {
            let chats = work::object(work::object(&tasks).get("chats"));
            drawer.tasks = work::rows(work::object(chats.get(&chat.id)).get("liveTasks"));
        }
        if let Some(watchers) = value(1).filter(Dv::is_list) {
            let completed = value(2).unwrap_or(Dv::Null);
            drawer.watchers = work::rows(&watchers)
                .into_iter()
                .chain(work::rows(&completed))
                .filter(|w| work::watcher_matches(w, &chat))
                .collect();
        }
        if let Some(delegations) = value(3).filter(Dv::is_list) {
            drawer.delegations = work::rows(&delegations);
        }
        let tree = value(4).unwrap_or(Dv::Null);
        if work::object(&tree).get("ok").is_true() {
            drawer.agents = work::rows(work::object(&tree).get("entries"));
        }
        if let Some(queue) = value(5).filter(Dv::is_list) {
            let row = work::rows(&queue)
                .into_iter()
                .find(|row| chat.matches_scope(row) && row.get("chatId").is_str(&chat.id));
            drawer.queue = work::rows(row.as_ref().map_or(&Dv::Null, |r| r.get("queue")));
        }
        // Unavailable channels need a desktop update, so retrying can't
        // help. Other failures report once their retries run out, and a
        // failure already shown stays until a read settles it.
        let failed_message = copy::text(CopyKey::LoadFailed).to_owned();
        let retrying = failed && drawer.attempt < RETRY_DELAYS.len();
        let shown = drawer.errors.contains(&failed_message);
        let mut retry_after = None;
        if retrying {
            retry_after = Some(RETRY_DELAYS[drawer.attempt]);
            drawer.attempt += 1;
        }
        if !failed {
            drawer.attempt = 0;
        }
        drawer.errors.clear();
        if failed && (!retrying || shown) {
            drawer.errors.push(failed_message);
        }
        if unavailable {
            drawer
                .errors
                .push(copy::text(CopyKey::UpdateComputer).into());
        }
        if let Some(read) = drawer.reads.get_mut(&op) {
            read.retry_after = retry_after;
        }
        // The drawer combines pipeline errors with its own observations.
        // Retry a failed pipeline read too, after releasing the drawer RPC.
        if self.errors.contains_key(&scope_of(&chat)) {
            self.load(&chat, Some(LoadWaiter::Drawer(token, op)));
            return;
        }
        self.drawer_read_done(token, op);
    }

    /// A load a drawer read awaited finished.
    pub(super) fn drawer_load_finished(&mut self, token: u64, op: u64) {
        self.drawer_read_done(token, op);
    }

    /// `refresh()`'s `.whenComplete`.
    fn drawer_read_done(&mut self, token: u64, op: u64) {
        let Some(drawer) = self.drawers.get_mut(&token) else {
            return;
        };
        let Some(read) = drawer.reads.remove(&op) else {
            return;
        };
        let current = read.generation == drawer.generation;
        let mut refresh = false;
        if current {
            if drawer.read == Some(op) {
                drawer.read = None;
            }
            if drawer.dirty {
                drawer.dirty = false;
                refresh = true;
            } else if let Some(delay) = read.retry_after {
                // A newer generation or read cancels it (`retry` cleared).
                let timer = self.timer(TimerKind::DrawerRetry(token), delay);
                if let Some(drawer) = self.drawers.get_mut(&token) {
                    drawer.retry = Some(timer);
                }
            }
            self.notify();
        }
        if refresh {
            self.drawer_refresh(token, None);
        }
        for cont in read.conts {
            self.resolve(token, Some(cont));
        }
    }

    pub(super) fn drawer_retry_fired(&mut self, token: u64, timer: u64) {
        let Some(drawer) = self.drawers.get_mut(&token) else {
            return;
        };
        if drawer.retry != Some(timer) {
            return;
        }
        drawer.retry = None;
        self.drawer_refresh(token, None);
    }

    /// `act(item, action, notifySubscriber)`.
    fn drawer_act(
        &mut self,
        token: u64,
        item: &str,
        action: WorkAction,
        notify_subscriber: bool,
        waiter: Option<Waiter>,
    ) {
        let Some(drawer) = self.drawers.get_mut(&token) else {
            self.settle(waiter, Outcome::Done);
            return;
        };
        let found = drawer.items.iter().find(|i| i.id == item).cloned();
        let (Some(chat), Some(found)) = (drawer.chat.clone(), found) else {
            self.settle(waiter, Outcome::Done);
            return;
        };
        if !drawer.online || !drawer.ready || drawer.busy.iter().any(|b| b == item) {
            self.settle(waiter, Outcome::Done);
            return;
        }
        drawer.busy.push(item.to_owned());
        drawer.action_errors.retain(|(id, _)| id != item);
        self.ops += 1;
        let op = self.ops;
        let generation = drawer.generation;
        drawer.acts.insert(
            op,
            ActOp {
                generation,
                item: item.to_owned(),
                waiter,
            },
        );
        self.notify();
        let action_id = found.action_id.clone();
        self.spawn(move |inner, computer, _| async move {
            let result = act_call(
                &inner,
                &computer,
                &chat,
                action,
                action_id,
                notify_subscriber,
            )
            .await;
            Msg::Drawer(DrawerMsg::Acted {
                token,
                op,
                result: result.and_then(|value| checked(action, value)),
            })
        });
    }

    fn drawer_acted(&mut self, token: u64, op: u64, result: Result<Dv, ActFail>) {
        let Some(drawer) = self.drawers.get_mut(&token) else {
            return;
        };
        let Some(act) = drawer.acts.get(&op) else {
            return;
        };
        if act.generation != drawer.generation {
            if let Some(act) = drawer.acts.remove(&op) {
                self.settle(act.waiter, Outcome::Done);
            }
            return;
        }
        match result {
            Ok(_) => self.drawer_refresh(token, Some(Cont::Act(op))),
            Err(fail) => {
                let message = match fail {
                    ActFail::Link(message) => message,
                    ActFail::Other => copy::text(CopyKey::ActionUnconfirmed).into(),
                };
                let item = act.item.clone();
                match drawer.action_errors.iter_mut().find(|(id, _)| *id == item) {
                    Some(slot) => slot.1 = message,
                    None => drawer.action_errors.push((item, message)),
                }
                self.drawer_act_finished(token, op);
            }
        }
    }

    /// `act`'s `finally`.
    fn drawer_act_finished(&mut self, token: u64, op: u64) {
        let Some(drawer) = self.drawers.get_mut(&token) else {
            return;
        };
        let Some(act) = drawer.acts.remove(&op) else {
            return;
        };
        if act.generation == drawer.generation {
            drawer.busy.retain(|b| *b != act.item);
            self.notify();
        }
        self.settle(act.waiter, Outcome::Done);
    }

    /// `dispose()`.
    pub(super) fn drawer_dispose(&mut self, token: u64) {
        let Some(mut drawer) = self.drawers.remove(&token) else {
            return;
        };
        drawer.shared.disposed.store(true, Ordering::SeqCst);
        drawer.generation += 1;
        drawer.sync_shared();
        if let Some(watch) = drawer.pipeline_watch.take() {
            self.release(watch);
        }
        for (_, read) in drawer.reads.drain() {
            for cont in read.conts {
                if let Cont::Host(waiter) = cont {
                    self.done.push((waiter, Outcome::Done));
                }
            }
        }
        for (_, act) in drawer.acts.drain() {
            if let Some(waiter) = act.waiter {
                self.done.push((waiter, Outcome::Done));
            }
        }
    }

    /// `_event` for the drawers' channels.
    pub(super) fn drawer_push(&mut self, channel: &str, payload: &Dv) {
        let args = payload.get("args");
        let first = args
            .elements()
            .and_then(|items| items.first().map(|v| (*v).clone()))
            .unwrap_or(Dv::Null);
        let event = work::object(&first).clone();
        let tokens: Vec<u64> = {
            let mut t: Vec<u64> = self.drawers.keys().copied().collect();
            t.sort_unstable();
            t
        };
        for token in tokens {
            let Some(drawer) = self.drawers.get_mut(&token) else {
                continue;
            };
            if !drawer.online || !drawer.ready {
                continue;
            }
            let Some(chat) = drawer.chat.clone() else {
                continue;
            };
            let matches = match channel {
                "chat:state-changed" => {
                    chat.matches_scope(&event)
                        && work::rows(event.get("changes")).iter().any(|c| {
                            c.get("chatId").is_str(&chat.id)
                                && c.get("type").is_str("delegation.card_state_updated")
                        })
                }
                "app-advisor:watchers-changed" => true,
                "activity:live-bg-tasks-changed"
                | "managed-delegation:activity-changed"
                | "chat:queue-updated" => {
                    chat.matches_scope(&event) && event.get("chatId").is_str(&chat.id)
                }
                _ => false,
            };
            if !matches {
                continue;
            }
            if drawer.read.is_some() {
                drawer.dirty = true;
            } else {
                self.drawer_refresh(token, None);
            }
        }
    }

    /// Pushes were dropped: every drawer reads again.
    pub(super) fn drawers_lagged(&mut self) {
        let mut tokens: Vec<u64> = self.drawers.keys().copied().collect();
        tokens.sort_unstable();
        for token in tokens {
            let Some(drawer) = self.drawers.get_mut(&token) else {
                continue;
            };
            if drawer.read.is_some() {
                drawer.dirty = true;
            } else {
                self.drawer_refresh(token, None);
            }
        }
    }

    /// `state`: the projection with the remembered observations, and the
    /// drawer's errors.
    pub(super) fn drawer_shown(&mut self, token: u64) -> DrawerShown {
        let Some(drawer) = self.drawers.get(&token) else {
            return DrawerShown::default();
        };
        let Some(chat) = drawer.chat.clone() else {
            return DrawerShown::default();
        };
        let Some(state) = drawer.state.clone() else {
            return DrawerShown {
                chat: Some(chat.key()),
                ..DrawerShown::default()
            };
        };
        let scope = scope_of(&chat);
        let listed = self.listed(&scope);
        let pipelines: Vec<&Run> = listed.iter().map(AsRef::as_ref).collect();
        let projected = work::project(
            &Inputs {
                chat: &state,
                tasks: &drawer.tasks,
                watchers: &drawer.watchers,
                delegations: &drawer.delegations,
                pipelines: &pipelines,
                agents: &drawer.agents,
                queue: &drawer.queue,
            },
            &copy::words,
        );
        let pipeline_error = self.errors.get(&scope).cloned();
        let Some(drawer) = self.drawers.get_mut(&token) else {
            return DrawerShown::default();
        };
        let any = !projected.is_empty();
        let items = drawer.observations.items(projected);
        drawer.items.clone_from(&items);
        let mut errors = drawer.errors.clone();
        errors.extend(drawer.action_errors.iter().map(|(_, m)| m.clone()));
        errors.extend(pipeline_error);
        if !drawer.online && any {
            errors.push(copy::text(CopyKey::Reconnect).into());
        }
        DrawerShown {
            chat: Some(chat.key()),
            items,
            errors,
            busy: drawer.busy.clone(),
        }
    }
}

/// `act`'s result checks.
fn checked(action: WorkAction, result: Dv) -> Result<Dv, ActFail> {
    if let Dv::Map(map) = &result
        && matches!(map.get("ok"), Dv::Bool(false))
    {
        return Err(ActFail::Link(
            work::text(map.get("error")).unwrap_or_else(|| copy::text(CopyKey::Refused).into()),
        ));
    }
    if action == WorkAction::StopTask
        && !["stopped", "already-finished", "session-ended"]
            .iter()
            .any(|s| result.is_str(s))
    {
        return Err(ActFail::Link(
            copy::text(CopyKey::TaskStopUnconfirmed).into(),
        ));
    }
    if matches!(action, WorkAction::StopDelegate | WorkAction::StopDelegates)
        && !work::object(&result).get("ok").is_true()
    {
        return Err(ActFail::Link(
            copy::text(CopyKey::DelegatesStopUnconfirmed).into(),
        ));
    }
    if action == WorkAction::DeleteWatcher && !work::object(&result).get("ok").is_true() {
        return Err(ActFail::Link(
            copy::text(CopyKey::WatcherDeleteUnconfirmed).into(),
        ));
    }
    Ok(result)
}

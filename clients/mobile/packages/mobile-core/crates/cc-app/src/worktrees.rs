//! One computer's worktree creation and archive (architecture §3.3, P8).
//! Ported from `device_link/worktrees/{creation,archive}.dart`
//! (`DeviceWorktreeCreator`, `DeviceWorktreeArchiver`) and the archive part
//! of `computer_connect/controller.dart`; comments cite the Dart rule they
//! keep.
//!
//! One actor task owns every attempt. Intents, the computer's connection
//! changes, `worktree:git-ready` / `worktree:git-failed` pushes, timers and
//! the replies of the reads and writes it sends arrive on one inbox and
//! apply in order. Each `_create` step is a message, with Dart's generation
//! checks between them.
//!
//! Creation is not idempotent: an attempt sends at most one create. A reply
//! the phone did not get, or a refusal after the desktop may have written,
//! marks the project uncertain and the attempt cannot send again; only a
//! request that never left (`NotSent`, `remote_channel_unavailable`) can be
//! retried. The core never resends on its own.
use crate::{
    account::{Inbox, Scope, View},
    api::{AccountView, AttemptView, CreatedWorktreeView, LinkPhase, WorktreesView},
    bridge::{Inner, shutdown_failure},
    chats::Peer,
    copy::worktrees::{self as copy, CopyKey},
    error::{Error, Result},
    failures, overview,
    push::{self, Delivery, Filter},
};
use cc_domain::{
    chat::Thrown,
    dart::Dv,
    worktrees::{self as domain, Fault, GitEvent, GitEvents, Refusal},
};
use cc_protocol::{FailureKind, dto};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::{
    runtime::Handle as Runtime,
    sync::{mpsc, oneshot, watch},
};

/// How long a creation waits for its `worktree:git-ready` push.
const GIT_READY: Duration = Duration::from_secs(45);
/// Removing the checkout stops its sessions first, so it can outlast the
/// session's default request timeout.
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(120);
const PUSHES: [&str; 2] = ["worktree:git-ready", "worktree:git-failed"];

/// What the Dart creator or archiver threw, as the caller sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FailKind {
    /// A `DeviceLinkException` with the message.
    Link,
    /// A `DesktopIpcRefusal`.
    Refused,
    /// A `DesktopIpcNotSent`.
    NotSent,
    /// Another error (a cast, the 45-second wait); the caller words it.
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(crate) message: String,
    pub(crate) kind: FailKind,
    pub(crate) code: Option<String>,
}

impl Failure {
    pub(crate) fn link(key: CopyKey) -> Self {
        Self {
            message: copy::text(key).into(),
            kind: FailKind::Link,
            code: None,
        }
    }
    pub(crate) fn other() -> Self {
        Self {
            message: String::new(),
            kind: FailKind::Other,
            code: None,
        }
    }
    pub(crate) fn thrown(t: Thrown) -> Self {
        match t {
            Thrown::Invalid => Self::link(CopyKey::InvalidMessage),
            Thrown::Cast => Self::other(),
        }
    }
    fn fault(f: Fault) -> Self {
        match f {
            Fault::Thrown(t) => Self::thrown(t),
            Fault::Refused(Refusal::ProjectGone) => Self::link(CopyKey::ProjectGone),
            Fault::Refused(Refusal::CoworkProject) => Self::link(CopyKey::ChooseCodeProject),
            Fault::Refused(Refusal::WorktreeGone) => Self::link(CopyKey::WorktreeGone),
        }
    }
    /// What the Dart transport throws for `error`.
    pub(crate) fn transport(error: &Error) -> Self {
        match (error.kind, failures::read_failure(error)) {
            (FailureKind::Refused, Some(message)) => Self {
                message,
                kind: FailKind::Refused,
                code: (error.code != "desktop_refused").then(|| error.code.clone()),
            },
            (FailureKind::NotSent, Some(message)) => Self {
                message,
                kind: FailKind::NotSent,
                code: None,
            },
            (_, Some(message)) => Self {
                message,
                kind: FailKind::Link,
                code: None,
            },
            (_, None) => Self::other(),
        }
    }
}

/// What a settled intent produced.
#[derive(Debug, Clone)]
pub(crate) struct Settled {
    pub(crate) revision: u64,
    pub(crate) failure: Option<Failure>,
    pub(crate) created: Option<CreatedWorktreeView>,
    pub(crate) attempt: Option<AttemptView>,
}

pub(crate) type Waiter = oneshot::Sender<Settled>;

pub(crate) enum Intent {
    /// A new UI attempt for `project_id` (`DeviceWorktreeCreateAttempt`).
    Begin {
        attempt: u64,
        project_id: String,
        base_branch: Option<String>,
    },
    /// `create(attempt)`.
    Create {
        attempt: u64,
    },
    /// The attempt's owner left: forget it once its creation ends.
    Release {
        attempt: u64,
    },
    /// `archiveWorktree`.
    Archive {
        project_id: String,
        worktree_id: String,
    },
    Close,
}

/// Which `_project` read of a creation returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// Before the create.
    Initial,
    /// After a `git-pending` reply.
    Readiness,
}

/// What a creation waiting for its push got.
enum Waited {
    Event(GitEvent),
    /// The connection dropped (`setConnected(false)`).
    Reconnect,
    Timeout,
}

enum Msg {
    Intent(Intent, Option<Waiter>),
    Push(push::Push),
    SessionOpened,
    Lagged,
    Read {
        attempt: u64,
        flow: u64,
        stage: Stage,
        result: Result<Value>,
    },
    Reply {
        attempt: u64,
        flow: u64,
        result: Result<Value>,
    },
    WaitTimeout {
        attempt: u64,
        flow: u64,
    },
    Archived {
        key: String,
        failure: Option<Failure>,
    },
}

/// The service's handle: its inbox and published view.
#[derive(Clone)]
pub(crate) struct Handle {
    inbox: mpsc::UnboundedSender<Msg>,
    view: View<WorktreesView>,
}

impl Handle {
    pub(crate) fn start(
        inner: &Arc<Inner>,
        runtime: &Runtime,
        computer: String,
        account: watch::Receiver<Arc<AccountView>>,
    ) -> Self {
        let scope = inner.scope();
        let (inbox, rx) = mpsc::unbounded_channel();
        let peer = Peer::main(computer.clone(), scope.clone());
        let mut actor = Actor::new(Arc::downgrade(inner), inbox.clone(), peer);
        let (publish, view) = watch::channel(Arc::new(actor.view()));
        let pushes = inbox.clone();
        actor.pushes = Some(inner.pushes.subscribe(
            Filter {
                computer: Some(computer),
                channels: &PUSHES,
                unreadable: false,
                sessions: true,
            },
            Box::new(move |delivery| {
                pushes
                    .send(match delivery {
                        Delivery::Push(push) => Msg::Push(push),
                        Delivery::Opened => Msg::SessionOpened,
                        Delivery::Lagged { .. } => Msg::Lagged,
                    })
                    .is_ok()
            }),
        ));
        runtime.spawn(actor.run(Inbox::new(rx, scope.clone()), publish, account));
        Self {
            inbox,
            view: View::new(view, scope),
        }
    }
    pub(crate) fn view(&self) -> View<WorktreesView> {
        self.view.clone()
    }
    pub(crate) fn scope(&self) -> &Scope {
        self.view.scope()
    }
    /// Queues `intent`; `waiter` gets its outcome.
    pub(crate) fn send(&self, intent: Intent, waiter: Option<Waiter>) -> Result<()> {
        self.view.scope().check()?;
        self.inbox
            .send(Msg::Intent(intent, waiter))
            .map_err(|_| shutdown_failure())
    }
}

/// One UI attempt (`DeviceWorktreeCreateAttempt`).
struct Attempt {
    project_id: String,
    base_branch: Option<String>,
    worktree_id: Option<String>,
    name: Option<String>,
    mutation_sent: bool,
    ready: bool,
    /// The running `_create`, with the connection generation it started on
    /// (`pending`).
    flow: Option<(u64, u64)>,
    /// A finished creation answers later calls (`pending` stays set).
    created: Option<CreatedWorktreeView>,
    /// How the last creation failed, until its waiters are settled.
    failure: Option<Failure>,
    waiters: Vec<Waiter>,
    /// Its owner left while it was creating: the creation runs on, holding
    /// the project, and the attempt is forgotten when it ends.
    released: bool,
}

impl Attempt {
    fn can_retry(&self) -> bool {
        self.worktree_id.is_some() || !self.mutation_sent
    }
    fn view(&self, id: u64) -> AttemptView {
        AttemptView {
            id,
            project_id: self.project_id.clone(),
            worktree_id: self.worktree_id.clone(),
            name: self.name.clone(),
            mutation_sent: self.mutation_sent,
            ready: self.ready,
            can_retry: self.can_retry(),
        }
    }
}

struct Actor {
    inner: Weak<Inner>,
    inbox: mpsc::UnboundedSender<Msg>,
    /// The computer in the service's account scope: its requests reach
    /// only a session of that scope.
    computer: Peer,
    pushes: Option<push::Subscription>,
    connection: Option<crate::api::ConnectionView>,
    connected: bool,
    disposed: bool,
    generation: u64,
    flows: u64,
    attempts: HashMap<u64, Attempt>,
    /// `_active`: the attempt creating in each project.
    active: HashMap<String, u64>,
    /// `_uncertain`: projects whose last create's outcome is unknown.
    uncertain: HashSet<String>,
    /// `_git`.
    git: GitEvents,
    /// `_waiters`: creations waiting for a push, by key.
    waiting: HashMap<String, Vec<(u64, u64)>>,
    /// `_archiving`: worktree keys being archived, in order.
    archiving: Vec<String>,
    archive_waiters: HashMap<String, Vec<Waiter>>,
    revision: u64,
}

impl Actor {
    fn new(inner: Weak<Inner>, inbox: mpsc::UnboundedSender<Msg>, computer: Peer) -> Self {
        Self {
            inner,
            inbox,
            computer,
            pushes: None,
            connection: None,
            connected: false,
            disposed: false,
            generation: 0,
            flows: 0,
            attempts: HashMap::new(),
            active: HashMap::new(),
            uncertain: HashSet::new(),
            git: GitEvents::default(),
            waiting: HashMap::new(),
            archiving: Vec::new(),
            archive_waiters: HashMap::new(),
            revision: 0,
        }
    }

    fn view(&self) -> WorktreesView {
        let mut attempts: Vec<AttemptView> = self
            .attempts
            .iter()
            .filter(|(_, a)| !a.released)
            .map(|(id, a)| a.view(*id))
            .collect();
        attempts.sort_by_key(|a| a.id);
        WorktreesView {
            revision: self.revision,
            attempts,
            archiving: self.archiving.clone(),
        }
    }

    async fn run(
        mut self,
        mut rx: Inbox<Msg>,
        publish: watch::Sender<Arc<WorktreesView>>,
        mut account: watch::Receiver<Arc<AccountView>>,
    ) {
        let current = account.borrow_and_update().clone();
        self.account_changed(&current);
        self.publish(&publish);
        loop {
            let mut done = Done::default();
            tokio::select! {
                biased;
                msg = rx.recv(|| Msg::Intent(Intent::Close, None)) => match msg {
                    Some(msg) => self.apply(msg, &mut done),
                    None => break,
                },
                changed = account.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    let view = account.borrow_and_update().clone();
                    self.account_changed(&view);
                }
            }
            self.publish(&publish);
            for (waiter, failure, created, attempt) in done.0 {
                let _ = waiter.send(Settled {
                    revision: self.revision,
                    failure,
                    created,
                    attempt: attempt.and_then(|id| self.attempts.get(&id).map(|a| a.view(id))),
                });
            }
            if self.disposed {
                break;
            }
        }
        self.pushes = None;
    }

    /// Publishes the view when it changed (a message that leaves it equal
    /// publishes nothing).
    fn publish(&mut self, publish: &watch::Sender<Arc<WorktreesView>>) {
        let view = self.view();
        if **publish.borrow() == view && self.revision > 0 {
            return;
        }
        self.revision += 1;
        publish.send_replace(Arc::new(WorktreesView {
            revision: self.revision,
            ..view
        }));
    }

    // ---- Connection (`setConnected`) ----

    fn account_changed(&mut self, view: &AccountView) {
        let connection = view
            .connections
            .iter()
            .find(|c| c.computer_id == self.computer.computer)
            .cloned();
        if connection == self.connection {
            return;
        }
        let online = connection
            .as_ref()
            .is_some_and(|c| c.phase == LinkPhase::Connected);
        self.connection = connection;
        self.set_connected(online);
    }

    fn set_connected(&mut self, value: bool) {
        if self.connected == value {
            return;
        }
        self.connected = value;
        self.generation += 1;
        if !value {
            // Every waiter learns the computer went offline.
            let waiting: Vec<(u64, u64)> = self.waiting.drain().flat_map(|(_, w)| w).collect();
            for (attempt, flow) in waiting {
                self.waited(attempt, flow, Waited::Reconnect);
            }
            self.git.clear();
        }
    }

    fn apply(&mut self, msg: Msg, done: &mut Done) {
        match msg {
            Msg::Intent(intent, waiter) => self.intent(intent, waiter, done),
            Msg::Push(push) => self.push(&push.message),
            Msg::SessionOpened => {
                // A reconnect the account's latest-wins view never showed
                // as a drop is still a new session.
                if self.connected {
                    self.set_connected(false);
                    self.set_connected(true);
                }
            }
            Msg::Lagged => {}
            Msg::Read {
                attempt,
                flow,
                stage,
                result,
            } => self.read(attempt, flow, stage, result),
            Msg::Reply {
                attempt,
                flow,
                result,
            } => self.reply(attempt, flow, result),
            Msg::WaitTimeout { attempt, flow } => {
                let removed = self.unwait(attempt, flow);
                if removed {
                    self.waited(attempt, flow, Waited::Timeout);
                }
            }
            Msg::Archived { key, failure } => {
                self.archiving.retain(|k| *k != key);
                for waiter in self.archive_waiters.remove(&key).unwrap_or_default() {
                    done.push(waiter, failure.clone(), None, None);
                }
            }
        }
        self.settle(done);
    }

    fn intent(&mut self, intent: Intent, waiter: Option<Waiter>, done: &mut Done) {
        match intent {
            Intent::Begin {
                attempt,
                project_id,
                base_branch,
            } => {
                self.attempts.insert(
                    attempt,
                    Attempt {
                        project_id,
                        base_branch,
                        worktree_id: None,
                        name: None,
                        mutation_sent: false,
                        ready: false,
                        flow: None,
                        created: None,
                        failure: None,
                        waiters: Vec::new(),
                        released: false,
                    },
                );
                if let Some(waiter) = waiter {
                    done.push(waiter, None, None, Some(attempt));
                }
            }
            Intent::Create { attempt } => self.create(attempt, waiter, done),
            Intent::Release { attempt } => {
                if let Some(a) = self.attempts.get_mut(&attempt) {
                    for waiter in a.waiters.drain(..) {
                        done.push(waiter, Some(Failure::other()), None, None);
                    }
                    // Dart's `release` does nothing: a running creation
                    // keeps `_active` until it ends, and an answer it never
                    // got still marks the project uncertain.
                    if a.flow.is_some() {
                        a.released = true;
                    } else {
                        self.attempts.remove(&attempt);
                    }
                }
                if let Some(waiter) = waiter {
                    done.push(waiter, None, None, None);
                }
            }
            Intent::Archive {
                project_id,
                worktree_id,
            } => self.archive(project_id, worktree_id, waiter, done),
            Intent::Close => {
                self.set_connected(false);
                self.disposed = true;
                if let Some(waiter) = waiter {
                    done.push(waiter, None, None, None);
                }
            }
        }
    }

    fn spawn<F>(&self, work: impl FnOnce(Arc<Inner>, Peer) -> F + Send + 'static)
    where
        F: std::future::Future<Output = Msg> + Send + 'static,
    {
        let (Some(inner), inbox, computer) = (
            self.inner.upgrade(),
            self.inbox.clone(),
            self.computer.clone(),
        ) else {
            return;
        };
        tokio::spawn(async move {
            let msg = work(inner, computer).await;
            let _ = inbox.send(msg);
        });
    }

    // ---- Creation (`create`, `_create`) ----

    fn create(&mut self, id: u64, waiter: Option<Waiter>, done: &mut Done) {
        let (connected, disposed, generation) = (self.connected, self.disposed, self.generation);
        let Some(a) = self.attempts.get_mut(&id).filter(|a| !a.released) else {
            if let Some(waiter) = waiter {
                done.push(waiter, Some(Failure::other()), None, None);
            }
            return;
        };
        // `if (attempt.pending case final pending?) return pending;`
        if let Some(created) = &a.created {
            if let Some(waiter) = waiter {
                done.push(waiter, None, Some(created.clone()), Some(id));
            }
            return;
        }
        if a.flow.is_some() {
            a.waiters.extend(waiter);
            return;
        }
        let refusal = if !connected || disposed {
            Some(CopyKey::ConnectFirst)
        } else if self.uncertain.contains(&a.project_id) {
            Some(CopyKey::CreationNotConfirmed)
        } else if self
            .active
            .get(&a.project_id)
            .is_some_and(|active| *active != id)
        {
            Some(CopyKey::AlreadyCreating)
        } else {
            None
        };
        if let Some(key) = refusal {
            if let Some(waiter) = waiter {
                done.push(waiter, Some(Failure::link(key)), None, Some(id));
            }
            return;
        }
        self.flows += 1;
        let flow = self.flows;
        a.flow = Some((flow, generation));
        a.waiters.extend(waiter);
        let project = a.project_id.clone();
        self.active.insert(project, id);
        self.read_project(id, flow, Stage::Initial);
    }

    fn read_project(&self, attempt: u64, flow: u64, stage: Stage) {
        self.spawn(move |inner, computer| async move {
            let result = call(&inner, &computer, "projects:load", vec![], None).await;
            Msg::Read {
                attempt,
                flow,
                stage,
                result,
            }
        });
    }

    /// The attempt `id` while `flow` is its running creation.
    fn flowing(&mut self, id: u64, flow: u64) -> Option<(&mut Attempt, u64)> {
        let a = self.attempts.get_mut(&id)?;
        let (running, generation) = a.flow?;
        (running == flow).then_some((a, generation))
    }

    /// `_check(generation)`.
    fn current(&self, generation: u64) -> bool {
        !self.disposed && self.connected && generation == self.generation
    }

    fn read(&mut self, id: u64, flow: u64, stage: Stage, result: Result<Value>) {
        let Some((_, generation)) = self.flowing(id, flow) else {
            return;
        };
        let reply = match result {
            Ok(reply) => dto::desktop_value(&reply),
            Err(error) => return self.fail(id, Failure::transport(&error)),
        };
        let project_id = self.attempts[&id].project_id.clone();
        let project = match domain::live_project(&reply, &project_id) {
            Ok(project) => project,
            Err(fault) => return self.fail(id, Failure::fault(fault)),
        };
        if !self.current(generation) {
            return self.fail(id, Failure::link(CopyKey::ConnectionChanged));
        }
        match stage {
            Stage::Initial => {
                if self.attempts[&id].worktree_id.is_some() {
                    return self.after_create(id, flow, generation);
                }
                let request = match domain::create_request(project) {
                    Ok(request) => request,
                    Err(fault) => return self.fail(id, Failure::fault(fault)),
                };
                let a = self.attempts.get_mut(&id).expect("flowing attempt");
                let mut body = Map::new();
                if request.multi {
                    body.insert("workspaceId".into(), json!(project_id));
                } else {
                    body.insert("projectId".into(), json!(project_id));
                }
                if let Some(path) = &request.repo_path {
                    body.insert("repoPath".into(), json!(path));
                }
                body.insert("existingWorktreeIds".into(), json!(request.existing));
                if let Some(base) = &a.base_branch {
                    body.insert("baseBranch".into(), json!(base));
                }
                a.mutation_sent = true;
                let channel = if request.multi {
                    "workspace:create-worktree"
                } else {
                    "worktree:create"
                };
                self.spawn(move |inner, computer| async move {
                    let result =
                        call(&inner, &computer, channel, vec![Value::Object(body)], None).await;
                    Msg::Reply {
                        attempt: id,
                        flow,
                        result,
                    }
                });
            }
            Stage::Readiness => {
                let worktree_id = self.attempts[&id].worktree_id.clone().unwrap_or_default();
                let readiness = match domain::readiness(project, &worktree_id) {
                    Ok(readiness) => readiness,
                    Err(t) => return self.fail(id, Failure::thrown(t)),
                };
                let a = self.attempts.get_mut(&id).expect("flowing attempt");
                if readiness.ready {
                    a.ready = true;
                }
                if readiness.recovery {
                    return self.fail(id, Failure::link(CopyKey::SetupNeedsAttention));
                }
                if a.ready {
                    return self.finish(id);
                }
                let key = format!("{project_id}/{worktree_id}");
                if let Some(event) = self.git.get(&key).cloned() {
                    return self.waited(id, flow, Waited::Event(event));
                }
                self.waiting.entry(key).or_default().push((id, flow));
                let inbox = self.inbox.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(GIT_READY).await;
                    let _ = inbox.send(Msg::WaitTimeout { attempt: id, flow });
                });
            }
        }
    }

    fn reply(&mut self, id: u64, flow: u64, result: Result<Value>) {
        let Some((a, generation)) = self.flowing(id, flow) else {
            return;
        };
        let parsed = match result {
            Ok(reply) => domain::created(&dto::desktop_value(&reply)).map_err(Failure::thrown),
            Err(error) => {
                let failure = Failure::transport(&error);
                if error.kind == FailureKind::NotSent
                    || (error.kind == FailureKind::Refused
                        && error.code == "remote_channel_unavailable")
                {
                    a.mutation_sent = false;
                    return self.fail(id, failure);
                }
                Err(failure)
            }
        };
        match parsed {
            Ok(created) => {
                a.worktree_id = Some(created.id);
                a.name = Some(
                    created
                        .branch_name
                        .unwrap_or_else(|| copy::text(CopyKey::NewTask).into()),
                );
                a.ready = created.ready;
            }
            Err(failure) => {
                // The desktop may have created it: never send again.
                let project = a.project_id.clone();
                self.uncertain.insert(project);
                return self.fail(id, failure);
            }
        }
        self.after_create(id, flow, generation);
    }

    /// `_create` after the request (or with a worktree already created).
    fn after_create(&mut self, id: u64, flow: u64, generation: u64) {
        if !self.current(generation) {
            return self.fail(id, Failure::link(CopyKey::ConnectionChanged));
        }
        if self.attempts[&id].ready {
            return self.finish(id);
        }
        self.read_project(id, flow, Stage::Readiness);
    }

    /// Stops waiting `flow`; whether it was waiting.
    fn unwait(&mut self, id: u64, flow: u64) -> bool {
        let mut removed = false;
        self.waiting.retain(|_, w| {
            let before = w.len();
            w.retain(|entry| *entry != (id, flow));
            removed |= w.len() != before;
            !w.is_empty()
        });
        removed
    }

    fn waited(&mut self, id: u64, flow: u64, waited: Waited) {
        let Some((_, generation)) = self.flowing(id, flow) else {
            return;
        };
        let event = match waited {
            // `waiter.future.timeout`: a `TimeoutException`.
            Waited::Timeout => return self.fail(id, Failure::other()),
            Waited::Reconnect | Waited::Event(_) if !self.current(generation) => {
                return self.fail(id, Failure::link(CopyKey::ConnectionChanged));
            }
            Waited::Reconnect => return self.fail(id, Failure::link(CopyKey::ReconnectToCheck)),
            Waited::Event(event) => event,
        };
        if event.failed {
            return self.fail(id, Failure::link(CopyKey::SetupFailed));
        }
        let name = match event.branch_name() {
            Ok(name) => name,
            Err(t) => return self.fail(id, Failure::thrown(t)),
        };
        let a = self.attempts.get_mut(&id).expect("flowing attempt");
        if let Some(name) = name {
            a.name = Some(name);
        }
        a.ready = true;
        self.finish(id);
    }

    fn finish(&mut self, id: u64) {
        let Some(a) = self.attempts.get_mut(&id) else {
            return;
        };
        let key = format!(
            "{}/{}",
            a.project_id,
            a.worktree_id.as_deref().unwrap_or_default()
        );
        let created = CreatedWorktreeView {
            project_id: a.project_id.clone(),
            id: a.worktree_id.clone().unwrap_or_default(),
            name: a.name.clone().unwrap_or_default(),
        };
        a.flow = None;
        a.created = Some(created);
        let project = a.project_id.clone();
        let released = a.released;
        self.git.remove(&key);
        if self.active.get(&project) == Some(&id) {
            self.active.remove(&project);
        }
        if released {
            self.attempts.remove(&id);
        }
    }

    fn fail(&mut self, id: u64, failure: Failure) {
        let Some(a) = self.attempts.get_mut(&id) else {
            return;
        };
        // `attempt.pending = null`: a later `create` starts again.
        a.flow = None;
        a.failure = Some(failure);
        let project = a.project_id.clone();
        let released = a.released;
        if self.active.get(&project) == Some(&id) {
            self.active.remove(&project);
        }
        if released {
            self.attempts.remove(&id);
        }
    }

    /// Settles the waiters of finished and failed creations into `done`.
    fn settle(&mut self, done: &mut Done) {
        for (id, a) in &mut self.attempts {
            if a.flow.is_some() {
                continue;
            }
            let failure = a.failure.take();
            if let Some(created) = &a.created {
                for waiter in a.waiters.drain(..) {
                    done.push(waiter, None, Some(created.clone()), Some(*id));
                }
            } else if let Some(failure) = failure {
                for waiter in a.waiters.drain(..) {
                    done.push(waiter, Some(failure.clone()), None, Some(*id));
                }
            }
        }
    }

    // ---- Pushes (`_event`) ----

    fn push(&mut self, message: &Value) {
        if !self.connected || self.disposed {
            return;
        }
        let dto = dto::desktop_value(message);
        let payload = dto.get("payload");
        if !payload.is_map() {
            return;
        }
        let Some(channel) = payload.get("channel").as_str() else {
            return;
        };
        let Some(event) = domain::git_event(channel, payload.get("args")) else {
            return;
        };
        let Dv::Str(project) = &event.project else {
            return;
        };
        if !self.active.contains_key(project) {
            return;
        }
        let key = event.key.clone();
        self.git.keep(event.clone());
        let waiting = self.waiting.remove(&key).unwrap_or_default();
        for (id, flow) in waiting {
            self.waited(id, flow, Waited::Event(event.clone()));
        }
    }

    // ---- Archive (`archiveWorktree`, `DeviceWorktreeArchiver.archive`) ----

    fn archive(
        &mut self,
        project_id: String,
        worktree_id: String,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        let key = format!("{project_id}/{worktree_id}");
        // `!_archiving.add(worktree.key)`: one archive per row.
        if self.archiving.contains(&key) {
            if let Some(waiter) = waiter {
                done.push(waiter, None, None, None);
            }
            return;
        }
        self.archiving.push(key.clone());
        self.archive_waiters
            .entry(key.clone())
            .or_default()
            .extend(waiter);
        self.spawn(move |inner, computer| async move {
            let failure = archive(&inner, &computer, &project_id, &worktree_id)
                .await
                .err();
            if failure.is_none() {
                // Lifecycle pushes schedule another re-read if this fails.
                reload_overview(&inner, &computer).await;
            }
            Msg::Archived { key, failure }
        });
    }
}

/// Waiters to settle once the view is published, with what they get.
#[derive(Default)]
struct Done(Vec<Pending>);

/// A waiter, its failure or created worktree, and the attempt to report.
type Pending = (
    Waiter,
    Option<Failure>,
    Option<CreatedWorktreeView>,
    Option<u64>,
);

impl Done {
    fn push(
        &mut self,
        waiter: Waiter,
        failure: Option<Failure>,
        created: Option<CreatedWorktreeView>,
        attempt: Option<u64>,
    ) {
        self.0.push((waiter, failure, created, attempt));
    }
}

/// One main-surface request with an optional own reply limit.
pub(crate) async fn call(
    inner: &Inner,
    computer: &Peer,
    channel: &str,
    args: Vec<Value>,
    limit: Option<Duration>,
) -> Result<Value> {
    let rx = match limit {
        None => inner.request(computer, channel, args)?,
        Some(limit) => {
            let (tx, rx) = oneshot::channel();
            inner.invoke(
                computer,
                channel,
                args,
                limit,
                crate::ports::Responder::new(move |result| {
                    let _ = tx.send(result);
                }),
            )?;
            rx
        }
    };
    rx.await
        .unwrap_or_else(|_| Err(cc_protocol::rpc::ended("session_ended")))
}

/// `DeviceWorktreeArchiver.archive`: the project read, the archive and
/// the snapshot invalidation.
async fn archive(
    inner: &Inner,
    computer: &Peer,
    project_id: &str,
    worktree_id: &str,
) -> std::result::Result<(), Failure> {
    let reply = call(inner, computer, "projects:load", vec![], None)
        .await
        .map_err(|e| Failure::transport(&e))?;
    let request = domain::archive_request(&dto::desktop_value(&reply), project_id, worktree_id)
        .map_err(Failure::fault)?;
    let mut body = Map::new();
    if request.multi {
        body.insert("workspaceId".into(), json!(project_id));
    } else {
        body.insert("projectId".into(), json!(project_id));
    }
    if let Some(path) = &request.repo_path {
        body.insert("repoPath".into(), json!(path));
    }
    body.insert("worktreeId".into(), json!(worktree_id));
    body.insert("remainingWorktreeOrder".into(), json!(request.remaining));
    body.insert(
        "expectedRemainingWorktreeOrder".into(),
        json!(request.remaining),
    );
    if let Some(created_at) = &request.created_at {
        body.insert("expectedCreatedAt".into(), json!(created_at));
    }
    // Matches Remote Control's `portal.worktree.archive`: the retained
    // archive stays until it is managed on the desktop.
    body.insert("lockAfterArchive".into(), json!(true));
    let channel = if request.multi {
        "workspace:archive-worktree"
    } else {
        "worktree:archive"
    };
    let response = call(
        inner,
        computer,
        channel,
        vec![Value::Object(body)],
        Some(ARCHIVE_TIMEOUT),
    )
    .await
    .map_err(|e| Failure::transport(&e))?;
    if domain::archive_refused(&dto::desktop_value(&response)) {
        return Err(Failure::link(CopyKey::ArchiveFailed));
    }
    match call(
        inner,
        computer,
        "desktop:session-snapshot-invalidate",
        vec![],
        None,
    )
    .await
    {
        // Older hosts may refuse it; the overview re-reads projects anyway.
        Ok(_) => Ok(()),
        Err(e) if failures::read_failure(&e).is_some() => Ok(()),
        Err(_) => Err(Failure::other()),
    }
}

/// `overview.reloadWorktrees()` on the computer's current overview, if
/// one of `computer`'s account scope runs.
pub(crate) async fn reload_overview(inner: &Inner, computer: &Peer) {
    let Some(overview) = inner.overview_inbox(computer) else {
        return;
    };
    let (tx, rx) = oneshot::channel();
    if overview
        .send(overview::Msg::Intent(overview::Intent::Reload(tx)))
        .is_ok()
    {
        let _ = rx.await;
    }
}

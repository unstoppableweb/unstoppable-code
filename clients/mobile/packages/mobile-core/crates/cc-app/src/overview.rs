//! One computer's overview (architecture §3.3, P4). Ported from
//! `computer_connect/controller.dart` (the overview part, now
//! `dart_overview.dart`), `device_link/worktrees/repository.dart`,
//! `device_link/chats/{overview_repository,recents,recent_inventory,
//! catalog}.dart` and `computer_connect/recent_chat_inventory.dart`;
//! comments cite the Dart rule they keep.
//!
//! One actor task owns the overview by value. Intents, pushes, the
//! computer's connection changes, timer fires and the results of the reads
//! it spawns arrive on one inbox and apply in order; every applied message
//! publishes one [`OverviewView`]. Each Dart `async` flow is a flow here
//! that advances when its read returns, with Dart's generation checks: a
//! result from an older generation is dropped exactly where Dart drops it.
use crate::{
    account::{Inbox, View},
    api::{
        AccountView, AttentionEntryView, AttentionView, CatalogView, CatalogWorkspaceView,
        ChatRefView, ContextScopeView, CoworkChatView, CoworkScopeView, LinkPhase, MergeQueueView,
        NotificationSpaceView, OverviewView, OwnerView, PrStatusView, ProjectView, RecentAttention,
        RecentChatView, RecentsView, WorktreeChatsView, WorktreeRowView, WorktreeStatus,
        WorktreeView,
    },
    bridge::{Inner, shutdown_failure},
    chats::Peer,
    copy::overview::{self as copy, CopyKey},
    error::{Error, Result},
    failures,
    interest::{Holder, SCOPES},
    push::{self, Delivery, Filter},
};
use cc_domain::overview::{
    self as domain, Catalog, ChatRef, ChatStatus, Collation, Owner, Project, RecentSnapshot,
    ScopeSnapshot, Worktree, WorktreeChats,
};
use cc_protocol::{
    FailureKind,
    desktop::{self, Fallbacks, Unreadable},
};
use futures_util::future::join3;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    runtime::Handle as Runtime,
    sync::{mpsc, oneshot, watch},
};

/// Bulk inventory pushes: a refresh after a 2-second quiet period.
const DEBOUNCED: [&str; 13] = [
    "worktrees:file-changed",
    "workspace:worktrees-updated",
    "chat:state-changed",
    // Snapshot invalidation is Portal-scoped. Lifecycle pushes also arrive
    // without Portal, so observe them directly for execution indicators.
    "desktop:session-snapshot-stale",
    "script:started",
    "script:complete",
    "hook:started",
    "hook:complete",
    "terminal:spawned",
    "terminal:exit",
    "terminal:running-changed",
    "pipelines:execution-event",
    "pipelines:queue-event",
];
const CODE_GRAPH: &str = "code-graph:build-status-changed";
const OWNERSHIP: &str = "org-projects:ownership-changed";
const DEBOUNCE: Duration = Duration::from_secs(2);
/// Below the session's eight-request admission.
const BATCH: usize = 3;

/// Every push channel the overview reads.
const OBSERVED: [&str; 15] = [
    DEBOUNCED[0],
    DEBOUNCED[1],
    DEBOUNCED[2],
    DEBOUNCED[3],
    DEBOUNCED[4],
    DEBOUNCED[5],
    DEBOUNCED[6],
    DEBOUNCED[7],
    DEBOUNCED[8],
    DEBOUNCED[9],
    DEBOUNCED[10],
    DEBOUNCED[11],
    DEBOUNCED[12],
    CODE_GRAPH,
    OWNERSHIP,
];

pub(crate) type Waiter = oneshot::Sender<Arc<OverviewView>>;

pub(crate) enum Intent {
    Watch(Waiter),
    EnterChat(Waiter),
    Refresh(Waiter),
    RefreshSoon(Waiter),
    Reload(Waiter),
    SetLocale(String, Waiter),
    Close(Waiter),
}

/// How an explicit worktree read ended.
pub(crate) enum LoadOutcome {
    Loaded(WorktreeChats),
    Unavailable,
    Stale,
}

#[derive(Clone)]
pub(crate) enum LoadPurpose {
    /// The roster read `flow`'s batch.
    Batch {
        flow: u64,
    },
    /// `_readScopes`.
    Scope,
    Explicit,
}

/// Why a read failed.
pub(crate) enum ReadError {
    Rpc(Error),
    Unreadable(Unreadable),
}
impl From<Error> for ReadError {
    fn from(e: Error) -> Self {
        Self::Rpc(e)
    }
}
impl From<Unreadable> for ReadError {
    fn from(e: Unreadable) -> Self {
        Self::Unreadable(e)
    }
}
/// `_describe`: a transport failure reads as its Dart message; anything
/// else is generic.
fn describe(error: &ReadError) -> String {
    match error {
        ReadError::Rpc(e) => {
            failures::read_failure(e).unwrap_or_else(|| copy::text(CopyKey::ReadFailed).into())
        }
        ReadError::Unreadable(Unreadable::Invalid) => copy::text(CopyKey::InvalidMessage).into(),
        ReadError::Unreadable(Unreadable::Unexpected) => copy::text(CopyKey::ReadFailed).into(),
    }
}

pub(crate) enum Msg {
    Intent(Intent),
    Load {
        project_id: String,
        worktree_id: String,
        saved_status: Option<String>,
        instance: u64,
        reply: oneshot::Sender<LoadOutcome>,
    },
    Push(push::Push),
    SessionOpened,
    /// Pushes were dropped (the fan-out's bound): re-read everything.
    Lagged(Delivery),
    /// A newer overview of this computer took over.
    Replaced,
    Timer(u64),
    Inventory {
        flow: u64,
        projects: Result<Value>,
        snapshot: Option<Value>,
        executions: Option<Value>,
    },
    Loaded {
        generation: u64,
        project_id: String,
        worktree_id: String,
        saved_status: Option<String>,
        instance: u64,
        purpose: LoadPurpose,
        reply: Option<oneshot::Sender<LoadOutcome>>,
        result: Result<Value>,
    },
    CoworkLoaded {
        generation: u64,
        chat: ChatRef,
        flow: Option<u64>,
        result: Result<Value>,
    },
    Catalog {
        flow: u64,
        result: std::result::Result<Catalog, ReadError>,
    },
    Recents {
        generation: u64,
        result: std::result::Result<RecentSnapshot, ()>,
    },
    /// The scopes claim of the connection `connection` answered.
    Claimed {
        connection: u64,
        result: Result<Value>,
        waiter: Option<Waiter>,
    },
}

/// The service's handle: its inbox and published view.
#[derive(Clone)]
pub(crate) struct Handle {
    inbox: mpsc::UnboundedSender<Msg>,
    view: View<OverviewView>,
    inner: Weak<Inner>,
    computer: Peer,
}

impl Handle {
    /// A fresh overview for `computer`, replacing any earlier one.
    pub(crate) fn start(
        inner: &Arc<Inner>,
        runtime: &Runtime,
        computer: String,
        locale: &str,
        account: watch::Receiver<Arc<AccountView>>,
    ) -> Self {
        let scope = inner.scope();
        let (inbox, rx) = mpsc::unbounded_channel();
        let peer = Peer::main(computer.clone(), scope.clone());
        let mut actor = Actor::new(Arc::downgrade(inner), inbox.clone(), peer.clone());
        actor.collation = Collation::new(locale);
        let (publish, view) = watch::channel(Arc::new(actor.view()));
        inner.observe_overview(&peer, inbox.clone());
        let pushes = inbox.clone();
        actor.pushes = Some(inner.pushes.subscribe(
            Filter {
                computer: Some(computer.clone()),
                channels: &OBSERVED,
                unreadable: false,
                sessions: true,
            },
            Box::new(move |delivery| {
                pushes
                    .send(match delivery {
                        Delivery::Push(push) => Msg::Push(push),
                        Delivery::Opened => Msg::SessionOpened,
                        lagged @ Delivery::Lagged { .. } => Msg::Lagged(lagged),
                    })
                    .is_ok()
            }),
        ));
        runtime.spawn(actor.run(Inbox::new(rx, scope.clone()), publish, account));
        Self {
            inbox,
            view: View::new(view, scope),
            inner: Arc::downgrade(inner),
            computer: peer,
        }
    }
    pub(crate) fn view(&self) -> View<OverviewView> {
        self.view.clone()
    }
    /// Queues `intent` while the scope lasts; the view it settled with,
    /// unless the scope ended first (`account_changed`).
    pub(crate) async fn request(
        &self,
        intent: impl FnOnce(Waiter) -> Intent,
    ) -> Result<Arc<OverviewView>> {
        let (tx, rx) = oneshot::channel();
        let sent = async {
            self.inbox
                .send(Msg::Intent(intent(tx)))
                .map_err(|_| shutdown_failure())?;
            rx.await.map_err(|_| shutdown_failure())
        };
        self.view.scope().within(sent).await
    }
    pub(crate) async fn load(
        &self,
        project_id: String,
        worktree_id: String,
        saved_status: Option<String>,
        instance: u64,
    ) -> Result<LoadOutcome> {
        let (reply, rx) = oneshot::channel();
        let sent = async {
            self.inbox
                .send(Msg::Load {
                    project_id,
                    worktree_id,
                    saved_status,
                    instance,
                    reply,
                })
                .map_err(|_| shutdown_failure())?;
            rx.await.map_err(|_| shutdown_failure())
        };
        self.view.scope().within(sent).await
    }
    /// One catalog read (`readDeviceChatCatalog`), for the chats feature.
    /// Both of its requests reach only a session of the overview's scope,
    /// and a read the scope ended under fails `account_changed`.
    pub(crate) async fn read_catalog(&self) -> Result<CatalogView> {
        let inner = self.inner.upgrade().ok_or_else(shutdown_failure)?;
        let read = async {
            match read_catalog(&inner, &self.computer).await {
                Ok(catalog) => Ok(catalog_view(&catalog)),
                Err(ReadError::Rpc(e)) => Err(e),
                Err(ReadError::Unreadable(Unreadable::Invalid)) => Err(Error::local(
                    "invalid_message",
                    copy::text(CopyKey::InvalidMessage),
                )),
                Err(ReadError::Unreadable(Unreadable::Unexpected)) => {
                    Err(Error::local("unreadable", copy::text(CopyKey::ReadFailed)))
                }
            }
        };
        self.computer.scope.within(read).await
    }
}

async fn call(inner: &Inner, computer: &Peer, channel: &str, args: Vec<Value>) -> Result<Value> {
    let rx = inner.request(computer, channel, args)?;
    rx.await
        .unwrap_or_else(|_| Err(cc_protocol::rpc::ended("session_ended")))
}

/// `readDeviceChatCatalog`: the catalog, then the chat workspaces.
async fn read_catalog(inner: &Inner, computer: &Peer) -> std::result::Result<Catalog, ReadError> {
    let entries = call(inner, computer, "chat-search:catalog", vec![]).await?;
    let projects = call(inner, computer, "chat-project:list", vec![]).await?;
    Ok(desktop::catalog(&entries, &projects, &copy::fallbacks())?)
}

/// `readRecentInventory`: the complete snapshot, or after a refusal the
/// overview and each code worktree's own summaries.
async fn read_recents(
    inner: &Inner,
    computer: &Peer,
    current: impl Fn() -> bool,
) -> std::result::Result<RecentSnapshot, ()> {
    let fallbacks = copy::fallbacks();
    let full = call(
        inner,
        computer,
        "desktop:session-snapshot",
        vec![json!({"includeChatSummaries": true})],
    )
    .await;
    match full {
        Ok(reply) => return desktop::recent_snapshot(&reply, &fallbacks).map_err(|_| ()),
        Err(e) if e.kind == FailureKind::Refused => {
            if !current() {
                return Err(());
            }
        }
        Err(_) => return Err(()),
    }
    let reply = call(inner, computer, "desktop:session-snapshot", vec![])
        .await
        .map_err(|_| ())?;
    let mut overview = desktop::recent_snapshot(&reply, &fallbacks).map_err(|_| ())?;
    let projects: HashSet<&str> = overview
        .workspaces
        .iter()
        .filter(|w| !w.hidden && matches!(w.kind.as_deref(), Some("single-repo" | "multi-repo")))
        .map(|w| w.local_id.as_str())
        .collect();
    let worktrees: Vec<(String, String)> = overview
        .worktrees
        .iter()
        .filter(|w| w.hidden != Some(true) && projects.contains(w.workspace_local_id.as_str()))
        .map(|w| (w.workspace_local_id.clone(), w.local_id.clone()))
        .collect();
    let mut summaries = Vec::new();
    for batch in worktrees.chunks(BATCH) {
        if !current() {
            break;
        }
        let reads = batch.iter().map(|(workspace, worktree)| {
            let fallbacks = &fallbacks;
            async move {
                let reply = call(
                    inner,
                    computer,
                    "desktop:session-snapshot",
                    vec![json!({
                        "includeChatSummaries": true,
                        "workspaceLocalId": workspace,
                        "worktreeLocalId": worktree,
                    })],
                )
                .await;
                match reply {
                    Ok(reply) => {
                        desktop::worktree_summaries(&reply, workspace, worktree, fallbacks)
                            .map_err(|_| ())
                    }
                    // Leave the failed scope unavailable; never let it
                    // discard independently readable scopes.
                    Err(e) if e.kind == FailureKind::Refused => Ok(Vec::new()),
                    Err(_) => Err(()),
                }
            }
        });
        for rows in futures_util::future::join_all(reads).await {
            summaries.extend(rows?);
        }
    }
    overview.chat_summaries = summaries;
    Ok(overview)
}

/// One roster read (`DeviceWorktreesRepository.refresh`) in flight.
enum WorktreesFor {
    Full(u64),
    Reload(Vec<Waiter>),
}
struct WorktreesFlow {
    purpose: WorktreesFor,
    /// The rows the batches read, from this flow's roster.
    batch: Vec<(String, String, Option<String>, u64)>,
    offset: usize,
    outstanding: usize,
}

/// One Cowork refresh (`DeviceChatOverviewRepository.refresh`).
struct CoworkFlow {
    full: u64,
    targets: Vec<ChatRef>,
    offset: usize,
    outstanding: usize,
}

/// One `refresh` (the controller's) in flight.
struct Full {
    worktrees: Option<()>,
    catalog: Option<()>,
    /// The first failure, in completion order (`Future.wait`).
    error: Option<String>,
    waiters: Vec<Waiter>,
}

struct Actor {
    inner: Weak<Inner>,
    inbox: mpsc::UnboundedSender<Msg>,
    /// The computer in the overview's account scope: its reads reach only
    /// a session of that scope.
    computer: Peer,
    fallbacks: Fallbacks,
    collation: Collation,
    revision: u64,
    disposed: bool,
    /// This overview's pushes and new sessions; ends with the actor.
    pushes: Option<push::Subscription>,
    // Connection (`chats.online`, `connection.reconnecting`).
    online: bool,
    reconnecting: bool,
    connection: Option<crate::api::ConnectionView>,
    /// Bumped whenever `online` changes: a claim of an earlier connection
    /// answers for a session that has ended.
    connections: u64,
    // The controller.
    watching: bool,
    refresh_generation: u64,
    loading: bool,
    scope_pending: bool,
    error: Option<String>,
    refresh_again: bool,
    refreshes: u64,
    timer: u64,
    pending_scopes: Vec<String>,
    reading_scope: bool,
    /// The refresh generation a running scope read started in.
    scope_generation: u64,
    fulls: HashMap<u64, Full>,
    // The worktrees repository.
    worktrees_generation: u64,
    instances: u64,
    has_inventory: bool,
    projects: Vec<Project>,
    worktrees: Vec<Worktree>,
    code_project_ids: Vec<String>,
    /// The latest roster's chat state by key; kept across invalidation.
    cached: HashMap<String, WorktreeChats>,
    code_graph: Vec<String>,
    worktree_flows: HashMap<u64, WorktreesFlow>,
    // The Cowork repository.
    cowork_generation: u64,
    targets: Vec<(String, ChatRef)>,
    cowork: HashMap<String, (i64, ScopeSnapshot)>,
    cowork_flows: HashMap<u64, CoworkFlow>,
    // The catalog (the chats repository's `catalog`).
    catalog: Catalog,
    catalog_revision: u64,
    // Recents.
    recents: Option<RecentSnapshot>,
    recents_generation: Arc<AtomicU64>,
    recents_refreshing: bool,
    recents_again: bool,
}

impl Actor {
    fn new(inner: Weak<Inner>, inbox: mpsc::UnboundedSender<Msg>, computer: Peer) -> Self {
        Self {
            inner,
            inbox,
            computer,
            fallbacks: copy::fallbacks(),
            collation: Collation::new("und"),
            revision: 0,
            disposed: false,
            pushes: None,
            online: false,
            reconnecting: false,
            connection: None,
            connections: 0,
            watching: true,
            refresh_generation: 0,
            loading: false,
            scope_pending: false,
            error: None,
            refresh_again: false,
            refreshes: 0,
            timer: 0,
            pending_scopes: Vec::new(),
            reading_scope: false,
            scope_generation: 0,
            fulls: HashMap::new(),
            worktrees_generation: 0,
            instances: 0,
            has_inventory: false,
            projects: Vec::new(),
            worktrees: Vec::new(),
            code_project_ids: Vec::new(),
            cached: HashMap::new(),
            code_graph: Vec::new(),
            worktree_flows: HashMap::new(),
            cowork_generation: 0,
            targets: Vec::new(),
            cowork: HashMap::new(),
            cowork_flows: HashMap::new(),
            catalog: Catalog::default(),
            catalog_revision: 0,
            recents: None,
            recents_generation: Arc::new(AtomicU64::new(0)),
            recents_refreshing: false,
            recents_again: false,
        }
    }

    async fn run(
        mut self,
        mut rx: Inbox<Msg>,
        publish: watch::Sender<Arc<OverviewView>>,
        mut account: watch::Receiver<Arc<AccountView>>,
    ) {
        // The computer's connection as the account last published it.
        let current = account.borrow_and_update().clone();
        self.account_changed(&current);
        self.publish(&publish);
        loop {
            let waiters = tokio::select! {
                biased;
                msg = rx.recv(|| Msg::Intent(Intent::Close(oneshot::channel().0))) => match msg {
                    Some(msg) => self.apply(msg),
                    None => break,
                },
                changed = account.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    let view = account.borrow_and_update().clone();
                    self.account_changed(&view);
                    Vec::new()
                }
            };
            let view = self.publish(&publish);
            for waiter in waiters {
                let _ = waiter.send(view.clone());
            }
            if self.disposed {
                break;
            }
        }
    }

    fn publish(&mut self, publish: &watch::Sender<Arc<OverviewView>>) -> Arc<OverviewView> {
        self.revision += 1;
        let view = Arc::new(self.view());
        publish.send_replace(view.clone());
        view
    }

    fn inner(&self) -> Option<Arc<Inner>> {
        self.inner.upgrade()
    }

    /// Runs `read` on the runtime and posts its message.
    fn spawn<F>(&self, read: impl FnOnce(Arc<Inner>, Peer) -> F + Send + 'static)
    where
        F: std::future::Future<Output = Msg> + Send + 'static,
    {
        let (Some(inner), inbox, computer) =
            (self.inner(), self.inbox.clone(), self.computer.clone())
        else {
            return;
        };
        tokio::spawn(async move {
            let msg = read(inner, computer).await;
            let _ = inbox.send(msg);
        });
    }

    /// Applies `msg`; returns the waiters to resolve with the next view.
    fn apply(&mut self, msg: Msg) -> Vec<Waiter> {
        let mut done = Vec::new();
        match msg {
            Msg::Intent(intent) => self.intent(intent, &mut done),
            Msg::Load {
                project_id,
                worktree_id,
                saved_status,
                instance,
                reply,
            } => self.load(
                project_id,
                worktree_id,
                saved_status,
                instance,
                LoadPurpose::Explicit,
                Some(reply),
            ),
            Msg::Push(push) => self.push(&push.message, &mut done),
            Msg::Lagged(_lagged) => {
                if !self.disposed && self.online {
                    self.ownership_changed(&mut done);
                }
            }
            Msg::Replaced => {
                // Stops without releasing: the claim is the newer overview's.
                self.disposed = true;
                self.refresh_generation += 1;
                self.timer += 1;
            }
            Msg::SessionOpened => {
                // A reconnect the account's latest-wins view never showed
                // as a drop: the overview still sees a new session.
                if self.online {
                    self.connection_changed(false, true, &mut done);
                    self.connection_changed(true, false, &mut done);
                }
            }
            Msg::Timer(token) => {
                if token == self.timer && !self.disposed {
                    self.refresh(None, &mut done);
                }
            }
            Msg::Inventory {
                flow,
                projects,
                snapshot,
                executions,
            } => self.inventory(flow, projects, snapshot, executions, &mut done),
            Msg::Loaded {
                generation,
                project_id,
                worktree_id,
                saved_status,
                instance,
                purpose,
                reply,
                result,
            } => {
                let outcome = self.loaded(
                    generation,
                    &project_id,
                    &worktree_id,
                    saved_status.as_deref(),
                    instance,
                    result,
                );
                match purpose {
                    LoadPurpose::Batch { flow } => self.batch_loaded(flow, &mut done),
                    LoadPurpose::Scope => self.scope_read(
                        &format!("{project_id}/{worktree_id}"),
                        Some(instance),
                        &mut done,
                    ),
                    LoadPurpose::Explicit => {}
                }
                if let Some(reply) = reply {
                    let _ = reply.send(outcome);
                }
            }
            Msg::CoworkLoaded {
                generation,
                chat,
                flow,
                result,
            } => {
                self.cowork_loaded(generation, &chat, result);
                match flow {
                    Some(flow) => self.cowork_batch_loaded(flow, &mut done),
                    None => self.scope_read(&chat.scope_key(), None, &mut done),
                }
            }
            Msg::Catalog { flow, result } => {
                let result = match result {
                    Ok(catalog) => {
                        // `refreshCatalog`: kept only while connected, and
                        // only from the current refresh: a superseded one
                        // can finish after newer data.
                        if self.online && flow == self.refresh_generation {
                            self.catalog = catalog;
                            self.catalog_revision += 1;
                        }
                        Ok(())
                    }
                    Err(error) => Err(describe(&error)),
                };
                if let Some(full) = self.fulls.get_mut(&flow) {
                    full.catalog = Some(());
                    if let Err(error) = result {
                        full.error.get_or_insert(error);
                    }
                }
                self.full_joined(flow, &mut done);
            }
            Msg::Recents { generation, result } => self.recents_read(generation, result),
            Msg::Claimed {
                connection,
                result,
                waiter,
            } => {
                // The newer connection claims and refreshes on its own.
                let current = !self.disposed && self.watching && connection == self.connections;
                match result {
                    Ok(_) => {
                        if current {
                            self.refresh(waiter, &mut done);
                            return done;
                        }
                    }
                    Err(error) => {
                        // The desktop's state is unknown either way: the
                        // next claim is sent.
                        if let Some(inner) = self.inner() {
                            inner.interest_unsent(&self.computer, SCOPES);
                        }
                        if current {
                            self.error = Some(describe(&ReadError::Rpc(error)));
                        }
                    }
                }
                done.extend(waiter);
            }
        }
        done
    }

    fn intent(&mut self, intent: Intent, done: &mut Vec<Waiter>) {
        match intent {
            Intent::Watch(waiter) => self.watch(Some(waiter), done),
            Intent::EnterChat(waiter) => {
                // `enterChat`: overview reads stop; nothing is written.
                self.watching = false;
                self.pending_scopes.clear();
                self.timer += 1;
                if let Some(inner) = self.inner() {
                    inner.release_interest(&self.computer, Holder::Overview);
                }
                done.push(waiter);
            }
            Intent::Refresh(waiter) => self.refresh(Some(waiter), done),
            Intent::RefreshSoon(waiter) => {
                // A read already in flight may predate the change.
                if self.loading {
                    self.refresh_again = true;
                    done.push(waiter);
                } else {
                    self.refresh(Some(waiter), done);
                }
            }
            Intent::Reload(waiter) => self.reload_worktrees(WorktreesFor::Reload(vec![waiter])),
            Intent::SetLocale(tag, waiter) => {
                if tag != self.collation.tag() {
                    self.collation = Collation::new(&tag);
                }
                done.push(waiter);
            }
            Intent::Close(waiter) => {
                self.disposed = true;
                self.refresh_generation += 1;
                self.timer += 1;
                self.invalidate_all();
                if let Some(inner) = self.inner() {
                    inner.release_interest(&self.computer, Holder::Overview);
                    inner.forget_overview(&self.computer.computer, &self.inbox);
                }
                done.push(waiter);
            }
        }
    }

    // ---- Connection (`_connectionChanged`) ----

    fn account_changed(&mut self, view: &AccountView) {
        let connection = view
            .connections
            .iter()
            .find(|c| c.computer_id == self.computer.computer)
            .cloned();
        if connection == self.connection {
            return;
        }
        self.connection = connection;
        let phase = self.connection.as_ref().map(|c| c.phase);
        let mut done = Vec::new();
        self.connection_changed(
            phase == Some(LinkPhase::Connected),
            phase == Some(LinkPhase::Reconnecting),
            &mut done,
        );
        // Waiters only come from intents; a connection change has none.
        drop(done);
    }

    fn connection_changed(&mut self, online: bool, reconnecting: bool, done: &mut Vec<Waiter>) {
        if self.disposed {
            return;
        }
        self.reconnecting = reconnecting;
        // An explicit disconnect can follow suspension without changing
        // `online`.
        if !online && !reconnecting {
            self.invalidate_all();
        }
        if self.online == online {
            return;
        }
        self.online = online;
        self.connections += 1;
        self.refresh_generation += 1;
        if online {
            // Reads sent while offline may have been answered by the
            // session that was ending.
            self.worktrees_generation += 1;
            self.cowork_generation += 1;
        }
        self.loading = false;
        self.scope_pending = true;
        if online && self.watching {
            self.watch(None, done);
        } else {
            if online || reconnecting {
                self.pause_all();
            } else {
                self.invalidate_all();
            }
            self.pending_scopes.clear();
            self.loading = false;
            self.timer += 1;
        }
    }

    /// `worktrees.pause()`, `overviewChats.pause()`, `recents.pause()`.
    fn pause_all(&mut self) {
        self.worktrees_generation += 1;
        self.code_graph.clear();
        self.cowork_generation += 1;
        self.pause_recents();
    }

    /// `invalidate()` on all three.
    fn invalidate_all(&mut self) {
        self.code_graph.clear();
        self.invalidate_inventory();
        self.invalidate_cowork();
        self.pause_recents();
        self.recents = None;
    }

    fn invalidate_inventory(&mut self) {
        self.worktrees_generation += 1;
        self.has_inventory = false;
        self.projects.clear();
        self.worktrees.clear();
        self.code_project_ids.clear();
    }

    fn invalidate_cowork(&mut self) {
        self.cowork_generation += 1;
        self.targets.clear();
        self.cowork.clear();
    }

    // ---- Interest (`watchOverview`) ----

    fn watch(&mut self, waiter: Option<Waiter>, done: &mut Vec<Waiter>) {
        self.watching = true;
        if !self.online {
            done.extend(waiter);
            return;
        }
        let Some(inner) = self.inner() else {
            done.extend(waiter);
            return;
        };
        match inner.claim_interest(
            &self.computer,
            Holder::Overview,
            SCOPES,
            vec![json!({"kind": "all"})],
        ) {
            Ok(None) => self.refresh(waiter, done),
            Ok(Some(reply)) => {
                let (inbox, connection) = (self.inbox.clone(), self.connections);
                tokio::spawn(async move {
                    let result = reply
                        .await
                        .unwrap_or_else(|_| Err(cc_protocol::rpc::ended("session_ended")));
                    let _ = inbox.send(Msg::Claimed {
                        connection,
                        result,
                        waiter,
                    });
                });
            }
            Err(error) => {
                self.error = Some(describe(&ReadError::Rpc(error)));
                done.extend(waiter);
            }
        }
    }

    // ---- Pushes (`_event`) ----

    /// Ownership changed (or pushes were lost): retire old evidence and
    /// re-read at once; a failed re-read must not keep filtering Recents by
    /// the old owner.
    fn ownership_changed(&mut self, done: &mut Vec<Waiter>) {
        self.refresh_generation += 1;
        self.loading = false;
        self.scope_pending = true;
        self.invalidate_inventory();
        self.invalidate_cowork();
        self.pause_recents();
        self.recents = None;
        self.pending_scopes.clear();
        self.timer += 1;
        if self.watching {
            self.refresh(None, done);
        }
    }

    fn push(&mut self, message: &Value, done: &mut Vec<Waiter>) {
        if self.disposed || !self.online {
            return;
        }
        let Some(push) = desktop::push(message) else {
            return;
        };
        // Desktop sends each build transition once, so track them while a
        // chat is open too; going offline clears the set.
        if push.channel == CODE_GRAPH
            && let Some((key, building)) = desktop::code_graph_status(&push)
        {
            if building {
                if !self.code_graph.contains(&key) {
                    self.code_graph.push(key);
                }
            } else {
                self.code_graph.retain(|k| k != &key);
            }
        }
        if push.channel == OWNERSHIP {
            return self.ownership_changed(done);
        }
        if !self.watching {
            return;
        }
        if push.channel == "chat:state-changed"
            && let Some(key) = desktop::chat_state_scope(&push)
        {
            if !self.pending_scopes.contains(&key) {
                self.pending_scopes.push(key);
            }
            self.read_scopes(done);
        }
        if DEBOUNCED.contains(&push.channel.as_str()) {
            // Bulk inventory waits for a quiet period; tab and read changes
            // refresh their own scope at once.
            self.timer += 1;
            let (token, inbox) = (self.timer, self.inbox.clone());
            tokio::spawn(async move {
                tokio::time::sleep(DEBOUNCE).await;
                let _ = inbox.send(Msg::Timer(token));
            });
        }
    }

    // ---- Scope reads (`_readScopes`) ----

    fn read_scopes(&mut self, done: &mut Vec<Waiter>) {
        if self.reading_scope {
            return;
        }
        self.next_scope(done);
    }

    /// The loop body: starts the next pending scope's read, or ends.
    fn next_scope(&mut self, done: &mut Vec<Waiter>) {
        let _ = done;
        while !self.disposed && self.watching && self.online && !self.pending_scopes.is_empty() {
            let key = self.pending_scopes.remove(0);
            let worktree = self.worktrees.iter().find(|w| w.key() == key).map(|w| {
                (
                    w.project_id.clone(),
                    w.id.clone(),
                    w.saved_status.clone(),
                    w.instance,
                )
            });
            let chat = self
                .targets
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, c)| c.clone());
            if worktree.is_none() && chat.is_none() {
                continue;
            }
            self.reading_scope = true;
            self.scope_generation = self.refresh_generation;
            if let Some((project_id, worktree_id, saved_status, instance)) = worktree {
                self.load(
                    project_id,
                    worktree_id,
                    saved_status,
                    instance,
                    LoadPurpose::Scope,
                    None,
                );
            } else if let Some(chat) = chat {
                self.cowork_load(chat, None);
            }
            return;
        }
        self.reading_scope = false;
    }

    /// A scope read finished: replay it when a refresh replaced its row.
    fn scope_read(&mut self, key: &str, instance: Option<u64>, done: &mut Vec<Waiter>) {
        let replaced = instance.is_some_and(|instance| {
            !self
                .worktrees
                .iter()
                .any(|w| w.key() == key && w.instance == instance)
        });
        if self.loading || self.scope_generation != self.refresh_generation || replaced {
            if !self.pending_scopes.iter().any(|k| k == key) {
                self.pending_scopes.push(key.to_owned());
            }
            if self.loading {
                self.reading_scope = false;
                return;
            }
        }
        self.next_scope(done);
    }

    // ---- Refresh (`refresh`) ----

    fn refresh(&mut self, waiter: Option<Waiter>, done: &mut Vec<Waiter>) {
        if !self.online || self.loading || self.disposed {
            done.extend(waiter);
            return;
        }
        self.refresh_generation += 1;
        let flow = self.refresh_generation;
        self.loading = true;
        self.error = None;
        self.refreshes += 1;
        self.refresh_recents();
        self.fulls.insert(
            flow,
            Full {
                worktrees: None,
                catalog: None,
                error: None,
                waiters: waiter.into_iter().collect(),
            },
        );
        self.reload_worktrees(WorktreesFor::Full(flow));
        self.spawn(move |inner, computer| async move {
            Msg::Catalog {
                flow,
                result: read_catalog(&inner, &computer).await,
            }
        });
    }

    /// Both reads of `flow` finished: Cowork states, then the end.
    fn full_joined(&mut self, flow: u64, done: &mut Vec<Waiter>) {
        let Some(full) = self.fulls.get_mut(&flow) else {
            return;
        };
        if full.worktrees.is_none() || full.catalog.is_none() {
            return;
        }
        if let Some(error) = full.error.clone() {
            if flow == self.refresh_generation {
                self.error = Some(error);
            }
            self.finish(flow, done);
            return;
        }
        if flow != self.refresh_generation {
            self.finish(flow, done);
            return;
        }
        let cowork: HashSet<&str> = self
            .projects
            .iter()
            .filter(|p| p.is_cowork())
            .map(|p| p.id.as_str())
            .collect();
        let targets: Vec<ChatRef> = self
            .catalog
            .chats
            .iter()
            .filter(|c| cowork.contains(c.project_id.as_str()))
            .cloned()
            .collect();
        self.cowork_refresh(targets, flow, done);
    }

    fn cowork_done(&mut self, flow: u64, done: &mut Vec<Waiter>) {
        if flow == self.refresh_generation {
            self.scope_pending = false;
        }
        self.finish(flow, done);
    }

    /// The `finally` of `refresh`.
    fn finish(&mut self, flow: u64, done: &mut Vec<Waiter>) {
        if let Some(full) = self.fulls.remove(&flow) {
            // A superseded refresh's waiters wait for the current one, whose
            // reads are newer; with none running they settle now.
            match self.fulls.get_mut(&self.refresh_generation) {
                Some(current) if flow != self.refresh_generation => {
                    current.waiters.extend(full.waiters);
                }
                _ => done.extend(full.waiters),
            }
        }
        if flow == self.refresh_generation {
            self.loading = false;
            if self.refresh_again {
                self.refresh_again = false;
                self.refresh(None, done);
            } else {
                self.read_scopes(done);
            }
        }
    }

    // ---- Roster (`DeviceWorktreesRepository`) ----

    fn reload_worktrees(&mut self, purpose: WorktreesFor) {
        self.worktrees_generation += 1;
        let flow = self.worktrees_generation;
        self.worktree_flows.insert(
            flow,
            WorktreesFlow {
                purpose,
                batch: Vec::new(),
                offset: 0,
                outstanding: 0,
            },
        );
        self.spawn(move |inner, computer| async move {
            // Optional reads: older hosts may refuse or lack them.
            let optional = |channel: &'static str| {
                let inner = inner.clone();
                let computer = computer.clone();
                async move { call(&inner, &computer, channel, vec![]).await.ok() }
            };
            let (projects, snapshot, executions) = join3(
                call(&inner, &computer, "projects:load", vec![]),
                optional("desktop:session-snapshot"),
                optional("pipelines:list-executions"),
            )
            .await;
            Msg::Inventory {
                flow,
                projects,
                snapshot,
                executions,
            }
        });
    }

    fn worktrees_ended(
        &mut self,
        flow: u64,
        result: std::result::Result<(), String>,
        done: &mut Vec<Waiter>,
    ) {
        let Some(ended) = self.worktree_flows.remove(&flow) else {
            return;
        };
        match ended.purpose {
            WorktreesFor::Full(full) => {
                if let Some(state) = self.fulls.get_mut(&full) {
                    state.worktrees = Some(());
                    if let Err(error) = result {
                        state.error.get_or_insert(error);
                    }
                }
                self.full_joined(full, done);
            }
            WorktreesFor::Reload(waiters) => done.extend(waiters),
        }
    }

    fn inventory(
        &mut self,
        flow: u64,
        projects: Result<Value>,
        snapshot: Option<Value>,
        executions: Option<Value>,
        done: &mut Vec<Waiter>,
    ) {
        let projects = match projects {
            Ok(projects) => projects,
            Err(error) => {
                self.worktrees_ended(flow, Err(describe(&ReadError::Rpc(error))), done);
                return;
            }
        };
        if flow != self.worktrees_generation {
            self.worktrees_ended(flow, Ok(()), done);
            return;
        }
        self.instances += 1;
        let read = desktop::inventory(
            &projects,
            snapshot.as_ref(),
            executions.as_ref(),
            &self.cached,
            self.instances,
            &self.fallbacks,
        );
        let mut inventory = match read {
            Ok(inventory) => inventory,
            Err(error) => {
                self.worktrees_ended(flow, Err(describe(&ReadError::Unreadable(error))), done);
                return;
            }
        };
        domain::sort_projects(&mut inventory.projects);
        domain::sort_worktrees(&mut inventory.worktrees, &self.collation);
        // Fresh inventory and owner evidence are enough to show the
        // roster; chat details can take many round trips.
        self.projects = inventory.projects;
        self.worktrees = inventory.worktrees;
        self.code_project_ids = inventory.code_project_ids;
        self.has_inventory = true;
        self.cached = self
            .worktrees
            .iter()
            .map(|w| (w.key(), w.chats.clone()))
            .collect();
        self.scope_pending = false;
        let batch = self
            .worktrees
            .iter()
            .map(|w| {
                (
                    w.project_id.clone(),
                    w.id.clone(),
                    w.saved_status.clone(),
                    w.instance,
                )
            })
            .collect();
        if let Some(state) = self.worktree_flows.get_mut(&flow) {
            state.batch = batch;
        }
        self.next_batch(flow, done);
    }

    fn next_batch(&mut self, flow: u64, done: &mut Vec<Waiter>) {
        let Some(state) = self.worktree_flows.get(&flow) else {
            return;
        };
        if state.offset >= state.batch.len() || flow != self.worktrees_generation {
            self.worktrees_ended(flow, Ok(()), done);
            return;
        }
        let rows: Vec<_> = state
            .batch
            .iter()
            .skip(state.offset)
            .take(BATCH)
            .cloned()
            .collect();
        if let Some(state) = self.worktree_flows.get_mut(&flow) {
            state.outstanding = rows.len();
        }
        for (project_id, worktree_id, saved_status, instance) in rows {
            self.load(
                project_id,
                worktree_id,
                saved_status,
                instance,
                LoadPurpose::Batch { flow },
                None,
            );
        }
    }

    fn batch_loaded(&mut self, flow: u64, done: &mut Vec<Waiter>) {
        let Some(state) = self.worktree_flows.get_mut(&flow) else {
            return;
        };
        state.outstanding -= 1;
        if state.outstanding > 0 {
            return;
        }
        state.offset += BATCH;
        if flow != self.worktrees_generation {
            self.worktrees_ended(flow, Ok(()), done);
            return;
        }
        // `onChanged`: the controller marks ownership as read.
        self.scope_pending = false;
        self.next_batch(flow, done);
    }

    /// `load`: one worktree's `chat:get-state`.
    fn load(
        &mut self,
        project_id: String,
        worktree_id: String,
        saved_status: Option<String>,
        instance: u64,
        purpose: LoadPurpose,
        reply: Option<oneshot::Sender<LoadOutcome>>,
    ) {
        let generation = self.worktrees_generation;
        self.spawn(move |inner, computer| async move {
            let scope = json!({"projectId": project_id, "worktreeId": worktree_id});
            let result = call(&inner, &computer, "chat:get-state", vec![scope]).await;
            Msg::Loaded {
                generation,
                project_id,
                worktree_id,
                saved_status,
                instance,
                purpose,
                reply,
                result,
            }
        });
    }

    fn loaded(
        &mut self,
        generation: u64,
        project_id: &str,
        worktree_id: &str,
        saved_status: Option<&str>,
        instance: u64,
        result: Result<Value>,
    ) -> LoadOutcome {
        if generation != self.worktrees_generation {
            return LoadOutcome::Stale;
        }
        let chats = result
            .ok()
            .and_then(|reply| desktop::worktree_scope(&reply, &self.fallbacks).ok())
            .and_then(|snapshot| {
                domain::worktree_chats(project_id, worktree_id, saved_status, &snapshot)
            });
        let key = format!("{project_id}/{worktree_id}");
        if let Some(row) = self
            .worktrees
            .iter_mut()
            .find(|w| w.instance == instance && w.key() == key)
        {
            match &chats {
                Some(chats) => row.chats = chats.clone(),
                None => row.chats.status = ChatStatus::Unavailable,
            }
            self.cached.insert(key, row.chats.clone());
        }
        match chats {
            Some(chats) => LoadOutcome::Loaded(chats),
            None => LoadOutcome::Unavailable,
        }
    }

    // ---- Cowork states (`DeviceChatOverviewRepository`) ----

    fn cowork_refresh(&mut self, chats: Vec<ChatRef>, full: u64, done: &mut Vec<Waiter>) {
        self.cowork_generation += 1;
        let flow = self.cowork_generation;
        self.targets.clear();
        for chat in chats {
            let key = chat.scope_key();
            match self.targets.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = chat,
                None => self.targets.push((key, chat)),
            }
        }
        let keys: HashSet<String> = self.targets.iter().map(|(k, _)| k.clone()).collect();
        self.cowork.retain(|key, _| keys.contains(key));
        let targets = self.targets.iter().map(|(_, c)| c.clone()).collect();
        self.cowork_flows.insert(
            flow,
            CoworkFlow {
                full,
                targets,
                offset: 0,
                outstanding: 0,
            },
        );
        self.next_cowork_batch(flow, done);
    }

    fn next_cowork_batch(&mut self, flow: u64, done: &mut Vec<Waiter>) {
        let Some(state) = self.cowork_flows.get(&flow) else {
            return;
        };
        if state.offset >= state.targets.len() || flow != self.cowork_generation {
            let full = state.full;
            self.cowork_flows.remove(&flow);
            self.cowork_done(full, done);
            return;
        }
        let batch: Vec<ChatRef> = state
            .targets
            .iter()
            .skip(state.offset)
            .take(BATCH)
            .cloned()
            .collect();
        let mut started = 0;
        for chat in batch {
            if self.cowork_load(chat, Some(flow)) {
                started += 1;
            }
        }
        if let Some(state) = self.cowork_flows.get_mut(&flow) {
            state.outstanding = started;
        }
        if started == 0 {
            self.cowork_batch_done(flow, done);
        }
    }

    fn cowork_batch_loaded(&mut self, flow: u64, done: &mut Vec<Waiter>) {
        let Some(state) = self.cowork_flows.get_mut(&flow) else {
            return;
        };
        state.outstanding -= 1;
        if state.outstanding == 0 {
            self.cowork_batch_done(flow, done);
        }
    }

    fn cowork_batch_done(&mut self, flow: u64, done: &mut Vec<Waiter>) {
        if let Some(state) = self.cowork_flows.get_mut(&flow) {
            state.offset += BATCH;
        }
        self.next_cowork_batch(flow, done);
    }

    /// `load`: returns whether a read started (the target must be listed).
    fn cowork_load(&mut self, chat: ChatRef, flow: Option<u64>) -> bool {
        let key = chat.scope_key();
        if !self.targets.iter().any(|(k, _)| *k == key) {
            return false;
        }
        let generation = self.cowork_generation;
        self.spawn(move |inner, computer| async move {
            let scope = json!({"projectId": chat.project_id, "worktreeId": chat.worktree_id});
            let result = call(&inner, &computer, "chat:get-state", vec![scope]).await;
            Msg::CoworkLoaded {
                generation,
                chat,
                flow,
                result,
            }
        });
        true
    }

    fn cowork_loaded(&mut self, generation: u64, chat: &ChatRef, result: Result<Value>) {
        if generation != self.cowork_generation {
            return;
        }
        // Keep the last observation when a read fails or does not hydrate.
        let Some((revision, state)) = result
            .ok()
            .and_then(|reply| desktop::cowork_scope(&reply, &self.fallbacks))
        else {
            return;
        };
        let key = chat.scope_key();
        if self.cowork.get(&key).is_some_and(|(r, _)| *r > revision) {
            return;
        }
        self.cowork.insert(key, (revision, state));
    }

    // ---- Recents (`DeviceRecentChatsRepository`) ----

    fn refresh_recents(&mut self) {
        if self.recents_refreshing {
            self.recents_again = true;
            return;
        }
        self.recents_refreshing = true;
        let generation = self.recents_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.read_recents(generation);
    }

    fn read_recents(&mut self, generation: u64) {
        self.recents_again = false;
        let current = self.recents_generation.clone();
        self.spawn(move |inner, computer| async move {
            let result = read_recents(&inner, &computer, || {
                current.load(Ordering::SeqCst) == generation
            })
            .await;
            Msg::Recents { generation, result }
        });
    }

    fn recents_read(&mut self, generation: u64, result: std::result::Result<RecentSnapshot, ()>) {
        if generation != self.recents_generation.load(Ordering::SeqCst) {
            return;
        }
        // Keep the last observation until a later refresh succeeds.
        if let Ok(snapshot) = result {
            self.recents = Some(snapshot);
        }
        if self.recents_again {
            self.read_recents(generation);
        } else {
            self.recents_refreshing = false;
        }
    }

    fn pause_recents(&mut self) {
        self.recents_generation.fetch_add(1, Ordering::SeqCst);
        self.recents_refreshing = false;
        self.recents_again = false;
    }

    // ---- View ----

    fn view(&self) -> OverviewView {
        let mut owners = vec![Owner::Personal];
        let mut add = |owner: &Option<Owner>| {
            if let Some(owner) = owner
                && !owners.contains(owner)
            {
                owners.push(owner.clone());
            }
        };
        for project in &self.projects {
            add(&project.owner);
        }
        for workspace in self.recents.iter().flat_map(|r| &r.workspaces) {
            add(&workspace.owner);
        }
        let building: HashSet<&str> = self.code_graph.iter().map(String::as_str).collect();
        OverviewView {
            revision: self.revision,
            loading: self.loading,
            scope_pending: self.scope_pending,
            online: self.online,
            error: self.error.clone(),
            has_inventory: self.has_inventory,
            refreshes: self.refreshes,
            projects: self.projects.iter().map(project_view).collect(),
            worktrees: self
                .worktrees
                .iter()
                .map(|w| worktree_view(w, building.contains(w.key().as_str())))
                .collect(),
            code_project_ids: self.code_project_ids.clone(),
            has_unknown_owners: self.projects.iter().any(|p| p.owner.is_none()),
            scopes: owners
                .iter()
                .map(|owner| {
                    scope_view(&domain::context_scope(
                        owner,
                        &self.projects,
                        &self.worktrees,
                        &self.collation,
                    ))
                })
                .collect(),
            catalog_revision: self.catalog_revision,
            catalog: self.catalog.chats.iter().map(chat_view).collect(),
            catalog_workspaces: self
                .catalog
                .workspaces
                .iter()
                .map(|w| CatalogWorkspaceView {
                    id: w.id.clone(),
                    name: w.name.clone(),
                })
                .collect(),
            cowork: self
                .targets
                .iter()
                .filter_map(|(key, _)| {
                    let (_, state) = self.cowork.get(key)?;
                    Some(CoworkScopeView {
                        scope_key: key.clone(),
                        chats: state
                            .tabs
                            .iter()
                            .filter_map(|t| t.id.clone())
                            .map(|id| {
                                let (unread, working) = domain::chat_scope_status(state, &id);
                                CoworkChatView {
                                    chat_id: id,
                                    unread,
                                    working,
                                }
                            })
                            .collect(),
                    })
                })
                .collect(),
            has_recents: self.recents.is_some(),
            recents: owners
                .iter()
                .map(|owner| RecentsView {
                    owner: owner_view(owner),
                    chats: domain::recent_chats(
                        owner,
                        self.recents.as_ref(),
                        &self.projects,
                        &self.worktrees,
                    )
                    .iter()
                    .map(|r| RecentChatView {
                        chat: chat_view(&r.chat),
                        worktree_name: r.worktree_name.clone(),
                        activity_at_ms: r.activity_at_ms,
                        attention: match r.attention {
                            domain::RecentAttention::None => RecentAttention::None,
                            domain::RecentAttention::Unread => RecentAttention::Unread,
                            domain::RecentAttention::AwaitingAnswer => {
                                RecentAttention::AwaitingAnswer
                            }
                        },
                    })
                    .collect(),
                })
                .collect(),
            notification_spaces: self.recents.as_ref().map_or_else(Vec::new, |recents| {
                let mut seen = HashSet::new();
                recents
                    .standalone_chats
                    .iter()
                    .filter_map(|chat| {
                        let space = chat.work_entry_notification_space_id.as_ref()?;
                        seen.insert(chat.local_id.as_str())
                            .then(|| NotificationSpaceView {
                                chat_id: chat.local_id.clone(),
                                space_id: space.clone(),
                            })
                    })
                    .collect()
            }),
        }
    }
}

fn owner_view(owner: &Owner) -> OwnerView {
    OwnerView {
        organization_id: match owner {
            Owner::Personal => None,
            Owner::Organization(id) => Some(id.clone()),
        },
    }
}

fn project_view(p: &Project) -> ProjectView {
    ProjectView {
        id: p.id.clone(),
        name: p.name.clone(),
        kind: p.kind.clone(),
        color: p.color.clone(),
        temporary: p.temporary,
        always_show: p.always_show,
        owner: p.owner.as_ref().map(owner_view),
        order: p.order,
    }
}

fn chat_view(c: &ChatRef) -> ChatRefView {
    ChatRefView {
        project_id: c.project_id.clone(),
        worktree_id: c.worktree_id.clone(),
        id: c.id.clone(),
        title: c.title.clone(),
    }
}

pub(crate) fn chats_view(c: &WorktreeChats) -> WorktreeChatsView {
    WorktreeChatsView {
        chats: c.chats.iter().map(chat_view).collect(),
        active_chat_id: c.active_chat_id.clone(),
        status: match c.status {
            ChatStatus::Loading => WorktreeStatus::Loading,
            ChatStatus::Unavailable => WorktreeStatus::Unavailable,
            ChatStatus::NeedsInput => WorktreeStatus::NeedsInput,
            ChatStatus::Working => WorktreeStatus::Working,
            ChatStatus::Failed => WorktreeStatus::Failed,
            ChatStatus::Done => WorktreeStatus::Done,
            ChatStatus::Idle => WorktreeStatus::Idle,
        },
        unread: c.unread,
        pending_question: c.pending_question,
        pending_approval: c.pending_approval,
        is_streaming: c.is_streaming,
        working_chats: c.working_chats.clone(),
    }
}

fn worktree_view(w: &Worktree, building: bool) -> WorktreeView {
    let row = domain::worktree_row(w);
    WorktreeView {
        key: w.key(),
        project_id: w.project_id.clone(),
        project_name: w.project_name.clone(),
        id: w.id.clone(),
        name: w.name.clone(),
        saved_status: w.saved_status.clone(),
        order: w.order,
        hidden: w.hidden,
        pipeline_status: w.pipeline_status.clone(),
        instance: w.instance,
        chats: chats_view(&w.chats),
        code_graph_building: building,
        row: WorktreeRowView {
            local_id: row.local_id,
            workspace_local_id: row.workspace_local_id,
            branch: row.branch,
            label: row.label,
            order: row.order,
            status: row.status,
            busy: row.busy,
            is_streaming: row.is_streaming,
            background_tasks: row.background_tasks,
            has_unread: row.has_unread,
            hidden: row.hidden,
            awaiting_approval: row.awaiting_approval,
            pipeline_status: row.pipeline_status,
            script_status: row.script_status,
            hook_status: row.hook_status,
            terminal_status: row.terminal_status,
            setup_phase: row.setup_phase,
            last_activity_at: row.last_activity_at,
            created_at: row.created_at,
            insertions: row.insertions,
            deletions: row.deletions,
            pr_statuses: row
                .pr_statuses
                .into_iter()
                .map(|p| PrStatusView {
                    repo_id: p.repo_id,
                    pr_number: p.pr_number,
                    state: p.state,
                    url: p.url,
                    title: p.title,
                    base_ref_name: p.base_ref_name,
                    check_status: p.check_status,
                    review_status: p.review_status,
                    has_conflicts: p.has_conflicts,
                    merge_ready: p.merge_ready,
                    comment_count: p.comment_count,
                    unresolved_review_thread_count: p.unresolved_review_thread_count,
                    merge_queue: p.merge_queue.map(|q| MergeQueueView {
                        in_queue: q.in_queue,
                        position: q.position,
                        phase: q.phase,
                    }),
                })
                .collect(),
            merging_pr: row.merging_pr,
            merge_pr_phase: row.merge_pr_phase,
            notification_space_id: row.notification_space_id,
        },
    }
}

fn entries(entries: &[domain::AttentionEntry]) -> Vec<AttentionEntryView> {
    entries
        .iter()
        .map(|e| AttentionEntryView {
            worktree_key: e.worktree_key.clone(),
            workspace_name: e.workspace_name.clone(),
        })
        .collect()
}

fn scope_view(s: &domain::ContextScope) -> ContextScopeView {
    ContextScopeView {
        owner: owner_view(&s.owner),
        project_ids: s.project_ids.clone(),
        worktree_keys: s.worktree_keys.clone(),
        all_worktree_keys: s.all_worktree_keys.clone(),
        cowork_project_ids: s.cowork_project_ids.clone(),
        attention: AttentionView {
            awaiting_approval: entries(&s.attention.awaiting_approval),
            unread_chats: entries(&s.attention.unread_chats),
            in_progress: entries(&s.attention.in_progress),
            pipelines_running: entries(&s.attention.pipelines_running),
            pipelines_finished: entries(&s.attention.pipelines_finished),
            entries: entries(&domain::attention_entries(&s.attention)),
        },
    }
}

fn catalog_view(c: &Catalog) -> CatalogView {
    CatalogView {
        chats: c.chats.iter().map(chat_view).collect(),
        workspaces: c
            .workspaces
            .iter()
            .map(|w| CatalogWorkspaceView {
                id: w.id.clone(),
                name: w.name.clone(),
            })
            .collect(),
    }
}

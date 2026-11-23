//! The signed-in account's computers and their connections: saved computers
//! and selection, discovery and its backoff, per-outage recovery, access
//! denial, the background grace, the offline banner and the reconnect
//! notice. Ported from `computer_connect/{account,engine,reconnect_status,
//! reconnect_notice_delay}.dart`, `desktop_link_model.dart` and
//! `desktop_link_recovery.dart`; comments cite the Dart rule they keep.
//!
//! One actor task owns all of it by value. Intents, relay and session
//! signals, timer fires and the results of the network work it spawns all
//! arrive on one inbox and apply in order; a message that changes the view
//! publishes one [`AccountView`] (an unchanged view is not republished).
//! Network work (relay, connect, stop, probe) runs in spawned tasks that
//! report back with the revision they belong to, so late results are
//! ignored as Dart's generation checks ignore them.
use crate::{
    account::Scope,
    api::{
        AccountView, AppLifecycle, ConnectionView, Notice, NoticeCode, SavedComputerView, SetupRow,
        SwitcherRow,
    },
    bridge::{Inner, RelaySnapshot},
    copy::computers::{self as copy, CopyKey},
    error::{Error, Result},
    failures,
    ports::Notice as RelayNotice,
};
use cc_domain::computers::{
    self as rules, LinkPhase, SetupInputs, SetupStatus, policy, valid_computer_id,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::{Arc, Weak},
    time::{Duration, SystemTime},
};
use tokio::{
    runtime::Handle as Runtime,
    sync::{mpsc, oneshot, watch},
};

/// Relay and session signals from the bridge.
pub(crate) enum Signal {
    /// The current relay's notice, numbered in the order the bridge
    /// forwarded it.
    Relay(u64, RelayNotice),
    SessionClosed {
        computer: String,
    },
    PairingCode {
        computer: String,
        code: String,
    },
}

pub(crate) enum Intent {
    /// Binds the service to `account` in the current account scope
    /// (resetting it for another account or scope) and restores its saved
    /// computers.
    Restore {
        account: String,
    },
    /// Applies `command` to the bound account if `binding` restored it in
    /// the account scope that still lasts; otherwise fails with
    /// `account_changed` before any effect.
    Account {
        binding: u64,
        command: Command,
    },
    Lifecycle(AppLifecycle),
    /// Releases binding `binding`, unless a newer one exists.
    Close {
        binding: u64,
    },
}

pub(crate) enum Command {
    FindComputers,
    Connect(String),
    Select(String),
    Disconnect(String),
    Forget(String),
    CancelConnect(String),
    Link(String, LinkIntent),
}

pub(crate) enum LinkIntent {
    Connect,
    Cancel,
    RetryNow,
    Reconnect,
    DisconnectAndClear,
    Forget,
}

/// Answers an intent with the view right after it applied.
type Reply = oneshot::Sender<Result<Arc<AccountView>>>;

/// Spawned work reports with the `epoch` it started in; a reset moves to
/// the next epoch, so results of the previous account's work are dropped
/// even where its flow and link revisions repeat.
pub(crate) enum Msg {
    Signal(Signal),
    Intent(Intent, Reply),
    Timer(u64),
    Discovered {
        epoch: u64,
        flow: u64,
        result: Result<RelaySnapshot>,
    },
    Opened {
        epoch: u64,
        computer: String,
        rev: u64,
        hello: Value,
    },
    ConnectDone {
        epoch: u64,
        computer: String,
        rev: u64,
        relay_was_open: bool,
        result: Result<()>,
    },
    CleanupDone {
        epoch: u64,
        cleared: bool,
    },
    Probed {
        epoch: u64,
        flow: u64,
    },
    Suspended {
        token: u64,
    },
    /// The account scope binding `binding` restored in ended.
    ScopeEnded {
        binding: u64,
    },
}

/// The service's handle: its inbox and published view.
#[derive(Clone)]
pub(crate) struct Handle {
    inbox: mpsc::UnboundedSender<Msg>,
    view: watch::Receiver<Arc<AccountView>>,
}

impl Handle {
    pub(crate) fn start(inner: &Arc<Inner>, runtime: &Runtime) -> Self {
        let (inbox, rx) = mpsc::unbounded_channel();
        // Observed before the relay is read: a notice sent in between is
        // queued, and one the read already reflects is skipped.
        inner.observe_signals(inbox.clone());
        let actor = Actor::new(
            Arc::downgrade(inner),
            inbox.clone(),
            &inner.relay_snapshot(),
        );
        let (publish, view) = watch::channel(Arc::new(actor.view()));
        runtime.spawn(actor.run(rx, publish));
        Self { inbox, view }
    }
    pub(crate) fn view(&self) -> watch::Receiver<Arc<AccountView>> {
        self.view.clone()
    }
    /// Applies `intent`; resolves with the view right after it applied.
    pub(crate) async fn request(&self, intent: Intent) -> Result<Arc<AccountView>> {
        let (tx, rx) = oneshot::channel();
        self.inbox
            .send(Msg::Intent(intent, tx))
            .map_err(|_| crate::bridge::shutdown_failure())?;
        rx.await.map_err(|_| crate::bridge::shutdown_failure())?
    }
}

#[derive(Clone)]
struct Saved {
    id: String,
    name: String,
    reconnect: bool,
}

#[derive(Clone)]
struct Peer {
    name: String,
    accepts_control: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Timer {
    DiscoveryRetry,
    Closing,
    Offline,
    RecoveryRetry { generation: u64 },
    RecoveryDeadline { generation: u64 },
    Notice,
}

/// One outage has one deadline, even when an attempt never finishes
/// (`desktop_link_recovery.dart`).
#[derive(Default)]
struct Recovery {
    generation: u64,
    active: bool,
    attempt: usize,
    attempting: bool,
    again: bool,
    retry: Option<u64>,
    deadline: Option<u64>,
}

struct Connecting {
    rev: u64,
    recovering: bool,
    /// The recovery generation of a recovery attempt.
    recovery: Option<u64>,
    /// Cancels the attempt at any step, even before its session has a
    /// slot in the bridge.
    abort: watch::Sender<bool>,
}

/// One computer's connection (`desktop_link_model.dart`).
struct Link {
    phase: LinkPhase,
    code: Option<String>,
    error: Option<String>,
    host_name: Option<String>,
    /// `_target != null`: a computer to reconnect to.
    target: bool,
    recovery_expired: bool,
    revision: u64,
    suspended: bool,
    resume: bool,
    /// This link owns a session the core still runs; its `closed` counts.
    session_live: bool,
    /// The sessions this link opened; the latest is the live one.
    sessions: u64,
    connecting: Option<Connecting>,
    recovery: Recovery,
    notice_visible: bool,
    notice_timer: Option<u64>,
    /// Completes when this link's latest stop released the session, so a
    /// later connect never races it.
    stopped: watch::Receiver<bool>,
}

impl Link {
    fn new() -> Self {
        Self {
            phase: LinkPhase::Disconnected,
            code: None,
            error: None,
            host_name: None,
            target: false,
            recovery_expired: false,
            revision: 0,
            suspended: false,
            resume: false,
            session_live: false,
            sessions: 0,
            connecting: None,
            recovery: Recovery::default(),
            notice_visible: false,
            notice_timer: None,
            stopped: watch::channel(true).1,
        }
    }
    fn busy(&self) -> bool {
        self.phase.busy()
    }
    fn reconnecting(&self) -> bool {
        self.phase == LinkPhase::Reconnecting
    }
    fn online(&self) -> bool {
        self.phase == LinkPhase::Connected
    }
}

/// The work an account flow waits on.
enum Flow {
    Idle,
    /// `findComputers`: waiting for the relay.
    Discovering {
        flow: u64,
    },
    /// `findComputers`: connecting saved computers one at a time.
    AutoConnect {
        queue: VecDeque<String>,
        waiting: Option<(String, u64)>,
    },
    /// `connect`: waiting for the computer's connect to settle.
    Connecting {
        id: String,
        name: String,
        waiting: Option<u64>,
    },
}

/// What a finished `_closeSessions` continues with.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AfterClose {
    Nothing,
    /// `resume` after the grace: open again unless hidden again.
    Resume,
}

struct Actor {
    inner: Weak<Inner>,
    inbox: mpsc::UnboundedSender<Msg>,
    revision: u64,
    binding: u64,
    /// The binding that bound `account`; it and the later restores of the
    /// same account in the same scope may command it.
    account_binding: u64,
    /// The account scope `account` was bound in. Once it ends, every
    /// binding of it is refused at once, before the next restore.
    scope: Option<Scope>,
    epoch: u64,
    account: Option<String>,
    // Saved computers (`SavedComputerConnection`), in saved order.
    saved: Vec<Saved>,
    saved_selected: Option<String>,
    credential: Value,
    creating_credential: bool,
    record_origin: Option<Value>,
    // Account state (`ComputerConnectAccount`).
    ready: bool,
    busy: bool,
    finding: bool,
    access_denied: bool,
    access_status: Option<u16>,
    error: Option<(NoticeCode, String)>,
    unreadable: bool,
    // The app's lifecycle, kept while no account is bound and across
    // accounts (`reset`).
    foreground: bool,
    hidden: bool,
    ui_foreground: bool,
    hidden_at: Option<SystemTime>,
    closing: Option<u64>,
    attempt: usize,
    retry: Option<u64>,
    connecting_id: Option<String>,
    cleanup_running: bool,
    flow: Flow,
    flows: u64,
    // The relay (`_relay`): seen at least once, and open now.
    relay_seen: bool,
    relay_open: bool,
    /// The last relay notice the relay state reflects; earlier ones queued
    /// behind a read of the relay are skipped.
    relay_seq: u64,
    peers: BTreeMap<String, Peer>,
    // Sessions (`ComputerConnectEngine`): one link per remembered computer,
    // in remembered order, and the selected one.
    links: Vec<(String, Link)>,
    selected: Option<String>,
    // `_closeSessions` in flight with its completion, and a resume waiting
    // for it.
    suspending: Option<(u64, AfterClose, watch::Receiver<bool>)>,
    resume_links: bool,
    // The offline banner (`ComputerReconnectStatus`).
    offline_computer: Option<String>,
    offline_online: bool,
    offline: bool,
    offline_timer: Option<u64>,
    timers: HashMap<u64, (Option<String>, Timer)>,
    tokens: u64,
    /// Completes when every earlier binding's teardown finished; this
    /// binding's relay and session work waits for it.
    teardown: watch::Receiver<bool>,
}

impl Actor {
    fn new(inner: Weak<Inner>, inbox: mpsc::UnboundedSender<Msg>, relay: &RelaySnapshot) -> Self {
        let relay_open = relay.peers.is_some();
        Self {
            inner,
            inbox,
            revision: 0,
            binding: 0,
            account_binding: 0,
            scope: None,
            epoch: 0,
            account: None,
            saved: Vec::new(),
            saved_selected: None,
            credential: Value::Null,
            creating_credential: false,
            record_origin: None,
            ready: false,
            busy: false,
            finding: false,
            access_denied: false,
            access_status: None,
            error: None,
            unreadable: false,
            foreground: true,
            hidden: false,
            ui_foreground: true,
            hidden_at: None,
            closing: None,
            attempt: 0,
            retry: None,
            connecting_id: None,
            cleanup_running: false,
            flow: Flow::Idle,
            flows: 0,
            relay_seen: relay_open,
            relay_open,
            relay_seq: relay.seq,
            peers: BTreeMap::new(),
            links: Vec::new(),
            selected: None,
            suspending: None,
            resume_links: false,
            offline_computer: None,
            offline_online: false,
            offline: false,
            offline_timer: None,
            timers: HashMap::new(),
            tokens: 0,
            teardown: watch::channel(true).1,
        }
    }

    async fn run(
        mut self,
        mut rx: mpsc::UnboundedReceiver<Msg>,
        publish: watch::Sender<Arc<AccountView>>,
    ) {
        let mut current = publish.borrow().clone();
        while let Some(msg) = rx.recv().await {
            let reply = self.apply(msg);
            self.schedule();
            self.update_offline();
            // Publish only a change: the stores following the account (and
            // Dart) wake only when what they read moved. `self.revision`
            // is the published view's, so a view equal to it is unchanged.
            let next = self.view();
            if next != *current {
                self.revision += 1;
                current = Arc::new(AccountView {
                    revision: self.revision,
                    ..next
                });
                publish.send_replace(current.clone());
            }
            if let Some((reply, applied)) = reply {
                let _ = reply.send(applied.map(|()| current.clone()));
            }
        }
    }

    /// Applies `msg`; an intent returns its reply and whether it applied.
    fn apply(&mut self, msg: Msg) -> Option<(Reply, Result<()>)> {
        match msg {
            Msg::Intent(intent, reply) => return Some((reply, self.intent(intent))),
            Msg::Signal(signal) => self.signal(signal),
            Msg::Timer(token) => self.timer(token),
            Msg::Discovered { epoch, .. }
            | Msg::Opened { epoch, .. }
            | Msg::ConnectDone { epoch, .. }
            | Msg::CleanupDone { epoch, .. }
            | Msg::Probed { epoch, .. }
                if epoch != self.epoch => {}
            Msg::Discovered { flow, result, .. } => self.discovered(flow, result),
            Msg::Opened {
                computer,
                rev,
                hello,
                ..
            } => self.opened(&computer, rev, &hello),
            Msg::ConnectDone {
                computer,
                rev,
                relay_was_open,
                result,
                ..
            } => self.connect_done(&computer, rev, relay_was_open, result),
            Msg::CleanupDone { cleared, .. } => {
                self.cleanup_running = false;
                if cleared {
                    self.credential = Value::Null;
                    self.creating_credential = false;
                }
            }
            Msg::Probed { flow, .. } => {
                if flow == self.flows {
                    self.find_computers();
                }
            }
            Msg::Suspended { token } => self.suspended(token),
            Msg::ScopeEnded { binding } => {
                // The binding of the next scope is not this one's: its
                // sessions, relay and caches were taken with the scope, and
                // nothing of the left account runs on. Every binding of it
                // is retired, so its views and closes no longer match.
                if self.account.is_some() && self.account_binding == binding && !self.live() {
                    self.reset(false);
                    self.binding += 1;
                }
            }
        }
        None
    }

    fn intent(&mut self, intent: Intent) -> Result<()> {
        match intent {
            Intent::Restore { account } => {
                let Some(inner) = self.inner.upgrade() else {
                    return Ok(());
                };
                // The scope of `account`: bound to it, a restore of a scope
                // that ends right after binds nothing that lasts.
                if inner.account().ok().as_deref() != Some(&account) {
                    return Ok(());
                }
                let scope = inner.scope();
                if scope.account().as_deref() != Some(&account) {
                    return Ok(());
                }
                self.binding += 1;
                let bound = self.account.as_deref() == Some(&account)
                    && self.scope.as_ref().is_some_and(|s| s.same(&scope));
                if !bound {
                    // The core tore the old scope's relay down when it left
                    // it; only its sessions are left to stop.
                    if self.account.is_some() {
                        self.reset(false);
                    }
                    self.account = Some(account);
                    self.account_binding = self.binding;
                    self.watch_scope(&scope);
                    self.scope = Some(scope);
                }
                self.restore();
            }
            Intent::Account { binding, command } => {
                // A scope's command can queue behind the end of its scope
                // and the next restore; it must not reach the next scope,
                // even of the same account.
                if self.account.is_none()
                    || !self.live()
                    || !(self.account_binding..=self.binding).contains(&binding)
                {
                    return Err(Error::new("account_changed"));
                }
                self.command(command);
                // Ended while it applied: what it removed or wrote was
                // refused from then on.
                if !self.live() {
                    return Err(Error::new("account_changed"));
                }
            }
            // The app's state, not an account's: it applies while no account
            // is bound, so a restore that binds one later starts hidden.
            Intent::Lifecycle(state) => self.lifecycle(state),
            _ if self.account.is_none() => {}
            Intent::Close { binding } => {
                if binding == self.binding {
                    self.reset(true);
                }
            }
        }
        Ok(())
    }

    /// Whether the scope the account was bound in lasts.
    fn live(&self) -> bool {
        self.scope.as_ref().is_some_and(Scope::live)
    }

    /// Reports the end of `scope`, bound by the current binding.
    fn watch_scope(&self, scope: &Scope) {
        let (ended, inbox, binding) = (scope.ended(), self.inbox.clone(), self.binding);
        tokio::spawn(async move {
            ended.await;
            let _ = inbox.send(Msg::ScopeEnded { binding });
        });
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::FindComputers => self.find_computers(),
            Command::Connect(id) => self.connect(&id),
            Command::Select(id) => self.select(&id),
            Command::Disconnect(id) => self.disconnect(&id),
            Command::Forget(id) => self.forget(&id),
            Command::CancelConnect(id) => {
                if self.saved_index(&id).is_some() {
                    self.disconnect(&id);
                } else {
                    self.link_disconnect(&id);
                }
            }
            Command::Link(id, intent) => self.link_intent(&id, intent),
        }
    }

    // ---- Timers ----

    fn timer_start(&mut self, computer: Option<&str>, kind: Timer, delay: Duration) -> u64 {
        self.tokens += 1;
        let token = self.tokens;
        self.timers
            .insert(token, (computer.map(String::from), kind));
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = inbox.send(Msg::Timer(token));
        });
        token
    }
    fn timer_cancel(&mut self, token: Option<u64>) {
        if let Some(token) = token {
            self.timers.remove(&token);
        }
    }
    fn timer(&mut self, token: u64) {
        let Some((computer, kind)) = self.timers.remove(&token) else {
            return;
        };
        match (kind, computer) {
            (Timer::DiscoveryRetry, _) => {
                if self.retry == Some(token) {
                    self.retry = None;
                    self.find_computers();
                }
            }
            (Timer::Closing, _) => {
                if self.closing == Some(token) {
                    self.closing = None;
                    self.close_sessions(AfterClose::Nothing);
                }
            }
            (Timer::Offline, _) => {
                if self.offline_timer == Some(token) {
                    self.offline_timer = None;
                    self.offline = true;
                }
            }
            (Timer::RecoveryRetry { generation }, Some(id)) => {
                let current = self.link(&id).is_some_and(|l| {
                    l.recovery.generation == generation && l.recovery.retry == Some(token)
                });
                if current {
                    if let Some(link) = self.link_mut(&id) {
                        link.recovery.retry = None;
                    }
                    self.recovery_run(&id, generation);
                }
            }
            (Timer::RecoveryDeadline { generation }, Some(id)) => {
                let current = self.link(&id).is_some_and(|l| {
                    l.recovery.generation == generation && l.recovery.deadline == Some(token)
                });
                if current {
                    self.recovery_cancel(&id);
                    // `onExpired`: the outage did not recover within a minute.
                    if let Some(link) = self.link_mut(&id) {
                        link.recovery_expired = true;
                    }
                    self.drop_link(&id);
                }
            }
            (Timer::Notice, Some(id)) => {
                if let Some(link) = self.link_mut(&id)
                    && link.notice_timer == Some(token)
                {
                    link.notice_timer = None;
                    link.notice_visible = true;
                }
            }
            _ => {}
        }
    }

    // ---- Links (`desktop_link_model.dart`) ----

    fn link(&self, id: &str) -> Option<&Link> {
        self.links.iter().find(|(i, _)| i == id).map(|(_, l)| l)
    }
    fn link_mut(&mut self, id: &str) -> Option<&mut Link> {
        self.links.iter_mut().find(|(i, _)| i == id).map(|(_, l)| l)
    }
    /// `rememberComputer`: every remembered computer keeps its link. The
    /// first one remembered adopts the engine's initial selection, so a
    /// restore without a saved selection shows the first saved computer;
    /// the adoption is not saved.
    fn remember(&mut self, id: &str) {
        if self.link(id).is_none() {
            self.links.push((id.to_owned(), Link::new()));
            if self.selected.is_none() {
                self.selected = Some(id.to_owned());
            }
        }
    }

    /// `connectWith`.
    fn link_connect_with(&mut self, id: &str) -> Option<u64> {
        let link = self.link_mut(id)?;
        if link.busy() {
            return None;
        }
        link.target = true;
        self.link_reconnect(id)
    }
    /// `reconnect`.
    fn link_reconnect(&mut self, id: &str) -> Option<u64> {
        let link = self.link_mut(id)?;
        if link.busy() {
            return None;
        }
        link.recovery_expired = false;
        self.start_connect(id, false)
    }

    /// `_connect`: starts an attempt and returns its revision, or `None`
    /// when there is nothing to connect.
    fn start_connect(&mut self, id: &str, recovering: bool) -> Option<u64> {
        // A recovery or retry of an ended scope opens nothing for the next.
        if !self.live() {
            return None;
        }
        let scope = self.scope.clone()?;
        let (epoch, relay_open, foreground) = (self.epoch, self.relay_open, self.foreground);
        let denied = self
            .access_denied
            .then(|| self.access_status.unwrap_or(401));
        let inner = self.inner.upgrade()?;
        let inbox = self.inbox.clone();
        let link = self.link_mut(id)?;
        if !link.target || link.suspended || (recovering && !link.recovery.active) {
            return None;
        }
        link.revision += 1;
        let rev = link.revision;
        link.phase = if recovering {
            LinkPhase::Reconnecting
        } else {
            LinkPhase::Connecting
        };
        link.error = None;
        link.code = None;
        if !recovering {
            link.host_name = None;
        }
        let (abort, aborted) = watch::channel(false);
        link.connecting = Some(Connecting {
            rev,
            recovering,
            recovery: recovering.then_some(link.recovery.generation),
            abort,
        });
        let mut stopped = link.stopped.clone();
        let mut teardown = self.teardown.clone();
        let computer = id.to_owned();
        tokio::spawn(async move {
            // `_token`: opening the relay needs the app in the foreground
            // and an account with access.
            let result = if relay_open {
                Ok(())
            } else if !foreground {
                Err(failures::cancelled())
            } else if let Some(status) = denied {
                Err(Error::http(status, "relay_access_denied"))
            } else {
                Ok(())
            };
            let result = match result {
                Ok(()) => {
                    let _ = teardown.wait_for(|done| *done).await;
                    let _ = stopped.wait_for(|done| *done).await;
                    // `connect` starts with `disconnect()`: a session the
                    // desktop ended still holds the computer's channel.
                    inner.release_ended(&scope, &computer).await;
                    let opened = inbox.clone();
                    let peer = computer.clone();
                    inner
                        .open_session(
                            &scope,
                            &computer,
                            !recovering,
                            None,
                            Some(aborted),
                            move |hello| {
                                let _ = opened.send(Msg::Opened {
                                    epoch,
                                    computer: peer,
                                    rev,
                                    hello,
                                });
                            },
                        )
                        .await
                }
                Err(e) => Err(e),
            };
            let _ = inbox.send(Msg::ConnectDone {
                epoch,
                computer,
                rev,
                relay_was_open: relay_open,
                result,
            });
        });
        Some(rev)
    }

    fn opened(&mut self, id: &str, rev: u64, hello: &Value) {
        let Some(link) = self.link_mut(id) else {
            return;
        };
        if rev != link.revision {
            return;
        }
        link.session_live = true;
        link.sessions += 1;
        link.host_name = hello["name"].as_str().map(String::from);
        link.code = None;
        link.phase = LinkPhase::Connected;
        self.recovery_cancel(id);
    }

    fn connect_done(&mut self, id: &str, rev: u64, relay_was_open: bool, result: Result<()>) {
        let Some(link) = self.link_mut(id) else {
            return;
        };
        let attempt = link.connecting.take_if(|c| c.rev == rev);
        let current = rev == link.revision;
        let restored = current && result.is_ok() && link.online();
        if current && let Err(e) = &result {
            let recovering = attempt.as_ref().is_some_and(|c| c.recovering);
            if let Some(status) = failures::access_status(e) {
                link.error = Some(failures::connection_failure(e));
                link.host_name = None;
                link.phase = LinkPhase::Failed;
                link.recovery_expired = true;
                link.code = None;
                self.recovery_cancel(id);
                // `_token` denies access when opening the relay failed.
                if !relay_was_open && self.foreground {
                    self.deny_access(status);
                }
            } else {
                if !recovering {
                    link.error = Some(failures::connection_failure(e));
                }
                link.phase = if recovering {
                    LinkPhase::Reconnecting
                } else {
                    LinkPhase::Failed
                };
                link.code = None;
            }
        }
        // The recovery attempt this connect was, if any, has finished.
        if let Some(generation) = attempt.and_then(|c| c.recovery) {
            self.recovery_done(id, generation, restored);
        }
        self.flow_settled(id, rev);
    }

    /// `retryNow`.
    fn link_retry_now(&mut self, id: &str) {
        if self
            .link(id)
            .is_some_and(|l| l.reconnecting() && !l.suspended)
        {
            self.recovery_retry_now(id);
        }
    }

    /// `_drop`: ends the session or the attempt and releases the computer.
    fn drop_link(&mut self, id: &str) {
        self.recovery_cancel(id);
        let Some(link) = self.link_mut(id) else {
            return;
        };
        link.revision += 1;
        link.phase = LinkPhase::Disconnected;
        link.code = None;
        link.host_name = None;
        self.stop_session(id);
    }

    /// `repository.disconnect()`.
    fn stop_session(&mut self, id: &str) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let Some(link) = self.link_mut(id) else {
            return;
        };
        link.session_live = false;
        if let Some(attempt) = &link.connecting {
            attempt.abort.send_replace(true);
        }
        let (done, stopped) = watch::channel(false);
        link.stopped = stopped;
        let computer = id.to_owned();
        // Only the session of the scope the account was bound in: once it
        // ended, leaving the account took that session.
        let scope = self.scope.clone();
        tokio::spawn(async move {
            if let Some(scope) = scope {
                let _ = inner.disconnect(&scope, &computer, false).await;
            }
            let _ = done.send(true);
        });
    }

    /// `disconnect`.
    fn link_disconnect(&mut self, id: &str) {
        if let Some(link) = self.link_mut(id) {
            link.resume = false;
            self.drop_link(id);
        }
    }
    /// `disconnectAndClear`.
    fn link_disconnect_and_clear(&mut self, id: &str) {
        self.link_disconnect(id);
        if let Some(link) = self.link_mut(id) {
            link.target = false;
        }
    }

    /// `suspend`: a connected or recovering link resumes recovery later.
    fn link_suspend(&mut self, id: &str) -> Option<watch::Receiver<bool>> {
        let link = self.link_mut(id)?;
        if link.suspended {
            return None;
        }
        link.suspended = true;
        link.resume = link.online() || link.reconnecting();
        if !link.resume {
            self.drop_link(id);
        } else {
            self.recovery_cancel(id);
            let link = self.link_mut(id)?;
            link.revision += 1;
            link.phase = LinkPhase::Reconnecting;
            link.code = None;
            self.stop_session(id);
        }
        self.link(id).map(|l| l.stopped.clone())
    }
    /// `resume`.
    fn link_resume(&mut self, id: &str) {
        let Some(link) = self.link_mut(id) else {
            return;
        };
        link.suspended = false;
        if !link.resume {
            return;
        }
        link.resume = false;
        self.recovery_start(id);
    }

    fn link_closed(&mut self, id: &str) {
        let Some(link) = self.link_mut(id) else {
            return;
        };
        // Only the session this link owns counts; stops it caused are its own.
        if !link.session_live {
            return;
        }
        link.session_live = false;
        if link.online() && !link.suspended && link.target {
            link.revision += 1;
            link.phase = LinkPhase::Reconnecting;
            link.error = None;
            link.code = None;
            self.recovery_start(id);
        } else {
            if !link.recovery.active && !link.busy() {
                link.phase = LinkPhase::Disconnected;
            }
            link.code = None;
        }
    }

    fn pairing_code(&mut self, id: &str, code: &str) {
        if let Some(link) = self.link_mut(id)
            && link
                .connecting
                .as_ref()
                .is_some_and(|c| c.rev == link.revision)
        {
            link.code = Some(rules::pairing_code(code));
            link.phase = LinkPhase::Pairing;
        }
    }

    fn link_intent(&mut self, id: &str, intent: LinkIntent) {
        if !valid_computer_id(id) {
            return;
        }
        match intent {
            LinkIntent::Connect => {
                self.remember(id);
                self.link_connect_with(id);
            }
            LinkIntent::Cancel => self.link_disconnect(id),
            LinkIntent::RetryNow => self.link_retry_now(id),
            LinkIntent::Reconnect => {
                self.link_reconnect(id);
            }
            LinkIntent::DisconnectAndClear => self.link_disconnect_and_clear(id),
            LinkIntent::Forget => {
                self.link_disconnect(id);
                if let Err(e) = self.forget_pin(id)
                    && let Some(link) = self.link_mut(id)
                {
                    link.error = Some(failures::connection_failure(&e));
                }
            }
        }
    }

    // ---- Recovery (`desktop_link_recovery.dart`) ----

    fn recovery_start(&mut self, id: &str) {
        let Some(link) = self.link_mut(id) else {
            return;
        };
        if link.recovery.active {
            return;
        }
        link.recovery.generation += 1;
        let generation = link.recovery.generation;
        link.recovery.attempt = 0;
        link.recovery.active = true;
        let deadline = self.timer_start(
            Some(id),
            Timer::RecoveryDeadline { generation },
            policy::RECOVERY_DEADLINE,
        );
        if let Some(link) = self.link_mut(id) {
            link.recovery.deadline = Some(deadline);
        }
        self.recovery_schedule(id, generation);
    }
    fn recovery_schedule(&mut self, id: &str, generation: u64) {
        let Some(link) = self.link_mut(id) else {
            return;
        };
        let delay = if link.recovery.again {
            Duration::ZERO
        } else {
            policy::recovery_delay(link.recovery.attempt)
        };
        link.recovery.again = false;
        link.recovery.attempt += 1;
        let token = self.timer_start(Some(id), Timer::RecoveryRetry { generation }, delay);
        if let Some(link) = self.link_mut(id) {
            link.recovery.retry = Some(token);
        }
    }
    /// Tries again now; an attempt in flight is followed at once if it fails.
    fn recovery_retry_now(&mut self, id: &str) {
        let Some(link) = self.link_mut(id) else {
            return;
        };
        if !link.recovery.active {
            return;
        }
        if link.recovery.attempting {
            link.recovery.again = true;
            return;
        }
        let retry = link.recovery.retry.take();
        let generation = link.recovery.generation;
        self.timer_cancel(retry);
        self.recovery_run(id, generation);
    }
    fn recovery_run(&mut self, id: &str, generation: u64) {
        if let Some(link) = self.link_mut(id) {
            link.recovery.attempting = true;
        }
        if self.start_connect(id, true).is_none() {
            self.recovery_done(id, generation, false);
        }
    }
    fn recovery_done(&mut self, id: &str, generation: u64, restored: bool) {
        let Some(link) = self.link_mut(id) else {
            return;
        };
        if generation != link.recovery.generation {
            return;
        }
        link.recovery.attempting = false;
        if restored {
            self.recovery_cancel(id);
        } else {
            self.recovery_schedule(id, generation);
        }
    }
    fn recovery_cancel(&mut self, id: &str) {
        let Some(link) = self.link_mut(id) else {
            return;
        };
        link.recovery.generation += 1;
        link.recovery.attempting = false;
        link.recovery.again = false;
        link.recovery.active = false;
        let timers = [link.recovery.deadline.take(), link.recovery.retry.take()];
        for token in timers {
            self.timer_cancel(token);
        }
    }

    // ---- Account (`account.dart`) ----

    fn saved_index(&self, id: &str) -> Option<usize> {
        self.saved.iter().position(|c| c.id == id)
    }
    fn saved_reconnect(&self, id: &str) -> Option<bool> {
        self.saved_index(id).map(|i| self.saved[i].reconnect)
    }

    fn set_error(&mut self, key: CopyKey) {
        self.error = Some((notice_code(key), copy::text(key).into()));
    }

    /// Drops every computer, session and timer of the bound account, and
    /// with `close_relay` the relay (`hub.dispose`).
    fn reset(&mut self, close_relay: bool) {
        let ids: Vec<String> = self.links.iter().map(|(id, _)| id.clone()).collect();
        for id in &ids {
            self.recovery_cancel(id);
            if let Some(link) = self.link_mut(id) {
                link.target = false;
            }
        }
        let inner = self.inner.upgrade();
        let scope = self.scope.clone();
        // The next binding starts only after this teardown, and this one
        // only after the earlier teardown and any `_closeSessions` it left.
        let mut waits: Vec<_> = ids.iter().filter_map(|id| self.link_suspend(id)).collect();
        waits.push(self.teardown.clone());
        waits.extend(self.suspending.as_ref().map(|(_, _, done)| done.clone()));
        let (done, teardown) = watch::channel(false);
        if let Some(inner) = inner {
            tokio::spawn(async move {
                for mut wait in waits {
                    let _ = wait.wait_for(|d| *d).await;
                }
                if close_relay && let Some(scope) = scope {
                    inner.disconnect_all_in(&scope, "suspended").await;
                }
                let _ = done.send(true);
            });
        }
        // Another account's relay is already gone; one open now is the next
        // account's (its link may open it before the restore). A close
        // closes the relay.
        let mut relay = self
            .inner
            .upgrade()
            .map(|inner| inner.relay_snapshot())
            .unwrap_or_default();
        if close_relay {
            relay.peers = None;
        }
        let next = Actor::new(self.inner.clone(), self.inbox.clone(), &relay);
        let old = std::mem::replace(self, next);
        self.revision = old.revision;
        self.binding = old.binding;
        self.epoch = old.epoch + 1;
        self.tokens = old.tokens;
        self.flows = old.flows;
        self.teardown = teardown;
        // The app's lifecycle outlives the account: the next binding starts
        // hidden, with the background grace still running or the sessions
        // already closed. Visible again, a close still in flight is part of
        // the teardown the next binding waits for.
        self.hidden = old.hidden;
        self.ui_foreground = old.ui_foreground;
        self.hidden_at = old.hidden_at;
        self.closing = old.closing;
        self.foreground = old.foreground || !old.hidden;
        if let Some(token) = self.closing {
            self.timers.insert(token, (None, Timer::Closing));
        }
        if let Some(peers) = &relay.peers {
            self.read_peers(peers);
        }
    }

    fn restore(&mut self) {
        if self.ready || self.busy {
            return;
        }
        let Some((inner, account)) = self.inner.upgrade().zip(self.account.clone()) else {
            return;
        };
        match inner.store.saved_computers(&account) {
            Ok(record) => {
                if let Some(record) = record {
                    self.load(&record);
                }
                let ids: Vec<String> = self.saved.iter().map(|c| c.id.clone()).collect();
                for id in &ids {
                    self.remember(id);
                }
                if let Some(id) = self.saved_selected.clone() {
                    self.engine_select(&id);
                }
                self.ready = true;
            }
            Err(_) => {
                self.unreadable = true;
                self.set_error(CopyKey::SavedUnreadable);
                return;
            }
        }
        // A person who connected before reconnects on open; a first run waits
        // for an explicit tap.
        if !self.saved.is_empty() || self.had_legacy_setup() {
            self.find_computers();
        }
    }

    fn load(&mut self, record: &Value) {
        self.saved = record["computers"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .map(|row| Saved {
                        id: row["id"].as_str().unwrap_or_default().into(),
                        name: row["name"].as_str().unwrap_or_default().into(),
                        reconnect: row["reconnect"] == true,
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.saved_selected = record["selectedId"].as_str().map(String::from);
        self.credential = record["credential"].clone();
        self.creating_credential = record["creatingCredential"] == true;
        self.record_origin = Some(record["origin"].clone());
    }

    fn had_legacy_setup(&self) -> bool {
        !self.credential.is_null() || self.creating_credential
    }

    /// `_save`. Keeps the legacy-key fields the store holds now, which the
    /// cleanup may have cleared meanwhile.
    fn save(&mut self) -> Result<()> {
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(crate::bridge::shutdown_failure)?;
        let account = self
            .account
            .clone()
            .ok_or_else(|| Error::new("invalid_input"))?;
        let record = json!({
            "version": 1,
            "accountId": account,
            "origin": self.record_origin.clone().unwrap_or_else(|| json!(inner.origin)),
            "credential": self.credential,
            "creatingCredential": self.creating_credential,
            "selectedId": self.saved_selected,
            "computers": self.saved.iter().map(|c| json!({
                "id": c.id, "name": c.name, "reconnect": c.reconnect,
            })).collect::<Vec<_>>(),
        });
        let scope = self
            .scope
            .clone()
            .ok_or_else(|| Error::new("account_changed"))?;
        let saved = inner.in_scope(&scope, || {
            inner
                .store
                .put_saved_computers_keeping_credential(&account, &record)
        })?;
        self.credential = saved["credential"].clone();
        self.creating_credential = saved["creatingCredential"] == true;
        Ok(())
    }

    fn deny_access(&mut self, status: u16) {
        self.access_denied = true;
        self.access_status = Some(status);
        let retry = self.retry.take();
        self.timer_cancel(retry);
        self.set_error(if status == 401 {
            CopyKey::SignInExpired
        } else {
            CopyKey::AccessUnavailable
        });
    }

    fn reset_recovery(&mut self) {
        let ids: Vec<String> = self
            .saved
            .iter()
            .filter(|c| c.reconnect)
            .map(|c| c.id.clone())
            .collect();
        for id in ids {
            if let Some(link) = self.link_mut(&id) {
                link.recovery_expired = false;
            }
        }
    }

    fn find_computers(&mut self) {
        if self.busy || !self.foreground || !self.live() {
            return;
        }
        if !self.ready || self.unreadable {
            self.unreadable = false;
            self.restore();
            return;
        }
        // Automatic discovery stops at access denial. A tap or a foreground
        // resume rechecks once, picking up a renewed sign-in.
        if self.access_denied {
            self.access_denied = false;
            self.access_status = None;
            self.reset_recovery();
        }
        let retry = self.retry.take();
        self.timer_cancel(retry);
        self.busy = true;
        self.finding = true;
        self.error = None;
        self.cleanup_legacy_key();
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        self.flows += 1;
        let (epoch, flow) = (self.epoch, self.flows);
        self.flow = Flow::Discovering { flow };
        let (inbox, mut teardown) = (self.inbox.clone(), self.teardown.clone());
        tokio::spawn(async move {
            let _ = teardown.wait_for(|done| *done).await;
            let result = inner.discover().await;
            let _ = inbox.send(Msg::Discovered {
                epoch,
                flow,
                result,
            });
        });
    }

    fn cleanup_legacy_key(&mut self) {
        if self.cleanup_running || !self.had_legacy_setup() {
            return;
        }
        let Some((inner, account)) = self.inner.upgrade().zip(self.account.clone()) else {
            return;
        };
        self.cleanup_running = true;
        let (epoch, inbox) = (self.epoch, self.inbox.clone());
        tokio::spawn(async move {
            let cleared = match inner.auth.cleanup_legacy_key(&account).await {
                Ok(v) => v["cleared"] == true,
                // The recorded key stays for a later retry.
                Err(_) => false,
            };
            let _ = inbox.send(Msg::CleanupDone { epoch, cleared });
        });
    }

    fn discovered(&mut self, flow: u64, result: Result<RelaySnapshot>) {
        if !matches!(self.flow, Flow::Discovering { flow: f } if f == flow) {
            return;
        }
        if !self.foreground {
            return self.finish_discovery();
        }
        match result {
            Ok(relay) => {
                self.relay_seen = true;
                // A notice sent after the read (the relay closed or was
                // replaced meanwhile) already moved the relay on.
                if relay.seq >= self.relay_seq {
                    self.relay_seq = relay.seq;
                    self.relay_open = relay.peers.is_some();
                    match &relay.peers {
                        Some(peers) => {
                            self.read_peers(peers);
                        }
                        None => self.peers.clear(),
                    }
                }
                self.access_denied = false;
                self.access_status = None;
                let queue = self.saved.iter().map(|c| c.id.clone()).collect();
                self.flow = Flow::AutoConnect {
                    queue,
                    waiting: None,
                };
                self.auto_connect();
            }
            Err(e) => {
                match failures::access_status(&e) {
                    Some(status) => self.deny_access(status),
                    None => {
                        self.error = Some((NoticeCode::Transport, failures::discovery_failure(&e)));
                    }
                }
                self.finish_discovery();
            }
        }
    }

    /// The loop of `findComputers` that connects saved computers in turn.
    fn auto_connect(&mut self) {
        loop {
            let Flow::AutoConnect { queue, waiting } = &mut self.flow else {
                return;
            };
            if waiting.is_some() {
                return;
            }
            let Some(id) = queue.pop_front() else {
                break;
            };
            if !self.foreground {
                return self.finish_discovery();
            }
            let link = self.link(&id);
            let pinned = self
                .inner
                .upgrade()
                .and_then(|inner| inner.store.pin(&id).ok().flatten())
                .is_some();
            if self.saved_reconnect(&id) != Some(true)
                || link.is_some_and(|l| l.busy() || l.recovery_expired || l.online())
                || !pinned
                || !self.peers.get(&id).is_some_and(|p| p.accepts_control)
            {
                continue;
            }
            if let Some(rev) = self.connect_device(&id, false)
                && let Flow::AutoConnect { waiting, .. } = &mut self.flow
            {
                *waiting = Some((id, rev));
            }
        }
        if self
            .saved
            .iter()
            .all(|c| !c.reconnect || self.link(&c.id).is_some_and(Link::online))
        {
            self.attempt = 0;
        }
        self.finish_discovery();
    }

    fn finish_discovery(&mut self) {
        self.flow = Flow::Idle;
        self.busy = false;
        self.finding = false;
    }

    /// A computer's connect settled: continue the flow waiting on it.
    fn flow_settled(&mut self, id: &str, rev: u64) {
        match &mut self.flow {
            Flow::AutoConnect { waiting, .. }
                if waiting.as_ref().is_some_and(|(w, r)| w == id && *r == rev) =>
            {
                *waiting = None;
                self.auto_connect();
            }
            Flow::Connecting {
                id: target,
                waiting,
                ..
            } if target == id && *waiting == Some(rev) => self.finish_connect(),
            _ => {}
        }
    }

    /// `engine.connectDevice`: returns the connect to wait for, if one
    /// started.
    fn connect_device(&mut self, id: &str, select: bool) -> Option<u64> {
        if !self.foreground {
            return None;
        }
        self.remember(id);
        if select {
            self.engine_select(id);
        }
        let link = self.link(id)?;
        if link.online() || link.busy() {
            return None;
        }
        self.link_connect_with(id)
    }

    fn connect(&mut self, id: &str) {
        if self.busy || !self.foreground {
            return;
        }
        let Some(peer) = self.peers.get(id).filter(|p| p.accepts_control).cloned() else {
            self.set_error(CopyKey::ComputerUnavailable);
            return;
        };
        self.busy = true;
        self.connecting_id = Some(id.to_owned());
        self.error = None;
        let waiting = self.connect_device(id, true);
        self.flow = Flow::Connecting {
            id: id.to_owned(),
            name: peer.name,
            waiting,
        };
        if waiting.is_none() {
            self.finish_connect();
        }
    }

    fn finish_connect(&mut self) {
        let Flow::Connecting { id, name, .. } = std::mem::replace(&mut self.flow, Flow::Idle)
        else {
            return;
        };
        if self.foreground
            && self.connecting_id.as_deref() == Some(&id)
            && self.link(&id).is_some_and(Link::online)
        {
            match self.saved_index(&id) {
                Some(i) => {
                    self.saved[i].name = name;
                    self.saved[i].reconnect = true;
                }
                None => self.saved.push(Saved {
                    id: id.clone(),
                    name,
                    reconnect: true,
                }),
            }
            self.saved_selected = Some(id);
            if self.save().is_err() {
                self.set_error(CopyKey::SaveConnectionFailed);
            }
        }
        self.connecting_id = None;
        self.busy = false;
    }

    /// `engine.select`.
    fn engine_select(&mut self, id: &str) {
        if self.link(id).is_some() {
            self.selected = Some(id.to_owned());
        }
    }

    /// Selection is navigation: every session keeps running; only the next
    /// cold start's choice depends on the write.
    fn select(&mut self, id: &str) {
        if self.saved_index(id).is_none() {
            return;
        }
        self.engine_select(id);
        if self.saved_selected.as_deref() == Some(id) {
            return;
        }
        self.saved_selected = Some(id.to_owned());
        // The switch already took effect; a cold start reopens the prior one.
        let _ = self.save();
    }

    fn disconnect(&mut self, id: &str) {
        let Some(i) = self.saved_index(id) else {
            return;
        };
        // A handshake may finish while the intent write is pending. Its
        // completion must not overwrite this disconnect with reconnect=true.
        if self.connecting_id.as_deref() == Some(id) {
            self.connecting_id = None;
        }
        // Persist intent before closing: a cold start honors it.
        let before = self.saved[i].clone();
        self.saved[i].reconnect = false;
        match self.save() {
            Ok(()) => self.link_disconnect_and_clear(id),
            Err(_) => {
                self.saved[i] = before;
                self.set_error(CopyKey::SaveDisconnectFailed);
            }
        }
    }

    fn forget(&mut self, id: &str) {
        self.disconnect(id);
        if self.saved_reconnect(id) != Some(false) {
            return;
        }
        let forgot = self.forget_pin(id);
        let saved = forgot.and_then(|()| {
            self.saved.retain(|c| c.id != id);
            if self.saved_selected.as_deref() == Some(id) {
                self.saved_selected = None;
            }
            self.save()
        });
        if saved.is_err() {
            self.set_error(CopyKey::ForgetFailed);
        }
    }

    /// `hub.forget`: the pin and the computer's caches. The pin is the
    /// installation's, as Dart's hub keeps it: only a command of the scope
    /// that lasts removes it.
    fn forget_pin(&mut self, id: &str) -> Result<()> {
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(crate::bridge::shutdown_failure)?;
        let (scope, account) = self
            .scope
            .clone()
            .zip(self.account.clone())
            .ok_or_else(|| Error::new("account_changed"))?;
        inner.in_scope(&scope, || {
            inner.cache.clear_computer(&account, id);
            inner.store.forget_pin(id)
        })
    }

    /// `_schedule`: retries discovery with backoff while a saved computer
    /// that reconnects is not connected.
    fn schedule(&mut self) {
        if !self.live()
            || !self.foreground
            || self.busy
            || self.access_denied
            || self.unreadable
            || self.retry.is_some()
        {
            return;
        }
        let needs_discovery =
            self.relay_seen && !self.relay_open && self.saved.iter().any(|c| c.reconnect);
        let waiting = self.saved.iter().any(|c| {
            c.reconnect
                && self
                    .link(&c.id)
                    .is_none_or(|l| !l.online() && !l.busy() && !l.recovery_expired)
        });
        if !needs_discovery && !waiting {
            return;
        }
        let delay = policy::discovery_delay(self.attempt);
        self.attempt += 1;
        self.retry = Some(self.timer_start(None, Timer::DiscoveryRetry, delay));
    }

    // ---- Relay ----

    fn signal(&mut self, signal: Signal) {
        match signal {
            // A read of the relay already reflects it.
            Signal::Relay(seq, _) if seq <= self.relay_seq => {}
            Signal::Relay(seq, notice) => {
                self.relay_seq = seq;
                self.relay_notice(notice);
            }
            Signal::SessionClosed { computer } => self.link_closed(&computer),
            Signal::PairingCode { computer, code } => self.pairing_code(&computer, &code),
        }
    }

    fn relay_notice(&mut self, notice: RelayNotice) {
        match notice {
            RelayNotice::Opened(peers) => {
                self.relay_seen = true;
                self.relay_open = true;
                if self.account.is_some() {
                    let returned = self.read_peers(&peers);
                    self.retry_returned(returned);
                }
            }
            RelayNotice::Peers(peers) => {
                if self.account.is_some() && self.relay_open {
                    let returned = self.read_peers(&peers);
                    self.retry_returned(returned);
                }
            }
            RelayNotice::Closed(_) => {
                self.relay_open = false;
                self.peers.clear();
            }
        }
    }

    /// `_readPeers`: returns the saved computers that just became reachable.
    fn read_peers(&mut self, peers: &[Value]) -> Vec<String> {
        let mut next = BTreeMap::new();
        for peer in peers {
            if !cc_protocol::relay::is_computer(peer)
                || cc_protocol::relay::unreadable_peer(peer).is_some()
            {
                continue;
            }
            let id = peer["deviceId"].as_str().unwrap_or_default().to_owned();
            next.insert(
                id,
                Peer {
                    name: peer["name"].as_str().unwrap_or_default().into(),
                    accepts_control: peer["acceptsRemoteControl"] == true,
                },
            );
        }
        let returned: Vec<String> = next
            .iter()
            .filter(|(id, p)| {
                p.accepts_control
                    && !self.peers.get(*id).is_some_and(|old| old.accepts_control)
                    && self.saved_reconnect(id) == Some(true)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in &returned {
            if let Some(link) = self.link_mut(id) {
                link.recovery_expired = false;
            }
        }
        self.peers = next;
        returned
    }

    /// `_retryReturned`: a computer that comes back is retried now.
    fn retry_returned(&mut self, returned: Vec<String>) {
        let mut discover = false;
        for id in returned {
            let Some(link) = self.link(&id) else {
                continue;
            };
            if link.reconnecting() {
                self.link_retry_now(&id);
            } else if !link.busy() && !link.online() {
                discover = true;
            }
        }
        if discover && !self.busy && !self.access_denied && self.foreground {
            let retry = self.retry.take();
            self.timer_cancel(retry);
            self.find_computers();
        }
    }

    // ---- Lifecycle ----

    fn lifecycle(&mut self, state: AppLifecycle) {
        self.ui_foreground = state == AppLifecycle::Resumed;
        match state {
            AppLifecycle::Resumed => self.resume(),
            AppLifecycle::Hidden => self.suspend(),
            AppLifecycle::Inactive => {}
        }
    }

    /// Leaving briefly keeps the sessions; they close after the grace.
    fn suspend(&mut self) {
        if self.hidden {
            return;
        }
        self.hidden = true;
        // Sessions are already closed or closing.
        if !self.foreground {
            return;
        }
        self.hidden_at = Some(SystemTime::now());
        self.closing = Some(self.timer_start(None, Timer::Closing, policy::BACKGROUND_GRACE));
    }

    /// `_closeSessions`, then `engine.suspend`: every link suspends, then
    /// the relay and every session drop (`hub.disconnect`).
    fn close_sessions(&mut self, then: AfterClose) {
        self.foreground = false;
        let retry = self.retry.take();
        self.timer_cancel(retry);
        let ids: Vec<String> = self.links.iter().map(|(id, _)| id.clone()).collect();
        let stops: Vec<_> = ids.iter().filter_map(|id| self.link_suspend(id)).collect();
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        self.tokens += 1;
        let token = self.tokens;
        let (done, closed) = watch::channel(false);
        self.suspending = Some((token, then, closed));
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            for mut stop in stops {
                let _ = stop.wait_for(|d| *d).await;
            }
            inner.disconnect_all("suspended").await;
            let _ = done.send(true);
            let _ = inbox.send(Msg::Suspended { token });
        });
    }

    fn suspended(&mut self, token: u64) {
        let Some((current, then)) = self.suspending.as_ref().map(|(t, then, _)| (*t, *then)) else {
            return;
        };
        if current != token {
            return;
        }
        self.suspending = None;
        if then == AfterClose::Resume {
            // Hidden again while closing: stay closed until the next resume.
            if !self.hidden {
                self.foreground_resume();
            }
        } else if std::mem::take(&mut self.resume_links) && self.foreground {
            self.resume_engine();
        }
    }

    fn resume(&mut self) {
        // Returning gives foreground reconnection a fresh offline grace.
        self.offline_reset();
        self.hidden = false;
        let closing = self.closing.take();
        let hidden_at = self.hidden_at.take();
        if let (Some(closing), Some(hidden_at)) = (closing, hidden_at) {
            self.timer_cancel(Some(closing));
            // Timers stop while the OS suspends the app: measure the absence.
            let away = SystemTime::now()
                .duration_since(hidden_at)
                .unwrap_or_default();
            if away < policy::BACKGROUND_GRACE {
                self.reset_recovery();
                // The socket may have died silently, as on a network change.
                if self.relay_open
                    && let Some(inner) = self.inner.upgrade()
                {
                    self.flows += 1;
                    let (epoch, flow) = (self.epoch, self.flows);
                    let inbox = self.inbox.clone();
                    tokio::spawn(async move {
                        let _ = inner.relay_probe(Some(3000)).await;
                        let _ = inbox.send(Msg::Probed { epoch, flow });
                    });
                } else {
                    self.find_computers();
                }
                return;
            }
            self.close_sessions(AfterClose::Resume);
            return;
        }
        self.foreground_resume();
    }

    fn foreground_resume(&mut self) {
        self.foreground = true;
        self.reset_recovery();
        // `engine.resume` runs after the suspend in flight finished.
        if self.suspending.is_some() {
            self.resume_links = true;
        } else {
            self.resume_engine();
        }
    }

    fn resume_engine(&mut self) {
        let ids: Vec<String> = self.links.iter().map(|(id, _)| id.clone()).collect();
        for id in &ids {
            self.link_resume(id);
        }
        self.find_computers();
    }

    // ---- Offline banner and reconnect notice ----

    fn offline_reset(&mut self) {
        let timer = self.offline_timer.take();
        self.timer_cancel(timer);
        self.offline_computer = None;
        self.offline_online = false;
        self.offline = false;
    }

    /// `ComputerReconnectStatus.update` and each link's notice delay.
    fn update_offline(&mut self) {
        let computer = self
            .has_selected_computer()
            .then(|| self.selected.clone())
            .flatten();
        let online = self
            .selected
            .as_deref()
            .and_then(|id| self.link(id))
            .is_some_and(Link::online);
        if self.offline_computer != computer || self.offline_online != online {
            self.offline_reset();
            self.offline_computer = computer.clone();
            self.offline_online = online;
            if computer.is_some() && !online {
                self.offline_timer =
                    Some(self.timer_start(None, Timer::Offline, policy::OFFLINE_GRACE));
            }
        }
        let ui_foreground = self.ui_foreground;
        let ids: Vec<String> = self.links.iter().map(|(id, _)| id.clone()).collect();
        for id in ids {
            let Some(link) = self.link_mut(&id) else {
                continue;
            };
            if !ui_foreground || !link.reconnecting() {
                let timer = link.notice_timer.take();
                link.notice_visible = false;
                self.timer_cancel(timer);
            } else if !link.notice_visible && link.notice_timer.is_none() {
                let token =
                    self.timer_start(Some(&id), Timer::Notice, policy::RECONNECT_NOTICE_DELAY);
                if let Some(link) = self.link_mut(&id) {
                    link.notice_timer = Some(token);
                }
            }
        }
    }

    // ---- View ----

    fn selectable(&self, c: &Saved) -> bool {
        c.reconnect
            || self
                .link(&c.id)
                .is_some_and(|l| l.online() || l.reconnecting())
    }
    fn has_selected_computer(&self) -> bool {
        self.saved
            .iter()
            .any(|c| self.selectable(c) && self.selected.as_deref() == Some(&c.id))
    }

    fn setup_row(&self, id: &str, name: &str, saved: bool) -> SetupRow {
        let link = self.link(id);
        let busy = link.is_some_and(Link::busy);
        let status = if saved || busy {
            rules::setup_status(SetupInputs {
                phase: link.map(|l| l.phase),
                link_error: link.is_some_and(|l| l.error.is_some()),
                reconnect: self.saved_reconnect(id),
                access_denied: self.access_denied,
                listed: self.peers.contains_key(id),
                accepts_control: self.peers.get(id).is_some_and(|p| p.accepts_control),
            })
        } else {
            SetupStatus::ReadyToPair
        };
        SetupRow {
            computer_id: id.into(),
            name: name.into(),
            saved,
            reconnect: self.saved_reconnect(id) == Some(true),
            busy,
            label: copy::setup_status(status).into(),
            tone: status.tone(),
            pairing_code: link.and_then(|l| l.code.clone()),
        }
    }

    fn view(&self) -> AccountView {
        let mut available: Vec<(&String, &Peer)> = self
            .peers
            .iter()
            .filter(|(id, p)| p.accepts_control && self.saved_index(id).is_none())
            .collect();
        available.sort_by(|a, b| a.1.name.cmp(&b.1.name));
        let mut setup_rows: Vec<SetupRow> = self
            .saved
            .iter()
            .map(|c| self.setup_row(&c.id, &c.name, true))
            .collect();
        setup_rows.extend(
            available
                .iter()
                .map(|(id, p)| self.setup_row(id, &p.name, false)),
        );
        let available_on_relay = |id: &str| {
            self.relay_open
                .then(|| self.peers.get(id).is_some_and(|p| p.accepts_control))
        };
        let selected_link = self.selected.as_deref().and_then(|id| self.link(id));
        AccountView {
            revision: self.revision,
            binding: self.binding,
            ready: self.ready,
            busy: self.busy,
            finding: self.finding,
            access_denied: self.access_denied,
            access_status: self.access_status,
            discovered: self.relay_seen,
            offline: self.offline,
            error: self.error.as_ref().map(|(code, message)| Notice {
                code: *code,
                message: message.clone(),
            }),
            setup_notice: self
                .error
                .as_ref()
                .map(|(_, m)| m.clone())
                .or_else(|| selected_link.and_then(|l| l.error.clone())),
            selected: self.selected.clone(),
            selected_name: self
                .selected
                .as_deref()
                .and_then(|id| self.saved_index(id))
                .map(|i| self.saved[i].name.clone()),
            has_selected_computer: self.has_selected_computer(),
            saved: self
                .saved
                .iter()
                .map(|c| SavedComputerView {
                    computer_id: c.id.clone(),
                    name: c.name.clone(),
                    reconnect: c.reconnect,
                })
                .collect(),
            selectable: self
                .saved
                .iter()
                .filter(|c| self.selectable(c))
                .map(|c| c.id.clone())
                .collect(),
            connected: self
                .saved
                .iter()
                .filter(|c| {
                    self.link(&c.id)
                        .is_some_and(|l| l.online() || l.reconnecting())
                })
                .map(|c| c.id.clone())
                .collect(),
            setup_rows,
            switcher: self
                .saved
                .iter()
                .map(|c| {
                    let link = self.link(&c.id);
                    SwitcherRow {
                        computer_id: c.id.clone(),
                        name: link
                            .and_then(|l| l.host_name.clone())
                            .unwrap_or_else(|| c.name.clone()),
                        status: copy::switcher_status(rules::switcher_status(
                            link.map(|l| l.phase),
                            available_on_relay(&c.id),
                        ))
                        .into(),
                    }
                })
                .collect(),
            connections: self
                .links
                .iter()
                .map(|(id, l)| ConnectionView {
                    computer_id: id.clone(),
                    phase: l.phase,
                    pairing_code: l.code.clone(),
                    host_name: l.host_name.clone(),
                    error: l.error.clone(),
                    can_reconnect: l.target,
                    recovery_expired: l.recovery_expired,
                    reconnect_notice_visible: l.notice_visible,
                    session: l.sessions,
                })
                .collect(),
        }
    }
}

fn notice_code(key: CopyKey) -> NoticeCode {
    match key {
        CopyKey::SavedUnreadable => NoticeCode::SavedUnreadable,
        CopyKey::SignInExpired => NoticeCode::SignInExpired,
        CopyKey::AccessUnavailable => NoticeCode::AccessUnavailable,
        CopyKey::DiscoveryFailed => NoticeCode::Transport,
        CopyKey::ComputerUnavailable => NoticeCode::ComputerUnavailable,
        CopyKey::SaveConnectionFailed => NoticeCode::SaveFailed,
        CopyKey::SaveDisconnectFailed => NoticeCode::SaveFailed,
        CopyKey::ForgetFailed => NoticeCode::ForgetFailed,
    }
}

//! The selected computer's provider usage: which computer to read, the
//! serialized usage reads and their generation checks, pushes, the retry
//! backoff, refreshes and their failures. Ported from
//! `computer_connect/provider_usage_source.dart` and
//! `lib/device_link/provider_usage/repository.dart`; comments cite the Dart
//! rule they keep. The projection itself is `cc_domain::usage`.
//!
//! One actor task owns the state by value. The account's view (selection,
//! each computer's phase and session count), the usage pushes of every
//! computer (from the push fan-out, `crate::push`), the replies to the reads
//! it sends, timer fires and intents arrive on one inbox. Replies and pushes of one session
//! are sent from that session's task in wire order, so they apply in the
//! order Dart sees them. A read that was superseded or belongs to an
//! earlier generation still runs to its end on the desktop, as Dart's does,
//! and is then ignored.
use crate::{
    account::Scope,
    api::{
        AccountView, OpenCodeAccount, OpenCodeAccountUsage, OpenCodeAccounts, OpenCodeProvider,
        OpenCodeUsageWindow, ProviderUsage, RefreshFailure, UsageAccount, UsageCredits,
        UsageDelivery, UsageError, UsageProjection, UsageSpend, UsageView, UsageWindow,
    },
    bridge::Inner,
    chats::Peer,
    copy::usage::{self as copy, CopyKey},
    error::{Error, Result},
    ports::Responder,
    push::{self, Delivery, Filter},
};
use cc_domain::{
    computers::LinkPhase,
    dart::{self, Dv, DvMap},
    usage::{self as rules, Projection, Provider, has_newer_usage, policy, serves_usage_proxy},
};
use cc_protocol::{FailureKind, dto::desktop_value};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::{
    runtime::Handle as Runtime,
    sync::{mpsc, oneshot, watch},
};

/// The pushes the usage reads depend on.
const PUSHES: [&str; 3] = [
    "observability:event",
    "account-proxy:changed",
    "preferences:changed",
];

pub(crate) enum Msg {
    Account(Arc<AccountView>),
    /// A usage push of some computer's session.
    Push(push::Push),
    /// Pushes were dropped (the fan-out's bound): read again.
    Lagged(Delivery),
    Reply {
        request: u64,
        result: Result<Value>,
    },
    Retry {
        token: u64,
    },
    Refresh {
        provider: Provider,
        reply: oneshot::Sender<Arc<UsageView>>,
    },
}

/// The service's handle: its inbox and published view.
#[derive(Clone)]
pub(crate) struct Handle {
    inbox: mpsc::UnboundedSender<Msg>,
    view: watch::Receiver<Arc<UsageView>>,
    /// The usage pushes; the service lives as long as the core.
    _pushes: Arc<push::Subscription>,
}

impl Handle {
    pub(crate) fn start(
        inner: &Arc<Inner>,
        mut account: watch::Receiver<Arc<AccountView>>,
        runtime: &Runtime,
    ) -> Self {
        let (inbox, rx) = mpsc::unbounded_channel();
        let actor = Actor::new(Arc::downgrade(inner), inbox.clone());
        let (publish, view) = watch::channel(Arc::new(actor.view(0)));
        let pushes = inbox.clone();
        // Every computer: the actor keeps the selected one's. A push whose
        // channel is not a string passes, so the actor applies Dart's
        // checks to it.
        let subscription = inner.pushes.subscribe(
            Filter {
                computer: None,
                channels: &PUSHES,
                unreadable: true,
                sessions: false,
            },
            Box::new(move |delivery| {
                pushes
                    .send(match delivery {
                        Delivery::Push(push) => Msg::Push(push),
                        other => Msg::Lagged(other),
                    })
                    .is_ok()
            }),
        );
        // The account's selection and phases, latest wins.
        let selection = inbox.clone();
        runtime.spawn(async move {
            loop {
                let view = account.borrow_and_update().clone();
                if selection.send(Msg::Account(view)).is_err() || account.changed().await.is_err() {
                    return;
                }
            }
        });
        runtime.spawn(actor.run(rx, publish));
        Self {
            inbox,
            view,
            _pushes: Arc::new(subscription),
        }
    }
    pub(crate) fn view(&self) -> watch::Receiver<Arc<UsageView>> {
        self.view.clone()
    }
    /// Resolves with the view once the refresh settled.
    pub(crate) async fn refresh(&self, provider: Provider) -> Result<Arc<UsageView>> {
        let (reply, rx) = oneshot::channel();
        self.inbox
            .send(Msg::Refresh { provider, reply })
            .map_err(|_| crate::bridge::shutdown_failure())?;
        rx.await.map_err(|_| crate::bridge::shutdown_failure())
    }
}

/// `usageObject(value)`: the value when it is a map, else `{}`.
fn object(value: Dv) -> Dv {
    if value.is_map() {
        value
    } else {
        Dv::Map(DvMap::new())
    }
}

/// `DeviceProviderUsageRepository`: one session's observations. Replaced
/// whenever the generation changes, so a late reply never crosses a
/// session boundary.
struct Repo {
    overview: Option<Dv>,
    proxy: Dv,
    preferences: Dv,
    ready: bool,
    load_revision: u64,
    usage_revision: u64,
    proxy_revision: u64,
}

impl Repo {
    fn new() -> Self {
        Self {
            overview: None,
            proxy: object(Dv::Null),
            preferences: object(Dv::Null),
            ready: false,
            load_revision: 0,
            usage_revision: 0,
            proxy_revision: 0,
        }
    }
    /// `projection`: `None` until a read completed; `Err` when it throws.
    fn projection(&self) -> std::result::Result<Option<Projection>, rules::Malformed> {
        match (&self.overview, self.ready) {
            (Some(overview), true) => {
                rules::project(overview, &self.proxy, &self.preferences).map(Some)
            }
            _ => Ok(None),
        }
    }
    /// `applyPush`: pushes carry the same cached observations as a read.
    fn apply_push(&mut self, push: &DvMap) -> bool {
        let Some(args) = push.get("args").elements() else {
            return false;
        };
        let Some(first) = args.first() else {
            return false;
        };
        let value = object((*first).clone());
        match push.get("channel").as_str() {
            Some("observability:event") => {
                if !value.get("type").is_str("usage") || !value.get("usage").is_map() {
                    return false;
                }
                self.overview = Some(object(value.get("usage").clone()));
                self.usage_revision += 1;
            }
            Some("account-proxy:changed") => {
                self.proxy = value;
                self.proxy_revision += 1;
            }
            _ => return false,
        }
        true
    }
}

#[derive(Clone, Copy)]
enum Read {
    Proxy,
    Preferences,
    Snapshot,
}

/// One `_load`: its three serialized reads (`repository.dart` `load`).
struct Load {
    computer: String,
    generation: u64,
    read_revision: u64,
    load_revision: u64,
    usage_revision: u64,
    proxy_revision: u64,
    proxy: Dv,
    preferences: Dv,
    /// The refresh that awaits this read.
    then: Option<Refresh>,
}

/// One `refresh(provider)` call.
struct Refresh {
    provider: Provider,
    generation: u64,
    previous: Option<Arc<Projection>>,
    reply: oneshot::Sender<Arc<UsageView>>,
}

enum Pending {
    Load(Load, Read),
    Refresh(Refresh),
}

/// Why a read failed.
enum Failure {
    Rpc(Error),
    Malformed,
}

struct Actor {
    inner: Weak<Inner>,
    inbox: mpsc::UnboundedSender<Msg>,
    computer: Option<String>,
    phase: Option<LinkPhase>,
    online: bool,
    /// The selected computer's session count while it is online.
    session: Option<u64>,
    scope: u64,
    /// The account scope current when the generation began: its reads
    /// reach only a session of that scope, never one another account
    /// opened on the computer before the selection follows it.
    account_scope: Option<Scope>,
    generation: u64,
    read_revision: u64,
    attempt: u32,
    loaded_generation: Option<u64>,
    pending_reads: i64,
    /// The active retry timer and the generation it reads for.
    retry: Option<(u64, u64)>,
    tokens: u64,
    requests: u64,
    pending: HashMap<u64, Pending>,
    repo: Option<Repo>,
    projection: Option<Arc<Projection>>,
    shown: Option<UsageProjection>,
    refreshing: BTreeSet<Provider>,
    failures: BTreeMap<Provider, CopyKey>,
    /// Refresh callers to answer after this message's view is published.
    done: Vec<oneshot::Sender<Arc<UsageView>>>,
}

impl Actor {
    fn new(inner: Weak<Inner>, inbox: mpsc::UnboundedSender<Msg>) -> Self {
        Self {
            inner,
            inbox,
            computer: None,
            phase: None,
            online: false,
            session: None,
            scope: 0,
            account_scope: None,
            generation: 0,
            read_revision: 0,
            attempt: 0,
            loaded_generation: None,
            pending_reads: 0,
            retry: None,
            tokens: 0,
            requests: 0,
            pending: HashMap::new(),
            repo: None,
            projection: None,
            shown: None,
            refreshing: BTreeSet::new(),
            failures: BTreeMap::new(),
            done: Vec::new(),
        }
    }

    async fn run(
        mut self,
        mut rx: mpsc::UnboundedReceiver<Msg>,
        publish: watch::Sender<Arc<UsageView>>,
    ) {
        let mut current = publish.borrow().clone();
        while let Some(msg) = rx.recv().await {
            self.apply(msg);
            let next = self.view(current.revision);
            if next != *current {
                current = Arc::new(self.view(current.revision + 1));
                publish.send_replace(current.clone());
            }
            for reply in self.done.drain(..) {
                let _ = reply.send(current.clone());
            }
        }
    }

    fn apply(&mut self, msg: Msg) {
        match msg {
            Msg::Account(view) => self.follow(&view),
            Msg::Push(push) => self.message(&push.computer, &push.message),
            Msg::Lagged(Delivery::Lagged { computer, .. }) => self.lagged(&computer),
            Msg::Lagged(_) => {}
            Msg::Reply { request, result } => match self.pending.remove(&request) {
                Some(Pending::Load(load, read)) => self.read(load, read, result),
                Some(Pending::Refresh(refresh)) => self.refreshed(refresh, result),
                None => {}
            },
            Msg::Retry { token } => {
                if let Some((active, generation)) = self.retry
                    && active == token
                {
                    self.retry = None;
                    self.load(generation, None);
                }
            }
            Msg::Refresh { provider, reply } => self.refresh(provider, reply),
        }
    }

    fn view(&self, revision: u64) -> UsageView {
        UsageView {
            revision,
            scope: self.scope,
            computer_id: self.computer.clone(),
            available: self.available(),
            delivery: match self.phase {
                Some(LinkPhase::Connected) => UsageDelivery::Live,
                Some(LinkPhase::Reconnecting | LinkPhase::Connecting) => {
                    UsageDelivery::Reconnecting
                }
                _ => UsageDelivery::Unreachable,
            },
            projection: self.shown.clone(),
            refreshing: self.refreshing.iter().copied().collect(),
            failures: self
                .failures
                .iter()
                .map(|(provider, key)| RefreshFailure {
                    provider: *provider,
                    message: copy::text(*key).to_owned(),
                })
                .collect(),
        }
    }

    /// `isAvailable`.
    fn available(&self) -> bool {
        self.online && self.loaded_generation == Some(self.generation) && self.projection.is_some()
    }

    /// `_current(generation)`.
    fn current(&self, generation: u64) -> bool {
        self.online && generation == self.generation
    }

    fn set_projection(&mut self, projection: Option<Projection>) {
        self.shown = projection.as_ref().map(render);
        self.projection = projection.map(Arc::new);
    }

    // ---- Following the selected computer (`_changed`) ----

    fn follow(&mut self, view: &AccountView) {
        let selected = view.selected.clone();
        let connection = selected
            .as_ref()
            .and_then(|id| view.connections.iter().find(|c| c.computer_id == *id));
        self.phase = connection.map(|c| c.phase);
        let online = self.phase == Some(LinkPhase::Connected);
        // Views coalesce: a connected view with another session count is a
        // new session even when no other phase was seen between them.
        let session = connection.filter(|_| online).map(|c| c.session);
        let changed = selected != self.computer;
        if !changed && online == self.online && session == self.session {
            return;
        }
        self.session = session;
        self.generation += 1;
        self.account_scope = self.inner.upgrade().map(|inner| inner.scope());
        self.pending_reads = 0;
        self.retry = None;
        self.attempt = 0;
        self.refreshing.clear();
        self.failures.clear();
        if changed {
            self.computer = selected;
            self.scope += 1;
            self.set_projection(None);
        }
        // A reconnect can finish while an old read is still settling; its
        // observations must not replace this session's.
        self.repo = (online && self.computer.is_some()).then(Repo::new);
        self.online = online;
        if online {
            self.load(self.generation, None);
        }
    }

    // ---- Reads ----

    /// Sends one usage read to `computer`; its reply arrives as `Msg::Reply`.
    fn request(
        &mut self,
        computer: &str,
        channel: &str,
        args: Vec<Value>,
        limit: Duration,
        pending: Pending,
    ) {
        self.requests += 1;
        let request = self.requests;
        self.pending.insert(request, pending);
        let inbox = self.inbox.clone();
        let reply = Responder::new(move |result| {
            let _ = inbox.send(Msg::Reply { request, result });
        });
        let sent = match (self.inner.upgrade(), &self.account_scope) {
            (Some(inner), Some(scope)) => inner.invoke(
                &Peer::main(computer.to_owned(), scope.clone()),
                channel,
                args,
                limit,
                reply,
            ),
            _ => Err(crate::bridge::shutdown_failure()),
        };
        if let Err(error) = sent {
            // Answered after this message, as the Dart call fails async.
            let _ = self.inbox.send(Msg::Reply {
                request,
                result: Err(error),
            });
        }
    }

    /// `_load(generation)`. A refresh in `then` learns whether it delivered.
    fn load(&mut self, generation: u64, then: Option<Refresh>) {
        let (Some(repo), Some(computer)) = (self.repo.as_mut(), self.computer.clone()) else {
            if let Some(refresh) = then {
                self.loaded(refresh, false);
            }
            return;
        };
        if !(self.online && generation == self.generation) {
            if let Some(refresh) = then {
                self.loaded(refresh, false);
            }
            return;
        }
        self.pending_reads += 1;
        self.read_revision += 1;
        repo.load_revision += 1;
        let load = Load {
            computer: computer.clone(),
            generation,
            read_revision: self.read_revision,
            load_revision: repo.load_revision,
            usage_revision: repo.usage_revision,
            proxy_revision: repo.proxy_revision,
            proxy: Dv::Null,
            preferences: Dv::Null,
            then,
        };
        // Serialized, to leave room for chat hydration on the same link.
        self.request(
            &computer,
            "account-proxy:status",
            Vec::new(),
            policy::READ_TIMEOUT,
            Pending::Load(load, Read::Proxy),
        );
    }

    fn read(&mut self, mut load: Load, read: Read, result: Result<Value>) {
        // Another session's read sends nothing more: the next read would
        // reach the session now open, as Dart's ended repository could not.
        if !self.current(load.generation) {
            return self.load_done(load, false);
        }
        let value = match result {
            Ok(value) => object(desktop_value(&value)),
            Err(error) => return self.load_failed(load, &Failure::Rpc(error)),
        };
        let computer = load.computer.clone();
        match read {
            Read::Proxy => {
                load.proxy = value;
                self.request(
                    &computer,
                    "preferences:load",
                    Vec::new(),
                    policy::READ_TIMEOUT,
                    Pending::Load(load, Read::Preferences),
                );
            }
            Read::Preferences => {
                load.preferences = value;
                self.request(
                    &computer,
                    "observability:load-snapshot",
                    Vec::new(),
                    policy::READ_TIMEOUT,
                    Pending::Load(load, Read::Snapshot),
                );
            }
            Read::Snapshot => self.snapshot(load, &value),
        }
    }

    /// The end of `repository.load`, then of `_load`.
    fn snapshot(&mut self, load: Load, snapshot: &Dv) {
        let current = self.current(load.generation);
        let repo = match self.repo.as_mut() {
            Some(repo) if current => repo,
            // Another session's read: Dart's `_load` returns false.
            _ => return self.load_done(load, false),
        };
        // A push during the reads is newer than the snapshot.
        let overview = if load.usage_revision == repo.usage_revision {
            object(snapshot.get("usage").clone())
        } else {
            repo.overview.clone().unwrap_or(Dv::Null)
        };
        let proxy = if load.proxy_revision == repo.proxy_revision {
            load.proxy.clone()
        } else {
            repo.proxy.clone()
        };
        let projection = match rules::project(&overview, &proxy, &load.preferences) {
            Ok(projection) => projection,
            Err(rules::Malformed) => return self.load_failed(load, &Failure::Malformed),
        };
        if load.load_revision == repo.load_revision {
            repo.overview = Some(overview);
            repo.proxy = proxy;
            repo.preferences = load.preferences.clone();
            repo.ready = true;
        }
        // Another provider's newer read owns publication. Superseding this
        // read does not mean its provider refresh failed.
        if load.read_revision == self.read_revision {
            self.clear_recovered(&projection);
            self.set_projection(Some(projection));
            self.loaded_generation = Some(load.generation);
            self.attempt = 0;
            self.retry = None;
        }
        self.pending_reads -= 1;
        self.load_done(load, true);
    }

    fn load_failed(&mut self, load: Load, failure: &Failure) {
        if !self.current(load.generation) {
            return self.load_done(load, false);
        }
        if load.read_revision != self.read_revision {
            self.pending_reads -= 1;
            return self.load_done(load, true);
        }
        let unavailable = matches!(failure, Failure::Rpc(e)
            if e.kind == FailureKind::Refused && e.code == "remote_channel_unavailable");
        if !unavailable && self.attempt < policy::MAX_RETRIES {
            let delay = policy::retry_delay(self.attempt);
            self.attempt += 1;
            self.tokens += 1;
            let token = self.tokens;
            self.retry = Some((token, load.generation));
            let inbox = self.inbox.clone();
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                let _ = inbox.send(Msg::Retry { token });
            });
        }
        self.pending_reads -= 1;
        self.load_done(load, false);
    }

    fn load_done(&mut self, load: Load, delivered: bool) {
        if let Some(refresh) = load.then {
            self.loaded(refresh, delivered);
        }
    }

    // ---- Pushes (`_event`) ----

    fn message(&mut self, computer: &str, message: &Value) {
        if !self.online || self.computer.as_deref() != Some(computer) {
            return;
        }
        let event = desktop_value(message);
        if !event.get("name").is_str("ipc.push") {
            return;
        }
        let payload = event.get("payload");
        // The main surface's pushes only.
        let surface = payload.get("surface");
        if payload.is_map() && !surface.is_null() && !surface.is_str("main") {
            return;
        }
        let push = payload.object();
        let generation = self.generation;
        let Some(repo) = self.repo.as_mut() else {
            return;
        };
        // Preferences pushes are payloadless invalidations: the native or
        // proxy route may have changed.
        if push.get("channel").is_str("preferences:changed") {
            repo.ready = false;
            self.loaded_generation = None;
            return self.load(generation, None);
        }
        if !repo.apply_push(push) {
            return;
        }
        match repo.projection() {
            Ok(Some(projection)) => {
                self.clear_recovered(&projection);
                self.set_projection(Some(projection));
                self.loaded_generation = Some(generation);
            }
            // A later observation can recover a session whose initial reads
            // exhausted their retries. Bursts join an active read or backoff.
            Ok(None) => {
                if self.pending_reads == 0 && self.retry.is_none() {
                    self.load(generation, None);
                }
            }
            // A newer host's unsupported data must not end the connection.
            Err(rules::Malformed) => self.load(generation, None),
        }
    }

    /// Usage pushes of `computer` were dropped: read again, as after a
    /// preferences invalidation.
    fn lagged(&mut self, computer: &str) {
        if !self.online || self.computer.as_deref() != Some(computer) {
            return;
        }
        let generation = self.generation;
        if let Some(repo) = self.repo.as_mut() {
            repo.ready = false;
            self.loaded_generation = None;
            self.load(generation, None);
        }
    }

    // ---- Refresh ----

    fn refresh(&mut self, provider: Provider, reply: oneshot::Sender<Arc<UsageView>>) {
        if !self.available() || self.repo.is_none() || self.refreshing.contains(&provider) {
            self.done.push(reply);
            return;
        }
        self.refreshing.insert(provider);
        self.failures.remove(&provider);
        let refresh = Refresh {
            provider,
            generation: self.generation,
            previous: self.projection.clone(),
            reply,
        };
        let (Some(repo), Some(computer)) = (self.repo.as_ref(), self.computer.clone()) else {
            return self.loaded(refresh, false);
        };
        if !repo.ready {
            return self.loaded(refresh, false);
        }
        let (channel, args) = match serves_usage_proxy(provider, &repo.proxy, &repo.preferences) {
            Ok(true) => ("account-proxy:status", vec![json!({"refreshUsage": true})]),
            Ok(false) => ("observability:refresh-usage", vec![json!(provider.wire())]),
            Err(rules::Malformed) => return self.loaded(refresh, false),
        };
        self.request(
            &computer,
            channel,
            args,
            policy::REFRESH_TIMEOUT,
            Pending::Refresh(refresh),
        );
    }

    fn refreshed(&mut self, refresh: Refresh, result: Result<Value>) {
        match result {
            Ok(_) if self.current(refresh.generation) => {
                let generation = refresh.generation;
                self.load(generation, Some(refresh));
            }
            Ok(_) => self.finish(refresh),
            Err(_) => self.loaded(refresh, false),
        }
    }

    /// A refresh's read settled; `delivered` is `_load`'s result.
    fn loaded(&mut self, refresh: Refresh, delivered: bool) {
        // A delivered usage observation is authoritative even when its RPC
        // acknowledgement is late or lost. Never expose raw transport errors.
        if !delivered
            && self.current(refresh.generation)
            && !has_newer_usage(
                refresh.previous.as_deref(),
                self.projection.as_deref(),
                refresh.provider,
            )
        {
            self.failures
                .insert(refresh.provider, CopyKey::RefreshFailed);
        }
        self.finish(refresh);
    }

    fn finish(&mut self, refresh: Refresh) {
        if self.current(refresh.generation) {
            self.refreshing.remove(&refresh.provider);
        }
        self.done.push(refresh.reply);
    }

    /// `_clearRecoveredFailures(next)`.
    fn clear_recovered(&mut self, next: &Projection) {
        let current = self.projection.clone();
        self.failures
            .retain(|provider, _| !has_newer_usage(current.as_deref(), Some(next), *provider));
    }
}

// ---- Rendering ----

fn iso(at: Option<dart::Micros>) -> Option<String> {
    at.map(dart::iso8601)
}

fn error(error: Option<rules::UsageError>) -> Option<UsageError> {
    error.map(|e| UsageError {
        kind: e.kind,
        message: copy::error_message(e),
    })
}

fn windows(windows: &[rules::Window]) -> Vec<UsageWindow> {
    windows
        .iter()
        .map(|w| UsageWindow {
            id: w.id.clone(),
            label: copy::window_label(&w.label, w.unlimited == Some(true)),
            unlimited: w.unlimited,
            used_percent: w.used_percent,
            resets_at: iso(w.resets_at),
            window_duration_ms: w.window_duration_ms,
            credits: w.credits.as_ref().map(|c| UsageCredits {
                unit: c.unit,
                spent: c.spent,
                remaining: c.remaining,
                total: c.total,
            }),
            spend: w.spend.as_ref().map(|s| UsageSpend {
                currency: s.currency.clone(),
                is_enabled: s.is_enabled,
                limit: s.limit,
                used: s.used,
            }),
        })
        .collect()
}

fn open_code(accounts: &rules::OpenCodeAccounts) -> OpenCodeAccounts {
    OpenCodeAccounts {
        providers: accounts
            .providers
            .iter()
            .map(|p| OpenCodeProvider {
                accounts: p
                    .accounts
                    .iter()
                    .map(|a| OpenCodeAccount {
                        label: a.label.clone(),
                        method: a.method,
                        needs_sign_in: a.needs_sign_in,
                        selected: a.selected,
                        usage: a.usage.as_ref().map(|u| OpenCodeAccountUsage {
                            checked_at: u.checked_at.clone(),
                            plan: u.plan.clone(),
                            status: u.status.clone(),
                            windows: u.windows.as_ref().map(|windows| {
                                windows
                                    .iter()
                                    .map(|w| OpenCodeUsageWindow {
                                        id: w.id.clone(),
                                        percent: w.percent,
                                        resets_at: w.resets_at.clone(),
                                    })
                                    .collect()
                            }),
                        }),
                    })
                    .collect(),
                id: p.id.clone(),
                name: p.name.clone(),
            })
            .collect(),
        status: accounts.status.clone(),
        updated_at: accounts.updated_at.clone(),
    }
}

/// The projection with its labels and messages worded.
fn render(projection: &Projection) -> UsageProjection {
    UsageProjection {
        updated_at: projection.updated_at.clone(),
        open_code_accounts: projection.open_code.as_ref().map(open_code),
        providers: projection
            .providers
            .iter()
            .map(|e| ProviderUsage {
                provider: e.provider,
                auth_state: e.auth_state,
                account_email: e.account_email.clone(),
                account_label: e.account_label.clone(),
                plan_label: e.plan_label.clone(),
                last_updated_at: iso(e.last_updated_at),
                error: error(e.error),
                windows: windows(&e.windows),
                accounts: e.accounts.as_ref().map(|accounts| {
                    accounts
                        .iter()
                        .map(|a| UsageAccount {
                            id: a.id.clone(),
                            label: a.label.clone(),
                            plan_label: a.plan.as_ref().map(copy::plan_label),
                            status: a.status,
                            available_at: iso(a.available_at),
                            usage_source: a.usage_source,
                            last_updated_at: iso(a.last_updated_at),
                            retry_at: iso(a.retry_at),
                            error: error(a.error),
                            windows: windows(&a.windows),
                        })
                        .collect()
                }),
            })
            .collect(),
    }
}

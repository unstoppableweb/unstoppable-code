//! The signed-in account the relay, sessions and caches belong to, and the
//! account scope each service is started in.
use crate::{
    bridge::{Inner, Taken, shutdown_failure},
    error::{Error, Result},
    ports::{AuthSession, BoxFuture, SignInStep, SignedIn},
};
use futures_util::{FutureExt, future::join_all};
use std::{
    collections::VecDeque,
    future::Future,
    sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::timeout,
};

fn left() -> Error {
    Error::new("account_changed")
}

/// One account scope: its number and the account it belongs to.
pub(crate) struct Epoch {
    n: u64,
    /// The signed-in account (`None`: signed out), fixed when the scope
    /// begins or the first time the core observes a sign-in in it, and
    /// never changed: another account begins another scope. Unset while
    /// unknown.
    account: OnceLock<Option<String>>,
}

impl Epoch {
    pub(crate) fn new(n: u64, account: Option<Option<String>>) -> Arc<Self> {
        let cell = OnceLock::new();
        if let Some(account) = account {
            let _ = cell.set(account);
        }
        Arc::new(Self { n, account: cell })
    }
}

/// The account a service was started in. The scope ends when the core
/// leaves that account (another account signed in, or signed out): from
/// then on the service's handles refuse intents, its views read nothing
/// and its actor closes, dropping what it cached.
#[derive(Clone)]
pub(crate) struct Scope {
    epoch: Arc<Epoch>,
    /// `None` for a service of the whole core, whose scope never ends.
    current: Option<watch::Receiver<Arc<Epoch>>>,
}

impl std::fmt::Debug for Scope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Scope").field(&self.epoch.n).finish()
    }
}

impl Scope {
    /// The scope of a service that outlives accounts (it follows the
    /// account service instead).
    pub(crate) fn unbound() -> Self {
        Self {
            epoch: Epoch::new(0, None),
            current: None,
        }
    }
    pub(crate) fn live(&self) -> bool {
        self.current
            .as_ref()
            .is_none_or(|current| current.borrow().n == self.epoch.n)
    }
    /// Whether `other` is the same account scope.
    pub(crate) fn same(&self, other: &Scope) -> bool {
        self.epoch.n == other.epoch.n
    }
    pub(crate) fn check(&self) -> Result<()> {
        if self.live() { Ok(()) } else { Err(left()) }
    }
    /// Runs `work` for this scope: refused once the scope ended, and its
    /// result dropped (`account_changed`) when the scope ended before it
    /// completed, so nothing a left account read or did reaches the caller
    /// as the current account's.
    pub(crate) fn within<T, F>(&self, work: F) -> impl Future<Output = Result<T>> + use<T, F>
    where
        F: Future<Output = Result<T>>,
    {
        let scope = self.clone();
        async move {
            scope.check()?;
            let result = work.await;
            scope.check()?;
            result
        }
    }
    /// The account whose records the scope's services read and write, also
    /// after the scope ended; never another account's, whatever auth
    /// reports meanwhile. `None` while the core has not observed a sign-in
    /// in the scope, once signed out, and for an unbound scope: records
    /// then stay in memory.
    pub(crate) fn account(&self) -> Option<String> {
        self.epoch.account.get().cloned().flatten()
    }
    /// Completes once the scope ended; never for an unbound one.
    pub(crate) fn ended(&self) -> impl Future<Output = ()> + Send + 'static {
        let (current, epoch) = (self.current.clone(), self.epoch.n);
        async move {
            if let Some(mut current) = current
                && current.wait_for(|e| e.n != epoch).await.is_ok()
            {
                return;
            }
            std::future::pending::<()>().await;
        }
    }
}

/// A service's published snapshots, read only while its scope lasts.
pub(crate) struct View<T> {
    rx: watch::Receiver<Arc<T>>,
    scope: Scope,
}

impl<T> Clone for View<T> {
    fn clone(&self) -> Self {
        Self {
            rx: self.rx.clone(),
            scope: self.scope.clone(),
        }
    }
}

impl<T> View<T> {
    pub(crate) fn new(rx: watch::Receiver<Arc<T>>, scope: Scope) -> Self {
        Self { rx, scope }
    }
    pub(crate) fn scope(&self) -> &Scope {
        &self.scope
    }
    /// The latest snapshot; `None` once the scope ended.
    pub(crate) fn current(&self) -> Option<Arc<T>> {
        self.scope.live().then(|| self.rx.borrow().clone())
    }
    /// The latest snapshot, marked seen; `None` once the scope ended.
    pub(crate) fn latest(&mut self) -> Option<Arc<T>> {
        self.scope
            .live()
            .then(|| self.rx.borrow_and_update().clone())
    }
    /// Waits for a snapshot not yet seen; fails once the service stopped
    /// or the scope ended.
    pub(crate) async fn changed(&mut self) -> Result<()> {
        tokio::select! {
            biased;
            () = self.scope.ended() => Err(left()),
            changed = self.rx.changed() => changed.map_err(|_| shutdown_failure()),
        }
    }
}

/// A service actor's inbox. Once the scope ended, the actor's own close
/// message comes first, before anything still queued, except the queued
/// messages the actor keeps.
pub(crate) struct Inbox<M> {
    rx: mpsc::UnboundedReceiver<M>,
    scope: Option<Scope>,
    keep: Option<fn(&M) -> bool>,
    /// The kept messages, then the close.
    closing: VecDeque<M>,
}

impl<M> Inbox<M> {
    pub(crate) fn new(rx: mpsc::UnboundedReceiver<M>, scope: Scope) -> Self {
        Self {
            rx,
            scope: Some(scope),
            keep: None,
            closing: VecDeque::new(),
        }
    }
    /// Once the scope ended, the messages `keep` selects of those already
    /// queued still come, in order, before the close: what they save
    /// belongs to the account the actor started in, which it still names.
    pub(crate) fn keeping(mut self, keep: fn(&M) -> bool) -> Self {
        self.keep = Some(keep);
        self
    }
    /// Whether the scope lasts.
    pub(crate) fn live(&self) -> bool {
        self.scope.as_ref().is_some_and(Scope::live)
    }
    /// The next message; `close()` once, when the scope ended.
    pub(crate) async fn recv(&mut self, close: impl FnOnce() -> M) -> Option<M> {
        if let Some(msg) = self.closing.pop_front() {
            return Some(msg);
        }
        let Some(scope) = &self.scope else {
            return self.rx.recv().await;
        };
        let ended = scope.ended();
        tokio::select! {
            biased;
            () = ended => {
                self.scope = None;
                if let Some(keep) = self.keep {
                    // Only what is queued now: nothing later is awaited.
                    for _ in 0..self.rx.len() {
                        let Ok(msg) = self.rx.try_recv() else { break };
                        if keep(&msg) {
                            self.closing.push_back(msg);
                        }
                    }
                }
                self.closing.push_back(close());
                self.closing.pop_front()
            }
            msg = self.rx.recv() => msg,
        }
    }
}

/// How long leaving an account waits for its records to be stored, and a
/// service of the next scope waits before it reads them.
const WRITES_LIMIT: Duration = Duration::from_secs(3);
/// How often a service waiting for its scope's account checks auth again.
const RECHECK: Duration = Duration::from_millis(50);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Held by a service of a scope, and by each of its record writes, until
/// the write ended: leaving the account waits for every one to drop.
#[derive(Clone)]
pub(crate) struct Writes {
    _open: mpsc::Sender<()>,
}

/// The current scope's [`Writes`]: `closed` completes once every clone of
/// `open` dropped.
pub(crate) struct Writers {
    open: mpsc::Sender<()>,
    closed: mpsc::Receiver<()>,
}

impl Default for Writers {
    fn default() -> Self {
        let (open, closed) = mpsc::channel(1);
        Self { open, closed }
    }
}

/// Marks scope `left` settled once the scopes before it settled and its
/// writes ended, or after [`WRITES_LIMIT`].
async fn settle(settled: Arc<watch::Sender<u64>>, left: u64, writers: Writers) {
    let Writers { open, mut closed } = writers;
    drop(open);
    let mut earlier = settled.subscribe();
    let _ = timeout(WRITES_LIMIT, async {
        let _ = earlier.wait_for(|s| *s >= left).await;
        closed.recv().await;
    })
    .await;
    settled.send_modify(|s| *s = (*s).max(left + 1));
}

/// What an ended scope left: its sessions and relay to end, and its
/// records' settling.
struct Retired {
    flushed: JoinHandle<()>,
    taken: Taken,
    code: &'static str,
}

/// A service that stores its records when asked, instead of after its
/// debounce: the app leaves the foreground, or another service is about to
/// read the same records.
pub(crate) struct Flusher {
    /// The records it writes, as [`Inner::flushed`] names them.
    records: String,
    /// Queues the request; the future completes once the records are
    /// stored, or the service stopped. `None` once it stopped.
    request: Box<dyn Fn() -> Option<BoxFuture<'static, ()>> + Send + Sync>,
    stopped: Box<dyn Fn() -> bool + Send + Sync>,
}

impl Flusher {
    /// A flusher over `inbox`: `flush` is the service's message that
    /// stores its records and then answers (or drops) the sender.
    pub(crate) fn new<M, R>(
        records: String,
        inbox: &mpsc::UnboundedSender<M>,
        flush: fn(oneshot::Sender<R>) -> M,
    ) -> Self
    where
        M: Send + 'static,
        R: Send + 'static,
    {
        let (queue, probe) = (inbox.clone(), inbox.clone());
        Self {
            records,
            request: Box::new(move || {
                let (tx, rx) = oneshot::channel();
                queue.send(flush(tx)).ok()?;
                Some(Box::pin(async move {
                    let _ = rx.await;
                }))
            }),
            stopped: Box::new(move || probe.is_closed()),
        }
    }
}

impl Inner {
    /// Registers a service's [`Flusher`] until the service stops.
    pub(crate) fn flushes(&self, flusher: Flusher) {
        let mut flushers = lock(&self.flushers);
        flushers.retain(|f| !(f.stopped)());
        flushers.push(flusher);
    }
    /// Asks every service writing `records` (every service when `None`) to
    /// store them now. The requests are queued before this returns; the
    /// future completes once they are stored, or after [`WRITES_LIMIT`].
    pub(crate) fn flushed(&self, records: Option<&str>) -> impl Future<Output = ()> + Send + use<> {
        let pending: Vec<_> = {
            let mut flushers = lock(&self.flushers);
            flushers.retain(|f| !(f.stopped)());
            flushers
                .iter()
                .filter(|f| records.is_none_or(|r| f.records == r))
                .filter_map(|f| (f.request)())
                .collect()
        };
        async move {
            let _ = timeout(WRITES_LIMIT, join_all(pending)).await;
        }
    }
}

impl Inner {
    /// The account auth reports signed in (no network), if any.
    fn reported(&self) -> Option<String> {
        let status = self.auth.status().ok()?;
        match (status["status"].as_str(), status["user"]["id"].as_str()) {
            (Some("signedIn"), Some(id)) => Some(id.into()),
            _ => None,
        }
    }
    /// The current scope's account while auth still reports it (no
    /// network); app state, saved computers and caches are scoped to it.
    /// Between auth taking another account and the core leaving the
    /// current scope, this fails `account_changed` rather than name either.
    pub(crate) fn account(&self) -> Result<String> {
        let status = self.auth.status()?;
        match (status["status"].as_str(), status["user"]["id"].as_str()) {
            (Some("signedIn"), Some(id)) => {
                if self.scopes.borrow().account.get() == Some(&Some(id.to_owned())) {
                    Ok(id.into())
                } else {
                    Err(left())
                }
            }
            (Some("signedOut"), _) => Err(Error::http(401, "sign_in_required")),
            _ => Err(Error::new("session_unverified")),
        }
    }
    /// `scope`'s account while the scope lasts and auth still reports it:
    /// what a call made in `scope` reads and writes. `account_changed` once
    /// the scope ended; otherwise as [`Inner::account`].
    pub(crate) fn account_in(&self, scope: &Scope) -> Result<String> {
        scope.check()?;
        let account = self.account()?;
        if scope.account().as_deref() != Some(account.as_str()) {
            return Err(left());
        }
        Ok(account)
    }
    /// The current account scope, for a service starting now.
    pub(crate) fn scope(&self) -> Scope {
        let current = self.scopes.subscribe();
        let epoch = current.borrow().clone();
        Scope {
            epoch,
            current: Some(current),
        }
    }
    /// The current account scope, for a service that saves records in it:
    /// leaving the account waits for its [`Writes`] to drop.
    pub(crate) fn writing_scope(&self) -> (Scope, Writes) {
        let writers = lock(&self.writers);
        (
            self.scope(),
            Writes {
                _open: writers.open.clone(),
            },
        )
    }
    /// The account whose records a service of `scope` reads, and then
    /// writes: the scope's, while auth still reports it or once the scope
    /// ended (the service's views then read nothing; only the edits it
    /// kept are stored, merged into that account's record). While the
    /// scope lasts and auth reports another account (or none), the sign-in
    /// that took it is about to end the scope, or auth to report the
    /// scope's account again: this waits for either, at most
    /// [`WRITES_LIMIT`], and names no account if neither happened, so the
    /// service reads and writes nothing.
    pub(crate) async fn records_account(&self, scope: &Scope) -> Option<String> {
        let account = scope.account()?;
        let owned = timeout(WRITES_LIMIT, async {
            let mut ended = std::pin::pin!(scope.ended().fuse());
            while !self.owns_records(scope, &account) {
                tokio::select! {
                    () = &mut ended => {}
                    () = tokio::time::sleep(RECHECK) => {}
                }
            }
        })
        .await;
        owned.is_ok().then_some(account)
    }
    /// Applies `effect` for `scope` under the writers lock, under which
    /// every scope ends: `account_changed` once the scope ended, and no
    /// scope ends while it runs. What a left account's command removes or
    /// writes (a pairing, saved computers, caches) never lands after the
    /// next account began.
    pub(crate) fn in_scope<T>(
        &self,
        scope: &Scope,
        effect: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        let _writers = lock(&self.writers);
        scope.check()?;
        effect()
    }
    /// [`Inner::disconnect_all`] for `scope`: nothing once it ended, when
    /// leaving its account already took its sessions and relay, and what
    /// is open now is the next scope's.
    pub(crate) async fn disconnect_all_in(&self, scope: &Scope, code: &'static str) {
        let taken = {
            let _writers = lock(&self.writers);
            if !scope.live() {
                return;
            }
            self.take_all(code)
        };
        self.end_taken(taken, code).await;
    }
    /// Under the writers lock, so no sign-in is entered meanwhile.
    fn owns_records(&self, scope: &Scope, account: &str) -> bool {
        let _writers = lock(&self.writers);
        !scope.live() || self.reported().as_deref() == Some(account)
    }
    /// Completes once the scopes before `scope` stored their records, or
    /// after [`WRITES_LIMIT`]: a service reads its records only then.
    pub(crate) fn settled(&self, scope: &Scope) -> impl Future<Output = ()> + Send + 'static {
        let (mut settled, epoch) = (self.settled.subscribe(), scope.epoch.n);
        async move {
            let _ = timeout(WRITES_LIMIT, settled.wait_for(|s| *s >= epoch)).await;
        }
    }
    /// Ends the account scope: every service started in it is cut off at
    /// once. The next scope belongs to `next` (`Some(None)`: signed out;
    /// `None`: not known yet). The returned task completes once the ended
    /// scope's records are stored (bounded by [`WRITES_LIMIT`]); spawned,
    /// so the scope settles even when the caller goes away.
    fn end_scope(&self, writers: &mut Writers, next: Option<Option<String>>) -> JoinHandle<()> {
        let left = self.scopes.borrow().n;
        self.scopes.send_replace(Epoch::new(left + 1, next));
        let writers = std::mem::take(writers);
        tokio::spawn(settle(self.settled.clone(), left, writers))
    }
    /// [`Inner::end_scope`] for leaving the account, under the same
    /// writers lock: the ended scope's Orchestrator window states,
    /// sessions, relay and caches are taken with it, and what its sessions
    /// and relay report ends with it ([`Inner::take_scope`]), so what the
    /// next scope opens or caches once it began is never taken for the
    /// ended one's, nor the ended one's reported as the next one's.
    fn retire(
        &self,
        writers: &mut Writers,
        next: Option<Option<String>>,
        code: &'static str,
    ) -> Retired {
        let flushed = self.end_scope(writers, next);
        self.clear_visibility();
        Retired {
            flushed,
            taken: self.take_scope(code),
            code,
        }
    }
    /// After [`Inner::retire`]: the ended scope's sessions and relay end,
    /// and its records are stored (bounded by [`WRITES_LIMIT`]).
    async fn left_scope(&self, retired: Retired) {
        let Retired {
            flushed,
            taken,
            code,
        } = retired;
        self.end_taken(taken, code).await;
        let _ = flushed.await;
    }
    /// Leaves the account once auth dropped its session: every service
    /// started in it is cut off before the caller reports the next account,
    /// and the next scope belongs to no account.
    ///
    /// Decided under the writers lock, as [`Inner::enter`] is: when auth
    /// reports a sign-in by then, a session taken after the one dropped
    /// (an adoption or sign-in that enters its own account), this leaves
    /// nothing, so it never ends that session's scope.
    pub(crate) async fn leave_account(&self, code: &'static str) {
        let retired = {
            let mut writers = lock(&self.writers);
            if self.reported().is_some() {
                return;
            }
            self.retire(&mut writers, Some(None), code)
        };
        self.left_scope(retired).await;
    }
    /// Ends the account scope as the core stops: every service started in
    /// it closes, and its records are stored (bounded by
    /// [`WRITES_LIMIT`]), so a core opened next on the same store reads
    /// them.
    pub(crate) async fn store_records(&self) {
        let flushed = self.end_scope(&mut lock(&self.writers), None);
        let _ = flushed.await;
    }
    /// A sign-in of `account`. The current scope becomes its scope when its
    /// account is not known yet and `changed` is false; otherwise, unless
    /// it already is its scope, a scope of `account` begins. Returns what
    /// the ended scope left, if one ended.
    ///
    /// Decided under the writers lock against what auth reports then:
    /// every account auth takes is entered after auth took it, so the last
    /// sign-in entered decides. One auth already replaced names no account:
    /// it ends a scope of another account than auth's in favor of one of no
    /// known account, and otherwise changes nothing.
    fn enter(&self, account: &str, changed: bool) -> Option<Retired> {
        const CODE: &str = "account_changed";
        let mut writers = lock(&self.writers);
        let reported = self.reported();
        let current = self.scopes.borrow().clone();
        if reported.as_deref() != Some(account) {
            return match current.account.get() {
                Some(owner) if *owner != reported => Some(self.retire(&mut writers, None, CODE)),
                _ => None,
            };
        }
        let owner = Some(account.to_owned());
        if current.account.get() == Some(&owner)
            || (!changed && current.account.set(owner.clone()).is_ok())
        {
            return None;
        }
        Some(self.retire(&mut writers, Some(owner), CODE))
    }
    /// Connections, relay and caches belong to one account: tear them down
    /// only when a sign-in or validation reports a different account.
    async fn signed_in(&self, signed_in: &SignedIn) {
        if let Some(retired) = self.enter(&signed_in.account_id, signed_in.account_changed()) {
            self.left_scope(retired).await;
        }
    }
    /// Applies a validated or cleared session to the account's state.
    pub(crate) async fn observe(&self, session: AuthSession) -> AuthSession {
        match &session {
            AuthSession::SignedIn(s) => self.signed_in(s).await,
            AuthSession::SignedOut => self.leave_account("signed_out").await,
        }
        session
    }
    /// Applies a sign-in step that completed a sign-in.
    pub(crate) async fn observe_step(&self, step: SignInStep) -> SignInStep {
        if let SignInStep::SignedIn(s) = &step {
            self.signed_in(s).await;
        }
        step
    }
    /// Cached validation for relay and connect work; guests are excluded.
    pub(crate) async fn computer_account(&self) -> Result<String> {
        match self.auth.ensure_valid().await? {
            AuthSession::SignedIn(s) if !s.is_guest() => {
                self.signed_in(&s).await;
                Ok(s.account_id)
            }
            AuthSession::SignedIn(_) => Err(Error::new("account_required")),
            AuthSession::SignedOut => Err(Error::http(401, "sign_in_required")),
        }
    }
}

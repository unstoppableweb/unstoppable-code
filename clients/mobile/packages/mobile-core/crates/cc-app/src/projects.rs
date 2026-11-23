//! One computer's project clones (architecture §3.3, P8), ported from
//! `device_link/projects/clone_repository.dart`
//! (`DeviceProjectCloneRepository`, CAN-5796) and the clone part of
//! `computer_connect/controller.dart` (`_cloneCreated`); comments cite the
//! Dart rule they keep. The rows and their rules are
//! `cc-domain::clones::CloneBook`.
//!
//! One actor task owns the attempts. A clone sends exactly one
//! `workspace:add-from-remote` with its own job id; a lost answer is read
//! back from `clone-jobs:list`, never resent. Adding is two intents so the
//! host can recheck its own context between the folder lookup and the
//! request, as Dart's `stillAllowed` did: `Discover` asks the computer for
//! its folder, `Commit` sends the clone.
use crate::{
    account::{Inbox, Scope, View},
    api::{AccountView, CloneRowView, ClonesView, LinkPhase},
    bridge::{Inner, shutdown_failure},
    chats::Peer,
    copy::projects::{self as copy, CopyKey},
    error::Result,
    failures, overview,
    push::{self, Delivery, Filter},
};
use cc_domain::{
    clones::{self as domain, AddRefusal, CloneBook, CloneFailure, Effects, PushCounts},
    dart::Dv,
};
use cc_protocol::{FailureKind, dto};
use rand::RngCore;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Weak},
    time::Duration,
};
use tokio::{
    runtime::Handle as Runtime,
    sync::{mpsc, oneshot, watch},
};

/// The clone request answers once the project exists, which can take
/// minutes.
const CLONE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PUSHES: [&str; 1] = ["clone-jobs:changed"];

/// An intent's outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Nothing was sent; the message says why.
    Refused(String),
    /// The folder is known: commit with this ticket.
    Discovered(u64),
    /// The pending row took over.
    Started,
    /// `acknowledgeUnknown`'s answer.
    Acknowledged(bool),
    Done,
    /// The folder lookup failed with an error Dart did not catch.
    Failed,
}

pub(crate) struct Settled {
    pub(crate) revision: u64,
    pub(crate) outcome: Outcome,
}

pub(crate) type Waiter = oneshot::Sender<Settled>;

pub(crate) enum Intent {
    /// The first half of `add`: the refusals, then the folder lookup.
    Discover,
    /// The second half of `add`: `allowed` is the host's `stillAllowed()`.
    Commit {
        discovery: u64,
        url: String,
        allowed: bool,
    },
    ReadBack,
    Acknowledge(String),
    Dismiss(String),
    Retire(Vec<String>),
    Close,
}

enum Msg {
    Intent(Intent, Option<Waiter>),
    Push(push::Push),
    SessionOpened,
    Lagged,
    Discovered {
        ticket: u64,
        generation: u64,
        result: Result<Value>,
        waiter: Option<Waiter>,
    },
    Answered {
        job: String,
        result: Result<Value>,
    },
    ReadBack {
        generation: u64,
        seen: PushCounts,
        result: Result<Value>,
    },
    BackgroundFailed(String),
}

/// The service's handle: its inbox and published view.
#[derive(Clone)]
pub(crate) struct Handle {
    inbox: mpsc::UnboundedSender<Msg>,
    view: View<ClonesView>,
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
    pub(crate) fn view(&self) -> View<ClonesView> {
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

/// A folder lookup's answer, kept until its `Commit`.
struct Discovery {
    generation: u64,
    destination: Dv,
}

struct Actor {
    inner: Weak<Inner>,
    inbox: mpsc::UnboundedSender<Msg>,
    /// The computer in the service's account scope: its requests reach
    /// only a session of that scope.
    computer: Peer,
    pushes: Option<push::Subscription>,
    connection: Option<crate::api::ConnectionView>,
    book: CloneBook,
    connected: bool,
    disposed: bool,
    discovering: bool,
    reading: bool,
    read_again: bool,
    generation: u64,
    tickets: u64,
    discoveries: HashMap<u64, Discovery>,
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
            book: CloneBook::default(),
            connected: false,
            disposed: false,
            discovering: false,
            reading: false,
            read_again: false,
            generation: 0,
            tickets: 0,
            discoveries: HashMap::new(),
            revision: 0,
        }
    }

    fn row(row: domain::CloneRow) -> CloneRowView {
        CloneRowView {
            dismissible: row.dismissible(),
            job_id: row.job_id,
            name: row.name,
            phase: row.phase.into(),
            failure: row.failure.map(|f| {
                copy::text(match f {
                    CloneFailure::CloneFailed => CopyKey::CloneFailed,
                    CloneFailure::Unsupported => CopyKey::Unsupported,
                    CloneFailure::NotSent => CopyKey::NotSent,
                })
                .to_owned()
            }),
        }
    }

    fn view(&self) -> ClonesView {
        ClonesView {
            revision: self.revision,
            rows: self.book.rows().into_iter().map(Self::row).collect(),
            unconfirmed: self.book.unconfirmed().map(Self::row),
        }
    }

    async fn run(
        mut self,
        mut rx: Inbox<Msg>,
        publish: watch::Sender<Arc<ClonesView>>,
        mut account: watch::Receiver<Arc<AccountView>>,
    ) {
        let current = account.borrow_and_update().clone();
        self.account_changed(&current);
        self.publish(&publish);
        loop {
            let mut done = Vec::new();
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
            for (waiter, outcome) in done {
                let _ = waiter.send(Settled {
                    revision: self.revision,
                    outcome,
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
    fn publish(&mut self, publish: &watch::Sender<Arc<ClonesView>>) {
        let view = self.view();
        if **publish.borrow() == view && self.revision > 0 {
            return;
        }
        self.revision += 1;
        publish.send_replace(Arc::new(ClonesView {
            revision: self.revision,
            ..view
        }));
    }

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

    /// `setConnected`: pushes may have been missed while offline.
    fn set_connected(&mut self, value: bool) {
        if self.connected == value {
            return;
        }
        self.connected = value;
        self.generation += 1;
        if value {
            self.read_back();
        }
    }

    fn spawn<F>(&self, work: impl FnOnce(Arc<Inner>, Peer) -> F + Send + 'static)
    where
        F: std::future::Future<Output = Option<Msg>> + Send + 'static,
    {
        let (Some(inner), inbox, computer) = (
            self.inner.upgrade(),
            self.inbox.clone(),
            self.computer.clone(),
        ) else {
            return;
        };
        tokio::spawn(async move {
            if let Some(msg) = work(inner, computer).await {
                let _ = inbox.send(msg);
            }
        });
    }

    fn apply(&mut self, msg: Msg, done: &mut Vec<(Waiter, Outcome)>) {
        match msg {
            Msg::Intent(intent, waiter) => {
                let mut waiter = waiter;
                if let Some(outcome) = self.intent(intent, &mut waiter)
                    && let Some(waiter) = waiter
                {
                    done.push((waiter, outcome));
                }
            }
            Msg::Push(push) => self.push(&push.message),
            Msg::SessionOpened => {
                if self.connected {
                    self.set_connected(false);
                    self.set_connected(true);
                }
            }
            Msg::Lagged => self.read_back(),
            Msg::Discovered {
                ticket,
                generation,
                result,
                waiter,
            } => {
                // `finally { _discovering = false; }` — after a lookup that
                // answered, at the commit, which Dart ran in the same turn.
                let outcome = match result {
                    Ok(destination) => {
                        self.discoveries.insert(
                            ticket,
                            Discovery {
                                generation,
                                destination: dto::desktop_value(&destination),
                            },
                        );
                        Outcome::Discovered(ticket)
                    }
                    Err(e) => match e.kind {
                        FailureKind::Refused => Outcome::Refused(
                            copy::text(if e.code == "remote_channel_unavailable" {
                                CopyKey::Unsupported
                            } else {
                                CopyKey::NoDestination
                            })
                            .into(),
                        ),
                        _ if failures::read_failure(&e).is_some() => {
                            Outcome::Refused(copy::text(CopyKey::Unreachable).into())
                        }
                        _ => Outcome::Failed,
                    },
                };
                // Only the host waiting for the answer can commit it: one
                // that no longer waits (or never did) abandoned the add.
                let waiting = waiter.as_ref().is_some_and(|w| !w.is_closed());
                if !waiting || !matches!(outcome, Outcome::Discovered(_)) {
                    self.discoveries.remove(&ticket);
                    self.discovering = false;
                }
                if let Some(waiter) = waiter {
                    done.push((waiter, outcome));
                }
            }
            Msg::Answered { job, result } => {
                let effects = match result {
                    Ok(reply) => self.book.answered(&job, &dto::desktop_value(&reply)),
                    Err(e) => match e.kind {
                        FailureKind::NotSent => self.book.failed(&job, CloneFailure::NotSent),
                        // The computer answered: the clone did not create a
                        // project.
                        FailureKind::Refused => self.book.failed(
                            &job,
                            if e.code == "remote_channel_unavailable" {
                                CloneFailure::Unsupported
                            } else {
                                CloneFailure::CloneFailed
                            },
                        ),
                        // A timeout or a lost connection: it may still be
                        // cloning.
                        _ => self.book.lost(&job),
                    },
                };
                self.effects(effects);
            }
            Msg::ReadBack {
                generation,
                seen,
                result,
            } => {
                if !self.disposed
                    && generation == self.generation
                    && let Ok(jobs) = result
                {
                    let effects =
                        self.book
                            .read_back(&dto::desktop_value(&jobs), generation, &seen);
                    self.effects(effects);
                }
                self.reading = false;
                if self.read_again {
                    self.read_again = false;
                    self.read_back();
                }
            }
            Msg::BackgroundFailed(job) => self.book.background_failed(&job),
        }
    }

    /// An intent's outcome now, or `None` when a read settles it later.
    fn intent(&mut self, intent: Intent, waiter: &mut Option<Waiter>) -> Option<Outcome> {
        match intent {
            Intent::Discover => {
                if self.disposed || !self.connected {
                    return Some(Outcome::Refused(copy::text(CopyKey::ConnectFirst).into()));
                }
                if let Some(refusal) = self.refusal() {
                    return Some(Outcome::Refused(refusal));
                }
                self.discovering = true;
                self.tickets += 1;
                let (ticket, generation) = (self.tickets, self.generation);
                let waiter = waiter.take();
                // The computer owns the folder; this phone passes it back
                // unchanged.
                self.spawn(move |inner, computer| async move {
                    let result =
                        call(&inner, &computer, "repo:default-clone-dir", vec![], None).await;
                    Some(Msg::Discovered {
                        ticket,
                        generation,
                        result,
                        waiter,
                    })
                });
                None
            }
            Intent::Commit {
                discovery,
                url,
                allowed,
            } => {
                let found = self.discoveries.remove(&discovery);
                if found.is_some() {
                    self.discovering = false;
                }
                let Some(found) = found.filter(|d| {
                    !self.disposed && self.connected && d.generation == self.generation && allowed
                }) else {
                    return Some(Outcome::Refused(
                        copy::text(CopyKey::ConnectionChanged).into(),
                    ));
                };
                let destination = match &found.destination {
                    Dv::Str(d) if !d.is_empty() => d.clone(),
                    _ => return Some(Outcome::Refused(copy::text(CopyKey::NoDestination).into())),
                };
                // Evidence received during the lookup can withdraw an
                // acknowledgment.
                if let Some(refusal) = self.refusal() {
                    return Some(Outcome::Refused(refusal));
                }
                let job = new_job_id();
                let name = domain::repository_name(&url)
                    .unwrap_or_else(|| copy::text(CopyKey::Repository).into());
                self.book.start(job.clone(), name, self.generation);
                let url = url.trim_matches(cc_domain::dart::is_space).to_owned();
                self.spawn(move |inner, computer| async move {
                    let result = call(
                        &inner,
                        &computer,
                        "workspace:add-from-remote",
                        vec![
                            json!({"remoteUrl": url, "destinationDir": destination, "jobId": job}),
                        ],
                        Some(CLONE_TIMEOUT),
                    )
                    .await;
                    Some(Msg::Answered { job, result })
                });
                Some(Outcome::Started)
            }
            Intent::ReadBack => {
                self.read_back();
                Some(Outcome::Done)
            }
            Intent::Acknowledge(job) => {
                let acknowledged = !self.disposed && self.connected && self.book.is_unknown(&job);
                if acknowledged {
                    self.book.acknowledge(&job);
                }
                Some(Outcome::Acknowledged(acknowledged))
            }
            Intent::Dismiss(job) => {
                self.book.dismiss(&job);
                Some(Outcome::Done)
            }
            Intent::Retire(ids) => {
                self.book.retire(&ids);
                Some(Outcome::Done)
            }
            Intent::Close => {
                self.disposed = true;
                self.book.clear();
                Some(Outcome::Done)
            }
        }
    }

    /// `_addRefusal`, worded.
    fn refusal(&self) -> Option<String> {
        self.book.add_refusal(self.discovering).map(|r| {
            copy::text(match r {
                AddRefusal::WaitForClone => CopyKey::WaitForClone,
                AddRefusal::Unconfirmed => CopyKey::Unconfirmed,
            })
            .into()
        })
    }

    /// `readBack`: one read at a time; a request meanwhile reads again
    /// afterwards.
    fn read_back(&mut self) {
        if self.disposed || !self.connected {
            return;
        }
        if self.reading {
            self.read_again = true;
            return;
        }
        if !self.book.wants_read_back(self.generation) {
            return;
        }
        self.reading = true;
        let (generation, seen) = (self.generation, self.book.push_counts());
        self.spawn(move |inner, computer| async move {
            let result = call(&inner, &computer, "clone-jobs:list", vec![], None).await;
            Some(Msg::ReadBack {
                generation,
                seen,
                result,
            })
        });
    }

    fn effects(&mut self, effects: Effects) {
        for job in effects.background {
            // The computer keeps a finished background job listed until its
            // desktop app or a restart removes it, so a lost answer can
            // often still be read back.
            self.spawn(move |inner, computer| async move {
                call(
                    &inner,
                    &computer,
                    "clone-jobs:background",
                    vec![json!(job)],
                    None,
                )
                .await
                .err()
                .map(|_| Msg::BackgroundFailed(job))
            });
        }
        if effects.created {
            self.created();
        }
        if effects.read_back {
            self.read_back();
        }
    }

    /// `_cloneCreated`: re-reads ownership too, since the new project's owner
    /// comes from the session snapshot the computer may have cached.
    fn created(&self) {
        if !self.connected {
            return;
        }
        self.spawn(move |inner, computer| async move {
            // Older hosts may refuse it; their snapshot pushes refresh instead.
            let _ = call(
                &inner,
                &computer,
                "desktop:session-snapshot-invalidate",
                vec![],
                None,
            )
            .await;
            if let Some(overview) = inner.overview_inbox(&computer) {
                let (tx, rx) = oneshot::channel();
                if overview
                    .send(overview::Msg::Intent(overview::Intent::RefreshSoon(tx)))
                    .is_ok()
                {
                    let _ = rx.await;
                }
            }
            None
        });
    }

    fn push(&mut self, message: &Value) {
        if self.disposed || !self.connected {
            return;
        }
        let dto = dto::desktop_value(message);
        let payload = dto.get("payload");
        if !payload.is_map() || !payload.get("channel").is_str("clone-jobs:changed") {
            return;
        }
        let first = match payload.get("args") {
            Dv::List(args) => args.first(),
            _ => None,
        };
        let Some(jobs @ Dv::List(_)) = first else {
            return;
        };
        let effects = self.book.pushed(jobs);
        self.effects(effects);
    }
}

/// `newDeviceCloneJobId`: a lowercase id the computer's validation accepts.
fn new_job_id() -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("mobile-clone-{hex}")
}

async fn call(
    inner: &Inner,
    computer: &Peer,
    channel: &str,
    args: Vec<Value>,
    limit: Option<Duration>,
) -> Result<Value> {
    crate::worktrees::call(inner, computer, channel, args, limit).await
}

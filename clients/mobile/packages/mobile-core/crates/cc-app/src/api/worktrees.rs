//! `WorktreesService` (P8): one computer's worktree creation attempts and
//! archives. Intents queue in call order; `request` returns a ticket whose
//! outcome `settled` reports.
use super::CoreFailure;
use crate::{
    account::View,
    api::CoreInner,
    worktrees::{self, FailKind, Handle, Intent},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::oneshot;

/// One creation attempt as the new task screen reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttemptView {
    pub id: u64,
    pub project_id: String,
    /// The created worktree, once the desktop answered.
    pub worktree_id: Option<String>,
    /// Its branch name (`New task` when the desktop sent none).
    pub name: Option<String>,
    /// A create left the phone (and may have reached the desktop).
    pub mutation_sent: bool,
    pub ready: bool,
    /// A worktree exists to check, or no create left the phone.
    pub can_retry: bool,
}

/// Every attempt and the rows being archived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreesView {
    pub revision: u64,
    pub attempts: Vec<AttemptView>,
    /// `<project>/<worktree>` keys, in the order archives started.
    pub archiving: Vec<String>,
}

/// A created worktree, ready for its first chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedWorktreeView {
    pub project_id: String,
    pub id: String,
    pub name: String,
}

/// The exception the Dart creator, archiver or clone repository threw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteFailureKind {
    /// A `DeviceLinkException`: show the message.
    Link,
    /// A `DesktopIpcRefusal`: the desktop answered.
    Refused,
    /// A `DesktopIpcNotSent`: nothing reached the desktop.
    NotSent,
    /// Another error; the caller words it.
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteFailure {
    pub message: String,
    pub kind: WriteFailureKind,
    /// A refusal's desktop code.
    pub code: Option<String>,
}

impl From<worktrees::Failure> for WriteFailure {
    fn from(f: worktrees::Failure) -> Self {
        Self {
            message: f.message,
            kind: match f.kind {
                FailKind::Link => WriteFailureKind::Link,
                FailKind::Refused => WriteFailureKind::Refused,
                FailKind::NotSent => WriteFailureKind::NotSent,
                FailKind::Other => WriteFailureKind::Other,
            },
            code: f.code,
        }
    }
}

/// A worktree intent. Each variant's doc ends with when it resolves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreesIntent {
    /// Sends at most one create for `attempt` (`DeviceWorktreeCreator.create`):
    /// reads the project, creates the worktree, then waits for its setup
    /// (a fresh project read, else the `worktree:git-ready` push, at most
    /// 45 s). A second call while one runs shares its outcome; after a
    /// success it answers the same worktree.
    ///
    /// Resolves when settled: created, or failed with the creator's
    /// exception.
    Create { attempt: u64 },
    /// The attempt's owner left: forget it.
    ///
    /// Resolves when applied.
    Release { attempt: u64 },
    /// Archives a worktree through the desktop's own archive call, then
    /// re-reads the overview's roster. The row stays archiving until then;
    /// a second call for the same row does nothing.
    ///
    /// Resolves when settled: archived (and the roster re-read), or failed.
    Archive {
        project_id: String,
        worktree_id: String,
    },
    /// Stops the service; waiting creations fail.
    ///
    /// Resolves when applied.
    Close,
}

/// A requested intent's outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreesSettled {
    /// The view revision that shows the outcome.
    pub revision: u64,
    pub failure: Option<WriteFailure>,
    pub created: Option<CreatedWorktreeView>,
    /// The attempt as it was when the outcome settled.
    pub attempt: Option<AttemptView>,
}

type Tickets = (u64, HashMap<u64, oneshot::Receiver<worktrees::Settled>>);

/// One computer's worktree creation and archive. Built by
/// `AccountService::worktrees`.
#[derive(Clone)]
pub struct WorktreesService {
    inner: Arc<CoreInner>,
    handle: Handle,
    attempts: Arc<AtomicU64>,
    tickets: Arc<Mutex<Tickets>>,
}

impl WorktreesService {
    pub(crate) fn new(inner: Arc<CoreInner>, handle: Handle) -> Self {
        Self {
            inner,
            handle,
            attempts: Arc::default(),
            tickets: Arc::default(),
        }
    }
    /// The view now, then every change (latest wins).
    pub fn watch(&self) -> WorktreesViews {
        WorktreesViews {
            view: self.handle.view(),
            first: true,
        }
    }
    /// A new creation attempt in `project_id` (one UI attempt owns it).
    /// Applied before any intent queued after it.
    pub fn begin(&self, project_id: String, base_branch: Option<String>) -> u64 {
        let attempt = self.attempts.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.handle.send(
            Intent::Begin {
                attempt,
                project_id,
                base_branch,
            },
            None,
        );
        attempt
    }
    /// Queues `intent`; its outcome is not reported.
    /// [`Self::begin`] for a new task (`cc-app::home`), sharing the ids.
    pub(crate) fn begin_attempt(&self, project_id: String, base_branch: Option<String>) -> u64 {
        self.begin(project_id, base_branch)
    }
    pub(crate) fn handle(&self) -> &Handle {
        &self.handle
    }
    pub(crate) fn view(&self) -> View<WorktreesView> {
        self.handle.view()
    }
    pub fn send(&self, intent: WorktreesIntent) {
        let _ = self.handle.send(self::intent(intent), None);
    }
    /// Queues `intent` and returns the ticket [`Self::settled`] takes.
    pub fn request(&self, intent: WorktreesIntent) -> u64 {
        let (tx, rx) = oneshot::channel();
        let mut tickets = self.tickets.lock().unwrap_or_else(|p| p.into_inner());
        tickets.0 += 1;
        let ticket = tickets.0;
        if self.handle.send(self::intent(intent), Some(tx)).is_ok() {
            tickets.1.insert(ticket, rx);
        }
        ticket
    }
    /// The outcome of a [`Self::request`]ed intent. Fails when the core
    /// shut down (or the ticket is unknown), and `account_changed` once
    /// the account the service was opened in was left, also while the
    /// intent ran.
    pub async fn settled(&self, ticket: u64) -> Result<WorktreesSettled, CoreFailure> {
        let rx = self
            .tickets
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .1
            .remove(&ticket);
        let settled = self.inner.ticket(self.handle.scope(), rx).await?;
        Ok(WorktreesSettled {
            revision: settled.revision,
            failure: settled.failure.map(Into::into),
            created: settled.created,
            attempt: settled.attempt,
        })
    }
}

fn intent(intent: WorktreesIntent) -> Intent {
    match intent {
        WorktreesIntent::Create { attempt } => Intent::Create { attempt },
        WorktreesIntent::Release { attempt } => Intent::Release { attempt },
        WorktreesIntent::Archive {
            project_id,
            worktree_id,
        } => Intent::Archive {
            project_id,
            worktree_id,
        },
        WorktreesIntent::Close => Intent::Close,
    }
}

/// A [`WorktreesService::watch`] stream.
pub struct WorktreesViews {
    view: View<WorktreesView>,
    first: bool,
}

impl WorktreesViews {
    /// The next view; `None` once the service stopped.
    pub async fn next(&mut self) -> Option<WorktreesView> {
        if !self.first {
            self.view.changed().await.ok()?;
        }
        self.first = false;
        Some(self.view.latest()?.as_ref().clone())
    }
}

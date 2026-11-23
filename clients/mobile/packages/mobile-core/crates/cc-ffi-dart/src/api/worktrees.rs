//! One computer's worktree creation attempts and archives (P8). A creation
//! is sent at most once: an answer the phone did not get leaves the
//! project uncertain, and only a request that never left can be retried.
//! [`WorktreesService::watch`] streams every attempt and the rows being
//! archived; intents are queued in call order and each variant of
//! [`WorktreesIntent`] says when it settles.
use super::{core::CoreFailure, handler};
use crate::frb_generated::StreamSink;
use flutter_rust_bridge::frb;

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

impl From<cc_core::AttemptView> for AttemptView {
    fn from(v: cc_core::AttemptView) -> Self {
        Self {
            id: v.id,
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            name: v.name,
            mutation_sent: v.mutation_sent,
            ready: v.ready,
            can_retry: v.can_retry,
        }
    }
}

impl From<AttemptView> for cc_core::AttemptView {
    fn from(v: AttemptView) -> Self {
        Self {
            id: v.id,
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            name: v.name,
            mutation_sent: v.mutation_sent,
            ready: v.ready,
            can_retry: v.can_retry,
        }
    }
}

impl From<cc_core::WorktreesView> for WorktreesView {
    fn from(v: cc_core::WorktreesView) -> Self {
        Self {
            revision: v.revision,
            attempts: v.attempts.into_iter().map(Into::into).collect(),
            archiving: v.archiving,
        }
    }
}

impl From<WorktreesView> for cc_core::WorktreesView {
    fn from(v: WorktreesView) -> Self {
        Self {
            revision: v.revision,
            attempts: v.attempts.into_iter().map(Into::into).collect(),
            archiving: v.archiving,
        }
    }
}

impl From<cc_core::CreatedWorktreeView> for CreatedWorktreeView {
    fn from(v: cc_core::CreatedWorktreeView) -> Self {
        Self {
            project_id: v.project_id,
            id: v.id,
            name: v.name,
        }
    }
}

impl From<CreatedWorktreeView> for cc_core::CreatedWorktreeView {
    fn from(v: CreatedWorktreeView) -> Self {
        Self {
            project_id: v.project_id,
            id: v.id,
            name: v.name,
        }
    }
}

impl From<cc_core::WriteFailureKind> for WriteFailureKind {
    fn from(v: cc_core::WriteFailureKind) -> Self {
        match v {
            cc_core::WriteFailureKind::Link => Self::Link,
            cc_core::WriteFailureKind::Refused => Self::Refused,
            cc_core::WriteFailureKind::NotSent => Self::NotSent,
            cc_core::WriteFailureKind::Other => Self::Other,
        }
    }
}

impl From<WriteFailureKind> for cc_core::WriteFailureKind {
    fn from(v: WriteFailureKind) -> Self {
        match v {
            WriteFailureKind::Link => Self::Link,
            WriteFailureKind::Refused => Self::Refused,
            WriteFailureKind::NotSent => Self::NotSent,
            WriteFailureKind::Other => Self::Other,
        }
    }
}

impl From<cc_core::WriteFailure> for WriteFailure {
    fn from(v: cc_core::WriteFailure) -> Self {
        Self {
            message: v.message,
            kind: v.kind.into(),
            code: v.code,
        }
    }
}

impl From<WriteFailure> for cc_core::WriteFailure {
    fn from(v: WriteFailure) -> Self {
        Self {
            message: v.message,
            kind: v.kind.into(),
            code: v.code,
        }
    }
}

impl From<cc_core::WorktreesIntent> for WorktreesIntent {
    fn from(v: cc_core::WorktreesIntent) -> Self {
        match v {
            cc_core::WorktreesIntent::Create { attempt } => Self::Create { attempt },
            cc_core::WorktreesIntent::Release { attempt } => Self::Release { attempt },
            cc_core::WorktreesIntent::Archive {
                project_id,
                worktree_id,
            } => Self::Archive {
                project_id,
                worktree_id,
            },
            cc_core::WorktreesIntent::Close => Self::Close,
        }
    }
}

impl From<WorktreesIntent> for cc_core::WorktreesIntent {
    fn from(v: WorktreesIntent) -> Self {
        match v {
            WorktreesIntent::Create { attempt } => Self::Create { attempt },
            WorktreesIntent::Release { attempt } => Self::Release { attempt },
            WorktreesIntent::Archive {
                project_id,
                worktree_id,
            } => Self::Archive {
                project_id,
                worktree_id,
            },
            WorktreesIntent::Close => Self::Close,
        }
    }
}

impl From<cc_core::WorktreesSettled> for WorktreesSettled {
    fn from(v: cc_core::WorktreesSettled) -> Self {
        Self {
            revision: v.revision,
            failure: v.failure.map(Into::into),
            created: v.created.map(Into::into),
            attempt: v.attempt.map(Into::into),
        }
    }
}

impl From<WorktreesSettled> for cc_core::WorktreesSettled {
    fn from(v: WorktreesSettled) -> Self {
        Self {
            revision: v.revision,
            failure: v.failure.map(Into::into),
            created: v.created.map(Into::into),
            attempt: v.attempt.map(Into::into),
        }
    }
}

/// One computer's worktree creation and archive. Built by
/// `AccountService.worktrees`.
#[frb(opaque)]
#[derive(Clone)]
pub struct WorktreesService {
    pub(crate) inner: cc_core::WorktreesService,
}

impl WorktreesService {
    pub(crate) fn new(inner: cc_core::WorktreesService) -> Self {
        Self { inner }
    }
    /// The view now, then every change (latest wins).
    pub fn watch(&self, sink: StreamSink<WorktreesView>) {
        let mut views = self.inner.watch();
        handler::runtime().spawn(async move {
            while let Some(view) = views.next().await {
                if sink.add(view.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// A new creation attempt in `project_id`, applied before any intent
    /// queued after it.
    #[frb(sync)]
    pub fn begin(&self, project_id: String, base_branch: Option<String>) -> u64 {
        self.inner.begin(project_id, base_branch)
    }
    /// Queues `intent`; its outcome is not reported.
    #[frb(sync)]
    pub fn send(&self, intent: WorktreesIntent) {
        self.inner.send(intent.into());
    }
    /// Queues `intent` and returns the ticket `settled` takes.
    #[frb(sync)]
    pub fn request(&self, intent: WorktreesIntent) -> u64 {
        self.inner.request(intent.into())
    }
    /// The outcome of a requested intent. Fails when the core shut down,
    /// and `account_changed` once the account the service was opened in
    /// was left, also while the intent ran.
    pub async fn settled(&self, ticket: u64) -> Result<WorktreesSettled, CoreFailure> {
        self.inner
            .settled(ticket)
            .await
            .map(Into::into)
            .map_err(Into::into)
    }
}

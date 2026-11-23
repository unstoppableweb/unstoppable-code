//! One computer's project clones (P8): the pending project rows and the
//! two-step add (the computer's folder lookup, then one clone request with
//! its own job id). A lost answer is read back from the computer's clone
//! jobs, never resent. [`ProjectsService::watch`] streams the rows; intents
//! are queued in call order and each variant of [`ProjectsIntent`] says
//! when it settles.
use super::{core::CoreFailure, handler};
use crate::frb_generated::StreamSink;
use flutter_rust_bridge::frb;

/// `DeviceProjectClonePhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClonePhaseView {
    /// The computer may still be cloning, or its answer is being read back.
    Cloning,
    /// The computer created the project; the inventory does not list it yet.
    AwaitingProject,
    /// The computer confirmed the clone failed, or never received it.
    Failed,
    /// The computer is not running the clone, but its result is unknown.
    Unknown,
}

/// One pending project row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloneRowView {
    pub job_id: String,
    /// The repository name from the URL; the URL is not kept.
    pub name: String,
    pub phase: ClonePhaseView,
    /// Path-free copy for a failed clone.
    pub failure: Option<String>,
    /// Rows the computer may still be working on cannot be dismissed.
    pub dismissible: bool,
}

/// The computer's pending project rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClonesView {
    pub revision: u64,
    /// Oldest first; hidden unknown rows are left out.
    pub rows: Vec<CloneRowView>,
    /// The oldest unknown result that blocks another clone, even hidden.
    pub unconfirmed: Option<CloneRowView>,
}

/// A clone intent. Each variant's doc ends with when it resolves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectsIntent {
    /// The first half of adding a project: the refusals (not connected, a
    /// clone running, an unknown result not acknowledged), then the
    /// computer's folder lookup (`repo:default-clone-dir`).
    ///
    /// Resolves when settled: `Discovered{discovery}` or `Refused{message}`.
    Discover,
    /// The second half: `allowed` is the host's own recheck of its context.
    /// Sends one `workspace:add-from-remote` with a new job id into the
    /// folder `discovery` found; never resends.
    ///
    /// Resolves when applied: `Started` once the pending row took over, or
    /// `Refused{message}`.
    Commit {
        discovery: u64,
        url: String,
        allowed: bool,
    },
    /// Reads the computer's clone jobs for answers that were lost or are
    /// unknown (one read at a time).
    ///
    /// Resolves when applied; the read reports on the stream.
    ReadBack,
    /// The user checked Projects on the computer and accepts that another
    /// clone might duplicate `job_id`'s. Sends nothing.
    ///
    /// Resolves when applied: `Acknowledged{accepted}`, false when the job
    /// is no longer unknown.
    Acknowledge { job_id: String },
    /// Removes a settled row, or hides an unknown one. Sends nothing.
    ///
    /// Resolves when applied.
    Dismiss { job_id: String },
    /// Drops rows whose created project the inventory lists.
    ///
    /// Resolves when applied.
    Retire { project_ids: Vec<String> },
    /// Stops the service.
    ///
    /// Resolves when applied.
    Close,
}

/// A requested intent's outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectsOutcome {
    /// Nothing was sent; `message` says why.
    Refused {
        message: String,
    },
    /// The folder is known: commit with `discovery`.
    Discovered {
        discovery: u64,
    },
    /// The pending row took over.
    Started,
    Acknowledged {
        accepted: bool,
    },
    Done,
    /// The folder lookup failed in a way the phone does not word.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectsSettled {
    /// The view revision that shows the outcome.
    pub revision: u64,
    pub outcome: ProjectsOutcome,
}

impl From<cc_core::ClonePhaseView> for ClonePhaseView {
    fn from(v: cc_core::ClonePhaseView) -> Self {
        match v {
            cc_core::ClonePhaseView::Cloning => Self::Cloning,
            cc_core::ClonePhaseView::AwaitingProject => Self::AwaitingProject,
            cc_core::ClonePhaseView::Failed => Self::Failed,
            cc_core::ClonePhaseView::Unknown => Self::Unknown,
        }
    }
}

impl From<ClonePhaseView> for cc_core::ClonePhaseView {
    fn from(v: ClonePhaseView) -> Self {
        match v {
            ClonePhaseView::Cloning => Self::Cloning,
            ClonePhaseView::AwaitingProject => Self::AwaitingProject,
            ClonePhaseView::Failed => Self::Failed,
            ClonePhaseView::Unknown => Self::Unknown,
        }
    }
}

impl From<cc_core::CloneRowView> for CloneRowView {
    fn from(v: cc_core::CloneRowView) -> Self {
        Self {
            job_id: v.job_id,
            name: v.name,
            phase: v.phase.into(),
            failure: v.failure,
            dismissible: v.dismissible,
        }
    }
}

impl From<CloneRowView> for cc_core::CloneRowView {
    fn from(v: CloneRowView) -> Self {
        Self {
            job_id: v.job_id,
            name: v.name,
            phase: v.phase.into(),
            failure: v.failure,
            dismissible: v.dismissible,
        }
    }
}

impl From<cc_core::ClonesView> for ClonesView {
    fn from(v: cc_core::ClonesView) -> Self {
        Self {
            revision: v.revision,
            rows: v.rows.into_iter().map(Into::into).collect(),
            unconfirmed: v.unconfirmed.map(Into::into),
        }
    }
}

impl From<ClonesView> for cc_core::ClonesView {
    fn from(v: ClonesView) -> Self {
        Self {
            revision: v.revision,
            rows: v.rows.into_iter().map(Into::into).collect(),
            unconfirmed: v.unconfirmed.map(Into::into),
        }
    }
}

impl From<cc_core::ProjectsIntent> for ProjectsIntent {
    fn from(v: cc_core::ProjectsIntent) -> Self {
        match v {
            cc_core::ProjectsIntent::Discover => Self::Discover,
            cc_core::ProjectsIntent::Commit {
                discovery,
                url,
                allowed,
            } => Self::Commit {
                discovery,
                url,
                allowed,
            },
            cc_core::ProjectsIntent::ReadBack => Self::ReadBack,
            cc_core::ProjectsIntent::Acknowledge { job_id } => Self::Acknowledge { job_id },
            cc_core::ProjectsIntent::Dismiss { job_id } => Self::Dismiss { job_id },
            cc_core::ProjectsIntent::Retire { project_ids } => Self::Retire { project_ids },
            cc_core::ProjectsIntent::Close => Self::Close,
        }
    }
}

impl From<ProjectsIntent> for cc_core::ProjectsIntent {
    fn from(v: ProjectsIntent) -> Self {
        match v {
            ProjectsIntent::Discover => Self::Discover,
            ProjectsIntent::Commit {
                discovery,
                url,
                allowed,
            } => Self::Commit {
                discovery,
                url,
                allowed,
            },
            ProjectsIntent::ReadBack => Self::ReadBack,
            ProjectsIntent::Acknowledge { job_id } => Self::Acknowledge { job_id },
            ProjectsIntent::Dismiss { job_id } => Self::Dismiss { job_id },
            ProjectsIntent::Retire { project_ids } => Self::Retire { project_ids },
            ProjectsIntent::Close => Self::Close,
        }
    }
}

impl From<cc_core::ProjectsOutcome> for ProjectsOutcome {
    fn from(v: cc_core::ProjectsOutcome) -> Self {
        match v {
            cc_core::ProjectsOutcome::Refused { message } => Self::Refused { message },
            cc_core::ProjectsOutcome::Discovered { discovery } => Self::Discovered { discovery },
            cc_core::ProjectsOutcome::Started => Self::Started,
            cc_core::ProjectsOutcome::Acknowledged { accepted } => Self::Acknowledged { accepted },
            cc_core::ProjectsOutcome::Done => Self::Done,
            cc_core::ProjectsOutcome::Failed => Self::Failed,
        }
    }
}

impl From<ProjectsOutcome> for cc_core::ProjectsOutcome {
    fn from(v: ProjectsOutcome) -> Self {
        match v {
            ProjectsOutcome::Refused { message } => Self::Refused { message },
            ProjectsOutcome::Discovered { discovery } => Self::Discovered { discovery },
            ProjectsOutcome::Started => Self::Started,
            ProjectsOutcome::Acknowledged { accepted } => Self::Acknowledged { accepted },
            ProjectsOutcome::Done => Self::Done,
            ProjectsOutcome::Failed => Self::Failed,
        }
    }
}

impl From<cc_core::ProjectsSettled> for ProjectsSettled {
    fn from(v: cc_core::ProjectsSettled) -> Self {
        Self {
            revision: v.revision,
            outcome: v.outcome.into(),
        }
    }
}

impl From<ProjectsSettled> for cc_core::ProjectsSettled {
    fn from(v: ProjectsSettled) -> Self {
        Self {
            revision: v.revision,
            outcome: v.outcome.into(),
        }
    }
}

/// One computer's project clones. Built by `AccountService.projects`.
#[frb(opaque)]
#[derive(Clone)]
pub struct ProjectsService {
    inner: cc_core::ProjectsService,
}

impl ProjectsService {
    pub(crate) fn new(inner: cc_core::ProjectsService) -> Self {
        Self { inner }
    }
    /// The view now, then every change (latest wins).
    pub fn watch(&self, sink: StreamSink<ClonesView>) {
        let mut views = self.inner.watch();
        handler::runtime().spawn(async move {
            while let Some(view) = views.next().await {
                if sink.add(view.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// Queues `intent`; its outcome is not reported.
    #[frb(sync)]
    pub fn send(&self, intent: ProjectsIntent) {
        self.inner.send(intent.into());
    }
    /// Queues `intent` and returns the ticket `settled` takes.
    #[frb(sync)]
    pub fn request(&self, intent: ProjectsIntent) -> u64 {
        self.inner.request(intent.into())
    }
    /// The outcome of a requested intent. Fails when the core shut down,
    /// and `account_changed` once the account the service was opened in
    /// was left, also while the intent ran.
    pub async fn settled(&self, ticket: u64) -> Result<ProjectsSettled, CoreFailure> {
        self.inner
            .settled(ticket)
            .await
            .map(Into::into)
            .map_err(Into::into)
    }
}

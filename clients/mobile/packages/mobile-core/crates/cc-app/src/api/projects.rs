//! `ProjectsService` (P8): one computer's project clones. Intents queue in
//! call order; `request` returns a ticket whose outcome `settled` reports.
use super::CoreFailure;
use crate::{
    account::View,
    api::CoreInner,
    projects::{Handle, Intent, Outcome},
};
use cc_domain::clones::ClonePhase;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;

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

impl From<ClonePhase> for ClonePhaseView {
    fn from(p: ClonePhase) -> Self {
        match p {
            ClonePhase::Cloning => Self::Cloning,
            ClonePhase::AwaitingProject => Self::AwaitingProject,
            ClonePhase::Failed => Self::Failed,
            ClonePhase::Unknown => Self::Unknown,
        }
    }
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

type Tickets = (
    u64,
    HashMap<u64, oneshot::Receiver<crate::projects::Settled>>,
);

/// One computer's project clones. Built by `AccountService::projects`.
#[derive(Clone)]
pub struct ProjectsService {
    inner: Arc<CoreInner>,
    handle: Handle,
    tickets: Arc<Mutex<Tickets>>,
}

impl ProjectsService {
    pub(crate) fn new(inner: Arc<CoreInner>, handle: Handle) -> Self {
        Self {
            inner,
            handle,
            tickets: Arc::default(),
        }
    }
    /// The view now, then every change (latest wins).
    pub fn watch(&self) -> ClonesViews {
        ClonesViews {
            view: self.handle.view(),
            first: true,
        }
    }
    /// Queues `intent`; its outcome is not reported.
    pub fn send(&self, intent: ProjectsIntent) {
        let _ = self.handle.send(self::intent(intent), None);
    }
    /// Queues `intent` and returns the ticket [`Self::settled`] takes.
    pub fn request(&self, intent: ProjectsIntent) -> u64 {
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
    pub async fn settled(&self, ticket: u64) -> Result<ProjectsSettled, CoreFailure> {
        let rx = self
            .tickets
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .1
            .remove(&ticket);
        let settled = self.inner.ticket(self.handle.scope(), rx).await?;
        Ok(ProjectsSettled {
            revision: settled.revision,
            outcome: match settled.outcome {
                Outcome::Refused(message) => ProjectsOutcome::Refused { message },
                Outcome::Discovered(discovery) => ProjectsOutcome::Discovered { discovery },
                Outcome::Started => ProjectsOutcome::Started,
                Outcome::Acknowledged(accepted) => ProjectsOutcome::Acknowledged { accepted },
                Outcome::Done => ProjectsOutcome::Done,
                Outcome::Failed => ProjectsOutcome::Failed,
            },
        })
    }
}

fn intent(intent: ProjectsIntent) -> Intent {
    match intent {
        ProjectsIntent::Discover => Intent::Discover,
        ProjectsIntent::Commit {
            discovery,
            url,
            allowed,
        } => Intent::Commit {
            discovery,
            url,
            allowed,
        },
        ProjectsIntent::ReadBack => Intent::ReadBack,
        ProjectsIntent::Acknowledge { job_id } => Intent::Acknowledge(job_id),
        ProjectsIntent::Dismiss { job_id } => Intent::Dismiss(job_id),
        ProjectsIntent::Retire { project_ids } => Intent::Retire(project_ids),
        ProjectsIntent::Close => Intent::Close,
    }
}

/// A [`ProjectsService::watch`] stream.
pub struct ClonesViews {
    view: View<ClonesView>,
    first: bool,
}

impl ClonesViews {
    /// The next view; `None` once the service stopped.
    pub async fn next(&mut self) -> Option<ClonesView> {
        if !self.first {
            self.view.changed().await.ok()?;
        }
        self.first = false;
        Some(self.view.latest()?.as_ref().clone())
    }
}

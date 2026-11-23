//! Project clones (architecture §3.3, P8): the pending project rows of one
//! computer, ported from `device_link/projects/clone_repository.dart`
//! (`DeviceProjectCloneRepository`, CAN-5796) and the display name of
//! `data/models/git_remote_url.dart` (`repositoryNameFromCloneUrl`). The
//! actor in `cc-app::projects` sends the requests; this book applies their
//! answers, pushes and read-backs, and says what to do next.
//!
//! A clone is not idempotent: each attempt sends one request with its own
//! job id, and a lost answer is read back from the computer's clone jobs,
//! never resent. Only the user can let another clone go ahead while a
//! result is unknown.
mod name;
pub use name::repository_name;

use crate::dart::Dv;

/// `DeviceProjectClonePhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClonePhase {
    /// The computer may still be cloning, or its answer is being read back.
    Cloning,
    /// The computer created the project; the inventory does not list it yet.
    AwaitingProject,
    /// The computer confirmed the clone failed, or never received it.
    Failed,
    /// The computer is not running the clone, but its result is unknown.
    Unknown,
}

/// Why a clone failed, worded by the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloneFailure {
    /// The computer's own path-free failure copy.
    CloneFailed,
    /// `remote_channel_unavailable`: the computer cannot add projects.
    Unsupported,
    /// The request was not sent.
    NotSent,
}

/// Why another clone cannot start (`_addRefusal`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddRefusal {
    /// A folder lookup or a clone is running.
    WaitForClone,
    /// A result is unknown and the user has not accepted a duplicate.
    Unconfirmed,
}

/// One pending project row (`DeviceProjectClone`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloneRow {
    pub job_id: String,
    /// The repository name derived from the URL; the URL is not kept.
    pub name: String,
    pub phase: ClonePhase,
    pub failure: Option<CloneFailure>,
}

impl CloneRow {
    /// Rows the computer may still be working on cannot be dismissed.
    pub fn dismissible(&self) -> bool {
        self.phase != ClonePhase::Cloning
    }
}

#[derive(Debug, Clone)]
struct Attempt {
    job_id: String,
    name: String,
    /// The connection generation that carried the request.
    generation: u64,
    phase: ClonePhase,
    workspace_id: Option<String>,
    failure: Option<CloneFailure>,
    /// The request's own answer can no longer arrive.
    answer_lost: bool,
    background_requested: bool,
    /// Matching pushes, so an older job list cannot overwrite them.
    pushes: u64,
    /// Dismissed while unknown: hidden, but still unresolved.
    hidden: bool,
    /// While unknown, the user accepted a possible duplicate.
    acknowledged: bool,
}

impl Attempt {
    fn unresolved(&self) -> bool {
        matches!(self.phase, ClonePhase::Cloning | ClonePhase::Unknown)
    }
    fn blocks_add(&self) -> bool {
        self.phase == ClonePhase::Unknown && !self.acknowledged
    }
    fn row(&self) -> CloneRow {
        CloneRow {
            job_id: self.job_id.clone(),
            name: self.name.clone(),
            phase: self.phase,
            failure: self.failure,
        }
    }
}

/// What applying an answer, push or read-back asks the actor to do.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Effects {
    /// The rows changed (`onChanged`).
    pub changed: bool,
    /// The computer created a project (`onCreated`).
    pub created: bool,
    /// Jobs to move to the background (`clone-jobs:background`).
    pub background: Vec<String>,
    /// A lost answer asks for a read-back.
    pub read_back: bool,
}

impl Effects {
    fn merge(&mut self, other: Effects) {
        self.changed |= other.changed;
        self.created |= other.created;
        self.read_back |= other.read_back;
        self.background.extend(other.background);
    }
}

/// One computer's clone attempts, oldest first.
#[derive(Debug, Default)]
pub struct CloneBook {
    attempts: Vec<Attempt>,
}

/// The pushes each attempt had seen when a read-back started.
pub type PushCounts = Vec<(String, u64)>;

impl CloneBook {
    /// `clones`: the rows that are not hidden.
    pub fn rows(&self) -> Vec<CloneRow> {
        self.attempts
            .iter()
            .filter(|a| !a.hidden)
            .map(Attempt::row)
            .collect()
    }
    /// `unconfirmed`: the oldest unknown result that blocks another clone,
    /// even when its row is hidden.
    pub fn unconfirmed(&self) -> Option<CloneRow> {
        self.attempts
            .iter()
            .find(|a| a.blocks_add())
            .map(Attempt::row)
    }
    /// `_addRefusal`, with the actor's folder lookup state.
    pub fn add_refusal(&self, discovering: bool) -> Option<AddRefusal> {
        if discovering || self.attempts.iter().any(|a| a.phase == ClonePhase::Cloning) {
            return Some(AddRefusal::WaitForClone);
        }
        self.attempts
            .iter()
            .any(Attempt::blocks_add)
            .then_some(AddRefusal::Unconfirmed)
    }
    /// A new attempt for `job_id`, sent on connection `generation`.
    pub fn start(&mut self, job_id: String, name: String, generation: u64) {
        self.attempts.push(Attempt {
            job_id,
            name,
            generation,
            phase: ClonePhase::Cloning,
            workspace_id: None,
            failure: None,
            answer_lost: false,
            background_requested: false,
            pushes: 0,
            hidden: false,
            acknowledged: false,
        });
    }

    fn current(&mut self, job_id: &str) -> Option<&mut Attempt> {
        // `_isCurrent`: still listed and unresolved.
        self.attempts
            .iter_mut()
            .find(|a| a.job_id == job_id)
            .filter(|a| a.unresolved())
    }

    /// `_created`.
    pub fn created(&mut self, job_id: &str, workspace_id: String) -> Effects {
        let Some(a) = self.current(job_id) else {
            return Effects::default();
        };
        a.workspace_id = Some(workspace_id);
        a.phase = ClonePhase::AwaitingProject;
        a.hidden = false;
        Effects {
            changed: true,
            created: true,
            ..Effects::default()
        }
    }
    /// `_failed`.
    pub fn failed(&mut self, job_id: &str, failure: CloneFailure) -> Effects {
        let Some(a) = self.current(job_id) else {
            return Effects::default();
        };
        a.phase = ClonePhase::Failed;
        a.failure = Some(failure);
        a.hidden = false;
        Effects {
            changed: true,
            ..Effects::default()
        }
    }
    /// `_lost`: the answer can no longer arrive; read the jobs back.
    pub fn lost(&mut self, job_id: &str) -> Effects {
        let Some(a) = self.current(job_id) else {
            return Effects::default();
        };
        a.answer_lost = true;
        Effects {
            read_back: true,
            ..Effects::default()
        }
    }
    /// The workspace id a `workspace:add-from-remote` answer carries.
    pub fn answered(&mut self, job_id: &str, reply: &Dv) -> Effects {
        match reply.get("id") {
            Dv::Str(id) if reply.is_map() && !id.is_empty() => self.created(job_id, id.clone()),
            _ => self.lost(job_id),
        }
    }

    /// `_needsReadBack` on connection `generation`.
    fn needs_read_back(a: &Attempt, generation: u64) -> bool {
        a.phase == ClonePhase::Unknown
            || (a.phase == ClonePhase::Cloning && (a.answer_lost || a.generation != generation))
    }
    /// Whether a read-back has anything to read.
    pub fn wants_read_back(&self, generation: u64) -> bool {
        self.attempts
            .iter()
            .any(|a| Self::needs_read_back(a, generation))
    }
    /// What each attempt had seen when a read-back starts.
    pub fn push_counts(&self) -> PushCounts {
        self.attempts
            .iter()
            .map(|a| (a.job_id.clone(), a.pushes))
            .collect()
    }
    /// Applies a `clone-jobs:list` reply read on `generation`
    /// (`readBack`); `jobs` that is not a list changes nothing.
    pub fn read_back(&mut self, jobs: &Dv, generation: u64, seen: &PushCounts) -> Effects {
        let mut effects = Effects::default();
        let Some(jobs) = jobs.elements() else {
            return effects;
        };
        let targets: Vec<String> = self
            .attempts
            .iter()
            .filter(|a| Self::needs_read_back(a, generation))
            .map(|a| a.job_id.clone())
            .collect();
        for job_id in targets {
            let job = jobs
                .iter()
                .find(|job| job.is_map() && job.get("id").is_str(&job_id));
            if let Some(job) = job {
                effects.merge(self.apply(&job_id, job));
                continue;
            }
            let before = seen
                .iter()
                .find(|(id, _)| *id == job_id)
                .map(|(_, pushes)| *pushes);
            if let Some(a) = self.current(&job_id)
                && a.phase == ClonePhase::Cloning
                && before == Some(a.pushes)
            {
                // Not running there and no push arrived during the read:
                // absence proves neither success nor failure.
                a.phase = ClonePhase::Unknown;
                effects.changed = true;
            }
        }
        effects
    }
    /// A `clone-jobs:changed` push's jobs (`args.first`).
    pub fn pushed(&mut self, jobs: &Dv) -> Effects {
        let mut effects = Effects::default();
        let Some(jobs) = jobs.elements() else {
            return effects;
        };
        for job in jobs.into_iter().filter(|j| j.is_map()) {
            let ids: Vec<String> = self
                .attempts
                .iter()
                .filter(|a| job.get("id").is_str(&a.job_id))
                .map(|a| a.job_id.clone())
                .collect();
            for id in ids {
                if let Some(a) = self.attempts.iter_mut().find(|a| a.job_id == id) {
                    a.pushes += 1;
                }
                effects.merge(self.apply(&id, job));
            }
        }
        effects
    }
    /// `_apply`.
    fn apply(&mut self, job_id: &str, job: &Dv) -> Effects {
        let mut effects = Effects::default();
        let Some(a) = self.current(job_id) else {
            return effects;
        };
        let status = job.get("status");
        if status.is_str("running") {
            if a.phase == ClonePhase::Unknown {
                // Running again: an earlier acknowledgment no longer applies.
                a.phase = ClonePhase::Cloning;
                a.hidden = false;
                a.acknowledged = false;
                effects.changed = true;
            }
            if !job.get("background").is_true() && !a.background_requested {
                a.background_requested = true;
                effects.background.push(a.job_id.clone());
            }
        } else if status.is_str("succeeded") {
            if let Dv::Str(id) = job.get("workspaceId")
                && !id.is_empty()
            {
                let id = id.clone();
                effects.merge(self.created(job_id, id));
            }
        } else if status.is_str("failed") {
            effects.merge(self.failed(job_id, CloneFailure::CloneFailed));
        }
        effects
    }
    /// `clone-jobs:background` failed: the next running job asks again.
    pub fn background_failed(&mut self, job_id: &str) {
        if let Some(a) = self.attempts.iter_mut().find(|a| a.job_id == job_id) {
            a.background_requested = false;
        }
    }
    /// `acknowledgeUnknown`: false when `job_id` is no longer unknown.
    pub fn acknowledge(&mut self, job_id: &str) -> bool {
        match self
            .attempts
            .iter_mut()
            .find(|a| a.job_id == job_id && a.phase == ClonePhase::Unknown)
        {
            Some(a) => {
                a.acknowledged = true;
                true
            }
            None => false,
        }
    }
    /// Whether `job_id` is an unknown attempt (`acknowledgeUnknown`'s
    /// lookup).
    pub fn is_unknown(&self, job_id: &str) -> bool {
        self.attempts
            .iter()
            .any(|a| a.job_id == job_id && a.phase == ClonePhase::Unknown)
    }
    /// `dismiss`: removes a settled row, or hides an unknown one; whether
    /// anything changed.
    pub fn dismiss(&mut self, job_id: &str) -> bool {
        let mut changed = false;
        let mut i = 0;
        while i < self.attempts.len() {
            let a = &mut self.attempts[i];
            if a.job_id != job_id || a.phase == ClonePhase::Cloning || a.hidden {
                i += 1;
                continue;
            }
            changed = true;
            if a.phase == ClonePhase::Unknown {
                a.hidden = true;
                i += 1;
            } else {
                self.attempts.remove(i);
            }
        }
        changed
    }
    /// `retireListed`: drops rows whose created project is listed.
    pub fn retire(&mut self, project_ids: &[String]) -> bool {
        let count = self.attempts.len();
        self.attempts.retain(|a| {
            a.workspace_id
                .as_ref()
                .is_none_or(|id| !project_ids.contains(id))
        });
        self.attempts.len() != count
    }
    pub fn clear(&mut self) {
        self.attempts.clear();
    }
}

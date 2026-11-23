//! Worktree creation and archive (architecture §3.3, P8), the reading and
//! request rules of `device_link/worktrees/{creation,archive}.dart`; the
//! flows that send them are in `cc-app::worktrees`. Comments cite the Dart
//! rule they keep. A rule that reads a desktop value returns the Dart throw
//! as [`Thrown`] or as a [`Refusal`] the app words.
use crate::{
    chat::{Thrown, link_string, object},
    dart::{Dv, DvMap},
};
use std::collections::HashMap;

/// A rule refused before anything was sent, with Dart's words for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// `This project is no longer available.`
    ProjectGone,
    /// `Choose a code project to create a worktree.`
    CoworkProject,
    /// `This worktree is no longer available.`
    WorktreeGone,
}

/// What reading or building failed with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    Thrown(Thrown),
    Refused(Refusal),
}

impl From<Thrown> for Fault {
    fn from(t: Thrown) -> Self {
        Self::Thrown(t)
    }
}

/// `(deviceLinkObject(reply)['items'] as List? ?? const [])
/// .whereType<Map<String, dynamic>>()`.
pub fn project_items(reply: &Dv) -> Result<Vec<&DvMap>, Thrown> {
    let items = match object(reply)?.get("items") {
        Dv::Null => return Ok(Vec::new()),
        Dv::List(items) => items,
        Dv::Bytes(_) => return Ok(Vec::new()),
        _ => return Err(Thrown::Cast),
    };
    Ok(items
        .iter()
        .filter_map(|item| match item {
            Dv::Map(map) => Some(map),
            _ => None,
        })
        .collect())
}

/// `row[key] as List? ?? const []`.
fn rows<'a>(map: &'a DvMap, key: &str) -> Result<&'a [Dv], Thrown> {
    match map.get(key) {
        Dv::Null | Dv::Bytes(_) => Ok(&[]),
        Dv::List(items) => Ok(items),
        _ => Err(Thrown::Cast),
    }
}

/// `DeviceWorktreeCreator._project`: the listed, visible, unarchived project
/// `id`.
pub fn live_project<'a>(reply: &'a Dv, id: &str) -> Result<&'a DvMap, Fault> {
    project_items(reply)?
        .into_iter()
        .find(|row| {
            row.get("id").is_str(id)
                && !row.get("hidden").is_true()
                && row.get("archivedAt").is_null()
        })
        .ok_or(Fault::Refused(Refusal::ProjectGone))
}

/// The `worktree:create` / `workspace:create-worktree` request of one
/// attempt.
#[derive(Debug, Clone, PartialEq)]
pub struct CreateRequest {
    pub multi: bool,
    /// The single-repo project's repository path.
    pub repo_path: Option<String>,
    /// The project's listed worktree ids, in order.
    pub existing: Vec<String>,
}

/// `_create`'s request, before anything is sent.
pub fn create_request(project: &DvMap) -> Result<CreateRequest, Fault> {
    let multi = project.get("type").is_str("multi-repo");
    if project.get("type").is_str("cowork") {
        return Err(Fault::Refused(Refusal::CoworkProject));
    }
    // `(project['worktrees'] as List? ?? const []).whereType<Map>()`.
    let existing = rows(project, "worktrees")?
        .iter()
        .filter_map(|row| match row {
            Dv::Map(row) => row.get("id").as_str().map(str::to_owned),
            _ => None,
        })
        .collect();
    let repo_path = if multi {
        None
    } else {
        Some(link_string(project, "repoPath")?.to_owned())
    };
    Ok(CreateRequest {
        multi,
        repo_path,
        existing,
    })
}

/// A create reply as the attempt keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Created {
    pub id: String,
    /// `result['branchName'] as String?`; `None` takes the default name.
    pub branch_name: Option<String>,
    /// `result['setupPhase'] != 'git-pending'`.
    pub ready: bool,
}

/// `deviceLinkObject(reply)`, `deviceLinkString(result, 'id')`,
/// `result['branchName'] as String?`, in Dart's order.
pub fn created(reply: &Dv) -> Result<Created, Thrown> {
    let result = object(reply)?;
    let id = link_string(result, "id")?.to_owned();
    let branch_name = result
        .get("branchName")
        .cast_str()
        .map_err(|_| Thrown::Cast)?
        .map(str::to_owned);
    Ok(Created {
        id,
        branch_name,
        ready: !result.get("setupPhase").is_str("git-pending"),
    })
}

/// What a fresh project read says about a created worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Readiness {
    /// `setupPhase == 'git-ready'` or `creation.state == 'complete'`.
    pub ready: bool,
    /// `creation.state == 'recovery-required'` (checked after `ready`).
    pub recovery: bool,
}

/// The created row `worktree_id` of a fresh project read.
pub fn readiness(project: &DvMap, worktree_id: &str) -> Result<Readiness, Thrown> {
    let row = rows(project, "worktrees")?
        .iter()
        .find_map(|row| match row {
            Dv::Map(row) if row.get("id").is_str(worktree_id) => Some(row),
            _ => None,
        });
    let Some(row) = row else {
        return Ok(Readiness::default());
    };
    let creation = row.get("creation");
    let state = |s: &str| creation.is_map() && creation.get("state").is_str(s);
    Ok(Readiness {
        ready: row.get("setupPhase").is_str("git-ready") || state("complete"),
        recovery: state("recovery-required"),
    })
}

/// A `worktree:git-ready` / `worktree:git-failed` push of an active
/// project.
#[derive(Debug, Clone, PartialEq)]
pub struct GitEvent {
    /// `row['projectId']` as Dart's map lookup compares it.
    pub project: Dv,
    /// `'$project/${row['worktreeId']}'`.
    pub key: String,
    pub failed: bool,
    /// The push's own map.
    pub row: DvMap,
}

impl GitEvent {
    /// `event['branchName'] as String?`.
    pub fn branch_name(&self) -> Result<Option<String>, Thrown> {
        self.row
            .get("branchName")
            .cast_str()
            .map(|s| s.map(str::to_owned))
            .map_err(|_| Thrown::Cast)
    }
}

/// `DeviceWorktreeCreator._event` on one `ipc.push` payload: `None` for any
/// push it ignores before reading the row. A row that is not a
/// `Map<String, dynamic>` is ignored too.
pub fn git_event(channel: &str, args: &Dv) -> Option<GitEvent> {
    let failed = match channel {
        "worktree:git-ready" => false,
        "worktree:git-failed" => true,
        _ => return None,
    };
    let first = match args {
        Dv::List(items) => items.first()?,
        _ => return None,
    };
    let Dv::Map(row) = first else {
        return None;
    };
    let project = row.get("projectId").clone();
    let key = format!(
        "{}/{}",
        project.dart_string(),
        row.get("worktreeId").dart_string()
    );
    Some(GitEvent {
        project,
        key,
        failed,
        row: row.clone(),
    })
}

/// `_git`: pushes kept for a waiter that has not started waiting yet.
#[derive(Debug, Default)]
pub struct GitEvents {
    events: HashMap<String, GitEvent>,
}

/// At most this many keys are kept.
const GIT_EVENTS: usize = 32;

impl GitEvents {
    /// `if (_git.length < 32 || _git.containsKey(key)) _git[key] = value`.
    pub fn keep(&mut self, event: GitEvent) {
        if self.events.len() < GIT_EVENTS || self.events.contains_key(&event.key) {
            self.events.insert(event.key.clone(), event);
        }
    }
    pub fn get(&self, key: &str) -> Option<&GitEvent> {
        self.events.get(key)
    }
    pub fn remove(&mut self, key: &str) {
        self.events.remove(key);
    }
    pub fn clear(&mut self) {
        self.events.clear();
    }
}

/// The archive request of `worktree_id` in project `project_id`
/// (`DeviceWorktreeArchiver.archive`).
#[derive(Debug, Clone, PartialEq)]
pub struct ArchiveRequest {
    pub multi: bool,
    pub repo_path: Option<String>,
    /// Every other listed worktree id, in order.
    pub remaining: Vec<String>,
    /// The target row's `createdAt` when it is a string.
    pub created_at: Option<String>,
}

/// Reads the archive request from a `projects:load` reply.
pub fn archive_request(
    reply: &Dv,
    project_id: &str,
    worktree_id: &str,
) -> Result<ArchiveRequest, Fault> {
    let project = project_items(reply)?
        .into_iter()
        .find(|row| row.get("id").is_str(project_id));
    let project = match project {
        Some(p) if p.get("type").is_str("single-repo") || p.get("type").is_str("multi-repo") => p,
        _ => return Err(Fault::Refused(Refusal::ProjectGone)),
    };
    // `.whereType<Map<String, dynamic>>()`.
    let listed: Vec<&DvMap> = rows(project, "worktrees")?
        .iter()
        .filter_map(|row| match row {
            Dv::Map(row) => Some(row),
            _ => None,
        })
        .collect();
    let target = listed
        .iter()
        .find(|row| row.get("id").is_str(worktree_id))
        .ok_or(Fault::Refused(Refusal::WorktreeGone))?;
    let remaining = listed
        .iter()
        .filter_map(|row| row.get("id").as_str())
        .filter(|id| *id != worktree_id)
        .map(str::to_owned)
        .collect();
    let multi = project.get("type").is_str("multi-repo");
    let repo_path = if multi {
        None
    } else {
        Some(link_string(project, "repoPath")?.to_owned())
    };
    Ok(ArchiveRequest {
        multi,
        repo_path,
        remaining,
        created_at: target.get("createdAt").as_str().map(str::to_owned),
    })
}

/// `response is Map && response['success'] == false`.
pub fn archive_refused(response: &Dv) -> bool {
    response.is_map() && matches!(response.get("success"), Dv::Bool(false))
}

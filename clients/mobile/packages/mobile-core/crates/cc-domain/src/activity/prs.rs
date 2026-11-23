//! Pull requests: the saved and pushed observations of a worktree's PRs
//! (`pr_repository.dart` `_observe`, `_actionRepo`, `_parseRepo`), the
//! models they parse into (`RemotePrRepo`, `RemoteWorktreePr`,
//! `RemotePrCheck`, `RemotePrMergeQueue`) and the creation and merge
//! progress feeds (`pr_progress.dart`).
use super::{Thrown, cast_int, cast_string, cast_string_or};
use crate::{
    chat::link_string,
    dart::{Dv, DvMap, parse_datetime},
};
use std::collections::{HashMap, HashSet};

/// `RemotePrCheck`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub name: String,
    pub status: Option<String>,
    pub execution_state: Option<String>,
    /// An absolute http(s) URL with a host, trimmed.
    pub details_url: Option<String>,
}

/// `RemotePrMergeQueuePhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeQueuePhase {
    Queued,
    AwaitingChecks,
    Mergeable,
    Locked,
    Unmergeable,
    Unknown,
}

/// `RemotePrMergeQueue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeQueue {
    pub in_queue: bool,
    pub position: Option<i64>,
    pub phase: Option<MergeQueuePhase>,
}

/// `RemoteWorktreePr` as `fromPortal` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrStatus {
    pub repo_id: Option<String>,
    pub number: Option<i64>,
    pub url: Option<String>,
    pub state: String,
    pub title: Option<String>,
    pub base_ref_name: Option<String>,
    pub check_status: Option<String>,
    pub checks: Vec<Check>,
    /// `none` reads as absent; `changes_requested` as `changes-requested`.
    pub review_status: Option<String>,
    pub merge_ready: Option<bool>,
    pub has_conflicts: Option<bool>,
    pub comment_count: Option<i64>,
    pub unresolved_review_thread_count: Option<i64>,
    pub merge_queue: Option<MergeQueue>,
}

impl PrStatus {
    /// `isInMergeQueue`.
    pub fn in_merge_queue(&self) -> bool {
        self.state == "open" && self.merge_queue.as_ref().is_some_and(|q| q.in_queue)
    }
}

/// `RemotePrRepo`: eligibility is computed by the desktop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrRepo {
    pub repo_id: String,
    pub repo_name: String,
    pub pr: Option<PrStatus>,
    pub base_branch: Option<String>,
    pub head_branch: Option<String>,
    pub published: Option<bool>,
    pub can_create: bool,
    pub can_merge: bool,
    pub merge_warning: bool,
    pub create_blocked_reason: Option<String>,
    pub merge_blocked_reason: Option<String>,
}

/// `RemotePrCheck._webUri`: `Uri.tryParse(value.trim())` with a host and
/// an http(s) scheme.
fn web_url(value: &Dv) -> Option<String> {
    let trimmed = value.as_str()?.trim_matches(crate::dart::is_space);
    let (scheme, rest) = trimmed.split_once(':')?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.strip_prefix("//")?;
    let end = authority.find(['/', '?', '#']).unwrap_or(authority.len());
    let host_port = authority[..end].rsplit('@').next().unwrap_or_default();
    let host = match host_port.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => host_port.split(':').next().unwrap_or_default(),
    };
    if host.is_empty() || trimmed.chars().any(|c| c == ' ') {
        return None;
    }
    Some(trimmed.to_owned())
}

/// `RemotePrCheck.listFromJson`: malformed entries are skipped.
fn checks(value: &Dv) -> Vec<Check> {
    let Dv::List(items) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|entry| {
            let Dv::Map(json) = entry else {
                return None;
            };
            let name = json.get("name").as_str().filter(|n| !n.is_empty())?;
            Some(Check {
                name: name.to_owned(),
                status: json.get("status").as_str().map(str::to_owned),
                execution_state: json.get("executionState").as_str().map(str::to_owned),
                details_url: web_url(json.get("detailsUrl")),
            })
        })
        .collect()
}

/// `RemotePrMergeQueuePhase.fromWire`.
fn queue_phase(value: &Dv) -> Option<MergeQueuePhase> {
    Some(match value.as_str()? {
        "queued" => MergeQueuePhase::Queued,
        "awaiting_checks" => MergeQueuePhase::AwaitingChecks,
        "mergeable" => MergeQueuePhase::Mergeable,
        "locked" => MergeQueuePhase::Locked,
        "unmergeable" => MergeQueuePhase::Unmergeable,
        _ => MergeQueuePhase::Unknown,
    })
}

/// `RemotePrMergeQueue.tryParse`; `position.toInt()` of NaN throws.
fn merge_queue(raw: &Dv) -> Result<Option<MergeQueue>, Thrown> {
    let Dv::Map(raw) = raw else {
        return Ok(None);
    };
    let Dv::Bool(in_queue) = raw.get("inQueue") else {
        return Ok(None);
    };
    let position = match raw.get("position") {
        p @ (Dv::Int(_) | Dv::Float(_)) => cast_int(p)?,
        _ => None,
    };
    Ok(Some(MergeQueue {
        in_queue: *in_queue,
        position,
        phase: if *in_queue {
            queue_phase(raw.get("phase"))
        } else {
            None
        },
    }))
}

/// `RemoteWorktreePr.fromPortal`.
fn status(json: &DvMap, repo_id: Option<String>) -> Result<PrStatus, Thrown> {
    let number = cast_int(json.get("number"))?;
    let url = cast_string(json.get("url"))?;
    let state = cast_string_or(json.get("state"), "")?;
    let title = cast_string(json.get("title"))?;
    let base_ref_name = cast_string(json.get("baseRefName"))?;
    let check_status = cast_string(json.get("checkStatus"))?;
    let checks = checks(json.get("checkDetails"));
    let review_status = match cast_string(json.get("reviewStatus"))?.as_deref() {
        Some("none") => None,
        Some("changes_requested") => Some("changes-requested".to_owned()),
        other => other.map(str::to_owned),
    };
    let bool_of = |key: &str| json.get(key).cast_bool().map_err(|_| Thrown::Cast);
    Ok(PrStatus {
        repo_id,
        number,
        url,
        state,
        title,
        base_ref_name,
        check_status,
        checks,
        review_status,
        merge_ready: bool_of("mergeReady")?,
        has_conflicts: bool_of("hasConflicts")?,
        comment_count: cast_int(json.get("commentCount"))?,
        unresolved_review_thread_count: cast_int(json.get("unresolvedReviewThreadCount"))?,
        merge_queue: None,
    })
}

/// `_parseRepo`: `RemotePrRepo.fromJson` with the status's merge queue.
pub fn parse_repo(row: &DvMap, repository: &str) -> Result<PrRepo, Thrown> {
    link_string(row, "repoId")?;
    let repo_id = cast_string_or(row.get("repoId"), "")?;
    let repo_name = cast_string_or(row.get("repoName"), repository)?;
    let mut pr = match row.get("status") {
        Dv::Map(json) => Some(status(json, cast_string(row.get("repoId"))?)?),
        _ => None,
    };
    let text = |key: &str| row.get(key).as_str().map(str::to_owned);
    let published = row.get("published").cast_bool().map_err(|_| Thrown::Cast)?;
    if let (Dv::Map(json), Some(pr)) = (row.get("status"), pr.as_mut()) {
        pr.merge_queue = merge_queue(json.get("mergeQueue"))?;
    }
    Ok(PrRepo {
        repo_id,
        repo_name,
        pr,
        base_branch: text("baseBranch"),
        head_branch: text("headBranch"),
        published,
        can_create: row.get("canCreate").is_true(),
        can_merge: row.get("canMerge").is_true(),
        merge_warning: row.get("mergeWarning").is_true(),
        create_blocked_reason: text("createBlockedReason"),
        merge_blocked_reason: text("mergeBlockedReason"),
    })
}

/// `_actionRepo`: a saved or pushed repository row in `get_actions`
/// shape (`prNumber`/`prUrl` as `number`/`url`, check statuses in the
/// detailed vocabulary), with the action's branches when given.
pub fn action_repo(raw: &DvMap, branches: Option<(Dv, Dv)>) -> Result<DvMap, Thrown> {
    let mut out = raw.clone();
    if let Some((base, head)) = branches {
        out.insert("baseBranch".into(), base);
        out.insert("headBranch".into(), head);
    }
    if let Dv::Map(status) = raw.get("status") {
        let mut next = status.clone();
        next.insert("number".into(), status.get("prNumber").clone());
        next.insert("url".into(), status.get("prUrl").clone());
        let details = match status.get("checkDetails") {
            Dv::Null => Vec::new(),
            other => other.elements().ok_or(Thrown::Cast)?,
        };
        let mut checks = Vec::new();
        for check in details {
            let Dv::Map(check) = check else {
                continue;
            };
            let mut check = check.clone();
            let mapped = match check.get("status") {
                Dv::Str(s) if s == "passing" => Dv::Str("success".into()),
                Dv::Str(s) if s == "failing" => Dv::Str("failure".into()),
                other => other.clone(),
            };
            check.insert("status".into(), mapped);
            checks.push(Dv::Map(check));
        }
        next.insert("checkDetails".into(), Dv::List(checks));
        out.insert("status".into(), Dv::Map(next));
    }
    Ok(out)
}

/// One worktree's PR observations and their ordering (`_observations`,
/// `_liveClears`). The desktop broadcasts before persistence, so a
/// projects read can carry an older sample than a push.
#[derive(Debug, Clone, Default)]
pub struct Observations {
    samples: HashMap<String, DvMap>,
    live_clears: HashSet<String>,
}

impl Observations {
    pub fn get(&self, key: &str) -> Option<&DvMap> {
        self.samples.get(key)
    }
    pub fn clear(&mut self) {
        self.samples.clear();
        self.live_clears.clear();
    }
    /// `_forgetPr`'s part.
    pub fn forget(&mut self, key: &str) {
        self.samples.remove(key);
        self.live_clears.remove(key);
    }
    /// A pushed `null` status: a confirmed clear. Keeps the previous
    /// sample's ordering marker so a later read cannot restore that PR.
    pub fn confirm_clear(&mut self, key: &str) -> DvMap {
        self.live_clears.insert(key.to_owned());
        let mut sample = DvMap::new();
        sample.insert("repos".into(), Dv::List(Vec::new()));
        sample.insert(
            "lastCheckedAt".into(),
            self.samples
                .get(key)
                .map(|s| s.get("lastCheckedAt").clone())
                .unwrap_or(Dv::Null),
        );
        self.samples.insert(key.to_owned(), sample.clone());
        sample
    }

    /// `_observe(key, value, fromPush:)`: the newer of the kept sample and
    /// `value`; repositories whose lookup was unavailable keep their
    /// previous row.
    pub fn observe(
        &mut self,
        key: &str,
        value: &Dv,
        from_push: bool,
    ) -> Result<Option<DvMap>, Thrown> {
        let previous = self.samples.get(key).cloned();
        if !from_push && self.live_clears.contains(key) {
            return Ok(previous);
        }
        let Dv::Map(value) = value else {
            return Ok(previous);
        };
        let Dv::List(rows) = value.get("repos") else {
            return Ok(previous);
        };
        let time = |v: &Dv| -> Result<Option<i64>, Thrown> {
            Ok(cast_string(v)?.as_deref().and_then(parse_datetime))
        };
        let before = time(
            previous
                .as_ref()
                .map_or(&Dv::Null, |p| p.get("lastCheckedAt")),
        )?;
        let next = time(value.get("lastCheckedAt"))?;
        if from_push && self.live_clears.contains(key) && next.is_none() {
            return Ok(previous);
        }
        if let Some(before) = before
            && next.is_none_or(|next| next <= before)
        {
            return Ok(previous);
        }
        self.live_clears.remove(key);
        let old_rows: Vec<&DvMap> = match previous.as_ref().map(|p| p.get("repos")) {
            None | Some(Dv::Null) => Vec::new(),
            Some(other) => other
                .elements()
                .ok_or(Thrown::Cast)?
                .into_iter()
                .filter_map(|v| match v {
                    Dv::Map(m) => Some(m),
                    _ => None,
                })
                .collect(),
        };
        let mut repos = Vec::new();
        for row in rows {
            let Dv::Map(row) = row else {
                continue;
            };
            let kept = if matches!(row.get("prLookupAvailable"), Dv::Bool(false)) {
                old_rows
                    .iter()
                    .find(|old| old.get("repoId").loosely_equals(row.get("repoId")))
                    .map(|old| (*old).clone())
            } else {
                None
            };
            repos.push(Dv::Map(kept.unwrap_or_else(|| row.clone())));
        }
        let mut sample = value.clone();
        sample.insert("repos".into(), Dv::List(repos));
        self.samples.insert(key.to_owned(), sample.clone());
        Ok(Some(sample))
    }
}

/// `RemotePrCreationPhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreationPhase {
    GatheringChanges,
    Summarizing,
    Pushing,
    CreatingPr,
    Skipped,
    Done,
    Error,
}

impl CreationPhase {
    fn from_wire(value: &Dv) -> Option<Self> {
        Some(match value.as_str()? {
            "gathering_changes" => Self::GatheringChanges,
            "summarizing" => Self::Summarizing,
            "pushing" => Self::Pushing,
            "creating_pr" => Self::CreatingPr,
            "skipped" => Self::Skipped,
            "done" => Self::Done,
            "error" => Self::Error,
            _ => return None,
        })
    }
    pub fn settled(self) -> bool {
        matches!(self, Self::Done | Self::Error)
    }
}

/// `RemoteMergePrPhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergePhase {
    Queued,
    CheckingMergeability,
    WaitingMergeability,
    Merging,
    RefreshingPrStatus,
    Done,
    Error,
}

impl MergePhase {
    fn from_wire(value: &Dv) -> Option<Self> {
        Some(match value.as_str()? {
            "queued" => Self::Queued,
            "checking_mergeability" => Self::CheckingMergeability,
            "waiting_mergeability" => Self::WaitingMergeability,
            "merging" => Self::Merging,
            "refreshing_pr_status" => Self::RefreshingPrStatus,
            "done" => Self::Done,
            "error" => Self::Error,
            _ => return None,
        })
    }
    pub fn settled(self) -> bool {
        matches!(self, Self::Done | Self::Error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreationStep {
    pub phase: CreationPhase,
    pub repo_name: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeStep {
    pub phase: MergePhase,
    pub repo_id: Option<String>,
    pub repo_name: Option<String>,
    pub queue_position: Option<i64>,
    pub queue_length: Option<i64>,
    pub retry_delay_ms: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreationProgress {
    pub current: CreationPhase,
    pub steps: Vec<CreationStep>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeProgress {
    pub current: MergePhase,
    pub steps: Vec<MergeStep>,
}

/// `_stringOrNull` of `pr_progress.dart`: a non-empty string.
fn text(value: &Dv) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

/// `_intOrNull` of `pr_progress.dart`: a Dart `int` only.
fn int(value: &Dv) -> Option<i64> {
    match value {
        Dv::Int(n) => Some(*n),
        _ => None,
    }
}

/// `RemotePrCreationProgress.fromJson({'currentPhase': phase, 'steps': steps})`.
pub fn parse_creation(phase: &Dv, steps: &[DvMap]) -> Option<CreationProgress> {
    Some(CreationProgress {
        current: CreationPhase::from_wire(phase)?,
        steps: steps
            .iter()
            .filter_map(|row| {
                Some(CreationStep {
                    phase: CreationPhase::from_wire(row.get("phase"))?,
                    repo_name: text(row.get("repoName")),
                    error: text(row.get("error")),
                })
            })
            .collect(),
    })
}

/// `RemoteMergePrProgress.fromJson({'currentPhase': phase, 'steps': steps})`.
pub fn parse_merge(phase: &Dv, steps: &[DvMap]) -> Option<MergeProgress> {
    Some(MergeProgress {
        current: MergePhase::from_wire(phase)?,
        steps: steps
            .iter()
            .filter_map(|row| {
                Some(MergeStep {
                    phase: MergePhase::from_wire(row.get("phase"))?,
                    repo_id: text(row.get("repoId")),
                    repo_name: text(row.get("repoName")),
                    queue_position: int(row.get("queuePosition")),
                    queue_length: int(row.get("queueLength")),
                    retry_delay_ms: int(row.get("retryDelayMs")),
                    error: text(row.get("error")),
                })
            })
            .collect(),
    })
}

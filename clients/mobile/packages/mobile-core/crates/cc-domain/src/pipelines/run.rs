//! `RemotePipelineRun` and its parts (`data/models/computer_activity/
//! pipeline_run.dart`, shared with Remote Control): `fromJson` over the
//! [`super::display`] map, `mergeWith` and `comparePipelineRunRecency`.
use crate::dart::{Dv, DvMap, parse_datetime};
use std::cmp::Ordering;

/// `_stringOrNull`.
fn string_or_null(value: &Dv) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// `_string(value, fallback)`.
fn string(value: &Dv, fallback: &str) -> String {
    value.as_str().unwrap_or(fallback).to_owned()
}

/// `_intOrNull`: `value is num ? value.toInt() : null`.
fn int_or_null(value: &Dv) -> Option<i64> {
    match value {
        Dv::Int(n) => Some(*n),
        #[allow(clippy::cast_possible_truncation)]
        Dv::Float(f) if f.is_finite() => Some(f.trunc() as i64),
        _ => None,
    }
}

fn non_empty(value: &Dv) -> Option<String> {
    string_or_null(value).filter(|s| !s.is_empty())
}

/// `value is List`.
fn list(value: &Dv) -> Option<Vec<&Dv>> {
    value.elements()
}

fn map(value: &Dv) -> Option<&DvMap> {
    match value {
        Dv::Map(m) => Some(m),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub completed_steps: i64,
    pub total_steps: i64,
}

impl Progress {
    fn from_json(value: &Dv) -> Option<Self> {
        let value = map(value)?;
        Some(Self {
            completed_steps: int_or_null(value.get("completedSteps"))?,
            total_steps: int_or_null(value.get("totalSteps"))?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub step_id: String,
    pub name: String,
    pub status: String,
    pub attempt: Option<i64>,
    pub iteration: Option<i64>,
    pub recovery: Option<i64>,
    pub output_tail: Option<String>,
}

impl Step {
    fn from_json(value: &Dv) -> Option<Self> {
        let value = map(value)?;
        let step_id = non_empty(value.get("stepId"))?;
        Some(Self {
            name: string(value.get("name"), &step_id),
            status: string(value.get("status"), ""),
            attempt: int_or_null(value.get("attempt")),
            iteration: int_or_null(value.get("iteration")),
            recovery: int_or_null(value.get("recovery")),
            output_tail: string_or_null(value.get("outputTail")),
            step_id,
        })
    }
}

fn steps(value: &Dv) -> Vec<Step> {
    list(value)
        .map(|items| items.into_iter().filter_map(Step::from_json).collect())
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Variant {
    pub job_id: String,
    pub name: String,
    pub status: String,
    /// The matrix values (no surface draws them).
    pub matrix: DvMap,
    pub steps: Vec<Step>,
}

impl Variant {
    fn from_json(value: &Dv) -> Option<Self> {
        let value = map(value)?;
        let job_id = non_empty(value.get("jobId"))?;
        Some(Self {
            name: string(value.get("name"), &job_id),
            status: string(value.get("status"), ""),
            matrix: map(value.get("matrix")).cloned().unwrap_or_default(),
            steps: steps(value.get("steps")),
            job_id,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    pub job_id: String,
    pub name: String,
    pub status: String,
    /// `None`: the desktop sent no `needs`.
    pub needs: Option<Vec<String>>,
    pub steps: Vec<Step>,
    pub variants: Vec<Variant>,
    pub expansion: Option<String>,
    pub expansion_error: Option<String>,
}

impl Job {
    fn from_json(value: &Dv) -> Option<Self> {
        let value = map(value)?;
        let job_id = non_empty(value.get("jobId"))?;
        Some(Self {
            name: string(value.get("name"), &job_id),
            status: string(value.get("status"), ""),
            needs: list(value.get("needs")).map(|items| {
                items
                    .into_iter()
                    .filter_map(|n| n.as_str().map(str::to_owned))
                    .collect()
            }),
            steps: steps(value.get("steps")),
            variants: list(value.get("variants"))
                .map(|items| items.into_iter().filter_map(Variant::from_json).collect())
                .unwrap_or_default(),
            expansion: string_or_null(value.get("expansion")),
            expansion_error: string_or_null(value.get("expansionError")),
            job_id,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusReason {
    pub id: String,
    pub kind: String,
    pub code: String,
    pub provider: Option<String>,
    pub resets_at: Option<String>,
}

impl StatusReason {
    fn from_json(value: &Dv) -> Option<Self> {
        let value = map(value)?;
        Some(Self {
            id: non_empty(value.get("id"))?,
            kind: string(value.get("kind"), ""),
            code: string(value.get("code"), ""),
            provider: string_or_null(value.get("provider")),
            resets_at: string_or_null(value.get("resetsAt")),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pause {
    pub id: String,
    pub kind: String,
    pub job_id: String,
    pub step_id: String,
    pub title: Option<String>,
    pub message: Option<String>,
    pub field_labels: Vec<String>,
}

impl Pause {
    fn from_json(value: &Dv) -> Option<Self> {
        let value = map(value)?;
        let id = non_empty(value.get("id"))?;
        let request = map(value.get("request"));
        let fields = request.map_or(&Dv::Null, |r| r.get("fields"));
        Some(Self {
            id,
            kind: string(value.get("kind"), ""),
            job_id: string(value.get("jobId"), ""),
            step_id: string(value.get("stepId"), ""),
            title: request.and_then(|r| string_or_null(r.get("title"))),
            message: request.and_then(|r| string_or_null(r.get("message"))),
            field_labels: list(fields)
                .map(|items| {
                    items
                        .into_iter()
                        .filter_map(map)
                        .map(|field| string(field.get("label"), &string(field.get("key"), "")))
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
    fn has_detail(&self) -> bool {
        self.title.is_some() || self.message.is_some() || !self.field_labels.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatTurn {
    pub chat_id: String,
    pub user_message_id: String,
    /// `launched` | `watching`.
    pub relation: String,
}

impl ChatTurn {
    fn from_json(value: &Dv) -> Option<Self> {
        let value = map(value)?;
        let relation = string_or_null(value.get("relation"))?;
        if relation != "launched" && relation != "watching" {
            return None;
        }
        Some(Self {
            chat_id: non_empty(value.get("chatId"))?,
            user_message_id: non_empty(value.get("userMessageId"))?,
            relation,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatFollowUp {
    pub plan_available: bool,
    pub report_available: bool,
}

/// `RemotePipelineRun`.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub local_id: String,
    pub pipeline_id: Option<String>,
    pub pipeline_name: String,
    pub workspace_local_id: Option<String>,
    pub worktree_local_id: Option<String>,
    pub status: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub parent_execution_id: Option<String>,
    pub trigger_source: Option<String>,
    pub hidden: bool,
    pub truncated: bool,
    pub output_tail: Option<String>,
    pub progress: Option<Progress>,
    pub status_reasons: Vec<StatusReason>,
    pub pending_pauses: Vec<Pause>,
    /// `None`: this desktop sent no detail.
    pub jobs: Option<Vec<Job>>,
    /// `None`: this update did not say.
    pub chat_turns: Option<Vec<ChatTurn>>,
    pub chat_follow_up: Option<ChatFollowUp>,
}

impl Run {
    /// `RemotePipelineRun.fromJson`.
    pub fn from_json(json: &DvMap) -> Option<Self> {
        let local_id =
            string_or_null(json.get("localId")).or_else(|| string_or_null(json.get("runId")))?;
        if local_id.is_empty() {
            return None;
        }
        let chat_turns = list(json.get("chatTurns")).map(|items| {
            let mut out: Vec<ChatTurn> = Vec::new();
            for turn in items.into_iter().filter_map(ChatTurn::from_json) {
                if !out.contains(&turn) {
                    out.push(turn);
                }
            }
            out
        });
        Some(Self {
            pipeline_id: string_or_null(json.get("pipelineId")),
            pipeline_name: string(
                json.get("pipelineName"),
                &string(json.get("name"), &local_id),
            ),
            workspace_local_id: string_or_null(json.get("workspaceLocalId")),
            worktree_local_id: string_or_null(json.get("worktreeLocalId")),
            status: string(json.get("status"), ""),
            started_at: string_or_null(json.get("startedAt")),
            finished_at: string_or_null(json.get("finishedAt")),
            parent_execution_id: string_or_null(json.get("parentExecutionId")),
            trigger_source: string_or_null(json.get("triggerSource")),
            hidden: json.get("hidden").is_true(),
            truncated: json.get("truncated").is_true(),
            output_tail: string_or_null(json.get("outputTail")),
            progress: Progress::from_json(json.get("progress")),
            status_reasons: list(json.get("statusReasons"))
                .map(|items| {
                    items
                        .into_iter()
                        .filter_map(StatusReason::from_json)
                        .collect()
                })
                .unwrap_or_default(),
            pending_pauses: list(json.get("pendingPauses"))
                .map(|items| items.into_iter().filter_map(Pause::from_json).collect())
                .unwrap_or_default(),
            jobs: list(json.get("jobs"))
                .map(|items| items.into_iter().filter_map(Job::from_json).collect()),
            chat_turns,
            chat_follow_up: map(json.get("chatFollowUp")).map(|v| ChatFollowUp {
                plan_available: v.get("planAvailable").is_true(),
                report_available: v.get("reportAvailable").is_true(),
            }),
            local_id,
        })
    }

    /// `isRoot`.
    pub fn is_root(&self) -> bool {
        self.parent_execution_id.is_none()
    }

    /// `hasDetail`.
    pub fn has_detail(&self) -> bool {
        self.jobs.is_some()
    }

    /// `mergeWith(incoming)`.
    #[must_use]
    pub fn merge_with(&self, incoming: &Run) -> Run {
        let running = incoming.status == "pending" || incoming.status == "running";
        Run {
            local_id: incoming.local_id.clone(),
            pipeline_id: incoming
                .pipeline_id
                .clone()
                .or_else(|| self.pipeline_id.clone()),
            pipeline_name: if incoming.pipeline_name == incoming.local_id {
                self.pipeline_name.clone()
            } else {
                incoming.pipeline_name.clone()
            },
            workspace_local_id: incoming
                .workspace_local_id
                .clone()
                .or_else(|| self.workspace_local_id.clone()),
            worktree_local_id: incoming
                .worktree_local_id
                .clone()
                .or_else(|| self.worktree_local_id.clone()),
            status: if incoming.status.is_empty() {
                self.status.clone()
            } else {
                incoming.status.clone()
            },
            started_at: incoming
                .started_at
                .clone()
                .or_else(|| self.started_at.clone()),
            finished_at: incoming.finished_at.clone().or_else(|| {
                if running {
                    None
                } else {
                    self.finished_at.clone()
                }
            }),
            parent_execution_id: incoming
                .parent_execution_id
                .clone()
                .or_else(|| self.parent_execution_id.clone()),
            trigger_source: incoming
                .trigger_source
                .clone()
                .or_else(|| self.trigger_source.clone()),
            hidden: incoming.hidden,
            truncated: incoming.truncated,
            output_tail: incoming
                .output_tail
                .clone()
                .or_else(|| self.output_tail.clone()),
            progress: incoming.progress.clone().or_else(|| self.progress.clone()),
            status_reasons: if incoming.truncated && incoming.status_reasons.is_empty() {
                self.status_reasons.clone()
            } else {
                incoming.status_reasons.clone()
            },
            pending_pauses: merge_pauses(&self.pending_pauses, incoming),
            jobs: match &incoming.jobs {
                None => self.jobs.clone(),
                Some(next) => Some(merge_jobs(self.jobs.as_deref(), next)),
            },
            chat_turns: incoming
                .chat_turns
                .clone()
                .or_else(|| self.chat_turns.clone()),
            chat_follow_up: incoming.chat_follow_up.or(self.chat_follow_up),
        }
    }
}

/// `_mergePendingPauses`.
fn merge_pauses(held: &[Pause], incoming: &Run) -> Vec<Pause> {
    if !incoming.truncated {
        return incoming.pending_pauses.clone();
    }
    if incoming.pending_pauses.is_empty() {
        return held.to_vec();
    }
    incoming
        .pending_pauses
        .iter()
        .map(|pause| {
            // `heldById`: the last held pause with this id.
            match held.iter().rev().find(|h| h.id == pause.id) {
                Some(existing) if !pause.has_detail() && existing.has_detail() => existing.clone(),
                _ => pause.clone(),
            }
        })
        .collect()
}

/// A map from id to the last entry with that id (`{for (x in xs) x.id: x}`).
fn last_by<'a, T>(items: &'a [T], id: impl Fn(&T) -> &str, key: &str) -> Option<&'a T> {
    items.iter().rev().find(|item| id(item) == key)
}

/// `_mergeJobs`.
fn merge_jobs(existing: Option<&[Job]>, incoming: &[Job]) -> Vec<Job> {
    let Some(existing) = existing.filter(|e| !e.is_empty()) else {
        return incoming.to_vec();
    };
    incoming
        .iter()
        .map(|job| match last_by(existing, |j| &j.job_id, &job.job_id) {
            Some(before) => Job {
                steps: merge_steps(&before.steps, &job.steps),
                variants: merge_variants(&before.variants, &job.variants),
                ..job.clone()
            },
            None => job.clone(),
        })
        .collect()
}

/// `_mergeVariants`.
fn merge_variants(existing: &[Variant], incoming: &[Variant]) -> Vec<Variant> {
    if existing.is_empty() {
        return incoming.to_vec();
    }
    incoming
        .iter()
        .map(
            |variant| match last_by(existing, |v| &v.job_id, &variant.job_id) {
                Some(before) => Variant {
                    steps: merge_steps(&before.steps, &variant.steps),
                    ..variant.clone()
                },
                None => variant.clone(),
            },
        )
        .collect()
}

/// `_mergeSteps`.
fn merge_steps(existing: &[Step], incoming: &[Step]) -> Vec<Step> {
    if existing.is_empty() {
        return incoming.to_vec();
    }
    incoming
        .iter()
        .map(
            |step| match last_by(existing, |s| &s.step_id, &step.step_id) {
                Some(before)
                    if step.output_tail.is_none()
                        && step.attempt == before.attempt
                        && step.iteration == before.iteration
                        && step.recovery == before.recovery
                        && before.output_tail.is_some() =>
                {
                    Step {
                        output_tail: before.output_tail.clone(),
                        ..step.clone()
                    }
                }
                _ => step.clone(),
            },
        )
        .collect()
}

/// `comparePipelineRunRecency(a, b)`: newest first; runs without a start
/// time last.
pub fn compare_recency(a: &Run, b: &Run) -> Ordering {
    let left = b.started_at.as_deref().and_then(parse_datetime);
    let right = a.started_at.as_deref().and_then(parse_datetime);
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(l), Some(r)) => l.cmp(&r),
    }
}

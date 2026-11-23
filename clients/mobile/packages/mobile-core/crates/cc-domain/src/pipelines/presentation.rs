//! Run presentation shared with Remote Control: the status vocabulary and
//! action guards of `ui/core/activity/{pipeline_run_status,
//! pipeline_run_display}.dart` (groups and dependency tiers), and
//! `ui/core/pipelines/pipeline_content_chunks.dart`. The words are in
//! `cc-app::copy::pipelines`.
use super::run::{Job, Run, Step};

/// `normalizePipelineRunStatus`.
pub fn normalize_status(status: &str) -> &str {
    match status {
        "failed" | "timed_out" => "failure",
        "completed" | "succeeded" => "success",
        "queued" => "pending",
        other => other,
    }
}

/// `isPipelineRunActive`.
pub fn is_active(status: &str) -> bool {
    matches!(normalize_status(status), "pending" | "running" | "paused")
}

/// `pipelineRunStatusLabel`'s cases.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusLabel {
    Running,
    Restarting,
    Paused,
    Succeeded,
    Failed,
    Canceled,
    Queued,
    Skipped,
    Unknown,
    /// Any other status, shown as sent.
    Raw,
}

pub fn status_label(status: &str) -> StatusLabel {
    match normalize_status(status) {
        "running" => StatusLabel::Running,
        "restarting" => StatusLabel::Restarting,
        "paused" => StatusLabel::Paused,
        "success" => StatusLabel::Succeeded,
        "failure" => StatusLabel::Failed,
        "cancelled" => StatusLabel::Canceled,
        "pending" | "queued" => StatusLabel::Queued,
        "skipped" => StatusLabel::Skipped,
        "" => StatusLabel::Unknown,
        _ => StatusLabel::Raw,
    }
}

/// `pipelineTriggerLabel`'s cases: an absent trigger is manual.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Hook,
    Chat,
    Plan,
    Manual,
}

pub fn trigger(source: Option<&str>) -> Trigger {
    match source {
        Some("hook") => Trigger::Hook,
        Some("chat") => Trigger::Chat,
        Some("plan") => Trigger::Plan,
        _ => Trigger::Manual,
    }
}

/// `canCancelPipelineRun`.
pub fn can_cancel(run: &Run) -> bool {
    is_active(&run.status)
}

/// `canResumePipelineRun`: a paused root run not waiting for input.
pub fn can_resume(run: &Run) -> bool {
    run.is_root()
        && normalize_status(&run.status) == "paused"
        && !run.pending_pauses.iter().any(|p| p.kind == "input")
}

/// `canRetryPipelineRun`.
pub fn can_retry(run: &Run) -> bool {
    run.is_root() && matches!(normalize_status(&run.status), "failure" | "cancelled")
}

/// One expandable group (`PipelineRunGroup`): a job, or a matrix variant
/// one level under it; steps carry the physical job id their log needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub job_id: String,
    pub name: String,
    pub status: String,
    pub depth: u32,
    pub is_variant: bool,
    pub steps: Vec<(String, Step)>,
}

/// `buildPipelineRunGroups`.
pub fn groups(jobs: &[Job]) -> Vec<Group> {
    let mut out = Vec::new();
    for job in jobs {
        out.push(Group {
            job_id: job.job_id.clone(),
            name: job.name.clone(),
            status: job.status.clone(),
            depth: 0,
            is_variant: false,
            steps: job
                .steps
                .iter()
                .map(|s| (job.job_id.clone(), s.clone()))
                .collect(),
        });
        for variant in &job.variants {
            out.push(Group {
                job_id: variant.job_id.clone(),
                name: variant.name.clone(),
                status: variant.status.clone(),
                depth: 1,
                is_variant: true,
                steps: variant
                    .steps
                    .iter()
                    .map(|s| (variant.job_id.clone(), s.clone()))
                    .collect(),
            });
        }
    }
    out
}

/// `PipelineRunDotStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DotStatus {
    Pending,
    Running,
    Success,
    Failure,
    Paused,
    Cancelled,
    Skipped,
}

/// `pipelineRunDotStatus`.
pub fn dot_status(status: &str) -> DotStatus {
    match normalize_status(status) {
        "running" | "restarting" => DotStatus::Running,
        "success" => DotStatus::Success,
        "failure" => DotStatus::Failure,
        "paused" => DotStatus::Paused,
        "cancelled" => DotStatus::Cancelled,
        "skipped" => DotStatus::Skipped,
        _ => DotStatus::Pending,
    }
}

/// `PipelineRunDot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dot {
    pub job_id: String,
    pub name: String,
    pub status: DotStatus,
}

/// `buildPipelineRunDotTiers`: jobs in dependency tiers; one tier when no
/// job carries `needs`.
pub fn dot_tiers(jobs: &[Job]) -> Vec<Vec<Dot>> {
    if jobs.is_empty() {
        return Vec::new();
    }
    // `byId`: the last job per id, at its first position.
    let mut by_id: Vec<&Job> = Vec::new();
    for job in jobs {
        match by_id.iter_mut().find(|j| j.job_id == job.job_id) {
            Some(slot) => *slot = job,
            None => by_id.push(job),
        }
    }
    let dot = |job: &Job| Dot {
        job_id: job.job_id.clone(),
        name: job.name.clone(),
        status: dot_status(&job.status),
    };
    if jobs.iter().all(|job| job.needs.is_none()) {
        return vec![by_id.iter().map(|j| dot(j)).collect()];
    }
    let find = |id: &str| by_id.iter().position(|j| j.job_id == id);
    let needs: Vec<Vec<usize>> = by_id
        .iter()
        .map(|job| {
            job.needs
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter(|id| **id != job.job_id)
                .filter_map(|id| find(id))
                .collect()
        })
        .collect();
    // Insertion-ordered levels, as the JS `Map`.
    let mut levels: Vec<(usize, usize)> = Vec::new();
    fn level_of(
        job: usize,
        visiting: &mut Vec<usize>,
        needs: &[Vec<usize>],
        levels: &mut Vec<(usize, usize)>,
    ) -> usize {
        if let Some((_, level)) = levels.iter().find(|(j, _)| *j == job) {
            return *level;
        }
        let deps = &needs[job];
        if visiting.contains(&job) || deps.is_empty() {
            levels.push((job, 0));
            return 0;
        }
        visiting.push(job);
        let mut level = 0;
        for &dep in deps {
            let dep_level = level_of(dep, visiting, needs, levels) + 1;
            if dep_level > level {
                level = dep_level;
            }
        }
        // `levels[jobId] = level`: a key set during the recursion (a
        // cycle) keeps its first position.
        match levels.iter_mut().find(|(j, _)| *j == job) {
            Some(entry) => entry.1 = level,
            None => levels.push((job, level)),
        }
        level
    }
    for job in 0..by_id.len() {
        level_of(job, &mut Vec::new(), &needs, &mut levels);
    }
    let mut tiers: Vec<Vec<Dot>> = Vec::new();
    for (job, level) in levels {
        while tiers.len() <= level {
            tiers.push(Vec::new());
        }
        tiers[level].push(dot(by_id[job]));
    }
    tiers.into_iter().filter(|t| !t.is_empty()).collect()
}

/// Most lines in one chunk of command output.
pub const CONTENT_CHUNK_LINES: usize = 200;

/// `pipelineContentChunks`: Markdown whole; text split into 200-line
/// chunks, a final newline dropped first.
pub fn content_chunks(markdown: bool, text: &str) -> Vec<(bool, String)> {
    if markdown {
        return vec![(true, text.to_owned())];
    }
    let text = text.strip_suffix('\n').unwrap_or(text);
    let lines: Vec<&str> = text.split('\n').collect();
    lines
        .chunks(CONTENT_CHUNK_LINES)
        .map(|chunk| (false, chunk.join("\n")))
        .collect()
}

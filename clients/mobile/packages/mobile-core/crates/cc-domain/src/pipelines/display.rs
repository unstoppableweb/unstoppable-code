//! `device_link/pipelines/display.dart`: the desktop execution row
//! projected onto the shared mobile run shape, as a [`Dv`] map that
//! [`super::Run::from_json`] then reads (`RemotePipelineRun.fromJson`), and
//! `pipelineOutputTail` (`existing_ipc.dart`).
use crate::chat::Thrown;
use crate::dart::{Dv, DvMap};

static EMPTY: std::sync::LazyLock<DvMap> = std::sync::LazyLock::new(DvMap::new);

/// `_object(value)`: a map, else `{}`.
fn object(value: &Dv) -> &DvMap {
    match value {
        Dv::Map(map) => map,
        _ => &EMPTY,
    }
}

/// `_rows(value)`: a list's map elements; nothing when it is not a list.
fn rows(value: &Dv) -> Vec<&DvMap> {
    value
        .elements()
        .map(|items| {
            items
                .into_iter()
                .filter_map(|item| match item {
                    Dv::Map(map) => Some(map),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `(value as num?)?.toInt()`.
fn cast_int(value: &Dv) -> Result<Option<i64>, Thrown> {
    match value {
        Dv::Null => Ok(None),
        Dv::Int(n) => Ok(Some(*n)),
        Dv::Float(f) if f.is_finite() =>
        {
            #[allow(clippy::cast_possible_truncation)]
            Ok(Some(f.trunc() as i64))
        }
        _ => Err(Thrown::Cast),
    }
}

/// `(value as List?)?.length`.
fn cast_length(value: &Dv) -> Result<Option<i64>, Thrown> {
    match value {
        Dv::Null => Ok(None),
        other => other
            .elements()
            .map(|items| Some(i64::try_from(items.len()).unwrap_or(i64::MAX)))
            .ok_or(Thrown::Cast),
    }
}

/// `pipelineAttempt(job)`.
pub fn attempt(job: &DvMap) -> Result<i64, Thrown> {
    Ok(cast_int(job.get("retry_count"))?
        .unwrap_or(0)
        .max(cast_length(job.get("retry_history"))?.unwrap_or(0)))
}

/// `pipelineIteration(job)`.
pub fn iteration(job: &DvMap) -> Result<i64, Thrown> {
    Ok(cast_int(job.get("iteration_count"))?.unwrap_or(1).max(1))
}

/// `value ?? fallback`.
fn or(value: &Dv, fallback: Dv) -> Dv {
    if value.is_null() {
        fallback
    } else {
        value.clone()
    }
}

fn map(entries: Vec<(&str, Dv)>) -> DvMap {
    let mut out = DvMap::new();
    for (key, value) in entries {
        out.insert(key.to_owned(), value);
    }
    out
}

/// `physical(id, fallback)`.
fn physical(
    id: &str,
    fallback: &DvMap,
    definitions: &DvMap,
    results: &DvMap,
) -> Result<DvMap, Thrown> {
    let definition = object(definitions.get(id));
    let source = if definition.is_empty() {
        fallback
    } else {
        definition
    };
    let result = object(results.get(id));
    let steps = object(result.get("steps"));
    let declared = rows(source.get("steps"));
    let mut step_ids: Vec<String> = Vec::new();
    for step in &declared {
        if let Dv::Str(step_id) = step.get("id")
            && !step_ids.contains(step_id)
        {
            step_ids.push(step_id.clone());
        }
    }
    for (key, _) in steps.iter() {
        if !step_ids.iter().any(|s| s == key) {
            step_ids.push(key.to_owned());
        }
    }
    // Dart reads the attempt and iteration per step, so a job without steps
    // never casts them.
    let (attempt, iteration) = if step_ids.is_empty() {
        (0, 0)
    } else {
        (attempt(result)?, iteration(result)?)
    };
    let mut rows_out = Vec::new();
    for step_id in &step_ids {
        let name = declared
            .iter()
            .find(|step| step.get("id").is_str(step_id))
            .map_or(&Dv::Null, |step| step.get("name"));
        let state = object(steps.get(step_id));
        rows_out.push(Dv::Map(map(vec![
            ("stepId", Dv::Str(step_id.clone())),
            ("name", or(name, Dv::Str(step_id.clone()))),
            ("status", or(state.get("status"), Dv::Str("pending".into()))),
            ("attempt", Dv::Int(attempt)),
            ("iteration", Dv::Int(iteration)),
            ("recovery", or(state.get("recovery_count"), Dv::Int(0))),
        ])));
    }
    Ok(map(vec![
        ("jobId", Dv::Str(id.to_owned())),
        ("name", or(source.get("name"), Dv::Str(id.to_owned()))),
        (
            "status",
            or(result.get("status"), Dv::Str("pending".into())),
        ),
        (
            "matrix",
            or(
                object(source.get("matrix")).get("values"),
                Dv::Map(DvMap::new()),
            ),
        ),
        ("steps", Dv::List(rows_out)),
    ]))
}

/// The settled step statuses the progress counts.
const SETTLED: [&str; 4] = ["success", "failure", "cancelled", "skipped"];

/// `pipelineDisplay(row)`. Throws where Dart's casts threw.
pub fn display(row: &DvMap) -> Result<DvMap, Thrown> {
    let snapshot = object(row.get("pipeline_snapshot"));
    let logical_jobs = object(snapshot.get("jobs"));
    let definitions = object(row.get("job_definitions"));
    let results = object(row.get("jobs"));
    let groups = object(row.get("job_groups"));

    let mut jobs: Vec<DvMap> = Vec::new();
    let mut represented: Vec<String> = Vec::new();
    for (key, value) in logical_jobs.iter() {
        let definition = object(value);
        let group = object(groups.get(key));
        let ids: Vec<String> = match group.get("variant_job_ids") {
            Dv::Null => vec![key.to_owned()],
            other => other
                .elements()
                .ok_or(Thrown::Cast)?
                .into_iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect(),
        };
        for id in &ids {
            if !represented.contains(id) {
                represented.push(id.clone());
            }
        }
        let mut job = if group.get("kind").is_str("matrix") {
            let mut variants = Vec::new();
            for id in &ids {
                variants.push(Dv::Map(physical(id, definition, definitions, results)?));
            }
            map(vec![
                ("jobId", Dv::Str(key.to_owned())),
                ("status", or(group.get("status"), Dv::Str("pending".into()))),
                ("steps", Dv::List(Vec::new())),
                ("variants", Dv::List(variants)),
                ("expansion", group.get("expansion").clone()),
                ("expansionError", group.get("error").clone()),
            ])
        } else {
            physical(
                ids.first().map_or(key, String::as_str),
                definition,
                definitions,
                results,
            )?
        };
        job.insert("jobId".into(), Dv::Str(key.to_owned()));
        job.insert(
            "name".into(),
            or(definition.get("name"), Dv::Str(key.to_owned())),
        );
        job.insert(
            "needs".into(),
            or(definition.get("needs"), Dv::List(Vec::new())),
        );
        jobs.push(job);
    }
    for (id, _) in results.iter() {
        if !represented.iter().any(|r| r == id) {
            jobs.push(physical(id, &EMPTY, definitions, results)?);
        }
    }
    let mut completed = 0i64;
    let mut total = 0i64;
    for job in &jobs {
        let mut count = |step: &DvMap| {
            total += 1;
            if SETTLED.iter().any(|s| step.get("status").is_str(s)) {
                completed += 1;
            }
        };
        for step in rows(job.get("steps")) {
            count(step);
        }
        for variant in rows(job.get("variants")) {
            for step in rows(variant.get("steps")) {
                count(step);
            }
        }
    }
    let mut out = map(vec![
        ("localId", row.get("id").clone()),
        ("pipelineId", row.get("pipeline_id").clone()),
        ("workspaceLocalId", row.get("project_id").clone()),
        ("worktreeLocalId", row.get("worktree_id").clone()),
        (
            "pipelineName",
            or(
                row.get("pipeline_name"),
                or(snapshot.get("name"), row.get("pipeline_id").clone()),
            ),
        ),
        ("status", row.get("status").clone()),
        ("startedAt", row.get("started_at").clone()),
        ("finishedAt", row.get("completed_at").clone()),
        ("parentExecutionId", row.get("parent_execution_id").clone()),
        ("hidden", Dv::Bool(row.get("hidden").is_true())),
    ]);
    if object(row.get("trigger_source")).get("kind").is_str("hook") {
        out.insert("triggerSource".into(), Dv::Str("hook".into()));
    }
    out.insert(
        "statusReasons".into(),
        Dv::List(
            rows(row.get("status_reasons"))
                .into_iter()
                .map(|reason| {
                    let mut r = reason.clone();
                    r.insert("resetsAt".into(), reason.get("resets_at").clone());
                    Dv::Map(r)
                })
                .collect(),
        ),
    );
    out.insert(
        "pendingPauses".into(),
        Dv::List(
            rows(row.get("pending_pauses"))
                .into_iter()
                .map(|pause| {
                    let mut p = pause.clone();
                    p.insert("jobId".into(), pause.get("job_id").clone());
                    p.insert("stepId".into(), pause.get("step_id").clone());
                    Dv::Map(p)
                })
                .collect(),
        ),
    );
    if row.get("jobs").is_map() {
        out.insert(
            "jobs".into(),
            Dv::List(jobs.into_iter().map(Dv::Map).collect()),
        );
        out.insert(
            "progress".into(),
            Dv::Map(map(vec![
                ("completedSteps", Dv::Int(completed)),
                ("totalSteps", Dv::Int(total)),
            ])),
        );
    }
    Ok(out)
}

/// `pipelineOutputTail(text)`: the last 2,048 UTF-8 bytes, starting at a
/// character boundary.
pub fn output_tail(text: &str) -> String {
    let bytes = text.as_bytes();
    if bytes.len() <= 2048 {
        return text.to_owned();
    }
    let mut start = bytes.len() - 2048;
    while start < bytes.len() && bytes[start] & 0xc0 == 0x80 {
        start += 1;
    }
    text[start..].to_owned()
}

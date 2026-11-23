//! `DeviceActivityRepository._load`: the activity reads of one worktree
//! read into its activity. A read that failed is `Dv::Null`, as Dart's
//! `read` returned `null`.
use super::{
    Plan, Run, ScriptDescriptor, ScriptRun, Summary, Thrown, cast_int, cast_string, cast_string_or,
    maps, string_or, string_or_null,
};
use crate::{
    chat::{link_string, object},
    dart::{Dv, DvMap},
    files::ChangedFile,
};

/// The words the readers put where the desktop sent none.
#[derive(Debug, Clone)]
pub struct Fallbacks {
    /// A plan without a title (`'Untitled plan'`).
    pub untitled_plan: String,
    /// A hook run without a trigger name (`'Hook'`).
    pub hook: String,
    /// A multi-repo hook outside a repository (`'Workspace root'`).
    pub workspace_root: String,
    /// A pull request row without a repository name (`'Repository'`).
    pub repository: String,
}

/// The replies of one load, in Dart's `first` and `next` order.
#[derive(Debug, Clone)]
pub struct ReadValues {
    /// `activity:changed-files`.
    pub changed: Dv,
    /// `worktree-summary:load`.
    pub summary: Dv,
    /// `tracked-plans:list`.
    pub plans: Dv,
    /// `script:load-worktree-runs`.
    pub script_runs: Dv,
    /// `hook:load-worktree-runs`.
    pub hook_runs: Dv,
}

/// One configured script `_scripts` found: an entry with an effective
/// command. `label` is the desktop's display name, or the entry's name.
#[derive(Debug, Clone)]
pub struct ScriptRow {
    pub name: String,
    pub label: Dv,
    pub key: String,
    pub target: &'static str,
}

/// What a load read. `changed_files` is `None` when the changed files were
/// not read (Dart keeps the previous list and reports the failure).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Loaded {
    pub changed_files: Option<Vec<ChangedFile>>,
    pub summary: Option<Summary>,
    pub plans: Vec<Plan>,
    pub scripts: Vec<ScriptDescriptor>,
    pub script_runs: Vec<ScriptRun>,
    pub hook_runs: Vec<Run>,
}

/// `_nameFromKey`.
fn name_from_key(key: &str) -> String {
    match key.rsplit(':').next() {
        Some(last) if !last.is_empty() => last.to_owned(),
        _ => key.to_owned(),
    }
}

/// `RemoteScriptDescriptor.fromJson`.
fn descriptor(row: &DvMap) -> ScriptDescriptor {
    let key = string_or_null(row.get("scriptKey"))
        .or_else(|| string_or_null(row.get("scriptId")))
        .unwrap_or_else(|| string_or(row.get("localId"), ""));
    let script_name = string_or_null(row.get("scriptName")).unwrap_or_else(|| name_from_key(&key));
    ScriptDescriptor {
        name: string_or(row.get("name"), &script_name),
        target: string_or_null(row.get("target")),
        key,
        script_name,
    }
}

/// The configured scripts' rows (`_scripts` then `deviceLinkString` of
/// each field).
pub fn script_rows(rows: &[ScriptRow]) -> Result<Vec<ScriptDescriptor>, Thrown> {
    let valid = |s: &str| !s.is_empty() && s.encode_utf16().count() <= 4096;
    rows.iter()
        .map(|row| {
            let label = match &row.label {
                Dv::Str(label) if valid(label) => label.clone(),
                _ => return Err(Thrown::Invalid),
            };
            if !valid(&row.key) || !valid(&row.name) {
                return Err(Thrown::Invalid);
            }
            Ok(ScriptDescriptor {
                key: row.key.clone(),
                script_name: row.name.clone(),
                name: label,
                target: Some(row.target.to_owned()),
            })
        })
        .collect()
}

/// The end of `_load`: every value read into the worktree's activity.
pub fn read_activity(
    values: &ReadValues,
    scripts: Result<Vec<ScriptDescriptor>, Thrown>,
    fallbacks: &Fallbacks,
) -> Result<Loaded, Thrown> {
    let changed_files = match &values.changed {
        Dv::Map(roster) => {
            let mut files = Vec::new();
            for (source, committed) in [("uncommitted", false), ("committed", true)] {
                for row in maps(roster.get(source)) {
                    files.push(ChangedFile {
                        path: link_string(row, "path")?.to_owned(),
                        status: link_string(row, "status")?.to_owned(),
                        committed,
                        repo_id: cast_string(row.get("repoId"))?,
                        repo_name: cast_string(row.get("repoName"))?,
                        insertions: cast_int(row.get("insertions"))?,
                        deletions: cast_int(row.get("deletions"))?,
                    });
                }
            }
            Some(files)
        }
        _ => None,
    };
    let summary = match &values.summary {
        Dv::Map(summary) => Some(Summary {
            title: cast_string_or(summary.get("title"), "")?,
            description: cast_string_or(summary.get("description"), "")?,
            generated_at: cast_string(summary.get("generatedAt"))?,
        }),
        _ => None,
    };
    let plans_value = match &values.plans {
        Dv::Map(map) => map.get("plans"),
        other => other,
    };
    let mut plans = Vec::new();
    for row in maps(plans_value) {
        if row.get("hidden").is_true() || !row.get("dismissedAt").is_null() {
            continue;
        }
        plans.push(Plan {
            title: cast_string_or(row.get("title"), &fallbacks.untitled_plan)?,
            status: cast_string_or(row.get("reviewStatus"), "")?,
        });
    }
    let scripts = scripts?;
    let mut script_runs = Vec::new();
    for row in maps(&values.script_runs) {
        let Dv::Map(script) = row.get("script") else {
            continue;
        };
        let mut merged = object(&Dv::Map(script.clone()))?.clone();
        merged.insert("name".into(), script.get("label").clone());
        merged.insert("status".into(), row.get("status").clone());
        merged.insert("startedAt".into(), row.get("startedAt").clone());
        script_runs.push(ScriptRun {
            script: descriptor(&merged),
            status: string_or(merged.get("status"), ""),
            started_at: string_or_null(merged.get("startedAt")),
        });
    }
    let mut hook_runs = Vec::new();
    for row in maps(&values.hook_runs) {
        hook_runs.push(Run {
            name: cast_string_or(row.get("triggerDisplayName"), &fallbacks.hook)?,
            status: cast_string_or(row.get("status"), "")?,
        });
    }
    Ok(Loaded {
        changed_files,
        summary,
        plans,
        scripts,
        script_runs,
        hook_runs,
    })
}

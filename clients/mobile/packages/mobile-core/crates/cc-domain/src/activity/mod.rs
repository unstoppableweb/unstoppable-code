//! A worktree's activity as Computer Connect reads it from the computer
//! (architecture §3.5, P6): its changed files, summary, tracked plans,
//! scripts and their runs, hooks and hook runs, chat todos and pull
//! requests. Ported from `lib/device_link/activity/*.dart`, the parsers of
//! `lib/data/models/computer_activity/{activity,pr,pr_status,pr_check,pr_merge_queue,pr_progress}.dart`
//! they call, and the display rules of
//! `lib/ui/core/activity/{pr_check_display,pr_merge_queue_display}.dart`;
//! comments cite the Dart rule they keep.
//!
//! The rules read [`Dv`], the desktop value as Dart held it, so every Dart
//! cast keeps its outcome ([`Thrown`]). Pure: no IO.
mod display;
mod prs;
mod read;
mod todos;
mod workspace;

pub use crate::chat::Thrown;
pub use display::{
    CheckState, MergeQueuePhaseKey, check_state, checks_expanded_by_default, checks_passed,
    merge_queue_for_action_pr,
};
pub use prs::{
    Check, CreationPhase, CreationProgress, CreationStep, MergePhase, MergeProgress, MergeQueue,
    MergeQueuePhase, MergeStep, Observations, PrRepo, PrStatus, action_repo, parse_creation,
    parse_merge, parse_repo,
};
pub use read::{Fallbacks, Loaded, ReadValues, ScriptRow, read_activity, script_rows};
pub use todos::{Todos, device_todos};
pub use workspace::{Missing, Source, Workspace, effective_sources, find_workspace, source_key};

use crate::dart::{Dv, DvMap};

/// The desktop's generated per-worktree summary (`RemoteWorktreeSummary`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub title: String,
    pub description: String,
    pub generated_at: Option<String>,
}

/// A tracked plan (`RemoteActivityPlan`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub title: String,
    pub status: String,
}

/// A configured script (`RemoteScriptDescriptor`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptDescriptor {
    pub key: String,
    pub script_name: String,
    pub name: String,
    pub target: Option<String>,
}

/// One run of a script (`RemoteScriptRun`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptRun {
    pub script: ScriptDescriptor,
    pub status: String,
    pub started_at: Option<String>,
}

/// A name and a coarse status (`RemoteActivityRun`): hook runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub name: String,
    pub status: String,
}

/// A configured hook (`RemoteHookDescriptor`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hook {
    pub name: String,
    pub hook_key: String,
    pub trigger_name: String,
    pub paused: bool,
    pub run_disabled: bool,
    pub run_disabled_reason: Option<String>,
}

/// One todo of a chat (`RemoteTodoItem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoItem {
    pub id: String,
    pub content: String,
    pub status: String,
}

/// A chat's todos (`RemoteChatTodoList`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoList {
    pub chat_id: String,
    pub items: Vec<TodoItem>,
}

/// `_stringOrNull`.
pub(crate) fn string_or_null(value: &Dv) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// `_string(value, fallback:)`.
pub(crate) fn string_or(value: &Dv, fallback: &str) -> String {
    value.as_str().unwrap_or(fallback).to_owned()
}

/// `value as String? ?? fallback`.
pub(crate) fn cast_string_or(value: &Dv, fallback: &str) -> Result<String, Thrown> {
    Ok(value
        .cast_str()
        .map_err(|_| Thrown::Cast)?
        .unwrap_or(fallback)
        .to_owned())
}

/// `value as String?`.
pub(crate) fn cast_string(value: &Dv) -> Result<Option<String>, Thrown> {
    Ok(value
        .cast_str()
        .map_err(|_| Thrown::Cast)?
        .map(str::to_owned))
}

/// `(value as num?)?.toInt()`: truncates; NaN and infinities throw.
pub(crate) fn cast_int(value: &Dv) -> Result<Option<i64>, Thrown> {
    match value {
        Dv::Null => Ok(None),
        Dv::Int(n) => Ok(Some(*n)),
        #[allow(clippy::cast_possible_truncation)]
        Dv::Float(f) if f.is_finite() => Ok(Some(f.trunc() as i64)),
        _ => Err(Thrown::Cast),
    }
}

/// `(value as List?)` elements that are maps (`whereType<Map>()`), none
/// when the value is not a list.
pub(crate) fn maps(value: &Dv) -> Vec<&DvMap> {
    match value {
        Dv::List(items) => items
            .iter()
            .filter_map(|v| match v {
                Dv::Map(m) => Some(m),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

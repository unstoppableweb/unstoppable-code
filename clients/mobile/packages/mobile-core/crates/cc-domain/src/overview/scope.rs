//! A context's slice of the inventory and its attention sections
//! (`DeviceContextScope`, `RemoteContextScope`, `computeAttentionSections`).
use super::{
    model::{Owner, Project, Worktree, WorktreeRow},
    order::{Collation, compare_rows},
    rows::worktree_row,
};
use std::collections::HashSet;

/// One attention row: a worktree and its workspace's name.
#[derive(Debug, Clone, PartialEq)]
pub struct AttentionEntry {
    pub worktree_key: String,
    pub workspace_name: String,
}

/// The five shared attention sections, in workspace and sidebar order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Attention {
    pub awaiting_approval: Vec<AttentionEntry>,
    pub unread_chats: Vec<AttentionEntry>,
    pub in_progress: Vec<AttentionEntry>,
    pub pipelines_running: Vec<AttentionEntry>,
    pub pipelines_finished: Vec<AttentionEntry>,
}

/// The phone's queue: approvals, unread results and finished pipelines,
/// one row per worktree (`attentionEntries`).
pub fn attention_entries(attention: &Attention) -> Vec<AttentionEntry> {
    let mut seen = HashSet::new();
    attention
        .awaiting_approval
        .iter()
        .chain(&attention.unread_chats)
        .chain(&attention.pipelines_finished)
        .filter(|e| seen.insert(e.worktree_key.clone()))
        .cloned()
        .collect()
}

/// A context's projects and worktrees, by id and key.
#[derive(Debug, Clone, PartialEq)]
pub struct ContextScope {
    pub owner: Owner,
    pub project_ids: Vec<String>,
    /// Visible worktrees: browser, search and Recents.
    pub worktree_keys: Vec<String>,
    /// Hidden ones too, for attention.
    pub all_worktree_keys: Vec<String>,
    /// Cowork projects, whose chats the context lists.
    pub cowork_project_ids: Vec<String>,
    pub attention: Attention,
}

/// [`ContextScope`] for `owner`: projects it owns, in inventory order, and
/// their worktrees. Unknown owners belong to no context.
pub fn context_scope(
    owner: &Owner,
    projects: &[Project],
    worktrees: &[Worktree],
    collation: &Collation,
) -> ContextScope {
    let scoped: Vec<&Project> = projects
        .iter()
        .filter(|p| p.owner.as_ref() == Some(owner))
        .collect();
    let ids: HashSet<&str> = scoped.iter().map(|p| p.id.as_str()).collect();
    let all: Vec<&Worktree> = worktrees
        .iter()
        .filter(|w| ids.contains(w.project_id.as_str()))
        .collect();
    // Hidden policy (intentional asymmetry of the shared store): only the
    // unread section leaves hidden worktrees out.
    let mut entries: Vec<(WorktreeRow, String)> = Vec::new();
    for project in &scoped {
        let mut rows: Vec<WorktreeRow> = all
            .iter()
            .filter(|w| w.project_id == project.id)
            .map(|w| worktree_row(w))
            .collect();
        rows.sort_by(|a, b| compare_rows(a, b, collation));
        entries.extend(rows.into_iter().map(|row| (row, project.name.clone())));
    }
    let section = |test: &dyn Fn(&WorktreeRow) -> bool| -> Vec<AttentionEntry> {
        entries
            .iter()
            .filter(|(row, _)| test(row))
            .map(|(row, name)| AttentionEntry {
                worktree_key: format!("{}/{}", row.workspace_local_id, row.local_id),
                workspace_name: name.clone(),
            })
            .collect()
    };
    let pipeline = |row: &WorktreeRow, statuses: &[&str]| {
        row.pipeline_status
            .as_deref()
            .is_some_and(|s| statuses.contains(&s))
    };
    let attention = Attention {
        awaiting_approval: section(&|r| r.awaiting_approval == Some(true)),
        unread_chats: section(&|r| r.has_unread == Some(true) && r.hidden != Some(true)),
        in_progress: section(&|r| r.is_streaming == Some(true)),
        pipelines_running: section(&|r| pipeline(r, &["running"])),
        pipelines_finished: section(&|r| pipeline(r, &["unseen", "unseen-failure", "paused"])),
    };
    ContextScope {
        owner: owner.clone(),
        project_ids: scoped.iter().map(|p| p.id.clone()).collect(),
        worktree_keys: all.iter().filter(|w| !w.hidden).map(|w| w.key()).collect(),
        all_worktree_keys: all.iter().map(|w| w.key()).collect(),
        cowork_project_ids: scoped
            .iter()
            .filter(|p| p.is_cowork())
            .map(|p| p.id.clone())
            .collect(),
        attention,
    }
}

//! Worktree rows and chat-state rules (`worktrees/repository.dart` `load`,
//! `row_projection.dart`, `chats/scope_state.dart`).
use super::model::{
    ChatRef, ChatStatus, Execution, ScopeSnapshot, Worktree, WorktreeChats, WorktreeRow,
};
use std::collections::{BTreeSet, HashMap, HashSet};

const LIVE: [&str; 5] = [
    "queued",
    "starting",
    "streaming",
    "awaiting_input",
    "completing",
];
const STREAMING: [&str; 4] = ["queued", "starting", "streaming", "completing"];

/// The desktop sidebar's pipeline status per `projectId/worktreeId`
/// (`devicePipelineStatuses`): running, then an unseen failure, then
/// paused, then an unseen result.
pub fn pipeline_statuses(
    executions: &[Execution],
    seen: &HashMap<String, HashSet<String>>,
) -> HashMap<String, String> {
    let (mut running, mut failed) = (BTreeSet::new(), BTreeSet::new());
    let (mut paused, mut unseen) = (BTreeSet::new(), BTreeSet::new());
    for row in executions {
        let key = format!("{}/{}", row.project_id, row.worktree_id);
        let status = row.status.as_deref();
        let was_seen = seen.get(&key).is_some_and(|ids| ids.contains(&row.id));
        if matches!(status, Some("pending" | "running")) {
            running.insert(key.clone());
        }
        if status == Some("paused") {
            paused.insert(key.clone());
        }
        if was_seen {
            continue;
        }
        if matches!(status, Some("paused" | "success" | "failure" | "cancelled")) {
            unseen.insert(key.clone());
        }
        if status == Some("failure") {
            failed.insert(key);
        }
    }
    let mut statuses = HashMap::new();
    for key in running.iter().chain(&failed).chain(&paused).chain(&unseen) {
        let status = if running.contains(key) {
            "running"
        } else if failed.contains(key) {
            "unseen-failure"
        } else if paused.contains(key) {
            "paused"
        } else {
            "unseen"
        };
        statuses.insert(key.clone(), status.to_owned());
    }
    statuses
}

/// The shared row: the projected row with the live chat state on top once
/// it was read (`deviceWorktreeRow`).
pub fn worktree_row(worktree: &Worktree) -> WorktreeRow {
    let mut row = worktree.base_row.clone();
    if worktree.chats.status.known() {
        row.is_streaming = Some(worktree.chats.is_streaming);
        row.has_unread = Some(worktree.chats.unread);
        row.awaiting_approval = Some(worktree.chats.pending_approval);
    }
    row
}

/// A worktree's chats and status from its scope state (`load`). Open tabs
/// are the non-file, non-archived ones; every open tab needs an id.
pub fn worktree_chats(
    project_id: &str,
    worktree_id: &str,
    saved_status: Option<&str>,
    snapshot: &ScopeSnapshot,
) -> Option<WorktreeChats> {
    let open: Vec<_> = snapshot
        .tabs
        .iter()
        .filter(|t| !t.is_file && !t.archived)
        .collect();
    let mut chats = Vec::with_capacity(open.len());
    for tab in &open {
        chats.push(ChatRef {
            project_id: project_id.to_owned(),
            worktree_id: worktree_id.to_owned(),
            id: tab.link_id.clone()?,
            title: tab.title.clone(),
        });
    }
    let mut working = Vec::new();
    for (id, status) in &snapshot.runtime {
        if status.as_deref().is_some_and(|s| LIVE.contains(&s)) && !working.contains(id) {
            working.push(id.clone());
        }
    }
    let states: HashSet<Option<&str>> =
        snapshot.runtime.iter().map(|(_, s)| s.as_deref()).collect();
    let questions = snapshot.questions.iter().filter(|q| q.open).count();
    let pending = snapshot.approvals + questions;
    let plan = open.iter().any(|t| t.plan_exit);
    let awaiting = states.contains(&Some("awaiting_input"));
    let is_streaming = states
        .iter()
        .any(|s| s.is_some_and(|s| STREAMING.contains(&s)));
    let status = if awaiting || pending > 0 || plan {
        ChatStatus::NeedsInput
    } else if is_streaming {
        ChatStatus::Working
    } else if states.contains(&Some("failed")) {
        ChatStatus::Failed
    } else if saved_status == Some("done") {
        ChatStatus::Done
    } else {
        ChatStatus::Idle
    };
    Some(WorktreeChats {
        chats,
        active_chat_id: snapshot.active_tab_id.clone(),
        status,
        unread: open.iter().any(|t| t.unread),
        pending_question: questions > 0,
        pending_approval: snapshot.approvals > 0 || awaiting || plan,
        is_streaming,
        working_chats: working,
    })
}

/// A Cowork chat's unread and working flags in its scope state
/// (`DeviceChatOverviewRepository.unread` / `working`).
pub fn chat_scope_status(snapshot: &ScopeSnapshot, chat_id: &str) -> (bool, bool) {
    let Some(tab) = snapshot
        .tabs
        .iter()
        .find(|t| t.id.as_deref() == Some(chat_id))
    else {
        return (false, false);
    };
    let visible = !tab.empty && !tab.is_file && !tab.archived;
    let running = snapshot
        .runtime
        .iter()
        .rev()
        .find(|(id, _)| id == chat_id)
        .and_then(|(_, s)| s.as_deref())
        .is_some_and(|s| LIVE.contains(&s));
    (visible && tab.unread, visible && running)
}

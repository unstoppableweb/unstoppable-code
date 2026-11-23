//! A computer's Recents in one context (`buildDeviceRecentChats` and
//! `buildComputerRecentChatInventory`): the snapshot's chat summaries, then
//! the tabs the roster read for chats the summaries miss.
use super::model::{ChatRef, Owner, Project, RecentSnapshot, SnapshotWorktree, Worktree};
use crate::dart::parse_millis;
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
};

/// Why a recent chat carries the attention dot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecentAttention {
    None,
    Unread,
    AwaitingAnswer,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecentChat {
    pub chat: ChatRef,
    /// The worktree's name; `None` for Cowork chats.
    pub worktree_name: Option<String>,
    /// Milliseconds since the epoch, when the computer says.
    pub activity_at_ms: Option<i64>,
    pub attention: RecentAttention,
}

/// Rows keyed by chat key: the first occurrence keeps its position, the
/// last one its value (a Dart map literal).
#[derive(Default)]
struct Rows {
    order: Vec<String>,
    rows: HashMap<String, RecentChat>,
}
impl Rows {
    fn insert(&mut self, row: RecentChat) {
        let key = row.chat.key();
        if !self.rows.contains_key(&key) {
            self.order.push(key.clone());
        }
        self.rows.insert(key, row);
    }
    fn insert_absent(&mut self, row: RecentChat) {
        if !self.rows.contains_key(&row.chat.key()) {
            self.insert(row);
        }
    }
    fn into_vec(mut self) -> Vec<RecentChat> {
        self.order
            .iter()
            .filter_map(|key| self.rows.remove(key))
            .collect()
    }
}

fn summary_rows(owner: &Owner, snapshot: &RecentSnapshot) -> Vec<RecentChat> {
    let scoped: Vec<_> = snapshot
        .workspaces
        .iter()
        .filter(|w| !w.placeholder && w.owner.as_ref() == Some(owner))
        .collect();
    let ids: HashSet<&str> = scoped.iter().map(|w| w.local_id.as_str()).collect();
    let hidden: HashSet<&str> = scoped
        .iter()
        .filter(|w| w.hidden)
        .map(|w| w.local_id.as_str())
        .collect();
    let mut by_id: HashMap<&str, &SnapshotWorktree> = HashMap::new();
    for worktree in &snapshot.worktrees {
        if ids.contains(worktree.workspace_local_id.as_str())
            && worktree.hidden != Some(true)
            && !hidden.contains(worktree.workspace_local_id.as_str())
        {
            by_id.insert(&worktree.local_id, worktree);
        }
    }
    let attention = |open: Option<bool>, unread: bool| {
        if open == Some(true) {
            RecentAttention::AwaitingAnswer
        } else if unread {
            RecentAttention::Unread
        } else {
            RecentAttention::None
        }
    };
    let mut rows = Vec::new();
    for chat in &snapshot.chat_summaries {
        if chat.scope.as_deref() == Some("standalone") {
            continue;
        }
        let Some(worktree) = chat
            .worktree_local_id
            .as_deref()
            .and_then(|id| by_id.get(id))
        else {
            continue;
        };
        if let Some(workspace) = chat.workspace_local_id.as_deref()
            && !workspace.is_empty()
            && workspace != worktree.workspace_local_id
        {
            continue;
        }
        rows.push(RecentChat {
            chat: ChatRef {
                project_id: worktree.workspace_local_id.clone(),
                worktree_id: worktree.local_id.clone(),
                id: chat.chat_id.clone(),
                title: chat.display_title.clone(),
            },
            worktree_name: Some(
                worktree
                    .label
                    .clone()
                    .unwrap_or_else(|| worktree.branch.clone()),
            ),
            activity_at_ms: chat
                .last_message_at
                .as_deref()
                .and_then(parse_millis)
                .or_else(|| chat.created_at.as_deref().and_then(parse_millis)),
            attention: attention(chat.open_question, chat.has_unread == Some(true)),
        });
    }
    let mut standalone = HashMap::new();
    for chat in &snapshot.chat_summaries {
        if chat.scope.as_deref() == Some("standalone") {
            standalone.insert(chat.chat_id.as_str(), chat);
        }
    }
    for chat in &snapshot.standalone_chats {
        // A chat with no project is Personal's; one in another context is not.
        let included = if chat.project_local_id.is_empty() {
            *owner == Owner::Personal
        } else {
            ids.contains(chat.project_local_id.as_str())
        };
        if !included
            || chat.archived == Some(true)
            || hidden.contains(chat.project_local_id.as_str())
        {
            continue;
        }
        let summary = standalone.get(chat.local_id.as_str());
        let row = chat.last_message_at.as_deref().and_then(parse_millis);
        let latest = summary
            .and_then(|s| s.last_message_at.as_deref())
            .and_then(parse_millis);
        let activity = match (latest, row) {
            (Some(s), None) => Some(s),
            (Some(s), Some(r)) if s > r => Some(s),
            _ => row,
        };
        // A Cowork chat's scope is its work entry; migrated chats without
        // one use the chat id.
        let entry = chat
            .work_entry_id
            .clone()
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| chat.local_id.clone());
        rows.push(RecentChat {
            chat: ChatRef {
                project_id: chat.project_local_id.clone(),
                worktree_id: entry,
                id: chat.local_id.clone(),
                title: chat.display_title.clone(),
            },
            worktree_name: None,
            activity_at_ms: activity,
            attention: attention(
                summary.and_then(|s| s.open_question),
                chat.has_unread == Some(true)
                    || summary.is_some_and(|s| s.has_unread == Some(true)),
            ),
        });
    }
    rows
}

/// Recents in `owner`'s context: snapshot summaries first, then tabs of
/// the context's visible worktrees the summaries miss, without activity or
/// attention (a worktree's aggregate status is not a chat's).
pub fn recent_chats(
    owner: &Owner,
    snapshot: Option<&RecentSnapshot>,
    projects: &[Project],
    worktrees: &[Worktree],
) -> Vec<RecentChat> {
    let mut rows = Rows::default();
    if let Some(snapshot) = snapshot {
        for row in summary_rows(owner, snapshot) {
            rows.insert(row);
        }
    }
    let ids: HashSet<&str> = projects
        .iter()
        .filter(|p| p.owner.as_ref() == Some(owner))
        .map(|p| p.id.as_str())
        .collect();
    for worktree in worktrees
        .iter()
        .filter(|w| ids.contains(w.project_id.as_str()) && !w.hidden)
    {
        for chat in &worktree.chats.chats {
            rows.insert_absent(RecentChat {
                chat: chat.clone(),
                worktree_name: Some(worktree.name.clone()),
                activity_at_ms: None,
                attention: RecentAttention::None,
            });
        }
    }
    rows.into_vec()
}

/// Indexes into the flattened groups, newest first, with a cap per computer.
/// Unknown dates sort last. Stable sorting keeps computer and row order for ties.
pub fn interleave_recents(computers: Vec<Vec<Option<i64>>>, limit: usize) -> Vec<usize> {
    let mut offset = 0;
    let mut rows = Vec::new();
    for activity in computers {
        let len = activity.len();
        let mut group: Vec<_> = activity.into_iter().enumerate().collect();
        group.sort_by_key(|&(_, timestamp)| Reverse(timestamp));
        rows.extend(
            group
                .into_iter()
                .take(limit)
                .map(|(index, timestamp)| (offset + index, timestamp)),
        );
        offset += len;
    }
    rows.sort_by(|&(index_a, time_a), &(index_b, time_b)| {
        time_b.cmp(&time_a).then_with(|| index_a.cmp(&index_b))
    });
    rows.into_iter().map(|(index, _)| index).collect()
}

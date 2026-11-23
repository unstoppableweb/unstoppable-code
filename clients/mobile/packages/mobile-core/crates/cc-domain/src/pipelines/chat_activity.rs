//! `device_link/pipelines/chat_activity.dart`: which chat turn each
//! receipt-backed run belongs to, and the receipts a chat carries.
use super::run::{Run, compare_recency};
use crate::chat::{ChatRef, Message};
use crate::dart::{Dv, DvMap};
use crate::feed::{FeedText, Role, hidden, present};

/// One turn's runs, newest first.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnRuns {
    /// The user message that opened the turn.
    pub turn: String,
    pub runs: Vec<Run>,
}

fn blocks(raw: &DvMap) -> Vec<&DvMap> {
    match raw.get("blocks") {
        Dv::List(items) => items
            .iter()
            .filter_map(|b| match b {
                Dv::Map(m) => Some(m),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `devicePipelineChatActivity`: tool-result receipts belong to the tool's
/// opening user turn; runs the desktop attributes to a turn of this chat
/// join it. `None` where Dart threw (a visible message without a valid id).
pub fn chat_activity<'a>(
    chat: &ChatRef,
    messages: &[Message],
    runs: impl IntoIterator<Item = &'a Run>,
) -> Option<Vec<TurnRuns>> {
    // `byId`: root, visible runs of this worktree, the last per id.
    let mut by_id: Vec<&Run> = Vec::new();
    for run in runs {
        if run.hidden
            || !run.is_root()
            || run.workspace_local_id.as_deref() != Some(chat.project_id.as_str())
            || run.worktree_local_id.as_deref() != Some(chat.worktree_id.as_str())
        {
            continue;
        }
        match by_id.iter_mut().find(|r| r.local_id == run.local_id) {
            Some(slot) => *slot = run,
            None => by_id.push(run),
        }
    }
    let mut result: Vec<(String, Vec<&Run>)> = Vec::new();
    let mut link = |turn: &str, run: &'a Run| {
        let index = match result.iter().position(|(t, _)| t == turn) {
            Some(i) => i,
            None => {
                result.push((turn.to_owned(), Vec::new()));
                result.len() - 1
            }
        };
        let runs = &mut result[index].1;
        match runs.iter_mut().find(|r| r.local_id == run.local_id) {
            Some(slot) => *slot = run,
            None => runs.push(run),
        }
    };
    for run in &by_id {
        for turn in run.chat_turns.as_deref().unwrap_or_default() {
            if turn.chat_id == chat.id {
                link(&turn.user_message_id, run);
            }
        }
    }
    let text = FeedText {
        additional: String::new(),
    };
    let mut owners: Vec<(String, String)> = Vec::new();
    let mut turn: Option<String> = None;
    for raw in messages.iter().filter(|m| !hidden(&m.raw)) {
        let message = present(raw, &text, &Default::default())?;
        if message.role == Some(Role::User) && !message.continues_turn {
            turn = Some(message.id.clone());
        }
        for block in blocks(&raw.raw) {
            let Some(tool) = block.get("toolUseId").as_str().filter(|t| !t.is_empty()) else {
                continue;
            };
            if block.get("type").is_str("tool_use")
                && let Some(turn) = &turn
            {
                match owners.iter_mut().find(|(t, _)| t == tool) {
                    Some(entry) => entry.1.clone_from(turn),
                    None => owners.push((tool.to_owned(), turn.clone())),
                }
            }
            let owner = owners
                .iter()
                .find(|(t, _)| t == tool)
                .map(|(_, o)| o.clone());
            let Some(owner) = owner else {
                continue;
            };
            if !block.get("type").is_str("tool_result") || block.get("isError").is_true() {
                continue;
            }
            for id in receipt_ids(chat, block) {
                if let Some(run) = by_id.iter().find(|r| r.local_id == id) {
                    link(&owner, run);
                }
            }
        }
    }
    Some(
        result
            .into_iter()
            .map(|(turn, runs)| {
                let mut runs: Vec<Run> = runs.into_iter().cloned().collect();
                crate::dart::sort::sort(&mut runs, &|a, b| compare_recency(b, a));
                TurnRuns { turn, runs }
            })
            .collect(),
    )
}

/// `devicePipelineReceiptIds`: every run id a visible message's receipts
/// name.
pub fn receipt_ids_of(chat: &ChatRef, messages: &[Message]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for message in messages.iter().filter(|m| !hidden(&m.raw)) {
        for block in blocks(&message.raw) {
            for id in receipt_ids(chat, block) {
                if !out.contains(&id) {
                    out.push(id);
                }
            }
        }
    }
    out
}

/// `_receiptIds(ref, block)`.
fn receipt_ids(chat: &ChatRef, block: &DvMap) -> Vec<String> {
    if !block.get("type").is_str("tool_result") || block.get("isError").is_true() {
        return Vec::new();
    }
    let Dv::List(receipts) = block.get("agentArtifacts") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for receipt in receipts {
        let Dv::Map(receipt) = receipt else {
            continue;
        };
        let Some(id) = receipt
            .get("executionId")
            .as_str()
            .filter(|i| !i.is_empty())
        else {
            continue;
        };
        let target = receipt.get("navigationTarget");
        let Dv::Map(target) = target else {
            continue;
        };
        if !matches!(receipt.get("version"), Dv::Int(1))
            && !matches!(receipt.get("version"), Dv::Float(f) if *f == 1.0)
        {
            continue;
        }
        if !receipt.get("kind").is_str("pipeline_run")
            || receipt.get("dedupeKey").as_str().is_none_or(str::is_empty)
            || !receipt.get("projectId").is_str(&chat.project_id)
            || !receipt.get("worktreeId").is_str(&chat.worktree_id)
            || !target.get("kind").is_str("pipeline_execution")
            || !target.get("projectId").is_str(&chat.project_id)
            || !target.get("worktreeId").is_str(&chat.worktree_id)
            || !target.get("executionId").is_str(id)
        {
            continue;
        }
        out.push(id.to_owned());
    }
    out
}

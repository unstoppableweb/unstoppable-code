//! The Computer Connect chat feed (architecture §3.4, §4.2, D8, P5a): the
//! desktop messages presented for the phone, grouped into turns, steps and
//! runs, and projected into the rows the feed draws.
//!
//! Ported from `lib/device_link/chats/presentation.dart` (here),
//! `ui/core/chat/view_models/{turn_grouping,step_runs,transcript_projection}.dart`
//! and `data/models/{chat_turn_liveness,turn_timer}.dart` ([`turns`],
//! [`rows`]). Remote Control keeps the Dart grouping; a behavior change goes
//! to both until cleanup C5. Words the leaf widgets draw from these facts
//! (run words, tool labels, turn durations) stay in the shared Dart widgets.
pub mod rows;
mod turn_ends;
pub mod turns;

pub use rows::{Projection, Row, ToolResult, project};
pub use turn_ends::end_reasons;
pub use turns::{StepCategory, TurnTimer};

use std::collections::BTreeMap;

use crate::chat::{Message, trim};
use crate::dart::{Dv, DvMap};

/// The words presentation puts into messages (`cc-app::copy::chats`).
#[derive(Debug, Clone)]
pub struct FeedText {
    /// "Additional content is available on your computer."
    pub additional: String,
}

/// `ChatRole`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    User,
    Assistant,
    System,
}

/// `ChatMessageStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Status {
    Streaming,
    Complete,
    Failed,
    Cancelled,
}

/// `ChatWatcherFiredInfo`.
#[derive(Debug, Clone, PartialEq)]
pub struct WatcherFired {
    pub kind: String,
    /// `(kind, text)` of each merged watcher message.
    pub combined: Option<Vec<(String, String)>>,
}

/// `ChatMessageAttachment` of a computer path.
#[derive(Debug, Clone, PartialEq)]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub media_type: String,
}

/// `ChatPart`.
#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    pub kind: String,
    pub tool_family: Option<String>,
    pub data: Option<DvMap>,
}

impl Part {
    fn new(kind: &str, tool_family: Option<&str>, data: Option<DvMap>) -> Self {
        Self {
            kind: kind.to_owned(),
            tool_family: tool_family.map(str::to_owned),
            data,
        }
    }
    fn field(&self, key: &str) -> &Dv {
        self.data.as_ref().map_or(&Dv::Null, |d| d.get(key))
    }
    /// `toolName`.
    pub fn tool_name(&self) -> Option<&str> {
        let name = self
            .field("toolName")
            .as_str()
            .or_else(|| self.field("name").as_str());
        name.filter(|n| !n.is_empty())
    }
    /// `thinkingText`.
    pub fn thinking_text(&self) -> Option<&str> {
        let text = self
            .field("text")
            .as_str()
            .or_else(|| self.field("thinking").as_str());
        text.filter(|t| !trim(t).is_empty())
    }
    pub fn tool_use_id(&self) -> Option<&str> {
        self.field("toolUseId").as_str()
    }
    /// `toolOutput`.
    pub fn tool_output(&self) -> Option<&str> {
        self.field("output")
            .as_str()
            .filter(|o| !trim(o).is_empty())
    }
    pub fn is_tool_error(&self) -> bool {
        self.field("isError").is_true()
    }
}

/// `ChatMessage` as `deviceChatPresentation` builds it.
#[derive(Debug, Clone, PartialEq)]
pub struct Presented {
    /// The desktop message entry it presents.
    pub uid: u64,
    pub id: String,
    pub role: Option<Role>,
    pub status: Status,
    pub text: String,
    pub watcher_fired: Option<WatcherFired>,
    pub attachments: Vec<Attachment>,
    pub occurred_at_ms: Option<i64>,
    pub continues_turn: bool,
    pub parts: Vec<Part>,
}

impl Presented {
    pub fn is_streaming(&self) -> bool {
        self.status == Status::Streaming
    }
    pub fn has_text(&self) -> bool {
        !trim(&self.text).is_empty()
    }
}

/// `DeviceChatMessage.hidden`.
pub fn hidden(raw: &DvMap) -> bool {
    raw.get("hidden").is_true()
        || raw.get("parentBlockId").as_str().is_some()
        || raw.get("parentToolUseId").as_str().is_some()
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

/// `DeviceChatMessage.text`.
fn message_text(blocks: &[&DvMap]) -> String {
    blocks
        .iter()
        .filter(|b| b.get("type").is_str("text"))
        .filter_map(|b| b.get("text").as_str())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

const RENDERED: [&str; 7] = [
    "text",
    "thinking",
    "tool_use",
    "tool_result",
    "turn_timer",
    "file_references",
    "image",
];

fn has_reference(block: &DvMap) -> bool {
    !block.get("textRef").is_null()
        || !block.get("blocksRef").is_null()
        || !block.get("fullOutputRef").is_null()
}

/// `_toolFamily`.
fn tool_family(name: &Dv) -> Option<&'static str> {
    Some(match name.as_str()? {
        "Read" | "ReadLines" | "read_file" => "read",
        "Edit" | "MultiEdit" | "file_change" | "apply_patch" => "edit",
        "Write" | "write_file" => "write",
        "Bash" | "PowerShell" | "command" | "exec_command" | "shell_command" => "bash",
        "Grep" | "grep" => "grep",
        "Glob" | "glob" => "glob",
        "AskUserQuestion" => "ask-user",
        "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskList" | "TaskGet" | "TaskStop" => "todo",
        "Agent" | "Task" | "SendMessage" | "Workflow" | "TaskOutput" => "agent",
        "Skill" => "skill",
        "EnterPlanMode" | "ExitPlanMode" => "plan",
        "WebSearch" | "WebFetch" => "web",
        _ => return None,
    })
}

/// Dart `a ?? b` for desktop values.
fn or<'a>(a: &'a Dv, b: &'a Dv) -> &'a Dv {
    if a.is_null() { b } else { a }
}

fn map(entries: Vec<(&str, Dv)>) -> DvMap {
    let mut out = DvMap::new();
    for (key, value) in entries {
        out.insert(key.to_owned(), value);
    }
    out
}

/// `_parts`.
fn parts(
    block: &DvMap,
    text: &FeedText,
    end_reasons: &BTreeMap<String, String>,
    out: &mut Vec<Part>,
) {
    let kind = block.get("type");
    match kind.as_str() {
        Some("thinking") => out.push(Part::new(
            "thinking",
            None,
            Some(map(vec![("text", block.get("text").clone())])),
        )),
        Some("tool_use") => {
            let display = match block.get("display") {
                Dv::Map(d) => d,
                _ => block,
            };
            let name = or(
                or(display.get("toolName"), block.get("toolName")),
                block.get("name"),
            );
            out.push(Part::new(
                "tool_use",
                tool_family(name),
                Some(map(vec![
                    ("toolUseId", block.get("toolUseId").clone()),
                    ("toolName", name.clone()),
                    (
                        "input",
                        or(display.get("input"), block.get("input")).clone(),
                    ),
                ])),
            ));
        }
        Some("tool_result") => out.push(Part::new(
            "tool_result",
            None,
            Some(map(vec![
                ("toolUseId", block.get("toolUseId").clone()),
                ("output", block.get("output").clone()),
                ("isError", Dv::Bool(block.get("isError").is_true())),
            ])),
        )),
        Some("turn_timer") => {
            let mut data = DvMap::new();
            for key in [
                "turnId",
                "userMessageId",
                "spawnedBy",
                "startedAt",
                "pausedAt",
                "resumedAt",
                "accumulatedPausedDurationMs",
                "completedAt",
            ] {
                if !block.get(key).is_null() {
                    data.insert(key.into(), block.get(key).clone());
                }
            }
            if !block.get("completedAt").is_null()
                && let Some(reason) = block
                    .get("userMessageId")
                    .as_str()
                    .and_then(|owner| end_reasons.get(owner))
            {
                data.insert("endReason".into(), Dv::Str(reason.clone()));
            }
            out.push(Part::new("turn_timer", None, Some(data)));
        }
        Some("file_references") => out.push(Part::new(
            "attachment",
            None,
            Some(map(vec![("references", block.get("references").clone())])),
        )),
        // Host filesystem paths cannot be loaded by the phone.
        Some("image") => out.push(Part::new("image", None, None)),
        Some("text") => {}
        other => out.push(Part::new(
            other.unwrap_or("unknown"),
            None,
            Some(map(vec![("text", Dv::Str(text.additional.clone()))])),
        )),
    }
    if has_reference(block) {
        out.push(Part::new(
            "content_reference",
            None,
            Some(map(vec![("text", Dv::Str(text.additional.clone()))])),
        ));
    }
}

/// `_visibleText`.
fn visible_text(blocks: &[&DvMap], text: &FeedText) -> String {
    let additional = blocks.iter().any(|b| {
        !b.get("type")
            .as_str()
            .is_some_and(|t| RENDERED.contains(&t))
            || has_reference(b)
    });
    let words = message_text(blocks);
    let mut out = Vec::new();
    if !words.is_empty() {
        out.push(words.as_str());
    }
    if additional {
        out.push(text.additional.as_str());
    }
    out.join("\n\n")
}

/// `ChatWatcherFiredInfo.fromJsonOrNull`.
fn watcher_fired(value: &Dv) -> Option<WatcherFired> {
    let Dv::Map(value) = value else { return None };
    let kind = value.get("kind").as_str()?.to_owned();
    if !value.contains_key("combinedWatchers") {
        return Some(WatcherFired {
            kind,
            combined: None,
        });
    }
    let Dv::List(combined) = value.get("combinedWatchers") else {
        return None;
    };
    let mut entries = Vec::new();
    for entry in combined {
        let Dv::Map(entry) = entry else { return None };
        let (Some(k), Some(t)) = (entry.get("kind").as_str(), entry.get("text").as_str()) else {
            return None;
        };
        entries.push((k.to_owned(), t.to_owned()));
    }
    Some(WatcherFired {
        kind,
        combined: Some(entries),
    })
}

/// `chatAttachmentMediaTypeForFilename`.
fn media_type(filename: &str) -> Option<&'static str> {
    let dot = filename.rfind('.')?;
    if dot == 0 || dot == filename.len() - 1 {
        return None;
    }
    Some(match filename[dot + 1..].to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        _ => return None,
    })
}

/// `_attachments`: each named by its path on the computer. Dart's
/// `as List?` threw for another value; none show then.
fn attachments(raw: &DvMap) -> Vec<Attachment> {
    let Dv::List(paths) = raw.get("attachmentPaths") else {
        return Vec::new();
    };
    paths
        .iter()
        .filter_map(Dv::as_str)
        .map(|path| {
            let filename = path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned();
            Attachment {
                id: path.to_owned(),
                media_type: media_type(&filename)
                    .unwrap_or("application/octet-stream")
                    .to_owned(),
                filename,
            }
        })
        .collect()
}

/// `continuesTurn`.
fn continues_turn(role: &str, blocks: &[&DvMap]) -> bool {
    let starts_false = |b: &DvMap, key: &str| match b.get(key) {
        Dv::Map(m) => matches!(m.get("startsTurn"), Dv::Bool(false)),
        _ => false,
    };
    role == "user"
        && ((!blocks.is_empty() && blocks.iter().all(|b| b.get("type").is_str("tool_result")))
            || blocks.iter().any(|b| {
                b.get("type").is_str("text")
                    && (starts_false(b, "steering") || starts_false(b, "asyncQuestionAnswer"))
            }))
}

/// One message as `deviceChatPresentation` shows it; `None` when it is
/// hidden. A message without a valid id is left out (Dart threw while
/// building the feed). [`end_reasons`] marks the completed timer of each
/// turn that failed, was stopped or was interrupted.
pub fn present(
    message: &Message,
    text: &FeedText,
    end_reasons: &BTreeMap<String, String>,
) -> Option<Presented> {
    let raw = &*message.raw;
    if hidden(raw) {
        return None;
    }
    let id = message.id().ok()?.to_owned();
    let role = raw.get("role").as_str().unwrap_or("system");
    let blocks = blocks(raw);
    let status = if raw.get("isStreaming").is_true() {
        Status::Streaming
    } else {
        match raw.get("status").as_str() {
            Some("streaming") => Status::Streaming,
            Some("failed") => Status::Failed,
            Some("cancelled") => Status::Cancelled,
            _ => Status::Complete,
        }
    };
    let mut out = Vec::new();
    for block in &blocks {
        parts(block, text, end_reasons, &mut out);
    }
    Some(Presented {
        uid: message.uid,
        id,
        role: match role {
            "user" => Some(Role::User),
            "assistant" => Some(Role::Assistant),
            "system" => Some(Role::System),
            _ => None,
        },
        status,
        text: visible_text(&blocks, text),
        watcher_fired: watcher_fired(raw.get("watcherFired")),
        attachments: attachments(raw),
        // `DateTime.fromMillisecondsSinceEpoch(timestamp.toInt())`.
        #[allow(clippy::cast_possible_truncation)]
        occurred_at_ms: match raw.get("timestamp") {
            Dv::Int(n) => Some(*n),
            Dv::Float(f) if f.is_finite() => Some(f.trunc() as i64),
            _ => None,
        },
        continues_turn: continues_turn(role, &blocks),
        parts: out,
    })
}

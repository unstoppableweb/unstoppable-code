//! Turns, their liveness, timers and step counts (`turn_grouping.dart`,
//! `chat_turn_liveness.dart`, `turn_timer.dart`).
use super::{Part, Presented, Role, Status};
use crate::dart::Dv;

/// One conversational turn, by index into the presented messages: the
/// prompt, every following non-user message, and which of them is the
/// final answer (the last one with visible text).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub user: Option<usize>,
    pub assistant: Vec<usize>,
    /// Index into `assistant`.
    pub final_at: Option<usize>,
}

impl Turn {
    pub fn intermediate(&self) -> Vec<usize> {
        self.assistant
            .iter()
            .enumerate()
            .filter(|(i, _)| Some(*i) != self.final_at)
            .map(|(_, m)| *m)
            .collect()
    }
    pub fn finals(&self) -> Vec<usize> {
        self.final_at
            .map(|i| self.assistant[i])
            .into_iter()
            .collect()
    }
    /// `[?user, ...intermediate, ...finalMessages]`.
    pub fn ordered(&self) -> Vec<usize> {
        let mut out: Vec<usize> = self.user.into_iter().collect();
        out.extend(self.intermediate());
        out.extend(self.finals());
        out
    }
    /// The turn's first row (`user ?? assistantMessages.first`).
    pub fn first(&self) -> usize {
        self.user.unwrap_or_else(|| self.assistant[0])
    }
    /// Stable identity for expand/collapse state (`ChatTurn.key`).
    pub fn key<'a>(&self, messages: &'a [&Presented]) -> &'a str {
        let anchor = self
            .user
            .or_else(|| self.intermediate().first().copied())
            .or_else(|| self.finals().first().copied());
        anchor.map_or("", |i| messages[i].id.as_str())
    }
}

/// `groupChatTurns`.
pub fn group(messages: &[&Presented]) -> Vec<Turn> {
    let mut turns = Vec::new();
    let mut user: Option<usize> = None;
    let mut assistant: Option<Vec<usize>> = None;
    let flush =
        |turns: &mut Vec<Turn>, user: &mut Option<usize>, assistant: &mut Option<Vec<usize>>| {
            let Some(rows) = assistant.take() else {
                return;
            };
            let final_at = rows.iter().rposition(|&i| messages[i].has_text());
            turns.push(Turn {
                user: user.take(),
                assistant: rows,
                final_at,
            });
        };
    for (i, message) in messages.iter().enumerate() {
        if message.role == Some(Role::User) {
            flush(&mut turns, &mut user, &mut assistant);
            user = Some(i);
            assistant = Some(Vec::new());
        } else {
            assistant.get_or_insert_with(Vec::new).push(i);
        }
    }
    flush(&mut turns, &mut user, &mut assistant);
    turns
}

/// `hasRenderableContent`.
pub fn renderable(message: &Presented) -> bool {
    if message.has_text() || !message.attachments.is_empty() {
        return true;
    }
    if message.role == Some(Role::User) && message.watcher_fired.is_some() {
        return true;
    }
    if !message.parts.is_empty() && message.parts.iter().all(|p| p.kind == "turn_timer") {
        return false;
    }
    if message.is_streaming() || matches!(message.status, Status::Failed | Status::Cancelled) {
        return true;
    }
    message
        .parts
        .iter()
        .any(|p| matches!(p.kind.as_str(), "tool_use" | "thinking" | "agent"))
}

/// A parsed `turn_timer` part (`TurnTimer`), epoch milliseconds of the
/// desktop's clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnTimer {
    pub started_at: Option<i64>,
    pub paused_at: Option<i64>,
    pub resumed_at: Option<i64>,
    pub accumulated_paused_duration_ms: Option<i64>,
    pub completed_at: Option<i64>,
    pub end_reason: Option<String>,
}

impl TurnTimer {
    /// `TurnTimer.fromPart`.
    pub fn from_part(part: &Part) -> Option<Self> {
        if part.kind != "turn_timer" {
            return None;
        }
        let data = part.data.as_ref()?;
        // `value is num ? value.toInt() : null`; Dart threw for NaN.
        #[allow(clippy::cast_possible_truncation)]
        let epoch = |key: &str| match data.get(key) {
            Dv::Int(n) => Some(*n),
            Dv::Float(f) if f.is_finite() => Some(f.trunc() as i64),
            _ => None,
        };
        Some(Self {
            started_at: epoch("startedAt"),
            paused_at: epoch("pausedAt"),
            resumed_at: epoch("resumedAt"),
            accumulated_paused_duration_ms: epoch("accumulatedPausedDurationMs"),
            completed_at: epoch("completedAt"),
            end_reason: data.get("endReason").as_str().map(str::to_owned),
        })
    }
    pub fn is_paused(&self) -> bool {
        self.completed_at.is_none() && self.paused_at.is_some() && self.resumed_at.is_none()
    }
    pub fn is_live(&self) -> bool {
        self.completed_at.is_none() && !self.is_paused()
    }
}

/// `findNewestTurnTimer`.
pub fn newest_timer(messages: &[&Presented]) -> Option<TurnTimer> {
    messages
        .iter()
        .rev()
        .find_map(|m| m.parts.iter().find_map(TurnTimer::from_part))
}

/// `isChatTurnRunning`: a completed timer settles its turn even when a
/// tool row still streams.
pub fn is_running(messages: &[&Presented]) -> bool {
    let mut streaming = false;
    let mut running_timer = false;
    let mut user_at: Option<i64> = None;
    let mut completed_at: Option<i64> = None;
    let mut streaming_at: Option<i64> = None;
    let mut running_started_at: Option<i64> = None;
    for message in messages {
        if message.role == Some(Role::User) && !message.continues_turn {
            streaming = false;
            running_timer = false;
            user_at = message.occurred_at_ms;
            completed_at = None;
            streaming_at = None;
            running_started_at = None;
        }
        let mut carries_timer = false;
        for timer in message.parts.iter().filter_map(TurnTimer::from_part) {
            carries_timer = true;
            if let Some(end) = timer.completed_at {
                // A late timer from the previous turn must not settle a
                // newer prompt.
                if let Some(user) = user_at
                    && (end < user || (end == user && timer.started_at.is_some_and(|s| s < user)))
                {
                    continue;
                }
                if completed_at.is_none_or(|c| end > c) {
                    completed_at = Some(end);
                }
            } else {
                running_timer = true;
                if let Some(start) = timer.started_at
                    && running_started_at.is_none_or(|r| start > r)
                {
                    running_started_at = Some(start);
                }
            }
        }
        if message.is_streaming() && !carries_timer {
            streaming = true;
            if let Some(at) = message.occurred_at_ms
                && streaming_at.is_none_or(|s| at > s)
            {
                streaming_at = Some(at);
            }
        }
    }
    match completed_at {
        None => streaming || running_timer,
        Some(done) => {
            streaming_at.is_some_and(|s| s > done) || running_started_at.is_some_and(|r| r > done)
        }
    }
}

/// The collapsed steps card's categories, in the desktop chip order
/// (`TurnStepCategory`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StepCategory {
    Messages,
    Thinking,
    Bash,
    Read,
    ReadLines,
    WriteEdit,
    Plan,
    Search,
    Grep,
    Web,
    Agent,
    Workflow,
    Tasks,
    TaskStop,
    Skills,
    Monitor,
    Claude,
    ScheduleWakeup,
    AskUser,
    ScriptOutput,
    Watcher,
    Canopy,
    Graph,
    AppAdvisor,
    PipelineEditor,
    ComputerUse,
    Mcp,
    Other,
}

/// `isComputerUseTool`.
fn computer_use(part: &Part) -> bool {
    part.tool_family.as_deref() == Some("computer-use")
        || matches!(
            part.tool_name(),
            Some("mcp__cua_repl__js" | "mcp__cua_repl__js_reset")
        )
}

/// `_toolCategory`.
fn tool_category(part: &Part) -> StepCategory {
    use StepCategory as C;
    let name = part.tool_name().unwrap_or("");
    if computer_use(part) {
        return C::ComputerUse;
    }
    match name {
        "Workflow" => return C::Workflow,
        "TaskStop" => return C::TaskStop,
        "ScheduleWakeup" => return C::ScheduleWakeup,
        "ReadLines" => return C::ReadLines,
        "request_user_input" => return C::AskUser,
        "ListMcpResourcesTool" => return C::Mcp,
        _ => {}
    }
    if let Some(family) = part.tool_family.as_deref() {
        let category = match family {
            "bash" => Some(C::Bash),
            "read" => Some(C::Read),
            "edit" | "write" => Some(C::WriteEdit),
            "plan" => Some(C::Plan),
            "glob" => Some(C::Search),
            "grep" => Some(C::Grep),
            "web" => Some(C::Web),
            "agent" => Some(C::Agent),
            "todo" => Some(C::Tasks),
            "skill" => Some(C::Skills),
            "monitor" => Some(C::Monitor),
            "claude" => Some(C::Claude),
            "ask-user" => Some(C::AskUser),
            "script-output" => Some(C::ScriptOutput),
            "watcher" => Some(C::Watcher),
            "canopy" => Some(C::Canopy),
            "graph" => Some(C::Graph),
            "app-advisor" => Some(C::AppAdvisor),
            "pipeline-editor" => Some(C::PipelineEditor),
            "computer-use" => Some(C::ComputerUse),
            _ => None,
        };
        if let Some(category) = category {
            return category;
        }
    }
    match name {
        "Bash" | "PowerShell" | "command" => C::Bash,
        "Read" => C::Read,
        "Write" | "Edit" | "NotebookEdit" => C::WriteEdit,
        "Glob" | "ToolSearch" => C::Search,
        "Grep" => C::Grep,
        "WebFetch" | "WebSearch" | "web_search" => C::Web,
        "Skill" => C::Skills,
        "Monitor" => C::Monitor,
        "TaskCreate" | "TaskUpdate" | "TaskList" | "TaskGet" | "TodoWrite" => C::Tasks,
        "Task" | "Agent" | "SendMessage" | "TaskOutput" => C::Agent,
        "AskUserQuestion" => C::AskUser,
        _ if name.starts_with("mcp__") => C::Mcp,
        _ => C::Other,
    }
}

/// `summarizeTurnSteps`: the intermediate steps by category, in chip order.
pub fn summarize(intermediate: &[&Presented]) -> Vec<(StepCategory, u32)> {
    let mut counts = std::collections::BTreeMap::<StepCategory, u32>::new();
    let mut bump = |c| *counts.entry(c).or_default() += 1;
    for message in intermediate {
        if message.has_text() {
            bump(StepCategory::Messages);
        }
        for part in &message.parts {
            match part.kind.as_str() {
                "thinking" if part.thinking_text().is_some() => bump(StepCategory::Thinking),
                "tool_use" => bump(tool_category(part)),
                "agent" => bump(StepCategory::Agent),
                _ => {}
            }
        }
    }
    counts.into_iter().collect()
}

/// `hasCollapsibleIntermediate`.
pub fn collapsible(intermediate: &[&Presented]) -> bool {
    intermediate
        .iter()
        .any(|m| m.has_text() || m.parts.iter().any(|p| p.kind != "turn_timer"))
}

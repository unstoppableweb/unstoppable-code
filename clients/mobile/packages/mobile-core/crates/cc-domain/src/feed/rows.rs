//! The rows the feed draws (`TranscriptProjection.rows`,
//! `transcript_projection.dart`) and the step runs between replies
//! (`segmentTurn`, `step_runs.dart`). A pure function of the presented
//! messages, the host's liveness, the open turns and runs, and the turns
//! that get a footer; the app diffs successive projections into ops.
use super::turns::{self, StepCategory, Turn, TurnTimer};
use super::{Part, Presented, Role, Status};
use std::collections::HashSet;

/// Newest steps a running turn keeps in view under its run's line
/// (`recentStepCount`).
pub const RECENT_STEPS: usize = 3;

/// One tool call's outcome (`ToolCallResult`); `content: None` is an error
/// without output, which the feed words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResult {
    pub tool_use_id: String,
    pub content: Option<String>,
    pub is_error: bool,
}

/// One feed row. Messages are named by their entry `uid`; `results` names
/// the turn (by its first row's `uid`) whose tool results a row shows.
#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    Message {
        uid: u64,
        id: String,
        results: Option<u64>,
        streaming_spinner: bool,
        parts: bool,
    },
    Run {
        key: String,
        /// `(message uid, part index)`.
        steps: Vec<(u64, usize)>,
        shown_from: usize,
        expanded: bool,
        results: u64,
        anchor_message_id: Option<String>,
    },
    Steps {
        turn_key: String,
        counts: Vec<(StepCategory, u32)>,
        expanded: bool,
        timer: Option<TurnTimer>,
    },
    /// A running turn's timer, or the bottom "Thinking" bridge (`turn_key:
    /// None`).
    Timer {
        turn_key: Option<String>,
        timer: Option<TurnTimer>,
    },
    TurnFooter {
        turn_key: String,
    },
    ResponseActions {
        uid: u64,
        turn_key: String,
        at_message_id: String,
    },
}

impl Row {
    /// The Dart row's `key`; `None` for a row without one.
    pub fn key(&self) -> Option<String> {
        match self {
            Row::Message { id, .. } => Some(format!("message-{id}")),
            Row::Run { key, .. } => Some(key.clone()),
            Row::Steps { turn_key, .. } if turn_key.is_empty() => None,
            Row::Steps { turn_key, .. } => Some(format!("turn-steps-row-{turn_key}")),
            Row::Timer { turn_key: None, .. } => Some("turn-timer-bridge".into()),
            Row::Timer {
                turn_key: Some(k), ..
            } if k.is_empty() => None,
            Row::Timer {
                turn_key: Some(k), ..
            } => Some(format!("turn-timer-{k}")),
            Row::TurnFooter { turn_key } => Some(format!("turn-footer-{turn_key}")),
            Row::ResponseActions { turn_key, .. } => Some(format!("response-actions-{turn_key}")),
        }
    }
}

/// The projection: rows in order, and each turn's tool results.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Projection {
    pub rows: Vec<Row>,
    /// `(turn's first row uid, results)` for every turn.
    pub results: Vec<(u64, Vec<ToolResult>)>,
}

/// `_turnToolResults`: a turn's `tool_result` outcomes by `toolUseId`, the
/// last one winning, in first-seen order.
fn tool_results(messages: &[&Presented], turn: &Turn) -> Vec<ToolResult> {
    let mut out: Vec<ToolResult> = Vec::new();
    for i in turn.ordered() {
        for part in &messages[i].parts {
            if part.kind != "tool_result" {
                continue;
            }
            let Some(id) = part.tool_use_id().filter(|id| !id.is_empty()) else {
                continue;
            };
            let output = part.tool_output();
            if output.is_none() && !part.is_tool_error() {
                continue;
            }
            let result = ToolResult {
                tool_use_id: id.to_owned(),
                content: output.map(str::to_owned),
                is_error: part.is_tool_error(),
            };
            match out.iter_mut().find(|r| r.tool_use_id == id) {
                Some(existing) => *existing = result,
                None => out.push(result),
            }
        }
    }
    out
}

const BREAK_TOOLS: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];

fn is_step(part: &Part) -> bool {
    match part.kind.as_str() {
        "tool_use" => !part.tool_name().is_some_and(|n| BREAK_TOOLS.contains(&n)),
        "thinking" => part.thinking_text().is_some(),
        "agent" => true,
        _ => false,
    }
}

fn is_break(part: &Part) -> bool {
    part.kind == "tool_use" && part.tool_name().is_some_and(|n| BREAK_TOOLS.contains(&n))
}

/// `_hasBody`: words, files or a failure besides its steps.
fn has_body(message: &Presented) -> bool {
    message.has_text()
        || !message.attachments.is_empty()
        || matches!(message.status, Status::Failed | Status::Cancelled)
}

enum Segment {
    Message {
        at: usize,
        parts: bool,
    },
    Run {
        key: String,
        steps: Vec<(usize, usize)>,
        anchor: Option<String>,
    },
}

/// `segmentTurn`: replies and runs of steps, a message's steps going to the
/// run and its words to the reply after it.
fn segments(messages: &[&Presented], turn_rows: &[usize]) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut run: Vec<(usize, usize)> = Vec::new();
    let mut anchor: Option<String> = None;
    let flush =
        |out: &mut Vec<Segment>, run: &mut Vec<(usize, usize)>, anchor: &mut Option<String>| {
            if let Some(&(first, _)) = run.first() {
                out.push(Segment::Run {
                    key: format!("run-{}", messages[first].id),
                    steps: std::mem::take(run),
                    anchor: anchor.take(),
                });
            }
        };
    for &at in turn_rows {
        let message = messages[at];
        if message.parts.iter().any(is_break) {
            flush(&mut out, &mut run, &mut anchor);
            out.push(Segment::Message { at, parts: true });
            continue;
        }
        let steps: Vec<(usize, usize)> = message
            .parts
            .iter()
            .enumerate()
            .filter(|(_, p)| is_step(p))
            .map(|(i, _)| (at, i))
            .collect();
        if steps.is_empty() {
            if !turns::renderable(message) {
                continue;
            }
            flush(&mut out, &mut run, &mut anchor);
            out.push(Segment::Message { at, parts: true });
            continue;
        }
        run.extend(steps);
        if has_body(message) {
            flush(&mut out, &mut run, &mut anchor);
            out.push(Segment::Message { at, parts: false });
        } else if anchor.is_none() {
            anchor = Some(message.id.clone());
        }
    }
    flush(&mut out, &mut run, &mut anchor);
    out
}

struct Context<'a> {
    messages: &'a [&'a Presented],
    expanded: &'a HashSet<String>,
}

impl Context<'_> {
    fn message_row(&self, at: usize, results: Option<u64>, spinner: bool, parts: bool) -> Row {
        let m = self.messages[at];
        Row::Message {
            uid: m.uid,
            id: m.id.clone(),
            results,
            streaming_spinner: spinner,
            parts,
        }
    }

    /// `_addSegments`.
    fn add_segments(
        &self,
        rows: &mut Vec<Row>,
        turn_rows: &[usize],
        results: u64,
        live: bool,
        spinner: bool,
    ) {
        let segments = segments(self.messages, turn_rows);
        let last = segments.len().saturating_sub(1);
        for (index, segment) in segments.into_iter().enumerate() {
            match segment {
                Segment::Message { at, parts } => {
                    rows.push(self.message_row(at, Some(results), spinner, parts));
                }
                Segment::Run { key, steps, anchor } => {
                    let tail = live && index == last;
                    let len = steps.len();
                    rows.push(Row::Run {
                        expanded: self.expanded.contains(&key),
                        key,
                        steps: steps
                            .into_iter()
                            .map(|(at, i)| (self.messages[at].uid, i))
                            .collect(),
                        shown_from: if tail {
                            len.saturating_sub(RECENT_STEPS)
                        } else {
                            len
                        },
                        results,
                        anchor_message_id: anchor,
                    });
                }
            }
        }
    }

    /// `_TurnFacts._build`.
    fn turn_rows(
        &self,
        turn: &Turn,
        newest: bool,
        turn_in_progress: bool,
        expanded: bool,
        rows: &mut Vec<Row>,
    ) -> Option<TurnTimer> {
        let messages = self.messages;
        let results = messages[turn.first()].uid;
        let intermediate: Vec<&Presented> =
            turn.intermediate().iter().map(|&i| messages[i]).collect();
        let finals = turn.finals();
        let timed: Vec<&Presented> = intermediate
            .iter()
            .copied()
            .chain(finals.iter().map(|&i| messages[i]))
            .collect();
        let timer = turns::newest_timer(&timed);
        let ordered: Vec<&Presented> = turn.ordered().iter().map(|&i| messages[i]).collect();
        let live = turns::is_running(&ordered);
        let in_progress = live || (newest && turn_in_progress);
        let shows_working_row = timer.as_ref().is_some_and(TurnTimer::is_live)
            || (newest
                && turn_in_progress
                && timer.as_ref().is_none_or(|t| t.completed_at.is_some()));
        let key = turn.key(messages).to_owned();
        if let Some(user) = turn.user
            && turns::renderable(messages[user])
        {
            rows.push(self.message_row(user, None, true, true));
        }
        if in_progress {
            self.add_segments(rows, &turn.assistant, results, true, !shows_working_row);
        } else {
            let counts = if turns::collapsible(&intermediate) {
                turns::summarize(&intermediate)
            } else {
                Vec::new()
            };
            let finished = timer.clone().filter(|t| t.completed_at.is_some());
            if !counts.is_empty() {
                rows.push(Row::Steps {
                    turn_key: key.clone(),
                    counts,
                    expanded,
                    timer: finished,
                });
                if expanded {
                    for i in turn.intermediate() {
                        if turns::renderable(messages[i]) {
                            rows.push(self.message_row(i, Some(results), true, true));
                        }
                    }
                }
            } else if finished.is_some() {
                rows.push(Row::Steps {
                    turn_key: key.clone(),
                    counts: Vec::new(),
                    expanded: false,
                    timer: finished,
                });
            }
            self.add_segments(rows, &finals, results, false, true);
            let response = finals
                .iter()
                .rev()
                .find(|&&i| messages[i].role == Some(Role::Assistant) && messages[i].has_text());
            if let Some(&response) = response {
                let last = *turn.assistant.last().unwrap_or(&response);
                rows.push(Row::ResponseActions {
                    uid: messages[response].uid,
                    turn_key: key.clone(),
                    at_message_id: messages[last].id.clone(),
                });
            }
        }
        if let Some(t) = timer.as_ref().filter(|t| t.completed_at.is_none()) {
            rows.push(Row::Timer {
                turn_key: Some(key),
                timer: Some(t.clone()),
            });
        }
        timer
    }
}

/// `TranscriptProjection.rows`: [`Row`]s for `messages` (presented, oldest
/// first). `expanded` holds open turns and run lines alike; `footers` the
/// turn keys that get a footer row.
pub fn project(
    messages: &[&Presented],
    turn_in_progress: bool,
    expanded: &HashSet<String>,
    footers: &HashSet<String>,
) -> Projection {
    let context = Context { messages, expanded };
    let turns = turns::group(messages);
    let mut rows = Vec::new();
    let mut results = Vec::with_capacity(turns.len());
    let mut newest_timer = None;
    let mut newest_footer = None;
    let count = turns.len();
    for (index, turn) in turns.iter().enumerate() {
        let newest = index + 1 == count;
        let key = turn.key(messages).to_owned();
        let timer = context.turn_rows(
            turn,
            newest,
            turn_in_progress,
            expanded.contains(&key),
            &mut rows,
        );
        if newest {
            newest_timer = timer;
        }
        results.push((messages[turn.first()].uid, tool_results(messages, turn)));
        if !key.is_empty() && footers.contains(&key) {
            if newest {
                newest_footer = Some(key);
            } else {
                rows.push(Row::TurnFooter { turn_key: key });
            }
        }
    }
    // Without an authoritative timer part, the send/streaming bridge reads
    // as a bottom "Thinking" row.
    if turn_in_progress && newest_timer.is_none_or(|t| t.completed_at.is_some()) {
        rows.push(Row::Timer {
            turn_key: None,
            timer: None,
        });
    }
    if let Some(turn_key) = newest_footer {
        rows.push(Row::TurnFooter { turn_key });
    }
    Projection { rows, results }
}

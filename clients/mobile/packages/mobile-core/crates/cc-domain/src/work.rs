//! The composer's work drawer (architecture §3.6, P7): background tasks,
//! queued messages, delegates, watchers, pull requests, GitHub runs and
//! linked pipeline runs of one chat, ported from
//! `device_link/work_drawer/projection.dart` and the observation rules of
//! `DeviceWorkDrawerRepository.state`. Every word comes from the host's
//! [`Words`] (`cc-app::copy::work`).
use crate::chat::{ChatRef, ChatState};
use crate::dart::{Dv, DvMap, is_space};
use crate::pipelines::{Run, receipt_ids_of};

/// `WorkGroup`, in the drawer's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkGroup {
    NeedsYou,
    Queued,
    Running,
    PullRequests,
    Watching,
}

impl WorkGroup {
    pub const ALL: [WorkGroup; 5] = [
        WorkGroup::NeedsYou,
        WorkGroup::Queued,
        WorkGroup::Running,
        WorkGroup::PullRequests,
        WorkGroup::Watching,
    ];
}

/// `WorkKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkKind {
    Agent,
    Command,
    Workflow,
    Task,
    Pipeline,
    Github,
    PullRequest,
    Watcher,
    Message,
}

/// `WorkTone`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkTone {
    Neutral,
    Running,
    Attention,
    Success,
    Failed,
    Merged,
    Info,
}

/// `WorkAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkAction {
    StopTask,
    StopDelegate,
    StopDelegates,
    DeleteWatcher,
    CancelQueued,
    ForceQueued,
    SteerQueued,
}

/// `WorkItem`.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkItem {
    pub id: String,
    pub group: WorkGroup,
    pub kind: WorkKind,
    pub title: String,
    pub subtitle: Option<String>,
    pub status: Option<String>,
    pub tone: WorkTone,
    /// Facts in Dart's map order (a repeated label keeps its first place
    /// and takes the last value).
    pub details: Vec<(String, String)>,
    pub action: Option<WorkAction>,
    pub action_id: Option<String>,
    pub url: Option<String>,
    pub pipeline_id: Option<String>,
    pub watcher_count: i64,
    pub count: i64,
    pub finished: bool,
    pub extra_actions: Vec<WorkAction>,
    pub action_labels: Vec<(WorkAction, String)>,
}

impl WorkItem {
    fn new(id: String, group: WorkGroup, kind: WorkKind, title: String) -> Self {
        Self {
            id,
            group,
            kind,
            title,
            subtitle: None,
            status: None,
            tone: WorkTone::Neutral,
            details: Vec::new(),
            action: None,
            action_id: None,
            url: None,
            pipeline_id: None,
            watcher_count: 0,
            count: 1,
            finished: false,
            extra_actions: Vec::new(),
            action_labels: Vec::new(),
        }
    }
}

/// Every word the projection writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Word {
    // workLabel
    Unknown,
    Succeeded,
    Failed,
    Running,
    Queued,
    NeedsInput,
    // Queued messages
    QueuedMessage,
    SwitchProvider,
    WaitingBackgroundWork,
    WaitingCurrentStep,
    TryAgain,
    Interrupt,
    RunNow,
    Message,
    SettingsWaiting,
    Sending,
    InterruptNote,
    WaitingFor,
    BackgroundWorkToFinish,
    Attachments,
    // Tasks
    BackgroundTask,
    Paused,
    Progress,
    Phase,
    Tokens,
    ToolCalls,
    Duration,
    /// `{seconds}s`.
    Seconds,
    // Delegates
    Delegate,
    NeedsApproval,
    Prompt,
    Model,
    /// `{count} more delegate`, `{count} delegate` and the plurals.
    MoreDelegate,
    MoreDelegates,
    OneDelegate,
    Delegates,
    /// `{count} running`, `{count} queued`.
    CountRunning,
    CountQueued,
    // Watchers
    Watching,
    Trigger,
    Status,
    FollowUp,
    SourceError,
    DeliveryError,
    Resumes,
    SourceUnavailable,
    DeliveryFailed,
    /// `Attempt {attempts}` and `Attempt {attempts}, next {next}`.
    Attempt,
    AttemptNext,
    ScheduledWakeup,
    Command,
    Pipeline,
    Hook,
    Chat,
    NewChats,
    Automation,
    GithubRuns,
    PullRequests,
    ChatActivity,
    Project,
    Branch,
    Description,
    Execution,
    Repository,
    ScheduledFor,
    Delay,
    /// `{count} seconds`.
    CountSeconds,
    CheckInterval,
    AttemptLimit,
    Directory,
    // Pull requests
    InMergeQueue,
    /// `In merge queue · {position}`.
    InMergeQueueAt,
    Queue,
    BaseBranch,
    Added,
    Removed,
    /// `+{count}`, `-{count}`.
    Plus,
    Minus,
    LastChecked,
    /// `#{number} {title}`.
    PrTitle,
    // GitHub runs
    Run,
    /// `{name} #{number}` and `… · attempt {attempt}`.
    RunTitle,
    RunTitleAttempt,
    Cancelled,
    Completed,
    // Pipelines
    Output,
}

/// The host's words: `words(word, args)` fills `{name}` placeholders.
pub type Words<'a> = &'a dyn Fn(Word, &[(&str, &str)]) -> String;

fn w(words: Words<'_>, word: Word) -> String {
    words(word, &[])
}

/// Ordered facts with Dart map semantics.
#[derive(Default)]
struct Details(Vec<(String, String)>);

impl Details {
    fn put(&mut self, key: String, value: String) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key, value)),
        }
    }
    fn put_some(&mut self, key: String, value: Option<String>) {
        if let Some(value) = value {
            self.put(key, value);
        }
    }
    fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
}

static EMPTY: std::sync::LazyLock<DvMap> = std::sync::LazyLock::new(DvMap::new);

/// `workObject(value)`.
pub fn object(value: &Dv) -> &DvMap {
    match value {
        Dv::Map(map) => map,
        _ => &EMPTY,
    }
}

/// `workRows(value)`.
pub fn rows(value: &Dv) -> Vec<DvMap> {
    value
        .elements()
        .map(|items| {
            items
                .into_iter()
                .filter_map(|item| match item {
                    Dv::Map(map) => Some(map.clone()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `workText(value)`: a string with something besides whitespace.
pub fn text(value: &Dv) -> Option<String> {
    value
        .as_str()
        .filter(|s| !trim(s).is_empty())
        .map(str::to_owned)
}

/// `workLabel(value)`: a wire status in words.
pub fn label(value: &Dv, words: Words<'_>) -> String {
    let raw = text(value).unwrap_or_else(|| w(words, Word::Unknown));
    let spaced = raw.replace(['_', '-'], " ");
    match spaced.as_str() {
        "success" => w(words, Word::Succeeded),
        "failure" => w(words, Word::Failed),
        "in progress" => w(words, Word::Running),
        "pending" => w(words, Word::Queued),
        "action required" => w(words, Word::NeedsInput),
        _ => capitalize(&spaced),
    }
}

/// `'${text[0].toUpperCase()}${text.substring(1)}'` over UTF-16 units with
/// Dart's simple (one-to-one) case mapping: a character outside the BMP,
/// or one whose uppercase is several characters (`ß`), is left as it is.
fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) if first.len_utf16() == 1 => {
            let mut upper = first.to_uppercase();
            let mapped = match (upper.next(), upper.next()) {
                (Some(single), None) => single,
                _ => first,
            };
            let mut out = String::from(mapped);
            out.push_str(chars.as_str());
            out
        }
        _ => text.to_owned(),
    }
}

/// `watcherMatches(row, chat)`.
pub fn watcher_matches(row: &DvMap, chat: &ChatRef) -> bool {
    let destination = object(row.get("destination"));
    chat.matches_scope(destination) && destination.get("chatId").is_str(&chat.id)
}

/// `followingWatcher(row)`.
fn following(row: &DvMap) -> bool {
    row.get("status").is_str("active")
        || (row.get("status").is_str("firing")
            && (row.get("trigger").is_str("github_workflow_runs_changed")
                || row.get("trigger").is_str("github_pull_requests_changed")))
}

/// `workGithubUrl(value)`: an `https://github.com` URL without user info
/// or an explicit non-default port, as `Uri.parse(..).toString()` prints it
/// (lowercased scheme and host, the default port dropped, dot segments
/// removed, percent-encoding normalized); anything else is dropped.
pub fn github_url(value: &Dv) -> Option<String> {
    let text = value.as_str()?;
    let colon = text.find(':')?;
    if !text[..colon].eq_ignore_ascii_case("https") {
        return None;
    }
    let rest = text[colon + 1..].strip_prefix("//")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.contains('@') {
        return None;
    }
    let host = match authority.split_once(':') {
        // `Uri` drops the scheme's default port; any other is explicit.
        Some((host, port)) if port.is_empty() || port.trim_start_matches('0') == "443" => host,
        Some(_) => return None,
        None => authority,
    };
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let tail = &rest[end..];
    let (before_fragment, fragment) = match tail.split_once('#') {
        Some((a, f)) => (a, Some(f)),
        None => (tail, None),
    };
    let (path, query) = match before_fragment.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (before_fragment, None),
    };
    let mut out = String::from("https://github.com");
    // `Uri` reads a backslash in the path as a slash.
    let path = path.replace('\\', "/");
    out.push_str(&remove_dot_segments(&normalize_component(&path, b"/:@")));
    if let Some(query) = query {
        out.push('?');
        out.push_str(&normalize_component(query, b"/:@?"));
    }
    if let Some(fragment) = fragment {
        out.push('#');
        out.push_str(&normalize_component(fragment, b"/:@?"));
    }
    Some(out)
}

fn unreserved(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~')
}

/// `Uri`'s component normalization: an escape of an unreserved byte is
/// decoded, other escapes get uppercase hex, and bytes outside the
/// component's characters (unreserved, sub-delims and `extra`) are
/// percent-encoded as UTF-8.
fn normalize_component(text: &str, extra: &[u8]) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let hex = |b: u8| char::from(b"0123456789ABCDEF"[usize::from(b)]);
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            let value = u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap_or(0);
            if unreserved(value) {
                out.push(char::from(value));
            } else {
                out.push('%');
                out.push(hex(value >> 4));
                out.push(hex(value & 15));
            }
            i += 3;
            continue;
        }
        if unreserved(b) || b"!$&'()*+,;=".contains(&b) || extra.contains(&b) {
            out.push(char::from(b));
        } else {
            out.push('%');
            out.push(hex(b >> 4));
            out.push(hex(b & 15));
        }
        i += 1;
    }
    out
}

/// RFC 3986 `remove_dot_segments` (`Uri._removeDotSegments`).
fn remove_dot_segments(path: &str) -> String {
    if !path.contains('.') {
        return path.to_owned();
    }
    let mut output: Vec<&str> = Vec::new();
    let segments: Vec<&str> = path.split('/').collect();
    let mut append_slash = false;
    for segment in &segments[1..] {
        append_slash = false;
        match *segment {
            ".." => {
                output.pop();
                append_slash = true;
            }
            "." => append_slash = true,
            other => output.push(other),
        }
    }
    let mut out = String::new();
    for segment in &output {
        out.push('/');
        out.push_str(segment);
    }
    if append_slash || out.is_empty() {
        out.push('/');
    }
    out
}

/// What one chat's drawer reads.
pub struct Inputs<'a> {
    pub chat: &'a ChatState,
    pub tasks: &'a [DvMap],
    pub watchers: &'a [DvMap],
    pub delegations: &'a [DvMap],
    /// `pipelines.runs(chat.ref)`: listed runs, newest first.
    pub pipelines: &'a [&'a Run],
    pub agents: &'a [DvMap],
    pub queue: &'a [DvMap],
}

/// `projectWork(...)`.
#[allow(clippy::too_many_lines)]
pub fn project(input: &Inputs<'_>, words: Words<'_>) -> Vec<WorkItem> {
    let chat = &input.chat.chat;
    let mut result: Vec<WorkItem> = Vec::new();
    for row in input.queue {
        let Some(id) = text(row.get("id")) else {
            continue;
        };
        let unlocked = !row.get("editLocked").is_true()
            && !row.get("forceLocked").is_true()
            && row.get("retryBlockedReason").is_null();
        let mut item = WorkItem::new(
            format!("message:{id}"),
            WorkGroup::Queued,
            WorkKind::Message,
            text(row.get("text")).unwrap_or_else(|| w(words, Word::QueuedMessage)),
        );
        item.status = if row.get("retryBlockedReason").is_str("insufficient_credits") {
            Some(w(words, Word::SwitchProvider))
        } else {
            match row.get("waitingReason") {
                Dv::Str(s) if s == "background_work" => Some(w(words, Word::WaitingBackgroundWork)),
                Dv::Str(s) if s == "steer_unavailable" => Some(w(words, Word::WaitingCurrentStep)),
                Dv::Null => None,
                reason => Some(label(reason, words)),
            }
        };
        item.action_id = Some(id);
        item.action = (!row.get("editLocked").is_true()).then_some(WorkAction::CancelQueued);
        if unlocked {
            item.extra_actions.push(WorkAction::ForceQueued);
        }
        if unlocked
            && row.get("canSteer").is_true()
            && (row.get("turnPhase").is_null() || row.get("turnPhase").is_str("foreground"))
        {
            item.extra_actions.push(WorkAction::SteerQueued);
        }
        item.action_labels.push((
            WorkAction::ForceQueued,
            w(
                words,
                if row.get("retryable").is_true() {
                    Word::TryAgain
                } else if row.get("turnPhase").is_str("foreground") {
                    Word::Interrupt
                } else {
                    Word::RunNow
                },
            ),
        ));
        let mut d = Details::default();
        d.put_some(w(words, Word::Message), text(row.get("text")));
        if let Some(held) = row.get("restartHeldChanges").elements() {
            d.put(
                w(words, Word::SettingsWaiting),
                held.into_iter()
                    .map(|v| label(v, words))
                    .collect::<Vec<_>>()
                    .join(", "),
            );
        }
        if row.get("blockedByBackgroundWork").is_true() {
            d.put(w(words, Word::Sending), w(words, Word::InterruptNote));
            d.put(
                w(words, Word::WaitingFor),
                w(words, Word::BackgroundWorkToFinish),
            );
        }
        if !row.get("retryBlockedReason").is_null() {
            d.put(
                w(words, Word::WaitingFor),
                label(row.get("retryBlockedReason"), words),
            );
        }
        if let Some(paths) = row.get("attachmentPaths").elements() {
            d.put(w(words, Word::Attachments), paths.len().to_string());
        }
        item.details = d.0;
        result.push(item);
    }
    if let Some(queued) = input.chat.runtime.get("queuedMessageIds").elements() {
        for id in queued.into_iter().filter_map(Dv::as_str) {
            let key = format!("message:{id}");
            if result.iter().any(|item| item.id == key) {
                continue;
            }
            let message = input.chat.messages.iter().find(|m| m.id().ok() == Some(id));
            let message_text = message.and_then(|m| {
                let t = message_text(&m.raw);
                (!trim(&t).is_empty()).then_some(t)
            });
            let mut item = WorkItem::new(
                key,
                WorkGroup::Queued,
                WorkKind::Message,
                message_text
                    .clone()
                    .unwrap_or_else(|| w(words, Word::QueuedMessage)),
            );
            let mut d = Details::default();
            d.put_some(w(words, Word::Message), message_text);
            item.details = d.0;
            result.push(item);
        }
    }
    for task in input.tasks {
        let Some(id) = text(task.get("taskId")) else {
            continue;
        };
        let paused = task.get("status").is_str("paused");
        let usage = object(task.get("usage"));
        let mut item = WorkItem::new(
            format!("task:{id}"),
            if paused {
                WorkGroup::NeedsYou
            } else {
                WorkGroup::Running
            },
            match task.get("taskType").as_str() {
                Some("agent" | "local_agent" | "remote_agent" | "in_process_teammate") => {
                    WorkKind::Agent
                }
                Some("bash" | "shell" | "local_bash" | "monitor_ws" | "monitor_mcp") => {
                    WorkKind::Command
                }
                Some("workflow" | "local_workflow") => WorkKind::Workflow,
                _ => WorkKind::Task,
            },
            text(task.get("description"))
                .or_else(|| text(task.get("workflowName")))
                .unwrap_or_else(|| w(words, Word::BackgroundTask)),
        );
        item.subtitle = text(task.get("summary")).or_else(|| text(task.get("phase")));
        item.status = Some(w(
            words,
            if task.get("status").is_str("pending") {
                Word::Queued
            } else if paused {
                Word::Paused
            } else {
                Word::Running
            },
        ));
        item.tone = if paused {
            WorkTone::Attention
        } else {
            WorkTone::Running
        };
        item.action =
            (!matches!(task.get("stoppable"), Dv::Bool(false))).then_some(WorkAction::StopTask);
        item.action_id = Some(id);
        let mut d = Details::default();
        d.put_some(w(words, Word::Progress), text(task.get("summary")));
        d.put_some(w(words, Word::Phase), text(task.get("phase")));
        if usage.get("totalTokens").num().is_some() {
            d.put(
                w(words, Word::Tokens),
                usage.get("totalTokens").dart_string(),
            );
        }
        if usage.get("toolUses").num().is_some() {
            d.put(
                w(words, Word::ToolCalls),
                usage.get("toolUses").dart_string(),
            );
        }
        if let Some(ms) = usage.get("durationMs").num() {
            d.put(
                w(words, Word::Duration),
                words(Word::Seconds, &[("seconds", &dart_round(ms / 1000.0))]),
            );
        }
        item.details = d.0;
        result.push(item);
    }
    let mut listed: i64 = 0;
    for entry in input.agents {
        let snapshot = object(entry.get("snapshot"));
        if !entry.get("executionMode").is_str("background")
            || !(snapshot.get("status").is_str("pending")
                || snapshot.get("status").is_str("running"))
        {
            continue;
        }
        let Some(id) = text(snapshot.get("delegationId")) else {
            continue;
        };
        listed += 1;
        let approval = snapshot.get("approvalPending").is_true();
        let mut item = WorkItem::new(
            format!("delegate:{id}"),
            if approval {
                WorkGroup::NeedsYou
            } else {
                WorkGroup::Running
            },
            WorkKind::Agent,
            text(entry.get("description")).unwrap_or_else(|| w(words, Word::Delegate)),
        );
        item.status = Some(w(
            words,
            if approval {
                Word::NeedsApproval
            } else if snapshot.get("status").is_str("pending") {
                Word::Queued
            } else {
                Word::Running
            },
        ));
        item.tone = if approval {
            WorkTone::Attention
        } else {
            WorkTone::Running
        };
        item.action = Some(WorkAction::StopDelegate);
        item.action_id = Some(id);
        let mut d = Details::default();
        d.put_some(w(words, Word::Prompt), text(entry.get("prompt")));
        d.put_some(w(words, Word::Progress), text(snapshot.get("partialText")));
        d.put_some(
            w(words, Word::Model),
            text(object(snapshot.get("routeSnapshot")).get("runtimeModelLabel")),
        );
        item.details = d.0;
        result.push(item);
    }
    let activity = input
        .delegations
        .iter()
        .find(|r| chat.matches_scope(r) && r.get("chatId").is_str(&chat.id));
    let live = activity.map_or(0, |a| to_int(a.get("live")));
    let pending = activity.map_or(0, |a| to_int(a.get("queued")));
    let unlisted = (live + pending - listed).clamp(0, (live + pending).max(0));
    if unlisted > 0 {
        let count = unlisted.to_string();
        let title_word = match (listed > 0, unlisted == 1) {
            (true, true) => Word::MoreDelegate,
            (true, false) => Word::MoreDelegates,
            (false, true) => Word::OneDelegate,
            (false, false) => Word::Delegates,
        };
        let mut item = WorkItem::new(
            "delegates".into(),
            WorkGroup::Running,
            WorkKind::Agent,
            words(title_word, &[("count", &count)]),
        );
        let mut parts = Vec::new();
        if live > 0 {
            parts.push(words(Word::CountRunning, &[("count", &live.to_string())]));
        }
        if pending > 0 {
            parts.push(words(Word::CountQueued, &[("count", &pending.to_string())]));
        }
        item.subtitle = Some(parts.join(" · "));
        item.tone = WorkTone::Running;
        item.count = unlisted;
        item.action = Some(WorkAction::StopDelegates);
        result.push(item);
    }

    // `scoped`: the last row per id among this chat's watchers.
    let mut scoped: Vec<(String, &DvMap)> = Vec::new();
    for watcher in input.watchers {
        if !watcher_matches(watcher, chat) {
            continue;
        }
        let Some(id) = text(watcher.get("id")) else {
            continue;
        };
        match scoped.iter_mut().find(|(i, _)| *i == id) {
            Some(slot) => slot.1 = watcher,
            None => scoped.push((id, watcher)),
        }
    }
    let mut prs: Vec<(String, DvMap)> = Vec::new();
    let mut runs: Vec<(String, DvMap)> = Vec::new();
    let mut active_runs: Vec<String> = Vec::new();
    let mut counts: Vec<(String, i64)> = Vec::new();
    let bump = |counts: &mut Vec<(String, i64)>, key: &str| match counts
        .iter_mut()
        .find(|(k, _)| k == key)
    {
        Some(entry) => entry.1 += 1,
        None => counts.push((key.to_owned(), 1)),
    };
    let newer = |observed: &Dv, held: &DvMap| {
        crate::composer::picker::compare_strings(
            &observed.dart_string(),
            &held.get("observedAt").dart_string(),
        ) == std::cmp::Ordering::Greater
    };
    for (_, watcher) in &scoped {
        let active = following(watcher);
        for pr in rows(object(watcher.get("githubPullRequestProgress")).get("pullRequests")) {
            let key = format!(
                "pr:{}#{}",
                pr.get("repository").dart_string(),
                pr.get("number").dart_string()
            );
            match prs.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => {
                    if newer(pr.get("observedAt"), &slot.1) {
                        slot.1 = pr.clone();
                    }
                }
                None => prs.push((key.clone(), pr.clone())),
            }
            if active {
                bump(&mut counts, &key);
            }
        }
        for run in rows(object(watcher.get("githubProgress")).get("runs")) {
            let key = format!(
                "github:{}/{}/{}",
                run.get("repository").dart_string(),
                run.get("runId").dart_string(),
                run.get("runAttempt").dart_string()
            );
            match runs.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => {
                    if newer(run.get("observedAt"), &slot.1) {
                        slot.1 = run.clone();
                    }
                }
                None => runs.push((key.clone(), run.clone())),
            }
            if active {
                if !active_runs.contains(&key) {
                    active_runs.push(key.clone());
                }
                bump(&mut counts, &key);
            }
        }
        let status = watcher.get("status");
        if !status.is_str("active") && !status.is_str("delivery_failed") {
            continue;
        }
        let target = object(watcher.get("target"));
        let mut watching: Vec<String> = Vec::new();
        for item in rows(target.get("items")) {
            if let Some(repo) = text(item.get("repository")) {
                let entry = if item.get("number").is_null() {
                    repo
                } else {
                    format!("{repo}#{}", item.get("number").dart_string())
                };
                if !watching.contains(&entry) {
                    watching.push(entry);
                }
            }
        }
        let watching = watching.join(", ");
        let failed = status.is_str("delivery_failed");
        let source_failed = failed && watcher.get("failureKind").is_str("source");
        let failed_status = w(
            words,
            if source_failed {
                Word::SourceUnavailable
            } else {
                Word::DeliveryFailed
            },
        );
        let mut d = Details::default();
        d.put(
            w(words, Word::Watching),
            if watching.is_empty() {
                target_label(target, words)
            } else {
                watching
            },
        );
        for (key, value) in target_details(target, words) {
            d.put(key, value);
        }
        d.put(
            w(words, Word::Trigger),
            label(watcher.get("trigger"), words),
        );
        d.put(
            w(words, Word::Status),
            if failed {
                failed_status.clone()
            } else {
                w(words, Word::Watching)
            },
        );
        d.put_some(
            w(words, Word::FollowUp),
            text(watcher.get("followUpInstruction")),
        );
        d.put_some(
            w(
                words,
                if source_failed {
                    Word::SourceError
                } else {
                    Word::DeliveryError
                },
            ),
            text(watcher.get("deliveryError")),
        );
        d.put_some(
            w(words, Word::Resumes),
            text(watcher.get("githubRateLimitedUntil")),
        );
        let progress = object(watcher.get("localProgress"));
        if !progress.is_empty() {
            let attempts =
                crate::dart::value::or(progress.get("attempts"), &Dv::Int(0)).dart_string();
            d.put(
                w(words, Word::Progress),
                if progress.get("nextAttemptAt").is_null() {
                    words(Word::Attempt, &[("attempts", &attempts)])
                } else {
                    words(
                        Word::AttemptNext,
                        &[
                            ("attempts", &attempts),
                            ("next", &progress.get("nextAttemptAt").dart_string()),
                        ],
                    )
                },
            );
        }
        let watching_key = w(words, Word::Watching);
        let shown = d.get(&watching_key).unwrap_or_default().to_owned();
        let id = text(watcher.get("id"));
        let mut item = WorkItem::new(
            format!("watcher:{}", watcher.get("id").dart_string()),
            WorkGroup::Watching,
            WorkKind::Watcher,
            text(watcher.get("label")).unwrap_or_else(|| shown.clone()),
        );
        item.subtitle = Some(shown);
        item.status = failed.then_some(failed_status);
        item.tone = if failed {
            WorkTone::Attention
        } else {
            WorkTone::Info
        };
        item.details = d.0;
        item.action = Some(WorkAction::DeleteWatcher);
        item.action_id = id;
        result.push(item);
    }
    for (key, pr) in &prs {
        let queue = object(pr.get("queue"));
        let state = text(pr.get("state")).unwrap_or_else(|| "unknown".into());
        let title = format!(
            "{} {}",
            words(
                Word::PrTitle,
                &[("number", &pr.get("number").dart_string())]
            ),
            text(pr.get("title")).unwrap_or_default()
        );
        let mut item = WorkItem::new(
            key.clone(),
            WorkGroup::PullRequests,
            WorkKind::PullRequest,
            trim(&title).to_owned(),
        );
        item.subtitle = text(pr.get("repository"));
        item.tone = match state.as_str() {
            "merged" => WorkTone::Merged,
            "open" => WorkTone::Success,
            _ => WorkTone::Neutral,
        };
        item.watcher_count = counts.iter().find(|(k, _)| k == key).map_or(0, |(_, c)| *c);
        item.url = github_url(pr.get("url"));
        let queued = !queue.is_empty() && state == "open";
        let mut d = Details::default();
        d.put(
            w(words, Word::Status),
            if queued {
                if queue.get("position").is_null() {
                    w(words, Word::InMergeQueue)
                } else {
                    words(
                        Word::InMergeQueueAt,
                        &[("position", &queue.get("position").dart_string())],
                    )
                }
            } else {
                label(&Dv::Str(state.clone()), words)
            },
        );
        if queued {
            d.put(w(words, Word::Queue), label(queue.get("phase"), words));
        }
        d.put_some(w(words, Word::BaseBranch), text(pr.get("baseRefName")));
        if pr.get("additions").num().is_some() {
            d.put(
                w(words, Word::Added),
                words(Word::Plus, &[("count", &pr.get("additions").dart_string())]),
            );
        }
        if pr.get("deletions").num().is_some() {
            d.put(
                w(words, Word::Removed),
                words(
                    Word::Minus,
                    &[("count", &pr.get("deletions").dart_string())],
                ),
            );
        }
        d.put_some(w(words, Word::LastChecked), text(pr.get("observedAt")));
        item.details = d.0;
        result.push(item);
    }
    for (key, run) in &runs {
        let state = object(run.get("state"));
        let terminal = state.get("kind").is_str("terminal") || state.get("terminal").is_true();
        if !terminal && !active_runs.contains(key) {
            continue;
        }
        let status = text(state.get("conclusion"))
            .or_else(|| text(state.get("status")))
            .unwrap_or_else(|| "unknown".into());
        let run_status = if terminal {
            w(
                words,
                match status.as_str() {
                    "success" => Word::Succeeded,
                    "failure" | "timed_out" | "startup_failure" | "action_required" => Word::Failed,
                    "cancelled" => Word::Cancelled,
                    _ => Word::Completed,
                },
            )
        } else {
            w(words, Word::Running)
        };
        let number = crate::dart::value::or(run.get("runNumber"), run.get("runId")).dart_string();
        let name = text(run.get("workflowName")).unwrap_or_else(|| w(words, Word::Run));
        let attempt = run.get("runAttempt");
        let title = match attempt.num() {
            Some(n) if n > 1.0 => words(
                Word::RunTitleAttempt,
                &[
                    ("name", &name),
                    ("number", &number),
                    ("attempt", &attempt.dart_string()),
                ],
            ),
            _ => words(Word::RunTitle, &[("name", &name), ("number", &number)]),
        };
        let mut item = WorkItem::new(key.clone(), WorkGroup::Running, WorkKind::Github, title);
        item.subtitle = text(run.get("repository"));
        item.status = Some(run_status);
        item.tone = if terminal {
            if status == "action_required" {
                WorkTone::Failed
            } else {
                terminal_tone(&status)
            }
        } else {
            WorkTone::Running
        };
        item.finished = terminal;
        item.watcher_count = counts.iter().find(|(k, _)| k == key).map_or(0, |(_, c)| *c);
        item.url = github_url(run.get("htmlUrl"));
        let mut d = Details::default();
        d.put(
            w(words, Word::Status),
            label(&Dv::Str(status.clone()), words),
        );
        for job in rows(run.get("jobs")) {
            let name = crate::dart::value::or(job.get("name"), job.get("jobId")).dart_string();
            d.put(name, job_status(&job, words));
        }
        d.put_some(w(words, Word::LastChecked), text(run.get("observedAt")));
        item.details = d.0;
        result.push(item);
    }
    let receipts = receipt_ids_of(chat, &input.chat.messages);
    for run in input.pipelines {
        if run.hidden
            || !run.is_root()
            || run.workspace_local_id.as_deref() != Some(chat.project_id.as_str())
            || run.worktree_local_id.as_deref() != Some(chat.worktree_id.as_str())
            || (!receipts.contains(&run.local_id)
                && !run
                    .chat_turns
                    .as_deref()
                    .is_some_and(|turns| turns.iter().any(|t| t.chat_id == chat.id)))
        {
            continue;
        }
        let terminal = matches!(run.status.as_str(), "success" | "failure" | "cancelled");
        let attention = run.status == "paused";
        let needs_input = attention && run.pending_pauses.iter().any(|p| p.kind == "input");
        let status = if needs_input {
            w(words, Word::NeedsInput)
        } else {
            label(&Dv::Str(run.status.clone()), words)
        };
        let mut item = WorkItem::new(
            format!("pipeline:{}", run.local_id),
            if attention {
                WorkGroup::NeedsYou
            } else {
                WorkGroup::Running
            },
            WorkKind::Pipeline,
            run.pipeline_name.clone(),
        );
        item.status = Some(status.clone());
        item.tone = if attention {
            WorkTone::Attention
        } else if terminal {
            terminal_tone(&run.status)
        } else {
            WorkTone::Running
        };
        item.finished = terminal;
        item.pipeline_id = Some(run.local_id.clone());
        let mut d = Details::default();
        d.put(w(words, Word::Status), status);
        for pause in &run.pending_pauses {
            let key = pause.title.clone().unwrap_or_else(|| {
                w(
                    words,
                    if pause.kind == "input" {
                        Word::NeedsInput
                    } else {
                        Word::Paused
                    },
                )
            });
            let mut parts: Vec<String> = Vec::new();
            if let Some(message) = &pause.message {
                parts.push(message.clone());
            }
            parts.extend(pause.field_labels.iter().cloned());
            d.put(key, parts.join(" · "));
        }
        for reason in &run.status_reasons {
            d.put(
                w(words, Word::WaitingFor),
                label(&Dv::Str(reason.code.clone()), words),
            );
        }
        for job in run.jobs.as_deref().unwrap_or_default() {
            d.put(job.name.clone(), label(&Dv::Str(job.status.clone()), words));
        }
        if let Some(tail) = run.output_tail.as_ref().filter(|t| !t.is_empty()) {
            d.put(w(words, Word::Output), tail.clone());
        }
        item.details = d.0;
        result.push(item);
    }
    result
}

/// `DeviceChatMessage.text`.
fn message_text(raw: &DvMap) -> String {
    let blocks = rows(raw.get("blocks"));
    blocks
        .iter()
        .filter(|b| b.get("type").is_str("text"))
        .map(|b| b.get("text").as_str().unwrap_or_default().to_owned())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// `(value as num?)?.toInt() ?? 0` (a non-number reads as zero; Dart's
/// cast would have thrown).
fn to_int(value: &Dv) -> i64 {
    match value {
        Dv::Int(n) => *n,
        #[allow(clippy::cast_possible_truncation)]
        Dv::Float(f) if f.is_finite() => f.trunc() as i64,
        _ => 0,
    }
}

/// `(x).round()` printed: half away from zero.
fn dart_round(value: f64) -> String {
    if !value.is_finite() {
        return crate::dart::double_to_string(value);
    }
    #[allow(clippy::cast_possible_truncation)]
    let rounded = value.round() as i64;
    rounded.to_string()
}

fn terminal_tone(status: &str) -> WorkTone {
    match status {
        "success" => WorkTone::Success,
        "failure" | "timed_out" | "startup_failure" => WorkTone::Failed,
        _ => WorkTone::Neutral,
    }
}

/// `_jobStatus(job)`.
fn job_status(job: &DvMap, words: Words<'_>) -> String {
    let state = object(job.get("state"));
    let value = [
        state.get("conclusion"),
        state.get("status"),
        job.get("conclusion"),
        job.get("status"),
    ]
    .into_iter()
    .find(|v| !v.is_null())
    .unwrap_or(&Dv::Null);
    label(value, words)
}

/// `_targetLabel(target)`.
fn target_label(target: &DvMap, words: Words<'_>) -> String {
    let or = |key: &str, word: Word| text(target.get(key)).unwrap_or_else(|| w(words, word));
    match target.get("kind").as_str() {
        Some("scheduled_wakeup") => w(words, Word::ScheduledWakeup),
        Some("command_watch") => or("command", Word::Command),
        Some("worktree_pipeline") => or("pipelineName", Word::Pipeline),
        Some("worktree_hook") => or("hookLabel", Word::Hook),
        Some("worktree_chat" | "standalone_chat") => or("chatTitle", Word::Chat),
        Some("worktree_chat_scope") => or("worktreeBranchName", Word::NewChats),
        Some("standalone_chat_project") => or("projectName", Word::NewChats),
        Some("automation") => or("automationName", Word::Automation),
        Some("github_workflow_runs") => w(words, Word::GithubRuns),
        Some("github_pull_requests") => w(words, Word::PullRequests),
        _ => w(words, Word::ChatActivity),
    }
}

/// `_targetDetails(target)`.
fn target_details(target: &DvMap, words: Words<'_>) -> Vec<(String, String)> {
    let mut d = Details::default();
    d.put_some(
        w(words, Word::Project),
        text(target.get("workspaceName")).or_else(|| text(target.get("projectName"))),
    );
    d.put_some(
        w(words, Word::Branch),
        text(target.get("worktreeBranchName")),
    );
    d.put_some(
        w(words, Word::Description),
        text(target.get("chatDescription")),
    );
    d.put_some(w(words, Word::Pipeline), text(target.get("pipelineName")));
    d.put_some(w(words, Word::Execution), text(target.get("executionId")));
    d.put_some(w(words, Word::Hook), text(target.get("hookLabel")));
    d.put_some(w(words, Word::Trigger), text(target.get("triggerName")));
    d.put_some(w(words, Word::Repository), text(target.get("repoName")));
    d.put_some(
        w(words, Word::ScheduledFor),
        text(target.get("scheduledFor")),
    );
    let seconds = |key: &str| {
        words(
            Word::CountSeconds,
            &[("count", &target.get(key).dart_string())],
        )
    };
    if target.get("delaySeconds").num().is_some() {
        d.put(w(words, Word::Delay), seconds("delaySeconds"));
    }
    if target.get("intervalSeconds").num().is_some() {
        d.put(w(words, Word::CheckInterval), seconds("intervalSeconds"));
    }
    if target.get("maxAttempts").num().is_some() {
        d.put(
            w(words, Word::AttemptLimit),
            target.get("maxAttempts").dart_string(),
        );
    }
    d.put_some(w(words, Word::Command), text(target.get("command")));
    d.put_some(w(words, Word::Directory), text(target.get("cwd")));
    d.0
}

/// What `DeviceWorkDrawerRepository.state` remembers between reads: runs
/// seen unfinished, and the last pull request and finished run
/// observations.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Observations {
    seen: Vec<String>,
    observed: Vec<(String, WorkItem)>,
}

impl Observations {
    /// `state`'s item list from a fresh projection, updating what it
    /// remembers.
    pub fn items(&mut self, projected: Vec<WorkItem>) -> Vec<WorkItem> {
        for item in &projected {
            if item.group == WorkGroup::PullRequests {
                self.observe(item);
            }
            if matches!(item.kind, WorkKind::Pipeline | WorkKind::Github)
                && !item.finished
                && !self.seen.contains(&item.id)
            {
                self.seen.push(item.id.clone());
            }
            if item.finished && self.seen.contains(&item.id) {
                self.observe(item);
            }
        }
        let mut out: Vec<WorkItem> = projected
            .iter()
            .filter(|item| !item.finished || self.seen.contains(&item.id))
            .cloned()
            .collect();
        for (id, item) in &self.observed {
            if !projected.iter().any(|p| p.id == *id) {
                out.push(WorkItem {
                    watcher_count: 0,
                    ..item.clone()
                });
            }
        }
        out
    }

    fn observe(&mut self, item: &WorkItem) {
        match self.observed.iter_mut().find(|(id, _)| *id == item.id) {
            Some(slot) => slot.1 = item.clone(),
            None => self.observed.push((item.id.clone(), item.clone())),
        }
    }
}

/// `WorkDrawerState.count(group)`: unfinished items' counts.
pub fn count(items: &[WorkItem], group: WorkGroup) -> i64 {
    items
        .iter()
        .filter(|i| i.group == group && !i.finished)
        .map(|i| i.count)
        .sum()
}

/// `WorkDrawerState.visible`.
pub fn visible(items: &[WorkItem]) -> bool {
    items.iter().any(|i| !i.finished)
}

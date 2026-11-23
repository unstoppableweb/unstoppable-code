//! One desktop chat scope and selected chat, as the Dart chats repository
//! kept it (architecture §3.4, P5a). Ported from
//! `lib/device_link/chats/{state,scope_state,title,cache}.dart`; comments
//! cite the Dart rule they keep. Revisions stay desktop-owned: a gap asks
//! for a fresh snapshot instead of guessing.
//!
//! The reducer reads [`Dv`], the desktop value as Dart held it, so every
//! Dart cast keeps its outcome: a `deviceLinkObject` or `deviceLinkString`
//! failure is [`Thrown::Invalid`] (a `DeviceLinkException`), any other cast
//! [`Thrown::Cast`] (a `TypeError`).
mod scope;
pub mod send;

pub use scope::ScopeState;

use crate::dart::{Dv, DvMap, is_space};
use std::sync::Arc;

/// What a Dart rule threw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Thrown {
    /// `deviceLinkObject` / `deviceLinkString`: "The peer sent an invalid
    /// message."
    Invalid,
    /// A cast (`as int`, `as List`) or `num.toInt()` of NaN.
    Cast,
}

/// `deviceLinkObject(value)`.
pub fn object(value: &Dv) -> Result<&DvMap, Thrown> {
    match value {
        Dv::Map(map) => Ok(map),
        _ => Err(Thrown::Invalid),
    }
}

/// `deviceLinkString(map, key)`: non-empty, at most 4096 UTF-16 units.
pub fn link_string<'a>(map: &'a DvMap, key: &str) -> Result<&'a str, Thrown> {
    match map.get(key) {
        Dv::Str(s) if !s.is_empty() && s.encode_utf16().count() <= 4096 => Ok(s),
        _ => Err(Thrown::Invalid),
    }
}

/// `value as int`.
fn cast_int(value: &Dv) -> Result<i64, Thrown> {
    match value {
        Dv::Int(n) => Ok(*n),
        _ => Err(Thrown::Cast),
    }
}

/// `(value as num).toInt()`.
fn num_to_int(value: &Dv) -> Result<i64, Thrown> {
    match value {
        Dv::Int(n) => Ok(*n),
        // Dart truncates toward zero; NaN and infinities throw.
        #[allow(clippy::cast_possible_truncation)]
        Dv::Float(f) if f.is_finite() => Ok(f.trunc() as i64),
        _ => Err(Thrown::Cast),
    }
}

/// `(value as num?)?.toInt()`.
fn optional_int(value: &Dv) -> Result<Option<i64>, Thrown> {
    if value.is_null() {
        Ok(None)
    } else {
        num_to_int(value).map(Some)
    }
}

/// `value as List`, its elements (a `Uint8List` is a list of ints).
fn cast_list(value: &Dv) -> Result<Vec<&Dv>, Thrown> {
    value.elements().ok_or(Thrown::Cast)
}

/// `{...a, ...b}`.
pub(crate) fn spread(a: &DvMap, b: &DvMap) -> DvMap {
    let mut out = a.clone();
    for (key, value) in b.iter() {
        out.insert(key.to_owned(), value.clone());
    }
    out
}

/// Dart `String.trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// The desktop's custom name wins over its generated description; `title`
/// remains the fallback captured from the first prompt (`deviceChatTitle`).
pub fn chat_title(tab: &DvMap, fallback: &str) -> String {
    for key in ["customTitle", "description", "title"] {
        if let Some(value) = tab.get(key).as_str() {
            let value = trim(value);
            if !value.is_empty() {
                return value.to_owned();
            }
        }
    }
    fallback.to_owned()
}

/// Runtime statuses that count as running.
const RUNNING: [&str; 5] = [
    "queued",
    "starting",
    "streaming",
    "awaiting_input",
    "completing",
];

pub(crate) fn is_running(status: &Dv) -> bool {
    RUNNING.iter().any(|s| status.is_str(s))
}

/// `DeviceChatRef`: a chat of one desktop scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatRef {
    pub project_id: String,
    pub worktree_id: String,
    pub id: String,
    /// The catalog title, the fallback for [`ChatState::title`].
    pub title: String,
}

impl ChatRef {
    /// `"$projectId/$worktreeId/$id"`.
    pub fn key(&self) -> String {
        format!("{}/{}/{}", self.project_id, self.worktree_id, self.id)
    }
    /// `matchesScope`.
    pub fn matches_scope(&self, value: &DvMap) -> bool {
        value.get("projectId").is_str(&self.project_id)
            && value.get("worktreeId").is_str(&self.worktree_id)
    }
}

/// Issues the identity of each message entry. An entry never changes: an
/// upsert replaces it with a new one.
#[derive(Debug, Default)]
pub struct Uids(u64);
impl Uids {
    pub fn issue(&mut self) -> u64 {
        self.0 += 1;
        self.0
    }
}

/// One desktop message (`DeviceChatMessage`): the raw map, unchanged.
#[derive(Debug, Clone)]
pub struct Message {
    pub uid: u64,
    pub raw: Arc<DvMap>,
}

impl Message {
    fn new(raw: DvMap, uids: &mut Uids) -> Self {
        Self {
            uid: uids.issue(),
            raw: Arc::new(raw),
        }
    }
    /// `message.id` (`deviceLinkString`).
    pub fn id(&self) -> Result<&str, Thrown> {
        link_string(&self.raw, "id")
    }
}

/// A projection of one desktop scope and selected chat (`DeviceChatState`).
#[derive(Debug, Clone)]
pub struct ChatState {
    pub chat: ChatRef,
    pub revision: i64,
    pub transcript_revision: i64,
    pub tab: DvMap,
    pub runtime: DvMap,
    pub messages: Vec<Message>,
    pub before: Option<i64>,
    pub total_messages: i64,
    pub closed: bool,
    pub scope: ScopeState,
}

/// How an event applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// Applied, or not for this chat (`true`).
    Done,
    /// A gap, an omission, a reset or an unknown anchor: read a fresh
    /// snapshot (`false`). Changes before the one that stopped stay
    /// applied, as Dart mutated the state in place.
    Resync,
}

fn closed_tab(tab: &DvMap) -> bool {
    tab.is_empty() || tab.get("kind").is_str("file") || !tab.get("archivedAt").is_null()
}

impl ChatState {
    pub fn new(chat: ChatRef) -> Self {
        Self {
            chat,
            revision: 0,
            transcript_revision: 0,
            tab: DvMap::new(),
            runtime: DvMap::new(),
            messages: Vec::new(),
            before: None,
            total_messages: 0,
            closed: false,
            scope: ScopeState::default(),
        }
    }

    /// `title`.
    pub fn title(&self) -> String {
        chat_title(&self.tab, &self.chat.title)
    }
    pub fn read_only(&self) -> bool {
        self.tab.get("readOnly").is_true()
    }

    pub fn running(&self) -> bool {
        is_running(self.runtime.get("status"))
    }
    /// `hasPendingDecision`.
    pub fn has_pending_decision(&self) -> bool {
        self.scope.needs_input(&self.chat.id)
    }
    pub fn awaiting_input(&self) -> bool {
        self.runtime.get("status").is_str("awaiting_input") || self.has_pending_decision()
    }
    /// `runtimeError`. Dart's `as String?` threw for another type there;
    /// that shows nothing here.
    pub fn runtime_error(&self) -> Option<String> {
        match self.runtime.get("error") {
            Dv::Map(error) => error.get("message").as_str().map(str::to_owned),
            _ => None,
        }
    }

    /// `hydrate(snapshot, page)`: the scope snapshot and the newest page.
    pub fn hydrate(
        &mut self,
        snapshot: &DvMap,
        page: &DvMap,
        uids: &mut Uids,
    ) -> Result<(), Thrown> {
        self.revision = cast_int(snapshot.get("revision"))?;
        let tabs_file = object(snapshot.get("tabsFile"))?;
        let tabs = cast_list(tabs_file.get("tabs"))?;
        self.tab = tabs
            .iter()
            .filter_map(|t| match t {
                Dv::Map(t) if t.get("id").is_str(&self.chat.id) => Some(t.clone()),
                _ => None,
            })
            .next()
            .unwrap_or_default();
        self.closed = closed_tab(&self.tab);
        let runtimes = object(snapshot.get("runtimeByChatId"))?;
        self.runtime = match runtimes.get(&self.chat.id) {
            Dv::Map(runtime) => runtime.clone(),
            _ => DvMap::new(),
        };
        self.scope.hydrate(snapshot)?;
        self.transcript_revision = num_to_int(page.get("transcriptRevision"))?;
        self.before = optional_int(page.get("before"))?;
        self.total_messages = optional_int(page.get("totalMessages"))?.unwrap_or(0);
        let rows = cast_list(page.get("messages"))?;
        self.messages.clear();
        for row in rows {
            self.messages.push(Message::new(object(row)?.clone(), uids));
        }
        Ok(())
    }

    /// `apply(event)`, one `chat:state-changed` payload.
    pub fn apply(&mut self, event: &DvMap, uids: &mut Uids) -> Result<Applied, Thrown> {
        if !self.chat.matches_scope(event) {
            return Ok(Applied::Done);
        }
        let (Dv::Int(next), Dv::Int(base)) = (event.get("revision"), event.get("baseRevision"))
        else {
            return Ok(Applied::Resync);
        };
        let (next, base) = (*next, *base);
        if next <= self.revision {
            return Ok(Applied::Done);
        }
        if base != self.revision {
            return Ok(Applied::Resync);
        }
        let changes = cast_list(event.get("changes"))?
            .into_iter()
            .map(|c| object(c).cloned())
            .collect::<Result<Vec<_>, _>>()?;
        let id = self.chat.id.clone();
        let descriptor = changes
            .iter()
            .rfind(|c| c.get("type").is_str("transcript.updated") && c.get("chatId").is_str(&id));
        let next_transcript = match descriptor.map(|d| d.get("transcript")) {
            Some(Dv::Map(t)) => match t.get("transcriptRevision") {
                Dv::Null => None,
                v => Some(cast_int(v)?),
            },
            _ => None,
        };
        let apply_bodies = next_transcript.is_none_or(|n| n > self.transcript_revision);
        if changes.iter().any(|c| {
            c.get("chatId").is_str(&id)
                && (c.get("type").is_str("messages.omitted")
                    || (apply_bodies
                        && c.get("type").is_str("transcript.updated")
                        && c.get("reset").is_true()))
        }) {
            return Ok(Applied::Resync);
        }
        for change in &changes {
            let kind = change.get("type");
            if kind.is_str("tab.removed") && change.get("tabId").is_str(&id) {
                self.closed = true;
            }
            if kind.is_str("tab.upserted")
                && let Dv::Map(tab) = change.get("tab")
                && tab.get("id").is_str(&id)
            {
                self.tab = tab.clone();
            }
            if kind.is_str("tab.metadata_patched") && change.get("tabId").is_str(&id) {
                self.tab = spread(&self.tab, object(change.get("patch"))?);
            }
            self.scope.apply(change)?;
            self.tab = self.scope.tab(&id).cloned().unwrap_or_default();
            if !change.get("chatId").is_str(&id) {
                continue;
            }
            if kind.is_str("runtime.patched") {
                self.runtime = object(change.get("runtime"))?.clone();
            }
            if !apply_bodies {
                continue;
            }
            match kind.as_str() {
                Some("message.upserted") => {
                    let message = Message::new(object(change.get("message"))?.clone(), uids);
                    let mut index = None;
                    for (i, m) in self.messages.iter().enumerate() {
                        if m.id()? == message.id()? {
                            index = Some(i);
                            break;
                        }
                    }
                    if let Some(i) = index {
                        self.messages[i] = message;
                    } else {
                        let anchor = change.get("afterMessageId");
                        let mut after = None;
                        for (i, m) in self.messages.iter().enumerate() {
                            if anchor.is_str(m.id()?) {
                                after = Some(i);
                                break;
                            }
                        }
                        if !anchor.is_null() && after.is_none() {
                            return Ok(Applied::Resync);
                        }
                        let at = after.map_or(self.messages.len(), |a| a + 1);
                        self.messages.insert(at, message);
                        self.total_messages += 1;
                    }
                }
                Some("message.removed") => {
                    let target = change.get("messageId");
                    let mut kept = Vec::with_capacity(self.messages.len());
                    for m in self.messages.drain(..) {
                        if !target.is_str(m.id()?) {
                            kept.push(m);
                        }
                    }
                    self.messages = kept;
                }
                Some("messages.replaced") => {
                    self.messages.clear();
                    for m in cast_list(change.get("messages"))? {
                        self.messages.push(Message::new(object(m)?.clone(), uids));
                    }
                }
                _ => {}
            }
        }
        if let Some(n) = next_transcript
            && n > self.transcript_revision
        {
            self.transcript_revision = n;
        }
        self.closed = closed_tab(&self.tab);
        self.revision = next;
        Ok(Applied::Done)
    }

    /// `DeviceChatCache.hydrate`: a fresh tail at the same transcript
    /// revision keeps the older pages already loaded; a new revision
    /// replaces the transcript.
    pub fn retain_older(&mut self, previous: &ChatState) -> Result<(), Thrown> {
        if previous.transcript_revision != self.transcript_revision {
            return Ok(());
        }
        let Some(first) = self.messages.first() else {
            return Ok(());
        };
        let mut boundary = None;
        for (i, m) in previous.messages.iter().enumerate() {
            if m.id()? == first.id()? {
                boundary = Some(i);
                break;
            }
        }
        if let Some(boundary) = boundary.filter(|b| *b > 0) {
            let older = previous.messages[..boundary].to_vec();
            self.messages.splice(0..0, older);
            self.before = previous.before;
        }
        Ok(())
    }

    /// `loadOlder`'s page, after its revision check: older messages not
    /// already held go first.
    pub fn prepend_page(&mut self, page: &DvMap, uids: &mut Uids) -> Result<(), Thrown> {
        let mut existing = Vec::with_capacity(self.messages.len());
        for m in &self.messages {
            existing.push(m.id()?.to_owned());
        }
        let mut older = Vec::new();
        for row in cast_list(page.get("messages"))? {
            let message = Message::new(object(row)?.clone(), uids);
            let id = message.id()?;
            if !existing.iter().any(|e| e == id) {
                older.push(message);
            }
        }
        self.messages.splice(0..0, older);
        self.before = optional_int(page.get("before"))?;
        Ok(())
    }

    /// `loadOlder`'s revision check, before [`ChatState::prepend_page`]:
    /// the page asked at `revision` applies only while this state still
    /// holds that transcript revision and the page is from it
    /// (`page['transcriptRevision'] != revision` refuses it).
    pub fn accepts_older(&self, page: &DvMap, revision: i64) -> bool {
        self.transcript_revision == revision
            && page
                .get("transcriptRevision")
                .loosely_equals(&Dv::Int(revision))
    }

    /// The tabs a chat screen lists: not files, not archived.
    pub fn open_tabs(&self) -> impl Iterator<Item = &DvMap> {
        self.scope
            .tabs
            .iter()
            .filter(|t| !t.get("kind").is_str("file") && t.get("archivedAt").is_null())
    }
}

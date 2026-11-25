//! One computer's chat read path (architecture §3.4, P5a). Ported from
//! `device_link/chats/dart_reader.dart` (the read half of the former
//! `DeviceChatsRepository`), `cache.dart` with `cache/observable_lru.dart`,
//! `read_receipts.dart` and `navigation.dart`; comments cite the Dart rule
//! they keep.
//!
//! One actor task owns the selection, the LRU of chat states, the hydrate
//! buffer, revision recovery, older pages and read receipts. Intents,
//! `chat:state-changed` pushes from the fan-out, timer fires and the
//! results of the reads it spawns apply in order on one inbox; every
//! applied message publishes one [`Published`] snapshot, from which each
//! subscriber's pump (`api::chats`) diffs its frames. The feed is
//! projected here (`cc-domain::feed`) from the selected chat, the open
//! turns and the footer turns the host names.
//!
//! Since P5b the actor also owns the writes (`sends`): sends with the
//! pending and confirmed attempt, chat and tab creation, stop, attachment
//! imports and the computer's chat drafts (`drafts`). The Dart repository
//! keeps the catalog; it drives `set_connected` and the selection
//! generations, so its own checks keep their order.
mod composer;
mod connection;
mod drafts;
mod sends;
mod tabs;
mod turns;

use crate::{
    account::{Flusher, Inbox, Scope, View, Writes},
    bridge::{APP_ADVISOR, Inner, MAIN, shutdown_failure},
    copy::chats::{self as copy, CopyKey},
    error::{Error, Result},
    failures,
    interest::{Holder, INTEREST, SCOPES},
    ports::DraftsRecord,
    push::{self, Delivery, Filter},
};
use cc_domain::{
    chat::{self, Applied, ChatRef, ChatState, Message, Thrown, Uids, object, send::PendingSend},
    dart::{Dv, DvMap},
    feed::{self, FeedText, Presented, Row, ToolResult},
};
use cc_protocol::dto;
pub(crate) use composer::{
    CommandRow, ComposerIntent, PickFailure, PickIntent, Shown as ComposerShown, SourceRead,
    SourceScope,
};
pub(crate) use drafts::Shown as DraftsShown;
pub(crate) use sends::{SendGate, SendIntent};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    runtime::Handle as Runtime,
    sync::{mpsc, oneshot, watch},
};

const STATE_CHANGED: &str = "chat:state-changed";
const INVENTORY_CHANGED: &str = "invocable-inventory:changed";
const OBSERVED: [&str; 2] = [STATE_CHANGED, INVENTORY_CHANGED];
/// `_scheduleRecovery`'s delay.
const RECOVERY: Duration = Duration::from_millis(150);
/// Events buffered while a snapshot is read; past it, recover.
const BUFFER: usize = 128;
/// `DeviceChatCache` bounds.
const MAX_ENTRIES: usize = 20;
const MAX_WEIGHT: usize = 8 * 1024 * 1024;
/// Read-receipt retries (1, 2, 4 s).
const RECEIPT_RETRIES: u32 = 3;

/// What the host asks of the read path.
pub(crate) enum Intent {
    SetConnected {
        connected: bool,
        generation: u64,
    },
    Open {
        chat: ChatRef,
        generation: u64,
    },
    OpenCurrent {
        chat: ChatRef,
        expected: u64,
    },
    LoadOlder,
    Leave {
        expected: Option<u64>,
        generation: u64,
    },
    ToggleTurn(String),
    SetFooterTurns(Vec<String>),
    SetReadReceipts(bool),
    InvalidateReadReceipts,
    RetryReadReceipts,
    CloseTab(String),
    Refresh {
        chat: ChatRef,
        generation: u64,
    },
    RestoreConnection {
        catalog_loaded: bool,
    },
    BindActivity(crate::activity::Handle),
    BindPipelines(crate::pipelines::Handle),
    TrackTurns(bool),
    Close,
    // Writes (P5b).
    /// Stores the drafts now instead of after the debounce.
    FlushDrafts,
    Send(SendIntent),
    Stop(ChatRef),
    CreateChat {
        expected: Option<u64>,
        workspace: String,
        title: Option<String>,
    },
    CreateTab {
        expected: Option<u64>,
        project_id: String,
        worktree_id: String,
    },
    SetWorkspaces(Vec<String>),
    SetDraft {
        chat: ChatRef,
        text: String,
        seq: u64,
    },
    ClearSentDraft {
        chat: ChatRef,
        text: String,
    },
    ImportAttachment {
        scope: ChatRef,
        filename: String,
        bytes: Vec<u8>,
    },
    DeleteAttachment {
        scope: ChatRef,
        filename: String,
    },
    // The composer (P5c).
    Composer(ComposerIntent),
}

/// What the Dart caller rethrows a failure as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailKind {
    /// A `DeviceLinkException` with the message.
    Link,
    /// A `DesktopIpcRefusal`: the desktop answered with a refusal.
    Refused,
    /// A `DesktopIpcNotSent`: nothing reached the desktop.
    NotSent,
    /// A `DeviceChatCreationNotSent`: no task mutation was sent.
    CreationNotSent,
    /// Another error; the caller words it.
    Other,
}

/// A failure the Dart caller rethrows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(crate) message: String,
    pub(crate) kind: FailKind,
    /// A refusal's desktop code.
    pub(crate) code: Option<String>,
}

impl Failure {
    pub(crate) fn link(key: CopyKey) -> Self {
        Self::link_text(copy::text(key))
    }
    /// A `DeviceLinkException` with `message`.
    pub(crate) fn link_text(message: &str) -> Self {
        Self {
            message: message.into(),
            kind: FailKind::Link,
            code: None,
        }
    }
}

/// What the Dart transport throws for a raw call's `error`.
pub(crate) fn transport_failure(error: &Error) -> Failure {
    sends::transport(error)
}

/// What a settled intent produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// The requested selection survived its reads.
    Opened { selected: bool, generation: u64 },
    /// A send was made: the computer accepted it, or it may have.
    Sent { accepted: bool },
    /// A chat or tab was created; the host opens it.
    Created(ChatRef),
    /// A file was stored on the computer.
    Stored {
        filename: String,
        path: String,
        size: i64,
    },
    /// A settings pick was saved for the shown chat (`applied`) or not.
    Changed { applied: bool },
    /// A settings command or decision was applied at `revision`.
    Saved { revision: i64 },
    /// A fork was created; the host opens it.
    Forked(ChatRef),
    /// The invocable rows and whether a later load can change them.
    Inventory {
        commands: Vec<CommandRow>,
        unsettled: bool,
    },
    /// The plugin picker's catalog, in bridge-form JSON.
    Catalog(String),
    /// The chat's plugin selections, in bridge-form JSON.
    Selections(Option<String>),
}

/// How an intent ended, and the snapshot revision that shows it.
#[derive(Debug, Clone)]
pub(crate) struct Settled {
    pub(crate) revision: u64,
    pub(crate) failure: Option<Failure>,
    pub(crate) outcome: Option<Outcome>,
}

pub(crate) type Waiter = oneshot::Sender<Settled>;
type Done = Vec<(Waiter, Option<Failure>, Option<Outcome>)>;

/// Why an open failed.
enum OpenError {
    Rpc(Error),
    Thrown(Thrown),
}

/// `_describe` of the read path.
fn describe(error: &OpenError) -> Failure {
    match error {
        OpenError::Rpc(e) => match failures::read_failure(e) {
            Some(message) => Failure {
                message,
                kind: FailKind::Link,
                code: None,
            },
            None => Failure {
                message: copy::text(CopyKey::ReadFailed).into(),
                kind: FailKind::Other,
                code: None,
            },
        },
        OpenError::Thrown(Thrown::Invalid) => Failure {
            message: copy::text(CopyKey::InvalidMessage).into(),
            kind: FailKind::Link,
            code: None,
        },
        OpenError::Thrown(Thrown::Cast) => Failure {
            message: copy::text(CopyKey::ReadFailed).into(),
            kind: FailKind::Other,
            code: None,
        },
    }
}

/// Why a tab command failed (`DeviceChatSettings.command`).
pub(crate) enum CommandError {
    Rpc(Error),
    Invalid,
    /// `DeviceChatSettingsRejected`.
    Rejected(String),
    /// A `FormatException`: no outcome or revision.
    Format,
}

impl CommandError {
    /// The message a `DeviceLinkException` carried (the work drawer's
    /// queued-message actions); `None` for any other failure.
    pub(crate) fn link_message(&self) -> Option<String> {
        match self {
            CommandError::Rpc(e) => crate::failures::read_failure(e),
            CommandError::Invalid => Some(copy::text(CopyKey::InvalidMessage).into()),
            CommandError::Rejected(reason) => Some(reason.clone()),
            CommandError::Format => None,
        }
    }
    fn failure(&self) -> Failure {
        match self {
            CommandError::Rpc(e) => describe(&OpenError::Rpc(e.clone())),
            CommandError::Invalid => describe(&OpenError::Thrown(Thrown::Invalid)),
            CommandError::Rejected(reason) => Failure {
                message: reason.clone(),
                kind: FailKind::Link,
                code: None,
            },
            CommandError::Format => Failure {
                message: copy::text(CopyKey::ReadFailed).into(),
                kind: FailKind::Other,
                code: None,
            },
        }
    }
}

enum Msg {
    Intent(Intent, Option<Waiter>),
    Push(push::Push),
    Lagged,
    Opened {
        read: u64,
        chat: ChatRef,
        result: std::result::Result<Option<(Dv, Dv)>, OpenError>,
        waiter: Option<Waiter>,
    },
    ConnectionRestored {
        connection: u64,
        failure: Option<Failure>,
        waiter: Option<Waiter>,
    },
    Recover(u64),
    Older {
        read: u64,
        revision: i64,
        result: Result<Value>,
        waiter: Option<Waiter>,
    },
    Done {
        waiter: Option<Waiter>,
        failure: Option<Failure>,
        outcome: Option<Outcome>,
    },
    Marked {
        generation: u64,
        key: String,
        revision: i64,
        result: std::result::Result<(), CommandError>,
    },
    ReceiptRetry(u64),
    Sent {
        attempt: PendingSend,
        result: Result<Value>,
        waiter: Option<Waiter>,
    },
    Cancelled {
        epoch: u64,
        result: Result<Value>,
        waiter: Option<Waiter>,
    },
    Archived {
        chat: ChatRef,
        generation: u64,
        waiter: Option<Waiter>,
        failure: Option<Failure>,
    },
    Created {
        generation: u64,
        select: bool,
        result: std::result::Result<sends::Creation, Failure>,
        waiter: Option<Waiter>,
    },
    DraftsFlush(u64),
    DraftsWritten(bool),
    Composer(composer::Event),
}

impl Msg {
    /// Draft edits and failed draft writes still apply when queued as the
    /// account is left, so the close stores them in its record.
    fn saves_drafts(&self) -> bool {
        matches!(
            self,
            Self::Intent(Intent::SetDraft { .. } | Intent::ClearSentDraft { .. }, _)
                | Self::DraftsWritten(_)
        )
    }
}

/// The selected chat's feed as projected.
#[derive(Debug, Default)]
pub(crate) struct FeedSnapshot {
    /// Presented messages, oldest first.
    pub(crate) order: Vec<Arc<Presented>>,
    /// Rows with their feed keys; `keyed` is false for a row Dart drew
    /// without a key (a synthetic key stands in).
    pub(crate) rows: Vec<FeedEntry>,
    pub(crate) feedback_turns: Vec<(String, String)>,
    latest_timer: Option<turns::LatestTimer>,
    /// Each turn's tool results by its first row's uid, with their
    /// revision.
    pub(crate) results: HashMap<u64, (u64, Arc<Vec<ToolResult>>)>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FeedEntry {
    pub(crate) key: String,
    pub(crate) keyed: bool,
    pub(crate) row: Row,
    /// The revision of the results the row shows.
    pub(crate) results_rev: Option<u64>,
}

/// A chat tab as the chat screen lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TabRow {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) unread: bool,
    pub(crate) running: bool,
    pub(crate) needs_input: bool,
}

/// The selection in a [`Published`] snapshot.
#[derive(Debug)]
pub(crate) struct Selected {
    pub(crate) chat: ChatRef,
    pub(crate) state: ChatState,
    pub(crate) title: String,
    pub(crate) running: bool,
    pub(crate) awaiting_input: bool,
    pub(crate) has_pending_decision: bool,
    pub(crate) runtime_error: Option<String>,
    pub(crate) tabs: Vec<TabRow>,
    pub(crate) feed: Arc<FeedSnapshot>,
}

/// Everything the read path shows, once per applied message.
#[derive(Debug)]
pub(crate) struct Published {
    pub(crate) revision: u64,
    pub(crate) generation: u64,
    pub(crate) connected: bool,
    pub(crate) activity_connected: bool,
    pub(crate) loading: bool,
    pub(crate) loading_older: bool,
    pub(crate) hydrating: bool,
    pub(crate) ready: bool,
    pub(crate) error: Option<String>,
    /// Bumped by every write of `error`, a clear included.
    pub(crate) error_revision: u64,
    pub(crate) selected: Option<Selected>,
    // Writes (P5b).
    pub(crate) sending: bool,
    pub(crate) pending: Option<PendingSend>,
    pub(crate) confirmed: Option<PendingSend>,
    pub(crate) successful_turns: Vec<String>,
    pub(crate) drafts: Arc<DraftsShown>,
    pub(crate) drafts_rev: u64,
    /// The host's last applied draft write.
    pub(crate) draft_seq: u64,
    // The composer (P5c).
    pub(crate) composer: ComposerShown,
}

/// The session and surface a service talks to: a computer's main surface
/// (its chats, overview, Home and the rest), or its Orchestrator chat on
/// `app-advisor` (P9). Requests reach only a session of `scope`, the
/// account scope the service was started in ([`Inner::request`]).
#[derive(Debug, Clone)]
pub(crate) struct Peer {
    pub(crate) computer: String,
    pub(crate) surface: &'static str,
    pub(crate) scope: Scope,
}

impl Peer {
    pub(crate) fn main(computer: String, scope: Scope) -> Self {
        Self {
            computer,
            surface: MAIN,
            scope,
        }
    }
    pub(crate) fn orchestrator(computer: String, scope: Scope) -> Self {
        Self {
            computer,
            surface: APP_ADVISOR,
            scope,
        }
    }
    /// The same computer and scope on `surface`.
    pub(crate) fn on(&self, surface: &'static str) -> Self {
        Self {
            surface,
            ..self.clone()
        }
    }
    /// The drafts record of this surface's chats.
    fn drafts(&self) -> DraftsRecord {
        if self.surface == APP_ADVISOR {
            DraftsRecord::Orchestrator
        } else {
            DraftsRecord::Chat
        }
    }
    /// `repository.dart` `_surfaceEvents`: a push for another surface is
    /// hidden; one without a surface reaches both.
    pub(crate) fn sees(&self, message: &Dv) -> bool {
        let Dv::Map(message) = message else {
            return true;
        };
        let Dv::Map(payload) = message.get("payload") else {
            return true;
        };
        let surface = payload.get("surface");
        surface.is_null() || surface.is_str(self.surface)
    }
}

/// The service's handle: its inbox and published snapshot.
#[derive(Clone)]
pub(crate) struct Handle {
    inbox: mpsc::UnboundedSender<Msg>,
    view: View<Published>,
    peer: Peer,
}

impl Handle {
    /// Starts the read path of `computer` on `surface` in the current
    /// account scope.
    pub(crate) fn start(
        inner: &Arc<Inner>,
        runtime: &Runtime,
        computer: String,
        surface: &'static str,
    ) -> Self {
        let (scope, writes) = inner.writing_scope();
        let peer = Peer {
            computer,
            surface,
            scope: scope.clone(),
        };
        let (inbox, rx) = mpsc::unbounded_channel();
        let computer = peer.computer.clone();
        // A service closing on the same record stores it before this one
        // reads it.
        let records = format!("chats/{computer}/{}", peer.surface);
        let earlier = inner.flushed(Some(&records));
        inner.flushes(Flusher::new(records, &inbox, |tx| {
            Msg::Intent(Intent::FlushDrafts, Some(tx))
        }));
        let mut actor = Actor::new(Arc::downgrade(inner), inbox.clone(), peer.clone());
        actor.writes = Some(writes);
        let (publish, view) = watch::channel(Arc::new(actor.published()));
        let pushes = inbox.clone();
        actor.pushes = Some(inner.pushes.subscribe(
            Filter {
                computer: Some(computer),
                channels: &OBSERVED,
                unreadable: false,
                sessions: false,
            },
            Box::new(move |delivery| {
                pushes
                    .send(match delivery {
                        Delivery::Push(push) => Msg::Push(push),
                        Delivery::Lagged { .. } | Delivery::Opened => Msg::Lagged,
                    })
                    .is_ok()
            }),
        ));
        let settled = inner.settled(&scope);
        runtime.spawn(actor.run(
            Inbox::new(rx, scope.clone()).keeping(Msg::saves_drafts),
            publish,
            scope.clone(),
            async move {
                settled.await;
                earlier.await;
            },
        ));
        Self {
            inbox,
            view: View::new(view, scope),
            peer,
        }
    }
    pub(crate) fn view(&self) -> View<Published> {
        self.view.clone()
    }
    pub(crate) fn scope(&self) -> &Scope {
        self.view.scope()
    }
    /// The computer and surface this read path talks to, in its scope.
    pub(crate) fn peer(&self) -> &Peer {
        &self.peer
    }
    /// Queues `intent` in call order; `waiter` gets its outcome.
    pub(crate) fn send(&self, intent: Intent, waiter: Option<Waiter>) -> Result<()> {
        self.scope().check()?;
        self.inbox
            .send(Msg::Intent(intent, waiter))
            .map_err(|_| shutdown_failure())
    }
}

/// What the spawned reads check between their awaits.
#[derive(Default)]
struct Shared {
    reads: AtomicU64,
    connected: AtomicBool,
}

/// Read receipts (`DeviceChatReadReceipts`).
#[derive(Default)]
struct Receipts {
    enabled: bool,
    /// Set by an invalidation: nothing is marked until the host opens or
    /// leaves a chat, reconnects, enables receipts again or retries. Dart's
    /// next `observe` after `invalidate` comes through the host's readiness
    /// gate, so it never marks the chat being left; here the invalidation
    /// and the open that follows are separate intents.
    held: bool,
    /// Per chat key, the newest revision a mark-read was sent for, kept
    /// across invalidations while it is in flight (`pending`) and, once
    /// the desktop applied it, until the chat shows a newer revision. No
    /// read goes out at or below it: the desktop does not check a mark's
    /// revision, so a duplicate landing after a newer reply would clear
    /// that reply's unread marker.
    marks: HashMap<String, Mark>,
    latest: Option<(String, ChatRef, i64)>,
    attempted: Option<(String, i64)>,
    busy: bool,
    failed: bool,
    generation: u64,
    retries: u32,
    retry: Option<u64>,
    timers: u64,
}

/// A mark-read sent for `revision`.
struct Mark {
    revision: i64,
    pending: bool,
}

impl Receipts {
    /// The mark-read for `revision` settled, whichever generation sent it.
    fn settle(&mut self, key: &str, revision: i64, applied: bool) {
        let Some(mark) = self.marks.get_mut(key) else {
            return;
        };
        if mark.revision != revision {
            return;
        }
        if applied {
            mark.pending = false;
        } else {
            self.marks.remove(key);
        }
    }

    /// Whether a mark-read sent before covers `revision`.
    fn covered(&self, key: &str, revision: i64) -> bool {
        self.marks.get(key).is_some_and(|m| revision <= m.revision)
    }

    /// Forgets applied marks the chat `key` has since moved past, and
    /// beyond the cache's bound, applied marks of the other chats.
    fn prune(&mut self, selected: Option<(&str, i64)>) {
        if let Some((key, revision)) = selected
            && self
                .marks
                .get(key)
                .is_some_and(|m| !m.pending && m.revision < revision)
        {
            self.marks.remove(key);
        }
        if self.marks.len() > MAX_ENTRIES {
            self.marks
                .retain(|k, m| m.pending || selected.is_some_and(|(key, _)| key == k));
        }
    }
}

/// The chat states (`DeviceChatCache` over `ObservableLru`): least
/// recently used first; the selection stays resident.
#[derive(Default)]
struct Cache {
    entries: Vec<(String, ChatState, usize)>,
}

/// `payloadWeight`, without Dart's identity sharing.
fn weigh(value: &Dv) -> usize {
    match value {
        Dv::Null => 8,
        Dv::Str(s) => 32 + s.encode_utf16().count() * 2,
        Dv::Bytes(b) => 32 + b.len(),
        Dv::Map(m) => weigh_map(m),
        Dv::List(items) => 32 + items.iter().map(|v| 8 + weigh(v)).sum::<usize>(),
        _ => 16,
    }
}

fn weigh_map(map: &DvMap) -> usize {
    64 + map
        .iter()
        .map(|(k, v)| 32 + 32 + k.encode_utf16().count() * 2 + weigh(v))
        .sum::<usize>()
}

fn weigh_state(state: &ChatState) -> usize {
    let scope = &state.scope;
    let list = |maps: &[DvMap]| 32 + maps.iter().map(|m| 8 + weigh_map(m)).sum::<usize>();
    32 + 8
        + 32
        + state.chat.key().len() * 2
        + 8
        + weigh_map(&state.tab)
        + 8
        + weigh_map(&state.runtime)
        + 8
        + list(&scope.tabs)
        + 8
        + weigh_map(&scope.runtime)
        + 8
        + list(&scope.questions)
        + 8
        + list(&scope.approvals)
        + state
            .messages
            .iter()
            .map(|m| 8 + weigh_map(&m.raw))
            .sum::<usize>()
}

impl Cache {
    fn position(&self, key: &str) -> Option<usize> {
        self.entries.iter().position(|(k, _, _)| k == key)
    }
    fn peek(&self, key: &str) -> Option<&ChatState> {
        self.position(key).map(|i| &self.entries[i].1)
    }
    fn get_mut(&mut self, key: &str) -> Option<&mut ChatState> {
        let i = self.position(key)?;
        Some(&mut self.entries[i].1)
    }
    /// `read`: marks `key` most recently used.
    fn read(&mut self, key: &str) -> bool {
        match self.position(key) {
            Some(i) => {
                let entry = self.entries.remove(i);
                self.entries.push(entry);
                true
            }
            None => false,
        }
    }
    fn keys(&self) -> Vec<String> {
        self.entries.iter().map(|(k, _, _)| k.clone()).collect()
    }
    /// `put`: stores (or re-weighs) `key` as most recently used, then
    /// evicts least recently used entries except `retained`.
    fn put(&mut self, key: &str, state: Option<ChatState>, retained: Option<&str>) {
        let state = match (state, self.position(key)) {
            (Some(state), Some(i)) => {
                self.entries.remove(i);
                state
            }
            (Some(state), None) => state,
            (None, Some(i)) => self.entries.remove(i).1,
            (None, None) => return,
        };
        let weight = weigh_state(&state);
        self.entries.push((key.to_owned(), state, weight));
        self.trim(retained);
    }
    fn trim(&mut self, retained: Option<&str>) {
        let mut i = 0;
        while i < self.entries.len() {
            let total: usize = self.entries.iter().map(|(_, _, w)| w).sum();
            if self.entries.len() <= MAX_ENTRIES && total <= MAX_WEIGHT {
                break;
            }
            if Some(self.entries[i].0.as_str()) == retained {
                i += 1;
                continue;
            }
            self.entries.remove(i);
        }
    }
}

/// The feed projection's inputs, to skip an unchanged projection.
#[derive(PartialEq, Default)]
struct FeedInputs {
    key: String,
    uids: Vec<u64>,
    running: bool,
    expanded: Vec<String>,
    footers: Vec<String>,
    end_reasons: BTreeMap<String, String>,
}

struct Actor {
    inner: Weak<Inner>,
    inbox: mpsc::UnboundedSender<Msg>,
    peer: Peer,
    text: FeedText,
    pushes: Option<push::Subscription>,
    shared: Arc<Shared>,
    uids: Uids,
    revision: u64,
    disposed: bool,
    // `DeviceChatReader`.
    connected: bool,
    completions: turns::Completions,
    closing_tab: Option<(u64, String)>,
    refresh_after_open: bool,
    deferred_composer_read: Option<u64>,
    restoration: connection::Restoration,
    synchronized: bool,
    loading: bool,
    loading_older: bool,
    hydrating: bool,
    overflow: bool,
    /// The host's selection generation, published; only host intents
    /// advance it.
    generation: u64,
    /// Tracks selection changes made inside the actor as well as host intents.
    selection_epoch: u64,
    /// Bumped whenever the reads in flight go stale, the internal
    /// re-reads included.
    reads: u64,
    error: Option<String>,
    error_revision: u64,
    selected: Option<String>,
    cache: Cache,
    buffer: Vec<DvMap>,
    recovery: Option<u64>,
    timers: u64,
    receipts: Receipts,
    // The feed.
    expanded: HashSet<String>,
    footers: HashSet<String>,
    inputs: FeedInputs,
    feed: Arc<FeedSnapshot>,
    presented: HashMap<u64, Option<Arc<Presented>>>,
    results: HashMap<u64, (u64, Arc<Vec<ToolResult>>)>,
    results_revs: u64,
    // Writes (P5b).
    sending: bool,
    pending: Option<PendingSend>,
    confirmed: Option<PendingSend>,
    workspaces: Vec<String>,
    drafts: drafts::Drafts,
    /// Holds the account's sign-out until the drafts are stored.
    writes: Option<Writes>,
    // The composer (P5c).
    composer: composer::Composer,
}

impl Actor {
    fn new(inner: Weak<Inner>, inbox: mpsc::UnboundedSender<Msg>, peer: Peer) -> Self {
        Self {
            inner,
            inbox,
            peer,
            text: copy::feed_text(),
            pushes: None,
            shared: Arc::default(),
            uids: Uids::default(),
            revision: 0,
            disposed: false,
            connected: false,
            completions: turns::Completions::default(),
            closing_tab: None,
            refresh_after_open: false,
            deferred_composer_read: None,
            restoration: connection::Restoration::default(),
            synchronized: false,
            loading: false,
            loading_older: false,
            hydrating: false,
            overflow: false,
            generation: 0,
            selection_epoch: 0,
            reads: 0,
            error: None,
            error_revision: 0,
            selected: None,
            cache: Cache::default(),
            buffer: Vec::new(),
            recovery: None,
            timers: 0,
            receipts: Receipts::default(),
            expanded: HashSet::new(),
            footers: HashSet::new(),
            inputs: FeedInputs::default(),
            feed: Arc::default(),
            presented: HashMap::new(),
            results: HashMap::new(),
            results_revs: 0,
            sending: false,
            pending: None,
            confirmed: None,
            workspaces: Vec::new(),
            drafts: drafts::Drafts::default(),
            writes: None,
            composer: composer::Composer::default(),
        }
    }

    async fn run(
        mut self,
        mut rx: Inbox<Msg>,
        publish: watch::Sender<Arc<Published>>,
        scope: Scope,
        settled: impl Future<Output = ()>,
    ) {
        // What the scopes before this one, and the services closing on the
        // same record, still wrote is stored first.
        settled.await;
        self.load_drafts(&scope).await;
        self.revision += 1;
        publish.send_replace(Arc::new(self.published()));
        while let Some(msg) = rx.recv(|| Msg::Intent(Intent::Close, None)).await {
            let mut done = Vec::new();
            self.apply(msg, &mut done);
            self.observe_sends();
            self.observe_composer();
            self.observe_receipts();
            self.revision += 1;
            publish.send_replace(Arc::new(self.published()));
            for (waiter, failure, outcome) in done {
                let _ = waiter.send(Settled {
                    revision: self.revision,
                    failure,
                    outcome,
                });
            }
            if self.disposed {
                break;
            }
        }
        self.pushes = None;
        if !rx.live() {
            // The account was left: nothing it read stays published.
            let mut left = Actor::new(self.inner.clone(), self.inbox.clone(), self.peer.clone());
            publish.send_replace(Arc::new(left.published()));
        }
    }

    /// The computer's stored drafts, before any intent applies. They and
    /// every later write belong to `scope`'s account, also when auth took
    /// another account meanwhile; none are read while auth reports another
    /// account and the scope lasts.
    async fn load_drafts(&mut self, scope: &Scope) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let Some(account) = inner.records_account(scope).await else {
            return;
        };
        let store = inner.store.clone();
        let (who, computer, record) = (
            account.clone(),
            self.peer.computer.clone(),
            self.peer.drafts(),
        );
        let record =
            tokio::task::spawn_blocking(move || store.chat_drafts(&who, &computer, record))
                .await
                .ok()
                .and_then(std::result::Result::ok)
                .flatten();
        self.drafts = drafts::Drafts::load(Some(account), record.as_ref(), drafts::now_ms());
    }

    fn ready(&self) -> bool {
        self.connected
            && self.synchronized
            && !self.loading
            && !self
                .closing_tab_key()
                .is_some_and(|key| self.selected.as_deref() == Some(key))
    }

    fn closing_tab_key(&self) -> Option<&str> {
        self.closing_tab.as_ref().map(|(_, key)| key.as_str())
    }
    fn state(&self) -> Option<&ChatState> {
        self.cache.peek(self.selected.as_deref()?)
    }
    fn set_error(&mut self, error: Option<String>) {
        self.error = error;
        self.error_revision += 1;
    }
    /// Bumps the selection generation; `given` is the host's own count.
    fn bump(&mut self, given: u64) {
        self.generation = (self.generation + 1).max(given);
        self.selection_epoch += 1;
        self.retire_reads();
    }
    /// Makes the reads in flight stale without moving the host's
    /// generation.
    fn retire_reads(&mut self) {
        self.refresh_after_open = false;
        self.reads += 1;
        self.shared.reads.store(self.reads, Ordering::SeqCst);
    }
    fn put_selected(&mut self) {
        if let Some(key) = self.selected.clone() {
            self.cache.put(&key, None, Some(&key));
        }
    }

    /// Runs `work` on the runtime and posts its message.
    fn spawn<F>(&self, work: impl FnOnce(Arc<Inner>, Peer) -> F + Send + 'static)
    where
        F: std::future::Future<Output = Msg> + Send + 'static,
    {
        let (Some(inner), inbox, peer) =
            (self.inner.upgrade(), self.inbox.clone(), self.peer.clone())
        else {
            return;
        };
        tokio::spawn(async move {
            let msg = work(inner, peer).await;
            let _ = inbox.send(msg);
        });
    }

    fn apply(&mut self, msg: Msg, done: &mut Done) {
        match msg {
            Msg::Intent(intent, waiter) => self.intent(intent, waiter, done),
            Msg::Push(push) => self.push(&push.message),
            Msg::Lagged => {
                // Pushes were dropped: only a fresh snapshot repairs the
                // selection.
                if self.connected && self.selected.is_some() && !self.hydrating {
                    self.schedule_recovery();
                }
            }
            Msg::Opened {
                read,
                chat,
                result,
                waiter,
            } => {
                let selected =
                    !self.disposed && read == self.reads && matches!(&result, Ok(Some(_)));
                let failure = self.opened(read, chat, result);
                if failure.is_none() && selected && self.recovery.is_some() {
                    self.deferred_composer_read = Some(read);
                } else {
                    let refresh = match &failure {
                        Some(failure) => composer::RefreshResult::Failed(failure),
                        None if selected && self.synchronized => composer::RefreshResult::Hydrated,
                        None => composer::RefreshResult::Incomplete,
                    };
                    self.composer_opened(read, refresh, done);
                }
                let restoring = self.restoration.read == Some(read);
                if restoring {
                    self.restoration.read = None;
                }
                let failed = failure.is_some();
                if restoring && failure.is_none() {
                    self.composer_intent(ComposerIntent::Restore, waiter, done);
                } else if let Some(waiter) = waiter {
                    let outcome = failure.is_none().then_some(Outcome::Opened {
                        selected,
                        generation: self.generation,
                    });
                    done.push((waiter, failure, outcome));
                }
                if read == self.reads
                    && std::mem::take(&mut self.refresh_after_open)
                    && self.connected
                    && !self.disposed
                    && self.recovery.is_none()
                {
                    if failed {
                        self.schedule_recovery();
                    } else if selected && self.synchronized {
                        self.refresh(None, done);
                    }
                }
            }
            Msg::ConnectionRestored {
                connection,
                failure,
                waiter,
            } => {
                self.finish_restoring(connection, failure, waiter, done);
            }
            Msg::Recover(token) => {
                if self.recovery != Some(token) {
                    return;
                }
                self.recovery = None;
                let chat = self.state().map(|s| s.chat.clone());
                if let Some(chat) = chat
                    && self.connected
                {
                    // `open(ref).catchError(...)`: a failure only shows.
                    self.open(chat, None, None, done);
                }
            }
            Msg::Older {
                read,
                revision,
                result,
                waiter,
            } => {
                self.older(read, revision, result);
                if let Some(waiter) = waiter {
                    done.push((waiter, None, None));
                }
            }
            Msg::Done {
                waiter,
                failure,
                outcome,
            } => {
                if let Some(waiter) = waiter {
                    done.push((waiter, failure, outcome));
                }
            }
            Msg::Marked {
                generation,
                key,
                revision,
                result,
            } => self.marked(generation, &key, revision, result),
            Msg::Sent {
                attempt,
                result,
                waiter,
            } => self.sent(attempt, result, waiter, done),
            Msg::Cancelled {
                epoch,
                result,
                waiter,
            } => self.cancelled(epoch, result, waiter, done),
            Msg::Archived {
                chat,
                generation,
                waiter,
                failure,
            } => {
                self.archived(chat, generation, waiter, failure, done);
            }
            Msg::Created {
                generation,
                select,
                result,
                waiter,
            } => {
                self.created(generation, select, result, waiter, done);
            }
            Msg::DraftsFlush(token) => {
                if self.drafts.timer == Some(token) {
                    self.write_drafts(false);
                }
            }
            Msg::Composer(event) => self.composer_event(event, done),
            Msg::DraftsWritten(written) => {
                // Kept in memory; retried with the next change.
                if !written {
                    self.drafts.dirty = true;
                }
            }
            Msg::ReceiptRetry(token) => {
                if self.receipts.retry == Some(token) {
                    self.receipts.retry = None;
                    self.receipts.attempted = None;
                    self.flush_receipts();
                }
            }
        }
        // A recovery open takes over matching continuations. Any still on
        // the completed read need to settle if recovery was superseded.
        if let Some(read) = self.deferred_composer_read
            && (read != self.reads || self.recovery.is_none())
        {
            self.deferred_composer_read = None;
            self.composer_opened(read, composer::RefreshResult::Incomplete, done);
        }
    }

    fn intent(&mut self, intent: Intent, waiter: Option<Waiter>, done: &mut Done) {
        let mut settle = |failure: Option<Failure>, waiter: Option<Waiter>| {
            if let Some(waiter) = waiter {
                done.push((waiter, failure, None));
            }
        };
        match intent {
            Intent::SetConnected {
                connected,
                generation,
            } => {
                if self.connected != connected {
                    self.composer_connection();
                    self.restoration.connection += 1;
                }
                self.receipts.held = false;
                if !connected {
                    // What the desktop applied shows in the next snapshot.
                    self.receipts.marks.retain(|_, m| m.pending);
                }
                self.connected = connected;
                self.shared.connected.store(connected, Ordering::SeqCst);
                if !connected {
                    self.restoration.read = None;
                    self.restoration.set_activity(false, None);
                    self.synchronized = false;
                    self.bump(generation);
                    self.hydrating = false;
                    self.loading = false;
                    self.loading_older = false;
                    self.recovery = None;
                    self.buffer.clear();
                }
                settle(None, waiter);
            }
            Intent::Open { chat, generation } => {
                self.receipts.held = false;
                self.open(chat, Some(generation), waiter, done);
            }
            Intent::OpenCurrent { chat, expected } => {
                if self.generation == expected {
                    self.select_chat(chat, waiter, done);
                } else {
                    settle(None, waiter);
                }
            }
            Intent::LoadOlder => self.load_older(waiter, done),
            Intent::Leave {
                expected,
                generation,
            } => {
                self.receipts.held = false;
                self.leave(expected, generation, waiter, done);
            }
            Intent::ToggleTurn(key) => {
                if !self.expanded.remove(&key) {
                    self.expanded.insert(key);
                }
                settle(None, waiter);
            }
            Intent::SetFooterTurns(keys) => {
                self.footers = keys.into_iter().collect();
                settle(None, waiter);
            }
            Intent::SetReadReceipts(enabled) => {
                if enabled && !self.receipts.enabled {
                    self.receipts.held = false;
                }
                self.receipts.enabled = enabled;
                settle(None, waiter);
            }
            Intent::InvalidateReadReceipts => {
                self.invalidate_receipts();
                settle(None, waiter);
            }
            Intent::RetryReadReceipts => {
                self.receipts.held = false;
                self.receipts.retry = None;
                self.receipts.retries = 0;
                self.receipts.attempted = None;
                self.flush_receipts();
                settle(None, waiter);
            }
            Intent::CloseTab(id) => self.close_tab(id, waiter, done),
            Intent::Refresh { chat, generation } => {
                if self.generation == generation
                    && self.selected.as_deref() == Some(chat.key().as_str())
                {
                    self.refresh(waiter, done);
                } else {
                    settle(None, waiter);
                }
            }
            Intent::RestoreConnection { catalog_loaded } => {
                self.restore_connection(catalog_loaded, waiter, done);
            }
            Intent::BindActivity(activity) => {
                self.restoration.activity = Some(activity);
                settle(None, waiter);
            }
            Intent::BindPipelines(pipelines) => {
                self.restoration.pipelines = Some(pipelines);
                settle(None, waiter);
            }
            Intent::TrackTurns(enabled) => {
                self.completions.tracking = enabled;
                self.completions.stop();
                settle(None, waiter);
            }

            Intent::Close => {
                self.disposed = true;
                self.retire_reads();
                self.recovery = None;
                self.invalidate_receipts();
                self.store_drafts();
                settle(None, waiter);
            }
            Intent::FlushDrafts => {
                self.store_drafts();
                settle(None, waiter);
            }
            Intent::Send(send) => self.send(send, waiter, done),
            Intent::Stop(chat) => self.stop(chat, waiter, done),
            Intent::CreateChat {
                expected,
                workspace,
                title,
            } => {
                if expected.is_none_or(|generation| generation == self.generation) {
                    self.create_chat(workspace, title, waiter, done);
                } else {
                    settle(None, waiter);
                }
            }
            Intent::CreateTab {
                expected,
                project_id,
                worktree_id,
            } => {
                if expected.is_none_or(|generation| generation == self.generation) {
                    self.create_tab(project_id, worktree_id, false, waiter, done);
                } else {
                    settle(None, waiter);
                }
            }
            Intent::SetWorkspaces(ids) => {
                self.workspaces = ids;
                settle(None, waiter);
            }
            Intent::SetDraft { chat, text, seq } => {
                self.set_draft(&chat, &text, seq);
                settle(None, waiter);
            }
            Intent::ClearSentDraft { chat, text } => {
                self.clear_sent_draft(&chat, &text);
                settle(None, waiter);
            }
            Intent::ImportAttachment {
                scope,
                filename,
                bytes,
            } => self.import_attachment(scope, filename, bytes, waiter),
            Intent::DeleteAttachment { scope, filename } => {
                self.delete_attachment(scope, filename, waiter);
            }
            Intent::Composer(intent) => self.composer_intent(intent, waiter, done),
        }
    }

    // ---- Open, hydrate and recovery (`open`, `_scheduleRecovery`) ----

    /// Opens `chat`. When `host` is absent, keep the route's generation
    /// and invalidate only outstanding reads.
    fn open(&mut self, chat: ChatRef, host: Option<u64>, waiter: Option<Waiter>, done: &mut Done) {
        if !self.connected {
            if let Some(waiter) = waiter {
                done.push((waiter, Some(Failure::link(CopyKey::ReconnectFirst)), None));
            }
            return;
        }
        let key = chat.key();
        match host {
            Some(given) => self.bump(given),
            None => {
                let same_chat = self.selected.as_deref() == Some(key.as_str());
                let previous_read = self.reads;
                if !same_chat {
                    self.selection_epoch += 1;
                }
                self.retire_reads();
                if same_chat {
                    self.replace_composer_read(previous_read);
                }
            }
        }
        let read = self.reads;
        self.recovery = None;
        self.synchronized = false;
        self.selected = Some(key.clone());
        if !self.cache.read(&key) {
            self.cache
                .put(&key, Some(ChatState::new(chat.clone())), Some(&key));
        }
        self.cache.trim(Some(&key));
        self.loading = true;
        self.loading_older = false;
        self.set_error(None);
        self.hydrating = true;
        self.overflow = false;
        self.buffer.clear();
        let shared = self.shared.clone();
        let opened = chat.clone();
        self.spawn(move |inner, peer| async move {
            let result = read_chat(&inner, &peer, &chat, || {
                shared.reads.load(Ordering::SeqCst) == read
            })
            .await;
            Msg::Opened {
                read,
                chat: opened,
                result,
                waiter,
            }
        });
    }

    /// The reads finished; returns the open's failure.
    fn opened(
        &mut self,
        read: u64,
        chat: ChatRef,
        result: std::result::Result<Option<(Dv, Dv)>, OpenError>,
    ) -> Option<Failure> {
        if read != self.reads || self.disposed {
            return None;
        }
        let (snapshot, page) = match result {
            Ok(Some(read)) => read,
            Ok(None) => return None,
            Err(error) => return Some(self.open_failed(&error)),
        };
        match self.hydrate(chat, &snapshot, &page) {
            Ok(recover) => {
                self.buffer.clear();
                self.hydrating = false;
                self.loading = false;
                self.synchronized = !recover;
                if recover {
                    self.schedule_recovery();
                }
                None
            }
            Err(thrown) => Some(self.open_failed(&OpenError::Thrown(thrown))),
        }
    }

    fn open_failed(&mut self, error: &OpenError) -> Failure {
        let failure = describe(error);
        self.hydrating = false;
        self.loading = false;
        self.buffer.clear();
        self.set_error(Some(failure.message.clone()));
        failure
    }

    /// `DeviceChatState.hydrate`, the buffered events, `cache.hydrate`;
    /// whether to recover.
    fn hydrate(
        &mut self,
        chat: ChatRef,
        snapshot: &Dv,
        page: &Dv,
    ) -> std::result::Result<bool, Thrown> {
        let key = chat.key();
        let mut next = ChatState::new(chat);
        next.hydrate(object(snapshot)?, object(page)?, &mut self.uids)?;
        let mut recover = self.overflow;
        for event in std::mem::take(&mut self.buffer) {
            if next.apply(&event, &mut self.uids)? == Applied::Resync {
                recover = true;
                break;
            }
        }
        if let Some(previous) = self.cache.peek(&key) {
            next.retain_older(previous)?;
            reuse_unchanged(&mut next, previous);
        }
        self.cache.put(&key, Some(next), Some(&key));
        Ok(recover)
    }

    fn schedule_recovery(&mut self) {
        self.synchronized = false;
        if self.recovery.is_some() || !self.connected {
            return;
        }
        self.loading = true;
        self.timers += 1;
        let token = self.timers;
        self.recovery = Some(token);
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            tokio::time::sleep(RECOVERY).await;
            let _ = inbox.send(Msg::Recover(token));
        });
    }

    // ---- Pushes (`_receive`) ----

    fn push(&mut self, message: &Value) {
        if self.disposed {
            return;
        }
        let message = dto::desktop_value(message);
        if !self.peer.sees(&message) {
            return;
        }
        // `DeviceComposerSources`: any inventory change, connected or not.
        if message.get("payload").get("channel").as_str() == Some(INVENTORY_CHANGED) {
            self.inventory_changed();
            return;
        }
        if !self.connected {
            return;
        }
        let Some(event) = state_changed(&message) else {
            return;
        };
        // Only events the host delivered apply; cached chats stay stale
        // until reopened, and caching never widens interest.
        let selected = self.selected.clone();
        for key in self.cache.keys() {
            if Some(&key) == selected.as_ref() {
                continue;
            }
            let Some(state) = self.cache.get_mut(&key) else {
                continue;
            };
            if !state.chat.matches_scope(&event) {
                continue;
            }
            if state.apply(&event, &mut self.uids).is_ok() {
                self.cache.put(&key, None, selected.as_deref());
            }
        }
        let Some(key) = selected else { return };
        if !self
            .cache
            .peek(&key)
            .is_some_and(|s| s.chat.matches_scope(&event))
        {
            return;
        }
        if self.hydrating {
            if self.buffer.len() < BUFFER {
                self.buffer.push(event);
            } else {
                self.overflow = true;
            }
            return;
        }
        let applied = match self.cache.get_mut(&key) {
            Some(state) => state.apply(&event, &mut self.uids),
            None => return,
        };
        match applied {
            Ok(Applied::Done) => self.put_selected(),
            Ok(Applied::Resync) => {
                self.schedule_recovery();
                self.put_selected();
            }
            Err(_) => self.schedule_recovery(),
        }
    }

    // ---- Older pages (`loadOlder`) ----

    fn load_older(&mut self, waiter: Option<Waiter>, done: &mut Done) {
        let ready = self.ready();
        let target = self.state().and_then(|s| {
            s.before
                .map(|before| (s.chat.clone(), before, s.transcript_revision))
        });
        let Some((chat, before, revision)) = target.filter(|_| ready && !self.loading_older) else {
            if let Some(waiter) = waiter {
                done.push((waiter, None, None));
            }
            return;
        };
        let read = self.reads;
        self.loading_older = true;
        self.spawn(move |inner, peer| async move {
            let mut args = target_of(&chat);
            args["before"] = json!(before);
            args["transcriptRevision"] = json!(revision);
            let result = call(&inner, &peer, "chat:get-transcript-page", vec![args]).await;
            Msg::Older {
                read,
                revision,
                result,
                waiter,
            }
        });
    }

    fn older(&mut self, read: u64, revision: i64, result: Result<Value>) {
        if self.disposed || read != self.reads {
            return;
        }
        let failure = match result {
            Err(error) => Some(describe(&OpenError::Rpc(error))),
            Ok(value) => self.prepend(revision, &dto::desktop_value(&value)).err(),
        };
        if let Some(failure) = failure {
            self.set_error(Some(failure.message));
        }
        self.loading_older = false;
    }

    fn prepend(&mut self, revision: i64, page: &Dv) -> std::result::Result<(), Failure> {
        let thrown = |t| describe(&OpenError::Thrown(t));
        let page = object(page).map_err(thrown)?;
        let key = self.selected.clone().unwrap_or_default();
        let Some(state) = self.cache.get_mut(&key) else {
            return Ok(());
        };
        if !state.accepts_older(page, revision) {
            return Err(Failure {
                message: copy::text(CopyKey::HistoryChanged).into(),
                kind: FailKind::Link,
                code: None,
            });
        }
        state.prepend_page(page, &mut self.uids).map_err(thrown)?;
        self.put_selected();
        Ok(())
    }

    // ---- Leaving (`clearSelection`) ----

    fn leave(
        &mut self,
        expected: Option<u64>,
        generation: u64,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        if expected.is_some_and(|e| e != self.generation) {
            if let Some(waiter) = waiter {
                done.push((waiter, None, None));
            }
            return;
        }
        self.bump(generation);
        let read = self.reads;
        self.synchronized = false;
        self.recovery = None;
        let previous = self.selected.take();
        if previous.is_some() {
            self.cache.trim(None);
        }
        self.loading = false;
        self.loading_older = false;
        self.buffer.clear();
        self.hydrating = false;
        self.expanded.clear();
        if !self.connected {
            if let Some(waiter) = waiter {
                done.push((waiter, None, None));
            }
            return;
        }
        let shared = self.shared.clone();
        self.spawn(move |inner, peer| async move {
            let failure = clear_interest(&inner, &peer, || {
                shared.reads.load(Ordering::SeqCst) == read
                    && shared.connected.load(Ordering::SeqCst)
            })
            .await
            .err()
            .map(|e| describe(&OpenError::Rpc(e)));
            Msg::Done {
                waiter,
                failure,
                outcome: None,
            }
        });
    }

    // ---- Read receipts (`DeviceChatReadReceipts`) ----

    fn observe_receipts(&mut self) {
        let selected = self.state().map(|s| (s.chat.key(), s.revision));
        self.receipts
            .prune(selected.as_ref().map(|(k, r)| (k.as_str(), *r)));
        let next = match self.state() {
            Some(state)
                if self.receipts.enabled
                    && !self.receipts.held
                    && self.ready()
                    && !state.closed
                    && state.tab.get("unread").is_true() =>
            {
                Some((state.chat.key(), state.chat.clone(), state.revision))
            }
            _ => None,
        };
        let id = |l: &Option<(String, ChatRef, i64)>| l.as_ref().map(|(k, _, r)| (k.clone(), *r));
        if id(&self.receipts.latest) != id(&next) {
            self.receipts.retry = None;
            self.receipts.retries = 0;
            // Returning to a chat can retry a failed read at the same
            // revision; successful reads wait for the desktop.
            if self.receipts.failed {
                self.receipts.attempted = None;
            }
            self.receipts.failed = false;
        }
        self.receipts.latest = next;
        self.flush_receipts();
    }

    /// `invalidate`. The marks in flight keep their entry in `marks`; their
    /// results only settle it.
    fn invalidate_receipts(&mut self) {
        let r = &mut self.receipts;
        r.generation += 1;
        r.held = true;
        r.busy = false;
        r.latest = None;
        r.attempted = None;
        r.failed = false;
        r.retry = None;
        r.retries = 0;
    }

    fn flush_receipts(&mut self) {
        let r = &mut self.receipts;
        let Some((key, chat, revision)) = r.latest.clone() else {
            return;
        };
        if self.disposed
            || r.busy
            || r.retry.is_some()
            || r.attempted.as_ref() == Some(&(key.clone(), revision))
            || r.covered(&key, revision)
        {
            return;
        }
        r.attempted = Some((key.clone(), revision));
        r.failed = false;
        r.busy = true;
        r.marks.insert(
            key.clone(),
            Mark {
                revision,
                pending: true,
            },
        );
        let generation = r.generation;
        self.spawn(move |inner, peer| async move {
            let command = json!({"type": "chat.mark_read", "chatId": chat.id});
            let result = command_call(&inner, &peer, &chat, command).await;
            Msg::Marked {
                generation,
                key,
                revision,
                result,
            }
        });
    }

    fn marked(
        &mut self,
        generation: u64,
        key: &str,
        revision: i64,
        result: std::result::Result<(), CommandError>,
    ) {
        self.receipts.settle(key, revision, result.is_ok());
        if self.disposed || generation != self.receipts.generation {
            return;
        }
        if let Err(error) = result {
            let r = &mut self.receipts;
            r.failed = true;
            // Canonical refusals need a refresh; admission failures and
            // uncertain delivery retry this idempotent marker.
            let latest = r.latest.as_ref().map(|(k, _, rev)| (k.as_str(), *rev));
            if !matches!(error, CommandError::Rejected(_))
                && latest == Some((key, revision))
                && r.retries < RECEIPT_RETRIES
            {
                let delay = Duration::from_secs(1 << r.retries);
                r.retries += 1;
                r.timers += 1;
                let token = r.timers;
                r.retry = Some(token);
                let inbox = self.inbox.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    let _ = inbox.send(Msg::ReceiptRetry(token));
                });
            }
        }
        self.receipts.busy = false;
        self.flush_receipts();
    }

    // ---- The snapshot ----

    fn published(&mut self) -> Published {
        let selected = self.selected_view();
        if self.connected && self.completions.tracking {
            self.completions.observe(
                selected
                    .as_ref()
                    .map(|s| (&s.state, s.feed.latest_timer.as_ref())),
                self.synchronized,
            );
        } else {
            self.completions.stop();
        }
        Published {
            revision: self.revision,
            generation: self.generation,
            connected: self.connected,
            activity_connected: self.restoration.activity_connected,
            loading: self.loading,
            loading_older: self.loading_older,
            hydrating: self.hydrating,
            ready: self.ready(),
            error: self.error.clone(),
            error_revision: self.error_revision,
            selected,
            sending: self.sending,
            pending: self.pending.clone(),
            confirmed: self.confirmed.clone(),
            successful_turns: self.completions.recent.iter().cloned().collect(),
            drafts: self.drafts.shown.clone(),
            drafts_rev: self.drafts.rev,
            draft_seq: self.drafts.seq,
            composer: self.composer_shown(),
        }
    }

    fn selected_view(&mut self) -> Option<Selected> {
        let state = self.state()?.clone();
        let feed = self.project(&state);
        let tabs = state
            .open_tabs()
            .filter_map(|tab| {
                let id = tab.get("id").as_str()?.to_owned();
                Some(TabRow {
                    title: chat::chat_title(tab, copy::text(CopyKey::ChatFallback)),
                    unread: state
                        .scope
                        .tab(&id)
                        .is_some_and(|t| t.get("unread").is_true()),
                    running: state.scope.running(&id),
                    needs_input: state.scope.needs_input(&id),
                    id,
                })
            })
            .collect();
        Some(Selected {
            chat: state.chat.clone(),
            title: state.title(),
            running: state.running(),
            awaiting_input: state.awaiting_input(),
            has_pending_decision: state.has_pending_decision(),
            runtime_error: state.runtime_error(),
            tabs,
            feed,
            state,
        })
    }

    /// The feed of `state`; unchanged inputs keep the previous snapshot.
    fn project(&mut self, state: &ChatState) -> Arc<FeedSnapshot> {
        let mut expanded: Vec<String> = self.expanded.iter().cloned().collect();
        expanded.sort();
        let mut footers: Vec<String> = self.footers.iter().cloned().collect();
        footers.sort();
        let inputs = FeedInputs {
            key: state.chat.key(),
            uids: state.messages.iter().map(|m| m.uid).collect(),
            running: state.running(),
            expanded,
            footers,
            end_reasons: feed::end_reasons(&state.tab),
        };
        if inputs == self.inputs {
            return self.feed.clone();
        }
        if inputs.end_reasons != self.inputs.end_reasons {
            self.presented.clear();
        }
        let text = &self.text;
        let end_reasons = &inputs.end_reasons;
        let presented = &mut self.presented;
        let order: Vec<Arc<Presented>> = state
            .messages
            .iter()
            .filter_map(|m| {
                presented
                    .entry(m.uid)
                    .or_insert_with(|| feed::present(m, text, end_reasons).map(Arc::new))
                    .clone()
            })
            .collect();
        let kept: HashSet<u64> = inputs.uids.iter().copied().collect();
        presented.retain(|uid, _| kept.contains(uid));
        let borrowed: Vec<&Presented> = order.iter().map(|m| &**m).collect();
        let projection = feed::project(&borrowed, inputs.running, &self.expanded, &self.footers);
        let mut results = HashMap::new();
        for (turn, entries) in projection.results {
            let rev = match self.results.get(&turn) {
                Some((rev, previous)) if **previous == entries => *rev,
                _ => {
                    self.results_revs += 1;
                    self.results_revs
                }
            };
            let entries = match self.results.get(&turn) {
                Some((r, previous)) if *r == rev => previous.clone(),
                _ => Arc::new(entries),
            };
            results.insert(turn, (rev, entries));
        }
        self.results = results.clone();
        let mut seen = HashMap::<String, usize>::new();
        let rows = projection
            .rows
            .into_iter()
            .map(|row| {
                let (key, keyed) = match row.key() {
                    Some(key) => (key, true),
                    None => (format!("~row-{}", synthetic(&row)), false),
                };
                let count = seen.entry(key.clone()).or_default();
                *count += 1;
                let key = if *count > 1 {
                    format!("{key}#{count}")
                } else {
                    key
                };
                let results_rev = match &row {
                    Row::Message {
                        results: Some(turn),
                        ..
                    }
                    | Row::Run { results: turn, .. } => results.get(turn).map(|(rev, _)| *rev),
                    _ => None,
                };
                FeedEntry {
                    key,
                    keyed,
                    row,
                    results_rev,
                }
            })
            .collect();
        self.inputs = inputs;
        self.feed = Arc::new(FeedSnapshot {
            feedback_turns: turns::feedback_footers(&order, state.running()),
            latest_timer: turns::latest_timer(state),
            order,
            rows,
            results,
        });
        self.feed.clone()
    }
}

/// A stand-in key for a row Dart drew without one.
fn synthetic(row: &Row) -> String {
    match row {
        Row::Steps { counts, .. } => format!("steps-{}", counts.len()),
        Row::Timer { .. } => "timer".into(),
        _ => "row".into(),
    }
}

/// Keeps the previous entry (and its uid) of each message a fresh read
/// left unchanged, so the feed and the host's mirror keep them.
fn reuse_unchanged(next: &mut ChatState, previous: &ChatState) {
    let by_id: HashMap<&str, &Message> = previous
        .messages
        .iter()
        .filter_map(|m| m.id().ok().map(|id| (id, m)))
        .collect();
    for message in &mut next.messages {
        let Ok(id) = message.id() else { continue };
        if let Some(old) = by_id.get(id)
            && (Arc::ptr_eq(&old.raw, &message.raw) || *old.raw == *message.raw)
        {
            *message = (*old).clone();
        }
    }
}

/// `_receive`'s checks: an `ipc.push` of `chat:state-changed` (on the
/// actor's surface, [`Peer::sees`]) whose first argument is an object.
fn state_changed(message: &Dv) -> Option<DvMap> {
    let Dv::Map(message) = message else {
        return None;
    };
    if !message.get("name").is_str("ipc.push") {
        return None;
    }
    let Dv::Map(payload) = message.get("payload") else {
        return None;
    };
    if !payload.get("channel").is_str(STATE_CHANGED) {
        return None;
    }
    match payload.get("args") {
        Dv::List(args) => match args.first() {
            Some(Dv::Map(event)) => Some(event.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn scope_of(chat: &ChatRef) -> Value {
    json!({"projectId": chat.project_id, "worktreeId": chat.worktree_id})
}

fn target_of(chat: &ChatRef) -> Value {
    json!({"projectId": chat.project_id, "worktreeId": chat.worktree_id, "chatId": chat.id})
}

async fn call(inner: &Inner, peer: &Peer, channel: &str, args: Vec<Value>) -> Result<Value> {
    let rx = inner.request(peer, channel, args)?;
    rx.await
        .unwrap_or_else(|_| Err(cc_protocol::rpc::ended("session_ended")))
}

/// Writes `args` while the selection that asks is `current()`; `None` when
/// a newer one superseded it first. The check and the send are one step
/// under the arbiter's lock, so a superseded open or leave never replaces
/// the newer selection's scope or focus on the desktop.
async fn write(
    inner: &Inner,
    peer: &Peer,
    channel: &str,
    args: Value,
    current: impl FnOnce() -> bool,
) -> Result<Option<Value>> {
    let Some(rx) = inner.write_interest_while(peer, Holder::Chats, channel, vec![args], current)?
    else {
        return Ok(None);
    };
    rx.await
        .unwrap_or_else(|_| Err(cc_protocol::rpc::ended("session_ended")))
        .map(Some)
}

/// `open`'s reads: the scope and focus, the snapshot, the newest page.
/// `None` when a newer selection superseded it.
async fn read_chat(
    inner: &Inner,
    peer: &Peer,
    chat: &ChatRef,
    current: impl Fn() -> bool,
) -> std::result::Result<Option<(Dv, Dv)>, OpenError> {
    let rpc = OpenError::Rpc;
    let scope = json!({"kind": "scopes", "scopes": [scope_of(chat)]});
    if write(inner, peer, SCOPES, scope, &current)
        .await
        .map_err(rpc)?
        .is_none()
    {
        return Ok(None);
    }
    let focus = json!({"focused": [target_of(chat)], "warm": []});
    if write(inner, peer, INTEREST, focus, &current)
        .await
        .map_err(rpc)?
        .is_none()
        || !current()
    {
        return Ok(None);
    }
    let snapshot = dto::desktop_value(
        &call(inner, peer, "chat:get-state", vec![scope_of(chat)])
            .await
            .map_err(rpc)?,
    );
    object(&snapshot).map_err(OpenError::Thrown)?;
    let page = dto::desktop_value(
        &call(
            inner,
            peer,
            "chat:get-transcript-page",
            vec![target_of(chat)],
        )
        .await
        .map_err(rpc)?,
    );
    object(&page).map_err(OpenError::Thrown)?;
    Ok(Some((snapshot, page)))
}

/// `clearSelection`'s writes.
async fn clear_interest(inner: &Inner, peer: &Peer, current: impl Fn() -> bool) -> Result<()> {
    let focus = json!({"focused": [], "warm": []});
    if write(inner, peer, INTEREST, focus, &current)
        .await?
        .is_some()
    {
        let scope = json!({"kind": "scopes", "scopes": []});
        write(inner, peer, SCOPES, scope, &current).await?;
    }
    Ok(())
}

/// A UUID v4 (`chatId()`).
fn uuid() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// `DeviceChatSettings.command`: one `chat:command` on the chat's scope.
pub(crate) async fn command_call(
    inner: &Inner,
    peer: &Peer,
    chat: &ChatRef,
    command: Value,
) -> std::result::Result<(), CommandError> {
    let args = json!({
        "schemaVersion": 1,
        "commandId": uuid(),
        "projectId": chat.project_id,
        "worktreeId": chat.worktree_id,
        "command": command,
    });
    let reply = call(inner, peer, "chat:command", vec![args])
        .await
        .map_err(CommandError::Rpc)?;
    let reply = dto::desktop_value(&reply);
    let response = object(&reply).map_err(|_| CommandError::Invalid)?;
    let outcome = response.get("outcome");
    if ["conflict", "not_found", "rejected"]
        .iter()
        .any(|o| outcome.is_str(o))
    {
        let reason = response
            .get("reason")
            .as_str()
            .filter(|r| !chat::trim(r).is_empty());
        return Err(CommandError::Rejected(match reason {
            Some(reason) => utf16_prefix(reason, 1000),
            None => copy::text(CopyKey::CommandRefused).into(),
        }));
    }
    if !["applied", "already_applied"]
        .iter()
        .any(|o| outcome.is_str(o))
    {
        return Err(CommandError::Format);
    }
    if !matches!(response.get("revision"), Dv::Int(_)) {
        return Err(CommandError::Format);
    }
    Ok(())
}

/// `text.substring(0, min(length, units))` in UTF-16 units.
fn utf16_prefix(text: &str, units: usize) -> String {
    let encoded: Vec<u16> = text.encode_utf16().take(units).collect();
    String::from_utf16_lossy(&encoded)
}

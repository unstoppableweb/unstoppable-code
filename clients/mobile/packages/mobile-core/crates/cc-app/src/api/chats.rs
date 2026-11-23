//! One computer's chat read path (architecture §3.4, §4.2, P5a): the
//! selected chat's desktop state with its cache, hydration, revision
//! recovery, older pages, read receipts and tab archive, and its feed
//! grouped in the core (D8).
//!
//! [`ChatsService::watch`] streams [`ChatFrame`]s, at most one per 33 ms
//! frame budget: the header and flags whole, the feed as keyed ops
//! against what that subscriber already has (a reset for a new selection,
//! a new transcript revision, a prepended page or more than 256 ops), and
//! the selected chat's desktop state for the Dart features not yet ported
//! (settings, activity, pipelines), also as changes.
//!
//! Since P5b it also carries the writes: sends with the pending and
//! confirmed attempt (one unconfirmed send per computer), chat and tab
//! creation, stop, attachment imports and the computer's chat drafts,
//! kept in the encrypted store (D9). A write is sent at most once and
//! never retried by the core.
//!
//! Intents are queued in call order ([`ChatsService::send`]);
//! [`ChatsService::request`] also returns a ticket whose outcome
//! [`ChatsService::settled`] waits for. Each [`ChatIntent`] variant says
//! when it settles.
use super::{ChatRefView, CoreFailure, CoreInner};
use crate::account::View;
use crate::chats::{self, FeedEntry, FeedSnapshot, Handle, Published};
use crate::copy::chats::{self as copy, CopyKey};
use cc_domain::{
    chat::{ChatRef, send::PendingSend},
    feed::{self, Presented, Row, StepCategory, ToolResult, TurnTimer},
};
use cc_protocol::dto;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;

/// The pump's frame budget (about 30 frames a second while streaming).
const FRAME: Duration = Duration::from_millis(33);
/// More feed ops than this collapse to a reset.
const MAX_OPS: usize = 256;

/// What the host asks of the read path. Queued in call order.
#[derive(Debug, Clone)]
pub enum ChatIntent {
    /// The session became usable or ended. `generation` is the host's
    /// selection count after its own bump on disconnect.
    ///
    /// Resolves when applied.
    SetConnected { connected: bool, generation: u64 },
    /// Selects `chat` and reads its state and newest page; fails
    /// ("Reconnect to your computer first.") when not connected.
    ///
    /// Resolves when settled: the reads finished, failed (with the
    /// failure) or a newer selection superseded them.
    Open { chat: ChatRefView, generation: u64 },
    /// Reads the page before the oldest message held.
    ///
    /// Resolves when settled: the page applied, failed (into `error`) or
    /// was superseded; at once when there is nothing to read.
    LoadOlder,
    /// Leaves the selected chat unless `expected` is set and differs from
    /// the current generation; then clears the desktop's focus and scopes.
    ///
    /// Resolves when settled: after both writes (at once offline).
    Leave {
        expected: Option<u64>,
        generation: u64,
    },
    /// Opens or closes a turn or a step run in the feed.
    ///
    /// Resolves when applied.
    ToggleTurn { key: String },
    /// The turns that get a footer row (the host's pipeline panels).
    ///
    /// Resolves when applied.
    SetFooterTurns { keys: Vec<String> },
    /// Whether the visible chat may be marked read.
    ///
    /// Resolves when applied.
    SetReadReceipts { enabled: bool },
    /// Forgets pending and attempted read marks.
    ///
    /// Resolves when applied.
    InvalidateReadReceipts,
    /// Marks the visible chat read again, even at a revision tried before.
    ///
    /// Resolves when applied.
    RetryReadReceipts,
    /// Archives `chat`'s tab on the computer.
    ///
    /// Resolves when settled: the desktop answered (or the call failed).
    Archive { chat: ChatRefView },
    /// Stops this read path (the drafts are written first).
    ///
    /// Resolves when applied.
    Close,
    /// Sends `text` to the selected chat with the selected tab's settings,
    /// or with `retry` the pending attempt again with its ids and files.
    /// Fails, with nothing sent, when `chat` is given and another chat is
    /// selected, the chat is not ready, the text is empty or too long,
    /// another attempt is unconfirmed, or a retry is not of the pending
    /// attempt. Sent once: an unanswered or refused send stays pending
    /// (`Sent { accepted: false }`, its words in `error`); only a provider
    /// sign-in refusal drops it (a `Refused` failure).
    ///
    /// Resolves when settled: the desktop answered, the call failed, or the
    /// transcript confirmed the attempt first.
    Send {
        /// The chat the send is for; none sends to the selected chat.
        chat: Option<ChatRefView>,
        text: String,
        retry: bool,
        dictated: bool,
        attachment_paths: Vec<String>,
    },
    /// Cancels the selected chat's turn (`chat:cancel`, once).
    ///
    /// Resolves when settled: the desktop answered (`Stopped`, with whether
    /// the host should re-read the chat) or the call failed.
    Stop,
    /// Creates a work entry in `workspace_id` (a catalog workspace) and its
    /// starter chat, each sent once.
    ///
    /// Resolves when settled: both calls answered (`Created`: the host
    /// opens it) or one failed; a `CreationNotSent` failure means no work
    /// entry was sent.
    CreateChat {
        workspace_id: String,
        title: Option<String>,
    },
    /// Creates a chat tab in the worktree (sent once).
    ///
    /// Resolves when settled: the desktop answered (`Created`: the host
    /// opens it; no outcome when the selection or session changed
    /// meanwhile) or the call failed.
    CreateTab {
        project_id: String,
        worktree_id: String,
    },
    /// The catalog's chat workspaces, which `CreateChat` accepts.
    ///
    /// Resolves when applied.
    SetWorkspaces { ids: Vec<String> },
    /// The host's draft of `chat`; `seq` (increasing per host) orders its
    /// writes, and frames echo the last one applied. Written to the
    /// encrypted store 500 ms after the last change.
    ///
    /// Resolves when applied.
    SetDraft {
        chat: ChatRefView,
        text: String,
        seq: u64,
    },
    /// The host learned `text` was sent to `chat`: its draft is cleared
    /// when it still equals `text`. (The core also does this whenever a
    /// send is accepted or confirmed.)
    ///
    /// Resolves when applied.
    ClearSentDraft { chat: ChatRefView, text: String },
    /// Stores `bytes` as `filename` in `scope`'s attachments folder on the
    /// computer: one file per request, sent once, with five minutes for the
    /// reply.
    ///
    /// Resolves when settled: the computer stored it (`Stored`) or the
    /// import failed.
    ImportAttachment {
        scope: ChatRefView,
        filename: String,
        bytes: Vec<u8>,
    },
    /// Deletes `filename` from `scope`'s attachments folder (sent once).
    ///
    /// Resolves when settled: the desktop answered or the call failed.
    DeleteAttachment {
        scope: ChatRefView,
        filename: String,
    },
    // ---- The composer (P5c) ----
    /// The host reads the composer from the core: the settings catalog is
    /// read when the selected chat changes from now on.
    ///
    /// Resolves when applied.
    EnableComposer,
    /// Reads the selected chat's settings catalog, or shares the read in
    /// flight for it. With `report` the outcome shows as the catalog error
    /// (`loadSettings`); without, the failure is returned
    /// (`DeviceChatSettings.load`).
    ///
    /// Resolves when settled: the read finished (at once without a
    /// selection).
    LoadSettings { report: bool },
    /// The host's listener ran with `chat` showing this model and harness
    /// (bridge-form JSON) and running state (`_syncSettings`): a change
    /// reads the catalog, unless a read for that chat was in flight when
    /// the state showed.
    ///
    /// Resolves when applied.
    SyncSettings {
        chat: ChatRefView,
        model_json: String,
        harness_json: String,
        running: bool,
    },
    /// Reads the catalog until the selected chat's model, harness and
    /// running state stay the same over a read (`_restore`).
    ///
    /// Resolves when settled: the loop ended (or the connection changed).
    RestoreSettings,
    /// Forgets the catalog (offline).
    ///
    /// Resolves when applied.
    InvalidateSettings,
    /// Shows `pick` at once and saves it after the picks before it, each
    /// with one `chat:command` (`Changed`: whether it was saved for the
    /// shown chat).
    ///
    /// Resolves when settled: the desktop answered, the pick was dropped
    /// (the chat or connection changed, or an earlier write was
    /// uncertain) or refused.
    ChangeSetting {
        chat: ChatRefView,
        pick: super::SettingsPick,
    },
    /// Drops the queued picks (a new tab or selection).
    ///
    /// Resolves when applied.
    InvalidatePicks,
    /// `chat.set_model` once, after the catalog check (`Saved`).
    ///
    /// Resolves when settled: the desktop answered or the call failed.
    SelectModel {
        chat: ChatRefView,
        id: String,
        provider: String,
        harness: Option<String>,
    },
    /// `chat.patch_tab_settings` once with `patch_json` (`Saved`).
    ///
    /// Resolves when settled: the desktop answered or the call failed.
    PatchSettings {
        chat: ChatRefView,
        patch_json: String,
    },
    /// Answers a pending question (`answers_json`: the answer maps), once.
    ///
    /// Resolves when settled: the desktop answered (`Saved`) or the call
    /// failed.
    Answer {
        chat: ChatRefView,
        request_id: String,
        answers_json: String,
    },
    /// Dismisses a pending question, once.
    ///
    /// Resolves when settled: the desktop answered (`Saved`) or the call
    /// failed.
    DismissQuestion {
        chat: ChatRefView,
        request_id: String,
    },
    /// Forks `chat` at a message, with ids kept per `(chat, message)`
    /// until the fork opens (`Forked`: the host opens it).
    ///
    /// Resolves when settled: the desktop confirmed the fork or the call
    /// failed.
    Fork {
        chat: ChatRefView,
        at_message_id: String,
    },
    /// The fork opened: the next fork at that message is a new one.
    ///
    /// Resolves when applied.
    ForkOpened {
        chat: ChatRefView,
        at_message_id: String,
    },
    /// Reads a composer catalog for the chat `scope` captured
    /// (`Inventory`, `PluginCatalog` or `Selections`); fails when the
    /// shown chat no longer matches it.
    ///
    /// Resolves when settled: the reads finished or failed.
    LoadComposerSource {
        source: super::ComposerSource,
        scope: super::SourceScopeView,
    },
}

/// What the host rethrows a failure as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatFailureKind {
    /// A `DeviceLinkException` with the message.
    Link,
    /// A `DesktopIpcRefusal`: the desktop refused.
    Refused,
    /// A `DesktopIpcNotSent`: nothing reached the desktop.
    NotSent,
    /// A `DeviceChatCreationNotSent`: no work entry was sent.
    CreationNotSent,
    /// Another error; the host words it.
    Other,
}

/// A send attempt (`DeviceChatPendingSend`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingSendView {
    pub chat: ChatRefView,
    pub id: String,
    pub text: String,
    pub dictated: bool,
    pub attachment_paths: Vec<String>,
}

/// What a settled intent produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatOutcome {
    /// The requested selection survived its reads.
    Opened { selected: bool },
    /// The computer accepted the send, or may have (`accepted: false`).
    Sent { accepted: bool },
    /// A chat or tab was created; the host opens it.
    Created { chat: ChatRefView },
    /// The turn was cancelled; with `refresh` the host re-reads the chat.
    Stopped { refresh: bool },
    /// The computer stored the file at `path`.
    Stored {
        filename: String,
        path: String,
        size: i64,
    },
    /// A settings pick was saved for the shown chat (`applied`) or not.
    Changed { applied: bool },
    /// A settings command or a decision applied at `revision`.
    Saved { revision: i64 },
    /// A fork was created; the host opens it.
    Forked { chat: ChatRefView },
    /// The invocable rows; `unsettled` when a later load can change them.
    Inventory {
        commands: Vec<super::CommandRowView>,
        unsettled: bool,
    },
    /// The plugin picker's catalog, in bridge-form JSON
    /// (`ComposerPluginCatalog.fromJson`'s input).
    PluginCatalog { json: String },
    /// The chat's plugin selections in bridge-form JSON, if any.
    Selections { json: Option<String> },
}

/// A draft as shown; `""` is none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftView {
    /// `"<project>/<worktree>/<chat>"`.
    pub key: String,
    pub text: String,
}

/// A failure the host rethrows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatFailure {
    pub message: String,
    pub kind: ChatFailureKind,
    /// A refusal's desktop code.
    pub code: Option<String>,
}

/// How a requested intent ended. Frames from `revision` on show it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatSettled {
    pub revision: u64,
    pub failure: Option<ChatFailure>,
    pub outcome: Option<ChatOutcome>,
}

/// A chat tab as the chat screen lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatTabView {
    pub id: String,
    pub title: String,
    pub unread: bool,
    pub running: bool,
    pub needs_input: bool,
}

/// The selected chat's header.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatHeaderView {
    pub revision: i64,
    pub transcript_revision: i64,
    pub title: String,
    pub closed: bool,
    pub read_only: bool,
    pub has_unread_tabs: bool,
    pub running: bool,
    pub awaiting_input: bool,
    pub has_pending_decision: bool,
    pub runtime_error: Option<String>,
    pub has_older: bool,
    pub total_messages: i64,
    pub tabs: Vec<ChatTabView>,
    /// The worktree's open file tabs, in tab order (P6).
    pub file_tabs: Vec<super::FileTabView>,
    /// The chat's pending questions (P5c).
    pub questions: Vec<super::QuestionView>,
}

/// One desktop message entry, in bridge form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawMessageView {
    pub uid: u64,
    pub json: String,
}

/// The selected chat's desktop state (`DeviceChatState`), for the Dart
/// features not yet ported. Bridge-form JSON fields are sent when they
/// changed; `order` when the message list changed.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatStateFrame {
    pub revision: i64,
    pub transcript_revision: i64,
    pub before: Option<i64>,
    pub total_messages: i64,
    pub closed: bool,
    pub tab_json: Option<String>,
    pub runtime_json: Option<String>,
    /// `{tabsFile: {tabs, pendingQuestions, pendingApprovals},
    /// runtimeByChatId}`.
    pub scope_json: Option<String>,
    pub messages: Vec<RawMessageView>,
    pub order: Option<Vec<u64>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageStatus {
    Streaming,
    Complete,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatcherEntryView {
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatcherFiredView {
    pub kind: String,
    pub combined: Option<Vec<WatcherEntryView>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentView {
    pub id: String,
    pub filename: String,
    pub media_type: String,
}

/// A message part; `data_json` is its payload in bridge form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartView {
    pub kind: String,
    pub tool_family: Option<String>,
    pub data_json: Option<String>,
}

/// A presented message (`ChatMessage` of the selected chat). An entry never changes: a new
/// version of a message is a new `uid`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageView {
    pub uid: u64,
    pub id: String,
    pub role: Option<ChatRole>,
    pub status: MessageStatus,
    pub text: String,
    pub watcher_fired: Option<WatcherFiredView>,
    pub attachments: Vec<AttachmentView>,
    pub occurred_at_ms: Option<i64>,
    pub continues_turn: bool,
    pub parts: Vec<PartView>,
}

/// A presented message's place in the transcript, with what turn feedback
/// reads of it whether or not a row materializes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageRef {
    pub uid: u64,
    pub id: String,
    pub role: Option<ChatRole>,
    pub continues_turn: bool,
    /// `hasRenderableContent`.
    pub renderable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResultView {
    pub tool_use_id: String,
    pub content: String,
    pub is_error: bool,
}

/// One turn's tool results; rows name them by `turn` and `rev`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResultsView {
    pub turn: u64,
    pub rev: u64,
    pub results: Vec<ToolResultView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResultsRef {
    pub turn: u64,
    pub rev: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimerView {
    pub started_at: Option<i64>,
    pub paused_at: Option<i64>,
    pub resumed_at: Option<i64>,
    pub accumulated_paused_duration_ms: Option<i64>,
    pub completed_at: Option<i64>,
    pub end_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepCategoryView {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StepCountView {
    pub category: StepCategoryView,
    pub count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StepRef {
    pub uid: u64,
    pub index: u32,
}

/// A feed row (`TranscriptRow`); messages are named by `uid`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedRow {
    Message {
        uid: u64,
        results: Option<ResultsRef>,
        streaming_spinner: bool,
        parts: bool,
    },
    Run {
        run_key: String,
        steps: Vec<StepRef>,
        shown_from: u32,
        expanded: bool,
        results: ResultsRef,
        anchor_message_id: Option<String>,
    },
    Steps {
        turn_key: String,
        counts: Vec<StepCountView>,
        expanded: bool,
        timer: Option<TimerView>,
    },
    Timer {
        turn_key: Option<String>,
        timer: Option<TimerView>,
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

/// A row and its feed key. `keyed` is false for a row Dart drew without a
/// key; its feed key is a stand-in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedItem {
    pub key: String,
    pub keyed: bool,
    pub row: FeedRow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedOp {
    /// Inserts or replaces `item` after `after` (`None`: first).
    Upsert {
        after: Option<String>,
        item: FeedItem,
    },
    Remove {
        key: String,
    },
}

/// The feed's changes since the subscriber's previous frame. On `reset`
/// everything it held is replaced: `messages`, `order` and `results` are
/// complete and `ops` upsert every row in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedFrame {
    pub reset: bool,
    pub messages: Vec<MessageView>,
    pub order: Option<Vec<MessageRef>>,
    pub results: Vec<ToolResultsView>,
    pub ops: Vec<FeedOp>,
}

/// The selection's part of a frame.
#[derive(Debug, Clone, PartialEq)]
pub struct SelectionFrame {
    pub chat: ChatRefView,
    /// A new selection: drop what was held.
    pub reset: bool,
    pub header: ChatHeaderView,
    pub state: ChatStateFrame,
    pub feed: FeedFrame,
}

/// One frame of the read path.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatFrame {
    /// The snapshot revision this frame shows.
    pub revision: u64,
    pub generation: u64,
    pub connected: bool,
    pub loading: bool,
    pub loading_older: bool,
    pub hydrating: bool,
    pub ready: bool,
    pub error: Option<String>,
    /// Bumped by every write of `error`, a clear included.
    pub error_revision: u64,
    pub selected: Option<SelectionFrame>,
    /// A send is in flight.
    pub sending: bool,
    /// The unconfirmed send of this computer.
    pub pending_send: Option<PendingSendView>,
    /// The last send accepted or confirmed.
    pub confirmed_send: Option<PendingSendView>,
    /// Drafts changed since this subscriber's previous frame (all on the
    /// first frame).
    pub drafts: Vec<DraftView>,
    /// The host's last [`ChatIntent::SetDraft`] `seq` applied.
    pub draft_seq: u64,
    /// The composer, when it changed since this subscriber's previous
    /// frame (always on the first).
    pub composer: Option<super::ComposerView>,
}

/// One computer's chat read path. Built by
/// [`super::AccountService::chats`].
#[derive(Clone)]
pub struct ChatsService {
    inner: Arc<CoreInner>,
    handle: Handle,
    tickets: Arc<Mutex<Tickets>>,
}

/// The last ticket issued and the outcomes not yet claimed.
type Tickets = (u64, HashMap<u64, oneshot::Receiver<chats::Settled>>);

fn chat_ref(v: ChatRefView) -> ChatRef {
    ChatRef {
        project_id: v.project_id,
        worktree_id: v.worktree_id,
        id: v.id,
        title: v.title,
    }
}

fn intent(i: ChatIntent) -> chats::Intent {
    use chats::{ComposerIntent as C, Intent as I, PickIntent as P};
    match i {
        ChatIntent::SetConnected {
            connected,
            generation,
        } => I::SetConnected {
            connected,
            generation,
        },
        ChatIntent::Open { chat, generation } => I::Open {
            chat: chat_ref(chat),
            generation,
        },
        ChatIntent::LoadOlder => I::LoadOlder,
        ChatIntent::Leave {
            expected,
            generation,
        } => I::Leave {
            expected,
            generation,
        },
        ChatIntent::ToggleTurn { key } => I::ToggleTurn(key),
        ChatIntent::SetFooterTurns { keys } => I::SetFooterTurns(keys),
        ChatIntent::SetReadReceipts { enabled } => I::SetReadReceipts(enabled),
        ChatIntent::InvalidateReadReceipts => I::InvalidateReadReceipts,
        ChatIntent::RetryReadReceipts => I::RetryReadReceipts,
        ChatIntent::Archive { chat } => I::Archive(chat_ref(chat)),
        ChatIntent::Close => I::Close,
        ChatIntent::Send {
            chat,
            text,
            retry,
            dictated,
            attachment_paths,
        } => I::Send(chats::SendIntent {
            generation: None,
            gate: None,
            chat: chat.map(chat_ref),
            text,
            retry,
            dictated,
            attachment_paths,
        }),
        ChatIntent::Stop => I::Stop,
        ChatIntent::CreateChat {
            workspace_id,
            title,
        } => I::CreateChat {
            workspace: workspace_id,
            title,
        },
        ChatIntent::CreateTab {
            project_id,
            worktree_id,
        } => I::CreateTab {
            project_id,
            worktree_id,
        },
        ChatIntent::SetWorkspaces { ids } => I::SetWorkspaces(ids),
        ChatIntent::SetDraft { chat, text, seq } => I::SetDraft {
            chat: chat_ref(chat),
            text,
            seq,
        },
        ChatIntent::ClearSentDraft { chat, text } => I::ClearSentDraft {
            chat: chat_ref(chat),
            text,
        },
        ChatIntent::ImportAttachment {
            scope,
            filename,
            bytes,
        } => I::ImportAttachment {
            scope: chat_ref(scope),
            filename,
            bytes,
        },
        ChatIntent::DeleteAttachment { scope, filename } => I::DeleteAttachment {
            scope: chat_ref(scope),
            filename,
        },
        ChatIntent::EnableComposer => I::Composer(C::Enable),
        ChatIntent::LoadSettings { report } => I::Composer(C::LoadSettings { report }),
        ChatIntent::SyncSettings {
            chat,
            model_json,
            harness_json,
            running,
        } => I::Composer(C::Sync {
            chat: chat_ref(chat),
            model: super::composer::host_value(&model_json),
            harness: super::composer::host_value(&harness_json),
            running,
        }),
        ChatIntent::RestoreSettings => I::Composer(C::Restore),
        ChatIntent::InvalidateSettings => I::Composer(C::InvalidateSettings),
        ChatIntent::ChangeSetting { chat, pick } => I::Composer(C::Change {
            chat: chat_ref(chat),
            pick: match pick {
                super::SettingsPick::Effort { level } => P::Effort(level),
                super::SettingsPick::Auto => P::Auto,
                super::SettingsPick::PlanMode { enabled } => P::PlanMode(enabled),
                super::SettingsPick::Model {
                    id,
                    execution_harness,
                } => P::Model {
                    id,
                    execution_harness,
                },
                super::SettingsPick::Fast { fast } => P::Fast(fast),
            },
        }),
        ChatIntent::InvalidatePicks => I::Composer(C::InvalidatePicks),
        ChatIntent::SelectModel {
            chat,
            id,
            provider,
            harness,
        } => I::Composer(C::SelectModel {
            chat: chat_ref(chat),
            id,
            provider,
            harness,
        }),
        ChatIntent::PatchSettings { chat, patch_json } => I::Composer(C::Patch {
            chat: chat_ref(chat),
            patch: match super::composer::host_value(&patch_json) {
                cc_domain::dart::Dv::Map(map) => map,
                _ => cc_domain::dart::DvMap::new(),
            },
        }),
        ChatIntent::Answer {
            chat,
            request_id,
            answers_json,
        } => I::Composer(C::Decide {
            chat: chat_ref(chat),
            request_id,
            answers: Some(serde_json::from_str(&answers_json).unwrap_or(serde_json::Value::Null)),
        }),
        ChatIntent::DismissQuestion { chat, request_id } => I::Composer(C::Decide {
            chat: chat_ref(chat),
            request_id,
            answers: None,
        }),
        ChatIntent::Fork {
            chat,
            at_message_id,
        } => I::Composer(C::Fork {
            chat: chat_ref(chat),
            at: at_message_id,
        }),
        ChatIntent::ForkOpened {
            chat,
            at_message_id,
        } => I::Composer(C::ForkOpened {
            chat: chat_ref(chat),
            at: at_message_id,
        }),
        ChatIntent::LoadComposerSource { source, scope } => I::Composer(C::Source {
            read: match source {
                super::ComposerSource::Inventory => chats::SourceRead::Inventory,
                super::ComposerSource::PluginCatalog => chats::SourceRead::PluginCatalog,
                super::ComposerSource::Selections => chats::SourceRead::Selections,
            },
            scope: chats::SourceScope {
                model: super::composer::host_value(&scope.model_json),
                tab_harness: super::composer::host_value(&scope.harness_json),
                chat: chat_ref(scope.chat),
                generation: scope.generation,
            },
        }),
    }
}

fn ref_view(c: &ChatRef) -> ChatRefView {
    ChatRefView {
        project_id: c.project_id.clone(),
        worktree_id: c.worktree_id.clone(),
        id: c.id.clone(),
        title: c.title.clone(),
    }
}

fn pending_view(p: &PendingSend) -> PendingSendView {
    PendingSendView {
        chat: ref_view(&p.chat),
        id: p.id.clone(),
        text: p.text.clone(),
        dictated: p.dictated,
        attachment_paths: p.attachment_paths.clone(),
    }
}

pub(crate) fn failure_view(f: chats::Failure) -> ChatFailure {
    use chats::FailKind as K;
    ChatFailure {
        message: f.message,
        kind: match f.kind {
            K::Link => ChatFailureKind::Link,
            K::Refused => ChatFailureKind::Refused,
            K::NotSent => ChatFailureKind::NotSent,
            K::CreationNotSent => ChatFailureKind::CreationNotSent,
            K::Other => ChatFailureKind::Other,
        },
        code: f.code,
    }
}

fn outcome_view(o: chats::Outcome) -> ChatOutcome {
    use chats::Outcome as O;
    match o {
        O::Opened { selected } => ChatOutcome::Opened { selected },
        O::Sent { accepted } => ChatOutcome::Sent { accepted },
        O::Created(chat) => ChatOutcome::Created {
            chat: ref_view(&chat),
        },
        O::Stopped { refresh } => ChatOutcome::Stopped { refresh },
        O::Stored {
            filename,
            path,
            size,
        } => ChatOutcome::Stored {
            filename,
            path,
            size,
        },
        O::Changed { applied } => ChatOutcome::Changed { applied },
        O::Saved { revision } => ChatOutcome::Saved { revision },
        O::Forked(chat) => ChatOutcome::Forked {
            chat: ref_view(&chat),
        },
        O::Inventory {
            commands,
            unsettled,
        } => ChatOutcome::Inventory {
            commands: commands
                .into_iter()
                .map(super::composer::command_row)
                .collect(),
            unsettled,
        },
        O::Catalog(json) => ChatOutcome::PluginCatalog { json },
        O::Selections(json) => ChatOutcome::Selections { json },
    }
}

impl ChatsService {
    pub(crate) fn new(inner: Arc<CoreInner>, handle: Handle) -> Self {
        Self {
            inner,
            handle,
            tickets: Arc::default(),
        }
    }
    /// The computer's worktree activity and changed-file diffs (P6),
    /// whose chat todos follow this read path's selection. Each lives
    /// until its [`super::ActivityIntent::Close`].
    pub fn activity(&self) -> super::ActivityService {
        let handle = crate::activity::Handle::start(
            &self.inner.app,
            self.inner.handle(),
            self.handle.peer().clone(),
            self.handle.view(),
        );
        super::ActivityService::new(self.inner.clone(), handle)
    }
    /// The computer's pipelines and the work drawers of its mounted chats
    /// (P7), whose feed panels and drawers follow this read path's chat.
    /// Each lives until its [`super::PipelinesIntent::Close`].
    pub fn pipelines(&self) -> super::PipelinesService {
        let handle = crate::pipelines::Handle::start(
            &self.inner.app,
            self.inner.handle(),
            self.handle.peer().clone(),
            self.handle.view(),
        );
        super::PipelinesService::new(self.inner.clone(), handle)
    }
    pub(crate) fn handle(&self) -> &Handle {
        &self.handle
    }
    /// The files this read path's chats have open (P6), read on its
    /// surface: the Orchestrator chat's on `app-advisor`, as its Dart
    /// reader read them over its own sender.
    pub fn files(&self) -> super::FilesService {
        super::FilesService::new(self.inner.clone(), self.handle.peer().clone())
    }
    /// The current state as a full frame, then changes, at most one frame
    /// per 33 ms.
    pub fn watch(&self) -> ChatFrames {
        ChatFrames {
            view: self.handle.view(),
            sent: None,
            drafts_rev: 0,
            first: true,
            last: None,
            composer: None,
        }
    }
    /// Queues `intent`; its outcome is not reported.
    pub fn send(&self, intent: ChatIntent) {
        let _ = self.handle.send(self::intent(intent), None);
    }
    /// Queues `intent` and returns the ticket [`Self::settled`] takes.
    pub fn request(&self, intent: ChatIntent) -> u64 {
        let (tx, rx) = oneshot::channel();
        let mut tickets = self.tickets.lock().unwrap_or_else(|p| p.into_inner());
        tickets.0 += 1;
        let ticket = tickets.0;
        if self.handle.send(self::intent(intent), Some(tx)).is_ok() {
            tickets.1.insert(ticket, rx);
        }
        ticket
    }
    /// The outcome of a [`Self::request`]ed intent. Fails when the core
    /// shut down (or the ticket is unknown), and `account_changed` once
    /// the account the service was opened in was left, also while the
    /// intent ran.
    pub async fn settled(&self, ticket: u64) -> Result<ChatSettled, CoreFailure> {
        let rx = self
            .tickets
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .1
            .remove(&ticket);
        let settled = self.inner.ticket(self.handle.scope(), rx).await?;
        Ok(ChatSettled {
            revision: settled.revision,
            failure: settled.failure.map(failure_view),
            outcome: settled.outcome.map(outcome_view),
        })
    }
}

/// What a subscriber holds, to diff the next frame against.
struct Sent {
    key: String,
    transcript_revision: i64,
    // The desktop state.
    tab: cc_domain::dart::DvMap,
    runtime: cc_domain::dart::DvMap,
    scope: cc_domain::chat::ScopeState,
    raw: HashSet<u64>,
    raw_order: Vec<u64>,
    // The feed.
    feed: Arc<FeedSnapshot>,
    messages: HashSet<u64>,
    results: HashMap<u64, u64>,
}

/// The composer's inputs (its state and the selected chat's key, running
/// and closed flags) and the view last sent for them.
type ComposerSent = (
    chats::ComposerShown,
    Option<(String, bool, bool)>,
    super::ComposerView,
);

/// A [`ChatsService::watch`] stream.
pub struct ChatFrames {
    view: View<Published>,
    sent: Option<Sent>,
    /// The draft revision this subscriber was shown.
    drafts_rev: u64,
    first: bool,
    last: Option<tokio::time::Instant>,
    /// The composer's inputs and the view last sent for them.
    composer: Option<ComposerSent>,
}

impl ChatFrames {
    /// The next frame; `None` once the read path stopped or the account it
    /// was opened in was left.
    pub async fn next(&mut self) -> Option<ChatFrame> {
        if !self.first {
            self.view.changed().await.ok()?;
            if let Some(last) = self.last {
                tokio::time::sleep_until(last + FRAME).await;
            }
        }
        self.first = false;
        self.last = Some(tokio::time::Instant::now());
        let published = self.view.latest()?;
        Some(self.frame(&published))
    }

    fn frame(&mut self, p: &Published) -> ChatFrame {
        let selected = match &p.selected {
            None => {
                self.sent = None;
                None
            }
            Some(s) => Some(self.selection(s)),
        };
        let drafts = p
            .drafts
            .iter()
            .filter(|(_, (_, rev))| *rev > self.drafts_rev)
            .map(|(key, (text, _))| DraftView {
                key: key.clone(),
                text: text.clone(),
            })
            .collect();
        self.drafts_rev = p.drafts_rev;
        let composer = self.composer_frame(p);
        ChatFrame {
            revision: p.revision,
            generation: p.generation,
            connected: p.connected,
            loading: p.loading,
            loading_older: p.loading_older,
            hydrating: p.hydrating,
            ready: p.ready,
            error: p.error.clone(),
            error_revision: p.error_revision,
            selected,
            sending: p.sending,
            pending_send: p.pending.as_ref().map(pending_view),
            confirmed_send: p.confirmed.as_ref().map(pending_view),
            drafts,
            draft_seq: p.draft_seq,
            composer,
        }
    }

    /// The composer view when its inputs changed and it differs from the
    /// one sent.
    fn composer_frame(&mut self, p: &Published) -> Option<super::ComposerView> {
        let state = p.selected.as_ref().map(|s| &s.state);
        let inputs = state.map(|s| (s.chat.key(), s.running(), s.closed));
        if let Some((shown, last_inputs, _)) = &self.composer
            && *shown == p.composer
            && *last_inputs == inputs
        {
            return None;
        }
        let view = super::composer::composer_view(&p.composer, state);
        let changed = self
            .composer
            .as_ref()
            .is_none_or(|(_, _, sent)| *sent != view);
        self.composer = Some((p.composer.clone(), inputs, view.clone()));
        changed.then_some(view)
    }

    fn selection(&mut self, s: &chats::Selected) -> SelectionFrame {
        let state = &s.state;
        let key = s.chat.key();
        let reset = self.sent.as_ref().is_none_or(|sent| sent.key != key);
        if reset {
            self.sent = None;
        }
        let header = ChatHeaderView {
            revision: state.revision,
            transcript_revision: state.transcript_revision,
            title: s.title.clone(),
            closed: state.closed,
            read_only: state.read_only(),
            has_unread_tabs: state
                .scope
                .tabs
                .iter()
                .any(|tab| tab.get("unread").is_true()),
            running: s.running,
            awaiting_input: s.awaiting_input,
            has_pending_decision: s.has_pending_decision,
            runtime_error: s.runtime_error.clone(),
            has_older: state.before.is_some(),
            total_messages: state.total_messages,
            tabs: s
                .tabs
                .iter()
                .map(|t| ChatTabView {
                    id: t.id.clone(),
                    title: t.title.clone(),
                    unread: t.unread,
                    running: t.running,
                    needs_input: t.needs_input,
                })
                .collect(),
            file_tabs: cc_domain::files::file_tabs(&state.scope.tabs)
                .into_iter()
                .map(|t| super::FileTabView {
                    project_id: s.chat.project_id.clone(),
                    worktree_id: s.chat.worktree_id.clone(),
                    id: t.id,
                    path: t.path,
                    title: t.title,
                    folder: t.folder,
                })
                .collect(),
            questions: super::composer::pending_questions(state),
        };
        let state_frame = self.state_frame(state);
        let feed = self.feed_frame(&s.feed, state.transcript_revision);
        if let Some(sent) = &mut self.sent {
            sent.key = key;
        }
        SelectionFrame {
            chat: ChatRefView {
                project_id: s.chat.project_id.clone(),
                worktree_id: s.chat.worktree_id.clone(),
                id: s.chat.id.clone(),
                title: s.chat.title.clone(),
            },
            reset,
            header,
            state: state_frame,
            feed,
        }
    }

    fn state_frame(&mut self, state: &cc_domain::chat::ChatState) -> ChatStateFrame {
        let json = |v: serde_json::Value| v.to_string();
        let scope_json = |scope: &cc_domain::chat::ScopeState| {
            let list = |maps: &[cc_domain::dart::DvMap]| {
                serde_json::Value::Array(maps.iter().map(dto::bridge_map).collect())
            };
            json(serde_json::json!({
                "tabsFile": {
                    "tabs": list(&scope.tabs),
                    "pendingQuestions": list(&scope.questions),
                    "pendingApprovals": list(&scope.approvals),
                },
                "runtimeByChatId": dto::bridge_map(&scope.runtime),
            }))
        };
        let order: Vec<u64> = state.messages.iter().map(|m| m.uid).collect();
        let sent = self.sent.as_ref();
        let tab_json =
            (sent.is_none_or(|s| s.tab != state.tab)).then(|| json(dto::bridge_map(&state.tab)));
        let runtime_json = (sent.is_none_or(|s| s.runtime != state.runtime))
            .then(|| json(dto::bridge_map(&state.runtime)));
        let scope = (sent.is_none_or(|s| s.scope != state.scope)).then(|| scope_json(&state.scope));
        let messages = state
            .messages
            .iter()
            .filter(|m| sent.is_none_or(|s| !s.raw.contains(&m.uid)))
            .map(|m| RawMessageView {
                uid: m.uid,
                json: json(dto::bridge_map(&m.raw)),
            })
            .collect();
        let order_changed = sent.is_none_or(|s| s.raw_order != order);
        let frame = ChatStateFrame {
            revision: state.revision,
            transcript_revision: state.transcript_revision,
            before: state.before,
            total_messages: state.total_messages,
            closed: state.closed,
            tab_json,
            runtime_json,
            scope_json: scope,
            messages,
            order: order_changed.then(|| order.clone()),
        };
        let sent = self.sent.get_or_insert_with(|| Sent {
            key: state.chat.key(),
            transcript_revision: state.transcript_revision,
            tab: Default::default(),
            runtime: Default::default(),
            scope: Default::default(),
            raw: HashSet::new(),
            raw_order: Vec::new(),
            feed: Arc::default(),
            messages: HashSet::new(),
            results: HashMap::new(),
        });
        sent.tab = state.tab.clone();
        sent.runtime = state.runtime.clone();
        sent.scope = state.scope.clone();
        sent.raw = order.iter().copied().collect();
        sent.raw_order = order;
        frame
    }

    fn feed_frame(&mut self, feed: &Arc<FeedSnapshot>, transcript_revision: i64) -> FeedFrame {
        let sent = self.sent.as_mut().expect("state_frame remembered");
        let prepended = sent
            .feed
            .order
            .first()
            .zip(feed.order.first())
            .is_some_and(|(a, b)| a.uid != b.uid && feed.order.len() > sent.feed.order.len());
        let fresh = sent.messages.is_empty() && sent.feed.rows.is_empty();
        let mut reset = fresh || sent.transcript_revision != transcript_revision || prepended;
        sent.transcript_revision = transcript_revision;
        if Arc::ptr_eq(&sent.feed, feed) && !reset {
            return FeedFrame {
                reset: false,
                messages: Vec::new(),
                order: None,
                results: Vec::new(),
                ops: Vec::new(),
            };
        }
        let ops = if reset {
            None
        } else {
            diff(&sent.feed.rows, &feed.rows)
        };
        let ops = match ops {
            Some(ops) if ops.len() <= MAX_OPS => ops,
            _ => {
                reset = true;
                Vec::new()
            }
        };
        if reset {
            sent.messages.clear();
            sent.results.clear();
        }
        let ops = if reset {
            let mut after = None;
            feed.rows
                .iter()
                .map(|e| {
                    let op = FeedOp::Upsert {
                        after: after.clone(),
                        item: item(e),
                    };
                    after = Some(e.key.clone());
                    op
                })
                .collect()
        } else {
            ops
        };
        // Every message a row names, once per subscriber.
        let by_uid: HashMap<u64, &Arc<Presented>> = feed.order.iter().map(|m| (m.uid, m)).collect();
        let mut messages = Vec::new();
        let mut name = |uid: u64, messages: &mut Vec<MessageView>| {
            if sent.messages.insert(uid)
                && let Some(m) = by_uid.get(&uid)
            {
                messages.push(message_view(m));
            }
        };
        for entry in &feed.rows {
            match &entry.row {
                Row::Message { uid, .. } | Row::ResponseActions { uid, .. } => {
                    name(*uid, &mut messages);
                }
                Row::Run { steps, .. } => {
                    for (uid, _) in steps {
                        name(*uid, &mut messages);
                    }
                }
                _ => {}
            }
        }
        sent.messages.retain(|uid| by_uid.contains_key(uid));
        let mut results = Vec::new();
        for (turn, (rev, entries)) in &feed.results {
            if sent.results.get(turn) != Some(rev) {
                sent.results.insert(*turn, *rev);
                results.push(ToolResultsView {
                    turn: *turn,
                    rev: *rev,
                    results: entries.iter().map(result_view).collect(),
                });
            }
        }
        sent.results
            .retain(|turn, _| feed.results.contains_key(turn));
        let order_changed = reset
            || sent.feed.order.len() != feed.order.len()
            || sent
                .feed
                .order
                .iter()
                .zip(&feed.order)
                .any(|(a, b)| a.uid != b.uid);
        let order = order_changed.then(|| {
            feed.order
                .iter()
                .map(|m| MessageRef {
                    uid: m.uid,
                    id: m.id.clone(),
                    role: m.role.map(role_view),
                    continues_turn: m.continues_turn,
                    renderable: feed::turns::renderable(m),
                })
                .collect()
        });
        sent.feed = feed.clone();
        FeedFrame {
            reset,
            messages,
            order,
            results,
            ops,
        }
    }
}

/// Ops from `old` to `new` rows; `None` when a kept row moved (a reset
/// says that more plainly).
fn diff(old: &[FeedEntry], new: &[FeedEntry]) -> Option<Vec<FeedOp>> {
    let before: HashMap<&str, (usize, &FeedEntry)> = old
        .iter()
        .enumerate()
        .map(|(i, e)| (e.key.as_str(), (i, e)))
        .collect();
    let keys: HashSet<&str> = new.iter().map(|e| e.key.as_str()).collect();
    let mut ops: Vec<FeedOp> = old
        .iter()
        .filter(|e| !keys.contains(e.key.as_str()))
        .map(|e| FeedOp::Remove { key: e.key.clone() })
        .collect();
    let mut last_kept = None;
    let mut after: Option<String> = None;
    for entry in new {
        match before.get(entry.key.as_str()) {
            Some((index, previous)) => {
                if last_kept.is_some_and(|l| *index < l) {
                    return None;
                }
                last_kept = Some(*index);
                if *previous != entry {
                    ops.push(FeedOp::Upsert {
                        after: after.clone(),
                        item: item(entry),
                    });
                }
            }
            None => ops.push(FeedOp::Upsert {
                after: after.clone(),
                item: item(entry),
            }),
        }
        after = Some(entry.key.clone());
    }
    Some(ops)
}

fn timer_view(t: &TurnTimer) -> TimerView {
    TimerView {
        started_at: t.started_at,
        paused_at: t.paused_at,
        resumed_at: t.resumed_at,
        accumulated_paused_duration_ms: t.accumulated_paused_duration_ms,
        completed_at: t.completed_at,
        end_reason: t.end_reason.clone(),
    }
}

fn category(c: StepCategory) -> StepCategoryView {
    use StepCategory as C;
    use StepCategoryView as V;
    match c {
        C::Messages => V::Messages,
        C::Thinking => V::Thinking,
        C::Bash => V::Bash,
        C::Read => V::Read,
        C::ReadLines => V::ReadLines,
        C::WriteEdit => V::WriteEdit,
        C::Plan => V::Plan,
        C::Search => V::Search,
        C::Grep => V::Grep,
        C::Web => V::Web,
        C::Agent => V::Agent,
        C::Workflow => V::Workflow,
        C::Tasks => V::Tasks,
        C::TaskStop => V::TaskStop,
        C::Skills => V::Skills,
        C::Monitor => V::Monitor,
        C::Claude => V::Claude,
        C::ScheduleWakeup => V::ScheduleWakeup,
        C::AskUser => V::AskUser,
        C::ScriptOutput => V::ScriptOutput,
        C::Watcher => V::Watcher,
        C::Canopy => V::Canopy,
        C::Graph => V::Graph,
        C::AppAdvisor => V::AppAdvisor,
        C::PipelineEditor => V::PipelineEditor,
        C::ComputerUse => V::ComputerUse,
        C::Mcp => V::Mcp,
        C::Other => V::Other,
    }
}

fn results_ref(turn: u64, rev: Option<u64>) -> ResultsRef {
    ResultsRef {
        turn,
        rev: rev.unwrap_or(0),
    }
}

#[allow(clippy::cast_possible_truncation)]
fn item(e: &FeedEntry) -> FeedItem {
    let row = match &e.row {
        Row::Message {
            uid,
            results,
            streaming_spinner,
            parts,
            ..
        } => FeedRow::Message {
            uid: *uid,
            results: results.map(|t| results_ref(t, e.results_rev)),
            streaming_spinner: *streaming_spinner,
            parts: *parts,
        },
        Row::Run {
            key,
            steps,
            shown_from,
            expanded,
            results,
            anchor_message_id,
        } => FeedRow::Run {
            run_key: key.clone(),
            steps: steps
                .iter()
                .map(|(uid, index)| StepRef {
                    uid: *uid,
                    index: *index as u32,
                })
                .collect(),
            shown_from: *shown_from as u32,
            expanded: *expanded,
            results: results_ref(*results, e.results_rev),
            anchor_message_id: anchor_message_id.clone(),
        },
        Row::Steps {
            turn_key,
            counts,
            expanded,
            timer,
        } => FeedRow::Steps {
            turn_key: turn_key.clone(),
            counts: counts
                .iter()
                .map(|(c, n)| StepCountView {
                    category: category(*c),
                    count: *n,
                })
                .collect(),
            expanded: *expanded,
            timer: timer.as_ref().map(timer_view),
        },
        Row::Timer { turn_key, timer } => FeedRow::Timer {
            turn_key: turn_key.clone(),
            timer: timer.as_ref().map(timer_view),
        },
        Row::TurnFooter { turn_key } => FeedRow::TurnFooter {
            turn_key: turn_key.clone(),
        },
        Row::ResponseActions {
            uid,
            turn_key,
            at_message_id,
        } => FeedRow::ResponseActions {
            uid: *uid,
            turn_key: turn_key.clone(),
            at_message_id: at_message_id.clone(),
        },
    };
    FeedItem {
        key: e.key.clone(),
        keyed: e.keyed,
        row,
    }
}

fn result_view(r: &ToolResult) -> ToolResultView {
    ToolResultView {
        tool_use_id: r.tool_use_id.clone(),
        content: r
            .content
            .clone()
            .unwrap_or_else(|| copy::text(CopyKey::ToolError).into()),
        is_error: r.is_error,
    }
}

fn role_view(role: feed::Role) -> ChatRole {
    match role {
        feed::Role::User => ChatRole::User,
        feed::Role::Assistant => ChatRole::Assistant,
        feed::Role::System => ChatRole::System,
    }
}

fn message_view(m: &Presented) -> MessageView {
    MessageView {
        uid: m.uid,
        id: m.id.clone(),
        role: m.role.map(role_view),
        status: match m.status {
            feed::Status::Streaming => MessageStatus::Streaming,
            feed::Status::Complete => MessageStatus::Complete,
            feed::Status::Failed => MessageStatus::Failed,
            feed::Status::Cancelled => MessageStatus::Cancelled,
        },
        text: m.text.clone(),
        watcher_fired: m.watcher_fired.as_ref().map(|w| WatcherFiredView {
            kind: w.kind.clone(),
            combined: w.combined.as_ref().map(|c| {
                c.iter()
                    .map(|(kind, text)| WatcherEntryView {
                        kind: kind.clone(),
                        text: text.clone(),
                    })
                    .collect()
            }),
        }),
        attachments: m
            .attachments
            .iter()
            .map(|a| AttachmentView {
                id: a.id.clone(),
                filename: a.filename.clone(),
                media_type: a.media_type.clone(),
            })
            .collect(),
        occurred_at_ms: m.occurred_at_ms,
        continues_turn: m.continues_turn,
        parts: m
            .parts
            .iter()
            .map(|p| PartView {
                kind: p.kind.clone(),
                tool_family: p.tool_family.clone(),
                data_json: p.data.as_ref().map(|d| dto::bridge_map(d).to_string()),
            })
            .collect(),
    }
}

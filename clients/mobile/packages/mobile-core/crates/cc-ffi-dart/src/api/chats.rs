//! One computer's chat read path (P5a) and writes (P5b): the selected chat's desktop
//! state, cache, hydration, revision recovery, older pages, read receipts
//! and tab archive, and its feed grouped in the core. [`ChatsService::watch`]
//! streams frames (at most one per 33 ms: the header whole, the feed as
//! keyed ops); intents are queued in call order and each variant of
//! [`ChatIntent`] says when it settles.
use super::{core::CoreFailure, handler, overview::ChatRefView};
use crate::frb_generated::StreamSink;
use flutter_rust_bridge::frb;

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
    /// Archives an open tab and reconciles the selected chat.
    CloseTab { id: String },
    /// Re-reads the chat if it is still selected in this generation.
    Refresh { chat: ChatRefView, generation: u64 },
    /// Rehydrates a retained selection after a successful catalog read,
    /// then restores the composer and resumes activity and pipelines.
    RestoreConnection { catalog_loaded: bool },
    /// Tracks successful turns while the host observes this chat.
    TrackTurns { enabled: bool },
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
    /// Cancels the supplied chat’s turn if it is still selected.
    /// The actor refreshes the selection after acknowledgement.
    Stop { chat: ChatRefView },
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
        pick: super::composer::SettingsPick,
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
        source: super::composer::ComposerSource,
        scope: super::composer::SourceScopeView,
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
    Opened { selected: bool, generation: u64 },
    /// The computer accepted the send, or may have (`accepted: false`).
    Sent { accepted: bool },
    /// A chat or tab was created; the host opens it.
    Created { chat: ChatRefView },
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
        commands: Vec<super::composer::CommandRowView>,
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
    pub file_tabs: Vec<super::files::FileTabView>,
    pub has_messages: bool,
    pub model: Option<String>,
    pub execution_harness: Option<String>,
    pub provider_type: Option<String>,
    pub terminal_mode: bool,
    pub plugin_selections_revision: u64,
    pub plugin_selection_count: Option<u32>,
    pub feedback_turns: Vec<FeedbackTurnView>,
    pub feedback_seeds: Vec<FeedbackSeedView>,
    /// The chat's pending questions (P5c).
    pub questions: Vec<super::composer::QuestionView>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedbackTurnView {
    pub footer: String,
    pub turn: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedbackSeedView {
    pub turn: String,
    pub rating: String,
    pub sync_state: Option<String>,
    pub feedback_id: Option<String>,
    pub reason: Option<String>,
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
    pub feed: FeedFrame,
}

/// One frame of the read path.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatFrame {
    /// The snapshot revision this frame shows.
    pub revision: u64,
    pub generation: u64,
    pub connected: bool,
    pub activity_connected: bool,
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
    pub successful_turns: Vec<String>,
    /// Drafts changed since this subscriber's previous frame (all on the
    /// first frame).
    pub drafts: Vec<DraftView>,
    /// The host's last `ChatIntent::SetDraft` `seq` applied.
    pub draft_seq: u64,
    /// The composer, when it changed since this subscriber's previous
    /// frame (always on the first).
    pub composer: Option<super::composer::ComposerView>,
}

impl From<cc_core::ChatFailure> for ChatFailure {
    fn from(v: cc_core::ChatFailure) -> Self {
        Self {
            message: v.message,
            kind: match v.kind {
                cc_core::ChatFailureKind::Link => ChatFailureKind::Link,
                cc_core::ChatFailureKind::Refused => ChatFailureKind::Refused,
                cc_core::ChatFailureKind::NotSent => ChatFailureKind::NotSent,
                cc_core::ChatFailureKind::CreationNotSent => ChatFailureKind::CreationNotSent,
                cc_core::ChatFailureKind::Other => ChatFailureKind::Other,
            },
            code: v.code,
        }
    }
}

impl From<cc_core::PendingSendView> for PendingSendView {
    fn from(v: cc_core::PendingSendView) -> Self {
        Self {
            chat: v.chat.into(),
            id: v.id,
            text: v.text,
            dictated: v.dictated,
            attachment_paths: v.attachment_paths,
        }
    }
}

impl From<cc_core::ChatOutcome> for ChatOutcome {
    fn from(v: cc_core::ChatOutcome) -> Self {
        match v {
            cc_core::ChatOutcome::Opened {
                selected,
                generation,
            } => Self::Opened {
                selected,
                generation,
            },
            cc_core::ChatOutcome::Sent { accepted } => Self::Sent { accepted },
            cc_core::ChatOutcome::Created { chat } => Self::Created { chat: chat.into() },
            cc_core::ChatOutcome::Stored {
                filename,
                path,
                size,
            } => Self::Stored {
                filename,
                path,
                size,
            },
            cc_core::ChatOutcome::Changed { applied } => Self::Changed { applied },
            cc_core::ChatOutcome::Saved { revision } => Self::Saved { revision },
            cc_core::ChatOutcome::Forked { chat } => Self::Forked { chat: chat.into() },
            cc_core::ChatOutcome::Inventory {
                commands,
                unsettled,
            } => Self::Inventory {
                commands: commands.into_iter().map(Into::into).collect(),
                unsettled,
            },
            cc_core::ChatOutcome::PluginCatalog { json } => Self::PluginCatalog { json },
            cc_core::ChatOutcome::Selections { json } => Self::Selections { json },
        }
    }
}

impl From<cc_core::DraftView> for DraftView {
    fn from(v: cc_core::DraftView) -> Self {
        Self {
            key: v.key,
            text: v.text,
        }
    }
}

impl From<cc_core::ChatSettled> for ChatSettled {
    fn from(v: cc_core::ChatSettled) -> Self {
        Self {
            revision: v.revision,
            failure: v.failure.map(|x| x.into()),
            outcome: v.outcome.map(|x| x.into()),
        }
    }
}

impl From<cc_core::ChatTabView> for ChatTabView {
    fn from(v: cc_core::ChatTabView) -> Self {
        Self {
            id: v.id,
            title: v.title,
            unread: v.unread,
            running: v.running,
            needs_input: v.needs_input,
        }
    }
}

impl From<cc_core::ChatHeaderView> for ChatHeaderView {
    fn from(v: cc_core::ChatHeaderView) -> Self {
        Self {
            revision: v.revision,
            transcript_revision: v.transcript_revision,
            title: v.title,
            closed: v.closed,
            read_only: v.read_only,
            has_unread_tabs: v.has_unread_tabs,
            running: v.running,
            awaiting_input: v.awaiting_input,
            has_pending_decision: v.has_pending_decision,
            runtime_error: v.runtime_error,
            has_older: v.has_older,
            total_messages: v.total_messages,
            tabs: v.tabs.into_iter().map(|x| x.into()).collect(),
            file_tabs: v.file_tabs.into_iter().map(Into::into).collect(),
            has_messages: v.has_messages,
            model: v.model,
            execution_harness: v.execution_harness,
            provider_type: v.provider_type,
            terminal_mode: v.terminal_mode,
            plugin_selections_revision: v.plugin_selections_revision,
            plugin_selection_count: v.plugin_selection_count,
            feedback_turns: v
                .feedback_turns
                .into_iter()
                .map(|turn| FeedbackTurnView {
                    footer: turn.footer,
                    turn: turn.turn,
                })
                .collect(),
            feedback_seeds: v
                .feedback_seeds
                .into_iter()
                .map(|seed| FeedbackSeedView {
                    turn: seed.turn,
                    rating: seed.rating,
                    sync_state: seed.sync_state,
                    feedback_id: seed.feedback_id,
                    reason: seed.reason,
                })
                .collect(),
            questions: v.questions.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::WatcherEntryView> for WatcherEntryView {
    fn from(v: cc_core::WatcherEntryView) -> Self {
        Self {
            kind: v.kind,
            text: v.text,
        }
    }
}

impl From<cc_core::WatcherFiredView> for WatcherFiredView {
    fn from(v: cc_core::WatcherFiredView) -> Self {
        Self {
            kind: v.kind,
            combined: v
                .combined
                .map(|x| x.into_iter().map(|x| x.into()).collect()),
        }
    }
}

impl From<cc_core::AttachmentView> for AttachmentView {
    fn from(v: cc_core::AttachmentView) -> Self {
        Self {
            id: v.id,
            filename: v.filename,
            media_type: v.media_type,
        }
    }
}

impl From<cc_core::PartView> for PartView {
    fn from(v: cc_core::PartView) -> Self {
        Self {
            kind: v.kind,
            tool_family: v.tool_family,
            data_json: v.data_json,
        }
    }
}

impl From<cc_core::MessageView> for MessageView {
    fn from(v: cc_core::MessageView) -> Self {
        Self {
            uid: v.uid,
            id: v.id,
            role: v.role.map(|x| x.into()),
            status: v.status.into(),
            text: v.text,
            watcher_fired: v.watcher_fired.map(|x| x.into()),
            attachments: v.attachments.into_iter().map(|x| x.into()).collect(),
            occurred_at_ms: v.occurred_at_ms,
            continues_turn: v.continues_turn,
            parts: v.parts.into_iter().map(|x| x.into()).collect(),
        }
    }
}

impl From<cc_core::MessageRef> for MessageRef {
    fn from(v: cc_core::MessageRef) -> Self {
        Self {
            uid: v.uid,
            id: v.id,
            role: v.role.map(|x| x.into()),
            continues_turn: v.continues_turn,
            renderable: v.renderable,
        }
    }
}

impl From<cc_core::ToolResultView> for ToolResultView {
    fn from(v: cc_core::ToolResultView) -> Self {
        Self {
            tool_use_id: v.tool_use_id,
            content: v.content,
            is_error: v.is_error,
        }
    }
}

impl From<cc_core::ToolResultsView> for ToolResultsView {
    fn from(v: cc_core::ToolResultsView) -> Self {
        Self {
            turn: v.turn,
            rev: v.rev,
            results: v.results.into_iter().map(|x| x.into()).collect(),
        }
    }
}

impl From<cc_core::ResultsRef> for ResultsRef {
    fn from(v: cc_core::ResultsRef) -> Self {
        Self {
            turn: v.turn,
            rev: v.rev,
        }
    }
}

impl From<cc_core::TimerView> for TimerView {
    fn from(v: cc_core::TimerView) -> Self {
        Self {
            started_at: v.started_at,
            paused_at: v.paused_at,
            resumed_at: v.resumed_at,
            accumulated_paused_duration_ms: v.accumulated_paused_duration_ms,
            completed_at: v.completed_at,
            end_reason: v.end_reason,
        }
    }
}

impl From<cc_core::StepCountView> for StepCountView {
    fn from(v: cc_core::StepCountView) -> Self {
        Self {
            category: v.category.into(),
            count: v.count,
        }
    }
}

impl From<cc_core::StepRef> for StepRef {
    fn from(v: cc_core::StepRef) -> Self {
        Self {
            uid: v.uid,
            index: v.index,
        }
    }
}

impl From<cc_core::FeedItem> for FeedItem {
    fn from(v: cc_core::FeedItem) -> Self {
        Self {
            key: v.key,
            keyed: v.keyed,
            row: v.row.into(),
        }
    }
}

impl From<cc_core::FeedFrame> for FeedFrame {
    fn from(v: cc_core::FeedFrame) -> Self {
        Self {
            reset: v.reset,
            messages: v.messages.into_iter().map(|x| x.into()).collect(),
            order: v.order.map(|x| x.into_iter().map(|x| x.into()).collect()),
            results: v.results.into_iter().map(|x| x.into()).collect(),
            ops: v.ops.into_iter().map(|x| x.into()).collect(),
        }
    }
}

impl From<cc_core::SelectionFrame> for SelectionFrame {
    fn from(v: cc_core::SelectionFrame) -> Self {
        Self {
            chat: v.chat.into(),
            reset: v.reset,
            header: v.header.into(),
            feed: v.feed.into(),
        }
    }
}

impl From<cc_core::ChatFrame> for ChatFrame {
    fn from(v: cc_core::ChatFrame) -> Self {
        Self {
            revision: v.revision,
            generation: v.generation,
            connected: v.connected,
            activity_connected: v.activity_connected,
            loading: v.loading,
            loading_older: v.loading_older,
            hydrating: v.hydrating,
            ready: v.ready,
            error: v.error,
            error_revision: v.error_revision,
            selected: v.selected.map(|x| x.into()),
            sending: v.sending,
            pending_send: v.pending_send.map(|x| x.into()),
            confirmed_send: v.confirmed_send.map(|x| x.into()),
            successful_turns: v.successful_turns,
            drafts: v.drafts.into_iter().map(|x| x.into()).collect(),
            draft_seq: v.draft_seq,
            composer: v.composer.map(Into::into),
        }
    }
}

impl From<ChatIntent> for cc_core::ChatIntent {
    fn from(v: ChatIntent) -> Self {
        match v {
            ChatIntent::SetConnected {
                connected,
                generation,
            } => Self::SetConnected {
                connected,
                generation,
            },
            ChatIntent::Open { chat, generation } => Self::Open {
                chat: chat.into(),
                generation,
            },
            ChatIntent::LoadOlder => Self::LoadOlder,
            ChatIntent::Leave {
                expected,
                generation,
            } => Self::Leave {
                expected,
                generation,
            },
            ChatIntent::ToggleTurn { key } => Self::ToggleTurn { key },
            ChatIntent::SetFooterTurns { keys } => Self::SetFooterTurns { keys },
            ChatIntent::SetReadReceipts { enabled } => Self::SetReadReceipts { enabled },
            ChatIntent::InvalidateReadReceipts => Self::InvalidateReadReceipts,
            ChatIntent::RetryReadReceipts => Self::RetryReadReceipts,
            ChatIntent::CloseTab { id } => Self::CloseTab { id },
            ChatIntent::Refresh { chat, generation } => Self::Refresh {
                chat: chat.into(),
                generation,
            },
            ChatIntent::RestoreConnection { catalog_loaded } => {
                Self::RestoreConnection { catalog_loaded }
            }
            ChatIntent::TrackTurns { enabled } => Self::TrackTurns { enabled },
            ChatIntent::Close => Self::Close,
            ChatIntent::Send {
                chat,
                text,
                retry,
                dictated,
                attachment_paths,
            } => Self::Send {
                chat: chat.map(Into::into),
                text,
                retry,
                dictated,
                attachment_paths,
            },
            ChatIntent::Stop { chat } => Self::Stop { chat: chat.into() },
            ChatIntent::CreateChat {
                workspace_id,
                title,
            } => Self::CreateChat {
                workspace_id,
                title,
            },
            ChatIntent::CreateTab {
                project_id,
                worktree_id,
            } => Self::CreateTab {
                project_id,
                worktree_id,
            },
            ChatIntent::SetWorkspaces { ids } => Self::SetWorkspaces { ids },
            ChatIntent::SetDraft { chat, text, seq } => Self::SetDraft {
                chat: chat.into(),
                text,
                seq,
            },
            ChatIntent::ClearSentDraft { chat, text } => Self::ClearSentDraft {
                chat: chat.into(),
                text,
            },
            ChatIntent::ImportAttachment {
                scope,
                filename,
                bytes,
            } => Self::ImportAttachment {
                scope: scope.into(),
                filename,
                bytes,
            },
            ChatIntent::DeleteAttachment { scope, filename } => Self::DeleteAttachment {
                scope: scope.into(),
                filename,
            },
            ChatIntent::EnableComposer => Self::EnableComposer,
            ChatIntent::LoadSettings { report } => Self::LoadSettings { report },
            ChatIntent::SyncSettings {
                chat,
                model_json,
                harness_json,
                running,
            } => Self::SyncSettings {
                chat: chat.into(),
                model_json,
                harness_json,
                running,
            },
            ChatIntent::InvalidateSettings => Self::InvalidateSettings,
            ChatIntent::ChangeSetting { chat, pick } => Self::ChangeSetting {
                chat: chat.into(),
                pick: pick.into(),
            },
            ChatIntent::InvalidatePicks => Self::InvalidatePicks,
            ChatIntent::SelectModel {
                chat,
                id,
                provider,
                harness,
            } => Self::SelectModel {
                chat: chat.into(),
                id,
                provider,
                harness,
            },
            ChatIntent::PatchSettings { chat, patch_json } => Self::PatchSettings {
                chat: chat.into(),
                patch_json,
            },
            ChatIntent::Answer {
                chat,
                request_id,
                answers_json,
            } => Self::Answer {
                chat: chat.into(),
                request_id,
                answers_json,
            },
            ChatIntent::DismissQuestion { chat, request_id } => Self::DismissQuestion {
                chat: chat.into(),
                request_id,
            },
            ChatIntent::Fork {
                chat,
                at_message_id,
            } => Self::Fork {
                chat: chat.into(),
                at_message_id,
            },
            ChatIntent::ForkOpened {
                chat,
                at_message_id,
            } => Self::ForkOpened {
                chat: chat.into(),
                at_message_id,
            },
            ChatIntent::LoadComposerSource { source, scope } => Self::LoadComposerSource {
                source: source.into(),
                scope: scope.into(),
            },
        }
    }
}

impl From<cc_core::ChatRole> for ChatRole {
    fn from(v: cc_core::ChatRole) -> Self {
        match v {
            cc_core::ChatRole::User => Self::User,
            cc_core::ChatRole::Assistant => Self::Assistant,
            cc_core::ChatRole::System => Self::System,
        }
    }
}

impl From<cc_core::MessageStatus> for MessageStatus {
    fn from(v: cc_core::MessageStatus) -> Self {
        match v {
            cc_core::MessageStatus::Streaming => Self::Streaming,
            cc_core::MessageStatus::Complete => Self::Complete,
            cc_core::MessageStatus::Failed => Self::Failed,
            cc_core::MessageStatus::Cancelled => Self::Cancelled,
        }
    }
}

impl From<cc_core::StepCategoryView> for StepCategoryView {
    fn from(v: cc_core::StepCategoryView) -> Self {
        match v {
            cc_core::StepCategoryView::Messages => Self::Messages,
            cc_core::StepCategoryView::Thinking => Self::Thinking,
            cc_core::StepCategoryView::Bash => Self::Bash,
            cc_core::StepCategoryView::Read => Self::Read,
            cc_core::StepCategoryView::ReadLines => Self::ReadLines,
            cc_core::StepCategoryView::WriteEdit => Self::WriteEdit,
            cc_core::StepCategoryView::Plan => Self::Plan,
            cc_core::StepCategoryView::Search => Self::Search,
            cc_core::StepCategoryView::Grep => Self::Grep,
            cc_core::StepCategoryView::Web => Self::Web,
            cc_core::StepCategoryView::Agent => Self::Agent,
            cc_core::StepCategoryView::Workflow => Self::Workflow,
            cc_core::StepCategoryView::Tasks => Self::Tasks,
            cc_core::StepCategoryView::TaskStop => Self::TaskStop,
            cc_core::StepCategoryView::Skills => Self::Skills,
            cc_core::StepCategoryView::Monitor => Self::Monitor,
            cc_core::StepCategoryView::Claude => Self::Claude,
            cc_core::StepCategoryView::ScheduleWakeup => Self::ScheduleWakeup,
            cc_core::StepCategoryView::AskUser => Self::AskUser,
            cc_core::StepCategoryView::ScriptOutput => Self::ScriptOutput,
            cc_core::StepCategoryView::Watcher => Self::Watcher,
            cc_core::StepCategoryView::Canopy => Self::Canopy,
            cc_core::StepCategoryView::Graph => Self::Graph,
            cc_core::StepCategoryView::AppAdvisor => Self::AppAdvisor,
            cc_core::StepCategoryView::PipelineEditor => Self::PipelineEditor,
            cc_core::StepCategoryView::ComputerUse => Self::ComputerUse,
            cc_core::StepCategoryView::Mcp => Self::Mcp,
            cc_core::StepCategoryView::Other => Self::Other,
        }
    }
}

impl From<cc_core::FeedRow> for FeedRow {
    fn from(v: cc_core::FeedRow) -> Self {
        match v {
            cc_core::FeedRow::Message {
                uid,
                results,
                streaming_spinner,
                parts,
            } => Self::Message {
                uid,
                results: results.map(|x| x.into()),
                streaming_spinner,
                parts,
            },
            cc_core::FeedRow::Run {
                run_key,
                steps,
                shown_from,
                expanded,
                results,
                anchor_message_id,
            } => Self::Run {
                run_key,
                steps: steps.into_iter().map(|x| x.into()).collect(),
                shown_from,
                expanded,
                results: results.into(),
                anchor_message_id,
            },
            cc_core::FeedRow::Steps {
                turn_key,
                counts,
                expanded,
                timer,
            } => Self::Steps {
                turn_key,
                counts: counts.into_iter().map(|x| x.into()).collect(),
                expanded,
                timer: timer.map(|x| x.into()),
            },
            cc_core::FeedRow::Timer { turn_key, timer } => Self::Timer {
                turn_key,
                timer: timer.map(|x| x.into()),
            },
            cc_core::FeedRow::TurnFooter { turn_key } => Self::TurnFooter { turn_key },
            cc_core::FeedRow::ResponseActions {
                uid,
                turn_key,
                at_message_id,
            } => Self::ResponseActions {
                uid,
                turn_key,
                at_message_id,
            },
        }
    }
}

impl From<cc_core::FeedOp> for FeedOp {
    fn from(v: cc_core::FeedOp) -> Self {
        match v {
            cc_core::FeedOp::Upsert { after, item } => Self::Upsert {
                after,
                item: item.into(),
            },
            cc_core::FeedOp::Remove { key } => Self::Remove { key },
        }
    }
}

impl From<ChatRefView> for cc_core::ChatRefView {
    fn from(v: ChatRefView) -> Self {
        Self {
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            id: v.id,
            title: v.title,
        }
    }
}

/// One computer's chat read path. Built by `AccountService.chats`.
#[frb(opaque)]
#[derive(Clone)]
pub struct ChatsService {
    pub(crate) inner: cc_core::ChatsService,
}

impl ChatsService {
    pub(crate) fn new(inner: cc_core::ChatsService) -> Self {
        Self { inner }
    }
    /// The computer's worktree activity and changed-file diffs (P6),
    /// whose chat todos follow this read path's selection. Each lives
    /// until its `ActivityIntent.close`.
    #[frb(sync)]
    pub fn activity(&self) -> super::activity::ActivityService {
        super::activity::ActivityService::new(self.inner.activity())
    }
    /// The computer's pipelines and the work drawers of its mounted chats
    /// (P7), whose feed panels and drawers follow this read path's chat.
    /// Each lives until its `PipelinesIntent.close`.
    #[frb(sync)]
    pub fn pipelines(&self) -> super::pipelines::PipelinesService {
        super::pipelines::PipelinesService::new(self.inner.pipelines())
    }
    /// The files this read path's chats have open (P6), read on its
    /// surface: the Orchestrator chat's on `app-advisor`.
    #[frb(sync)]
    pub fn files(&self) -> super::files::FilesService {
        super::files::FilesService::new(self.inner.files())
    }
    /// The current state as a full frame, then changes, at most one frame
    /// per 33 ms.
    pub fn watch(&self, sink: StreamSink<ChatFrame>) {
        let mut frames = self.inner.watch();
        handler::runtime().spawn(async move {
            while let Some(frame) = frames.next().await {
                if sink.add(frame.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// Queues `intent`; its outcome is not reported.
    #[frb(sync)]
    pub fn send(&self, intent: ChatIntent) {
        self.inner.send(intent.into());
    }
    /// Queues `intent` and returns the ticket `settled` takes.
    #[frb(sync)]
    pub fn request(&self, intent: ChatIntent) -> u64 {
        self.inner.request(intent.into())
    }
    /// The outcome of a requested intent; frames from its `revision` on
    /// show it. Fails when the core shut down, and `account_changed` once
    /// the account the service was opened in was left, also while the
    /// intent ran.
    pub async fn settled(&self, ticket: u64) -> Result<ChatSettled, CoreFailure> {
        self.inner
            .settled(ticket)
            .await
            .map(Into::into)
            .map_err(Into::into)
    }
}

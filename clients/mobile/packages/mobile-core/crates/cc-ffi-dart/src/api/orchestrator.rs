//! One computer's Orchestrator (P9): its work entries, the tool requests it
//! shows as questions, the window state the desktop sees, and its chat on
//! the `app-advisor` surface ([`OrchestratorService::chats`]). Requests the
//! phone cannot show are refused inside the core. Intents are queued in
//! call order and each variant of [`OrchestratorIntent`] says when it
//! settles.
use super::{
    chats::{ChatFailure, ChatsService},
    composer::{QuestionAnswerView, QuestionView},
    core::CoreFailure,
    handler,
    overview::{CatalogView, CatalogWorkspaceView, ChatRefView},
};
use crate::frb_generated::StreamSink;
use flutter_rust_bridge::frb;

/// A work entry as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrchestratorEntryView {
    pub id: String,
    pub title: String,
    /// The entry's live chats from the search index: identities only,
    /// never permission to create a tab.
    pub chats: Vec<ChatRefView>,
    pub running: bool,
    pub unread: bool,
}

/// A tool request the desktop asks the user to answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolQuestionView {
    pub chat_id: String,
    pub question: QuestionView,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrchestratorView {
    pub revision: u64,
    /// In the desktop's registry order.
    pub entries: Vec<OrchestratorEntryView>,
    /// Pending questions in arrival order.
    pub questions: Vec<ToolQuestionView>,
    /// Bumped when pushes call for a fresh list; the host refreshes then.
    pub refreshes: u64,
}

/// An Orchestrator intent. Each variant's doc ends with when it resolves.
#[derive(Debug, Clone, PartialEq)]
pub enum OrchestratorIntent {
    /// The host's chat model went online or offline. Online acknowledges
    /// the renderer (so the desktop redelivers pending requests), sends the
    /// window state and claims the entries' scopes; offline forgets the
    /// questions and the claimed list.
    ///
    /// Resolves when applied.
    SetOnline { online: bool },
    /// Whether the Orchestrator shows; the desktop sees it as its window
    /// state.
    ///
    /// Resolves when applied: `Visible{refresh}`, whether the host
    /// refreshes the list now.
    SetVisible { visible: bool },
    /// Reads the work entries and the chat catalog (the chat model's
    /// catalog reader).
    ///
    /// Resolves when settled: `Catalog`, or `Failed` with what Dart threw.
    ReadCatalog,
    /// The host's catalog is not loading: a new list claims its scopes.
    ///
    /// Resolves when applied.
    CatalogShown,
    /// Claims the listed entries' scopes, unless a chat is open.
    ///
    /// Resolves when settled: the write finished.
    WatchEntries,
    /// Starts opening `entry_id` (`None`: a new chat). Reads the entry's
    /// active tab first.
    ///
    /// Resolves when settled: what the host opens next.
    Enter { entry_id: Option<String> },
    /// The host's open of `generation` finished.
    ///
    /// Resolves when applied: `Entered{opened}`, whether the chat stays.
    Entered { generation: u64, opened: bool },
    /// The chat was left.
    ///
    /// Resolves when applied.
    Leave,
    /// Answers a pending question with exactly one answer.
    ///
    /// Resolves when settled: `Done` once the desktop took it, or `Failed`.
    Answer {
        chat_id: String,
        request_id: String,
        answers: Vec<QuestionAnswerView>,
    },
    /// Dismisses a pending question.
    ///
    /// Resolves when settled: `Done` once the desktop took it, or `Failed`.
    Dismiss { chat_id: String, request_id: String },
    /// Stops the service.
    ///
    /// Resolves when applied.
    Close,
}

/// A requested intent's outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrchestratorOutcome {
    Visible {
        refresh: bool,
    },
    Catalog {
        catalog: CatalogView,
    },
    /// Already in a chat.
    Busy,
    /// Open `chat`, the entry's active tab.
    Open {
        chat: ChatRefView,
        generation: u64,
    },
    /// Create a chat in `workspace`.
    NewChat {
        workspace: CatalogWorkspaceView,
        generation: u64,
    },
    /// Create a tab in entry `entry_id`; `failure` is what a failed
    /// creation shows.
    NewTab {
        entry_id: String,
        generation: u64,
        failure: String,
    },
    /// The entry could not be read; show `message`.
    LoadFailed {
        message: String,
    },
    /// The connection changed meanwhile.
    Stale,
    Entered {
        opened: bool,
    },
    Failed {
        failure: ChatFailure,
    },
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrchestratorSettled {
    pub revision: u64,
    pub outcome: OrchestratorOutcome,
}

impl From<cc_core::OrchestratorEntryView> for OrchestratorEntryView {
    fn from(v: cc_core::OrchestratorEntryView) -> Self {
        Self {
            id: v.id,
            title: v.title,
            chats: v.chats.into_iter().map(Into::into).collect(),
            running: v.running,
            unread: v.unread,
        }
    }
}

impl From<cc_core::ToolQuestionView> for ToolQuestionView {
    fn from(v: cc_core::ToolQuestionView) -> Self {
        Self {
            chat_id: v.chat_id,
            question: v.question.into(),
        }
    }
}

impl From<cc_core::OrchestratorView> for OrchestratorView {
    fn from(v: cc_core::OrchestratorView) -> Self {
        Self {
            revision: v.revision,
            entries: v.entries.into_iter().map(Into::into).collect(),
            questions: v.questions.into_iter().map(Into::into).collect(),
            refreshes: v.refreshes,
        }
    }
}

impl From<OrchestratorIntent> for cc_core::OrchestratorIntent {
    fn from(v: OrchestratorIntent) -> Self {
        use OrchestratorIntent as I;
        match v {
            I::SetOnline { online } => Self::SetOnline { online },
            I::SetVisible { visible } => Self::SetVisible { visible },
            I::ReadCatalog => Self::ReadCatalog,
            I::CatalogShown => Self::CatalogShown,
            I::WatchEntries => Self::WatchEntries,
            I::Enter { entry_id } => Self::Enter { entry_id },
            I::Entered { generation, opened } => Self::Entered { generation, opened },
            I::Leave => Self::Leave,
            I::Answer {
                chat_id,
                request_id,
                answers,
            } => Self::Answer {
                chat_id,
                request_id,
                answers: answers.into_iter().map(Into::into).collect(),
            },
            I::Dismiss {
                chat_id,
                request_id,
            } => Self::Dismiss {
                chat_id,
                request_id,
            },
            I::Close => Self::Close,
        }
    }
}

impl From<cc_core::OrchestratorOutcome> for OrchestratorOutcome {
    fn from(v: cc_core::OrchestratorOutcome) -> Self {
        use cc_core::OrchestratorOutcome as O;
        match v {
            O::Visible { refresh } => Self::Visible { refresh },
            O::Catalog { catalog } => Self::Catalog {
                catalog: catalog.into(),
            },
            O::Busy => Self::Busy,
            O::Open { chat, generation } => Self::Open {
                chat: chat.into(),
                generation,
            },
            O::NewChat {
                workspace,
                generation,
            } => Self::NewChat {
                workspace: workspace.into(),
                generation,
            },
            O::NewTab {
                entry_id,
                generation,
                failure,
            } => Self::NewTab {
                entry_id,
                generation,
                failure,
            },
            O::LoadFailed { message } => Self::LoadFailed { message },
            O::Stale => Self::Stale,
            O::Entered { opened } => Self::Entered { opened },
            O::Failed { failure } => Self::Failed {
                failure: failure.into(),
            },
            O::Done => Self::Done,
        }
    }
}

/// One computer's Orchestrator. Built by `AccountService.orchestrator`.
#[frb(opaque)]
#[derive(Clone)]
pub struct OrchestratorService {
    inner: cc_core::OrchestratorService,
}

impl OrchestratorService {
    pub(crate) fn new(inner: cc_core::OrchestratorService) -> Self {
        Self { inner }
    }
    /// The Orchestrator chat's read path, writes and composer, on the
    /// `app-advisor` surface. It lives until its `ChatIntent.close`.
    #[frb(sync)]
    pub fn chats(&self) -> ChatsService {
        ChatsService::new(self.inner.chats())
    }
    /// The view now, then every change (latest wins).
    pub fn watch(&self, sink: StreamSink<OrchestratorView>) {
        let mut views = self.inner.watch();
        handler::runtime().spawn(async move {
            while let Some(view) = views.next().await {
                if sink.add(view.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// Queues `intent`; its outcome is not reported.
    #[frb(sync)]
    pub fn send(&self, intent: OrchestratorIntent) {
        self.inner.send(intent.into());
    }
    /// Queues `intent` and returns the ticket `settled` takes.
    #[frb(sync)]
    pub fn request(&self, intent: OrchestratorIntent) -> u64 {
        self.inner.request(intent.into())
    }
    /// The outcome of a requested intent. Fails when the core shut down,
    /// and `account_changed` once the account the service was opened in
    /// was left, also while the intent ran.
    pub async fn settled(&self, ticket: u64) -> Result<OrchestratorSettled, CoreFailure> {
        self.inner
            .settled(ticket)
            .await
            .map(|s| OrchestratorSettled {
                revision: s.revision,
                outcome: s.outcome.into(),
            })
            .map_err(Into::into)
    }
}

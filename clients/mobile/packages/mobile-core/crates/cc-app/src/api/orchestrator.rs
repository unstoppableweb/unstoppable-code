//! `OrchestratorService` (P9): one computer's Orchestrator. Its work
//! entries, the tool requests it shows as questions, the window state the
//! desktop sees, and its chat, which runs on [`ChatsService`] over the
//! `app-advisor` surface. Intents queue in call order; `request` returns a
//! ticket whose outcome `settled` reports.
use super::{
    CatalogView, CatalogWorkspaceView, ChatFailure, ChatRefView, ChatsService, CoreFailure,
    QuestionAnswerView, QuestionView,
};
use crate::{
    account::View,
    api::{CoreInner, chats::failure_view},
    orchestrator::{Entering, Handle, Intent, Outcome, Published},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;

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

type Tickets = (
    u64,
    HashMap<u64, oneshot::Receiver<crate::orchestrator::Settled>>,
);

/// One computer's Orchestrator. Built by `AccountService::orchestrator`.
#[derive(Clone)]
pub struct OrchestratorService {
    inner: Arc<CoreInner>,
    handle: Handle,
    chats: ChatsService,
    tickets: Arc<Mutex<Tickets>>,
}

fn chat_view(c: &cc_domain::overview::ChatRef) -> ChatRefView {
    ChatRefView {
        project_id: c.project_id.clone(),
        worktree_id: c.worktree_id.clone(),
        id: c.id.clone(),
        title: c.title.clone(),
    }
}

fn view(p: &Published) -> OrchestratorView {
    OrchestratorView {
        revision: p.revision,
        entries: p
            .entries
            .iter()
            .map(|e| OrchestratorEntryView {
                id: e.id.clone(),
                title: e.title.clone(),
                chats: e.chats.iter().map(chat_view).collect(),
                running: e.running,
                unread: e.unread,
            })
            .collect(),
        questions: p
            .questions
            .iter()
            .map(|q| ToolQuestionView {
                chat_id: q.chat.clone(),
                question: q.question.clone(),
            })
            .collect(),
        refreshes: p.refreshes,
    }
}

impl OrchestratorService {
    pub(crate) fn new(inner: Arc<CoreInner>, handle: Handle, chats: ChatsService) -> Self {
        Self {
            inner,
            handle,
            chats,
            tickets: Arc::default(),
        }
    }
    /// The Orchestrator chat's read path, writes and composer, on the
    /// `app-advisor` surface. It lives until its `ChatIntent::Close`.
    pub fn chats(&self) -> ChatsService {
        self.chats.clone()
    }
    /// The view now, then every change (latest wins).
    pub fn watch(&self) -> OrchestratorViews {
        OrchestratorViews {
            view: self.handle.view(),
            first: true,
        }
    }
    /// Queues `intent`; its outcome is not reported.
    pub fn send(&self, intent: OrchestratorIntent) {
        let _ = self.handle.send(self::intent(intent), None);
    }
    /// Queues `intent` and returns the ticket [`Self::settled`] takes.
    pub fn request(&self, intent: OrchestratorIntent) -> u64 {
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
    pub async fn settled(&self, ticket: u64) -> Result<OrchestratorSettled, CoreFailure> {
        let rx = self
            .tickets
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .1
            .remove(&ticket);
        let settled = self.inner.ticket(self.handle.scope(), rx).await?;
        Ok(OrchestratorSettled {
            revision: settled.revision,
            outcome: outcome(settled.outcome),
        })
    }
}

fn outcome(o: Outcome) -> OrchestratorOutcome {
    use OrchestratorOutcome as O;
    match o {
        Outcome::Visible { refresh } => O::Visible { refresh },
        Outcome::Catalog { chats, workspace } => O::Catalog {
            catalog: CatalogView {
                chats: chats.iter().map(chat_view).collect(),
                workspaces: vec![CatalogWorkspaceView {
                    id: workspace.0,
                    name: workspace.1,
                }],
            },
        },
        Outcome::Entering(entering) => match entering {
            Entering::Busy => O::Busy,
            Entering::Open { chat, generation } => O::Open {
                chat: chat_view(&chat),
                generation,
            },
            Entering::NewChat { generation } => O::NewChat {
                workspace: CatalogWorkspaceView {
                    id: crate::orchestrator::PROJECT.into(),
                    name: crate::copy::orchestrator::text(
                        crate::copy::orchestrator::CopyKey::Workspace,
                    )
                    .into(),
                },
                generation,
            },
            Entering::NewTab {
                entry,
                generation,
                failure,
            } => O::NewTab {
                entry_id: entry,
                generation,
                failure,
            },
            Entering::Failed { message } => O::LoadFailed { message },
            Entering::Stale => O::Stale,
        },
        Outcome::Entered(opened) => O::Entered { opened },
        Outcome::Failed(failure) => O::Failed {
            failure: failure_view(failure),
        },
        Outcome::Done => O::Done,
    }
}

fn intent(i: OrchestratorIntent) -> Intent {
    use OrchestratorIntent as I;
    match i {
        I::SetOnline { online } => Intent::Online(online),
        I::SetVisible { visible } => Intent::Visible(visible),
        I::ReadCatalog => Intent::Read,
        I::CatalogShown => Intent::Shown,
        I::WatchEntries => Intent::Watch,
        I::Enter { entry_id } => Intent::Enter(entry_id),
        I::Entered { generation, opened } => Intent::Entered { generation, opened },
        I::Leave => Intent::Leave,
        I::Answer {
            chat_id,
            request_id,
            answers,
        } => Intent::Answer {
            chat: chat_id,
            request: request_id,
            answers,
        },
        I::Dismiss {
            chat_id,
            request_id,
        } => Intent::Dismiss {
            chat: chat_id,
            request: request_id,
        },
        I::Close => Intent::Close,
    }
}

/// An [`OrchestratorService::watch`] stream.
pub struct OrchestratorViews {
    view: View<Published>,
    first: bool,
}

impl OrchestratorViews {
    /// The next view; `None` once the service stopped.
    pub async fn next(&mut self) -> Option<OrchestratorView> {
        if !self.first {
            self.view.changed().await.ok()?;
        }
        self.first = false;
        let published = self.view.latest()?;
        Some(view(&published))
    }
}

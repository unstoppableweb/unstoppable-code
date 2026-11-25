//! One computer's Orchestrator (architecture §3.7, P9), ported from
//! `computer_connect/orchestrator/controller.dart`
//! (`ComputerOrchestratorController`) and `device_link/orchestrator/
//! {catalog,questions}.dart` (`OrchestratorCatalog`,
//! `OrchestratorQuestions`); comments cite the Dart rule they keep.
//!
//! One actor task owns the work entries, the pending tool requests, the
//! window visibility the desktop sees, the renderer-ready handshake, the
//! entries' chat interest on the `app-advisor` surface and the bounded
//! refresh after desktop pushes. The Orchestrator chat itself runs on a
//! chats actor over the same surface (`chats::Peer::orchestrator`), which
//! the host's chat view model drives as for any chat; the host tells this
//! actor where that model is (online, catalog shown, in a chat), in the
//! order its listeners saw it, so the desktop sees Dart's sequence.
//!
//! Requests the phone cannot show are refused at once with
//! `unsupported_action`; Dart never sees them.
use crate::{
    account::{Inbox, Scope, View},
    api::{QuestionAnswerView, QuestionView},
    bridge::{APP_ADVISOR, Inner, MAIN, shutdown_failure},
    chats::{self, FailKind, Failure, Peer, transport_failure},
    copy::{
        chats as chat_copy,
        orchestrator::{self as copy, CopyKey},
    },
    error::Result,
    interest::{Holder, SCOPES},
    ports::Responder,
    push::{self, Delivery, Filter},
};
use cc_domain::{
    chat::ChatRef,
    dart::{Dv, DvMap},
};
use cc_protocol::{
    desktop::{self, Fallbacks, WorkEntry},
    dto,
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex, PoisonError, Weak},
    time::Duration,
};
use tokio::{
    runtime::Handle as Runtime,
    sync::{mpsc, oneshot, watch},
};

/// `orchestratorProjectId`.
pub(crate) const PROJECT: &str = "app-advisor";
/// `_event`'s single delay: one bounded refresh, not a debounce that busy
/// chats can starve.
const REFRESH: Duration = Duration::from_millis(500);
const LIMIT: Duration = Duration::from_millis(15_000);
const TOOL_REQUEST: &str = "app-advisor:tool-request";
const TOOL_CANCELLED: &str = "app-advisor:tool-request-cancelled";
const TOOL_RESPONSE: &str = "app-advisor:tool-response";
/// The pushes that refresh the list (`_event`).
const REFRESHING: [&str; 5] = [
    "chat:state-changed",
    "chat-search:updated",
    "app-advisor:window-command",
    "app-advisor:settings-changed",
    "sidebar-item-groups:changed",
];
const OBSERVED: [&str; 7] = [
    REFRESHING[0],
    REFRESHING[1],
    REFRESHING[2],
    REFRESHING[3],
    REFRESHING[4],
    TOOL_REQUEST,
    TOOL_CANCELLED,
];
/// The refusal a presentation request gets. Wire text the desktop shows its
/// agent, not the phone's copy.
const UNSUPPORTED: &str = "This view is unavailable on mobile. Open it on your computer.";
const DISMISSED: &str = "User dismissed the question.";

/// A work entry as the list shows it (`OrchestratorEntry`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Entry {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) chats: Vec<cc_domain::overview::ChatRef>,
    pub(crate) running: bool,
    pub(crate) unread: bool,
}

/// One pending `ask_user_question` (`_pending`'s value).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Pending {
    pub(crate) chat: String,
    pub(crate) question: QuestionView,
    /// Identity: a removed and re-delivered request is another object.
    serial: u64,
}

/// What the Orchestrator shows.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Published {
    pub(crate) revision: u64,
    pub(crate) entries: Arc<Vec<Entry>>,
    /// In arrival order (Dart's map order).
    pub(crate) questions: Vec<Pending>,
    /// Bumped when the delayed refresh fires; the host refreshes then.
    pub(crate) refreshes: u64,
}

/// What the host asks.
pub(crate) enum Intent {
    Online(bool),
    Visible(bool),
    Read,
    Shown,
    Watch,
    Enter(Option<String>),
    Leave,
    Answer {
        chat: String,
        request: String,
        answers: Vec<QuestionAnswerView>,
    },
    Dismiss {
        chat: String,
        request: String,
    },
    Close,
}

#[derive(Clone, Copy)]
struct OpenAttempt {
    id: u64,
    connection: u64,
    selection: u64,
}

#[derive(Clone, Copy)]
enum OpenStage {
    Create { tab: bool },
    Read,
}

#[derive(Debug, Clone)]
pub(crate) enum Outcome {
    Visible {
        refresh: bool,
    },
    Catalog {
        chats: Vec<cc_domain::overview::ChatRef>,
        workspace: (String, String),
    },
    Opened {
        revision: u64,
        generation: u64,
    },
    Failed(Failure),
    Done,
}

pub(crate) struct Settled {
    pub(crate) revision: u64,
    pub(crate) outcome: Outcome,
}

pub(crate) type Waiter = oneshot::Sender<Settled>;
type Done = Vec<(Waiter, Outcome)>;

enum Msg {
    Intent(Intent, Option<Waiter>),
    Push(push::Push),
    /// `app-advisor:window-renderer-ready` of the connection `generation`
    /// answered.
    Ready {
        generation: u64,
        ok: bool,
    },
    Read {
        generation: u64,
        result: std::result::Result<(Vec<cc_domain::overview::ChatRef>, Vec<WorkEntry>), Failure>,
        waiter: Option<Waiter>,
    },
    /// The active-chat read of the open `enter`.
    Active {
        attempt: OpenAttempt,
        entry: String,
        result: std::result::Result<Option<(String, String)>, ()>,
        waiter: Option<Waiter>,
    },
    ChatStep {
        attempt: OpenAttempt,
        stage: OpenStage,
        result: Option<chats::Settled>,
        waiter: Option<Waiter>,
    },
    Responded {
        key: (String, String),
        serial: u64,
        generation: u64,
        result: Result<Value>,
        waiter: Option<Waiter>,
    },
    Watched(Option<Waiter>),
    Timer(u64),
}

#[derive(Clone)]
pub(crate) struct Handle {
    inbox: mpsc::UnboundedSender<Msg>,
    view: View<Published>,
}

impl Handle {
    pub(crate) fn start(
        inner: &Arc<Inner>,
        runtime: &Runtime,
        computer: String,
        chats: chats::Handle,
    ) -> Self {
        let scope = inner.scope();
        let (inbox, rx) = mpsc::unbounded_channel();
        let pushes = inbox.clone();
        let subscription = inner.pushes.subscribe(
            Filter {
                computer: Some(computer.clone()),
                channels: &OBSERVED,
                unreadable: false,
                sessions: false,
            },
            Box::new(move |delivery| match delivery {
                Delivery::Push(push) => pushes.send(Msg::Push(push)).is_ok(),
                // Dart has no bound; a dropped request times out on the
                // desktop.
                Delivery::Lagged { .. } | Delivery::Opened => !pushes.is_closed(),
            }),
        );
        let actor = Actor {
            inner: Arc::downgrade(inner),
            inbox: inbox.clone(),
            computer: Peer::orchestrator(computer, scope.clone()),
            _pushes: subscription,
            chats,
            disposed: false,
            online: false,
            visible: false,
            in_chat: false,
            enters: 0,
            entering: None,
            generation: 0,
            entries: Arc::default(),
            entries_rev: 0,
            catalog_generation: 0,
            watched: None,
            timer: None,
            timers: 0,
            refreshes: 0,
            questions: Vec::new(),
            question_generation: 0,
            serials: 0,
            revision: 0,
        };
        let (publish, view) = watch::channel(Arc::new(Published::default()));
        runtime.spawn(actor.run(Inbox::new(rx, scope.clone()), publish));
        Self {
            inbox,
            view: View::new(view, scope),
        }
    }
    pub(crate) fn view(&self) -> View<Published> {
        self.view.clone()
    }
    pub(crate) fn scope(&self) -> &Scope {
        self.view.scope()
    }
    pub(crate) fn send(&self, intent: Intent, waiter: Option<Waiter>) -> Result<()> {
        self.view.scope().check()?;
        self.inbox
            .send(Msg::Intent(intent, waiter))
            .map_err(|_| shutdown_failure())
    }
}

struct Actor {
    inner: Weak<Inner>,
    inbox: mpsc::UnboundedSender<Msg>,
    /// The computer's Orchestrator surface in the service's account scope:
    /// its requests reach only a session of that scope.
    computer: Peer,
    _pushes: push::Subscription,
    chats: chats::Handle,
    disposed: bool,
    // `ComputerOrchestratorController`.
    online: bool,
    visible: bool,
    in_chat: bool,
    enters: u64,
    /// The open that owns the route until the chat has hydrated.
    entering: Option<u64>,
    generation: u64,
    // `OrchestratorCatalog`.
    entries: Arc<Vec<Entry>>,
    /// Bumped whenever `entries` is replaced (Dart: a new list identity).
    entries_rev: u64,
    catalog_generation: u64,
    /// `_watchedEntries`: the entries whose scopes were claimed.
    watched: Option<u64>,
    /// The pending refresh delay's token (`_refresh`).
    timer: Option<u64>,
    timers: u64,
    refreshes: u64,
    // `OrchestratorQuestions`.
    questions: Vec<Pending>,
    question_generation: u64,
    serials: u64,
    revision: u64,
}

fn fallbacks() -> Fallbacks {
    crate::copy::overview::fallbacks()
}

fn entry_view(row: WorkEntry, chats: &[cc_domain::overview::ChatRef]) -> Entry {
    Entry {
        chats: chats
            .iter()
            .filter(|chat| chat.worktree_id == row.id)
            .cloned()
            .collect(),
        title: row
            .title
            .unwrap_or_else(|| copy::text(CopyKey::EntryFallback).into()),
        id: row.id,
        running: row.running,
        unread: row.unread,
    }
}

impl Actor {
    async fn run(mut self, mut rx: Inbox<Msg>, publish: watch::Sender<Arc<Published>>) {
        self.publish(&publish);
        while let Some(msg) = rx.recv(|| Msg::Intent(Intent::Close, None)).await {
            let mut done = Vec::new();
            self.apply(msg, &mut done);
            self.publish(&publish);
            for (waiter, outcome) in done {
                let _ = waiter.send(Settled {
                    revision: self.revision,
                    outcome,
                });
            }
            if self.disposed {
                break;
            }
        }
    }

    /// Publishes when the view changed.
    fn publish(&mut self, publish: &watch::Sender<Arc<Published>>) {
        let current = publish.borrow().clone();
        if self.revision > 0
            && Arc::ptr_eq(&current.entries, &self.entries)
            && current.questions == self.questions
            && current.refreshes == self.refreshes
        {
            return;
        }
        self.revision += 1;
        publish.send_replace(Arc::new(Published {
            revision: self.revision,
            entries: self.entries.clone(),
            questions: self.questions.clone(),
            refreshes: self.refreshes,
        }));
    }

    fn apply(&mut self, msg: Msg, done: &mut Done) {
        match msg {
            Msg::Intent(intent, waiter) => self.intent(intent, waiter, done),
            Msg::Push(push) => self.push(&push.message),
            Msg::Ready { generation, ok } => self.ready(generation, ok),
            Msg::Read {
                generation,
                result,
                waiter,
            } => {
                let outcome = match result {
                    Ok((chats, rows)) => {
                        if generation == self.catalog_generation {
                            self.entries =
                                Arc::new(rows.into_iter().map(|r| entry_view(r, &chats)).collect());
                            self.entries_rev += 1;
                        }
                        Outcome::Catalog {
                            chats,
                            workspace: (PROJECT.into(), copy::text(CopyKey::Workspace).into()),
                        }
                    }
                    Err(failure) => Outcome::Failed(failure),
                };
                settle(done, waiter, outcome);
            }
            Msg::Active {
                attempt,
                entry,
                result,
                waiter,
            } => {
                if !self.current_open(attempt) {
                    return self.finish_open(attempt, waiter, None, None, done);
                }
                match result {
                    Err(()) => self.finish_open(
                        attempt,
                        waiter,
                        Some(Failure::link_text(copy::text(CopyKey::LoadFailed))),
                        None,
                        done,
                    ),
                    Ok(Some((id, title))) => self.open_chat(
                        attempt,
                        ChatRef {
                            project_id: PROJECT.into(),
                            worktree_id: entry,
                            id,
                            title,
                        },
                        waiter,
                    ),
                    Ok(None) => self.chat_step(
                        attempt,
                        OpenStage::Create { tab: true },
                        chats::Intent::CreateTab {
                            expected: Some(attempt.selection),
                            project_id: PROJECT.into(),
                            worktree_id: entry,
                        },
                        waiter,
                    ),
                }
            }
            Msg::ChatStep {
                attempt,
                stage,
                result,
                waiter,
            } => {
                if !self.current_open(attempt) {
                    return self.finish_open(attempt, waiter, None, None, done);
                }
                match (stage, result) {
                    (
                        OpenStage::Create { .. },
                        Some(chats::Settled {
                            outcome: Some(chats::Outcome::Created(chat)),
                            ..
                        }),
                    ) => self.open_chat(attempt, chat, waiter),
                    (
                        OpenStage::Read,
                        Some(chats::Settled {
                            revision,
                            outcome:
                                Some(chats::Outcome::Opened {
                                    selected: true,
                                    generation,
                                }),
                            ..
                        }),
                    ) if self
                        .chats
                        .view()
                        .current()
                        .is_some_and(|view| view.generation == generation) =>
                    {
                        self.finish_open(attempt, waiter, None, Some((revision, generation)), done);
                    }
                    (stage, result) => {
                        let failure = result.and_then(|result| result.failure).map(|failure| {
                            if matches!(stage, OpenStage::Create { tab: true }) {
                                Failure::link_text(copy::text(CopyKey::CreateFailed))
                            } else {
                                failure
                            }
                        });
                        self.finish_open(attempt, waiter, failure, None, done);
                    }
                }
            }
            Msg::Responded {
                key,
                serial,
                generation,
                result,
                waiter,
            } => {
                let outcome = match result {
                    Err(error) => Outcome::Failed(transport_failure(&error)),
                    Ok(_) => {
                        if !self.disposed && generation == self.question_generation {
                            self.questions
                                .retain(|q| !(key_of(q) == key && q.serial == serial));
                        }
                        Outcome::Done
                    }
                };
                settle(done, waiter, outcome);
            }
            Msg::Watched(waiter) => settle(done, waiter, Outcome::Done),
            Msg::Timer(token) => {
                if self.timer == Some(token) {
                    self.timer = None;
                    self.refreshes += 1;
                }
            }
        }
    }

    fn intent(&mut self, intent: Intent, waiter: Option<Waiter>, done: &mut Done) {
        match intent {
            Intent::Online(online) => {
                self.set_online(online);
                settle(done, waiter, Outcome::Done);
            }
            Intent::Visible(visible) => {
                let refresh = self.set_visible(visible);
                settle(done, waiter, Outcome::Visible { refresh });
            }
            Intent::Read => self.read(waiter),
            Intent::Shown => {
                // `_changed`: the host's catalog is not loading.
                if !self.in_chat && self.watched != Some(self.entries_rev) {
                    self.watched = Some(self.entries_rev);
                    self.watch(None);
                }
                settle(done, waiter, Outcome::Done);
            }
            Intent::Watch => self.watch(waiter),
            Intent::Enter(entry) => self.enter(entry, waiter, done),
            Intent::Leave => {
                self.in_chat = false;
                self.entering = None;
                settle(done, waiter, Outcome::Done);
            }
            Intent::Answer {
                chat,
                request,
                answers,
            } => self.answer(chat, request, answers, waiter, done),
            Intent::Dismiss { chat, request } => {
                let response = json!({
                    "ok": false,
                    "error": {"code": "cancelled", "message": DISMISSED},
                });
                self.respond(chat, request, response, waiter, done);
            }
            Intent::Close => {
                self.disposed = true;
                self.generation += 1;
                self.catalog_generation += 1;
                self.timer = None;
                self.question_generation += 1;
                self.questions.clear();
                settle(done, waiter, Outcome::Done);
            }
        }
    }

    // ---- The controller (`_connectionChanged`, `setVisible`, `_ready`) ----

    fn set_online(&mut self, online: bool) {
        if self.online == online {
            return;
        }
        self.online = online;
        self.generation += 1;
        if !online {
            self.watched = None;
            self.catalog_generation += 1;
            self.invalidate_questions();
        }
        self.timer = None;
        if online {
            // Creating the app-advisor sender before this acknowledgement
            // lets the desktop redeliver pending questions after reconnect.
            let (inbox, generation) = (self.inbox.clone(), self.generation);
            self.call("app-advisor:window-renderer-ready", vec![], move |result| {
                let _ = inbox.send(Msg::Ready {
                    generation,
                    ok: result.is_ok(),
                });
            });
        }
    }

    /// `_ready` after the acknowledgement: the window state, then the
    /// entries' scopes. A failure ends it (the list keeps its retry), as
    /// does a newer connection, whose own acknowledgement continues.
    fn ready(&mut self, generation: u64, ok: bool) {
        if !ok || self.disposed || generation != self.generation {
            return;
        }
        if let Some(inner) = self.inner.upgrade() {
            let _ = inner.set_visible(&self.computer, self.visible);
        }
        if !self.disposed && self.online && !self.in_chat {
            self.watch(None);
        }
    }

    /// Whether the host refreshes the list now.
    fn set_visible(&mut self, visible: bool) -> bool {
        if self.visible == visible || self.disposed {
            return false;
        }
        self.visible = visible;
        if !visible {
            self.timer = None;
        }
        if let Some(inner) = self.inner.upgrade() {
            let _ = inner.set_visible(&self.computer, visible);
        }
        visible && self.online
    }

    /// `_watchOverview`: every entry's scope on the Orchestrator surface.
    fn watch(&mut self, waiter: Option<Waiter>) {
        let inbox = self.inbox.clone();
        if !self.online || self.in_chat || self.disposed {
            let _ = inbox.send(Msg::Watched(waiter));
            return;
        }
        let scopes: Vec<Value> = self
            .entries
            .iter()
            .map(|e| json!({"projectId": PROJECT, "worktreeId": e.id}))
            .collect();
        let args = json!({"kind": "scopes", "scopes": scopes});
        let sent = self.inner.upgrade().map(|inner| {
            inner.write_interest_on(&self.computer, Holder::Orchestrator, SCOPES, vec![args])
        });
        match sent {
            Some(Ok(rx)) => {
                tokio::spawn(async move {
                    // Errors are swallowed, as Dart's callers did.
                    let _ = rx.await;
                    let _ = inbox.send(Msg::Watched(waiter));
                });
            }
            _ => {
                let _ = inbox.send(Msg::Watched(waiter));
            }
        }
    }

    // ---- The catalog (`OrchestratorCatalog.read`) ----

    fn read(&mut self, waiter: Option<Waiter>) {
        self.catalog_generation += 1;
        let generation = self.catalog_generation;
        let (Some(inner), inbox, computer) = (
            self.inner.upgrade(),
            self.inbox.clone(),
            self.computer.clone(),
        ) else {
            return;
        };
        tokio::spawn(async move {
            let result = read_catalog(&inner, &computer).await;
            let _ = inbox.send(Msg::Read {
                generation,
                result,
                waiter,
            });
        });
    }

    // ---- Opening (`open`, `activeChat`) ----

    fn current_open(&self, attempt: OpenAttempt) -> bool {
        !self.disposed
            && self.online
            && self.entering == Some(attempt.id)
            && self.generation == attempt.connection
    }

    fn finish_open(
        &mut self,
        attempt: OpenAttempt,
        waiter: Option<Waiter>,
        failure: Option<Failure>,
        opened: Option<(u64, u64)>,
        done: &mut Done,
    ) {
        if self.entering == Some(attempt.id) {
            self.entering = None;
            self.in_chat = opened.is_some();
        }
        settle(
            done,
            waiter,
            if let Some(failure) = failure {
                Outcome::Failed(failure)
            } else if let Some((revision, generation)) = opened {
                Outcome::Opened {
                    revision,
                    generation,
                }
            } else {
                Outcome::Done
            },
        );
    }

    fn chat_step(
        &self,
        attempt: OpenAttempt,
        stage: OpenStage,
        intent: chats::Intent,
        waiter: Option<Waiter>,
    ) {
        let (tx, rx) = oneshot::channel();
        let _ = self.chats.send(intent, Some(tx));
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            let result = rx.await.ok();
            let _ = inbox.send(Msg::ChatStep {
                attempt,
                stage,
                result,
                waiter,
            });
        });
    }

    fn open_chat(&self, attempt: OpenAttempt, chat: ChatRef, waiter: Option<Waiter>) {
        self.chat_step(
            attempt,
            OpenStage::Read,
            chats::Intent::OpenCurrent {
                chat,
                expected: attempt.selection,
            },
            waiter,
        );
    }

    fn enter(&mut self, entry: Option<String>, waiter: Option<Waiter>, done: &mut Done) {
        let Some(chat) = self.chats.view().current().filter(|chat| chat.connected) else {
            return settle(done, waiter, Outcome::Done);
        };
        if !self.online || self.in_chat {
            return settle(done, waiter, Outcome::Done);
        }
        self.in_chat = true;
        self.timer = None;
        self.enters += 1;
        let attempt = OpenAttempt {
            id: self.enters,
            connection: self.generation,
            selection: chat.generation,
        };
        self.entering = Some(attempt.id);
        let Some(entry) = entry else {
            self.chat_step(
                attempt,
                OpenStage::Create { tab: false },
                chats::Intent::CreateChat {
                    expected: Some(attempt.selection),
                    workspace: PROJECT.into(),
                    title: None,
                },
                waiter,
            );
            return;
        };
        let (Some(inner), inbox, computer) = (
            self.inner.upgrade(),
            self.inbox.clone(),
            self.computer.clone(),
        ) else {
            return self.finish_open(attempt, waiter, None, None, done);
        };
        tokio::spawn(async move {
            let reply = call(
                &inner,
                &computer,
                "chat:get-state",
                vec![json!({"projectId": PROJECT, "worktreeId": entry})],
            )
            .await;
            let result = reply
                .ok()
                .and_then(|reply| desktop::active_tab(&reply, &fallbacks()).ok())
                .ok_or(());
            let _ = inbox.send(Msg::Active {
                attempt,
                entry,
                result,
                waiter,
            });
        });
    }

    // ---- Questions (`OrchestratorQuestions`) ----

    fn invalidate_questions(&mut self) {
        self.question_generation += 1;
        self.questions.clear();
    }

    fn push(&mut self, message: &Value) {
        if self.disposed {
            return;
        }
        let message = dto::desktop_value(message);
        let Dv::Map(event) = &message else { return };
        if !event.get("name").is_str("ipc.push") {
            return;
        }
        let Dv::Map(payload) = event.get("payload") else {
            return;
        };
        let surface = payload.get("surface");
        // The Orchestrator's sender sees pushes for its surface and those
        // without one; the main sender's own pushes reach the questions too.
        let sender = if surface.is_null() || surface.is_str(APP_ADVISOR) {
            APP_ADVISOR
        } else if surface.is_str(MAIN) {
            MAIN
        } else {
            return;
        };
        let channel = payload.get("channel").as_str().unwrap_or_default();
        if sender == APP_ADVISOR && REFRESHING.contains(&channel) {
            self.schedule_refresh();
        }
        self.question_push(payload, channel, sender);
    }

    /// `_event`: one bounded refresh while the list shows.
    fn schedule_refresh(&mut self) {
        if !self.visible || self.in_chat || !self.online || self.timer.is_some() {
            return;
        }
        self.timers += 1;
        let token = self.timers;
        self.timer = Some(token);
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            tokio::time::sleep(REFRESH).await;
            let _ = inbox.send(Msg::Timer(token));
        });
    }

    /// `_receive`.
    fn question_push(&mut self, payload: &DvMap, channel: &str, sender: &'static str) {
        let first = match payload.get("args") {
            Dv::List(args) => match args.first() {
                Some(first) => first,
                None => return,
            },
            _ => return,
        };
        let Dv::Map(raw) = first else { return };
        let Some(request) = raw.get("requestId").as_str().map(str::to_owned) else {
            return;
        };
        if channel == TOOL_CANCELLED {
            if let Some(chat) = raw.get("originChatId").as_str() {
                let key = (chat.to_owned(), request);
                self.questions.retain(|q| key_of(q) != key);
            }
            return;
        }
        if channel != TOOL_REQUEST {
            return;
        }
        if let (true, Some(chat), Dv::Map(question)) = (
            raw.get("kind").is_str("ask_user_question"),
            raw.get("chatId").as_str(),
            raw.get("question"),
        ) {
            let key = (chat.to_owned(), request.clone());
            if !self.questions.iter().any(|q| key_of(q) == key) {
                self.serials += 1;
                self.questions.push(Pending {
                    chat: chat.to_owned(),
                    question: QuestionView {
                        request_id: request,
                        tool_use_id: None,
                        questions: vec![crate::api::question_item(question)],
                        answered: false,
                        answers: Vec::new(),
                    },
                    serial: self.serials,
                });
            }
            return;
        }
        let origin = match raw.get("originChatTabId") {
            Dv::Null => raw.get("payload").get("origin").get("chatTabId"),
            origin => origin,
        };
        let mut response = json!({
            "requestId": request,
            "ok": false,
            "error": {"code": "unsupported_action", "message": UNSUPPORTED},
        });
        if let Some(origin) = origin.as_str() {
            response["originChatId"] = json!(origin);
        }
        // Answered at once rather than left to time out; the outcome is
        // ignored.
        self.call_on(sender, TOOL_RESPONSE, vec![response], |_| {});
    }

    fn answer(
        &mut self,
        chat: String,
        request: String,
        answers: Vec<QuestionAnswerView>,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        let key = (chat.clone(), request.clone());
        let question = self
            .questions
            .iter()
            .find(|q| key_of(q) == key)
            .and_then(|q| q.question.questions.first().cloned());
        let (Some(question), [answer]) = (question, answers.as_slice()) else {
            return settle(
                done,
                waiter,
                Outcome::Failed(Failure::link_text(copy::text(CopyKey::AnswerFirst))),
            );
        };
        let mut reply = json!({
            "question": question.question,
            "selectedOptions": answer.selected_options,
        });
        if let Some(id) = question.id {
            reply["questionId"] = json!(id);
        }
        if let Some(text) = &answer.freeform_text {
            reply["freeformText"] = json!(text);
        }
        self.respond(
            chat,
            request,
            json!({"ok": true, "answer": reply}),
            waiter,
            done,
        );
    }

    /// `_respond`: one `app-advisor:tool-response`; the request leaves the
    /// list once the desktop took it, unless it changed meanwhile.
    fn respond(
        &mut self,
        chat: String,
        request: String,
        response: Value,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        let key = (chat, request);
        let Some(serial) = self
            .questions
            .iter()
            .find(|q| key_of(q) == key)
            .map(|q| q.serial)
        else {
            return settle(
                done,
                waiter,
                Outcome::Failed(Failure::link_text(copy::text(CopyKey::NoLongerWaiting))),
            );
        };
        let generation = self.question_generation;
        let mut args = json!({"requestId": key.1, "originChatId": key.0});
        if let (Some(args), Value::Object(extra)) = (args.as_object_mut(), response) {
            args.extend(extra);
        }
        let inbox = self.inbox.clone();
        self.call(TOOL_RESPONSE, vec![args], move |result| {
            let _ = inbox.send(Msg::Responded {
                key,
                serial,
                generation,
                result,
                waiter,
            });
        });
    }

    /// One request on the Orchestrator surface; `on_reply` gets its reply
    /// in wire order, or why no session took it.
    fn call(
        &self,
        channel: &str,
        args: Vec<Value>,
        on_reply: impl FnOnce(Result<Value>) + Send + 'static,
    ) {
        self.call_on(APP_ADVISOR, channel, args, on_reply);
    }
    fn call_on(
        &self,
        surface: &'static str,
        channel: &str,
        args: Vec<Value>,
        on_reply: impl FnOnce(Result<Value>) + Send + 'static,
    ) {
        type Reply = Box<dyn FnOnce(Result<Value>) + Send>;
        let slot: Arc<Mutex<Option<Reply>>> = Arc::new(Mutex::new(Some(Box::new(on_reply))));
        let take = |slot: &Arc<Mutex<Option<Reply>>>| {
            slot.lock().unwrap_or_else(PoisonError::into_inner).take()
        };
        let responder = {
            let slot = slot.clone();
            Responder::new(move |result| {
                if let Some(reply) = take(&slot) {
                    reply(result);
                }
            })
        };
        let sent = match self.inner.upgrade() {
            Some(inner) => {
                inner.invoke(&self.computer.on(surface), channel, args, LIMIT, responder)
            }
            None => Err(shutdown_failure()),
        };
        if let Err(error) = sent
            && let Some(reply) = take(&slot)
        {
            reply(Err(error));
        }
    }
}

fn key_of(q: &Pending) -> (String, String) {
    (q.chat.clone(), q.question.request_id.clone())
}

fn settle(done: &mut Done, waiter: Option<Waiter>, outcome: Outcome) {
    if let Some(waiter) = waiter {
        done.push((waiter, outcome));
    }
}

async fn call(inner: &Inner, computer: &Peer, channel: &str, args: Vec<Value>) -> Result<Value> {
    let rx = inner.request(computer, channel, args)?;
    rx.await
        .unwrap_or_else(|_| Err(cc_protocol::rpc::ended("session_ended")))
}

/// `OrchestratorCatalog.read`: the work entries, then the search catalog,
/// with what Dart would throw.
async fn read_catalog(
    inner: &Inner,
    computer: &Peer,
) -> std::result::Result<(Vec<cc_domain::overview::ChatRef>, Vec<WorkEntry>), Failure> {
    let entries = call(
        inner,
        computer,
        "work-entries:list",
        vec![json!({"projectId": PROJECT})],
    )
    .await
    .map_err(|e| transport_failure(&e))?;
    let entries = desktop::work_entries_reply(&entries).map_err(unreadable)?;
    let catalog = call(inner, computer, "chat-search:catalog", vec![])
        .await
        .map_err(|e| transport_failure(&e))?;
    desktop::orchestrator_catalog(&entries, &catalog, PROJECT, &fallbacks()).map_err(unreadable)
}

/// What a reply Dart could not read throws: `deviceLinkObject`'s
/// exception, or a cast's `TypeError`.
fn unreadable(error: desktop::Unreadable) -> Failure {
    match error {
        desktop::Unreadable::Invalid => {
            Failure::link_text(chat_copy::text(chat_copy::CopyKey::InvalidMessage))
        }
        desktop::Unreadable::Unexpected => Failure {
            message: chat_copy::text(chat_copy::CopyKey::ReadFailed).into(),
            kind: FailKind::Other,
            code: None,
        },
    }
}

//! The selected chat's composer (P5c), ported from
//! `device_link/chats/{settings,decisions,forks,composer}.dart`,
//! `computer_connect/{settings_controller,composer_sources}.dart` and the
//! settings half of `chats_view_model.dart` (`_syncSettings`, `_restore`,
//! `_loadSettings`); comments cite the Dart rule they keep.
//!
//! The settings catalog is read where Dart read it: when the shown chat's
//! model, harness or running state changed (`_syncSettings`), when the
//! host asks, and in the reconnect loop. Whether a change shares the read
//! in flight is decided here as of the moment that state showed (every
//! shown state is recorded with the read in flight then), and the host
//! confirms which states its listener saw (`Sync`): a state it replaced
//! within the same turn reads nothing, as in Dart. The composer's calls
//! are answered through responders on the session task, so the reads keep
//! their order against the open's own reads and the pushes.
//!
//! Settings picks are serialized: each shows at once (merged over the
//! tab), is saved with one `chat:command`, and is released once the chat's
//! revision reaches the receipt's; when it does not by the next turn, the
//! chat is re-read.
use super::{
    Actor, ChatRef, CommandError, Done, FailKind, Failure, Msg, Outcome, Waiter, utf16_prefix, uuid,
};
use crate::{
    copy::{
        chats::{self as chat_copy, CopyKey as ChatCopy},
        composer::{self as copy, CopyKey},
    },
    error::{Error, Result},
    failures,
    ports::Responder,
};
use cc_domain::{
    chat::{self, Thrown, object},
    composer::{
        ModelOption,
        catalog::{self, CatalogError},
        pick::{self, Pick, Save},
        registry::{self, Catalog, SavedDefault},
        selection,
    },
    dart::{Dv, DvMap},
};
use cc_protocol::{FailureKind, dto};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};
use tokio::sync::mpsc;

/// Shown chat states kept for `SyncSettings`.
const SEEN: usize = 16;
/// The session's default request limit.
const LIMIT: Duration = Duration::from_millis(15_000);

/// A composer pick as the host names it; the model is resolved here.
#[derive(Debug, Clone)]
pub(crate) enum PickIntent {
    Effort(String),
    Auto,
    PlanMode(bool),
    /// `selectionModelOption(catalog, id, executionHarness: harness ??
    /// the chat's locked harness)`.
    Model {
        id: String,
        execution_harness: Option<String>,
    },
    Fast(bool),
}

/// What the composer sources' callbacks captured (`current()`): the chat,
/// its selection generation, model and harness.
#[derive(Debug, Clone)]
pub(crate) struct SourceScope {
    pub(crate) chat: ChatRef,
    pub(crate) generation: u64,
    pub(crate) model: Dv,
    pub(crate) tab_harness: Dv,
}

/// A composer catalog read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SourceRead {
    Inventory,
    PluginCatalog,
    Selections,
}

/// An invocable row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandRow {
    pub(crate) name: String,
    pub(crate) display_name: Option<String>,
    pub(crate) description: String,
    pub(crate) entry_id: String,
}

/// A settings write's failure (`DeviceSettingsFailure`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PickFailure {
    pub(crate) message: String,
    pub(crate) reported: bool,
    pub(crate) model_change: bool,
}

/// The parts of a catalog read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Part {
    Registry,
    Projection,
    Preferences,
    Projects,
}

/// Replies and continuations of the composer's work.
pub(crate) enum Event {
    Read {
        generation: u64,
        part: Part,
        result: Result<Value>,
    },
    Saved {
        id: u64,
        result: std::result::Result<i64, CommandError>,
    },
    Resume,
    /// One reply of several; the last one carries them all.
    Partial,
    Decided {
        result: std::result::Result<i64, CommandError>,
        waiter: Option<Waiter>,
    },
    Forked {
        source: (ChatRef, u64),
        at: String,
        tab_id: String,
        result: Result<Value>,
        waiter: Option<Waiter>,
    },
    Source {
        read: SourceRead,
        scope: SourceScope,
        harness: Option<String>,
        replies: Vec<Result<Value>>,
        waiter: Option<Waiter>,
    },
}

/// Who waits for a catalog read.
enum Request {
    /// `_loadSettings` (`waiter` for the host's `loadSettings`).
    Report { key: String, waiter: Option<Waiter> },
    /// `DeviceChatSettings.load` (the failure rethrown).
    Raw { waiter: Option<Waiter> },
    /// The reconnect loop's `_loadSettings`.
    Restore { key: String },
}

/// One `_load`.
struct ReadJob {
    generation: u64,
    chat: ChatRef,
    advisor: bool,
    registry: Option<Result<Value>>,
    projection: Option<Result<Value>>,
    preferences: Option<Result<Value>>,
    projects: Option<Result<Value>>,
    /// After round one: the registry and the projection.
    first: Option<(DvMap, Option<DvMap>, Vec<ModelOption>)>,
    requests: Vec<Request>,
}

/// `_settingsInput`: what the catalog was read for.
#[derive(Debug, Clone, PartialEq)]
struct Input {
    key: String,
    model: Dv,
    harness: Dv,
    running: bool,
}

/// The reconnect loop (`_restore`).
struct Restore {
    epoch: u64,
    input: Option<Input>,
    waiter: Option<Waiter>,
}

/// `(chat key, closed, session generation, selection generation)`.
type Scope = (Option<String>, Option<bool>, u64, u64);

struct Selection {
    id: u64,
    patch: DvMap,
    pick: Pick,
    chat: ChatRef,
    revision: Option<i64>,
    waiter: Option<Waiter>,
}

/// Where the queue's drain waits.
enum After {
    /// `change` re-reads before queueing after an uncertain write.
    Change {
        chat: ChatRef,
        pick: Pick,
        waiter: Option<Waiter>,
        scope: Option<Scope>,
    },
    /// A receipt did not catch up by the next turn.
    CatchUp { scope: Option<Scope> },
    /// After an uncertain write.
    Uncertain {
        scope: Option<Scope>,
        id: u64,
        waiter: Option<Waiter>,
    },
}

#[derive(Clone, Copy)]
pub(super) enum RefreshResult<'a> {
    Hydrated,
    Incomplete,
    Failed(&'a Failure),
}

/// The selected chat's composer state.
#[derive(Default)]
pub(super) struct Composer {
    /// The host reads the composer from the core; until then the catalog
    /// is not read on its own.
    enabled: bool,
    // `DeviceChatSettings`.
    pub(super) catalog: Catalog,
    pub(super) scope_key: Option<String>,
    pub(super) loading: bool,
    generation: u64,
    current: Option<u64>,
    jobs: Vec<ReadJob>,
    /// `_settingsError`.
    pub(super) error: Option<String>,
    input: Option<Input>,
    /// Recent shown states and the catalog read in flight then.
    seen: std::collections::VecDeque<(Input, Option<u64>)>,
    restore: Option<Restore>,
    /// Bumped by every connection change (`_connectionRevision`).
    epoch: u64,
    // `DeviceComposerSettingsController`.
    selections: Vec<Selection>,
    ids: u64,
    scope: Option<Scope>,
    refresh_scope: Option<Scope>,
    working_scope: Option<Scope>,
    selection_generation: u64,
    draining: bool,
    requires_refresh: bool,
    pub(super) failure: Option<PickFailure>,
    /// The pick being saved and the scope it was saved for.
    saving: Option<(u64, Option<Scope>)>,
    refreshes: Vec<(u64, After)>,
    // Composer sources.
    pub(super) inventory_revision: u64,
    // `DeviceChatForks`.
    attempts: Vec<((String, String), (String, String))>,
}

/// The composer as the snapshot shows it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Shown {
    pub(crate) catalog: Catalog,
    pub(crate) scope_key: Option<String>,
    pub(crate) loading: bool,
    pub(crate) error: Option<String>,
    /// The selected tab with the queued picks applied.
    pub(crate) tab: DvMap,
    pub(crate) saving: bool,
    pub(crate) refreshing: bool,
    pub(crate) failure: Option<PickFailure>,
    pub(crate) inventory_revision: u64,
}

fn settle(
    done: &mut Done,
    waiter: Option<Waiter>,
    failure: Option<Failure>,
    outcome: Option<Outcome>,
) {
    if let Some(waiter) = waiter {
        done.push((waiter, failure, outcome));
    }
}

fn link(message: impl Into<String>) -> Failure {
    Failure {
        message: message.into(),
        kind: FailKind::Link,
        code: None,
    }
}

fn other(message: impl Into<String>) -> Failure {
    Failure {
        message: message.into(),
        kind: FailKind::Other,
        code: None,
    }
}

/// What a catalog read's failure reads as (`_loadSettings`): a
/// `DeviceLinkException`'s message, else the generic words.
fn read_failure(error: &ReadError) -> Failure {
    match error {
        ReadError::Rpc(e) => match failures::read_failure(e) {
            Some(message) => link(message),
            None => other(copy::text(CopyKey::ModelsFailed)),
        },
        ReadError::Thrown(Thrown::Invalid) => link(chat_copy::text(ChatCopy::InvalidMessage)),
        ReadError::Thrown(Thrown::Cast) => other(copy::text(CopyKey::ModelsFailed)),
    }
}

enum ReadError {
    Rpc(Error),
    Thrown(Thrown),
}

/// A command's failure as the caller rethrows it.
fn command_failure(error: &CommandError) -> Failure {
    match error {
        CommandError::Rpc(e) => super::sends::transport(e),
        _ => error.failure(),
    }
}

/// `DeviceChatSettingsRejected` or `DesktopIpcNotSent`: the write was not
/// applied.
fn reported(error: &CommandError) -> bool {
    match error {
        CommandError::Rejected(_) => true,
        CommandError::Rpc(e) => e.kind == FailureKind::NotSent,
        _ => false,
    }
}

/// A `DeviceLinkException`'s message, if it is one.
fn link_message(error: &CommandError) -> Option<String> {
    match error {
        CommandError::Rejected(reason) => Some(reason.clone()),
        CommandError::Rpc(e) => failures::read_failure(e),
        CommandError::Invalid => Some(chat_copy::text(ChatCopy::InvalidMessage).into()),
        CommandError::Format => None,
    }
}

/// `_recordFailure`.
fn pick_failure(
    error: Option<&CommandError>,
    open: Option<&Failure>,
    patch: &DvMap,
) -> PickFailure {
    let is_reported = error.is_some_and(reported);
    let message = match (error, open) {
        (Some(e), _) if is_reported => {
            link_message(e).unwrap_or_else(|| copy::text(CopyKey::SaveFailed).into())
        }
        (Some(e), _) => copy::render(
            CopyKey::CheckSelection,
            &[(
                "reason",
                &link_message(e).unwrap_or_else(|| copy::text(CopyKey::NotConfirmed).into()),
            )],
        ),
        (None, Some(f)) if f.kind == FailKind::Link => {
            copy::render(CopyKey::CheckSelection, &[("reason", &f.message)])
        }
        _ => copy::render(
            CopyKey::CheckSelection,
            &[("reason", copy::text(CopyKey::NotConfirmed))],
        ),
    };
    PickFailure {
        message,
        reported: is_reported,
        model_change: pick::model_change(patch),
    }
}

impl Actor {
    /// Sends `channel` on the session; its reply arrives as `make(reply)`
    /// in wire order.
    fn composer_call(
        &self,
        channel: &str,
        args: Vec<Value>,
        make: impl FnOnce(Result<Value>) -> Event + Send + 'static,
    ) {
        type Make = Box<dyn FnOnce(Result<Value>) -> Event + Send>;
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let slot: Arc<Mutex<Option<Make>>> = Arc::new(Mutex::new(Some(Box::new(make))));
        let post = |slot: &Arc<Mutex<Option<Make>>>, inbox: &mpsc::UnboundedSender<Msg>, result| {
            let make = slot.lock().unwrap_or_else(PoisonError::into_inner).take();
            if let Some(make) = make {
                let _ = inbox.send(Msg::Composer(make(result)));
            }
        };
        let responder = {
            let (slot, inbox) = (slot.clone(), self.inbox.clone());
            Responder::new(move |result| post(&slot, &inbox, result))
        };
        if let Err(error) = inner.invoke(&self.peer, channel, args, LIMIT, responder) {
            // No session took it; the responder was dropped unanswered.
            post(&slot, &self.inbox, Err(error));
        }
    }

    fn input(&self) -> Option<Input> {
        let state = self.state()?;
        Some(Input {
            key: state.chat.key(),
            model: state.tab.get("model").clone(),
            harness: state.tab.get("executionHarness").clone(),
            running: state.running(),
        })
    }

    /// After every applied message: `_syncSettings` and the queue's
    /// `sync`.
    pub(super) fn observe_composer(&mut self) {
        // Every shown model, harness and running state, with the catalog
        // read in flight for that chat then: `SyncSettings` decides as
        // `_syncSettings` did when it ran on that update.
        if self.composer.enabled
            && let Some(input) = self.input()
            && self.composer.seen.back().map(|(i, _)| i) != Some(&input)
        {
            let key = input.key.clone();
            let in_flight = (self.composer.scope_key.as_deref() == Some(key.as_str()))
                .then_some(self.composer.current)
                .flatten();
            if self.composer.seen.len() == SEEN {
                self.composer.seen.pop_front();
            }
            self.composer.seen.push_back((input, in_flight));
        }
        self.sync_picks();
    }

    /// `_syncSettings`: the host's listener ran with `chat` showing this
    /// model, harness and running state. A change reads the catalog
    /// unless a read for that chat was in flight when the state showed.
    fn sync_settings(&mut self, chat: ChatRef, model: Dv, harness: Dv, running: bool) {
        if !self.connected {
            return;
        }
        let input = Input {
            key: chat.key(),
            model,
            harness,
            running,
        };
        if self.composer.input.as_ref() == Some(&input) {
            return;
        }
        let shown = self
            .composer
            .seen
            .iter()
            .rev()
            .find(|(i, _)| *i == input)
            .map(|(_, in_flight)| *in_flight);
        let key = input.key.clone();
        self.composer.input = Some(input);
        match shown {
            // The read in flight then answers it (if it is still running,
            // its outcome is this caller's too).
            Some(Some(generation)) => {
                if let Some(job) = self
                    .composer
                    .jobs
                    .iter_mut()
                    .find(|j| j.generation == generation)
                {
                    job.requests.push(Request::Report { key, waiter: None });
                }
            }
            _ => self.request_catalog(&chat, Request::Report { key, waiter: None }),
        }
    }

    /// The connection changed (`_connectionChanged`).
    pub(super) fn composer_connection(&mut self) {
        self.composer.epoch += 1;
    }

    /// A composer intent.
    pub(super) fn composer_intent(
        &mut self,
        intent: ComposerIntent,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        match intent {
            ComposerIntent::LoadSettings { report } => {
                // `_loadSettings` reads nothing offline; the bare read
                // (`DeviceChatSettings.load`) fails there instead.
                let chat = self.state().map(|s| s.chat.clone());
                let Some(chat) = chat.filter(|_| self.connected || !report) else {
                    return settle(done, waiter, None, None);
                };
                let key = chat.key();
                if report {
                    self.request_catalog(&chat, Request::Report { key, waiter });
                } else {
                    self.request_catalog(&chat, Request::Raw { waiter });
                }
            }
            ComposerIntent::Sync {
                chat,
                model,
                harness,
                running,
            } => {
                self.sync_settings(chat, model, harness, running);
                settle(done, waiter, None, None);
            }
            ComposerIntent::Enable => {
                self.composer.enabled = true;
                settle(done, waiter, None, None);
            }
            ComposerIntent::Restore => {
                // A newer connection's loop replaces an older one.
                self.end_restore(done);
                self.composer.restore = Some(Restore {
                    epoch: self.composer.epoch,
                    input: None,
                    waiter,
                });
                self.step_restore(done);
            }
            ComposerIntent::InvalidateSettings => {
                let c = &mut self.composer;
                c.generation += 1;
                c.current = None;
                c.loading = false;
                c.scope_key = None;
                c.catalog = Catalog::default();
                c.input = None;
                settle(done, waiter, None, None);
            }
            ComposerIntent::Change { chat, pick } => self.change(chat, pick, waiter, done),
            ComposerIntent::InvalidatePicks => {
                self.composer.selection_generation += 1;
                self.sync_picks();
                settle(done, waiter, None, None);
            }
            ComposerIntent::SelectModel {
                chat,
                id,
                provider,
                harness,
            } => {
                let mut choice = ModelOption::new(&id, &id, &provider, "model", true);
                choice.harness = harness;
                self.save_command(&chat, Save::SelectModel(Box::new(choice)), waiter, done);
            }
            ComposerIntent::Patch { chat, patch } => {
                self.save_command(&chat, Save::Patch(patch), waiter, done);
            }
            ComposerIntent::Decide {
                chat,
                request_id,
                answers,
            } => {
                let command = match answers {
                    Some(answers) => json!({
                        "type": "chat.answer_question",
                        "chatId": chat.id,
                        "questionId": request_id,
                        "answers": answers,
                    }),
                    None => json!({
                        "type": "chat.dismiss_question",
                        "chatId": chat.id,
                        "questionId": request_id,
                    }),
                };
                self.command(&chat, command, move |result| Event::Decided {
                    result,
                    waiter,
                });
            }
            ComposerIntent::Fork { chat, at } => self.fork(chat, at, waiter, done),
            ComposerIntent::ForkOpened { chat, at } => {
                let key = (chat.key(), at);
                self.composer.attempts.retain(|(k, _)| *k != key);
                settle(done, waiter, None, None);
            }
            ComposerIntent::Source { read, scope } => self.source(read, scope, waiter, done),
        }
    }

    // ---- The settings catalog (`DeviceChatSettings.load`) ----

    fn request_catalog(&mut self, chat: &ChatRef, request: Request) {
        let chat = chat.clone();
        let key = chat.key();
        let c = &mut self.composer;
        if let Request::Report { .. } | Request::Restore { .. } = request
            && c.scope_key.as_deref() != Some(&key)
        {
            c.error = None;
        }
        if c.scope_key.as_deref() == Some(&key)
            && let Some(current) = c.current
            && let Some(job) = c.jobs.iter_mut().find(|j| j.generation == current)
        {
            job.requests.push(request);
            return;
        }
        if c.scope_key.as_deref() != Some(&key) {
            c.catalog = Catalog::default();
        }
        c.scope_key = Some(key);
        c.loading = true;
        c.generation += 1;
        let generation = c.generation;
        c.current = Some(generation);
        let advisor = chat.project_id == "app-advisor";
        c.jobs.push(ReadJob {
            generation,
            chat: chat.clone(),
            advisor,
            registry: None,
            projection: None,
            preferences: None,
            projects: None,
            first: None,
            requests: vec![request],
        });
        self.composer_call("model-registry:get", vec![], move |result| Event::Read {
            generation,
            part: Part::Registry,
            result,
        });
        let make = move |result| Event::Read {
            generation,
            part: Part::Projection,
            result,
        };
        if advisor {
            self.composer_call("app-advisor:settings-view", vec![], make);
        } else {
            self.composer_call(
                "desktop:session-snapshot",
                vec![json!({
                    "workspaceLocalId": chat.project_id,
                    "worktreeLocalId": chat.worktree_id,
                    "includeChatSummaries": true,
                })],
                make,
            );
        }
    }

    fn read_reply(&mut self, generation: u64, part: Part, result: Result<Value>, done: &mut Done) {
        let Some(index) = self
            .composer
            .jobs
            .iter()
            .position(|j| j.generation == generation)
        else {
            return;
        };
        let job = &mut self.composer.jobs[index];
        match part {
            Part::Registry => job.registry = Some(result),
            Part::Projection => job.projection = Some(result),
            Part::Preferences => job.preferences = Some(result),
            Part::Projects => job.projects = Some(result),
        }
        if job.first.is_none() {
            let (Some(registry), Some(projection)) = (&job.registry, &job.projection) else {
                return;
            };
            // `Future.wait`: the registry's failure, after both answered.
            let registry = match registry {
                Ok(value) => dto::desktop_value(value),
                Err(e) => {
                    let e = e.clone();
                    return self.finish_read(index, Err(ReadError::Rpc(e)), done);
                }
            };
            let registry = match object(&registry) {
                Ok(map) => map.clone(),
                Err(t) => return self.finish_read(index, Err(ReadError::Thrown(t)), done),
            };
            // The projection is optional; any failure reads as none.
            let projection = projection.as_ref().ok().and_then(|value| {
                let value = dto::desktop_value(value);
                if job.advisor {
                    object(&value).ok().cloned()
                } else {
                    registry::chat_projection(&job.chat, &value)
                }
            });
            let rows = match registry::catalog_rows(&registry, projection.as_ref()) {
                Ok(rows) => rows,
                Err(t) => return self.finish_read(index, Err(ReadError::Thrown(t)), done),
            };
            job.first = Some((registry, projection, rows));
            let advisor = job.advisor;
            self.composer_call("preferences:load", vec![], move |result| Event::Read {
                generation,
                part: Part::Preferences,
                result,
            });
            if !advisor {
                self.composer_call("projects:load", vec![], move |result| Event::Read {
                    generation,
                    part: Part::Projects,
                    result,
                });
            }
            return;
        }
        let job = &self.composer.jobs[index];
        let saved: Option<SavedDefault> = if job.advisor {
            let Some(preferences) = &job.preferences else {
                return;
            };
            let (registry, _, _) = job.first.as_ref().expect("round one");
            preferences
                .as_ref()
                .ok()
                .and_then(|p| registry::orchestrator_default(registry, &dto::desktop_value(p)))
        } else {
            let (Some(preferences), Some(projects)) = (&job.preferences, &job.projects) else {
                return;
            };
            let (registry, _, _) = job.first.as_ref().expect("round one");
            match (preferences, projects) {
                (Ok(p), Ok(q)) => registry::saved_default(
                    registry,
                    &job.chat,
                    &dto::desktop_value(p),
                    &dto::desktop_value(q),
                ),
                _ => None,
            }
        };
        let current = self.composer.generation == generation;
        if !current {
            return self.finish_read(index, Ok(()), done);
        }
        let job = &mut self.composer.jobs[index];
        let (_, projection, rows) = job.first.take().expect("round one");
        let read = registry::apply_catalog(
            std::mem::take(&mut self.composer.catalog),
            rows,
            projection.as_ref(),
            saved.as_ref(),
        );
        self.composer.catalog = read.catalog;
        let result = match read.thrown {
            Some(t) => Err(ReadError::Thrown(t)),
            None => Ok(()),
        };
        self.finish_read(index, result, done);
    }

    /// `whenComplete` and each waiting caller's continuation.
    fn finish_read(
        &mut self,
        index: usize,
        result: std::result::Result<(), ReadError>,
        done: &mut Done,
    ) {
        let job = self.composer.jobs.remove(index);
        if self.composer.current == Some(job.generation) {
            self.composer.current = None;
            self.composer.loading = false;
        }
        let failure = result.as_ref().err().map(read_failure);
        // A superseded read's outcome is not the chat's: a newer read of the
        // same chat reports it.
        let selected = self
            .selected
            .clone()
            .filter(|_| job.generation == self.composer.generation);
        let mut restore = false;
        for request in job.requests {
            match request {
                Request::Report { key, waiter } => {
                    if selected.as_deref() == Some(&key) {
                        self.composer.error = failure.as_ref().map(|f| f.message.clone());
                    }
                    settle(done, waiter, None, None);
                }
                Request::Raw { waiter } => settle(done, waiter, failure.clone(), None),
                Request::Restore { key } => {
                    if selected.as_deref() == Some(&key) {
                        self.composer.error = failure.as_ref().map(|f| f.message.clone());
                    }
                    restore = true;
                }
            }
        }
        if restore {
            self.restored(done);
        }
    }

    // ---- Reconnect (`_restore`) ----

    fn step_restore(&mut self, done: &mut Done) {
        let Some(restore) = &self.composer.restore else {
            return;
        };
        if restore.epoch != self.composer.epoch || !self.connected {
            return self.end_restore(done);
        }
        let Some(input) = self.input() else {
            return self.end_restore(done);
        };
        let key = input.key.clone();
        if let Some(restore) = &mut self.composer.restore {
            restore.input = Some(input);
        }
        let Some(chat) = self.state().map(|s| s.chat.clone()) else {
            return self.end_restore(done);
        };
        self.request_catalog(&chat, Request::Restore { key });
    }

    fn restored(&mut self, done: &mut Done) {
        let Some(restore) = &self.composer.restore else {
            return;
        };
        if restore.epoch != self.composer.epoch || !self.connected {
            return self.end_restore(done);
        }
        let latest = self.input();
        if latest.is_some() && latest == restore.input {
            self.composer.input = latest;
            return self.end_restore(done);
        }
        self.step_restore(done);
    }

    fn end_restore(&mut self, done: &mut Done) {
        if let Some(restore) = self.composer.restore.take() {
            settle(done, restore.waiter, None, None);
        }
    }

    // ---- Commands (`DeviceChatSettings.command`) ----

    /// One `chat:command` on `chat`'s scope; its outcome arrives as `make`.
    fn command(
        &self,
        chat: &ChatRef,
        command: Value,
        make: impl FnOnce(std::result::Result<i64, CommandError>) -> Event + Send + 'static,
    ) {
        let args = json!({
            "schemaVersion": 1,
            "commandId": uuid(),
            "projectId": chat.project_id,
            "worktreeId": chat.worktree_id,
            "command": command,
        });
        self.composer_call("chat:command", vec![args], move |result| {
            make(receipt(result))
        });
    }

    /// `selectModel`, `selectAuto` or `patch`, validated against the
    /// catalog as Dart did before sending.
    fn save_value(&self, chat: &ChatRef, save: &Save) -> std::result::Result<Value, CommandError> {
        let scoped = self.composer.scope_key.as_deref() == Some(chat.key().as_str());
        match save {
            Save::SelectModel(choice) => {
                if !scoped
                    || !selection::valid_agent_selection(
                        &self.composer.catalog.models,
                        Some(&choice.id),
                    )
                {
                    return Err(CommandError::Rejected(
                        copy::text(CopyKey::RefreshModels).into(),
                    ));
                }
                let mut command = json!({
                    "type": "chat.set_model",
                    "tabId": chat.id,
                    "model": choice.id,
                    "providerType": choice.provider,
                });
                if let Some(harness) = &choice.harness {
                    command["executionHarness"] = json!(harness);
                }
                Ok(command)
            }
            Save::SelectAuto => {
                if !scoped || !self.composer.catalog.routing_supported {
                    return Err(CommandError::Rejected(
                        copy::text(CopyKey::AutoUnavailable).into(),
                    ));
                }
                Ok(json!({
                    "type": "chat.patch_tab_settings",
                    "tabId": chat.id,
                    "patch": {"modelSelectionMode": "auto"},
                }))
            }
            Save::Patch(patch) => Ok(json!({
                "type": "chat.patch_tab_settings",
                "tabId": chat.id,
                "patch": dto::bridge_map(patch),
            })),
        }
    }

    /// A direct `selectModel` or `patch` (Home's new task): its revision.
    fn save_command(
        &mut self,
        chat: &ChatRef,
        save: Save,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        match self.save_value(chat, &save) {
            Ok(command) => self.command(chat, command, move |result| Event::Decided {
                result,
                waiter,
            }),
            Err(error) => settle(done, waiter, Some(command_failure(&error)), None),
        }
    }

    // ---- Picks (`DeviceComposerSettingsController`) ----

    fn picks_scope(&self) -> Scope {
        let state = self.state();
        (
            state.map(|s| s.chat.key()),
            state.map(|s| s.closed),
            self.composer.epoch,
            self.composer.selection_generation,
        )
    }

    /// `sync`: a new scope drops the queue; a receipt the chat's revision
    /// reached releases its pick.
    fn sync_picks(&mut self) {
        let scope = self.picks_scope();
        let c = &mut self.composer;
        if c.scope.as_ref() != Some(&scope) {
            c.scope = Some(scope);
            for selection in c.selections.drain(..) {
                if let Some(waiter) = selection.waiter {
                    let _ = waiter.send(changed(false));
                }
            }
            c.failure = None;
            c.requires_refresh = false;
        }
        let revision = self.state().map(|s| s.revision);
        self.composer
            .selections
            .retain(|s| match (s.revision, revision) {
                (Some(receipt), Some(state)) => state < receipt,
                _ => true,
            });
    }

    /// The tab with the queued picks applied.
    pub(super) fn picked_tab(&self) -> DvMap {
        let tab = self.state().map(|s| s.tab.clone()).unwrap_or_default();
        self.composer
            .selections
            .iter()
            .fold(tab, |tab, s| pick::merge(&tab, &s.patch))
    }

    pub(super) fn picks_saving(&self) -> bool {
        !self.composer.selections.is_empty()
            || (self.composer.draining && self.composer.working_scope == Some(self.picks_scope()))
    }

    pub(super) fn picks_refreshing(&self) -> bool {
        self.composer.refresh_scope == Some(self.picks_scope())
    }

    fn resolve_pick(&self, chat: &ChatRef, pick: PickIntent) -> Option<Pick> {
        Some(match pick {
            PickIntent::Effort(level) => Pick::Effort(level),
            PickIntent::Auto => Pick::Auto,
            PickIntent::PlanMode(enabled) => Pick::PlanMode(enabled),
            PickIntent::Fast(fast) => Pick::Fast(fast),
            PickIntent::Model {
                id,
                execution_harness,
            } => {
                let scoped = self.composer.scope_key.as_deref() == Some(chat.key().as_str());
                let catalog: &[ModelOption] = if scoped {
                    &self.composer.catalog.models
                } else {
                    &[]
                };
                // Explicitly unlocked chats may switch; older hosts keep
                // their lock.
                let locked = if scoped && self.composer.catalog.harness_locked != Some(false) {
                    self.composer.catalog.execution_harness.clone()
                } else {
                    None
                };
                Pick::Model(Box::new(selection::selection_model_option(
                    catalog,
                    Some(&id),
                    execution_harness.or(locked).as_deref(),
                )?))
            }
        })
    }

    /// `change`.
    fn change(&mut self, chat: ChatRef, pick: PickIntent, waiter: Option<Waiter>, done: &mut Done) {
        let Some(pick) = self.resolve_pick(&chat, pick) else {
            return settle(done, waiter, None, Some(changed_outcome(false)));
        };
        self.sync_picks();
        if self.composer.requires_refresh {
            let scope = self.composer.scope.clone();
            return self.refresh_chat(
                After::Change {
                    chat,
                    pick,
                    waiter,
                    scope,
                },
                done,
            );
        }
        self.queue(chat, pick, waiter, done);
    }

    fn queue(&mut self, chat: ChatRef, pick: Pick, waiter: Option<Waiter>, done: &mut Done) {
        if self.disposed || self.selected.as_deref() != Some(chat.key().as_str()) {
            return settle(done, waiter, None, Some(changed_outcome(false)));
        }
        self.composer.ids += 1;
        let id = self.composer.ids;
        self.composer.selections.push(Selection {
            id,
            patch: pick::optimistic(&pick),
            pick,
            chat,
            revision: None,
            waiter,
        });
        self.composer.failure = None;
        if !self.composer.draining {
            self.composer.draining = true;
            self.drain(done);
        }
    }

    /// Re-reads the selected chat (`chats.refresh`), then continues
    /// `after`.
    fn refresh_chat(&mut self, after: After, done: &mut Done) {
        let chat = self.state().map(|s| s.chat.clone());
        match chat.filter(|_| self.connected) {
            Some(chat) => {
                self.open(chat, None, None, done);
                self.composer.refreshes.push((self.reads, after));
            }
            None => {
                let failure = Failure::link(ChatCopy::ReconnectFirst);
                self.after_refresh(after, RefreshResult::Failed(&failure), done);
            }
        }
    }

    pub(super) fn replace_composer_read(&mut self, previous: u64) {
        let current_scope = self.picks_scope();
        for (read, after) in &mut self.composer.refreshes {
            let scope = match after {
                After::Change { scope, .. }
                | After::CatchUp { scope }
                | After::Uncertain { scope, .. } => scope,
            };
            if *read == previous && scope.as_ref() == Some(&current_scope) {
                *read = self.reads;
            }
        }
    }

    /// An open finished; continues refreshes waiting for it.
    pub(super) fn composer_opened(
        &mut self,
        read: u64,
        result: RefreshResult<'_>,
        done: &mut Done,
    ) {
        while let Some(index) = self.composer.refreshes.iter().position(|(r, _)| *r == read) {
            let (_, after) = self.composer.refreshes.remove(index);
            self.after_refresh(after, result, done);
        }
    }

    fn after_refresh(&mut self, after: After, result: RefreshResult<'_>, done: &mut Done) {
        let hydrated = matches!(result, RefreshResult::Hydrated);
        match after {
            After::Change {
                chat,
                pick,
                waiter,
                scope,
            } => {
                if !hydrated || self.disposed || scope != Some(self.picks_scope()) {
                    return settle(done, waiter, None, Some(changed_outcome(false)));
                }
                self.composer.requires_refresh = false;
                self.queue(chat, pick, waiter, done);
            }
            After::CatchUp { scope } => {
                if self.composer.refresh_scope == scope {
                    self.composer.refresh_scope = None;
                }
                if !hydrated {
                    if !self.disposed && scope != Some(self.picks_scope()) {
                        return self.resume(done);
                    }
                    if !self.disposed {
                        self.composer.requires_refresh = true;
                        if let RefreshResult::Failed(failure) = result {
                            self.composer.failure =
                                Some(pick_failure(None, Some(failure), &DvMap::new()));
                        }
                        for selection in self.composer.selections.drain(..) {
                            if let Some(waiter) = selection.waiter {
                                let _ = waiter.send(changed(false));
                            }
                        }
                    }
                    return self.stop_draining();
                }
                self.sync_picks();
                if self
                    .composer
                    .selections
                    .iter()
                    .any(|s| s.revision.is_none())
                {
                    return self.drain(done);
                }
                self.stop_draining();
            }
            After::Uncertain { scope, id, waiter } => {
                if hydrated && scope == Some(self.picks_scope()) {
                    self.composer.requires_refresh = false;
                }
                let _ = id;
                settle(done, waiter, None, Some(changed_outcome(false)));
                self.sync_picks();
                self.drain(done);
            }
        }
    }

    fn stop_draining(&mut self) {
        self.composer.draining = false;
        self.composer.working_scope = None;
    }

    /// `_drain`, from the top of its loop until it waits.
    fn drain(&mut self, done: &mut Done) {
        if self.disposed {
            return self.stop_draining();
        }
        self.sync_picks();
        let next = self
            .composer
            .selections
            .iter()
            .position(|s| s.revision.is_none());
        let receipts = self
            .composer
            .selections
            .iter()
            .any(|s| s.revision.is_some());
        let Some(next) = next.filter(|_| !receipts) else {
            if self.composer.selections.is_empty() {
                return self.stop_draining();
            }
            // The receipt and the push can complete on adjacent turns.
            let _ = self.inbox.send(Msg::Composer(Event::Resume));
            return;
        };
        let scope = self.composer.scope.clone();
        self.composer.working_scope = scope.clone();
        let mut effective = self.state().map(|s| s.tab.clone()).unwrap_or_default();
        for selection in &self.composer.selections[..=next] {
            effective = pick::merge(&effective, &selection.patch);
        }
        let selection = &mut self.composer.selections[next];
        let (id, chat) = (selection.id, selection.chat.clone());
        let save = pick::save(&selection.pick, &effective);
        self.composer.saving = Some((id, scope));
        match self.save_value(&chat, &save) {
            Ok(command) => self.command(&chat, command, move |result| Event::Saved { id, result }),
            Err(error) => self.saved(id, Err(error), done),
        }
    }

    fn resume(&mut self, done: &mut Done) {
        if !self.composer.draining || self.composer.saving.is_some() || self.picks_refreshing() {
            return;
        }
        self.sync_picks();
        if self.composer.selections.is_empty() {
            return self.stop_draining();
        }
        if self
            .composer
            .selections
            .iter()
            .all(|s| s.revision.is_none())
        {
            return self.drain(done);
        }
        // A receipt can have side effects beyond the patch: recover the
        // state before building the next write from the canonical tab.
        let scope = self.composer.scope.clone();
        self.composer.refresh_scope = scope.clone();
        self.refresh_chat(After::CatchUp { scope }, done);
    }

    fn saved(&mut self, id: u64, result: std::result::Result<i64, CommandError>, done: &mut Done) {
        let Some((saving, scope)) = self.composer.saving.take() else {
            return;
        };
        if saving != id {
            return;
        }
        // A pick dropped meanwhile (a new scope) was already answered.
        let waiter = self
            .composer
            .selections
            .iter_mut()
            .find(|s| s.id == id)
            .and_then(|s| s.waiter.take());
        let current = !self.disposed && scope == Some(self.picks_scope());
        let patch = self
            .composer
            .selections
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.patch.clone())
            .unwrap_or_default();
        match result {
            Ok(revision) => {
                if current && let Some(s) = self.composer.selections.iter_mut().find(|s| s.id == id)
                {
                    s.revision = Some(revision);
                }
                settle(done, waiter, None, Some(changed_outcome(current)));
            }
            Err(error) => {
                if current {
                    if reported(&error) {
                        let position = self.composer.selections.iter().position(|s| s.id == id);
                        let superseded = position.is_some_and(|p| {
                            self.composer.selections[p + 1..]
                                .iter()
                                .any(|later| patch.iter().all(|(k, _)| later.patch.contains_key(k)))
                        });
                        self.composer.selections.retain(|s| s.id != id);
                        if !superseded {
                            self.composer.failure = Some(pick_failure(Some(&error), None, &patch));
                        }
                    } else {
                        // A timeout or lost reply can still commit on the
                        // computer: cancel dependent picks and re-read.
                        for selection in self.composer.selections.drain(..) {
                            if let Some(w) = selection.waiter {
                                let _ = w.send(changed(false));
                            }
                        }
                        self.composer.requires_refresh = true;
                        self.composer.failure = Some(pick_failure(Some(&error), None, &patch));
                        settle(done, waiter, None, Some(changed_outcome(false)));
                        let scope = scope.clone();
                        return self.refresh_chat(
                            After::Uncertain {
                                scope,
                                id,
                                waiter: None,
                            },
                            done,
                        );
                    }
                }
                settle(done, waiter, None, Some(changed_outcome(false)));
            }
        }
        if !self.disposed {
            self.sync_picks();
        }
        self.drain(done);
    }

    // ---- Forks (`DeviceChatForks.fork`) ----

    fn fork(&mut self, source: ChatRef, at: String, waiter: Option<Waiter>, done: &mut Done) {
        if !self.ready()
            || !self.state().is_some_and(|state| {
                state.chat.key() == source.key() && !state.closed && !state.read_only()
            })
        {
            settle(
                done,
                waiter,
                Some(Failure::link(ChatCopy::ReconnectFirst)),
                None,
            );
            return;
        }
        let key = (source.key(), at.clone());
        let (command_id, tab_id) = match self.composer.attempts.iter().find(|(k, _)| *k == key) {
            Some((_, ids)) => ids.clone(),
            None => {
                let ids = (uuid(), uuid());
                self.composer.attempts.push((key, ids.clone()));
                ids
            }
        };
        let args = json!({
            "schemaVersion": 1,
            "commandId": command_id,
            "projectId": source.project_id,
            "worktreeId": source.worktree_id,
            "command": {
                "type": "chat.fork_tab",
                "sourceTabId": source.id,
                "targetTabId": tab_id,
                "atMessageId": at,
            },
        });
        let epoch = self.selection_epoch;
        self.composer_call("chat:command", vec![args], move |result| Event::Forked {
            source: (source, epoch),
            at,
            tab_id,
            result,
            waiter,
        });
    }

    fn forked(
        &mut self,
        (source, epoch): (ChatRef, u64),
        at: String,
        tab_id: String,
        result: Result<Value>,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        let reply = match result {
            Ok(value) => dto::desktop_value(&value),
            Err(error) => return settle(done, waiter, Some(super::sends::transport(&error)), None),
        };
        let Ok(result) = object(&reply) else {
            return settle(
                done,
                waiter,
                Some(link(chat_copy::text(ChatCopy::InvalidMessage))),
                None,
            );
        };
        let outcome = result.get("outcome");
        let applied = ["applied", "already_applied"]
            .iter()
            .any(|o| outcome.is_str(o));
        if !applied || !result.get("entityId").is_str(&tab_id) {
            if ["rejected", "not_found", "conflict"]
                .iter()
                .any(|o| outcome.is_str(o))
            {
                let key = (source.key(), at);
                self.composer.attempts.retain(|(k, _)| *k != key);
            }
            return settle(
                done,
                waiter,
                Some(link(copy::text(CopyKey::ForkNotConfirmed))),
                None,
            );
        }
        let still_selected = !self.disposed
            && self.connected
            && self.selection_epoch == epoch
            && self.closing_tab_key() != Some(source.key().as_str())
            && self
                .state()
                .is_some_and(|state| state.chat.key() == source.key() && !state.closed);
        let chat = ChatRef {
            project_id: source.project_id,
            worktree_id: source.worktree_id,
            id: tab_id,
            title: source.title,
        };
        if still_selected {
            self.select_chat(chat, waiter, done);
        } else {
            settle(done, waiter, None, Some(Outcome::Forked(chat)));
        }
    }

    // ---- Composer sources (`DeviceComposerSources`) ----

    /// The settings catalog's harness for the selected chat (`_harness`).
    fn scoped_harness(&self) -> Option<String> {
        let key = self.state().map(|s| s.chat.key())?;
        (self.composer.scope_key.as_deref() == Some(&key))
            .then(|| self.composer.catalog.execution_harness.clone())
            .flatten()
    }

    /// `current()`'s check: the captured chat is still the shown one.
    fn source_current(&self, scope: &SourceScope) -> bool {
        let Some(state) = self.state() else {
            return false;
        };
        !self.disposed
            && self.connected
            && self.ready()
            && self.generation == scope.generation
            && state.chat.key() == scope.chat.key()
            && !state.closed
            && *state.tab.get("model") == scope.model
            && *state.tab.get("executionHarness") == scope.tab_harness
    }

    /// `checkTarget` and, for the inventory, `inventoryHarness`.
    fn source_check(
        &self,
        read: SourceRead,
        scope: &SourceScope,
    ) -> std::result::Result<Option<String>, Failure> {
        if !self.source_current(scope) {
            return Err(link(copy::text(CopyKey::ChatChangedReopen)));
        }
        if read != SourceRead::Inventory {
            return Ok(None);
        }
        match self.scoped_harness() {
            Some(harness) => Ok(Some(harness)),
            None => Err(link(copy::text(CopyKey::ChoicesNotLoaded))),
        }
    }

    fn source(
        &mut self,
        read: SourceRead,
        scope: SourceScope,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        let harness = match self.source_check(read, &scope) {
            Ok(harness) => harness,
            Err(failure) => return settle(done, waiter, Some(failure), None),
        };
        let calls: Vec<(&str, Vec<Value>)> = match read {
            SourceRead::Inventory => vec![(
                "invocable-inventory:load",
                vec![json!({"providerType": harness})],
            )],
            SourceRead::PluginCatalog => vec![
                ("collections:load-index", vec![]),
                ("skills:load", vec![]),
                ("plugins:loadCacheOnly", vec![]),
                ("mcp-servers:load-index", vec![]),
            ],
            SourceRead::Selections => vec![(
                "chat:get-state",
                vec![
                    json!({"projectId": scope.chat.project_id, "worktreeId": scope.chat.worktree_id}),
                ],
            )],
        };
        let count = calls.len();
        let replies: Arc<Mutex<Vec<Option<Result<Value>>>>> =
            Arc::new(Mutex::new((0..count).map(|_| None).collect()));
        let job = Arc::new(Mutex::new(Some((scope, harness, waiter))));
        for (i, (channel, args)) in calls.into_iter().enumerate() {
            let (replies, job) = (replies.clone(), job.clone());
            self.composer_call(channel, args, move |result| {
                let mut all = replies.lock().unwrap_or_else(PoisonError::into_inner);
                all[i] = Some(result);
                if all.iter().all(Option::is_some) {
                    let replies = all.iter_mut().filter_map(Option::take).collect();
                    let job = job.lock().unwrap_or_else(PoisonError::into_inner).take();
                    if let Some((scope, harness, waiter)) = job {
                        return Event::Source {
                            read,
                            scope,
                            harness,
                            replies,
                            waiter,
                        };
                    }
                }
                Event::Partial
            });
        }
    }

    fn sourced(
        &mut self,
        read: SourceRead,
        scope: SourceScope,
        harness: Option<String>,
        replies: Vec<Result<Value>>,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        // `Future.wait`: the first failure in call order.
        let mut values = Vec::new();
        for reply in replies {
            match reply {
                Ok(value) => values.push(dto::desktop_value(&value)),
                Err(error) => {
                    return settle(done, waiter, Some(super::sends::transport(&error)), None);
                }
            }
        }
        let fail = |e: CatalogError| match e {
            CatalogError::Thrown(Thrown::Invalid) => {
                link(chat_copy::text(ChatCopy::InvalidMessage))
            }
            CatalogError::Thrown(Thrown::Cast) => other(String::new()),
            CatalogError::NoData => link(copy::text(CopyKey::ChoicesFailed)),
            CatalogError::Closed => link(copy::text(CopyKey::ChatClosed)),
        };
        let outcome = match read {
            SourceRead::Inventory => {
                let harness = harness.unwrap_or_default();
                match catalog::inventory(&harness, &values[0]) {
                    Ok((commands, unsettled)) => {
                        if self.source_check(read, &scope).ok().flatten().as_deref()
                            != Some(harness.as_str())
                        {
                            let failure = match self.source_check(read, &scope) {
                                Err(f) => f,
                                Ok(_) => link(copy::text(CopyKey::ChatChanged)),
                            };
                            return settle(done, waiter, Some(failure), None);
                        }
                        Outcome::Inventory {
                            commands: commands
                                .into_iter()
                                .map(|c| CommandRow {
                                    name: c.name,
                                    display_name: c.display_name,
                                    description: c.description,
                                    entry_id: c.entry_id,
                                })
                                .collect(),
                            unsettled,
                        }
                    }
                    Err(e) => return settle(done, waiter, Some(fail(e)), None),
                }
            }
            SourceRead::PluginCatalog => {
                let projected = catalog::data(&values[1])
                    .and_then(|skills| catalog::data(&values[2]).map(|plugins| (skills, plugins)))
                    .and_then(|(skills, plugins)| {
                        catalog::plugin_catalog(&values[0], skills, plugins, &values[3])
                            .map_err(CatalogError::Thrown)
                    });
                match projected {
                    Ok(value) => {
                        if let Err(failure) = self.source_check(read, &scope) {
                            return settle(done, waiter, Some(failure), None);
                        }
                        Outcome::Catalog(dto::bridge_value(&value).to_string())
                    }
                    Err(e) => return settle(done, waiter, Some(fail(e)), None),
                }
            }
            SourceRead::Selections => match catalog::snapshot(&scope.chat, &values[0]) {
                Ok(snapshot) => {
                    if let Err(failure) = self.source_check(read, &scope) {
                        return settle(done, waiter, Some(failure), None);
                    }
                    if snapshot.model != scope.model
                        || snapshot.execution_harness != scope.tab_harness
                    {
                        return settle(
                            done,
                            waiter,
                            Some(link(copy::text(CopyKey::ModelChanged))),
                            None,
                        );
                    }
                    Outcome::Selections(
                        snapshot.selections.map(|s| dto::bridge_map(&s).to_string()),
                    )
                }
                Err(e) => return settle(done, waiter, Some(fail(e)), None),
            },
        };
        settle(done, waiter, None, Some(outcome));
    }

    /// A composer reply or continuation.
    pub(super) fn composer_event(&mut self, event: Event, done: &mut Done) {
        match event {
            Event::Read {
                generation,
                part,
                result,
            } => self.read_reply(generation, part, result, done),
            Event::Saved { id, result } => self.saved(id, result, done),
            Event::Resume => self.resume(done),
            Event::Partial => {}
            Event::Decided { result, waiter } => match result {
                Ok(revision) => settle(done, waiter, None, Some(Outcome::Saved { revision })),
                Err(error) => settle(done, waiter, Some(command_failure(&error)), None),
            },
            Event::Forked {
                source,
                at,
                tab_id,
                result,
                waiter,
            } => self.forked(source, at, tab_id, result, waiter, done),
            Event::Source {
                read,
                scope,
                harness,
                replies,
                waiter,
            } => self.sourced(read, scope, harness, replies, waiter, done),
        }
    }

    /// `invocable-inventory:changed`: the inventory loads again.
    pub(super) fn inventory_changed(&mut self) {
        self.composer.inventory_revision += 1;
    }

    pub(super) fn composer_shown(&self) -> Shown {
        Shown {
            catalog: self.composer.catalog.clone(),
            scope_key: self.composer.scope_key.clone(),
            loading: self.composer.loading,
            error: self.composer.error.clone(),
            tab: self.picked_tab(),
            saving: self.picks_saving(),
            refreshing: self.picks_refreshing(),
            failure: self.composer.failure.clone(),
            inventory_revision: self.composer.inventory_revision,
        }
    }
}

/// `command`'s receipt: the revision, or why it failed.
fn receipt(result: Result<Value>) -> std::result::Result<i64, CommandError> {
    let reply = dto::desktop_value(&result.map_err(CommandError::Rpc)?);
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
            None => chat_copy::text(ChatCopy::CommandRefused).into(),
        }));
    }
    if !["applied", "already_applied"]
        .iter()
        .any(|o| outcome.is_str(o))
    {
        return Err(CommandError::Format);
    }
    match response.get("revision") {
        Dv::Int(revision) => Ok(*revision),
        _ => Err(CommandError::Format),
    }
}

fn changed_outcome(applied: bool) -> Outcome {
    Outcome::Changed { applied }
}

fn changed(applied: bool) -> super::Settled {
    super::Settled {
        revision: 0,
        failure: None,
        outcome: Some(changed_outcome(applied)),
    }
}

/// The composer's intents.
pub(crate) enum ComposerIntent {
    /// The host reads the composer from the core.
    Enable,
    /// `_syncSettings` ran with this chat state.
    Sync {
        chat: ChatRef,
        model: Dv,
        harness: Dv,
        running: bool,
    },
    /// `loadSettings` (`report`) or `DeviceChatSettings.load`.
    LoadSettings {
        report: bool,
    },
    /// `_restore`'s loop.
    Restore,
    InvalidateSettings,
    Change {
        chat: ChatRef,
        pick: PickIntent,
    },
    InvalidatePicks,
    SelectModel {
        chat: ChatRef,
        id: String,
        provider: String,
        harness: Option<String>,
    },
    Patch {
        chat: ChatRef,
        patch: DvMap,
    },
    /// `answers` is the answer list in bridge form; `None` dismisses.
    Decide {
        chat: ChatRef,
        request_id: String,
        answers: Option<Value>,
    },
    Fork {
        chat: ChatRef,
        at: String,
    },
    ForkOpened {
        chat: ChatRef,
        at: String,
    },
    Source {
        read: SourceRead,
        scope: SourceScope,
    },
}

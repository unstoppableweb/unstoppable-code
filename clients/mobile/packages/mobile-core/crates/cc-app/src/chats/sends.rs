//! One computer's chat writes (P5b), ported from the write half of the
//! former `DeviceChatsRepository` (`device_link/chats/dart_sender.dart`)
//! and `dart_attachments.dart`; comments cite the Dart rule they keep.
//!
//! Every write is sent at most once and never retried by the core: an
//! answer the phone did not get (a timeout, an ended session, a refusal
//! after the desktop may have written, even a request not sent) leaves the
//! attempt pending with the same ids, as Dart decides, until the
//! transcript confirms it or the user retries that attempt. Only a reply
//! with `refusedAuthDependencies` drops it.
use super::{
    Actor, ChatRef, Done, FailKind, Failure, Msg, Outcome, Peer, Waiter, call, drafts, object,
    target_of, uuid,
};
use crate::{
    bridge::Inner,
    copy::chats::{self as copy, CopyKey},
    error::{Error, Result},
    failures,
};
use cc_domain::{
    chat::{
        self,
        send::{self, PendingSend, SendRefusal, SendRequest},
    },
    dart::Dv,
};
use cc_protocol::{FailureKind, dto};
use serde_json::{Map, Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

/// `DeviceChatAttachments.uploadTimeout`: a whole file is one request.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Serializes Home task cancellation with queued chat work and first-message dispatch.
#[derive(Clone, Default)]
pub(crate) struct SendGate(Arc<Mutex<bool>>);

impl SendGate {
    pub(crate) fn cancel(&self) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = true;
    }

    pub(crate) fn dispatch<T>(&self, send: impl FnOnce() -> T) -> Option<T> {
        let cancelled = self.0.lock().unwrap_or_else(|p| p.into_inner());
        (!*cancelled).then(send)
    }
}

/// A send the host asks for.
pub(crate) struct SendIntent {
    /// The chat the send is for; none is the selected chat.
    pub(crate) chat: Option<ChatRef>,
    pub(crate) generation: Option<u64>,
    /// Home can cancel the first send until it is queued for the session.
    pub(crate) gate: Option<SendGate>,
    pub(crate) text: String,
    pub(crate) retry: bool,
    pub(crate) dictated: bool,
    pub(crate) attachment_paths: Vec<String>,
}

/// A created entry's ids before the generation check (Dart builds the ref
/// after it).
pub(super) struct Creation {
    project_id: String,
    worktree_id: String,
    tab_id: String,
    entity: Dv,
    title: String,
    /// `createChat`: a non-string entity id falls back to the tab id;
    /// `createTab` casts it (`as String?`).
    starter: bool,
}

/// What the Dart transport throws for `error`, as the caller sees it
/// (`rust_core/failures.dart` `rustFailure`).
pub(super) fn transport(error: &Error) -> Failure {
    let message = failures::read_failure(error);
    match (error.kind, message) {
        (FailureKind::Refused, Some(message)) => Failure {
            message,
            kind: FailKind::Refused,
            code: (error.code != "desktop_refused").then(|| error.code.clone()),
        },
        (FailureKind::NotSent, Some(message)) => Failure {
            message,
            kind: FailKind::NotSent,
            code: None,
        },
        (_, Some(message)) => Failure {
            message,
            kind: FailKind::Link,
            code: None,
        },
        (_, None) => Failure {
            message: String::new(),
            kind: FailKind::Other,
            code: None,
        },
    }
}

fn invalid() -> Failure {
    Failure::link(CopyKey::InvalidMessage)
}

fn refusal(r: SendRefusal) -> Failure {
    Failure::link(match r {
        SendRefusal::NotReady => CopyKey::SendNotReady,
        SendRefusal::TooLong => CopyKey::SendTooLong,
        SendRefusal::PreviousUnconfirmed => CopyKey::PreviousUnconfirmed,
        SendRefusal::OpenOriginal => CopyKey::OpenOriginalToRetry,
    })
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

/// `{...scope, ...}` of `chat`.
fn scope_with(chat: &ChatRef, extra: Value) -> Value {
    let mut args = json!({"projectId": chat.project_id, "worktreeId": chat.worktree_id});
    if let (Some(args), Value::Object(extra)) = (args.as_object_mut(), extra) {
        args.extend(extra);
    }
    args
}

/// A call with its own reply limit.
async fn call_with(
    inner: &Inner,
    peer: &Peer,
    channel: &str,
    args: Vec<Value>,
    limit: Duration,
) -> Result<Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    inner.invoke(
        peer,
        channel,
        args,
        limit,
        crate::ports::Responder::new(move |result| {
            let _ = tx.send(result);
        }),
    )?;
    rx.await
        .unwrap_or_else(|_| Err(cc_protocol::rpc::ended("session_ended")))
}

impl Actor {
    // ---- Sends (`send`, `_confirm`, `_readerChanged`, `_releaseClosedSend`) ----

    pub(super) fn send(&mut self, intent: SendIntent, waiter: Option<Waiter>, done: &mut Done) {
        if intent
            .generation
            .is_some_and(|generation| generation != self.generation)
            || intent
                .chat
                .as_ref()
                .is_some_and(|chat| self.selected.as_deref() != Some(chat.key().as_str()))
        {
            return settle(
                done,
                waiter,
                Some(Failure::link(CopyKey::ChatChanged)),
                None,
            );
        }
        let ready = self.ready();
        let attempt = send::attempt(
            ready,
            self.state(),
            self.sending,
            self.pending.as_ref(),
            SendRequest {
                text: &intent.text,
                retry: intent.retry,
                dictated: intent.dictated,
                attachment_paths: &intent.attachment_paths,
            },
            uuid,
        );
        let attempt = match attempt {
            Ok(attempt) => attempt,
            Err(r) => return settle(done, waiter, Some(refusal(r)), None),
        };
        let settings = self
            .state()
            .map(|s| send::send_settings(&s.tab))
            .unwrap_or_default();
        let mut args = Map::new();
        if let Value::Object(target) = target_of(&attempt.chat) {
            args.extend(target);
        }
        for (key, value) in settings {
            args.insert(key.into(), dto::bridge_value(&value));
        }
        args.insert("userMessageId".into(), json!(attempt.id));
        args.insert("clientUserMessageId".into(), json!(attempt.id));
        args.insert("text".into(), json!(attempt.text));
        if !attempt.attachment_paths.is_empty() {
            args.insert("attachmentPaths".into(), json!(attempt.attachment_paths));
        }
        args.insert(
            "inputMode".into(),
            json!(if attempt.dictated { "voice" } else { "typed" }),
        );
        let Some(inner) = self.inner.upgrade() else {
            return settle(
                done,
                waiter,
                Some(transport(&super::shutdown_failure())),
                None,
            );
        };
        // Queue the request in the same actor turn that checked the selection.
        let send = || inner.request(&self.peer, "chat:send-message", vec![Value::Object(args)]);
        let request = match intent.gate {
            Some(gate) => gate.dispatch(send),
            None => Some(send()),
        };
        let Some(request) = request else {
            return settle(done, waiter, None, None);
        };
        self.pending = Some(attempt.clone());
        self.sending = true;
        self.set_error(None);
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            let result = match request {
                Ok(rx) => rx
                    .await
                    .unwrap_or_else(|_| Err(cc_protocol::rpc::ended("session_ended"))),
                Err(error) => Err(error),
            };
            let _ = inbox.send(Msg::Sent {
                attempt,
                result,
                waiter,
            });
        });
    }

    pub(super) fn sent(
        &mut self,
        attempt: PendingSend,
        result: Result<Value>,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        self.sending = false;
        // `deviceLinkObject(deviceChatDto(reply))`, then the auth check.
        let refused_auth = match &result {
            Ok(reply) => match dto::desktop_value(reply) {
                Dv::Map(reply) => Some(!reply.get("refusedAuthDependencies").is_null()),
                _ => None,
            },
            Err(_) => None,
        };
        if refused_auth == Some(false) {
            self.confirm(&attempt);
            return settle(done, waiter, None, Some(Outcome::Sent { accepted: true }));
        }
        // The transcript may have confirmed it while the call ran.
        if self.confirmed.as_ref().is_some_and(|c| c.id == attempt.id) {
            return settle(done, waiter, None, Some(Outcome::Sent { accepted: true }));
        }
        if refused_auth == Some(true) {
            if self.pending.as_ref().is_some_and(|p| p.id == attempt.id) {
                self.pending = None;
            }
            let failure = Failure {
                message: copy::text(CopyKey::ProviderSignInRequired).into(),
                kind: FailKind::Refused,
                code: None,
            };
            self.set_error(Some(failure.message.clone()));
            return settle(done, waiter, Some(failure), None);
        }
        // A generic failure can follow the desktop's durable write: keep
        // the attempt's identity even when the peer returned an error.
        let error = match &result {
            Err(e) if e.kind == FailureKind::Refused => {
                let reason = transport(e).message;
                copy::render(CopyKey::RefusedCheckDelivery, &reason)
            }
            _ => copy::text(CopyKey::MayHaveReached).into(),
        };
        self.set_error(Some(error));
        settle(done, waiter, None, Some(Outcome::Sent { accepted: false }))
    }

    /// `_confirm`, and the chat model's `_reconcileDraft`: the confirmed
    /// text leaves the draft when the draft still equals it.
    pub(super) fn confirm(&mut self, attempt: &PendingSend) {
        let changed = self.confirmed.as_ref().is_none_or(|c| c.id != attempt.id);
        self.confirmed = Some(attempt.clone());
        if self.pending.as_ref().is_some_and(|p| p.id == attempt.id) {
            self.pending = None;
        }
        if changed {
            self.clear_sent_draft(&attempt.chat, &attempt.text);
        }
    }

    /// After every applied message: the selection may confirm the pending
    /// send, or show that its chat closed.
    pub(super) fn observe_sends(&mut self) {
        if let Some(pending) = self.pending.clone()
            && send::confirms(self.state(), self.hydrating, &pending)
        {
            self.confirm(&pending);
        }
        if let Some(pending) = &self.pending
            && send::released(
                self.state(),
                pending,
                self.ready(),
                self.hydrating,
                self.loading,
            )
        {
            self.pending = None;
            self.set_error(Some(copy::text(CopyKey::OriginalClosed).into()));
        }
    }

    // ---- Stop (`stop`) ----

    pub(super) fn stop(&mut self, chat: ChatRef, waiter: Option<Waiter>, done: &mut Done) {
        if !self.connected {
            return settle(done, waiter, None, None);
        }
        if self.selected.as_deref() != Some(chat.key().as_str()) {
            return settle(
                done,
                waiter,
                Some(Failure::link(CopyKey::ChatChanged)),
                None,
            );
        }
        let epoch = self.selection_epoch;
        self.spawn(move |inner, peer| async move {
            let result = call(&inner, &peer, "chat:cancel", vec![target_of(&chat)]).await;
            Msg::Cancelled {
                epoch,
                result,
                waiter,
            }
        });
    }

    /// The cancel acknowledgement is authoritative: re-read the chat unless
    /// the selection moved on (never retarget a late reply).
    pub(super) fn cancelled(
        &mut self,
        epoch: u64,
        result: Result<Value>,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        if let Err(error) = result {
            return settle(done, waiter, Some(transport(&error)), None);
        }
        if self.connected && !self.disposed && epoch == self.selection_epoch {
            self.refresh(waiter, done);
        } else {
            settle(done, waiter, None, None);
        }
    }

    // ---- Creation (`createChat`, `createTab`) ----

    pub(super) fn create_tab(
        &mut self,
        project_id: String,
        worktree_id: String,
        select: bool,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        if !self.connected {
            return settle(
                done,
                waiter,
                Some(Failure::link(CopyKey::ReconnectFirst)),
                None,
            );
        }
        let tab_id = uuid();
        let generation = self.generation;
        if select {
            self.closing_tab = self.selected.clone().map(|key| (generation, key));
        }
        let title = copy::text(CopyKey::NewChat).to_owned();
        self.spawn(move |inner, peer| async move {
            let command = json!({"type": "chat.create_tab", "tabId": tab_id, "title": title});
            let result = tab_command(&inner, &peer, &project_id, &worktree_id, command)
                .await
                .map(|entity| Creation {
                    project_id,
                    worktree_id,
                    tab_id,
                    entity,
                    title,
                    starter: false,
                });
            Msg::Created {
                generation,
                select,
                result,
                waiter,
            }
        });
    }

    pub(super) fn create_chat(
        &mut self,
        workspace: String,
        title: Option<String>,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        let requested = title
            .as_deref()
            .map(chat::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned);
        if !self.connected || !self.workspaces.contains(&workspace) {
            return settle(
                done,
                waiter,
                Some(Failure::link(CopyKey::ChooseWorkspace)),
                None,
            );
        }
        let generation = self.generation;
        self.spawn(move |inner, peer| async move {
            let result = new_chat(&inner, &peer, workspace, requested).await;
            Msg::Created {
                generation,
                select: false,
                result,
                waiter,
            }
        });
    }

    pub(super) fn created(
        &mut self,
        generation: u64,
        select: bool,
        result: std::result::Result<Creation, Failure>,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        let replacing = select
            && self
                .closing_tab
                .as_ref()
                .is_some_and(|(route, _)| *route == generation);
        if replacing {
            self.closing_tab = None;
        }
        let current = !self.disposed && self.connected && generation == self.generation;
        if replacing
            && current
            && !result
                .as_ref()
                .is_ok_and(|creation| matches!(creation.entity, Dv::Str(_) | Dv::Null))
            && self.state().is_some_and(|state| !state.closed)
        {
            // The archive succeeded even if its push has yet to arrive.
            self.refresh(None, done);
        }
        let creation = match result {
            Ok(creation) => creation,
            Err(failure) => return settle(done, waiter, Some(failure), None),
        };
        if !current {
            // `createTab` returns quietly; `createChat` throws.
            let failure = creation
                .starter
                .then(|| Failure::link(CopyKey::FindNewChat));
            return settle(done, waiter, failure, None);
        }
        let id = match (&creation.entity, creation.starter) {
            (Dv::Str(id), _) => id.clone(),
            (_, true) | (Dv::Null, false) => creation.tab_id.clone(),
            // `result['entityId'] as String?` threw.
            _ => {
                let failure = Failure {
                    message: String::new(),
                    kind: FailKind::Other,
                    code: None,
                };
                return settle(done, waiter, Some(failure), None);
            }
        };
        let chat = ChatRef {
            project_id: creation.project_id,
            worktree_id: creation.worktree_id,
            id,
            title: creation.title,
        };
        if select {
            self.select_chat(chat, waiter, done);
        } else {
            settle(done, waiter, None, Some(Outcome::Created(chat)));
        }
    }

    // ---- Attachments (`DeviceChatAttachments`) ----

    pub(super) fn import_attachment(
        &mut self,
        scope: ChatRef,
        filename: String,
        bytes: Vec<u8>,
        waiter: Option<Waiter>,
    ) {
        self.spawn(move |inner, peer| async move {
            let size = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
            // An import without files opens a file chooser on the
            // computer, so a request always carries exactly one file.
            let args = scope_with(
                &scope,
                json!({
                    "filePaths": [],
                    "clipboardItems": [
                        {"filename": filename, "data": dto::bridge_value(&Dv::Bytes(bytes))},
                    ],
                }),
            );
            let result = call_with(
                &inner,
                &peer,
                "workspace-items:import-attachments",
                vec![args],
                UPLOAD_TIMEOUT,
            )
            .await;
            let (failure, outcome) = match result {
                Err(error) => (Some(transport(&error)), None),
                Ok(reply) => match stored(&dto::desktop_value(&reply), size) {
                    Ok(outcome) => (None, Some(outcome)),
                    Err(failure) => (Some(failure), None),
                },
            };
            Msg::Done {
                waiter,
                failure,
                outcome,
            }
        });
    }

    pub(super) fn delete_attachment(
        &mut self,
        scope: ChatRef,
        filename: String,
        waiter: Option<Waiter>,
    ) {
        self.spawn(move |inner, peer| async move {
            let args = scope_with(&scope, json!({"filename": filename}));
            let failure = call(
                &inner,
                &peer,
                "workspace-items:delete-attachment",
                vec![args],
            )
            .await
            .err()
            .map(|e| transport(&e));
            Msg::Done {
                waiter,
                failure,
                outcome: None,
            }
        });
    }

    // ---- Drafts ----

    /// The host's draft of `chat`; `seq` orders the host's writes.
    pub(super) fn set_draft(&mut self, chat: &ChatRef, text: &str, seq: u64) {
        self.drafts.seq = self.drafts.seq.max(seq);
        if self.drafts.set(&chat.key(), text, drafts::now_ms()) {
            self.schedule_drafts();
        }
    }

    /// Clears `chat`'s draft when it still equals the sent `text`.
    pub(super) fn clear_sent_draft(&mut self, chat: &ChatRef, text: &str) {
        let key = chat.key();
        if self.drafts.get(&key) == text && self.drafts.set(&key, "", drafts::now_ms()) {
            self.schedule_drafts();
        }
    }

    fn schedule_drafts(&mut self) {
        self.timers += 1;
        let token = self.timers;
        self.drafts.timer = Some(token);
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            tokio::time::sleep(drafts::DEBOUNCE).await;
            let _ = inbox.send(Msg::DraftsFlush(token));
        });
    }

    /// Writes the drafts record when it changed; `now` writes on this
    /// thread (at close, after a write still running), otherwise on the
    /// blocking pool.
    /// Writes the drafts on this task, redoing a write still running or
    /// one that failed: once it returns, the store holds them (unless the
    /// write failed).
    pub(super) fn store_drafts(&mut self) {
        if self.drafts.unconfirmed() {
            self.drafts.dirty = true;
        }
        self.write_drafts(true);
    }
    pub(super) fn write_drafts(&mut self, now: bool) {
        self.drafts.timer = None;
        let (Some(account), Some(inner)) = (self.drafts.account.clone(), self.inner.upgrade())
        else {
            return;
        };
        if !self.drafts.dirty {
            return;
        }
        self.drafts.dirty = false;
        let write = self.drafts.write(drafts::now_ms());
        let (computer, kind) = (self.peer.computer.clone(), self.peer.drafts());
        let store = inner.store.clone();
        let put = move |record: &Value| {
            store
                .put_chat_drafts(&account, &computer, kind, record)
                .is_ok()
        };
        if now {
            if !write.run(put) {
                self.drafts.dirty = true;
            }
            return;
        }
        let (inbox, writes) = (self.inbox.clone(), self.writes.clone());
        tokio::spawn(async move {
            let written = tokio::task::spawn_blocking(move || write.run(put))
                .await
                .unwrap_or(false);
            let _ = inbox.send(Msg::DraftsWritten(written));
            drop(writes);
        });
    }
}

/// `deviceLinkObject(...)['attachments']`'s first map: its path, name and
/// size (else the request's byte count).
fn stored(reply: &Dv, size: i64) -> std::result::Result<Outcome, Failure> {
    let reply = object(reply).map_err(|_| invalid())?;
    let first = match reply.get("attachments") {
        Dv::Null => None,
        Dv::List(items) => items.iter().find_map(|i| match i {
            Dv::Map(map) => Some(map),
            _ => None,
        }),
        // `as List?` threw.
        _ => {
            return Err(Failure {
                message: String::new(),
                kind: FailKind::Other,
                code: None,
            });
        }
    };
    let field = |key: &str| first.and_then(|m| m.get(key).as_str().map(str::to_owned));
    let (Some(path), Some(filename)) = (field("absolutePath"), field("filename")) else {
        return Err(Failure::link(CopyKey::FileNotStored));
    };
    #[allow(clippy::cast_possible_truncation)]
    let size = match first.map(|m| m.get("sizeBytes")) {
        Some(Dv::Int(n)) => *n,
        Some(Dv::Float(f)) if f.is_finite() => f.trunc() as i64,
        _ => size,
    };
    Ok(Outcome::Stored {
        filename,
        path,
        size,
    })
}

/// One `chat:command` creating a tab; the receipt's `entityId`.
async fn tab_command(
    inner: &Inner,
    peer: &Peer,
    project_id: &str,
    worktree_id: &str,
    command: Value,
) -> std::result::Result<Dv, Failure> {
    let args = json!({
        "schemaVersion": 1,
        "commandId": uuid(),
        "projectId": project_id,
        "worktreeId": worktree_id,
        "command": command,
    });
    let reply = call(inner, peer, "chat:command", vec![args])
        .await
        .map_err(|e| transport(&e))?;
    let reply = dto::desktop_value(&reply);
    let receipt = object(&reply).map_err(|_| invalid())?;
    let outcome = receipt.get("outcome");
    if !(outcome.is_str("applied") || outcome.is_str("already_applied")) {
        return Err(Failure::link(CopyKey::CouldNotCreate));
    }
    Ok(receipt.get("entityId").clone())
}

/// `createChat`'s calls: the work entry, then its starter tab.
async fn new_chat(
    inner: &Inner,
    peer: &Peer,
    workspace: String,
    requested: Option<String>,
) -> std::result::Result<Creation, Failure> {
    let mut args = json!({"projectId": workspace});
    if let Some(title) = &requested {
        args["title"] = json!(title);
    }
    let reply = match call(inner, peer, "work-entries:create", vec![args]).await {
        Ok(reply) => reply,
        Err(e) if e.kind == FailureKind::NotSent => {
            let failure = transport(&e);
            return Err(Failure {
                kind: FailKind::CreationNotSent,
                ..failure
            });
        }
        Err(e) => return Err(transport(&e)),
    };
    let reply = dto::desktop_value(&reply);
    let created = object(&reply).map_err(|_| invalid())?;
    let entry = object(created.get("entry")).map_err(|_| invalid())?;
    let worktree_id = chat::link_string(entry, "id")
        .map_err(|_| invalid())?
        .to_owned();
    let tab_id = uuid();
    let title = requested.unwrap_or_else(|| copy::text(CopyKey::NewChat).into());
    let command = json!({
        "type": "chat.create_tab",
        "tabId": tab_id,
        "starter": true,
        "title": title,
    });
    let entity = tab_command(inner, peer, &workspace, &worktree_id, command).await?;
    Ok(Creation {
        project_id: workspace,
        worktree_id,
        tab_id,
        entity,
        title,
        starter: true,
    })
}

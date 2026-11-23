//! Sends to one computer's chats (P5b), ported from the write half of
//! `device_link/chats/repository.dart` (now `dart_sender.dart`): one
//! unconfirmed send per computer, a UUID v4 sent as both message ids,
//! confirmation by message id, `lastAcceptedUserMessageId` or
//! `queuedMessageIds`, the 32,000-unit limit, the tab settings copied into
//! the send, and the release of an attempt whose chat closed. A
//! transmitted send is never retried automatically: the user retries the
//! same attempt (same ids and files).
use super::{ChatRef, ChatState, trim};
use crate::dart::{Dv, DvMap};

/// `text.length > 32000` (UTF-16 code units).
pub const MAX_TEXT_UNITS: usize = 32_000;

/// The tab settings a send carries, in Dart's order.
pub const SETTINGS_KEYS: [&str; 15] = [
    "model",
    "modelSelectionMode",
    "providerType",
    "modelConfig",
    "thinkingLevel",
    "codexFastModeEnabled",
    "planMode",
    "sdkSessionId",
    "pluginSelections",
    "deferredToolsAllowed",
    "interfaceMode",
    "selectedRepoId",
    "executionHarness",
    "aiCreditsRouting",
    "subscriptionBillingOverride",
];

/// One send attempt (`DeviceChatPendingSend`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingSend {
    pub chat: ChatRef,
    pub id: String,
    pub text: String,
    pub dictated: bool,
    /// Files already stored on the computer; a retry sends the same paths.
    pub attachment_paths: Vec<String>,
}

/// Why a send was not made (nothing was sent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendRefusal {
    /// Not ready, no chat, a closed chat or a send in flight.
    NotReady,
    /// Empty without files, or longer than [`MAX_TEXT_UNITS`].
    TooLong,
    /// Another attempt is unconfirmed.
    PreviousUnconfirmed,
    /// A retry from another chat, of other text, or with nothing pending.
    OpenOriginal,
}

/// A send the host asks for.
#[derive(Debug, Clone, Copy)]
pub struct SendRequest<'a> {
    pub text: &'a str,
    pub retry: bool,
    pub dictated: bool,
    pub attachment_paths: &'a [String],
}

/// The attempt `request` makes, in Dart's check order; `new_id` names a
/// new one.
pub fn attempt(
    ready: bool,
    state: Option<&ChatState>,
    sending: bool,
    pending: Option<&PendingSend>,
    request: SendRequest<'_>,
    new_id: impl FnOnce() -> String,
) -> Result<PendingSend, SendRefusal> {
    let current = match state {
        Some(state) if ready && !state.closed && !sending => state,
        _ => return Err(SendRefusal::NotReady),
    };
    let attached = if request.retry {
        pending
            .map(|p| p.attachment_paths.as_slice())
            .unwrap_or(&[])
    } else {
        request.attachment_paths
    };
    if (trim(request.text).is_empty() && attached.is_empty())
        || request.text.encode_utf16().count() > MAX_TEXT_UNITS
    {
        return Err(SendRefusal::TooLong);
    }
    if pending.is_some() && !request.retry {
        return Err(SendRefusal::PreviousUnconfirmed);
    }
    let attempt = if request.retry {
        pending.cloned()
    } else {
        Some(PendingSend {
            chat: current.chat.clone(),
            id: new_id(),
            text: request.text.to_owned(),
            dictated: request.dictated,
            attachment_paths: request.attachment_paths.to_vec(),
        })
    };
    match attempt {
        Some(a) if a.chat.key() == current.chat.key() && a.text == request.text => Ok(a),
        _ => Err(SendRefusal::OpenOriginal),
    }
}

/// The tab settings a send of `tab` carries (non-null values).
pub fn send_settings(tab: &DvMap) -> Vec<(&'static str, Dv)> {
    SETTINGS_KEYS
        .iter()
        .filter_map(|key| {
            let value = tab.get(key);
            (!value.is_null()).then(|| (*key, value.clone()))
        })
        .collect()
}

impl ChatState {
    /// `containsUserMessage`: a user message with the id, the tab's
    /// `lastAcceptedUserMessageId` or the runtime's `queuedMessageIds`.
    /// A message without a valid id never matches (Dart threw there).
    pub fn contains_user_message(&self, id: &str) -> bool {
        self.messages
            .iter()
            .any(|m| m.id().is_ok_and(|i| i == id) && m.raw.get("role").is_str("user"))
            || self.tab.get("lastAcceptedUserMessageId").is_str(id)
            || match self.runtime.get("queuedMessageIds") {
                Dv::List(ids) => ids.iter().any(|v| v.is_str(id)),
                _ => false,
            }
    }
}

/// `_readerChanged`: the selected chat confirms `pending`.
pub fn confirms(state: Option<&ChatState>, hydrating: bool, pending: &PendingSend) -> bool {
    !hydrating
        && state.is_some_and(|s| {
            s.chat.key() == pending.chat.key() && s.contains_user_message(&pending.id)
        })
}

/// `_releaseClosedSend`: `pending`'s chat is closed in the selected scope,
/// so the attempt is dropped (its draft is kept).
pub fn released(
    state: Option<&ChatState>,
    pending: &PendingSend,
    ready: bool,
    hydrating: bool,
    loading: bool,
) -> bool {
    let Some(current) = state else { return false };
    if !ready
        || hydrating
        || loading
        || current.revision == 0
        || pending.chat.project_id != current.chat.project_id
        || pending.chat.worktree_id != current.chat.worktree_id
    {
        return false;
    }
    match current.scope.tab(&pending.chat.id) {
        None => true,
        Some(tab) => {
            tab.is_empty() || !tab.get("archivedAt").is_null() || tab.get("kind").is_str("file")
        }
    }
}

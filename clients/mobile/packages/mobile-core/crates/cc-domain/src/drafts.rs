//! Computer Connect chat drafts (P5b, D9), the rules of
//! `data/models/chat_drafts.dart` (`ChatDraftState`, `ChatDraftStateStore`)
//! for one computer's chats: setting the same text changes nothing, empty
//! text removes the draft, and a prune keeps the newest 200 drafts no
//! older than 30 days. Times are milliseconds since the epoch.
use std::collections::BTreeMap;

/// `chatDraftMaxDrafts`.
pub const MAX_DRAFTS: usize = 200;
/// `chatDraftMaxAge` (30 days).
pub const MAX_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub text: String,
    pub updated_ms: i64,
}

/// The drafts of one computer's chats, by chat key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DraftBook {
    drafts: BTreeMap<String, Draft>,
}

impl DraftBook {
    /// The draft of `key`, or `""`.
    pub fn get(&self, key: &str) -> &str {
        self.drafts.get(key).map_or("", |d| d.text.as_str())
    }
    /// `setDraft`: whether anything changed.
    pub fn set(&mut self, key: &str, text: &str, now_ms: i64) -> bool {
        if self.get(key) == text {
            return false;
        }
        if text.is_empty() {
            self.drafts.remove(key);
        } else {
            self.drafts.insert(
                key.to_owned(),
                Draft {
                    text: text.to_owned(),
                    updated_ms: now_ms,
                },
            );
        }
        true
    }
    /// Adds a stored draft (empty ones are skipped, as `fromJson` does).
    pub fn restore(&mut self, key: String, draft: Draft) {
        if !draft.text.is_empty() {
            self.drafts.insert(key, draft);
        }
    }
    /// `prune`: drops expired drafts, then keeps the newest ones.
    pub fn prune(&mut self, now_ms: i64) {
        let cutoff = now_ms - MAX_AGE_MS;
        self.drafts.retain(|_, d| d.updated_ms >= cutoff);
        if self.drafts.len() <= MAX_DRAFTS {
            return;
        }
        let mut by_newest: Vec<(String, i64)> = self
            .drafts
            .iter()
            .map(|(k, d)| (k.clone(), d.updated_ms))
            .collect();
        by_newest.sort_by_key(|e| std::cmp::Reverse(e.1));
        for (key, _) in by_newest.into_iter().skip(MAX_DRAFTS) {
            self.drafts.remove(&key);
        }
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Draft)> {
        self.drafts.iter()
    }
}

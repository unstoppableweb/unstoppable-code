//! One computer's chat drafts (P5b, D9): the book (`cc-domain::drafts`),
//! what subscribers were shown of it, and its sealed record in the
//! encrypted store, written 500 ms after the last change
//! (`FileChatDraftStore`'s debounce) and at close. Writes land in the order
//! they were taken: one that finds a later write stored is dropped. A failed
//! write keeps the drafts and is retried with the next change. Dart drafts
//! are not imported.
//!
//! Record: `{"v": 1, "drafts": {"<project>/<worktree>/<chat>":
//! {"text": "…", "updatedAtMs": <ms>}}}`.
use cc_domain::drafts::{Draft, DraftBook};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

/// `FileChatDraftStore`'s write debounce.
pub(super) const DEBOUNCE: Duration = Duration::from_millis(500);
const VERSION: u64 = 1;

/// Each key's text as shown, with the revision of its last change; a
/// removed draft stays as `""` so subscribers learn of it.
pub(crate) type Shown = BTreeMap<String, (String, u64)>;

#[derive(Default)]
pub(super) struct Drafts {
    book: DraftBook,
    pub(super) shown: Arc<Shown>,
    pub(super) rev: u64,
    /// The host's last applied draft write.
    pub(super) seq: u64,
    /// The account the record belongs to; none keeps drafts in memory.
    pub(super) account: Option<String>,
    pub(super) dirty: bool,
    pub(super) timer: Option<u64>,
    /// The last write taken, and the latest one stored.
    taken: u64,
    stored: Arc<Mutex<u64>>,
}

/// One write of the record, numbered in the order it was taken.
pub(super) struct Write {
    record: Value,
    number: u64,
    stored: Arc<Mutex<u64>>,
}

impl Write {
    /// Stores the record with `put` unless a later write is stored; whether
    /// the store now holds this write or a later one. Writes of one record
    /// run one at a time.
    pub(super) fn run(self, put: impl FnOnce(&Value) -> bool) -> bool {
        let mut stored = self.stored.lock().unwrap_or_else(|p| p.into_inner());
        if *stored > self.number {
            return true;
        }
        let written = put(&self.record);
        if written {
            *stored = self.number;
        }
        written
    }
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

impl Drafts {
    /// The stored `record` of `account`, pruned (`FileChatDraftStore.open`).
    /// An unreadable record starts empty.
    pub(super) fn load(account: Option<String>, record: Option<&Value>, now: i64) -> Self {
        let mut book = DraftBook::default();
        if let Some(record) = record
            && record.get("v").and_then(Value::as_u64) == Some(VERSION)
            && let Some(drafts) = record.get("drafts").and_then(Value::as_object)
        {
            for (key, value) in drafts {
                if let (Some(text), Some(updated_ms)) = (
                    value.get("text").and_then(Value::as_str),
                    value.get("updatedAtMs").and_then(Value::as_i64),
                ) {
                    book.restore(
                        key.clone(),
                        Draft {
                            text: text.to_owned(),
                            updated_ms,
                        },
                    );
                }
            }
        }
        book.prune(now);
        let mut drafts = Self {
            book,
            account,
            ..Self::default()
        };
        drafts.show_all();
        drafts
    }

    pub(super) fn get(&self, key: &str) -> &str {
        self.book.get(key)
    }

    /// `setDraft`; whether anything changed.
    pub(super) fn set(&mut self, key: &str, text: &str, now: i64) -> bool {
        if !self.book.set(key, text, now) {
            return false;
        }
        self.rev += 1;
        Arc::make_mut(&mut self.shown).insert(key.to_owned(), (text.to_owned(), self.rev));
        self.dirty = true;
        true
    }

    /// The next write of the record.
    pub(super) fn write(&mut self, now: i64) -> Write {
        self.taken += 1;
        Write {
            record: self.record(now),
            number: self.taken,
            stored: self.stored.clone(),
        }
    }

    /// Whether the last write taken is not known stored: still running
    /// (this waits for it) or failed.
    pub(super) fn unconfirmed(&self) -> bool {
        *self.stored.lock().unwrap_or_else(|p| p.into_inner()) < self.taken
    }

    /// Prunes and encodes the record to write; drafts the prune dropped
    /// are shown removed.
    fn record(&mut self, now: i64) -> Value {
        self.book.prune(now);
        self.show_all();
        let mut drafts = Map::new();
        for (key, draft) in self.book.iter() {
            drafts.insert(
                key.clone(),
                json!({"text": draft.text, "updatedAtMs": draft.updated_ms}),
            );
        }
        if drafts.is_empty() {
            return Value::Null;
        }
        json!({"v": VERSION, "drafts": drafts})
    }

    /// Brings `shown` in line with the book.
    fn show_all(&mut self) {
        let mut changed = Vec::new();
        for (key, (text, _)) in self.shown.iter() {
            if self.book.get(key) != text {
                changed.push(key.clone());
            }
        }
        for (key, _) in self.book.iter() {
            if !self.shown.contains_key(key) {
                changed.push(key.clone());
            }
        }
        for key in changed {
            self.rev += 1;
            let text = self.book.get(&key).to_owned();
            Arc::make_mut(&mut self.shown).insert(key, (text, self.rev));
        }
    }
}

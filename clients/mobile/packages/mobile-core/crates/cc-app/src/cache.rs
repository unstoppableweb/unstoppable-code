//! Byte-bounded LRU shared by concurrent tasks (`&self`, interior lock).
//! Keys are JSON `[accountId, computerId, key]` (see [`Cache::key`]); entries
//! are never shared between accounts, and one computer's entries can be
//! cleared without touching the others.
// Without `diagnostics`, only clearing is reachable.
#![cfg_attr(not(feature = "diagnostics"), allow(dead_code))]
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Mutex, MutexGuard},
};

pub(crate) const MAX_ENTRIES: usize = 20;
pub(crate) const MAX_BYTES: usize = 8 * 1024 * 1024;

struct Entry {
    value: Value,
    size: usize,
    /// `(account, computer)` when the key is a [`Cache::key`].
    owner: Option<(String, String)>,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<String, Entry>,
    order: VecDeque<String>,
    bytes: usize,
}
impl Inner {
    fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key) {
            self.bytes -= entry.size;
            self.order.retain(|k| k != key);
        }
    }
}

#[derive(Default)]
pub(crate) struct Cache {
    inner: Mutex<Inner>,
}

impl Cache {
    /// The canonical entry key.
    pub(crate) fn key(account: &str, computer: &str, key: &str) -> String {
        serde_json::to_string(&(account, computer, key)).expect("strings serialize")
    }
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while holding the lock leaves only cache state; recover it.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(crate) fn get(&self, key: &str) -> Option<Value> {
        let mut inner = self.lock();
        let value = inner.entries.get(key)?.value.clone();
        inner.order.retain(|k| k != key);
        inner.order.push_back(key.into());
        Some(value)
    }
    /// Inserts; a value larger than the whole cache is dropped (see
    /// [`Cache::try_put`] to learn about that).
    pub(crate) fn put(&self, key: String, value: Value) {
        let _ = self.try_put(key, value);
    }
    /// `false` when the entry alone exceeds [`MAX_BYTES`] and was not stored
    /// (any previous value under `key` is removed either way).
    pub(crate) fn try_put(&self, key: String, value: Value) -> bool {
        let mut inner = self.lock();
        inner.remove(&key);
        let size = value.to_string().len() + key.len();
        if size > MAX_BYTES {
            return false;
        }
        let owner = serde_json::from_str::<(String, String, String)>(&key)
            .ok()
            .map(|(a, c, _)| (a, c));
        inner.bytes += size;
        inner
            .entries
            .insert(key.clone(), Entry { value, size, owner });
        inner.order.push_back(key);
        while inner.bytes > MAX_BYTES || inner.entries.len() > MAX_ENTRIES {
            match inner.order.pop_front() {
                Some(oldest) => inner.remove(&oldest),
                None => break,
            }
        }
        true
    }
    pub(crate) fn remove(&self, key: &str) {
        self.lock().remove(key);
    }
    /// Drops one computer's entries for one account; others stay.
    pub(crate) fn clear_computer(&self, account: &str, computer: &str) {
        self.retain(|owner| owner != Some((account, computer)));
    }
    /// Drops every entry of one account.
    pub(crate) fn clear_account(&self, account: &str) {
        self.retain(|owner| owner.map(|(a, _)| a) != Some(account));
    }
    fn retain(&self, keep: impl Fn(Option<(&str, &str)>) -> bool) {
        let mut inner = self.lock();
        let doomed: Vec<String> = inner
            .entries
            .iter()
            .filter(|(_, e)| !keep(e.owner.as_ref().map(|(a, c)| (a.as_str(), c.as_str()))))
            .map(|(k, _)| k.clone())
            .collect();
        for key in doomed {
            inner.remove(&key);
        }
    }
    pub(crate) fn clear(&self) {
        let mut inner = self.lock();
        inner.entries.clear();
        inner.order.clear();
        inner.bytes = 0;
    }
}

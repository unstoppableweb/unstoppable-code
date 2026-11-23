//! Changed-file diffs (`DeviceFileDiffRepository`): a read-through cache
//! of at most 30 entries and 4 MiB (`ObservableLru`) whose watched entries
//! stay resident, refreshes deduplicated per file, stale marking on
//! connection changes and file pushes, and the bounded LCS in
//! `cc-domain::files`. No disk storage or extra desktop interest.
use super::{Actor, Fail, Msg, Outcome, TimerKind, Waiter, worktree_key};
use crate::{
    copy::activity::{self as copy, CopyKey},
    error::Result,
};
use cc_domain::{
    chat::object,
    files::{TooLarge, display_text_diff},
};
use cc_protocol::dto::desktop_value;
use serde_json::{Map, Value, json};
use std::{collections::HashMap, sync::Arc, time::Duration};

const MAX_ENTRIES: usize = 30;
const MAX_WEIGHT: usize = 4 * 1024 * 1024;
/// The refresh after a file push.
const PUSH_REFRESH: Duration = Duration::from_millis(150);

/// `DeviceFileDiffKey`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct DiffKey {
    pub(crate) project_id: String,
    pub(crate) worktree_id: String,
    pub(crate) repo_id: Option<String>,
    pub(crate) path: String,
    pub(crate) committed: bool,
}

/// A file whose diff is read: its key and the list's line counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) key: DiffKey,
    pub(crate) insertions: Option<i64>,
    pub(crate) deletions: Option<i64>,
}

/// `DeviceFileDiffState`; `patch` is the diff's (`RemoteFileDiff.patch`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DiffState {
    pub(crate) patch: Option<Arc<String>>,
    pub(crate) error: Option<String>,
    pub(crate) refreshing: bool,
    pub(crate) stale: bool,
    pub(crate) truncated: bool,
}

impl Default for DiffState {
    fn default() -> Self {
        Self {
            patch: None,
            error: None,
            refreshing: false,
            stale: true,
            truncated: false,
        }
    }
}

impl DiffState {
    /// `pending({error, refreshing})`: the same diff, stale.
    fn pending(&self, error: Option<String>, refreshing: bool) -> Self {
        Self {
            patch: self.patch.clone(),
            error,
            refreshing,
            stale: true,
            truncated: self.truncated,
        }
    }
    /// `256 + payloadWeight(diff?.patch) + payloadWeight(error)`.
    fn weight(&self) -> usize {
        let text = |s: Option<&str>| s.map_or(8, |s| 32 + s.encode_utf16().count() * 2);
        256 + text(self.patch.as_deref().map(String::as_str)) + text(self.error.as_deref())
    }
}

/// `ObservableLru`: least recently used first; retained entries stay.
#[derive(Default)]
struct Lru {
    entries: Vec<(DiffKey, Arc<DiffState>, usize)>,
    retained: HashMap<DiffKey, usize>,
    weight: usize,
}

impl Lru {
    fn position(&self, key: &DiffKey) -> Option<usize> {
        self.entries.iter().position(|(k, _, _)| k == key)
    }
    fn peek(&self, key: &DiffKey) -> Option<Arc<DiffState>> {
        self.position(key).map(|i| self.entries[i].1.clone())
    }
    fn read(&mut self, key: &DiffKey) -> Option<Arc<DiffState>> {
        let i = self.position(key)?;
        let entry = self.entries.remove(i);
        let value = entry.1.clone();
        self.entries.push(entry);
        Some(value)
    }
    fn keys(&self) -> Vec<DiffKey> {
        self.entries.iter().map(|(k, _, _)| k.clone()).collect()
    }
    fn put(&mut self, key: DiffKey, value: DiffState) {
        let weight = value.weight();
        if let Some(i) = self.position(&key) {
            let (_, _, old) = self.entries.remove(i);
            self.weight -= old;
        }
        self.weight += weight;
        self.entries.push((key, Arc::new(value), weight));
        self.trim();
    }
    fn retain(&mut self, key: &DiffKey) {
        *self.retained.entry(key.clone()).or_insert(0) += 1;
        self.read(key);
    }
    fn release(&mut self, key: &DiffKey) {
        match self.retained.get_mut(key) {
            Some(count) if *count > 1 => *count -= 1,
            Some(_) => {
                self.retained.remove(key);
            }
            None => return,
        }
        self.trim();
    }
    fn trim(&mut self) {
        for key in self.keys() {
            if self.entries.len() <= MAX_ENTRIES && self.weight <= MAX_WEIGHT {
                break;
            }
            if self.retained.contains_key(&key) {
                continue;
            }
            if let Some(i) = self.position(&key) {
                let (_, _, weight) = self.entries.remove(i);
                self.weight -= weight;
            }
        }
    }
}

struct Read {
    generation: u64,
    invalidation: u64,
    waiters: Vec<Waiter>,
}

#[derive(Default)]
pub(crate) struct Diffs {
    lru: Lru,
    reads: HashMap<DiffKey, u64>,
    ops: HashMap<u64, Read>,
    /// Watched files: the latest target and the watch count.
    watching: HashMap<DiffKey, (Target, usize)>,
    tokens: HashMap<u64, DiffKey>,
    invalidation: u64,
    pub(crate) refresh: Option<u64>,
}

impl Diffs {
    pub(crate) fn published(&self) -> HashMap<DiffKey, Arc<DiffState>> {
        self.lru
            .entries
            .iter()
            .map(|(k, v, _)| (k.clone(), v.clone()))
            .collect()
    }
    fn state(&self, key: &DiffKey) -> DiffState {
        self.lru.peek(key).map(|s| (*s).clone()).unwrap_or_default()
    }
}

impl Actor {
    /// `diffs.watch(ref, file)`.
    pub(super) fn watch_diff(&mut self, target: Target, token: u64) {
        if self.disposed {
            return;
        }
        let key = target.key.clone();
        self.diffs.lru.retain(&key);
        let count = self.diffs.watching.get(&key).map_or(0, |(_, c)| *c);
        self.diffs
            .watching
            .insert(key.clone(), (target.clone(), count + 1));
        self.diffs.tokens.insert(token, key);
        self.refresh_diff(&target, None);
    }

    pub(super) fn release_diff(&mut self, token: u64) {
        let Some(key) = self.diffs.tokens.remove(&token) else {
            return;
        };
        if self.disposed {
            return;
        }
        match self.diffs.watching.get_mut(&key) {
            Some((_, count)) if *count > 1 => *count -= 1,
            Some(_) => {
                self.diffs.watching.remove(&key);
            }
            None => {}
        }
        self.diffs.lru.release(&key);
    }

    /// `diffs.setConnected`.
    pub(super) fn diffs_connected(&mut self, connected: bool) {
        if self.disposed {
            return;
        }
        self.diffs.reads.clear();
        self.diffs.refresh = None;
        for key in self.diffs.lru.keys() {
            let Some(cached) = self.diffs.lru.peek(&key) else {
                continue;
            };
            let error = (!connected).then(|| copy::text(CopyKey::DiffReconnect).to_owned());
            self.diffs.lru.put(key, cached.pending(error, false));
        }
        if connected {
            self.refresh_watched_diffs();
        }
    }

    pub(super) fn refresh_watched_diffs(&mut self) {
        let watched: Vec<Target> = self
            .diffs
            .watching
            .values()
            .map(|(t, _)| t.clone())
            .collect();
        for target in watched {
            self.refresh_diff(&target, None);
        }
    }

    /// `diffs.refresh(ref, file)`.
    pub(super) fn refresh_diff(&mut self, target: &Target, waiter: Option<Waiter>) {
        if self.disposed {
            return self.settle(waiter, Outcome::Done);
        }
        let key = target.key.clone();
        if let Some(op) = self.diffs.reads.get(&key).copied()
            && let Some(read) = self.diffs.ops.get_mut(&op)
        {
            read.waiters.extend(waiter);
            return;
        }
        let previous = self
            .diffs
            .lru
            .read(&key)
            .map(|s| (*s).clone())
            .unwrap_or_default();
        if !self.connected {
            let error = Some(copy::text(CopyKey::DiffReconnect).to_owned());
            self.diffs.lru.put(key, previous.pending(error, false));
            return self.settle(waiter, Outcome::Done);
        }
        self.diffs
            .lru
            .put(key.clone(), previous.pending(None, true));
        let op = self.next_op();
        self.diffs.ops.insert(
            op,
            Read {
                generation: self.generation,
                invalidation: self.diffs.invalidation,
                waiters: waiter.into_iter().collect(),
            },
        );
        self.diffs.reads.insert(key.clone(), op);
        let mut args = Map::new();
        args.insert("projectId".into(), json!(key.project_id));
        args.insert("worktreeId".into(), json!(key.worktree_id));
        args.insert("filePath".into(), json!(key.path));
        if let Some(repo) = &key.repo_id {
            args.insert("repoId".into(), json!(repo));
        }
        args.insert(
            "source".into(),
            json!(if key.committed {
                "committed"
            } else {
                "uncommitted"
            }),
        );
        self.spawn(move |inner, computer, _| async move {
            let result = super::flows::call(
                &inner,
                &computer,
                "activity:file-diff",
                vec![Value::Object(args)],
            )
            .await;
            Msg::Diff { key, op, result }
        });
    }

    /// `_load`'s end, then `refresh`'s `whenComplete`.
    pub(super) fn diff_read(&mut self, key: DiffKey, op: u64, result: Result<Value>) {
        let Some(read) = self.diffs.ops.remove(&op) else {
            return;
        };
        let current = !self.disposed && read.generation == self.generation;
        if current {
            self.apply_diff(&key, &read, result);
        }
        if self.diffs.reads.get(&key) == Some(&op) {
            self.diffs.reads.remove(&key);
            if read.generation == self.generation
                && read.invalidation != self.diffs.invalidation
                && self.connected
                && self.diffs.refresh.is_none()
                && let Some((target, _)) = self.diffs.watching.get(&key).cloned()
            {
                self.refresh_diff(&target, None);
            }
        }
        for waiter in read.waiters {
            self.done.push((waiter, Outcome::Done));
        }
    }

    fn apply_diff(&mut self, key: &DiffKey, read: &Read, result: Result<Value>) {
        let failed = |actor: &mut Self, message: String| {
            let state = actor.diffs.state(key).pending(Some(message), false);
            actor.diffs.lru.put(key.clone(), state);
        };
        let raw = match result {
            Ok(value) => desktop_value(&value),
            Err(error) => return failed(self, Fail::rpc(&error).message_or(CopyKey::DiffFailed)),
        };
        let raw = match object(&raw) {
            Ok(raw) => raw.clone(),
            Err(thrown) => {
                return failed(self, Fail::thrown(thrown).message_or(CopyKey::DiffFailed));
            }
        };
        if read.invalidation != self.diffs.invalidation {
            let refreshing = self.diffs.watching.contains_key(key);
            let state = self.diffs.state(key).pending(None, refreshing);
            self.diffs.lru.put(key.clone(), state);
            return;
        }
        let patch = if raw.get("binary").is_true() {
            format!("{}\n", copy::text(CopyKey::BinaryDiffers))
        } else {
            let text = |field: &str| -> std::result::Result<String, ()> {
                Ok(raw
                    .get(field)
                    .cast_str()
                    .map_err(|_| ())?
                    .unwrap_or_default()
                    .to_owned())
            };
            let (Ok(before), Ok(after)) = (text("oldValue"), text("newValue")) else {
                return failed(self, copy::text(CopyKey::DiffFailed).into());
            };
            match display_text_diff(&before, &after, 3) {
                Ok(patch) => patch,
                Err(TooLarge) => return failed(self, copy::text(CopyKey::DiffTooLarge).into()),
            }
        };
        let empty = patch.is_empty();
        self.diffs.lru.put(
            key.clone(),
            DiffState {
                patch: Some(Arc::new(patch)),
                error: None,
                refreshing: false,
                stale: false,
                truncated: raw.get("truncated").is_true(),
            },
        );
        // The computer sends no push when a change is committed or
        // discarded, so the list that offered the file is out of date.
        if empty {
            let worktree = worktree_key(&key.project_id, &key.worktree_id);
            if let Some(chat) = self.watching.get(&worktree).cloned() {
                self.load(&chat, None);
            }
        }
    }

    /// A file push (`_event`): every cached diff is stale; watched ones
    /// refresh after 150 ms.
    pub(super) fn invalidate_diffs(&mut self) {
        if self.disposed || !self.connected {
            return;
        }
        self.diffs.invalidation += 1;
        for key in self.diffs.lru.keys() {
            let Some(cached) = self.diffs.lru.peek(&key) else {
                continue;
            };
            let refreshing =
                self.diffs.reads.contains_key(&key) || self.diffs.watching.contains_key(&key);
            self.diffs.lru.put(key, cached.pending(None, refreshing));
        }
        self.diffs.refresh = Some(self.timer(TimerKind::Diffs, PUSH_REFRESH));
    }
}

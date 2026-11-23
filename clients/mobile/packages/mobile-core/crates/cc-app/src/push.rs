//! The per-computer push fan-out (architecture §4.1, §4.4): the one path
//! from a session's desktop messages into the stores.
//!
//! A store subscribes with a [`Filter`] (which computer, which `ipc.push`
//! channels, whether it wants new sessions) and a sink that posts into its
//! own inbox. The session task calls [`Fanout::message`] for every desktop
//! message before the bridge sees it; the fan-out reads the channel once,
//! cheaply, and copies the message only for the stores that asked for it.
//! Deliveries are made on the session's task, so a store sees one session's
//! pushes in wire order, interleaved correctly with the replies it gets
//! through [`crate::bridge::Inner::invoke`] (sent from the same task).
//!
//! Backpressure: each subscription holds at most [`CAPACITY`] undelivered
//! pushes. Past that it collapses to a single [`Delivery::Lagged`] marker
//! and drops further pushes until the store took the marker; the store
//! then re-reads what the dropped pushes would have changed (the op-stream
//! rule of §4.2: degrade to a reset, never block the session). No current
//! flow comes near the bound.
use cc_protocol::v8;
use serde_json::Value;
use std::sync::{
    Arc, Mutex, MutexGuard,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
};

/// Pushes a subscription may hold before it collapses to `Lagged`.
pub(crate) const CAPACITY: usize = 256;

/// What a subscription receives.
pub(crate) struct Filter {
    /// Only this computer's sessions; `None` for every computer.
    pub(crate) computer: Option<String>,
    /// The `ipc.push` channels it reads.
    pub(crate) channels: &'static [&'static str],
    /// Also pushes whose channel is present but not a string, so the store
    /// applies its own (Dart's) checks to them.
    pub(crate) unreadable: bool,
    /// Also a [`Delivery::Opened`] for every new session of `computer`.
    pub(crate) sessions: bool,
}

/// One delivery to a store. Dropping it (after it was applied) frees its
/// place in the subscription's bound.
pub(crate) enum Delivery {
    /// An `ipc.push` of a channel the filter names, in bridge form.
    Push(Push),
    /// A new session of the filter's computer opened.
    Opened,
    /// Pushes of `computer` were dropped: re-read what they cover.
    Lagged { computer: String, _slot: Release },
}

pub(crate) struct Push {
    pub(crate) computer: String,
    /// The whole desktop message in bridge form, for the store's decoder.
    pub(crate) message: Value,
    _slot: Release,
}

/// Frees a place in a subscription's bound, or ends its lag, when dropped.
pub(crate) struct Release(Option<(Arc<Slot>, bool)>);
impl Drop for Release {
    fn drop(&mut self) {
        if let Some((slot, lagged)) = self.0.take() {
            if lagged {
                slot.lagged.store(false, Ordering::SeqCst);
            } else {
                slot.pending.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }
}

#[derive(Default)]
struct Slot {
    pending: AtomicUsize,
    lagged: AtomicBool,
}

/// Posts a delivery into the store's inbox; `false` once the store is gone.
pub(crate) type Sink = Box<dyn Fn(Delivery) -> bool + Send + Sync>;

struct Entry {
    id: u64,
    filter: Filter,
    sink: Sink,
    slot: Arc<Slot>,
}

#[derive(Default)]
pub(crate) struct Fanout {
    entries: Arc<Mutex<Vec<Entry>>>,
    ids: AtomicU64,
}

/// Ends its subscription when dropped.
pub(crate) struct Subscription {
    id: u64,
    entries: std::sync::Weak<Mutex<Vec<Entry>>>,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(entries) = self.entries.upgrade() {
            lock(&entries).retain(|e| e.id != self.id);
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// An `ipc.push`'s channel, read without copying the message.
enum Channel<'a> {
    Named(&'a str),
    /// Present but not a string.
    Unreadable,
}

/// The channel of `message` when it is an `ipc.push` (both the plain and
/// the tagged object forms the bridge uses).
fn channel(message: &Value, read: impl FnOnce(Option<Channel<'_>>)) {
    let Some(envelope) = v8::as_map(v8::plain(message)) else {
        return read(None);
    };
    if envelope["name"] != "ipc.push" {
        return read(None);
    }
    let Some(payload) = v8::as_map(v8::plain(&envelope["payload"])) else {
        return read(None);
    };
    read(match &payload["channel"] {
        Value::Null => None,
        Value::String(name) => Some(Channel::Named(name)),
        _ => Some(Channel::Unreadable),
    });
}

impl Fanout {
    pub(crate) fn subscribe(&self, filter: Filter, sink: Sink) -> Subscription {
        let id = self.ids.fetch_add(1, Ordering::SeqCst);
        lock(&self.entries).push(Entry {
            id,
            filter,
            sink,
            slot: Arc::default(),
        });
        Subscription {
            id,
            entries: Arc::downgrade(&self.entries),
        }
    }

    /// A desktop message of `computer`'s session, on the session's task.
    pub(crate) fn message(&self, computer: &str, message: &Value) {
        channel(message, |channel| {
            let Some(channel) = channel else {
                return;
            };
            self.deliver(
                computer,
                |filter| match channel {
                    Channel::Named(name) => filter.channels.contains(&name),
                    Channel::Unreadable => filter.unreadable,
                },
                |slot| {
                    Delivery::Push(Push {
                        computer: computer.to_owned(),
                        message: message.clone(),
                        _slot: slot,
                    })
                },
            );
        });
    }

    /// A new session of `computer` opened.
    pub(crate) fn opened(&self, computer: &str) {
        let mut entries = lock(&self.entries);
        entries.retain(|e| {
            if !e.filter.sessions || e.filter.computer.as_deref() != Some(computer) {
                return true;
            }
            (e.sink)(Delivery::Opened)
        });
    }

    fn deliver(
        &self,
        computer: &str,
        wants: impl Fn(&Filter) -> bool,
        push: impl Fn(Release) -> Delivery,
    ) {
        let mut entries = lock(&self.entries);
        entries.retain(|e| {
            if !e.filter.computer.as_deref().is_none_or(|c| c == computer) || !wants(&e.filter) {
                return true;
            }
            if e.slot.lagged.load(Ordering::SeqCst) {
                return true;
            }
            if e.slot.pending.load(Ordering::SeqCst) >= CAPACITY {
                e.slot.lagged.store(true, Ordering::SeqCst);
                return (e.sink)(Delivery::Lagged {
                    computer: computer.to_owned(),
                    _slot: Release(Some((e.slot.clone(), true))),
                });
            }
            e.slot.pending.fetch_add(1, Ordering::SeqCst);
            (e.sink)(push(Release(Some((e.slot.clone(), false)))))
        });
    }
}

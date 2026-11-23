//! One ordered delivery channel to one subscriber, with a flush barrier,
//! and the [`Subscription`] every service stream uses.
//!
//! Every message is queued under one lock, so the subscriber sees them in
//! emission order. [`Outbox::flush`] resolves once the subscriber has taken
//! every message queued before it: an operation that awaits it before
//! returning delivers the events it caused ahead of its own result, as the
//! single callback of the JSON ABI did.
use crate::account::{Scope, View};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::{mpsc, oneshot, watch};

enum Item<T> {
    Message(T),
    Flush(oneshot::Sender<()>),
}

pub(crate) struct Outbox<T> {
    tx: Mutex<Option<mpsc::UnboundedSender<Item<T>>>>,
}

impl<T> Outbox<T> {
    pub(crate) fn new() -> Self {
        Self {
            tx: Mutex::new(None),
        }
    }
    fn lock(&self) -> MutexGuard<'_, Option<mpsc::UnboundedSender<Item<T>>>> {
        self.tx.lock().unwrap_or_else(|p| p.into_inner())
    }
    /// Queues `message` for the subscriber; dropped when there is none.
    pub(crate) fn send(&self, message: T) {
        if let Some(tx) = self.lock().as_ref() {
            let _ = tx.send(Item::Message(message));
        }
    }
    /// A new subscription; it replaces (ends) the previous one.
    pub(crate) fn subscribe(&self) -> Subscription<T> {
        let (tx, rx) = mpsc::unbounded_channel();
        *self.lock() = Some(tx);
        Subscription {
            source: Source::Queue(rx),
        }
    }
    /// Waits until the subscriber took every message queued so far.
    pub(crate) async fn flush(&self) {
        let taken = {
            let tx = self.lock();
            tx.as_ref().and_then(|tx| {
                let (ack, taken) = oneshot::channel();
                tx.send(Item::Flush(ack)).ok().map(|()| taken)
            })
        };
        if let Some(taken) = taken {
            let _ = taken.await;
        }
    }
    /// Ends the subscription after the messages already queued.
    pub(crate) fn close(&self) {
        *self.lock() = None;
    }
}

/// A stream of messages or view snapshots. The binding pumps it into its
/// own stream type and drops it when the host stops listening.
pub struct Subscription<T> {
    source: Source<T>,
}

enum Source<T> {
    /// Every message, in order.
    Queue(mpsc::UnboundedReceiver<Item<T>>),
    /// The current snapshot first, then the latest after each change.
    Watch { view: View<T>, first: bool },
}

impl<T: Clone> Subscription<T> {
    pub(crate) fn watch(rx: watch::Receiver<Arc<T>>) -> Self {
        Self::view(View::new(rx, Scope::unbound()))
    }
    /// A service's view, which ends with its account scope.
    pub(crate) fn view(view: View<T>) -> Self {
        Self {
            source: Source::Watch { view, first: true },
        }
    }
    /// The next item; `None` once the source ended.
    pub async fn next(&mut self) -> Option<T> {
        match &mut self.source {
            Source::Queue(rx) => loop {
                match rx.recv().await? {
                    Item::Message(message) => return Some(message),
                    // Everything before the marker was already handed out.
                    Item::Flush(ack) => {
                        let _ = ack.send(());
                    }
                }
            },
            Source::Watch { view, first } => {
                if !std::mem::take(first) {
                    view.changed().await.ok()?;
                }
                let latest = view.latest()?;
                Some(T::clone(&latest))
            }
        }
    }
    /// [`Subscription::next`] for a thread outside any async runtime.
    pub fn blocking_next(&mut self) -> Option<T> {
        match &mut self.source {
            Source::Queue(rx) => loop {
                match rx.blocking_recv()? {
                    Item::Message(message) => return Some(message),
                    Item::Flush(ack) => {
                        let _ = ack.send(());
                    }
                }
            },
            Source::Watch { .. } => tokio::runtime::Builder::new_current_thread()
                .build()
                .ok()?
                .block_on(self.next()),
        }
    }
}

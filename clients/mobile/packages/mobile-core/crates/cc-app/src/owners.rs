//! The ends of streams a host token owns (a work drawer, a feed follower,
//! a watch). A stream that only compares views cannot tell a closed owner
//! from an unchanged one, so it would wait for a change that never comes;
//! and the FFI pump only notices a cancelled Dart stream when it sends.
//! Closing the owner ends its streams instead.
use crate::account::View;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::watch;

enum Owner {
    /// Streams wait on it; dropping the sender ends them.
    Open(watch::Sender<()>),
    /// Closed before its stream started (FRB starts a stream on its pool,
    /// possibly after a later sync close); that stream takes the mark.
    Closed,
}

/// The owners of one kind of token, shared by a service and its actor.
#[derive(Clone, Default)]
pub(crate) struct Owners(Arc<Mutex<HashMap<u64, Owner>>>);

impl Owners {
    /// The end of a stream `token` owns.
    pub(crate) fn end(&self, token: u64) -> End {
        let mut owners = self.0.lock().unwrap_or_else(|p| p.into_inner());
        match owners.get(&token) {
            Some(Owner::Open(tx)) => End(tx.subscribe()),
            Some(Owner::Closed) => {
                owners.remove(&token);
                End(watch::channel(()).1)
            }
            None => {
                let (tx, rx) = watch::channel(());
                owners.insert(token, Owner::Open(tx));
                End(rx)
            }
        }
    }
    /// `token`'s owner closed: its streams end.
    pub(crate) fn close(&self, token: u64) {
        let mut owners = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(Owner::Open(_)) = owners.insert(token, Owner::Closed) {
            owners.remove(&token);
        }
    }
}

/// Reached once the stream's owner closed.
pub(crate) struct End(watch::Receiver<()>);

impl End {
    pub(crate) fn reached(&self) -> bool {
        self.0.has_changed().is_err()
    }
    /// Waits for a snapshot of `view` not yet seen; `None` once reached
    /// (the owner's view may well be unchanged) or the service stopped.
    pub(crate) async fn or_changed<T>(&mut self, view: &mut View<T>) -> Option<()> {
        tokio::select! {
            biased;
            // Never true: completes only once the owner closed.
            _ = self.0.wait_for(|_| false) => None,
            changed = view.changed() => changed.ok(),
        }
    }
}

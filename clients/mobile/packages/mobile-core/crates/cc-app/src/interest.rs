//! The per-computer interest arbiter (architecture §4.3): the only writer
//! of `chat:set-state-scopes` and `chat:set-interest`. Every write, from a
//! Rust service or a Dart feature's raw call through the bridge, goes
//! through it and is sent to the session while it holds its lock, so writes
//! keep one order.
//!
//! Each holder (the bridge on behalf of the Dart features not yet ported,
//! the overview) keeps its latest claim per channel and surface. A claim
//! makes the newest claim the desktop's state: the desktop's own rule is
//! last write wins, and Dart's flows rely on it (search opens a chat before
//! the overview stops claiming every scope). A release only forgets the
//! claim; it never writes, as leaving the overview never wrote in Dart.
//! Service writes the desktop already has are skipped; bridge writes are
//! always sent, so Dart features see the replies they always got. A new
//! session starts with nothing sent and no bridge claims (Dart features
//! claim again on reconnect; the overview re-claims when it comes online).
use serde_json::Value;
use std::collections::HashMap;

pub(crate) const SCOPES: &str = "chat:set-state-scopes";
pub(crate) const INTEREST: &str = "chat:set-interest";

/// Whether `channel` is one the arbiter owns.
pub(crate) fn owned(channel: &str) -> bool {
    channel == SCOPES || channel == INTEREST
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Holder {
    /// A Dart feature's raw call.
    Bridge,
    Overview,
    /// The selected chat (P5a). Its writes are always sent, as the Dart
    /// chats repository sent every open and leave.
    Chats,
    /// The Orchestrator's list of work entries (P9), on its own surface.
    /// Always sent, as Dart's controller wrote it.
    Orchestrator,
}

#[derive(Default)]
struct Surface {
    /// `(holder, channel)` -> (claim order, arguments).
    claims: HashMap<(Holder, &'static str), (u64, Value)>,
    /// What the desktop was last sent, per channel.
    sent: HashMap<&'static str, Value>,
}

/// Claims per `(computer, surface)`.
#[derive(Default)]
pub(crate) struct Arbiter {
    surfaces: HashMap<(String, String), Surface>,
    order: u64,
}

fn channel_key(channel: &str) -> &'static str {
    if channel == SCOPES { SCOPES } else { INTEREST }
}

impl Arbiter {
    fn surface(&mut self, computer: &str, surface: &str) -> &mut Surface {
        self.surfaces
            .entry((computer.to_owned(), surface.to_owned()))
            .or_default()
    }

    /// A raw call from the bridge: the bridge's claim, sent as is.
    pub(crate) fn bridge_write(
        &mut self,
        computer: &str,
        surface: &str,
        channel: &str,
        args: &Value,
    ) {
        self.write(computer, surface, Holder::Bridge, channel, args);
    }

    /// `holder` writes `args`: its claim, sent whatever the desktop has.
    pub(crate) fn write(
        &mut self,
        computer: &str,
        surface: &str,
        holder: Holder,
        channel: &str,
        args: &Value,
    ) {
        self.order += 1;
        let order = self.order;
        let channel = channel_key(channel);
        let state = self.surface(computer, surface);
        state
            .claims
            .insert((holder, channel), (order, args.clone()));
        state.sent.insert(channel, args.clone());
    }

    /// `holder` claims `args`. Returns the arguments to send, or `None`
    /// when the desktop already has them.
    pub(crate) fn claim(
        &mut self,
        computer: &str,
        surface: &str,
        holder: Holder,
        channel: &str,
        args: Value,
    ) -> Option<Value> {
        self.order += 1;
        let order = self.order;
        let channel = channel_key(channel);
        let state = self.surface(computer, surface);
        state.claims.insert((holder, channel), (order, args));
        let newest = state
            .claims
            .iter()
            .filter(|((_, c), _)| *c == channel)
            .max_by_key(|(_, (order, _))| *order)
            .map(|(_, (_, args))| args.clone())?;
        if state.sent.get(channel) == Some(&newest) {
            return None;
        }
        state.sent.insert(channel, newest.clone());
        Some(newest)
    }

    /// A service write failed: the desktop's state is unknown, so the next
    /// claim is sent.
    pub(crate) fn unsent(&mut self, computer: &str, surface: &str, channel: &str) {
        self.surface(computer, surface)
            .sent
            .remove(channel_key(channel));
    }

    /// `holder` stops claiming on `computer`. Nothing is written.
    pub(crate) fn release(&mut self, computer: &str, holder: Holder) {
        for ((c, _), state) in self.surfaces.iter_mut() {
            if c == computer {
                state.claims.retain(|(h, _), _| *h != holder);
            }
        }
    }

    /// A new session for `computer`: it has no interest yet.
    pub(crate) fn session_opened(&mut self, computer: &str) {
        for ((c, _), state) in self.surfaces.iter_mut() {
            if c == computer {
                state.sent.clear();
                state.claims.retain(|(h, _), _| *h != Holder::Bridge);
            }
        }
    }
}

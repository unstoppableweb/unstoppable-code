//! How a desktop chat tab's turns ended (`device_link/chats/turn_ends.dart`).

use std::collections::BTreeMap;

use crate::dart::{Dv, DvMap};

/// How each abnormally ended turn ended, keyed by the turn's user message id:
/// `failed`, `cancelled` or `interrupted` (`deviceTurnEndReasons`). The
/// recorded `turnEnds` outcome, else the `unacceptedTurnEnds` entry, when
/// either is failed or cancelled; else `interrupted` when an app restart
/// interrupted the turn. Malformed maps contribute nothing.
pub fn end_reasons(tab: &DvMap) -> BTreeMap<String, String> {
    let ends = tab.get("turnEnds");
    let unaccepted = tab.get("unacceptedTurnEnds");
    let interrupted = tab.get("interruptedTurns");
    let mut reasons = BTreeMap::new();
    let owners = [ends, unaccepted, interrupted]
        .into_iter()
        .filter_map(|value| match value {
            Dv::Map(map) => Some(map.iter().map(|(key, _)| key)),
            _ => None,
        })
        .flatten();
    for owner in owners {
        if reasons.contains_key(owner) {
            continue;
        }
        let end = ends.get(owner);
        let recorded = if end.is_map() && !end.get("outcome").is_null() {
            end.get("outcome")
        } else {
            unaccepted.get(owner)
        };
        match recorded.as_str() {
            Some(reason @ ("failed" | "cancelled")) => {
                reasons.insert(owner.to_owned(), reason.to_owned());
            }
            _ if !interrupted.get(owner).is_null() => {
                reasons.insert(owner.to_owned(), "interrupted".to_owned());
            }
            _ => {}
        }
    }
    reasons
}

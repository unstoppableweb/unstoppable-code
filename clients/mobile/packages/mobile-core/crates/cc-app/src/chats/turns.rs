use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use cc_domain::{
    chat::ChatState,
    dart::Dv,
    feed::{self, Presented, Role},
};

/// A completion counts only if this client watched the turn run. Keep recent
/// completions in the frame so coalescing a stream update does not lose them.
#[derive(Default)]
pub(super) struct Completions {
    pub(super) tracking: bool,
    chat: Option<String>,
    running: HashSet<String>,
    pub(super) recent: VecDeque<String>,
}

impl Completions {
    pub(super) fn stop(&mut self) {
        self.chat = None;
        self.running.clear();
    }

    pub(super) fn observe(
        &mut self,
        state: Option<(&ChatState, Option<&LatestTimer>)>,
        synchronized: bool,
    ) {
        let chat = state.map(|(state, _)| state.chat.key());
        if self.chat != chat {
            self.running.clear();
            self.chat = chat;
        }
        if !synchronized {
            return;
        }
        let Some((state, timer)) = state else { return };
        let Some(timer) = timer else { return };
        let (owner, completed) = (&timer.owner, timer.completed);
        if state.running() {
            if !completed {
                self.running.insert(owner.to_owned());
            }
            return;
        }
        if !completed
            || !self.running.contains(owner)
            || !state
                .tab
                .get("turnEnds")
                .get(owner)
                .get("outcome")
                .is_str("completed")
        {
            return;
        }
        if feed::end_reasons(&state.tab).contains_key(owner) {
            return;
        }
        self.running.remove(owner);
        let key = format!("computer:{}:{owner}", state.chat.id);
        if !self.recent.contains(&key) {
            if self.recent.len() == 256 {
                self.recent.pop_front();
            }
            self.recent.push_back(key);
        }
    }
}

#[derive(Debug)]
pub(super) struct LatestTimer {
    owner: String,
    completed: bool,
}

pub(super) fn latest_timer(state: &ChatState) -> Option<LatestTimer> {
    let timer = state.messages.iter().rev().find_map(|message| {
        let Dv::List(blocks) = message.raw.get("blocks") else {
            return None;
        };
        blocks
            .iter()
            .rev()
            .find(|block| block.get("type").is_str("turn_timer"))
    })?;
    Some(LatestTimer {
        owner: timer.get("userMessageId").as_str()?.to_owned(),
        completed: matches!(timer.get("completedAt"), Dv::Int(_) | Dv::Float(_)),
    })
}

/// The last segment with renderable output gets the rating control. Its
/// rating still uses the opening user message's id.
pub(super) fn feedback_footers(
    messages: &[Arc<Presented>],
    running: bool,
) -> Vec<(String, String)> {
    let mut footers = Vec::new();
    let mut opener = None;
    let mut footer = None;
    let mut has_output = false;
    for message in messages {
        if message.role == Some(Role::User) {
            if !message.continues_turn {
                if has_output && let Some((opener, footer)) = opener.zip(footer) {
                    footers.push((footer, opener));
                }
                opener = Some(message.id.clone());
                footer = opener.clone();
                has_output = false;
            } else if opener.is_some() {
                footer = Some(message.id.clone());
            }
        } else if opener.is_some() && feed::turns::renderable(message) {
            has_output = true;
        }
    }
    if !running
        && has_output
        && let Some((opener, footer)) = opener.zip(footer)
    {
        footers.push((footer, opener));
    }
    footers
}

//! The tab list and decisions of one subscribed desktop scope
//! (`DeviceChatScopeState`, `chats/scope_state.dart`).
use super::{Thrown, cast_list, is_running, link_string, object, spread};
use crate::dart::{Dv, DvMap};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScopeState {
    pub tabs: Vec<DvMap>,
    /// `chatId` -> runtime, in Dart's insertion order.
    pub runtime: DvMap,
    pub questions: Vec<DvMap>,
    pub approvals: Vec<DvMap>,
}

fn objects(value: &Dv) -> Result<Vec<DvMap>, Thrown> {
    cast_list(value)?
        .into_iter()
        .map(|v| object(v).cloned())
        .collect()
}

/// `(value as List? ?? []).map(deviceLinkObject)`.
fn optional_objects(value: &Dv) -> Result<Vec<DvMap>, Thrown> {
    if value.is_null() {
        Ok(Vec::new())
    } else {
        objects(value)
    }
}

impl ScopeState {
    pub fn hydrate(&mut self, snapshot: &DvMap) -> Result<(), Thrown> {
        let file = object(snapshot.get("tabsFile"))?;
        self.tabs = objects(file.get("tabs"))?;
        self.questions = optional_objects(file.get("pendingQuestions"))?;
        self.approvals = optional_objects(file.get("pendingApprovals"))?;
        let mut runtime = DvMap::new();
        for (key, value) in object(snapshot.get("runtimeByChatId"))?.iter() {
            if value.is_map() {
                runtime.insert(key.to_owned(), value.clone());
            }
        }
        self.runtime = runtime;
        Ok(())
    }

    /// `tab(id)`; `None` is Dart's `{}`.
    pub fn tab(&self, id: &str) -> Option<&DvMap> {
        self.tabs.iter().find(|t| t.get("id").is_str(id))
    }

    /// `pendingQuestions(id).length`.
    pub fn pending_questions(&self, id: &str) -> usize {
        self.questions
            .iter()
            .filter(|q| {
                q.get("chatId").is_str(id)
                    && q.get("answeredAt").is_null()
                    && q.get("dismissedAt").is_null()
            })
            .count()
    }

    pub fn needs_input(&self, id: &str) -> bool {
        self.pending_questions(id) > 0
            || self.approvals.iter().any(|a| a.get("chatId").is_str(id))
            || self
                .tab(id)
                .is_some_and(|t| !t.get("pendingPlanExit").is_null())
    }

    pub fn running(&self, id: &str) -> bool {
        is_running(self.runtime.get(id).get("status"))
    }

    pub fn apply(&mut self, change: &DvMap) -> Result<(), Thrown> {
        match change.get("type").as_str() {
            Some("tab.created" | "tab.upserted") => {
                let next = object(change.get("tab"))?.clone();
                match self
                    .tabs
                    .iter()
                    .position(|t| t.get("id").loosely_equals(next.get("id")))
                {
                    Some(i) => self.tabs[i] = next,
                    None => self.tabs.push(next),
                }
            }
            Some("tab.metadata_patched") => {
                let target = change.get("tabId");
                if let Some(i) = self
                    .tabs
                    .iter()
                    .position(|t| t.get("id").loosely_equals(target))
                {
                    self.tabs[i] = spread(&self.tabs[i], object(change.get("patch"))?);
                }
            }
            Some("tab.order_changed") => {
                let ids = cast_list(change.get("tabIds"))?;
                let mut ordered = Vec::with_capacity(self.tabs.len());
                for id in &ids {
                    for tab in &self.tabs {
                        if tab.get("id").loosely_equals(id) {
                            ordered.push(tab.clone());
                        }
                    }
                }
                for tab in &self.tabs {
                    if !ids.iter().any(|id| id.loosely_equals(tab.get("id"))) {
                        ordered.push(tab.clone());
                    }
                }
                self.tabs = ordered;
            }
            Some("tab.removed") => {
                let target = change.get("tabId");
                self.tabs.retain(|t| !t.get("id").loosely_equals(target));
            }
            Some("runtime.patched") => {
                let chat = link_string(change, "chatId")?.to_owned();
                let runtime = object(change.get("runtime"))?.clone();
                self.runtime.insert(chat, Dv::Map(runtime));
            }
            Some("transcript.updated") => {
                let target = change.get("chatId");
                if let Some(i) = self
                    .tabs
                    .iter()
                    .position(|t| t.get("id").loosely_equals(target))
                {
                    let transcript = object(change.get("transcript"))?.clone();
                    let mut tab = self.tabs[i].clone();
                    tab.insert("transcript".into(), Dv::Map(transcript));
                    self.tabs[i] = tab;
                }
            }
            Some("pending_question.upserted") => {
                let next = object(change.get("question"))?.clone();
                self.questions
                    .retain(|q| !q.get("requestId").loosely_equals(next.get("requestId")));
                self.questions.push(next);
            }
            Some("pending_question.removed") => {
                let (request, chat) = (change.get("requestId"), change.get("chatId"));
                self.questions.retain(|q| {
                    !(q.get("requestId").loosely_equals(request)
                        && q.get("chatId").loosely_equals(chat))
                });
            }
            _ => {}
        }
        Ok(())
    }
}

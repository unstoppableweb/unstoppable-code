use super::*;

impl Actor {
    pub(super) fn close_tab(&mut self, id: String, waiter: Option<Waiter>, done: &mut Done) {
        let chat = self.state().and_then(|state| {
            let open = state.open_tabs().any(|tab| tab.get("id").is_str(&id));
            let pending = self.pending.as_ref().is_some_and(|send| {
                send.chat.project_id == state.chat.project_id
                    && send.chat.worktree_id == state.chat.worktree_id
                    && send.chat.id == id
            });
            (open && !pending && !state.scope.running(&id)).then(|| ChatRef {
                id,
                ..state.chat.clone()
            })
        });
        let Some(chat) = chat else {
            done.extend(waiter.map(|waiter| (waiter, None, None)));
            return;
        };
        if !self.ready() || self.closing_tab_key().is_some() {
            done.extend(
                waiter.map(|waiter| (waiter, Some(Failure::link(CopyKey::SendNotReady)), None)),
            );
            return;
        }
        if self.state().is_some_and(|state| state.chat.id == chat.id) {
            self.composer_intent(ComposerIntent::InvalidatePicks, None, done);
        }
        let generation = self.generation;
        self.closing_tab = Some((generation, chat.key()));
        self.spawn(move |inner, peer| async move {
            let command = json!({"type": "chat.close_tab", "tabId": chat.id, "mode": "archive"});
            let failure = command_call(&inner, &peer, &chat, command)
                .await
                .err()
                .map(|error| error.failure());
            Msg::Archived {
                chat,
                generation,
                waiter,
                failure,
            }
        });
    }

    pub(super) fn archived(
        &mut self,
        chat: ChatRef,
        generation: u64,
        waiter: Option<Waiter>,
        failure: Option<Failure>,
        done: &mut Done,
    ) {
        if self
            .closing_tab
            .as_ref()
            .is_some_and(|(route, _)| *route == generation)
        {
            self.closing_tab = None;
        }
        if !self.connected || self.generation != generation {
            done.extend(waiter.map(|waiter| (waiter, None, None)));
            return;
        }
        if failure.is_some() {
            done.extend(waiter.map(|waiter| (waiter, failure, None)));
            return;
        }
        let Some(state) = self.state() else {
            done.extend(waiter.map(|waiter| (waiter, None, None)));
            return;
        };
        if state.chat.id != chat.id {
            if self.hydrating {
                // Reconcile the archive after the pending open acknowledges its selection.
                self.refresh_after_open = true;
                done.extend(waiter.map(|waiter| (waiter, None, None)));
                return;
            }
            return self.refresh(waiter, done);
        }
        let next = state.open_tabs().find_map(|tab| {
            let id = tab.get("id").as_str()?;
            (id != chat.id).then(|| ChatRef {
                id: id.to_owned(),
                title: chat::chat_title(tab, copy::text(CopyKey::ChatFallback)),
                ..chat.clone()
            })
        });
        if let Some(next) = next {
            self.select_chat(next, waiter, done);
        } else {
            self.create_tab(chat.project_id, chat.worktree_id, true, waiter, done);
        }
    }

    // Internal selections keep the route's generation so it can leave
    // before the host receives the new frame.
    pub(super) fn select_chat(&mut self, chat: ChatRef, waiter: Option<Waiter>, done: &mut Done) {
        self.composer_intent(ComposerIntent::InvalidatePicks, None, done);
        self.invalidate_receipts();
        self.receipts.held = false;
        self.open(chat, None, waiter, done);
    }

    pub(super) fn refresh(&mut self, waiter: Option<Waiter>, done: &mut Done) {
        if let Some(chat) = self.state().map(|state| state.chat.clone()) {
            self.open(chat, None, waiter, done);
        } else {
            done.extend(waiter.map(|waiter| (waiter, None, None)));
        }
    }
}

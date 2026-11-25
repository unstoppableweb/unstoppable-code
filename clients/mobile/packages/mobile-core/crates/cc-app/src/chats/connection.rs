use super::{Actor, Done, FailKind, Failure, Msg, Waiter};
use crate::{activity, pipelines};
use tokio::sync::oneshot;

#[derive(Default)]
pub(super) struct Restoration {
    pub(super) connection: u64,
    pub(super) read: Option<u64>,
    pub(super) activity: Option<activity::Handle>,
    pub(super) pipelines: Option<pipelines::Handle>,
    pub(super) activity_connected: bool,
}

impl Restoration {
    pub(super) fn set_activity(&mut self, connected: bool, waiter: Option<activity::Waiter>) {
        self.activity_connected = connected;
        if let Some(pipelines) = &self.pipelines {
            let _ = pipelines.send(pipelines::Intent::SetConnected(connected), None);
        }
        if let Some(activity) = &self.activity {
            let _ = activity.send(activity::Intent::SetConnected(connected), waiter);
        }
    }
}

impl Actor {
    pub(super) fn restore_connection(
        &mut self,
        catalog_loaded: bool,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        if !self.connected {
            done.extend(waiter.map(|waiter| (waiter, None, None)));
            return;
        }
        let connection = self.restoration.connection;
        let Some(chat) = self
            .state()
            .filter(|_| catalog_loaded)
            .map(|s| s.chat.clone())
        else {
            self.finish_restoring(connection, None, waiter, done);
            return;
        };
        let (tx, rx) = oneshot::channel();
        self.open(chat, None, Some(tx), done);
        self.restoration.read = Some(self.reads);
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            if let Ok(settled) = rx.await {
                let _ = inbox.send(Msg::ConnectionRestored {
                    connection,
                    failure: settled.failure,
                    waiter,
                });
            }
        });
    }

    pub(super) fn finish_restoring(
        &mut self,
        connection: u64,
        failure: Option<Failure>,
        waiter: Option<Waiter>,
        done: &mut Done,
    ) {
        if self.restoration.connection != connection || !self.connected {
            done.extend(waiter.map(|waiter| (waiter, None, None)));
            return;
        }
        let (tx, rx) = oneshot::channel();
        self.restoration.set_activity(true, Some(tx));
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            let activity_failure = match rx.await {
                Ok(activity::Outcome::Failed(error)) => Some(Failure {
                    kind: if error.link {
                        FailKind::Link
                    } else {
                        FailKind::Other
                    },
                    message: error.message,
                    code: None,
                }),
                _ => None,
            };
            let _ = inbox.send(Msg::Done {
                waiter,
                failure: activity_failure.or(failure),
                outcome: None,
            });
        });
    }
}

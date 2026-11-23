//! Migration-only: the relay and session operations the Dart product layer
//! still drives (deleted in cleanup C3). Desktop values are bridge JSON
//! (`$bytes`, `$date`, `$ref`, ...) for `value_codec.dart`.
//!
//! Session calls ([`TransportBridge::submit`]) are answered on
//! [`TransportBridge::messages`] with every core event, in emission order.
//! Every other call resolves after the events it caused were added to that
//! stream.
use super::{core::CoreFailure, handler};
use crate::frb_generated::StreamSink;
use flutter_rust_bridge::frb;
use std::sync::{Arc, Mutex};

pub enum SessionCall {
    /// Pairs if needed (`allow_pairing`, default true), opens the control
    /// session and replies with the hello. `visible` is the caller's
    /// Orchestrator state for the new session.
    Connect {
        computer_id: String,
        allow_pairing: Option<bool>,
        visible: Option<bool>,
    },
    /// A desktop IPC request: `args_json` a JSON array, `surface` `main`
    /// (default) or `app-advisor`, `timeout_ms` 1..=900000 (default 15000).
    Invoke {
        computer_id: String,
        channel: String,
        args_json: String,
        surface: Option<String>,
        timeout_ms: Option<u64>,
    },
    HostInfo {
        computer_id: String,
    },
    /// Replies `null`.
    SetOrchestratorVisible {
        computer_id: String,
        visible: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeMessage {
    Reply { id: i64, value_json: String },
    Failed { id: i64, failure: CoreFailure },
    Event(BridgeEvent),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeEvent {
    PairingCode {
        computer_id: String,
        code: String,
    },
    /// A desktop event message (bridge JSON), in session order.
    Message {
        computer_id: String,
        message_json: String,
    },
    /// A connected session ended (once per session).
    Closed {
        computer_id: String,
        code: String,
        reason: String,
    },
    RelayOpened {
        peers_json: String,
    },
    RelayClosed {
        reason: String,
    },
    Peers {
        peers_json: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicIdentity {
    pub device_id: String,
    pub public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    pub computer_id: String,
    pub public_key: String,
}

pub enum IdentityImport {
    /// The Dart `device_link_desktop.v1` record.
    DartRecord { record: String },
    Seed {
        seed: String,
        pins_json: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityImported {
    pub device_id: String,
    pub public_key: String,
    pub pins: u32,
    pub replaced: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayStatus {
    pub open: bool,
    pub peers_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyCleanup {
    pub revoked: bool,
    pub cleared: bool,
}

impl From<SessionCall> for cc_core::SessionCall {
    fn from(c: SessionCall) -> Self {
        match c {
            SessionCall::Connect {
                computer_id,
                allow_pairing,
                visible,
            } => Self::Connect {
                computer_id,
                allow_pairing,
                visible,
            },
            SessionCall::Invoke {
                computer_id,
                channel,
                args_json,
                surface,
                timeout_ms,
            } => Self::Invoke {
                computer_id,
                channel,
                args_json,
                surface,
                timeout_ms,
            },
            SessionCall::HostInfo { computer_id } => Self::HostInfo { computer_id },
            SessionCall::SetOrchestratorVisible {
                computer_id,
                visible,
            } => Self::SetOrchestratorVisible {
                computer_id,
                visible,
            },
        }
    }
}

impl From<cc_core::BridgeEvent> for BridgeEvent {
    fn from(e: cc_core::BridgeEvent) -> Self {
        use cc_core::BridgeEvent as E;
        match e {
            E::PairingCode { computer_id, code } => Self::PairingCode { computer_id, code },
            E::Message {
                computer_id,
                message_json,
            } => Self::Message {
                computer_id,
                message_json,
            },
            E::Closed {
                computer_id,
                code,
                reason,
            } => Self::Closed {
                computer_id,
                code,
                reason,
            },
            E::RelayOpened { peers_json } => Self::RelayOpened { peers_json },
            E::RelayClosed { reason } => Self::RelayClosed { reason },
            E::Peers { peers_json } => Self::Peers { peers_json },
        }
    }
}

impl From<cc_core::BridgeMessage> for BridgeMessage {
    fn from(m: cc_core::BridgeMessage) -> Self {
        match m {
            cc_core::BridgeMessage::Reply { id, value_json } => Self::Reply { id, value_json },
            cc_core::BridgeMessage::Failed { id, failure } => Self::Failed {
                id,
                failure: failure.into(),
            },
            cc_core::BridgeMessage::Event(e) => Self::Event(e.into()),
        }
    }
}

type Pending = Arc<Mutex<Option<cc_core::Subscription<cc_core::BridgeMessage>>>>;

#[frb(opaque)]
#[derive(Clone)]
pub struct TransportBridge {
    inner: cc_core::TransportBridge,
    /// The subscription taken at open, until Dart listens.
    pending: Pending,
}

impl TransportBridge {
    pub(crate) fn new(inner: cc_core::TransportBridge, pending: Pending) -> Self {
        Self { inner, pending }
    }

    /// Replies to [`TransportBridge::submit`] and every core event, in
    /// emission order. Listen once; listening again ends the previous
    /// stream.
    pub fn messages(&self, sink: StreamSink<BridgeMessage>) {
        let taken = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        let mut messages = taken.unwrap_or_else(|| self.inner.messages());
        handler::runtime().spawn(async move {
            while let Some(message) = messages.next().await {
                // Dart stopped listening: dropping the subscription ends it.
                if sink.add(message.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// Starts session call `id`; never blocks on work.
    #[frb(sync)]
    pub fn submit(&self, id: i64, call: SessionCall) {
        self.inner.submit(id, call.into());
    }
    pub async fn identity(&self) -> Result<PublicIdentity, CoreFailure> {
        let i = self.inner.identity().await?;
        Ok(PublicIdentity {
            device_id: i.device_id,
            public_key: i.public_key,
        })
    }
    pub async fn import_identity(
        &self,
        source: IdentityImport,
        force: bool,
    ) -> Result<IdentityImported, CoreFailure> {
        let source = match source {
            IdentityImport::DartRecord { record } => cc_core::IdentityImport::DartRecord { record },
            IdentityImport::Seed { seed, pins_json } => {
                cc_core::IdentityImport::Seed { seed, pins_json }
            }
        };
        let r = self.inner.import_identity(source, force).await?;
        Ok(IdentityImported {
            device_id: r.device_id,
            public_key: r.public_key,
            pins: r.pins,
            replaced: r.replaced,
        })
    }
    /// Paired computers, reachable or not.
    pub async fn pins(&self) -> Result<Vec<Pin>, CoreFailure> {
        Ok(self
            .inner
            .pins()
            .await?
            .into_iter()
            .map(|p| Pin {
                computer_id: p.computer_id,
                public_key: p.public_key,
            })
            .collect())
    }
    /// Opens the relay when needed; its peers as JSON, each with `paired`.
    pub async fn computers(&self) -> Result<String, CoreFailure> {
        Ok(self.inner.computers().await?)
    }
    pub async fn relay_status(&self) -> Result<RelayStatus, CoreFailure> {
        let s = self.inner.relay_status().await?;
        Ok(RelayStatus {
            open: s.open,
            peers_json: s.peers_json,
        })
    }
    pub async fn relay_probe(&self, timeout_ms: Option<u64>) -> Result<bool, CoreFailure> {
        Ok(self.inner.relay_probe(timeout_ms).await?)
    }
    pub async fn cancel_connect(&self, computer_id: String) -> Result<bool, CoreFailure> {
        Ok(self.inner.cancel_connect(computer_id).await?)
    }
    pub async fn disconnect(&self, computer_id: String) -> Result<(), CoreFailure> {
        Ok(self.inner.disconnect(computer_id).await?)
    }
    pub async fn forget(&self, computer_id: String) -> Result<(), CoreFailure> {
        Ok(self.inner.forget(computer_id).await?)
    }
    pub async fn suspend(&self) -> Result<(), CoreFailure> {
        Ok(self.inner.suspend().await?)
    }
    pub async fn saved_computers(&self) -> Result<Option<String>, CoreFailure> {
        Ok(self.inner.saved_computers().await?)
    }
    pub async fn save_computers(
        &self,
        record_json: String,
        force: bool,
    ) -> Result<String, CoreFailure> {
        Ok(self.inner.save_computers(record_json, force).await?)
    }
    pub async fn import_saved_computers(
        &self,
        raw: String,
        force: bool,
    ) -> Result<String, CoreFailure> {
        Ok(self.inner.import_saved_computers(raw, force).await?)
    }
    pub async fn cleanup_legacy_key(&self) -> Result<LegacyCleanup, CoreFailure> {
        let r = self.inner.cleanup_legacy_key().await?;
        Ok(LegacyCleanup {
            revoked: r.revoked,
            cleared: r.cleared,
        })
    }
}

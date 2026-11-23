//! Migration-only: the relay and session operations the Dart product layer
//! still drives over the Rust session (deleted in cleanup C3). Desktop
//! values stay in the tagged-JSON bridge form (`$bytes`, `$date`, `$ref`,
//! ...) that `value_codec.dart` reads.
//!
//! Ordering: [`TransportBridge::submit`] hands session calls to their
//! session in submission order, and their replies arrive on
//! [`TransportBridge::messages`] together with every core event, in the order
//! the core emitted them. Every other operation resolves after the events it
//! caused were delivered to the subscription.
use super::{CoreFailure, CoreInner, Subscription};
use serde_json::Value;
use std::sync::Arc;

/// A session operation, answered on [`TransportBridge::messages`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionCall {
    /// Pairs if needed (`allow_pairing`, default true), opens the control
    /// session and replies with the desktop hello. `visible` is this
    /// caller's Orchestrator state for the new session.
    Connect {
        computer_id: String,
        allow_pairing: Option<bool>,
        visible: Option<bool>,
    },
    /// One desktop IPC request. `args_json` is a JSON array; `surface` is
    /// `main` (default) or `app-advisor`; `timeout_ms` 1..=900000, default
    /// 15000. Replies with the desktop value.
    Invoke {
        computer_id: String,
        channel: String,
        args_json: String,
        surface: Option<String>,
        timeout_ms: Option<u64>,
    },
    /// Re-reads the hello with the session's negotiated version.
    HostInfo { computer_id: String },
    /// The Orchestrator window state the desktop sees. Replies `null`.
    SetOrchestratorVisible { computer_id: String, visible: bool },
}

/// One item of the ordered bridge stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeMessage {
    /// Submitted call `id` succeeded with a bridge-JSON value.
    Reply {
        id: i64,
        value_json: String,
    },
    Failed {
        id: i64,
        failure: CoreFailure,
    },
    Event(BridgeEvent),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeEvent {
    /// The code to compare with the desktop while pairing.
    PairingCode {
        computer_id: String,
        code: String,
    },
    /// A desktop event message (bridge JSON), in session order.
    Message {
        computer_id: String,
        message_json: String,
    },
    /// A connected session ended (exactly once per session).
    Closed {
        computer_id: String,
        code: String,
        reason: String,
    },
    /// The account relay opened; peers as JSON, each with `paired`.
    RelayOpened {
        peers_json: String,
    },
    RelayClosed {
        reason: String,
    },
    /// The relay's computers changed.
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityImport {
    /// The Dart `device_link_desktop.v1` secure-storage record.
    DartRecord { record: String },
    /// A base64url seed and `{computerId: publicKey}` pins as JSON.
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

pub(crate) fn parse_json(raw: &str) -> cc_protocol::Result<Value> {
    crate::bridge::parse_json(raw.as_bytes(), 0)
}

#[derive(Clone)]
pub struct TransportBridge {
    core: Arc<CoreInner>,
}

impl TransportBridge {
    pub(crate) fn new(core: Arc<CoreInner>) -> Self {
        Self { core }
    }

    /// Replies to [`TransportBridge::submit`] and every core event, in
    /// emission order. One subscriber: a new subscription ends the previous.
    /// A session's events end with its account scope: leaving the account
    /// reports each of its sessions `closed` (and its relay closed) before
    /// anything of the next account's, and nothing of them after.
    pub fn messages(&self) -> Subscription<BridgeMessage> {
        self.core.app.outbox.subscribe()
    }
    /// Starts session call `id` for the account scope current now; never
    /// blocks on work. It reaches only that scope's session and answers
    /// `account_changed` once the scope ended, also when it ended before
    /// the session answered.
    pub fn submit(&self, id: i64, call: SessionCall) {
        self.core.app.submit(id, call);
    }

    pub async fn identity(&self) -> Result<PublicIdentity, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                let identity = app.store.identity()?;
                Ok(PublicIdentity {
                    device_id: identity.device_id.clone(),
                    public_key: identity.public_key.clone(),
                })
            })
            .await
    }
    /// Imports an identity and its pins. Without `force`, an existing
    /// different identity or a conflicting pin is kept and reported.
    pub async fn import_identity(
        &self,
        source: IdentityImport,
        force: bool,
    ) -> Result<IdentityImported, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                let v = app.import_identity(source, force).await?;
                Ok(IdentityImported {
                    device_id: v["deviceId"].as_str().unwrap_or_default().into(),
                    public_key: v["publicKey"].as_str().unwrap_or_default().into(),
                    pins: v["pins"].as_u64().unwrap_or_default() as u32,
                    replaced: v["replaced"] == true,
                })
            })
            .await
    }
    /// Paired computers, reachable or not.
    pub async fn pins(&self) -> Result<Vec<Pin>, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                Ok(app
                    .store
                    .pins()?
                    .into_iter()
                    .map(|(computer_id, public_key)| Pin {
                        computer_id,
                        public_key,
                    })
                    .collect())
            })
            .await
    }
    /// Opens the relay when needed and lists its peers (JSON, each with
    /// `paired`).
    ///
    /// This and every operation below acts for the account scope current
    /// when it is called ([`CoreInner::scoped`]): `account_changed` once
    /// that scope ended, also when it ended before the operation completed.
    pub async fn computers(&self) -> Result<String, CoreFailure> {
        self.core
            .scoped(|app, _| async move { Ok(Value::from(app.computers().await?).to_string()) })
            .await
    }
    pub async fn relay_status(&self) -> Result<RelayStatus, CoreFailure> {
        self.core
            .scoped(|app, _| async move {
                let (open, peers) = app.relay_status();
                Ok(RelayStatus {
                    open,
                    peers_json: Value::from(peers).to_string(),
                })
            })
            .await
    }
    /// Whether the relay answers a liveness check within `timeout_ms`
    /// (1..=60000, default 3000); closes it when not.
    pub async fn relay_probe(&self, timeout_ms: Option<u64>) -> Result<bool, CoreFailure> {
        self.core
            .scoped(|app, _| async move { app.relay_probe(timeout_ms).await })
            .await
    }
    /// Cancels a connect in progress; false when there was none.
    pub async fn cancel_connect(&self, computer_id: String) -> Result<bool, CoreFailure> {
        self.core
            .scoped(|app, scope| async move { app.cancel_connect(&scope, &computer_id).await })
            .await
    }
    /// Ends the computer's session (politely) and clears its caches.
    pub async fn disconnect(&self, computer_id: String) -> Result<(), CoreFailure> {
        self.core
            .scoped(|app, scope| async move { app.disconnect(&scope, &computer_id, false).await })
            .await
    }
    /// [`TransportBridge::disconnect`], then forgets the computer's pin.
    pub async fn forget(&self, computer_id: String) -> Result<(), CoreFailure> {
        self.core
            .scoped(|app, scope| async move { app.disconnect(&scope, &computer_id, true).await })
            .await
    }
    /// Drops every session and the relay without `close`, as dropping the
    /// Dart account socket does. Ended sessions fail requests `not_sent`
    /// until disconnect or connect.
    pub async fn suspend(&self) -> Result<(), CoreFailure> {
        self.core
            .scoped(|app, scope| async move {
                app.disconnect_all_in(&scope, "suspended").await;
                Ok(())
            })
            .await
    }
    /// The saved-computers record of the signed-in account, as JSON.
    pub async fn saved_computers(&self) -> Result<Option<String>, CoreFailure> {
        self.core
            .scoped(|app, scope| async move {
                Ok(app
                    .store
                    .saved_computers(&app.account_in(&scope)?)?
                    .map(|v| v.to_string()))
            })
            .await
    }
    /// Validates and saves the record; returns it normalized.
    pub async fn save_computers(
        &self,
        record_json: String,
        force: bool,
    ) -> Result<String, CoreFailure> {
        self.core
            .scoped(|app, scope| async move {
                let record = parse_json(&record_json)?;
                app.in_scope(&scope, || {
                    let account = app.account_in(&scope)?;
                    Ok(app
                        .store
                        .put_saved_computers(&account, &record, force)?
                        .to_string())
                })
            })
            .await
    }
    /// Imports the Dart saved-computers secure-storage string.
    pub async fn import_saved_computers(
        &self,
        raw: String,
        force: bool,
    ) -> Result<String, CoreFailure> {
        self.core
            .scoped(|app, scope| async move {
                app.in_scope(&scope, || {
                    let account = app.account_in(&scope)?;
                    Ok(app
                        .store
                        .import_saved_computers_dart(&account, &raw, force)?
                        .to_string())
                })
            })
            .await
    }
    /// Revokes a recorded legacy API key, then clears it from the record.
    pub async fn cleanup_legacy_key(&self) -> Result<LegacyCleanup, CoreFailure> {
        self.core
            .scoped(|app, scope| async move {
                let account = app.account_in(&scope)?;
                let v = app.auth.cleanup_legacy_key(&account).await?;
                Ok(LegacyCleanup {
                    revoked: v["revoked"] == true,
                    cleared: v["cleared"] == true,
                })
            })
            .await
    }
}

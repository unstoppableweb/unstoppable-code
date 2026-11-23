//! Ports: everything with IO the application layer uses. `cc-infra`
//! implements them; `cc-core` wires the implementations in with
//! [`assemble`]. Public for those two crates only; `cc-core` does not
//! re-export this module.
use cc_protocol::{Result, rpc};
use serde_json::{Value, json};
use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc, time::Duration};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

pub use crate::assemble::{Assembly, assemble};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
/// A session event as JSON: `{event: "event", computerId, message}` or
/// `{event: "closed", computerId, code, reason}`, in session order.
pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

// ---- Hosted auth ----

/// A validated sign-in.
#[derive(Debug, Clone)]
pub struct SignedIn {
    /// The server's user record.
    pub user: Value,
    pub account_id: String,
    /// The account of the last validated user persisted before this one.
    pub previous_account: Option<String>,
}
impl SignedIn {
    pub fn new(user: Value, previous_account: Option<String>) -> Self {
        let account_id = user["id"].as_str().unwrap_or_default().to_owned();
        Self {
            user,
            account_id,
            previous_account,
        }
    }
    /// The core must tear down connections, relay and caches only then.
    pub fn account_changed(&self) -> bool {
        self.previous_account.as_deref() != Some(self.account_id.as_str())
    }
    /// Guests (`isAnonymous`) are excluded from Computer Connect.
    pub fn is_guest(&self) -> bool {
        self.user["isAnonymous"] == true
    }
    /// `{status: signedIn, user, accountChanged, hasAccount}`.
    pub fn to_json(&self) -> Value {
        json!({
            "status": "signedIn",
            "user": self.user,
            "accountChanged": self.account_changed(),
            "hasAccount": !self.is_guest(),
        })
    }
}

#[derive(Debug, Clone)]
pub enum AuthSession {
    SignedIn(SignedIn),
    /// No credentials, or the server confirmed (twice) they are invalid and
    /// they were cleared.
    SignedOut,
}

#[derive(Debug, Clone)]
pub enum SignInStep {
    SignedIn(SignedIn),
    /// Keep the pending verifier; complete with [`AuthPort::two_factor`].
    TwoFactor {
        challenge: String,
    },
    /// Email sign-in needs the verify step first.
    VerificationRequired,
    /// The user backed out (`error=access_denied`); not a failure.
    Cancelled,
}

/// Hosted sign-in, session validation and authenticated HTTP, bound to the
/// encrypted store that holds the session.
pub trait AuthPort: Send + Sync {
    /// `{status: signedIn|unverified|signedOut, user?, hasAccount}` without
    /// any network request.
    fn status(&self) -> Result<Value>;
    fn restore(&self) -> BoxFuture<'_, Result<AuthSession>>;
    /// The process-cached session when the stored token was validated by
    /// this process; otherwise [`AuthPort::restore`].
    fn ensure_valid(&self) -> BoxFuture<'_, Result<AuthSession>>;
    fn revalidate_after_auth_failure(&self) -> BoxFuture<'_, Result<AuthSession>>;
    fn adopt<'a>(
        &'a self,
        token: &'a str,
        proof: Option<&'a str>,
    ) -> BoxFuture<'a, Result<AuthSession>>;
    fn adopt_app_session(
        &self,
        token: &str,
        proof: Option<&str>,
        account_id: &str,
    ) -> Result<AuthSession>;
    fn app_owned(&self) -> bool;
    fn forget(&self) -> Result<()>;
    fn forget_if_token(&self, token: &str) -> Result<bool>;
    fn sign_out(&self) -> BoxFuture<'_, Result<()>>;
    fn cancel_sign_in(&self);
    /// `{authorizeUrl, callbackUrl}`.
    fn begin_oauth(&self, provider: &str, callback_url: &str) -> Result<Value>;
    fn oauth_callback<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<SignInStep>>;
    /// `{nonceHash}`.
    fn apple_begin(&self) -> Value;
    fn apple_complete<'a>(
        &'a self,
        identity_token: &'a str,
        name: Option<&'a str>,
    ) -> BoxFuture<'a, Result<SignInStep>>;
    fn two_factor<'a>(
        &'a self,
        challenge: &'a str,
        code: &'a str,
    ) -> BoxFuture<'a, Result<SignInStep>>;
    fn email_sign_in<'a>(
        &'a self,
        email: &'a str,
        password: &'a str,
    ) -> BoxFuture<'a, Result<SignInStep>>;
    /// `available` returns `{enabled}`; `sign_up`, `verify`, `forgot` and
    /// `reset` read `email`, `password` and `otp` from `body` and return `{}`.
    fn email_action<'a>(&'a self, action: &'a str, body: &'a Value)
    -> BoxFuture<'a, Result<Value>>;
    /// `{token, relayUrl}` for this device.
    fn relay_token<'a>(&'a self, device_id: &'a str) -> BoxFuture<'a, Result<Value>>;
    /// `{status, headers, body}` for `{method, path, body?, retryTransient?,
    /// timeoutMs?}`.
    fn http_request<'a>(&'a self, request: &'a Value) -> BoxFuture<'a, Result<Value>>;
    /// `{revoked, cleared}`.
    fn cleanup_legacy_key<'a>(&'a self, account: &'a str) -> BoxFuture<'a, Result<Value>>;
}

// ---- Encrypted store ----

/// This installation's identity. The seed never leaves Rust.
pub struct DeviceIdentity {
    pub device_id: String,
    pub public_key: String,
    pub seed: Zeroizing<[u8; 32]>,
}
impl DeviceIdentity {
    /// `{deviceId, publicKey}`.
    pub fn public(&self) -> Value {
        json!({"deviceId": self.device_id, "publicKey": self.public_key})
    }
}

pub trait StorePort: Send + Sync {
    /// Created and saved on first use.
    fn identity(&self) -> Result<DeviceIdentity>;
    fn existing_identity(&self) -> Result<Option<DeviceIdentity>>;
    /// Paired computers: device id to public key.
    fn pins(&self) -> Result<BTreeMap<String, String>>;
    fn pin(&self, peer: &str) -> Result<Option<String>>;
    fn remember_pin(&self, peer: &str, key: &str) -> Result<()>;
    fn forget_pin(&self, peer: &str) -> Result<()>;
    /// `{deviceId, publicKey, pins, replaced}`.
    fn identity_import(&self, seed: &str, pins: &Value, force: bool) -> Result<Value>;
    fn identity_import_dart(&self, record: &str, force: bool) -> Result<Value>;
    fn app_state_get(&self, account: &str, key: &str) -> Result<Option<Value>>;
    /// Writing JSON `null` deletes the entry.
    fn app_state_put(&self, account: &str, key: &str, value: &Value) -> Result<()>;
    fn saved_computers(&self, account: &str) -> Result<Option<Value>>;
    fn put_saved_computers(&self, account: &str, record: &Value, force: bool) -> Result<Value>;
    /// Saves without replacing the stored legacy-key fields, which only the
    /// legacy key cleanup changes once a record exists.
    fn put_saved_computers_keeping_credential(
        &self,
        account: &str,
        record: &Value,
    ) -> Result<Value>;
    fn import_saved_computers_dart(&self, account: &str, raw: &str, force: bool) -> Result<Value>;
    /// A computer's chat drafts record (P5b; the Orchestrator's since P9).
    fn chat_drafts(
        &self,
        account: &str,
        computer: &str,
        kind: DraftsRecord,
    ) -> Result<Option<Value>>;
    /// Replaces it; JSON `null` deletes it.
    fn put_chat_drafts(
        &self,
        account: &str,
        computer: &str,
        kind: DraftsRecord,
        record: &Value,
    ) -> Result<()>;
    /// A computer's Home record (P8): `"drafts"` or `"choices"`.
    fn home(&self, account: &str, computer: &str, kind: HomeRecord) -> Result<Option<Value>>;
    /// Replaces it; JSON `null` deletes it.
    fn put_home(
        &self,
        account: &str,
        computer: &str,
        kind: HomeRecord,
        record: &Value,
    ) -> Result<()>;
}

/// A computer's two chat drafts records: its chats' (P5b) and its
/// Orchestrator chat's, which the app-advisor surface keeps apart (P9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftsRecord {
    Chat,
    Orchestrator,
}

/// Home's two records per account and computer (P8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomeRecord {
    /// The composer drafts of each navigation context.
    Drafts,
    /// The launcher choices of each navigation context.
    Choices,
}

// ---- Relay and sessions ----

/// Relay lifecycle notices, delivered in order.
pub enum Notice {
    Opened(Vec<Value>),
    Peers(Vec<Value>),
    Closed(String),
}
pub type Notify = Arc<dyn Fn(Notice) + Send + Sync>;

/// Opens the account relay socket.
pub trait RelayConnector: Send + Sync {
    /// `token` is `{token, relayUrl}` from [`AuthPort::relay_token`].
    fn open<'a>(
        &'a self,
        token: &'a Value,
        seed: [u8; 32],
        name: &'a str,
        platform: &'a str,
        notify: Notify,
    ) -> BoxFuture<'a, Result<Arc<dyn RelayPort>>>;
}

/// One open account relay socket. Dropping the last handle closes it.
pub trait RelayPort: Send + Sync {
    fn alive(&self) -> bool;
    /// Marks the socket as opened and reports it with its peers, unless it
    /// already ended. Every announced relay later reports `Closed`.
    fn announce(&self) -> bool;
    fn peers(&self) -> Vec<Value>;
    fn peer(&self, id: &str) -> Option<Value>;
    /// A session over this relay's channel for `peer` (one per computer).
    fn open_session(
        &self,
        peer: &str,
        public: &str,
        seed: [u8; 32],
        emit: Emit,
    ) -> Result<Box<dyn PeerSession>>;
    fn close(&self, reason: &str);
    /// Whether the socket still reaches the relay; closes it when not.
    fn probe(&self, limit: Duration) -> BoxFuture<'_, bool>;
}

/// Why a session ended: a stable code and the Dart transport's reason.
#[derive(Debug, Clone)]
pub struct SessionEnd {
    pub code: &'static str,
    pub reason: String,
}

/// One computer's session while it connects; [`PeerSession::run`] turns it
/// into the connected-session actor.
pub trait PeerSession: Send {
    fn set_visible(&mut self, visible: bool);
    /// Marks the session ended without sending `close`.
    fn fail(&mut self, code: &'static str, reason: &str);
    /// Runs a handshake for `purpose` and returns the pairing code.
    fn establish<'a>(&'a mut self, purpose: &'a str) -> BoxFuture<'a, Result<String>>;
    /// One request awaited inline, used while connecting.
    fn call<'a>(
        &'a mut self,
        method: &'a str,
        params: Value,
        limit: Duration,
    ) -> BoxFuture<'a, Result<Value>>;
    /// Sends `close` when the secure channel is still usable, bounded.
    fn close(&mut self) -> BoxFuture<'_, ()>;
    /// The connected-session actor. Emits `closed` exactly once.
    fn run(
        self: Box<Self>,
        version: u64,
        commands: mpsc::UnboundedReceiver<Command>,
    ) -> BoxFuture<'static, SessionEnd>;
}

/// Completes one call from the session actor, so results leave the core in
/// the order the session settles them (Dart completes replies in wire
/// order). Dropped unanswered, it fails the call as an ended session.
pub struct Responder(Option<Box<dyn FnOnce(Result<Value>) + Send>>);
impl Responder {
    pub fn new(f: impl FnOnce(Result<Value>) + Send + 'static) -> Self {
        Self(Some(Box::new(f)))
    }
    pub fn send(mut self, result: Result<Value>) {
        if let Some(f) = self.0.take() {
            f(result);
        }
    }
    /// Drops it without answering (the caller answers instead).
    pub fn cancel(mut self) {
        self.0 = None;
    }
}
impl Drop for Responder {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f(Err(rpc::ended("session_ended")));
        }
    }
}

pub enum Command {
    Request {
        method: String,
        params: Value,
        timeout: Duration,
        reply: Responder,
    },
    HostInfo {
        reply: Responder,
    },
    Visible(bool),
    /// Ends the session. `polite` sends `close` first, as Dart's
    /// `DesktopSession.close`; otherwise the session ends as when Dart drops
    /// the relay socket under it.
    Close {
        code: &'static str,
        polite: bool,
    },
}

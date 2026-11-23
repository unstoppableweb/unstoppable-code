//! The `cc-app` ports over this crate's auth, store, relay and sessions.
use crate::{
    auth::Auth,
    error::Result,
    relay::Relay,
    session::{self, Session},
    store::{Store, identity::Identity},
};
use cc_app::ports::{
    AuthPort, AuthSession, BoxFuture, Command, DeviceIdentity, DraftsRecord, Emit, HomeRecord,
    Notify, PeerSession, RelayConnector, RelayPort, SessionEnd, SignInStep, StorePort,
};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::mpsc;

/// Hosted auth bound to the store that holds its session.
pub(crate) struct HostedAuth {
    pub(crate) auth: Auth,
    pub(crate) store: Arc<Store>,
}

impl AuthPort for HostedAuth {
    fn status(&self) -> Result<Value> {
        self.auth.status(&self.store)
    }
    fn restore(&self) -> BoxFuture<'_, Result<AuthSession>> {
        Box::pin(self.auth.restore(&self.store))
    }
    fn ensure_valid(&self) -> BoxFuture<'_, Result<AuthSession>> {
        Box::pin(self.auth.ensure_valid(&self.store))
    }
    fn revalidate_after_auth_failure(&self) -> BoxFuture<'_, Result<AuthSession>> {
        Box::pin(self.auth.revalidate_after_auth_failure(&self.store))
    }
    fn adopt<'a>(
        &'a self,
        token: &'a str,
        proof: Option<&'a str>,
    ) -> BoxFuture<'a, Result<AuthSession>> {
        Box::pin(self.auth.adopt(&self.store, token, proof))
    }
    fn adopt_app_session(
        &self,
        token: &str,
        proof: Option<&str>,
        account_id: &str,
    ) -> Result<AuthSession> {
        self.auth
            .adopt_app_session(&self.store, token, proof, account_id)
    }
    fn app_owned(&self) -> bool {
        self.auth.app_owned(&self.store)
    }
    fn forget(&self) -> Result<()> {
        self.auth.forget(&self.store)
    }
    fn forget_if_token(&self, token: &str) -> Result<bool> {
        self.auth.forget_if_token(&self.store, token)
    }
    fn sign_out(&self) -> BoxFuture<'_, Result<()>> {
        Box::pin(self.auth.sign_out(&self.store))
    }
    fn cancel_sign_in(&self) {
        self.auth.cancel_sign_in();
    }
    fn begin_oauth(&self, provider: &str, callback_url: &str) -> Result<Value> {
        self.auth.begin_oauth(provider, callback_url)
    }
    fn oauth_callback<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<SignInStep>> {
        Box::pin(self.auth.oauth_callback(&self.store, url))
    }
    fn apple_begin(&self) -> Value {
        self.auth.apple_begin()
    }
    fn apple_complete<'a>(
        &'a self,
        identity_token: &'a str,
        name: Option<&'a str>,
    ) -> BoxFuture<'a, Result<SignInStep>> {
        Box::pin(self.auth.apple_complete(&self.store, identity_token, name))
    }
    fn two_factor<'a>(
        &'a self,
        challenge: &'a str,
        code: &'a str,
    ) -> BoxFuture<'a, Result<SignInStep>> {
        Box::pin(self.auth.two_factor(&self.store, challenge, code))
    }
    fn email_sign_in<'a>(
        &'a self,
        email: &'a str,
        password: &'a str,
    ) -> BoxFuture<'a, Result<SignInStep>> {
        Box::pin(self.auth.email_sign_in(&self.store, email, password))
    }
    fn email_action<'a>(
        &'a self,
        action: &'a str,
        body: &'a Value,
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(self.auth.email_action(&self.store, action, body))
    }
    fn relay_token<'a>(&'a self, device_id: &'a str) -> BoxFuture<'a, Result<Value>> {
        Box::pin(self.auth.relay_token(&self.store, device_id))
    }
    fn http_request<'a>(&'a self, request: &'a Value) -> BoxFuture<'a, Result<Value>> {
        Box::pin(self.auth.http_request(&self.store, request))
    }
    fn cleanup_legacy_key<'a>(&'a self, account: &'a str) -> BoxFuture<'a, Result<Value>> {
        Box::pin(self.auth.cleanup_legacy_key(&self.store, account))
    }
}

fn device(identity: Identity) -> DeviceIdentity {
    DeviceIdentity {
        seed: identity.seed(),
        device_id: identity.device_id,
        public_key: identity.public_key,
    }
}

impl StorePort for Store {
    fn identity(&self) -> Result<DeviceIdentity> {
        Store::identity(self).map(device)
    }
    fn existing_identity(&self) -> Result<Option<DeviceIdentity>> {
        Store::existing_identity(self).map(|i| i.map(device))
    }
    fn pins(&self) -> Result<BTreeMap<String, String>> {
        Store::pins(self)
    }
    fn pin(&self, peer: &str) -> Result<Option<String>> {
        Store::pin(self, peer)
    }
    fn remember_pin(&self, peer: &str, key: &str) -> Result<()> {
        Store::remember_pin(self, peer, key)
    }
    fn forget_pin(&self, peer: &str) -> Result<()> {
        Store::forget_pin(self, peer)
    }
    fn identity_import(&self, seed: &str, pins: &Value, force: bool) -> Result<Value> {
        Store::identity_import(self, seed, pins, force)
    }
    fn identity_import_dart(&self, record: &str, force: bool) -> Result<Value> {
        Store::identity_import_dart(self, record, force)
    }
    fn app_state_get(&self, account: &str, key: &str) -> Result<Option<Value>> {
        Store::app_state_get(self, account, key)
    }
    fn app_state_put(&self, account: &str, key: &str, value: &Value) -> Result<()> {
        Store::app_state_put(self, account, key, value)
    }
    fn saved_computers(&self, account: &str) -> Result<Option<Value>> {
        Store::saved_computers(self, account)
    }
    fn put_saved_computers(&self, account: &str, record: &Value, force: bool) -> Result<Value> {
        Store::put_saved_computers(self, account, record, force)
    }
    fn put_saved_computers_keeping_credential(
        &self,
        account: &str,
        record: &Value,
    ) -> Result<Value> {
        Store::put_saved_computers_keeping_credential(self, account, record)
    }
    fn import_saved_computers_dart(&self, account: &str, raw: &str, force: bool) -> Result<Value> {
        Store::import_saved_computers_dart(self, account, raw, force)
    }
    fn chat_drafts(
        &self,
        account: &str,
        computer: &str,
        kind: DraftsRecord,
    ) -> Result<Option<Value>> {
        Store::drafts(self, account, computer, kind)
    }
    fn put_chat_drafts(
        &self,
        account: &str,
        computer: &str,
        kind: DraftsRecord,
        record: &Value,
    ) -> Result<()> {
        Store::put_drafts(self, account, computer, kind, record)
    }
    fn home(&self, account: &str, computer: &str, kind: HomeRecord) -> Result<Option<Value>> {
        Store::home(self, account, computer, kind)
    }
    fn put_home(
        &self,
        account: &str,
        computer: &str,
        kind: HomeRecord,
        record: &Value,
    ) -> Result<()> {
        Store::put_home(self, account, computer, kind, record)
    }
}

/// Opens relay v2 WebSockets.
pub(crate) struct WebSocketRelays;

impl RelayConnector for WebSocketRelays {
    fn open<'a>(
        &'a self,
        token: &'a Value,
        seed: [u8; 32],
        name: &'a str,
        platform: &'a str,
        notify: Notify,
    ) -> BoxFuture<'a, Result<Arc<dyn RelayPort>>> {
        Box::pin(async move {
            let relay: Arc<dyn RelayPort> =
                Arc::new(Relay::open(token, seed, name, platform, notify).await?);
            Ok(relay)
        })
    }
}

impl RelayPort for Relay {
    fn alive(&self) -> bool {
        Relay::alive(self)
    }
    fn announce(&self) -> bool {
        Relay::announce(self)
    }
    fn peers(&self) -> Vec<Value> {
        Relay::peers(self)
    }
    fn peer(&self, id: &str) -> Option<Value> {
        Relay::peer(self, id)
    }
    fn open_session(
        &self,
        peer: &str,
        public: &str,
        seed: [u8; 32],
        emit: Emit,
    ) -> Result<Box<dyn PeerSession>> {
        Ok(Box::new(Session::new(
            self.channel(peer)?,
            peer,
            public,
            seed,
            emit,
        )))
    }
    fn close(&self, reason: &str) {
        Relay::close(self, reason);
    }
    fn probe(&self, limit: Duration) -> BoxFuture<'_, bool> {
        Box::pin(Relay::probe(self, limit))
    }
}

impl PeerSession for Session {
    fn set_visible(&mut self, visible: bool) {
        Session::set_visible(self, visible);
    }
    fn fail(&mut self, code: &'static str, reason: &str) {
        Session::fail(self, code, reason);
    }
    fn establish<'a>(&'a mut self, purpose: &'a str) -> BoxFuture<'a, Result<String>> {
        Box::pin(Session::establish(self, purpose))
    }
    fn call<'a>(
        &'a mut self,
        method: &'a str,
        params: Value,
        limit: Duration,
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(Session::call(self, method, params, limit))
    }
    fn close(&mut self) -> BoxFuture<'_, ()> {
        Box::pin(Session::close(self))
    }
    fn run(
        self: Box<Self>,
        version: u64,
        commands: mpsc::UnboundedReceiver<Command>,
    ) -> BoxFuture<'static, SessionEnd> {
        Box::pin(async move { session::run(*self, version, commands).await.0 })
    }
}

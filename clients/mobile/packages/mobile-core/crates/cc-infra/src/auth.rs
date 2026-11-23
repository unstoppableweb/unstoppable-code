//! Hosted sign-in, session validation and authenticated HTTP with the Dart
//! wire and failure semantics (`lib/data/services/{auth_api_service,
//! email_auth_api_service,api_client}.dart`,
//! `lib/data/repositories/auth_repository.dart`,
//! `lib/device_link/desktop/relay.dart`, `lib/app/computer_connect_access.dart`).
//!
//! `Auth` is `Send + Sync`; every method takes `&self` so concurrent tasks can
//! share it. No lock is held across an await except the validation
//! single-flight, which only serializes session validations.
use crate::{
    error::{Error, Kind, Result, field},
    http::{self, Call, Credentials, Http, Profile, RawResponse, local, malformed},
    store::Store,
};
use cc_app::ports::{AuthSession as Session, SignInStep, SignedIn};
use reqwest::Method;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    sync::{Mutex, MutexGuard, RwLock},
    time::Duration,
};
use url::Url;
use zeroize::Zeroizing;

/// Dart `HttpAuthRepository.validationTimeout`, per get-session attempt.
pub(crate) const VALIDATION_TIMEOUT: Duration = Duration::from_secs(30);
/// Dart email POST and availability timeouts.
pub(crate) const EMAIL_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const EMAIL_AVAILABLE_TIMEOUT: Duration = Duration::from_secs(10);
/// `fetchMobileRelayToken`: send and per-chunk read deadlines, body cap.
pub(crate) const RELAY_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const RELAY_BODY_LIMIT: usize = 16 * 1024;
/// `ComputerConnectAccess.revokeLegacyKey`.
pub(crate) const LEGACY_REVOKE_TIMEOUT: Duration = Duration::from_secs(20);
/// Dart awaits sign-out revocation without a deadline; local credentials are
/// cleared only afterwards. Bounded here so an unreachable server cannot hold
/// sign-out open; the outcome (credentials cleared) is the same.
pub(crate) const SIGN_OUT_TIMEOUT: Duration = Duration::from_secs(30);
/// Response cap for `ApiClient`-equivalent calls (Dart has none).
pub(crate) const API_BODY_LIMIT: usize = 16 * 1024 * 1024;

pub(crate) fn secure_url(raw: &str, websocket: bool) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| Error::new("invalid_origin"))?;
    let secure = if websocket { "wss" } else { "https" };
    let local = if websocket { "ws" } else { "http" };
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == secure
            || (url.scheme() == local
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
    {
        return Err(Error::new("invalid_origin"));
    }
    Ok(url)
}

/// Dart `Uri.encodeComponent`: keeps `A-Za-z0-9-_.!~*'()`.
pub(crate) fn encode_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn pkce_challenge(verifier: &str) -> String {
    cc_protocol::secure::encode(&Sha256::digest(verifier.as_bytes()))
}
fn random_verifier() -> Zeroizing<String> {
    Zeroizing::new(cc_protocol::secure::encode(&cc_protocol::secure::random::<
        32,
    >()))
}
fn token_hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}
fn non_empty(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}
fn with_message(mut e: Error, message: &str) -> Error {
    e.message = Some(message.into());
    e
}

/// `AuthUser.fromJson` type checks: `id` a non-empty string; the optional
/// fields, when present and non-null, of the declared type.
pub(crate) fn valid_user(user: &Value) -> bool {
    let Some(map) = user.as_object() else {
        return false;
    };
    let typed =
        |key: &str, ok: fn(&Value) -> bool| map.get(key).is_none_or(|v| v.is_null() || ok(v));
    non_empty(&user["id"]).is_some()
        && [
            "email",
            "name",
            "image",
            "role",
            "status",
            "createdAt",
            "updatedAt",
        ]
        .iter()
        .all(|k| typed(k, Value::is_string))
        && ["emailVerified", "twoFactorEnabled", "isAnonymous"]
            .iter()
            .all(|k| typed(k, Value::is_boolean))
}

struct Pending {
    generation: u64,
    verifier: Zeroizing<String>,
    callback: Option<Url>,
    apple_nonce: Option<Zeroizing<String>>,
}

struct Validated {
    user: Value,
    token: [u8; 32],
    /// Adopted from the app with its account id: the app owns validation.
    app_owned: bool,
}

#[derive(Default)]
struct State {
    /// Bumped by every sign-in start, cancel, adopt and sign-out. A sign-in
    /// whose generation is stale never persists its exchange.
    generation: u64,
    /// Bumped by every session write; a validation that observes a change
    /// is inconclusive.
    epoch: u64,
    pending: Option<Pending>,
    /// The process cache of the last validated user and its token.
    validated: Option<Validated>,
    /// The app's session from [`Auth::adopt_app_session`], used instead of
    /// the stored one. Memory only: the app adopts it again before relay
    /// work, so it ends with the core (a runtime switch closes the core) and
    /// no app sign-out has to reach the store to remove it.
    app: Option<AppSession>,
}

struct AppSession {
    token: Zeroizing<String>,
    proof: Option<Zeroizing<String>>,
}

pub(crate) struct Auth {
    pub origin: Url,
    http: Http,
    client_version: RwLock<Option<String>>,
    state: Mutex<State>,
    validating: tokio::sync::Mutex<()>,
}

impl Auth {
    pub(crate) fn new(origin: &str) -> Result<Self> {
        let origin = secure_url(origin, false)?;
        if origin.path() != "/" {
            return Err(Error::new("invalid_origin"));
        }
        Ok(Self {
            origin,
            http: Http::new()?,
            client_version: RwLock::new(None),
            state: Mutex::default(),
            validating: tokio::sync::Mutex::new(()),
        })
    }
    /// `x-canopy-client-version` source (the app version). A value outside
    /// `^[0-9A-Za-z.+-]{1,32}$` is dropped, as Dart drops it.
    pub(crate) fn with_client_version(origin: &str, version: Option<&str>) -> Result<Self> {
        let auth = Self::new(origin)?;
        auth.set_client_version(version);
        Ok(auth)
    }
    pub(crate) fn set_user_agent(&self, agent: Option<&str>) {
        self.http.set_user_agent(agent);
    }
    pub(crate) fn set_client_version(&self, version: Option<&str>) {
        let version = version
            .filter(|v| http::valid_client_version(v))
            .map(String::from);
        *self
            .client_version
            .write()
            .unwrap_or_else(|e| e.into_inner()) = version;
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// The session requests carry: the app's adopted one while held, else
    /// the stored one.
    fn credentials(&self, store: &Store) -> Result<Credentials> {
        Self::credentials_in(&self.state(), store)
    }
    /// The credentials in use, only while they are `account`'s validated
    /// session.
    fn credentials_of(&self, store: &Store, account: &str) -> Result<Option<Credentials>> {
        let state = self.state();
        let credentials = Self::credentials_in(&state, store)?;
        Ok(match (&state.validated, &credentials.token) {
            (Some(v), Some(token))
                if v.token == token_hash(token) && v.user["id"].as_str() == Some(account) =>
            {
                Some(credentials)
            }
            _ => None,
        })
    }
    fn credentials_in(state: &State, store: &Store) -> Result<Credentials> {
        if let Some(app) = &state.app {
            return Ok(Credentials {
                token: Some(app.token.to_string()),
                proof: app.proof.as_ref().map(|p| p.to_string()),
            });
        }
        Ok(match store.session()? {
            Some(s) => Credentials {
                token: non_empty(&s["token"]).map(String::from),
                proof: non_empty(&s["twoFactorProof"]).map(String::from),
            },
            None => Credentials::default(),
        })
    }
    async fn send(&self, call: Call<'_>, credentials: &Credentials) -> Result<RawResponse> {
        let version = self
            .client_version
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        self.http
            .send(&self.origin, call, credentials, version.as_deref())
            .await
    }
    /// A JSON call through the app `ApiClient` profile: the stored bearer and
    /// proof are attached whenever present (this is what merges a guest into
    /// the signing-in account), non-2xx fails with status, code, message and
    /// Retry-After, and 2xx decodes like `ApiClient._decode`.
    async fn api(
        &self,
        store: &Store,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Option<Duration>,
    ) -> Result<Value> {
        let credentials = self.credentials(store)?;
        let response = self
            .send(
                Call {
                    method,
                    path,
                    body,
                    profile: Profile::App,
                    timeout,
                    chunk_timeout: None,
                    limit: API_BODY_LIMIT,
                },
                &credentials,
            )
            .await?;
        if !response.ok() {
            return Err(response.failure());
        }
        response.decode_object()
    }

    // ---- Session validation ----

    /// Dart `restoreSession`/`_validate`: no token -> signed out without a
    /// request. A 401 or JSON `null` is confirmed once more; two in a row
    /// clear the session. A 2FA user without a stored proof is cleared. Any
    /// other failure (network, timeout, 5xx, other 4xx, malformed body) keeps
    /// the credentials and fails, so the host can offer Retry.
    pub(crate) async fn restore(&self, store: &Store) -> Result<Session> {
        let _single = self.validating.lock().await;
        self.validate_locked(store).await
    }

    /// The process-cached session when the stored token is the one this
    /// process validated; otherwise [`Auth::restore`]. Use before relay or
    /// connect work so a successful validation is not repeated per call.
    pub(crate) async fn ensure_valid(&self, store: &Store) -> Result<Session> {
        if let Some(session) = self.cached(store)? {
            return Ok(session);
        }
        let _single = self.validating.lock().await;
        // Another task may have validated while this one waited.
        if let Some(session) = self.cached(store)? {
            return Ok(session);
        }
        self.validate_locked(store).await
    }

    fn cached(&self, store: &Store) -> Result<Option<Session>> {
        let token = self.credentials(store)?.token;
        let state = self.state();
        Ok(match (&state.validated, token) {
            (Some(v), Some(token)) if v.token == token_hash(&token) => {
                let user = v.user.clone();
                let id = user["id"].as_str().map(String::from);
                Some(Session::SignedIn(SignedIn::new(user, id)))
            }
            _ => None,
        })
    }

    /// `{status: signedIn|unverified|signedOut, user?, hasAccount}` without
    /// any network request. `unverified` means credentials are stored but
    /// this process has not validated them (or validation failed).
    pub(crate) fn status(&self, store: &Store) -> Result<Value> {
        if let Some(Session::SignedIn(s)) = self.cached(store)? {
            return Ok(s.to_json());
        }
        Ok(match self.credentials(store)?.token {
            None => json!({"status": "signedOut", "hasAccount": false}),
            Some(_) => {
                json!({"status": "unverified", "hasAccount": false, "lastUser": store.user()?})
            }
        })
    }

    /// `revalidateSessionAfterAuthenticationFailure`: after a resource-level
    /// 401/403 (for example the relay token), one authoritative check. An
    /// invalid session is signed out (server call plus local clear); a
    /// transient failure keeps the session and returns the error. A sign-in,
    /// adopt or sign-out started meanwhile supersedes the sign-out (Dart
    /// `_isCurrent(generation)`).
    pub(crate) async fn revalidate_after_auth_failure(&self, store: &Store) -> Result<Session> {
        let generation = self.state().generation;
        let session = self.restore(store).await?;
        if let Session::SignedOut = session {
            self.sign_out_from(store, Some(generation)).await?;
        }
        Ok(session)
    }

    async fn validate_locked(&self, store: &Store) -> Result<Session> {
        let credentials = self.credentials(store)?;
        let Some(token) = credentials.token.clone() else {
            self.state().validated = None;
            return Ok(Session::SignedOut);
        };
        let epoch = self.state().epoch;
        let mut user = None;
        for attempt in 0..2 {
            let response = self
                .send(
                    Call {
                        method: Method::GET,
                        path: "/api/auth/get-session",
                        body: None,
                        profile: Profile::App,
                        timeout: Some(VALIDATION_TIMEOUT),
                        chunk_timeout: None,
                        limit: API_BODY_LIMIT,
                    },
                    &credentials,
                )
                .await?;
            if self.state().epoch != epoch {
                return Err(Error::new("session_superseded"));
            }
            if response.status != 401 {
                if !response.ok() {
                    return Err(response.failure());
                }
                // `getNullableJson`: only JSON null means absence.
                let body: Value = serde_json::from_slice(&response.body)
                    .map_err(|_| local("malformed_response"))?;
                if !body.is_null() {
                    if !body.is_object() || !valid_user(&body["user"]) {
                        return Err(local("malformed_response"));
                    }
                    user = Some(body["user"].clone());
                    break;
                }
            }
            // One edge or proxy anomaly must not erase the only copy of the
            // bearer: confirm once before clearing.
            if attempt == 0 {
                continue;
            }
        }
        let Some(user) = user else {
            self.clear_if_current(store, epoch)?;
            return Ok(Session::SignedOut);
        };
        if user["twoFactorEnabled"] == true && credentials.proof.is_none() {
            self.clear_if_current(store, epoch)?;
            return Ok(Session::SignedOut);
        }
        let mut state = self.state();
        if state.epoch != epoch {
            return Err(Error::new("session_superseded"));
        }
        let previous = store
            .user()?
            .and_then(|u| u["id"].as_str().map(String::from));
        store.put_user(&user)?;
        state.validated = Some(Validated {
            user: user.clone(),
            token: token_hash(&token),
            app_owned: false,
        });
        Ok(Session::SignedIn(SignedIn::new(user, previous)))
    }

    fn clear_if_current(&self, store: &Store, epoch: u64) -> Result<()> {
        let mut state = self.state();
        if state.epoch != epoch {
            return Err(Error::new("session_superseded"));
        }
        state.epoch += 1;
        state.validated = None;
        state.app = None;
        store.clear_session()
    }

    // ---- Session writes ----

    /// Adopts a session the normal app's sign-in produced (`auth.adopt`):
    /// stores it, supersedes any sign-in in progress, then validates it with
    /// the restore rules (an invalid token is cleared). The token never
    /// leaves Rust afterwards.
    pub(crate) async fn adopt(
        &self,
        store: &Store,
        token: &str,
        proof: Option<&str>,
    ) -> Result<Session> {
        if token.is_empty() || token.len() > 16 * 1024 {
            return Err(Error::new("invalid_input"));
        }
        {
            let mut state = self.state();
            state.generation += 1;
            state.pending = None;
            state.epoch += 1;
            state.validated = None;
            state.app = None;
            store.put_session(token, proof)?;
        }
        self.restore(store).await
    }

    /// Adopts the app's session for `account_id` without a request. The
    /// app's own auth repository validated it, as Dart's Computer Connect
    /// trusts the session the app hands it (`ComputerConnectAccess`): the
    /// core neither re-validates it nor checks it again after a relay-token
    /// 401/403, and the relay-token route decides account eligibility.
    ///
    /// The token and proof stay in memory and replace any stored session;
    /// only the account id is stored, to detect an account change.
    pub(crate) fn adopt_app_session(
        &self,
        store: &Store,
        token: &str,
        proof: Option<&str>,
        account_id: &str,
    ) -> Result<Session> {
        if token.is_empty() || token.len() > 16 * 1024 || account_id.is_empty() {
            return Err(Error::new("invalid_input"));
        }
        let mut state = self.state();
        state.generation += 1;
        state.pending = None;
        state.epoch += 1;
        let previous = store
            .user()?
            .and_then(|u| u["id"].as_str().map(String::from));
        let user = json!({ "id": account_id });
        store.clear_session()?;
        store.put_user(&user)?;
        state.app = Some(AppSession {
            token: Zeroizing::new(token.into()),
            proof: proof
                .filter(|p| !p.is_empty())
                .map(|p| Zeroizing::new(p.into())),
        });
        state.validated = Some(Validated {
            user: user.clone(),
            token: token_hash(token),
            app_owned: true,
        });
        Ok(Session::SignedIn(SignedIn::new(user, previous)))
    }
    /// Whether the session in use is one the app owns (see
    /// [`Auth::adopt_app_session`]).
    pub(crate) fn app_owned(&self, store: &Store) -> bool {
        let token = self.credentials(store).ok().and_then(|c| c.token);
        let state = self.state();
        matches!((&state.validated, token), (Some(v), Some(t)) if v.app_owned && v.token == token_hash(&t))
    }
    /// Drops the local session without a request (the app signed out or its
    /// account scope ended). Identity, pins and app state are kept.
    pub(crate) fn forget_if_token(&self, store: &Store, token: &str) -> Result<bool> {
        let mut state = self.state();
        if Self::credentials_in(&state, store)?.token.as_deref() != Some(token) {
            return Ok(false);
        }
        state.generation += 1;
        state.epoch += 1;
        state.pending = None;
        state.validated = None;
        state.app = None;
        store.clear_session()?;
        Ok(true)
    }

    pub(crate) fn forget(&self, store: &Store) -> Result<()> {
        let mut state = self.state();
        state.generation += 1;
        state.epoch += 1;
        state.pending = None;
        state.validated = None;
        state.app = None;
        store.clear_session()
    }

    /// Dart `signOut`: supersede sign-ins, attempt `POST /api/auth/sign-out`
    /// (no body; bearer only when held), ignore its outcome, then always
    /// clear the local session. Identity, pins, saved computers and app
    /// state are kept. A session adopted or stored while the request is in
    /// flight supersedes this sign-out and is kept.
    pub(crate) async fn sign_out(&self, store: &Store) -> Result<()> {
        self.sign_out_from(store, None).await
    }
    /// [`Auth::sign_out`], skipped when `generation` is given and no longer
    /// current.
    async fn sign_out_from(&self, store: &Store, generation: Option<u64>) -> Result<()> {
        let (epoch, credentials) = {
            let mut state = self.state();
            if generation.is_some_and(|g| g != state.generation) {
                return Ok(());
            }
            state.generation += 1;
            state.epoch += 1;
            state.pending = None;
            state.validated = None;
            let credentials = Self::credentials_in(&state, store).unwrap_or_default();
            (state.epoch, credentials)
        };
        let _ = self
            .send(
                Call {
                    method: Method::POST,
                    path: "/api/auth/sign-out",
                    body: None,
                    profile: Profile::App,
                    timeout: Some(SIGN_OUT_TIMEOUT),
                    chunk_timeout: None,
                    limit: API_BODY_LIMIT,
                },
                &credentials,
            )
            .await;
        match self.clear_if_current(store, epoch) {
            Err(e) if e.code == "session_superseded" => Ok(()),
            result => result,
        }
    }

    /// Exchange, fence, persist (before validation, so a transient
    /// get-session failure never re-consumes the code), validate.
    async fn exchange_and_persist(
        &self,
        store: &Store,
        code: &str,
        verifier: &str,
        generation: u64,
    ) -> Result<SignedIn> {
        if self.state().generation != generation {
            return Err(Error::new("sign_in_superseded"));
        }
        let body = json!({"code": code, "code_verifier": verifier});
        let result = self
            .api(
                store,
                Method::POST,
                "/api/mobile/oauth-token",
                Some(&body),
                None,
            )
            .await?;
        let token = non_empty(&result["token"]).ok_or_else(malformed)?;
        let proof = non_empty(&result["twoFactorProof"]);
        {
            let mut state = self.state();
            if state.generation != generation {
                return Err(Error::new("sign_in_superseded"));
            }
            state.epoch += 1;
            state.validated = None;
            state.app = None;
            store.put_session(token, proof)?;
        }
        match self.restore(store).await? {
            Session::SignedIn(s) => Ok(s),
            Session::SignedOut => Err(Error::new("sign_in_incomplete")),
        }
    }

    // ---- Sign-in flows ----

    fn start(
        &self,
        callback: Option<Url>,
        apple_nonce: Option<Zeroizing<String>>,
    ) -> (u64, Zeroizing<String>) {
        let verifier = random_verifier();
        let mut state = self.state();
        state.generation += 1;
        state.pending = Some(Pending {
            generation: state.generation,
            verifier: verifier.clone(),
            callback,
            apple_nonce,
        });
        (state.generation, verifier)
    }
    /// Drops any pending verifier, challenge or nonce and supersedes an
    /// in-flight exchange (Dart `cancelEmailSignIn`, 2FA cancel, a cancelled
    /// browser or Apple sheet).
    pub(crate) fn cancel_sign_in(&self) {
        let mut state = self.state();
        state.generation += 1;
        state.pending = None;
    }
    fn take_pending(&self) -> Result<Pending> {
        self.state()
            .pending
            .take()
            .ok_or_else(|| Error::new("auth_not_started"))
    }
    fn restore_pending(&self, pending: Pending) {
        let mut state = self.state();
        if state.generation == pending.generation && state.pending.is_none() {
            state.pending = Some(pending);
        }
    }

    /// Starts a browser sign-in. Does not touch the current session or its
    /// connections. Returns `{authorizeUrl, callbackUrl}`; the URL matches
    /// Dart's `_oauthStartUrl` byte for byte.
    pub(crate) fn begin_oauth(&self, provider: &str, callback_url: &str) -> Result<Value> {
        // Apple uses only the native sheet in Dart.
        if !matches!(provider, "google" | "github" | "unstoppable-domains") {
            return Err(Error::new("invalid_provider"));
        }
        let callback = Url::parse(callback_url).map_err(|_| Error::new("invalid_callback"))?;
        let (_, verifier) = self.start(Some(callback), None);
        let url = format!(
            "{}/api/mobile/oauth-start?provider={provider}&redirect={}&code_challenge={}",
            self.origin.as_str().trim_end_matches('/'),
            encode_component(callback_url),
            pkce_challenge(&verifier),
        );
        Ok(json!({"authorizeUrl": url, "callbackUrl": callback_url}))
    }

    /// Completes a browser sign-in from the intercepted callback URL.
    /// - `error=access_denied` -> [`SignInStep::Cancelled`] (silent).
    /// - `error=two_factor_required` with a non-empty `challenge` ->
    ///   [`SignInStep::TwoFactor`]; without one -> error `two_factor_required`.
    /// - any other `error=` -> error whose code is that value
    ///   (`provider_unavailable`, `invalid_flow`, `no_session`, ...; values
    ///   outside `[a-z0-9_]{1,64}` become `oauth_error`).
    /// - missing or empty `code` -> error `sign_in_incomplete`.
    /// - exchange failures keep their HTTP status for the 401/403 mapping.
    pub(crate) async fn oauth_callback(&self, store: &Store, url: &str) -> Result<SignInStep> {
        let received = Url::parse(url).map_err(|_| Error::new("invalid_callback"))?;
        let pending = self.take_pending()?;
        let Some(expected) = pending.callback.clone() else {
            self.restore_pending(pending);
            return Err(Error::new("auth_not_started"));
        };
        let strip = |mut u: Url| {
            u.set_query(None);
            u.set_fragment(None);
            u
        };
        if strip(received.clone()) != strip(expected) {
            self.restore_pending(pending);
            return Err(Error::new("invalid_callback"));
        }
        // Dart `queryParameters`: the last value of a repeated key wins.
        let mut params = std::collections::HashMap::new();
        for (k, v) in received.query_pairs() {
            params.insert(k.into_owned(), v.into_owned());
        }
        if let Some(error) = params.get("error") {
            if error == "access_denied" {
                return Ok(SignInStep::Cancelled);
            }
            if error == "two_factor_required"
                && let Some(challenge) = params.get("challenge").filter(|c| !c.is_empty())
            {
                let challenge = challenge.clone();
                self.restore_pending(Pending {
                    callback: None,
                    ..pending
                });
                return Ok(SignInStep::TwoFactor { challenge });
            }
            let slug = error.len() <= 64
                && !error.is_empty()
                && error
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
            return Err(Error::new(if slug { error } else { "oauth_error" }));
        }
        let code = params
            .get("code")
            .filter(|c| !c.is_empty())
            .ok_or_else(|| Error::new("sign_in_incomplete"))?;
        Ok(SignInStep::SignedIn(
            self.exchange_and_persist(store, code, &pending.verifier, pending.generation)
                .await?,
        ))
    }

    /// Starts native Sign in with Apple: `{nonceHash}` (lowercase hex
    /// SHA-256 of a raw nonce kept in Rust) for the OS sheet.
    pub(crate) fn apple_begin(&self) -> Value {
        let nonce = random_verifier();
        let hash: String = Sha256::digest(nonce.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        self.start(None, Some(nonce));
        json!({"nonceHash": hash})
    }

    /// `POST /api/mobile/oauth-apple-native`. `name` is trimmed and omitted
    /// when empty (Apple sends it only on first consent). A cancelled sheet
    /// is [`Auth::cancel_sign_in`].
    pub(crate) async fn apple_complete(
        &self,
        store: &Store,
        identity_token: &str,
        name: Option<&str>,
    ) -> Result<SignInStep> {
        let pending = self.take_pending()?;
        let Some(nonce) = pending.apple_nonce.as_ref() else {
            self.restore_pending(pending);
            return Err(Error::new("auth_not_started"));
        };
        let mut body = json!({
            "identity_token": identity_token,
            "nonce": nonce.as_str(),
            "code_challenge": pkce_challenge(&pending.verifier),
        });
        if let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) {
            body["name"] = json!(name);
        }
        let result = self
            .api(
                store,
                Method::POST,
                "/api/mobile/oauth-apple-native",
                Some(&body),
                None,
            )
            .await?;
        if let Some(code) = non_empty(&result["code"]) {
            return Ok(SignInStep::SignedIn(
                self.exchange_and_persist(store, code, &pending.verifier, pending.generation)
                    .await?,
            ));
        }
        if result["two_factor_required"] == true
            && let Some(challenge) = non_empty(&result["challenge"])
        {
            let challenge = challenge.to_owned();
            self.restore_pending(Pending {
                apple_nonce: None,
                ..pending
            });
            return Ok(SignInStep::TwoFactor { challenge });
        }
        Err(malformed())
    }

    /// `POST /api/mobile/two-factor/verify` then the exchange. The pending
    /// verifier survives a failed attempt so the user can retry the code.
    pub(crate) async fn two_factor(
        &self,
        store: &Store,
        challenge: &str,
        code: &str,
    ) -> Result<SignInStep> {
        let pending = self.take_pending()?;
        let body = json!({"challenge": challenge, "code": code, "code_verifier": pending.verifier.as_str()});
        let verified = self
            .api(
                store,
                Method::POST,
                "/api/mobile/two-factor/verify",
                Some(&body),
                None,
            )
            .await
            .and_then(|r| {
                non_empty(&r["code"])
                    .map(String::from)
                    .ok_or_else(malformed)
            });
        let exchange_code = match verified {
            Ok(code) => code,
            Err(e) => {
                self.restore_pending(pending);
                return Err(e);
            }
        };
        Ok(SignInStep::SignedIn(
            self.exchange_and_persist(store, &exchange_code, &pending.verifier, pending.generation)
                .await?,
        ))
    }

    // ---- Email ----

    /// `EmailAuthApiService._post` mapping: 404 -> `EMAIL_AUTH_UNAVAILABLE`,
    /// 429 -> `RATE_LIMITED`, else body `code` ?? `error` (identifier-shaped)
    /// ?? `AUTH_UNAVAILABLE`; transport and timeout -> `AUTH_UNAVAILABLE`.
    /// Status, `error` text and Retry-After are kept.
    async fn email_post(&self, store: &Store, path: &str, body: &Value) -> Result<Value> {
        let credentials = self.credentials(store)?;
        let response = self
            .send(
                Call {
                    method: Method::POST,
                    path,
                    body: Some(body),
                    profile: Profile::App,
                    timeout: Some(EMAIL_TIMEOUT),
                    chunk_timeout: None,
                    limit: API_BODY_LIMIT,
                },
                &credentials,
            )
            .await
            .map_err(|e| Error {
                code: "AUTH_UNAVAILABLE".into(),
                ..e
            })?;
        if response.ok() {
            return response.decode_object().map_err(|e| Error {
                code: "AUTH_UNAVAILABLE".into(),
                ..e
            });
        }
        let mut error = response.failure();
        let json: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        let server = [&json["code"], &json["error"]]
            .into_iter()
            .find_map(|v| v.as_str())
            .filter(|s| http::is_code(s));
        error.code = match response.status {
            404 => "EMAIL_AUTH_UNAVAILABLE",
            429 => "RATE_LIMITED",
            _ => server.unwrap_or("AUTH_UNAVAILABLE"),
        }
        .into();
        if response.status != 429 {
            error.retry_after = None;
        }
        Err(error)
    }

    /// `GET /api/mobile/email-auth` (10 s): `enabled == true`; any failure,
    /// including an older server's 404, is `false`.
    pub(crate) async fn email_available(&self, store: &Store) -> bool {
        let Ok(credentials) = self.credentials(store) else {
            return false;
        };
        let response = self
            .send(
                Call {
                    method: Method::GET,
                    path: "/api/mobile/email-auth",
                    body: None,
                    profile: Profile::App,
                    timeout: Some(EMAIL_AVAILABLE_TIMEOUT),
                    chunk_timeout: None,
                    limit: API_BODY_LIMIT,
                },
                &credentials,
            )
            .await;
        matches!(response, Ok(r) if r.ok() && r.decode_object().is_ok_and(|v| v["enabled"] == true))
    }

    /// Email and password sign-in with a fresh PKCE verifier.
    pub(crate) async fn email_sign_in(
        &self,
        store: &Store,
        email: &str,
        password: &str,
    ) -> Result<SignInStep> {
        let (generation, verifier) = self.start(None, None);
        let body = json!({
            "email": email,
            "password": password,
            "code_challenge": pkce_challenge(&verifier),
            "code_challenge_method": "S256",
        });
        let result = self
            .email_post(store, "/api/mobile/email-auth/sign-in", &body)
            .await?;
        if self.state().generation != generation {
            return Err(Error::new("sign_in_superseded"));
        }
        if let Some(code) = non_empty(&result["code"]) {
            self.take_pending()?;
            return Ok(SignInStep::SignedIn(
                self.exchange_and_persist(store, code, &verifier, generation)
                    .await?,
            ));
        }
        if result["two_factor_required"] == true
            && let Some(challenge) = non_empty(&result["challenge"])
        {
            return Ok(SignInStep::TwoFactor {
                challenge: challenge.into(),
            });
        }
        self.cancel_sign_in();
        if result["verification_required"] == true {
            return Ok(SignInStep::VerificationRequired);
        }
        Err(Error::new("AUTH_UNAVAILABLE"))
    }
    pub(crate) async fn email_sign_up(
        &self,
        store: &Store,
        email: &str,
        password: &str,
    ) -> Result<()> {
        let body = json!({"email": email, "password": password, "name": ""});
        self.email_post(store, "/api/auth/sign-up/email", &body)
            .await
            .map(drop)
    }
    pub(crate) async fn email_verify(&self, store: &Store, email: &str, code: &str) -> Result<()> {
        let body = json!({"email": email, "otp": code});
        self.email_post(store, "/api/auth/email-otp/verify-email", &body)
            .await
            .map(drop)
    }
    pub(crate) async fn email_forgot(&self, store: &Store, email: &str) -> Result<()> {
        let body = json!({"email": email});
        self.email_post(store, "/api/auth/email-otp/request-password-reset", &body)
            .await
            .map(drop)
    }
    pub(crate) async fn email_reset(
        &self,
        store: &Store,
        email: &str,
        code: &str,
        password: &str,
    ) -> Result<()> {
        let body = json!({"email": email, "otp": code, "password": password});
        self.email_post(store, "/api/auth/email-otp/reset-password", &body)
            .await
            .map(drop)
    }
    /// `auth.email.request {action, body}`: Dart bodies are built here from
    /// `body.email`, `body.password` and `body.otp` (or `body.code`).
    /// `available` returns `{enabled}`; the others `{}`.
    pub(crate) async fn email_action(
        &self,
        store: &Store,
        action: &str,
        body: &Value,
    ) -> Result<Value> {
        let otp = || field(body, "otp").or_else(|_| field(body, "code"));
        match action {
            "available" => return Ok(json!({"enabled": self.email_available(store).await})),
            "sign_up" => {
                self.email_sign_up(store, field(body, "email")?, field(body, "password")?)
                    .await?
            }
            "verify" => {
                self.email_verify(store, field(body, "email")?, otp()?)
                    .await?
            }
            "forgot" => self.email_forgot(store, field(body, "email")?).await?,
            "reset" => {
                self.email_reset(
                    store,
                    field(body, "email")?,
                    otp()?,
                    field(body, "password")?,
                )
                .await?
            }
            _ => return Err(Error::new("unknown_operation")),
        }
        Ok(json!({}))
    }

    // ---- Relay token ----

    /// `fetchMobileRelayToken`: `POST /api/v1/device-relay/token`
    /// `{deviceId, kind:"mobile"}` with only bearer, proof and Content-Type;
    /// no redirects; 15 s to headers and per body chunk; 16 KiB body cap.
    /// - no session: 401 `unauthorized` without a request.
    /// - 401/403/404: `{status, code}` where code is the body's `code` when
    ///   it matches `^[a-z_]{1,64}$` (so `entitlement_denied` survives), else
    ///   `relay_access_denied`.
    /// - any other non-200 (including other 2xx): `relay_unavailable`.
    /// - bad body, `token` or `relayUrl` (must be `wss` or loopback `ws`,
    ///   no userinfo, query or fragment): `relay_auth_failed`.
    ///
    /// Returns `{token, relayUrl}`.
    pub(crate) async fn relay_token(&self, store: &Store, device_id: &str) -> Result<Value> {
        let credentials = self.credentials(store)?;
        if credentials.token.is_none() {
            return Err(Error::http(401, "unauthorized"));
        }
        let failed = "Could not authenticate with the device relay.";
        let body = json!({"deviceId": device_id, "kind": "mobile"});
        let response = self
            .http
            .start(
                &self.origin,
                Call {
                    method: Method::POST,
                    path: "/api/v1/device-relay/token",
                    body: Some(&body),
                    profile: Profile::RelayToken,
                    timeout: Some(RELAY_TIMEOUT),
                    chunk_timeout: None,
                    limit: RELAY_BODY_LIMIT,
                },
                &credentials,
                None,
            )
            .await
            .map_err(|e| with_message(e, failed))?;
        let status = response.status().as_u16();
        let read = |response| http::read(response, RELAY_BODY_LIMIT, Some(RELAY_TIMEOUT), None);
        if status != 200 {
            if matches!(status, 401 | 403 | 404) {
                let code = read(response)
                    .await
                    .ok()
                    .and_then(|r| serde_json::from_slice::<Value>(&r.body).ok())
                    .and_then(|v| v["code"].as_str().map(String::from))
                    .filter(|c| {
                        !c.is_empty()
                            && c.len() <= 64
                            && c.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                    });
                return Err(with_message(
                    Error::http(status, code.as_deref().unwrap_or("relay_access_denied")),
                    "Connection access is unavailable. Try again or check your account.",
                ));
            }
            return Err(with_message(
                Error::http(status, "relay_unavailable"),
                &format!("Computer connection is temporarily unavailable ({status}). Try again."),
            ));
        }
        let bad = || with_message(Error::new("relay_auth_failed"), failed);
        let raw = read(response).await.map_err(|e| match e.kind {
            Kind::Http | Kind::Timeout => with_message(e, failed),
            _ => bad(),
        })?;
        let value: Value = serde_json::from_slice(&raw.body).map_err(|_| bad())?;
        let token = field(&value, "token").map_err(|_| bad())?;
        let relay_url = field(&value, "relayUrl").map_err(|_| bad())?;
        secure_url(relay_url, true).map_err(|_| bad())?;
        Ok(json!({"token": token, "relayUrl": relay_url}))
    }

    // ---- Authenticated passthrough for Dart API services ----

    /// `http.request {method, path, body?, retryTransient?, timeoutMs?}`
    /// through the app `ApiClient` profile, so the bearer stays in Rust.
    /// Returns `{status, headers, body}` for every status (the Dart side
    /// raises `ApiException` itself); only transport failures are errors.
    /// GETs retry 408/429/500/502/503/504 and transport failures twice
    /// (250 ms, 500 ms) unless `retryTransient` is false, as `ApiClient`
    /// does. Paths that mint or reveal credentials are refused.
    pub(crate) async fn http_request(&self, store: &Store, request: &Value) -> Result<Value> {
        let method = match field(request, "method")? {
            "GET" => Method::GET,
            "POST" => Method::POST,
            "PUT" => Method::PUT,
            "PATCH" => Method::PATCH,
            "DELETE" => Method::DELETE,
            _ => return Err(Error::new("invalid_method")),
        };
        let path = field(request, "path")?;
        let resolved = http::resolve(&self.origin, path)?;
        let lower = resolved.path().to_ascii_lowercase();
        let reserved = [
            "/api/auth/",
            "/api/mobile/oauth",
            "/api/mobile/two-factor",
            "/api/mobile/email-auth",
            "/api/v1/device-relay/",
        ];
        if reserved.iter().any(|p| lower.starts_with(p))
            || lower.contains("%2f")
            || lower.contains("%5c")
        {
            return Err(Error::new("reserved_path"));
        }
        let body = request.get("body").filter(|b| !b.is_null());
        let retry = method == Method::GET && request["retryTransient"] != false;
        let timeout = request["timeoutMs"]
            .as_u64()
            .map(|ms| Duration::from_millis(ms.clamp(1, 900_000)));
        let credentials = self.credentials(store)?;
        let mut attempt = 0;
        let response = loop {
            let result = self
                .send(
                    Call {
                        method: method.clone(),
                        path,
                        body,
                        profile: Profile::App,
                        timeout,
                        chunk_timeout: None,
                        limit: API_BODY_LIMIT,
                    },
                    &credentials,
                )
                .await;
            let transient = match &result {
                Ok(r) => matches!(r.status, 408 | 429 | 500 | 502 | 503 | 504),
                Err(e) => matches!(e.kind, Kind::Http | Kind::Timeout) && e.status.is_none(),
            };
            if !retry || attempt >= 2 || !transient {
                break result?;
            }
            tokio::time::sleep(Duration::from_millis(250 << attempt)).await;
            attempt += 1;
        };
        let headers: serde_json::Map<String, Value> = response
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        Ok(json!({
            "status": response.status,
            "headers": headers,
            "body": String::from_utf8_lossy(&response.body),
        }))
    }

    // ---- Legacy API key cleanup ----

    /// `ComputerConnectAccess.revokeLegacyKey`: `DELETE
    /// /api/account/api-keys/<id>` with the bare `ApiClient` profile, 20 s;
    /// 404 and 410 count as done.
    async fn revoke_legacy_api_key(&self, credentials: &Credentials, id: &str) -> Result<()> {
        let path = format!("/api/account/api-keys/{}", encode_component(id));
        let response = self
            .send(
                Call {
                    method: Method::DELETE,
                    path: &path,
                    body: None,
                    profile: Profile::Bare,
                    timeout: Some(LEGACY_REVOKE_TIMEOUT),
                    chunk_timeout: None,
                    limit: API_BODY_LIMIT,
                },
                credentials,
            )
            .await?;
        if response.ok() || matches!(response.status, 404 | 410) {
            Ok(())
        } else {
            Err(response.failure())
        }
    }

    /// `LegacyComputerConnectKeyCleanup.run` against the saved-computers
    /// record of `account`: revoke the recorded key, then clear `credential`
    /// and `creatingCredential` only if the record still names that key.
    /// The key is revoked only with `account`'s own credentials, so a 404
    /// cannot come from another account's view of it: while `account` is not
    /// the validated account in use this fails `account_changed`. A failed
    /// revocation or save keeps the record for a later retry.
    /// Returns `{revoked, cleared}`.
    pub(crate) async fn cleanup_legacy_key(&self, store: &Store, account: &str) -> Result<Value> {
        let Some(saved) = store.saved_computers(account)? else {
            return Ok(json!({"revoked": false, "cleared": false}));
        };
        let credential = saved["credential"]["id"].as_str().map(String::from);
        if credential.is_none() && saved["creatingCredential"] != true {
            return Ok(json!({"revoked": false, "cleared": false}));
        }
        if let Some(id) = &credential {
            let credentials = self
                .credentials_of(store, account)?
                .ok_or_else(|| Error::new("account_changed"))?;
            self.revoke_legacy_api_key(&credentials, id).await?;
        }
        let cleared = store.clear_saved_credential(account, credential.as_deref())?;
        Ok(json!({"revoked": credential.is_some(), "cleared": cleared}))
    }
}

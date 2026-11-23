//! Hosted sign-in and the session the core holds. The normal app signs in
//! with Dart and hands its session over with [`AuthService::adopt`]; the
//! developer console signs in through the core itself.
use super::{CoreFailure, CoreInner};
use crate::ports;
use serde_json::{Value, json};
use std::sync::Arc;

/// A validated sign-in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedInView {
    pub account_id: String,
    /// The hosted API's user record, as JSON.
    pub user_json: String,
    /// The account differs from the last one this store validated; the core
    /// tore down connections, relay and caches.
    pub account_changed: bool,
    /// Not a guest: Computer Connect is available.
    pub has_account: bool,
}
impl From<&ports::SignedIn> for SignedInView {
    fn from(s: &ports::SignedIn) -> Self {
        Self {
            account_id: s.account_id.clone(),
            user_json: s.user.to_string(),
            account_changed: s.account_changed(),
            has_account: !s.is_guest(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthSession {
    SignedIn(SignedInView),
    SignedOut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthStatus {
    /// Validated by this process.
    SignedIn(SignedInView),
    /// Credentials are stored but this process has not validated them.
    Unverified {
        last_user_json: Option<String>,
    },
    SignedOut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInStep {
    SignedIn(SignedInView),
    /// Complete with [`AuthService::two_factor`].
    TwoFactorRequired {
        challenge: String,
    },
    /// Email sign-in needs the verify step first.
    VerificationRequired,
    /// The user backed out; not a failure.
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthStart {
    pub authorize_url: String,
    pub callback_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleStart {
    /// The nonce hash to pass to the Apple sheet.
    pub nonce_hash: String,
}

fn session(s: &ports::AuthSession) -> AuthSession {
    match s {
        ports::AuthSession::SignedIn(s) => AuthSession::SignedIn(s.into()),
        ports::AuthSession::SignedOut => AuthSession::SignedOut,
    }
}
fn step(s: &ports::SignInStep) -> SignInStep {
    match s {
        ports::SignInStep::SignedIn(s) => SignInStep::SignedIn(s.into()),
        ports::SignInStep::TwoFactor { challenge } => SignInStep::TwoFactorRequired {
            challenge: challenge.clone(),
        },
        ports::SignInStep::VerificationRequired => SignInStep::VerificationRequired,
        ports::SignInStep::Cancelled => SignInStep::Cancelled,
    }
}
/// The port's status JSON as a typed status.
fn status(v: &Value) -> cc_protocol::Result<AuthStatus> {
    Ok(match v["status"].as_str() {
        Some("signedIn") => {
            let user = v["user"].clone();
            let account_id = user["id"].as_str().unwrap_or_default().to_owned();
            AuthStatus::SignedIn(SignedInView {
                account_id,
                user_json: user.to_string(),
                account_changed: v["accountChanged"] == true,
                has_account: v["hasAccount"] == true,
            })
        }
        Some("unverified") => AuthStatus::Unverified {
            last_user_json: (!v["lastUser"].is_null()).then(|| v["lastUser"].to_string()),
        },
        _ => AuthStatus::SignedOut,
    })
}
/// A required text input: non-empty, at most 4096 bytes.
pub(crate) use crate::error::required as text;

#[derive(Clone)]
pub struct AuthService {
    core: Arc<CoreInner>,
}

impl AuthService {
    pub(crate) fn new(core: Arc<CoreInner>) -> Self {
        Self { core }
    }

    /// Validates the stored session (`restoreSession`).
    pub async fn restore(&self) -> Result<AuthSession, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move { Ok(session(&app.observe(app.auth.restore().await?).await)) })
            .await
    }
    /// The session state without any network request.
    pub async fn status(&self) -> Result<AuthStatus, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move { status(&app.auth.status()?) })
            .await
    }
    /// Takes the app's session. With `account_id`, trusts the app's own
    /// validation, sends no request and holds the session in memory only;
    /// without it, stores and validates the session.
    pub async fn adopt(
        &self,
        token: String,
        two_factor_proof: Option<String>,
        account_id: Option<String>,
    ) -> Result<AuthSession, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                let token = text(&token)?;
                let proof = two_factor_proof.as_deref();
                let adopted = match account_id.as_deref() {
                    Some(account) => app.auth.adopt_app_session(token, proof, account)?,
                    None => app.auth.adopt(token, proof).await?,
                };
                Ok(session(&app.observe(adopted).await))
            })
            .await
    }
    /// Drops the local session without a request (the app signed out).
    pub async fn forget(&self) -> Result<(), CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                let forgotten = app.auth.forget();
                app.leave_account("signed_out").await;
                forgotten
            })
            .await
    }
    /// Drops only the session the host is signing out, preserving a newer
    /// token and the account scope a session adopted meanwhile entered.
    pub async fn forget_if_token(&self, token: String) -> Result<bool, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                let forgotten = app.auth.forget_if_token(&token)?;
                if forgotten {
                    app.leave_account("signed_out").await;
                }
                Ok(forgotten)
            })
            .await
    }
    /// Signs out on the server, then clears the local session and leaves
    /// the account, unless a session adopted meanwhile superseded it.
    pub async fn sign_out(&self) -> Result<(), CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                let signed_out = app.auth.sign_out().await;
                app.leave_account("signed_out").await;
                signed_out
            })
            .await
    }
    /// Supersedes a sign-in in progress.
    pub async fn cancel(&self) -> Result<(), CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                app.auth.cancel_sign_in();
                Ok(())
            })
            .await
    }
    pub async fn begin_oauth(
        &self,
        provider: String,
        callback_url: String,
    ) -> Result<OAuthStart, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                let v = app
                    .auth
                    .begin_oauth(text(&provider)?, text(&callback_url)?)?;
                Ok(OAuthStart {
                    authorize_url: v["authorizeUrl"].as_str().unwrap_or_default().into(),
                    callback_url: v["callbackUrl"].as_str().unwrap_or_default().into(),
                })
            })
            .await
    }
    /// Completes an OAuth sign-in from the callback URL the browser sheet
    /// returned.
    pub async fn complete_oauth(&self, url: String) -> Result<SignInStep, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                let s = app.auth.oauth_callback(text(&url)?).await?;
                Ok(step(&app.observe_step(s).await))
            })
            .await
    }
    pub async fn begin_apple(&self) -> Result<AppleStart, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                let v = app.auth.apple_begin();
                Ok(AppleStart {
                    nonce_hash: v["nonceHash"].as_str().unwrap_or_default().into(),
                })
            })
            .await
    }
    pub async fn complete_apple(
        &self,
        identity_token: String,
        name: Option<String>,
    ) -> Result<SignInStep, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                let s = app
                    .auth
                    .apple_complete(text(&identity_token)?, name.as_deref())
                    .await?;
                Ok(step(&app.observe_step(s).await))
            })
            .await
    }
    pub async fn two_factor(
        &self,
        challenge: String,
        code: String,
    ) -> Result<SignInStep, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                let s = app.auth.two_factor(text(&challenge)?, text(&code)?).await?;
                Ok(step(&app.observe_step(s).await))
            })
            .await
    }
    pub async fn email_sign_in(
        &self,
        email: String,
        password: String,
    ) -> Result<SignInStep, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                let s = app
                    .auth
                    .email_sign_in(text(&email)?, text(&password)?)
                    .await?;
                Ok(step(&app.observe_step(s).await))
            })
            .await
    }
    /// Whether email sign-in is offered.
    pub async fn email_available(&self) -> Result<bool, CoreFailure> {
        let v = self.email("available", json!({})).await?;
        Ok(v["enabled"] == true)
    }
    pub async fn email_sign_up(&self, email: String, password: String) -> Result<(), CoreFailure> {
        self.email("sign_up", json!({"email": email, "password": password}))
            .await
            .map(drop)
    }
    pub async fn email_verify(&self, email: String, otp: String) -> Result<(), CoreFailure> {
        self.email("verify", json!({"email": email, "otp": otp}))
            .await
            .map(drop)
    }
    pub async fn email_forgot(&self, email: String) -> Result<(), CoreFailure> {
        self.email("forgot", json!({ "email": email }))
            .await
            .map(drop)
    }
    pub async fn email_reset(
        &self,
        email: String,
        otp: String,
        password: String,
    ) -> Result<(), CoreFailure> {
        self.email(
            "reset",
            json!({"email": email, "otp": otp, "password": password}),
        )
        .await
        .map(drop)
    }
    async fn email(&self, action: &'static str, body: Value) -> Result<Value, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move { app.auth.email_action(action, &body).await })
            .await
    }
}

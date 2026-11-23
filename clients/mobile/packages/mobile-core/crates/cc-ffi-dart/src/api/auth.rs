//! Hosted sign-in and the session the core holds.
use super::core::CoreFailure;
use flutter_rust_bridge::frb;

/// A validated sign-in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedInView {
    pub account_id: String,
    /// The hosted API's user record, as JSON.
    pub user_json: String,
    /// A different account than the store last validated; connections,
    /// relay and caches were torn down.
    pub account_changed: bool,
    /// Not a guest: Computer Connect is available.
    pub has_account: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthSession {
    SignedIn(SignedInView),
    SignedOut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthStatus {
    SignedIn(SignedInView),
    /// Credentials stored, not validated by this process.
    Unverified {
        last_user_json: Option<String>,
    },
    SignedOut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInStep {
    SignedIn(SignedInView),
    TwoFactorRequired { challenge: String },
    VerificationRequired,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthStart {
    pub authorize_url: String,
    pub callback_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppleStart {
    pub nonce_hash: String,
}

impl From<cc_core::SignedInView> for SignedInView {
    fn from(s: cc_core::SignedInView) -> Self {
        Self {
            account_id: s.account_id,
            user_json: s.user_json,
            account_changed: s.account_changed,
            has_account: s.has_account,
        }
    }
}
impl From<cc_core::AuthSession> for AuthSession {
    fn from(s: cc_core::AuthSession) -> Self {
        match s {
            cc_core::AuthSession::SignedIn(s) => Self::SignedIn(s.into()),
            cc_core::AuthSession::SignedOut => Self::SignedOut,
        }
    }
}
impl From<cc_core::AuthStatus> for AuthStatus {
    fn from(s: cc_core::AuthStatus) -> Self {
        match s {
            cc_core::AuthStatus::SignedIn(s) => Self::SignedIn(s.into()),
            cc_core::AuthStatus::Unverified { last_user_json } => {
                Self::Unverified { last_user_json }
            }
            cc_core::AuthStatus::SignedOut => Self::SignedOut,
        }
    }
}
impl From<cc_core::SignInStep> for SignInStep {
    fn from(s: cc_core::SignInStep) -> Self {
        match s {
            cc_core::SignInStep::SignedIn(s) => Self::SignedIn(s.into()),
            cc_core::SignInStep::TwoFactorRequired { challenge } => {
                Self::TwoFactorRequired { challenge }
            }
            cc_core::SignInStep::VerificationRequired => Self::VerificationRequired,
            cc_core::SignInStep::Cancelled => Self::Cancelled,
        }
    }
}

/// Hosted sign-in. The normal app signs in with Dart and calls
/// [`AuthService::adopt`]; the developer console signs in here.
#[frb(opaque)]
pub struct AuthService {
    inner: cc_core::AuthService,
}

impl AuthService {
    pub(crate) fn new(inner: cc_core::AuthService) -> Self {
        Self { inner }
    }
    pub async fn restore(&self) -> Result<AuthSession, CoreFailure> {
        Ok(self.inner.restore().await?.into())
    }
    pub async fn status(&self) -> Result<AuthStatus, CoreFailure> {
        Ok(self.inner.status().await?.into())
    }
    /// With `account_id`, trusts the app's validation and sends no request.
    pub async fn adopt(
        &self,
        token: String,
        two_factor_proof: Option<String>,
        account_id: Option<String>,
    ) -> Result<AuthSession, CoreFailure> {
        Ok(self
            .inner
            .adopt(token, two_factor_proof, account_id)
            .await?
            .into())
    }
    /// Drops the local session without a request.
    pub async fn forget(&self) -> Result<(), CoreFailure> {
        Ok(self.inner.forget().await?)
    }
    pub async fn forget_if_token(&self, token: String) -> Result<bool, CoreFailure> {
        Ok(self.inner.forget_if_token(token).await?)
    }
    pub async fn sign_out(&self) -> Result<(), CoreFailure> {
        Ok(self.inner.sign_out().await?)
    }
    pub async fn cancel(&self) -> Result<(), CoreFailure> {
        Ok(self.inner.cancel().await?)
    }
    pub async fn begin_oauth(
        &self,
        provider: String,
        callback_url: String,
    ) -> Result<OAuthStart, CoreFailure> {
        let s = self.inner.begin_oauth(provider, callback_url).await?;
        Ok(OAuthStart {
            authorize_url: s.authorize_url,
            callback_url: s.callback_url,
        })
    }
    pub async fn complete_oauth(&self, url: String) -> Result<SignInStep, CoreFailure> {
        Ok(self.inner.complete_oauth(url).await?.into())
    }
    pub async fn begin_apple(&self) -> Result<AppleStart, CoreFailure> {
        let s = self.inner.begin_apple().await?;
        Ok(AppleStart {
            nonce_hash: s.nonce_hash,
        })
    }
    pub async fn complete_apple(
        &self,
        identity_token: String,
        name: Option<String>,
    ) -> Result<SignInStep, CoreFailure> {
        Ok(self
            .inner
            .complete_apple(identity_token, name)
            .await?
            .into())
    }
    pub async fn two_factor(
        &self,
        challenge: String,
        code: String,
    ) -> Result<SignInStep, CoreFailure> {
        Ok(self.inner.two_factor(challenge, code).await?.into())
    }
    pub async fn email_sign_in(
        &self,
        email: String,
        password: String,
    ) -> Result<SignInStep, CoreFailure> {
        Ok(self.inner.email_sign_in(email, password).await?.into())
    }
    pub async fn email_available(&self) -> Result<bool, CoreFailure> {
        Ok(self.inner.email_available().await?)
    }
    pub async fn email_sign_up(&self, email: String, password: String) -> Result<(), CoreFailure> {
        Ok(self.inner.email_sign_up(email, password).await?)
    }
    pub async fn email_verify(&self, email: String, otp: String) -> Result<(), CoreFailure> {
        Ok(self.inner.email_verify(email, otp).await?)
    }
    pub async fn email_forgot(&self, email: String) -> Result<(), CoreFailure> {
        Ok(self.inner.email_forgot(email).await?)
    }
    pub async fn email_reset(
        &self,
        email: String,
        otp: String,
        password: String,
    ) -> Result<(), CoreFailure> {
        Ok(self.inner.email_reset(email, otp, password).await?)
    }
}

//! The selected computer's provider plan usage (architecture §3.7): the
//! desktop's Claude, Codex and Copilot limits, its account proxy's accounts
//! and OpenCode account metadata, as Account shows them. The service follows
//! the account's selected computer: it reads usage when that computer
//! connects, applies the desktop's usage pushes, retries failed reads and
//! drops everything of the previous computer when the selection changes.
//! Labels and messages are computed here.
use super::{CoreFailure, CoreInner, Subscription};
pub use cc_domain::usage::{
    AccountSource as UsageAccountSource, AccountStatus as UsageAccountStatus,
    AuthState as UsageAuthState, CreditUnit, ErrorKind as UsageErrorKind, OpenCodeMethod,
    Provider as UsageProvider,
};
use std::sync::Arc;

/// This phone's delivery of the selected computer's updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageDelivery {
    Live,
    /// Reconnecting; the values shown are the last received.
    Reconnecting,
    Unreachable,
}

/// A classified failed read with curated copy, never raw provider text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageError {
    pub kind: UsageErrorKind,
    pub message: String,
}

/// Credits of one window; absent amounts were not reported.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageCredits {
    pub unit: CreditUnit,
    pub spent: Option<f64>,
    pub remaining: Option<f64>,
    pub total: Option<f64>,
}

/// Billing-period spend and cap in major currency units.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageSpend {
    pub currency: Option<String>,
    pub is_enabled: Option<bool>,
    pub limit: Option<f64>,
    pub used: Option<f64>,
}

/// One plan limit window. Timestamps are ISO 8601 UTC.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageWindow {
    pub id: String,
    pub label: String,
    pub unlimited: Option<bool>,
    pub used_percent: Option<f64>,
    pub resets_at: Option<String>,
    pub window_duration_ms: Option<f64>,
    pub credits: Option<UsageCredits>,
    pub spend: Option<UsageSpend>,
}

/// One account the desktop's account proxy shares for a provider.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageAccount {
    pub id: String,
    pub label: Option<String>,
    pub plan_label: Option<String>,
    pub status: UsageAccountStatus,
    pub available_at: Option<String>,
    pub usage_source: Option<UsageAccountSource>,
    pub last_updated_at: Option<String>,
    pub retry_at: Option<String>,
    pub error: Option<UsageError>,
    pub windows: Vec<UsageWindow>,
}

/// One provider's usage on the selected computer.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderUsage {
    pub provider: UsageProvider,
    pub auth_state: UsageAuthState,
    pub account_email: Option<String>,
    pub account_label: Option<String>,
    pub plan_label: Option<String>,
    pub last_updated_at: Option<String>,
    pub error: Option<UsageError>,
    pub windows: Vec<UsageWindow>,
    /// Present while the account proxy serves the provider.
    pub accounts: Option<Vec<UsageAccount>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeUsageWindow {
    pub id: String,
    pub percent: f64,
    pub resets_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeAccountUsage {
    pub checked_at: Option<String>,
    pub plan: Option<String>,
    pub status: String,
    pub windows: Option<Vec<OpenCodeUsageWindow>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeAccount {
    pub label: String,
    pub method: OpenCodeMethod,
    pub needs_sign_in: bool,
    pub selected: bool,
    pub usage: Option<OpenCodeAccountUsage>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeProvider {
    pub accounts: Vec<OpenCodeAccount>,
    pub id: String,
    pub name: String,
}

/// OpenCode account metadata, as the desktop sent it.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeAccounts {
    pub providers: Vec<OpenCodeProvider>,
    pub status: String,
    pub updated_at: String,
}

/// The desktop's usage, as Account shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageProjection {
    pub updated_at: String,
    pub open_code_accounts: Option<OpenCodeAccounts>,
    pub providers: Vec<ProviderUsage>,
}

/// Why the last refresh of `provider` did not deliver newer usage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshFailure {
    pub provider: UsageProvider,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageView {
    pub revision: u64,
    /// Changes whenever the selected computer does: values shown for the
    /// previous computer must be dropped, even when the new one is offline.
    pub scope: u64,
    pub computer_id: Option<String>,
    /// The selected computer answers for usage now.
    pub available: bool,
    pub delivery: UsageDelivery,
    /// The latest values; kept while the computer reconnects.
    pub projection: Option<UsageProjection>,
    pub refreshing: Vec<UsageProvider>,
    pub failures: Vec<RefreshFailure>,
}

#[derive(Clone)]
pub struct ProviderUsageService {
    core: Arc<CoreInner>,
}

impl ProviderUsageService {
    pub(crate) fn new(core: Arc<CoreInner>) -> Self {
        Self { core }
    }
    /// The current view first, then every change (latest wins).
    pub fn watch(&self) -> Subscription<UsageView> {
        Subscription::watch(self.core.usage().view())
    }
    /// Asks the selected computer to re-read `provider`'s usage. Does
    /// nothing while usage is unavailable or the provider is already
    /// refreshing.
    ///
    /// Resolves when settled: with the view once the refresh delivered
    /// newer values or recorded a refresh failure for `provider`
    /// (`ProviderUsageSource.refresh` awaited that).
    pub async fn refresh(&self, provider: UsageProvider) -> Result<UsageView, CoreFailure> {
        let handle = self.core.usage().clone();
        let view = self
            .core
            .run(async move { handle.refresh(provider).await })
            .await?;
        Ok(UsageView::clone(&view))
    }
}

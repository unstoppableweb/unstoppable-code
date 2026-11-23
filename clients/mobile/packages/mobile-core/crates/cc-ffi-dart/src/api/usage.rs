//! The selected computer's provider usage. The service follows the
//! account's selection; `refresh` resolves once the refresh settled.
use super::{core::CoreFailure, handler};
use crate::frb_generated::StreamSink;
use flutter_rust_bridge::frb;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageProvider {
    Claude,
    Codex,
    Copilot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageDelivery {
    Live,
    Reconnecting,
    Unreachable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageAuthState {
    Authenticated,
    Unauthenticated,
    Unknown,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageErrorKind {
    Auth,
    Network,
    Service,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreditUnit {
    Usd,
    Credits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageAccountStatus {
    Active,
    Cooling,
    Error,
    Disabled,
    Refreshing,
    Pending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageAccountSource {
    Live,
    Passive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenCodeMethod {
    Key,
    OAuth,
    External,
    Env,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageError {
    pub kind: UsageErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageCredits {
    pub unit: CreditUnit,
    pub spent: Option<f64>,
    pub remaining: Option<f64>,
    pub total: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageSpend {
    pub currency: Option<String>,
    pub is_enabled: Option<bool>,
    pub limit: Option<f64>,
    pub used: Option<f64>,
}

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

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeAccounts {
    pub providers: Vec<OpenCodeProvider>,
    pub status: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageProjection {
    pub updated_at: String,
    pub open_code_accounts: Option<OpenCodeAccounts>,
    pub providers: Vec<ProviderUsage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshFailure {
    pub provider: UsageProvider,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageView {
    pub revision: u64,
    /// Changes whenever the selected computer does.
    pub scope: u64,
    pub computer_id: Option<String>,
    pub available: bool,
    pub delivery: UsageDelivery,
    pub projection: Option<UsageProjection>,
    pub refreshing: Vec<UsageProvider>,
    pub failures: Vec<RefreshFailure>,
}

// ---- Conversions from the facade ----

fn provider(p: cc_core::UsageProvider) -> UsageProvider {
    match p {
        cc_core::UsageProvider::Claude => UsageProvider::Claude,
        cc_core::UsageProvider::Codex => UsageProvider::Codex,
        cc_core::UsageProvider::Copilot => UsageProvider::Copilot,
    }
}

fn error(e: cc_core::UsageError) -> UsageError {
    use cc_core::UsageErrorKind as K;
    UsageError {
        kind: match e.kind {
            K::Auth => UsageErrorKind::Auth,
            K::Network => UsageErrorKind::Network,
            K::Service => UsageErrorKind::Service,
            K::Unsupported => UsageErrorKind::Unsupported,
            K::Unknown => UsageErrorKind::Unknown,
        },
        message: e.message,
    }
}

fn window(w: cc_core::UsageWindow) -> UsageWindow {
    UsageWindow {
        id: w.id,
        label: w.label,
        unlimited: w.unlimited,
        used_percent: w.used_percent,
        resets_at: w.resets_at,
        window_duration_ms: w.window_duration_ms,
        credits: w.credits.map(|c| UsageCredits {
            unit: match c.unit {
                cc_core::CreditUnit::Usd => CreditUnit::Usd,
                cc_core::CreditUnit::Credits => CreditUnit::Credits,
            },
            spent: c.spent,
            remaining: c.remaining,
            total: c.total,
        }),
        spend: w.spend.map(|s| UsageSpend {
            currency: s.currency,
            is_enabled: s.is_enabled,
            limit: s.limit,
            used: s.used,
        }),
    }
}

fn account(a: cc_core::UsageAccount) -> UsageAccount {
    use cc_core::UsageAccountStatus as S;
    UsageAccount {
        id: a.id,
        label: a.label,
        plan_label: a.plan_label,
        status: match a.status {
            S::Active => UsageAccountStatus::Active,
            S::Cooling => UsageAccountStatus::Cooling,
            S::Error => UsageAccountStatus::Error,
            S::Disabled => UsageAccountStatus::Disabled,
            S::Refreshing => UsageAccountStatus::Refreshing,
            S::Pending => UsageAccountStatus::Pending,
        },
        available_at: a.available_at,
        usage_source: a.usage_source.map(|s| match s {
            cc_core::UsageAccountSource::Live => UsageAccountSource::Live,
            cc_core::UsageAccountSource::Passive => UsageAccountSource::Passive,
        }),
        last_updated_at: a.last_updated_at,
        retry_at: a.retry_at,
        error: a.error.map(error),
        windows: a.windows.into_iter().map(window).collect(),
    }
}

fn entry(e: cc_core::ProviderUsage) -> ProviderUsage {
    use cc_core::UsageAuthState as A;
    ProviderUsage {
        provider: provider(e.provider),
        auth_state: match e.auth_state {
            A::Authenticated => UsageAuthState::Authenticated,
            A::Unauthenticated => UsageAuthState::Unauthenticated,
            A::Unknown => UsageAuthState::Unknown,
            A::Error => UsageAuthState::Error,
        },
        account_email: e.account_email,
        account_label: e.account_label,
        plan_label: e.plan_label,
        last_updated_at: e.last_updated_at,
        error: e.error.map(error),
        windows: e.windows.into_iter().map(window).collect(),
        accounts: e
            .accounts
            .map(|accounts| accounts.into_iter().map(account).collect()),
    }
}

fn open_code(o: cc_core::OpenCodeAccounts) -> OpenCodeAccounts {
    OpenCodeAccounts {
        providers: o
            .providers
            .into_iter()
            .map(|p| OpenCodeProvider {
                accounts: p
                    .accounts
                    .into_iter()
                    .map(|a| OpenCodeAccount {
                        label: a.label,
                        method: match a.method {
                            cc_core::OpenCodeMethod::Key => OpenCodeMethod::Key,
                            cc_core::OpenCodeMethod::OAuth => OpenCodeMethod::OAuth,
                            cc_core::OpenCodeMethod::External => OpenCodeMethod::External,
                            cc_core::OpenCodeMethod::Env => OpenCodeMethod::Env,
                        },
                        needs_sign_in: a.needs_sign_in,
                        selected: a.selected,
                        usage: a.usage.map(|u| OpenCodeAccountUsage {
                            checked_at: u.checked_at,
                            plan: u.plan,
                            status: u.status,
                            windows: u.windows.map(|windows| {
                                windows
                                    .into_iter()
                                    .map(|w| OpenCodeUsageWindow {
                                        id: w.id,
                                        percent: w.percent,
                                        resets_at: w.resets_at,
                                    })
                                    .collect()
                            }),
                        }),
                    })
                    .collect(),
                id: p.id,
                name: p.name,
            })
            .collect(),
        status: o.status,
        updated_at: o.updated_at,
    }
}

impl From<cc_core::UsageView> for UsageView {
    fn from(v: cc_core::UsageView) -> Self {
        Self {
            revision: v.revision,
            scope: v.scope,
            computer_id: v.computer_id,
            available: v.available,
            delivery: match v.delivery {
                cc_core::UsageDelivery::Live => UsageDelivery::Live,
                cc_core::UsageDelivery::Reconnecting => UsageDelivery::Reconnecting,
                cc_core::UsageDelivery::Unreachable => UsageDelivery::Unreachable,
            },
            projection: v.projection.map(|p| UsageProjection {
                updated_at: p.updated_at,
                open_code_accounts: p.open_code_accounts.map(open_code),
                providers: p.providers.into_iter().map(entry).collect(),
            }),
            refreshing: v.refreshing.into_iter().map(provider).collect(),
            failures: v
                .failures
                .into_iter()
                .map(|f| RefreshFailure {
                    provider: provider(f.provider),
                    message: f.message,
                })
                .collect(),
        }
    }
}

#[frb(opaque)]
#[derive(Clone)]
pub struct ProviderUsageService {
    inner: cc_core::ProviderUsageService,
}

impl ProviderUsageService {
    pub(crate) fn new(inner: cc_core::ProviderUsageService) -> Self {
        Self { inner }
    }

    /// The current view, then every change (latest wins).
    pub fn watch(&self, sink: StreamSink<UsageView>) {
        let mut views = self.inner.watch();
        handler::runtime().spawn(async move {
            while let Some(view) = views.next().await {
                if sink.add(view.into()).is_err() {
                    break;
                }
            }
        });
    }
    /// Asks the selected computer to re-read `provider`'s usage. Does
    /// nothing while usage is unavailable or the provider is already
    /// refreshing.
    ///
    /// Resolves when settled: with the view once the refresh delivered
    /// newer values or recorded a refresh failure for `provider`
    /// (`ProviderUsageSource.refresh` awaited that).
    pub async fn refresh(&self, provider: UsageProvider) -> Result<UsageView, CoreFailure> {
        let provider = match provider {
            UsageProvider::Claude => cc_core::UsageProvider::Claude,
            UsageProvider::Codex => cc_core::UsageProvider::Codex,
            UsageProvider::Copilot => cc_core::UsageProvider::Copilot,
        };
        self.inner
            .refresh(provider)
            .await
            .map(Into::into)
            .map_err(Into::into)
    }
}

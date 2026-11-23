//! Provider usage: the projection of the desktop's usage overview, account
//! proxy status and preferences into what Account shows, the proxy routing
//! rule, and the timing policy of the usage reads. Ported from
//! `lib/device_link/provider_usage/projection.dart` (window semantics follow
//! `desktop-shared/lib/account-proxy-usage-projection.ts`) and
//! `computer_connect/provider_usage_source.dart`.
//!
//! The projection reads [`Dv`] values with Dart's checks, so a payload that
//! made the Dart code throw fails here too ([`Malformed`]). Labels and
//! messages are returned as keys ([`WindowLabel`], [`PlanLabel`],
//! [`UsageError`]); the app layer words them.
use crate::dart::{
    self, Micros,
    value::{CastError, Dv, DvMap, or, parse_list},
};
use std::time::Duration;

/// Timing rules, citing their Dart source.
pub mod policy {
    use super::Duration;
    /// `provider_usage_source.dart` `_load`: 1, 2 and 4 s, three retries.
    pub const MAX_RETRIES: u32 = 3;
    pub fn retry_delay(attempt: u32) -> Duration {
        Duration::from_secs(1 << attempt)
    }
    /// `repository.dart` `refresh`: provider reads can take 45 s, proxy
    /// reads queue behind other accounts.
    pub const REFRESH_TIMEOUT: Duration = Duration::from_secs(120);
    /// The session's default request timeout.
    pub const READ_TIMEOUT: Duration = Duration::from_secs(15);
}

/// A usage payload the Dart projection could not read (it threw).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Malformed;

impl From<CastError> for Malformed {
    fn from(_: CastError) -> Self {
        Self
    }
}

type Result<T> = std::result::Result<T, Malformed>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Provider {
    Claude,
    Codex,
    Copilot,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Claude, Provider::Codex, Provider::Copilot];
    pub fn wire(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Copilot => "copilot",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthState {
    Authenticated,
    Unauthenticated,
    Unknown,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Auth,
    Network,
    Service,
    Unsupported,
    Unknown,
}

/// Which curated headline an error shows; never raw provider text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCause {
    Auth,
    Network,
    Service,
    RateLimited,
    Unsupported,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UsageError {
    pub provider: Provider,
    pub kind: ErrorKind,
    pub cause: ErrorCause,
}

/// `_error(provider, kind)`.
fn error(provider: Provider, kind: &str) -> UsageError {
    let cause = match kind {
        "auth" => ErrorCause::Auth,
        "network" => ErrorCause::Network,
        "service" => ErrorCause::Service,
        "rate_limited" => ErrorCause::RateLimited,
        "unsupported" => ErrorCause::Unsupported,
        _ => ErrorCause::Other,
    };
    let kind = match if kind == "rate_limited" {
        "service"
    } else {
        kind
    } {
        "auth" => ErrorKind::Auth,
        "network" => ErrorKind::Network,
        "service" => ErrorKind::Service,
        "unsupported" => ErrorKind::Unsupported,
        _ => ErrorKind::Unknown,
    };
    UsageError {
        provider,
        kind,
        cause,
    }
}

/// The leading part of a Codex window label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Span {
    Days(i64),
    Hours(i64),
    /// The minutes as Dart prints the number.
    Minutes(String),
    Primary,
    Secondary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowLabel {
    /// Text from the desktop (a limit name or id).
    Desktop(String),
    CurrentWindow,
    Credits,
    /// `'<span> <suffix>'`; no suffix reads `window`.
    Slot {
        span: Span,
        suffix: Option<String>,
    },
    FiveHourLimit,
    WeeklyLimit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreditUnit {
    Usd,
    Credits,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Credits {
    pub unit: CreditUnit,
    pub spent: Option<f64>,
    pub remaining: Option<f64>,
    pub total: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Spend {
    pub currency: Option<String>,
    pub is_enabled: Option<bool>,
    pub limit: Option<f64>,
    pub used: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    pub id: String,
    pub label: WindowLabel,
    pub unlimited: Option<bool>,
    pub used_percent: Option<f64>,
    pub resets_at: Option<Micros>,
    pub window_duration_ms: Option<f64>,
    pub credits: Option<Credits>,
    pub spend: Option<Spend>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountStatus {
    Active,
    Cooling,
    Error,
    Disabled,
    Refreshing,
    Pending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountSource {
    Live,
    Passive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanLabel {
    ApiKey,
    /// `ChatGPT <name>` for Codex, `Claude <name>` otherwise; `name` is the
    /// normalized plan slug in title case, as the desktop names the plan.
    Plan {
        chat_gpt: bool,
        name: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Account {
    pub id: String,
    pub label: Option<String>,
    pub plan: Option<PlanLabel>,
    pub status: AccountStatus,
    pub available_at: Option<Micros>,
    pub usage_source: Option<AccountSource>,
    pub last_updated_at: Option<Micros>,
    pub retry_at: Option<Micros>,
    pub error: Option<UsageError>,
    pub windows: Vec<Window>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub provider: Provider,
    pub auth_state: AuthState,
    pub account_email: Option<String>,
    pub account_label: Option<String>,
    /// The desktop's subscription label, shown as is.
    pub plan_label: Option<String>,
    pub last_updated_at: Option<Micros>,
    pub error: Option<UsageError>,
    pub windows: Vec<Window>,
    /// Present while the account proxy serves the provider.
    pub accounts: Option<Vec<Account>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenCodeMethod {
    Key,
    OAuth,
    External,
    Env,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeWindow {
    pub id: String,
    pub percent: f64,
    pub resets_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeUsage {
    pub checked_at: Option<String>,
    pub plan: Option<String>,
    pub status: String,
    pub windows: Option<Vec<OpenCodeWindow>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeAccount {
    pub label: String,
    pub method: OpenCodeMethod,
    pub needs_sign_in: bool,
    pub selected: bool,
    pub usage: Option<OpenCodeUsage>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeProvider {
    pub accounts: Vec<OpenCodeAccount>,
    pub id: String,
    pub name: String,
}

/// OpenCode account metadata, passed through as the generated
/// `OpenCodeAccountSnapshot.fromJson` reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodeAccounts {
    pub providers: Vec<OpenCodeProvider>,
    pub status: String,
    pub updated_at: String,
}

/// The selected computer's usage, as Account shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Projection {
    /// The desktop's overview timestamp, as sent.
    pub updated_at: String,
    pub open_code: Option<OpenCodeAccounts>,
    pub providers: Vec<Entry>,
}

// ---- Reading the payloads ----

/// `_iso(value)`: a finite number as epoch milliseconds or a parseable
/// string; `Err` where Dart's `DateTime` throws (out of range).
fn iso(value: &Dv) -> Result<Option<Micros>> {
    match value {
        Dv::Int(_) | Dv::Float(_) => match value.finite() {
            Some(ms) => dart::from_millis(ms).map(Some).ok_or(Malformed),
            None => Ok(None),
        },
        Dv::Str(text) => Ok(dart::parse_datetime(text)),
        _ => Ok(None),
    }
}

fn open_code(value: &DvMap) -> Result<OpenCodeAccounts> {
    let window = |e: &Dv| -> Result<OpenCodeWindow> {
        let w = e.cast_map()?;
        Ok(OpenCodeWindow {
            id: w.get("id").cast_required_str()?.into(),
            percent: w.get("percent").cast_num()?.unwrap_or(0.0),
            resets_at: w.get("resetsAt").cast_required_str()?.into(),
        })
    };
    let account = |e: &Dv| -> Result<OpenCodeAccount> {
        let a = e.cast_map()?;
        let method = match a.get("method").cast_required_str()? {
            "key" => OpenCodeMethod::Key,
            "oauth" => OpenCodeMethod::OAuth,
            "external" => OpenCodeMethod::External,
            "env" => OpenCodeMethod::Env,
            _ => return Err(Malformed),
        };
        let usage = match a.get("usage") {
            Dv::Null => None,
            usage => {
                let u = usage.cast_map()?;
                Some(OpenCodeUsage {
                    checked_at: u.get("checkedAt").cast_str()?.map(Into::into),
                    plan: u.get("plan").cast_str()?.map(Into::into),
                    status: u.get("status").cast_required_str()?.into(),
                    windows: match u.get("windows") {
                        Dv::Null => None,
                        windows => Some(parse_list(windows, window)?),
                    },
                })
            }
        };
        Ok(OpenCodeAccount {
            label: a.get("label").cast_required_str()?.into(),
            method,
            needs_sign_in: a.get("needsSignIn").cast_bool()?.ok_or(Malformed)?,
            selected: a.get("selected").cast_bool()?.ok_or(Malformed)?,
            usage,
        })
    };
    let provider = |e: &Dv| -> Result<OpenCodeProvider> {
        let p = e.cast_map()?;
        Ok(OpenCodeProvider {
            accounts: parse_list(p.get("accounts"), account)?,
            id: p.get("id").cast_required_str()?.into(),
            name: p.get("name").cast_required_str()?.into(),
        })
    };
    Ok(OpenCodeAccounts {
        providers: parse_list(value.get("providers"), provider)?,
        status: value.get("status").cast_required_str()?.into(),
        updated_at: value.get("updatedAt").cast_required_str()?.into(),
    })
}

/// `projectDesktopUsage(overview, proxy, preferences)`.
pub fn project(overview: &Dv, proxy: &Dv, preferences: &Dv) -> Result<Projection> {
    let overview = overview.object();
    let updated_at = overview.get("updatedAt").cast_required_str()?.to_owned();
    let open_code = match overview.get("openCodeAccounts") {
        Dv::Map(map) => Some(self::open_code(map)?),
        _ => None,
    };
    let provider_rows = overview.get("providers").maps();
    let empty = DvMap::new();
    let mut providers = Vec::new();
    for provider in Provider::ALL {
        let matching = |row: &&&DvMap| row.get("provider").is_str(provider.wire());
        if provider == Provider::Copilot && !provider_rows.iter().any(|r| matching(&r)) {
            continue;
        }
        let row = provider_rows
            .iter()
            .find(matching)
            .copied()
            .unwrap_or(&empty);
        let accounts = if serves_usage_proxy(provider, proxy, preferences)? {
            let mut accounts = Vec::new();
            for account_row in proxy.get("accounts").maps() {
                if account_row.get("provider").is_str(provider.wire()) {
                    accounts.push(account(provider, account_row)?);
                }
            }
            Some(accounts)
        } else {
            None
        };
        providers.push(entry(provider, row, accounts)?);
    }
    Ok(Projection {
        updated_at,
        open_code,
        providers,
    })
}

/// `servesUsageProxy`: the desktop's device-wide account-source rule,
/// including local runtime readiness and the global AI Credits override.
pub fn serves_usage_proxy(provider: Provider, proxy: &Dv, preferences: &Dv) -> Result<bool> {
    let route = if provider == Provider::Claude {
        "routeClaude"
    } else {
        "routeCodex"
    };
    if provider == Provider::Copilot
        || preferences.get("aiCreditsRoutingMode").is_str("on")
        || !proxy.get("available").is_true()
        || !proxy.get("state").is_str("connected")
        || !proxy.get("error").is_null()
        || !proxy.get(route).is_true()
    {
        return Ok(false);
    }
    let connection = proxy.get("connection").object();
    if connection.is_empty() {
        return Ok(false);
    }
    if !connection.get("kind").is_str("local") {
        return Ok(true);
    }
    let local = proxy.get("local").object();
    let url = connection.get("url").cast_str()?.unwrap_or("");
    let port = local.get("port");
    Ok(local.get("phase").is_str("running")
        && !port.is_null()
        && dart::uri_port(url).is_some_and(|p| {
            // Exact: ports are small.
            #[allow(clippy::cast_precision_loss)]
            let p = p as f64;
            Dv::Float(p).loosely_equals(port)
        }))
}

/// `_entry(provider, row, accounts)`.
fn entry(provider: Provider, row: &DvMap, accounts: Option<Vec<Account>>) -> Result<Entry> {
    let unauthenticated = row.get("authState").is_str("unauthenticated");
    let windows = if unauthenticated {
        Vec::new()
    } else {
        self::windows(provider, row.get("rateLimits"))?
    };
    let info = row.get("errorInfo").object();
    let kind = match info.get("kind").cast_str()? {
        Some(kind) => Some(kind.to_owned()),
        None if !row.get("error").is_null() || row.get("authState").is_str("error") => {
            Some("unknown".to_owned())
        }
        None => None,
    };
    let retained_throttle = kind.as_deref() == Some("rate_limited") && !windows.is_empty();
    let auth_state = if unauthenticated {
        AuthState::Unauthenticated
    } else if retained_throttle || (kind.is_none() && row.get("authState").is_str("authenticated"))
    {
        AuthState::Authenticated
    } else if kind.is_some() {
        AuthState::Error
    } else {
        AuthState::Unknown
    };
    let text = |key: &str| -> Result<Option<String>> {
        if unauthenticated {
            return Ok(None);
        }
        Ok(row.get(key).cast_str()?.map(Into::into))
    };
    Ok(Entry {
        provider,
        auth_state,
        account_email: text("accountEmail")?,
        account_label: text("accountLabel")?,
        plan_label: text("subscriptionLabel")?,
        last_updated_at: iso(row.get("lastUpdatedAt"))?,
        error: match &kind {
            Some(kind) if !unauthenticated && !retained_throttle => Some(error(provider, kind)),
            _ => None,
        },
        windows: if kind.is_some() && !retained_throttle {
            Vec::new()
        } else {
            windows
        },
        accounts,
    })
}

/// `_windows(provider, raw)`: Codex-named limits first, provider order kept
/// within each group (the desktop's stable sort).
fn windows(provider: Provider, raw: &Dv) -> Result<Vec<Window>> {
    let rows = raw.maps();
    let mut counts: Vec<(String, u32)> = Vec::new();
    let mut credited: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for priority in [0, 1] {
        for row in rows.iter().filter(|row| sort_key(row) == priority) {
            out.extend(limit_windows(provider, row, &mut counts, &mut credited)?);
        }
    }
    Ok(out)
}

fn name_or_id(row: &DvMap) -> &Dv {
    or(row.get("limitName"), row.get("limitId"))
}

fn sort_key(row: &DvMap) -> u8 {
    let name = match name_or_id(row) {
        Dv::Null => String::new(),
        value => value.dart_string(),
    };
    u8::from(name.to_lowercase() != "codex")
}

/// `_limitWindows`.
fn limit_windows(
    provider: Provider,
    row: &DvMap,
    counts: &mut Vec<(String, u32)>,
    credited: &mut Vec<String>,
) -> Result<Vec<Window>> {
    let codex = provider == Provider::Codex;
    let key = match or(row.get("limitId"), row.get("limitName")) {
        Dv::Null => "default".to_owned(),
        value => value.dart_string(),
    };
    let credits = row.get("credits").object();
    let has_credits = ["usedUsd", "remainingUsd", "totalUsd"]
        .iter()
        .any(|k| credits.get(k).finite().is_some());
    let slots: Vec<&str> = if codex {
        let primary = row.get("primary").is_map();
        let secondary = row.get("secondary").is_map();
        let mut slots = Vec::new();
        if primary {
            slots.push("primary");
        }
        if secondary {
            slots.push("secondary");
        }
        if !primary
            && !secondary
            && (credits.get("usedUsd").finite().is_some()
                || credits.get("remainingUsd").finite().is_some())
        {
            slots.push("balance");
        }
        slots
    } else {
        vec!["primary"]
    };
    let mut out = Vec::new();
    for slot in slots {
        let window = row.get(slot).object();
        let mins = window.get("windowDurationMins").finite();
        let duration = match mins {
            Some(m) if m > 0.0 => Some(m * 60_000.0),
            _ => match row.get("limitId").as_str() {
                Some("five_hour" | "session") => Some(18_000_000.0),
                Some(id) if id.starts_with("seven_day") || id.starts_with("weekly") => {
                    Some(604_800_000.0)
                }
                _ => None,
            },
        };
        let base = match name_or_id(row) {
            Dv::Null => String::new(),
            value => value.dart_string(),
        };
        let suffix = (!base.is_empty() && base.to_lowercase() != "codex").then_some(base);
        let label = if codex {
            if slot == "balance" {
                match row.get("limitName").cast_str()? {
                    Some(name) => WindowLabel::Desktop(name.into()),
                    None => WindowLabel::Credits,
                }
            } else {
                let span = duration_span(mins).unwrap_or(if slot == "primary" {
                    Span::Primary
                } else {
                    Span::Secondary
                });
                WindowLabel::Slot { span, suffix }
            }
        } else {
            match or(row.get("limitName"), row.get("limitId")) {
                Dv::Null => WindowLabel::CurrentWindow,
                value => WindowLabel::Desktop(value.dart_string()),
            }
        };
        let id = format!("{key}-{slot}");
        let count = match counts.iter_mut().find(|(k, _)| *k == id) {
            Some(entry) => {
                entry.1 += 1;
                entry.1
            }
            None => {
                counts.push((id.clone(), 1));
                1
            }
        };
        let include_credits = has_credits && !credited.contains(&key) && {
            credited.push(key.clone());
            true
        };
        let unlimited = window.get("unlimited").is_true();
        out.push(Window {
            id: if count == 1 {
                id
            } else {
                format!("{id}-{count}")
            },
            label,
            unlimited: unlimited.then_some(true),
            used_percent: window.get("usedPercent").finite(),
            resets_at: iso(window.get("resetsAt"))?,
            window_duration_ms: duration,
            credits: include_credits.then(|| Credits {
                unit: if codex {
                    CreditUnit::Credits
                } else {
                    CreditUnit::Usd
                },
                spent: credits.get("usedUsd").finite(),
                remaining: credits.get("remainingUsd").finite(),
                total: credits.get("totalUsd").finite(),
            }),
            spend: match row.get("spend") {
                Dv::Map(spend) => Some(Spend {
                    currency: spend.get("currency").cast_str()?.map(Into::into),
                    is_enabled: spend.get("isEnabled").cast_bool()?,
                    limit: spend.get("limit").cast_num()?,
                    used: spend.get("used").cast_num()?,
                }),
                _ => None,
            },
        });
    }
    Ok(out)
}

/// `_durationLabel(mins)`.
fn duration_span(mins: Option<f64>) -> Option<Span> {
    let mins = mins.filter(|m| *m > 0.0)?;
    // `~/` on whole multiples: exact for the durations a window has.
    #[allow(clippy::cast_possible_truncation)]
    if mins % 1440.0 == 0.0 {
        return Some(Span::Days((mins / 1440.0) as i64));
    }
    #[allow(clippy::cast_possible_truncation)]
    if mins % 60.0 == 0.0 {
        return Some(Span::Hours((mins / 60.0) as i64));
    }
    // `mins % 1 == 0 ? mins.toInt() : mins`.
    Some(Span::Minutes(dart::num_to_string(
        mins,
        mins.fract() == 0.0,
    )))
}

/// `_account(provider, row)`.
fn account(provider: Provider, row: &DvMap) -> Result<Account> {
    let usage_value = row.get("usage");
    let usage = usage_value.object();
    let info = usage.get("errorInfo").object();
    let limits = row.get("limits").maps();
    let status = match row.get("status").cast_required_str()? {
        "active" => AccountStatus::Active,
        "cooling" => AccountStatus::Cooling,
        "error" => AccountStatus::Error,
        "disabled" => AccountStatus::Disabled,
        "refreshing" => AccountStatus::Refreshing,
        "pending" => AccountStatus::Pending,
        _ => return Err(Malformed),
    };
    let plan = if row.get("source").is_str("api-key") {
        Some(PlanLabel::ApiKey)
    } else {
        plan_label(provider, row.get("planType").cast_str()?)
    };
    let usage_source = if usage_value.is_map() {
        Some(match usage.get("source").cast_required_str()? {
            "live" => AccountSource::Live,
            "passive" => AccountSource::Passive,
            _ => return Err(Malformed),
        })
    } else if limits.is_empty() {
        None
    } else {
        Some(AccountSource::Passive)
    };
    let windows = if usage_value.is_map() {
        windows(provider, usage.get("rateLimits"))?
    } else {
        let mut windows = Vec::new();
        for limit in limits {
            let five_hour = limit.get("id").is_str("five-hour");
            windows.push(Window {
                id: limit.get("id").cast_required_str()?.into(),
                label: if five_hour {
                    WindowLabel::FiveHourLimit
                } else {
                    WindowLabel::WeeklyLimit
                },
                unlimited: None,
                used_percent: limit.get("usedPercent").finite(),
                resets_at: iso(limit.get("resetsAt"))?,
                window_duration_ms: Some(if five_hour {
                    18_000_000.0
                } else {
                    604_800_000.0
                }),
                credits: None,
                spend: None,
            });
        }
        windows
    };
    Ok(Account {
        id: row.get("authIndex").cast_required_str()?.into(),
        label: row.get("label").cast_str()?.map(Into::into),
        plan,
        status,
        available_at: iso(row.get("availableAt"))?,
        usage_source,
        last_updated_at: iso(usage.get("lastUpdatedAt"))?,
        retry_at: iso(usage.get("retryAt"))?,
        error: info.get("kind").as_str().map(|kind| error(provider, kind)),
        windows,
    })
}

/// `(?:^|\D)<n>x?(?:\D|$)`: the digits stand alone.
fn standalone(slug: &str, digits: &str) -> bool {
    slug.match_indices(digits).any(|(at, _)| {
        let before = slug[..at].chars().next_back();
        let after = slug[at + digits.len()..].chars().next();
        before.is_none_or(|c| !c.is_ascii_digit()) && after.is_none_or(|c| !c.is_ascii_digit())
    })
}

/// `_planLabel(provider, raw)`.
fn plan_label(provider: Provider, raw: Option<&str>) -> Option<PlanLabel> {
    let lower = raw
        .unwrap_or("")
        .trim_matches(dart::is_space)
        .to_lowercase();
    let mut slug = String::new();
    let mut in_run = false;
    for c in lower.chars() {
        if dart::is_space(c) || c == '_' {
            if !in_run {
                slug.push('-');
            }
            in_run = true;
        } else {
            slug.push(c);
            in_run = false;
        }
    }
    if slug.is_empty() || slug == "unknown" {
        return None;
    }
    if provider == Provider::Claude && slug.contains("max") {
        if standalone(&slug, "20") || slug == "max20x" || slug == "max-20" {
            slug = "max-20x".into();
        } else if standalone(&slug, "5") || slug == "max" || slug == "max5x" || slug == "max-5" {
            slug = "max-5x".into();
        }
    }
    if provider == Provider::Codex && slug == "team" {
        slug = "business".into();
    }
    // Dart spells out `Max 5x`, `Max 20x` and `Team Premium`; each is also
    // the title case of its slug.
    let name = slug
        .split('-')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect(),
                None => String::new(),
            }
        })
        .collect::<Vec<String>>()
        .join(" ");
    Some(PlanLabel::Plan {
        chat_gpt: provider == Provider::Codex,
        name,
    })
}

/// `_hasNewerUsage(before, after, provider)`: `after` carries a successful
/// read of `provider` newer than `before`'s.
pub fn has_newer_usage(
    before: Option<&Projection>,
    after: Option<&Projection>,
    provider: Provider,
) -> bool {
    fn find(p: Option<&Projection>, provider: Provider) -> Option<&Entry> {
        p?.providers.iter().find(|e| e.provider == provider)
    }
    let previous = find(before, provider);
    let Some(next) = find(after, provider) else {
        return false;
    };
    let newer =
        |at: Option<Micros>, old: Option<Micros>| at.is_some_and(|t| old.is_none_or(|o| t > o));
    if let Some(accounts) = &next.accounts {
        return accounts.iter().any(|account| {
            account.error.is_none()
                && newer(
                    account.last_updated_at,
                    previous
                        .and_then(|p| p.accounts.as_ref())
                        .and_then(|rows| rows.iter().find(|row| row.id == account.id))
                        .and_then(|row| row.last_updated_at),
                )
        });
    }
    next.auth_state == AuthState::Authenticated
        && next.error.is_none()
        && newer(
            next.last_updated_at,
            previous.and_then(|p| p.last_updated_at),
        )
}

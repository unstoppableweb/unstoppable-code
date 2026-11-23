//! Provider usage copy, from `lib/device_link/provider_usage/projection.dart`
//! (curated error headlines, window and plan labels) and
//! `computer_connect/provider_usage_source.dart` (the refresh failure).
//! Provider and plan names are the providers' own.
use super::render;
use cc_domain::usage::{ErrorCause, PlanLabel, Provider, Span, UsageError, WindowLabel};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyKey {
    /// A refresh did not deliver newer usage.
    RefreshFailed,
}

pub(crate) fn text(key: CopyKey) -> &'static str {
    match key {
        CopyKey::RefreshFailed => "Couldn't refresh usage. Try again.",
    }
}

fn provider_name(provider: Provider) -> &'static str {
    match provider {
        Provider::Claude => "Claude",
        Provider::Codex => "Codex",
        Provider::Copilot => "Copilot",
    }
}

/// A failed read's headline; raw provider errors can contain secrets.
pub(crate) fn error_message(error: UsageError) -> String {
    let template = match error.cause {
        ErrorCause::Auth => "Sign in to {label} again to see live usage.",
        ErrorCause::Network => "Check your connection, then try reaching {label} again.",
        ErrorCause::Service => "{label} is not answering right now, so try again in a moment.",
        ErrorCause::RateLimited => "{label} is limiting usage checks right now. Try again later.",
        ErrorCause::Unsupported => "This {label} account doesn't expose usage details.",
        ErrorCause::Other => "Try again to load {label} usage.",
    };
    render(template, &[("label", provider_name(error.provider))])
}

fn span(span: &Span) -> String {
    match span {
        Span::Days(n) => render("{n}-day", &[("n", &n.to_string())]),
        Span::Hours(n) => render("{n}-hour", &[("n", &n.to_string())]),
        Span::Minutes(n) => render("{n}-minute", &[("n", n)]),
        Span::Primary => "Primary".into(),
        Span::Secondary => "Secondary".into(),
    }
}

/// A window's label; an unlimited window drops a trailing ` · Unlimited`.
pub(crate) fn window_label(label: &WindowLabel, unlimited: bool) -> String {
    let text = match label {
        WindowLabel::Desktop(text) => text.clone(),
        WindowLabel::CurrentWindow => "Current window".into(),
        WindowLabel::Credits => "Credits".into(),
        WindowLabel::Slot { span: s, suffix } => render(
            "{span} {suffix}",
            &[
                ("span", &span(s)),
                ("suffix", suffix.as_deref().unwrap_or("window")),
            ],
        ),
        WindowLabel::FiveHourLimit => "5-hour limit".into(),
        WindowLabel::WeeklyLimit => "Weekly limit".into(),
    };
    match text.strip_suffix(" · Unlimited") {
        Some(stripped) if unlimited => stripped.to_owned(),
        _ => text,
    }
}

/// A proxy account's plan, for example `Claude Max 20x` or `API key`.
pub(crate) fn plan_label(plan: &PlanLabel) -> String {
    let (chat_gpt, name) = match plan {
        PlanLabel::ApiKey => return "API key".into(),
        PlanLabel::Plan { chat_gpt, name } => (*chat_gpt, name),
    };
    let template = if chat_gpt {
        "ChatGPT {plan}"
    } else {
        "Claude {plan}"
    };
    render(template, &[("plan", name)])
}

//! Composer copy (P5c): the settings catalog and picks, from
//! `device_link/chats/settings.dart`,
//! `computer_connect/{settings_controller,composer_sources}.dart`,
//! `chats_view_model.dart` (`_loadSettings`), `device_link/chats/{composer,
//! forks}.dart`; and the model picker's titles, hints and reasons, from
//! `ui/core/chat/view_models/model_picker_catalog.dart`. The words the
//! shared composer widgets draw themselves stay in Dart.
use cc_domain::composer::picker::{AutoReason, Disabled, Lock, Tab, Title};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyKey {
    /// A settings catalog read failed for a reason the transport does not
    /// word.
    ModelsFailed,
    /// A model pick the catalog does not list.
    RefreshModels,
    /// Auto on a chat that does not route.
    AutoUnavailable,
    /// A refused settings write without words.
    SaveFailed,
    /// An unconfirmed settings write: `{reason}` is the failure's words.
    CheckSelection,
    /// An unconfirmed settings write without words.
    NotConfirmed,
    /// The picker's chat changed while it loaded.
    ChatChangedReopen,
    /// The inventory's harness is not known yet.
    ChoicesNotLoaded,
    /// The inventory's harness changed while it loaded.
    ChatChanged,
    /// A composer catalog call did not succeed.
    ChoicesFailed,
    /// The picker's chat is closed.
    ChatClosed,
    /// The chat's model changed while its selections loaded.
    ModelChanged,
    /// The desktop did not confirm a fork.
    ForkNotConfirmed,
}

pub(crate) fn text(key: CopyKey) -> &'static str {
    match key {
        CopyKey::ModelsFailed => "Couldn't load models from your computer.",
        CopyKey::RefreshModels => "Refresh model choices before selecting a model.",
        CopyKey::AutoUnavailable => "Auto is not available for this chat.",
        CopyKey::SaveFailed => "Couldn't save chat settings. Try again.",
        CopyKey::CheckSelection => "{reason} Check the selection before trying again.",
        CopyKey::NotConfirmed => "The computer did not confirm this change.",
        CopyKey::ChatChangedReopen => "The chat changed. Close the picker and open it again.",
        CopyKey::ChoicesNotLoaded => {
            "Couldn't load chat choices. Try again once the chat has loaded."
        }
        CopyKey::ChatChanged => "The chat changed. Try again.",
        CopyKey::ChoicesFailed => "Couldn't load choices from your computer. Try again.",
        CopyKey::ChatClosed => "The chat is closed. Open another chat.",
        CopyKey::ModelChanged => "The model changed. Close the picker and open it again.",
        CopyKey::ForkNotConfirmed => "The computer did not confirm the fork.",
    }
}

/// `modelLibraryUnlockLabel`.
pub(crate) const UNLOCK_LABEL: &str = "Sign in";

pub(crate) fn render(key: CopyKey, args: &[(&str, &str)]) -> String {
    super::render(text(key), args)
}

/// `ModelPickerTab.label`.
pub(crate) fn tab_label(tab: Tab) -> &'static str {
    match tab {
        Tab::All => "All models",
        Tab::Claude => "Claude",
        Tab::Codex => "Codex",
        Tab::Cursor => "Cursor",
        Tab::Ollama => "Ollama",
        Tab::Other => "Other models",
    }
}

/// `modelVendorLabel` of a trimmed, lowercased vendor.
pub(crate) fn vendor_label(vendor: &str) -> String {
    let known = match vendor {
        "anthropic" | "claude" => Some("Claude"),
        "openai" | "codex" => Some("OpenAI"),
        "ollama" => Some("Ollama"),
        "deepseek" => Some("DeepSeek"),
        "moonshotai" => Some("Moonshot AI"),
        "zai" => Some("Z.ai"),
        "minimax" => Some("MiniMax"),
        "google" => Some("Google"),
        "meta" => Some("Meta"),
        "mistral" => Some("Mistral"),
        "xai" => Some("xAI"),
        "qwen" => Some("Qwen"),
        _ => None,
    };
    if let Some(label) = known {
        return label.into();
    }
    if vendor.is_empty() {
        return "Other".into();
    }
    // `'${normalized[0].toUpperCase()}${normalized.substring(1)}'` in
    // UTF-16 units.
    let units: Vec<u16> = vendor.encode_utf16().collect();
    let first = String::from_utf16_lossy(&units[..1]).to_uppercase();
    format!("{first}{}", String::from_utf16_lossy(&units[1..]))
}

/// `modelProviderLabel`.
pub(crate) fn provider_label(provider: &str) -> &'static str {
    match provider {
        "claude" => "Claude",
        "codex" => "Codex",
        "ollama" => "Ollama",
        "cursor" => "Cursor",
        "opencode" => "OpenCode",
        "copilot" => "GitHub Copilot",
        _ => "Model",
    }
}

/// A section title.
pub(crate) fn title(title: &Title) -> String {
    match title {
        Title::Agents => "Agents".into(),
        Title::Vendor(vendor) => vendor_label(vendor),
        Title::Cursor => "Cursor".into(),
        Title::Ollama => "Ollama".into(),
        Title::OtherModels => "Other models".into(),
        Title::OtherSupported => "Other supported models".into(),
        Title::Tab(tab) => tab_label(*tab).into(),
    }
}

/// `modelRowDisabledReason`'s words.
pub(crate) fn disabled(reason: &Disabled) -> String {
    match reason {
        Disabled::Connect(tab) => super::render(
            "Connect {label} in the desktop app to use it here.",
            &[("label", tab_label(*tab))],
        ),
        Disabled::CopilotNotConnected => {
            "Connect Copilot in the desktop app to use it here.".into()
        }
        Disabled::AgentUnavailable => {
            "This agent is unavailable — its base model is not registered on the desktop app."
                .into()
        }
        Disabled::Locked { locked, harness } => super::render(
            "This chat is running on {locked}. Start a new chat to use {harness} models.",
            &[
                ("locked", provider_label(locked)),
                ("harness", provider_label(harness)),
            ],
        ),
        Disabled::NotSignedIn(provider) => super::render(
            "{provider} is not signed in on the desktop app.",
            &[("provider", provider_label(provider))],
        ),
        Disabled::Unlock(lock) => unlock_hint(*lock).into(),
        Disabled::Unavailable => "This model is unavailable.".into(),
    }
}

/// `modelLibraryUnlockHint`.
pub(crate) fn unlock_hint(lock: Lock) -> &'static str {
    match lock {
        Lock::SignIn => "Unlock with sign-in",
        Lock::SignInThenPurchase => "Unlock with sign-in and a credits purchase",
    }
}

/// The Auto row's reason.
pub(crate) fn auto_reason(reason: AutoReason) -> &'static str {
    match reason {
        AutoReason::CheckingCredits => "Checking credits…",
        AutoReason::RunsOnCredits => "Runs on credits",
        AutoReason::NeedsTwoModels => "Needs two or more models",
    }
}

//! One model catalog row (`ModelOption`, `data/models/chat_message.dart`),
//! an Agent's supported models (`AgentCatalogSelection`,
//! `agent_catalog_selection.dart`) and the host's provider availability
//! (`ProviderAvailability`). Parsed from desktop values with Dart's
//! lenient `fromJson` rules: a field of the wrong type reads as absent.
use crate::chat::trim;
use crate::dart::{Dv, DvMap};

/// `kThinkingLevelOrder`: canonical effort levels, weakest first.
pub const THINKING_LEVEL_ORDER: [&str; 7] =
    ["off", "low", "medium", "high", "xhigh", "max", "ultra"];

/// Execution harnesses an Agent's supported model may name.
const AGENT_HARNESSES: [&str; 6] = [
    "claude",
    "codex",
    "cursor",
    "copilot",
    "opencode",
    "antigravity",
];

/// An ordered `Map<String, V>` with Dart's literal semantics: a repeated
/// key keeps its first position and takes the last value.
pub fn put<V>(pairs: &mut Vec<(String, V)>, key: &str, value: V) {
    match pairs.iter_mut().find(|(k, _)| k == key) {
        Some(entry) => entry.1 = value,
        None => pairs.push((key.to_owned(), value)),
    }
}

/// `map[key]` of an ordered map.
pub fn lookup<'a, V>(pairs: &'a [(String, V)], key: Option<&str>) -> Option<&'a V> {
    let key = key?;
    pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// `AgentCatalogSelection`: absent is an older host; empty is a checked,
/// unsupported combination.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AgentSelection {
    pub preferred_model: Option<String>,
    /// Model id -> the harnesses that run it, in the host's order.
    pub supported_models: Vec<(String, Vec<String>)>,
}

impl AgentSelection {
    /// `AgentCatalogSelection.concrete`.
    pub fn concrete(value: &Dv) -> bool {
        value.as_str().is_some_and(concrete_str)
    }

    /// `AgentCatalogSelection.read`.
    pub fn read(value: &Dv) -> Self {
        let empty = Self::default();
        let Dv::Map(map) = value else {
            return empty;
        };
        let Some(rows) = map.get("supportedModels").elements() else {
            return empty;
        };
        if map.contains_key("preferredModel") && !Self::concrete(map.get("preferredModel")) {
            return empty;
        }
        let mut supported = Vec::new();
        for row in rows {
            let Dv::Map(row) = row else {
                return empty;
            };
            let Some(choices) = row.get("harnesses").elements() else {
                return empty;
            };
            if !Self::concrete(row.get("modelId")) {
                return empty;
            }
            if choices.is_empty()
                || choices
                    .iter()
                    .any(|v| !v.as_str().is_some_and(|h| AGENT_HARNESSES.contains(&h)))
            {
                return empty;
            }
            let harnesses = choices
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            put(
                &mut supported,
                row.get("modelId").as_str().unwrap_or_default(),
                harnesses,
            );
        }
        Self {
            preferred_model: map.get("preferredModel").as_str().map(str::to_owned),
            supported_models: supported,
        }
    }

    /// `supportedModels[model]`.
    pub fn supports(&self, model: Option<&str>) -> Option<&Vec<String>> {
        lookup(&self.supported_models, model)
    }
}

/// `AgentCatalogSelection.concrete` of a string.
pub fn concrete_str(value: &str) -> bool {
    !trim(value).is_empty()
        && value != "auto"
        && value != "default"
        && !value.starts_with("agent_model_")
        && !value.starts_with('$')
}

/// `ModelOption`: one row of the composer's model catalog.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    /// The owning provider (`claude`, `codex`, `ollama`, `cursor`, ...).
    pub provider: String,
    /// `model` or `agent`.
    pub kind: String,
    pub available: bool,
    pub description: Option<String>,
    pub agent_selection: Option<AgentSelection>,
    pub vendor: Option<String>,
    pub extra_charge_only: bool,
    pub extra_charge_message: Option<String>,
    /// Declared levels, exactly as sent; `None` when omitted.
    pub supported_thinking_levels: Option<Vec<String>>,
    /// Legacy levels; `None` when omitted.
    pub thinking_levels: Option<Vec<String>>,
    pub harness_thinking_levels: Vec<(String, Vec<String>)>,
    pub harness_providers: Vec<(String, String)>,
    pub harness_fast_modes: Vec<(String, bool)>,
    pub harness_context_windows: Vec<(String, i64)>,
    pub is_default: bool,
    pub supports_fast_mode: Option<bool>,
    pub show_more_only: bool,
    pub source: Option<String>,
    pub harness: Option<String>,
    pub family: Option<String>,
    pub family_label: Option<String>,
    pub context_window: Option<i64>,
    pub sort_order: Option<f64>,
    pub unavailable_reason: Option<String>,
}

fn string_or_null(value: &Dv) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn bool_or_null(value: &Dv) -> Option<bool> {
    match value {
        Dv::Bool(b) => Some(*b),
        _ => None,
    }
}

/// `_thinkingLevelsFromJson`: known levels of a list; `None` otherwise.
fn levels_from(value: &Dv) -> Option<Vec<String>> {
    let items = value.elements()?;
    Some(
        items
            .into_iter()
            .filter_map(Dv::as_str)
            .filter(|level| THINKING_LEVEL_ORDER.contains(level))
            .map(str::to_owned)
            .collect(),
    )
}

/// The `harnessChoices` maps (`whereType<Map>`).
fn choices(json: &DvMap) -> Vec<&DvMap> {
    match json.get("harnessChoices") {
        Dv::List(items) => items
            .iter()
            .filter_map(|v| match v {
                Dv::Map(m) => Some(m),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

impl ModelOption {
    /// A row with every optional field empty (Dart's constructor defaults).
    pub fn new(id: &str, label: &str, provider: &str, kind: &str, available: bool) -> Self {
        Self {
            id: id.to_owned(),
            label: label.to_owned(),
            provider: provider.to_owned(),
            kind: kind.to_owned(),
            available,
            description: None,
            agent_selection: None,
            vendor: None,
            extra_charge_only: false,
            extra_charge_message: None,
            supported_thinking_levels: None,
            thinking_levels: None,
            harness_thinking_levels: Vec::new(),
            harness_providers: Vec::new(),
            harness_fast_modes: Vec::new(),
            harness_context_windows: Vec::new(),
            is_default: false,
            supports_fast_mode: None,
            show_more_only: false,
            source: None,
            harness: None,
            family: None,
            family_label: None,
            context_window: None,
            sort_order: None,
            unavailable_reason: None,
        }
    }

    /// `ModelOption.fromJson`.
    pub fn from_json(json: &DvMap) -> Self {
        let id = string_or_null(json.get("id")).unwrap_or_default();
        let mut harness_thinking_levels = Vec::new();
        let mut harness_providers = Vec::new();
        let mut harness_fast_modes = Vec::new();
        let mut harness_context_windows = Vec::new();
        for choice in choices(json) {
            if let (Some(harness), Some(levels)) = (
                choice.get("harness").as_str(),
                levels_from(choice.get("supportedThinkingLevels")),
            ) {
                put(&mut harness_thinking_levels, harness, levels);
            }
        }
        for choice in choices(json) {
            if let (Some(harness), Some(provider)) = (
                choice.get("harness").as_str(),
                choice.get("provider").as_str(),
            ) {
                put(&mut harness_providers, harness, provider.to_owned());
            }
        }
        for choice in choices(json) {
            if let (Some(harness), Dv::Bool(fast)) = (
                choice.get("harness").as_str(),
                choice.get("supportsFastMode"),
            ) {
                put(&mut harness_fast_modes, harness, *fast);
            }
        }
        for choice in choices(json) {
            if let (Some(harness), Dv::Int(window)) =
                (choice.get("harness").as_str(), choice.get("contextWindow"))
            {
                put(&mut harness_context_windows, harness, *window);
            }
        }
        Self {
            label: string_or_null(json.get("label")).unwrap_or_else(|| id.clone()),
            provider: string_or_null(json.get("provider")).unwrap_or_default(),
            kind: string_or_null(json.get("kind")).unwrap_or_else(|| "model".into()),
            available: bool_or_null(json.get("available"))
                .unwrap_or_else(|| !json.get("kind").is_str("agent")),
            agent_selection: json
                .contains_key("agentSelection")
                .then(|| AgentSelection::read(json.get("agentSelection"))),
            description: string_or_null(json.get("description")),
            vendor: string_or_null(json.get("vendor")),
            extra_charge_only: bool_or_null(json.get("extraChargeOnly")).unwrap_or(false),
            extra_charge_message: string_or_null(json.get("extraChargeMessage")),
            supported_thinking_levels: levels_from(json.get("supportedThinkingLevels")),
            thinking_levels: levels_from(json.get("thinkingLevels")),
            harness_thinking_levels,
            harness_providers,
            harness_fast_modes,
            harness_context_windows,
            is_default: bool_or_null(json.get("isDefault")).unwrap_or(false),
            supports_fast_mode: bool_or_null(json.get("supportsFastMode")),
            show_more_only: bool_or_null(json.get("showMoreOnly")).unwrap_or(false),
            source: string_or_null(json.get("source")),
            harness: string_or_null(json.get("harness")),
            family: string_or_null(json.get("family")),
            family_label: string_or_null(json.get("familyLabel")),
            // `num value when value.isFinite && value > 0 => value.toInt()`.
            #[allow(clippy::cast_possible_truncation)]
            context_window: json
                .get("contextWindow")
                .finite()
                .filter(|v| *v > 0.0)
                .map(|v| match json.get("contextWindow") {
                    Dv::Int(n) => *n,
                    _ => v.trunc() as i64,
                }),
            sort_order: json.get("sortOrder").finite(),
            unavailable_reason: string_or_null(json.get("unavailableReason")),
            id,
        }
    }

    /// `harness ?? provider`.
    fn own_harness(&self) -> &str {
        self.harness.as_deref().unwrap_or(&self.provider)
    }

    /// `forExecution`: keeps source identity and display facts while
    /// choosing a compatible runtime.
    pub fn for_execution(&self, selection: &str, execution_harness: Option<&str>) -> Self {
        let native = execution_harness.is_none_or(|h| h == self.own_harness());
        Self {
            id: selection.to_owned(),
            provider: if self.provider == "ollama" {
                self.provider.clone()
            } else {
                lookup(&self.harness_providers, execution_harness)
                    .cloned()
                    .or_else(|| execution_harness.map(str::to_owned))
                    .unwrap_or_else(|| self.provider.clone())
            },
            kind: if selection.starts_with("agent_model_") {
                "agent".into()
            } else {
                "model".into()
            },
            supported_thinking_levels: lookup(&self.harness_thinking_levels, execution_harness)
                .cloned()
                .or_else(|| {
                    if native {
                        self.supported_thinking_levels.clone()
                    } else {
                        None
                    }
                }),
            thinking_levels: if native {
                self.thinking_levels.clone()
            } else {
                None
            },
            supports_fast_mode: lookup(&self.harness_fast_modes, execution_harness)
                .copied()
                .or(if native {
                    self.supports_fast_mode
                } else {
                    None
                }),
            harness: execution_harness
                .map(str::to_owned)
                .or_else(|| self.harness.clone()),
            context_window: lookup(&self.harness_context_windows, execution_harness)
                .copied()
                .or(if native { self.context_window } else { None }),
            ..self.clone()
        }
    }
}

/// `ProviderAvailability`: what the host projects of its providers'
/// sign-in; `None` is unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ProviderAvailability {
    pub claude: Option<bool>,
    pub codex: Option<bool>,
    pub ollama: Option<bool>,
    pub cursor: Option<bool>,
    pub copilot: Option<bool>,
}

impl ProviderAvailability {
    /// `ProviderAvailability.fromJson`.
    pub fn from_json(json: &DvMap) -> Self {
        Self {
            claude: bool_or_null(json.get("claude")),
            codex: bool_or_null(json.get("codex")),
            ollama: bool_or_null(json.get("ollama")),
            cursor: bool_or_null(json.get("cursor")),
            copilot: bool_or_null(json.get("copilot")),
        }
    }

    /// `isAvailable`: Claude, Codex and Ollama are optimistic when
    /// unknown; Cursor and Copilot fail closed.
    pub fn is_available(&self, provider: &str) -> bool {
        match provider {
            "claude" => self.claude.unwrap_or(true),
            "codex" => self.codex.unwrap_or(true),
            "ollama" => self.ollama.unwrap_or(true),
            "cursor" => self.cursor.unwrap_or(false),
            "copilot" => self.copilot.unwrap_or(false),
            _ => true,
        }
    }
}

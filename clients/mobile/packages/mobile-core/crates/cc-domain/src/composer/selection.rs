//! How a model selection resolves against the catalog
//! (`data/models/{selection_metadata,agent_model_selection}.dart`), the
//! effort levels it offers (`ui/core/chat/view_models/thinking_levels.dart`)
//! and the effort and speed a composer shows (`composer_effort.dart`).
use super::model::{ModelOption, THINKING_LEVEL_ORDER, concrete_str, lookup};

/// `providerFallbackThinkingLevels`.
pub fn provider_fallback_levels(provider_hint: Option<&str>) -> Vec<String> {
    let levels: &[&str] = match provider_hint {
        Some("unknown" | "cursor" | "copilot" | "opencode") => &[],
        Some("codex") => &["off", "medium", "high", "xhigh"],
        _ => &["off", "medium", "high", "xhigh", "max"],
    };
    levels.iter().map(|l| (*l).to_owned()).collect()
}

/// `^agent_model_[a-z0-9]+(?:_[a-z0-9]+)*$`.
fn agent_id_shape(id: &str) -> bool {
    id.strip_prefix("agent_model_").is_some_and(|rest| {
        rest.split('_').all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
    })
}

/// `selectedAgentId`.
pub fn selected_agent_id(selection: Option<&str>) -> Option<&str> {
    let selection = selection?;
    let (id, model) = match selection.find('@') {
        Some(at) => (&selection[..at], Some(&selection[at + 1..])),
        None => (selection, None),
    };
    if !agent_id_shape(id) {
        return None;
    }
    if let Some(model) = model
        && (model.is_empty() || model == "default" || model.starts_with("agent_model_"))
    {
        return None;
    }
    Some(id)
}

/// `explicitAgentModel`.
pub fn explicit_agent_model(selection: Option<&str>) -> Option<&str> {
    let selection = selection?;
    selected_agent_id(Some(selection))?;
    let at = selection.find('@')?;
    let model = &selection[at + 1..];
    concrete_str(model).then_some(model)
}

/// `ModelSelectionMetadata`.
#[derive(Debug, Clone, PartialEq)]
pub struct Metadata {
    pub agent_row: Option<ModelOption>,
    pub concrete_model_id: Option<String>,
    pub model_row: Option<ModelOption>,
    pub metadata_row: Option<ModelOption>,
    pub execution_harness: Option<String>,
    pub thinking_levels: Vec<String>,
}

/// `resolveModelSelectionMetadata`: describes existing state without
/// requiring current admission or availability.
pub fn resolve_metadata(
    catalog: &[ModelOption],
    selection: Option<&str>,
    execution_harness: Option<&str>,
    provider_hint: Option<&str>,
    default_model_id: Option<&str>,
) -> Metadata {
    let agent_id = selected_agent_id(selection);
    let explicit = agent_id.is_some() && selection.is_some_and(|s| s.contains('@'));
    let agent_row = catalog
        .iter()
        .find(|row| row.kind == "agent" && Some(row.id.as_str()) == agent_id);
    let concrete: Option<String> = if explicit {
        selection.and_then(|s| s.find('@').map(|at| s[at + 1..].to_owned()))
    } else if agent_id.is_some() {
        agent_row
            .and_then(|row| row.agent_selection.as_ref())
            .and_then(|a| a.preferred_model.clone())
    } else {
        selection
            .or(default_model_id)
            .map(str::to_owned)
            .or_else(|| {
                catalog
                    .iter()
                    .find(|row| row.kind == "model" && row.is_default)
                    .map(|row| row.id.clone())
            })
    };
    let model_row = catalog
        .iter()
        .find(|row| row.kind == "model" && Some(row.id.as_str()) == concrete.as_deref());
    let source = model_row.or(if agent_id.is_some() && !explicit {
        agent_row
    } else {
        None
    });
    let support = agent_row
        .and_then(|row| row.agent_selection.as_ref())
        .and_then(|a| a.supports(concrete.as_deref()));
    let base_harness = source.map(|s| s.harness.as_deref().unwrap_or(&s.provider));
    let harness: Option<String> = execution_harness
        .map(str::to_owned)
        .or_else(|| match support {
            None => base_harness.map(str::to_owned),
            Some(list) if base_harness.is_some_and(|b| list.iter().any(|h| h == b)) => {
                base_harness.map(str::to_owned)
            }
            Some(list) => list.first().cloned(),
        });
    let h = harness.as_deref();
    let needs_projection = h != base_harness
        || source.is_some_and(|s| {
            lookup(&s.harness_providers, h).is_some()
                || lookup(&s.harness_thinking_levels, h).is_some()
                || lookup(&s.harness_fast_modes, h).is_some()
                || lookup(&s.harness_context_windows, h).is_some()
        });
    let metadata = if needs_projection {
        source.map(|s| s.for_execution(&s.id, h))
    } else {
        source.cloned()
    };
    let declared = metadata.as_ref().and_then(|m| {
        m.supported_thinking_levels
            .as_ref()
            .or(m.thinking_levels.as_ref())
    });
    let thinking_levels = match declared {
        None => provider_fallback_levels(h.or(provider_hint)),
        Some(declared) => THINKING_LEVEL_ORDER
            .iter()
            .filter(|level| declared.iter().any(|d| d == *level))
            .map(|l| (*l).to_owned())
            .collect(),
    };
    Metadata {
        agent_row: agent_row.cloned(),
        concrete_model_id: concrete,
        model_row: model_row.cloned(),
        metadata_row: metadata,
        execution_harness: harness,
        thinking_levels,
    }
}

/// `effectiveModelOption`.
pub fn effective_model_option(
    catalog: &[ModelOption],
    selection: Option<&str>,
    default_model: Option<&str>,
    execution_harness: Option<&str>,
) -> Option<ModelOption> {
    resolve_metadata(catalog, selection, execution_harness, None, default_model).metadata_row
}

/// `validAgentSelection`.
pub fn valid_agent_selection(catalog: &[ModelOption], selection: Option<&str>) -> bool {
    let Some(selection) = selection else {
        return false;
    };
    let usable = |id: &str| {
        catalog
            .iter()
            .any(|row| row.id == id && row.kind == "model" && row.available)
    };
    let Some(agent_id) = selected_agent_id(Some(selection)) else {
        return usable(selection);
    };
    let Some(agent) = catalog
        .iter()
        .find(|row| row.id == agent_id && row.kind == "agent")
    else {
        return false;
    };
    match explicit_agent_model(Some(selection)) {
        None => {
            if selection.contains('@') {
                return false;
            }
            agent.available
                && agent
                    .agent_selection
                    .as_ref()
                    .is_none_or(|d| d.supports(d.preferred_model.as_deref()).is_some())
        }
        Some(model) => {
            usable(model)
                && agent
                    .agent_selection
                    .as_ref()
                    .is_none_or(|d| d.supports(Some(model)).is_some())
        }
    }
}

/// `selectionModelOption`: a transport choice keeps the canonical route
/// while taking hints from its concrete row.
pub fn selection_model_option(
    catalog: &[ModelOption],
    selection: Option<&str>,
    execution_harness: Option<&str>,
) -> Option<ModelOption> {
    if !valid_agent_selection(catalog, selection) {
        return None;
    }
    let selection = selection?;
    resolve_metadata(catalog, Some(selection), execution_harness, None, None)
        .metadata_row
        .map(|row| row.for_execution(selection, None))
}

/// `resolveThinkingLevels`.
pub fn resolve_thinking_levels(
    catalog: &[ModelOption],
    model_id: Option<&str>,
    provider_hint: Option<&str>,
) -> Vec<String> {
    let selection = model_id.filter(|id| !id.is_empty());
    resolve_metadata(catalog, selection, provider_hint, None, None).thinking_levels
}

/// `clampThinkingLevelTo`: the nearest supported level at or below
/// `level`, else the weakest supported one, else `off`.
pub fn clamp_level(level: &str, supported: &[String]) -> String {
    if supported.iter().any(|s| s == level) {
        return level.to_owned();
    }
    let has = |candidate: &str| supported.iter().any(|s| s == candidate);
    if let Some(ceiling) = THINKING_LEVEL_ORDER.iter().position(|l| *l == level) {
        for candidate in THINKING_LEVEL_ORDER[..ceiling].iter().rev() {
            if has(candidate) {
                return (*candidate).to_owned();
            }
        }
    }
    THINKING_LEVEL_ORDER
        .iter()
        .find(|c| has(c))
        .map_or_else(|| "off".to_owned(), |c| (*c).to_owned())
}

/// `CanopyEffortSpeed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Speed {
    Regular,
    Fast,
    UltraFast,
}

/// `RemoteComposerEffort.speedOf`.
pub fn speed_of(pending_fast: Option<bool>, speed: Option<&str>, fast_mode: Option<bool>) -> Speed {
    match (pending_fast, speed) {
        (_, Some("ultrafast")) => Speed::UltraFast,
        (Some(true), _) => Speed::Fast,
        (Some(false), _) => Speed::Regular,
        (None, Some("fast")) => Speed::Fast,
        (None, Some("standard")) => Speed::Regular,
        _ => {
            if fast_mode.unwrap_or(false) {
                Speed::Fast
            } else {
                Speed::Regular
            }
        }
    }
}

/// `RemoteComposerEffort`: the effort levels and speed one chat shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Effort {
    /// Weakest first; empty when the model does not think.
    pub levels: Vec<String>,
    /// The shown level, clamped to `levels`.
    pub level: String,
    pub speed: Speed,
}

/// `RemoteComposerEffort.resolve`.
pub fn resolve_effort(
    catalog: &[ModelOption],
    model_id: Option<&str>,
    execution_harness: Option<&str>,
    provider_type: Option<&str>,
    level: &str,
    speed: Option<&str>,
    fast_mode: Option<bool>,
) -> Effort {
    let levels =
        resolve_metadata(catalog, model_id, execution_harness, provider_type, None).thinking_levels;
    Effort {
        level: clamp_level(level, &levels),
        levels,
        speed: speed_of(None, speed, fast_mode),
    }
}

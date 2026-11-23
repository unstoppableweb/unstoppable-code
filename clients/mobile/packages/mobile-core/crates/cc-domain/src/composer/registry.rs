//! The model catalog from the desktop's registry (`deviceRegistryModels`,
//! `device_link/chats/model_registry.dart`), the saved default model
//! (`readDeviceDefaultModel`, `default_model.dart`) and the chat's settings
//! catalog read (`DeviceChatSettings._load`, `settings.dart`).
use super::model::{ModelOption, ProviderAvailability, put};
use crate::chat::{ChatRef, Thrown, object};
use crate::dart::{Dv, DvMap};

/// The registry's provider lists, in catalog order.
const PROVIDERS: [&str; 7] = [
    "claude",
    "codex",
    "cursor",
    "copilot",
    "opencode",
    "ollama",
    "aiGatewayModels",
];
const MANAGED: [&str; 5] = ["claude", "codex", "cursor", "copilot", "opencode"];

/// `value as List? ?? const []`.
fn optional_list(value: &Dv) -> Result<Vec<&Dv>, Thrown> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    value.elements().ok_or(Thrown::Cast)
}

/// `a ?? b` over desktop values.
fn or<'a>(a: &'a Dv, b: &'a Dv) -> &'a Dv {
    if a.is_null() { b } else { a }
}

/// `deviceRegistryModels`: display metadata from the registry. A
/// `FormatException` or cast failure is [`Thrown::Cast`].
pub fn registry_models(registry: &DvMap) -> Result<Vec<ModelOption>, Thrown> {
    if !registry.get("claude").is_list() || !registry.get("codex").is_list() {
        return Err(Thrown::Cast);
    }
    let mut assignments: Vec<(String, DvMap)> = Vec::new();
    if let Dv::Map(raw) = registry.get("harnessAssignments") {
        for row in optional_list(raw.get("assignments"))? {
            let row = object(row)?;
            let key = format!(
                "{}/{}",
                row.get("source").dart_string(),
                row.get("modelId").dart_string()
            );
            put(&mut assignments, &key, row.clone());
        }
    }
    let mut rows: Vec<(String, ModelOption)> = Vec::new();
    for provider in PROVIDERS {
        let source = if provider == "aiGatewayModels" {
            "ai-gateway"
        } else {
            provider
        };
        let assignment_source = if MANAGED.contains(&provider) {
            format!("{provider}-managed")
        } else {
            source.to_owned()
        };
        for raw in optional_list(registry.get(provider))? {
            let row = object(raw)?;
            if matches!(row.get("selectable"), Dv::Bool(false)) {
                continue;
            }
            let id = match row.get("id") {
                Dv::Str(id) if !id.is_empty() => id.clone(),
                _ => return Err(Thrown::Cast),
            };
            let assignment = assignments
                .iter()
                .find(|(k, _)| *k == format!("{assignment_source}/{id}"))
                .map(|(_, a)| a);
            let harness = or(
                assignment.map_or(&Dv::Null, |a| a.get("harness")),
                or(
                    row.get("harness"),
                    or(row.get("recommendedHarness"), &Dv::Null),
                ),
            )
            .clone();
            let harness = if harness.is_null() {
                Dv::Str(provider.into())
            } else {
                harness
            };
            let mut json = row.clone();
            json.insert("id".into(), Dv::Str(id.clone()));
            json.insert(
                "provider".into(),
                if provider == "aiGatewayModels" {
                    harness.clone()
                } else {
                    Dv::Str(provider.into())
                },
            );
            json.insert("harness".into(), harness);
            json.insert("source".into(), Dv::Str(source.into()));
            json.insert("kind".into(), Dv::Str("model".into()));
            if !rows.iter().any(|(k, _)| *k == id) {
                rows.push((id, ModelOption::from_json(&json)));
            }
        }
    }
    let aliases = registry.get("aliases");
    for raw in optional_list(registry.get("agents"))? {
        let agent = object(raw)?;
        let base_id = agent.get("baseModel");
        let find = |key: &Dv| {
            key.as_str()
                .and_then(|k| rows.iter().find(|(id, _)| id == k).map(|(_, r)| r.clone()))
        };
        // A default-inheriting Agent requires an owner-specific default
        // lookup; it is never guessed.
        let base = find(base_id).or_else(|| match aliases {
            Dv::Map(aliases) => base_id.as_str().and_then(|b| find(aliases.get(b))),
            _ => None,
        });
        let Some(base) = base else {
            continue;
        };
        let id = match agent.get("id") {
            Dv::Str(id) if !id.is_empty() => id.clone(),
            _ => return Err(Thrown::Cast),
        };
        let label = agent
            .get("name")
            .cast_str()
            .map_err(|_| Thrown::Cast)?
            .map_or_else(|| id.clone(), str::to_owned);
        let unavailable_reason = agent
            .get("unavailableReason")
            .cast_str()
            .map_err(|_| Thrown::Cast)?
            .map(str::to_owned);
        let mut row = ModelOption::new(
            &id,
            &label,
            &base.provider,
            "agent",
            agent.get("available").is_true() && base.available,
        );
        row.harness = base.harness.clone();
        row.supported_thinking_levels = base.supported_thinking_levels.clone();
        row.context_window = base.context_window;
        row.vendor = base.vendor.clone();
        row.unavailable_reason = unavailable_reason;
        put(&mut rows, &id, row);
    }
    Ok(rows.into_iter().map(|(_, r)| r).collect())
}

/// A saved default model and its effort.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedDefault {
    pub model_id: String,
    pub thinking_level: Option<String>,
}

/// The canonical id of `model` through the registry's aliases.
fn canonical(registry: &DvMap, model: &str, non_empty: bool) -> String {
    match registry.get("aliases") {
        Dv::Map(aliases) => match aliases.get(model) {
            Dv::Str(c) if !non_empty || !c.is_empty() => c.clone(),
            _ => model.to_owned(),
        },
        _ => model.to_owned(),
    }
}

/// `readDeviceDefaultModel` for the Orchestrator chat, from
/// `preferences:load`. Any failure is no default.
pub fn orchestrator_default(registry: &DvMap, preferences: &Dv) -> Option<SavedDefault> {
    let preferences = object(preferences).ok()?;
    let model = preferences.get("appAdvisorModel").as_str()?;
    if model.is_empty() {
        return None;
    }
    let thinking_level = preferences
        .get("appAdvisorThinkingLevel")
        .cast_str()
        .ok()?
        .map(str::to_owned);
    Some(SavedDefault {
        model_id: canonical(registry, model, false),
        thinking_level,
    })
}

/// `readDeviceDefaultModel` for a worktree or Cowork chat, from
/// `preferences:load` and `projects:load`. Any failure is no default.
pub fn saved_default(
    registry: &DvMap,
    chat: &ChatRef,
    preferences: &Dv,
    projects: &Dv,
) -> Option<SavedDefault> {
    let preferences = object(preferences).ok()?;
    let projects = object(projects).ok()?;
    let items = optional_list(projects.get("items")).ok()?;
    let project = items.into_iter().find_map(|row| match row {
        Dv::Map(row) if row.get("id").is_str(&chat.project_id) => Some(row),
        _ => None,
    });
    let scope = match project.map(|p| p.get("type")) {
        Some(Dv::Str(t)) if t == "cowork" => "Chat",
        Some(Dv::Str(t)) if t == "single-repo" || t == "multi-repo" => "Worktree",
        _ => return None,
    };
    let provider = preferences.get(&format!("default{scope}Provider"));
    let defaults = preferences.get(&format!("default{scope}ModelByProvider"));
    // `defaults[provider]`: a map lookup by the provider value.
    let selection = match (defaults, provider) {
        (Dv::Map(defaults), Dv::Str(provider)) => defaults.get(provider),
        _ => &Dv::Null,
    };
    let model = selection.get("model").as_str()?;
    if model.is_empty() {
        return None;
    }
    Some(SavedDefault {
        model_id: canonical(registry, model, true),
        thinking_level: selection.get("thinkingLevel").as_str().map(str::to_owned),
    })
}

/// `_projection`: the chat's summary row of a scoped
/// `desktop:session-snapshot`, else the snapshot when it lists models.
/// `None` for anything else (the read is optional).
pub fn chat_projection(chat: &ChatRef, snapshot: &Dv) -> Option<DvMap> {
    let result = object(snapshot).ok()?;
    let summaries = match result.get("chatSummaries") {
        Dv::Null => Vec::new(),
        value => value.elements()?,
    };
    let summary = summaries.into_iter().find_map(|row| match row {
        Dv::Map(row)
            if row.get("scope").is_str("worktree")
                && row.get("workspaceLocalId").is_str(&chat.project_id)
                && row.get("worktreeLocalId").is_str(&chat.worktree_id)
                && row.get("chatId").is_str(&chat.id) =>
        {
            Some(row)
        }
        _ => None,
    });
    match summary {
        Some(row) => Some(row.clone()),
        None if result.get("availableModels").is_list() => Some(result.clone()),
        None => None,
    }
}

/// The settings catalog of one chat (the `DeviceChatSettings` fields
/// `_load` assigns).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Catalog {
    pub models: Vec<ModelOption>,
    pub default_model_id: Option<String>,
    pub default_thinking_level: Option<String>,
    pub provider_availability: Option<ProviderAvailability>,
    pub execution_harness: Option<String>,
    pub model_label: Option<String>,
    pub routing_supported: bool,
    /// `modelHarnessLocked`: `None` when the host omits it.
    pub harness_locked: Option<bool>,
    pub loaded: bool,
}

/// How far `_load` got before it threw: the fields assigned in its order
/// stay assigned.
#[derive(Debug, Clone, PartialEq)]
pub struct Read {
    pub catalog: Catalog,
    pub thrown: Option<Thrown>,
}

/// `_load`'s rows: the projection's `availableModels`, else the
/// registry's. A row without an id or provider fails the read.
pub fn catalog_rows(
    registry: &DvMap,
    projection: Option<&DvMap>,
) -> Result<Vec<ModelOption>, Thrown> {
    let rows = match projection.map(|p| p.get("availableModels")) {
        Some(Dv::List(rows)) => rows
            .iter()
            .map(|row| object(row).map(ModelOption::from_json))
            .collect::<Result<Vec<_>, _>>()?,
        _ => registry_models(registry)?,
    };
    if rows
        .iter()
        .any(|row| row.id.is_empty() || row.provider.is_empty())
    {
        return Err(Thrown::Cast);
    }
    Ok(rows)
}

/// `_load` after its reads, from `previous` (the fields it assigns
/// overwrite them in order).
pub fn apply_catalog(
    mut catalog: Catalog,
    rows: Vec<ModelOption>,
    projection: Option<&DvMap>,
    saved: Option<&SavedDefault>,
) -> Read {
    let default_id = rows
        .iter()
        .find(|row| row.is_default)
        .map(|row| row.id.clone())
        .or_else(|| saved.map(|s| s.model_id.clone()));
    catalog.default_model_id = default_id.filter(|id| rows.iter().any(|row| row.id == *id));
    catalog.default_thinking_level = match (&catalog.default_model_id, saved) {
        (Some(id), Some(saved)) if *id == saved.model_id => saved.thinking_level.clone(),
        _ => None,
    };
    catalog.models = rows;
    let empty = DvMap::new();
    let projection = projection.unwrap_or(&empty);
    catalog.provider_availability = match projection.get("providerAvailability") {
        Dv::Map(map) => Some(ProviderAvailability::from_json(map)),
        _ => None,
    };
    let thrown = |catalog| Read {
        catalog,
        thrown: Some(Thrown::Cast),
    };
    match projection.get("executionHarness").cast_str() {
        Ok(h) => catalog.execution_harness = h.map(str::to_owned),
        Err(_) => return thrown(catalog),
    }
    match projection.get("modelLabel").cast_str() {
        Ok(l) => catalog.model_label = l.map(str::to_owned),
        Err(_) => return thrown(catalog),
    }
    catalog.routing_supported = projection.get("modelRoutingSupported").is_true();
    match projection.get("modelHarnessLocked").cast_bool() {
        Ok(locked) => catalog.harness_locked = locked,
        Err(_) => return thrown(catalog),
    }
    catalog.loaded = true;
    Read {
        catalog,
        thrown: None,
    }
}

//! What the composer's controls show for the selected chat
//! (`deviceComposerControls`, `computer_connect/chat_controls.dart`): the
//! model, its label and catalog, the effort levels and speed, Auto, Plan
//! mode, the catalog status, the captured harness and the harness it locks.
use super::model::{ModelOption, ProviderAvailability};
use super::registry::Catalog;
use super::selection::{Effort, effective_model_option, resolve_effort};
use crate::dart::{Dv, DvMap};

/// `ModelCatalogStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogStatus {
    Absent,
    Loading,
    Loaded,
    Failed,
}

/// The inputs the controls read.
#[derive(Debug, Clone, Copy)]
pub struct Inputs<'a> {
    /// The selected chat's tab with the queued picks applied.
    pub tab: &'a DvMap,
    /// The selected chat's key and project, if any.
    pub chat: Option<(&'a str, &'a str)>,
    pub running: bool,
    /// The catalog and the chat key it was read for.
    pub catalog: &'a Catalog,
    pub catalog_key: Option<&'a str>,
    pub catalog_loading: bool,
    pub catalog_failed: bool,
}

/// `ComposerControlsData`'s facts (its callbacks stay in the host).
#[derive(Debug, Clone, PartialEq)]
pub struct Controls {
    /// The harness the chat runs, as the controls name it.
    pub provider_type: Option<String>,
    pub model_label: Option<String>,
    pub selected_model_id: Option<String>,
    /// The catalog rows for this chat (empty for another chat's catalog).
    pub models: Vec<ModelOption>,
    pub provider_availability: Option<ProviderAvailability>,
    /// `Some(selected)` when Auto is offered.
    pub auto: Option<bool>,
    /// `Some(enabled)` when Plan mode is offered.
    pub plan_mode: Option<bool>,
    pub effort: Effort,
    pub supports_fast_mode: bool,
    pub running: bool,
    pub catalog_status: CatalogStatus,
    /// The captured harness for the current selection, even when unlocked.
    pub execution_harness: Option<String>,
    /// The host runtime's harness, unless the host unlocked the chat.
    pub locked_harness: Option<String>,
}

fn str_of(value: &Dv) -> Option<&str> {
    value.as_str()
}

/// `deviceComposerControls`.
pub fn controls(input: Inputs<'_>) -> Controls {
    let tab = input.tab;
    let key = input.chat.map(|(key, _)| key);
    let scoped = key.is_some() && input.catalog_key == key;
    let settings = input.catalog;
    let models: &[ModelOption] = if scoped { &settings.models } else { &[] };
    let selected = str_of(tab.get("model")).map(str::to_owned).or_else(|| {
        if scoped {
            settings.default_model_id.clone()
        } else {
            None
        }
    });
    let scoped_harness = if scoped {
        settings.execution_harness.as_deref()
    } else {
        None
    };
    let execution_harness = scoped_harness
        .or_else(|| str_of(tab.get("executionHarness")))
        .map(str::to_owned);
    let current = effective_model_option(
        models,
        selected.as_deref(),
        settings.default_model_id.as_deref(),
        execution_harness.as_deref(),
    );
    let harness = execution_harness
        .clone()
        .or_else(|| current.as_ref().and_then(|c| c.harness.clone()))
        .or_else(|| str_of(tab.get("providerType")).map(str::to_owned));
    let config = tab.get("modelConfig");
    let level = str_of(config.get("thinkingLevel"))
        .or_else(|| str_of(tab.get("thinkingLevel")))
        .map(str::to_owned)
        .or_else(|| {
            if scoped && selected.is_some() && selected == settings.default_model_id {
                settings.default_thinking_level.clone()
            } else {
                None
            }
        })
        .unwrap_or_else(|| "off".into());
    let fast_mode = match config.get("fastMode") {
        Dv::Bool(b) => Some(*b),
        _ => match tab.get("codexFastModeEnabled") {
            Dv::Bool(b) => Some(*b),
            _ => None,
        },
    };
    let effort = resolve_effort(
        models,
        selected.as_deref(),
        harness.as_deref(),
        current
            .as_ref()
            .map(|c| c.provider.as_str())
            .or_else(|| str_of(tab.get("providerType"))),
        &level,
        str_of(config.get("speed")),
        fast_mode,
    );
    let plan_harness = matches!(harness.as_deref(), Some("claude" | "codex"));
    Controls {
        provider_type: harness.clone(),
        model_label: current
            .as_ref()
            .map(|c| c.label.clone())
            .or_else(|| {
                if scoped {
                    settings.model_label.clone()
                } else {
                    None
                }
            })
            .or_else(|| selected.clone()),
        selected_model_id: selected,
        models: models.to_vec(),
        provider_availability: if scoped {
            settings.provider_availability
        } else {
            None
        },
        auto: (scoped && settings.routing_supported)
            .then(|| tab.get("modelSelectionMode").is_str("auto")),
        plan_mode: input
            .chat
            .filter(|(_, project)| *project != "app-advisor" && plan_harness)
            .map(|_| tab.get("planMode").is_true()),
        effort,
        supports_fast_mode: harness.as_deref() == Some("codex"),
        running: input.running,
        catalog_status: if input.catalog_loading {
            CatalogStatus::Loading
        } else if input.catalog_failed {
            CatalogStatus::Failed
        } else if settings.loaded {
            CatalogStatus::Loaded
        } else {
            CatalogStatus::Absent
        },
        execution_harness,
        // Explicitly unlocked chats may switch; older hosts keep their lock.
        locked_harness: if settings.harness_locked == Some(false) {
            None
        } else {
            scoped_harness.map(str::to_owned)
        },
    }
}

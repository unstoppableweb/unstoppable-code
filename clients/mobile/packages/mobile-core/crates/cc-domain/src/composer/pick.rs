//! A settings pick's optimistic patch and the command it saves with
//! (`chat_controls.dart`'s `changeSetting` calls and
//! `settings_controller.dart`'s `_merge`).
use super::model::ModelOption;
use crate::dart::{Dv, DvMap};

/// One composer choice.
#[derive(Debug, Clone, PartialEq)]
pub enum Pick {
    /// An effort level.
    Effort(String),
    /// Auto model routing.
    Auto,
    /// Plan mode on or off.
    PlanMode(bool),
    /// A model, as `selectionModelOption` resolved it.
    Model(Box<ModelOption>),
    /// Fast mode on or off.
    Fast(bool),
}

/// How a pick is saved.
#[derive(Debug, Clone, PartialEq)]
pub enum Save {
    /// `chat.patch_tab_settings` with this patch.
    Patch(DvMap),
    /// `selectModel`.
    SelectModel(Box<ModelOption>),
    /// `selectAuto`.
    SelectAuto,
}

fn map(entries: Vec<(&str, Dv)>) -> DvMap {
    let mut out = DvMap::new();
    for (k, v) in entries {
        out.insert(k.to_owned(), v);
    }
    out
}

fn text(value: &str) -> Dv {
    Dv::Str(value.to_owned())
}

/// The patch shown at once.
pub fn optimistic(pick: &Pick) -> DvMap {
    match pick {
        Pick::Effort(level) => map(vec![
            ("thinkingLevel", text(level)),
            (
                "modelConfig",
                Dv::Map(map(vec![("thinkingLevel", text(level))])),
            ),
        ]),
        Pick::Auto => map(vec![("modelSelectionMode", text("auto"))]),
        Pick::PlanMode(enabled) => map(vec![("planMode", Dv::Bool(*enabled))]),
        Pick::Model(choice) => {
            let mut patch = map(vec![
                ("model", text(&choice.id)),
                ("providerType", text(&choice.provider)),
            ]);
            if let Some(harness) = &choice.harness {
                patch.insert("executionHarness".into(), text(harness));
            }
            patch.insert("modelSelectionMode".into(), text("manual"));
            patch
        }
        Pick::Fast(fast) => map(vec![
            ("codexFastModeEnabled", Dv::Bool(*fast)),
            (
                "modelConfig",
                Dv::Map(map(vec![
                    ("speed", text(if *fast { "fast" } else { "standard" })),
                    ("fastMode", Dv::Bool(*fast)),
                ])),
            ),
        ]),
    }
}

/// What the pick saves, from the tab with the picks before it applied.
pub fn save(pick: &Pick, effective: &DvMap) -> Save {
    match pick {
        Pick::Effort(level) => Save::Patch(map(vec![
            ("thinkingLevel", text(level)),
            ("modelConfig", effective.get("modelConfig").clone()),
        ])),
        Pick::Auto => Save::SelectAuto,
        Pick::PlanMode(enabled) => Save::Patch(map(vec![("planMode", Dv::Bool(*enabled))])),
        Pick::Model(choice) => Save::SelectModel(choice.clone()),
        Pick::Fast(fast) => Save::Patch(map(vec![
            ("codexFastModeEnabled", Dv::Bool(*fast)),
            ("modelConfig", effective.get("modelConfig").clone()),
        ])),
    }
}

/// `_merge`: the patch over the tab, `modelConfig` merged key by key.
pub fn merge(tab: &DvMap, patch: &DvMap) -> DvMap {
    let mut out = tab.clone();
    for (key, value) in patch.iter() {
        out.insert(key.to_owned(), value.clone());
    }
    if let Dv::Map(config) = patch.get("modelConfig") {
        let mut merged = match tab.get("modelConfig") {
            Dv::Map(existing) => existing.clone(),
            _ => DvMap::new(),
        };
        for (key, value) in config.iter() {
            merged.insert(key.to_owned(), value.clone());
        }
        out.insert("modelConfig".into(), Dv::Map(merged));
    }
    out
}

/// Whether a failed patch changed the model (`_recordFailure`).
pub fn model_change(patch: &DvMap) -> bool {
    patch.contains_key("model") || patch.contains_key("modelSelectionMode")
}

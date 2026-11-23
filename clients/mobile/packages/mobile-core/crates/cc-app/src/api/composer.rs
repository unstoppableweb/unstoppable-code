//! The selected chat's composer (architecture §3.4, P5c): the settings
//! catalog, the queued picks, the composer controls and the model picker's
//! presentation, the chat's pending questions, and the pure composer rules
//! (slash-command search, model search) the host and the comparison call.
//!
//! The composer rides in [`super::ChatFrame::composer`], sent when it
//! changed for that subscriber. Its intents are [`super::ChatIntent`]
//! variants, queued with the read path's.
use super::ChatRefView;
use crate::chats::{CommandRow, ComposerShown, PickFailure};
use crate::copy::composer as copy;
use cc_domain::{
    chat::ChatState,
    composer::{
        AgentSelection, ModelOption, ProviderAvailability,
        controls::{self, CatalogStatus, Controls, Inputs},
        model::put,
        picker::{self, Routing, Section, Selection, Tab},
        search::{self, Fields},
        selection::Speed,
    },
    dart::{Dv, DvMap},
};
use cc_protocol::dto;

/// A composer pick (`chat_controls.dart`'s `changeSetting` calls).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsPick {
    Effort {
        level: String,
    },
    Auto,
    PlanMode {
        enabled: bool,
    },
    /// The catalog row `id`, run on `execution_harness` (else the chat's
    /// locked harness).
    Model {
        id: String,
        execution_harness: Option<String>,
    },
    Fast {
        fast: bool,
    },
}

/// A composer catalog read (`DeviceComposerSources`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerSource {
    /// `invocable-inventory:load` for the chat's harness.
    Inventory,
    /// The plugin picker's catalog.
    PluginCatalog,
    /// The chat's plugin selections.
    Selections,
}

/// What a composer source captured when the host built it: a read fails
/// when the shown chat no longer matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceScopeView {
    pub chat: ChatRefView,
    pub generation: u64,
    /// The tab's `model` and `executionHarness`, in bridge-form JSON.
    pub model_json: String,
    pub harness_json: String,
}

/// One invocable row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRowView {
    pub name: String,
    pub display_name: Option<String>,
    pub description: String,
    pub entry_id: String,
}

/// A harness choice of a model row.
#[derive(Debug, Clone, PartialEq)]
pub struct HarnessChoiceView {
    pub harness: String,
    pub provider: Option<String>,
    pub thinking_levels: Option<Vec<String>>,
    pub fast_mode: Option<bool>,
    pub context_window: Option<i64>,
}

/// An Agent's supported model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentModelView {
    pub model_id: String,
    pub harnesses: Vec<String>,
}

/// An Agent's supported models (`AgentCatalogSelection`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSelectionView {
    pub preferred_model: Option<String>,
    pub supported_models: Vec<AgentModelView>,
}

/// One model catalog row (`ModelOption`).
#[derive(Debug, Clone, PartialEq)]
pub struct ModelRowView {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub kind: String,
    pub available: bool,
    pub description: Option<String>,
    pub agent_selection: Option<AgentSelectionView>,
    pub vendor: Option<String>,
    pub extra_charge_only: bool,
    pub extra_charge_message: Option<String>,
    pub supported_thinking_levels: Option<Vec<String>>,
    pub thinking_levels: Option<Vec<String>>,
    pub harness_choices: Vec<HarnessChoiceView>,
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

/// The host's provider availability (`None` is unknown).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvailabilityView {
    pub claude: Option<bool>,
    pub codex: Option<bool>,
    pub ollama: Option<bool>,
    pub cursor: Option<bool>,
    pub copilot: Option<bool>,
}

/// `CanopyEffortSpeed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeedView {
    Regular,
    Fast,
    UltraFast,
}

/// `ModelCatalogStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogStatusView {
    Absent,
    Loading,
    Loaded,
    Failed,
}

/// `ModelPickerTab`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickerTabKind {
    All,
    Claude,
    Codex,
    Cursor,
    Ollama,
    Other,
}

/// A picker section: rows by their index in [`PickerView::rows`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickerSectionView {
    pub key: String,
    pub title: String,
    pub rows: Vec<u32>,
    pub legacy: Vec<u32>,
}

/// One picker tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickerTabView {
    pub tab: PickerTabKind,
    pub label: String,
    pub connected: bool,
    pub sections: Vec<PickerSectionView>,
}

/// One picker row's facts.
#[derive(Debug, Clone, PartialEq)]
pub struct PickerRowView {
    pub row: ModelRowView,
    /// Why it cannot be picked, if so.
    pub reason: Option<String>,
    pub context_window: Option<String>,
    pub ai_credits: bool,
    pub unlock_label: Option<String>,
}

/// The Auto row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoRowView {
    pub selected: bool,
    pub reason: Option<String>,
}

/// What the model picker shows when not searching
/// (`model_picker_catalog.dart` over the controls' picker rows).
#[derive(Debug, Clone, PartialEq)]
pub struct PickerView {
    pub rows: Vec<PickerRowView>,
    pub tabs: Vec<PickerTabView>,
    pub auto: Option<AutoRowView>,
}

/// The composer controls (`deviceComposerControls`), without callbacks.
#[derive(Debug, Clone, PartialEq)]
pub struct ControlsView {
    pub provider_type: Option<String>,
    pub model_label: Option<String>,
    pub selected_model_id: Option<String>,
    /// The catalog rows the controls offer (empty for another chat's).
    pub models: Vec<ModelRowView>,
    pub provider_availability: Option<AvailabilityView>,
    /// `Some(selected)` when Auto is offered.
    pub auto: Option<bool>,
    /// `Some(enabled)` when Plan mode is offered.
    pub plan_mode: Option<bool>,
    /// Weakest first; empty hides the effort control.
    pub effort_levels: Vec<String>,
    pub effort_level: String,
    pub speed: SpeedView,
    pub supports_fast_mode: bool,
    pub running: bool,
    pub catalog_status: CatalogStatusView,
    /// The captured harness for the current selection, even when unlocked.
    pub execution_harness: Option<String>,
    pub locked_harness: Option<String>,
    pub picker: PickerView,
}

/// A settings write's failure (`DeviceSettingsFailure`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsFailureView {
    pub message: String,
    /// The desktop refused it (else it is unconfirmed).
    pub reported: bool,
    pub model_change: bool,
}

/// The selected chat's composer.
#[derive(Debug, Clone, PartialEq)]
pub struct ComposerView {
    /// The chat key the catalog was read for (`scopeKey`).
    pub catalog_key: Option<String>,
    pub catalog_loading: bool,
    pub catalog_loaded: bool,
    /// The catalog read's failure (`settingsCatalogError`).
    pub catalog_error: Option<String>,
    pub models: Vec<ModelRowView>,
    pub default_model_id: Option<String>,
    pub default_thinking_level: Option<String>,
    pub provider_availability: Option<AvailabilityView>,
    pub execution_harness: Option<String>,
    pub model_label: Option<String>,
    pub routing_supported: bool,
    /// `None` when the host omits it (the captured harness stays locked).
    pub harness_locked: Option<bool>,
    /// The selected tab with the queued picks applied, in bridge-form
    /// JSON.
    pub tab_json: String,
    pub saving: bool,
    pub refreshing: bool,
    pub failure: Option<SettingsFailureView>,
    /// Bumped by `invocable-inventory:changed`.
    pub inventory_revision: u64,
    pub controls: ControlsView,
}

/// One question of a pending request (`AskUserQuestion`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionItemView {
    pub id: Option<String>,
    pub header: Option<String>,
    pub question: String,
    pub options: Vec<String>,
    pub multi_select: bool,
    pub option_descriptions: Vec<String>,
    pub allow_other: bool,
    pub secret: bool,
}

/// A display-safe answer (`AskUserQuestionAnswer`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionAnswerView {
    pub question_id: Option<String>,
    pub question: String,
    pub selected_options: Vec<String>,
    pub freeform_text: Option<String>,
}

/// A pending question request on the chat (`AskUserQuestionState`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionView {
    pub request_id: String,
    pub tool_use_id: Option<String>,
    pub questions: Vec<QuestionItemView>,
    pub answered: bool,
    pub answers: Vec<QuestionAnswerView>,
}

/// A row for [`search_commands`] (`ComposerSearchFields`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSearchRow {
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub namespace: Option<String>,
    pub member_name: Option<String>,
    pub available: bool,
}

/// [`limit_commands`]'s result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandLimitView {
    pub visible: Vec<u32>,
    pub hidden_count: u32,
}

/// A run of same-group rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRunView {
    pub key: String,
    pub occurrence: u32,
    pub rows: Vec<u32>,
}

// ---- Pure rules ----

fn index(i: usize) -> u32 {
    u32::try_from(i).unwrap_or(u32::MAX)
}

/// `searchComposerItems`: the positions of the matching rows, ranked
/// (every row in order for an empty query).
pub fn search_commands(rows: Vec<CommandSearchRow>, query: String) -> Vec<u32> {
    let fields: Vec<Fields> = rows
        .into_iter()
        .map(|r| Fields {
            name: r.name,
            display_name: r.display_name,
            description: r.description,
            category: r.category,
            namespace: r.namespace,
            member_name: r.member_name,
            available: r.available,
        })
        .collect();
    search::search(&fields, &query)
        .into_iter()
        .map(index)
        .collect()
}

/// `limitSlashResults` over the rows' group keys.
pub fn limit_commands(
    groups: Vec<String>,
    total: Option<u32>,
    per_group: Option<u32>,
) -> CommandLimitView {
    let (visible, hidden) = search::limit(
        &groups,
        total.map(|t| t as usize),
        per_group.map(|g| g as usize),
    );
    CommandLimitView {
        visible: visible.into_iter().map(index).collect(),
        hidden_count: index(hidden),
    }
}

/// `groupContiguousRuns` over the rows' group keys.
pub fn command_runs(groups: Vec<String>) -> Vec<CommandRunView> {
    search::runs(&groups)
        .into_iter()
        .map(|(key, occurrence, rows)| CommandRunView {
            key,
            occurrence: index(occurrence),
            rows: rows.into_iter().map(index).collect(),
        })
        .collect()
}

/// `modelPickerSearch` over `rows`.
pub fn search_models(rows: Vec<ModelRowView>, query: String) -> Vec<PickerSectionView> {
    let rows: Vec<ModelOption> = rows.iter().map(model_option).collect();
    picker::search(&rows, &query)
        .iter()
        .map(section_view)
        .collect()
}

// ---- Conversions ----

pub(crate) fn model_row(m: &ModelOption) -> ModelRowView {
    let mut harnesses: Vec<String> = Vec::new();
    for (h, _) in &m.harness_thinking_levels {
        if !harnesses.contains(h) {
            harnesses.push(h.clone());
        }
    }
    for (h, _) in &m.harness_providers {
        if !harnesses.contains(h) {
            harnesses.push(h.clone());
        }
    }
    for (h, _) in &m.harness_fast_modes {
        if !harnesses.contains(h) {
            harnesses.push(h.clone());
        }
    }
    for (h, _) in &m.harness_context_windows {
        if !harnesses.contains(h) {
            harnesses.push(h.clone());
        }
    }
    ModelRowView {
        id: m.id.clone(),
        label: m.label.clone(),
        provider: m.provider.clone(),
        kind: m.kind.clone(),
        available: m.available,
        description: m.description.clone(),
        agent_selection: m.agent_selection.as_ref().map(|a| AgentSelectionView {
            preferred_model: a.preferred_model.clone(),
            supported_models: a
                .supported_models
                .iter()
                .map(|(model_id, harnesses)| AgentModelView {
                    model_id: model_id.clone(),
                    harnesses: harnesses.clone(),
                })
                .collect(),
        }),
        vendor: m.vendor.clone(),
        extra_charge_only: m.extra_charge_only,
        extra_charge_message: m.extra_charge_message.clone(),
        supported_thinking_levels: m.supported_thinking_levels.clone(),
        thinking_levels: m.thinking_levels.clone(),
        harness_choices: harnesses
            .into_iter()
            .map(|h| HarnessChoiceView {
                provider: m
                    .harness_providers
                    .iter()
                    .find(|(k, _)| *k == h)
                    .map(|(_, v)| v.clone()),
                thinking_levels: m
                    .harness_thinking_levels
                    .iter()
                    .find(|(k, _)| *k == h)
                    .map(|(_, v)| v.clone()),
                fast_mode: m
                    .harness_fast_modes
                    .iter()
                    .find(|(k, _)| *k == h)
                    .map(|(_, v)| *v),
                context_window: m
                    .harness_context_windows
                    .iter()
                    .find(|(k, _)| *k == h)
                    .map(|(_, v)| *v),
                harness: h,
            })
            .collect(),
        is_default: m.is_default,
        supports_fast_mode: m.supports_fast_mode,
        show_more_only: m.show_more_only,
        source: m.source.clone(),
        harness: m.harness.clone(),
        family: m.family.clone(),
        family_label: m.family_label.clone(),
        context_window: m.context_window,
        sort_order: m.sort_order,
        unavailable_reason: m.unavailable_reason.clone(),
    }
}

pub(crate) fn model_option(v: &ModelRowView) -> ModelOption {
    let mut m = ModelOption::new(&v.id, &v.label, &v.provider, &v.kind, v.available);
    m.description = v.description.clone();
    m.agent_selection = v.agent_selection.as_ref().map(|a| AgentSelection {
        preferred_model: a.preferred_model.clone(),
        supported_models: a
            .supported_models
            .iter()
            .map(|s| (s.model_id.clone(), s.harnesses.clone()))
            .collect(),
    });
    m.vendor = v.vendor.clone();
    m.extra_charge_only = v.extra_charge_only;
    m.extra_charge_message = v.extra_charge_message.clone();
    m.supported_thinking_levels = v.supported_thinking_levels.clone();
    m.thinking_levels = v.thinking_levels.clone();
    for c in &v.harness_choices {
        if let Some(levels) = &c.thinking_levels {
            put(&mut m.harness_thinking_levels, &c.harness, levels.clone());
        }
        if let Some(provider) = &c.provider {
            put(&mut m.harness_providers, &c.harness, provider.clone());
        }
        if let Some(fast) = c.fast_mode {
            put(&mut m.harness_fast_modes, &c.harness, fast);
        }
        if let Some(window) = c.context_window {
            put(&mut m.harness_context_windows, &c.harness, window);
        }
    }
    m.is_default = v.is_default;
    m.supports_fast_mode = v.supports_fast_mode;
    m.show_more_only = v.show_more_only;
    m.source = v.source.clone();
    m.harness = v.harness.clone();
    m.family = v.family.clone();
    m.family_label = v.family_label.clone();
    m.context_window = v.context_window;
    m.sort_order = v.sort_order;
    m.unavailable_reason = v.unavailable_reason.clone();
    m
}

fn availability(a: &ProviderAvailability) -> AvailabilityView {
    AvailabilityView {
        claude: a.claude,
        codex: a.codex,
        ollama: a.ollama,
        cursor: a.cursor,
        copilot: a.copilot,
    }
}

fn tab_kind(tab: Tab) -> PickerTabKind {
    match tab {
        Tab::All => PickerTabKind::All,
        Tab::Claude => PickerTabKind::Claude,
        Tab::Codex => PickerTabKind::Codex,
        Tab::Cursor => PickerTabKind::Cursor,
        Tab::Ollama => PickerTabKind::Ollama,
        Tab::Other => PickerTabKind::Other,
    }
}

fn section_view(s: &Section) -> PickerSectionView {
    PickerSectionView {
        key: s.key.clone(),
        title: copy::title(&s.title),
        rows: s.rows.iter().copied().map(index).collect(),
        legacy: s.legacy.iter().copied().map(index).collect(),
    }
}

pub(crate) fn command_row(c: CommandRow) -> CommandRowView {
    CommandRowView {
        name: c.name,
        display_name: c.display_name,
        description: c.description,
        entry_id: c.entry_id,
    }
}

fn failure_view(f: &PickFailure) -> SettingsFailureView {
    SettingsFailureView {
        message: f.message.clone(),
        reported: f.reported,
        model_change: f.model_change,
    }
}

/// The picker over the controls' rows (`ModelPickerSheet._content`, not
/// searching; Auto as the sheet offers it, routing available).
fn picker_view(c: &Controls) -> PickerView {
    let selection = Selection {
        selected: c.selected_model_id.as_deref(),
        execution: c.execution_harness.as_deref(),
        locked: c.locked_harness.as_deref(),
    };
    let rows = picker::picker_models(&c.models, selection);
    let available = c.provider_availability.as_ref();
    let words = |t: &picker::Title| copy::title(t);
    let views = rows
        .iter()
        .map(|row| PickerRowView {
            row: model_row(row),
            reason: picker::disabled_reason(row, available, selection.locked)
                .map(|r| copy::disabled(&r)),
            context_window: picker::format_context_window(row.context_window),
            ai_credits: picker::uses_ai_credits(row),
            unlock_label: picker::Lock::of(row.unavailable_reason.as_deref())
                .map(|_| copy::UNLOCK_LABEL.into()),
        })
        .collect();
    let tabs = picker::tabs(&rows, available)
        .into_iter()
        .map(|tab| PickerTabView {
            tab: tab_kind(tab),
            label: copy::tab_label(tab).into(),
            connected: picker::harness_connected(tab, available),
            sections: picker::sections(&rows, tab, &words)
                .iter()
                .map(section_view)
                .collect(),
        })
        .collect();
    let auto = c.auto.and_then(|selected| {
        picker::auto_row(
            selected,
            Routing::Available,
            &rows,
            available,
            selection.locked,
        )
        .map(|row| AutoRowView {
            selected: row.selected,
            reason: row.reason.map(|r| copy::auto_reason(r).into()),
        })
    });
    PickerView {
        rows: views,
        tabs,
        auto,
    }
}

/// The composer view of `shown` for the selected `state`.
pub(crate) fn composer_view(shown: &ComposerShown, state: Option<&ChatState>) -> ComposerView {
    let key = state.map(|s| s.chat.key());
    let failed = shown.error.is_some();
    let c = controls::controls(Inputs {
        tab: &shown.tab,
        chat: state.map(|s| {
            (
                key.as_deref().unwrap_or_default(),
                s.chat.project_id.as_str(),
            )
        }),
        running: state.is_some_and(ChatState::running),
        catalog: &shown.catalog,
        catalog_key: shown.scope_key.as_deref(),
        catalog_loading: shown.loading,
        catalog_failed: failed,
    });
    let controls = ControlsView {
        provider_type: c.provider_type.clone(),
        model_label: c.model_label.clone(),
        selected_model_id: c.selected_model_id.clone(),
        models: c.models.iter().map(model_row).collect(),
        provider_availability: c.provider_availability.as_ref().map(availability),
        auto: c.auto,
        plan_mode: c.plan_mode,
        effort_levels: c.effort.levels.clone(),
        effort_level: c.effort.level.clone(),
        speed: match c.effort.speed {
            Speed::Regular => SpeedView::Regular,
            Speed::Fast => SpeedView::Fast,
            Speed::UltraFast => SpeedView::UltraFast,
        },
        supports_fast_mode: c.supports_fast_mode,
        running: c.running,
        catalog_status: match c.catalog_status {
            CatalogStatus::Absent => CatalogStatusView::Absent,
            CatalogStatus::Loading => CatalogStatusView::Loading,
            CatalogStatus::Loaded => CatalogStatusView::Loaded,
            CatalogStatus::Failed => CatalogStatusView::Failed,
        },
        execution_harness: c.execution_harness.clone(),
        locked_harness: c.locked_harness.clone(),
        picker: picker_view(&c),
    };
    let catalog = &shown.catalog;
    ComposerView {
        catalog_key: shown.scope_key.clone(),
        catalog_loading: shown.loading,
        catalog_loaded: catalog.loaded,
        catalog_error: shown.error.clone(),
        models: catalog.models.iter().map(model_row).collect(),
        default_model_id: catalog.default_model_id.clone(),
        default_thinking_level: catalog.default_thinking_level.clone(),
        provider_availability: catalog.provider_availability.as_ref().map(availability),
        execution_harness: catalog.execution_harness.clone(),
        model_label: catalog.model_label.clone(),
        routing_supported: catalog.routing_supported,
        harness_locked: catalog.harness_locked,
        tab_json: dto::bridge_map(&shown.tab).to_string(),
        saving: shown.saving,
        refreshing: shown.refreshing,
        failure: shown.failure.as_ref().map(failure_view),
        inventory_revision: shown.inventory_revision,
        controls,
    }
}

fn strings(value: &Dv) -> Vec<String> {
    match value {
        Dv::List(items) => items
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

fn opt_str(value: &Dv) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn maps(value: &Dv) -> Vec<&DvMap> {
    match value {
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

/// `AskUserQuestion.fromJson`.
pub(crate) fn question_item(item: &DvMap) -> QuestionItemView {
    QuestionItemView {
        id: opt_str(item.get("id")),
        header: opt_str(item.get("header")),
        question: opt_str(item.get("question")).unwrap_or_default(),
        options: strings(item.get("options")),
        multi_select: matches!(item.get("multiSelect"), Dv::Bool(true)),
        option_descriptions: strings(item.get("optionDescriptions")),
        allow_other: !matches!(item.get("allowOther"), Dv::Bool(false)),
        secret: matches!(item.get("secret"), Dv::Bool(true)),
    }
}

/// `pendingQuestions(id)`: the chat's unanswered, undismissed requests
/// (`AskUserQuestionState.fromJson`).
pub(crate) fn pending_questions(state: &ChatState) -> Vec<QuestionView> {
    let id = &state.chat.id;
    state
        .scope
        .questions
        .iter()
        .filter(|q| {
            q.get("chatId").is_str(id)
                && q.get("answeredAt").is_null()
                && q.get("dismissedAt").is_null()
        })
        .map(|q| QuestionView {
            request_id: opt_str(q.get("requestId")).unwrap_or_default(),
            tool_use_id: opt_str(q.get("toolUseId")),
            questions: maps(q.get("questions"))
                .into_iter()
                .map(question_item)
                .collect(),
            answered: matches!(q.get("answered"), Dv::Bool(true)),
            answers: maps(q.get("answers"))
                .into_iter()
                .map(|a| QuestionAnswerView {
                    question_id: opt_str(a.get("questionId")),
                    question: opt_str(a.get("question")).unwrap_or_default(),
                    selected_options: strings(a.get("selectedOptions")),
                    freeform_text: opt_str(a.get("freeformText")),
                })
                .collect(),
        })
        .collect()
}

/// A JSON value from the host, in bridge form.
pub(crate) fn host_value(json: &str) -> Dv {
    serde_json::from_str::<serde_json::Value>(json)
        .map(|v| dto::desktop_value(&v))
        .unwrap_or(Dv::Null)
}

//! The selected chat's composer (P5c): the settings catalog, the queued
//! picks, the composer controls and the model picker's presentation, the
//! chat's pending questions, and the pure composer rules (slash-command
//! and model search). The composer rides in `ChatFrame.composer`; its
//! intents are `ChatIntent` variants.
use super::overview::ChatRefView;
use flutter_rust_bridge::frb;

/// The composer's pure search rules (P5c): slash-command search, its
/// limits and runs, and the model picker search. The shared composer
/// widgets still search with the Dart helpers they share with Remote
/// Control; the comparisons check that these agree (C5 switches them).
#[frb(opaque)]
pub struct ComposerSearch;

impl ComposerSearch {
    #[frb(sync)]
    #[allow(clippy::new_without_default)] // A binding constructor.
    pub fn new() -> Self {
        Self
    }
    /// `searchComposerItems`: the positions of the matching rows, ranked
    /// (every row in order for an empty query).
    #[frb(sync)]
    pub fn commands(&self, rows: Vec<CommandSearchRow>, query: String) -> Vec<u32> {
        cc_core::search_commands(rows.into_iter().map(Into::into).collect(), query)
    }
    /// `limitSlashResults` over the rows' group keys.
    #[frb(sync)]
    pub fn limit(
        &self,
        groups: Vec<String>,
        total: Option<u32>,
        per_group: Option<u32>,
    ) -> CommandLimitView {
        cc_core::limit_commands(groups, total, per_group).into()
    }
    /// `groupContiguousRuns` over the rows' group keys.
    #[frb(sync)]
    pub fn runs(&self, groups: Vec<String>) -> Vec<CommandRunView> {
        cc_core::command_runs(groups)
            .into_iter()
            .map(Into::into)
            .collect()
    }
    /// `modelPickerSearch` over `rows`.
    #[frb(sync)]
    pub fn models(&self, rows: Vec<ModelRowView>, query: String) -> Vec<PickerSectionView> {
        cc_core::search_models(rows.into_iter().map(Into::into).collect(), query)
            .into_iter()
            .map(Into::into)
            .collect()
    }
}

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

impl From<cc_core::SettingsPick> for SettingsPick {
    fn from(v: cc_core::SettingsPick) -> Self {
        match v {
            cc_core::SettingsPick::Effort { level } => Self::Effort { level },
            cc_core::SettingsPick::Auto => Self::Auto,
            cc_core::SettingsPick::PlanMode { enabled } => Self::PlanMode { enabled },
            cc_core::SettingsPick::Model {
                id,
                execution_harness,
            } => Self::Model {
                id,
                execution_harness,
            },
            cc_core::SettingsPick::Fast { fast } => Self::Fast { fast },
        }
    }
}

impl From<SettingsPick> for cc_core::SettingsPick {
    fn from(v: SettingsPick) -> Self {
        match v {
            SettingsPick::Effort { level } => Self::Effort { level },
            SettingsPick::Auto => Self::Auto,
            SettingsPick::PlanMode { enabled } => Self::PlanMode { enabled },
            SettingsPick::Model {
                id,
                execution_harness,
            } => Self::Model {
                id,
                execution_harness,
            },
            SettingsPick::Fast { fast } => Self::Fast { fast },
        }
    }
}

impl From<cc_core::ComposerSource> for ComposerSource {
    fn from(v: cc_core::ComposerSource) -> Self {
        match v {
            cc_core::ComposerSource::Inventory => Self::Inventory,
            cc_core::ComposerSource::PluginCatalog => Self::PluginCatalog,
            cc_core::ComposerSource::Selections => Self::Selections,
        }
    }
}

impl From<ComposerSource> for cc_core::ComposerSource {
    fn from(v: ComposerSource) -> Self {
        match v {
            ComposerSource::Inventory => Self::Inventory,
            ComposerSource::PluginCatalog => Self::PluginCatalog,
            ComposerSource::Selections => Self::Selections,
        }
    }
}

impl From<cc_core::SourceScopeView> for SourceScopeView {
    fn from(v: cc_core::SourceScopeView) -> Self {
        Self {
            chat: v.chat.into(),
            generation: v.generation,
            model_json: v.model_json,
            harness_json: v.harness_json,
        }
    }
}

impl From<SourceScopeView> for cc_core::SourceScopeView {
    fn from(v: SourceScopeView) -> Self {
        Self {
            chat: v.chat.into(),
            generation: v.generation,
            model_json: v.model_json,
            harness_json: v.harness_json,
        }
    }
}

impl From<cc_core::CommandRowView> for CommandRowView {
    fn from(v: cc_core::CommandRowView) -> Self {
        Self {
            name: v.name,
            display_name: v.display_name,
            description: v.description,
            entry_id: v.entry_id,
        }
    }
}

impl From<CommandRowView> for cc_core::CommandRowView {
    fn from(v: CommandRowView) -> Self {
        Self {
            name: v.name,
            display_name: v.display_name,
            description: v.description,
            entry_id: v.entry_id,
        }
    }
}

impl From<cc_core::HarnessChoiceView> for HarnessChoiceView {
    fn from(v: cc_core::HarnessChoiceView) -> Self {
        Self {
            harness: v.harness,
            provider: v.provider,
            thinking_levels: v.thinking_levels,
            fast_mode: v.fast_mode,
            context_window: v.context_window,
        }
    }
}

impl From<HarnessChoiceView> for cc_core::HarnessChoiceView {
    fn from(v: HarnessChoiceView) -> Self {
        Self {
            harness: v.harness,
            provider: v.provider,
            thinking_levels: v.thinking_levels,
            fast_mode: v.fast_mode,
            context_window: v.context_window,
        }
    }
}

impl From<cc_core::AgentModelView> for AgentModelView {
    fn from(v: cc_core::AgentModelView) -> Self {
        Self {
            model_id: v.model_id,
            harnesses: v.harnesses,
        }
    }
}

impl From<AgentModelView> for cc_core::AgentModelView {
    fn from(v: AgentModelView) -> Self {
        Self {
            model_id: v.model_id,
            harnesses: v.harnesses,
        }
    }
}

impl From<cc_core::AgentSelectionView> for AgentSelectionView {
    fn from(v: cc_core::AgentSelectionView) -> Self {
        Self {
            preferred_model: v.preferred_model,
            supported_models: v.supported_models.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<AgentSelectionView> for cc_core::AgentSelectionView {
    fn from(v: AgentSelectionView) -> Self {
        Self {
            preferred_model: v.preferred_model,
            supported_models: v.supported_models.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::ModelRowView> for ModelRowView {
    fn from(v: cc_core::ModelRowView) -> Self {
        Self {
            id: v.id,
            label: v.label,
            provider: v.provider,
            kind: v.kind,
            available: v.available,
            description: v.description,
            agent_selection: v.agent_selection.map(Into::into),
            vendor: v.vendor,
            extra_charge_only: v.extra_charge_only,
            extra_charge_message: v.extra_charge_message,
            supported_thinking_levels: v.supported_thinking_levels,
            thinking_levels: v.thinking_levels,
            harness_choices: v.harness_choices.into_iter().map(Into::into).collect(),
            is_default: v.is_default,
            supports_fast_mode: v.supports_fast_mode,
            show_more_only: v.show_more_only,
            source: v.source,
            harness: v.harness,
            family: v.family,
            family_label: v.family_label,
            context_window: v.context_window,
            sort_order: v.sort_order,
            unavailable_reason: v.unavailable_reason,
        }
    }
}

impl From<ModelRowView> for cc_core::ModelRowView {
    fn from(v: ModelRowView) -> Self {
        Self {
            id: v.id,
            label: v.label,
            provider: v.provider,
            kind: v.kind,
            available: v.available,
            description: v.description,
            agent_selection: v.agent_selection.map(Into::into),
            vendor: v.vendor,
            extra_charge_only: v.extra_charge_only,
            extra_charge_message: v.extra_charge_message,
            supported_thinking_levels: v.supported_thinking_levels,
            thinking_levels: v.thinking_levels,
            harness_choices: v.harness_choices.into_iter().map(Into::into).collect(),
            is_default: v.is_default,
            supports_fast_mode: v.supports_fast_mode,
            show_more_only: v.show_more_only,
            source: v.source,
            harness: v.harness,
            family: v.family,
            family_label: v.family_label,
            context_window: v.context_window,
            sort_order: v.sort_order,
            unavailable_reason: v.unavailable_reason,
        }
    }
}

impl From<cc_core::AvailabilityView> for AvailabilityView {
    fn from(v: cc_core::AvailabilityView) -> Self {
        Self {
            claude: v.claude,
            codex: v.codex,
            ollama: v.ollama,
            cursor: v.cursor,
            copilot: v.copilot,
        }
    }
}

impl From<AvailabilityView> for cc_core::AvailabilityView {
    fn from(v: AvailabilityView) -> Self {
        Self {
            claude: v.claude,
            codex: v.codex,
            ollama: v.ollama,
            cursor: v.cursor,
            copilot: v.copilot,
        }
    }
}

impl From<cc_core::SpeedView> for SpeedView {
    fn from(v: cc_core::SpeedView) -> Self {
        match v {
            cc_core::SpeedView::Regular => Self::Regular,
            cc_core::SpeedView::Fast => Self::Fast,
            cc_core::SpeedView::UltraFast => Self::UltraFast,
        }
    }
}

impl From<SpeedView> for cc_core::SpeedView {
    fn from(v: SpeedView) -> Self {
        match v {
            SpeedView::Regular => Self::Regular,
            SpeedView::Fast => Self::Fast,
            SpeedView::UltraFast => Self::UltraFast,
        }
    }
}

impl From<cc_core::CatalogStatusView> for CatalogStatusView {
    fn from(v: cc_core::CatalogStatusView) -> Self {
        match v {
            cc_core::CatalogStatusView::Absent => Self::Absent,
            cc_core::CatalogStatusView::Loading => Self::Loading,
            cc_core::CatalogStatusView::Loaded => Self::Loaded,
            cc_core::CatalogStatusView::Failed => Self::Failed,
        }
    }
}

impl From<CatalogStatusView> for cc_core::CatalogStatusView {
    fn from(v: CatalogStatusView) -> Self {
        match v {
            CatalogStatusView::Absent => Self::Absent,
            CatalogStatusView::Loading => Self::Loading,
            CatalogStatusView::Loaded => Self::Loaded,
            CatalogStatusView::Failed => Self::Failed,
        }
    }
}

impl From<cc_core::PickerTabKind> for PickerTabKind {
    fn from(v: cc_core::PickerTabKind) -> Self {
        match v {
            cc_core::PickerTabKind::All => Self::All,
            cc_core::PickerTabKind::Claude => Self::Claude,
            cc_core::PickerTabKind::Codex => Self::Codex,
            cc_core::PickerTabKind::Cursor => Self::Cursor,
            cc_core::PickerTabKind::Ollama => Self::Ollama,
            cc_core::PickerTabKind::Other => Self::Other,
        }
    }
}

impl From<PickerTabKind> for cc_core::PickerTabKind {
    fn from(v: PickerTabKind) -> Self {
        match v {
            PickerTabKind::All => Self::All,
            PickerTabKind::Claude => Self::Claude,
            PickerTabKind::Codex => Self::Codex,
            PickerTabKind::Cursor => Self::Cursor,
            PickerTabKind::Ollama => Self::Ollama,
            PickerTabKind::Other => Self::Other,
        }
    }
}

impl From<cc_core::PickerSectionView> for PickerSectionView {
    fn from(v: cc_core::PickerSectionView) -> Self {
        Self {
            key: v.key,
            title: v.title,
            rows: v.rows,
            legacy: v.legacy,
        }
    }
}

impl From<PickerSectionView> for cc_core::PickerSectionView {
    fn from(v: PickerSectionView) -> Self {
        Self {
            key: v.key,
            title: v.title,
            rows: v.rows,
            legacy: v.legacy,
        }
    }
}

impl From<cc_core::PickerTabView> for PickerTabView {
    fn from(v: cc_core::PickerTabView) -> Self {
        Self {
            tab: v.tab.into(),
            label: v.label,
            connected: v.connected,
            sections: v.sections.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<PickerTabView> for cc_core::PickerTabView {
    fn from(v: PickerTabView) -> Self {
        Self {
            tab: v.tab.into(),
            label: v.label,
            connected: v.connected,
            sections: v.sections.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::PickerRowView> for PickerRowView {
    fn from(v: cc_core::PickerRowView) -> Self {
        Self {
            row: v.row.into(),
            reason: v.reason,
            context_window: v.context_window,
            ai_credits: v.ai_credits,
            unlock_label: v.unlock_label,
        }
    }
}

impl From<PickerRowView> for cc_core::PickerRowView {
    fn from(v: PickerRowView) -> Self {
        Self {
            row: v.row.into(),
            reason: v.reason,
            context_window: v.context_window,
            ai_credits: v.ai_credits,
            unlock_label: v.unlock_label,
        }
    }
}

impl From<cc_core::AutoRowView> for AutoRowView {
    fn from(v: cc_core::AutoRowView) -> Self {
        Self {
            selected: v.selected,
            reason: v.reason,
        }
    }
}

impl From<AutoRowView> for cc_core::AutoRowView {
    fn from(v: AutoRowView) -> Self {
        Self {
            selected: v.selected,
            reason: v.reason,
        }
    }
}

impl From<cc_core::PickerView> for PickerView {
    fn from(v: cc_core::PickerView) -> Self {
        Self {
            rows: v.rows.into_iter().map(Into::into).collect(),
            tabs: v.tabs.into_iter().map(Into::into).collect(),
            auto: v.auto.map(Into::into),
        }
    }
}

impl From<PickerView> for cc_core::PickerView {
    fn from(v: PickerView) -> Self {
        Self {
            rows: v.rows.into_iter().map(Into::into).collect(),
            tabs: v.tabs.into_iter().map(Into::into).collect(),
            auto: v.auto.map(Into::into),
        }
    }
}

impl From<cc_core::ControlsView> for ControlsView {
    fn from(v: cc_core::ControlsView) -> Self {
        Self {
            provider_type: v.provider_type,
            model_label: v.model_label,
            selected_model_id: v.selected_model_id,
            models: v.models.into_iter().map(Into::into).collect(),
            provider_availability: v.provider_availability.map(Into::into),
            auto: v.auto,
            plan_mode: v.plan_mode,
            effort_levels: v.effort_levels,
            effort_level: v.effort_level,
            speed: v.speed.into(),
            supports_fast_mode: v.supports_fast_mode,
            running: v.running,
            catalog_status: v.catalog_status.into(),
            execution_harness: v.execution_harness,
            locked_harness: v.locked_harness,
            picker: v.picker.into(),
        }
    }
}

impl From<ControlsView> for cc_core::ControlsView {
    fn from(v: ControlsView) -> Self {
        Self {
            provider_type: v.provider_type,
            model_label: v.model_label,
            selected_model_id: v.selected_model_id,
            models: v.models.into_iter().map(Into::into).collect(),
            provider_availability: v.provider_availability.map(Into::into),
            auto: v.auto,
            plan_mode: v.plan_mode,
            effort_levels: v.effort_levels,
            effort_level: v.effort_level,
            speed: v.speed.into(),
            supports_fast_mode: v.supports_fast_mode,
            running: v.running,
            catalog_status: v.catalog_status.into(),
            execution_harness: v.execution_harness,
            locked_harness: v.locked_harness,
            picker: v.picker.into(),
        }
    }
}

impl From<cc_core::SettingsFailureView> for SettingsFailureView {
    fn from(v: cc_core::SettingsFailureView) -> Self {
        Self {
            message: v.message,
            reported: v.reported,
            model_change: v.model_change,
        }
    }
}

impl From<SettingsFailureView> for cc_core::SettingsFailureView {
    fn from(v: SettingsFailureView) -> Self {
        Self {
            message: v.message,
            reported: v.reported,
            model_change: v.model_change,
        }
    }
}

impl From<cc_core::ComposerView> for ComposerView {
    fn from(v: cc_core::ComposerView) -> Self {
        Self {
            catalog_key: v.catalog_key,
            catalog_loading: v.catalog_loading,
            catalog_loaded: v.catalog_loaded,
            catalog_error: v.catalog_error,
            models: v.models.into_iter().map(Into::into).collect(),
            default_model_id: v.default_model_id,
            default_thinking_level: v.default_thinking_level,
            provider_availability: v.provider_availability.map(Into::into),
            execution_harness: v.execution_harness,
            model_label: v.model_label,
            routing_supported: v.routing_supported,
            harness_locked: v.harness_locked,
            tab_json: v.tab_json,
            saving: v.saving,
            refreshing: v.refreshing,
            failure: v.failure.map(Into::into),
            inventory_revision: v.inventory_revision,
            controls: v.controls.into(),
        }
    }
}

impl From<ComposerView> for cc_core::ComposerView {
    fn from(v: ComposerView) -> Self {
        Self {
            catalog_key: v.catalog_key,
            catalog_loading: v.catalog_loading,
            catalog_loaded: v.catalog_loaded,
            catalog_error: v.catalog_error,
            models: v.models.into_iter().map(Into::into).collect(),
            default_model_id: v.default_model_id,
            default_thinking_level: v.default_thinking_level,
            provider_availability: v.provider_availability.map(Into::into),
            execution_harness: v.execution_harness,
            model_label: v.model_label,
            routing_supported: v.routing_supported,
            harness_locked: v.harness_locked,
            tab_json: v.tab_json,
            saving: v.saving,
            refreshing: v.refreshing,
            failure: v.failure.map(Into::into),
            inventory_revision: v.inventory_revision,
            controls: v.controls.into(),
        }
    }
}

impl From<cc_core::QuestionItemView> for QuestionItemView {
    fn from(v: cc_core::QuestionItemView) -> Self {
        Self {
            id: v.id,
            header: v.header,
            question: v.question,
            options: v.options,
            multi_select: v.multi_select,
            option_descriptions: v.option_descriptions,
            allow_other: v.allow_other,
            secret: v.secret,
        }
    }
}

impl From<QuestionItemView> for cc_core::QuestionItemView {
    fn from(v: QuestionItemView) -> Self {
        Self {
            id: v.id,
            header: v.header,
            question: v.question,
            options: v.options,
            multi_select: v.multi_select,
            option_descriptions: v.option_descriptions,
            allow_other: v.allow_other,
            secret: v.secret,
        }
    }
}

impl From<cc_core::QuestionAnswerView> for QuestionAnswerView {
    fn from(v: cc_core::QuestionAnswerView) -> Self {
        Self {
            question_id: v.question_id,
            question: v.question,
            selected_options: v.selected_options,
            freeform_text: v.freeform_text,
        }
    }
}

impl From<QuestionAnswerView> for cc_core::QuestionAnswerView {
    fn from(v: QuestionAnswerView) -> Self {
        Self {
            question_id: v.question_id,
            question: v.question,
            selected_options: v.selected_options,
            freeform_text: v.freeform_text,
        }
    }
}

impl From<cc_core::QuestionView> for QuestionView {
    fn from(v: cc_core::QuestionView) -> Self {
        Self {
            request_id: v.request_id,
            tool_use_id: v.tool_use_id,
            questions: v.questions.into_iter().map(Into::into).collect(),
            answered: v.answered,
            answers: v.answers.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<QuestionView> for cc_core::QuestionView {
    fn from(v: QuestionView) -> Self {
        Self {
            request_id: v.request_id,
            tool_use_id: v.tool_use_id,
            questions: v.questions.into_iter().map(Into::into).collect(),
            answered: v.answered,
            answers: v.answers.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<cc_core::CommandSearchRow> for CommandSearchRow {
    fn from(v: cc_core::CommandSearchRow) -> Self {
        Self {
            name: v.name,
            display_name: v.display_name,
            description: v.description,
            category: v.category,
            namespace: v.namespace,
            member_name: v.member_name,
            available: v.available,
        }
    }
}

impl From<CommandSearchRow> for cc_core::CommandSearchRow {
    fn from(v: CommandSearchRow) -> Self {
        Self {
            name: v.name,
            display_name: v.display_name,
            description: v.description,
            category: v.category,
            namespace: v.namespace,
            member_name: v.member_name,
            available: v.available,
        }
    }
}

impl From<cc_core::CommandLimitView> for CommandLimitView {
    fn from(v: cc_core::CommandLimitView) -> Self {
        Self {
            visible: v.visible,
            hidden_count: v.hidden_count,
        }
    }
}

impl From<CommandLimitView> for cc_core::CommandLimitView {
    fn from(v: CommandLimitView) -> Self {
        Self {
            visible: v.visible,
            hidden_count: v.hidden_count,
        }
    }
}

impl From<cc_core::CommandRunView> for CommandRunView {
    fn from(v: cc_core::CommandRunView) -> Self {
        Self {
            key: v.key,
            occurrence: v.occurrence,
            rows: v.rows,
        }
    }
}

impl From<CommandRunView> for cc_core::CommandRunView {
    fn from(v: CommandRunView) -> Self {
        Self {
            key: v.key,
            occurrence: v.occurrence,
            rows: v.rows,
        }
    }
}

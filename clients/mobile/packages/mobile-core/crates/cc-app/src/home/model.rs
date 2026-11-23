//! One mounted Home composer's choices, ported from
//! `computer_connect/home_model.dart` (`ComputerChatHomeModel`). The model
//! resolves remembered choices against the context's inventory, as the
//! host's controller last showed it, and against the project's launcher
//! options. The store never supplies authorization, paths, model policy or
//! project ownership. The actor (`super`) runs the reads and writes; this
//! module holds the state and Dart's rules, with comments citing them.
use crate::{
    api::{HomeChoicesView, HomeModelView, ModelRowView, ProviderAvailabilityView, model_row},
    copy::home::{CopyKey, text},
};
use cc_domain::{
    composer::{
        model::ModelOption,
        selection::{Effort, effective_model_option, resolve_effort, valid_agent_selection},
    },
    home::{Inventory, remembered_harness},
};

/// The launcher options one read returned, as the model applies them.
pub(crate) struct Options {
    pub(crate) branches_supported: bool,
    pub(crate) branches: Vec<String>,
    pub(crate) default_branch: Option<String>,
    pub(crate) models: Vec<ModelOption>,
    pub(crate) default_model_id: Option<String>,
    pub(crate) default_thinking_level: Option<String>,
    pub(crate) provider_availability: ProviderAvailabilityView,
}

pub(crate) struct Model {
    pub(crate) id: u64,
    pub(crate) context: String,
    pub(crate) inv: Inventory,
    pub(crate) loaded: bool,
    /// `_loadingSaved`: a `load` is reading the saved choices.
    pub(crate) loading_saved: bool,
    choices_valid: bool,
    reload_choices: bool,
    pub(crate) generation: u64,
    pub(crate) c: HomeChoicesView,
    pub(crate) models: Vec<ModelOption>,
    rows: Vec<ModelRowView>,
    provider_availability: Option<ProviderAvailabilityView>,
    options_revision: u64,
    branches: Vec<String>,
    pub(crate) loading: bool,
    branches_supported: bool,
    pub(crate) disposed: bool,
    error: Option<String>,
    pub(crate) save_error: Option<String>,
}

impl Model {
    pub(crate) fn new(id: u64, context: String, inv: Inventory) -> Self {
        Self {
            id,
            context,
            inv,
            loaded: false,
            loading_saved: false,
            choices_valid: false,
            reload_choices: false,
            generation: 0,
            c: HomeChoicesView::default(),
            models: Vec::new(),
            rows: Vec::new(),
            provider_availability: None,
            options_revision: 0,
            branches: Vec::new(),
            // `loading = true` until the first read settles.
            loading: true,
            branches_supported: false,
            disposed: false,
            error: None,
            save_error: None,
        }
    }

    /// `project`: the chosen project, if the context still owns it.
    pub(crate) fn project_kind(&self) -> Option<&str> {
        self.inv
            .project(self.c.project_id.as_deref())
            .map(|p| p.kind.as_str())
    }

    fn has_worktree(&self, id: Option<&str>) -> bool {
        let Some(id) = id else {
            return false;
        };
        self.inv
            .worktrees_of(self.c.project_id.as_deref())
            .any(|w| w.id == id)
    }

    fn selected(&self) -> Option<ModelOption> {
        effective_model_option(
            &self.models,
            self.c.model_id.as_deref(),
            None,
            self.c.execution_harness.as_deref(),
        )
    }

    /// `effort`.
    pub(crate) fn effort(&self) -> Effort {
        let selected = self.selected();
        resolve_effort(
            &self.models,
            self.c.model_id.as_deref(),
            selected.as_ref().and_then(|m| m.harness.as_deref()),
            selected.as_ref().map(|m| m.provider.as_str()),
            self.c.thinking_level.as_deref().unwrap_or("high"),
            None,
            None,
        )
    }

    /// `canStart`.
    pub(crate) fn can_start(&self) -> bool {
        !self.disposed
            && self.inv.active
            && self.error.is_none()
            && !self.loading
            && self.choices_valid
            && self.inv.online
            && !self.inv.scope_pending
            && self.project_kind().is_some()
            && (self.c.worktree_id.is_none() || self.has_worktree(self.c.worktree_id.as_deref()))
    }

    /// What `load` restores from the saved `choices`, once it may (the
    /// caller checked `scopePending` and `online` after the read, against
    /// the inventory as it is then).
    pub(crate) fn restore(&mut self, saved: &HomeChoicesView) {
        self.loaded = true;
        let selected = saved.project_id.as_deref();
        self.c.project_id = match selected {
            Some(id) if self.inv.owns(id) => Some(id.to_owned()),
            _ => self.inv.projects.first().map(|p| p.id.clone()),
        };
        self.c.worktree_id = if self.has_worktree(saved.worktree_id.as_deref()) {
            saved.worktree_id.clone()
        } else {
            None
        };
        self.c.base_branch.clone_from(&saved.base_branch);
        self.c.model_id.clone_from(&saved.model_id);
        self.c
            .execution_harness
            .clone_from(&saved.execution_harness);
        self.c.thinking_level.clone_from(&saved.thinking_level);
    }

    /// What `_inventoryChanged` decides once the inventory is applied.
    pub(crate) fn inventory_changed(&mut self, inv: Inventory) -> Changed {
        self.inv = inv;
        if self.disposed {
            return Changed::Nothing;
        }
        if self.inv.scope_pending || !self.inv.online {
            self.choices_valid = false;
            self.reload_choices = true;
            self.generation += 1;
            self.loading = false;
            return Changed::Nothing;
        }
        if !self.loaded {
            return if self.inv.loading {
                Changed::Nothing
            } else {
                Changed::Load
            };
        }
        // Wait for fresh owner evidence before resolving stale selections.
        if !self.inv.loading {
            if self.c.project_id.is_some() && self.project_kind().is_none() {
                self.choices_valid = false;
                self.c = HomeChoicesView::default();
                self.branches.clear();
                self.set_models(Vec::new(), None);
            } else if self.c.worktree_id.is_some()
                && !self.has_worktree(self.c.worktree_id.as_deref())
            {
                self.c.worktree_id = None;
            }
        }
        if self.reload_choices
            && !self.inv.loading
            && !self.loading
            && self.project_kind().is_some()
        {
            self.reload_choices = false;
            return Changed::Refresh;
        }
        Changed::Nothing
    }

    /// The synchronous start of `refreshChoices`: the generation it runs
    /// under and the project to read, or `None` when it already finished
    /// (no project, offline or pending).
    pub(crate) fn begin_refresh(&mut self) -> (u64, Option<(String, String)>) {
        self.generation += 1;
        let generation = self.generation;
        let target = self
            .inv
            .project(self.c.project_id.as_deref())
            .map(|p| (p.id.clone(), p.kind.clone()));
        self.choices_valid = false;
        self.reload_choices = false;
        self.loading = true;
        self.error = None;
        self.branches.clear();
        self.set_models(Vec::new(), None);
        self.branches_supported = false;
        if target.is_none() || !self.inv.online || self.inv.scope_pending {
            self.finish_refresh(generation);
            return (generation, None);
        }
        (generation, target)
    }

    /// The `finally` of `refreshChoices`.
    fn finish_refresh(&mut self, generation: u64) {
        if !self.disposed && generation == self.generation {
            self.loading = false;
        }
    }

    /// The rest of `refreshChoices`, once the options read of `generation`
    /// for a project of `kind` returned.
    pub(crate) fn apply_options(
        &mut self,
        generation: u64,
        kind: &str,
        result: Result<Options, Option<String>>,
    ) {
        match result {
            Err(message) => {
                if !self.disposed && generation == self.generation {
                    self.error =
                        Some(message.unwrap_or_else(|| text(CopyKey::OptionsFailed).to_owned()));
                }
            }
            Ok(options) => {
                if !(self.disposed
                    || generation != self.generation
                    || !self.inv.online
                    || self.inv.scope_pending)
                {
                    self.apply(kind, options);
                }
            }
        }
        self.finish_refresh(generation);
    }

    fn apply(&mut self, kind: &str, options: Options) {
        // The protocol lists only a reference repository's branches. A
        // shared base is unsafe for multi-repo projects without
        // per-repository evidence.
        self.branches_supported = kind == "single-repo" && options.branches_supported;
        self.branches = if self.branches_supported {
            options.branches
        } else {
            Vec::new()
        };
        let default_branch = if self.branches_supported {
            options.default_branch
        } else {
            None
        };
        if !self.contains_branch(self.c.base_branch.as_deref()) {
            self.c.base_branch = if self.contains_branch(default_branch.as_deref()) {
                default_branch
            } else {
                None
            };
        }
        self.set_models(options.models, Some(options.provider_availability));
        if !valid_agent_selection(&self.models, self.c.model_id.as_deref()) {
            self.c.execution_harness = None;
            let default = options.default_model_id.as_deref();
            self.c.model_id = if self
                .models
                .iter()
                .any(|m| Some(m.id.as_str()) == default && m.available)
            {
                options.default_model_id.clone()
            } else {
                None
            };
            self.c.thinking_level = options.default_thinking_level;
        }
        self.c.execution_harness = remembered_harness(
            &self.models,
            self.c.model_id.as_deref(),
            self.c.execution_harness.as_deref(),
        );
        if self.c.thinking_level.is_some() {
            self.c.thinking_level = Some(self.effort().level);
        }
        self.choices_valid = true;
    }

    fn contains_branch(&self, branch: Option<&str>) -> bool {
        branch.is_some_and(|b| self.branches.iter().any(|x| x == b))
    }

    fn set_models(
        &mut self,
        models: Vec<ModelOption>,
        availability: Option<ProviderAvailabilityView>,
    ) {
        if models == self.models && availability == self.provider_availability {
            return;
        }
        self.rows = models.iter().map(model_row).collect();
        self.models = models;
        self.provider_availability = availability;
        self.options_revision += 1;
    }

    /// `selectProject`: `false` when it changes nothing. Then the caller
    /// refreshes and saves.
    pub(crate) fn select_project(&mut self, id: &str) -> bool {
        if !self.inv.owns(id) || self.c.project_id.as_deref() == Some(id) {
            return false;
        }
        self.c = HomeChoicesView {
            project_id: Some(id.to_owned()),
            ..HomeChoicesView::default()
        };
        true
    }

    /// `selectWorktree`: `false` when it changes nothing; then the caller
    /// saves.
    pub(crate) fn select_worktree(&mut self, id: Option<&str>) -> bool {
        if id.is_some() && !self.has_worktree(id) {
            return false;
        }
        self.c.worktree_id = id.map(str::to_owned);
        true
    }

    pub(crate) fn select_branch(&mut self, id: &str) -> bool {
        if !self.contains_branch(Some(id)) {
            return false;
        }
        self.c.base_branch = Some(id.to_owned());
        true
    }

    pub(crate) fn select_model(&mut self, id: &str, harness: Option<String>) -> bool {
        if !valid_agent_selection(&self.models, Some(id)) {
            return false;
        }
        self.c.model_id = Some(id.to_owned());
        self.c.execution_harness = harness;
        if self.c.thinking_level.is_some() {
            self.c.thinking_level = Some(self.effort().level);
        }
        true
    }

    pub(crate) fn select_effort(&mut self, level: &str) -> bool {
        if !self.effort().levels.iter().any(|l| l == level) {
            return false;
        }
        self.c.thinking_level = Some(level.to_owned());
        true
    }

    /// The save's result (`save`).
    pub(crate) fn saved(&mut self, stored: bool) {
        self.save_error = if stored {
            None
        } else {
            Some(text(CopyKey::ChoicesNotSaved).to_owned())
        };
    }

    pub(crate) fn view(&self) -> HomeModelView {
        let effort = self.effort();
        HomeModelView {
            id: self.id,
            loading: self.loading,
            error: self.error.clone(),
            save_error: self.save_error.clone(),
            choices: self.c.clone(),
            branches_supported: self.branches_supported,
            branches: self.branches.clone(),
            options_revision: self.options_revision,
            models: self.rows.clone(),
            provider_availability: self.provider_availability,
            selected_model: self.selected().as_ref().map(model_row),
            effort_level: effort.level,
            effort_levels: effort.levels,
            can_start: self.can_start(),
        }
    }
}

/// What an inventory change asks of the actor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Changed {
    Nothing,
    /// `unawaited(load())`.
    Load,
    /// `unawaited(refreshChoices())`.
    Refresh,
}

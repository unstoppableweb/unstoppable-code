//! Home's launcher choices (architecture §3.7, P8): the reading rules of
//! `device_link/chats/home_options.dart` that are Home's own (branch
//! targets, runtime statuses, provider availability). The model catalog
//! and the saved default are the chat composer's rules
//! (`composer::registry`, P5c). The app (`cc-app::home`) sends the reads in
//! Dart's order.
use crate::{
    chat::{Thrown, object},
    dart::{Dv, DvMap},
};

/// Branch targets as Home offers them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BranchTargets {
    /// `branchResult?['supported'] == true`.
    pub supported: bool,
    /// Local names, then `origin/<name>` when the branch has a remote ref;
    /// remote-only branches as `origin/<name>`. No duplicates, in order.
    pub branches: Vec<String>,
    /// `origin/<default>` when the default has a remote ref.
    pub default_branch: Option<String>,
}

/// `home:list-branch-targets`'s reply, `None` on a host without it.
pub fn branch_targets(reply: Option<&DvMap>) -> Result<BranchTargets, Thrown> {
    let supported = reply.is_some_and(|r| r.get("supported").is_true());
    // `branchResult?['branches'] as List? ?? const []`.
    let rows: Vec<&DvMap> = match reply.map(|r| r.get("branches")) {
        None | Some(Dv::Null | Dv::Bytes(_)) => Vec::new(),
        Some(Dv::List(items)) => items
            .iter()
            .filter_map(|i| match i {
                Dv::Map(m) => Some(m),
                _ => None,
            })
            .collect(),
        Some(_) => return Err(Thrown::Cast),
    };
    // `branchResult?['defaultBranch'] as String?`.
    let default = match reply.map(|r| r.get("defaultBranch")) {
        None | Some(Dv::Null) => None,
        Some(Dv::Str(s)) => Some(s.clone()),
        Some(_) => return Err(Thrown::Cast),
    };
    let remote_default = default.as_deref().is_some_and(|d| {
        rows.iter()
            .any(|row| row.get("name").is_str(d) && row.get("hasRemoteRef").is_true())
    });
    let mut branches: Vec<String> = Vec::new();
    let mut add = |name: String| {
        if !branches.contains(&name) {
            branches.push(name);
        }
    };
    if supported {
        for row in &rows {
            let Some(name) = row.get("name").as_str() else {
                continue;
            };
            if row.get("isRemote").is_true() {
                add(format!("origin/{name}"));
            } else {
                add(name.to_owned());
                if row.get("hasRemoteRef").is_true() {
                    add(format!("origin/{name}"));
                }
            }
        }
    }
    Ok(BranchTargets {
        supported,
        branches,
        default_branch: match default {
            Some(d) if remote_default => Some(format!("origin/{d}")),
            other => other,
        },
    })
}

/// `_runtimeAvailable`: `None` when the status was not an object.
pub fn runtime_available(status: &Dv) -> Option<bool> {
    let status = object(status).ok()?;
    Some(
        status.get("supported").is_true()
            && status.get("enabled").is_true()
            && status.get("installed").is_true(),
    )
}

/// `ProviderAvailability`: `None` is unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Availability {
    pub claude: Option<bool>,
    pub codex: Option<bool>,
    pub ollama: Option<bool>,
    pub cursor: Option<bool>,
    pub copilot: Option<bool>,
}

/// The projection's `providerAvailability`, with the Cursor and Copilot
/// runtime statuses over it when they were read.
pub fn availability(
    projection: Option<&DvMap>,
    cursor: Option<bool>,
    copilot: Option<bool>,
) -> Availability {
    let source = projection.map(|p| p.get("providerAvailability"));
    let field = |key: &str| match source {
        Some(Dv::Map(m)) => match m.get(key) {
            Dv::Bool(b) => Some(*b),
            _ => None,
        },
        _ => None,
    };
    Availability {
        claude: field("claude"),
        codex: field("codex"),
        ollama: field("ollama"),
        cursor: cursor.or_else(|| field("cursor")),
        copilot: copilot.or_else(|| field("copilot")),
    }
}

/// `_rememberedHarness` (`home_model.dart`): a remembered execution harness
/// must not outlive the catalog support that made it selectable.
pub fn remembered_harness(
    models: &[crate::composer::model::ModelOption],
    selection: Option<&str>,
    harness: Option<&str>,
) -> Option<String> {
    use crate::composer::{model::lookup, selection::resolve_metadata};
    let harness = harness?;
    let metadata = resolve_metadata(models, selection, None, None, None);
    let support = metadata
        .agent_row
        .as_ref()
        .and_then(|row| row.agent_selection.as_ref())
        .and_then(|s| lookup(&s.supported_models, metadata.concrete_model_id.as_deref()));
    if support.is_some_and(|s| !s.iter().any(|h| h == harness)) {
        return None;
    }
    let Some(row) = metadata.model_row else {
        return (Some(harness) == metadata.execution_harness.as_deref())
            .then(|| harness.to_owned());
    };
    let own = row.harness.as_deref().unwrap_or(&row.provider);
    (harness == own || lookup(&row.harness_providers, Some(harness)).is_some())
        .then(|| harness.to_owned())
}

/// What Home's launcher shows of one project the context owns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    pub id: String,
    /// `single-repo`, `multi-repo` or `cowork`.
    pub kind: String,
}

/// One of the context's worktrees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub project_id: String,
    pub id: String,
}

/// What the host's controller showed for one navigation context when it
/// last notified: `controller.active`, `chats.online`, `scopePending`,
/// `loading` and `scopeFor(context)` (empty while pending or inactive).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Inventory {
    pub active: bool,
    pub online: bool,
    pub scope_pending: bool,
    pub loading: bool,
    pub projects: Vec<Project>,
    pub worktrees: Vec<Worktree>,
}

impl Inventory {
    pub fn project(&self, id: Option<&str>) -> Option<&Project> {
        let id = id?;
        self.projects.iter().find(|p| p.id == id)
    }
    /// `worktrees` of `project`, in the controller's order.
    pub fn worktrees_of<'a>(
        &'a self,
        project: Option<&'a str>,
    ) -> impl Iterator<Item = &'a Worktree> {
        self.worktrees
            .iter()
            .filter(move |w| Some(w.project_id.as_str()) == project)
    }
    /// `projects.any((p) => p.id == id)`.
    pub fn owns(&self, id: &str) -> bool {
        self.projects.iter().any(|p| p.id == id)
    }
}

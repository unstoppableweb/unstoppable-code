//! `workspace.dart`: the requested workspace and worktree from a
//! `projects:load` read, and the effective scripts or hooks of each of its
//! sources. Never infers a target from collection order or another
//! computer's ids.
use super::Thrown;
use crate::{
    chat::{link_string, object},
    dart::{Dv, DvMap},
};

/// The selected workspace and worktree rows.
#[derive(Debug, Clone)]
pub struct Workspace {
    pub project: DvMap,
    pub worktree: DvMap,
}

/// Why `readDeviceWorkspace` failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Missing {
    /// A Dart check threw.
    Thrown(Thrown),
    /// "This worktree is no longer available."
    Unavailable,
}

/// The first item of `list` whose `id` is `id`. Items are checked with
/// `deviceLinkObject` up to the match, as Dart's lazy `map().where()`.
fn find<'a>(list: &'a Dv, id: &str) -> Result<Option<&'a DvMap>, Thrown> {
    let items = match list {
        Dv::Null => return Ok(None),
        other => other.elements().ok_or(Thrown::Cast)?,
    };
    for item in items {
        let row = object(item)?;
        if row.get("id").is_str(id) {
            return Ok(Some(row));
        }
    }
    Ok(None)
}

/// `readDeviceWorkspace`, from the `projects:load` reply.
pub fn find_workspace(reply: &Dv, project: &str, worktree: &str) -> Result<Workspace, Missing> {
    let result = object(reply).map_err(Missing::Thrown)?;
    let found = find(result.get("items"), project).map_err(Missing::Thrown)?;
    let row = match found {
        Some(p) => find(p.get("worktrees"), worktree).map_err(Missing::Thrown)?,
        None => None,
    };
    match (found, row) {
        (Some(project), Some(worktree)) => Ok(Workspace {
            project: project.clone(),
            worktree: worktree.clone(),
        }),
        _ => Err(Missing::Unavailable),
    }
}

/// One source of effective scripts or hooks.
#[derive(Debug, Clone)]
pub struct Source {
    /// `project`, `workspace-root` or `workspace-repo`.
    pub target: &'static str,
    pub repo_id: Option<String>,
    pub repo_name: Option<String>,
    /// The source's entries in order (a non-map value has none).
    pub values: Vec<(String, Dv)>,
}

/// `'$target:$name'` or `'$target:$repoId:$name'`.
pub fn source_key(source: &Source, name: &str) -> String {
    match &source.repo_id {
        Some(repo) => format!("{}:{repo}:{name}", source.target),
        None => format!("{}:{name}", source.target),
    }
}

fn entries(value: &Dv) -> Vec<(String, Dv)> {
    match value {
        Dv::Map(map) => map.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect(),
        _ => Vec::new(),
    }
}

/// `deviceEffectiveSources(project, worktreeId, field)`.
pub fn effective_sources(
    project: &DvMap,
    worktree_id: &str,
    field: &str,
) -> Result<Vec<Source>, Thrown> {
    let local = match project.get("worktreeEffective") {
        Dv::Map(effective) => effective.get(worktree_id),
        _ => &Dv::Null,
    };
    let root = match local {
        Dv::Map(local) if local.contains_key(field) => local.get(field),
        _ => project.get(field),
    };
    let multi = project.get("type").is_str("multi-repo");
    let mut sources = vec![Source {
        target: if multi { "workspace-root" } else { "project" },
        repo_id: None,
        repo_name: None,
        values: entries(root),
    }];
    if multi {
        let repos = match project.get("repos") {
            Dv::Null => Vec::new(),
            other => other.elements().ok_or(Thrown::Cast)?,
        };
        for repo in repos {
            let repo = object(repo)?;
            let id = link_string(repo, "id")?.to_owned();
            let name = super::cast_string(repo.get("name"))?;
            let value = match local.get("repos") {
                Dv::Map(local_repos) if local_repos.get(&id).is_map() => {
                    local_repos.get(&id).get(field)
                }
                _ => repo.get(field),
            };
            sources.push(Source {
                target: "workspace-repo",
                repo_id: Some(id),
                repo_name: name,
                values: entries(value),
            });
        }
    }
    Ok(sources)
}

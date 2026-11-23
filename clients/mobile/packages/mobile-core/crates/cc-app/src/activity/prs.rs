//! Pull requests (`DevicePrRepository`): saved and pushed observations,
//! progress feeds, refreshes through `get_actions` and the guarded create
//! and merge calls. Cached observations do not imply fresh action
//! eligibility.
use super::{Actor, DEBOUNCE, Fail, Msg, Outcome, TimerKind, Waiter, key_of};
use crate::{copy::activity::CopyKey, error::Result};
use cc_domain::{
    activity::{
        CreationProgress, MergeProgress, Missing, Observations, PrRepo, action_repo,
        find_workspace, parse_creation, parse_merge, parse_repo,
    },
    chat::{ChatRef, object},
    dart::{Dv, DvMap},
};
use cc_protocol::dto::desktop_value;
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

/// `RemotePrAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PrAction {
    Refresh,
    Create,
    Merge,
}

/// `RemotePrActionIdentity`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PrIdentity {
    pub(crate) base_branch: String,
    pub(crate) head_branch: String,
    pub(crate) pr_number: Option<i64>,
}

/// `RemotePrProgressState`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Progress {
    pub(crate) creation: Option<CreationProgress>,
    pub(crate) merge: Option<MergeProgress>,
}

/// `DevicePrState`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PrState {
    pub(crate) repos: Option<Vec<PrRepo>>,
    pub(crate) busy: bool,
    pub(crate) progress: Option<Progress>,
    pub(crate) error: Option<String>,
}

/// Who waits for a PR operation.
enum Subscriber {
    /// A host caller: the result, the discard marker or the failure.
    Waiter(Waiter),
    /// `_reload`: a failure becomes the worktree's error when the
    /// connection and the worktree's version are unchanged.
    Reload { generation: u64, version: u64 },
}

struct Op {
    key: String,
    project: String,
    worktree: String,
    action: PrAction,
    generation: u64,
    version: u64,
    subscribers: Vec<Subscriber>,
    rows: Vec<Dv>,
}

/// A step of a running operation.
pub(crate) enum Step {
    Workspace(Result<Value>),
    FastRefreshed(Result<Value>),
    Mutated(Result<Value>),
}

#[derive(Default)]
pub(crate) struct Prs {
    pub(crate) states: HashMap<String, Arc<PrState>>,
    observations: Observations,
    branch_names: HashMap<String, Option<String>>,
    reads: HashMap<String, u64>,
    mutations: HashSet<String>,
    versions: HashMap<String, u64>,
    creation_steps: HashMap<String, Vec<DvMap>>,
    merge_steps: HashMap<String, Vec<DvMap>>,
    pub(crate) refresh: Option<u64>,
    ops: HashMap<u64, Op>,
}

impl Prs {
    fn version(&self, key: &str) -> u64 {
        self.versions.get(key).copied().unwrap_or(0)
    }
    fn bump(&mut self, key: &str) {
        *self.versions.entry(key.to_owned()).or_insert(0) += 1;
    }
    fn state(&self, key: &str) -> PrState {
        self.states
            .get(key)
            .map(|s| (**s).clone())
            .unwrap_or_default()
    }
    /// `_forgetPr`.
    fn forget(&mut self, key: &str) {
        self.observations.forget(key);
        self.branch_names.remove(key);
        self.creation_steps.remove(key);
        self.merge_steps.remove(key);
        self.states.insert(
            key.to_owned(),
            Arc::new(PrState {
                repos: Some(Vec::new()),
                ..PrState::default()
            }),
        );
    }
}

impl Actor {
    /// `prs.setConnected`.
    pub(super) fn prs_connected(&mut self, connected: bool) {
        self.prs.reads.clear();
        self.prs.mutations.clear();
        self.prs.refresh = None;
        if connected {
            // Checkouts can be missed offline: rehydrate observations and
            // progress for this connection instead of reusing them.
            self.prs.states.clear();
            self.prs.observations.clear();
            self.prs.branch_names.clear();
            self.prs.creation_steps.clear();
            self.prs.merge_steps.clear();
            self.reload_watched_prs();
        }
    }

    pub(super) fn reload_watched_prs(&mut self) {
        let watched = self.watching.chats();
        for chat in watched {
            self.reload_pr(&chat);
        }
    }

    /// `_reload(ref)`.
    pub(super) fn reload_pr(&mut self, chat: &ChatRef) {
        let key = key_of(chat);
        let subscriber = Subscriber::Reload {
            generation: self.generation,
            version: self.prs.version(&key),
        };
        self.start_pr(chat, PrAction::Refresh, None, None, false, subscriber);
    }

    /// The host's `run(ref, action, ...)`.
    pub(super) fn run_pr(
        &mut self,
        chat: &ChatRef,
        action: PrAction,
        repo_id: Option<String>,
        identity: Option<super::PrIdentity>,
        confirm: bool,
        waiter: Option<Waiter>,
    ) {
        let subscriber = match waiter {
            Some(waiter) => Subscriber::Waiter(waiter),
            // A sent (not requested) action still runs.
            None => Subscriber::Reload {
                generation: u64::MAX,
                version: u64::MAX,
            },
        };
        self.start_pr(chat, action, repo_id, identity, confirm, subscriber);
    }

    fn fail_subscriber(&mut self, key: &str, subscriber: Subscriber, fail: &Fail) {
        match subscriber {
            Subscriber::Waiter(waiter) => {
                self.done.push((waiter, Outcome::Failed(fail.failure())));
            }
            Subscriber::Reload {
                generation,
                version,
            } => {
                if !self.disposed
                    && generation == self.generation
                    && version == self.prs.version(key)
                {
                    let previous = self.prs.state(key);
                    self.prs.states.insert(
                        key.to_owned(),
                        Arc::new(PrState {
                            error: Some(fail.message_or(CopyKey::PrsFailed)),
                            ..previous
                        }),
                    );
                }
            }
        }
    }

    fn start_pr(
        &mut self,
        chat: &ChatRef,
        action: PrAction,
        repo_id: Option<String>,
        identity: Option<super::PrIdentity>,
        confirm: bool,
        subscriber: Subscriber,
    ) {
        let key = key_of(chat);
        if !self.connected || self.disposed {
            return self.fail_subscriber(&key, subscriber, &Fail::link(CopyKey::ConnectFirst));
        }
        if action == PrAction::Refresh {
            if let Some(op) = self.prs.reads.get(&key).copied()
                && let Some(running) = self.prs.ops.get_mut(&op)
            {
                running.subscribers.push(subscriber);
                return;
            }
        } else {
            let invalid = match (&repo_id, &identity) {
                (Some(repo), Some(identity)) => {
                    repo.is_empty() || (action == PrAction::Merge && identity.pr_number.is_none())
                }
                _ => true,
            };
            if invalid {
                return self.fail_subscriber(
                    &key,
                    subscriber,
                    &Fail::link(CopyKey::SelectRepository),
                );
            }
            if !self.prs.mutations.insert(key.clone()) {
                return self.fail_subscriber(
                    &key,
                    subscriber,
                    &Fail::link(CopyKey::PrActionRunning),
                );
            }
        }
        let op = self.next_op();
        self.prs.ops.insert(
            op,
            Op {
                key: key.clone(),
                project: chat.project_id.clone(),
                worktree: chat.worktree_id.clone(),
                action,
                generation: self.generation,
                version: self.prs.version(&key),
                subscribers: vec![subscriber],
                rows: Vec::new(),
            },
        );
        let (project, worktree) = (chat.project_id.clone(), chat.worktree_id.clone());
        if action == PrAction::Refresh {
            self.prs.reads.insert(key, op);
            self.spawn(move |inner, computer, _| async move {
                let result =
                    super::flows::call(&inner, &computer, "projects:load", Vec::new()).await;
                Msg::Pr(op, Step::Workspace(result))
            });
            return;
        }
        let mut args = Map::new();
        args.insert("projectId".into(), json!(project));
        args.insert("worktreeId".into(), json!(worktree));
        if let Some(repo) = &repo_id {
            args.insert("repoIds".into(), json!([repo]));
        }
        if let Some(identity) = &identity {
            args.insert("expectedBaseBranch".into(), json!(identity.base_branch));
            args.insert("expectedHeadBranch".into(), json!(identity.head_branch));
            if let Some(number) = identity.pr_number {
                args.insert("expectedPrNumber".into(), json!(number));
            }
        }
        if action == PrAction::Merge {
            args.insert("confirmUnresolvedComments".into(), json!(confirm));
        }
        let channel = if action == PrAction::Create {
            "github:create-pr"
        } else {
            "github:merge-pr"
        };
        self.spawn(move |inner, computer, _| async move {
            let result =
                super::flows::call(&inner, &computer, channel, vec![Value::Object(args)]).await;
            Msg::Pr(op, Step::Mutated(result))
        });
    }

    pub(super) fn pr_step(&mut self, op: u64, step: Step) {
        match step {
            Step::Workspace(result) => match result {
                Err(error) => self.finish_pr(op, Err(Fail::rpc(&error))),
                Ok(reply) => self.pr_workspace(op, &desktop_value(&reply)),
            },
            Step::FastRefreshed(result) => match result {
                Err(error) => self.finish_pr(op, Err(Fail::rpc(&error))),
                Ok(_) => {
                    let rows = self
                        .prs
                        .ops
                        .get_mut(&op)
                        .map(|o| std::mem::take(&mut o.rows))
                        .unwrap_or_default();
                    let mut result = DvMap::new();
                    result.insert("busy".into(), Dv::Bool(false));
                    result.insert("repos".into(), Dv::List(rows));
                    self.continue_pr(op, &Dv::Map(result));
                }
            },
            Step::Mutated(result) => match result {
                Err(error) => self.finish_pr(op, Err(Fail::rpc(&error))),
                Ok(reply) => self.continue_pr(op, &desktop_value(&reply)),
            },
        }
    }

    /// `_invoke`'s `get_actions` after its `projects:load`.
    fn pr_workspace(&mut self, op: u64, reply: &Dv) {
        let Some(running) = self.prs.ops.get(&op) else {
            return;
        };
        let (key, generation, version) = (running.key.clone(), running.generation, running.version);
        let (project, worktree) = (running.project.clone(), running.worktree.clone());
        let workspace = match find_workspace(reply, &project, &worktree) {
            Ok(workspace) => workspace,
            Err(Missing::Thrown(thrown)) => return self.finish_pr(op, Err(Fail::thrown(thrown))),
            Err(Missing::Unavailable) => {
                return self.finish_pr(op, Err(Fail::link(CopyKey::WorktreeGone)));
            }
        };
        if self.disposed
            || !self.connected
            || generation != self.generation
            || version != self.prs.version(&key)
        {
            return self.finish_pr(op, Ok(None));
        }
        let worktree_row = &workspace.worktree;
        let branch = match worktree_row.get("branchName").cast_str() {
            Ok(branch) => branch.map(str::to_owned),
            Err(_) => return self.finish_pr(op, Err(Fail::Other)),
        };
        if self
            .prs
            .branch_names
            .get(&key)
            .is_some_and(|known| *known != branch)
        {
            self.prs.forget(&key);
        }
        self.prs.branch_names.insert(key.clone(), branch);
        let saved =
            match self
                .prs
                .observations
                .observe(&key, worktree_row.get("lastKnownPrStatus"), false)
            {
                Ok(saved) => saved,
                Err(thrown) => return self.finish_pr(op, Err(Fail::thrown(thrown))),
            };
        let mut rows = Vec::new();
        for raw in saved
            .as_ref()
            .map(|s| s.get("repos"))
            .map_or(Vec::new(), |r| r.elements().unwrap_or_default())
        {
            let Dv::Map(raw) = raw else {
                continue;
            };
            let tracked = match (
                worktree_row.get("trackedRepoBaseBranches"),
                raw.get("repoId"),
            ) {
                (Dv::Map(branches), Dv::Str(repo)) => branches.get(repo).clone(),
                _ => Dv::Null,
            };
            let base =
                cc_domain::dart::value::or(&tracked, worktree_row.get("trackedBaseBranch")).clone();
            let head = worktree_row.get("branchName").clone();
            match action_repo(raw, Some((base, head))) {
                Ok(row) => rows.push(Dv::Map(row)),
                Err(thrown) => return self.finish_pr(op, Err(Fail::thrown(thrown))),
            }
        }
        if let Some(running) = self.prs.ops.get_mut(&op) {
            running.rows = rows;
        }
        // Establish branch identity before a fast refresh can push a
        // partial observation.
        self.spawn(move |inner, computer, _| async move {
            let result = super::flows::call(
                &inner,
                &computer,
                "github:request-fast-refresh",
                vec![json!({"projectId": project, "worktreeId": worktree})],
            )
            .await;
            Msg::Pr(op, Step::FastRefreshed(result))
        });
    }

    /// `_run` after `_invoke`.
    fn continue_pr(&mut self, op: u64, result: &Dv) {
        let Some(running) = self.prs.ops.get(&op) else {
            return;
        };
        let (key, action, generation, version) = (
            running.key.clone(),
            running.action,
            running.generation,
            running.version,
        );
        let result = match object(result) {
            Ok(result) => result.clone(),
            Err(thrown) => return self.finish_pr(op, Err(Fail::thrown(thrown))),
        };
        if self.disposed
            || !self.connected
            || generation != self.generation
            || (action == PrAction::Refresh && version != self.prs.version(&key))
        {
            return self.finish_pr(op, Ok(None));
        }
        if action == PrAction::Refresh {
            let (Dv::List(rows), Dv::Bool(busy)) = (result.get("repos"), result.get("busy")) else {
                return self.finish_pr(op, Err(Fail::link(CopyKey::InvalidPrState)));
            };
            let repository = crate::copy::activity::text(CopyKey::RepositoryFallback);
            let mut repos = Vec::new();
            for raw in rows {
                match object(raw).and_then(|row| parse_repo(row, repository)) {
                    Ok(repo) => repos.push(repo),
                    Err(thrown) => return self.finish_pr(op, Err(Fail::thrown(thrown))),
                }
            }
            let progress = self.prs.state(&key).progress;
            self.prs.states.insert(
                key,
                Arc::new(PrState {
                    repos: Some(repos),
                    busy: *busy,
                    progress,
                    error: None,
                }),
            );
        }
        self.finish_pr(op, Ok(Some(Dv::Map(result))));
    }

    /// The operation's end: `None` is the discard marker.
    fn finish_pr(&mut self, op: u64, outcome: std::result::Result<Option<Dv>, Fail>) {
        let Some(running) = self.prs.ops.remove(&op) else {
            return;
        };
        let key = running.key.clone();
        if running.action == PrAction::Refresh {
            if self.prs.reads.get(&key) == Some(&op) {
                self.prs.reads.remove(&key);
            }
        } else if running.generation == self.generation {
            self.prs.mutations.remove(&key);
        }
        for subscriber in running.subscribers {
            match (&outcome, subscriber) {
                (Err(fail), subscriber) => self.fail_subscriber(&key, subscriber, fail),
                (Ok(result), Subscriber::Waiter(waiter)) => self.done.push((
                    waiter,
                    match result {
                        Some(result) => Outcome::Result(result.clone()),
                        None => Outcome::Discarded,
                    },
                )),
                (Ok(_), Subscriber::Reload { .. }) => {}
            }
        }
    }

    /// `DevicePrRepository._event`.
    pub(super) fn pr_push(&mut self, channel: &str, payload: &Dv) {
        if !self.connected || self.disposed {
            return;
        }
        let Some(args) = payload.get("args").elements() else {
            return;
        };
        let Some(Dv::Map(row)) = args.first().copied() else {
            return;
        };
        let key = format!(
            "{}/{}",
            row.get("projectId").dart_string(),
            row.get("worktreeId").dart_string()
        );
        let watched = self.watching.get(&key).cloned();
        if channel == "worktree:branch-changed" {
            if !matches!(row.get("branchName"), Dv::Str(_))
                || (watched.is_none() && !self.prs.states.contains_key(&key))
            {
                return;
            }
            // A checkout also invalidates a multi-repo worktree's PRs.
            self.prs.bump(&key);
            self.prs.reads.remove(&key);
            self.prs.forget(&key);
            if let Some(chat) = watched {
                self.reload_pr(&chat);
            }
            return;
        }
        if watched.is_none() {
            return;
        }
        self.prs.bump(&key);
        if channel == "github:pr-status-event" {
            // A live null is a confirmed clear.
            let observed = if row.get("status").is_null() {
                Some(self.prs.observations.confirm_clear(&key))
            } else {
                match self.prs.observations.observe(&key, row.get("status"), true) {
                    Ok(observed) => observed,
                    // Dart threw in the listener.
                    Err(_) => return,
                }
            };
            let Some(observed) = observed else {
                return;
            };
            let repository = crate::copy::activity::text(CopyKey::RepositoryFallback);
            let mut repos = Vec::new();
            for raw in observed.get("repos").elements().unwrap_or_default() {
                let Dv::Map(raw) = raw else {
                    continue;
                };
                match action_repo(raw, None).and_then(|row| parse_repo(&row, repository)) {
                    Ok(repo) => repos.push(repo),
                    Err(_) => return,
                }
            }
            let previous = self.prs.state(&key);
            self.prs.states.insert(
                key,
                Arc::new(PrState {
                    repos: Some(repos),
                    busy: previous.busy,
                    progress: previous.progress,
                    error: None,
                }),
            );
            return;
        }
        let creating = channel == "github:pr-creation-progress";
        let phase = row.get("phase").clone();
        let previous = self.prs.state(&key);
        let progress = previous.progress.clone().unwrap_or_default();
        let settled = if creating {
            progress
                .creation
                .as_ref()
                .is_some_and(|p| p.current.settled())
        } else {
            progress.merge.as_ref().is_some_and(|p| p.current.settled())
        };
        let steps = if creating {
            self.prs.creation_steps.entry(key.clone()).or_default()
        } else {
            self.prs.merge_steps.entry(key.clone()).or_default()
        };
        if settled && !(phase.is_str("done") || phase.is_str("error")) {
            steps.clear();
        }
        steps.push(row.clone());
        if steps.len() > 100 {
            steps.remove(0);
        }
        let next = Progress {
            creation: if creating {
                parse_creation(&phase, steps)
            } else {
                progress.creation.clone()
            },
            merge: if creating {
                progress.merge.clone()
            } else {
                parse_merge(&phase, steps)
            },
        };
        self.prs.states.insert(
            key,
            Arc::new(PrState {
                repos: previous.repos,
                busy: previous.busy,
                progress: Some(next),
                error: None,
            }),
        );
        self.prs.refresh = Some(self.timer(TimerKind::Prs, DEBOUNCE));
    }
}

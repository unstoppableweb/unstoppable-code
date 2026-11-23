//! The desktop channel catalog for the overview: one decoder per reply and
//! push it reads, mapping the bridge's tagged JSON to `cc-domain::overview`
//! values. Each decoder keeps the Dart reader's strictness: what Dart
//! rejects with `deviceLinkObject`/`deviceLinkString` fails
//! [`Unreadable::Invalid`], a failed cast fails [`Unreadable::Unexpected`],
//! and what Dart reads leniently stays lenient.
use cc_domain::overview::{
    Catalog, CatalogWorkspace, ChatRef, ChatSummary, Execution, MergeQueue, Owner, PrStatus,
    Project, RecentSnapshot, ScopeQuestion, ScopeSnapshot, ScopeTab, SnapshotWorkspace,
    SnapshotWorktree, StandaloneChat, Worktree, WorktreeChats, WorktreeRow, pipeline_statuses,
};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// Why a reply could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unreadable {
    /// `DeviceLinkException('The peer sent an invalid message.')`.
    Invalid,
    /// Any other failure (a Dart `TypeError`).
    Unexpected,
}
type Read<T> = Result<T, Unreadable>;

/// The fallback words decoders put in names and titles.
#[derive(Debug, Clone)]
pub struct Fallbacks {
    /// A worktree without label or branch (`'Worktree'`).
    pub worktree: String,
    /// A tab or catalog entry without a title (`'Chat'`).
    pub chat: String,
    /// A summary or Cowork chat without a title (`'Untitled chat'`).
    pub untitled_chat: String,
    /// A row without a branch (`'Detached worktree'`).
    pub detached: String,
}

// ---- Tagged JSON to plain values ----

const OPAQUE: &str = "\u{0}v8";

/// The plain value Dart's reader builds from bridge JSON, after
/// `deviceChatDto`: references resolved (a cycle reads as null),
/// `$object` maps, `undefined` map entries dropped (null in lists), lone
/// surrogates replaced. Dates and byte arrays become opaque values that no
/// decoder reads as a string, number, list or map.
pub fn resolve(value: &Value) -> Value {
    let mut ids = HashMap::new();
    resolve_in(value, &mut ids)
}

fn resolve_in(value: &Value, ids: &mut HashMap<u64, Value>) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| match undefined(v) {
                    true => Value::Null,
                    false => resolve_in(v, ids),
                })
                .collect(),
        ),
        Value::Object(map) if crate::v8::is_tag(map.keys()) => tag(map, ids),
        Value::Object(map) => Value::Object(plain_map(map.iter(), ids)),
        other => other.clone(),
    }
}

fn undefined(v: &Value) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == 1 && o.contains_key("$undefined"))
}

fn plain_map<'a>(
    entries: impl Iterator<Item = (&'a String, &'a Value)>,
    ids: &mut HashMap<u64, Value>,
) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in entries {
        if !undefined(value) {
            let value = resolve_in(value, ids);
            out.insert(key.clone(), value);
        }
    }
    out
}

fn tag(map: &Map<String, Value>, ids: &mut HashMap<u64, Value>) -> Value {
    if let (Some(id), Some(inner)) = (map.get("$id").and_then(Value::as_u64), map.get("$value")) {
        // A cycle back to this object reads as null while it is resolved.
        ids.insert(id, Value::Null);
        let resolved = resolve_in(inner, ids);
        ids.insert(id, resolved.clone());
        return resolved;
    }
    let (key, inner) = map.iter().next().expect("a tag has one key");
    match key.as_str() {
        "$ref" => inner
            .as_u64()
            .and_then(|id| ids.get(&id).cloned())
            .unwrap_or(Value::Null),
        "$undefined" => Value::Null,
        "$number" => opaque("number"),
        "$utf16" => Value::String(utf16(inner)),
        "$sparse" => resolve_in(inner, ids),
        "$object" => {
            let mut out = Map::new();
            for pair in inner.as_array().into_iter().flatten() {
                if let Some([k, v]) = pair.as_array().map(Vec::as_slice) {
                    let key = match k {
                        Value::String(s) => s.clone(),
                        other => match other.get("$utf16") {
                            Some(units) => utf16(units),
                            None => continue,
                        },
                    };
                    if !undefined(v) {
                        let v = resolve_in(v, ids);
                        out.insert(key, v);
                    }
                }
            }
            Value::Object(out)
        }
        // `$date`, `$bytes`.
        _ => opaque("value"),
    }
}

fn utf16(units: &Value) -> String {
    let units: Vec<u16> = units
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| u.as_u64().and_then(|u| u16::try_from(u).ok()))
        .collect();
    String::from_utf16_lossy(&units)
}

/// A non-finite number, date or byte array: none of the JSON kinds the
/// decoders read.
fn opaque(kind: &str) -> Value {
    let mut map = Map::new();
    map.insert(OPAQUE.into(), Value::String(kind.into()));
    Value::Object(map)
}

// ---- Dart reader rules ----

/// `value is Map<String, dynamic>`.
fn map(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|m| !m.contains_key(OPAQUE))
}
/// `deviceLinkObject`.
fn object(value: &Value) -> Read<&Map<String, Value>> {
    map(value).ok_or(Unreadable::Invalid)
}
fn get<'a>(map: &'a Map<String, Value>, key: &str) -> &'a Value {
    map.get(key).unwrap_or(&Value::Null)
}
/// `deviceLinkString`: a non-empty string of at most 4096 UTF-16 units.
fn link_string(map: &Map<String, Value>, key: &str) -> Read<String> {
    match get(map, key) {
        Value::String(s) if !s.is_empty() && s.encode_utf16().count() <= 4096 => Ok(s.clone()),
        _ => Err(Unreadable::Invalid),
    }
}
/// `value is String ? value : null`.
fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}
/// `value as String?`.
fn cast_string(value: &Value) -> Read<Option<String>> {
    match value {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.clone())),
        _ => Err(Unreadable::Unexpected),
    }
}
/// `value as List? ?? const []`.
fn cast_list(value: &Value) -> Read<&[Value]> {
    match value {
        Value::Null => Ok(&[]),
        Value::Array(items) => Ok(items),
        _ => Err(Unreadable::Unexpected),
    }
}
/// `value as List`.
fn list(value: &Value) -> Read<&[Value]> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or(Unreadable::Unexpected)
}
/// `value is List ? value : const []`.
fn rows(value: &Value) -> impl Iterator<Item = &Map<String, Value>> {
    value.as_array().into_iter().flatten().filter_map(map)
}
fn boolean(value: &Value) -> Option<bool> {
    value.as_bool()
}
/// `value is num && value.isFinite ? value : null`.
fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}
/// `value is num ? value.toInt() : null`.
fn int(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().filter(|n| n.is_finite()).map(|n| n as i64))
}
/// Dart string interpolation of a wire value, for keys.
fn interpolated(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        _ => "<value>".into(),
    }
}
fn nonempty(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

// ---- Inventory (`worktrees/repository.dart` `refresh`) ----

/// The roster a refresh builds: projects and worktrees in inventory order
/// (callers sort), and the ids of code projects.
#[derive(Debug, Clone, Default)]
pub struct Inventory {
    pub projects: Vec<Project>,
    pub worktrees: Vec<Worktree>,
    pub code_project_ids: Vec<String>,
}

/// The session snapshot's owner union (`_ownerContext`): absent is
/// Personal; an organization needs its type and a non-empty id.
fn owner(value: &Value) -> Option<Owner> {
    if value.is_null() {
        return Some(Owner::Personal);
    }
    let owner = map(value)?;
    let organization = nonempty(get(owner, "organizationId"));
    match get(owner, "type").as_str() {
        Some("personal") => Some(Owner::Personal),
        Some("organization" | "cloud-organization") => organization.map(Owner::Organization),
        _ => None,
    }
}

struct WorkspaceRow {
    owner: Option<Owner>,
    order: Option<f64>,
    placeholder: bool,
    hidden: bool,
}
fn workspace_row(row: &Map<String, Value>) -> WorkspaceRow {
    WorkspaceRow {
        owner: owner(get(row, "owner")),
        order: finite(get(row, "order")),
        placeholder: !get(row, "placeholder").is_null(),
        hidden: boolean(get(row, "hidden")).unwrap_or(false),
    }
}

/// Builds the roster from `projects:load`, the optional
/// `desktop:session-snapshot` and `pipelines:list-executions` replies.
/// Chat state comes from `cached` (the previous roster, by key); `instance`
/// tags the new rows.
pub fn inventory(
    projects: &Value,
    snapshot: Option<&Value>,
    executions: Option<&Value>,
    cached: &HashMap<String, WorktreeChats>,
    instance: u64,
    fallbacks: &Fallbacks,
) -> Read<Inventory> {
    let projects = resolve(projects);
    let snapshot = snapshot.map(resolve).unwrap_or(Value::Null);
    let executions = executions.map(resolve).unwrap_or(Value::Null);
    let result = object(&projects)?;
    let empty = Map::new();
    let snapshot = map(&snapshot).unwrap_or(&empty);
    let mut owners: HashMap<String, WorkspaceRow> = HashMap::new();
    for row in cast_list(get(snapshot, "workspaces"))?
        .iter()
        .filter_map(map)
    {
        owners.insert(interpolated(get(row, "localId")), workspace_row(row));
    }
    let mut projections: HashMap<String, &Map<String, Value>> = HashMap::new();
    for row in cast_list(get(snapshot, "worktrees"))?
        .iter()
        .filter_map(map)
    {
        let key = format!(
            "{}/{}",
            interpolated(get(row, "workspaceLocalId")),
            interpolated(get(row, "localId"))
        );
        projections.insert(key, row);
    }
    let executions = map(&executions).unwrap_or(&empty);
    let mut runs = Vec::new();
    if get(executions, "success") == &Value::Bool(true) {
        for row in cast_list(get(executions, "data"))?.iter().filter_map(map) {
            if let (Some(project_id), Some(worktree_id), Some(id)) = (
                string(get(row, "project_id")),
                string(get(row, "worktree_id")),
                string(get(row, "id")),
            ) {
                runs.push(Execution {
                    project_id,
                    worktree_id,
                    id,
                    status: string(get(row, "status")),
                });
            }
        }
    }
    let items = list(get(result, "items"))?;
    let items: Vec<&Map<String, Value>> = items.iter().map(object).collect::<Read<_>>()?;
    let mut seen: HashMap<String, HashSet<String>> = HashMap::new();
    for project in &items {
        for row in cast_list(get(project, "worktrees"))?.iter().filter_map(map) {
            let key = format!(
                "{}/{}",
                interpolated(get(project, "id")),
                interpolated(get(row, "id"))
            );
            let ids = cast_list(get(row, "seenPipelineExecutionIds"))?
                .iter()
                .filter_map(string)
                .collect();
            seen.insert(key, ids);
        }
    }
    let pipelines = pipeline_statuses(&runs, &seen);
    let mut code_project_ids = Vec::new();
    for project in &items {
        if get(project, "type").as_str() != Some("cowork") {
            let id = link_string(project, "id")?;
            if !code_project_ids.contains(&id) {
                code_project_ids.push(id);
            }
        }
    }
    let mut inventory = Inventory {
        code_project_ids,
        ..Inventory::default()
    };
    for project in &items {
        if get(project, "hidden") == &Value::Bool(true) || !get(project, "archivedAt").is_null() {
            continue;
        }
        let workspace = owners.get(&interpolated(get(project, "id")));
        if workspace.is_some_and(|w| w.placeholder || w.hidden) {
            continue;
        }
        let id = link_string(project, "id")?;
        let name = link_string(project, "name")?;
        inventory.projects.push(Project {
            id: id.clone(),
            name: name.clone(),
            kind: cast_string(get(project, "type"))?.unwrap_or_else(|| "single-repo".into()),
            color: cast_string(get(project, "color"))?,
            temporary: get(project, "temporary") == &Value::Bool(true),
            always_show: get(project, "alwaysShow") != &Value::Bool(false),
            // An absent owner in a legacy workspace row is Personal; an
            // absent row or unrecognized owner stays unknown.
            owner: workspace.and_then(|w| w.owner.clone()),
            order: workspace
                .and_then(|w| w.order)
                .or_else(|| finite(get(project, "order"))),
        });
        for row in cast_list(get(project, "worktrees"))? {
            let row = object(row)?;
            if !get(row, "archivedAt").is_null() {
                continue;
            }
            let worktree_id = link_string(row, "id")?;
            let key = format!("{id}/{worktree_id}");
            let projection = projections.get(&key).copied();
            let field = |key: &str| projection.map_or(&Value::Null, |p| get(p, key));
            let worktree_name = [
                field("label"),
                field("branch"),
                get(row, "label"),
                get(row, "branchName"),
            ]
            .into_iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .find(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| fallbacks.worktree.clone());
            let order = finite(field("order")).or_else(|| finite(get(row, "order")));
            let hidden =
                get(row, "hidden") == &Value::Bool(true) || field("hidden") == &Value::Bool(true);
            let pipeline_status = pipelines.get(&key).cloned();
            // `deviceWorktreeRow`: the name as branch, the projection over
            // it, then identity, order, hidden and the pipeline status.
            let mut merged = Map::new();
            merged.insert("branch".into(), Value::String(worktree_name.clone()));
            if let Some(projection) = projection {
                for (k, v) in projection {
                    merged.insert(k.clone(), v.clone());
                }
            }
            merged.insert("localId".into(), Value::String(worktree_id.clone()));
            merged.insert("workspaceLocalId".into(), Value::String(id.clone()));
            merged.insert(
                "order".into(),
                order
                    .and_then(serde_json::Number::from_f64)
                    .map_or(Value::Null, Value::Number),
            );
            merged.insert("hidden".into(), Value::Bool(hidden));
            if let Some(status) = &pipeline_status {
                merged.insert("pipelineStatus".into(), Value::String(status.clone()));
            }
            inventory.worktrees.push(Worktree {
                project_id: id.clone(),
                project_name: name.clone(),
                id: worktree_id,
                name: worktree_name,
                saved_status: cast_string(get(row, "status"))?,
                order,
                hidden,
                pipeline_status,
                base_row: worktree_row(&merged, fallbacks),
                chats: cached.get(&key).cloned().unwrap_or_default(),
                instance,
            });
        }
    }
    Ok(inventory)
}

/// `RemoteWorktree.fromJson`.
fn worktree_row(json: &Map<String, Value>, fallbacks: &Fallbacks) -> WorktreeRow {
    let diff = map(get(json, "diffStats"));
    let known = |value: &Value, wire: &[&str]| {
        value
            .as_str()
            .filter(|s| wire.contains(s))
            .map(str::to_owned)
    };
    WorktreeRow {
        local_id: string(get(json, "localId")).unwrap_or_default(),
        workspace_local_id: string(get(json, "workspaceLocalId")).unwrap_or_default(),
        branch: string(get(json, "branch")).unwrap_or_else(|| fallbacks.detached.clone()),
        label: string(get(json, "label")),
        order: finite(get(json, "order")),
        status: string(get(json, "status")),
        busy: boolean(get(json, "busy")),
        is_streaming: boolean(get(json, "isStreaming")),
        background_tasks: int(get(json, "backgroundTasks")),
        has_unread: boolean(get(json, "hasUnread")),
        hidden: boolean(get(json, "hidden")),
        awaiting_approval: boolean(get(json, "awaitingApproval")),
        pipeline_status: known(
            get(json, "pipelineStatus"),
            &["running", "unseen", "unseen-failure", "paused"],
        ),
        script_status: string(get(json, "scriptStatus")),
        hook_status: string(get(json, "hookStatus")),
        terminal_status: string(get(json, "terminalStatus")),
        setup_phase: known(
            get(json, "setupPhase"),
            &["idle", "git-pending", "running-setup", "running-teardown"],
        ),
        last_activity_at: string(get(json, "lastActivityAt")),
        created_at: string(get(json, "createdAt")),
        insertions: diff.and_then(|d| int(get(d, "insertions"))),
        deletions: diff.and_then(|d| int(get(d, "deletions"))),
        pr_statuses: pr_statuses(get(json, "lastKnownPrStatus")),
        merging_pr: boolean(get(json, "mergingPr")).unwrap_or(false),
        merge_pr_phase: string(get(json, "mergePrPhase")),
        notification_space_id: nonempty(get(json, "notificationSpaceId")),
    }
}

/// `RemoteWorktree._parsePrStatuses`.
fn pr_statuses(value: &Value) -> Vec<PrStatus> {
    let Some(repos) = map(value).and_then(|v| get(v, "repos").as_array()) else {
        return Vec::new();
    };
    let mut statuses = Vec::new();
    for repo in repos.iter().filter_map(map) {
        let Some(status) = map(get(repo, "status")) else {
            continue;
        };
        let Some(state) = nonempty(get(status, "state")) else {
            continue;
        };
        statuses.push(PrStatus {
            repo_id: string(get(repo, "repoId")),
            pr_number: int(get(status, "prNumber")),
            state,
            url: string(get(status, "prUrl")),
            title: string(get(status, "title")),
            base_ref_name: string(get(status, "baseRefName")),
            check_status: string(get(status, "checkStatus")),
            review_status: match get(status, "reviewStatus").as_str() {
                None | Some("none") => None,
                Some("changes_requested") => Some("changes-requested".into()),
                Some(other) => Some(other.into()),
            },
            has_conflicts: boolean(get(status, "hasConflicts")),
            merge_ready: boolean(get(status, "mergeReady")),
            comment_count: int(get(status, "commentCount")),
            unresolved_review_thread_count: int(get(status, "unresolvedReviewThreadCount")),
            merge_queue: merge_queue(get(status, "mergeQueue")),
        });
    }
    statuses
}

/// `RemotePrMergeQueue.tryParse`.
fn merge_queue(value: &Value) -> Option<MergeQueue> {
    let raw = map(value)?;
    let in_queue = boolean(get(raw, "inQueue"))?;
    Some(MergeQueue {
        in_queue,
        position: int(get(raw, "position")),
        phase: in_queue
            .then(|| get(raw, "phase").as_str())
            .flatten()
            .map(|phase| match phase {
                "queued" | "awaiting_checks" | "mergeable" | "locked" | "unmergeable" => {
                    phase.to_owned()
                }
                _ => "unknown".to_owned(),
            }),
    })
}

// ---- Chat scope state (`chat:get-state`) ----

/// `deviceChatTitle`: the custom name, else the description, else the
/// title, trimmed.
fn chat_title(tab: &Map<String, Value>, fallback: &str) -> String {
    ["customTitle", "description", "title"]
        .into_iter()
        .filter_map(|k| get(tab, k).as_str())
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

fn scope_tab(tab: &Map<String, Value>, fallbacks: &Fallbacks) -> ScopeTab {
    let link_id = link_string(tab, "id").ok();
    ScopeTab {
        id: string(get(tab, "id")),
        link_id,
        empty: tab.is_empty(),
        is_file: get(tab, "kind").as_str() == Some("file"),
        archived: !get(tab, "archivedAt").is_null(),
        unread: get(tab, "unread") == &Value::Bool(true),
        plan_exit: !get(tab, "pendingPlanExit").is_null(),
        title: chat_title(tab, &fallbacks.chat),
    }
}

fn runtime(snapshot: &Map<String, Value>) -> Read<Vec<(String, Option<String>)>> {
    Ok(object(get(snapshot, "runtimeByChatId"))?
        .iter()
        .filter_map(|(id, runtime)| map(runtime).map(|r| (id.clone(), string(get(r, "status")))))
        .collect())
}

/// A worktree's `chat:get-state` as `DeviceWorktreesRepository.load`
/// reads it; any failure makes the worktree unavailable.
pub fn worktree_scope(reply: &Value, fallbacks: &Fallbacks) -> Read<ScopeSnapshot> {
    let reply = resolve(reply);
    let snapshot = object(&reply)?;
    let tabs = object(get(snapshot, "tabsFile"))?;
    let all = list(get(tabs, "tabs"))?
        .iter()
        .map(|t| object(t).map(|t| scope_tab(t, fallbacks)))
        .collect::<Read<Vec<_>>>()?;
    if all
        .iter()
        .any(|t| !t.is_file && !t.archived && t.link_id.is_none())
    {
        return Err(Unreadable::Invalid);
    }
    let active_tab_id = cast_string(get(tabs, "activeTabId"))?;
    let runtime = runtime(snapshot)?;
    let approvals = cast_list(get(tabs, "pendingApprovals"))?.len();
    let questions = cast_list(get(tabs, "pendingQuestions"))?
        .iter()
        .map(|q| {
            object(q).map(|q| ScopeQuestion {
                open: get(q, "answeredAt").is_null() && get(q, "dismissedAt").is_null(),
            })
        })
        .collect::<Read<Vec<_>>>()?;
    Ok(ScopeSnapshot {
        tabs: all,
        active_tab_id,
        runtime,
        approvals,
        questions,
    })
}

/// A Cowork entry's `chat:get-state` (`DeviceChatScopeState.hydrate`) with
/// its revision. `None` when the revision is not an integer or the state
/// does not hydrate: the last observation is kept.
pub fn cowork_scope(reply: &Value, fallbacks: &Fallbacks) -> Option<(i64, ScopeSnapshot)> {
    let reply = resolve(reply);
    let snapshot = map(&reply)?;
    let revision = get(snapshot, "revision");
    let revision = revision
        .as_i64()
        .filter(|_| revision.is_i64() || revision.is_u64())?;
    let hydrate = || -> Read<ScopeSnapshot> {
        let file = object(get(snapshot, "tabsFile"))?;
        let tabs = list(get(file, "tabs"))?
            .iter()
            .map(|t| object(t).map(|t| scope_tab(t, fallbacks)))
            .collect::<Read<Vec<_>>>()?;
        let questions = cast_list(get(file, "pendingQuestions"))?
            .iter()
            .map(|q| {
                object(q).map(|q| ScopeQuestion {
                    open: get(q, "answeredAt").is_null() && get(q, "dismissedAt").is_null(),
                })
            })
            .collect::<Read<Vec<_>>>()?;
        let approvals = cast_list(get(file, "pendingApprovals"))?
            .iter()
            .map(object)
            .collect::<Read<Vec<_>>>()?
            .len();
        Ok(ScopeSnapshot {
            tabs,
            active_tab_id: None,
            runtime: runtime(snapshot)?,
            approvals,
            questions,
        })
    };
    hydrate().ok().map(|state| (revision, state))
}

// ---- Chat catalog (`chats/catalog.dart`) ----

/// The live chats of `chat-search:catalog` and the workspaces of
/// `chat-project:list`.
pub fn catalog(entries: &Value, projects: &Value, fallbacks: &Fallbacks) -> Read<Catalog> {
    let entries = resolve(entries);
    let projects = resolve(projects);
    let result = object(&entries)?;
    let projects = object(&projects)?;
    let mut chats = Vec::new();
    for entry in list(get(result, "entries"))? {
        let entry = object(entry)?;
        let kind = get(entry, "documentKind");
        if get(entry, "source").as_str() != Some("live")
            || !(kind.is_null() || kind.as_str() == Some("chat"))
            || !get(entry, "archivedAt").is_null()
        {
            continue;
        }
        chats.push(ChatRef {
            project_id: link_string(entry, "projectId")?,
            worktree_id: link_string(entry, "worktreeId")?,
            id: link_string(entry, "chatId")?,
            title: nonempty(get(entry, "title")).unwrap_or_else(|| fallbacks.chat.clone()),
        });
    }
    let mut workspaces = Vec::new();
    for project in list(get(projects, "projects"))? {
        let project = object(project)?;
        workspaces.push(CatalogWorkspace {
            id: link_string(project, "id")?,
            name: link_string(project, "name")?,
        });
    }
    Ok(Catalog { chats, workspaces })
}

// ---- Recents (`desktop:session-snapshot` with chat summaries) ----

/// The parts of `RemoteSessionSnapshot.fromJson` Recents reads.
pub fn recent_snapshot(reply: &Value, fallbacks: &Fallbacks) -> Read<RecentSnapshot> {
    let reply = resolve(reply);
    let snapshot = object(&reply)?;
    let workspaces = rows(get(snapshot, "workspaces"))
        .map(|w| SnapshotWorkspace {
            local_id: string(get(w, "localId")).unwrap_or_default(),
            owner: owner(get(w, "owner")),
            placeholder: !get(w, "placeholder").is_null(),
            hidden: boolean(get(w, "hidden")).unwrap_or(false),
            kind: get(w, "type")
                .as_str()
                .filter(|t| matches!(*t, "single-repo" | "multi-repo" | "cowork"))
                .map(str::to_owned),
        })
        .collect();
    let worktrees = rows(get(snapshot, "worktrees"))
        .map(|w| SnapshotWorktree {
            local_id: string(get(w, "localId")).unwrap_or_default(),
            workspace_local_id: string(get(w, "workspaceLocalId")).unwrap_or_default(),
            branch: string(get(w, "branch")).unwrap_or_else(|| fallbacks.detached.clone()),
            label: string(get(w, "label")),
            hidden: boolean(get(w, "hidden")),
        })
        .collect();
    let standalone_chats = rows(get(snapshot, "standaloneChats"))
        .map(|c| StandaloneChat {
            local_id: string(get(c, "localId")).unwrap_or_default(),
            project_local_id: string(get(c, "projectLocalId")).unwrap_or_default(),
            display_title: ["workEntryTitle", "description", "title"]
                .into_iter()
                .filter_map(|k| get(c, k).as_str())
                .map(str::trim)
                .find(|s| !s.is_empty())
                .map_or_else(|| fallbacks.untitled_chat.clone(), str::to_owned),
            work_entry_id: string(get(c, "workEntryId")),
            work_entry_notification_space_id: string(get(c, "workEntryNotificationSpaceId"))
                .filter(|id| !id.is_empty()),
            archived: boolean(get(c, "archived")),
            last_message_at: string(get(c, "lastMessageAt")),
            has_unread: boolean(get(c, "hasUnread")),
        })
        .collect();
    let chat_summaries = summaries(snapshot, fallbacks);
    Ok(RecentSnapshot {
        workspaces,
        worktrees,
        standalone_chats,
        chat_summaries,
    })
}

fn summaries(snapshot: &Map<String, Value>, fallbacks: &Fallbacks) -> Vec<ChatSummary> {
    rows(get(snapshot, "chatSummaries"))
        .map(|c| ChatSummary {
            chat_id: string(get(c, "chatId")).unwrap_or_default(),
            scope: get(c, "scope")
                .as_str()
                .filter(|s| matches!(*s, "worktree" | "standalone"))
                .map(str::to_owned),
            display_title: string(get(c, "description")).unwrap_or_else(|| {
                string(get(c, "title")).unwrap_or_else(|| fallbacks.untitled_chat.clone())
            }),
            workspace_local_id: string(get(c, "workspaceLocalId")),
            worktree_local_id: string(get(c, "worktreeLocalId")),
            created_at: string(get(c, "createdAt")),
            last_message_at: string(get(c, "lastMessageAt")),
            open_question: get(c, "pendingQuestions").as_array().map(|questions| {
                questions
                    .iter()
                    .filter_map(map)
                    .any(|q| boolean(get(q, "answered")) != Some(true))
            }),
            has_unread: boolean(get(c, "hasUnread")),
        })
        .collect()
}

/// The snapshot's chat summaries scoped to one worktree, for the fallback
/// read of `readRecentInventory`.
pub fn worktree_summaries(
    reply: &Value,
    workspace: &str,
    worktree: &str,
    fallbacks: &Fallbacks,
) -> Read<Vec<ChatSummary>> {
    let reply = resolve(reply);
    let snapshot = object(&reply)?;
    Ok(summaries(snapshot, fallbacks)
        .into_iter()
        .filter(|c| {
            c.workspace_local_id.as_deref() == Some(workspace)
                && c.worktree_local_id.as_deref() == Some(worktree)
        })
        .collect())
}

// ---- Pushes ----

// ---- Orchestrator (`orchestrator/catalog.dart`) ----

/// A `work-entries:list` row as the Orchestrator lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkEntry {
    pub id: String,
    /// `None` when the desktop sent no title.
    pub title: Option<String>,
    pub running: bool,
    pub unread: bool,
}

/// `work-entries:list`'s reply as Dart reads it before it asks for the
/// catalog (`deviceLinkObject`).
pub fn work_entries_reply(reply: &Value) -> Read<Value> {
    let reply = resolve(reply);
    object(&reply)?;
    Ok(reply)
}

/// `OrchestratorCatalog.read` after both replies: the live chats of
/// `project` in `chat-search:catalog`, then the work entries. `entries` is
/// [`work_entries_reply`]'s value.
pub fn orchestrator_catalog(
    entries: &Value,
    catalog: &Value,
    project: &str,
    fallbacks: &Fallbacks,
) -> Read<(Vec<ChatRef>, Vec<WorkEntry>)> {
    let catalog = resolve(catalog);
    let catalog = object(&catalog)?;
    let mut chats = Vec::new();
    for row in list(get(catalog, "entries"))? {
        let row = object(row)?;
        let kind = get(row, "documentKind");
        if get(row, "projectId").as_str() != Some(project)
            || get(row, "source").as_str() != Some("live")
            || !get(row, "archivedAt").is_null()
            || !(kind.is_null() || kind.as_str() == Some("chat"))
        {
            continue;
        }
        chats.push(ChatRef {
            project_id: link_string(row, "projectId")?,
            worktree_id: link_string(row, "worktreeId")?,
            id: link_string(row, "chatId")?,
            title: nonempty(get(row, "title")).unwrap_or_else(|| fallbacks.chat.clone()),
        });
    }
    let entries = object(entries)?;
    let mut rows = Vec::new();
    for row in list(get(entries, "entries"))? {
        let row = object(row)?;
        rows.push(WorkEntry {
            id: link_string(row, "id")?,
            title: cast_string(get(row, "title"))?,
            running: get(row, "hasActiveChat") == &Value::Bool(true),
            unread: !cast_list(get(row, "unreadChats"))?.is_empty(),
        });
    }
    Ok((chats, rows))
}

/// `OrchestratorCatalog.activeChat`: a work entry's active tab (else its
/// first open one) from `chat:get-state`, as `(id, title)`.
pub fn active_tab(reply: &Value, fallbacks: &Fallbacks) -> Read<Option<(String, String)>> {
    let reply = resolve(reply);
    let snapshot = object(&reply)?;
    let file = object(get(snapshot, "tabsFile"))?;
    let tabs = list(get(file, "tabs"))?
        .iter()
        .map(object)
        .collect::<Read<Vec<_>>>()?
        .into_iter()
        .filter(|t| get(t, "kind").as_str() != Some("file") && get(t, "archivedAt").is_null())
        .collect::<Vec<_>>();
    let active = get(file, "activeTabId");
    let Some(tab) = tabs
        .iter()
        .find(|t| get(t, "id") == active)
        .or_else(|| tabs.first())
    else {
        return Ok(None);
    };
    Ok(Some((
        link_string(tab, "id")?,
        chat_title(tab, &fallbacks.chat),
    )))
}

/// An `ipc.push` event for the main surface: its channel and arguments.
#[derive(Debug, Clone)]
pub struct Push {
    pub channel: String,
    pub args: Vec<Value>,
}

/// The push a session event carries, when it is an `ipc.push` the main
/// surface sees (no surface, or `main`).
pub fn push(message: &Value) -> Option<Push> {
    let message = resolve(message);
    let message = map(&message)?;
    if get(message, "name").as_str() != Some("ipc.push") {
        return None;
    }
    let payload = map(get(message, "payload"))?;
    match get(payload, "surface") {
        Value::Null => {}
        Value::String(s) if s == "main" => {}
        _ => return None,
    }
    Some(Push {
        channel: string(get(payload, "channel")).unwrap_or_default(),
        args: get(payload, "args").as_array().cloned().unwrap_or_default(),
    })
}

/// `code-graph:build-status-changed`: the worktree key and whether it is
/// building (`applyCodeGraphStatus`).
pub fn code_graph_status(push: &Push) -> Option<(String, bool)> {
    let event = map(push.args.first()?)?;
    Some((
        format!(
            "{}/{}",
            interpolated(get(event, "projectId")),
            interpolated(get(event, "worktreeId"))
        ),
        get(event, "status").as_str() == Some("building"),
    ))
}

/// `chat:state-changed`: the scope key when a change can move a row's chat
/// state (tabs, runtime, unread).
pub fn chat_state_scope(push: &Push) -> Option<String> {
    let event = map(push.args.first()?)?;
    let relevant = get(event, "changes")
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(map)
        .any(|change| match get(change, "type").as_str() {
            Some("runtime.patched" | "tab.created" | "tab.upserted" | "tab.removed") => true,
            Some("tab.metadata_patched") => {
                map(get(change, "patch")).is_some_and(|p| p.contains_key("unread"))
            }
            _ => false,
        });
    // `event['changes'] as List?` fails the handler for a non-list.
    if !matches!(get(event, "changes"), Value::Null | Value::Array(_)) {
        return None;
    }
    relevant.then(|| {
        format!(
            "{}/{}",
            interpolated(get(event, "projectId")),
            interpolated(get(event, "worktreeId"))
        )
    })
}

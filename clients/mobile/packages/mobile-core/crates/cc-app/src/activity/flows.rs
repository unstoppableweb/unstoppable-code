//! The activity's multi-step desktop reads, as Dart's `async` methods ran
//! them: `DeviceActivityRepository._load` (with `_scripts`) and
//! `DeviceHookRepository._request`. Each runs in its own task and
//! re-checks the connection generation where Dart did; the actor applies
//! the result.
use super::{Fail, Shared};
use crate::chats::Peer;
use crate::{
    bridge::Inner,
    copy::activity::{self as copy, CopyKey, ReadLabel},
    error::{Error, Result},
};
use cc_domain::{
    activity::{
        Hook, Loaded, Missing, ReadValues, ScriptRow, Source, Thrown, effective_sources,
        find_workspace, read_activity, script_rows, source_key,
    },
    chat::{ChatRef, link_string, object},
    dart::Dv,
};
use cc_protocol::{FailureKind, dto::desktop_value};
use serde_json::{Map, Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{Mutex, atomic::Ordering},
};

pub(crate) async fn call(
    inner: &Inner,
    computer: &Peer,
    channel: &str,
    args: Vec<Value>,
) -> Result<Value> {
    let rx = inner.request(computer, channel, args)?;
    rx.await
        .unwrap_or_else(|_| Err(cc_protocol::rpc::ended("session_ended")))
}

/// `ipc.invoke` then `deviceChatDto`.
pub(crate) async fn read(
    inner: &Inner,
    computer: &Peer,
    channel: &str,
    args: Vec<Value>,
) -> Result<Dv> {
    call(inner, computer, channel, args)
        .await
        .map(|v| desktop_value(&v))
}

/// `ref.scope`.
pub(crate) fn scope(chat: &ChatRef) -> Map<String, Value> {
    let mut scope = Map::new();
    scope.insert("projectId".into(), json!(chat.project_id));
    scope.insert("worktreeId".into(), json!(chat.worktree_id));
    scope
}

/// A source-info request: `{target, projectId|workspaceId, worktreeId,
/// repoId?, <name key>: name}`.
fn source_args(chat: &ChatRef, source: &Source, name_key: &str, name: &str) -> Value {
    let mut args = Map::new();
    args.insert("target".into(), json!(source.target));
    let id_key = if source.target == "project" {
        "projectId"
    } else {
        "workspaceId"
    };
    args.insert(id_key.into(), json!(chat.project_id));
    args.insert("worktreeId".into(), json!(chat.worktree_id));
    if let Some(repo) = &source.repo_id {
        args.insert("repoId".into(), json!(repo));
    }
    args.insert(name_key.into(), json!(name));
    Value::Object(args)
}

/// `cause is DesktopIpcRefusal && cause.code == 'remote_channel_unavailable'`.
fn outdated(error: &Error) -> bool {
    error.kind == FailureKind::Refused && error.code == "remote_channel_unavailable"
}

/// What one `_load` read.
pub(crate) struct LoadResult {
    pub(crate) loaded: std::result::Result<Loaded, Thrown>,
    pub(crate) errors: Vec<String>,
}

/// `_load(ref)`: three reads, then three more, then the activity. `None`
/// when a newer connection superseded it between its awaits.
pub(crate) async fn load(
    inner: &Inner,
    computer: &Peer,
    chat: &ChatRef,
    shared: &Shared,
    generation: u64,
) -> Option<LoadResult> {
    let errors = Mutex::new(Vec::new());
    let same = || {
        !shared.disposed.load(Ordering::SeqCst)
            && shared.generation.load(Ordering::SeqCst) == generation
    };
    let read_one = |channel: &'static str, label: ReadLabel, args: Value| {
        let errors = &errors;
        async move {
            match read(inner, computer, channel, vec![args]).await {
                Ok(value) => value,
                Err(error) => {
                    errors
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .push(copy::read_error(label, outdated(&error)));
                    Dv::Null
                }
            }
        }
    };
    let scope = Value::Object(scope(chat));
    let with_lines = {
        let mut s = super::flows::scope(chat);
        s.insert("maxLines".into(), json!(0));
        Value::Object(s)
    };
    let (changed, summary, plans) = futures_util::join!(
        read_one(
            "activity:changed-files",
            ReadLabel::ChangedFiles,
            scope.clone()
        ),
        read_one("worktree-summary:load", ReadLabel::Summary, scope.clone()),
        read_one("tracked-plans:list", ReadLabel::Plans, scope.clone()),
    );
    if !same() {
        return None;
    }
    let scripts = async {
        match scripts(inner, computer, chat).await {
            Ok(rows) => rows,
            Err(()) => {
                errors
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push(copy::text(CopyKey::ScriptsFailed).into());
                Vec::new()
            }
        }
    };
    let (script_runs, hook_runs, scripts) = futures_util::join!(
        read_one(
            "script:load-worktree-runs",
            ReadLabel::ScriptRuns,
            with_lines.clone()
        ),
        read_one(
            "hook:load-worktree-runs",
            ReadLabel::HookRuns,
            with_lines.clone()
        ),
        scripts,
    );
    if !same() {
        return None;
    }
    let values = ReadValues {
        changed,
        summary,
        plans,
        script_runs,
        hook_runs,
    };
    let loaded = read_activity(&values, script_rows(&scripts), &copy::fallbacks());
    Some(LoadResult {
        loaded,
        errors: errors.into_inner().unwrap_or_else(|p| p.into_inner()),
    })
}

/// `_scripts(ref)`: every configured script with an effective command.
/// Any failure is reported once by the caller.
async fn scripts(
    inner: &Inner,
    computer: &Peer,
    chat: &ChatRef,
) -> std::result::Result<Vec<ScriptRow>, ()> {
    let reply = read(inner, computer, "projects:load", Vec::new())
        .await
        .map_err(|_| ())?;
    let workspace = find_workspace(&reply, &chat.project_id, &chat.worktree_id).map_err(|_| ())?;
    let sources = effective_sources(&workspace.project, &chat.worktree_id, "effectiveScripts")
        .map_err(|_| ())?;
    let mut rows = Vec::new();
    for source in &sources {
        for (name, value) in &source.values {
            if value.is_null() {
                continue;
            }
            let info = read(
                inner,
                computer,
                "script:source-info",
                vec![source_args(chat, source, "scriptName", name)],
            )
            .await
            .map_err(|_| ())?;
            let info = object(&info).map_err(|_| ())?;
            if info.get("effectiveCommand").is_null() {
                continue;
            }
            let label = match info.get("scriptDisplayName") {
                Dv::Null => Dv::Str(name.clone()),
                other => other.clone(),
            };
            rows.push(ScriptRow {
                name: name.clone(),
                label,
                key: source_key(source, name),
                target: source.target,
            });
        }
    }
    Ok(rows)
}

type Boxed<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `DeviceHookRepository._request`: lists the configured hooks, or (with
/// `set`) writes one hook's paused state from a fresh full-key read and
/// lists them again.
pub(crate) fn hooks<'a>(
    inner: &'a Inner,
    computer: &'a Peer,
    chat: &'a ChatRef,
    shared: &'a Shared,
    generation: u64,
    set: Option<(String, bool)>,
) -> Boxed<'a, std::result::Result<Vec<Hook>, Fail>> {
    Box::pin(async move {
        if !shared.connected.load(Ordering::SeqCst) || shared.disposed.load(Ordering::SeqCst) {
            return Err(Fail::link(CopyKey::ConnectFirst));
        }
        let reply = read(inner, computer, "projects:load", Vec::new())
            .await
            .map_err(|e| Fail::rpc(&e))?;
        let workspace =
            find_workspace(&reply, &chat.project_id, &chat.worktree_id).map_err(|missing| {
                match missing {
                    Missing::Thrown(thrown) => Fail::thrown(thrown),
                    Missing::Unavailable => Fail::link(CopyKey::WorktreeGone),
                }
            })?;
        let mut paused: Vec<String> = Vec::new();
        match workspace.worktree.get("pausedHookKeys") {
            Dv::Null => {}
            other => {
                for key in other.elements().ok_or(Fail::Other)? {
                    if let Dv::Str(key) = key
                        && !paused.contains(key)
                    {
                        paused.push(key.clone());
                    }
                }
            }
        }
        let sources = effective_sources(&workspace.project, &chat.worktree_id, "effectiveHooks")
            .map_err(Fail::thrown)?;
        let fallbacks = copy::fallbacks();
        // (name, hook key, trigger name, paused)
        let mut rows: Vec<(String, String, String, bool)> = Vec::new();
        for source in &sources {
            for (name, value) in &source.values {
                if value.elements().is_none_or(|items| items.is_empty()) {
                    continue;
                }
                let key = source_key(source, name);
                let info = read(
                    inner,
                    computer,
                    "hook:source-info",
                    vec![source_args(chat, source, "triggerName", name)],
                )
                .await
                .map_err(|e| Fail::rpc(&e))?;
                let info = object(&info).map_err(Fail::thrown)?;
                let label = info
                    .get("triggerDisplayName")
                    .cast_str()
                    .map_err(|_| Fail::Other)?
                    .unwrap_or(name)
                    .to_owned();
                let shown = if source.target == "project" {
                    label
                } else {
                    format!(
                        "{} — {label}",
                        source
                            .repo_name
                            .as_deref()
                            .unwrap_or(&fallbacks.workspace_root)
                    )
                };
                let is_paused = paused.contains(&key);
                rows.push((shown, key, name.clone(), is_paused));
            }
        }
        let changed = || {
            shared.disposed.load(Ordering::SeqCst)
                || shared.generation.load(Ordering::SeqCst) != generation
                || !shared.connected.load(Ordering::SeqCst)
        };
        if changed() {
            return Err(Fail::link(CopyKey::ConnectionChanged));
        }
        if let Some((hook_key, pause)) = set {
            if !rows.iter().any(|row| row.1 == hook_key) {
                return Err(Fail::link(CopyKey::RefreshHooks));
            }
            if pause {
                if !paused.contains(&hook_key) {
                    paused.push(hook_key);
                }
            } else {
                paused.retain(|k| *k != hook_key);
            }
            let mut args = scope(chat);
            args.insert("pausedHookKeys".into(), json!(paused));
            call(
                inner,
                computer,
                "worktree:set-paused-hooks",
                vec![Value::Object(args)],
            )
            .await
            .map_err(|e| Fail::rpc(&e))?;
            return hooks(inner, computer, chat, shared, generation, None).await;
        }
        rows.into_iter()
            .map(|(name, hook_key, trigger_name, paused)| {
                let mut row = cc_domain::dart::DvMap::new();
                row.insert("name".into(), Dv::Str(name));
                row.insert("hookKey".into(), Dv::Str(hook_key));
                link_string(&row, "name").map_err(Fail::thrown)?;
                let hook_key = link_string(&row, "hookKey").map_err(Fail::thrown)?;
                Ok(Hook {
                    name: row.get("name").as_str().unwrap_or_default().to_owned(),
                    hook_key: hook_key.to_owned(),
                    trigger_name,
                    paused,
                    run_disabled: false,
                    run_disabled_reason: None,
                })
            })
            .collect()
    })
}

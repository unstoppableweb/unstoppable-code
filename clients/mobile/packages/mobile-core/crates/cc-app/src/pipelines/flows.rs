//! The pipelines' desktop calls, as `DevicePipelineIpc` (`device_link/
//! pipelines/existing_ipc.dart`) ran them: each runs in its own task,
//! checks the connection where Dart's `isCurrent` did and returns what the
//! actor applies. Paths stay opaque: they only go back to the computer.
use crate::chats::Peer;
use crate::{bridge::Inner, copy::pipelines as copy, copy::pipelines::CopyKey, failures};
use cc_domain::{
    chat::{ChatRef, link_string, object},
    dart::{Dv, DvMap},
    pipelines::{
        Descriptor, DispatchForm, Origin,
        display::{self, output_tail},
    },
};
use cc_protocol::{FailureKind, RpcFailure, dto};
use serde_json::{Map, Value, json};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

/// What the spawned calls check between their awaits.
#[derive(Default)]
pub(crate) struct Shared {
    pub(crate) generation: AtomicU64,
    pub(crate) connected: AtomicBool,
    pub(crate) disposed: AtomicBool,
}

impl Shared {
    /// `!_disposed && _connected && generation == _generation`.
    pub(crate) fn current(&self, generation: u64) -> bool {
        !self.disposed.load(Ordering::SeqCst)
            && self.connected.load(Ordering::SeqCst)
            && self.generation.load(Ordering::SeqCst) == generation
    }
}

/// What a Dart pipeline call threw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Thrown {
    /// `RemoteControlException(message)`.
    Remote(String),
    /// `DesktopIpcRefusal`: the desktop answered with a refusal.
    Refusal { message: String, unavailable: bool },
    /// `DesktopIpcNotSent`.
    NotSent(String),
    /// Another `DeviceLinkException`.
    Link(String),
    /// Anything else (a cast, a `FormatException`, a `StateError`).
    Other,
}

impl Thrown {
    pub(crate) fn remote(key: CopyKey) -> Self {
        Self::Remote(copy::text(key).into())
    }
    pub(crate) fn link(key: CopyKey) -> Self {
        Self::Link(copy::text(key).into())
    }
    fn invalid() -> Self {
        Self::link(CopyKey::InvalidMessage)
    }
    /// What a transport failure throws in Dart.
    pub(crate) fn rpc(error: &RpcFailure) -> Self {
        let message = failures::read_failure(error);
        match (error.kind, message) {
            (FailureKind::Refused, message) => Self::Refusal {
                message: message.unwrap_or_default(),
                unavailable: error.code == "remote_channel_unavailable",
            },
            (FailureKind::NotSent, Some(message)) => Self::NotSent(message),
            (_, Some(message)) => Self::Link(message),
            (_, None) => Self::Other,
        }
    }
    /// `DevicePipelineRepository._request`'s refusal mapping
    /// (`_PipelineRefusal`).
    #[must_use]
    pub(crate) fn requested(self) -> Self {
        match self {
            Self::Refusal {
                message,
                unavailable,
            } => Self::Refusal {
                message: if unavailable {
                    copy::text(CopyKey::Unavailable).into()
                } else {
                    message
                },
                unavailable: false,
            },
            other => other,
        }
    }
    /// `errorMessage(error)`.
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Remote(m) | Self::NotSent(m) | Self::Link(m) => m.clone(),
            Self::Refusal { message, .. } => message.clone(),
            Self::Other => copy::text(CopyKey::RequestUnconfirmed).into(),
        }
    }
}

pub(crate) type Thrown2<T> = Result<T, Thrown>;

async fn call(inner: &Inner, computer: &Peer, channel: &str, args: Vec<Value>) -> Thrown2<Value> {
    let rx = inner
        .request(computer, channel, args)
        .map_err(|e| Thrown::rpc(&e))?;
    rx.await
        .unwrap_or_else(|_| Err(cc_protocol::rpc::ended("session_ended")))
        .map_err(|e| Thrown::rpc(&e))
}

/// `_read(channel, args)`: `{success: true, data}` or a refusal.
async fn read(inner: &Inner, computer: &Peer, channel: &str, args: Vec<Value>) -> Thrown2<Dv> {
    let reply = dto::desktop_value(&call(inner, computer, channel, args).await?);
    let result = object(&reply).map_err(|_| Thrown::invalid())?;
    match result.get("success") {
        Dv::Bool(false) => Err(match result.get("error") {
            Dv::Null => Thrown::Refusal {
                message: copy::text(CopyKey::RequestFailed).into(),
                unavailable: false,
            },
            Dv::Str(message) => Thrown::Refusal {
                message: message.clone(),
                unavailable: false,
            },
            // `result['error'] as String?`.
            _ => Thrown::Other,
        }),
        Dv::Bool(true) => Ok(result.get("data").clone()),
        _ => Err(Thrown::link(CopyKey::InvalidReply)),
    }
}

fn map(value: &Dv) -> Thrown2<&DvMap> {
    object(value).map_err(|_| Thrown::invalid())
}

fn string<'a>(map: &'a DvMap, key: &str) -> Thrown2<&'a str> {
    link_string(map, key).map_err(|_| Thrown::invalid())
}

/// `ref.scope`.
fn scope(chat: &ChatRef) -> Map<String, Value> {
    let mut scope = Map::new();
    scope.insert("projectId".into(), json!(chat.project_id));
    scope.insert("worktreeId".into(), json!(chat.worktree_id));
    scope
}

/// `rows as List? ?? const []`.
fn list(value: &Dv) -> Thrown2<Vec<&Dv>> {
    match value {
        Dv::Null => Ok(Vec::new()),
        other => other.elements().ok_or(Thrown::Other),
    }
}

/// `pipelineDisplay(row)`; a cast failure is a `TypeError`.
fn display_of(row: &DvMap) -> Thrown2<DvMap> {
    display::display(row).map_err(|_| Thrown::Other)
}

/// The `executions` request: this worktree's rows, displayed.
pub(crate) async fn executions(
    inner: &Inner,
    computer: &Peer,
    chat: &ChatRef,
) -> Thrown2<Vec<DvMap>> {
    let rows = read(inner, computer, "pipelines:list-executions", Vec::new()).await?;
    let mut out = Vec::new();
    for raw in list(&rows)? {
        if let Dv::Map(raw) = raw
            && raw.get("project_id").is_str(&chat.project_id)
            && raw.get("worktree_id").is_str(&chat.worktree_id)
        {
            out.push(display_of(raw)?);
        }
    }
    Ok(out)
}

/// `_key(ref, id, source)`.
pub(crate) fn lookup_key(chat: &ChatRef, pipeline_id: &str, source: &str) -> String {
    format!(
        "{}/{}/{source}/{pipeline_id}",
        chat.project_id, chat.worktree_id
    )
}

/// What the `list` request read: the rows, and the lookups it wrote
/// (Dart wrote each before the next row could throw).
pub(crate) struct Listed {
    pub(crate) lookups: Vec<(String, Value)>,
    pub(crate) rows: Thrown2<Vec<Dv>>,
}

/// The `list` request: the stored and project pipelines with their
/// lookups.
pub(crate) async fn list_pipelines(inner: &Inner, computer: &Peer, chat: &ChatRef) -> Listed {
    let mut lookups = Vec::new();
    let rows = async {
        let cwd = call(
            inner,
            computer,
            "worktree:get-path",
            vec![Value::Object(scope(chat))],
        )
        .await?;
        // `Future.wait`: both run; the first failure in time is thrown.
        let first: Mutex<Option<Thrown>> = Mutex::new(None);
        let record = |result: Thrown2<Dv>| match result {
            Ok(value) => Some(value),
            Err(e) => {
                let mut slot = first.lock().unwrap_or_else(|p| p.into_inner());
                if slot.is_none() {
                    *slot = Some(e);
                }
                None
            }
        };
        let (stored, project) = futures_util::join!(
            async { record(read(inner, computer, "pipelines:list", Vec::new()).await) },
            async {
                record(
                    read(
                        inner,
                        computer,
                        "pipelines:discover-project",
                        vec![cwd.clone()],
                    )
                    .await,
                )
            },
        );
        if let Some(error) = first.into_inner().unwrap_or_else(|p| p.into_inner()) {
            return Err(error);
        }
        let (stored, project) = (stored.unwrap_or(Dv::Null), project.unwrap_or(Dv::Null));
        let mut rows = Vec::new();
        for raw in list(&stored)?.into_iter().chain(list(&project)?) {
            let row = map(raw)?;
            let pipeline_id = string(row, "id")?;
            let source = string(row, "source")?;
            let lookup = if source == "project" {
                json!({
                    "id": pipeline_id,
                    "cwd": cwd,
                    "filePath": dto::bridge_value(row.get("filePath")),
                })
            } else {
                json!({"id": pipeline_id, "source": source})
            };
            lookups.push((lookup_key(chat, pipeline_id, source), lookup));
            let mut out = row.clone();
            out.insert("pipelineId".into(), Dv::Str(pipeline_id.to_owned()));
            out.insert("origin".into(), row.get("source").clone());
            rows.push(Dv::Map(out));
        }
        Ok(rows)
    }
    .await;
    Listed { lookups, rows }
}

/// Dispatchable descriptors of the `list` rows.
pub(crate) fn dispatchable(rows: &[Dv]) -> Vec<Descriptor> {
    rows.iter()
        .filter_map(Descriptor::from_json)
        .filter(Descriptor::is_dispatchable)
        .collect()
}

/// `pipelines:get` with the row's lookup.
async fn definition(
    inner: &Inner,
    computer: &Peer,
    pipeline_id: &str,
    origin: Origin,
    lookup: Option<Value>,
) -> Thrown2<DvMap> {
    let lookup = lookup.unwrap_or_else(|| json!({"id": pipeline_id, "source": origin.name()}));
    let value = read(inner, computer, "pipelines:get", vec![lookup]).await?;
    Ok(map(&value)?.clone())
}

/// The `definition` request: the dispatch form.
pub(crate) async fn form(
    inner: &Inner,
    computer: &Peer,
    pipeline_id: &str,
    origin: Origin,
    lookup: Option<Value>,
) -> Thrown2<DispatchForm> {
    let definition = definition(inner, computer, pipeline_id, origin, lookup).await?;
    let content = map(definition.get("content"))?;
    let metadata = match content.get("pipeline") {
        Dv::Map(pipeline) => pipeline,
        _ => content,
    };
    let dispatch = match metadata.get("on") {
        Dv::Map(on) => on.get("dispatch").clone(),
        _ => Dv::Null,
    };
    let mut result = DvMap::new();
    result.insert(
        "dispatchInputs".into(),
        match &dispatch {
            Dv::Map(dispatch) => match dispatch.get("inputs") {
                Dv::Null => Dv::Map(DvMap::new()),
                inputs => inputs.clone(),
            },
            _ => Dv::Map(DvMap::new()),
        },
    );
    Ok(DispatchForm::from_get_result(&result))
}

/// The `run` request's end: whether the mutation was sent, and the new
/// execution id.
pub(crate) struct Started {
    pub(crate) mutation_sent: bool,
    pub(crate) result: Thrown2<String>,
}

/// The `run` request: `pipelines:execute` at most once.
pub(crate) async fn run(
    inner: &Inner,
    computer: &Peer,
    chat: &ChatRef,
    shared: &Shared,
    generation: u64,
    request: (&str, Origin, Option<Value>, &[(String, String)]),
) -> Started {
    let (pipeline_id, origin, lookup, inputs) = request;
    let mut mutation_sent = false;
    let result = async {
        let definition = definition(inner, computer, pipeline_id, origin, lookup).await?;
        let content = map(definition.get("content"))?.clone();
        let cwd = call(
            inner,
            computer,
            "worktree:get-path",
            vec![Value::Object(scope(chat))],
        )
        .await?;
        let info = map(definition.get("info"))?;
        if !shared.current(generation) {
            return Err(Thrown::link(CopyKey::LinkChanged));
        }
        mutation_sent = true;
        let mut options = scope(chat);
        options.insert("pipelineId".into(), json!(pipeline_id));
        options.insert("cwd".into(), cwd);
        options.insert("scope".into(), json!("worktree"));
        options.insert("eventName".into(), json!("dispatch"));
        let mut values = Map::new();
        for (name, value) in inputs {
            values.insert(name.clone(), json!(value));
        }
        options.insert("inputs".into(), Value::Object(values));
        let project = info.get("source").is_str("project");
        if project {
            options.insert(
                "pipelineFilePath".into(),
                dto::bridge_value(info.get("filePath")),
            );
        }
        options.insert(
            "pipelinePreferenceLocator".into(),
            if project {
                json!({"type": "file", "value": dto::bridge_value(info.get("filePath"))})
            } else {
                json!({"type": "stored", "source": origin.name(), "value": pipeline_id})
            },
        );
        let row = read(
            inner,
            computer,
            "pipelines:execute",
            vec![dto::bridge_map(&content), Value::Object(options)],
        )
        .await?;
        Ok(string(map(&row)?, "id")?.to_owned())
    }
    .await;
    Started {
        mutation_sent,
        result,
    }
}

/// `state(ref, id)`: the execution row, checked against the worktree.
async fn state(inner: &Inner, computer: &Peer, chat: &ChatRef, id: &str) -> Thrown2<DvMap> {
    let value = read(inner, computer, "pipelines:get-execution", vec![json!(id)]).await?;
    let row = map(&value)?;
    if !row.get("id").is_str(id)
        || !row.get("project_id").is_str(&chat.project_id)
        || !row.get("worktree_id").is_str(&chat.worktree_id)
    {
        return Err(Thrown::link(CopyKey::DifferentWorktree));
    }
    Ok(row.clone())
}

/// The `get` request: the execution, displayed.
pub(crate) async fn get(
    inner: &Inner,
    computer: &Peer,
    chat: &ChatRef,
    id: &str,
) -> Thrown2<DvMap> {
    display_of(&state(inner, computer, chat, id).await?)
}

/// `RemotePipelineRunAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Control {
    Cancel,
    Retry,
    Resume,
}

/// A cancel, retry or resume: at most one mutation, after a fresh read.
pub(crate) async fn control(
    inner: &Inner,
    computer: &Peer,
    chat: &ChatRef,
    shared: &Shared,
    generation: u64,
    id: &str,
    action: Control,
) -> Thrown2<DvMap> {
    let current = state(inner, computer, chat, id).await?;
    if !shared.current(generation) {
        return Err(Thrown::link(CopyKey::LinkChanged));
    }
    let channel = match action {
        Control::Cancel => "pipelines:cancel-execution",
        Control::Retry => "pipelines:retry-execution",
        Control::Resume => "pipelines:resume",
    };
    let mut args = vec![json!(id)];
    if action == Control::Resume {
        let mut ids = Vec::new();
        for reason in list(current.get("status_reasons"))? {
            if let Dv::Map(reason) = reason
                && let Dv::Str(id) = reason.get("id")
            {
                ids.push(json!(id));
            }
        }
        args.push(json!({"statusReasonIds": ids}));
    }
    let value = read(inner, computer, channel, args).await?;
    let result = map(&value)?;
    if !result.get("project_id").is_str(&chat.project_id)
        || !result.get("worktree_id").is_str(&chat.worktree_id)
    {
        return Err(Thrown::link(CopyKey::ControlChanged));
    }
    display_of(result)
}

/// A content read's source (`RemotePipelineContentSource`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Source {
    StepOutput { job_id: String, step_id: String },
    Report,
}

/// A read document (`RemotePipelineContentDocument`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Document {
    pub(crate) markdown: bool,
    pub(crate) text: String,
}

/// `_content(id, source, current)`.
async fn content_of(
    inner: &Inner,
    computer: &Peer,
    id: &str,
    source: &Source,
    current: &DvMap,
) -> Thrown2<Document> {
    match source {
        Source::Report => {
            let outputs = match current.get("report_outputs") {
                Dv::Null => DvMap::new(),
                other => map(other)?.clone(),
            };
            let as_json =
                outputs.get("report_file").is_null() && !outputs.get("report_json_file").is_null();
            let value = read(
                inner,
                computer,
                "pipelines:read-report-file",
                vec![json!(id), json!(if as_json { "json" } else { "text" })],
            )
            .await?;
            let result = map(&value)?;
            let text = match result.get("content") {
                Dv::Null => String::new(),
                Dv::Str(text) => text.clone(),
                _ => return Err(Thrown::Other),
            };
            let text = if as_json && !text.is_empty() {
                pretty_json(&text).ok_or(Thrown::Other)?
            } else {
                text
            };
            Ok(Document {
                markdown: !as_json,
                text,
            })
        }
        Source::StepOutput { job_id, step_id } => {
            let jobs = map(current.get("jobs"))?;
            let job = jobs.get(job_id);
            let step = match job {
                Dv::Map(job) => match job.get("steps") {
                    Dv::Map(steps) => steps.get(step_id).clone(),
                    _ => Dv::Null,
                },
                _ => Dv::Null,
            };
            let Dv::Map(step) = step else {
                return Err(Thrown::link(CopyKey::StepGone));
            };
            let job = map(job)?;
            let attempt = display::attempt(job).map_err(|_| Thrown::Other)?;
            let iteration = display::iteration(job).map_err(|_| Thrown::Other)?;
            let mut request = Map::new();
            request.insert("executionId".into(), json!(id));
            request.insert("jobId".into(), json!(job_id));
            request.insert("stepId".into(), json!(step_id));
            request.insert("attempt".into(), json!(attempt));
            request.insert("iteration".into(), json!(iteration));
            request.insert(
                "recovery".into(),
                match step.get("recovery_count") {
                    Dv::Null => json!(0),
                    other => dto::bridge_value(other),
                },
            );
            if let Dv::Str(path) = step.get("log_file") {
                request.insert("logFilePath".into(), json!(path));
            }
            let value = read(
                inner,
                computer,
                "pipelines:read-step-log",
                vec![Value::Object(request), json!({"format": "text"})],
            )
            .await?;
            let result = map(&value)?;
            let text = match result.get("text") {
                Dv::Str(text) => text.clone(),
                Dv::Null => match result.get("lines") {
                    Dv::Null => String::new(),
                    lines => lines
                        .elements()
                        .ok_or(Thrown::Other)?
                        .into_iter()
                        .map(Dv::dart_string)
                        .collect::<Vec<_>>()
                        .join("\n"),
                },
                _ => return Err(Thrown::Other),
            };
            Ok(Document {
                markdown: false,
                text,
            })
        }
    }
}

/// `JsonEncoder.withIndent('  ').convert(jsonDecode(text))`; `None` when it
/// is not JSON.
fn pretty_json(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    serde::Serialize::serialize(&value, &mut serializer).ok()?;
    String::from_utf8(out).ok()
}

/// `content(ref, id, source)`: the execution read fresh, then the content.
pub(crate) async fn content(
    inner: &Inner,
    computer: &Peer,
    chat: &ChatRef,
    id: &str,
    source: &Source,
) -> Thrown2<Document> {
    let current = state(inner, computer, chat, id).await?;
    content_of(inner, computer, id, source, &current).await
}

/// The `log` request: the step's output tail on the displayed run.
pub(crate) async fn log(
    inner: &Inner,
    computer: &Peer,
    chat: &ChatRef,
    id: &str,
    job_id: &str,
    step_id: &str,
) -> Thrown2<DvMap> {
    let current = state(inner, computer, chat, id).await?;
    let source = Source::StepOutput {
        job_id: job_id.to_owned(),
        step_id: step_id.to_owned(),
    };
    let output = content_of(inner, computer, id, &source, &current).await?;
    let mut shown = display_of(&current)?;
    let tail = output_tail(&output.text);
    // `display['jobs'] as List`, each job and its variants.
    let Dv::List(mut jobs) = shown.get("jobs").clone() else {
        return Err(Thrown::Other);
    };
    for job in &mut jobs {
        let Dv::Map(job) = job else {
            continue;
        };
        let set = |physical: &mut DvMap| {
            if !physical.get("jobId").is_str(job_id) {
                return;
            }
            if let Dv::List(steps) = physical.get("steps").clone() {
                let steps = steps
                    .into_iter()
                    .map(|step| match step {
                        Dv::Map(mut step) if step.get("stepId").is_str(step_id) => {
                            step.insert("outputTail".into(), Dv::Str(tail.clone()));
                            Dv::Map(step)
                        }
                        other => other,
                    })
                    .collect();
                physical.insert("steps".into(), Dv::List(steps));
            }
        };
        set(job);
        if let Dv::List(mut variants) = job.get("variants").clone() {
            for variant in &mut variants {
                if let Dv::Map(variant) = variant {
                    set(variant);
                }
            }
            job.insert("variants".into(), Dv::List(variants));
        }
    }
    shown.insert("jobs".into(), Dv::List(jobs));
    Ok(shown)
}

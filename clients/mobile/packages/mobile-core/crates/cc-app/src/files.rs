//! The files the computer has open in a worktree (P6): locating a file
//! tab under one of its worktree's roots (roots read once per worktree and
//! connection) and reading files for the viewer. Ported from
//! `device_link/files/{tabs,reader}.dart` and
//! `computer_connect/file_viewer_source.dart`; comments cite the Dart
//! rule they keep. The computer resolves every path and refuses reads
//! outside the worktree's roots, so nothing here grants access.
use crate::chats::Peer;
use crate::{bridge::Inner, error::Error};
use cc_domain::{
    chat::object,
    dart::Dv,
    files::{RootedPath, locate_under_root},
};
use cc_protocol::{FailureKind, dto::desktop_value};
use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;

/// Reads per open viewer, leaving room for chat traffic on the session.
pub(crate) const MAX_CONCURRENT_READS: usize = 2;

/// Why a file tab could not be located.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocateFailure {
    /// No root holds the file, or the roots reply was unreadable
    /// (`DeviceFileReadException`).
    Outside,
    /// The roots could not be read (another `DeviceLinkException`).
    Failed,
}

/// `FileViewerProblem`s a read can end in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Problem {
    NotFound,
    Unsupported,
    Unavailable,
    OutdatedHost,
}

/// One `file:read-content` result.
pub(crate) enum Content {
    Text { text: String, truncated: bool },
    Image(Vec<u8>),
}

type Roots = Shared<BoxFuture<'static, Result<Vec<String>, LocateFailure>>>;

/// One computer's file roots (`DeviceFileLocator`).
#[derive(Default)]
pub(crate) struct Locator {
    roots: Mutex<HashMap<String, Roots>>,
}

async fn call(
    inner: &Inner,
    computer: &Peer,
    channel: &str,
    args: serde_json::Value,
) -> Result<Dv, Error> {
    let rx = inner.request(computer, channel, vec![args])?;
    rx.await
        .unwrap_or_else(|_| Err(cc_protocol::rpc::ended("session_ended")))
        .map(|v| desktop_value(&v))
}

/// `DeviceFileReader.roots()`.
async fn read_roots(
    inner: Arc<Inner>,
    computer: Peer,
    project: String,
    worktree: String,
) -> Result<Vec<String>, LocateFailure> {
    let reply = call(
        &inner,
        &computer,
        "file-tree:roots",
        json!({"projectId": project, "worktreeId": worktree}),
    )
    .await
    .map_err(|_| LocateFailure::Failed)?;
    let response = object(&reply).map_err(|_| LocateFailure::Outside)?;
    let Dv::List(roots) = response.get("roots") else {
        return Err(LocateFailure::Outside);
    };
    Ok(roots
        .iter()
        .filter_map(|root| match root {
            Dv::Map(root) => root.get("absolutePath").as_str().map(str::to_owned),
            _ => None,
        })
        .collect())
}

impl Locator {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Roots>> {
        self.roots.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// `locate(tab)`: which root holds `path`. Roots change when
    /// repositories are added, so a miss reads them again next time.
    pub(crate) async fn locate(
        &self,
        inner: Arc<Inner>,
        computer: Peer,
        project: String,
        worktree: String,
        path: String,
    ) -> Result<RootedPath, LocateFailure> {
        let key = format!("{project}/{worktree}");
        let pending = self
            .lock()
            .entry(key.clone())
            .or_insert_with(|| {
                read_roots(inner, computer, project, worktree)
                    .boxed()
                    .shared()
            })
            .clone();
        let located = match pending.clone().await {
            Ok(roots) => locate_under_root(&roots, &path).ok_or(LocateFailure::Outside),
            Err(failure) => Err(failure),
        };
        if located.is_err() {
            self.forget(&key, &pending);
        }
        located
    }

    /// Drops `pending` so the next locate reads the roots again, unless a
    /// newer read (after a `clear`) already replaced it.
    fn forget(&self, key: &str, pending: &Roots) {
        let mut map = self.lock();
        if map.get(key).is_some_and(|f| f.ptr_eq(pending)) {
            map.remove(key);
        }
    }

    /// Forgets cached roots, for example after a reconnect.
    pub(crate) fn clear(&self) {
        self.lock().clear();
    }
}

/// `data:<type>;base64,<data>`.
fn data_url_bytes(value: &str) -> Option<Vec<u8>> {
    let comma = value.find(',')?;
    if !value.starts_with("data:") || !value[..comma].ends_with(";base64") {
        return None;
    }
    cc_protocol::dto::base64_bytes(&value[comma + 1..])
}

/// One viewer's reads under its file's root (`DeviceFileReader` with
/// `DeviceFileViewerSource`'s failure mapping).
pub(crate) struct Reader {
    location: RootedPath,
    project: String,
    worktree: String,
    slots: Semaphore,
}

impl Reader {
    pub(crate) fn new(location: RootedPath, project: String, worktree: String) -> Self {
        Self {
            location,
            project,
            worktree,
            slots: Semaphore::new(MAX_CONCURRENT_READS),
        }
    }

    /// The viewer closed: queued reads fail without being sent, later
    /// reads at once; reads already sent finish on their own.
    pub(crate) fn close(&self) {
        self.slots.close();
    }

    /// Reads `relative`, a `/`-separated path under the root.
    pub(crate) async fn read(
        &self,
        inner: &Inner,
        computer: &Peer,
        relative: &str,
    ) -> Result<Content, Problem> {
        let Ok(slot) = self.slots.acquire().await else {
            // "The file viewer closed." (`DesktopIpcNotSent`).
            return Err(Problem::Unavailable);
        };
        let reply = call(
            inner,
            computer,
            "file:read-content",
            json!({
                "absolutePath": self.location.absolute(relative),
                "workspaceTarget": {"projectId": self.project, "worktreeId": self.worktree},
            }),
        )
        .await;
        drop(slot);
        let reply = reply.map_err(|error| {
            // A host that does not pass the channel through answers this code.
            if error.kind == FailureKind::Refused && error.code == "remote_channel_unavailable" {
                Problem::OutdatedHost
            } else {
                Problem::Unavailable
            }
        })?;
        let response = object(&reply).map_err(|_| Problem::Unavailable)?;
        let Dv::Str(content) = response.get("content") else {
            return Err(Problem::Unavailable);
        };
        match response.get("kind").as_str() {
            Some("missing") => Err(Problem::NotFound),
            Some("unsupported") => Err(Problem::Unsupported),
            Some("image") => data_url_bytes(content)
                .map(Content::Image)
                .ok_or(Problem::Unavailable),
            Some("text" | "markdown" | "html") => Ok(Content::Text {
                text: content.clone(),
                truncated: response.get("truncated").is_true(),
            }),
            _ => Err(Problem::Unavailable),
        }
    }
}

//! The files the computer has open in a worktree (architecture §3.5, P6):
//! [`FilesService::locate`] finds a file tab's worktree root (roots are
//! read once per worktree and connection), and a [`FileReader`] reads it
//! and the files it links to for the viewer, at most two at a time.
use super::{CoreFailure, CoreInner};
use crate::files::{Content, LocateFailure, Locator, Problem, Reader};
use cc_domain::files::RootedPath;
use std::sync::Arc;

/// A file tab the computer opened in a worktree, usually from an agent's
/// ShowFiles call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileTabView {
    pub project_id: String,
    pub worktree_id: String,
    pub id: String,
    /// The computer's absolute path.
    pub path: String,
    pub title: String,
    /// The folder holding the file, to tell same-named files apart.
    pub folder: Option<String>,
}

/// A file under one of its worktree's roots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileLocationView {
    pub project_id: String,
    pub worktree_id: String,
    pub root: String,
    /// `/`-separated, under `root`; the viewer's path.
    pub relative_path: String,
    /// `\` for Windows paths, `/` otherwise.
    pub separator: String,
}

/// Where a file tab is, or why it cannot open here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocateOutcome {
    Located {
        location: FileLocationView,
    },
    /// No root of the worktree holds the file.
    Outside,
    /// The worktree's roots could not be read.
    Failed,
}

/// Why a file cannot be shown (`FileViewerProblem`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileProblem {
    NotFound,
    Unsupported,
    Unavailable,
    OutdatedHost,
}

/// A read as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileTextOutcome {
    Text { contents: String, truncated: bool },
    Problem { problem: FileProblem },
}

/// A read as bytes (images and the assets a page links to).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileBytesOutcome {
    Bytes { bytes: Vec<u8> },
    Problem { problem: FileProblem },
}

fn problem(p: Problem) -> FileProblem {
    match p {
        Problem::NotFound => FileProblem::NotFound,
        Problem::Unsupported => FileProblem::Unsupported,
        Problem::Unavailable => FileProblem::Unavailable,
        Problem::OutdatedHost => FileProblem::OutdatedHost,
    }
}

/// One computer's files. Built by [`super::AccountService::files`].
#[derive(Clone)]
pub struct FilesService {
    inner: Arc<CoreInner>,
    computer: crate::chats::Peer,
    locator: Arc<Locator>,
}

impl FilesService {
    pub(crate) fn new(inner: Arc<CoreInner>, computer: crate::chats::Peer) -> Self {
        Self {
            inner,
            computer,
            locator: Arc::default(),
        }
    }
    /// Finds which of its worktree's roots holds `tab`. Fails only when
    /// the core shut down or the account it was built in was left.
    pub async fn locate(&self, tab: FileTabView) -> Result<LocateOutcome, CoreFailure> {
        let (locator, app, computer) = (
            self.locator.clone(),
            self.inner.app.clone(),
            self.computer.clone(),
        );
        let scope = computer.scope.clone();
        let (project, worktree) = (tab.project_id.clone(), tab.worktree_id.clone());
        self.inner
            .run(scope.within(async move {
                Ok(
                    match locator
                        .locate(app, computer, project.clone(), worktree.clone(), tab.path)
                        .await
                    {
                        Ok(located) => LocateOutcome::Located {
                            location: FileLocationView {
                                project_id: project,
                                worktree_id: worktree,
                                root: located.root,
                                relative_path: located.relative_path,
                                separator: located.separator.to_string(),
                            },
                        },
                        Err(LocateFailure::Outside) => LocateOutcome::Outside,
                        Err(LocateFailure::Failed) => LocateOutcome::Failed,
                    },
                )
            }))
            .await
    }
    /// Forgets the roots read so far (a reconnect).
    pub fn clear(&self) {
        self.locator.clear();
    }
    /// A reader of `location`'s root for one viewer.
    pub fn reader(&self, location: FileLocationView) -> FileReader {
        let rooted = RootedPath {
            root: location.root,
            relative_path: location.relative_path,
            separator: location.separator.chars().next().unwrap_or('/'),
        };
        FileReader {
            inner: self.inner.clone(),
            computer: self.computer.clone(),
            reader: Arc::new(Reader::new(
                rooted,
                location.project_id,
                location.worktree_id,
            )),
        }
    }
}

/// Reads under one file's root for a viewer.
#[derive(Clone)]
pub struct FileReader {
    inner: Arc<CoreInner>,
    computer: crate::chats::Peer,
    reader: Arc<Reader>,
}

impl FileReader {
    async fn read(&self, path: String) -> Result<Result<Content, Problem>, CoreFailure> {
        let (reader, app, computer) = (
            self.reader.clone(),
            self.inner.app.clone(),
            self.computer.clone(),
        );
        let scope = computer.scope.clone();
        self.inner
            .run(scope.within(async move { Ok(reader.read(&app, &computer, &path).await) }))
            .await
    }
    /// `path` (under the root) as text; an image is unsupported.
    pub async fn read_text(&self, path: String) -> Result<FileTextOutcome, CoreFailure> {
        Ok(match self.read(path).await? {
            Ok(Content::Text { text, truncated }) => FileTextOutcome::Text {
                contents: text,
                truncated,
            },
            Ok(Content::Image(_)) => FileTextOutcome::Problem {
                problem: FileProblem::Unsupported,
            },
            Err(p) => FileTextOutcome::Problem {
                problem: problem(p),
            },
        })
    }
    /// `path`'s bytes: an image's, or a whole text's UTF-8 (a cut-off
    /// script or stylesheet would fail in confusing ways).
    pub async fn read_bytes(&self, path: String) -> Result<FileBytesOutcome, CoreFailure> {
        Ok(match self.read(path).await? {
            Ok(Content::Image(bytes)) => FileBytesOutcome::Bytes { bytes },
            Ok(Content::Text {
                truncated: true, ..
            }) => FileBytesOutcome::Problem {
                problem: FileProblem::Unsupported,
            },
            Ok(Content::Text { text, .. }) => FileBytesOutcome::Bytes {
                bytes: text.into_bytes(),
            },
            Err(p) => FileBytesOutcome::Problem {
                problem: problem(p),
            },
        })
    }
    /// The viewer closed.
    pub fn close(&self) {
        self.reader.close();
    }
}

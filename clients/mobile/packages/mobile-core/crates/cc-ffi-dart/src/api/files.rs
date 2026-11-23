//! The files the computer has open in a worktree (P6): `FilesService`
//! locates a file tab under its worktree's roots, and a `FileReader`
//! reads it and the files it links to for the viewer.
use super::core::CoreFailure;
use flutter_rust_bridge::frb;

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

impl From<cc_core::FileTabView> for FileTabView {
    fn from(v: cc_core::FileTabView) -> Self {
        Self {
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            id: v.id,
            path: v.path,
            title: v.title,
            folder: v.folder,
        }
    }
}

impl From<FileTabView> for cc_core::FileTabView {
    fn from(v: FileTabView) -> Self {
        Self {
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            id: v.id,
            path: v.path,
            title: v.title,
            folder: v.folder,
        }
    }
}

impl From<cc_core::FileLocationView> for FileLocationView {
    fn from(v: cc_core::FileLocationView) -> Self {
        Self {
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            root: v.root,
            relative_path: v.relative_path,
            separator: v.separator,
        }
    }
}

impl From<FileLocationView> for cc_core::FileLocationView {
    fn from(v: FileLocationView) -> Self {
        Self {
            project_id: v.project_id,
            worktree_id: v.worktree_id,
            root: v.root,
            relative_path: v.relative_path,
            separator: v.separator,
        }
    }
}

impl From<cc_core::LocateOutcome> for LocateOutcome {
    fn from(v: cc_core::LocateOutcome) -> Self {
        match v {
            cc_core::LocateOutcome::Located { location } => Self::Located {
                location: location.into(),
            },
            cc_core::LocateOutcome::Outside => Self::Outside,
            cc_core::LocateOutcome::Failed => Self::Failed,
        }
    }
}

impl From<LocateOutcome> for cc_core::LocateOutcome {
    fn from(v: LocateOutcome) -> Self {
        match v {
            LocateOutcome::Located { location } => Self::Located {
                location: location.into(),
            },
            LocateOutcome::Outside => Self::Outside,
            LocateOutcome::Failed => Self::Failed,
        }
    }
}

impl From<cc_core::FileProblem> for FileProblem {
    fn from(v: cc_core::FileProblem) -> Self {
        match v {
            cc_core::FileProblem::NotFound => Self::NotFound,
            cc_core::FileProblem::Unsupported => Self::Unsupported,
            cc_core::FileProblem::Unavailable => Self::Unavailable,
            cc_core::FileProblem::OutdatedHost => Self::OutdatedHost,
        }
    }
}

impl From<FileProblem> for cc_core::FileProblem {
    fn from(v: FileProblem) -> Self {
        match v {
            FileProblem::NotFound => Self::NotFound,
            FileProblem::Unsupported => Self::Unsupported,
            FileProblem::Unavailable => Self::Unavailable,
            FileProblem::OutdatedHost => Self::OutdatedHost,
        }
    }
}

impl From<cc_core::FileTextOutcome> for FileTextOutcome {
    fn from(v: cc_core::FileTextOutcome) -> Self {
        match v {
            cc_core::FileTextOutcome::Text {
                contents,
                truncated,
            } => Self::Text {
                contents,
                truncated,
            },
            cc_core::FileTextOutcome::Problem { problem } => Self::Problem {
                problem: problem.into(),
            },
        }
    }
}

impl From<FileTextOutcome> for cc_core::FileTextOutcome {
    fn from(v: FileTextOutcome) -> Self {
        match v {
            FileTextOutcome::Text {
                contents,
                truncated,
            } => Self::Text {
                contents,
                truncated,
            },
            FileTextOutcome::Problem { problem } => Self::Problem {
                problem: problem.into(),
            },
        }
    }
}

impl From<cc_core::FileBytesOutcome> for FileBytesOutcome {
    fn from(v: cc_core::FileBytesOutcome) -> Self {
        match v {
            cc_core::FileBytesOutcome::Bytes { bytes } => Self::Bytes { bytes },
            cc_core::FileBytesOutcome::Problem { problem } => Self::Problem {
                problem: problem.into(),
            },
        }
    }
}

impl From<FileBytesOutcome> for cc_core::FileBytesOutcome {
    fn from(v: FileBytesOutcome) -> Self {
        match v {
            FileBytesOutcome::Bytes { bytes } => Self::Bytes { bytes },
            FileBytesOutcome::Problem { problem } => Self::Problem {
                problem: problem.into(),
            },
        }
    }
}

/// One computer's files. Built by `AccountService.files`.
#[frb(opaque)]
#[derive(Clone)]
pub struct FilesService {
    inner: cc_core::FilesService,
}

impl FilesService {
    pub(crate) fn new(inner: cc_core::FilesService) -> Self {
        Self { inner }
    }
    /// Finds which of its worktree's roots holds `tab` (roots are read
    /// once per worktree until `clear`). Fails when the core shut down,
    /// and `account_changed` once the account it was built in was left,
    /// also while it ran.
    pub async fn locate(&self, tab: FileTabView) -> Result<LocateOutcome, CoreFailure> {
        self.inner
            .locate(tab.into())
            .await
            .map(Into::into)
            .map_err(Into::into)
    }
    /// Forgets the roots read so far (a reconnect).
    #[frb(sync)]
    pub fn clear(&self) {
        self.inner.clear();
    }
    /// A reader of `location`'s root for one viewer.
    #[frb(sync)]
    pub fn reader(&self, location: FileLocationView) -> FileReader {
        FileReader {
            inner: self.inner.reader(location.into()),
        }
    }
}

/// Reads under one file's root for a viewer, at most two at a time.
#[frb(opaque)]
#[derive(Clone)]
pub struct FileReader {
    inner: cc_core::FileReader,
}

impl FileReader {
    /// `path` (under the root) as text; an image is unsupported.
    pub async fn read_text(&self, path: String) -> Result<FileTextOutcome, CoreFailure> {
        self.inner
            .read_text(path)
            .await
            .map(Into::into)
            .map_err(Into::into)
    }
    /// `path`'s bytes: an image's, or a whole text's UTF-8.
    pub async fn read_bytes(&self, path: String) -> Result<FileBytesOutcome, CoreFailure> {
        self.inner
            .read_bytes(path)
            .await
            .map(Into::into)
            .map_err(Into::into)
    }
    /// The viewer closed: queued reads fail, reads already sent finish.
    #[frb(sync)]
    pub fn close(&self) {
        self.inner.close();
    }
}

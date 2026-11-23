//! A worktree's changed files, their diffs and the files the computer has
//! open (architecture §3.5, P6). Ported from
//! `lib/ui/core/files/{changed_files_grouping,unified_diff_lines}.dart`,
//! `lib/data/models/text_diff.dart`, `lib/device_link/files/{tabs,rooted_path}.dart`
//! and the diff screen's line rules
//! (`computer_connect/file_diff_screen.dart`); comments cite the Dart rule
//! they keep. Pure: no IO.
mod diff;
mod grouping;
mod rooted;
mod tabs;

pub use diff::{
    DiffLine, DiffLineKind, Displayed, MAX_CHARACTERS_PER_LINE, MAX_LINES, TooLarge,
    classify_bounded, display_lines, display_text_diff, strip_file_headers,
};
pub use grouping::{
    DirectoryGroup, Summary, compare_directories_like_desktop, group_by_directory, summarize,
};
pub use rooted::{RootedPath, locate_under_root};
pub use tabs::{FileTab, file_folder, file_tabs};

/// One changed file (`RemoteChangedFile`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangedFile {
    pub path: String,
    /// Git status token (`modified`, `added`, ...).
    pub status: String,
    pub committed: bool,
    pub repo_id: Option<String>,
    pub repo_name: Option<String>,
    pub insertions: Option<i64>,
    pub deletions: Option<i64>,
}

/// Dart's `String.compareTo`: UTF-16 code units in order.
pub(crate) fn compare_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// A string's length in UTF-16 code units (Dart's `length`).
pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

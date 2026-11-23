//! `changed_files_grouping.dart`: changed files under one header per repo
//! and parent directory, in the desktop tree's order.
use super::{ChangedFile, compare_utf16};
use std::cmp::Ordering;

/// Files that share a parent directory (and, in multi-repo worktrees, a
/// repo) (`ChangedFileDirectoryGroup`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryGroup {
    pub repo_id: Option<String>,
    pub repo_name: Option<String>,
    /// Parent directory without a trailing slash; empty for the repo root.
    pub directory: String,
    /// Each file's index in the grouped slice and its last path segment.
    pub files: Vec<(usize, String)>,
}

/// A section header's totals (`ChangedFilesSummary`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    pub file_count: usize,
    pub insertions: i64,
    pub deletions: i64,
}

/// `_compareNames`: case-insensitive first, then case-sensitive.
fn compare_names(a: &str, b: &str) -> Ordering {
    compare_utf16(&a.to_lowercase(), &b.to_lowercase()).then_with(|| compare_utf16(a, b))
}

/// `compareDirectoriesLikeDesktop`: preorder, a directory's subfolders
/// before its own files, so the root (`""`) comes last.
pub fn compare_directories_like_desktop(a: &str, b: &str) -> Ordering {
    if a == b {
        return Ordering::Equal;
    }
    let split = |p: &str| -> Vec<String> {
        if p.is_empty() {
            Vec::new()
        } else {
            p.split('/').map(str::to_owned).collect()
        }
    };
    let (left, right) = (split(a), split(b));
    for (l, r) in left.iter().zip(right.iter()) {
        let cmp = compare_names(l, r);
        if cmp != Ordering::Equal {
            return cmp;
        }
    }
    // One is the other's ancestor: the deeper one first.
    right.len().cmp(&left.len())
}

/// `groupChangedFilesByDirectory`: by repo then parent directory, both
/// sorted, file names sorted inside each group.
pub fn group_by_directory(files: &[&ChangedFile]) -> Vec<DirectoryGroup> {
    // (repo key, directory) in first-seen order, with the last file's repo.
    let mut groups: Vec<((String, String), DirectoryGroup)> = Vec::new();
    for (index, file) in files.iter().enumerate() {
        let (directory, name) = match file.path.rfind('/') {
            Some(slash) => (&file.path[..slash], &file.path[slash + 1..]),
            None => ("", file.path.as_str()),
        };
        let key = (
            file.repo_id.clone().unwrap_or_default(),
            directory.to_owned(),
        );
        let entry = match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, group)) => group,
            None => {
                groups.push((
                    key,
                    DirectoryGroup {
                        repo_id: None,
                        repo_name: None,
                        directory: directory.to_owned(),
                        files: Vec::new(),
                    },
                ));
                &mut groups.last_mut().expect("just pushed").1
            }
        };
        entry.repo_id.clone_from(&file.repo_id);
        entry.repo_name.clone_from(&file.repo_name);
        entry.files.push((index, name.to_owned()));
    }
    groups.sort_by(|(a, _), (b, _)| {
        compare_names(&a.0, &b.0).then_with(|| compare_directories_like_desktop(&a.1, &b.1))
    });
    groups
        .into_iter()
        .map(|(_, mut group)| {
            group.files.sort_by(|a, b| compare_names(&a.1, &b.1));
            group
        })
        .collect()
}

/// `summarizeChangedFiles`.
pub fn summarize(files: &[&ChangedFile]) -> Summary {
    Summary {
        file_count: files.len(),
        insertions: files.iter().map(|f| f.insertions.unwrap_or(0)).sum(),
        deletions: files.iter().map(|f| f.deletions.unwrap_or(0)).sum(),
    }
}

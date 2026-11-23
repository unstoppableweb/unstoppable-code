//! `tabs.dart` `deviceFileTabs`: the files the computer has open in a
//! worktree, usually from an agent's ShowFiles call.
use crate::dart::{Dv, DvMap, is_space};

/// A file tab (`DeviceFileTab`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileTab {
    pub id: String,
    /// The computer's absolute path.
    pub path: String,
    pub title: String,
    /// The folder holding the file, to tell same-named files apart.
    pub folder: Option<String>,
}

fn segments(path: &str) -> Vec<&str> {
    path.split(['\\', '/']).collect()
}

/// `DeviceFileTab.displayFolder`.
pub fn file_folder(path: &str) -> Option<String> {
    let parts = segments(path);
    match parts.len() {
        0 | 1 => None,
        n if parts[n - 2].is_empty() => None,
        n => Some(parts[n - 2].to_owned()),
    }
}

/// The worktree's open file tabs, in tab order; archived tabs and tabs
/// without a file are skipped.
pub fn file_tabs(tabs: &[DvMap]) -> Vec<FileTab> {
    tabs.iter()
        .filter_map(|tab| {
            if !tab.contains_key("kind") || !tab.get("kind").is_str("file") {
                return None;
            }
            let (Dv::Str(id), Dv::Str(path)) = (tab.get("id"), tab.get("filePath")) else {
                return None;
            };
            if path.is_empty() || !tab.get("archivedAt").is_null() {
                return None;
            }
            let title = match tab.get("title") {
                Dv::Str(title) if !title.trim_matches(is_space).is_empty() => {
                    title.trim_matches(is_space).to_owned()
                }
                _ => segments(path)
                    .last()
                    .copied()
                    .unwrap_or_default()
                    .to_owned(),
            };
            Some(FileTab {
                id: id.clone(),
                path: path.clone(),
                title,
                folder: file_folder(path),
            })
        })
        .collect()
}

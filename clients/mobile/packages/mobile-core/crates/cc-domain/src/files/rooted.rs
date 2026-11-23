//! `rooted_path.dart`: which of a worktree's roots holds a computer path.
//! Only the computer decides access; this only builds requests.

/// A computer path split into one of its worktree's roots and a
/// `/`-separated path under it (`DeviceRootedPath`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootedPath {
    pub root: String,
    pub relative_path: String,
    /// `\` for Windows paths, `/` otherwise.
    pub separator: char,
}

impl RootedPath {
    /// The computer path of `relative`, a `/`-separated path under the root.
    pub fn absolute(&self, relative: &str) -> String {
        let mut path = self.root.clone();
        path.push(self.separator);
        path.push_str(&relative.replace('/', &self.separator.to_string()));
        path
    }
}

/// Drive-letter (`C:\`, `C:/`) and UNC (`\\server`) paths.
fn windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/'))
        || path.starts_with("\\\\")
}

/// `locateUnderRoot`: the deepest root containing `absolute_path`. Windows
/// paths compare case-insensitively (ASCII) and take either separator.
pub fn locate_under_root(roots: &[String], absolute_path: &str) -> Option<RootedPath> {
    let windows = windows_path(absolute_path);
    let separator = if windows { '\\' } else { '/' };
    // Folding keeps every byte in place, so offsets carry over.
    let fold = |path: &str| -> String {
        if !windows {
            return path.to_owned();
        }
        path.chars()
            .map(|c| match c {
                '\\' => '/',
                'A'..='Z' => c.to_ascii_lowercase(),
                _ => c,
            })
            .collect()
    };
    let path = fold(absolute_path);
    let mut best: Option<RootedPath> = None;
    for candidate in roots {
        let mut root = candidate.as_str();
        // `root.length > 1` counts UTF-16 units; a trailing `/` is ASCII.
        while root.encode_utf16().count() > 1 && fold(root).ends_with('/') {
            root = &root[..root.len() - 1];
        }
        let folded = fold(root);
        let prefix = if folded.ends_with('/') {
            folded
        } else {
            format!("{folded}/")
        };
        if !path.starts_with(&prefix) || path.len() == prefix.len() {
            continue;
        }
        if best
            .as_ref()
            .is_some_and(|b| b.root.encode_utf16().count() >= root.encode_utf16().count())
        {
            continue;
        }
        let rest = &absolute_path[prefix.len()..];
        best = Some(RootedPath {
            root: absolute_path[..prefix.len() - 1].to_owned(),
            relative_path: if windows {
                rest.replace('\\', "/")
            } else {
                rest.to_owned()
            },
            separator,
        });
    }
    best
}

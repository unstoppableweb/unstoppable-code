//! A changed file's diff: the bounded LCS that builds display hunks from
//! the desktop's before and after text (`text_diff.dart`
//! `displayTextDiff`), the unified-diff line classifier
//! (`unified_diff_lines.dart`) and the diff screen's line limits.
use super::utf16_len;

/// `kRemoteFileDiffMaxLines`: lines classified before the rest is cut.
pub const MAX_LINES: usize = 5000;
/// `kRemoteFileDiffMaxCharactersPerLine`, in UTF-16 units.
pub const MAX_CHARACTERS_PER_LINE: usize = 1000;
/// The LCS table bound, in cells.
const MAX_CELLS: usize = 1_000_000;

/// The edit region is too large to compare on the phone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TooLarge;

/// `displayTextDiff(before, after, context:)`: unified hunks, or empty when
/// the texts' lines are equal.
pub fn display_text_diff(before: &str, after: &str, context: usize) -> Result<String, TooLarge> {
    // A line and whether it is the last line without a newline.
    fn lines(text: &str) -> Vec<(&str, bool)> {
        if text.is_empty() {
            return Vec::new();
        }
        let mut parts: Vec<&str> = text.split('\n').collect();
        if parts.last().is_some_and(|l| l.is_empty()) {
            parts.pop();
        }
        let count = parts.len();
        let open = !text.ends_with('\n');
        parts
            .into_iter()
            .enumerate()
            .map(|(i, line)| (line, i == count - 1 && open))
            .collect()
    }
    let (a, b) = (lines(before), lines(after));
    let shortest = a.len().min(b.len());
    let mut prefix = 0;
    while prefix < shortest && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < shortest - prefix && a[a.len() - suffix - 1] == b[b.len() - suffix - 1] {
        suffix += 1;
    }
    let (n, m) = (a.len() - prefix - suffix, b.len() - prefix - suffix);
    if n == 0 && m == 0 {
        return Ok(String::new());
    }
    if (n + 1).saturating_mul(m + 1) > MAX_CELLS {
        return Err(TooLarge);
    }
    let width = m + 1;
    let mut table = vec![0u32; (n + 1) * width];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[i * width + j] = if a[prefix + i] == b[prefix + j] {
                table[(i + 1) * width + j + 1] + 1
            } else {
                table[(i + 1) * width + j].max(table[i * width + j + 1])
            };
        }
    }
    let at = |i: usize, j: usize| table[i * width + j];
    let mut edits: Vec<(char, (&str, bool))> = a[..prefix].iter().map(|l| (' ', *l)).collect();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && a[prefix + i] == b[prefix + j] {
            edits.push((' ', a[prefix + i]));
            i += 1;
            j += 1;
        } else if i < n && (j == m || at(i + 1, j) >= at(i, j + 1)) {
            edits.push(('-', a[prefix + i]));
            i += 1;
        } else {
            edits.push(('+', b[prefix + j]));
            j += 1;
        }
    }
    edits.extend(a[a.len() - suffix..].iter().map(|l| (' ', *l)));
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (k, _) in edits.iter().enumerate().filter(|(_, e)| e.0 != ' ') {
        let (start, end) = (
            k.saturating_sub(context),
            (k + context + 1).min(edits.len()),
        );
        match ranges.last_mut() {
            Some(last) if start <= last.1 => last.1 = end,
            _ => ranges.push((start, end)),
        }
    }
    // Lines of the old and new text before each edit.
    let mut old_before = vec![0usize; edits.len() + 1];
    let mut new_before = vec![0usize; edits.len() + 1];
    for (k, (kind, _)) in edits.iter().enumerate() {
        old_before[k + 1] = old_before[k] + usize::from(*kind != '+');
        new_before[k + 1] = new_before[k] + usize::from(*kind != '-');
    }
    let mut patch = String::new();
    for (start, end) in ranges {
        let old_count = old_before[end] - old_before[start];
        let new_count = new_before[end] - new_before[start];
        patch.push_str(&format!(
            "@@ -{},{old_count} +{},{new_count} @@\n",
            old_before[start] + usize::from(old_count > 0),
            new_before[start] + usize::from(new_count > 0),
        ));
        for (kind, (text, open)) in &edits[start..end] {
            patch.push(*kind);
            patch.push_str(text);
            patch.push('\n');
            if *open {
                patch.push_str("\\ No newline at end of file\n");
            }
        }
    }
    Ok(patch)
}

/// `UnifiedDiffLineKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffLineKind {
    Add,
    Del,
    Hunk,
    Meta,
    Context,
}

/// One classified patch line; `text` keeps its `+`/`-`/space marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub text: String,
}

/// File-section headers outside a hunk body.
const META_PREFIXES: [&str; 13] = [
    "diff ",
    "index ",
    "--- ",
    "+++ ",
    "new file",
    "deleted file",
    "old mode",
    "new mode",
    "rename ",
    "copy ",
    "similarity ",
    "dissimilarity ",
    "Binary ",
];

const SEMANTIC_META_PREFIXES: [&str; 9] = [
    "new file mode",
    "deleted file mode",
    "old mode",
    "new mode",
    "rename ",
    "copy ",
    "similarity ",
    "dissimilarity ",
    "Binary ",
];

fn classify(text: &str, in_hunk: bool) -> DiffLineKind {
    if text.starts_with("@@") {
        return DiffLineKind::Hunk;
    }
    if text.starts_with("\\ No newline") || text.starts_with("diff ") || text.starts_with("index ")
    {
        return DiffLineKind::Meta;
    }
    if in_hunk {
        return if text.starts_with('+') {
            DiffLineKind::Add
        } else if text.starts_with('-') {
            DiffLineKind::Del
        } else {
            DiffLineKind::Context
        };
    }
    if META_PREFIXES.iter().any(|p| text.starts_with(p)) {
        DiffLineKind::Meta
    } else {
        DiffLineKind::Context
    }
}

/// `classifyUnifiedDiffLinesBounded`: at most `max_lines` lines, and
/// whether any were left out.
pub fn classify_bounded(patch: &str, max_lines: usize) -> (Vec<DiffLine>, bool) {
    let mut lines = Vec::new();
    if patch.is_empty() {
        return (lines, false);
    }
    let mut in_hunk = false;
    let mut rest = patch;
    loop {
        if lines.len() >= max_lines {
            return (lines, true);
        }
        let (text, next) = match rest.find('\n') {
            Some(newline) => (&rest[..newline], Some(&rest[newline + 1..])),
            None => (rest, None),
        };
        let kind = classify(text, in_hunk);
        if kind == DiffLineKind::Hunk {
            in_hunk = true;
        } else if text.starts_with("diff ") || text.starts_with("index ") {
            in_hunk = false;
        }
        lines.push(DiffLine {
            kind,
            text: text.to_owned(),
        });
        match next {
            Some(next) if !next.is_empty() => rest = next,
            _ => break,
        }
    }
    (lines, false)
}

/// `stripUnifiedDiffFileHeaders`: drops headers that restate the screen's
/// own; keeps rename, copy and mode metadata, `Binary files … differ` and
/// `\ No newline at end of file`.
pub fn strip_file_headers(lines: Vec<DiffLine>) -> Vec<DiffLine> {
    lines
        .into_iter()
        .filter(|l| {
            l.kind != DiffLineKind::Meta
                || SEMANTIC_META_PREFIXES.iter().any(|p| l.text.starts_with(p))
                || l.text.starts_with("\\ No newline")
        })
        .collect()
}

/// What the diff screen draws of a patch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Displayed {
    pub lines: Vec<DiffLine>,
    /// Lines past [`MAX_LINES`] were left out.
    pub truncated: bool,
    /// A line was cut at [`MAX_CHARACTERS_PER_LINE`].
    pub line_length_truncated: bool,
}

/// The diff screen's lines: classified up to [`MAX_LINES`], file headers
/// stripped, each line cut to [`MAX_CHARACTERS_PER_LINE`] UTF-16 units
/// with an ellipsis. A cut that splits a surrogate pair drops its high
/// half (Dart kept a lone surrogate, which renders as a replacement).
pub fn display_lines(patch: &str) -> Displayed {
    let (lines, truncated) = classify_bounded(patch, MAX_LINES);
    let lines = strip_file_headers(lines);
    let mut line_length_truncated = false;
    let lines = lines
        .into_iter()
        .map(|line| {
            if utf16_len(&line.text) <= MAX_CHARACTERS_PER_LINE {
                return line;
            }
            line_length_truncated = true;
            let mut units = 0;
            let mut kept = String::new();
            for c in line.text.chars() {
                units += c.len_utf16();
                if units > MAX_CHARACTERS_PER_LINE - 1 {
                    if units - c.len_utf16() < MAX_CHARACTERS_PER_LINE - 1 {
                        kept.push('\u{fffd}');
                    }
                    break;
                }
                kept.push(c);
            }
            kept.push('…');
            DiffLine {
                kind: line.kind,
                text: kept,
            }
        })
        .collect();
    Displayed {
        lines,
        truncated,
        line_length_truncated,
    }
}

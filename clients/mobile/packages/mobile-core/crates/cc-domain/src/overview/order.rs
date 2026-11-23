//! Sidebar orders (`remote_overview_sections.dart`): projects by saved
//! position then id; worktrees by saved position, then the locale-collated
//! title, then the collated local id.
use super::model::{Project, Worktree, WorktreeRow};
use icu_collator::{
    Collator, CollatorBorrowed,
    options::{AlternateHandling, CaseLevel, CollatorOptions, Strength},
};
use icu_locale_core::Locale;
use std::cmp::Ordering;

/// `localeCompare`'s default semantics, as `_compareWorktreeText` builds
/// its ICU collator: tertiary strength, punctuation kept, no case level.
pub struct Collation {
    tag: String,
    collator: CollatorBorrowed<'static>,
}

impl Collation {
    /// The collator for a BCP 47 `tag` (the system locale in Dart); the
    /// root collation when the tag does not parse.
    pub fn new(tag: &str) -> Self {
        let mut options = CollatorOptions::default();
        options.strength = Some(Strength::Tertiary);
        options.alternate_handling = Some(AlternateHandling::NonIgnorable);
        options.case_level = Some(CaseLevel::Off);
        let locale = Locale::try_from_str(tag).unwrap_or(Locale::UNKNOWN);
        let collator = Collator::try_new((&locale).into(), options)
            .or_else(|_| Collator::try_new((&Locale::UNKNOWN).into(), options))
            .expect("root collation data is compiled in");
        Self {
            tag: tag.to_owned(),
            collator,
        }
    }
    pub fn tag(&self) -> &str {
        &self.tag
    }
    pub fn compare(&self, left: &str, right: &str) -> Ordering {
        self.collator.compare(left, right)
    }
}

/// Dart `String.compareTo`: UTF-16 code units.
fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn by_order(left: f64, right: f64) -> Ordering {
    left.partial_cmp(&right).unwrap_or(Ordering::Equal)
}

/// `compareRemoteWorkspaces`: saved positions precede missing ones.
pub fn compare_projects(left: &Project, right: &Project) -> Ordering {
    by_order(
        left.order.unwrap_or(f64::INFINITY),
        right.order.unwrap_or(f64::INFINITY),
    )
    .then_with(|| utf16_cmp(&left.id, &right.id))
}

/// `compareRemoteWorktrees`: a missing position is zero; the title is the
/// trimmed label, else the branch.
pub fn compare_rows(left: &WorktreeRow, right: &WorktreeRow, collation: &Collation) -> Ordering {
    fn title(row: &WorktreeRow) -> &str {
        match row.label.as_deref().map(str::trim) {
            Some(label) if !label.is_empty() => label,
            _ => &row.branch,
        }
    }
    by_order(left.order.unwrap_or(0.0), right.order.unwrap_or(0.0))
        .then_with(|| collation.compare(title(left), title(right)))
        .then_with(|| collation.compare(&left.local_id, &right.local_id))
}

pub fn sort_projects(projects: &mut [Project]) {
    projects.sort_by(compare_projects);
}

/// Sorts the roster by its rows, as `DeviceWorktreesRepository.refresh`
/// does across every project.
pub fn sort_worktrees(worktrees: &mut [Worktree], collation: &Collation) {
    let rows: Vec<WorktreeRow> = worktrees.iter().map(super::rows::worktree_row).collect();
    let mut order: Vec<usize> = (0..worktrees.len()).collect();
    order.sort_by(|&a, &b| compare_rows(&rows[a], &rows[b], collation));
    let mut taken: Vec<Option<Worktree>> = worktrees.iter().cloned().map(Some).collect();
    for (slot, index) in order.into_iter().enumerate() {
        if let Some(worktree) = taken[index].take() {
            worktrees[slot] = worktree;
        }
    }
}

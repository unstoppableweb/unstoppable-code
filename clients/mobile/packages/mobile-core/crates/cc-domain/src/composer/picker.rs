//! The model picker's policy (`model_picker_catalog.dart`, mirroring the
//! desktop `ModelPickerMenu`): harness tabs, vendor sections with Legacy
//! rows, fuzzy search, why a row cannot be picked and the Auto row. Titles
//! and reasons are keys; `words` renders a title where its text orders
//! sections.
use super::model::{ModelOption, ProviderAvailability};
use super::selection::{Metadata, resolve_metadata};
use super::utf16::{index_of, units};
use std::cmp::Ordering;

/// Harness tabs, in desktop rail order after All models.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tab {
    All,
    Claude,
    Codex,
    Cursor,
    Ollama,
    Other,
}

impl Tab {
    pub const VALUES: [Tab; 6] = [
        Tab::All,
        Tab::Claude,
        Tab::Codex,
        Tab::Cursor,
        Tab::Ollama,
        Tab::Other,
    ];

    /// `ModelPickerTab.forHarness`.
    pub fn for_harness(harness: Option<&str>) -> Tab {
        match harness {
            Some("claude") => Tab::Claude,
            Some("codex") => Tab::Codex,
            Some("cursor") => Tab::Cursor,
            Some("ollama") => Tab::Ollama,
            _ => Tab::Other,
        }
    }

    /// The enum member name (`ModelPickerTab.name`).
    pub fn name(self) -> &'static str {
        match self {
            Tab::All => "all",
            Tab::Claude => "claude",
            Tab::Codex => "codex",
            Tab::Cursor => "cursor",
            Tab::Ollama => "ollama",
            Tab::Other => "other",
        }
    }
}

/// A section title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Title {
    Agents,
    /// A declared vendor, trimmed and lowercased.
    Vendor(String),
    Cursor,
    Ollama,
    /// Rows with no declared vendor.
    OtherModels,
    OtherSupported,
    /// A search group: the tab's label.
    Tab(Tab),
}

/// `ModelPickerSection`: rows by their index in the catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub key: String,
    pub title: Title,
    pub rows: Vec<usize>,
    pub legacy: Vec<usize>,
}

/// A model library lock (`modelLibraryUnlockHint`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lock {
    SignIn,
    SignInThenPurchase,
}

impl Lock {
    pub fn of(value: Option<&str>) -> Option<Lock> {
        match value {
            Some("needs_sign_in") => Some(Lock::SignIn),
            Some("needs_sign_in_then_purchase") => Some(Lock::SignInThenPurchase),
            _ => None,
        }
    }
}

/// Why a row cannot be picked (`modelRowDisabledReason`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disabled {
    /// The harness is not connected on the host.
    Connect(Tab),
    CopilotNotConnected,
    AgentUnavailable,
    /// The chat runs on `locked`; `harness` runs the row.
    Locked {
        locked: String,
        harness: String,
    },
    /// `provider` is not signed in on the host.
    NotSignedIn(String),
    Unlock(Lock),
    Unavailable,
}

/// `ModelRoutingAvailability`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Routing {
    Loading,
    Available,
    NoCredits,
    Hidden,
}

/// Why the Auto row cannot be picked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoReason {
    CheckingCredits,
    RunsOnCredits,
    NeedsTwoModels,
}

/// `ModelAutoRow`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AutoRow {
    pub selected: bool,
    pub reason: Option<AutoReason>,
}

/// `modelRowHarness`: its declared harness, else its source, else its
/// provider.
pub fn row_harness(row: &ModelOption) -> &str {
    if let Some(h) = row.harness.as_deref() {
        return h;
    }
    match row.source.as_deref() {
        Some(source) if source != "ai-gateway" => source,
        _ => &row.provider,
    }
}

/// `modelCandidateHarness`.
pub fn candidate_harness<'a>(row: &ModelOption, locked: Option<&'a str>) -> Option<&'a str> {
    let locked = locked?;
    (row_harness(row) == locked || row.harness_providers.iter().any(|(k, _)| k == locked))
        .then_some(locked)
}

/// `modelRowTabHarness`: a native catalog source keeps its tab.
pub fn row_tab_harness(row: &ModelOption) -> &str {
    match row.source.as_deref() {
        Some("ai-gateway") => row_harness(row),
        Some(source) => source,
        None => &row.provider,
    }
}

/// `modelRowTab`.
pub fn row_tab(row: &ModelOption) -> Tab {
    Tab::for_harness(Some(row_tab_harness(row)))
}

/// `modelUsesAiCredits`.
pub fn uses_ai_credits(row: &ModelOption) -> bool {
    row.source.as_deref() == Some("ai-gateway")
}

/// `modelHarnessConnected`: Cursor must be confirmed; the others are
/// optimistic when unknown.
pub fn harness_connected(tab: Tab, availability: Option<&ProviderAvailability>) -> bool {
    match tab {
        Tab::Claude => availability.and_then(|a| a.claude).unwrap_or(true),
        Tab::Codex => availability.and_then(|a| a.codex).unwrap_or(true),
        Tab::Ollama => availability.and_then(|a| a.ollama).unwrap_or(true),
        Tab::Cursor => availability.and_then(|a| a.cursor).unwrap_or(false),
        Tab::All | Tab::Other => true,
    }
}

fn reported_disconnected(tab: Tab, availability: Option<&ProviderAvailability>) -> bool {
    let value = match tab {
        Tab::Claude => availability.and_then(|a| a.claude),
        Tab::Codex => availability.and_then(|a| a.codex),
        Tab::Ollama => availability.and_then(|a| a.ollama),
        Tab::Cursor => availability.and_then(|a| a.cursor),
        Tab::All | Tab::Other => None,
    };
    value == Some(false)
}

/// `modelPickerTabs`: All, then tabs with rows or a reported disconnected
/// harness; connected tabs first.
pub fn tabs(rows: &[ModelOption], availability: Option<&ProviderAvailability>) -> Vec<Tab> {
    let populated: Vec<Tab> = rows.iter().map(row_tab).collect();
    let candidates: Vec<Tab> = Tab::VALUES[1..]
        .iter()
        .copied()
        .filter(|t| populated.contains(t) || reported_disconnected(*t, availability))
        .collect();
    let mut out = vec![Tab::All];
    out.extend(
        candidates
            .iter()
            .filter(|t| harness_connected(**t, availability)),
    );
    out.extend(
        candidates
            .iter()
            .filter(|t| !harness_connected(**t, availability)),
    );
    out
}

/// `modelRowDisabledReason`.
pub fn disabled_reason(
    row: &ModelOption,
    availability: Option<&ProviderAvailability>,
    locked: Option<&str>,
) -> Option<Disabled> {
    let tab = row_tab(row);
    if tab == Tab::Cursor && !harness_connected(tab, availability) {
        return Some(Disabled::Connect(tab));
    }
    let copilot = row.provider == "copilot"
        || row.harness.as_deref() == Some("copilot")
        || row.source.as_deref() == Some("copilot");
    if copilot && !availability.is_some_and(|a| a.is_available("copilot")) {
        return Some(Disabled::CopilotNotConnected);
    }
    if row.kind == "agent" && !row.available {
        return Some(Disabled::AgentUnavailable);
    }
    let harness = row_harness(row);
    if let Some(locked) = locked
        && harness != locked
    {
        return Some(Disabled::Locked {
            locked: locked.to_owned(),
            harness: harness.to_owned(),
        });
    }
    let signed_in = match row.provider.as_str() {
        "claude" => availability.and_then(|a| a.claude),
        "codex" => availability.and_then(|a| a.codex),
        "ollama" => availability.and_then(|a| a.ollama),
        _ => None,
    };
    if row.source.as_deref() != Some("ai-gateway") && signed_in == Some(false) {
        return Some(Disabled::NotSignedIn(row.provider.clone()));
    }
    if let Some(lock) = Lock::of(row.unavailable_reason.as_deref()) {
        return Some(Disabled::Unlock(lock));
    }
    if !row.available {
        return Some(Disabled::Unavailable);
    }
    None
}

/// `modelAutoRow`: `None` when Auto is hidden.
pub fn auto_row(
    selected: bool,
    routing: Routing,
    rows: &[ModelOption],
    availability: Option<&ProviderAvailability>,
    locked: Option<&str>,
) -> Option<AutoRow> {
    if routing == Routing::Hidden {
        return selected.then_some(AutoRow {
            selected: true,
            reason: None,
        });
    }
    let candidates = rows
        .iter()
        .filter(|row| row.kind != "agent" && disabled_reason(row, availability, locked).is_none())
        .count();
    Some(AutoRow {
        selected,
        reason: match routing {
            Routing::Loading => Some(AutoReason::CheckingCredits),
            Routing::NoCredits => Some(AutoReason::RunsOnCredits),
            _ if candidates < 2 => Some(AutoReason::NeedsTwoModels),
            _ => None,
        },
    })
}

/// Dart `String.compareTo`: by UTF-16 code units.
pub fn compare_strings(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn order(row: &ModelOption) -> f64 {
    row.sort_order.unwrap_or(f64::MAX)
}

fn sorted(rows: &[ModelOption], members: &[usize]) -> Vec<usize> {
    let mut out = members.to_vec();
    out.sort_by(|a, b| {
        let (ra, rb) = (&rows[*a], &rows[*b]);
        order(ra)
            .partial_cmp(&order(rb))
            .unwrap_or(Ordering::Equal)
            .then_with(|| compare_strings(&ra.label, &rb.label))
    });
    out
}

fn section(rows: &[ModelOption], key: String, title: Title, members: &[usize]) -> Section {
    let sorted = sorted(rows, members);
    Section {
        key,
        title,
        rows: sorted
            .iter()
            .copied()
            .filter(|i| !rows[*i].show_more_only)
            .collect(),
        legacy: sorted
            .iter()
            .copied()
            .filter(|i| rows[*i].show_more_only)
            .collect(),
    }
}

/// `_sectionOf`: Cursor and Ollama keep their own heading; other rows
/// group by declared vendor.
fn section_of(row: &ModelOption) -> (String, Title) {
    if row.provider == "cursor" && row.source.as_deref().is_none_or(|s| s == "cursor") {
        return ("provider:cursor".into(), Title::Cursor);
    }
    let vendor = row
        .vendor
        .as_deref()
        .map(|v| crate::dart::to_lower(crate::chat::trim(v)))
        .unwrap_or_default();
    if !vendor.is_empty() {
        return (format!("vendor:{vendor}"), Title::Vendor(vendor));
    }
    if row.provider == "ollama" {
        return ("provider:ollama".into(), Title::Ollama);
    }
    ("vendor:unclaimed".into(), Title::OtherModels)
}

fn by_vendor(
    rows: &[ModelOption],
    members: &[usize],
    words: &dyn Fn(&Title) -> String,
) -> Vec<Section> {
    let mut grouped: Vec<((String, Title), Vec<usize>)> = Vec::new();
    for i in members {
        let key = section_of(&rows[*i]);
        match grouped.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(*i),
            None => grouped.push((key, vec![*i])),
        }
    }
    let mut sections: Vec<Section> = grouped
        .into_iter()
        .map(|((key, title), list)| section(rows, key, title, &list))
        .collect();
    let min_order = |s: &Section| {
        s.rows
            .iter()
            .chain(&s.legacy)
            .map(|i| order(&rows[*i]))
            .fold(f64::MAX, f64::min)
    };
    sections.sort_by(|a, b| {
        min_order(a)
            .partial_cmp(&min_order(b))
            .unwrap_or(Ordering::Equal)
            .then_with(|| compare_strings(&words(&a.title), &words(&b.title)))
    });
    sections
}

/// `modelPickerSections`: Agents first; a harness tab keeps only its own
/// Agents.
pub fn sections(rows: &[ModelOption], tab: Tab, words: &dyn Fn(&Title) -> String) -> Vec<Section> {
    let shown: Vec<usize> = (0..rows.len())
        .filter(|i| tab == Tab::All || row_tab(&rows[*i]) == tab)
        .collect();
    let agents: Vec<usize> = shown
        .iter()
        .copied()
        .filter(|i| rows[*i].kind == "agent")
        .collect();
    let models: Vec<usize> = shown
        .iter()
        .copied()
        .filter(|i| rows[*i].kind != "agent")
        .collect();
    let mut out = Vec::new();
    if !agents.is_empty() {
        out.push(Section {
            key: "agents".into(),
            title: Title::Agents,
            rows: sorted(rows, &agents),
            legacy: Vec::new(),
        });
    }
    if tab == Tab::All {
        out.extend(by_vendor(rows, &models, words));
        return out;
    }
    let native: Vec<usize> = if tab == Tab::Other {
        models.clone()
    } else {
        models
            .iter()
            .copied()
            .filter(|i| {
                let row = &rows[*i];
                row.source.as_deref().unwrap_or(&row.provider) == tab.name()
            })
            .collect()
    };
    let borrowed: Vec<usize> = models
        .iter()
        .copied()
        .filter(|i| !native.contains(i))
        .collect();
    out.extend(by_vendor(rows, &native, words));
    if !borrowed.is_empty() {
        out.push(section(
            rows,
            "other-supported".into(),
            Title::OtherSupported,
            &borrowed,
        ));
    }
    out
}

/// `fuzzyModelScore`: lower is better; `None` is no match.
pub fn fuzzy_score(row: &ModelOption, query: &str) -> Option<f64> {
    let needle = units(&crate::dart::to_lower(crate::chat::trim(query)));
    if needle.is_empty() {
        return Some(0.0);
    }
    let haystack = units(&crate::dart::to_lower(&format!(
        "{} {} {}",
        row.label,
        row.id,
        row.vendor.as_deref().unwrap_or("")
    )));
    if let Some(at) = index_of(&haystack, &needle, 0) {
        #[allow(clippy::cast_precision_loss)]
        return Some(at as f64);
    }
    let (mut cursor, mut gaps) = (0usize, 0usize);
    for unit in &needle {
        let found = index_of(&haystack, &[*unit], cursor)?;
        gaps += found - cursor;
        cursor = found + 1;
    }
    #[allow(clippy::cast_precision_loss)]
    Some(100.0 + gaps as f64)
}

/// `modelPickerSearch`: matches grouped by harness tab.
pub fn search(rows: &[ModelOption], query: &str) -> Vec<Section> {
    let mut scored: Vec<(usize, f64)> = rows
        .iter()
        .enumerate()
        .filter_map(|(i, row)| fuzzy_score(row, query).map(|s| (i, s)))
        .collect();
    scored.sort_by(|a, b| {
        a.1.partial_cmp(&b.1)
            .unwrap_or(Ordering::Equal)
            .then_with(|| compare_strings(&rows[a.0].label, &rows[b.0].label))
    });
    Tab::VALUES[1..]
        .iter()
        .filter_map(|tab| {
            let matches: Vec<usize> = scored
                .iter()
                .filter(|(i, _)| row_tab(&rows[*i]) == *tab)
                .map(|(i, _)| *i)
                .collect();
            (!matches.is_empty()).then(|| Section {
                key: format!("search-{}", tab.name()),
                title: Title::Tab(*tab),
                rows: matches,
                legacy: Vec::new(),
            })
        })
        .collect()
}

/// `formatModelContextWindow`: `200K`, `1M`, `1.5M`.
pub fn format_context_window(tokens: Option<i64>) -> Option<String> {
    let tokens = tokens.filter(|t| *t > 0)?;
    let compact = |value: f64, suffix: &str| {
        let rounded = (value * 10.0).round() / 10.0;
        if rounded == rounded.round() {
            #[allow(clippy::cast_possible_truncation)]
            let whole = rounded as i64;
            format!("{whole}{suffix}")
        } else {
            format!("{}{suffix}", crate::dart::double_to_string(rounded))
        }
    };
    #[allow(clippy::cast_precision_loss)]
    let value = tokens as f64;
    Some(if tokens >= 1_000_000 {
        compact(value / 1_000_000.0, "M")
    } else if tokens >= 1000 {
        compact(value / 1000.0, "K")
    } else {
        tokens.to_string()
    })
}

/// What the picker reads of `ComposerControlsData` beside the catalog.
#[derive(Debug, Clone, Copy)]
pub struct Selection<'a> {
    pub selected: Option<&'a str>,
    /// The captured harness, even when unlocked.
    pub execution: Option<&'a str>,
    pub locked: Option<&'a str>,
}

/// The harnesses the selection's Agent supports its concrete model on.
fn agent_support(metadata: &Metadata) -> Option<&Vec<String>> {
    metadata
        .agent_row
        .as_ref()
        .and_then(|row| row.agent_selection.as_ref())
        .and_then(|a| a.supports(metadata.concrete_model_id.as_deref()))
}

/// `ComposerControlsData._selectionHarness` for the next selection's
/// metadata: the captured runtime only when the next Agent can also use it.
/// `current` is the chat's concrete model.
fn selection_harness<'a>(
    next: &Metadata,
    current: Option<&str>,
    selection: Selection<'a>,
) -> Option<&'a str> {
    if selection.locked.is_some() {
        return selection.locked;
    }
    if next.concrete_model_id.is_none() || next.concrete_model_id.as_deref() != current {
        return None;
    }
    if agent_support(next).is_some_and(|support| {
        !selection
            .execution
            .is_some_and(|h| support.iter().any(|s| s == h))
    }) {
        return None;
    }
    candidate_harness(next.model_row.as_ref()?, selection.execution)
}

/// `ComposerControlsData.pickerModels`: every row, Agents included, as it
/// would run when picked.
pub fn picker_models(catalog: &[ModelOption], selection: Selection<'_>) -> Vec<ModelOption> {
    let current = resolve_metadata(catalog, selection.selected, None, None, None).concrete_model_id;
    catalog
        .iter()
        .map(|row| {
            let next = resolve_metadata(catalog, Some(&row.id), None, None, None);
            let harness = candidate_harness(
                next.model_row.as_ref().unwrap_or(row),
                selection_harness(&next, current.as_deref(), selection),
            )
            .filter(|h| agent_support(&next).is_none_or(|s| s.iter().any(|x| x == h)));
            row.for_execution(&row.id, harness)
        })
        .collect()
}

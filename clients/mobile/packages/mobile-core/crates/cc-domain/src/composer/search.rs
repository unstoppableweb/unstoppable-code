//! Identity-first slash search and the capped first view
//! (`composer_command_search.dart`, itself a port of
//! `packages/ui-rich/src/plugins/commandSearch.ts`). The shared vectors in
//! `apps/mobile/test/fixtures/slash-search-vectors.json` pin all three.
//! Strings are measured and cut in UTF-16 code units, as Dart does.
use super::utf16::{Units, contains, units};
use crate::chat::trim;
use std::cmp::Ordering;

/// The searchable fields of one row (`ComposerSearchFields`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Fields {
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub namespace: Option<String>,
    pub member_name: Option<String>,
    pub available: bool,
}

/// `kSlashResultLimit`.
pub const RESULT_LIMIT: usize = 8;
/// `kSlashGroupLimit`.
pub const GROUP_LIMIT: usize = 5;

const MEMBER: i32 = 3;
const QUALIFIED: i32 = 2;
const PLUGIN: i32 = 1;
const LABEL: i32 = 0;

const STOPWORDS: [&str; 22] = [
    "a", "an", "the", "my", "me", "our", "your", "to", "for", "of", "in", "on", "with", "and",
    "or", "this", "that", "it", "is", "be", "do", "please",
];

/// JavaScript `\s` (Dart's `RegExp` without `unicode`).
fn js_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d
            | 0x20
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

/// `[\s:/_\-.,()]`.
fn token_separator(unit: u16) -> bool {
    js_space(unit) || b":/_-.,()".iter().any(|b| u16::from(*b) == unit)
}

/// `normalizeSearchText`: trims, lowercases and strips one leading `/` or
/// `$`.
pub fn normalize(value: Option<&str>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    let lowered = crate::dart::to_lower(trim(value));
    let stripped = lowered
        .strip_prefix('/')
        .or_else(|| lowered.strip_prefix('$'))
        .unwrap_or(&lowered);
    trim(stripped).to_owned()
}

fn tokenize(value: &[u16]) -> Vec<Units> {
    value
        .split(|u| token_separator(*u))
        .filter(|t| !t.is_empty())
        .map(<[u16]>::to_vec)
        .collect()
}

fn query_tokens(normalized: &[u16]) -> Vec<Units> {
    let tokens = tokenize(normalized);
    let meaningful: Vec<Units> = tokens
        .iter()
        .filter(|t| !STOPWORDS.iter().any(|s| units(s) == **t))
        .cloned()
        .collect();
    if meaningful.is_empty() {
        tokens
    } else {
        meaningful
    }
}

/// `[^\p{L}\p{N}]+` splits a lowercased description into words.
fn description_words(value: Option<&str>) -> Vec<Units> {
    let Some(value) = value else {
        return Vec::new();
    };
    let lowered = crate::dart::to_lower(value);
    let mut words = Vec::new();
    let mut word = String::new();
    for c in lowered.chars() {
        if letter_or_number(c) {
            word.push(c);
        } else if !word.is_empty() {
            words.push(units(&std::mem::take(&mut word)));
        }
    }
    if !word.is_empty() {
        words.push(units(&word));
    }
    words
}

/// `\p{L}` or `\p{N}`.
fn letter_or_number(c: char) -> bool {
    use icu_properties::{CodePointMapData, props::GeneralCategory as G};
    matches!(
        CodePointMapData::<G>::new().get(c),
        G::UppercaseLetter
            | G::LowercaseLetter
            | G::TitlecaseLetter
            | G::ModifierLetter
            | G::OtherLetter
            | G::DecimalNumber
            | G::LetterNumber
            | G::OtherNumber
    )
}

struct Identity {
    text: Units,
    tokens: Vec<Units>,
    strength: i32,
}

fn prefix_before_colon(value: &[u16]) -> Units {
    match value.iter().position(|u| *u == u16::from(b':')) {
        Some(index) if index > 0 => value[..index].to_vec(),
        _ => Vec::new(),
    }
}

fn alias_strength(alias: &[u16]) -> i32 {
    if alias.contains(&u16::from(b':')) {
        QUALIFIED
    } else {
        MEMBER
    }
}

fn identities(fields: &Fields) -> Vec<Identity> {
    let name = units(&normalize(Some(&fields.name)));
    let display_name = units(&normalize(fields.display_name.as_deref()));
    let mut plugin = units(&normalize(fields.namespace.as_deref()));
    if plugin.is_empty() {
        plugin = prefix_before_colon(&name);
    }
    if plugin.is_empty() {
        plugin = prefix_before_colon(&display_name);
    }
    let mut member = units(&normalize(fields.member_name.as_deref()));
    if member.is_empty() {
        member = match name.iter().position(|u| *u == u16::from(b':')) {
            Some(index) => name[index + 1..].to_vec(),
            None => name.clone(),
        };
    }
    let qualified = if !plugin.is_empty() && !member.is_empty() {
        let mut q = plugin.clone();
        q.push(u16::from(b':'));
        q.extend(&member);
        q
    } else {
        Vec::new()
    };
    let display_strength = alias_strength(&display_name);
    let candidates = [
        (member, MEMBER),
        (qualified, QUALIFIED),
        (plugin, PLUGIN),
        (display_name, display_strength),
    ];
    let mut seen: Vec<Units> = Vec::new();
    let mut out = Vec::new();
    for (text, strength) in candidates {
        if text.is_empty() || seen.contains(&text) {
            continue;
        }
        seen.push(text.clone());
        out.push(Identity {
            tokens: tokenize(&text),
            text,
            strength,
        });
    }
    out
}

/// `isOneEditApart`: one insertion, deletion, substitution or adjacent
/// transposition.
pub fn one_edit_apart(a: &[u16], b: &[u16]) -> bool {
    if a == b {
        return false;
    }
    let delta = a.len().abs_diff(b.len());
    if delta > 1 {
        return false;
    }
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let rest = |value: &[u16], from: usize| -> Units {
        if from >= value.len() {
            Vec::new()
        } else {
            value[from..].to_vec()
        }
    };
    if a.len() == b.len() {
        if rest(a, start + 1) == rest(b, start + 1) {
            return true;
        }
        return start + 1 < a.len()
            && a[start] == b[start + 1]
            && a[start + 1] == b[start]
            && rest(a, start + 2) == rest(b, start + 2);
    }
    let (longer, shorter) = if a.len() > b.len() { (a, b) } else { (b, a) };
    rest(longer, start + 1) == rest(shorter, start)
}

/// The shortest span holding `query` as an ordered subsequence of `text`.
fn subsequence_span(text: &[u16], query: &[u16]) -> Option<usize> {
    if query.is_empty() {
        return None;
    }
    let mut best: Option<usize> = None;
    for start in 0..text.len() {
        if text[start] != query[0] {
            continue;
        }
        let mut offset = start + 1;
        let mut matched = 1;
        while matched < query.len() && offset < text.len() {
            if text[offset] == query[matched] {
                matched += 1;
            }
            offset += 1;
        }
        if matched < query.len() {
            break;
        }
        let span = offset - start;
        if best.is_none_or(|b| span < b) {
            best = Some(span);
        }
    }
    best
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Match {
    tier: i32,
    strength: i32,
    exact_tokens: usize,
    span: i64,
}

fn compare_matches(a: &Match, b: &Match) -> Ordering {
    a.tier
        .cmp(&b.tier)
        .then(b.strength.cmp(&a.strength))
        .then(b.exact_tokens.cmp(&a.exact_tokens))
        .then(a.span.cmp(&b.span))
}

struct Query {
    full: Units,
    tokens: Vec<Units>,
}

fn prefixes(token: &[u16], words: &[Units]) -> bool {
    words.iter().any(|w| w.starts_with(token))
}

fn count_exact(tokens: &[Units], words: &[Units]) -> usize {
    tokens.iter().filter(|t| words.contains(t)).count()
}

fn match_identity(identity: &Identity, query: &Query) -> Option<Match> {
    let exact_tokens = count_exact(&query.tokens, &identity.tokens);
    let make = |tier: i32, span: i64| Match {
        tier,
        strength: identity.strength,
        exact_tokens,
        span,
    };
    if identity.text == query.full {
        return Some(make(1, 0));
    }
    if identity.text.starts_with(&query.full) {
        return Some(make(2, 0));
    }
    if query.full.len() < 2 {
        return None;
    }
    let has_tokens = !query.tokens.is_empty();
    if contains(&identity.text, &query.full)
        || (has_tokens && query.tokens.iter().all(|t| prefixes(t, &identity.tokens)))
    {
        return Some(make(3, 0));
    }
    if has_tokens {
        let mut used_edit = false;
        let typo = query.tokens.iter().all(|token| {
            if prefixes(token, &identity.tokens) {
                return true;
            }
            if token.len() < 4 {
                return false;
            }
            let edited = identity.tokens.iter().any(|w| one_edit_apart(token, w));
            used_edit = used_edit || edited;
            edited
        });
        if typo && used_edit {
            #[allow(clippy::cast_possible_wrap)]
            let span = identity.tokens.len() as i64 - query.tokens.len() as i64;
            return Some(make(4, span));
        }
    }
    let span = if query.tokens.len() > 1 {
        subsequence_span(&identity.text, &query.full)
    } else {
        None
    };
    #[allow(clippy::cast_possible_wrap)]
    span.map(|s| make(6, s as i64))
}

fn match_row(fields: &Fields, query: &Query) -> Option<Match> {
    let mut candidates: Vec<Match> = identities(fields)
        .iter()
        .filter_map(|i| match_identity(i, query))
        .collect();
    if query.full.len() >= 2 && !query.tokens.is_empty() {
        let description = description_words(fields.description.as_deref());
        if query.tokens.iter().all(|t| description.contains(t)) {
            candidates.push(Match {
                tier: 5,
                strength: LABEL,
                exact_tokens: count_exact(&query.tokens, &description),
                span: 0,
            });
        }
    }
    let mut best: Option<Match> = None;
    for candidate in candidates {
        if best.is_none_or(|b| compare_matches(&candidate, &b) == Ordering::Less) {
            best = Some(candidate);
        }
    }
    best
}

/// `searchComposerItems`: the indices of the matching rows, ranked. An
/// empty query keeps every row in order.
pub fn search(rows: &[Fields], query: &str) -> Vec<usize> {
    let full = units(&normalize(Some(query)));
    if full.is_empty() {
        return (0..rows.len()).collect();
    }
    let prepared = Query {
        tokens: query_tokens(&full),
        full,
    };
    let mut ranked: Vec<(usize, Match, bool)> = rows
        .iter()
        .enumerate()
        .filter_map(|(i, f)| match_row(f, &prepared).map(|m| (i, m, f.available)))
        .collect();
    ranked.sort_by(|a, b| {
        compare_matches(&a.1, &b.1)
            .then_with(|| a.2.cmp(&b.2))
            .then(a.0.cmp(&b.0))
    });
    let has_identity = ranked.iter().any(|r| r.1.tier <= 4);
    let has_description = ranked.iter().any(|r| r.1.tier == 5);
    ranked
        .into_iter()
        .filter(|r| {
            if has_identity {
                r.1.tier <= 4 || (r.1.tier == 5 && prepared.tokens.len() > 1)
            } else if has_description {
                r.1.tier == 5
            } else {
                true
            }
        })
        .map(|r| r.0)
        .collect()
}

/// `limitSlashResults`: the visible rows' positions and how many were
/// hidden.
pub fn limit(
    groups: &[String],
    total: Option<usize>,
    per_group: Option<usize>,
) -> (Vec<usize>, usize) {
    let total = total.filter(|t| *t > 0).unwrap_or(RESULT_LIMIT);
    let per_group = per_group.filter(|g| *g > 0).unwrap_or(GROUP_LIMIT);
    let mut counts: Vec<(&str, usize)> = Vec::new();
    let mut visible = Vec::new();
    for (i, key) in groups.iter().enumerate() {
        if visible.len() >= total {
            break;
        }
        let count = counts.iter_mut().find(|(k, _)| *k == key.as_str());
        let current = count.as_ref().map_or(0, |(_, c)| *c);
        if current >= per_group {
            continue;
        }
        match count {
            Some((_, c)) => *c += 1,
            None => counts.push((key, 1)),
        }
        visible.push(i);
    }
    let hidden = groups.len() - visible.len();
    (visible, hidden)
}

/// `groupContiguousRuns`: `(key, occurrence, positions)`.
pub fn runs(groups: &[String]) -> Vec<(String, usize, Vec<usize>)> {
    let mut out: Vec<(String, usize, Vec<usize>)> = Vec::new();
    let mut occurrences: Vec<(String, usize)> = Vec::new();
    for (i, key) in groups.iter().enumerate() {
        if let Some(last) = out.last_mut()
            && last.0 == *key
        {
            last.2.push(i);
            continue;
        }
        let occurrence = match occurrences.iter_mut().find(|(k, _)| k == key) {
            Some((_, n)) => {
                *n += 1;
                *n - 1
            }
            None => {
                occurrences.push((key.clone(), 1));
                0
            }
        };
        out.push((key.clone(), occurrence, vec![i]));
    }
    out
}

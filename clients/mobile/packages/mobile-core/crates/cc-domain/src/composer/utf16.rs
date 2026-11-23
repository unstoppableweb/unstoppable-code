//! Dart `String` operations on UTF-16 code units, for rules that index,
//! measure or cut strings the way Dart does.

/// A Dart string as its code units.
pub(crate) type Units = Vec<u16>;

pub(crate) fn units(text: &str) -> Units {
    text.encode_utf16().collect()
}

/// `haystack.indexOf(needle, from)`.
pub(crate) fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return (from <= haystack.len()).then_some(from);
    }
    if needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&i| haystack[i..].starts_with(needle))
}

/// `haystack.contains(needle)`.
pub(crate) fn contains(haystack: &[u16], needle: &[u16]) -> bool {
    index_of(haystack, needle, 0).is_some()
}

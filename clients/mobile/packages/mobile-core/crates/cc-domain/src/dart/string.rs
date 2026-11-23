//! Dart string rules.

/// Dart's `\s` and what `String.trim()` removes: JavaScript whitespace and
/// line terminators.
pub fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// Dart's `String.toLowerCase()`: each character's full lowercase mapping,
/// without the context rules (a final sigma stays `σ`).
pub fn to_lower(text: &str) -> String {
    text.chars().flat_map(char::to_lowercase).collect()
}

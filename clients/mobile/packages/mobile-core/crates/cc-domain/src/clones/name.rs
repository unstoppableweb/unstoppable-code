//! `repositoryNameFromCloneUrl` (`data/models/git_remote_url.dart`, a port
//! of the protocol's rule), with the part of Dart's `Uri.tryParse` it reads:
//! the path of a `scheme://` URL.
use crate::dart::is_space;

/// The name a clone of `url` gets, for display only. Credentials, query
/// and fragment never reach it. `None` takes the generic name, which the
/// app words.
pub fn repository_name(url: &str) -> Option<String> {
    let trimmed = url.trim_matches(is_space);
    let mut path = trimmed.to_owned();
    if any_scheme(trimmed) {
        path = uri_path(trimmed)?;
    } else if let Some(colon) = scp_prefix(trimmed) {
        path = trimmed[colon + 1..].to_owned();
    }
    let path = path.trim_end_matches(['/', '\\']);
    let segment = path.rsplit(['/', '\\']).next().unwrap_or("");
    let name = segment.strip_suffix(".git").unwrap_or(segment);
    (!name.is_empty()).then(|| name.to_owned())
}

/// `^[a-z][a-z\d+.-]*://` (case-insensitive).
fn any_scheme(text: &str) -> bool {
    let Some(end) = text.find("://") else {
        return false;
    };
    let mut chars = text[..end].chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// `^[^/\\]+@[^/\\]+:`: the index of the first `:` in `text` when it
/// matches (Dart then takes everything after `indexOf(':')`).
fn scp_prefix(text: &str) -> Option<usize> {
    // Before the first separator: an `@` after at least one character, and
    // a `:` at least one character after that `@`.
    let head = &text[..text.find(['/', '\\']).unwrap_or(text.len())];
    let matches = head.char_indices().any(|(at, c)| {
        c == '@'
            && at > 0
            && head[at + 1..]
                .char_indices()
                .any(|(colon, c)| c == ':' && colon > 0)
    });
    if matches { text.find(':') } else { None }
}

/// `Uri.tryParse(text)?.path` for a `scheme://` URL: `None` when Dart
/// cannot parse it (a port that is not a number, a bracket outside an
/// IPv6 host).
fn uri_path(text: &str) -> Option<String> {
    let rest = &text[text.find("://")? + 3..];
    let end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
    let (authority, after) = rest.split_at(end);
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let port = if let Some(bracketed) = host_port.strip_prefix('[') {
        let (_, after) = bracketed.split_once(']')?;
        after.strip_prefix(':').unwrap_or(after)
    } else {
        if host_port.contains(['[', ']']) {
            return None;
        }
        host_port.rsplit_once(':').map_or("", |(_, port)| port)
    };
    if !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let path_end = after.find(['?', '#']).unwrap_or(after.len());
    Some(normalize_path(&after[..path_end].replace('\\', "/")))
}

/// Dart's path normalization: a valid percent escape of an unreserved
/// character is decoded and others are upper-cased, a `%` without one is
/// `%25`, and characters a path cannot hold are percent-encoded (UTF-8).
fn normalize_path(path: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let unreserved = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~');
    let allowed = |b: u8| {
        unreserved(b)
            || matches!(
                b,
                b'!' | b'$'
                    | b'&'
                    | b'\''
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b';'
                    | b'='
                    | b':'
                    | b'@'
                    | b'/'
            )
    };
    let bytes = path.as_bytes();
    let mut out = String::with_capacity(path.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            let escape = path
                .get(i + 1..i + 3)
                .filter(|hex| hex.bytes().all(|h| h.is_ascii_hexdigit()))
                .and_then(|hex| u8::from_str_radix(hex, 16).ok().map(|v| (hex, v)));
            match escape {
                Some((_, value)) if unreserved(value) => out.push(char::from(value)),
                Some((hex, _)) => {
                    out.push('%');
                    out.push_str(&hex.to_ascii_uppercase());
                }
                None => {
                    out.push_str("%25");
                    i += 1;
                    continue;
                }
            }
            i += 3;
        } else if allowed(b) {
            out.push(char::from(b));
            i += 1;
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(b >> 4)]));
            out.push(char::from(HEX[usize::from(b & 15)]));
            i += 1;
        }
    }
    out
}

//! Dart's `Uri.tryParse(..).port`.

/// `Uri.tryParse(text)?.port`: the explicit port, else 80 for `http` and
/// 443 for `https`, else 0; `None` when Dart cannot parse it.
pub fn uri_port(text: &str) -> Option<i64> {
    let scheme_end = text.find(':').filter(|&end| {
        let scheme = &text[..end];
        let mut chars = scheme.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    });
    let scheme = scheme_end.map_or(String::new(), |end| text[..end].to_ascii_lowercase());
    let rest = scheme_end.map_or(text, |end| &text[end + 1..]);
    let default = match scheme.as_str() {
        "http" => 80,
        "https" => 443,
        _ => 0,
    };
    let Some(authority) = rest.strip_prefix("//") else {
        return Some(default);
    };
    let authority = &authority[..authority.find(['/', '?', '#']).unwrap_or(authority.len())];
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let port = if let Some(bracketed) = host_port.strip_prefix('[') {
        let (_, after) = bracketed.split_once(']')?;
        match after.strip_prefix(':') {
            Some(port) => port,
            None if after.is_empty() => "",
            None => return None,
        }
    } else {
        host_port.rsplit_once(':').map_or("", |(_, port)| port)
    };
    if port.is_empty() {
        return Some(default);
    }
    if !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    port.parse().ok()
}

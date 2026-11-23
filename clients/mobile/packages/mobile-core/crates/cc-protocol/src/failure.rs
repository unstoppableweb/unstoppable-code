//! Typed failure envelope: `{kind, code, message?, status?, protocolVersion?}`.
//! `kind` tells callers whether the desktop answered (`refused`), the request
//! never reached the session writer (`not_sent`, safe to retry), it was sent
//! and then lost (`timeout`, `ended`), or the core or HTTP failed (`local`,
//! `http`). Messages repeat the Dart transport's user-facing wording.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Local,
    Refused,
    NotSent,
    Timeout,
    Ended,
    Http,
}

#[derive(Debug, Clone)]
pub struct RpcFailure {
    pub kind: FailureKind,
    pub code: String,
    pub message: Option<String>,
    pub status: Option<u16>,
    pub protocol_version: Option<u64>,
    /// Seconds from an HTTP `Retry-After`, when positive.
    pub retry_after: Option<u64>,
    /// For a cancelled `connect`: the step it interrupted (`relay`,
    /// `handshake` or `request`).
    pub step: Option<&'static str>,
}
impl RpcFailure {
    pub fn new(code: &str) -> Self {
        Self {
            kind: FailureKind::Local,
            code: code.into(),
            message: None,
            status: None,
            protocol_version: None,
            retry_after: None,
            step: None,
        }
    }
    pub fn http(status: u16, code: &str) -> Self {
        Self {
            kind: FailureKind::Http,
            status: Some(status),
            ..Self::new(code)
        }
    }
    pub fn of(kind: FailureKind, code: &str, message: &str) -> Self {
        Self {
            kind,
            message: Some(message.into()),
            ..Self::new(code)
        }
    }
    /// A local failure with the Dart transport's message.
    pub fn local(code: &str, message: &str) -> Self {
        Self::of(FailureKind::Local, code, message)
    }
    pub fn with_message(mut self, message: &str) -> Self {
        self.message = Some(message.into());
        self
    }
}
pub type Result<T> = std::result::Result<T, RpcFailure>;
/// A required string field of a JSON object: non-empty and at most 4096
/// bytes, else `invalid_input`.
pub fn field<'a>(v: &'a serde_json::Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(|| RpcFailure::new("invalid_input"))
}

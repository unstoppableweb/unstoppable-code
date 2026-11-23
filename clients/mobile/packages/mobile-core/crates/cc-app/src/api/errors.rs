pub use cc_protocol::FailureKind;
use cc_protocol::RpcFailure;

/// A failed core operation: `kind` says whether the desktop answered
/// (`Refused`), the request never reached the session writer (`NotSent`,
/// safe to retry), it was sent and then lost (`Timeout`, `Ended`), or the
/// core or HTTP failed (`Local`, `Http`). `message` repeats the Dart
/// transport's user-facing wording when the core has one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreFailure {
    pub kind: FailureKind,
    pub code: String,
    pub message: Option<String>,
    pub status: Option<u16>,
    pub protocol_version: Option<u64>,
    /// Seconds from an HTTP `Retry-After`, when positive.
    pub retry_after: Option<u64>,
    /// For a cancelled connect: the step it interrupted (`relay`,
    /// `handshake` or `request`).
    pub step: Option<String>,
}

impl CoreFailure {
    pub(crate) fn local(code: &str) -> Self {
        RpcFailure::new(code).into()
    }
}

impl From<RpcFailure> for CoreFailure {
    fn from(e: RpcFailure) -> Self {
        Self {
            kind: e.kind,
            code: e.code,
            message: e.message,
            status: e.status,
            protocol_version: e.protocol_version,
            retry_after: e.retry_after,
            step: e.step.map(String::from),
        }
    }
}

impl std::fmt::Display for CoreFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?} {}", self.kind, self.code)
    }
}
impl std::error::Error for CoreFailure {}

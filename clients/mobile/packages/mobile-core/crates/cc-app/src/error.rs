pub(crate) use cc_protocol::{Result, RpcFailure as Error, field};

/// A required text input: non-empty and at most 4096 bytes, else
/// `invalid_input` (the JSON ABI's field rule).
pub(crate) fn required(value: &str) -> Result<&str> {
    if value.is_empty() || value.len() > 4096 {
        return Err(Error::new("invalid_input"));
    }
    Ok(value)
}

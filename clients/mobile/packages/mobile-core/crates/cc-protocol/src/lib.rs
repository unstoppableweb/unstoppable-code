//! The Computer Connect wire contract with the desktop and the device relay:
//! the V8 value codec with fragmentation and deflate ([`v8`]), the secure
//! handshake and channel ([`secure`]), RPC envelopes, refusals and version
//! rules ([`rpc`]), relay message rules ([`relay`]) and the typed failure
//! every layer reports ([`RpcFailure`]), the desktop channel decoders of
//! the ported read models ([`desktop`]) and the Dart DTO view of a desktop
//! value ([`dto`]). Deterministic: no sockets or IO.
pub mod desktop;
pub mod dto;
mod failure;
pub mod relay;
pub mod rpc;
pub mod secure;
pub mod v8;

pub use failure::{FailureKind, Result, RpcFailure, field};

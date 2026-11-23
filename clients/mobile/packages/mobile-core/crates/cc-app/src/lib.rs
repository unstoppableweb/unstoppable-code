//! Computer Connect use cases. The public surface is [`api`]; [`ports`] is
//! for the adapters in `cc-infra` and the composition root in `cc-core`.
//! Everything else is crate-private.
mod account;
mod activity;
pub mod api;
mod assemble;
mod bridge;
mod cache;
mod chats;
mod computers;
mod copy;
mod error;
mod failures;
mod files;
mod home;
mod interest;
mod orchestrator;
mod outbox;
mod overview;
mod owners;
mod pipelines;
pub mod ports;
mod projects;
mod push;
mod usage;
mod worktrees;

#[cfg(cc_scratch)]
#[rustfmt::skip]
#[path = "__scratch__/mod.rs"]
mod scratch;

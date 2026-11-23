//! The Dart-visible surface. `flutter_rust_bridge_codegen` reads only this
//! module tree (`rust_input: crate::api`): opaque handles over the
//! `cc_core` services and plain re-declared DTOs, converted at the edge.
pub mod activity;
pub mod app_auth_http;
pub mod auth;
pub mod bridge;
pub mod chats;
pub mod composer;
pub mod computers;
pub mod core;
pub mod diagnostics;
pub mod files;
pub mod handler;
pub mod home;
pub mod orchestrator;
pub mod overview;
pub mod pipelines;
pub mod projects;
pub mod usage;
pub mod worktrees;

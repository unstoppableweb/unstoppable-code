//! A computer's overview read models: the worktree roster and its rows,
//! context scopes and attention, Cowork chat states and Recents. Pure
//! types and rules; `cc-protocol::desktop` decodes the desktop's replies
//! into them and `cc-app::overview` owns their lifetime.
//!
//! Ported from `lib/device_link/worktrees/{repository,row_projection,
//! context_scope}.dart`, `lib/device_link/chats/{overview_repository,
//! scope_state,recents}.dart`, `computer_connect/recent_chat_inventory.dart`
//! and the shared `lib/data/models/remote_{overview_sections,context_scope,
//! session}.dart` helpers they call. Comments cite the Dart rule they keep.
mod model;
mod order;
mod recents;
mod rows;
mod scope;

pub use model::*;
pub use order::{Collation, compare_projects, compare_rows, sort_projects, sort_worktrees};
pub use recents::{RecentAttention, RecentChat, interleave_recents, recent_chats};
pub use rows::{chat_scope_status, pipeline_statuses, worktree_chats, worktree_row};
pub use scope::{Attention, AttentionEntry, ContextScope, attention_entries, context_scope};

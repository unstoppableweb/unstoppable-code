//! The chat composer's catalog and choices (architecture §3.4, P5c): the
//! model catalog rows and their selection rules, effort levels and speed,
//! the model picker's tabs, sections and search, the slash-command
//! search, the composer catalogs the desktop projects, and the settings
//! picks' optimistic patches. Ported from `data/models/{chat_message
//! (ModelOption, ProviderAvailability), agent_catalog_selection,
//! agent_model_selection, selection_metadata}.dart`,
//! `device_link/chats/{model_registry,default_model,composer,
//! composer_catalog}.dart`, `ui/core/chat/view_models/{thinking_levels,
//! composer_effort,model_picker_catalog,composer_command_search}.dart` and
//! the composer controls in `computer_connect/chat_controls.dart`;
//! comments cite the Dart rule they keep.
//!
//! Words are not built here: picker titles, hints and reasons are keys
//! (`cc-app::copy::composer` words them).
pub mod catalog;
pub mod controls;
pub mod model;
pub mod pick;
pub mod picker;
pub mod registry;
pub mod search;
pub mod selection;
mod utf16;

pub use model::{AgentSelection, ModelOption, ProviderAvailability, THINKING_LEVEL_ORDER};

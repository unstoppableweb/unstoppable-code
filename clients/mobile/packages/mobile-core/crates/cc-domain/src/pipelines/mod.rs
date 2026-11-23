//! Pipelines (architecture §3.6, P7): the desktop execution row projected
//! onto the shared run shape ([`display`]), the run model with its merge
//! and recency order ([`run`]), the dispatchable pipelines and the start
//! form with its rules ([`dispatch`]), which chat turn a run belongs to
//! ([`chat_activity`]) and the run presentation ([`presentation`]). Ported
//! from `device_link/pipelines/{display,chat_activity}.dart` and the parts
//! of `data/models/computer_activity/pipeline_{run,dispatch}.dart` and
//! `ui/core/{pipelines,activity}` Computer Connect reads (shared with
//! Remote Control, which keeps the Dart copies until cleanup C5).
pub mod chat_activity;
pub mod dispatch;
pub mod display;
pub mod presentation;
pub mod run;

pub use chat_activity::{TurnRuns, chat_activity, receipt_ids_of};
pub use dispatch::{
    Descriptor, DispatchForm, InputDefinition, InputError, InputType, Number, Origin,
};
pub use run::{
    ChatFollowUp, ChatTurn, Job, Pause, Progress, Run, StatusReason, Step, Variant, compare_recency,
};

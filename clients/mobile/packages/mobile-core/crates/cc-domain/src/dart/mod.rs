//! Dart runtime behavior the ported rules depend on, in one place so every
//! feature reads desktop values and prints numbers, dates and URLs the way
//! the Dart product layer did:
//!
//! - [`value`] — a desktop value as Dart code holds it ([`Dv`], `x is Map`,
//!   `x as String?`, `'${x}'`, the generated `fromJson` list rule);
//! - [`number`] — `double.toString()` and `'$n'`;
//! - [`date`] — `DateTime.tryParse`, `fromMillisecondsSinceEpoch`,
//!   `toIso8601String` and `toString` (UTC only: the core has no time zone
//!   data; desktops send `Z` timestamps);
//! - [`uri`] — `Uri.tryParse(..).port`;
//! - [`string`] — Dart's `\s` and `trim()`;
//! - [`sort`] — `List.sort` (not stable).
//!
//! Each keeps the Dart SDK's output for the inputs desktop payloads carry.
//! Pure: no IO and no wire format (`cc-protocol::dto` decodes the bridge
//! form into [`Dv`]).
pub mod date;
pub mod number;
pub mod sort;
pub mod string;
pub mod uri;
pub mod value;

pub use date::{Micros, date_to_string, from_millis, iso8601, parse_datetime, parse_millis};
pub use number::{double_to_string, num_to_string};
pub use string::{is_space, to_lower};
pub use uri::uri_port;
pub use value::{CastError, Dv, DvMap};

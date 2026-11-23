//! The pipelines a worktree can run and the form that starts one:
//! `RemotePipelineDescriptor`, `RemotePipelineInputDefinition` and
//! `RemotePipelineDispatchForm` (`data/models/computer_activity/
//! pipeline_dispatch.dart`), and the form rules of
//! `ui/core/pipelines/pipeline_input_form.dart` (both shared with Remote
//! Control).
use crate::dart::{Dv, DvMap, double_to_string, is_space};

fn non_empty(value: &Dv) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn strings(value: &Dv) -> Vec<String> {
    value
        .elements()
        .map(|items| items.into_iter().filter_map(non_empty).collect())
        .unwrap_or_default()
}

/// `RemotePipelineOrigin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Bundled,
    User,
    Project,
    Shared,
    Curated,
}

impl Origin {
    /// `origin.name`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Bundled => "bundled",
            Self::User => "user",
            Self::Project => "project",
            Self::Shared => "shared",
            Self::Curated => "curated",
        }
    }
}

/// `RemotePipelineDescriptor`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Descriptor {
    pub pipeline_id: String,
    pub name: String,
    pub description: Option<String>,
    pub origin: Origin,
    pub trigger_types: Vec<String>,
    pub scopes: Vec<String>,
}

impl Descriptor {
    /// `RemotePipelineDescriptor.fromJson`.
    pub fn from_json(value: &Dv) -> Option<Self> {
        let Dv::Map(value) = value else {
            return None;
        };
        let pipeline_id =
            non_empty(value.get("pipelineId")).or_else(|| non_empty(value.get("localId")))?;
        let scopes = strings(value.get("scopes"));
        Some(Self {
            name: non_empty(value.get("name")).unwrap_or_else(|| pipeline_id.clone()),
            description: non_empty(value.get("description")),
            origin: match value.get("origin").as_str() {
                Some("bundled") => Origin::Bundled,
                Some("user") => Origin::User,
                Some("shared") => Origin::Shared,
                Some("curated") => Origin::Curated,
                _ => Origin::Project,
            },
            trigger_types: strings(value.get("triggerTypes")),
            scopes: if scopes.is_empty() {
                vec!["directory".into()]
            } else {
                scopes
            },
            pipeline_id,
        })
    }

    /// `isDispatchable`.
    pub fn is_dispatchable(&self) -> bool {
        self.trigger_types.iter().any(|t| t == "dispatch")
            && self
                .scopes
                .iter()
                .any(|s| s == "directory" || s == "worktree")
            && self.origin != Origin::Shared
            && !self.pipeline_id.starts_with("shared:")
    }
}

/// `RemotePipelineInputType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputType {
    String,
    Boolean,
    Number,
    Choice,
}

/// A `num` from the wire, keeping Dart's `int`/`double` distinction for
/// printing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Number {
    pub value: f64,
    pub integer: bool,
}

impl Number {
    fn from_dv(value: &Dv) -> Option<Self> {
        match value {
            #[allow(clippy::cast_precision_loss)]
            Dv::Int(n) => Some(Self {
                value: *n as f64,
                integer: true,
            }),
            Dv::Float(f) => Some(Self {
                value: *f,
                integer: false,
            }),
            _ => None,
        }
    }
    /// `'$n'`.
    pub fn dart_string(self) -> String {
        if self.integer {
            #[allow(clippy::cast_possible_truncation)]
            return (self.value as i64).to_string();
        }
        double_to_string(self.value)
    }
}

/// `RemotePipelineInputDefinition`.
#[derive(Debug, Clone, PartialEq)]
pub struct InputDefinition {
    pub name: String,
    pub description: Option<String>,
    pub required: bool,
    pub default_value: Option<String>,
    pub input_type: InputType,
    pub options: Vec<String>,
    pub min: Option<Number>,
    pub max: Option<Number>,
    pub hide_in_ui: bool,
}

impl InputDefinition {
    /// `RemotePipelineInputDefinition.fromJson(name, value)`.
    pub fn from_json(name: &str, value: &Dv) -> Option<Self> {
        let Dv::Map(value) = value else {
            return None;
        };
        if name.is_empty() {
            return None;
        }
        let default = value.get("default");
        Some(Self {
            name: name.to_owned(),
            description: non_empty(value.get("description")),
            required: value.get("required").is_true(),
            default_value: match default {
                Dv::Str(_) | Dv::Int(_) | Dv::Float(_) | Dv::Bool(_) => Some(default.dart_string()),
                _ => None,
            },
            input_type: match value.get("type").as_str() {
                Some("boolean") => InputType::Boolean,
                Some("number") => InputType::Number,
                Some("choice") => InputType::Choice,
                _ => InputType::String,
            },
            options: strings(value.get("options")),
            min: Number::from_dv(value.get("min")),
            max: Number::from_dv(value.get("max")),
            hide_in_ui: value.get("hint-hide-ui-option").is_true(),
        })
    }
}

/// `RemotePipelineDispatchForm`.
#[derive(Debug, Clone, PartialEq)]
pub struct DispatchForm {
    pub inputs: Vec<InputDefinition>,
    pub inputs_omitted: bool,
    pub unsupported_reason: Option<String>,
}

impl DispatchForm {
    /// `RemotePipelineDispatchForm.fromGetResult(result)`.
    pub fn from_get_result(result: &DvMap) -> Self {
        Self {
            inputs: match result.get("dispatchInputs") {
                Dv::Map(raw) => raw
                    .iter()
                    .filter_map(|(name, value)| InputDefinition::from_json(name, value))
                    .collect(),
                _ => Vec::new(),
            },
            inputs_omitted: result.get("dispatchInputsOmitted").is_true(),
            unsupported_reason: non_empty(result.get("dispatchUnsupportedReason")),
        }
    }
    /// `canDispatch`.
    pub fn can_dispatch(&self) -> bool {
        !self.inputs_omitted && self.unsupported_reason.is_none()
    }
}

// ---- Form rules (`pipeline_input_form.dart`) ----

/// `visiblePipelineInputs`: indexes of the inputs the form shows.
pub fn visible_inputs(inputs: &[InputDefinition]) -> Vec<usize> {
    inputs
        .iter()
        .enumerate()
        .filter(|(_, input)| !input.hide_in_ui || (input.required && input.default_value.is_none()))
        .map(|(i, _)| i)
        .collect()
}

/// `initialPipelineInputValues`: `(name, value)` in input order, a later
/// input with the same name replacing the value.
pub fn initial_values(inputs: &[InputDefinition]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for input in inputs {
        let value = input.default_value.clone().unwrap_or_default();
        match out.iter_mut().find(|(name, _)| *name == input.name) {
            Some(entry) => entry.1 = value,
            None => out.push((input.name.clone(), value)),
        }
    }
    out
}

/// Dart's `String.trim()`.
fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// What a form rule renders (`cc-app::copy::pipelines`).
#[derive(Debug, Clone, PartialEq)]
pub enum InputError {
    Required,
    InvalidNumber,
    AtLeast(Number),
    AtMost(Number),
    OneOf(Vec<String>),
}

/// `validatePipelineInputs`: `(name, error)` for every invalid value, in
/// the map order Dart builds (a later input with the same name replaces
/// the error in place).
pub fn validate(
    inputs: &[InputDefinition],
    values: &[(String, String)],
) -> Vec<(String, InputError)> {
    let mut errors: Vec<(String, InputError)> = Vec::new();
    let mut put = |name: &str, error: InputError| match errors.iter_mut().find(|(n, _)| n == name) {
        Some(entry) => entry.1 = error,
        None => errors.push((name.to_owned(), error)),
    };
    for input in inputs {
        let value = values
            .iter()
            .rev()
            .find(|(name, _)| *name == input.name)
            .map_or("", |(_, value)| trim(value));
        if input.required && value.is_empty() {
            put(&input.name, InputError::Required);
            continue;
        }
        if value.is_empty() {
            continue;
        }
        if input.input_type == InputType::Number {
            match num_try_parse(value).filter(|n| n.is_finite()) {
                None => put(&input.name, InputError::InvalidNumber),
                Some(parsed) => {
                    if let Some(min) = input.min
                        && parsed < min.value
                    {
                        put(&input.name, InputError::AtLeast(min));
                    } else if let Some(max) = input.max
                        && parsed > max.value
                    {
                        put(&input.name, InputError::AtMost(max));
                    }
                }
            }
        }
        if input.input_type == InputType::Choice
            && !input.options.is_empty()
            && !input.options.iter().any(|o| o == value)
        {
            put(&input.name, InputError::OneOf(input.options.clone()));
        }
    }
    errors
}

/// `buildPipelineInputPayload`: trimmed, non-empty values, in input order.
pub fn payload(inputs: &[InputDefinition], values: &[(String, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for input in inputs {
        let value = values
            .iter()
            .rev()
            .find(|(name, _)| *name == input.name)
            .map_or("", |(_, value)| trim(value));
        if value.is_empty() {
            continue;
        }
        match out.iter_mut().find(|(name, _)| *name == input.name) {
            Some(entry) => entry.1 = value.to_owned(),
            None => out.push((input.name.clone(), value.to_owned())),
        }
    }
    out
}

/// `num.tryParse(text)`: `int.tryParse` (decimal or `0x` hex, an optional
/// sign, surrounding whitespace) then `double.tryParse`.
pub fn num_try_parse(text: &str) -> Option<f64> {
    let t = trim(text);
    let (negative, digits) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let int = if let Some(hex) = digits
        .strip_prefix("0x")
        .or_else(|| digits.strip_prefix("0X"))
    {
        (!hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| i64::from_str_radix(hex, 16).ok())
            .flatten()
    } else {
        (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
            .then(|| digits.parse::<i64>().ok())
            .flatten()
    };
    if let Some(n) = int {
        #[allow(clippy::cast_precision_loss)]
        return Some(if negative { -(n as f64) } else { n as f64 });
    }
    double_try_parse(t)
}

/// `double.tryParse(text)`: a decimal literal with an optional exponent,
/// `Infinity` or `NaN`, an optional sign and surrounding whitespace.
fn double_try_parse(text: &str) -> Option<f64> {
    let t = trim(text);
    let (sign, body) = match t.as_bytes().first() {
        Some(b'-') => (-1.0, &t[1..]),
        Some(b'+') => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    match body {
        "Infinity" => return Some(sign * f64::INFINITY),
        "NaN" => return Some(f64::NAN),
        _ => {}
    }
    let bytes = body.as_bytes();
    let mut i = 0;
    let mut mantissa_digits = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        mantissa_digits += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            mantissa_digits += 1;
        }
    }
    if mantissa_digits == 0 {
        return None;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return None;
        }
    }
    if i != bytes.len() {
        return None;
    }
    body.parse::<f64>().ok().map(|v| sign * v)
}

//! A desktop value as the Dart product layer reads it: the object graph of
//! the V8 reader after `deviceChatDto` (`lib/device_link/dto.dart`), which
//! drops `undefined` map entries. Rules ported from Dart code that inspects
//! loosely shaped desktop payloads (`x is Map`, `x as String?`, `'${x}'`)
//! read this instead of the wire form, so they keep Dart's checks exactly.
use super::{date, number};

/// One desktop value. `Int` is a V8 integer and `Float` a V8 double (Dart
/// `int` and `double`); both are a Dart `num`.
#[derive(Debug, Clone, PartialEq)]
pub enum Dv {
    /// `null`, and `undefined` inside a list.
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    /// A `Uint8List`, which Dart also treats as a `List<int>`.
    Bytes(Vec<u8>),
    /// A V8 date (a Dart `DateTime`), milliseconds since the epoch.
    Date(i64),
    List(Vec<Dv>),
    Map(DvMap),
}

/// A `Map<String, dynamic>`: keys in insertion order, a repeated key keeps
/// its first position and takes the last value.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DvMap(Vec<(String, Dv)>);

static NULL: Dv = Dv::Null;

impl DvMap {
    pub fn new() -> Self {
        Self(Vec::new())
    }
    pub fn insert(&mut self, key: String, value: Dv) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key, value)),
        }
    }
    /// `map[key]`: `Null` when absent.
    pub fn get(&self, key: &str) -> &Dv {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map_or(&NULL, |(_, v)| v)
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    /// `map.containsKey(key)` (a `null` value counts).
    pub fn contains_key(&self, key: &str) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Dv)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v))
    }
}

static EMPTY: DvMap = DvMap(Vec::new());

/// A Dart cast (`as String`, `as bool?`) failed: the Dart code threw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CastError;

impl Dv {
    /// `value is Map ? value : const {}` (`usageObject`).
    pub fn object(&self) -> &DvMap {
        match self {
            Dv::Map(map) => map,
            _ => &EMPTY,
        }
    }
    /// `object()[key]`.
    pub fn get(&self, key: &str) -> &Dv {
        self.object().get(key)
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Dv::Null)
    }
    pub fn is_map(&self) -> bool {
        matches!(self, Dv::Map(_))
    }
    /// `value is List` (a `Uint8List` is one).
    pub fn is_list(&self) -> bool {
        matches!(self, Dv::List(_) | Dv::Bytes(_))
    }
    /// The elements of a list, `None` for anything else.
    pub fn elements(&self) -> Option<Vec<&Dv>> {
        match self {
            Dv::List(items) => Some(items.iter().collect()),
            // Bytes are ints; only their count and non-map shape matter to
            // the rules that read lists.
            Dv::Bytes(bytes) => Some(bytes.iter().map(|_| &NULL).collect()),
            _ => None,
        }
    }
    /// `value is String ? value : null`.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Dv::Str(s) => Some(s),
            _ => None,
        }
    }
    /// `value == text` for a string literal.
    pub fn is_str(&self, text: &str) -> bool {
        self.as_str() == Some(text)
    }
    /// `value == true`.
    pub fn is_true(&self) -> bool {
        matches!(self, Dv::Bool(true))
    }
    /// `value as String?`.
    pub fn cast_str(&self) -> Result<Option<&str>, CastError> {
        match self {
            Dv::Null => Ok(None),
            Dv::Str(s) => Ok(Some(s)),
            _ => Err(CastError),
        }
    }
    /// `value as String`.
    pub fn cast_required_str(&self) -> Result<&str, CastError> {
        self.cast_str()?.ok_or(CastError)
    }
    /// `value as bool?`.
    pub fn cast_bool(&self) -> Result<Option<bool>, CastError> {
        match self {
            Dv::Null => Ok(None),
            Dv::Bool(b) => Ok(Some(*b)),
            _ => Err(CastError),
        }
    }
    /// `value as num?`, as an `f64`.
    pub fn cast_num(&self) -> Result<Option<f64>, CastError> {
        match self {
            Dv::Null => Ok(None),
            Dv::Int(_) | Dv::Float(_) => Ok(self.num()),
            _ => Err(CastError),
        }
    }
    /// `value is num ? value : null`, as an `f64`.
    pub fn num(&self) -> Option<f64> {
        match self {
            // Precision past 2^53 only matters for display.
            #[allow(clippy::cast_precision_loss)]
            Dv::Int(n) => Some(*n as f64),
            Dv::Float(f) => Some(*f),
            _ => None,
        }
    }
    /// `value is num && value.isFinite ? value : null`.
    pub fn finite(&self) -> Option<f64> {
        self.num().filter(|n| n.is_finite())
    }
    /// Dart `==` between two values a rule compares (numbers across `int`
    /// and `double`, strings, bools and null); collections never compare
    /// equal here.
    pub fn loosely_equals(&self, other: &Dv) -> bool {
        match (self, other) {
            (Dv::Null, Dv::Null) => true,
            (Dv::Bool(a), Dv::Bool(b)) => a == b,
            (Dv::Str(a), Dv::Str(b)) => a == b,
            (Dv::Date(a), Dv::Date(b)) => a == b,
            (a, b) => match (a.num(), b.num()) {
                (Some(x), Some(y)) => x == y,
                _ => false,
            },
        }
    }
    /// String interpolation `'${value}'`: Dart's `toString`.
    pub fn dart_string(&self) -> String {
        match self {
            Dv::Null => "null".into(),
            Dv::Bool(b) => b.to_string(),
            Dv::Int(n) => n.to_string(),
            Dv::Float(f) => number::double_to_string(*f),
            Dv::Str(s) => s.clone(),
            Dv::Bytes(bytes) => format!(
                "[{}]",
                bytes
                    .iter()
                    .map(u8::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Dv::Date(ms) => date::date_to_string(*ms),
            Dv::List(items) => format!(
                "[{}]",
                items
                    .iter()
                    .map(Dv::dart_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Dv::Map(map) => format!(
                "{{{}}}",
                map.iter()
                    .map(|(k, v)| format!("{k}: {}", v.dart_string()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }
}

/// `value ?? fallback` for desktop values.
pub fn or<'a>(value: &'a Dv, fallback: &'a Dv) -> &'a Dv {
    if value.is_null() { fallback } else { value }
}

impl Dv {
    /// `value as Map<String, dynamic>`.
    pub fn cast_map(&self) -> Result<&DvMap, CastError> {
        match self {
            Dv::Map(map) => Ok(map),
            _ => Err(CastError),
        }
    }
    /// A list's elements as maps, `{}` for an element that is not one; no
    /// elements when the value is not a list.
    pub fn maps(&self) -> Vec<&DvMap> {
        self.elements()
            .map(|items| items.into_iter().map(Dv::object).collect())
            .unwrap_or_default()
    }
}

/// The generated protocol `_parseList`: the list cast throws, elements
/// that fail to parse are skipped.
pub fn parse_list<T, E: From<CastError>>(
    value: &Dv,
    parse: impl Fn(&Dv) -> Result<T, E>,
) -> Result<Vec<T>, E> {
    let items = value.elements().ok_or(CastError)?;
    Ok(items.into_iter().filter_map(|e| parse(e).ok()).collect())
}

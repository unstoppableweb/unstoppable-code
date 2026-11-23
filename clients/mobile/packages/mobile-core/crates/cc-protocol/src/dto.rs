//! The Dart DTO view of a desktop value: the bridge form ([`crate::v8`])
//! read back into the object graph Dart's V8 reader returns, after
//! `deviceChatDto` drops `undefined` map entries. Rules that inspect loosely
//! shaped desktop payloads read this ([`Dv`]).
use base64::Engine;
use cc_domain::dart::{Dv, DvMap};
use serde_json::Value;
use std::collections::HashMap;

/// `deviceChatDto(decode(value))`. Shared references resolve to copies; a
/// reference to an enclosing object (a cycle) reads as `null`.
pub fn desktop_value(value: &Value) -> Dv {
    let mut refs = HashMap::new();
    read(value, &mut refs).unwrap_or(Dv::Null)
}

/// `None` is `undefined`.
fn read(value: &Value, refs: &mut HashMap<u64, Dv>) -> Option<Dv> {
    Some(match value {
        Value::Null => Dv::Null,
        Value::Bool(b) => Dv::Bool(*b),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => Dv::Int(i),
            (None, Some(u)) => Dv::Int(i64::try_from(u).unwrap_or(i64::MAX)),
            _ => Dv::Float(n.as_f64().unwrap_or(f64::NAN)),
        },
        Value::String(s) => Dv::Str(s.clone()),
        Value::Array(items) => list(items, refs),
        Value::Object(o) if crate::v8::is_tag(o.keys()) => {
            if let (Some(id), Some(inner)) = (o.get("$id"), o.get("$value")) {
                let resolved = read(inner, refs).unwrap_or(Dv::Null);
                if let Some(id) = id.as_u64() {
                    refs.insert(id, resolved.clone());
                }
                return Some(resolved);
            }
            let (tag, tagged) = o.iter().next()?;
            match tag.as_str() {
                "$undefined" => return None,
                "$bytes" => Dv::Bytes(
                    base64::engine::general_purpose::STANDARD
                        .decode(tagged.as_str().unwrap_or_default())
                        .unwrap_or_default(),
                ),
                // `DateTime.fromMillisecondsSinceEpoch(ms.toInt())`.
                #[allow(clippy::cast_possible_truncation)]
                "$date" => Dv::Date(tagged.as_f64().unwrap_or(0.0).trunc() as i64),
                "$number" => Dv::Float(match tagged.as_str() {
                    Some("Infinity") => f64::INFINITY,
                    Some("-Infinity") => f64::NEG_INFINITY,
                    _ => f64::NAN,
                }),
                "$utf16" => Dv::Str(utf16(tagged)),
                "$sparse" => list(tagged.as_array().map_or(&[][..], Vec::as_slice), refs),
                "$object" => {
                    let mut map = DvMap::new();
                    for pair in tagged.as_array().map_or(&[][..], Vec::as_slice) {
                        if let Some([key, value]) = pair.as_array().map(Vec::as_slice) {
                            let key = match key {
                                Value::String(s) => s.clone(),
                                other => utf16(&other["$utf16"]),
                            };
                            if let Some(value) = read(value, refs) {
                                map.insert(key, value);
                            }
                        }
                    }
                    Dv::Map(map)
                }
                "$ref" => tagged
                    .as_u64()
                    .and_then(|id| refs.get(&id).cloned())
                    .unwrap_or(Dv::Null),
                _ => Dv::Null,
            }
        }
        Value::Object(o) => {
            let mut map = DvMap::new();
            for (key, value) in o {
                if let Some(value) = read(value, refs) {
                    map.insert(key.clone(), value);
                }
            }
            Dv::Map(map)
        }
    })
}

fn list(items: &[Value], refs: &mut HashMap<u64, Dv>) -> Dv {
    Dv::List(
        items
            .iter()
            .map(|item| read(item, refs).unwrap_or(Dv::Null))
            .collect(),
    )
}

fn utf16(units: &Value) -> String {
    let units: Vec<u16> = units
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|u| u.as_u64().and_then(|u| u16::try_from(u).ok()))
                .collect()
        })
        .unwrap_or_default();
    String::from_utf16_lossy(&units)
}

/// The bridge form of `value`, which Dart's `decodeRustValue` reads back
/// into the same object graph (dates, bytes and non-finite numbers tagged;
/// a map whose keys look like a tag goes as `$object` pairs).
pub fn bridge_value(value: &Dv) -> Value {
    use serde_json::Number;
    match value {
        Dv::Null => Value::Null,
        Dv::Bool(b) => Value::Bool(*b),
        Dv::Int(n) => Value::Number((*n).into()),
        Dv::Float(f) => match Number::from_f64(*f) {
            Some(n) => Value::Number(n),
            None => serde_json::json!({"$number": if f.is_nan() {
                "NaN"
            } else if *f > 0.0 {
                "Infinity"
            } else {
                "-Infinity"
            }}),
        },
        Dv::Str(s) => Value::String(s.clone()),
        Dv::Bytes(bytes) => serde_json::json!({
            "$bytes": base64::engine::general_purpose::STANDARD.encode(bytes)
        }),
        Dv::Date(ms) => serde_json::json!({ "$date": ms }),
        Dv::List(items) => Value::Array(items.iter().map(bridge_value).collect()),
        Dv::Map(map) => bridge_map(map),
    }
}

/// [`bridge_value`] of a map.
pub fn bridge_map(map: &DvMap) -> Value {
    let keys: Vec<String> = map.iter().map(|(k, _)| k.to_owned()).collect();
    if crate::v8::is_tag(keys.iter()) {
        let pairs = map
            .iter()
            .map(|(k, v)| Value::Array(vec![Value::String(k.to_owned()), bridge_value(v)]))
            .collect();
        return serde_json::json!({ "$object": Value::Array(pairs) });
    }
    let mut out = serde_json::Map::new();
    for (k, v) in map.iter() {
        out.insert(k.to_owned(), bridge_value(v));
    }
    Value::Object(out)
}

/// Dart's `base64.decode`: the standard or the URL-safe alphabet, padding
/// optional. `None` for anything else.
pub fn base64_bytes(text: &str) -> Option<Vec<u8>> {
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let standard: String = text
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    LENIENT.decode(standard).ok()
}

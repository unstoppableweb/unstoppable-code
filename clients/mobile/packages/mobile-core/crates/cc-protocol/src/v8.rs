//! Bounded V8 DTO subset compatible with Node v8.serialize and the Dart codec.
//!
//! JSON bridge. A tag is an object with exactly one of these shapes:
//! - `{"$bytes":"<base64>"}`, `{"$date":<ms>}`, `{"$undefined":true}`,
//!   `{"$number":"NaN"|"Infinity"|"-Infinity"}`;
//! - `{"$utf16":[<code units>]}`: a two-byte string with an unpaired surrogate;
//! - `{"$sparse":[...]}`: a V8 holey array (Dart: a fixed-length list);
//! - `{"$object":[[key, value], ...]}`: an object that cannot be a plain JSON
//!   object: its plain form would read as a tag, a key holds an unpaired
//!   surrogate (`key` is then `{"$utf16":[...]}`), or keys repeat;
//! - `{"$id":n,"$value":<object|array|tag>}` defines reference `n` for a V8
//!   object the message references again; `{"$ref":n}` is that object (an
//!   ancestor for a cycle). Identity follows the Dart reader: the same
//!   object, not a copy.
//!
//! Every other object is a plain object. Object key order is preserved both
//! ways (serde_json `preserve_order`). Depth limits count V8 levels, as
//! Dart's writer and reader do, never the bridge wrappers.
use crate::{Result, RpcFailure as Error};
use base64::Engine;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::io::Read;
const MAX: usize = 12 * 1024 * 1024;
const MAX_OUT: usize = 16 * 1024 * 1024;
const FRAGMENT: usize = 65470;
/// Dart `DateTime` accepts at most 8.64e15 ms either side of the epoch.
const MAX_DATE_MS: f64 = 8.64e15;
/// Single-key tags; `$id` with `$value` is the only two-key tag.
const TAGS: [&str; 8] = [
    "$bytes",
    "$date",
    "$undefined",
    "$number",
    "$utf16",
    "$sparse",
    "$object",
    "$ref",
];
fn invalid() -> Error {
    Error::new("malformed_v8")
}
/// Whether a bridge object is a tag rather than a plain object.
pub fn is_tag<'a>(keys: impl ExactSizeIterator<Item = &'a String> + Clone) -> bool {
    match keys.len() {
        1 => keys.clone().any(|k| TAGS.contains(&k.as_str())),
        2 => {
            let mut keys = keys;
            let (a, b) = (keys.next(), keys.next());
            matches!(
                (a.map(String::as_str), b.map(String::as_str)),
                (Some("$id"), Some("$value")) | (Some("$value"), Some("$id"))
            )
        }
        _ => false,
    }
}
/// The object a `$id` wrapper defines, or `v` itself. For the few fields the
/// core reads from desktop messages (error, hello).
pub fn plain(v: &Value) -> &Value {
    match v.as_object() {
        Some(o) if o.len() == 2 && o.contains_key("$id") && o.contains_key("$value") => {
            &o["$value"]
        }
        _ => v,
    }
}
/// A decoded message as a map, when the Dart reader would return one: a plain
/// object, or the `$object` form (keys with unpaired surrogates become
/// U+FFFD, later duplicates win). Only for reading envelope fields.
pub fn as_map(v: &Value) -> Option<std::borrow::Cow<'_, Value>> {
    let o = v.as_object()?;
    if !is_tag(o.keys()) {
        return Some(std::borrow::Cow::Borrowed(v));
    }
    let pairs = o.get("$object")?.as_array()?;
    let mut map = Map::new();
    for pair in pairs {
        if let Some([k, v]) = pair.as_array().map(Vec::as_slice) {
            map.insert(text(k).ok()?, v.clone());
        }
    }
    Some(std::borrow::Cow::Owned(Value::Object(map)))
}
fn uint(out: &mut Vec<u8>, mut n: u64) {
    loop {
        let b = (n & 127) as u8;
        n >>= 7;
        out.push(b | if n > 0 { 128 } else { 0 });
        if n == 0 {
            break;
        }
    }
}
pub fn encode(v: &Value) -> Result<Vec<Vec<u8>>> {
    let mut writer = Writer {
        out: vec![255, 15],
        next_id: 0,
        ids: HashMap::new(),
    };
    writer.write(v, 0)?;
    let bytes = writer.out;
    if bytes.len() > MAX_OUT {
        return Err(invalid());
    }
    let count = bytes.len().div_ceil(FRAGMENT);
    Ok(bytes
        .chunks(FRAGMENT)
        .enumerate()
        .map(|(i, p)| [&[u8::from(i + 1 == count)], p].concat())
        .collect())
}
fn special_number(tag: &str) -> Option<f64> {
    match tag {
        "NaN" => Some(f64::NAN),
        "Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => None,
    }
}
fn units(v: &Value) -> Result<Vec<u16>> {
    v.as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|u| u.as_u64().and_then(|u| u16::try_from(u).ok()))
        .collect::<Option<Vec<u16>>>()
        .ok_or_else(invalid)
}
/// A bridge string: a JSON string or `{"$utf16":[...]}`. Dart's
/// `utf8.encode` writes U+FFFD for an unpaired surrogate.
fn text(v: &Value) -> Result<String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Object(o) if o.len() == 1 && o.contains_key("$utf16") => {
            Ok(String::from_utf16_lossy(&units(&o["$utf16"])?))
        }
        _ => Err(invalid()),
    }
}

/// Writes V8 in the order and with the reference ids of Dart's `_Writer`:
/// every object, array, date and byte array takes the next id.
struct Writer {
    out: Vec<u8>,
    next_id: u64,
    /// Bridge `$id` -> V8 id.
    ids: HashMap<u64, u64>,
}
impl Writer {
    fn check(&self, depth: usize) -> Result<()> {
        if depth > 128 || self.out.len() > MAX_OUT {
            return Err(invalid());
        }
        Ok(())
    }
    fn string(&mut self, s: &str, depth: usize) -> Result<()> {
        self.check(depth)?;
        self.out.push(b'S');
        uint(&mut self.out, s.len() as u64);
        self.out.extend(s.as_bytes());
        Ok(())
    }
    fn reference(&mut self) {
        self.next_id += 1;
    }
    fn array(&mut self, items: &[Value], depth: usize) -> Result<()> {
        self.reference();
        self.out.push(b'A');
        uint(&mut self.out, items.len() as u64);
        for v in items {
            self.write(v, depth + 1)?;
        }
        self.out.push(b'$');
        uint(&mut self.out, 0);
        uint(&mut self.out, items.len() as u64);
        Ok(())
    }
    fn object<'a>(
        &mut self,
        entries: impl Iterator<Item = (String, &'a Value)>,
        depth: usize,
    ) -> Result<()> {
        self.reference();
        self.out.push(b'o');
        let mut count = 0;
        for (k, v) in entries {
            self.string(&k, depth + 1)?;
            self.write(v, depth + 1)?;
            count += 1;
        }
        self.out.push(b'{');
        uint(&mut self.out, count);
        Ok(())
    }
    fn tag(&mut self, o: &Map<String, Value>, depth: usize) -> Result<()> {
        let (key, tagged) = o.iter().next().ok_or_else(invalid)?;
        match key.as_str() {
            "$bytes" => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(tagged.as_str().ok_or_else(invalid)?)
                    .map_err(|_| invalid())?;
                self.reference();
                self.out.push(b'\\');
                uint(&mut self.out, 1);
                uint(&mut self.out, bytes.len() as u64);
                self.out.extend(bytes);
            }
            "$date" => {
                let ms = tagged.as_f64().ok_or_else(invalid)?;
                self.reference();
                self.out.push(b'D');
                self.out.extend(ms.to_le_bytes());
            }
            "$undefined" if tagged == &Value::Bool(true) => self.out.push(b'_'),
            "$number" => {
                let n = tagged
                    .as_str()
                    .and_then(special_number)
                    .ok_or_else(invalid)?;
                self.out.push(b'N');
                self.out.extend(n.to_le_bytes());
            }
            "$utf16" => {
                let s = String::from_utf16_lossy(&units(tagged)?);
                self.string(&s, depth)?;
            }
            "$sparse" => self.array(tagged.as_array().ok_or_else(invalid)?, depth)?,
            "$object" => {
                let pairs = tagged.as_array().ok_or_else(invalid)?;
                let mut entries = Vec::with_capacity(pairs.len());
                for pair in pairs {
                    match pair.as_array().map(Vec::as_slice) {
                        Some([k, v]) => entries.push((text(k)?, v)),
                        _ => return Err(invalid()),
                    }
                }
                self.object(entries.into_iter(), depth)?;
            }
            "$ref" => {
                let id = tagged
                    .as_u64()
                    .and_then(|n| self.ids.get(&n))
                    .copied()
                    .ok_or_else(invalid)?;
                self.out.push(b'^');
                uint(&mut self.out, id);
            }
            "$id" | "$value" => {
                let id = o["$id"].as_u64().ok_or_else(invalid)?;
                let value = &o["$value"];
                // Only referenceable values can be defined.
                let referenceable = match value {
                    Value::Array(_) => true,
                    Value::Object(inner) if !is_tag(inner.keys()) => true,
                    Value::Object(inner) => {
                        inner.len() == 1
                            && ["$bytes", "$date", "$sparse", "$object"]
                                .contains(&inner.keys().next().map_or("", String::as_str))
                    }
                    _ => false,
                };
                if !referenceable || self.ids.insert(id, self.next_id).is_some() {
                    return Err(invalid());
                }
                self.write(value, depth)?;
            }
            _ => return Err(invalid()),
        }
        Ok(())
    }
    fn write(&mut self, v: &Value, depth: usize) -> Result<()> {
        self.check(depth)?;
        match v {
            Value::Null => self.out.push(b'0'),
            Value::Bool(b) => self.out.push(if *b { b'T' } else { b'F' }),
            Value::Number(n) => {
                if let Some(n) = n.as_i64().filter(|n| i32::try_from(*n).is_ok()) {
                    self.out.push(b'I');
                    uint(&mut self.out, ((n << 1) ^ (n >> 31)) as u64);
                } else {
                    self.out.push(b'N');
                    self.out
                        .extend(n.as_f64().ok_or_else(invalid)?.to_le_bytes());
                }
            }
            Value::String(s) => self.string(s, depth)?,
            Value::Array(a) => self.array(a, depth)?,
            Value::Object(o) if !is_tag(o.keys()) => {
                self.object(o.iter().map(|(k, v)| (k.clone(), v)), depth)?
            }
            Value::Object(o) => self.tag(o, depth)?,
        }
        Ok(())
    }
}
#[derive(Default)]
pub struct Assembler {
    bytes: Vec<u8>,
    compressed: Option<bool>,
}
impl Assembler {
    pub fn push(&mut self, fragment: &[u8]) -> Result<Option<Value>> {
        let flag = *fragment.first().ok_or_else(invalid)?;
        if flag > 3
            || (flag & 1 == 0 && fragment.len() != FRAGMENT + 1)
            || self.compressed.is_some_and(|c| c != (flag & 2 != 0))
            || self.bytes.len() + fragment.len() - 1 > MAX
        {
            return Err(invalid());
        }
        self.compressed = Some(flag & 2 != 0);
        self.bytes.extend(&fragment[1..]);
        if flag & 1 == 0 {
            return Ok(None);
        }
        let mut bytes = std::mem::take(&mut self.bytes);
        let compressed = self.compressed.take().unwrap_or(false);
        if compressed {
            let mut clear = Vec::new();
            flate2::read::DeflateDecoder::new(bytes.as_slice())
                .take((MAX + 1) as u64)
                .read_to_end(&mut clear)
                .map_err(|_| invalid())?;
            if clear.len() > MAX {
                return Err(invalid());
            }
            bytes = clear;
        }
        let mut r = Reader {
            bytes: &bytes,
            pos: 0,
            next_id: 0,
            referenced: HashSet::new(),
        };
        if r.byte()? != 255 || !matches!(r.uint()?, 15 | 16) {
            return Err(invalid());
        }
        let node = r.value(0)?;
        while r.pos < bytes.len() && bytes[r.pos] == 0 {
            r.pos += 1;
        }
        if r.pos != bytes.len() {
            return Err(invalid());
        }
        // A message whose envelope is itself referenced has no JSON form the
        // core can read; a desktop builds the envelope around the value, so
        // it never is.
        if matches!(node, Node::Object { id: 0, .. }) && r.referenced.contains(&0) {
            return Err(invalid());
        }
        let v = node.render(&r.referenced);
        Ok(Some(v))
    }
}
/// An object key as Dart's reader keeps it.
#[derive(PartialEq)]
enum Key {
    Text(String),
    Utf16(Vec<u16>),
}
impl Key {
    fn json(self) -> Value {
        match self {
            Key::Text(s) => Value::String(s),
            Key::Utf16(units) => json!({ "$utf16": units }),
        }
    }
}

/// A decoded value with the V8 reference ids of the objects that have one.
enum Node {
    Json(Value),
    Date {
        id: u64,
        ms: i64,
    },
    Bytes {
        id: u64,
        base64: String,
    },
    Array {
        id: u64,
        dense: bool,
        items: Vec<Node>,
    },
    Object {
        id: u64,
        entries: Vec<(Key, Node)>,
    },
    Ref(u64),
}
impl Node {
    fn render(self, referenced: &HashSet<u64>) -> Value {
        let (id, value) = match self {
            Node::Json(v) => return v,
            Node::Ref(id) => return json!({ "$ref": id }),
            Node::Date { id, ms } => (id, json!({ "$date": ms })),
            Node::Bytes { id, base64 } => (id, json!({ "$bytes": base64 })),
            Node::Array { id, dense, items } => {
                let items: Vec<Value> = items.into_iter().map(|n| n.render(referenced)).collect();
                (
                    id,
                    if dense {
                        Value::Array(items)
                    } else {
                        json!({ "$sparse": items })
                    },
                )
            }
            Node::Object { id, entries } => {
                let mut seen = HashSet::new();
                let plain = entries.iter().all(|(k, _)| match k {
                    Key::Text(s) => seen.insert(s.as_str()),
                    Key::Utf16(_) => false,
                }) && !is_tag(
                    entries
                        .iter()
                        .filter_map(|(k, _)| match k {
                            Key::Text(s) => Some(s),
                            Key::Utf16(_) => None,
                        })
                        .collect::<Vec<_>>()
                        .into_iter(),
                );
                let value = if plain {
                    let mut map = Map::new();
                    for (k, v) in entries {
                        if let Key::Text(k) = k {
                            map.insert(k, v.render(referenced));
                        }
                    }
                    Value::Object(map)
                } else {
                    let pairs: Vec<Value> = entries
                        .into_iter()
                        .map(|(k, v)| json!([k.json(), v.render(referenced)]))
                        .collect();
                    json!({ "$object": pairs })
                };
                (id, value)
            }
        };
        if referenced.contains(&id) {
            json!({ "$id": id, "$value": value })
        } else {
            value
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
    /// Ids assigned so far, in Dart reader order.
    next_id: u64,
    referenced: HashSet<u64>,
}
impl Reader<'_> {
    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id - 1
    }
    fn raw(&mut self, n: usize) -> Result<&[u8]> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(invalid)?;
        let out = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(out)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.raw(1)?[0])
    }
    fn peek(&mut self) -> Result<u8> {
        while self.bytes.get(self.pos) == Some(&0) {
            self.pos += 1;
        }
        self.bytes.get(self.pos).copied().ok_or_else(invalid)
    }
    fn uint(&mut self) -> Result<u64> {
        let mut n = 0;
        for shift in (0..56).step_by(7) {
            let b = self.byte()?;
            n |= u64::from(b & 127) << shift;
            if b < 128 {
                return Ok(n);
            }
        }
        Err(invalid())
    }
    fn number(&mut self) -> Result<f64> {
        Ok(f64::from_le_bytes(
            self.raw(8)?.try_into().map_err(|_| invalid())?,
        ))
    }
    fn value(&mut self, depth: usize) -> Result<Node> {
        if depth > 128 || self.next_id > 100_000 {
            return Err(invalid());
        }
        self.peek()?;
        let v = match self.byte()? {
            b'_' => json!({"$undefined":true}),
            b'0' => Value::Null,
            b'T' => json!(true),
            b'F' => json!(false),
            b'I' => {
                let n = self.uint()?;
                json!(((n >> 1) as i64) ^ -((n & 1) as i64))
            }
            b'U' => json!(self.uint()?),
            b'N' => {
                let n = self.number()?;
                match serde_json::Number::from_f64(n) {
                    Some(n) => Value::Number(n),
                    None if n.is_nan() => json!({"$number":"NaN"}),
                    None if n > 0.0 => json!({"$number":"Infinity"}),
                    None => json!({"$number":"-Infinity"}),
                }
            }
            b'S' => {
                let n = self.uint()? as usize;
                Value::String(String::from_utf8(self.raw(n)?.to_vec()).map_err(|_| invalid())?)
            }
            b'"' => {
                let n = self.uint()? as usize;
                Value::String(self.raw(n)?.iter().map(|b| char::from(*b)).collect())
            }
            b'c' => {
                let n = self.uint()? as usize;
                if !n.is_multiple_of(2) {
                    return Err(invalid());
                }
                let units: Vec<u16> = self
                    .raw(n)?
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|c| u16::from_le_bytes(*c))
                    .collect();
                // Dart's String.fromCharCodes keeps unpaired surrogates, which a
                // JSON string here cannot hold; the bridge carries the code units.
                match String::from_utf16(&units) {
                    Ok(s) => Value::String(s),
                    Err(_) => json!({ "$utf16": units }),
                }
            }
            b'^' => {
                let id = self.uint()?;
                if id >= self.next_id {
                    return Err(invalid());
                }
                self.referenced.insert(id);
                return Ok(Node::Ref(id));
            }
            b'o' => {
                let id = self.id();
                let mut entries = Vec::new();
                while self.peek()? != b'{' {
                    let key = match self.value(depth + 1)? {
                        Node::Json(Value::String(s)) => Key::Text(s),
                        Node::Json(Value::Number(n)) if n.is_i64() || n.is_u64() => {
                            Key::Text(n.to_string())
                        }
                        // Dart keeps the unpaired surrogate in the key.
                        Node::Json(Value::Object(o))
                            if o.len() == 1 && o.contains_key("$utf16") =>
                        {
                            Key::Utf16(units(&o["$utf16"])?)
                        }
                        _ => return Err(invalid()),
                    };
                    entries.push((key, self.value(depth + 1)?));
                }
                self.byte()?;
                if self.uint()? != entries.len() as u64 {
                    return Err(invalid());
                }
                return Ok(Node::Object { id, entries });
            }
            b'A' | b'a' => {
                let dense = self.bytes[self.pos - 1] == b'A';
                let len = self.uint()? as usize;
                if len > self.bytes.len() {
                    return Err(invalid());
                }
                let id = self.id();
                let mut items: Vec<Node> = Vec::with_capacity(if dense { len } else { 0 });
                let mut count = 0;
                if dense {
                    for _ in 0..len {
                        items.push(self.value(depth + 1)?);
                    }
                } else {
                    let mut slots: Vec<Option<Node>> = (0..len).map(|_| None).collect();
                    while self.peek()? != b'@' {
                        let key = match self.value(depth + 1)? {
                            Node::Json(v) => v.as_u64().ok_or_else(invalid)? as usize,
                            _ => return Err(invalid()),
                        };
                        if key >= len {
                            return Err(invalid());
                        }
                        slots[key] = Some(self.value(depth + 1)?);
                        count += 1;
                    }
                    items = slots
                        .into_iter()
                        .map(|s| s.unwrap_or_else(|| Node::Json(json!({"$undefined":true}))))
                        .collect();
                }
                if self.byte()? != if dense { b'$' } else { b'@' }
                    || self.uint()? != count
                    || self.uint()? != len as u64
                {
                    return Err(invalid());
                }
                return Ok(Node::Array { id, dense, items });
            }
            b'D' => {
                // Dart rejects an invalid Date and drops sub-millisecond precision.
                let ms = self.number()?;
                if !ms.is_finite() || ms.trunc().abs() > MAX_DATE_MS {
                    return Err(invalid());
                }
                let id = self.id();
                return Ok(Node::Date {
                    id,
                    ms: ms.trunc() as i64,
                });
            }
            b'B' | b'\\' => {
                let host = self.bytes[self.pos - 1] == b'\\';
                if host && !matches!(self.uint()?, 1 | 2 | 10) {
                    return Err(invalid());
                }
                let n = self.uint()? as usize;
                let base64 = base64::engine::general_purpose::STANDARD.encode(self.raw(n)?);
                let id = self.id();
                return Ok(Node::Bytes { id, base64 });
            }
            _ => return Err(invalid()),
        };
        Ok(Node::Json(v))
    }
}

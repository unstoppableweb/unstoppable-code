//! One device identity and one pin set per installation, in the exact record
//! format of the Dart hub (`lib/device_link/desktop/hub.dart`,
//! secure-storage key `device_link_desktop.v1`):
//! `{"version":1,"seed":<b64url 32 bytes>,"pins":{<peerDeviceId>:<publicKey>}}`.
//!
//! A record that fails validation (version, seed, or any pin whose device id
//! does not match its key) is preserved and never overwritten implicitly.
use super::Store;
use crate::error::{Error, Result};
use base64::{
    Engine,
    alphabet::URL_SAFE,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use ed25519_dalek::SigningKey;
use rusqlite::Connection;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use zeroize::Zeroizing;

pub(crate) const RECORD: &str = "device_link_desktop.v1";

/// Dart `linkBytes`: `^[A-Za-z0-9_-]+$`, then lenient unpadded base64url.
const LINK: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::RequireNone)
        .with_decode_allow_trailing_bits(true),
);

pub(crate) fn link_bytes<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    LINK.decode(value).ok()?.try_into().ok()
}
pub(crate) fn link_base64(bytes: &[u8]) -> String {
    LINK.encode(bytes)
}
/// Dart `linkDeviceId`: base64url(SHA-256(publicKey)[..16]).
pub(crate) fn link_device_id(public_key: &str) -> Option<String> {
    let key = link_bytes::<32>(public_key)?;
    Some(link_base64(&Sha256::digest(key)[..16]))
}

fn loc() -> String {
    json!(["installation", RECORD]).to_string()
}
fn unreadable() -> Error {
    Error::new("identity_unreadable")
}

pub struct Identity {
    seed: Zeroizing<[u8; 32]>,
    pub public_key: String,
    pub device_id: String,
    /// Peer device id -> canonical base64url public key.
    pub pins: BTreeMap<String, String>,
}
impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("device_id", &self.device_id)
            .field("pins", &self.pins.len())
            .finish_non_exhaustive()
    }
}
impl Identity {
    fn from_seed(seed: [u8; 32], pins: BTreeMap<String, String>) -> Self {
        let public_key = link_base64(&SigningKey::from_bytes(&seed).verifying_key().to_bytes());
        let device_id = link_device_id(&public_key).expect("32-byte key");
        Self {
            seed: Zeroizing::new(seed),
            public_key,
            device_id,
            pins,
        }
    }
    pub fn seed(&self) -> Zeroizing<[u8; 32]> {
        self.seed.clone()
    }
    pub(crate) fn seed_b64(&self) -> String {
        link_base64(&*self.seed)
    }
    /// `{deviceId, publicKey}`; the seed never leaves Rust.
    pub fn public(&self) -> Value {
        json!({"deviceId": self.device_id, "publicKey": self.public_key})
    }
    fn record(&self) -> Value {
        json!({"version": 1, "seed": self.seed_b64(), "pins": self.pins})
    }
}

/// hub.dart `_load` validation.
pub(crate) fn parse_record(record: &Value) -> Result<Identity> {
    if record["version"] != 1 {
        return Err(unreadable());
    }
    let seed = record["seed"]
        .as_str()
        .filter(|s| s.len() <= 4096)
        .and_then(link_bytes::<32>)
        .ok_or_else(unreadable)?;
    let pins = parse_pins(&record["pins"]).ok_or_else(unreadable)?;
    Ok(Identity::from_seed(seed, pins))
}

/// Every value a string whose device id equals its key. Keys are stored in
/// canonical encoding (identical for every key a desktop sends).
fn parse_pins(pins: &Value) -> Option<BTreeMap<String, String>> {
    let mut next = BTreeMap::new();
    for (peer, key) in pins.as_object()? {
        let key = key.as_str()?;
        if link_device_id(key)? != *peer {
            return None;
        }
        next.insert(peer.clone(), link_base64(&link_bytes::<32>(key)?));
    }
    Some(next)
}

pub(crate) fn read(store: &Store, db: &Connection) -> Result<Option<Identity>> {
    store
        .raw_get(db, &loc())?
        .map(|v| parse_record(&v))
        .transpose()
}
fn write(store: &Store, db: &Connection, identity: &Identity) -> Result<()> {
    store.raw_put(db, &loc(), &identity.record())
}
fn load_or_create(store: &Store, db: &Connection) -> Result<Identity> {
    if let Some(identity) = read(store, db)? {
        return Ok(identity);
    }
    // First use: generate and save before use.
    let identity = Identity::from_seed(cc_protocol::secure::random::<32>(), BTreeMap::new());
    write(store, db, &identity)?;
    Ok(identity)
}

/// Creates the identity from `seed` when none exists. Ok(true) when the
/// stored identity now uses `seed`, Ok(false) when a different one exists.
pub(crate) fn adopt_seed(store: &Store, db: &Connection, seed: &str) -> Result<bool> {
    let seed = link_bytes::<32>(seed).ok_or_else(|| Error::new("invalid_key"))?;
    match read(store, db)? {
        Some(existing) => Ok(*existing.seed == seed),
        None => {
            write(store, db, &Identity::from_seed(seed, BTreeMap::new()))?;
            Ok(true)
        }
    }
}

/// Adds a pin unless a different one exists. Ok(true) when stored or equal.
pub(crate) fn merge_pin(store: &Store, db: &Connection, peer: &str, key: &str) -> Result<bool> {
    let Some(mut identity) = read(store, db)? else {
        return Ok(false);
    };
    let pins = parse_pins(&json!({ peer: key })).ok_or_else(|| Error::new("peer_identity"))?;
    let key = &pins[peer];
    match identity.pins.get(peer) {
        Some(existing) => Ok(existing == key),
        None => {
            identity.pins.insert(peer.into(), key.clone());
            write(store, db, &identity)?;
            Ok(true)
        }
    }
}

/// hub.dart `remember`: a pin that differs from the stored one is refused.
pub(crate) fn remember(store: &Store, db: &Connection, peer: &str, key: &str) -> Result<()> {
    let pins = parse_pins(&json!({ peer: key })).ok_or_else(|| Error::new("peer_identity"))?;
    let mut identity = load_or_create(store, db)?;
    match identity.pins.get(peer) {
        Some(existing) if *existing != pins[peer] => Err(Error::new("peer_identity_changed")),
        Some(_) => Ok(()),
        None => {
            identity.pins.extend(pins);
            write(store, db, &identity)
        }
    }
}
pub(crate) fn forget(store: &Store, db: &Connection, peer: &str) -> Result<()> {
    let mut identity = load_or_create(store, db)?;
    if identity.pins.remove(peer).is_some() {
        write(store, db, &identity)?;
    }
    Ok(())
}

impl Store {
    /// The installation identity, created and saved on first use. Fails with
    /// `identity_unreadable` (record preserved) when the stored one is invalid.
    pub fn identity(&self) -> Result<Identity> {
        let db = self.conn()?;
        load_or_create(self, &db)
    }
    /// The installation identity without creating one.
    pub fn existing_identity(&self) -> Result<Option<Identity>> {
        let db = self.conn()?;
        read(self, &db)
    }
    /// Pinned public key for `peer` (installation-wide, every account).
    pub fn pin(&self, peer: &str) -> Result<Option<String>> {
        Ok(self
            .existing_identity()?
            .and_then(|i| i.pins.get(peer).cloned()))
    }
    pub fn pins(&self) -> Result<BTreeMap<String, String>> {
        Ok(self
            .existing_identity()?
            .map(|i| i.pins)
            .unwrap_or_default())
    }
    /// Saves a pin (serialized under the store lock). `peer_identity` when the
    /// key does not hash to `peer`; `peer_identity_changed` when a different
    /// key is already pinned.
    pub fn remember_pin(&self, peer: &str, key: &str) -> Result<()> {
        let db = self.conn()?;
        remember(self, &db, peer, key)
    }
    pub fn forget_pin(&self, peer: &str) -> Result<()> {
        let db = self.conn()?;
        forget(self, &db, peer)
    }

    /// Explicit migration of the Dart identity: `seed` is the record's
    /// base64url seed, `pins` its `{peerId: publicKey}` object (validated as
    /// hub.dart does).
    ///
    /// - No identity yet: stored.
    /// - Same seed: pins merged; a conflicting pin fails `pin_conflict`
    ///   unless `force` (imported pin wins).
    /// - Different or unreadable identity: fails `identity_exists` unless
    ///   `force`, which replaces the identity and its pins.
    ///
    /// Returns `{deviceId, publicKey, pins, replaced}`.
    pub fn identity_import(&self, seed: &str, pins: &Value, force: bool) -> Result<Value> {
        let seed = link_bytes::<32>(seed).ok_or_else(|| Error::new("invalid_identity"))?;
        let pins = if pins.is_null() {
            BTreeMap::new()
        } else {
            parse_pins(pins).ok_or_else(|| Error::new("invalid_identity"))?
        };
        let mut db = self.conn()?;
        let tx = db.transaction().map_err(|_| Error::new("storage_write"))?;
        let existing = match read(self, &tx) {
            Err(e) if e.code == "identity_unreadable" => Err(()),
            Err(e) => return Err(e),
            Ok(found) => Ok(found),
        };
        let (identity, replaced) = match existing {
            Ok(Some(mut current)) if *current.seed == seed => {
                for (peer, key) in pins {
                    match current.pins.get(&peer) {
                        Some(old) if *old != key && !force => {
                            return Err(Error::new("pin_conflict"));
                        }
                        _ => {
                            current.pins.insert(peer, key);
                        }
                    }
                }
                (current, false)
            }
            Ok(None) => (Identity::from_seed(seed, pins), false),
            Ok(Some(_)) | Err(()) if force => (Identity::from_seed(seed, pins), true),
            Ok(Some(_)) | Err(()) => return Err(Error::new("identity_exists")),
        };
        write(self, &tx, &identity)?;
        tx.commit().map_err(|_| Error::new("storage_write"))?;
        let mut out = identity.public();
        out["pins"] = json!(identity.pins.len());
        out["replaced"] = json!(replaced);
        Ok(out)
    }

    /// [`Store::identity_import`] from the raw Dart `device_link_desktop.v1`
    /// string; the whole record is validated first.
    pub fn identity_import_dart(&self, raw: &str, force: bool) -> Result<Value> {
        let record: Value =
            serde_json::from_str(raw).map_err(|_| Error::new("invalid_identity"))?;
        let parsed = parse_record(&record).map_err(|_| Error::new("invalid_identity"))?;
        let pins: Map<String, Value> = parsed
            .pins
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        self.identity_import(&parsed.seed_b64(), &Value::Object(pins), force)
    }
}

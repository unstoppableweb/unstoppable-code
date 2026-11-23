//! Encrypted records. The host supplies only an OS-keystore wrapping key and an
//! app-private directory; token serialization stays in Rust.
//!
//! Layout (v2, table `sealed`):
//! - Every record has a logical location, a JSON array such as
//!   `["origin", <origin>, "session"]`, `["installation", "device_link_desktop.v1"]`,
//!   `["app", <origin>, <accountId>, <key>]` or `["saved", <origin>, <accountId>]`.
//! - The row id is HMAC-SHA256(index key, location), so account ids, computer
//!   ids and key names are not readable from the database or its WAL.
//! - `secure_delete` zeroes deleted and replaced content, so the migrated v1
//!   rows and cleared records leave nothing readable in free pages.
//! - The value is AES-256-GCM with a random nonce and the location as AAD.
//! - `meta.check` holds a sealed canary. A wrong wrapping key locks the store:
//!   every operation fails with `storage_corrupt` and nothing is overwritten.
//!
//! The v1 table `records(scope, key, value)` (plaintext scope/key) is migrated
//! into `sealed` on the first open with the right key; see [`Store::open`].
use crate::error::{Error, Result};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use hkdf::Hkdf;
use rand::{RngCore, rngs::OsRng};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::Sha256;
use std::sync::{Mutex, MutexGuard};
use zeroize::Zeroizing;

pub(crate) mod drafts;
pub(crate) mod home;
pub(crate) mod identity;
pub(crate) mod saved;

const CHECK: &[u8] = b"canopy-computer-connect/store-check/v2";
const AAD_PREFIX: &[u8] = b"canopy-computer-connect/v2:";

pub struct Store {
    db: Mutex<Connection>,
    key: Zeroizing<[u8; 32]>,
    index: Zeroizing<[u8; 32]>,
    scope: String,
    locked: bool,
}

/// How a v1 (origin-scoped, plaintext-keyed) record name maps onto v2.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Route<'a> {
    /// Legacy `identity` = `{"seed"}`: now the installation identity.
    Identity,
    /// Legacy `account/<id>/pins/<peer>`: now the installation pin set.
    Pin(&'a str),
    /// Legacy `account/<id>/<key>`: now the app-state namespace.
    App(&'a str, &'a str),
    /// Anything else (`session`, `user`): an origin-scoped internal record.
    Plain,
}
pub(crate) fn route(key: &str) -> Route<'_> {
    if key == "identity" {
        return Route::Identity;
    }
    if let Some(rest) = key.strip_prefix("account/")
        && let Some((account, name)) = rest.split_once('/')
        && !account.is_empty()
        && !name.is_empty()
    {
        if let Some(peer) = name.strip_prefix("pins/")
            && !peer.is_empty()
            && !peer.contains('/')
        {
            return Route::Pin(peer);
        }
        return Route::App(account, name);
    }
    Route::Plain
}

pub(crate) fn loc_origin(scope: &str, key: &str) -> String {
    json!(["origin", scope, key]).to_string()
}
pub(crate) fn loc_app(origin: &str, account: &str, key: &str) -> String {
    json!(["app", origin, account, key]).to_string()
}

fn corrupt() -> Error {
    Error::new("storage_corrupt")
}

impl Store {
    /// Opens (creating if needed) the database. `scope` is the configured
    /// origin; it scopes the session, the user and app state. Identity and
    /// pins are per installation. A wrong key does not fail here: the store
    /// opens locked and every later operation fails with `storage_corrupt`.
    pub fn open(path: &str, key: [u8; 32], scope: String) -> Result<Self> {
        let db = Connection::open(path).map_err(|_| Error::new("storage_open"))?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
             CREATE TABLE IF NOT EXISTS records(scope TEXT, key TEXT, value BLOB NOT NULL, PRIMARY KEY(scope,key));
             CREATE TABLE IF NOT EXISTS sealed(id BLOB PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS meta(name TEXT PRIMARY KEY, value BLOB NOT NULL);",
        )
        .map_err(|_| Error::new("storage_schema"))?;
        let mut index = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(b"canopy-computer-connect/store/v2"), &key)
            .expand(b"record-index", &mut *index)
            .map_err(|_| Error::new("storage_open"))?;
        let mut store = Self {
            db: Mutex::new(db),
            key: Zeroizing::new(key),
            index,
            scope,
            locked: false,
        };
        store.locked = !store.unlock_and_migrate()?;
        Ok(store)
    }

    pub fn scope(&self) -> &str {
        &self.scope
    }

    /// Verifies the key against the canary, then migrates v1 rows. Returns
    /// false (locked) when the key cannot open existing data.
    fn unlock_and_migrate(&self) -> Result<bool> {
        let mut db = self.db.lock().map_err(|_| Error::new("storage_read"))?;
        let tx = db.transaction().map_err(|_| Error::new("storage_read"))?;
        let check: Option<Vec<u8>> = tx
            .query_row("SELECT value FROM meta WHERE name='check'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|_| Error::new("storage_read"))?;
        match &check {
            Some(bytes) => {
                if self.open_bytes(bytes, CHECK).as_ref().map(|v| v.as_slice()) != Some(CHECK) {
                    return Ok(false);
                }
            }
            None => {
                let sealed: i64 = tx
                    .query_row("SELECT count(*) FROM sealed", [], |r| r.get(0))
                    .map_err(|_| Error::new("storage_read"))?;
                if sealed > 0 {
                    return Ok(false);
                }
            }
        }
        let rows: Vec<(String, String, Vec<u8>)> = {
            let mut stmt = tx
                .prepare("SELECT scope, key, value FROM records")
                .map_err(|_| Error::new("storage_read"))?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(|_| Error::new("storage_read"))?
                .collect::<rusqlite::Result<_>>()
                .map_err(|_| Error::new("storage_read"))?
        };
        let mut clear = Vec::with_capacity(rows.len());
        for (scope, key, bytes) in rows {
            let aad = serde_json::to_vec(&(&scope, &key)).map_err(|_| corrupt())?;
            let Some(plain) = self.open_bytes(&bytes, &aad) else {
                // Wrong key (or tampering): preserve v1 rows, lock the store.
                return Ok(false);
            };
            let value: Value = serde_json::from_slice(&plain).map_err(|_| corrupt())?;
            clear.push((scope, key, value));
        }
        if check.is_none() {
            let sealed = self.seal_bytes(CHECK, CHECK)?;
            tx.execute(
                "INSERT INTO meta(name, value) VALUES('check', ?)",
                params![sealed],
            )
            .map_err(|_| Error::new("storage_write"))?;
        }
        if !clear.is_empty() {
            self.migrate_v1(&tx, clear)?;
            tx.execute("DELETE FROM records", [])
                .map_err(|_| Error::new("storage_write"))?;
        }
        tx.commit().map_err(|_| Error::new("storage_write"))?;
        Ok(true)
    }

    fn migrate_v1(&self, db: &Connection, mut rows: Vec<(String, String, Value)>) -> Result<()> {
        // The current origin's identity wins; other origins' identities and
        // pins paired under them are archived, never dropped.
        rows.sort_by_key(|(scope, key, _)| (*scope != self.scope, key != "identity"));
        let mut same_identity = std::collections::HashSet::new();
        let mut pins = Vec::new();
        for (scope, key, value) in rows {
            let archive = json!(["legacy", &scope, &key]).to_string();
            match route(&key) {
                Route::Identity => {
                    let seed = value["seed"].as_str().unwrap_or_default();
                    match identity::adopt_seed(self, db, seed) {
                        Ok(true) => {
                            same_identity.insert(scope);
                        }
                        _ => self.raw_put(db, &archive, &value)?,
                    }
                }
                Route::Pin(peer) => pins.push((scope, peer.to_owned(), archive, value)),
                Route::App(account, name) => {
                    self.raw_put(db, &loc_app(&scope, account, name), &value)?
                }
                Route::Plain => self.raw_put(db, &loc_origin(&scope, &key), &value)?,
            }
        }
        for (scope, peer, archive, value) in pins {
            let merged = same_identity.contains(&scope)
                && value
                    .as_str()
                    .is_some_and(|key| identity::merge_pin(self, db, &peer, key).unwrap_or(false));
            if !merged {
                self.raw_put(db, &archive, &value)?;
            }
        }
        Ok(())
    }

    pub(crate) fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        if self.locked {
            return Err(corrupt());
        }
        self.db.lock().map_err(|_| Error::new("storage_read"))
    }

    fn id(&self, loc: &str) -> Vec<u8> {
        Hkdf::<Sha256>::extract(Some(&*self.index), loc.as_bytes())
            .0
            .to_vec()
    }
    fn aad(loc: &str) -> Vec<u8> {
        [AAD_PREFIX, loc.as_bytes()].concat()
    }
    fn seal_bytes(&self, clear: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        let mut nonce = [0; 12];
        OsRng.fill_bytes(&mut nonce);
        let sealed = Aes256Gcm::new((&*self.key).into())
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: clear, aad })
            .map_err(|_| Error::new("storage_encrypt"))?;
        Ok([nonce.as_slice(), &sealed].concat())
    }
    fn open_bytes(&self, bytes: &[u8], aad: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
        if bytes.len() < 28 {
            return None;
        }
        Aes256Gcm::new((&*self.key).into())
            .decrypt(
                Nonce::from_slice(&bytes[..12]),
                Payload {
                    msg: &bytes[12..],
                    aad,
                },
            )
            .ok()
            .map(Zeroizing::new)
    }

    pub(crate) fn raw_get(&self, db: &Connection, loc: &str) -> Result<Option<Value>> {
        let row: Option<Vec<u8>> = db
            .query_row(
                "SELECT value FROM sealed WHERE id=?",
                params![self.id(loc)],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| Error::new("storage_read"))?;
        row.map(|bytes| {
            let clear = self
                .open_bytes(&bytes, &Self::aad(loc))
                .ok_or_else(corrupt)?;
            serde_json::from_slice(&clear).map_err(|_| corrupt())
        })
        .transpose()
    }
    pub(crate) fn raw_put(&self, db: &Connection, loc: &str, value: &Value) -> Result<()> {
        let clear =
            Zeroizing::new(serde_json::to_vec(value).map_err(|_| Error::new("storage_encode"))?);
        let sealed = self.seal_bytes(&clear, &Self::aad(loc))?;
        db.execute(
            "INSERT INTO sealed(id, value) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
            params![self.id(loc), sealed],
        )
        .map_err(|_| Error::new("storage_write"))?;
        Ok(())
    }
    pub(crate) fn raw_delete(&self, db: &Connection, loc: &str) -> Result<()> {
        db.execute("DELETE FROM sealed WHERE id=?", params![self.id(loc)])
            .map_err(|_| Error::new("storage_write"))?;
        Ok(())
    }

    // ---- v1-compatible keyed API (kept for the current core) ----
    //
    // Keys keep their v1 meaning, but reach the v2 owners: `identity` is the
    // installation identity, `account/<id>/pins/<peer>` the installation pin
    // set and `account/<id>/<key>` app state. New callers use the typed APIs.

    pub fn get(&self, key: &str) -> Result<Option<Value>> {
        let db = self.conn()?;
        match route(key) {
            Route::Identity => {
                Ok(identity::read(self, &db)?.map(|i| json!({"seed": i.seed_b64()})))
            }
            Route::Pin(peer) => Ok(identity::read(self, &db)?
                .and_then(|i| i.pins.get(peer).cloned().map(Value::String))),
            Route::App(account, name) => self.raw_get(&db, &loc_app(&self.scope, account, name)),
            Route::Plain => self.raw_get(&db, &loc_origin(&self.scope, key)),
        }
    }
    pub fn put(&self, key: &str, value: &Value) -> Result<()> {
        let db = self.conn()?;
        match route(key) {
            Route::Identity => {
                let seed = crate::error::field(value, "seed")?;
                if identity::adopt_seed(self, &db, seed)? {
                    Ok(())
                } else {
                    Err(Error::new("identity_exists"))
                }
            }
            Route::Pin(peer) => identity::remember(
                self,
                &db,
                peer,
                value.as_str().ok_or_else(|| Error::new("invalid_input"))?,
            ),
            Route::App(account, name) => {
                self.raw_put(&db, &loc_app(&self.scope, account, name), value)
            }
            Route::Plain => self.raw_put(&db, &loc_origin(&self.scope, key), value),
        }
    }
    pub fn delete(&self, key: &str) -> Result<()> {
        let db = self.conn()?;
        match route(key) {
            Route::Identity => Err(Error::new("reserved_key")),
            Route::Pin(peer) => identity::forget(self, &db, peer),
            Route::App(account, name) => self.raw_delete(&db, &loc_app(&self.scope, account, name)),
            Route::Plain => self.raw_delete(&db, &loc_origin(&self.scope, key)),
        }
    }

    // ---- Session and user (origin-scoped internal records) ----

    /// The stored session `{token, twoFactorProof?}`, if any.
    pub fn session(&self) -> Result<Option<Value>> {
        let db = self.conn()?;
        self.raw_get(&db, &loc_origin(&self.scope, "session"))
    }
    /// Replaces the session. A missing or empty proof removes any stored
    /// proof (Dart `SessionStore.save(token, twoFactorProof: null)`).
    pub fn put_session(&self, token: &str, proof: Option<&str>) -> Result<()> {
        let mut record = json!({ "token": token });
        if let Some(proof) = proof.filter(|p| !p.is_empty()) {
            record["twoFactorProof"] = json!(proof);
        }
        let db = self.conn()?;
        self.raw_put(&db, &loc_origin(&self.scope, "session"), &record)
    }
    /// Deletes the session and the last validated user.
    pub fn clear_session(&self) -> Result<()> {
        let mut db = self.conn()?;
        let tx = db.transaction().map_err(|_| Error::new("storage_write"))?;
        self.raw_delete(&tx, &loc_origin(&self.scope, "session"))?;
        self.raw_delete(&tx, &loc_origin(&self.scope, "user"))?;
        tx.commit().map_err(|_| Error::new("storage_write"))
    }
    pub fn user(&self) -> Result<Option<Value>> {
        let db = self.conn()?;
        self.raw_get(&db, &loc_origin(&self.scope, "user"))
    }
    pub fn put_user(&self, user: &Value) -> Result<()> {
        let db = self.conn()?;
        self.raw_put(&db, &loc_origin(&self.scope, "user"), user)
    }

    // ---- App-facing state namespace ----
    //
    // `["app", origin, account, key]` can never address the session, user,
    // identity, pins or saved-computer records, whatever the key.

    pub fn app_state_get(&self, account: &str, key: &str) -> Result<Option<Value>> {
        check_app_key(account, key)?;
        let db = self.conn()?;
        self.raw_get(&db, &loc_app(&self.scope, account, key))
    }
    /// Writing JSON `null` deletes the entry.
    pub fn app_state_put(&self, account: &str, key: &str, value: &Value) -> Result<()> {
        check_app_key(account, key)?;
        let db = self.conn()?;
        let loc = loc_app(&self.scope, account, key);
        if value.is_null() {
            self.raw_delete(&db, &loc)
        } else {
            self.raw_put(&db, &loc, value)
        }
    }
    pub fn app_state_delete(&self, account: &str, key: &str) -> Result<()> {
        self.app_state_put(account, key, &Value::Null)
    }
}

fn check_app_key(account: &str, key: &str) -> Result<()> {
    if account.is_empty() || account.len() > 4096 || key.is_empty() || key.len() > 1024 {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

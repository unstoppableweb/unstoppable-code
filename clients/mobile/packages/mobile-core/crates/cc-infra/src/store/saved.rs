//! Saved computers per (origin, account), with the validation of the Dart
//! `SavedComputerConnection` (`lib/device_link/desktop/saved_connection.dart`):
//! `{version:1, accountId, origin, credential:{id,token}|null,
//!   creatingCredential:bool, selectedId:string|null,
//!   computers:[{id, name, reconnect:bool}]}`.
//!
//! An unreadable record is preserved: reads fail `saved_unreadable` and writes
//! refuse to replace it unless `force` is set.
use super::Store;
use crate::error::{Error, Result};
use cc_domain::computers::{valid_computer_id, valid_link_string};
use rusqlite::TransactionBehavior;
use serde_json::{Map, Value, json};

fn loc(origin: &str, account: &str) -> String {
    json!(["saved", origin, account]).to_string()
}
fn unreadable() -> Error {
    Error::new("saved_unreadable")
}
/// `deviceLinkString`.
fn link_string(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| valid_link_string(s))
}
fn same_origin(a: &str, b: &str) -> bool {
    match (url::Url::parse(a), url::Url::parse(b)) {
        (Ok(a), Ok(b)) => a.origin() == b.origin(),
        _ => a == b,
    }
}

/// Validates and normalizes a record exactly as `SavedComputerConnection.restore`
/// does; returns the record as `encode()` would write it.
pub(crate) fn validate(data: &Value, account: &str, origin: &str) -> Option<Value> {
    let data = data.as_object()?;
    if data.get("version")? != 1
        || data.get("accountId")?.as_str()? != account
        || !same_origin(data.get("origin")?.as_str()?, origin)
    {
        return None;
    }
    // Dart keeps first-insertion order with the last value for a repeated id.
    let mut order: Vec<String> = Vec::new();
    let mut computers: Map<String, Value> = Map::new();
    for row in data.get("computers")?.as_array()? {
        let row = row.as_object()?;
        let id = link_string(row.get("id")?)?;
        let reconnect = row.get("reconnect")?.as_bool()?;
        if !valid_computer_id(id) {
            return None;
        }
        let name = link_string(row.get("name")?)?;
        if !computers.contains_key(id) {
            order.push(id.into());
        }
        computers.insert(
            id.into(),
            json!({"id": id, "name": name, "reconnect": reconnect}),
        );
    }
    let credential = match data.get("credential").unwrap_or(&Value::Null) {
        Value::Null => Value::Null,
        key => {
            let key = key.as_object()?;
            json!({"id": link_string(key.get("id")?)?, "token": link_string(key.get("token")?)?})
        }
    };
    let selected = data.get("selectedId").unwrap_or(&Value::Null);
    if !selected.is_null() && !selected.as_str().is_some_and(|s| computers.contains_key(s)) {
        return None;
    }
    let creating = data.get("creatingCredential")?.as_bool()?;
    Some(json!({
        "version": 1,
        "accountId": account,
        "origin": data["origin"],
        "credential": credential,
        "creatingCredential": creating,
        "selectedId": selected,
        "computers": order.iter().map(|id| computers[id].clone()).collect::<Vec<_>>(),
    }))
}

impl Store {
    /// The saved-computers record for `account` at this origin, validated.
    pub fn saved_computers(&self, account: &str) -> Result<Option<Value>> {
        let db = self.conn()?;
        match self.raw_get(&db, &loc(self.scope(), account))? {
            None => Ok(None),
            Some(v) => validate(&v, account, self.scope())
                .map(Some)
                .ok_or_else(unreadable),
        }
    }
    /// Runs `update` on the current validated record inside one write
    /// transaction, so no other save lands between its read and its write.
    /// `saved_unreadable` when an unreadable record exists.
    fn update_saved<T>(
        &self,
        account: &str,
        update: impl FnOnce(&rusqlite::Connection, &str, Option<Value>) -> Result<T>,
    ) -> Result<T> {
        let mut db = self.conn()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::new("storage_write"))?;
        let loc = loc(self.scope(), account);
        let current = self
            .raw_get(&tx, &loc)?
            .map(|old| validate(&old, account, self.scope()).ok_or_else(unreadable))
            .transpose()?;
        let result = update(&tx, &loc, current)?;
        tx.commit().map_err(|_| Error::new("storage_write"))?;
        Ok(result)
    }
    /// Validates and saves; returns the normalized record. `invalid_input`
    /// for an invalid record, `saved_unreadable` when an unreadable record
    /// exists and `force` is false.
    pub fn put_saved_computers(&self, account: &str, record: &Value, force: bool) -> Result<Value> {
        let record =
            validate(record, account, self.scope()).ok_or_else(|| Error::new("invalid_input"))?;
        if force {
            let db = self.conn()?;
            self.raw_put(&db, &loc(self.scope(), account), &record)?;
        } else {
            self.update_saved(account, |db, loc, _| self.raw_put(db, loc, &record))?;
        }
        Ok(record)
    }
    /// [`Self::put_saved_computers`] without `force`, except that the stored
    /// `credential` and `creatingCredential` win over the record's: only the
    /// legacy key cleanup changes them once a record exists.
    pub fn put_saved_computers_keeping_credential(
        &self,
        account: &str,
        record: &Value,
    ) -> Result<Value> {
        let mut record =
            validate(record, account, self.scope()).ok_or_else(|| Error::new("invalid_input"))?;
        self.update_saved(account, |db, loc, current| {
            if let Some(current) = current {
                record["credential"] = current["credential"].clone();
                record["creatingCredential"] = current["creatingCredential"].clone();
            }
            self.raw_put(db, loc, &record)
        })?;
        Ok(record)
    }
    /// Clears `credential` and `creatingCredential` if the record still names
    /// the `expected` key id, keeping its computers and selection. Returns
    /// whether it cleared them.
    pub(crate) fn clear_saved_credential(
        &self,
        account: &str,
        expected: Option<&str>,
    ) -> Result<bool> {
        self.update_saved(account, |db, loc, current| {
            let Some(mut current) = current else {
                return Ok(false);
            };
            if current["credential"]["id"].as_str() != expected {
                return Ok(false);
            }
            current["credential"] = Value::Null;
            current["creatingCredential"] = json!(false);
            self.raw_put(db, loc, &current)?;
            Ok(true)
        })
    }
    /// Imports the Dart `computer_connect.v1.<...>` secure-storage string.
    /// Any existing record, including an empty list after a forget, takes
    /// precedence unless `force` is set.
    pub fn import_saved_computers_dart(
        &self,
        account: &str,
        raw: &str,
        force: bool,
    ) -> Result<Value> {
        let value: Value = serde_json::from_str(raw).map_err(|_| Error::new("invalid_input"))?;
        if force {
            return self.put_saved_computers(account, &value, true);
        }
        let record =
            validate(&value, account, self.scope()).ok_or_else(|| Error::new("invalid_input"))?;
        let mut db = self.conn()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| Error::new("storage_write"))?;
        let loc = loc(self.scope(), account);
        if self.raw_get(&tx, &loc)?.is_some() {
            return Err(Error::new("saved_exists"));
        }
        self.raw_put(&tx, &loc, &record)?;
        tx.commit().map_err(|_| Error::new("storage_write"))?;
        Ok(record)
    }
    pub fn delete_saved_computers(&self, account: &str) -> Result<()> {
        let db = self.conn()?;
        self.raw_delete(&db, &loc(self.scope(), account))
    }
}

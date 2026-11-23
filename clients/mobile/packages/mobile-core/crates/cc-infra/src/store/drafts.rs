//! Computer Connect chat drafts (P5b, D9), one sealed record per
//! (origin, account, computer) at `["drafts", origin, account, "chat",
//! computer]`, apart from the app-state namespace; the computer's
//! Orchestrator chat keeps its own at `["drafts", origin, account,
//! "orchestrator", computer]` (P9). The record's shape is the app's
//! (`cc-app::chats::drafts`); the store only seals it. Dart drafts are
//! never imported.
use super::Store;
use crate::error::{Error, Result};
use cc_app::ports::DraftsRecord;
use serde_json::{Value, json};

fn loc(origin: &str, account: &str, computer: &str, kind: DraftsRecord) -> String {
    let kind = match kind {
        DraftsRecord::Chat => "chat",
        DraftsRecord::Orchestrator => "orchestrator",
    };
    json!(["drafts", origin, account, kind, computer]).to_string()
}

fn check(account: &str, computer: &str) -> Result<()> {
    if account.is_empty() || account.len() > 4096 || computer.is_empty() || computer.len() > 4096 {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

impl Store {
    /// The chat drafts record of `computer`, if any.
    pub fn chat_drafts(&self, account: &str, computer: &str) -> Result<Option<Value>> {
        self.drafts(account, computer, DraftsRecord::Chat)
    }
    /// Replaces the chat drafts record of `computer`; JSON `null` deletes it.
    pub fn put_chat_drafts(&self, account: &str, computer: &str, record: &Value) -> Result<()> {
        self.put_drafts(account, computer, DraftsRecord::Chat, record)
    }
    /// The `kind` drafts record of `computer`, if any.
    pub fn drafts(
        &self,
        account: &str,
        computer: &str,
        kind: DraftsRecord,
    ) -> Result<Option<Value>> {
        check(account, computer)?;
        let db = self.conn()?;
        self.raw_get(&db, &loc(&self.scope, account, computer, kind))
    }
    /// Replaces the `kind` drafts record of `computer`; JSON `null`
    /// deletes it.
    pub fn put_drafts(
        &self,
        account: &str,
        computer: &str,
        kind: DraftsRecord,
        record: &Value,
    ) -> Result<()> {
        check(account, computer)?;
        let db = self.conn()?;
        let loc = loc(&self.scope, account, computer, kind);
        if record.is_null() {
            self.raw_delete(&db, &loc)
        } else {
            self.raw_put(&db, &loc, record)
        }
    }
}

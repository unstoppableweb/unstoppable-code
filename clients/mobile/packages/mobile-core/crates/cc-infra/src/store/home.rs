//! Computer Connect Home records (P8, D9; architecture §5.5): the composer
//! drafts at `["drafts", origin, account, "home", computer]` and the
//! launcher choices at `["home", origin, account, "choices", computer]`,
//! one sealed record each per (origin, account, computer). The records'
//! shapes are the app's (`cc-app::home`); the store only seals them. Dart's
//! Home drafts and choices are never imported.
use super::Store;
use crate::error::{Error, Result};
use cc_app::ports::HomeRecord;
use serde_json::{Value, json};

fn loc(origin: &str, account: &str, computer: &str, kind: HomeRecord) -> String {
    match kind {
        HomeRecord::Drafts => json!(["drafts", origin, account, "home", computer]),
        HomeRecord::Choices => json!(["home", origin, account, "choices", computer]),
    }
    .to_string()
}

fn check(account: &str, computer: &str) -> Result<()> {
    if account.is_empty() || account.len() > 4096 || computer.is_empty() || computer.len() > 4096 {
        return Err(Error::new("invalid_input"));
    }
    Ok(())
}

impl Store {
    /// `computer`'s Home record of `kind`, if any.
    pub fn home(&self, account: &str, computer: &str, kind: HomeRecord) -> Result<Option<Value>> {
        check(account, computer)?;
        let db = self.conn()?;
        self.raw_get(&db, &loc(&self.scope, account, computer, kind))
    }
    /// Replaces `computer`'s Home record of `kind`; JSON `null` deletes it.
    pub fn put_home(
        &self,
        account: &str,
        computer: &str,
        kind: HomeRecord,
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

//! Developer-console operations: the account's app-state namespace, the
//! byte-bounded cache and raw authenticated HTTP. Built only with the
//! `diagnostics` feature; otherwise every call fails `unknown_operation`.
use super::{CoreFailure, CoreInner};
use std::sync::Arc;

/// What [`Diagnostics::cache_clear`] removes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheScope {
    /// Every entry of the signed-in account.
    Account,
    /// One computer's entries.
    Computer { computer_id: String },
    /// One entry.
    Entry { computer_id: String, key: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    /// `GET`, `POST`, `PUT`, `PATCH` or `DELETE`.
    pub method: String,
    pub path: String,
    pub body_json: Option<String>,
    /// GETs retry transient failures twice unless false.
    pub retry_transient: Option<bool>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<HttpHeader>,
    pub body: String,
}

#[derive(Clone)]
pub struct Diagnostics {
    #[cfg_attr(not(feature = "diagnostics"), allow(dead_code))]
    core: Arc<CoreInner>,
}

#[cfg(not(feature = "diagnostics"))]
fn unavailable<T>() -> Result<T, CoreFailure> {
    Err(CoreFailure::local("unknown_operation"))
}

#[cfg(not(feature = "diagnostics"))]
impl Diagnostics {
    pub(crate) fn new(core: Arc<CoreInner>) -> Self {
        Self { core }
    }
    pub async fn read_state(&self, _key: String) -> Result<Option<String>, CoreFailure> {
        unavailable()
    }
    pub async fn write_state(&self, _key: String, _value_json: String) -> Result<(), CoreFailure> {
        unavailable()
    }
    pub async fn cache_read(
        &self,
        _computer_id: String,
        _key: String,
    ) -> Result<Option<String>, CoreFailure> {
        unavailable()
    }
    pub async fn cache_write(
        &self,
        _computer_id: String,
        _key: String,
        _value_json: String,
    ) -> Result<(), CoreFailure> {
        unavailable()
    }
    pub async fn cache_clear(&self, _scope: CacheScope) -> Result<(), CoreFailure> {
        unavailable()
    }
    pub async fn http_request(&self, _request: HttpRequest) -> Result<HttpResponse, CoreFailure> {
        unavailable()
    }
}

#[cfg(feature = "diagnostics")]
impl Diagnostics {
    pub(crate) fn new(core: Arc<CoreInner>) -> Self {
        Self { core }
    }
    /// An app-state entry of the signed-in account, as JSON.
    ///
    /// This and the state and cache operations below act for the account
    /// scope current when they are called ([`CoreInner::scoped`]): never on
    /// the next account's entries.
    pub async fn read_state(&self, key: String) -> Result<Option<String>, CoreFailure> {
        self.core
            .scoped(|app, scope| async move {
                Ok(app
                    .store
                    .app_state_get(&app.account_in(&scope)?, super::auth::text(&key)?)?
                    .map(|v| v.to_string()))
            })
            .await
    }
    /// Writing `null` deletes the entry.
    pub async fn write_state(&self, key: String, value_json: String) -> Result<(), CoreFailure> {
        self.core
            .scoped(|app, scope| async move {
                let key = super::auth::text(&key)?;
                let value = super::bridge::parse_json(&value_json)?;
                app.in_scope(&scope, || {
                    app.store
                        .app_state_put(&app.account_in(&scope)?, key, &value)
                })
            })
            .await
    }
    pub async fn cache_read(
        &self,
        computer_id: String,
        key: String,
    ) -> Result<Option<String>, CoreFailure> {
        self.core
            .scoped(|app, scope| async move {
                Ok(app
                    .cache_read(&scope, &computer_id, &key)?
                    .map(|v| v.to_string()))
            })
            .await
    }
    pub async fn cache_write(
        &self,
        computer_id: String,
        key: String,
        value_json: String,
    ) -> Result<(), CoreFailure> {
        self.core
            .scoped(|app, scope| async move {
                let value = super::bridge::parse_json(&value_json)?;
                app.cache_write(&scope, &computer_id, &key, value)
            })
            .await
    }
    pub async fn cache_clear(&self, which: CacheScope) -> Result<(), CoreFailure> {
        self.core
            .scoped(|app, scope| async move { app.cache_clear(&scope, which) })
            .await
    }
    /// Authenticated passthrough; the token stays in Rust and credential
    /// paths are refused. Every status is a response.
    pub async fn http_request(&self, request: HttpRequest) -> Result<HttpResponse, CoreFailure> {
        let app = self.core.app.clone();
        self.core
            .call(async move {
                let mut v = serde_json::json!({
                    "method": request.method,
                    "path": request.path,
                });
                if let Some(body) = &request.body_json {
                    v["body"] = super::bridge::parse_json(body)?;
                }
                if let Some(retry) = request.retry_transient {
                    v["retryTransient"] = retry.into();
                }
                if let Some(timeout) = request.timeout_ms {
                    v["timeoutMs"] = timeout.into();
                }
                let r = app.auth.http_request(&v).await?;
                Ok(HttpResponse {
                    status: r["status"].as_u64().unwrap_or_default() as u16,
                    headers: r["headers"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .map(|(name, value)| HttpHeader {
                            name: name.clone(),
                            value: value.as_str().unwrap_or_default().into(),
                        })
                        .collect(),
                    body: r["body"].as_str().unwrap_or_default().into(),
                })
            })
            .await
    }
}

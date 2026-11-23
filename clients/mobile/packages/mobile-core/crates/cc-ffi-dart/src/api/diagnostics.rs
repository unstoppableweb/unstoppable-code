//! Developer-console operations. Without the `diagnostics` cargo feature
//! every call fails `unknown_operation`.
use super::core::CoreFailure;
use flutter_rust_bridge::frb;

pub enum CacheScope {
    Account,
    Computer { computer_id: String },
    Entry { computer_id: String, key: String },
}

pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub body_json: Option<String>,
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

#[frb(opaque)]
pub struct Diagnostics {
    inner: cc_core::Diagnostics,
}

impl Diagnostics {
    pub(crate) fn new(inner: cc_core::Diagnostics) -> Self {
        Self { inner }
    }
    pub async fn read_state(&self, key: String) -> Result<Option<String>, CoreFailure> {
        Ok(self.inner.read_state(key).await?)
    }
    pub async fn write_state(&self, key: String, value_json: String) -> Result<(), CoreFailure> {
        Ok(self.inner.write_state(key, value_json).await?)
    }
    pub async fn cache_read(
        &self,
        computer_id: String,
        key: String,
    ) -> Result<Option<String>, CoreFailure> {
        Ok(self.inner.cache_read(computer_id, key).await?)
    }
    pub async fn cache_write(
        &self,
        computer_id: String,
        key: String,
        value_json: String,
    ) -> Result<(), CoreFailure> {
        Ok(self.inner.cache_write(computer_id, key, value_json).await?)
    }
    pub async fn cache_clear(&self, scope: CacheScope) -> Result<(), CoreFailure> {
        let scope = match scope {
            CacheScope::Account => cc_core::CacheScope::Account,
            CacheScope::Computer { computer_id } => cc_core::CacheScope::Computer { computer_id },
            CacheScope::Entry { computer_id, key } => {
                cc_core::CacheScope::Entry { computer_id, key }
            }
        };
        Ok(self.inner.cache_clear(scope).await?)
    }
    pub async fn http_request(&self, request: HttpRequest) -> Result<HttpResponse, CoreFailure> {
        let r = self
            .inner
            .http_request(cc_core::HttpRequest {
                method: request.method,
                path: request.path,
                body_json: request.body_json,
                retry_transient: request.retry_transient,
                timeout_ms: request.timeout_ms,
            })
            .await?;
        Ok(HttpResponse {
            status: r.status,
            headers: r
                .headers
                .into_iter()
                .map(|h| HttpHeader {
                    name: h.name,
                    value: h.value,
                })
                .collect(),
            body: r.body,
        })
    }
}

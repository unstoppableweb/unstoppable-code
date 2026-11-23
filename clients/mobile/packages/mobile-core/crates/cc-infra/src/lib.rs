//! Adapters that implement the `cc-app` ports: hosted auth over HTTPS
//! (`auth`, `http`, `tls`), the encrypted SQLite store (`store`), the account
//! relay WebSocket (`relay`) and the per-computer session actor (`session`).
mod adapters;
mod app_auth_http;
mod auth;
mod error;
mod http;
mod relay;
mod session;
mod store;
mod tls;

pub use app_auth_http::{AppAuthHttp, AppAuthRequest, AppAuthResponse};
pub use store::{Store, identity::Identity};
#[cfg(target_os = "android")]
pub use tls::android_init;

use cc_app::ports::{AuthPort, RelayConnector, StorePort};
use cc_protocol::{RpcFailure, secure};
use std::sync::Arc;

/// The adapters one core uses.
pub struct Connectors {
    pub auth: Arc<dyn AuthPort>,
    pub store: Arc<dyn StorePort>,
    pub relays: Arc<dyn RelayConnector>,
}

fn required(value: &str) -> Result<&str, RpcFailure> {
    if value.is_empty() || value.len() > 4096 {
        return Err(RpcFailure::new("invalid_input"));
    }
    Ok(value)
}

/// Opens the hosted auth client for `origin` and the encrypted store at
/// `database_path` with `wrapping_key` (unpadded base64url, 32 bytes).
/// The store is scoped to the origin; a wrong key opens it locked.
pub fn open(
    origin: &str,
    database_path: &str,
    wrapping_key: &str,
    client_version: Option<&str>,
    user_agent: Option<&str>,
) -> Result<Connectors, RpcFailure> {
    let auth = auth::Auth::with_client_version(required(origin)?, client_version)?;
    auth.set_user_agent(user_agent);
    // The profile identifies an app environment, NOT a caller-chosen account.
    // Auth confirms the account before any peer state is addressed.
    let scope = auth.origin.to_string();
    let store = Arc::new(Store::open(
        required(database_path)?,
        secure::decode(required(wrapping_key)?)?,
        scope,
    )?);
    Ok(Connectors {
        auth: Arc::new(adapters::HostedAuth {
            auth,
            store: store.clone(),
        }),
        store,
        relays: Arc::new(adapters::WebSocketRelays),
    })
}

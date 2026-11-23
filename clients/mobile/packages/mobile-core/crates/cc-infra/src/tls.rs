//! OS trust store for every TLS connection the core makes (HTTPS auth calls
//! and the relay WebSocket), like Dart's `dart:io` clients.
//!
//! - iOS/macOS: Security.framework trust evaluation (user/MDM roots honored).
//! - Android: the platform `X509TrustManager` through the
//!   `rustls-platform-verifier` Kotlin component, after the host registers its
//!   `Context` (see `android_init`). Until then the bundled Mozilla roots
//!   are used, so a host that has not wired the init still connects.
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

static PLATFORM_READY: AtomicBool = AtomicBool::new(!cfg!(target_os = "android"));

/// `None` means "keep the client's bundled webpki roots" (Android before init).
pub(crate) fn client_config() -> Result<Option<Arc<rustls::ClientConfig>>, rustls::Error> {
    use rustls_platform_verifier::BuilderVerifierExt;
    if !PLATFORM_READY.load(Ordering::Acquire) {
        return Ok(None);
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_platform_verifier()?
        .with_no_client_auth();
    Ok(Some(Arc::new(config)))
}

/// reqwest builder with the platform verifier when available.
pub(crate) fn reqwest_builder() -> Result<reqwest::ClientBuilder, rustls::Error> {
    let builder = reqwest::Client::builder().no_proxy();
    Ok(match client_config()? {
        Some(config) => builder.use_preconfigured_tls((*config).clone()),
        None => builder,
    })
}

/// WebSocket connector for `tokio_tungstenite::connect_async_tls_with_config`.
pub(crate) fn websocket_connector() -> Result<Option<tokio_tungstenite::Connector>, rustls::Error> {
    Ok(client_config()?.map(tokio_tungstenite::Connector::Rustls))
}

/// Registers the Android host's `Context` with the platform verifier. The
/// binding's JNI entry point (`ComputerConnectTls.nativeInit`) calls it once
/// before the first core call; safe to call again.
#[cfg(target_os = "android")]
pub fn android_init(env: &mut jni::Env<'_>, context: jni::objects::JObject<'_>) -> bool {
    let ready = rustls_platform_verifier::android::init_with_env(env, context).is_ok();
    if ready {
        PLATFORM_READY.store(true, Ordering::Release);
    }
    ready
}

//! Opening and closing a core, and the failure every call reports.
use super::{
    auth::AuthService, bridge::TransportBridge, computers::AccountService,
    diagnostics::Diagnostics, usage::ProviderUsageService,
};
use flutter_rust_bridge::{DartFnFuture, frb};
use std::sync::{Arc, Mutex};

/// What the host supplies at open.
pub struct CoreConfig {
    /// The hosted API origin.
    pub origin: String,
    /// An app-private SQLite path.
    pub database_path: String,
    /// The OS-keystore wrapping key, unpadded base64url of 32 bytes.
    pub wrapping_key: String,
    pub device_name: String,
    /// `darwin` or `linux`.
    pub platform: String,
    /// Sent as `x-canopy-client-version`.
    pub client_version: Option<String>,
    /// Sent as `user-agent`.
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// The core or a local check failed.
    Local,
    /// The desktop answered `ok: false`.
    Refused,
    /// Never reached the session writer; safe to retry.
    NotSent,
    /// Sent, unanswered in time.
    Timeout,
    /// Sent, then the session ended.
    Ended,
    /// The hosted API failed.
    Http,
}

/// A failed core call. `message` repeats the Dart transport's wording when
/// the core has one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreFailure {
    pub kind: FailureKind,
    pub code: String,
    pub message: Option<String>,
    pub status: Option<u16>,
    pub protocol_version: Option<u64>,
    pub retry_after: Option<u64>,
    /// For a cancelled connect: `relay`, `handshake` or `request`.
    pub step: Option<String>,
}

impl From<cc_core::CoreFailure> for CoreFailure {
    fn from(e: cc_core::CoreFailure) -> Self {
        Self {
            kind: match e.kind {
                cc_core::FailureKind::Local => FailureKind::Local,
                cc_core::FailureKind::Refused => FailureKind::Refused,
                cc_core::FailureKind::NotSent => FailureKind::NotSent,
                cc_core::FailureKind::Timeout => FailureKind::Timeout,
                cc_core::FailureKind::Ended => FailureKind::Ended,
                cc_core::FailureKind::Http => FailureKind::Http,
            },
            code: e.code,
            message: e.message,
            status: e.status,
            protocol_version: e.protocol_version,
            retry_after: e.retry_after,
            step: e.step,
        }
    }
}

impl From<CoreConfig> for cc_core::Config {
    fn from(config: CoreConfig) -> Self {
        Self {
            origin: config.origin,
            database_path: config.database_path,
            wrapping_key: config.wrapping_key,
            device_name: config.device_name,
            platform: config.platform,
            client_version: config.client_version,
            user_agent: config.user_agent,
        }
    }
}

fn unknown_operation() -> CoreFailure {
    CoreFailure {
        kind: FailureKind::Local,
        code: "unknown_operation".into(),
        message: None,
        status: None,
        protocol_version: None,
        retry_after: None,
        step: None,
    }
}

/// One open core: its own runtime, encrypted store, auth and relay.
#[frb(opaque)]
pub struct Core {
    core: cc_core::Core,
    bridge: TransportBridge,
    #[cfg(feature = "test-desktop")]
    desktop: Option<cc_core::test_desktop::TestDesktop>,
}

/// The scripted computer of a core opened with
/// [`Core::open_with_test_desktop`]: the host answers its requests and
/// sends its events here.
#[frb(opaque)]
pub struct TestDesktop {
    #[cfg(feature = "test-desktop")]
    inner: cc_core::test_desktop::TestDesktop,
    #[cfg(not(feature = "test-desktop"))]
    never: std::convert::Infallible,
}

impl TestDesktop {
    /// The computer's device id, as the account lists it.
    #[frb(sync)]
    pub fn computer_id(&self) -> String {
        #[cfg(feature = "test-desktop")]
        return self.inner.computer_id();
        #[cfg(not(feature = "test-desktop"))]
        match self.never {}
    }
    /// One response or event envelope (bridge JSON) for the computer's
    /// session, delivered in call order. Fails `not_connected` without a
    /// session.
    #[frb(sync)]
    pub fn deliver(&self, message_json: String) -> Result<(), CoreFailure> {
        #[cfg(feature = "test-desktop")]
        return Ok(self.inner.deliver(&message_json)?);
        #[cfg(not(feature = "test-desktop"))]
        {
            let _ = message_json;
            match self.never {}
        }
    }
}

impl Core {
    fn wrap(core: cc_core::Core) -> Core {
        let bridge = core.transport_bridge();
        let messages = Arc::new(Mutex::new(Some(bridge.messages())));
        Core {
            bridge: TransportBridge::new(bridge, messages),
            core,
            #[cfg(feature = "test-desktop")]
            desktop: None,
        }
    }

    /// Opens the store and starts the core. The bridge's message stream is
    /// subscribed here, so no reply or event is lost before Dart listens.
    pub fn open(config: CoreConfig) -> Result<Core, CoreFailure> {
        Ok(Core::wrap(cc_core::open(config.into())?))
    }

    /// [`Core::open`] with one scripted, paired computer in place of the
    /// account relay, for the Flutter goldens: `requests` gets each of its
    /// session's request envelopes (bridge JSON) in order, and the host
    /// answers through [`Core::test_desktop`]. Fails `unknown_operation`
    /// without the `test-desktop` cargo feature (Android and iOS builds).
    pub fn open_with_test_desktop(
        config: CoreConfig,
        requests: impl Fn(String) -> DartFnFuture<()> + Send + Sync + 'static,
    ) -> Result<Core, CoreFailure> {
        #[cfg(feature = "test-desktop")]
        {
            let (core, desktop) = cc_core::test_desktop::open(
                config.into(),
                Arc::new(move |request| requests(request)),
            )?;
            let mut core = Core::wrap(core);
            core.desktop = Some(desktop);
            Ok(core)
        }
        #[cfg(not(feature = "test-desktop"))]
        {
            let _ = (config, requests);
            Err(unknown_operation())
        }
    }

    /// The scripted computer; fails `unknown_operation` for a core opened
    /// without one.
    #[frb(sync)]
    pub fn test_desktop(&self) -> Result<TestDesktop, CoreFailure> {
        #[cfg(feature = "test-desktop")]
        return match &self.desktop {
            Some(inner) => Ok(TestDesktop {
                inner: inner.clone(),
            }),
            None => Err(unknown_operation()),
        };
        #[cfg(not(feature = "test-desktop"))]
        Err(unknown_operation())
    }
    #[frb(sync)]
    pub fn auth(&self) -> AuthService {
        AuthService::new(self.core.auth())
    }
    #[frb(sync)]
    pub fn account(&self) -> AccountService {
        AccountService::new(self.core.account())
    }
    /// The selected computer's provider usage.
    #[frb(sync)]
    pub fn usage(&self) -> ProviderUsageService {
        ProviderUsageService::new(self.core.usage())
    }
    #[frb(sync)]
    pub fn transport_bridge(&self) -> TransportBridge {
        self.bridge.clone()
    }
    #[frb(sync)]
    pub fn diagnostics(&self) -> Diagnostics {
        Diagnostics::new(self.core.diagnostics())
    }
    /// Waits, at most 3 s, until the account services stored the records
    /// they still held (chat and Home drafts and choices), then stops all
    /// work without waiting for network I/O. Suspend first to close
    /// sessions politely. Waiting calls fail `shutdown`; the bridge stream
    /// ends after the messages already emitted.
    pub async fn close(&self) {
        self.core.close().await;
    }
}

//! The composition root of the Computer Connect core: [`open`] builds the
//! runtime, the encrypted store, hosted auth and the relay connector and
//! wires them into the application services. Re-exports `cc_app::api`, the
//! one facade bindings wrap.
pub use cc_app::api::*;
pub use cc_infra::{AppAuthHttp, AppAuthRequest, AppAuthResponse};

#[cfg(feature = "test-desktop")]
pub mod test_desktop;

/// Host platform hooks.
pub mod platform {
    /// Registers the Android `Context` for TLS trust evaluation.
    #[cfg(target_os = "android")]
    pub use cc_infra::android_init;
}

fn failure(code: &str) -> CoreFailure {
    CoreFailure {
        kind: FailureKind::Local,
        code: code.into(),
        message: None,
        status: None,
        protocol_version: None,
        retry_after: None,
        step: None,
    }
}
fn required(value: &str) -> Result<&str, CoreFailure> {
    if value.is_empty() || value.len() > 4096 {
        return Err(failure("invalid_input"));
    }
    Ok(value)
}

/// Opens a core with its own runtime (2 workers plus the blocking pool).
/// Fails `invalid_input`, `invalid_origin`, `invalid_key`, `storage_*` or
/// `invalid_platform` before anything runs.
pub fn open(config: Config) -> Result<Core, CoreFailure> {
    let (runtime, connectors) = prepare(&config)?;
    Ok(assemble(runtime, connectors, config))
}

/// The runtime and adapters for `config`, checked before anything runs.
fn prepare(
    config: &Config,
) -> Result<(tokio::runtime::Runtime, cc_infra::Connectors), CoreFailure> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("cc-core")
        .enable_all()
        .build()
        .map_err(|_| failure("runtime_init"))?;
    let connectors = cc_infra::open(
        &config.origin,
        &config.database_path,
        &config.wrapping_key,
        config.client_version.as_deref(),
        config.user_agent.as_deref(),
    )?;
    if !matches!(required(&config.platform)?, "darwin" | "linux") {
        return Err(failure("invalid_platform"));
    }
    required(&config.device_name)?;
    Ok((runtime, connectors))
}

fn assemble(
    runtime: tokio::runtime::Runtime,
    connectors: cc_infra::Connectors,
    config: Config,
) -> Core {
    cc_app::ports::assemble(cc_app::ports::Assembly {
        runtime,
        auth: connectors.auth,
        store: connectors.store,
        relays: connectors.relays,
        origin: config.origin,
        device_name: config.device_name,
        platform: config.platform,
    })
}

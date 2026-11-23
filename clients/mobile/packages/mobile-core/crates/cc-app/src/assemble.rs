use crate::{
    api::{Core, CoreInner},
    bridge::Inner,
    ports::{AuthPort, RelayConnector, StorePort},
};
use std::sync::Arc;
use tokio::runtime::Runtime;

/// The adapters and settings a [`Core`] is built from.
pub struct Assembly {
    /// The runtime every core task runs on; the core owns it from here.
    pub runtime: Runtime,
    pub auth: Arc<dyn AuthPort>,
    pub store: Arc<dyn StorePort>,
    pub relays: Arc<dyn RelayConnector>,
    /// The hosted API origin the store is scoped to.
    pub origin: String,
    pub device_name: String,
    /// The relay platform: `darwin` or `linux`.
    pub platform: String,
}

/// Wires the adapters into the application services.
pub fn assemble(assembly: Assembly) -> Core {
    let Assembly {
        runtime,
        auth,
        store,
        relays,
        origin,
        device_name,
        platform,
    } = assembly;
    let app = Inner::new(
        auth,
        store,
        relays,
        origin,
        device_name,
        platform,
        runtime.handle(),
    );
    Core::from_inner(CoreInner::new(runtime, app))
}

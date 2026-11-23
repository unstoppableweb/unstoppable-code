//! Custom FRB handler: codegen finds `static FLUTTER_RUST_BRIDGE_HANDLER` in a
//! `rust_input` module and uses it instead of the default handler, whose
//! executor would create its own runtime per core count. Async API calls run
//! on one small process-wide runtime; they only hand work to a core's own
//! runtime and await it.
use flutter_rust_bridge::handler::{NoOpErrorListener, SimpleExecutor, SimpleHandler};
use flutter_rust_bridge::{BaseAsyncRuntime, JoinHandle, SimpleThreadPool};
use std::future::Future;
use std::sync::LazyLock;

static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("cc-ffi")
        .enable_all()
        .build()
        .expect("binding runtime")
});

pub(crate) fn runtime() -> &'static tokio::runtime::Runtime {
    &RUNTIME
}

pub struct CoreAsyncRuntime;

impl BaseAsyncRuntime for CoreAsyncRuntime {
    fn spawn<F>(&self, future: F) -> JoinHandle<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        RUNTIME.spawn(future)
    }
}

pub type CoreHandler = SimpleHandler<
    SimpleExecutor<NoOpErrorListener, SimpleThreadPool, CoreAsyncRuntime>,
    NoOpErrorListener,
>;

pub static FLUTTER_RUST_BRIDGE_HANDLER: LazyLock<CoreHandler> = LazyLock::new(|| {
    SimpleHandler::new(
        SimpleExecutor::new(
            NoOpErrorListener,
            SimpleThreadPool::default(),
            CoreAsyncRuntime,
        ),
        NoOpErrorListener,
    )
});

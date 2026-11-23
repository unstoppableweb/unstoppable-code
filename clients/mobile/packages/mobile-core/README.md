# Computer Connect mobile core

This Cargo workspace contains the Computer Connect core and the Rust side of
its Dart binding. Native hosts can use `cc-core` through a local Cargo path
dependency. From the workspace root, `cargo build --locked` builds `cc-core`
and its dependencies.

```toml
[dependencies]
cc-core = { path = "../path/to/packages/mobile-core/crates/cc-core" }
```

Use `cc_core::open(Config)` to open the core. The host supplies an app-private
database path, an OS-protected wrapping key and lifecycle events. Android
hosts register their application context through `cc_core::platform::android_init`
for TLS. Swift and Kotlin hosts will need a binding over `cc-core`. The
Flutter app uses [its Dart package](../../apps/mobile/packages/computer_connect_core/README.md)
to build and load `cc-ffi-dart`.

## Layout

Each crate may depend only on the crates above it in this table.

| Crate         | Owns                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `cc-domain`   | Pure domain rules (computers, the provider usage projection, Dart value semantics)                                     |
| `cc-protocol` | Wire contract: V8 codec and framing (`v8`), handshake and secure channel (`secure`), RPC and relay rules, `RpcFailure` |
| `cc-app`      | Use cases over port traits (`ports`), the cache, and the one public facade `api`                                       |
| `cc-infra`    | Port adapters: hosted auth over HTTPS, TLS, the encrypted SQLite store, the relay WebSocket, the session actor         |
| `cc-core`     | Composition root: `cc_core::open(Config)`, re-exports `cc_app::api`                                                    |
| `cc-ffi-dart` | flutter_rust_bridge wrappers (`src/api`), generated code, and the `legacy-json` C ABI                                  |

Everything is crate-private unless it is the crate's contract;
`unreachable_pub`, `unsafe_code` (outside `cc-ffi-dart`) and holding a lock
across an `.await` are denied.

The workspace's `rust-toolchain.toml` links to the pin in `cc-ffi-dart`.
Flutter's native-assets builder reads the regular file next to that crate's
manifest, which also lets the mobile source export build without symlinks.

## Checks

From `packages/mobile-core` in the repository:

```sh
cargo fmt --check
cargo clippy --workspace --all-features --all-targets -- -D warnings
```

The committed tests are the cargo goldens (wire, store format and chat revisions);
run them from the repository root with `pnpm run test:cargo-goldens`. Write
other tests in `crates/<crate>/tests/__scratch__/` or
`crates/<crate>/src/__scratch__/mod.rs` (with `--cfg cc_scratch`); see
[golden tests](../../docs/golden-tests.md).

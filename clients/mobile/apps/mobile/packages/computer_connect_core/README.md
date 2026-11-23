# Computer Connect Flutter binding

The Dart binding for the [shared Computer Connect core](../../../../packages/mobile-core/README.md).
The normal app (`apps/mobile/lib/main.dart`) bundles this core for Computer Connect.
See the [mobile data reference](../../../../docs/mobile-computer-connect.md) for
ownership and upgrade behavior.

The build hook (`hook/build.dart`) builds the shared workspace's `cc-ffi-dart`
crate as the package's code asset. The generated bindings reopen the same
library, using the path `lib/src/native_loader.dart` resolves with `dladdr`.

Android builds need the Flutter-pinned NDK installed before the native-assets
hook runs.

Cargo features of `cc-ffi-dart`, all off by default:

- `diagnostics`: optional app state, cache and raw HTTP diagnostics.
  Without it those calls fail `unknown_operation`.
- `test-desktop`: `ComputerConnectCore.openWithTestDesktop`, a core whose
  relay lists one scripted, paired computer whose session envelopes the
  Flutter goldens answer (`test/support/rust_test_computer.dart`). The build
  hook turns it on for host builds, which only `flutter test` makes; Android
  and iOS builds never have it, and there the call fails `unknown_operation`.
- `legacy-json`: the JSON-over-C-callback ABI (`cc_open`, `cc_submit`,
  `cc_close`) for scratch tooling.

## Dart boundary

`lib/computer_connect_core.dart` exports the generated types and
`ComputerConnectCore`: `open(...)` (and `openWithTestDesktop(...)` for
tests), the typed services `auth`, `account`,
`usage`, `bridge` and `diagnostics`, `session(SessionCall)` for the ordered session calls, `events`
and `close()`. Failures are `CoreFailure`. Session replies and core events
arrive in the order the core emitted them; the other calls resolve after the
events they caused.

Regenerate the bindings after changing `packages/mobile-core/crates/cc-ffi-dart/src/api`
(`flutter_rust_bridge_codegen` 2.13.0, the same version as the crate and the
Dart runtime):

```sh
flutter_rust_bridge_codegen generate
(cd ../../../../packages/mobile-core && cargo fmt)
dart format lib/src/frb
```

Use `dart pub get` in this directory, not `flutter pub get`.

Do not add credentials to Dart view models. The platform host supplies an
OS-protected wrapping key, app-private database path and lifecycle events.

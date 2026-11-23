# Unstoppable Code mobile app

This folder is the source for the Unstoppable Code iOS and Android app at one
exported revision, either a release or a development snapshot from main. Releases
have a `source-mobile/<version>` tag; snapshots have no tag and may appear before
the first release. It builds on its own: you don't need any other part of this
repository, an account, or any credentials.

## What you need

- [Flutter](https://docs.flutter.dev/get-started/install) 3.44.4 (stable
  channel), which includes the matching Dart SDK
- Node.js 24, to check the generated API bindings
- [Rustup](https://rustup.rs) for the Computer Connect core in `packages/mobile-core`.
  The first build needs network access to fetch the pinned toolchain and dependencies.
- For Android: Java 17, the Android SDK, and NDK 28.2.13676358. Set
  `ANDROID_NDK_HOME` to that NDK's directory before building.
- For iOS: a Mac with Xcode

## Build and test

Run these from this folder (the one with this README):

```sh
# Check that the generated API bindings match their published digests
node scripts/public-export/check-mobile-protocol.mjs --check

cd apps/mobile
flutter pub get --enforce-lockfile
flutter analyze
flutter test

# Android debug build
flutter build apk --debug

# iOS simulator build (macOS only)
flutter build ios --simulator --no-codesign
```

To try the app, start an emulator or simulator and run `flutter run` from
`apps/mobile`.

## What to expect

- **Sample data:** without an API address the app uses built-in sample data, so
  you can explore it without an account or network service.
- **No analytics or crash reporting:** Firebase stays off unless you add your
  own `google-services.json` or `GoogleService-Info.plist`.
- **Not for distribution:** these are debug and simulator builds. Release
  signing, store uploads, and our app identifiers aren't included, so use your
  own if you publish a fork.

## Reporting issues

See [CONTRIBUTING.md](../../CONTRIBUTING.md). Please say that you built from
source and which public commit or `source-mobile/*` tag you used.

## License

See `LICENSE`. Third-party code keeps its own license, including the vendored
`speech_to_text` package in `apps/mobile/third_party/`.

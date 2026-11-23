import 'dart:ffi';

/// The code asset the package build hook bundles (`cc-ffi-dart`).
const _asset = 'package:computer_connect_core/src/bindings.dart';

/// Any symbol of the native library: taking its address makes the Dart
/// native-assets loader load the asset, so the loader can name its file.
@Native<Int32 Function()>(assetId: _asset, symbol: 'frb_get_rust_content_hash')
external int rustContentHash();

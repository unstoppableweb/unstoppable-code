import 'package:code_assets/code_assets.dart';
import 'package:hooks/hooks.dart';
import 'package:native_toolchain_rust/native_toolchain_rust.dart';

/// Builds `cc-ffi-dart`, the one native library of the Computer Connect
/// core, as this package's code asset. The developer console's diagnostic
/// operations are compiled in only on request, through the app's
/// `pubspec.yaml`:
///
/// ```yaml
/// hooks:
///   user_defines:
///     computer_connect_core:
///       diagnostics: true
/// ```
///
/// Host builds also get `test-desktop`, the scripted computer of the
/// Flutter goldens (`ComputerConnectCore.openWithTestDesktop`): the app
/// ships only for Android and iOS, so only `flutter test` builds for the
/// host.
void main(List<String> args) async {
  await build(args, (input, output) async {
    final host =
        input.config.buildCodeAssets &&
        switch (input.config.code.targetOS) {
          OS.android || OS.iOS => false,
          _ => true,
        };
    await RustBuilder(
      assetName: 'src/bindings.dart',
      cratePath: '../../../../packages/mobile-core/crates/cc-ffi-dart',
      features: [
        if (input.userDefines['diagnostics'] == true) 'diagnostics',
        if (host) 'test-desktop',
      ],
    ).run(input: input, output: output);
  });
}

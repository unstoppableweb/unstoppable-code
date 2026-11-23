import 'package:computer_connect_core/computer_connect_core.dart';
import 'package:flutter/foundation.dart';

import 'core_client.dart';

/// The signed-in app session used by the Rust account service.
final class RustDesktopAccountLink {
  RustDesktopAccountLink(
    Future<ComputerConnectCore> Function() core, {
    required String? Function() sessionToken,
    required String? Function() twoFactorProof,
    required String? Function() accountId,
    void Function(String token)? onAdopted,
  }) {
    client = RustCoreClient(
      core,
      sessionToken: sessionToken,
      twoFactorProof: twoFactorProof,
      accountId: accountId,
      onAdopted: onAdopted,
      onOpened: (core) {
        if (!_disposed) _latest[core] = this;
      },
    );
  }

  static final _latest = Expando<RustDesktopAccountLink>();
  late final RustCoreClient client;
  bool _disposed = false;

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    final core = await client.opened;
    if (core != null && identical(_latest[core], this)) {
      try {
        await client.run((core) => core.bridge.suspend());
      } on CoreFailure catch (error) {
        debugPrint('Computer connection suspend failed: ${error.code}');
      }
      await client.forgetSession();
    }
    client.close();
  }
}

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:computer_connect_core/computer_connect_core.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:mobile/device_link/rust_core/account_link.dart';
import 'package:mobile/device_link/rust_core/failures.dart';
import 'package:mobile/device_link/store.dart';
import 'package:mobile/services/app_build_info.dart';
import 'package:mobile/ui/features/device_link/computer_connect/rust/rust_account.dart';
import 'package:mobile/ui/features/device_link/computer_connect/rust/rust_usage.dart';
import 'package:path_provider/path_provider.dart';

import 'computer_connect_transport.dart';
import 'device_link_device_name.dart';
import 'device_link_secure_store.dart';
import 'rust_core_store.dart';

/// Computer Connect over the Rust core.
///
/// One core per API origin, opened on first use in its own app-private
/// directory that is never backed up, under one OS-keystore wrapping key.
/// The first open imports the Dart installation identity and pins. Each
/// account imports its saved computers before restore if it has no Rust
/// record.
final class RustComputerConnectTransport implements ComputerConnectTransport {
  final _cores = <String, Future<ComputerConnectCore>>{};
  Future<({Directory root, String key})>? _store;
  bool _closed = false;
  final _links = <String, RustDesktopAccountLink>{};

  /// The session token each origin's core last adopted, whichever link
  /// adopted it, so a sign-out without a token still names the one to drop.
  final _adopted = <String, String>{};

  /// Ends the matching links and drops the session each origin's core
  /// adopted. The tokens are read before any wait, and the core drops one
  /// only while it still holds it, so a session adopted by a link bound
  /// after this started is kept.
  @override
  Future<void> signOut(String? token) async {
    final ending = [
      for (final MapEntry(key: origin, value: link) in _links.entries)
        if (token == null || link.client.sessionToken() == token)
          (origin: origin, link: link, adopted: _adopted[origin]),
    ];
    for (final entry in ending) {
      _links.remove(entry.origin);
    }
    for (final (:origin, :link, :adopted) in ending) {
      await link.client.endSession(adopted ?? token);
      if (!_links.containsKey(origin)) _adopted.remove(origin);
    }
  }

  /// Closes every core this transport opened (sessions close politely).
  @override
  Future<void> close() async {
    _closed = true;
    _adopted.clear();
    final cores = [..._cores.values];
    _cores.clear();
    for (final core in cores) {
      try {
        await (await core).close();
      } catch (error) {
        debugPrint('Computer Connect (Rust): close failed: $error');
      }
    }
  }

  @override
  ComputerConnectBinding bind({
    required String origin,
    required String accountId,
    required String? Function() sessionToken,
    required String? Function() twoFactorProof,
  }) {
    Future<ComputerConnectCore> core() => _core(origin);
    final link = RustDesktopAccountLink(
      core,
      sessionToken: sessionToken,
      twoFactorProof: twoFactorProof,
      accountId: () => accountId,
      onAdopted: (token) => _adopted[origin] = token,
    );
    _links[origin] = link;
    return (
      createAccount: () => RustComputerAccount(
        open: () async => (await core()).account,
        link: link,
        accountId: accountId,
        prepare: (current) async => importDartSavedComputersOnce(
          await core(),
          dartStore: DeviceLinkSecureStore.connection(
            accountId: accountId,
            origin: origin,
          ),
          current: current,
        ),
      ),
      createUsage: (account) =>
          RustProviderUsageSource(open: core, account: account),
      orderRecents: OverviewService.recentOrder,
    );
  }

  /// [origin]'s core, opened on first use and again after a failed open.
  Future<ComputerConnectCore> _core(String origin) =>
      _closed ? Future.error(coreShutdown) : _cores[origin] ??= _open(origin);

  Future<ComputerConnectCore> _open(String origin) async {
    try {
      final store = await _readyStore();
      final scope = sha256
          .convert(utf8.encode(origin))
          .toString()
          .substring(0, 16);
      final directory = Directory('${store.root.path}/$scope');
      await directory.create(recursive: true);
      final core = await ComputerConnectCore.open(
        origin: origin,
        databasePath: '${directory.path}/core.sqlite',
        wrappingKey: store.key,
        deviceName: deviceLinkDeviceName,
        platform: Platform.isIOS || Platform.isMacOS ? 'darwin' : 'linux',
        clientVersion: await _clientVersion(),
        userAgent: _dartUserAgent(),
      );
      try {
        await importDartIdentityOnce(
          core,
          dartStore: DeviceLinkSecureStore.desktop(),
          marker: File('${directory.path}/dart-identity-import.json'),
        );
        return core;
      } catch (_) {
        await core.close();
        rethrow;
      }
    } catch (error) {
      // The next use opens it again.
      _cores.remove(origin);
      rethrow;
    }
  }

  /// The cores' root directory and wrapping key, readied once for every
  /// origin and again after a failure.
  Future<({Directory root, String key})> _readyStore() async {
    try {
      return await (_store ??= _openStore());
    } catch (_) {
      _store = null;
      rethrow;
    }
  }

  static Future<({Directory root, String key})> _openStore() async {
    const name = 'computer-connect-rust';
    final root = Directory('${(await noBackupDirectory()).path}/$name');
    final key = await openRustCoreStore(
      root: root,
      legacy: Directory(
        '${(await getApplicationSupportDirectory()).path}/$name',
      ),
      key: DeviceLinkSecureStore.rustWrappingKey(),
    );
    return (root: root, key: key);
  }

  /// The user agent dart:io sends, so the core's requests carry it too.
  static String? _dartUserAgent() {
    final client = HttpClient();
    try {
      return client.userAgent;
    } finally {
      client.close(force: true);
    }
  }

  static Future<String?> _clientVersion() async {
    try {
      return (await AppBuildInfo.load()).appVersion;
    } catch (_) {
      return null;
    }
  }
}

/// Imports the Dart installation identity and pins into [core] once.
///
/// Reads the legacy installation record in [dartStore] and passes it to
/// the core for validation.
/// Never forces: an existing, different Rust identity or a conflicting pin
/// is kept and reported. [marker] records the result of importing a Dart
/// record so a later forget in Rust does not restore the same pins. Earlier
/// versions also marked empty stores, which may have been populated since.
/// The Dart record is never written or deleted.
Future<void> importDartIdentityOnce(
  ComputerConnectCore core, {
  required DeviceLinkStore dartStore,
  required File marker,
}) async {
  if (await marker.exists()) {
    final contents = await marker.readAsString();
    try {
      final previous = jsonDecode(contents);
      if (previous is! Map || previous['outcome'] != 'none') return;
    } on FormatException {
      return;
    }
  }
  final record = await dartStore.read();
  if (record == null) return;

  Map<String, Object?> outcome;
  try {
    final result = await core.bridge.importIdentity(
      source: IdentityImport.dartRecord(record: record),
      force: false,
    );
    outcome = {
      'outcome': 'imported',
      'deviceId': result.deviceId,
      'pins': result.pins,
      'replaced': result.replaced,
    };
  } on CoreFailure catch (error) {
    if (!const {
      'identity_exists',
      'identity_unreadable',
      'invalid_identity',
      'pin_conflict',
    }.contains(error.code)) {
      rethrow;
    }
    outcome = {'outcome': 'not_imported', 'code': error.code};
  }
  final summary = jsonEncode({
    ...outcome,
    'at': DateTime.now().toUtc().toIso8601String(),
  });
  final pending = File('${marker.path}.tmp');
  await pending.writeAsString(summary, flush: true);
  await pending.rename(marker.path);
  debugPrint('Computer Connect (Rust): Dart identity import: $summary');
}

/// Imports the Dart saved computers of one account into [core] when the
/// core has none for it yet, so the import never replaces the core's own
/// choices. The Dart record is only read. A failed read throws, so setup
/// offers a retry: the import is skipped only once the core has a record or
/// a read finds no Dart one. A record the core rejects is skipped. The core
/// imports into the account it holds, so nothing is written once [current]
/// is false (the account scope that asked was replaced).
Future<void> importDartSavedComputersOnce(
  ComputerConnectCore core, {
  required DeviceLinkStore dartStore,
  required bool Function() current,
}) async {
  if (await core.bridge.savedComputers() != null) return;
  final record = await dartStore.read();
  if (record == null || !current()) return;
  try {
    await core.bridge.importSavedComputers(raw: record, force: false);
    debugPrint('Computer Connect (Rust): imported the Dart saved computers.');
  } on CoreFailure catch (error) {
    if (error.code == 'saved_exists') return;
    if (error.code != 'invalid_input') rethrow;
    debugPrint(
      'Computer Connect (Rust): saved computers not imported: ${error.code}',
    );
  }
}

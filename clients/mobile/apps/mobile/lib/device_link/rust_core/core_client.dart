import 'package:computer_connect_core/computer_connect_core.dart';
import 'package:flutter/foundation.dart';

import '../desktop/relay_access.dart';
import 'failures.dart';

/// The Rust core as one account link and its connections use it.
///
/// [run] calls the core's typed services and keeps the typed [CoreFailure];
/// [call] maps failures to the Dart transport's exceptions. Before relay or
/// connect work, [adoptSession] hands the app's own sign-in session to the
/// core, so the core mints relay tokens for the same account the app shows.
/// The core is shared; this client never closes it.
final class RustCoreClient {
  RustCoreClient(
    this._open, {
    required this.sessionToken,
    required this.twoFactorProof,
    required this.accountId,
    this.onOpened,
    this.onAdopted,
  }) {
    // An unawaited failure here would be unhandled; every call reports it.
    core.then<void>(
      (_) {},
      onError: (Object error) =>
          debugPrint('Computer connection core did not open: $error'),
    );
  }

  final Future<ComputerConnectCore> Function() _open;

  /// Called once for each core this client first opens.
  final void Function(ComputerConnectCore core)? onOpened;

  /// Called with each session token the core adopts for this client.
  final void Function(String token)? onAdopted;
  ComputerConnectCore? _source;
  Future<ComputerConnectCore>? _last;

  /// The shared core. A use after a failed open opens it again.
  Future<ComputerConnectCore> get core => _last = _open().then((core) {
    if (!_closed && !identical(_source, core)) {
      _source = core;
      onOpened?.call(core);
    }
    return core;
  });

  /// The core the last use opened, or null when that open failed or none
  /// ran. Never opens it.
  Future<ComputerConnectCore?> get opened async {
    try {
      return await _last;
    } catch (_) {
      return null;
    }
  }

  /// The app's session for this account, read per use so a refreshed session
  /// is adopted (`ComputerConnectAccess` reads the same providers).
  final String? Function() sessionToken, twoFactorProof;

  /// The signed-in account the session belongs to. The app validated the
  /// session; the core adopts it for this account without another request.
  final String? Function() accountId;

  ({String token, String? proof, String? account})? _adopted;
  Future<void>? _adopting;
  bool _closed = false;

  /// Runs [action] on the opened core; failures are typed [CoreFailure]s.
  Future<T> run<T>(Future<T> Function(ComputerConnectCore core) action) async {
    final ComputerConnectCore opened;
    try {
      opened = await core;
    } on CoreFailure {
      rethrow;
    } catch (_) {
      throw coreShutdown;
    }
    try {
      return await action(opened);
    } on StateError {
      // The wrapper's `Core closed`: the core stopped under this call.
      throw coreShutdown;
    }
  }

  /// Adopts the app's current session unless the core already has it.
  ///
  /// No session is the relay-token route's 401 (`computer_connect_access.dart`
  /// `token`); a session the server no longer accepts is the same 401. A
  /// failed adoption is retried on the next call; the core keeps the token
  /// and validates it again before relay work.
  Future<void> adoptSession() async {
    while (true) {
      if (_closed) throw coreShutdown;
      final token = sessionToken();
      if (token == null || token.isEmpty) {
        await forgetSession();
        throw const DesktopRelayAccessException(401, code: 'unauthorized');
      }
      final proof = twoFactorProof();
      final current = (
        token: token,
        proof: proof?.isEmpty == true ? null : proof,
        account: accountId(),
      );
      if (_adopted == current) return;
      final pending = _adopting;
      if (pending != null) {
        await pending;
        continue;
      }
      final adopting = _adopt(current);
      _adopting = adopting;
      try {
        await adopting;
      } finally {
        if (identical(_adopting, adopting)) _adopting = null;
      }
      return;
    }
  }

  /// Drops the adopted session from the core once the app has none, so the
  /// core never keeps a token the app signed out of. Local only.
  Future<void> forgetSession() async {
    final token = sessionToken();
    if (token != null && token.isNotEmpty) return;
    _adopted = null;
    try {
      await run((core) => core.auth.forget());
    } on CoreFailure catch (error) {
      debugPrint('Computer connection sign-out failed: ${error.code}');
    }
  }

  Future<void> _adopt(
    ({String token, String? proof, String? account}) session,
  ) async {
    final AuthSession result;
    try {
      result = await run(
        (core) => core.auth.adopt(
          token: session.token,
          twoFactorProof: session.proof,
          accountId: session.account,
        ),
      );
    } on CoreFailure catch (error) {
      debugPrint(
        'Computer connection sign-in check failed (${error.kind.name}, '
        '${error.code}); the next connection step checks it again.',
      );
      return;
    }
    if (result is AuthSession_SignedOut) {
      throw const DesktopRelayAccessException(401, code: 'unauthorized');
    }
    _adopted = session;
    onAdopted?.call(session.token);
  }

  /// Stops adopting sessions and drops the one this client adopted, or else
  /// [token], from the core. The core drops it only while it still holds
  /// that token, so a session adopted since is kept.
  Future<void> endSession(String? token) async {
    _closed = true;
    await _adopting;
    final source = await opened;
    final ending = _adopted?.token ?? token;
    if (source != null && ending != null) {
      await source.auth.forgetIfToken(token: ending);
    }
    _adopted = null;
  }

  void close() => _closed = true;
}

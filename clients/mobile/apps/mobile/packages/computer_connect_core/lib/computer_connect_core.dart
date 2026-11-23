/// The Dart boundary of the Computer Connect core: typed services generated
/// by flutter_rust_bridge from `packages/mobile-core/crates/cc-ffi-dart/src/api`, and
/// [ComputerConnectCore], which opens a core and routes the replies of
/// session calls. Credentials, HTTP, pairing, encryption, IPC, caches, saved
/// computers, the connection lifecycle, provider usage, the overview and
/// the chat read path, worktree activity and files, Home, worktree writes,
/// project clones and the Orchestrator live in Rust; the
/// native library is the one the package build hook bundles, which the
/// bridge only reopens.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_rust_bridge/flutter_rust_bridge_for_generated.dart';

import 'src/frb/api/auth.dart';
import 'src/frb/api/bridge.dart';
import 'src/frb/api/computers.dart';
import 'src/frb/api/core.dart';
import 'src/frb/api/diagnostics.dart';
import 'src/frb/api/usage.dart';
import 'src/frb/frb_generated.dart';
import 'src/native_loader.dart';

export 'package:flutter_rust_bridge/flutter_rust_bridge.dart'
    show FrbException, PanicException;
export 'src/frb/api/activity.dart';
export 'src/frb/api/app_auth_http.dart';
export 'src/frb/api/auth.dart';
export 'src/frb/api/bridge.dart';
export 'src/frb/api/chats.dart';
export 'src/frb/api/composer.dart';
export 'src/frb/api/computers.dart';
export 'src/frb/api/core.dart' show CoreFailure, FailureKind, TestDesktop;
export 'src/frb/api/diagnostics.dart';
export 'src/frb/api/files.dart';
export 'src/frb/api/home.dart';
export 'src/frb/api/orchestrator.dart';
export 'src/frb/api/overview.dart';
export 'src/frb/api/pipelines.dart';
export 'src/frb/api/projects.dart';
export 'src/frb/api/usage.dart';
export 'src/frb/api/worktrees.dart';

Future<void>? _initialized;

/// Initializes the bridge once per isolate.
Future<void> initCoreBridge() => _initialized ??= () async {
  try {
    await CoreBridge.init(
      externalLibrary: ExternalLibrary.open(nativeAssetLibraryPath()),
    );
  } catch (_) {
    _initialized = null;
    rethrow;
  }
}();

/// A core event with its bridge-JSON payload decoded: the desktop message
/// of [BridgeEvent_Message] and the peer list of [BridgeEvent_RelayOpened]
/// and [BridgeEvent_Peers]; null for the others.
final class CoreEvent {
  const CoreEvent(this.event, this.payload);
  final BridgeEvent event;
  final Object? payload;
}

/// One open core. Session calls ([session]) are handed to their session in
/// call order; their replies and every [events] item arrive in the order the
/// core emitted them. The typed services ([auth], [bridge], [diagnostics])
/// resolve after the events they caused were delivered.
final class ComputerConnectCore {
  ComputerConnectCore._(this._core)
    : auth = _core.auth(),
      account = _core.account(),
      usage = _core.usage(),
      bridge = _core.transportBridge(),
      diagnostics = _core.diagnostics() {
    _messages = bridge.messages().listen(
      _receive,
      onDone: () {
        if (!_ended.isCompleted) _ended.complete();
      },
    );
  }

  final Core _core;
  final AuthService auth;

  /// The signed-in account's computers and their connections.
  final AccountService account;

  /// The selected computer's provider usage.
  final ProviderUsageService usage;
  final TransportBridge bridge;
  final Diagnostics diagnostics;
  late final StreamSubscription<BridgeMessage> _messages;
  final _pending = <int, Completer<Object?>>{};
  final _events = StreamController<CoreEvent>.broadcast();
  final _ended = Completer<void>();
  int _nextId = 1;
  bool _closed = false;
  Future<void>? _closing;

  /// Core events in emission order.
  Stream<CoreEvent> get events => _events.stream;

  /// [wrappingKey] is an OS-keystore key, never a bearer token.
  /// [clientVersion] (the app version) is sent as `x-canopy-client-version`,
  /// [userAgent] as `user-agent` (dart:io's `HttpClient.userAgent`).
  static Future<ComputerConnectCore> open({
    required String origin,
    required String databasePath,
    required String wrappingKey,
    required String deviceName,
    required String platform,
    String? clientVersion,
    String? userAgent,
  }) async {
    await initCoreBridge();
    final core = await Core.open(
      config: CoreConfig(
        origin: origin,
        databasePath: databasePath,
        wrappingKey: wrappingKey,
        deviceName: deviceName,
        platform: platform,
        clientVersion: clientVersion,
        userAgent: userAgent,
      ),
    );
    return ComputerConnectCore._(core);
  }

  /// [open] with one scripted, paired computer in place of the account
  /// relay, for the Flutter goldens. Each of its session's request
  /// envelopes, `{kind: request, id, method, params}` in bridge JSON, goes
  /// to [requests] in order; answer them and send the computer's events
  /// through [testDesktop]. Only host builds (`flutter test`) have it;
  /// elsewhere it fails `unknown_operation`.
  static Future<ComputerConnectCore> openWithTestDesktop({
    required String origin,
    required String databasePath,
    required String wrappingKey,
    required String deviceName,
    required String platform,
    required void Function(String request) requests,
  }) async {
    await initCoreBridge();
    final core = await Core.openWithTestDesktop(
      config: CoreConfig(
        origin: origin,
        databasePath: databasePath,
        wrappingKey: wrappingKey,
        deviceName: deviceName,
        platform: platform,
      ),
      requests: requests,
    );
    return ComputerConnectCore._(core);
  }

  /// The scripted computer of [openWithTestDesktop].
  TestDesktop get testDesktop => _core.testDesktop();

  /// Starts [call]; completes with its decoded bridge-JSON value or throws
  /// a [CoreFailure]. Throws a [StateError] once the core closed.
  Future<Object?> session(SessionCall call) {
    if (_closed) return Future.error(StateError('Core closed'));
    final id = _nextId++;
    final completer = Completer<Object?>();
    _pending[id] = completer;
    bridge.submit(id: id, call: call);
    return completer.future;
  }

  void _receive(BridgeMessage message) {
    switch (message) {
      case BridgeMessage_Reply(:final id, :final valueJson):
        _pending.remove(id)?.complete(jsonDecode(valueJson));
      case BridgeMessage_Failed(:final id, :final failure):
        _pending.remove(id)?.completeError(failure);
      case BridgeMessage_Event(field0: final event):
        if (_events.isClosed) return;
        _events.add(
          CoreEvent(event, switch (event) {
            BridgeEvent_Message(:final messageJson) => jsonDecode(messageJson),
            BridgeEvent_RelayOpened(:final peersJson) ||
            BridgeEvent_Peers(:final peersJson) => jsonDecode(peersJson),
            _ => null,
          }),
        );
    }
  }

  /// Closes sessions politely (suspend), waits (bounded) until the account
  /// services stored the drafts and choices they still held, so a core
  /// opened next on the same store reads them, then stops the core. Session
  /// calls still waiting fail with a [StateError].
  Future<void> close() => _closing ??= _close();

  Future<void> _close() async {
    if (_closed) return;
    try {
      await bridge.suspend().timeout(const Duration(seconds: 10));
    } catch (_) {}
    _closed = true;
    try {
      await _core.close();
    } catch (_) {}
    // Deliver the messages the core emitted before it stopped.
    try {
      await _ended.future.timeout(const Duration(seconds: 2));
    } on TimeoutException catch (_) {}
    for (final completer in _pending.values) {
      completer.completeError(StateError('Core closed'));
    }
    _pending.clear();
    await _messages.cancel();
    // The service handles stay valid: later calls fail `shutdown`.
    await _events.close();
  }
}

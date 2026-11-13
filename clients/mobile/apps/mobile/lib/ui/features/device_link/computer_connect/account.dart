import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:mobile/device_link/desktop/legacy_key_cleanup.dart';
import 'package:mobile/device_link/desktop/relay.dart';
import 'package:mobile/device_link/desktop/saved_connection.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/store.dart';
import '../desktop_link_model.dart';
import 'engine.dart';
import 'reconnect_status.dart';

/// Owns one signed-in account's setup, saved computers and foreground recovery.
/// Only an explicit connect can pair. Recovery never grants new trust.
final class ComputerConnectAccount extends ChangeNotifier {
  ComputerConnectAccount({
    required this.engine,
    required this.store,
    required String accountId,
    required String origin,
    required this.fetchToken,
    required this.revokeLegacyKey,
    this.createTimer = Timer.new,
    this.now = DateTime.now,
  }) : saved = SavedComputerConnection(accountId: accountId, origin: origin) {
    engine.addListener(_engineChanged);
    // Session recovery can open the account socket before discovery does.
    _opened = engine.hub.opened.listen(_watch);
  }

  /// How long the app may stay in the background before its sessions close.
  /// The relay drops a phone that stops answering after about 20 seconds.
  static const backgroundGrace = Duration(seconds: 15);
  final ComputerConnectEngine engine;
  final DeviceLinkStore store;
  final SavedComputerConnection saved;

  /// Mints a relay token with the sign-in session for this phone's device ID.
  final DesktopTokenProvider fetchToken;

  /// Revokes an API key an earlier build created and stored for this account.
  final Future<void> Function(String id) revokeLegacyKey;
  final Timer Function(Duration, void Function()) createTimer;
  final DateTime Function() now;
  final peers = <String, DesktopRelayPeer>{};
  bool ready = false, busy = false, finding = false, accessDenied = false;
  int? accessStatus;

  /// The account's plan does not include Remote Control. Set only for the
  /// token route's entitlement denial, never for other access failures.
  bool planRequired = false;
  String? error;
  String? _connectingId;
  bool _disposed = false, _foreground = true, _unreadable = false;
  // The app's lifecycle, apart from whether sessions are open: a resume can
  // still be closing stale sessions when the app is hidden again.
  bool _hidden = false;
  late final _legacyKeyCleanup = LegacyComputerConnectKeyCleanup(
    saved: saved,
    revoke: revokeLegacyKey,
    persist: _save,
  );
  int _attempt = 0;
  Timer? _retry, _closing;
  DateTime? _hiddenAt;
  StreamSubscription<void>? _peerChanges, _relayClosed;
  StreamSubscription<DesktopRelay>? _opened;
  DesktopRelay? _relay;
  Future<void> _writes = Future.value();
  List<SavedComputer> get computers => saved.computers.values.toList();
  String? get selectedName => saved.computers[engine.selectedId]?.name;

  late final _reconnectStatus = ComputerReconnectStatus(
    onChanged: _notify,
    createTimer: createTimer,
  );
  bool get offline => _reconnectStatus.offline;

  /// A saved auto-reconnecting computer opens before discovery or handshake.
  /// Explicitly disconnected computers still open setup.
  bool get hasSelectedComputer =>
      selectableComputers.any((computer) => computer.id == engine.selectedId);

  /// Keep saved reconnecting computers available even before their sessions open.
  List<SavedComputer> get selectableComputers => [
    for (final computer in computers)
      if (computer.reconnect ||
          engine.sessions[computer.id]?.chats.online == true ||
          engine.sessions[computer.id]?.chats.connection.reconnecting == true)
        computer,
  ];

  /// Recents follows live or recovering sessions, not saved picker choices.
  List<SavedComputer> get connectedComputers => [
    for (final computer in computers)
      if (engine.sessions[computer.id]?.chats case final chats?
          when chats.online || chats.connection.reconnecting)
        computer,
  ];

  /// Discovery has reached the relay at least once since this screen opened.
  bool get discovered => _relay != null;

  /// A closed or unopened relay cannot tell us whether a computer is online.
  bool? computerAvailable(String id) {
    final relay = _relay;
    if (relay == null || relay.isClosed) return null;
    return peers[id]?.acceptsControl == true;
  }

  void _notify() {
    if (_disposed) return;
    _reconnectStatus.update(
      computerId: hasSelectedComputer ? engine.selectedId : null,
      online: engine.selected.chats.online,
    );
    notifyListeners();
  }

  Future<void> _save() {
    final value = saved.encode();
    final next = _writes.then((_) => store.write(value));
    _writes = next.catchError((Object _) {});
    return next;
  }

  Future<void> restore() async {
    if (ready || busy || _disposed) return;
    busy = true;
    try {
      final record = await store.read();
      if (_disposed) return;
      if (record != null) saved.restore(record);
      for (final computer in computers) {
        engine.rememberComputer(computer.id);
      }
      if (saved.selectedId case final id?) engine.select(id);
      ready = true;
    } catch (_) {
      _unreadable = true;
      error =
          'Saved connection settings could not be read. They were preserved. Try again.';
    } finally {
      busy = false;
      _notify();
    }
    // A person who connected before reconnects on open; a first run waits
    // for an explicit tap.
    if (!_disposed && ready && (computers.isNotEmpty || _hadLegacySetup)) {
      await findComputers();
    }
  }

  bool get _hadLegacySetup =>
      saved.credential != null || saved.creatingCredential;

  Future<DesktopRelayToken> _token(String id) async {
    if (_disposed || !_foreground) {
      throw const DeviceLinkException('Connection cancelled.');
    }
    if (accessDenied) throw DesktopRelayAccessException(accessStatus ?? 401);
    try {
      return await fetchToken(id);
    } on DesktopRelayAccessException catch (cause) {
      if (!_disposed && _foreground) _denyAccess(cause);
      rethrow;
    }
  }

  void _denyAccess(DesktopRelayAccessException cause) {
    accessDenied = true;
    accessStatus = cause.statusCode;
    planRequired = cause.entitlementDenied;
    _retry?.cancel();
    _retry = null;
    error = planRequired
        ? null
        : cause.statusCode == 401
        ? 'Your sign-in expired. Sign in again to connect your computers.'
        : 'Computer connection is unavailable for this account. Check your account access and try again.';
    _notify();
  }

  void _resetRecovery() {
    for (final computer in computers.where((computer) => computer.reconnect)) {
      engine.sessions[computer.id]?.chats.connection.recoveryExpired = false;
    }
  }

  Future<void> findComputers() async {
    if (busy || _disposed || !_foreground) return;
    if (!ready || _unreadable) {
      _unreadable = false;
      await restore();
      return;
    }
    // Automatic discovery stops at accessDenied. A tap or foreground resume
    // rechecks once, picking up a renewed sign-in or plan.
    if (accessDenied) {
      accessDenied = false;
      accessStatus = null;
      planRequired = false;
      _resetRecovery();
    }
    _retry?.cancel();
    busy = true;
    finding = true;
    error = null;
    _notify();
    unawaited(_legacyKeyCleanup.run());
    try {
      final relay = await engine.hub.relay(_token);
      if (_disposed || !_foreground) return;
      _watch(relay);
      _readPeers(relay);
      accessDenied = false;
      accessStatus = null;
      for (final computer in computers) {
        if (_disposed || !_foreground) return;
        final connection = engine.sessions[computer.id]?.chats.connection;
        if (saved.computers[computer.id]?.reconnect != true ||
            connection?.busy == true ||
            connection?.recoveryExpired == true ||
            connection?.phase == DesktopLinkPhase.connected ||
            engine.hub.pinnedKey(computer.id) == null ||
            peers[computer.id]?.acceptsControl != true) {
          continue;
        }
        await engine.connectDevice(computer.id, _token, selectComputer: false);
      }
      if (computers.every(
        (c) => !c.reconnect || engine.sessions[c.id]?.chats.online == true,
      )) {
        _attempt = 0;
      }
    } on DesktopRelayAccessException catch (cause) {
      _denyAccess(cause);
    } catch (cause) {
      error = cause is DeviceLinkException
          ? cause.message
          : 'Could not connect. Your saved settings were kept. Try again.';
    } finally {
      busy = false;
      finding = false;
      _notify();
      _schedule();
    }
  }

  void _watch(DesktopRelay relay) {
    if (_disposed || identical(relay, _relay) || relay.isClosed) return;
    unawaited(_peerChanges?.cancel());
    unawaited(_relayClosed?.cancel());
    _relay = relay;
    _peerChanges = relay.peerChanges.listen((_) {
      _retryReturned(_readPeers(relay));
      _schedule();
    });
    _relayClosed = relay.closed.listen((_) {
      peers.clear();
      _notify();
      _schedule();
    });
    _retryReturned(_readPeers(relay));
  }

  /// Returns the saved computers that just became reachable.
  List<String> _readPeers(DesktopRelay relay) {
    if (_disposed) return const [];
    final returned = <String>[];
    for (final peer in relay.peers.values) {
      if (peer.acceptsControl &&
          peers[peer.id]?.acceptsControl != true &&
          saved.computers[peer.id]?.reconnect == true) {
        engine.sessions[peer.id]?.chats.connection.recoveryExpired = false;
        returned.add(peer.id);
      }
    }
    peers
      ..clear()
      ..addAll(relay.peers);
    _notify();
    return returned;
  }

  /// A computer that comes back is retried now, not at the next backoff step.
  void _retryReturned(List<String> returned) {
    var discover = false;
    for (final id in returned) {
      final connection = engine.sessions[id]?.chats.connection;
      if (connection == null) continue;
      if (connection.reconnecting) {
        connection.retryNow();
      } else if (!connection.busy &&
          connection.phase != DesktopLinkPhase.connected) {
        discover = true;
      }
    }
    if (discover && !busy && !accessDenied && _foreground) {
      _retry?.cancel();
      _retry = null;
      unawaited(findComputers());
    }
  }

  void _engineChanged() {
    _notify();
    _schedule();
  }

  void _schedule() {
    if (_disposed ||
        !_foreground ||
        busy ||
        accessDenied ||
        _unreadable ||
        _retry?.isActive == true) {
      return;
    }
    final needsDiscovery =
        _relay?.isClosed == true &&
        computers.any((computer) => computer.reconnect);
    if (!needsDiscovery &&
        !computers.any(
          (c) =>
              c.reconnect &&
              engine.sessions[c.id]?.chats.online != true &&
              engine.sessions[c.id]?.chats.connection.busy != true &&
              engine.sessions[c.id]?.chats.connection.recoveryExpired != true,
        )) {
      return;
    }
    const delays = [2, 5, 15, 30];
    final delay = delays[_attempt.clamp(0, delays.length - 1)];
    _attempt++;
    _retry = createTimer(Duration(seconds: delay), () {
      _retry = null;
      unawaited(findComputers());
    });
  }

  Future<void> connect(String id) async {
    if (busy || _disposed || !_foreground) return;
    final peer = peers[id];
    if (peer == null || !peer.acceptsControl) {
      error = 'This computer is offline or Remote access is off.';
      _notify();
      return;
    }
    busy = true;
    _connectingId = id;
    error = null;
    _notify();
    try {
      await engine.connect(peer, _token);
      if (_disposed || !_foreground || _connectingId != id) return;
      if (engine.sessions[id]?.chats.online == true) {
        saved.computers[id] = SavedComputer(id, peer.name);
        saved.selectedId = id;
        await _save();
      }
    } catch (_) {
      error = 'Could not save this connection. Try again.';
    } finally {
      _connectingId = null;
      busy = false;
      _notify();
      _schedule();
    }
  }

  /// Shows a saved computer. Selection is navigation: every session keeps
  /// running, and only the next cold start's choice depends on the write.
  Future<void> select(String id) async {
    if (_disposed || !saved.computers.containsKey(id)) return;
    engine.select(id);
    if (saved.selectedId == id) return;
    saved.selectedId = id;
    try {
      await _save();
    } catch (_) {
      // The switch already took effect; a cold start reopens the prior one.
    }
  }

  Future<void> disconnect(String id) async {
    final computer = saved.computers[id];
    if (_disposed || computer == null) return;
    // A handshake may finish while the intent write is pending. Its completion
    // must not overwrite this explicit disconnect with reconnect=true.
    if (_connectingId == id) {
      _connectingId = null;
    }
    // Persist intent before closing. A cold start must honor a manual disconnect.
    saved.computers[id] = SavedComputer(id, computer.name, reconnect: false);
    try {
      await _save();
      await engine.sessions[id]?.disconnect();
    } catch (_) {
      saved.computers[id] = computer;
      error = 'Could not save the disconnect. Try again.';
    }
    _notify();
  }

  Future<void> forget(String id) async {
    if (_disposed) return;
    await disconnect(id);
    if (saved.computers[id]?.reconnect != false) return;
    try {
      await engine.hub.forget(id);
      saved.computers.remove(id);
      if (saved.selectedId == id) saved.selectedId = null;
      await _save();
    } catch (_) {
      error = 'Could not forget this computer. Try again.';
    }
    _notify();
  }

  /// Leaving the app briefly keeps its sessions; they close after
  /// [backgroundGrace].
  Future<void> suspend() async {
    if (_disposed || _hidden) return;
    _hidden = true;
    if (!_foreground) return; // Sessions are already closed or closing.
    _hiddenAt = now();
    _closing = createTimer(backgroundGrace, () {
      _closing = null;
      unawaited(_closeSessions());
    });
  }

  Future<void> _closeSessions() async {
    _foreground = false;
    _retry?.cancel();
    _retry = null;
    await engine.suspend();
  }

  Future<void> resume() async {
    if (_disposed) return;
    _reconnectStatus.reset();
    _notify();
    _hidden = false;
    final closing = _closing;
    final hiddenAt = _hiddenAt;
    _closing = null;
    _hiddenAt = null;
    if (closing != null && hiddenAt != null) {
      closing.cancel();
      // Timers stop while the OS suspends the app, so measure the absence.
      if (now().difference(hiddenAt) < backgroundGrace) {
        _resetRecovery();
        // The socket may have died silently, for example on a network change.
        if (_relay case final relay? when !relay.isClosed) {
          await relay.probe();
        }
        if (!_disposed) await findComputers();
        return;
      }
      await _closeSessions();
      // Hidden again while closing: stay closed until the next resume.
      if (_hidden || _disposed) return;
    }
    _foreground = true;
    _resetRecovery();
    await engine.resume();
    if (!_disposed) await findComputers();
  }

  @override
  void dispose() {
    _disposed = true;
    _retry?.cancel();
    _closing?.cancel();
    _reconnectStatus.dispose();
    engine.removeListener(_engineChanged);
    unawaited(_opened?.cancel());
    unawaited(_peerChanges?.cancel());
    unawaited(_relayClosed?.cancel());
    super.dispose();
  }
}

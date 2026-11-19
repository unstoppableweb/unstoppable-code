import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/device_link/desktop/ipc.dart';
import 'package:mobile/device_link/provider_usage/projection.dart';
import 'package:mobile/device_link/provider_usage/repository.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import '../desktop_link_model.dart';
import 'controller.dart';
import 'engine.dart';

/// Account's usage follows Computer Connect's selected computer, including
/// while the detail route is open. Late reads never cross a session boundary.
final class ComputerProviderUsageSource extends ChangeNotifier
    implements ProviderUsageSource {
  ComputerProviderUsageSource({this.createTimer = Timer.new});
  final Timer Function(Duration, void Function()) createTimer;
  ComputerConnectEngine? _engine;
  ComputerConnectController? _computer;
  DeviceProviderUsageRepository? _repository;
  StreamSubscription<Map<String, dynamic>>? _events;
  Timer? _retry;
  int _generation = 0, _readRevision = 0, _attempt = 0;
  int _loadedGeneration = -1, _pendingReads = 0;
  bool _online = false, _disposed = false;
  RemoteControlProviderUsageProjection? _projection;
  final _refreshing = <RemoteControlProviderUsageProvider>{};
  final _failures = <RemoteControlProviderUsageProvider, String>{};

  void bind(ComputerConnectEngine engine) {
    if (identical(engine, _engine)) return;
    _engine?.removeListener(_changed);
    _engine = engine..addListener(_changed);
    _changed();
  }

  @override
  Object? get scopeKey => _computer;
  @override
  bool get isAvailable =>
      _online && _loadedGeneration == _generation && _projection != null;
  @override
  RemoteControlProviderUsageProjection? get projection => _projection;
  @override
  ProviderUsageDelivery get delivery =>
      switch (_computer?.chats.connection.phase) {
        DesktopLinkPhase.connected => ProviderUsageDelivery.live,
        DesktopLinkPhase.reconnecting ||
        DesktopLinkPhase.connecting => ProviderUsageDelivery.reconnecting,
        _ => ProviderUsageDelivery.unreachable,
      };
  @override
  bool isRefreshing(RemoteControlProviderUsageProvider provider) =>
      _refreshing.contains(provider);
  @override
  String? refreshFailure(RemoteControlProviderUsageProvider provider) =>
      _failures[provider];

  void _changed() {
    if (_disposed) return;
    final selected = _engine?.selected;
    final changed = !identical(selected, _computer);
    final online = selected?.chats.online == true;
    if (!changed && online == _online) return;
    _generation++;
    _pendingReads = 0;
    _retry?.cancel();
    _attempt = 0;
    _refreshing.clear();
    _failures.clear();
    if (changed) {
      unawaited(_events?.cancel());
      _computer = selected;
      _projection = null;
      _events = selected?.chats.chats.ipc.events.listen(_event);
    }
    // A reconnect can finish while an old request is still settling. Its
    // repository must not replace this session's observations or account route.
    _repository = online && selected != null
        ? DeviceProviderUsageRepository(selected.chats.chats.ipc)
        : null;
    _online = online;
    notifyListeners();
    if (online) unawaited(_load(_generation));
  }

  bool _current(int generation) =>
      !_disposed && _online && generation == _generation;

  Future<bool> _load(int generation) async {
    final repository = _repository;
    if (repository == null || !_current(generation)) return false;
    _pendingReads++;
    final revision = ++_readRevision;
    try {
      final value = await repository.load();
      if (!_current(generation)) return false;
      // Another provider's newer read owns publication. Superseding this
      // read does not mean its provider refresh failed.
      if (revision != _readRevision) return true;
      _clearRecoveredFailures(value);
      _projection = value;
      _loadedGeneration = generation;
      _attempt = 0;
      _retry?.cancel();
      notifyListeners();
      return true;
    } catch (error) {
      if (!_current(generation)) return false;
      if (revision != _readRevision) return true;
      final unavailable =
          error is DesktopIpcRefusal &&
          error.code == 'remote_channel_unavailable';
      if (!unavailable && _attempt < 3) {
        final delay = Duration(seconds: 1 << _attempt++);
        _retry?.cancel();
        _retry = createTimer(delay, () => unawaited(_load(generation)));
      }
      return false;
    } finally {
      if (_current(generation)) _pendingReads--;
    }
  }

  void _event(Map<String, dynamic> event) {
    if (_disposed || !_online || event['name'] != 'ipc.push') return;
    try {
      final push = usageObject(event['payload']);
      // Preferences pushes are payloadless invalidations.
      if (push['channel'] == 'preferences:changed') {
        _repository?.invalidateRoute();
        _loadedGeneration = -1;
        notifyListeners();
        unawaited(_load(_generation));
        return;
      }
      if (_repository?.applyPush(push) != true) return;
      final value = _repository?.projection;
      if (value == null) {
        // A later observation can recover a session whose initial reads
        // exhausted their retries. Bursts join an active read or backoff.
        if (_pendingReads == 0 && _retry?.isActive != true) {
          unawaited(_load(_generation));
        }
        return;
      }
      _clearRecoveredFailures(value);
      _projection = value;
      _loadedGeneration = _generation;
      notifyListeners();
    } catch (_) {
      // A newer host's unsupported data must not tear down the connection.
      unawaited(_load(_generation));
    }
  }

  @override
  Future<void> refresh(RemoteControlProviderUsageProvider provider) async {
    final repository = _repository;
    if (!isAvailable || repository == null || !_refreshing.add(provider)) {
      return;
    }
    final generation = _generation;
    final previous = _projection;
    void recordFailure() {
      if (_current(generation) &&
          !_hasNewerUsage(previous, _projection, provider)) {
        // A delivered usage observation is authoritative even when its RPC
        // acknowledgement is late or lost. Never expose raw transport errors.
        _failures[provider] = "Couldn't refresh usage. Try again.";
      }
    }

    _failures.remove(provider);
    notifyListeners();
    try {
      await repository.refresh(provider);
      if (_current(generation) && !await _load(generation)) recordFailure();
    } catch (_) {
      recordFailure();
    } finally {
      if (_current(generation)) {
        _refreshing.remove(provider);
        notifyListeners();
      }
    }
  }

  void _clearRecoveredFailures(RemoteControlProviderUsageProjection next) {
    _failures.removeWhere(
      (provider, _) => _hasNewerUsage(_projection, next, provider),
    );
  }

  bool _hasNewerUsage(
    RemoteControlProviderUsageProjection? before,
    RemoteControlProviderUsageProjection? after,
    RemoteControlProviderUsageProvider provider,
  ) {
    final previous = before?.providers
        .where((row) => row.provider == provider)
        .firstOrNull;
    final next = after?.providers
        .where((row) => row.provider == provider)
        .firstOrNull;
    bool newer(String? at, String? previousAt) {
      final time = at == null ? null : DateTime.tryParse(at);
      final old = previousAt == null ? null : DateTime.tryParse(previousAt);
      return time != null && (old == null || time.isAfter(old));
    }

    if (next == null) return false;
    if (next.accounts case final accounts?) {
      return accounts.any(
        (account) =>
            account.error == null &&
            newer(
              account.lastUpdatedAt,
              previous?.accounts
                  ?.where((row) => row.id == account.id)
                  .firstOrNull
                  ?.lastUpdatedAt,
            ),
      );
    }
    return next.authState ==
            RemoteControlProviderUsageAuthState.authenticated &&
        next.error == null &&
        newer(next.lastUpdatedAt, previous?.lastUpdatedAt);
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _retry?.cancel();
    _engine?.removeListener(_changed);
    unawaited(_events?.cancel());
    super.dispose();
  }
}

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';

import 'usage_limits_policy.dart';

/// State of the Usage limits detail screen (CAN-3636), owned by that screen.
///
/// Mirrors the paired desktop's usage while it is available. When the
/// desktop goes away the last values stay on screen, marked disconnected,
/// and refresh is disabled. Selecting another computer clears those retained
/// values immediately; reconnecting the same computer replaces them. The
/// [clock] and [timer] drive the passed-reset overlay, which flips when a
/// reset time arrives even without a usage update.
final class UsageLimitsViewModel extends ChangeNotifier
    with DisposeSafeNotifier {
  UsageLimitsViewModel({
    required this._source,
    DateTime Function()? clock,
    Timer Function(Duration, void Function())? timer,
  }) : _clock = clock ?? DateTime.now,
       _timer = timer ?? Timer.new {
    _source.addListener(_onSourceChanged);
    _onSourceChanged();
  }

  final ProviderUsageSource _source;
  final DateTime Function() _clock;
  final Timer Function(Duration, void Function()) _timer;

  RemoteControlProviderUsageProjection? _projection;
  Object? _scopeKey;
  bool _available = false;
  ProviderUsageDelivery _delivery = ProviderUsageDelivery.live;
  Timer? _resetTimer;

  /// The values on screen: live while available, the last ones otherwise.
  RemoteControlProviderUsageProjection? get projection => _projection;

  /// False once the desktop stopped answering for usage.
  bool get isDesktopAvailable => _available;

  /// This phone's delivery of updates, independent of the desktop.
  ProviderUsageDelivery get delivery => _delivery;

  DateTime now() => _clock();

  bool isRefreshing(RemoteControlProviderUsageProvider provider) =>
      _available && _source.isRefreshing(provider);

  String? refreshFailure(RemoteControlProviderUsageProvider provider) =>
      _available ? _source.refreshFailure(provider) : null;

  bool canRefresh(RemoteControlProviderUsageProvider provider) =>
      _available &&
      _delivery == ProviderUsageDelivery.live &&
      !_source.isRefreshing(provider);

  Future<void> refresh(RemoteControlProviderUsageProvider provider) async {
    if (!canRefresh(provider)) return;
    await _source.refresh(provider);
  }

  void _onSourceChanged() {
    if (_scopeKey != _source.scopeKey) {
      _scopeKey = _source.scopeKey;
      _projection = null;
    }
    _available = _source.isAvailable;
    _delivery = _source.delivery;
    if (_available) _projection = _source.projection;
    _scheduleResetTick();
    notifyListenersSafe();
  }

  void _scheduleResetTick() {
    _resetTimer?.cancel();
    _resetTimer = null;
    final now = _clock();
    final next = nextUsageResetAfter(_projection, now);
    if (next == null) return;
    _resetTimer = _timer(next.difference(now), () {
      _scheduleResetTick();
      notifyListenersSafe();
    });
  }

  @override
  void dispose() {
    _source.removeListener(_onSourceChanged);
    _resetTimer?.cancel();
    super.dispose();
  }
}

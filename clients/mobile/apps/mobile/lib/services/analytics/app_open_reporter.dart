import 'package:mobile/services/analytics/product_analytics.dart';

/// PostHog events for app opens. Fixed constants: renaming one splits
/// historical analytics (see the `posthog-event-naming` skill).
abstract final class AppOpenEvents {
  static const String sessionStart = 'app:session_start';
}

/// Fixed property keys for [AppOpenEvents].
abstract final class AppOpenProperties {
  /// Whether this install had not yet reported its first launch when the
  /// process started. Omitted, never false, when that is unknown.
  static const String isFirstOpen = 'is_first_open';
}

/// Sends `app:session_start` once per process so active installs can be
/// counted by platform. The event carries no content and no identifier;
/// `platform_name` and the other build context are added by the PostHog sink.
final class AppOpenReporter {
  /// [isFirstLaunch] must be read before the install beacon can flip its
  /// marker, and may complete with an error when the marker is unreadable;
  /// that is reported as an unknown (omitted) `is_first_open`.
  AppOpenReporter({
    required this._analytics,
    required Future<bool> isFirstLaunch,
  }) : _isFirstLaunch = isFirstLaunch.then<bool?>(
         (value) => value,
         onError: (Object _) => null,
       );

  final ProductAnalytics _analytics;
  final Future<bool?> _isFirstLaunch;
  bool _reported = false;

  /// Call once analytics is ready and the usage-data choice is applied to the
  /// SDK. Later calls in the same process do nothing.
  Future<void> reportOnce() async {
    if (_reported) return;
    _reported = true;
    final isFirstOpen = await _isFirstLaunch;
    _analytics.capture(AppOpenEvents.sessionStart, {
      AppOpenProperties.isFirstOpen: ?isFirstOpen,
    });
  }
}

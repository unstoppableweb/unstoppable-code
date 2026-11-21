import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

/// Platforms whose first launch is reported as an install.
enum InstallBeaconPlatform {
  ios('ios'),
  android('android');

  const InstallBeaconPlatform(this.wire);

  final String wire;
}

/// Persists whether this installation has successfully reported its beacon.
abstract interface class InstallBeaconMarkerStore {
  Future<bool> hasReported();

  Future<void> markReported();
}

/// Uses the app's ordinary preferences on platforms where those preferences
/// have the desired install lifetime (currently iOS).
final class SharedPreferencesInstallBeaconMarkerStore
    implements InstallBeaconMarkerStore {
  @override
  Future<bool> hasReported() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(InstallBeaconService.preferenceKey) ?? false;
  }

  @override
  Future<void> markReported() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(InstallBeaconService.preferenceKey, true);
  }
}

/// Uses Android's native no-backup directory so device transfer and automatic
/// backup cannot restore a completed marker onto a fresh installation.
final class AndroidNoBackupInstallBeaconMarkerStore
    implements InstallBeaconMarkerStore {
  static const MethodChannel _channel = MethodChannel(
    'com.unstoppabledomains.canopy/install_beacon',
  );

  @override
  Future<bool> hasReported() async =>
      await _channel.invokeMethod<bool>('hasReported') ?? false;

  @override
  Future<void> markReported() => _channel.invokeMethod<void>('markReported');
}

/// Reports the app's first launch on this install exactly once.
///
/// An App Store / Play install is not observable from our backend, so the app's
/// own first run is the earliest install signal available. The report is
/// anonymous by design: it carries the platform only — no device id, no
/// advertising identifier, and no account — so it stays out of the app's
/// privacy disclosures.
///
/// Best-effort and never blocking: startup must not wait on it, and a failure
/// costs a feed line rather than a launch.
final class InstallBeaconService {
  InstallBeaconService({
    required this.baseUrlProvider,
    http.Client? httpClient,
    this.platformOverride,
    InstallBeaconMarkerStore? markerStore,
  }) : _client = httpClient ?? http.Client(),
       _markerStore =
           markerStore ??
           (Platform.isAndroid
               ? AndroidNoBackupInstallBeaconMarkerStore()
               : SharedPreferencesInstallBeaconMarkerStore());

  /// Marks that this install has already reported. Versioned so a future
  /// change of what "first launch" means can re-report deliberately rather
  /// than silently reusing a stale flag.
  static const String preferenceKey = 'mobile.install_beacon_reported_v1';

  static const String path = '/api/download/track';

  /// Matches the discriminator the shared beacon route uses to tell a mobile
  /// install apart from a web download click.
  static const String source = 'app-first-launch';

  /// Short on purpose: this runs during startup, so a stalled request must be
  /// abandoned rather than hold a socket open behind the first screen.
  static const Duration timeout = Duration(seconds: 5);

  final String Function() baseUrlProvider;
  final http.Client _client;
  final InstallBeaconMarkerStore _markerStore;

  /// Injected by tests; production resolves the real host platform.
  final InstallBeaconPlatform? platformOverride;

  InstallBeaconPlatform? get _platform {
    final override = platformOverride;
    if (override != null) return override;
    if (Platform.isIOS) return InstallBeaconPlatform.ios;
    if (Platform.isAndroid) return InstallBeaconPlatform.android;
    return null;
  }

  /// Whether this install has not yet reported its beacon, i.e. this is its
  /// first launch as far as the beacon knows. Read it before
  /// [reportFirstLaunchIfNeeded] starts: that flips the marker once the server
  /// accepts. Throws when the platform is unsupported or the marker cannot be
  /// read, so callers can tell unknown apart from false.
  Future<bool> isFirstLaunch() async {
    if (_platform == null) {
      throw StateError('Install beacon is unsupported on this platform');
    }
    return !await _markerStore.hasReported();
  }

  /// Posts the first-launch beacon unless this install already reported.
  ///
  /// The persisted flag is written only after the server accepts the report, so
  /// a first launch in airplane mode reports on a later launch instead of being
  /// lost. At most one attempt is made per launch, so an endpoint that is gone
  /// cannot spin.
  Future<void> reportFirstLaunchIfNeeded() async {
    try {
      final platform = _platform;
      if (platform == null) return;

      if (await _markerStore.hasReported()) return;

      final baseUrl = baseUrlProvider().trim();
      if (baseUrl.isEmpty) return;
      final baseUri = Uri.tryParse(baseUrl);
      if (baseUri == null || !baseUri.hasScheme || baseUri.host.isEmpty) return;
      final uri = baseUri.resolve(path);

      final response = await _client
          .post(
            uri,
            headers: const {'Content-Type': 'application/json'},
            body: jsonEncode({'platform': platform.wire, 'source': source}),
          )
          .timeout(timeout);

      if (response.statusCode >= 200 && response.statusCode < 300) {
        await _markerStore.markReported();
      }
    } catch (_) {
      // Offline, malformed host, unavailable preferences: the beacon is
      // best-effort and a later launch retries.
    }
  }
}

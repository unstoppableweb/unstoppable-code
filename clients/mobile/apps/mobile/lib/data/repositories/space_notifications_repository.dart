import 'dart:async';
import 'dart:convert';

import 'package:mobile/data/models/space_notification_policy.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/space_notifications_api_service.dart';

/// Why a read or save of a space's notification choice did not return a
/// snapshot.
enum SpaceNotificationsFailure {
  /// 403 or 404: the server does not know this space, or the user is not in
  /// it.
  notFound,

  /// 409: the save named a revision the space has moved past.
  staleRevision,

  /// 423: a notification for this space is being delivered.
  deliveryInProgress,

  /// 503: the server is not accepting changes.
  writesDisabled,

  /// Any other 4xx: refused, and nothing was saved.
  rejected,

  /// A transport failure, timeout, other 5xx, or unreadable body. The server
  /// may or may not have applied a save.
  ambiguous,
}

/// Thrown by [SpaceNotificationsRepository]. A refused save carries the
/// server's authoritative [policy] when its body had one.
final class SpaceNotificationsException implements Exception {
  const SpaceNotificationsException(this.failure, {this.policy});

  final SpaceNotificationsFailure failure;
  final SpaceNotificationPolicy? policy;

  @override
  String toString() => 'SpaceNotificationsException(${failure.name})';
}

/// Reads and saves the signed-in user's notification choice for one space.
abstract interface class SpaceNotificationsRepository {
  /// Reads the space's saved choice. Throws [SpaceNotificationsException].
  Future<SpaceNotificationPolicy> load(String spaceId);

  /// Saves [override] (null clears it) against [expectedRevision].
  /// Throws [SpaceNotificationsException].
  Future<SpaceNotificationPolicy> save(
    String spaceId, {
    required int expectedRevision,
    required SpaceNotificationLevel? override,
  });
}

/// Live [SpaceNotificationsRepository] backed by
/// [SpaceNotificationsApiService].
final class HttpSpaceNotificationsRepository
    implements SpaceNotificationsRepository {
  const HttpSpaceNotificationsRepository({
    required this.service,
    this.timeout = const Duration(seconds: 20),
  });

  final SpaceNotificationsApiService service;

  /// Upper bound for one request, so a connection that neither answers nor
  /// fails settles as [SpaceNotificationsFailure.ambiguous].
  final Duration timeout;

  @override
  Future<SpaceNotificationPolicy> load(String spaceId) =>
      _guard(() => service.getPolicy(spaceId));

  @override
  Future<SpaceNotificationPolicy> save(
    String spaceId, {
    required int expectedRevision,
    required SpaceNotificationLevel? override,
  }) => _guard(
    () => service.setPreference(
      spaceId,
      expectedRevision: expectedRevision,
      override: override,
    ),
  );

  Future<SpaceNotificationPolicy> _guard(
    Future<SpaceNotificationPolicy?> Function() request,
  ) async {
    final SpaceNotificationPolicy? policy;
    try {
      policy = await request().timeout(timeout);
    } on ApiException catch (error) {
      throw _fromApiException(error);
    } on Exception {
      throw const SpaceNotificationsException(
        SpaceNotificationsFailure.ambiguous,
      );
    }
    if (policy == null) {
      throw const SpaceNotificationsException(
        SpaceNotificationsFailure.ambiguous,
      );
    }
    return policy;
  }

  static SpaceNotificationsException _fromApiException(ApiException error) {
    final policy = _policyFromBody(error.body);
    final failure = switch (error.statusCode) {
      403 || 404 => SpaceNotificationsFailure.notFound,
      409 => SpaceNotificationsFailure.staleRevision,
      423 => SpaceNotificationsFailure.deliveryInProgress,
      503 => SpaceNotificationsFailure.writesDisabled,
      >= 500 => SpaceNotificationsFailure.ambiguous,
      _ => SpaceNotificationsFailure.rejected,
    };
    return SpaceNotificationsException(failure, policy: policy);
  }

  /// The `policy` of a `{ error, policy }` refusal body, when readable.
  static SpaceNotificationPolicy? _policyFromBody(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is! Map<String, dynamic>) return null;
      return SpaceNotificationPolicy.tryParse(decoded['policy']);
    } on FormatException {
      return null;
    }
  }
}

/// In-memory [SpaceNotificationsRepository] used in mock mode (no API
/// config) and in tests. Every space starts with no override at revision 0 and
/// enforces revisions the way the server does.
final class MockSpaceNotificationsRepository
    implements SpaceNotificationsRepository {
  MockSpaceNotificationsRepository({
    this.latency = const Duration(milliseconds: 400),
  });

  final Duration latency;

  final Map<String, SpaceNotificationPolicy> _policies = {};

  /// Number of times [load] has been called. Test-only instrumentation.
  int loadCount = 0;

  /// Number of times [save] has been called. Test-only instrumentation.
  int saveCount = 0;

  SpaceNotificationPolicy _policyFor(String spaceId) =>
      _policies[spaceId] ??= SpaceNotificationPolicy(
        spaceId: spaceId,
        revision: 0,
        override: null,
        writesEnabled: true,
      );

  @override
  Future<SpaceNotificationPolicy> load(String spaceId) async {
    loadCount++;
    await Future<void>.delayed(latency);
    return _policyFor(spaceId);
  }

  @override
  Future<SpaceNotificationPolicy> save(
    String spaceId, {
    required int expectedRevision,
    required SpaceNotificationLevel? override,
  }) async {
    saveCount++;
    await Future<void>.delayed(latency);
    final current = _policyFor(spaceId);
    if (current.revision != expectedRevision) {
      throw SpaceNotificationsException(
        SpaceNotificationsFailure.staleRevision,
        policy: current,
      );
    }
    return _policies[spaceId] = SpaceNotificationPolicy(
      spaceId: spaceId,
      revision: current.revision + 1,
      override: override,
      writesEnabled: current.writesEnabled,
    );
  }
}

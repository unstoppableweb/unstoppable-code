/// Reads the account-level `provider_usage` singleton (CAN-3635) out of
/// Portal entity envelopes. The desktop normalizes the values; this file only
/// decides whether a payload carried the singleton, cleared it, or said
/// nothing about it.
library;

import 'package:mobile/data/protocol/generated/provider_usage.dart';

/// `RemoteControlEntityType` of the singleton.
const String kProviderUsageEntityType = 'provider_usage';

/// One authoritative observation of the singleton. A null [projection] means
/// the desktop no longer projects usage (an overview snapshot without it, or
/// an explicit removal).
final class RemoteProviderUsageUpdate {
  const RemoteProviderUsageUpdate(this.projection);

  final RemoteControlProviderUsageProjection? projection;
}

/// The singleton from `RemoteControlEntityEnvelope` [entities].
///
/// Returns null when the rows say nothing about usage: [entities] is not a
/// list, the singleton is absent from a non-[authoritative] payload, or its
/// payload cannot be decoded (the last good value is kept rather than
/// blanked). An [authoritative] payload, an overview snapshot that replaces
/// every overview entity type, reports a missing singleton as cleared.
RemoteProviderUsageUpdate? parseProviderUsageEntities(
  Object? entities, {
  bool authoritative = false,
}) {
  if (entities is! List) return null;
  for (final row in entities.whereType<Map<String, dynamic>>()) {
    if (row['entityType'] != kProviderUsageEntityType) continue;
    final payload = row['payload'];
    if (payload is! Map<String, dynamic>) return null;
    try {
      return RemoteProviderUsageUpdate(
        RemoteControlProviderUsageProjection.fromJson(payload),
      );
    } catch (_) {
      return null;
    }
  }
  return authoritative ? const RemoteProviderUsageUpdate(null) : null;
}

/// Whether a delta's `removed` rows drop the singleton.
bool removesProviderUsage(Object? removed) =>
    removed is List &&
    removed.whereType<Map<String, dynamic>>().any(
      (row) => row['entityType'] == kProviderUsageEntityType,
    );

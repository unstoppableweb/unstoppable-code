import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/space_notification_policy.dart';
import 'package:mobile/data/repositories/space_notifications_repository.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

import 'space_notification_menu.dart';

/// Per-space notification choices offered from Computer connect rows
/// (CAN-3615, restored in CAN-7218). Mirrors the web
/// `SpaceNotificationSettingsStore`.
///
/// The server owns the choice. This view model only shows what the server
/// has acknowledged: a choice is never shown as selected before its save
/// returns, there is no offline write queue, and an outcome the network left
/// ambiguous is settled by reading the space again rather than by assuming
/// it failed.
///
/// The choices are the signed-in account's own server setting, not a command
/// to a computer, so one view model serves every connected computer. It is
/// account-scoped: its owner creates a new one for another account.
final class SpaceNotificationsViewModel extends ChangeNotifier
    with DisposeSafeNotifier {
  SpaceNotificationsViewModel({required this.repository});

  final SpaceNotificationsRepository repository;

  final Map<String, _Entry> _entries = {};

  /// The latest read or save per space; any other result is stale.
  final Map<String, Object> _operations = {};

  /// What the menu for [spaceId] shows. A space that has not been read yet is
  /// loading, with no selection.
  SpaceNotificationMenuState menuStateFor(String spaceId) {
    final entry = _entries[spaceId];
    final snapshot = entry?.snapshot;
    if (entry == null || snapshot == null) {
      final unavailable = entry?.unavailable ?? false;
      final failed = entry?.status == SpaceNotificationMenuStatus.failed;
      return SpaceNotificationMenuState(
        status: unavailable
            ? SpaceNotificationMenuStatus.ready
            : failed
            ? SpaceNotificationMenuStatus.failed
            : SpaceNotificationMenuStatus.loading,
        override: null,
        selectionKnown: false,
        failure: entry?.failure,
        disabledReason: unavailable
            ? SpaceNotificationCopy.writesClosed
            : failed
            ? SpaceNotificationCopy.loadFailed
            : null,
      );
    }
    return SpaceNotificationMenuState(
      status: entry.status,
      override: snapshot.override,
      selectionKnown: true,
      pendingOverride: entry.pendingOverride,
      failure: entry.failure,
      disabledReason: snapshot.writesEnabled
          ? null
          : SpaceNotificationCopy.writesClosed,
    );
  }

  /// Reads the space's saved choice. Called whenever its menu opens.
  Future<void> refresh(String spaceId) async {
    if (isDisposed) return;
    final current = _entries[spaceId];
    if (current != null && current.isBusy) return;
    final operation = Object();
    _operations[spaceId] = operation;
    final known = current?.snapshot;
    // A known choice stays on screen while it is re-read.
    _put(
      spaceId,
      current == null || known == null
          ? const _Entry(status: SpaceNotificationMenuStatus.loading)
          : _Entry(
              snapshot: known,
              status: current.status,
              failure: current.failure,
            ),
    );
    final SpaceNotificationPolicy policy;
    try {
      policy = await repository.load(spaceId);
    } catch (error) {
      if (!_isCurrent(spaceId, operation)) return;
      _put(spaceId, _readRefusal(spaceId, error, known));
      return;
    }
    if (!_isCurrent(spaceId, operation)) return;
    if (policy.spaceId != spaceId) {
      _put(spaceId, _readFailure(known));
      return;
    }
    // A failure line describes a save against the revision it was shown
    // with; a fresh read at a newer revision replaces it.
    final stale = known != null && policy.revision == known.revision;
    _put(
      spaceId,
      _Entry(
        snapshot: _newest(known, policy),
        status: stale && current?.status == SpaceNotificationMenuStatus.failed
            ? SpaceNotificationMenuStatus.failed
            : SpaceNotificationMenuStatus.ready,
        failure: stale ? current?.failure : null,
      ),
    );
  }

  /// Saves [choice] (null clears the override). Ignored while the space is
  /// loading or saving, when nothing is known yet, when changes are closed,
  /// and when [choice] is already saved.
  Future<void> select(String spaceId, SpaceNotificationLevel? choice) async {
    if (isDisposed) return;
    final current = _entries[spaceId];
    final known = current?.snapshot;
    // One save at a time per space, and never against an unknown revision.
    if (current == null || known == null || current.isBusy) return;
    if (!known.writesEnabled || known.override == choice) return;
    final operation = Object();
    _operations[spaceId] = operation;
    _put(
      spaceId,
      _Entry(
        snapshot: known,
        status: SpaceNotificationMenuStatus.saving,
        pendingOverride: choice,
      ),
    );
    final SpaceNotificationPolicy saved;
    try {
      saved = await repository.save(
        known.spaceId,
        expectedRevision: known.revision,
        override: choice,
      );
    } catch (error) {
      await _settleRefusal(spaceId, error, known, choice, operation);
      return;
    }
    if (!_isCurrent(spaceId, operation)) return;
    if (saved.spaceId != known.spaceId ||
        saved.revision <= known.revision ||
        saved.override != choice) {
      await _reconcile(spaceId, known, choice, operation);
      return;
    }
    _put(
      spaceId,
      _Entry(snapshot: saved, status: SpaceNotificationMenuStatus.ready),
    );
  }

  Future<void> _settleRefusal(
    String spaceId,
    Object error,
    SpaceNotificationPolicy known,
    SpaceNotificationLevel? choice,
    Object operation,
  ) async {
    if (!_isCurrent(spaceId, operation)) return;
    final failure = error is SpaceNotificationsException
        ? error.failure
        : SpaceNotificationsFailure.ambiguous;
    if (failure == SpaceNotificationsFailure.notFound) {
      _put(spaceId, const _Entry.unavailable());
      return;
    }
    final authoritative = error is SpaceNotificationsException
        ? error.policy
        : null;
    // A stale revision is never retried for the user: read the space again
    // and show what the server holds now.
    if (failure == SpaceNotificationsFailure.staleRevision) {
      await _refetchAfterConflict(spaceId, known, authoritative, operation);
      return;
    }
    final refusal = switch (failure) {
      SpaceNotificationsFailure.deliveryInProgress =>
        SpaceNotificationCopy.deliveryInProgress,
      SpaceNotificationsFailure.writesDisabled =>
        SpaceNotificationCopy.writesClosed,
      _ => null,
    };
    if (refusal != null &&
        authoritative != null &&
        authoritative.spaceId == known.spaceId &&
        authoritative.revision >= known.revision) {
      _put(
        spaceId,
        _Entry(
          snapshot: authoritative,
          status: SpaceNotificationMenuStatus.failed,
          failure: refusal,
        ),
      );
      return;
    }
    // A transport failure, 5xx, or unreadable body does not say whether the
    // write committed.
    if (failure == SpaceNotificationsFailure.ambiguous ||
        failure == SpaceNotificationsFailure.writesDisabled) {
      await _reconcile(spaceId, known, choice, operation);
      return;
    }
    _put(
      spaceId,
      _Entry(
        snapshot: known,
        status: SpaceNotificationMenuStatus.failed,
        failure: SpaceNotificationCopy.saveFailed,
      ),
    );
  }

  /// Settles a save refused for a stale revision: shows a fresh read, or the
  /// refusal's own policy when that read fails, as the selected choice.
  Future<void> _refetchAfterConflict(
    String spaceId,
    SpaceNotificationPolicy sentAgainst,
    SpaceNotificationPolicy? refusalPolicy,
    Object operation,
  ) async {
    final latest =
        await _readAtLeast(sentAgainst) ?? _atLeast(sentAgainst, refusalPolicy);
    if (!_isCurrent(spaceId, operation)) return;
    _put(
      spaceId,
      _Entry(
        snapshot: latest ?? sentAgainst,
        status: SpaceNotificationMenuStatus.failed,
        failure: latest == null
            ? SpaceNotificationCopy.unconfirmed
            : SpaceNotificationCopy.changedElsewhere,
      ),
    );
  }

  /// Settles a save whose outcome never arrived. The write committed only if
  /// the space moved past the revision it was sent against AND now holds the
  /// requested choice; anything else is reported as not saved, with whatever
  /// the server holds shown as selected.
  Future<void> _reconcile(
    String spaceId,
    SpaceNotificationPolicy sentAgainst,
    SpaceNotificationLevel? choice,
    Object operation,
  ) async {
    if (!_isCurrent(spaceId, operation)) return;
    final latest = await _readAtLeast(sentAgainst);
    if (!_isCurrent(spaceId, operation)) return;
    if (latest == null) {
      _put(
        spaceId,
        _Entry(
          snapshot: sentAgainst,
          status: SpaceNotificationMenuStatus.failed,
          failure: SpaceNotificationCopy.unconfirmed,
        ),
      );
      return;
    }
    final advanced = latest.revision > sentAgainst.revision;
    _put(
      spaceId,
      advanced && latest.override == choice
          ? _Entry(snapshot: latest, status: SpaceNotificationMenuStatus.ready)
          : _Entry(
              snapshot: latest,
              status: SpaceNotificationMenuStatus.failed,
              failure: advanced
                  ? SpaceNotificationCopy.changedElsewhere
                  : SpaceNotificationCopy.saveFailed,
            ),
    );
  }

  /// Reads the space again; null when the read fails or is older than
  /// [sentAgainst].
  Future<SpaceNotificationPolicy?> _readAtLeast(
    SpaceNotificationPolicy sentAgainst,
  ) async {
    try {
      return _atLeast(sentAgainst, await repository.load(sentAgainst.spaceId));
    } catch (_) {
      return null;
    }
  }

  /// [policy] when it is the same space at [sentAgainst]'s revision or newer.
  static SpaceNotificationPolicy? _atLeast(
    SpaceNotificationPolicy sentAgainst,
    SpaceNotificationPolicy? policy,
  ) =>
      policy != null &&
          policy.spaceId == sentAgainst.spaceId &&
          policy.revision >= sentAgainst.revision
      ? policy
      : null;

  /// A refused read: the user cannot reach the space (403 or 404), the
  /// server is not accepting changes (503, shown read-only with the policy it
  /// returned), or a failure the user can retry by reopening the sheet.
  static _Entry _readRefusal(
    String spaceId,
    Object error,
    SpaceNotificationPolicy? known,
  ) {
    if (error is! SpaceNotificationsException) return _readFailure(known);
    if (error.failure == SpaceNotificationsFailure.notFound) {
      return const _Entry.unavailable();
    }
    final policy = error.policy;
    if (error.failure == SpaceNotificationsFailure.writesDisabled &&
        policy != null &&
        policy.spaceId == spaceId) {
      return _Entry(
        snapshot: SpaceNotificationPolicy(
          spaceId: policy.spaceId,
          revision: policy.revision,
          override: policy.override,
          writesEnabled: false,
        ),
        status: SpaceNotificationMenuStatus.ready,
      );
    }
    return _readFailure(known);
  }

  /// A failed re-read keeps the last acknowledged choice and stays usable;
  /// only a first read with nothing to show reports the failure.
  static _Entry _readFailure(SpaceNotificationPolicy? known) => known == null
      ? const _Entry(
          status: SpaceNotificationMenuStatus.failed,
          failure: SpaceNotificationCopy.loadFailed,
        )
      : _Entry(snapshot: known, status: SpaceNotificationMenuStatus.ready);

  /// A late response never rolls a space back to an older revision.
  static SpaceNotificationPolicy _newest(
    SpaceNotificationPolicy? known,
    SpaceNotificationPolicy incoming,
  ) => known != null && known.revision > incoming.revision ? known : incoming;

  bool _isCurrent(String spaceId, Object operation) =>
      !isDisposed && identical(_operations[spaceId], operation);

  void _put(String spaceId, _Entry entry) {
    _entries[spaceId] = entry;
    notifyListenersSafe();
  }
}

class _Entry {
  const _Entry({
    required this.status,
    this.snapshot,
    this.failure,
    this.pendingOverride,
  }) : unavailable = false;

  /// The server does not know this space: choices stay disabled, with why.
  const _Entry.unavailable()
    : status = SpaceNotificationMenuStatus.ready,
      snapshot = null,
      failure = null,
      pendingOverride = null,
      unavailable = true;

  /// The override a save in flight is storing.
  final SpaceNotificationLevel? pendingOverride;

  /// Absent until the space has been read once.
  final SpaceNotificationPolicy? snapshot;
  final SpaceNotificationMenuStatus status;
  final String? failure;
  final bool unavailable;

  bool get isBusy =>
      status == SpaceNotificationMenuStatus.loading ||
      status == SpaceNotificationMenuStatus.saving;
}

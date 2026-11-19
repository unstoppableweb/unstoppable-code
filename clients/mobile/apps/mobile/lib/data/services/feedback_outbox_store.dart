/// Durable queue of turn-feedback operations that have not reached the server.
///
/// Ratings are fire-and-forget — nothing on screen holds the payload — so a
/// dropped one is invisible to the user. Report submissions deliberately do
/// NOT use this: their sheet stays open on failure with the text intact.
///
/// Follows the repo's persisted-file conventions: an explicit `version`, and a
/// silent fallback to empty on a corrupt or unrecognized read.
library;

import 'dart:convert';

import 'package:mobile/data/models/turn_feedback.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// `rate` carries the desired end state. `clear` retracts a rating the server
/// already holds; a clear for a still-pending rate removes that entry instead
/// of queueing one, because there is nothing on the server to retract. `detail`
/// amends an already-synced rating (known `feedbackId`) with a reason and/or
/// comment when that PATCH itself fails retryably — it never carries a
/// `rating`, so it must not be confused with a re-queued rate.
enum FeedbackOutboxKind { rate, clear, detail }

/// Version 3 makes [FeedbackOutboxEntry.accountId] an opaque principal scope
/// containing BOTH the selected API environment and the signed-in account id.
/// Version 2 carried only the account id, so production user 7 and staging user
/// 7 were indistinguishable. Versions 1 and 2 are therefore dropped by the
/// unrecognized-version fallback rather than migrated: neither contains enough
/// information to identify the server-side principal that authored the row.
///
/// [FeedbackOutboxEntry.seq] was added WITHOUT a further bump: it is purely
/// additive and a row that lacks it decodes to `0`, which is the correct
/// answer for a row an earlier run wrote (older than every sequence this run
/// will issue). Bumping would have discarded live queues to gain nothing.
const int feedbackOutboxVersion = 3;
const int feedbackOutboxMaxEntries = 100;
const Duration feedbackOutboxMaxAge = Duration(days: 14);

final class FeedbackOutboxEntry {
  const FeedbackOutboxEntry({
    required this.kind,
    required this.clientUserMessageId,
    required this.clientChatId,
    required this.queuedAtMs,
    required this.seq,
    this.accountId,
    this.rating,
    this.reason,
    this.comment,
    this.feedbackId,
    this.provider,
    this.model,
    this.chatMode,
    this.appVersion,
    this.eventType,
  });

  final FeedbackOutboxKind kind;
  final String clientUserMessageId;
  final String clientChatId;

  /// The server principal this entry was queued under.
  ///
  /// The queue is durable and survives sign-out, and a 401 is a RETRYABLE
  /// failure (see `isRejectedTurnFeedbackRequest`) — precisely because an
  /// expired session is the case worth replaying. Without this field the
  /// replay would happen under whichever account happens to be signed in at
  /// flush time, publishing one user's rating (and their typed comment) as
  /// another's: the server upserts on `(userId, clientUserMessageId)` and
  /// performs no chat-ownership check. Flush therefore sends only the entries
  /// whose [accountId] equals the current environment-qualified account scope.
  ///
  /// Despite the legacy JSON/property name, this is intentionally opaque and
  /// has the form `<api-environment>:<stable-user-id>` in production. Code must
  /// only compare it for equality, never parse it. Nullable only so a malformed
  /// row still parses; such an entry belongs to no principal and is never sent.
  final String? accountId;
  final TurnFeedbackRating? rating;
  final TurnFeedbackReason? reason;
  final String? comment;
  final String? feedbackId;

  /// Denormalized technical context, carried through the outbox so a queued
  /// `rate` replays with the same columns a same-turn online write would have
  /// sent. Mirrors `TurnFeedbackContext` (`data/repositories/turn_feedback_repository.dart`).
  final String? provider;
  final String? model;
  final String? chatMode;
  final String? appVersion;
  final String? eventType;

  /// WALL-CLOCK time this entry was queued, in milliseconds since the epoch.
  ///
  /// This field and [seq] answer two different questions, and using either for
  /// the other's is what produced the ordering bugs this class now guards
  /// against. Keep them apart:
  ///
  /// - [queuedAtMs] answers "how OLD is this entry", and only that. Its single
  ///   consumer is the [feedbackOutboxMaxAge] age cutoff in
  ///   [pruneFeedbackOutbox], which genuinely wants wall time: 14 days is a
  ///   calendar span, and there is no local stamp to compare a queued entry's
  ///   age against.
  /// - [seq] answers "which of two LOCALLY ISSUED writes came first", and only
  ///   that. Every ordering decision the repository makes is between two
  ///   stamps this device issued itself, so it needs a total order rather than
  ///   a date.
  final int queuedAtMs;

  /// MONOTONIC local ordering position, from a per-repository counter that is
  /// never read from a clock. See [queuedAtMs] for the division of labor.
  ///
  /// A wall clock cannot order local writes: a backward device or NTP
  /// correction inside a request window makes a NEWER entry look older, and
  /// the success-path sweep then deletes a rating that was queued while the
  /// request it is bounded against was still in flight — precisely the loss
  /// the bound exists to prevent. A counter cannot move backwards, so the
  /// comparison is exact and every tie disappears (no two entries can share a
  /// sequence).
  ///
  /// `0` means "queued before this field existed" — a row decoded from an
  /// older persisted payload. It sorts as older than every issued stamp,
  /// which is correct: it was written by an earlier run of the app. The
  /// repository raises its counter past every sequence it reads, so a new
  /// stamp always exceeds anything already stored.
  final int seq;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'kind': switch (kind) {
      FeedbackOutboxKind.rate => 'rate',
      FeedbackOutboxKind.clear => 'clear',
      FeedbackOutboxKind.detail => 'detail',
    },
    'clientUserMessageId': clientUserMessageId,
    'clientChatId': clientChatId,
    'queuedAtMs': queuedAtMs,
    'seq': seq,
    'accountId': ?accountId,
    if (rating != null) 'rating': turnFeedbackRatingWire(rating!),
    if (reason != null) 'reason': turnFeedbackReasonWire(reason!),
    if (comment != null) 'comment': comment,
    if (feedbackId != null) 'feedbackId': feedbackId,
    'provider': ?provider,
    'model': ?model,
    'chatMode': ?chatMode,
    'appVersion': ?appVersion,
    'eventType': ?eventType,
  };

  /// Returns null for anything unrecognized, so one bad row cannot take the
  /// whole queue down with it.
  static FeedbackOutboxEntry? fromJson(Object? value) {
    if (value is! Map) return null;
    final messageId = value['clientUserMessageId'];
    final chatId = value['clientChatId'];
    final queuedAt = value['queuedAtMs'];
    if (messageId is! String || chatId is! String || queuedAt is! int) {
      return null;
    }
    final kind = switch (value['kind']) {
      'rate' => FeedbackOutboxKind.rate,
      'clear' => FeedbackOutboxKind.clear,
      'detail' => FeedbackOutboxKind.detail,
      _ => null,
    };
    if (kind == null) return null;
    final accountId = value['accountId'];
    // A row written before `seq` existed decodes to 0 — older than every
    // sequence this run will issue, which is exactly what it is.
    final seq = value['seq'];
    final comment = value['comment'];
    final feedbackId = value['feedbackId'];
    final provider = value['provider'];
    final model = value['model'];
    final chatMode = value['chatMode'];
    final appVersion = value['appVersion'];
    final eventType = value['eventType'];
    return FeedbackOutboxEntry(
      kind: kind,
      clientUserMessageId: messageId,
      clientChatId: chatId,
      queuedAtMs: queuedAt,
      seq: seq is int ? seq : 0,
      accountId: accountId is String ? accountId : null,
      rating: turnFeedbackRatingFromWire(value['rating']),
      reason: turnFeedbackReasonFromWire(value['reason']),
      comment: comment is String ? comment : null,
      feedbackId: feedbackId is String ? feedbackId : null,
      provider: provider is String ? provider : null,
      model: model is String ? model : null,
      chatMode: chatMode is String ? chatMode : null,
      appVersion: appVersion is String ? appVersion : null,
      eventType: eventType is String ? eventType : null,
    );
  }
}

/// Replaces any existing entry for the same turn UNDER THE SAME ACCOUNT. A
/// turn has exactly one desired end state per account; a second queued rating
/// supersedes the first rather than replaying both. Another account's entry
/// for the same turn id is left alone — it is that account's pending feedback,
/// not this one's, and dropping it here would be the same silent loss the
/// outbox exists to prevent.
List<FeedbackOutboxEntry> upsertFeedbackOutbox(
  List<FeedbackOutboxEntry> entries,
  FeedbackOutboxEntry next,
) => <FeedbackOutboxEntry>[
  ...entries.where(
    (entry) =>
        entry.clientUserMessageId != next.clientUserMessageId ||
        entry.accountId != next.accountId,
  ),
  next,
];

/// Drops entries older than [feedbackOutboxMaxAge], then keeps the newest
/// [feedbackOutboxMaxEntries]. An unbounded queue on a device that has been
/// offline for a month is a storage leak, not durability.
///
/// Both bounds are deliberately global rather than per-account: they exist to
/// cap what one device stores, and a per-account cap would let N signed-out
/// accounts hold N times as much.
/// The two bounds deliberately read different fields, matching the split
/// documented on [FeedbackOutboxEntry.queuedAtMs] and
/// [FeedbackOutboxEntry.seq]: the AGE cutoff is wall time (14 days is a
/// calendar span), while the count cap orders entries against each other and
/// so uses the monotonic sequence. A device whose clock jumped backwards
/// would otherwise drop its newest entries first.
List<FeedbackOutboxEntry> pruneFeedbackOutbox(
  List<FeedbackOutboxEntry> entries, {
  required int nowMs,
}) {
  final cutoff = nowMs - feedbackOutboxMaxAge.inMilliseconds;
  final fresh = entries.where((entry) => entry.queuedAtMs >= cutoff).toList()
    ..sort((a, b) {
      final bySeq = b.seq.compareTo(a.seq);
      // Only reachable between rows that predate `seq` (both 0), where wall
      // time is the only ordering left.
      return bySeq != 0 ? bySeq : b.queuedAtMs.compareTo(a.queuedAtMs);
    });
  if (fresh.length <= feedbackOutboxMaxEntries) return fresh;
  return fresh.sublist(0, feedbackOutboxMaxEntries);
}

abstract interface class FeedbackOutboxStore {
  Future<List<FeedbackOutboxEntry>> read();

  /// Throws if nothing was persisted. Callers in
  /// `turn_feedback_repository.dart` treat a throw as "not stored" and degrade
  /// accordingly — reporting the write as `dropped` rather than claiming a
  /// durable queue — so a store that fails SILENTLY is strictly worse than one
  /// that throws: it makes that degradation unreachable.
  Future<void> write(List<FeedbackOutboxEntry> entries);
}

final class SharedPrefsFeedbackOutboxStore implements FeedbackOutboxStore {
  static const String _key = 'canopy.feedback_outbox';

  @override
  Future<List<FeedbackOutboxEntry>> read() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    if (raw == null) return const <FeedbackOutboxEntry>[];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return const <FeedbackOutboxEntry>[];
      if (decoded['version'] != feedbackOutboxVersion) {
        return const <FeedbackOutboxEntry>[];
      }
      final entries = decoded['entries'];
      if (entries is! List) return const <FeedbackOutboxEntry>[];
      return entries
          .map(FeedbackOutboxEntry.fromJson)
          .whereType<FeedbackOutboxEntry>()
          .toList(growable: false);
    } on FormatException {
      // Corrupt file: start empty rather than wedging every later write.
      return const <FeedbackOutboxEntry>[];
    }
  }

  @override
  Future<void> write(List<FeedbackOutboxEntry> entries) async {
    final prefs = await SharedPreferences.getInstance();
    final stored = await prefs.setString(
      _key,
      jsonEncode(<String, dynamic>{
        'version': feedbackOutboxVersion,
        'entries': entries.map((entry) => entry.toJson()).toList(),
      }),
    );
    // `setString` reports whether the value actually reached disk — on Android
    // this is `Editor.commit()`'s result — and it is the only failure signal
    // the platform gives us. Discarding it defeated the whole degradation
    // contract above: the repository would report the write as durably queued
    // while nothing had been persisted.
    //
    // Silence is not the safe direction here. `SharedPreferences._setValue`
    // populates its in-memory `_preferenceCache` BEFORE calling the store and
    // regardless of the result, so a rejected write keeps satisfying reads for
    // the rest of the session; the loss surfaces only at next launch, with the
    // thumb still selected and the user's typed comment gone.
    if (!stored) throw const FeedbackOutboxWriteFailure();
  }
}

/// Raised when the platform accepted a [FeedbackOutboxStore.write] call but
/// reported that nothing was persisted.
///
/// Deliberately a distinct type rather than a bare [Exception] so a caller can
/// tell "the store said no" from an arbitrary error escaping the store, and so
/// the throw reads as the contract it is rather than an accident.
final class FeedbackOutboxWriteFailure implements Exception {
  const FeedbackOutboxWriteFailure();

  @override
  String toString() =>
      'FeedbackOutboxWriteFailure: the feedback outbox was not persisted';
}

final class InMemoryFeedbackOutboxStore implements FeedbackOutboxStore {
  List<FeedbackOutboxEntry> _entries = const <FeedbackOutboxEntry>[];

  @override
  Future<List<FeedbackOutboxEntry>> read() async => _entries;

  @override
  Future<void> write(List<FeedbackOutboxEntry> entries) async {
    _entries = List<FeedbackOutboxEntry>.unmodifiable(entries);
  }
}

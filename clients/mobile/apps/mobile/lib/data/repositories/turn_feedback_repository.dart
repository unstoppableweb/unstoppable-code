import 'dart:async';

import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/feedback_outbox_store.dart';
import 'package:mobile/data/services/turn_feedback_api_service.dart';

/// Denormalized technical context stored alongside a rating so the warehouse
/// can slice it without joining a transcript row.
///
/// [eventType] must be one of the server's closed `TELEMETRY_EVENT_TYPES`
/// values — the same value desktop sends for the chat's scope
/// (`eventTypeForTarget` in the desktop turn-feedback slice). The server
/// silently drops anything it does not recognize, so an unknown scope omits
/// it rather than inventing a mobile-specific value.
final class TurnFeedbackContext {
  const TurnFeedbackContext({
    this.provider,
    this.model,
    this.chatMode,
    this.appVersion,
    this.eventType,
  });

  final String? provider;
  final String? model;
  final String? chatMode;
  final String? appVersion;
  final String? eventType;
}

/// Outcome of a write — a rating, a detail, or a retraction.
///
/// `synced: false` on its own means the operation is durably QUEUED, not
/// lost: the caller keeps its optimistic state. [dropped] means it was
/// refused outright (a 4xx other than 401, 408 or 429) or could not be
/// queued, so nothing will ever retry it and the caller rolls back.
final class TurnFeedbackWriteResult {
  const TurnFeedbackWriteResult({
    required this.synced,
    this.feedbackId,
    this.dropped = false,
  });

  final bool synced;
  final String? feedbackId;
  final bool dropped;
}

/// A rating that reached the server for the first time during an outbox
/// flush, with the `feedbackId` the server answered with. Without it the
/// caller could never retract a rating it queued offline.
final class TurnFeedbackReplayedRating {
  const TurnFeedbackReplayedRating({
    required this.clientChatId,
    required this.clientUserMessageId,
    required this.feedbackId,
  });

  final String clientChatId;
  final String clientUserMessageId;
  final String feedbackId;
}

/// Raised when the signed-in account changed between a write being opened and
/// its request reaching the wire. Retryable: the entry stays queued for the
/// account that authored it.
final class TurnFeedbackAccountChanged implements Exception {
  const TurnFeedbackAccountChanged();

  @override
  String toString() =>
      'TurnFeedbackAccountChanged: the signed-in account changed before the '
      'request was sent';
}

/// A request the server refused for good: a 4xx other than 401 (the session
/// may come back), 408 or 429 (transient by definition). Retrying it would
/// fail identically and block the queue.
bool isRejectedTurnFeedbackRequest(Object error) =>
    error is ApiException &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode != 401 &&
    error.statusCode != 408 &&
    error.statusCode != 429;

abstract interface class TurnFeedbackRepository {
  Future<List<TurnFeedbackSummary>> listForChat(String clientChatId);

  /// The signed-in account's still-queued entries for one chat, oldest
  /// first. Hydration lets these win over the server's list.
  Future<List<FeedbackOutboxEntry>> pendingForChat(String clientChatId);

  Future<TurnFeedbackWriteResult> rate({
    required String clientUserMessageId,
    required String clientChatId,
    required TurnFeedbackRating rating,
    required TurnFeedbackContext context,
  });

  Future<TurnFeedbackWriteResult> attachDetail({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
    TurnFeedbackReason? reason,
    String? comment,
  });

  Future<TurnFeedbackWriteResult> clear({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
  });

  /// Replays the signed-in account's queued entries in order.
  Future<List<TurnFeedbackReplayedRating>> flushOutbox();
}

typedef _TurnKey = (String account, String clientUserMessageId);

/// The networked repository and its durable outbox.
///
/// Rules:
///
/// - Every entry carries the environment-qualified account that queued it
///   ([FeedbackOutboxEntry.accountId]); only the signed-in account's entries
///   are read or sent. An entry without one belongs to nobody; the flush
///   discards it.
/// - One entry per `(account, turn)`: a newer action replaces the older one.
///   A detail merges into a still-queued rating. A retraction of a rating the
///   server never saw just removes the queued rating.
/// - Writes against one turn run one at a time (rate, then detail, then
///   clear), so a retraction can address the row a just-finished rating
///   created. Flushed entries take the same per-turn slot.
/// - The flush sends in queue order. A network failure stops it and keeps
///   everything left; a 5xx, 408 or 429 keeps that entry and moves on; any
///   other 4xx drops the entry; a 401 stops the flush and keeps everything.
///   Only one flush runs at a time.
final class HttpTurnFeedbackRepository implements TurnFeedbackRepository {
  HttpTurnFeedbackRepository({
    required this.service,
    required this.outbox,
    required this.accountScope,
    this.now = DateTime.now,
    this.requestTimeout = const Duration(seconds: 30),
    this.storeTimeout = const Duration(seconds: 5),
  });

  final TurnFeedbackApiService service;
  final FeedbackOutboxStore outbox;

  /// The signed-in account's environment-qualified scope
  /// (`<environment>:<userId>`), or null without an account. Read live.
  final String? Function() accountScope;

  /// Wall clock for [FeedbackOutboxEntry.queuedAtMs] and the age prune only;
  /// ordering uses the monotonic sequence.
  final DateTime Function() now;

  /// Bounds every request: `ApiClient` sets no timeout of its own.
  final Duration requestTimeout;

  /// Bounds every store touch, so a stalled platform channel degrades to a
  /// failed store instead of wedging every later write.
  final Duration storeTimeout;

  Future<void> _storeChain = Future<void>.value();
  final Map<_TurnKey, Future<void>> _turnChains = {};

  /// Server ids learned this session, so a retraction or detail can address
  /// a row whose id the caller has not seen yet. Bounded.
  final Map<_TurnKey, String> _knownIds = {};
  static const int _knownIdCapacity = 500;

  int _seq = 0;
  bool _flushing = false;

  Future<T> _locked<T>(Future<T> Function() action) {
    final result = _storeChain.then((_) => action());
    _storeChain = result.then((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  Future<T> _onTurn<T>(_TurnKey key, Future<T> Function() action) {
    final previous = _turnChains[key] ?? Future<void>.value();
    final result = previous.then((_) => action());
    final tail = result.then((_) {}, onError: (Object _, StackTrace _) {});
    _turnChains[key] = tail;
    unawaited(
      tail.then((_) {
        if (identical(_turnChains[key], tail)) _turnChains.remove(key);
      }),
    );
    return result;
  }

  Future<T> _bounded<T>(Future<T> Function() request) =>
      request().timeout(requestTimeout);

  /// Re-checks the account immediately before a write opens: the request
  /// carries the live session's bearer.
  Future<T> _send<T>(String account, Future<T> Function() request) {
    if (accountScope() != account) {
      return Future<T>.error(const TurnFeedbackAccountChanged());
    }
    return _bounded(request);
  }

  Future<List<FeedbackOutboxEntry>> _read() async {
    final entries = await outbox.read().timeout(storeTimeout);
    for (final entry in entries) {
      if (entry.seq > _seq) _seq = entry.seq;
    }
    return entries;
  }

  Future<void> _write(List<FeedbackOutboxEntry> entries) =>
      outbox.write(entries).timeout(storeTimeout);

  /// Applies [change] to the stored queue under the store lock. Returns
  /// false when the store failed; the write then reports itself dropped.
  Future<bool> _mutate(
    List<FeedbackOutboxEntry> Function(List<FeedbackOutboxEntry> entries)
    change,
  ) async {
    try {
      await _locked(() async {
        final entries = await _read();
        final next = pruneFeedbackOutbox(
          change(entries),
          nowMs: now().millisecondsSinceEpoch,
        );
        await _write(next);
      });
      return true;
    } on Object catch (_) {
      return false;
    }
  }

  /// A sequence above everything stored, including entries an earlier run
  /// queued (this counter restarts at zero with the process).
  Future<int> _issueSeq() async {
    try {
      await _locked(_read);
    } on Object catch (_) {
      // A failed read leaves the counter where it was.
    }
    return ++_seq;
  }

  void _remember(_TurnKey key, String feedbackId) {
    _knownIds.remove(key);
    _knownIds[key] = feedbackId;
    if (_knownIds.length > _knownIdCapacity) {
      _knownIds.remove(_knownIds.keys.first);
    }
  }

  bool _isTurn(FeedbackOutboxEntry entry, _TurnKey key) =>
      entry.accountId == key.$1 && entry.clientUserMessageId == key.$2;

  /// Removes this turn's entries queued before [seq] (the write that just
  /// reached the server supersedes them). Entries queued while the request
  /// was in flight are newer and stay.
  Future<void> _settle(_TurnKey key, int seq) async {
    await _mutate(
      (entries) => [
        for (final entry in entries)
          if (!_isTurn(entry, key) || entry.seq > seq) entry,
      ],
    );
  }

  Future<bool> _enqueue(
    _TurnKey key,
    FeedbackOutboxEntry Function(FeedbackOutboxEntry? existing, int seq)
    build, {
    bool Function(FeedbackOutboxEntry? existing)? refuse,
  }) async {
    var queued = false;
    final stored = await _mutate((entries) {
      final existing = entries.where((e) => _isTurn(e, key)).lastOrNull;
      if (refuse != null && refuse(existing)) return entries;
      queued = true;
      return upsertFeedbackOutbox(entries, build(existing, ++_seq));
    });
    return stored && queued;
  }

  @override
  Future<List<TurnFeedbackSummary>> listForChat(String clientChatId) =>
      _bounded(() => service.listForChat(clientChatId));

  @override
  Future<List<FeedbackOutboxEntry>> pendingForChat(String clientChatId) async {
    final account = accountScope();
    if (account == null) return const [];
    try {
      final entries = await _locked(_read);
      return [
        for (final entry in entries)
          if (entry.accountId == account && entry.clientChatId == clientChatId)
            entry,
      ]..sort((a, b) => a.seq.compareTo(b.seq));
    } on Object catch (_) {
      return const [];
    }
  }

  @override
  Future<TurnFeedbackWriteResult> rate({
    required String clientUserMessageId,
    required String clientChatId,
    required TurnFeedbackRating rating,
    required TurnFeedbackContext context,
  }) async {
    final account = accountScope();
    if (account == null) {
      return const TurnFeedbackWriteResult(synced: false, dropped: true);
    }
    final key = (account, clientUserMessageId);
    return _onTurn(key, () async {
      final seq = await _issueSeq();
      try {
        final summary = await _send(
          account,
          () => service.rate(
            clientUserMessageId: clientUserMessageId,
            clientChatId: clientChatId,
            rating: rating,
            provider: context.provider,
            model: context.model,
            chatMode: context.chatMode,
            appVersion: context.appVersion,
            eventType: context.eventType,
          ),
        );
        _remember(key, summary.feedbackId);
        await _settle(key, seq);
        return TurnFeedbackWriteResult(
          synced: true,
          feedbackId: summary.feedbackId,
        );
      } on Object catch (error) {
        // A FormatException means the server accepted the rating but its id
        // was unreadable; the queued replay is an idempotent upsert that
        // recovers it.
        if (isRejectedTurnFeedbackRequest(error)) {
          return const TurnFeedbackWriteResult(synced: false, dropped: true);
        }
        final queued = await _enqueue(
          key,
          (_, seq) => FeedbackOutboxEntry(
            kind: FeedbackOutboxKind.rate,
            clientUserMessageId: clientUserMessageId,
            clientChatId: clientChatId,
            accountId: account,
            rating: rating,
            provider: context.provider,
            model: context.model,
            chatMode: context.chatMode,
            appVersion: context.appVersion,
            eventType: context.eventType,
            queuedAtMs: now().millisecondsSinceEpoch,
            seq: seq,
          ),
        );
        return TurnFeedbackWriteResult(synced: false, dropped: !queued);
      }
    });
  }

  @override
  Future<TurnFeedbackWriteResult> attachDetail({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
    TurnFeedbackReason? reason,
    String? comment,
  }) async {
    final account = accountScope();
    if (account == null) {
      return const TurnFeedbackWriteResult(synced: false, dropped: true);
    }
    final key = (account, clientUserMessageId);
    return _onTurn(key, () async {
      final id = feedbackId ?? _knownIds[key];
      if (id != null) {
        try {
          await _send(
            account,
            () => service.attachDetail(
              feedbackId: id,
              reason: reason,
              comment: comment,
            ),
          );
          return const TurnFeedbackWriteResult(synced: true);
        } on FormatException {
          // The PATCH landed; only its body was unreadable.
          return const TurnFeedbackWriteResult(synced: true);
        } on Object catch (error) {
          if (isRejectedTurnFeedbackRequest(error)) {
            return const TurnFeedbackWriteResult(synced: false, dropped: true);
          }
        }
      }
      // Merge into a queued rating; otherwise queue a detail for a row whose
      // id is known. A queued retraction, or nothing to attach to, refuses.
      final queued = await _enqueue(
        key,
        (existing, seq) => switch (existing) {
          final FeedbackOutboxEntry rate
              when rate.kind == FeedbackOutboxKind.rate =>
            FeedbackOutboxEntry(
              kind: FeedbackOutboxKind.rate,
              clientUserMessageId: rate.clientUserMessageId,
              clientChatId: rate.clientChatId,
              accountId: account,
              rating: rate.rating,
              reason: reason,
              comment: comment,
              provider: rate.provider,
              model: rate.model,
              chatMode: rate.chatMode,
              appVersion: rate.appVersion,
              eventType: rate.eventType,
              queuedAtMs: rate.queuedAtMs,
              seq: seq,
            ),
          _ => FeedbackOutboxEntry(
            kind: FeedbackOutboxKind.detail,
            clientUserMessageId: clientUserMessageId,
            clientChatId: clientChatId,
            accountId: account,
            feedbackId: id,
            reason: reason,
            comment: comment,
            queuedAtMs: now().millisecondsSinceEpoch,
            seq: seq,
          ),
        },
        refuse: (existing) =>
            existing?.kind == FeedbackOutboxKind.clear ||
            (existing?.kind != FeedbackOutboxKind.rate && id == null),
      );
      return TurnFeedbackWriteResult(synced: false, dropped: !queued);
    });
  }

  @override
  Future<TurnFeedbackWriteResult> clear({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
  }) async {
    final account = accountScope();
    if (account == null) {
      return const TurnFeedbackWriteResult(synced: false, dropped: true);
    }
    final key = (account, clientUserMessageId);
    return _onTurn(key, () async {
      final id = feedbackId ?? _knownIds[key];
      if (id == null) {
        // The server holds no row this phone knows of: dropping the queued
        // rating (and any detail riding on it) is the whole retraction.
        final stored = await _mutate(
          (entries) => [
            for (final entry in entries)
              if (!_isTurn(entry, key) ||
                  entry.kind == FeedbackOutboxKind.clear)
                entry,
          ],
        );
        // A failed write leaves the queued rating to replay; report it
        // dropped so the thumb is restored rather than claiming a retraction.
        return stored
            ? const TurnFeedbackWriteResult(synced: true)
            : const TurnFeedbackWriteResult(synced: false, dropped: true);
      }
      final seq = await _issueSeq();
      try {
        await _send(account, () => service.clear(id));
      } on Object catch (error) {
        // 404: the row is already gone, which is what a retraction wants.
        final gone = error is ApiException && error.statusCode == 404;
        if (!gone) {
          if (isRejectedTurnFeedbackRequest(error)) {
            return const TurnFeedbackWriteResult(synced: false, dropped: true);
          }
          final queued = await _enqueue(
            key,
            (_, seq) => FeedbackOutboxEntry(
              kind: FeedbackOutboxKind.clear,
              clientUserMessageId: clientUserMessageId,
              clientChatId: clientChatId,
              accountId: account,
              feedbackId: id,
              queuedAtMs: now().millisecondsSinceEpoch,
              seq: seq,
            ),
          );
          return TurnFeedbackWriteResult(synced: false, dropped: !queued);
        }
      }
      _knownIds.remove(key);
      await _settle(key, seq);
      return const TurnFeedbackWriteResult(synced: true);
    });
  }

  @override
  Future<List<TurnFeedbackReplayedRating>> flushOutbox() async {
    final replayed = <TurnFeedbackReplayedRating>[];
    final account = accountScope();
    if (account == null || _flushing) return replayed;
    _flushing = true;
    try {
      final List<FeedbackOutboxEntry> snapshot;
      try {
        snapshot = await _locked(_read);
      } on Object catch (_) {
        return replayed;
      }
      // An entry with no account belongs to nobody and can never be sent.
      if (snapshot.any((entry) => entry.accountId == null)) {
        await _mutate(
          (entries) => [
            for (final entry in entries)
              if (entry.accountId != null) entry,
          ],
        );
      }
      final mine = [
        for (final entry in snapshot)
          if (entry.accountId == account) entry,
      ]..sort((a, b) => a.seq.compareTo(b.seq));
      for (final entry in mine) {
        if (accountScope() != account) break;
        final outcome = await _onTurn((
          account,
          entry.clientUserMessageId,
        ), () => _replay(account, entry, replayed));
        if (outcome == _ReplayOutcome.stop) break;
      }
    } finally {
      _flushing = false;
    }
    return replayed;
  }

  /// Sends one queued entry, unless a newer write for its turn replaced it
  /// while the flush waited for the turn's slot.
  Future<_ReplayOutcome> _replay(
    String account,
    FeedbackOutboxEntry entry,
    List<TurnFeedbackReplayedRating> replayed,
  ) async {
    final key = (account, entry.clientUserMessageId);
    bool same(FeedbackOutboxEntry other) =>
        _isTurn(other, key) && other.seq == entry.seq;
    try {
      final current = await _locked(_read);
      if (!current.any(same)) return _ReplayOutcome.next;
    } on Object catch (_) {
      return _ReplayOutcome.stop;
    }
    // The entry to store in place of this one, when part of it landed.
    FeedbackOutboxEntry? remainder;
    try {
      switch (entry.kind) {
        case FeedbackOutboxKind.rate:
          final rating = entry.rating;
          if (rating != null) {
            final summary = await _send(
              account,
              () => service.rate(
                clientUserMessageId: entry.clientUserMessageId,
                clientChatId: entry.clientChatId,
                rating: rating,
                provider: entry.provider,
                model: entry.model,
                chatMode: entry.chatMode,
                appVersion: entry.appVersion,
                eventType: entry.eventType,
              ),
            );
            _remember(key, summary.feedbackId);
            replayed.add(
              TurnFeedbackReplayedRating(
                clientChatId: entry.clientChatId,
                clientUserMessageId: entry.clientUserMessageId,
                feedbackId: summary.feedbackId,
              ),
            );
            if (entry.reason != null || entry.comment != null) {
              remainder = FeedbackOutboxEntry(
                kind: FeedbackOutboxKind.detail,
                clientUserMessageId: entry.clientUserMessageId,
                clientChatId: entry.clientChatId,
                accountId: account,
                feedbackId: summary.feedbackId,
                reason: entry.reason,
                comment: entry.comment,
                queuedAtMs: entry.queuedAtMs,
                seq: entry.seq,
              );
              await _send(
                account,
                () => service.attachDetail(
                  feedbackId: summary.feedbackId,
                  reason: entry.reason,
                  comment: entry.comment,
                ),
              );
              remainder = null;
            }
          }
        case FeedbackOutboxKind.clear:
          final id = entry.feedbackId;
          if (id != null) {
            try {
              await _send(account, () => service.clear(id));
            } on ApiException catch (error) {
              if (error.statusCode != 404) rethrow;
            }
            _knownIds.remove(key);
          }
        case FeedbackOutboxKind.detail:
          final id = entry.feedbackId;
          if (id != null) {
            await _send(
              account,
              () => service.attachDetail(
                feedbackId: id,
                reason: entry.reason,
                comment: entry.comment,
              ),
            );
          }
      }
      await _replace(same, null);
      return _ReplayOutcome.next;
    } on FormatException {
      // Accepted by the server; resending would not change the body.
      await _replace(same, null);
      return _ReplayOutcome.next;
    } on ApiException catch (error) {
      if (error.statusCode == 401) {
        if (remainder != null) await _replace(same, remainder);
        return _ReplayOutcome.stop;
      }
      if (isRejectedTurnFeedbackRequest(error)) {
        await _replace(same, null);
        return _ReplayOutcome.next;
      }
      if (remainder != null) await _replace(same, remainder);
      return _ReplayOutcome.next;
    } on Object catch (_) {
      // Offline, timed out, or the account changed: keep it and stop.
      if (remainder != null) await _replace(same, remainder);
      return _ReplayOutcome.stop;
    }
  }

  Future<void> _replace(
    bool Function(FeedbackOutboxEntry entry) same,
    FeedbackOutboxEntry? replacement,
  ) => _mutate(
    (entries) => [
      for (final entry in entries)
        if (!same(entry)) entry else ?replacement,
    ],
  );
}

enum _ReplayOutcome { next, stop }

/// In-memory repository for mock mode and builds without API config.
class MockTurnFeedbackRepository implements TurnFeedbackRepository {
  MockTurnFeedbackRepository();

  final Map<String, Map<String, TurnFeedbackSummary>> _rows = {};
  int _nextId = 1;

  @override
  Future<List<TurnFeedbackSummary>> listForChat(String clientChatId) async =>
      (_rows[clientChatId] ?? const {}).values.toList(growable: false);

  @override
  Future<List<FeedbackOutboxEntry>> pendingForChat(String clientChatId) async =>
      const [];

  @override
  Future<TurnFeedbackWriteResult> rate({
    required String clientUserMessageId,
    required String clientChatId,
    required TurnFeedbackRating rating,
    required TurnFeedbackContext context,
  }) async {
    final id = 'mock-fb-${_nextId++}';
    _rows.putIfAbsent(
      clientChatId,
      () => {},
    )[clientUserMessageId] = TurnFeedbackSummary(
      feedbackId: id,
      clientUserMessageId: clientUserMessageId,
      rating: rating,
      hasComment: false,
    );
    return TurnFeedbackWriteResult(synced: true, feedbackId: id);
  }

  @override
  Future<TurnFeedbackWriteResult> attachDetail({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
    TurnFeedbackReason? reason,
    String? comment,
  }) async => const TurnFeedbackWriteResult(synced: true);

  @override
  Future<TurnFeedbackWriteResult> clear({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
  }) async {
    _rows[clientChatId]?.remove(clientUserMessageId);
    return const TurnFeedbackWriteResult(synced: true);
  }

  @override
  Future<List<TurnFeedbackReplayedRating>> flushOutbox() async => const [];
}

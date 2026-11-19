import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/feedback_outbox_store.dart';

/// Per-chat turn rating state for a chat transcript. Transport-neutral: it
/// knows chat ids and turn keys, not which host the chat lives on.
///
/// Writes are optimistic: the thumb selects on tap and settles to `synced` or
/// `failed` when the repository answers. A `failed` (queued) rating keeps its
/// selection, because it will still land. A dropped write was refused outright
/// and is rolled back.
///
/// Hydration precedence, highest first: a queued outbox entry, a rating the
/// user set after the server read was sent, the server's list, then the seed
/// the host supplies (a desktop tab's persisted `turnFeedback`). A local write
/// made after the read was sent also outranks a queued entry, because it is
/// the newer intent.
final class TurnFeedbackController extends ChangeNotifier {
  TurnFeedbackController({required this.repository});

  final TurnFeedbackRepository repository;

  final Map<String, Map<String, TurnFeedbackEntry>> _byChat = {};

  /// Open chats, counted, so a late server read for a chat that closed is
  /// discarded.
  final Map<String, int> _attached = {};

  /// Open chats whose server list has been applied since they were opened.
  final Set<String> _hydrated = {};
  final Set<String> _hydrating = {};

  /// Synced seeds shown while a chat's server list was still on its way.
  /// Only these can be contradicted by that list: a synced seed first seen
  /// after it (a rating made on desktop since) is newer than the read.
  final Map<String, Set<_SeedKey>> _seedsBeforeRead = {};

  /// Synced seeds the chat's last server list contradicted (cleared
  /// elsewhere). Kept across a reopen, so they stay hidden while it re-reads.
  final Map<String, Set<_SeedKey>> _contradictedSeeds = {};

  /// Bumped by [resetHydration], so work started under a previous account
  /// cannot touch the next account's state.
  int _generation = 0;

  /// Monotonic stamp for local writes. Each write records its stamp, so
  /// hydration can tell a rating set after its read was sent, and a settling
  /// write can tell whether a newer one replaced it.
  int _clock = 0;
  final Map<(String, String), ({int stamp, int generation})> _writes = {};
  static const int writeCapacity = 500;

  bool _disposed = false;

  /// The controller's own entry for a turn, without the host seed.
  TurnFeedbackEntry? entryFor(String chatId, String clientUserMessageId) =>
      _byChat[chatId]?[clientUserMessageId];

  /// What a turn's thumbs show: the controller's entry, else the host
  /// [seed]'s, unless this account already wrote the turn (a cleared
  /// rating stays cleared) or the server list, which outranks a synced seed
  /// shown before it arrived, was applied without it.
  TurnFeedbackEntry? resolve(
    String chatId,
    String clientUserMessageId,
    Map<String, TurnFeedbackEntry> seed,
  ) {
    final own = entryFor(chatId, clientUserMessageId);
    if (own != null) return own;
    if (_writes[(chatId, clientUserMessageId)]?.generation == _generation) {
      return null;
    }
    final seeded = seed[clientUserMessageId];
    if (seeded == null) return null;
    if (seeded.syncState != TurnFeedbackSyncState.synced) return seeded;
    final key = (
      turn: clientUserMessageId,
      feedbackId: seeded.feedbackId,
      rating: seeded.rating,
    );
    final contradicted = _contradictedSeeds[chatId]?.contains(key) ?? false;
    if (!_hydrated.contains(chatId)) {
      // Recorded while building, without notifying: the read this seed
      // preceded decides whether it is contradicted.
      _seedsBeforeRead.putIfAbsent(chatId, () => {}).add(key);
    }
    return contradicted ? null : seeded;
  }

  /// Marks [chatId] open and pulls its ratings each time it opens, so a
  /// rating changed elsewhere while it was closed shows. Never notifies
  /// synchronously, so a widget may call it while building.
  void attach(String chatId) {
    final count = _attached[chatId] ?? 0;
    _attached[chatId] = count + 1;
    if (count == 0) _hydrated.remove(chatId);
    unawaited(_hydrate(chatId));
  }

  void detach(String chatId) {
    final count = (_attached[chatId] ?? 0) - 1;
    if (count <= 0) {
      _attached.remove(chatId);
    } else {
      _attached[chatId] = count;
    }
  }

  /// Clears cached ratings when the signed-in account changes, and re-reads
  /// any chat still open.
  void resetHydration() {
    _generation++;
    _byChat.clear();
    _hydrated.clear();
    _hydrating.clear();
    _seedsBeforeRead.clear();
    _contradictedSeeds.clear();
    _notify();
    for (final chatId in _attached.keys.toList()) {
      unawaited(_hydrate(chatId));
    }
  }

  bool _writtenSince(String chatId, String turn, int stamp) {
    final write = _writes[(chatId, turn)];
    return write != null &&
        write.generation == _generation &&
        write.stamp > stamp;
  }

  Future<void> _hydrate(String chatId) async {
    if (_hydrated.contains(chatId) || _hydrating.contains(chatId)) return;
    _hydrating.add(chatId);
    final generation = _generation;
    final sentAt = _clock;
    List<TurnFeedbackSummary>? server;
    try {
      server = await repository.listForChat(chatId);
    } on Object catch (_) {
      // A failed read keeps the seed and shows no error; the next open
      // retries.
      server = null;
    }
    List<FeedbackOutboxEntry> pending;
    try {
      pending = await repository.pendingForChat(chatId);
    } on Object catch (_) {
      // An unreadable outbox must not hide the server's ratings; its queued
      // entries still flush, and the next open reads it again.
      pending = const [];
    }
    if (_disposed || generation != _generation) return;
    _hydrating.remove(chatId);
    if (!_attached.containsKey(chatId)) return;

    final chat = _byChat.putIfAbsent(chatId, () => {});
    if (server != null) {
      _hydrated.add(chatId);
      final onServer = {for (final row in server) row.clientUserMessageId};
      _contradictedSeeds[chatId] = {
        for (final key in _seedsBeforeRead.remove(chatId) ?? <_SeedKey>{})
          if (!onServer.contains(key.turn)) key,
      };
      chat.removeWhere(
        (turn, entry) =>
            !onServer.contains(turn) &&
            entry.syncState == TurnFeedbackSyncState.synced &&
            !_writtenSince(chatId, turn, sentAt),
      );
      for (final row in server) {
        if (_writtenSince(chatId, row.clientUserMessageId, sentAt)) continue;
        chat[row.clientUserMessageId] = TurnFeedbackEntry.fromSummary(row);
      }
    }
    for (final entry in pending) {
      final turn = entry.clientUserMessageId;
      if (_writtenSince(chatId, turn, sentAt)) continue;
      final current = chat[turn];
      switch (entry.kind) {
        case FeedbackOutboxKind.rate:
          final rating = entry.rating;
          if (rating == null) continue;
          chat[turn] = TurnFeedbackEntry(
            rating: rating,
            syncState: TurnFeedbackSyncState.failed,
            feedbackId: current?.feedbackId,
            reason: entry.reason,
          );
        case FeedbackOutboxKind.clear:
          chat.remove(turn);
          // Keeps a synced seed for this turn from showing.
          _stamp(chatId, turn);
        case FeedbackOutboxKind.detail:
          if (current != null && entry.reason != null) {
            chat[turn] = current.copyWith(reason: entry.reason);
          }
      }
    }
    _notify();
  }

  int _stamp(String chatId, String turn) {
    final stamp = ++_clock;
    final key = (chatId, turn);
    // Re-inserted so insertion order is least-recently-written first.
    _writes.remove(key);
    _writes[key] = (stamp: stamp, generation: _generation);
    while (_writes.length > writeCapacity) {
      _writes.remove(_writes.keys.first);
    }
    return stamp;
  }

  bool _isLatest(String chatId, String turn, int stamp) =>
      _writes[(chatId, turn)]?.stamp == stamp;

  /// Records (or, with a null [rating], retracts) one turn's rating.
  /// [fallback] is the entry the user saw when the controller had none of its
  /// own (the host seed), so a retraction can still address its row.
  ///
  /// Returns whether the write stands: false when it was dropped (and rolled
  /// back) or a newer write for the same turn replaced it.
  Future<bool> setRating({
    required String chatId,
    required String clientUserMessageId,
    required TurnFeedbackRating? rating,
    TurnFeedbackContext context = const TurnFeedbackContext(),
    TurnFeedbackEntry? fallback,
  }) async {
    final chat = _byChat.putIfAbsent(chatId, () => {});
    final existing = chat[clientUserMessageId] ?? fallback;
    final generation = _generation;
    final stamp = _stamp(chatId, clientUserMessageId);

    if (rating == null) {
      chat.remove(clientUserMessageId);
      _notify();
      final result = await repository.clear(
        clientUserMessageId: clientUserMessageId,
        clientChatId: chatId,
        feedbackId: existing?.feedbackId,
      );
      if (generation != _generation ||
          !_isLatest(chatId, clientUserMessageId, stamp)) {
        return false;
      }
      if (!result.synced && result.dropped) {
        if (existing != null) {
          _byChat.putIfAbsent(chatId, () => {})[clientUserMessageId] = existing;
          _notify();
        }
        return false;
      }
      return true;
    }

    chat[clientUserMessageId] = TurnFeedbackEntry(
      rating: rating,
      syncState: TurnFeedbackSyncState.pending,
      feedbackId: existing?.feedbackId,
    );
    _notify();

    final result = await repository.rate(
      clientUserMessageId: clientUserMessageId,
      clientChatId: chatId,
      rating: rating,
      context: context,
    );
    if (generation != _generation ||
        !_isLatest(chatId, clientUserMessageId, stamp)) {
      return false;
    }
    final current = _byChat[chatId];
    if (current == null) return false;
    if (!result.synced && result.dropped) {
      if (existing == null) {
        current.remove(clientUserMessageId);
      } else {
        current[clientUserMessageId] = existing;
      }
      _notify();
      return false;
    }
    final optimistic = current[clientUserMessageId];
    if (optimistic == null) return false;
    current[clientUserMessageId] = optimistic.copyWith(
      syncState: result.synced
          ? TurnFeedbackSyncState.synced
          : TurnFeedbackSyncState.failed,
      feedbackId: result.feedbackId,
    );
    _notify();
    return true;
  }

  /// Attaches a reason and/or comment to one turn's rating. Returns whether
  /// the detail stands (synced or queued); a dropped detail rolls back its
  /// optimistic reason.
  Future<bool> submitDetail({
    required String chatId,
    required String clientUserMessageId,
    TurnFeedbackReason? reason,
    String? comment,
  }) async {
    final chat = _byChat[chatId];
    final existing = chat?[clientUserMessageId];
    TurnFeedbackEntry? optimistic;
    if (chat != null && existing != null && reason != null) {
      optimistic = existing.copyWith(reason: reason);
      chat[clientUserMessageId] = optimistic;
      _notify();
    }
    final result = await repository.attachDetail(
      clientUserMessageId: clientUserMessageId,
      clientChatId: chatId,
      feedbackId: existing?.feedbackId,
      reason: reason,
      comment: comment,
    );
    if (result.synced || !result.dropped) return true;
    if (chat == null || existing == null || optimistic == null) return false;
    if (!identical(chat[clientUserMessageId], optimistic)) return false;
    chat[clientUserMessageId] = existing;
    _notify();
    return false;
  }

  /// Replays the outbox and adopts the server id of every rating it created,
  /// so a later retraction can address the row.
  Future<void> flushOutbox() async {
    final generation = _generation;
    final List<TurnFeedbackReplayedRating> replayed;
    try {
      replayed = await repository.flushOutbox();
    } on Object catch (_) {
      return;
    }
    if (replayed.isEmpty || generation != _generation) return;
    var applied = false;
    for (final rating in replayed) {
      final chat = _byChat[rating.clientChatId];
      final existing = chat?[rating.clientUserMessageId];
      if (chat == null || existing == null) continue;
      if (existing.feedbackId == rating.feedbackId) continue;
      chat[rating.clientUserMessageId] = existing.copyWith(
        feedbackId: rating.feedbackId,
        syncState: existing.syncState == TurnFeedbackSyncState.failed
            ? TurnFeedbackSyncState.synced
            : null,
      );
      applied = true;
    }
    if (applied) _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

typedef _SeedKey = ({
  String turn,
  String? feedbackId,
  TurnFeedbackRating rating,
});

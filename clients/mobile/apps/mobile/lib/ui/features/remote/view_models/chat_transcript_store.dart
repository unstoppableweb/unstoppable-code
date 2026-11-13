import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/transcript_list.dart';
import 'package:mobile/data/models/chat_turn_liveness.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';

import 'remote_identity.dart';
import 'user_message_index.dart';

/// Reads one page of older transcript history for a chat.
typedef RemoteChatHistoryFetch =
    Future<RemoteChatHistoryChunk> Function(
      RemoteChatTarget target, {
      String? before,
    });

/// Resolves an incoming bare chat id against the session as [snapshot] saw
/// it. Null when the chat is unknown or ambiguous.
typedef RemoteChatResolver =
    RemoteChatKey? Function(
      RemoteSessionSnapshot? snapshot,
      String chatId,
      RemoteChatScope? scope,
    );

/// Where a cached chat tail came from, staler first. Both are provisional:
/// live rows and the desktop's snapshot always win over them.
enum RemoteCachedTailSource {
  /// Persisted on this device by an earlier visit (CAN-3373).
  device,

  /// The server's cached projection (CAN-3369).
  server,
}

/// Transcript rows the session reducer hands to the transcript store, in
/// order.
sealed class RemoteTranscriptUpdate {
  const RemoteTranscriptUpdate();
}

/// A chat-targeted snapshot's transcript window for [chat].
final class AuthoritativeTranscriptUpdate extends RemoteTranscriptUpdate {
  const AuthoritativeTranscriptUpdate({
    required this.chat,
    required this.rows,
    required this.truncated,
  });

  final RemoteChatKey chat;

  /// The snapshot's rows for [chat], in desktop order.
  final List<RemoteChatMessage> rows;

  /// Whether [rows] is a bounded tail rather than the whole transcript.
  final bool truncated;
}

/// A live chat event's row, resolved to its chat by the event's own chat id
/// and scope when it merges.
final class LiveChatMessageUpdate extends RemoteTranscriptUpdate {
  const LiveChatMessageUpdate({
    required this.chatId,
    required this.scope,
    required this.message,
    required this.keySnapshot,
  });

  final String chatId;
  final RemoteChatScope? scope;
  final RemoteChatMessage message;
  final RemoteSessionSnapshot? keySnapshot;
}

/// Rows to merge one at a time. Each row's chat is resolved when it merges,
/// against [keySnapshot] — the session as the reducer saw it at this point
/// of the step — so rows cannot resolve through summaries that arrived later
/// in the same event.
final class IncomingChatRowsUpdate extends RemoteTranscriptUpdate {
  const IncomingChatRowsUpdate({
    required this.rows,
    required this.keySnapshot,
    this.fallbackScope,
    this.authoritativeSnapshot = false,
    this.preserveCacheProvenance = false,
  });

  final List<RemoteChatMessage> rows;
  final RemoteSessionSnapshot? keySnapshot;

  /// Scope for rows that carry none.
  final RemoteChatScope? fallbackScope;

  /// The rows come from a full snapshot read. See
  /// `ChatTranscriptStore.newerMessage`.
  final bool authoritativeSnapshot;

  /// The rows are provisional and must not clear cache-seeded provenance.
  final bool preserveCacheProvenance;
}

final class _PendingSend {
  _PendingSend(this.message, this.wasPreviouslyShown, this.previousMessageIds);

  final RemoteChatMessage message;
  final bool Function(String) wasPreviouslyShown;
  final Set<String> previousMessageIds;
}

/// Per-chat transcripts: the desktop-projected rows plus this device's
/// optimistic sends awaiting their echo.
///
/// The facade routes rows here from live chat events and from the session
/// reducer's snapshot effects. The ordering rules hold for every path: a new
/// row lands by its stable position, an existing row never moves, stale
/// revisions never rewind a newer one, and a terminal row is never reopened
/// by a late streaming revision.
final class ChatTranscriptStore {
  ChatTranscriptStore({
    required this.notify,
    required this.isConnected,
    required this.fetchHistory,
    required this.onEvidence,
    required this.onTranscriptChanged,
  });

  final void Function() notify;
  final bool Function() isConnected;

  /// Reads older history for [loadOlderMessages].
  final RemoteChatHistoryFetch fetchHistory;

  /// Called with every projected row before it is merged, so a caller can
  /// treat it as turn evidence without this store knowing why.
  final void Function(RemoteChatKey key, RemoteChatMessage message) onEvidence;

  /// Called whenever [key]'s transcript changes, so a caller can persist it.
  final void Function(RemoteChatKey key) onTranscriptChanged;

  final Map<RemoteChatKey, TranscriptBuffer<RemoteChatMessage>> _transcripts =
      {};
  final Map<RemoteChatKey, UserMessageIndex> _userIds = {};
  final Map<RemoteChatKey, List<_PendingSend>> _pendingSends = {};

  /// Live revisions use a session-wide mark so foreground requests can take
  /// a baseline before the desktop tells us which chat they will return.
  int _liveMark = 0;
  final Map<RemoteChatKey, Map<String, int>> _liveRowMarks = {};

  int get liveMark => _liveMark;

  /// Rows seeded from the server's cached chat tail that no live event has
  /// replaced since, compared by identity. They predate the authoritative
  /// snapshot, so the snapshot drops any it no longer carries rather than
  /// keeping them as live rows that raced it.
  final Map<RemoteChatKey, Set<RemoteChatMessage>> _cacheSeededRows = {};

  /// Where each chat's cache-seeded rows came from.
  final Map<RemoteChatKey, RemoteCachedTailSource> _cacheSources = {};

  /// Device-seeded rows that still show the revision persisted on this
  /// device, by identity. The server's copy of one is fresher whatever the
  /// timestamps say; see [_serverRevisionOf].
  final Map<RemoteChatKey, Set<RemoteChatMessage>> _deviceRevisions = {};

  /// Chats that received the desktop's snapshot or a server history page
  /// this session, so their rows are no longer only provisional.
  final Set<RemoteChatKey> _authoritativeChats = {};

  /// Older-history pagination (`POST .../chat/history`): the opaque `before`
  /// cursor per chat. An entry recorded as null means the transcript start
  /// was reached — `before: null` must never be re-sent after the first page
  /// (it means "newest historical page" and would re-fetch loaded turns).
  final Map<RemoteChatKey, String?> _chatHistoryCursors = {};

  /// Single-flight guard for [loadOlderMessages].
  final Set<RemoteChatKey> _loadingOlderMessages = {};

  /// The first row of the history page merged last per chat: an older page
  /// ends just before it.
  final Map<RemoteChatKey, String> _historyHeads = {};

  /// Bumped when a chat's older history is discarded and its cursor reset,
  /// so a page read against the discarded history cannot land in front of
  /// the rows that replaced it.
  final Map<RemoteChatKey, int> _historyGenerations = {};

  /// Per-chat change counter, bumped by every write that changes what a
  /// chat's transcript shows: its rows, its optimistic sends, and its
  /// older-history flag. Lets a caller notice that one chat changed without
  /// diffing its rows.
  final Map<RemoteChatKey, int> _revisions = {};

  /// The list [messagesFor] last returned per chat, dropped by every write
  /// that bumps the chat's revision. A chat whose transcript has not changed
  /// hands every caller the same list, so its consumers can skip work on
  /// identity alone.
  final Map<RemoteChatKey, List<RemoteChatMessage>> _published = {};

  /// Replaced on [reset], so a history page read for a discarded session
  /// cannot write into the next one.
  Object _session = Object();

  /// The transcript for [target]: authoritative messages followed by any
  /// optimistic sends still awaiting their desktop echo. Unmodifiable, and
  /// the same list until the chat's transcript changes.
  List<RemoteChatMessage> messagesFor(RemoteChatTarget target) {
    final key = remoteChatKeyForTarget(target);
    if (key == null) return const [];
    return _published[key] ??= JoinedTranscript(
      _transcripts[key]?.snapshot ?? const <RemoteChatMessage>[],
      _pendingSends[key]?.map((send) => send.message) ?? const [],
    );
  }

  /// Immutable desktop-projected rows without optimistic sends.
  List<RemoteChatMessage> projectedRows(RemoteChatKey key) =>
      _transcripts[key]?.snapshot ?? const <RemoteChatMessage>[];

  void _reindexUsers(RemoteChatKey key) {
    (_userIds[key] ??= UserMessageIndex()).replace(
      (_transcripts[key] ?? const <RemoteChatMessage>[])
          .where((row) => row.role == ChatRole.user)
          .map((row) => row.messageId),
    );
  }

  /// Whether desktop-projected rows are cached for [key].
  bool hasTranscript(RemoteChatKey key) =>
      _transcripts[key]?.isNotEmpty == true;

  /// Whether [key] received the desktop's snapshot or a server history page
  /// this session.
  bool hasAuthoritativeRows(RemoteChatKey key) =>
      _authoritativeChats.contains(key);

  /// Chats with projected rows or optimistic sends, for resolving the scope
  /// of an incoming bare chat id.
  Iterable<RemoteChatKey> get chatKeys => {
    ..._transcripts.keys,
    ..._pendingSends.keys,
  };

  /// The first projected row in [scope] that satisfies [test].
  RemoteChatMessage? findProjectedRow(
    RemoteChatScope scope,
    bool Function(RemoteChatMessage message) test,
  ) {
    for (final MapEntry(:key, :value) in _transcripts.entries) {
      if (key.scope != scope) continue;
      for (final message in value) {
        if (test(message)) return message;
      }
    }
    return null;
  }

  /// Whether the latest turn is running, without publishing a transcript list
  /// for the tab-strip spinners. Tool rows retain their own execution status.
  bool isStreamingForChat(RemoteChatTarget target) {
    final key = remoteChatKeyForTarget(target);
    if (key == null) return false;
    // Pending sends are appended for display, not positioned in the host turn.
    return isChatTurnRunning(
          _transcripts[key] ?? const <RemoteChatMessage>[],
        ) ||
        (_pendingSends[key]?.any((send) => send.message.isStreaming) ?? false);
  }

  /// The current change count for [key]'s transcript; see [_revisions].
  int revisionFor(RemoteChatKey key) => _revisions[key] ?? 0;

  void _touch(RemoteChatKey key) {
    _revisions[key] = revisionFor(key) + 1;
    _published.remove(key);
    onTranscriptChanged(key);
  }

  /// Shows [message] as an optimistic send until its echo retires it.
  void addPendingSend(RemoteChatKey key, RemoteChatMessage message) {
    _pendingSends
        .putIfAbsent(key, () => [])
        .add(
          _PendingSend(
            message,
            (_userIds[key] ??= UserMessageIndex()).capture(),
            {
              for (final send in _pendingSends[key] ?? const <_PendingSend>[])
                send.message.messageId,
            },
          ),
        );
    _touch(key);
  }

  /// Retracts an optimistic send. False when its echo already retired it.
  bool removePendingSend(RemoteChatKey key, RemoteChatMessage message) {
    final pending = _pendingSends[key];
    final before = pending?.length ?? 0;
    pending?.removeWhere((send) => identical(send.message, message));
    final removed = (pending?.length ?? 0) != before;
    if (removed) _touch(key);
    return removed;
  }

  /// Retracts only the optimistic send with [messageId], if it still exists.
  bool removePendingSendById(RemoteChatKey key, String messageId) {
    final pending = _pendingSends[key];
    if (pending == null) return false;
    final before = pending.length;
    pending.removeWhere((send) => send.message.messageId == messageId);
    if (pending.length == before) return false;
    _touch(key);
    return true;
  }

  /// Merges a reducer step's rows, resolving bare chat ids through
  /// [resolveChat]. Returns whether any row merged.
  bool applyUpdate(
    RemoteTranscriptUpdate update, {
    required RemoteChatResolver resolveChat,
    int? snapshotBaseline,
  }) {
    switch (update) {
      case AuthoritativeTranscriptUpdate(
        :final chat,
        :final rows,
        :final truncated,
      ):
        replaceAuthoritative(
          chat,
          rows,
          truncated: truncated,
          baseline: snapshotBaseline,
        );
        return true;
      case LiveChatMessageUpdate(
        :final chatId,
        :final scope,
        :final message,
        :final keySnapshot,
      ):
        final key = resolveChat(keySnapshot, chatId, scope ?? message.scope);
        if (key == null) return false;
        ingest(key, message);
        return true;
      case IncomingChatRowsUpdate(
        :final rows,
        :final keySnapshot,
        :final fallbackScope,
        :final authoritativeSnapshot,
        :final preserveCacheProvenance,
      ):
        var changed = false;
        for (final message in rows) {
          final key = resolveChat(
            keySnapshot,
            message.chatId,
            message.scope ?? fallbackScope,
          );
          if (key == null) continue;
          ingest(
            key,
            message,
            authoritativeSnapshot: authoritativeSnapshot,
            preserveCacheProvenance: preserveCacheProvenance,
            live: false,
          );
          changed = true;
        }
        return changed;
    }
  }

  /// Merges one projected row: retires the optimistic send it echoes, keeps
  /// that send's attachments when they describe the same files, and upserts.
  void ingest(
    RemoteChatKey key,
    RemoteChatMessage message, {
    bool authoritativeSnapshot = false,
    bool preserveCacheProvenance = false,
    bool live = true,
  }) {
    final retired = consumeMatchedPending(key, message, live: live);
    upsert(
      key,
      retainPendingAttachments(message, retired),
      authoritativeSnapshot: authoritativeSnapshot,
      preserveCacheProvenance: preserveCacheProvenance,
      live: live,
    );
  }

  void upsert(
    RemoteChatKey key,
    RemoteChatMessage message, {
    bool authoritativeSnapshot = false,
    bool preserveCacheProvenance = false,
    bool live = true,
  }) {
    if (key.chatId.isEmpty || message.messageId.isEmpty) return;
    onEvidence(key, message);
    final transcript = _transcripts.putIfAbsent(key, () => TranscriptBuffer());
    final index = transcript.indexWhere(
      (m) => m.messageId == message.messageId,
    );
    if (index == -1) {
      // Live delivery can beat the history read containing its user prompt.
      // Insert only new rows by host time; updates never move an existing row
      // (timer/tool frames change their timestamps as the turn progresses).
      final occurredAt = message.positionAt;
      final insertAt = occurredAt == null
          ? -1
          : transcript.indexWhere(
              (row) => row.positionAt?.isAfter(occurredAt) == true,
            );
      transcript.insert(insertAt < 0 ? transcript.length : insertAt, message);
      if (message.role == ChatRole.user) {
        (_userIds[key] ??= UserMessageIndex()).add(message.messageId);
      }
      if (live) _markLiveRow(key, message.messageId);
      _touch(key);
    } else {
      final cached = transcript[index];
      transcript[index] = newerMessage(
        cached,
        message,
        authoritativeSnapshot: authoritativeSnapshot,
      );
      if (!identical(transcript[index], cached)) {
        if (cached.role != transcript[index].role) _reindexUsers(key);
        if (live) _markLiveRow(key, message.messageId);
        _touch(key);
      }
      // Generic snapshots are provisional. If one replaces a cache-seeded
      // object, keep its provenance until the chat-scoped snapshot reconciles.
      final seeded = _cacheSeededRows[key];
      if (preserveCacheProvenance && seeded?.remove(cached) == true) {
        seeded!.add(transcript[index]);
      }
    }
  }

  void _markLiveRow(RemoteChatKey key, String messageId) {
    (_liveRowMarks[key] ??= {})[messageId] = ++_liveMark;
  }

  /// Applies a chat-targeted snapshot's transcript window for [key]. [rows]
  /// are the snapshot's rows for this chat, in desktop order.
  ///
  /// A full window replaces the transcript, so desktop order holds and stale
  /// rows drop; optimistic sends stay separate. A [truncated] tail keeps the
  /// cached history before it and any live rows that raced it. A request
  /// [baseline] also protects later live rows from a full window.
  void replaceAuthoritative(
    RemoteChatKey key,
    List<RemoteChatMessage> rows, {
    required bool truncated,
    int? baseline,
  }) {
    final cachedById = {
      for (final message in _transcripts[key] ?? <RemoteChatMessage>[])
        message.messageId: message,
    };
    var authoritative = <RemoteChatMessage>[];
    final marks = _liveRowMarks[key] ?? const <String, int>{};
    bool changedSinceRequest(String id) =>
        baseline != null && (marks[id] ?? 0) > baseline;
    for (final message in rows) {
      final cached = cachedById[message.messageId];
      // A snapshot can prove completion, or carry an explicitly newer
      // revision. Otherwise a post-request live revision wins over history
      // whose creation time says nothing about its content's freshness.
      final completesLiveRow =
          cached?.isStreaming == true && _isTerminal(message);
      final cachedAt = cached?.updatedAt ?? cached?.occurredAt;
      final newerRevision =
          cachedAt != null && message.updatedAt?.isAfter(cachedAt) == true;
      final retained =
          changedSinceRequest(message.messageId) &&
              !completesLiveRow &&
              !newerRevision
          ? cached
          : null;
      onEvidence(key, retained ?? message);
      final retired = consumeMatchedPending(key, message, live: false);
      authoritative.add(
        retained ??
            newerMessage(
              cachedById[message.messageId],
              retainPendingAttachments(message, retired),
              authoritativeSnapshot: true,
            ),
      );
    }
    // Full snapshots keep rows changed after this request, anchored before
    // the next surviving desktop row. Truncated tails merge against their
    // original window below, keeping older cached rows in place.
    if (baseline != null && !truncated) {
      final included = {for (final row in authoritative) row.messageId};
      final cached = _transcripts[key] ?? const <RemoteChatMessage>[];
      final before = <String?, List<RemoteChatMessage>>{};
      String? anchor;
      for (final row in cached.reversed) {
        if (included.contains(row.messageId)) {
          anchor = row.messageId;
        } else if (changedSinceRequest(row.messageId)) {
          (before[anchor] ??= []).add(row);
        }
      }
      authoritative = [
        for (final row in authoritative) ...[
          ...?before[row.messageId]?.reversed,
          row,
        ],
        ...?before[null]?.reversed,
      ];
    }
    _transcripts[key] = TranscriptBuffer(
      truncated ? _mergeTruncatedTail(key, authoritative) : authoritative,
    );
    _reindexUsers(key);
    _cacheSeededRows.remove(key);
    _cacheSources.remove(key);
    _deviceRevisions.remove(key);
    final shown = {for (final row in _transcripts[key]!) row.messageId};
    _liveRowMarks[key]?.removeWhere((id, _) => !shown.contains(id));
    _authoritativeChats.add(key);
    _touch(key);
  }

  /// A bounded tail can race live rows that were emitted after the snapshot
  /// was assembled. Keeps cached history before the first overlapping tail
  /// row, preserves the authoritative desktop order, then appends unmatched
  /// live rows that followed that overlap.
  List<RemoteChatMessage> _mergeTruncatedTail(
    RemoteChatKey key,
    List<RemoteChatMessage> authoritative,
  ) {
    final authoritativeIds = authoritative
        .map((message) => message.messageId)
        .toSet();
    final seeded = _cacheSeededRows[key] ?? const <RemoteChatMessage>{};
    final cached = _transcripts[key] ?? const <RemoteChatMessage>[];
    // Cache-seeded rows the snapshot does not carry drop. Rows kept in front
    // of one would be cut off from the snapshot by a hole that history
    // pagination never fills, since it continues before the oldest row. So
    // they drop too, and paging restarts from the newest page to refetch
    // them in place.
    final cachedPrefix = <RemoteChatMessage>[];
    var discardedHistory = false;
    void dropSeeded() {
      discardedHistory = discardedHistory || cachedPrefix.isNotEmpty;
      cachedPrefix.clear();
    }

    final firstOverlapIndex = cached.indexWhere(
      (message) => authoritativeIds.contains(message.messageId),
    );
    if (firstOverlapIndex >= 0) {
      for (final message in cached.take(firstOverlapIndex)) {
        if (seeded.contains(message)) {
          dropSeeded();
        } else {
          cachedPrefix.add(message);
        }
      }
      if (discardedHistory) _discardOlderHistory(key);
      return [
        ...cachedPrefix,
        ...authoritative,
        ...cached
            .skip(firstOverlapIndex + 1)
            .where(
              (message) =>
                  !authoritativeIds.contains(message.messageId) &&
                  !seeded.contains(message),
            ),
      ];
    }
    // With no shared id, use the timestamps supplied by desktop to
    // distinguish cached history from rows emitted after the snapshot.
    // Unknown timestamps stay in the prefix to preserve legacy data. A cached
    // tail never does: nothing proves it adjoins the snapshot, and history
    // pagination restores what precedes the snapshot without a gap.
    final firstAuthoritativeAt = authoritative
        .map((message) => message.occurredAt)
        .whereType<DateTime>()
        .firstOrNull;
    final liveSuffix = <RemoteChatMessage>[];
    for (final message in cached) {
      final occurredAt = message.occurredAt;
      final afterSnapshot =
          firstAuthoritativeAt != null &&
          occurredAt != null &&
          occurredAt.isAfter(firstAuthoritativeAt);
      if (seeded.contains(message)) {
        if (!afterSnapshot) dropSeeded();
      } else if (afterSnapshot) {
        liveSuffix.add(message);
      } else {
        cachedPrefix.add(message);
      }
    }
    if (discardedHistory) _discardOlderHistory(key);
    return [...cachedPrefix, ...authoritative, ...liveSuffix];
  }

  /// Forgets [key]'s history cursor, so the next older page is the newest
  /// one again, and retires any page still in flight.
  void _discardOlderHistory(RemoteChatKey key) {
    _chatHistoryCursors.remove(key);
    _historyHeads.remove(key);
    _historyGenerations[key] = (_historyGenerations[key] ?? 0) + 1;
  }

  /// Whether a cached tail from [source] may paint [key] now: the chat shows
  /// nothing yet, or only rows seeded from a staler cache. Live rows, an
  /// authoritative snapshot, and optimistic sends are never overwritten.
  ///
  /// A device tail also seeds under live rows and optimistic sends that
  /// arrived first, e.g. for a chat still streaming on the desktop; see
  /// [seedFromCache]. The first server tail can also seed under live timers:
  /// completion can arrive before an agent-created tab is ever opened.
  bool acceptsCachedTail(RemoteChatKey key, RemoteCachedTailSource source) {
    if (source == RemoteCachedTailSource.device) {
      return !_cacheSources.containsKey(key) &&
          !_authoritativeChats.contains(key);
    }
    if (_pendingSends[key]?.isNotEmpty == true) return false;
    if (_hasOnlyUncachedTimers(key)) return true;
    final rows = _transcripts[key];
    if (rows == null || rows.isEmpty) return true;
    final seeded = _cacheSeededRows[key];
    final seededFrom = _cacheSources[key];
    return seeded != null &&
        seededFrom != null &&
        seededFrom.index < source.index &&
        rows.every(seeded.contains);
  }

  bool _hasOnlyUncachedTimers(RemoteChatKey key) {
    if (_cacheSources.containsKey(key) || _authoritativeChats.contains(key)) {
      return false;
    }
    final rows = _transcripts[key];
    return rows != null &&
        rows.isNotEmpty &&
        rows.every(
          (row) =>
              row.role == ChatRole.system &&
              row.text.trim().isEmpty &&
              row.attachments.isEmpty &&
              row.parts.isNotEmpty &&
              row.parts.every((part) => part.kind == 'turn_timer'),
        );
  }

  /// Paints a cached tail while the chat's transcript hydrates; returns
  /// whether it did. The rows predate the authoritative snapshot, which drops
  /// any it no longer carries. A fresher cache replaces a staler one's rows,
  /// and an empty cache is never taken for an empty chat.
  bool seedFromCache(
    RemoteChatKey key,
    List<RemoteChatMessage> rows, {
    RemoteCachedTailSource source = RemoteCachedTailSource.server,
  }) {
    if (rows.isEmpty || !acceptsCachedTail(key, source)) return false;
    if (source == RemoteCachedTailSource.device ||
        _hasOnlyUncachedTimers(key)) {
      return _seedInitialTail(key, rows, source: source);
    }
    // The server orders its tail by creation time, which timer revisions
    // move, so a row the staler tail shows keeps its place and anchor, as
    // upsert keeps any row it already shows, and takes the server's content
    // over a device revision. The staler tail's other rows drop.
    final ids = {for (final message in rows) message.messageId};
    _transcripts[key]?.removeWhere(
      (message) => !ids.contains(message.messageId),
    );
    final transcript = _transcripts.putIfAbsent(key, () => TranscriptBuffer());
    final deviceRevisions =
        _deviceRevisions.remove(key) ?? const <RemoteChatMessage>{};
    for (final message in rows) {
      final index = transcript.indexWhere(
        (row) =>
            row.messageId == message.messageId && deviceRevisions.contains(row),
      );
      if (index < 0) {
        upsert(key, message, live: false);
        continue;
      }
      onEvidence(key, message);
      transcript[index] = _serverRevisionOf(transcript[index], message);
    }
    _cacheSeededRows[key] = Set.identity()..addAll(transcript);
    _cacheSources[key] = source;
    _reindexUsers(key);
    _touch(key);
    return true;
  }

  /// Inserts an initial cached tail's [rows] that [key] does not show yet, as
  /// provisional rows, in their stored order: the tail was persisted in
  /// transcript order, and timer revisions move a row's creation time, so
  /// its timestamps do not give that order. An empty transcript takes the
  /// tail as stored.
  ///
  /// Live rows and optimistic sends that arrived first keep their places
  /// and every id they share with the tail. A tail row goes after the tail
  /// rows before it and before the next one the transcript shows; between
  /// those, before the first live row positioned after it or undated.
  bool _seedInitialTail(
    RemoteChatKey key,
    List<RemoteChatMessage> rows, {
    required RemoteCachedTailSource source,
  }) {
    final transcript = <RemoteChatMessage>[...?_transcripts[key]];
    final live = {for (final message in transcript) message.messageId};
    final shown = {
      ...live,
      for (final send in _pendingSends[key] ?? const <_PendingSend>[])
        send.message.messageId,
    };
    final seeded = Set<RemoteChatMessage>.identity();
    // Rows from here on precede no earlier tail row, so stored order holds.
    var floor = 0;
    for (final (i, message) in rows.indexed) {
      final id = message.messageId;
      if (id.isEmpty) continue;
      if (!shown.add(id)) {
        if (live.contains(id)) {
          final index = transcript.indexWhere(
            (row) => row.messageId == id,
            floor,
          );
          if (index >= 0) floor = index + 1;
          continue;
        }
        // A duplicate tail row keeps the first one's place, as upsert would.
        final index = transcript.indexWhere(
          (row) => row.messageId == id && seeded.contains(row),
        );
        if (index < 0) continue;
        onEvidence(key, message);
        seeded.remove(transcript[index]);
        transcript[index] = newerMessage(transcript[index], message);
        seeded.add(transcript[index]);
        continue;
      }
      final limit = _nextLiveRow(transcript, live, rows, i + 1, floor);
      final at = message.positionAt;
      var index = at == null
          ? floor
          : transcript.indexWhere(
              (row) => row.positionAt?.isAfter(at) ?? true,
              floor,
            );
      if (index < 0 || index > limit) index = limit;
      onEvidence(key, message);
      transcript.insert(index, message);
      seeded.add(message);
      floor = index + 1;
    }
    if (seeded.isEmpty) return false;
    _transcripts[key] = TranscriptBuffer(transcript);
    _reindexUsers(key);
    _cacheSeededRows[key] = seeded;
    _cacheSources[key] = source;
    if (source == RemoteCachedTailSource.device) {
      _deviceRevisions[key] = Set.identity()..addAll(seeded);
    }
    _touch(key);
    return true;
  }

  /// The index in [transcript], from [floor] on, of the first of [rows]
  /// after [from] that a [live] row shows; the end when there is none.
  static int _nextLiveRow(
    List<RemoteChatMessage> transcript,
    Set<String> live,
    List<RemoteChatMessage> rows,
    int from,
    int floor,
  ) {
    for (final message in rows.skip(from)) {
      if (!live.contains(message.messageId)) continue;
      final index = transcript.indexWhere(
        (row) => row.messageId == message.messageId,
        floor,
      );
      if (index >= 0) return index;
    }
    return transcript.length;
  }

  /// Replayed events and delayed history must not undo a newer live revision.
  /// Equal/unknown timestamps must also never reopen a terminal message.
  static RemoteChatMessage newerMessage(
    RemoteChatMessage? cached,
    RemoteChatMessage incoming, {
    bool authoritativeSnapshot = false,
  }) {
    if (cached == null) return incoming;
    incoming = incoming.withOrderingAt(cached.positionAt);
    if (_isTerminal(cached) && incoming.isStreaming) return cached;
    // Persisted chat history can retain only the original creation time.
    // That time cannot be compared with a live patch's revision time, so let
    // the targeted history snapshot correct missed live content/parts.
    if (authoritativeSnapshot && incoming.updatedAt == null) {
      return incoming.withUpdatedAt(cached.updatedAt);
    }
    final cachedAt = cached.updatedAt ?? cached.occurredAt;
    final incomingAt = incoming.updatedAt ?? incoming.occurredAt;
    if (cachedAt != null && incomingAt != null) {
      if (incomingAt.isBefore(cachedAt)) return cached;
      if (incomingAt.isAfter(cachedAt)) return incoming;
    }
    return incoming;
  }

  /// The server's copy of a row that still shows its [device] revision. A
  /// server row carries only its creation time, which the device revision's
  /// update time can pass, so the server's content wins without comparing
  /// them. The row keeps its place and the later known revision time, so an
  /// older live revision cannot replace it, and a terminal row is never
  /// reopened.
  static RemoteChatMessage _serverRevisionOf(
    RemoteChatMessage device,
    RemoteChatMessage server,
  ) {
    if (_isTerminal(device) && server.isStreaming) return device;
    final deviceAt = device.updatedAt;
    final serverAt = server.updatedAt;
    final revisedAt = deviceAt == null || serverAt?.isAfter(deviceAt) == true
        ? serverAt
        : deviceAt;
    return server.withOrderingAt(device.positionAt).withUpdatedAt(revisedAt);
  }

  static bool _isTerminal(RemoteChatMessage message) =>
      message.status == ChatMessageStatus.complete ||
      message.status == ChatMessageStatus.failed ||
      message.status == ChatMessageStatus.cancelled;

  /// Drops the matching optimistic send once the desktop echoes a user
  /// message, so the bubble is not duplicated. New clients pre-allocate the
  /// wire message id; matching text remains a fallback for legacy echoes.
  /// Returns the retired bubble so the caller can pass it to
  /// [retainPendingAttachments].
  RemoteChatMessage? consumeMatchedPending(
    RemoteChatKey key,
    RemoteChatMessage message, {
    bool live = true,
  }) {
    if (message.role != ChatRole.user) return null;
    final pending = _pendingSends[key];
    if (pending == null || pending.isEmpty) return null;
    var index = pending.indexWhere(
      (send) => send.message.messageId == message.messageId,
    );
    if (index == -1) {
      index = pending.indexWhere((send) {
        if (send.wasPreviouslyShown(message.messageId) ||
            send.previousMessageIds.contains(message.messageId)) {
          return false;
        }
        final sentAt = send.message.occurredAt;
        final echoedAt = message.occurredAt;
        // Legacy hosts timestamp echoes on the desktop, while optimistic
        // sends use the phone clock. Allow up to a minute of clock skew,
        // while still excluding older history and every previously seen id.
        if (sentAt != null &&
            echoedAt != null &&
            echoedAt.isBefore(sentAt.subtract(const Duration(minutes: 1)))) {
          return false;
        }
        // Undated historical rows cannot prove a legacy echo. A live row
        // can, provided it was not already present when this send started.
        if (!live && (sentAt == null || echoedAt == null)) return false;
        return send.message.text.trim() == message.text.trim();
      });
    }
    if (index == -1) return null;
    _touch(key);
    final retired = pending.removeAt(index).message;
    for (final send in pending) {
      send.previousMessageIds.add(message.messageId);
    }
    return retired;
  }

  /// The echoed row, carrying the retired optimistic bubble's attachments
  /// when they describe the same files. The desktop echo mints its own
  /// attachment ids (`path-<hash>`) and slugified lowercase filenames for the
  /// same upload and never reports size, so a same-count echo is treated as
  /// the same files and the user-chosen names/ids win; a differing count
  /// means the echo is authoritative (e.g. an older desktop that dropped
  /// attachments entirely, or a genuinely different set) and its list wins.
  static RemoteChatMessage retainPendingAttachments(
    RemoteChatMessage message,
    RemoteChatMessage? retired,
  ) {
    if (retired == null || retired.attachments.isEmpty) return message;
    if (message.attachments.isEmpty ||
        message.attachments.length == retired.attachments.length) {
      return message.withAttachments(retired.attachments);
    }
    return message;
  }

  /// True while an older-history page for [target] is in flight.
  bool isLoadingOlderMessages(RemoteChatTarget target) {
    final key = remoteChatKeyForTarget(target);
    return key != null && _loadingOlderMessages.contains(key);
  }

  /// True when [target] may still have older messages on the server. Unknown
  /// (never paged) counts as "may have" until a chunk reports the start.
  bool canLoadOlderMessages(RemoteChatTarget target) {
    if (!isConnected()) return false;
    final key = remoteChatKeyForTarget(target);
    if (key == null) return false;
    return !(_chatHistoryCursors.containsKey(key) &&
        _chatHistoryCursors[key] == null);
  }

  /// Loads the next-older transcript page for [target], adding messages the
  /// cached transcript does not already contain (dedupe by message id — the
  /// newest historical page overlaps the live tail by design). Transport
  /// failures leave the cursor untouched so the next trigger retries.
  Future<void> loadOlderMessages(RemoteChatTarget target) async {
    final key = remoteChatKeyForTarget(target);
    if (key == null || !canLoadOlderMessages(target)) return;
    if (!_loadingOlderMessages.add(key)) return;
    _touch(key);
    final session = _session;
    final generation = _historyGenerations[key];
    final before = _chatHistoryCursors[key];
    notify();
    try {
      final chunk = await fetchHistory(target, before: before);
      if (!identical(session, _session) || !isConnected()) return;
      if (_historyGenerations[key] != generation) return;
      // Merge a page in one working list rather than copying chunks once
      // per historical insertion. Publish one immutable buffer afterwards.
      final transcript = <RemoteChatMessage>[...?_transcripts[key]];
      final rows = [
        for (final message in chunk.messages)
          if (message.messageId.isNotEmpty) message,
      ];
      final end = rows.lastOrNull?.messageId;
      final endShown = transcript.any((m) => m.messageId == end);
      _mergeHistoryChunk(transcript, chunk.messages);
      _dropContradictedCachedRows(
        key,
        transcript,
        {for (final message in rows) message.messageId},
        newest: before == null,
        shownEnd: endShown ? end : null,
      );
      _confirmCachedRows(key, transcript, chunk.messages);
      _transcripts[key] = TranscriptBuffer(transcript);
      _reindexUsers(key);
      if (rows.firstOrNull case final head?) {
        _historyHeads[key] = head.messageId;
      }
      _authoritativeChats.add(key);
      _chatHistoryCursors[key] = chunk.nextCursor;
    } on RemoteControlException {
      // Best-effort; scrollback stays retryable on the next trigger.
    } finally {
      // A reset cleared this flag already, and a newer session may own it.
      if (identical(session, _session)) {
        _loadingOlderMessages.remove(key);
        _touch(key);
      }
      notify();
    }
  }

  /// Drops the cache-seeded rows that a history page with [pageIds]
  /// contradicts. A cached tail, from this device or the server's cache, can
  /// be far behind the server's history, and kept, such a row would show
  /// after newer server rows. Live rows and optimistic sends stay.
  ///
  /// The page is the server's history from its first row up to the page
  /// merged before it, so cached rows it does not carry in between are
  /// stale. The [newest] page ends the server's history: cached rows after
  /// it are newer only when it ends on a row the transcript showed before
  /// it, [shownEnd], and stay until the snapshot confirms or drops them.
  /// Nothing places a cached tail against a newest page that shares no row
  /// shown among the tail's rows, so the whole tail drops.
  void _dropContradictedCachedRows(
    RemoteChatKey key,
    List<RemoteChatMessage> transcript,
    Set<String> pageIds, {
    required bool newest,
    required String? shownEnd,
  }) {
    final seeded = _cacheSeededRows[key];
    if (seeded == null) return;
    bool inPage(RemoteChatMessage message) =>
        pageIds.contains(message.messageId);
    final first = transcript.indexWhere(inPage);
    final firstSeeded = transcript.indexWhere(seeded.contains);
    if (first < 0 || firstSeeded < 0) return;
    var from = first + 1;
    var to = transcript.length;
    if (newest) {
      final lastSeeded = transcript.lastIndexWhere(seeded.contains);
      if (!transcript.getRange(firstSeeded, lastSeeded + 1).any(inPage)) {
        from = 0;
      } else if (shownEnd != null) {
        to = transcript.indexWhere((message) => message.messageId == shownEnd);
      }
    } else {
      final head = _historyHeads[key];
      final headIndex = transcript.indexWhere(
        (message) => message.messageId == head,
      );
      if (headIndex >= 0) to = headIndex;
    }
    if (to <= from) return;
    final stale = Set<RemoteChatMessage>.identity()
      ..addAll(
        transcript
            .getRange(from, to)
            .where((message) => seeded.contains(message) && !inPage(message)),
      );
    if (stale.isEmpty) return;
    transcript.removeWhere(stale.contains);
    seeded.removeAll(stale);
    _deviceRevisions[key]?.removeAll(stale);
  }

  /// Cache-seeded rows that a history [page] also carries are confirmed by
  /// the server: they become history, which a bounded snapshot keeps rather
  /// than dropping as a provisional tail, and take the page's revision when
  /// it is newer, or always over a device revision.
  void _confirmCachedRows(
    RemoteChatKey key,
    List<RemoteChatMessage> transcript,
    List<RemoteChatMessage> page,
  ) {
    final seeded = _cacheSeededRows[key];
    if (seeded == null || seeded.isEmpty) return;
    final deviceRevisions = _deviceRevisions[key];
    final pageRows = {for (final message in page) message.messageId: message};
    for (var i = 0; i < transcript.length; i++) {
      final cached = transcript[i];
      final confirmed = pageRows[cached.messageId];
      if (confirmed == null || !seeded.remove(cached)) continue;
      transcript[i] = deviceRevisions?.remove(cached) == true
          ? _serverRevisionOf(cached, confirmed)
          : newerMessage(cached, confirmed);
    }
  }

  /// Adds the rows of a history [chunk] that [transcript] lacks, anchored to
  /// the chunk's own order. The newest page overlaps the live tail, and rows
  /// missed while the app was suspended sit between rows it already has, so
  /// only a chunk that shares no row with the transcript is purely older.
  static void _mergeHistoryChunk(
    List<RemoteChatMessage> transcript,
    List<RemoteChatMessage> chunk,
  ) {
    final known = {for (final message in transcript) message.messageId};
    final firstKnown = chunk
        .where((message) => known.contains(message.messageId))
        .firstOrNull;
    var insertAt = firstKnown == null
        ? 0
        : transcript.indexWhere((m) => m.messageId == firstKnown.messageId);
    for (final message in chunk) {
      if (message.messageId.isEmpty) continue;
      if (known.contains(message.messageId)) {
        insertAt =
            transcript.indexWhere((m) => m.messageId == message.messageId) + 1;
        continue;
      }
      known.add(message.messageId);
      transcript.insert(insertAt, message);
      insertAt += 1;
    }
  }

  /// Discards every transcript of the current session.
  void reset() {
    _session = Object();
    _transcripts.clear();
    _userIds.clear();
    _pendingSends.clear();
    _liveRowMarks.clear();
    _liveMark = 0;
    _cacheSeededRows.clear();
    _cacheSources.clear();
    _deviceRevisions.clear();
    _authoritativeChats.clear();
    _chatHistoryCursors.clear();
    _historyHeads.clear();
    _loadingOlderMessages.clear();
    _historyGenerations.clear();
    _revisions.clear();
    _published.clear();
  }

  void dispose() => reset();
}

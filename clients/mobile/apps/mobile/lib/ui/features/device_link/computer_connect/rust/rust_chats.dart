import 'dart:async';
import 'dart:convert';

import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/turn_timer.dart';
import 'package:mobile/device_link/chats/dto.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/reader.dart';
import 'package:mobile/device_link/chats/sender.dart';
import 'package:mobile/device_link/chats/state.dart';
import 'package:mobile/device_link/desktop/ipc.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/rust_core/failures.dart';
import 'package:mobile/device_link/rust_core/value_codec.dart';
import 'package:mobile/ui/core/chat/view_models/response_action_target.dart';
import 'package:mobile/ui/core/chat/view_models/step_runs.dart';
import 'package:mobile/ui/core/chat/view_models/tool_call_display.dart';
import 'package:mobile/ui/core/chat/view_models/transcript_projection.dart';
import 'package:mobile/ui/core/chat/view_models/turn_grouping.dart';

import '../chat_feed_model.dart';
import 'same_name.dart';
import 'view_revisions.dart';

/// How many chats the reader and its feed keep, to show a reopened chat at
/// once (the core's cache bound).
const _cachedChats = 20;

/// A desktop value in bridge form, as Dart's DTO reader holds it.
Object? _decode(String json) =>
    deviceChatDto(decodeRustValue(jsonDecode(json)));

Map<String, dynamic> _object(String json) =>
    _decode(json) as Map<String, dynamic>? ?? {};

/// What the Dart implementation throws for [failure].
Object chatFailure(core.ChatFailure failure) => switch (failure.kind) {
  core.ChatFailureKind.link => DeviceLinkException(failure.message),
  core.ChatFailureKind.refused => DesktopIpcRefusal(
    failure.message,
    code: failure.code,
  ),
  core.ChatFailureKind.notSent => DesktopIpcNotSent(failure.message),
  core.ChatFailureKind.creationNotSent => DeviceChatCreationNotSent(
    failure.message,
  ),
  core.ChatFailureKind.other => StateError(failure.message),
};

/// The chat read path of one computer on the core's [core.ChatsService]
/// (P5a). The core owns the selection, the chat states and their cache,
/// hydration, revision recovery, older pages, read receipts and the grouped
/// feed; this model applies its frames. Selection changes take effect here
/// at once (the generation is bumped before the first await, as Dart's
/// reader did) and the core's frames confirm them. [state] is the core's
/// desktop state of the selected chat, for the Dart features not yet
/// ported (sends, settings, activity, pipelines) to read.
///
final class RustChatReader implements DeviceChatReader {
  RustChatReader(this.service) {
    _frames = service.watch().listen(
      _apply,
      onError: _revisions.ended,
      onDone: _revisions.ended,
      cancelOnError: true,
    );
  }

  final core.ChatsService service;
  late final StreamSubscription<core.ChatFrame> _frames;
  final _updates = StreamController<void>.broadcast();
  @override
  Stream<void> get updates => _updates.stream;

  /// The selected chat's feed: it shows only rows built for [state]'s chat,
  /// so a selection that is ahead of the core's frames never shows the
  /// previous chat's rows.
  late final RustChatFeed feed = RustChatFeed(service, () => state?.ref.key);
  @override
  late final RustReadMarker readReceipts = RustReadMarker(service);

  core.ChatFrame? _frame;
  DeviceChatState? _state;

  /// What was last shown per chat (the core's cache bound), so an open
  /// shows a cached chat at once, as Dart's reader did, until its frame.
  final _seen =
      <String, ({DeviceChatState state, core.ComposerView? composer})>{};
  core.ComposerView? _composer;

  /// Whether the last frame's chat is [state]'s: false while a newly
  /// selected chat waits for its frame.
  bool get _framed => _state?.ref.key == state?.ref.key;

  /// [state]'s header: the last frame's, or what was last shown of a newly
  /// selected chat until its frame, never the previous chat's.
  core.ChatHeaderView? get header => state?.header;

  /// [state]'s composer as the core last sent it (P5c), as [header].
  core.ComposerView? get composer =>
      _framed ? _composer : _seen[state?.ref.key]?.composer;
  final _raw = <int, DeviceChatMessage>{};
  List<int> _order = const [];

  @override
  bool connected = false;
  int _generation = 0;
  @override
  int get selectionGeneration => _generation;
  String? _error;
  int _errorRevision = 0;
  bool _disposed = false;
  final _revisions = ViewRevisions(current: -1);

  /// What this model already did that no frame shows yet.
  ({DeviceChatState? state, bool loading, bool hydrating})? _ahead;
  bool get _behind => (_frame?.generation ?? -1) < _generation;

  @override
  DeviceChatState? get state =>
      _behind && _ahead != null ? _ahead!.state : _state;
  @override
  bool get loading =>
      _behind && _ahead != null ? _ahead!.loading : _frame?.loading ?? false;
  @override
  bool get hydrating => _behind && _ahead != null
      ? _ahead!.hydrating
      : _frame?.hydrating ?? false;
  @override
  bool get loadingOlder => !_behind && (_frame?.loadingOlder ?? false);
  @override
  bool get ready => connected && !_behind && (_frame?.ready ?? false);
  @override
  String? get error => _error;
  @override
  set error(String? value) => _error = value;

  void _notify() {
    if (!_disposed) _updates.add(null);
  }

  core.ChatRefView _ref(DeviceChatRef ref) => chatRefView(ref);

  /// [ref] as the core names it.
  static core.ChatRefView chatRefView(DeviceChatRef ref) => core.ChatRefView(
    projectId: ref.projectId,
    worktreeId: ref.worktreeId,
    id: ref.id,
    title: ref.title,
  );

  /// Waits for [intent]'s outcome and the frame that shows it; throws its
  /// failure as the Dart implementation would.
  Future<core.ChatSettled> settle(core.ChatIntent intent) async {
    if (_disposed) throw StateError('Chat reader disposed.');
    final core.ChatSettled settled;
    try {
      settled = await service.settled(ticket: service.request(intent: intent));
    } on core.CoreFailure catch (error) {
      throw rustFailure(error);
    }
    if (_disposed) throw StateError('Chat reader disposed.');
    await _revisions.wait(settled.revision);
    if (settled.failure case final failure?) throw chatFailure(failure);
    return settled;
  }

  Future<void> _request(core.ChatIntent intent) => settle(intent);

  /// The core's last frame (the writes read their part of it).
  core.ChatFrame? get frame => _frame;

  /// The computer's drafts by chat key, as the core holds them.
  final drafts = <String, String>{};

  /// The last draft write of this host the core applied.
  int draftSeq = 0;

  @override
  Future<void> setConnected(bool value) async {
    connected = value;
    if (!value) {
      _generation++;
      _ahead = (state: state, loading: false, hydrating: false);
      _notify();
    }
    service.send(
      intent: core.ChatIntent.setConnected(
        connected: value,
        generation: _generation,
      ),
    );
  }

  @override
  Future<bool> open(DeviceChatRef ref) async {
    if (connected) {
      _generation++;
      final current = state;
      _ahead = (
        state: current?.ref.key == ref.key
            ? current
            : _seen[ref.key]?.state ?? DeviceChatState(ref),
        loading: true,
        hydrating: true,
      );
      _error = null;
      _notify();
    }
    final generation = _generation;
    final settled = await settle(
      core.ChatIntent.open(chat: _ref(ref), generation: generation),
    );
    return !_disposed &&
        generation == _generation &&
        switch (settled.outcome) {
          core.ChatOutcome_Opened(selected: true) => true,
          _ => false,
        };
  }

  @override
  Future<void> refresh() async {
    final ref = state?.ref;
    if (ref != null) await open(ref);
  }

  @override
  Future<void> loadOlder() async {
    final current = state;
    if (current == null || current.before == null || !ready || loadingOlder) {
      return;
    }
    await _request(const core.ChatIntent.loadOlder());
  }

  @override
  Future<void> clearSelection({int? expectedGeneration}) async {
    if (expectedGeneration != null && expectedGeneration != _generation) return;
    _generation++;
    _ahead = (state: null, loading: false, hydrating: false);
    _notify();
    await _request(
      core.ChatIntent.leave(
        expected: expectedGeneration,
        generation: _generation,
      ),
    );
  }

  @override
  Future<void> archive(DeviceChatRef ref) =>
      _request(core.ChatIntent.archive(chat: _ref(ref)));

  void _apply(core.ChatFrame frame) {
    if (_disposed) return;
    _frame = frame;
    if (frame.generation > _generation) _generation = frame.generation;
    if (!_behind) _ahead = null;
    if (frame.errorRevision != _errorRevision) {
      _errorRevision = frame.errorRevision;
      _error = frame.error;
    }
    for (final draft in frame.drafts) {
      if (draft.text.isEmpty) {
        drafts.remove(draft.key);
      } else {
        drafts[draft.key] = draft.text;
      }
    }
    draftSeq = frame.draftSeq;
    if (frame.composer case final view?) _composer = view;
    final selected = frame.selected;
    if (selected == null) {
      _state = null;
      _raw.clear();
      _order = const [];
      feed._clear();
    } else {
      _applySelection(selected);
    }
    _revisions.reached(frame.revision);
    _notify();
  }

  void _applySelection(core.SelectionFrame selected) {
    final chat = selected.chat;
    final ref = DeviceChatRef(
      projectId: chat.projectId,
      worktreeId: chat.worktreeId,
      id: chat.id,
      title: chat.title,
    );
    var current = _state;
    if (selected.reset || current == null || current.ref.key != ref.key) {
      current = _state = DeviceChatState(ref);
      _raw.clear();
      _order = const [];
    }
    final s = selected.state;
    current
      ..header = selected.header
      ..before = s.before
      ..closed = s.closed;
    if (s.tabJson case final json?) current.tab = _object(json);
    for (final message in s.messages) {
      _raw[message.uid] = DeviceChatMessage(_object(message.json));
    }
    if (s.order case final order?) {
      _order = order;
      final kept = order.toSet();
      _raw.removeWhere((uid, _) => !kept.contains(uid));
    }
    if (s.order != null || s.messages.isNotEmpty) {
      current.messages
        ..clear()
        ..addAll([for (final uid in _order) ?_raw[uid]]);
    }
    feed._apply(selected.feed, ref);
    _seen
      ..remove(ref.key)
      ..[ref.key] = (state: current, composer: _composer);
    if (_seen.length > _cachedChats) _seen.remove(_seen.keys.first);
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    service.send(intent: const core.ChatIntent.close());
    _revisions.fail(StateError('Chat reader disposed.'));
    await _frames.cancel();
    await _updates.close();
  }
}

/// Read receipts on the core: the visible chat's flag goes to it; it marks
/// reads at most once per revision, with its retries.
final class RustReadMarker implements DeviceChatReadMarker {
  RustReadMarker(this.service);
  final core.ChatsService service;
  bool? _enabled;

  @override
  void observe(DeviceChatState? state, {required bool enabled}) {
    if (_enabled == enabled) return;
    _enabled = enabled;
    service.send(intent: core.ChatIntent.setReadReceipts(enabled: enabled));
  }

  @override
  void invalidate() =>
      service.send(intent: const core.ChatIntent.invalidateReadReceipts());

  @override
  void retry() =>
      service.send(intent: const core.ChatIntent.retryReadReceipts());

  @override
  void dispose() {}
}

/// What the feed shows of one chat.
typedef _FeedView = ({
  List<ChatMessage> messages,
  List<FeedMessageOutline> outline,
  List<TranscriptRow> rows,
});

const _FeedView _noFeed = (messages: [], outline: [], rows: []);

/// The Rust-grouped feed: applies the core's keyed feed ops to an immutable
/// row list, keeping each unchanged row (and message) the same object so
/// the feed's row cache keeps working, and hands those rows to [ChatFeed].
///
/// It shows rows only for the chat [_selected] names (the reader's state,
/// which moves before the core's frame for a new selection): the rows last
/// built for that chat, or none, never another chat's.
final class RustChatFeed implements ComputerChatFeed {
  RustChatFeed(this.service, this._selected);
  final core.ChatsService service;
  final String? Function() _selected;

  final _messages = <int, ChatMessage>{};
  List<ChatMessage> _order = const [];
  List<FeedMessageOutline> _outline = const [];
  final _items = <core.FeedItem>[];
  final _built = <String, (core.FeedItem, TranscriptRow)>{};
  final _results = <int, (int, Map<String, ToolCallResult>)>{};
  List<TranscriptRow> _rows = const [];
  Set<String> _footers = const {};
  String _chatId = '';

  /// The chat the rows above were built for.
  String? _key;

  /// The last view of each recent chat, by key.
  final _shown = <String, _FeedView>{};

  _FeedView get _view => switch (_selected()) {
    null => _noFeed,
    final key when key == _key => (
      messages: _order,
      outline: _outline,
      rows: _rows,
    ),
    final key => _shown[key] ?? _noFeed,
  };

  @override
  List<ChatMessage> get messages => _view.messages;
  @override
  List<FeedMessageOutline> get outline => _view.outline;
  @override
  void toggleTurn(String key) =>
      service.send(intent: core.ChatIntent.toggleTurn(key: key));

  @override
  List<TranscriptRow> project({Set<String> footerTurns = const {}}) {
    _sendFooters(footerTurns);
    return _view.rows;
  }

  void _sendFooters(Set<String> footers) {
    if (footers.length == _footers.length && _footers.containsAll(footers)) {
      return;
    }
    _footers = Set.of(footers);
    service.send(
      intent: core.ChatIntent.setFooterTurns(keys: footers.toList()),
    );
  }

  void _clear() {
    _key = null;
    _messages.clear();
    _order = const [];
    _outline = const [];
    _items.clear();
    _built.clear();
    _results.clear();
    _rows = const [];
  }

  void _apply(core.FeedFrame frame, DeviceChatRef chat) {
    if (frame.reset || chat.key != _key) _clear();
    _key = chat.key;
    _chatId = chat.id;
    _build(frame, chat.id);
    _shown
      ..remove(chat.key)
      ..[chat.key] = (messages: _order, outline: _outline, rows: _rows);
    if (_shown.length > _cachedChats) _shown.remove(_shown.keys.first);
  }

  void _build(core.FeedFrame frame, String chatId) {
    for (final message in frame.messages) {
      _messages[message.uid] = _message(message, chatId);
    }
    for (final results in frame.results) {
      _results[results.turn] = (
        results.rev,
        {
          for (final r in results.results)
            r.toolUseId: (content: r.content, isError: r.isError),
        },
      );
    }
    if (frame.order case final order?) {
      final uids = {for (final m in order) m.uid};
      _messages.removeWhere((uid, _) => !uids.contains(uid));
      _order = List.unmodifiable([
        for (final m in order) _messages[m.uid] ?? _placeholder(m, chatId),
      ]);
      _outline = List.unmodifiable([
        for (final m in order)
          (
            messageId: m.id,
            user: m.role == core.ChatRole.user,
            continuesTurn: m.continuesTurn,
            renderable: m.renderable,
          ),
      ]);
    }
    if (frame.ops.isEmpty && frame.messages.isEmpty && frame.order == null) {
      return;
    }
    for (final op in frame.ops) {
      if (frame.reset) {
        // A reset upserts every row in order.
        if (op case core.FeedOp_Upsert(:final item)) _items.add(item);
        continue;
      }
      switch (op) {
        case core.FeedOp_Remove(:final key):
          _items.removeWhere((item) => item.key == key);
        case core.FeedOp_Upsert(:final after, :final item):
          _items.removeWhere((existing) => existing.key == item.key);
          final at = after == null
              ? 0
              : _items.indexWhere((existing) => existing.key == after) + 1;
          _items.insert(at, item);
      }
    }
    final keys = {for (final item in _items) item.key};
    _built.removeWhere((key, _) => !keys.contains(key));
    _rows = List.unmodifiable([
      for (final item in _items)
        switch (_built[item.key]) {
          (final built, final row) when built == item => row,
          _ => (_built[item.key] = (item, _row(item))).$2,
        },
    ]);
  }

  /// The id only: [ChatFeed] anchors scrolling by message ids, and rows
  /// carry their messages.
  ChatMessage _placeholder(core.MessageRef ref, String chatId) => ChatMessage(
    messageId: ref.id,
    chatId: chatId,
    role: null,
    status: null,
    text: '',
  );

  ChatMessage _message(core.MessageView m, String chatId) => ChatMessage(
    messageId: m.id,
    chatId: chatId,
    role: switch (m.role) {
      final role? => sameName(ChatRole.values, role),
      null => null,
    },
    status: sameName(ChatMessageStatus.values, m.status),
    text: m.text,
    parts: [
      for (final p in m.parts)
        ChatPart(
          kind: p.kind,
          toolFamily: p.toolFamily,
          data: switch (p.dataJson) {
            final json? => _object(json),
            null => null,
          },
        ),
    ],
    occurredAt: switch (m.occurredAtMs) {
      final ms? => DateTime.fromMillisecondsSinceEpoch(ms),
      null => null,
    },
    attachments: [
      for (final a in m.attachments)
        ChatMessageAttachment(
          attachmentId: a.id,
          filename: a.filename,
          mediaType: a.mediaType,
        ),
    ],
    watcherFired: switch (m.watcherFired) {
      final w? => ChatWatcherFiredInfo(
        kind: w.kind,
        combinedWatchers: switch (w.combined) {
          final combined? => List.unmodifiable([
            for (final e in combined)
              ChatWatcherFiredEntry(kind: e.kind, text: e.text),
          ]),
          null => null,
        },
      ),
      null => null,
    },
    continuesTurn: m.continuesTurn,
  );

  Map<String, ToolCallResult> _toolResults(core.ResultsRef? ref) =>
      ref == null ? const {} : _results[ref.turn]?.$2 ?? const {};

  TurnTimer? _timer(core.TimerView? t) => t == null
      ? null
      : TurnTimer(
          startedAt: t.startedAt,
          pausedAt: t.pausedAt,
          resumedAt: t.resumedAt,
          accumulatedPausedDurationMs: t.accumulatedPausedDurationMs,
          completedAt: t.completedAt,
          endReason: t.endReason,
        );

  ChatMessage _named(int uid) =>
      _messages[uid] ??
      ChatMessage(
        messageId: '',
        chatId: _chatId,
        role: null,
        status: null,
        text: '',
      );

  TranscriptRow _row(core.FeedItem item) => switch (item.row) {
    core.FeedRow_Message(
      :final uid,
      :final results,
      :final streamingSpinner,
      :final parts,
    ) =>
      TranscriptMessageRow(
        _named(uid),
        toolResults: _toolResults(results),
        streamingSpinner: streamingSpinner,
        parts: parts,
      ),
    core.FeedRow_Run(
      :final runKey,
      :final steps,
      :final shownFrom,
      :final expanded,
      :final results,
      :final anchorMessageId,
    ) =>
      TranscriptRunRow(
        runKey,
        [for (final s in steps) RunStep(_named(s.uid), s.index)],
        shownFrom: shownFrom,
        expanded: expanded,
        toolResults: _toolResults(results),
        anchorMessageId: anchorMessageId,
      ),
    core.FeedRow_Steps(
      :final turnKey,
      :final counts,
      :final expanded,
      :final timer,
    ) =>
      TranscriptStepsRow(
        turnKey,
        [
          for (final c in counts)
            (
              category: sameName(TurnStepCategory.values, c.category),
              count: c.count,
            ),
        ],
        expanded: expanded,
        timer: _timer(timer),
      ),
    core.FeedRow_Timer(:final turnKey, :final timer) => TranscriptTimerRow(
      _timer(timer),
      turnKey: turnKey,
    ),
    core.FeedRow_TurnFooter(:final turnKey) => TranscriptTurnFooterRow(turnKey),
    core.FeedRow_ResponseActions(
      :final uid,
      :final turnKey,
      :final atMessageId,
    ) =>
      TranscriptResponseActionsRow(
        _named(uid),
        ResponseActionTarget(
          chatId: _chatId,
          turnKey: turnKey,
          atMessageId: atMessageId,
        ),
      ),
  };

  @override
  void dispose() {}
}

/// [ChatFeed]'s row source: the mirrored rows; it passes back the footer
/// turns, which the core needs for its rows.

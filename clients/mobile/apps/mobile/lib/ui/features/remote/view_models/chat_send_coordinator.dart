import 'dart:async';
import 'dart:math';

import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/remote_unsent_sends.dart';

import 'chat_transcript_store.dart';
import 'owned_command_registry.dart';
import 'remote_identity.dart';

/// Ceiling on the post-send "awaiting agent turn" bridge. After an accepted
/// send, the chat is presented as running until real turn evidence arrives —
/// this bound guarantees a send whose turn never materializes (dropped
/// events, desktop wedged) cannot pin a working indicator forever. Sized to
/// cover a slow agent spawn plus projection lag with margin.
const Duration kRemoteTurnStartGrace = Duration(seconds: 30);

const Duration _firstChatSendEchoGrace = Duration(seconds: 3);

/// Mints the id of an optimistic user message submitted at [submittedAt].
typedef RemoteMessageIdFactory = String Function(DateTime submittedAt);

/// Mints a client chat id in [scope] at [mintedAt]. Ids must satisfy the
/// desktop's `validateId` rule (`^[a-z0-9][a-z0-9-]*$`).
typedef RemoteChatIdFactory =
    String Function(RemoteChatScope scope, DateTime mintedAt);

/// Subscribes [onChange] to every visible client change; returns the
/// unsubscribe callback.
typedef RemoteChangeWatcher =
    void Function() Function(void Function() onChange);

/// Chat sends and the chat-scoped commands the composer and tab strip issue.
///
/// A send appends an optimistic user row, then bridges the gap until the
/// agent turn surfaces in any projection ("awaiting agent turn"), so the
/// working indicator cannot flap to idle mid-handoff. A send whose outcome
/// is unknown is confirmed only by the host echoing its exact
/// `userMessageId`; it is never resubmitted automatically.
final class ChatSendCoordinator {
  ChatSendCoordinator({
    required this.repository,
    required this.commands,
    required this.transcripts,
    required this.notify,
    required this.isConnected,
    required this.isDisposed,
    required this.isBackgrounded,
    required this.sessionGeneration,
    required this.watchChanges,
    required this.onSendCompleted,
    required this.onSendFailed,
    required this.onTabCreateFailed,
    required this.unsent,
    required this.chatExists,
    DateTime Function()? clock,
    RemoteTimerFactory? timer,
    this.messageId,
    this.chatId,
  }) : _clock = clock ?? DateTime.now,
       _timer = timer ?? Timer.new;

  final RemoteControlRepository repository;
  final OwnedCommandRegistry commands;
  final ChatTranscriptStore transcripts;
  final void Function() notify;
  final bool Function() isConnected;
  final bool Function() isDisposed;
  final bool Function() isBackgrounded;
  final int Function() sessionGeneration;
  final RemoteChangeWatcher watchChanges;

  /// The desktop completed the send command [commandId].
  final void Function(String commandId) onSendCompleted;

  /// The desktop rejected the send command [commandId].
  final void Function(String commandId) onSendFailed;

  /// The desktop rejected creating [target]'s chat tab.
  final void Function(RemoteWorktreeChatTarget target) onTabCreateFailed;

  /// Durable records of text sends the desktop has not confirmed.
  final RemoteUnsentSends unsent;

  /// Whether the desktop already projects [key]'s chat tab.
  final bool Function(RemoteChatKey key) chatExists;
  static final Random _chatIdRandom = Random();

  final DateTime Function() _clock;
  final RemoteTimerFactory _timer;

  /// Mints optimistic send ids; defaults to a submission-time stamp plus a
  /// per-client sequence.
  final RemoteMessageIdFactory? messageId;

  /// Mints client chat ids; defaults to [mintChatId]'s stamped random ids.
  final RemoteChatIdFactory? chatId;

  /// Chats with an accepted send whose agent turn has not shown up in any
  /// projection yet, keyed to the send's acceptance time. Bridges the gap
  /// between the optimistic send and the first authoritative running signal
  /// (streamed row, assistant row, or turn-timer part) so the working
  /// indicator cannot flap to "nothing happening" mid-handoff. Entries clear
  /// on turn evidence, a failed send, a cancel, or [kRemoteTurnStartGrace].
  final Map<RemoteChatKey, DateTime> _awaitingTurnSince = {};
  final Map<RemoteChatKey, Set<String>> _awaitingTurnBaselineMessageIds = {};
  final Map<RemoteChatKey, Timer> _awaitingTurnTimers = {};

  /// Send command ids → the chat key their acceptance marked as awaiting, so
  /// an asynchronous `portal.command.failed` for the send releases the wait.
  /// Turn evidence and the grace timer detach a command from its wait here,
  /// so a late failure cannot release a newer send's wait on the same chat.
  final Map<String, RemoteChatKey> _awaitingTurnCommands = {};
  int _localSendSeq = 0;
  final Map<RemoteChatKey, Future<void>> _standaloneChatCreates = {};

  /// Completed on foreground, reset, and disposal, so an unknown-outcome send
  /// waiting out the background can resume its confirmation.
  Completer<void>? _sendRecoveryForeground;

  String _nextMessageId(DateTime submittedAt) =>
      messageId?.call(submittedAt) ??
      'msg-mobile-${submittedAt.microsecondsSinceEpoch}-${++_localSendSeq}';

  /// A new client-minted chat id in [scope]. Worktree tabs use the `chat-m`
  /// prefix, distinguishing them from the desktop renderer's `chat-N-…`;
  /// standalone chats use `cc-`.
  String mintChatId(RemoteChatScope scope) => _nextChatId(scope, _clock());

  String _nextChatId(RemoteChatScope scope, DateTime mintedAt) {
    if (chatId case final factory?) return factory(scope, mintedAt);
    return switch (scope) {
      RemoteChatScope.worktree =>
        'chat-m${mintedAt.millisecondsSinceEpoch}-'
            '${_chatIdRandom.nextInt(0xffffff).toRadixString(16).padLeft(6, '0')}',
      RemoteChatScope.standalone =>
        'cc-${mintedAt.millisecondsSinceEpoch.toRadixString(36)}-'
            '${_chatIdRandom.nextInt(1 << 30).toRadixString(36)}',
    };
  }

  /// Sends [text] to the targeted chat. A text-only send is durable: it is
  /// recorded (clearing the draft at [clearDraft] in the same write) before it
  /// is submitted, and a failure keeps the record as a not-sent or uncertain
  /// row and throws [RemoteChatSendNotSentException]. A worktree target with
  /// no chat gets a client-minted chat and tab first. Sends with attachments
  /// keep the non-durable path and rethrow [RemoteControlException] so the
  /// composer can restore them.
  Future<RemoteChatSendResult> sendChatMessage(
    RemoteChatTarget target,
    String text, {
    RemoteChatSendOptions? options,
    DraftTarget? clearDraft,
  }) async {
    final submittedAt = _clock();
    final userMessageId = options?.userMessageId ?? _nextMessageId(submittedAt);
    final durable = options?.attachments?.isEmpty ?? true;
    if (!durable) {
      return _deliver(
        target,
        text,
        options: options,
        submittedAt: submittedAt,
        userMessageId: userMessageId,
      );
    }
    var sendTarget = target;
    RemoteWorktreeChatTarget? mintedTab;
    if (target case RemoteWorktreeChatTarget(
      chatId: null,
      :final workspaceLocalId,
      :final worktreeLocalId,
    )) {
      final minted = RemoteWorktreeChatTarget(
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
        chatId: _nextChatId(RemoteChatScope.worktree, submittedAt),
      );
      sendTarget = minted;
      mintedTab = minted;
    }
    unsent.recordSending(
      target: sendTarget,
      userMessageId: userMessageId,
      text: text,
      createdAt: submittedAt,
      options: options,
      clearDraft: clearDraft,
    );
    notify();
    if (!isConnected()) {
      unsent.markNotSent(userMessageId, kRemoteOfflineReason);
      notify();
      throw RemoteChatSendNotSentException(
        kRemoteOfflineReason,
        chatId: sendTarget.chatId,
      );
    }
    try {
      if (mintedTab != null) await createChatTab(mintedTab);
      return await _deliver(
        sendTarget,
        text,
        options: options,
        submittedAt: submittedAt,
        userMessageId: userMessageId,
      );
    } catch (error) {
      throw RemoteChatSendNotSentException(
        _recordFailure(userMessageId, error),
        chatId: sendTarget.chatId,
      );
    }
  }

  /// Resends a not-sent or uncertain record with its original ids and send
  /// options, so desktop dedupes a send whose acknowledgement was lost.
  /// Ignores a record that is missing or already sending.
  Future<void> resend(String userMessageId) async {
    final record = unsent.byId(userMessageId);
    if (record == null || !unsent.markSending(userMessageId)) return;
    notify();
    final target = record.target;
    if (!isConnected()) {
      unsent.markNotSent(userMessageId, kRemoteOfflineReason);
      notify();
      return;
    }
    try {
      if (target is RemoteWorktreeChatTarget && !chatExists(record.key)) {
        await createChatTab(target);
      }
      await _deliver(
        target,
        record.text,
        options: record.options.copyWith(userMessageId: userMessageId),
        submittedAt: _clock(),
        userMessageId: userMessageId,
      );
      final confirmed = await _recoverChatSend(
        target,
        userMessageId,
        sessionGeneration(),
      );
      if (confirmed != null) {
        unsent.remove(userMessageId);
      } else {
        unsent.markUncertain(userMessageId, '');
        final key = remoteChatKeyForTarget(target);
        if (key != null) transcripts.removePendingSendById(key, userMessageId);
      }
      notify();
    } catch (error) {
      _recordFailure(userMessageId, error);
    }
  }

  /// Marks [userMessageId]'s record after a failed delivery — uncertain when
  /// the outcome is unknown, not sent otherwise — and returns the reason.
  String _recordFailure(String userMessageId, Object error) {
    final message = error is RemoteControlException
        ? error.message
        : kRemoteSendFailedReason;
    if (error is RemoteChatSendOutcomeUnknownException) {
      unsent.markUncertain(userMessageId, message);
    } else {
      unsent.markNotSent(userMessageId, message);
    }
    notify();
    return message;
  }

  /// Submits [text], appending an optimistic user bubble (for known chats)
  /// that is replaced by the desktop's authoritative echo. Rethrows
  /// [RemoteControlException] after retracting the bubble.
  Future<RemoteChatSendResult> _deliver(
    RemoteChatTarget target,
    String text, {
    required RemoteChatSendOptions? options,
    required DateTime submittedAt,
    required String userMessageId,
  }) async {
    final chatId = target.chatId;
    final key = remoteChatKeyForTarget(target);
    final sendGeneration = sessionGeneration();
    final sendOptions = (options ?? const RemoteChatSendOptions()).copyWith(
      userMessageId: userMessageId,
    );
    var awaitingKey = key;
    RemoteChatMessage? optimistic;
    if (key != null && chatId != null) {
      optimistic = RemoteChatMessage(
        messageId: userMessageId,
        chatId: chatId,
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: text,
        occurredAt: DateTime.now(),
        attachments: [
          for (final ref
              in sendOptions.attachments ?? const <ChatAttachmentRef>[])
            ref.toMessageAttachment(),
        ],
      );
      transcripts.addPendingSend(key, optimistic);
      // Install the bridge before the submit: projections can race the HTTP
      // response, and evidence received while the request is in flight must
      // be able to release it instead of being forgotten and reinstalled.
      _markAwaitingAgentTurn(key, since: submittedAt);
      notify();
    }

    try {
      RemoteChatSendResult result;
      try {
        result = await repository.sendChatMessage(
          target,
          text,
          options: sendOptions,
        );
      } on RemoteChatSendOutcomeUnknownException {
        final recovered = await _recoverChatSend(
          target,
          userMessageId,
          sendGeneration,
        );
        if (recovered == null) rethrow;
        result = recovered;
      }
      // A raced failure throws here; the catch below retracts the bubble.
      final commandId = commands.register(
        result.commandId,
        throwIfFailed: true,
        onCompleted: (_) => onSendCompleted(result.commandId),
        onFailed: (message) => _sendFailed(
          result.commandId,
          key,
          optimistic,
          userMessageId,
          message,
        ),
      );

      var canonicalChatId = result.chatId;
      if (chatId == null && canonicalChatId == null && commandId.isNotEmpty) {
        final completed = commands.hasCompleted(commandId)
            ? commands.resultOf(commandId)
            : await _waitForSendCompletion(commandId);
        final completedChatId = completed?['chatId'];
        if (completedChatId is String && completedChatId.isNotEmpty) {
          canonicalChatId = completedChatId;
        }
      }
      // The send is accepted: present the chat as awaiting its agent turn
      // until real turn evidence lands, so the working indicator cannot dip
      // to idle while projections catch up. Keyed on the canonical id the
      // desktop echoed, which also covers sends that minted a new chat.
      final turnKey = canonicalChatId != null && canonicalChatId.isNotEmpty
          ? (scope: target.scope, chatId: canonicalChatId)
          : key;
      if (turnKey != null && turnKey != awaitingKey) {
        if (awaitingKey case final previousKey?) {
          _clearAwaitingAgentTurn(previousKey);
        }
        awaitingKey = turnKey;
        // A newly minted chat had no transcript baseline at send time. Mark
        // it with an empty baseline, then immediately consider any evidence
        // that raced ahead of the submit response.
        _markAwaitingAgentTurn(
          turnKey,
          since: submittedAt,
          baselineMessageIds: const {},
        );
        for (final message in transcripts.projectedRows(turnKey)) {
          clearAwaitingTurnOnEvidence(turnKey, message);
          if (!_awaitingTurnSince.containsKey(turnKey)) break;
        }
      }
      if (turnKey != null &&
          commandId.isNotEmpty &&
          _awaitingTurnSince.containsKey(turnKey)) {
        _awaitingTurnCommands[commandId] = turnKey;
      }
      if (turnKey != null) {
        notify();
      }
      return RemoteChatSendResult(
        commandId: commandId,
        chatId: canonicalChatId,
        queuedWhileReconnecting: result.queuedWhileReconnecting,
      );
    } catch (_) {
      if (awaitingKey case final activeKey?) {
        _clearAwaitingAgentTurn(activeKey);
      }
      if (optimistic != null && key != null) {
        transcripts.removePendingSend(key, optimistic);
        notify();
      }
      rethrow;
    }
  }

  Future<RemoteChatSendResult?> _recoverChatSend(
    RemoteChatTarget target,
    String userMessageId,
    int generation,
  ) async {
    bool isCurrent() =>
        !isDisposed() && isConnected() && generation == sessionGeneration();
    bool matches(RemoteChatMessage message) =>
        message.role == ChatRole.user &&
        message.messageId == userMessageId &&
        (target.chatId == null || message.chatId == target.chatId) &&
        (message.scope == null || message.scope == target.scope);
    RemoteChatSendResult? confirmed() {
      if (!isCurrent()) return null;
      final echo = transcripts.findProjectedRow(target.scope, matches);
      return echo == null
          ? null
          : RemoteChatSendResult(commandId: '', chatId: echo.chatId);
    }

    // Only a host-projected row is proof of delivery. The optimistic bubble,
    // matching text, or another running turn cannot acknowledge this send.
    final echoed = confirmed();
    if (echoed != null) return echoed;
    while (isBackgrounded() && isCurrent()) {
      await (_sendRecoveryForeground ??= Completer<void>()).future;
    }
    if (!isCurrent()) return null;
    final resumedEcho = confirmed();
    if (resumedEcho != null) return resumedEcho;
    final key = remoteChatKeyForTarget(target);
    if (key == null) {
      // The first send can mint its chat on the host, so there is no chat id
      // for a targeted cache read yet. Give its live echo a bounded chance to
      // identify the new chat before treating the uncertain send as failed.
      final echo = Completer<RemoteChatSendResult?>();
      final unwatch = watchChanges(() {
        final result = confirmed();
        if (result != null || !isCurrent()) {
          if (!echo.isCompleted) echo.complete(result);
        }
      });
      final timeout = _timer(_firstChatSendEchoGrace, () {
        if (!echo.isCompleted) echo.complete(confirmed());
      });
      try {
        return await echo.future;
      } finally {
        timeout.cancel();
        unwatch();
      }
    }
    try {
      // This bounded, independent read also works when the suspended HTTP
      // connection failed before the resumed event stream caught up.
      final messages = await repository.fetchCachedChatMessages(target);
      if (!isCurrent()) return null;
      for (final message in messages.where(matches)) {
        transcripts.ingest(key, message);
      }
    } catch (_) {
      // A live echo may still have arrived while the cache read failed.
    }
    return confirmed();
  }

  /// A send's asynchronous rejection: release its awaiting-turn bridge,
  /// retract its optimistic bubble unless the desktop echo already retired it,
  /// and keep its durable record (if any) as a not-sent row.
  void _sendFailed(
    String commandId,
    RemoteChatKey? key,
    RemoteChatMessage? optimistic,
    String userMessageId,
    String message,
  ) {
    final failedTurnKey = _awaitingTurnCommands.remove(commandId);
    if (failedTurnKey != null) _clearAwaitingAgentTurn(failedTurnKey);
    onSendFailed(commandId);
    if (key != null && optimistic != null) {
      transcripts.removePendingSend(key, optimistic);
    }
    unsent.markNotSent(
      userMessageId,
      message.isEmpty ? kRemoteSendFailedReason : message,
    );
    notify();
  }

  Future<Map<String, dynamic>?> _waitForSendCompletion(String commandId) async {
    final failure = commands.failureMessageFor(commandId);
    if (failure != null) throw RemoteControlException(failure);
    if (commands.hasCompleted(commandId)) return commands.resultOf(commandId);
    try {
      return await commands.waitForResult(
        commandId,
        timeout: kRemoteTurnStartGrace,
      );
    } on TimeoutException {
      return null;
    }
  }

  void _markAwaitingAgentTurn(
    RemoteChatKey key, {
    DateTime? since,
    Set<String>? baselineMessageIds,
  }) {
    final startedAt = since ?? _clock();
    final elapsed = _clock().difference(startedAt);
    final remaining = elapsed.isNegative
        ? kRemoteTurnStartGrace
        : kRemoteTurnStartGrace - elapsed;
    if (remaining <= Duration.zero) return;
    _awaitingTurnSince[key] = startedAt;
    _awaitingTurnBaselineMessageIds[key] =
        baselineMessageIds ??
        {
          for (final message in transcripts.projectedRows(key))
            message.messageId,
        };
    _awaitingTurnTimers.remove(key)?.cancel();
    late final Timer timer;
    timer = _timer(remaining, () {
      if (!identical(_awaitingTurnTimers[key], timer)) return;
      _awaitingTurnTimers.remove(key);
      if (_awaitingTurnSince.remove(key) != null) {
        _awaitingTurnBaselineMessageIds.remove(key);
        _awaitingTurnCommands.removeWhere((_, value) => value == key);
        notify();
      }
    });
    _awaitingTurnTimers[key] = timer;
  }

  void _clearAwaitingAgentTurn(RemoteChatKey key) {
    _awaitingTurnSince.remove(key);
    _awaitingTurnBaselineMessageIds.remove(key);
    _awaitingTurnTimers.remove(key)?.cancel();
    _awaitingTurnCommands.removeWhere((_, value) => value == key);
  }

  void _cancelAwaitingTurnTimers() {
    for (final timer in _awaitingTurnTimers.values) {
      timer.cancel();
    }
    _awaitingTurnTimers.clear();
  }

  /// True while an accepted send for [target]'s chat is still waiting for its
  /// agent turn to surface in any projection. The chat screen ORs this into
  /// its working indicators so the post-send handoff between the optimistic
  /// and authoritative signals never reads as idle.
  bool isAwaitingAgentTurn(RemoteChatTarget target) {
    final chatId = target.chatId;
    if (chatId == null) return false;
    final key = (scope: target.scope, chatId: chatId);
    final since = _awaitingTurnSince[key];
    if (since == null) return false;
    if (_clock().difference(since) >= kRemoteTurnStartGrace) {
      _clearAwaitingAgentTurn(key);
      return false;
    }
    return true;
  }

  /// Releases the awaiting-turn bridge once [message] proves the turn is
  /// visible in projections: a streaming row, any assistant row, or a
  /// `turn_timer` part (live OR completed — a completed timer means the turn
  /// already ended and the indicator must be allowed to drop). A plain user
  /// echo is NOT evidence; it arrives before the agent has started.
  void clearAwaitingTurnOnEvidence(
    RemoteChatKey key,
    RemoteChatMessage message,
  ) {
    final since = _awaitingTurnSince[key];
    if (since == null) return;
    if (_awaitingTurnBaselineMessageIds[key]?.contains(message.messageId) ==
        true) {
      return;
    }
    final occurredAt = message.occurredAt;
    if (occurredAt != null && occurredAt.isBefore(since)) return;
    final isEvidence =
        message.role == ChatRole.assistant ||
        message.isStreaming ||
        message.parts.any((part) => part.kind == 'turn_timer');
    if (isEvidence) _clearAwaitingAgentTurn(key);
  }

  /// Submits a chat-scoped command and claims its id with [onCompleted] and
  /// [onFailed]. A response that arrives after the session was replaced or
  /// the owner disposed is never claimed, so its terminal event stays foreign;
  /// the empty id tells the caller the command no longer exists.
  /// [onCompleted] receives the composer projection sequence at which the
  /// desktop's completion was observed.
  Future<String> _submit(
    Future<String> Function() submit, {
    void Function(int completedAt)? onCompleted,
    OwnedCommandFailed? onFailed,
  }) async {
    final generation = sessionGeneration();
    final commandId = await submit();
    if (isDisposed() || generation != sessionGeneration()) return '';
    return commands.register(
      commandId,
      onCompleted: onCompleted == null
          ? null
          : (_) => onCompleted(
              commands.completedProjectionSequence(commandId) ?? 0,
            ),
      onFailed: onFailed,
    );
  }

  Future<void> ensureStandaloneChatCreated(
    RemoteStandaloneChatTarget target,
  ) async {
    if (!isConnected() || isDisposed()) {
      throw const RemoteControlException('Remote Control is disconnected.');
    }
    final key = (scope: target.scope, chatId: target.chatId);
    final pending = _standaloneChatCreates[key];
    if (pending != null) return pending;
    final creation = _createStandaloneChat(target);
    _standaloneChatCreates[key] = creation;
    try {
      await creation;
    } catch (_) {
      if (identical(_standaloneChatCreates[key], creation)) {
        _standaloneChatCreates.remove(key);
      }
      rethrow;
    }
  }

  Future<void> _createStandaloneChat(RemoteStandaloneChatTarget target) async {
    final generation = sessionGeneration();
    final commandId = await commands.submit(
      () => repository.createStandaloneChat(target),
      throwIfFailed: true,
    );
    if (commandId.isEmpty) {
      throw const RemoteControlException('The chat could not be created.');
    }
    Map<String, dynamic>? result;
    try {
      result = commands.hasCompleted(commandId)
          ? commands.resultOf(commandId)
          : await commands.waitForResult(
              commandId,
              timeout: kRemoteTurnStartGrace,
            );
    } on TimeoutException {
      throw const RemoteControlException(
        'The desktop has not confirmed this chat. Retry to check again.',
      );
    }
    if (!isConnected() || isDisposed() || sessionGeneration() != generation) {
      throw const RemoteControlException('Remote Control is disconnected.');
    }
    if (result?['chatId'] != target.chatId) {
      throw const RemoteControlException('The chat could not be created.');
    }
  }

  /// Creates an empty chat tab on the desktop with the client-minted
  /// `target.chatId` (web-parity `portal.chat.create_tab` flow). Rethrows
  /// [RemoteControlException] so the caller can revert its optimistic tab;
  /// [onFailed] reports an asynchronous rejection.
  Future<String> createChatTab(
    RemoteWorktreeChatTarget target, {
    OwnedCommandFailed? onFailed,
  }) async {
    if (!isConnected()) {
      throw const RemoteControlException('Remote Control is disconnected.');
    }
    return _submit(
      () => repository.createChatTab(target),
      onFailed: (message) {
        onTabCreateFailed(target);
        onFailed?.call(message);
      },
    );
  }

  Future<String> forkResponse(
    RemoteWorktreeChatTarget target,
    String turnKey, {
    required OwnedCommandCompleted onCompleted,
    required OwnedCommandFailed onFailed,
  }) async {
    if (!isConnected() || isDisposed()) {
      throw const RemoteControlException('Remote Control is disconnected.');
    }
    final generation = sessionGeneration();
    final id = await repository.responseCommands.fork(target, turnKey);
    if (isDisposed() || generation != sessionGeneration()) return '';
    return commands.register(id, onCompleted: onCompleted, onFailed: onFailed);
  }

  /// Closes a chat tab; [onFailed] reports an asynchronous rejection so the
  /// caller can restore its optimistically hidden tab.
  Future<String> closeChatTab(
    RemoteWorktreeChatTarget target, {
    OwnedCommandFailed? onFailed,
  }) async {
    if (!isConnected()) {
      throw const RemoteControlException('Remote Control is disconnected.');
    }
    return _submit(() => repository.closeChatTab(target), onFailed: onFailed);
  }

  /// Persists the chat's model without sending a message. Rethrows
  /// [RemoteControlException] so the composer can revert an optimistic flip.
  /// Returns an empty id when nothing was submitted.
  Future<String> setChatModel(
    RemoteChatTarget target,
    String model, {
    void Function(int completedAt)? onCompleted,
    OwnedCommandFailed? onFailed,
  }) async {
    if (!isConnected()) return '';
    return _submit(
      () => repository.setChatModel(target, model),
      onCompleted: onCompleted,
      onFailed: onFailed,
    );
  }

  /// Turns on Auto for a worktree chat. Rethrows [RemoteControlException] so
  /// the composer can revert its optimistic Auto.
  Future<String> setChatAutoModel(
    RemoteWorktreeChatTarget target, {
    void Function(int completedAt)? onCompleted,
    OwnedCommandFailed? onFailed,
  }) async {
    if (!isConnected()) return '';
    return _submit(
      () => repository.setChatAutoModel(target),
      onCompleted: onCompleted,
      onFailed: onFailed,
    );
  }

  /// Toggles plan mode on a worktree chat. Rethrows on failure.
  Future<String> setChatPlanMode(
    RemoteWorktreeChatTarget target,
    bool planMode, {
    void Function(int completedAt)? onCompleted,
    OwnedCommandFailed? onFailed,
  }) async {
    if (!isConnected()) return '';
    return _submit(
      () => repository.setChatPlanMode(target, planMode),
      onCompleted: onCompleted,
      onFailed: onFailed,
    );
  }

  /// Sets the thinking level on a worktree chat. Rethrows on failure.
  Future<String> setChatThinkingLevel(
    RemoteWorktreeChatTarget target,
    String thinkingLevel, {
    void Function(int completedAt)? onCompleted,
    OwnedCommandFailed? onFailed,
  }) async {
    if (!isConnected()) return '';
    return _submit(
      () => repository.setChatThinkingLevel(target, thinkingLevel),
      onCompleted: onCompleted,
      onFailed: onFailed,
    );
  }

  /// Toggles Codex fast mode on a worktree chat. Rethrows on failure.
  Future<String> setChatFastMode(
    RemoteWorktreeChatTarget target,
    bool fastMode, {
    void Function(int completedAt)? onCompleted,
    OwnedCommandFailed? onFailed,
  }) async {
    if (!isConnected()) return '';
    return _submit(
      () => repository.setChatFastMode(target, fastMode),
      onCompleted: onCompleted,
      onFailed: onFailed,
    );
  }

  /// Saves a chat's complete plugin selection. Rethrows on failure.
  Future<String> setChatPluginSelections(
    RemoteChatTarget target,
    Map<String, Object?> selections, {
    void Function(int completedAt)? onCompleted,
    OwnedCommandFailed? onFailed,
  }) async {
    if (!isConnected()) return '';
    return _submit(
      () => repository.setChatPluginSelections(target, selections),
      onCompleted: onCompleted,
      onFailed: onFailed,
    );
  }

  /// Interrupts the chat's active run. Rethrows on failure.
  Future<void> cancelChat(RemoteChatTarget target) async {
    if (!isConnected()) return;
    // A cancel means the user no longer expects a turn; release the
    // post-send bridge so the working indicator can drop immediately.
    final chatId = target.chatId;
    if (chatId != null) {
      _clearAwaitingAgentTurn((scope: target.scope, chatId: chatId));
      notify();
    }
    await commands.submit(() => repository.cancelChat(target));
  }

  /// Lets unknown-outcome sends waiting out the background confirm again.
  void onAppForegrounded() => _releaseSendRecovery();

  void _releaseSendRecovery() {
    _sendRecoveryForeground?.complete();
    _sendRecoveryForeground = null;
  }

  /// Drops the discarded session's awaiting-turn bridges. A recovering send
  /// resumes, finds its session generation stale, and fails.
  void reset() {
    _releaseSendRecovery();
    _awaitingTurnSince.clear();
    _awaitingTurnBaselineMessageIds.clear();
    _awaitingTurnCommands.clear();
    _standaloneChatCreates.clear();
    _cancelAwaitingTurnTimers();
  }

  void dispose() {
    _releaseSendRecovery();
    _cancelAwaitingTurnTimers();
  }
}

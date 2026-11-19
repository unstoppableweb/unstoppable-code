/// Hand-written Dart mirrors of the Portal chat wire contract consumed by the
/// mobile Remote Control chat screen.
///
/// The same chat message arrives in two spellings (see
/// `packages/protocol/src/remote-control/shell/index.ts`):
///
///  * `RemoteControlChatMessage` — the live wire shape carried by `portal.chat.event`
///    payloads and `portal.state.snapshot` `chatMessages` arrays
///    (`messageId`, `chatId`, `text`, `createdAtMs`).
///  * `RemoteControlChatMessageView` — the server state projection returned inside
///    `GET .../state` under `state.chatMessages`
///    (`localMessageId`, `localChatId`, `content`, `occurredAt`).
///
/// [RemoteChatMessage] normalizes both via [RemoteChatMessage.fromWireJson]
/// and [RemoteChatMessage.fromViewJson] so the rest of the app renders one
/// shape. JSON keys are kept wire-accurate; parsing is null-tolerant like
/// `remote_session.dart`.
library;

import 'chat_tab_item.dart';

import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/chat_attachment.dart';

/// Remote Control consumers historically imported every chat type from this
/// file. The neutral types now live in `chat_message.dart`; re-export them so
/// the remote feature keeps a single import.
export 'package:mobile/data/models/chat_message.dart';

/// The attachment limits and ready-upload reference are shared with cloud
/// chats; re-exported for the same single-import reason.
export 'package:mobile/data/models/chat_attachment.dart';

/// Worktree- vs standalone-scoped chat thread (`RemoteControlChatScope`).
enum RemoteChatScope {
  worktree('worktree'),
  standalone('standalone');

  const RemoteChatScope(this.wire);

  final String wire;

  /// Parses a wire value, returning `null` for absent/unknown values.
  static RemoteChatScope? fromWire(String? wire) {
    if (wire == null) return null;
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return null;
  }
}

/// The chat's canonical turn phase (`ChatTurnPhase`, turn-state phase 41a).
/// [background] means only background work runs: there is no turn, so the
/// composer is open and there is no Stop.
enum RemoteChatTurnPhase {
  idle('idle'),
  background('background'),
  foreground('foreground');

  const RemoteChatTurnPhase(this.wire);

  final String wire;

  /// Parses a wire value, returning `null` for absent/unknown values.
  static RemoteChatTurnPhase? fromWire(Object? wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return null;
  }
}

/// Remote Control's chat row: the neutral [ChatMessage] plus the desktop's
/// worktree/standalone [scope], which the view model uses to key incoming,
/// snapshot, and history rows to a chat.
class RemoteChatMessage extends ChatMessage {
  const RemoteChatMessage({
    required super.messageId,
    required super.chatId,
    required super.role,
    required super.status,
    required super.text,
    this.scope,
    super.parts,
    super.occurredAt,
    super.attachments,
    super.delivery,
    super.deliveryNote,
    super.watcherFired,
    super.continuesTurn,
    this.updatedAt,
    this.orderingAt,
  });

  final RemoteChatScope? scope;

  /// Proven host revision time, distinct from the message's position in the
  /// chat. Live rows expose this as `updatedAtMs`; state-view `occurredAt`
  /// does not establish a revision time.
  final DateTime? updatedAt;

  // Runtime timer/tool revisions can change createdAtMs. Keep their first
  // observed position separately from the timestamp used by the live timer.
  final DateTime? orderingAt;
  @override
  DateTime? get positionAt => orderingAt ?? occurredAt;

  /// Parses the live wire shape (`RemoteControlChatMessage`): `portal.chat.event`
  /// payload `message` and snapshot `chatMessages` rows.
  factory RemoteChatMessage.fromWireJson(Map<String, dynamic> json) {
    final updatedAtMs = json['updatedAtMs'];
    final parts = _parseParts(json['parts']);
    return RemoteChatMessage(
      messageId: _stringValue(json['messageId']),
      chatId: _stringValue(json['chatId']),
      scope: RemoteChatScope.fromWire(_stringOrNull(json['scope'])),
      role: ChatRole.fromWire(_stringOrNull(json['role'])),
      status: ChatMessageStatus.fromWire(_stringOrNull(json['status'])),
      text: _stringValue(json['text']),
      parts: parts,
      occurredAt: _dateTimeFromEpochMilliseconds(json['createdAtMs']),
      updatedAt: updatedAtMs is num && updatedAtMs > 0
          ? _dateTimeFromEpochMilliseconds(updatedAtMs)
          : null,
      attachments: ChatMessageAttachment.listFromJson(json['attachments']),
      watcherFired: ChatWatcherFiredInfo.read(json['watcherFired'], parts),
      continuesTurn: json['continuesTurn'] == true,
    );
  }

  /// Parses the server state projection (`RemoteControlChatMessageView`) returned by
  /// `GET .../state` under `state.chatMessages`.
  factory RemoteChatMessage.fromViewJson(Map<String, dynamic> json) {
    final occurredAt = _stringOrNull(json['occurredAt']);
    final parts = _parseParts(json['parts']);
    return RemoteChatMessage(
      messageId: _stringValue(json['localMessageId']),
      chatId: _stringValue(json['localChatId']),
      scope: RemoteChatScope.fromWire(_stringOrNull(json['scope'])),
      role: ChatRole.fromWire(_stringOrNull(json['role'])),
      status: ChatMessageStatus.fromWire(_stringOrNull(json['status'])),
      text: _stringValue(json['content']),
      parts: parts,
      occurredAt: occurredAt == null ? null : DateTime.tryParse(occurredAt),
      attachments: ChatMessageAttachment.listFromJson(json['attachments']),
      watcherFired: ChatWatcherFiredInfo.read(json['watcherFired'], parts),
      continuesTurn: json['continuesTurn'] == true,
    );
  }

  static List<ChatPart> _parseParts(Object? value) {
    if (value is! List) return const [];
    return value
        .whereType<Map<String, dynamic>>()
        .map(ChatPart.fromJson)
        .toList(growable: false);
  }

  RemoteChatMessage withAttachments(List<ChatMessageAttachment> attachments) =>
      _copyWith(attachments: attachments);

  RemoteChatMessage withOrderingAt(DateTime? orderingAt) =>
      _copyWith(orderingAt: orderingAt);

  RemoteChatMessage withUpdatedAt(DateTime? updatedAt) => RemoteChatMessage(
    messageId: messageId,
    chatId: chatId,
    role: role,
    status: status,
    text: text,
    scope: scope,
    parts: parts,
    occurredAt: occurredAt,
    updatedAt: updatedAt,
    orderingAt: positionAt,
    attachments: attachments,
    delivery: delivery,
    deliveryNote: deliveryNote,
    watcherFired: watcherFired,
    continuesTurn: continuesTurn,
  );

  RemoteChatMessage _copyWith({
    List<ChatMessageAttachment>? attachments,
    DateTime? orderingAt,
  }) => RemoteChatMessage(
    messageId: messageId,
    chatId: chatId,
    role: role,
    status: status,
    text: text,
    scope: scope,
    parts: parts,
    occurredAt: occurredAt,
    updatedAt: updatedAt,
    orderingAt: orderingAt ?? positionAt,
    attachments: attachments ?? this.attachments,
    delivery: delivery,
    deliveryNote: deliveryNote,
    watcherFired: watcherFired,
    continuesTurn: continuesTurn,
  );
}

/// One host-owned message waiting behind the active turn.
class RemoteQueuedMessage {
  const RemoteQueuedMessage({
    required this.id,
    required this.text,
    required this.origin,
    required this.enqueuedAtMs,
  });

  final String id;
  final String text;
  final String origin;
  final int enqueuedAtMs;

  factory RemoteQueuedMessage.fromJson(Map<String, dynamic> json) {
    final enqueuedAtMs = json['enqueuedAtMs'];
    return RemoteQueuedMessage(
      id: _stringValue(json['id']),
      text: _stringValue(json['text']),
      origin: _stringValue(json['origin']),
      enqueuedAtMs: enqueuedAtMs is num ? enqueuedAtMs.toInt() : 0,
    );
  }

  static List<RemoteQueuedMessage>? listOrNullFromJson(Object? value) {
    if (value is! List) return null;
    return [
      for (final item in value)
        if (item is Map<String, dynamic>) RemoteQueuedMessage.fromJson(item),
    ];
  }
}

/// One chat tab row from `state.chatSummaries` (`RemoteControlChatSummaryEntity`).
class RemoteChatSummary implements ChatTabItem {
  /// Desktop-owned unread state.
  final bool? hasUnread;
  const RemoteChatSummary({
    required this.chatId,
    required this.scope,
    required this.title,
    this.description,
    this.workspaceLocalId,
    this.worktreeLocalId,
    this.order,
    this.createdAt,
    this.lastMessageAt,
    this.modelLabel,
    this.providerType,
    this.active,
    this.model,
    this.planMode,
    this.thinkingLevel,
    this.fastMode,
    this.speed,
    this.providerAvailability,
    this.availableModels = const [],
    this.modelCatalogProjected = false,
    this.pendingQuestions,
    this.queuedMessages,
    this.hasUnread,
    this.turnActive,
    this.turnElapsedMs,
    this.turnPhase,
    this.backgroundTasks,
    this.backgroundDelegations,
    this.executionHarness,
    this.modelHarnessLocked,
    this.modelAuto = false,
    this.modelRoutingSupported = false,
    this.pluginSelectionsDetail,
  });

  /// Desktop turn liveness; null means an older host omitted the signal.
  final bool? turnActive;

  /// Desktop-measured active-turn duration at summary projection time.
  final int? turnElapsedMs;

  /// Canonical turn phase; null when an older host omits it or sends an
  /// unknown phase.
  final RemoteChatTurnPhase? turnPhase;

  /// The chat's background tasks: delegations plus every provider background
  /// task. The desktop sends it with canonical turn state, zero included;
  /// null means an older host did not send it.
  final int? backgroundTasks;

  /// The queued and live managed delegations among [backgroundTasks]. Null
  /// means an older host did not send it.
  final int? backgroundDelegations;

  @override
  final String chatId;
  final RemoteChatScope? scope;
  final String title;
  final String? description;

  /// Matches the desktop chat tab label.
  @override
  String get displayTitle => description ?? title;

  /// Owning workspace local id (worktree-scoped chats only).
  final String? workspaceLocalId;

  /// Owning worktree local id (worktree-scoped chats only).
  final String? worktreeLocalId;

  /// Authoritative 0-based tab position within the worktree's chat-tab list.
  final int? order;

  /// ISO-8601 creation timestamp; secondary ordering key after [order].
  final String? createdAt;

  /// ISO-8601 timestamp of the most recent message.
  final String? lastMessageAt;
  final String? modelLabel;
  final String? providerType;

  /// True when this is the desktop's active chat for its scope.
  final bool? active;

  /// Projected composer state (CAN-1217) mirrored from the desktop chat tab so
  /// the mobile composer chips seed from and reconcile against desktop flips.

  /// Current model id (registry key), distinct from [modelLabel].
  final String? model;

  /// Whether plan mode is engaged for this chat.
  final bool? planMode;

  /// Current thinking level (`off|low|medium|high|xhigh|max|ultra`).
  final String? thinkingLevel;

  /// Whether Codex fast mode is engaged (Codex provider only). The legacy
  /// projection of [speed]: never true for Ultra fast.
  final bool? fastMode;

  /// Exact requested Codex speed (`standard | fast | ultrafast`), which wins
  /// over [fastMode]. Null when an older host omits it or sends another value.
  final String? speed;

  static const _speeds = {'standard', 'fast', 'ultrafast'};

  /// Provider availability the desktop cheaply projects from cached auth.
  final ProviderAvailability? providerAvailability;

  /// The desktop's projected model catalog for the picker; empty until the
  /// desktop has hydrated its registry.
  final List<ModelOption> availableModels;

  /// Whether the wire actually carried an `availableModels` array.
  ///
  /// Empty and absent are NOT the same thing, and the difference decides
  /// whether a selection that is missing from the catalog should be dropped:
  ///
  /// * **Absent** (`false`) — the desktop skips building the catalog entirely
  ///   when no portal client is active, and a snapshot can simply not have
  ///   hydrated yet. Nothing is known about which models are permitted.
  /// * **Explicitly empty** (`true` with an empty [availableModels]) — the
  ///   desktop built the catalog and it really is empty, e.g. an org model
  ///   policy blocked every remote model and no Ollama model is selectable.
  ///   One caveat: the desktop also projects `[]` during the brief startup
  ///   window before its model registry is initialized, so acting on this is
  ///   *usually* right rather than provably right. The cost of being wrong is
  ///   bounded — a cleared selection falls back to the desktop default, and
  ///   the host still refuses a blocked default before persisting anything.
  ///
  /// Same omission-vs-empty contract as [pendingQuestions].
  final bool modelCatalogProjected;

  /// Whether the desktop projected this chat's model catalog. A non-empty
  /// catalog implies the desktop projected the array (`fromJson` derives the
  /// flag from the same field), so deriving it here rather than trusting the
  /// flag alone stays robust against a hand-built summary that sets one
  /// without the other.
  bool get hasProjectedModelCatalog =>
      modelCatalogProjected || availableModels.isNotEmpty;

  /// Projected AskUserQuestion lifecycle for this chat
  /// (`RemoteControlChatSummaryEntity.pendingQuestions`). Null means the wire
  /// omitted the field (older desktop / partial delta) — consumers must
  /// preserve previously cached state; an empty list explicitly clears it.
  final List<AskUserQuestionState>? pendingQuestions;

  /// Host-authoritative FIFO queue. Null means an older host or partial delta
  /// omitted the field; an empty list explicitly clears the cached queue.
  final List<RemoteQueuedMessage>? queuedMessages;

  /// Desktop-captured harness of a started chat.
  /// Null for an unstarted chat or an older host.
  final String? executionHarness;

  /// False permits changing harness; absent keeps the captured-harness lock.
  final bool? modelHarnessLocked;

  /// The chat is in Auto (`modelSelectionMode: 'auto'`); [model] stays the
  /// concrete fallback. False for manual chats and older hosts.
  final bool modelAuto;

  /// The paired desktop can route this chat (`modelRoutingSupported`).
  final bool modelRoutingSupported;

  /// The chat's complete plugin selection (`pluginSelectionsDetail`). The
  /// desktop omits it when the chat has no selections.
  final Map<String, Object?>? pluginSelectionsDetail;

  factory RemoteChatSummary.fromJson(Map<String, dynamic> json) {
    final order = json['order'];
    final turnElapsedMs = json['turnElapsedMs'];
    return RemoteChatSummary(
      chatId: _stringValue(json['chatId']),
      scope: RemoteChatScope.fromWire(_stringOrNull(json['scope'])),
      title: _stringValue(json['title'], fallback: 'Untitled chat'),
      description: json['description'] is String
          ? json['description'] as String
          : null,
      workspaceLocalId: _stringOrNull(json['workspaceLocalId']),
      worktreeLocalId: _stringOrNull(json['worktreeLocalId']),
      order: order is num ? order.toInt() : null,
      createdAt: _stringOrNull(json['createdAt']),
      lastMessageAt: _stringOrNull(json['lastMessageAt']),
      modelLabel: _stringOrNull(json['modelLabel']),
      providerType: _stringOrNull(json['providerType']),
      active: _boolOrNull(json['active']),
      hasUnread: _boolOrNull(json['hasUnread']),
      turnActive: _boolOrNull(json['turnActive']),
      turnElapsedMs:
          turnElapsedMs is num && turnElapsedMs.isFinite && turnElapsedMs >= 0
          ? turnElapsedMs.toInt()
          : null,
      turnPhase: RemoteChatTurnPhase.fromWire(json['turnPhase']),
      backgroundTasks: _countOrNull(json['backgroundTasks']),
      backgroundDelegations: _countOrNull(json['backgroundDelegations']),
      model: _stringOrNull(json['model']),
      planMode: _boolOrNull(json['planMode']),
      thinkingLevel: _stringOrNull(json['thinkingLevel']),
      fastMode: _boolOrNull(json['fastMode']),
      speed: switch (json['speed']) {
        final String speed when _speeds.contains(speed) => speed,
        _ => null,
      },
      providerAvailability: ProviderAvailability.maybeFromJson(
        json['providerAvailability'],
      ),
      availableModels: ModelOption.listFromJson(json['availableModels']),
      modelCatalogProjected: json['availableModels'] is List,
      pendingQuestions: AskUserQuestionState.listOrNullFromJson(
        json['pendingQuestions'],
      ),
      queuedMessages: RemoteQueuedMessage.listOrNullFromJson(
        json['queuedMessages'],
      ),
      executionHarness: _stringOrNull(json['executionHarness']),
      modelHarnessLocked: _boolOrNull(json['modelHarnessLocked']),
      modelAuto: json['modelSelectionMode'] == 'auto',
      modelRoutingSupported: json['modelRoutingSupported'] == true,
      pluginSelectionsDetail: switch (json['pluginSelectionsDetail']) {
        final Map<String, dynamic> detail => Map.unmodifiable(detail),
        _ => null,
      },
    );
  }

  RemoteChatSummary withUnread(bool unread) => RemoteChatSummary(
    chatId: chatId,
    scope: scope,
    title: title,
    description: description,
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    order: order,
    createdAt: createdAt,
    lastMessageAt: lastMessageAt,
    modelLabel: modelLabel,
    providerType: providerType,
    active: active,
    hasUnread: unread,
    turnActive: turnActive,
    turnElapsedMs: turnElapsedMs,
    turnPhase: turnPhase,
    backgroundTasks: backgroundTasks,
    backgroundDelegations: backgroundDelegations,
    model: model,
    planMode: planMode,
    thinkingLevel: thinkingLevel,
    fastMode: fastMode,
    speed: speed,
    providerAvailability: providerAvailability,
    availableModels: availableModels,
    modelCatalogProjected: modelCatalogProjected,
    pendingQuestions: pendingQuestions,
    queuedMessages: queuedMessages,
    executionHarness: executionHarness,
    modelHarnessLocked: modelHarnessLocked,
    modelAuto: modelAuto,
    modelRoutingSupported: modelRoutingSupported,
    pluginSelectionsDetail: pluginSelectionsDetail,
  );

  /// Returns this summary, inheriting cached partial-projection fields when
  /// the wire omitted them (omission = preserve; `[]` = clear).
  RemoteChatSummary inheritPendingQuestions(RemoteChatSummary? previous) {
    final inheritedQuestions = pendingQuestions ?? previous?.pendingQuestions;
    final inheritedQueue = queuedMessages ?? previous?.queuedMessages;
    if (identical(inheritedQuestions, pendingQuestions) &&
        identical(inheritedQueue, queuedMessages)) {
      return this;
    }
    return RemoteChatSummary(
      chatId: chatId,
      scope: scope,
      title: title,
      description: description,
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      order: order,
      createdAt: createdAt,
      lastMessageAt: lastMessageAt,
      modelLabel: modelLabel,
      providerType: providerType,
      active: active,
      hasUnread: hasUnread,
      turnActive: turnActive,
      turnElapsedMs: turnElapsedMs,
      turnPhase: turnPhase,
      backgroundTasks: backgroundTasks,
      backgroundDelegations: backgroundDelegations,
      model: model,
      planMode: planMode,
      thinkingLevel: thinkingLevel,
      fastMode: fastMode,
      speed: speed,
      providerAvailability: providerAvailability,
      availableModels: availableModels,
      modelCatalogProjected: modelCatalogProjected,
      pendingQuestions: inheritedQuestions,
      queuedMessages: inheritedQueue,
      executionHarness: executionHarness,
      modelHarnessLocked: modelHarnessLocked,
      modelAuto: modelAuto,
      modelRoutingSupported: modelRoutingSupported,
      pluginSelectionsDetail: pluginSelectionsDetail,
    );
  }
}

/// Routing target for transcript requests and sends. Mirrors the two routing
/// namespaces the Portal command layer uses: worktree chats need the owning
/// workspace + worktree local ids, standalone chats just the chat id.
sealed class RemoteChatTarget {
  const RemoteChatTarget();

  RemoteChatScope get scope;

  String? get chatId;
}

/// A chat tab inside a worktree. [chatId] may be null on send, letting the
/// desktop mint a new chat thread (`RemoteControlChatSendPayload.chatId` omitted);
/// transcript requests require it.
final class RemoteWorktreeChatTarget extends RemoteChatTarget {
  const RemoteWorktreeChatTarget({
    required this.workspaceLocalId,
    required this.worktreeLocalId,
    this.chatId,
  });

  final String workspaceLocalId;
  final String worktreeLocalId;
  @override
  final String? chatId;

  @override
  RemoteChatScope get scope => RemoteChatScope.worktree;
}

/// A standalone (cowork) chat.
final class RemoteStandaloneChatTarget extends RemoteChatTarget {
  const RemoteStandaloneChatTarget({required this.chatId, this.projectLocalId});

  @override
  final String chatId;

  @override
  RemoteChatScope get scope => RemoteChatScope.standalone;

  /// The owning chat-project's local id, when known.
  final String? projectLocalId;
}

/// Result of a chat send (`SubmitBrowserRemoteControlCommandResponse` subset).
/// Optional composer selections and input metadata carried with a chat send.
/// An unset field stays off the wire so the desktop's persisted defaults keep
/// applying.
class RemoteChatSendOptions {
  const RemoteChatSendOptions({
    this.userMessageId,
    this.model,
    this.providerType,
    this.executionHarness,
    this.planMode,
    this.thinkingLevel,
    this.fastMode,
    this.inputMode,
    this.attachments,
  });

  /// Client-owned identity used to reconcile the authoritative user echo.
  final String? userMessageId;
  final String? model;
  final String? providerType;

  /// Local setup intent, applied with set-model before sending; never a send payload field.
  final String? executionHarness;
  final bool? planMode;
  final String? thinkingLevel;
  final bool? fastMode;

  /// `'voice'` when the draft was dictated; the desktop marks such messages
  /// with a mic badge. Omitted for typed drafts.
  final String? inputMode;

  /// Ready uploads sent as `cloudAttachments` for either chat scope.
  final List<ChatAttachmentRef>? attachments;

  bool get isEmpty =>
      userMessageId == null &&
      model == null &&
      providerType == null &&
      executionHarness == null &&
      planMode == null &&
      thinkingLevel == null &&
      fastMode == null &&
      inputMode == null &&
      attachments == null;

  RemoteChatSendOptions copyWith({
    String? userMessageId,
    String? inputMode,
    List<ChatAttachmentRef>? attachments,
  }) => RemoteChatSendOptions(
    userMessageId: userMessageId ?? this.userMessageId,
    model: model,
    providerType: providerType,
    executionHarness: executionHarness,
    planMode: planMode,
    thinkingLevel: thinkingLevel,
    fastMode: fastMode,
    inputMode: inputMode ?? this.inputMode,
    attachments: attachments ?? this.attachments,
  );

  RemoteChatSendOptions withoutModelSelection() => RemoteChatSendOptions(
    userMessageId: userMessageId,
    planMode: planMode,
    thinkingLevel: thinkingLevel,
    fastMode: fastMode,
    inputMode: inputMode,
    attachments: attachments,
  );
}

/// One page of lazily-loaded transcript history
/// (`RemoteControlChatHistoryChunk` from `POST .../chat/history`): turn-aligned
/// messages in ascending order plus the opaque cursor for the next-older
/// page (`null` when the transcript start was reached).
class RemoteChatHistoryChunk {
  const RemoteChatHistoryChunk({required this.messages, this.nextCursor});

  final List<RemoteChatMessage> messages;
  final String? nextCursor;
}

class RemoteChatSendResult {
  const RemoteChatSendResult({
    required this.commandId,
    this.chatId,
    this.queuedWhileReconnecting = false,
  });

  final String commandId;

  /// Canonical chat thread id echoed by the desktop; present when the send
  /// resolved (or created) the chat within the submit round trip.
  final String? chatId;

  /// True when the desktop was reconnecting at submit time — the message is
  /// queued and delivers when it resumes polling.
  final bool queuedWhileReconnecting;

  factory RemoteChatSendResult.fromJson(Map<String, dynamic> json) =>
      RemoteChatSendResult(
        commandId: _stringValue(json['commandId']),
        chatId: _stringOrNull(json['chatId']),
        queuedWhileReconnecting:
            _boolOrNull(json['queuedWhileReconnecting']) ?? false,
      );
}

String? _stringOrNull(Object? value) => value is String ? value : null;

String _stringValue(Object? value, {String fallback = ''}) =>
    _stringOrNull(value) ?? fallback;

bool? _boolOrNull(Object? value) => value is bool ? value : null;

// Dart DateTime supports ±100,000,000 days from the Unix epoch.
const int _maxDateTimeEpochMilliseconds = 8640000000000000;

DateTime? _dateTimeFromEpochMilliseconds(Object? value) {
  if (value is! num || !value.isFinite) return null;
  if (value < -_maxDateTimeEpochMilliseconds ||
      value > _maxDateTimeEpochMilliseconds) {
    return null;
  }
  return DateTime.fromMillisecondsSinceEpoch(value.toInt());
}

/// A non-negative whole count, or null when the wire sent none.
int? _countOrNull(Object? value) =>
    value is num && value.isFinite && value >= 0 ? value.toInt() : null;

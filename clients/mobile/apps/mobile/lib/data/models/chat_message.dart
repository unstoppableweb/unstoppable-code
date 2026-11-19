/// Provider-neutral chat transcript models shared by every mobile chat
/// computer chat surface.
///
/// These mirror the Portal chat wire contract in
/// `packages/protocol/src/remote-control/shell/index.ts` (`RemoteControlChatPart`,
/// `RemoteControlAskUserQuestion*`, `ModelCatalogOption`), but carry nothing that is
/// specific to one transport. Remote Control adds its own fields by
/// subclassing (`RemoteChatMessage`); Computer Connect maps desktop rows onto these
/// types directly. Parsing is null-tolerant: unknown kinds degrade, never drop.
///
/// This file must stay free of feature and data-access imports — see
/// `test/architecture/chat_boundary_test.dart`.
library;

import 'dart:convert';
import 'agent_catalog_selection.dart';

/// Sender role on a chat message (`RemoteControlChatMessage.role`).
enum ChatRole {
  user('user'),
  assistant('assistant'),
  system('system');

  const ChatRole(this.wire);

  final String wire;

  /// Parses a wire value, returning `null` for absent/unknown values so the
  /// renderer can fall back to a neutral treatment.
  static ChatRole? fromWire(String? wire) {
    if (wire == null) return null;
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return null;
  }
}

/// Lifecycle of a chat message (`RemoteControlChatMessage.status`).
enum ChatMessageStatus {
  streaming('streaming'),
  complete('complete'),
  failed('failed'),
  cancelled('cancelled');

  const ChatMessageStatus(this.wire);

  final String wire;

  /// Parses a wire value, returning `null` for absent/unknown values.
  static ChatMessageStatus? fromWire(String? wire) {
    if (wire == null) return null;
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    return null;
  }
}

/// Local delivery state for a user message the host has not confirmed
/// (CAN-3556). Null for every host-projected row.
enum ChatDelivery { notSent, uncertain }

/// One rich content block inside a message's `parts` array
/// (`RemoteControlChatPart`). `kind` and `toolFamily` are kept as raw wire strings —
/// the closed enums grow over time and an unknown block should degrade to a
/// generic chip, not be dropped.
class ChatPart {
  const ChatPart({required this.kind, this.toolFamily, this.data});

  /// Wire kind: `tool_use | tool_result | thinking | attachment | image |
  /// agent | turn_timer` (open set).
  final String kind;

  /// Canonical tool family for `tool_use` parts (`read`, `bash`, `edit`, ...).
  final String? toolFamily;

  /// Free-form per-part payload; shape depends on [kind].
  final Map<String, dynamic>? data;

  factory ChatPart.fromJson(Map<String, dynamic> json) {
    final rawData = json['data'];
    return ChatPart(
      kind: _stringValue(json['kind'], fallback: 'unknown'),
      toolFamily: _stringOrNull(json['toolFamily']),
      data: rawData is Map<String, dynamic> ? rawData : null,
    );
  }

  /// The tool's own name for `tool_use` parts, checked across the key
  /// spellings the projector has used (mirrors the web run viewer's
  /// `toolNameOf` defensiveness).
  String? get toolName {
    final name =
        _stringOrNull(data?['toolName']) ?? _stringOrNull(data?['name']);
    return name != null && name.isNotEmpty ? name : null;
  }

  /// Captured reasoning text for `thinking` parts. Both the live runtime
  /// projector and the persisted-history projection carry it as `data.text`;
  /// `data.thinking` is a defensive fallback. Null when absent or blank.
  String? get thinkingText {
    final text =
        _stringOrNull(data?['text']) ?? _stringOrNull(data?['thinking']);
    return text != null && text.trim().isNotEmpty ? text : null;
  }

  /// Correlates a `tool_use` part with its `tool_result` — both carry
  /// `data.toolUseId` on the wire.
  String? get toolUseId => _stringOrNull(data?['toolUseId']);

  /// The serialized tool input for `tool_use` parts. The runtime projector
  /// sends a (possibly truncated) JSON string; the persisted projection can
  /// carry a decoded object, which is re-serialized here.
  String? get toolInput {
    final input = data?['input'];
    if (input is String) return input.isEmpty ? null : input;
    if (input == null) return null;
    try {
      return jsonEncode(input);
    } on Object {
      return input.toString();
    }
  }

  /// The captured output text for `tool_result` parts. Null when absent or
  /// blank.
  String? get toolOutput {
    final output = _stringOrNull(data?['output']);
    return output != null && output.trim().isNotEmpty ? output : null;
  }

  /// True when a `tool_result` part carries an error outcome.
  bool get isToolError => data?['isError'] == true;

  /// Best-effort human label for a tool part: the tool's own name when the
  /// projector carried one, else the canonical family (when meaningful),
  /// else a generic label — never the raw `unknown` wire value.
  String get displayLabel {
    final name = toolName;
    if (name != null) return name;
    final family = toolFamily;
    if (family != null && family.isNotEmpty && family != 'unknown') {
      return family;
    }
    return kind == 'tool_use' || kind == 'tool_result' ? 'Tool' : kind;
  }
}

/// One question inside an AskUserQuestion request (`RemoteControlAskUserQuestion`).
class AskUserQuestion {
  const AskUserQuestion({
    this.id,
    this.header,
    required this.question,
    this.options = const [],
    this.multiSelect = false,
    this.optionDescriptions = const [],
    this.allowOther = true,
    this.secret = false,
  });

  /// Stable question id; multi-question prompts key answers on it.
  final String? id;

  /// Short heading shown above the question, when present.
  final String? header;
  final String question;

  /// Selectable choices.
  final List<String> options;
  final bool multiSelect;

  /// Index-aligned helper text for [options]; may be shorter than [options].
  final List<String> optionDescriptions;

  /// Whether a freeform "other" answer is permitted.
  final bool allowOther;

  /// Whether the answer is sensitive: the composer obscures input and the
  /// desktop redacts the projected answer.
  final bool secret;

  factory AskUserQuestion.fromJson(Map<String, dynamic> json) =>
      AskUserQuestion(
        id: _stringOrNull(json['id']),
        header: _stringOrNull(json['header']),
        question: _stringValue(json['question']),
        options: _stringList(json['options']),
        multiSelect: _boolOrNull(json['multiSelect']) ?? false,
        optionDescriptions: _stringList(json['optionDescriptions']),
        allowOther: _boolOrNull(json['allowOther']) ?? true,
        secret: _boolOrNull(json['secret']) ?? false,
      );
}

/// An answer to one [AskUserQuestion] (`RemoteControlAskUserQuestionAnswer`).
/// Sent raw on `portal.chat.answer_question`; received display-safe (secrets
/// redacted to `[hidden]`) inside [AskUserQuestionState.answers].
class AskUserQuestionAnswer {
  const AskUserQuestionAnswer({
    this.questionId,
    required this.question,
    this.selectedOptions = const [],
    this.freeformText,
  });

  final String? questionId;
  final String question;
  final List<String> selectedOptions;
  final String? freeformText;

  factory AskUserQuestionAnswer.fromJson(Map<String, dynamic> json) =>
      AskUserQuestionAnswer(
        questionId: _stringOrNull(json['questionId']),
        question: _stringValue(json['question']),
        selectedOptions: _stringList(json['selectedOptions']),
        freeformText: _stringOrNull(json['freeformText']),
      );

  /// Wire shape for the `portal.chat.answer_question` payload.
  Map<String, dynamic> toJson() => {
    'questionId': ?questionId,
    'question': question,
    'selectedOptions': selectedOptions,
    'freeformText': ?freeformText,
  };
}

/// Projected lifecycle of one AskUserQuestion request
/// (`RemoteControlAskUserQuestionState`, carried on
/// `RemoteControlChatSummaryEntity.pendingQuestions`). Awaiting entries have
/// `answered == false`; dismissed/expired requests are removed from the array
/// rather than kept as answered entries.
class AskUserQuestionState {
  const AskUserQuestionState({
    required this.requestId,
    this.toolUseId,
    this.questions = const [],
    this.answered = false,
    this.answers = const [],
  });

  /// Authoritative correlation key for the answer/dismiss commands.
  final String requestId;

  /// Matches the card to a transcript `tool_use` block, when present.
  final String? toolUseId;
  final List<AskUserQuestion> questions;
  final bool answered;

  /// Display-safe answers, present once [answered].
  final List<AskUserQuestionAnswer> answers;

  factory AskUserQuestionState.fromJson(Map<String, dynamic> json) {
    final questions = json['questions'];
    final answers = json['answers'];
    return AskUserQuestionState(
      requestId: _stringValue(json['requestId']),
      toolUseId: _stringOrNull(json['toolUseId']),
      questions: questions is List
          ? questions
                .whereType<Map<String, dynamic>>()
                .map(AskUserQuestion.fromJson)
                .toList(growable: false)
          : const [],
      answered: _boolOrNull(json['answered']) ?? false,
      answers: answers is List
          ? answers
                .whereType<Map<String, dynamic>>()
                .map(AskUserQuestionAnswer.fromJson)
                .toList(growable: false)
          : const [],
    );
  }

  /// Parses a `pendingQuestions` array. Absence is meaningful on this field
  /// (omission = preserve cached state, `[]` = clear), so non-list input
  /// yields null rather than an empty list.
  static List<AskUserQuestionState>? listOrNullFromJson(Object? value) =>
      value is List
      ? value
            .whereType<Map<String, dynamic>>()
            .map(AskUserQuestionState.fromJson)
            .toList(growable: false)
      : null;
}

/// Display-only file attached to a chat message. JSON keys match the Portal
/// wire contract; the bytes remain with the owning transport.
class ChatMessageAttachment {
  const ChatMessageAttachment({
    required this.attachmentId,
    required this.filename,
    required this.mediaType,
    this.size,
  });

  final String attachmentId;
  final String filename;
  final String mediaType;
  final int? size;

  static ChatMessageAttachment? fromJsonOrNull(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final attachmentId = _stringOrNull(value['attachmentId']);
    final filename = _stringOrNull(value['filename']);
    final mediaType = _stringOrNull(value['mediaType']);
    if (attachmentId == null || attachmentId.isEmpty) return null;
    if (filename == null || filename.isEmpty) return null;
    if (mediaType == null || mediaType.isEmpty) return null;
    final size = value['size'];
    return ChatMessageAttachment(
      attachmentId: attachmentId,
      filename: filename,
      mediaType: mediaType,
      size: size is num ? size.toInt() : null,
    );
  }

  static List<ChatMessageAttachment> listFromJson(Object? value) {
    if (value is! List) return const [];
    final seen = <String>{};
    return [
      for (final entry in value)
        if (fromJsonOrNull(entry) case final attachment?)
          if (seen.add(attachment.attachmentId)) attachment,
    ];
  }
}

/// Marker on a user message a fired watcher posted (`ChatWatcherFiredInfo`
/// in `packages/protocol/src/remote-control/shell/input-delivery.ts`). [kind] names the
/// watcher, rendered as "`kind` watcher has fired".
class ChatWatcherFiredInfo {
  const ChatWatcherFiredInfo({required this.kind, this.combinedWatchers});

  final String kind;

  /// The watcher messages merged into this one. When non-empty, [kind] is
  /// the aggregate title, such as "Multiple watchers fired (2)".
  final List<ChatWatcherFiredEntry>? combinedWatchers;

  bool get isMerged => combinedWatchers?.isNotEmpty ?? false;

  /// Mirrors `parseChatWatcherFiredInfo`: one malformed merged entry
  /// rejects the whole marker.
  static ChatWatcherFiredInfo? fromJsonOrNull(Object? value) {
    if (value is! Map<String, dynamic>) return null;
    final kind = value['kind'];
    if (kind is! String) return null;
    if (!value.containsKey('combinedWatchers')) {
      return ChatWatcherFiredInfo(kind: kind);
    }
    final combined = value['combinedWatchers'];
    if (combined is! List) return null;
    final entries = <ChatWatcherFiredEntry>[];
    for (final entry in combined) {
      if (entry is! Map<String, dynamic>) return null;
      final (entryKind, text) = (entry['kind'], entry['text']);
      if (entryKind is! String || text is! String) return null;
      entries.add(ChatWatcherFiredEntry(kind: entryKind, text: text));
    }
    return ChatWatcherFiredInfo(
      kind: kind,
      combinedWatchers: List.unmodifiable(entries),
    );
  }

  /// Mirrors `readChatWatcherFired`: a valid [topLevel] marker, else the
  /// copy cached history keeps in the `prompt_source` part.
  static ChatWatcherFiredInfo? read(Object? topLevel, List<ChatPart> parts) {
    if (fromJsonOrNull(topLevel) case final marker?) return marker;
    for (final part in parts) {
      if (part.kind != 'prompt_source') continue;
      if (fromJsonOrNull(part.data?['watcherFired']) case final marker?) {
        return marker;
      }
    }
    return null;
  }

  Map<String, Object?> toJson() => {
    'kind': kind,
    'combinedWatchers': ?combinedWatchers
        ?.map((entry) => {'kind': entry.kind, 'text': entry.text})
        .toList(),
  };
}

/// One watcher message inside a merged [ChatWatcherFiredInfo].
class ChatWatcherFiredEntry {
  const ChatWatcherFiredEntry({required this.kind, required this.text});

  final String kind;
  final String text;
}

/// Normalized chat message rendered by the shared transcript widgets.
class ChatMessage {
  const ChatMessage({
    required this.messageId,
    required this.chatId,
    required this.role,
    required this.status,
    required this.text,
    this.parts = const [],
    this.occurredAt,
    this.attachments = const [],
    this.delivery,
    this.deliveryNote,
    this.watcherFired,
    this.continuesTurn = false,
  });

  final String messageId;
  final String chatId;
  final ChatRole? role;
  final ChatMessageStatus? status;

  /// Plain-text content. Tool/thinking blocks live in [parts] and never erase
  /// text (mirrors the projection rules on `RemoteControlChatMessage`).
  final String text;
  final List<ChatPart> parts;

  /// Best-known wall-clock timestamp for display ordering fallbacks.
  final DateTime? occurredAt;

  /// Stable transcript position, independent of later live revisions.
  DateTime? get positionAt => occurredAt;

  /// Files attached to this message.
  final List<ChatMessageAttachment> attachments;

  /// Set only on local rows for sends the host has not confirmed.
  final ChatDelivery? delivery;

  /// Why the send failed, shown under the delivery label when present.
  final String? deliveryNote;

  /// Set on a user message a fired watcher posted; [text] is then only the
  /// visible notice.
  final ChatWatcherFiredInfo? watcherFired;

  /// Host-marked steering or an answer that belongs to the current turn.
  final bool continuesTurn;

  /// True while the producer is still streaming this message.
  bool get isStreaming => status == ChatMessageStatus.streaming;
}

/// One selectable row of the desktop's projected model catalog
/// (`ModelCatalogOption`): a plain provider model or a custom Agent.
class ModelOption {
  const ModelOption({
    required this.id,
    required this.label,
    required this.provider,
    required this.kind,
    required this.available,
    this.description,
    this.agentSelection,
    this.vendor,
    this.extraChargeOnly = false,
    this.extraChargeMessage,
    this.supportedThinkingLevels,
    this.thinkingLevels,
    this.harnessThinkingLevels = const {},
    this.harnessProviders = const {},
    this.harnessFastModes = const {},
    this.harnessContextWindows = const {},
    this.isDefault = false,
    this.supportsFastMode,
    this.showMoreOnly = false,
    this.source,
    this.harness,
    this.family,
    this.familyLabel,
    this.contextWindow,
    this.sortOrder,
    this.unavailableReason,
  });

  /// True when this row is the desktop's current default model
  /// (`ModelCatalogOption.isDefault`) — what an untouched composer will
  /// actually run.
  final bool isDefault;

  /// The row's canonical effort levels
  /// (`ModelCatalogOption.supportedThinkingLevels`), exactly as declared.
  /// Null when the host omitted the field; an empty list means the model
  /// does not think, so the effort control hides.
  final List<String>? supportedThinkingLevels;

  /// Legacy per-model levels (`ModelCatalogOption.thinkingLevels`, CAN-2441)
  /// from hosts that predate [supportedThinkingLevels]. Null when omitted.
  /// Unknown entries are dropped on parse, mirroring the web client.
  final List<String>? thinkingLevels;

  /// Declared levels per execution harness, from the row's `harnessChoices`
  /// entries that declare their own `supportedThinkingLevels`.
  final Map<String, List<String>> harnessThinkingLevels;
  final Map<String, String> harnessProviders;
  final Map<String, bool> harnessFastModes;
  final Map<String, int> harnessContextWindows;

  /// Keep source identity and display facts while choosing a compatible runtime.
  ModelOption forExecution({
    required String selection,
    String? executionHarness,
  }) => ModelOption(
    id: selection,
    label: label,
    provider: provider == 'ollama'
        ? provider
        : harnessProviders[executionHarness] ?? executionHarness ?? provider,
    kind: selection.startsWith('agent_model_') ? 'agent' : 'model',
    available: available,
    agentSelection: agentSelection,
    description: description,
    vendor: vendor,
    extraChargeOnly: extraChargeOnly,
    extraChargeMessage: extraChargeMessage,
    supportedThinkingLevels:
        harnessThinkingLevels[executionHarness] ??
        (executionHarness == null || executionHarness == (harness ?? provider)
            ? supportedThinkingLevels
            : null),
    thinkingLevels:
        executionHarness == null || executionHarness == (harness ?? provider)
        ? thinkingLevels
        : null,
    harnessThinkingLevels: harnessThinkingLevels,
    harnessProviders: harnessProviders,
    harnessFastModes: harnessFastModes,
    harnessContextWindows: harnessContextWindows,
    isDefault: isDefault,
    supportsFastMode:
        harnessFastModes[executionHarness] ??
        (executionHarness == null || executionHarness == (harness ?? provider)
            ? supportsFastMode
            : null),
    showMoreOnly: showMoreOnly,
    source: source,
    harness: executionHarness ?? harness,
    family: family,
    familyLabel: familyLabel,
    contextWindow:
        harnessContextWindows[executionHarness] ??
        (executionHarness == null || executionHarness == (harness ?? provider)
            ? contextWindow
            : null),
    sortOrder: sortOrder,
    unavailableReason: unavailableReason,
  );

  static const Set<String> _knownThinkingLevels = {
    'off',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
  };

  final String id;
  final String label;
  final AgentCatalogSelection? agentSelection;

  /// Short catalog blurb for the row, when the desktop projection sends one.
  /// Optional so an older host that omits it parses unchanged.
  final String? description;

  /// Owning provider (`'claude' | 'codex' | 'ollama' | 'cursor'`).
  final String provider;

  /// Catalog vendor, distinct from the execution provider.
  final String? vendor;

  /// `'model'` for a plain provider model, `'agent'` for a custom Agent.
  final String kind;

  /// Whether the row is selectable on its own merits; custom Agents are false
  /// when their base model is unavailable.
  final bool available;

  /// Whether selecting this model can incur charges outside the user's
  /// included allowance, plus the catalog-provided explanation when present.
  final bool extraChargeOnly;
  final String? extraChargeMessage;

  /// Whether the catalog says this model can run in Fast mode
  /// (`ModelCatalogOption.supportsFastMode`). Null when the source did not
  /// say; callers fall back to their own provider rule.
  final bool? supportsFastMode;

  /// Older models the picker keeps in a collapsed Legacy group.
  final bool showMoreOnly;

  /// Catalog source (`'claude'`, `'codex'`, `'ai-gateway'`, ...). Null when
  /// the host predates the field.
  final String? source;

  /// Execution harness that runs the row, mainly for AI Gateway rows.
  final String? harness;
  final String? family;
  final String? familyLabel;

  /// Declared context window in tokens; null unless positive.
  final int? contextWindow;

  /// Host catalog order; null when the host did not send one.
  final double? sortOrder;

  /// Why an unavailable row cannot run (`'base_model_unavailable'`).
  final String? unavailableReason;

  factory ModelOption.fromJson(Map<String, dynamic> json) => ModelOption(
    id: _stringValue(json['id']),
    label: _stringValue(json['label'], fallback: _stringValue(json['id'])),
    provider: _stringValue(json['provider']),
    kind: _stringValue(json['kind'], fallback: 'model'),
    available: _boolOrNull(json['available']) ?? json['kind'] != 'agent',
    agentSelection: json.containsKey('agentSelection')
        ? AgentCatalogSelection.read(json['agentSelection'])
        : null,
    description: _stringOrNull(json['description']),
    vendor: _stringOrNull(json['vendor']),
    extraChargeOnly: _boolOrNull(json['extraChargeOnly']) ?? false,
    extraChargeMessage: _stringOrNull(json['extraChargeMessage']),
    supportedThinkingLevels: _thinkingLevelsFromJson(
      json['supportedThinkingLevels'],
    ),
    thinkingLevels: _thinkingLevelsFromJson(json['thinkingLevels']),
    harnessThinkingLevels: _harnessThinkingLevelsFromJson(
      json['harnessChoices'],
    ),
    harnessProviders: {
      for (final choice
          in (json['harnessChoices'] is List
                  ? json['harnessChoices'] as List
                  : const [])
              .whereType<Map>())
        if ((choice['harness'], choice['provider']) case (
          final String harness,
          final String provider,
        ))
          harness: provider,
    },
    harnessFastModes: {
      for (final choice
          in (json['harnessChoices'] is List
                  ? json['harnessChoices'] as List
                  : const [])
              .whereType<Map>())
        if ((choice['harness'], choice['supportsFastMode']) case (
          final String harness,
          final bool fast,
        ))
          harness: fast,
    },
    harnessContextWindows: {
      for (final choice
          in (json['harnessChoices'] is List
                  ? json['harnessChoices'] as List
                  : const [])
              .whereType<Map>())
        if ((choice['harness'], choice['contextWindow']) case (
          final String harness,
          final int window,
        ))
          harness: window,
    },
    isDefault: _boolOrNull(json['isDefault']) ?? false,
    supportsFastMode: _boolOrNull(json['supportsFastMode']),
    showMoreOnly: _boolOrNull(json['showMoreOnly']) ?? false,
    source: _stringOrNull(json['source']),
    harness: _stringOrNull(json['harness']),
    family: _stringOrNull(json['family']),
    familyLabel: _stringOrNull(json['familyLabel']),
    contextWindow: switch (json['contextWindow']) {
      final num value when value.isFinite && value > 0 => value.toInt(),
      _ => null,
    },
    sortOrder: switch (json['sortOrder']) {
      final num value when value.isFinite => value.toDouble(),
      _ => null,
    },
    unavailableReason: _stringOrNull(json['unavailableReason']),
  );

  /// Null for an absent field; an explicit empty list stays empty.
  static List<String>? _thinkingLevelsFromJson(Object? value) {
    if (value is! List) return null;
    return List.unmodifiable([
      for (final entry in value)
        if (entry is String && _knownThinkingLevels.contains(entry)) entry,
    ]);
  }

  static Map<String, List<String>> _harnessThinkingLevelsFromJson(
    Object? value,
  ) {
    if (value is! List) return const {};
    return Map.unmodifiable({
      for (final choice in value.whereType<Map<String, dynamic>>())
        if ((
              _stringOrNull(choice['harness']),
              _thinkingLevelsFromJson(choice['supportedThinkingLevels']),
            )
            case (final String harness, final List<String> levels))
          harness: levels,
    });
  }

  /// Parses the `availableModels` array; non-list input yields an empty list.
  static List<ModelOption> listFromJson(Object? value) => value is List
      ? value
            .whereType<Map<String, dynamic>>()
            .map(ModelOption.fromJson)
            .toList(growable: false)
      : const [];
}

/// Provider native-auth availability the desktop cheaply projects
/// (`RemoteControlChatProviderAvailability`). An omitted `claude`/`codex`/`ollama`
/// key means "unknown" (native-auth cache cold) and is treated optimistically
/// as available, matching the desktop/web projection's existing intent for
/// those three. `cursor` is different: it is a managed runtime that must be
/// explicitly confirmed supported, enabled, and installed on the paired
/// desktop before a remote send can succeed, so an omitted/unknown `cursor`
/// key fails closed instead — selectable only once the desktop has actually
/// confirmed the runtime (mirrors the web portal picker's
/// `providerAvailability?.cursor !== true` fail-closed check). `copilot`
/// fails closed the same way (`providerAvailability?.copilot !== true`).
class ProviderAvailability {
  const ProviderAvailability({
    this.claude,
    this.codex,
    this.ollama,
    this.cursor,
    this.copilot,
  });

  final bool? claude;
  final bool? codex;
  final bool? ollama;
  final bool? cursor;
  final bool? copilot;

  /// Whether [provider] is selectable. `claude`/`codex`/`ollama` treat an
  /// unknown/absent value as optimistically available; `cursor` and
  /// `copilot` fail closed on unknown/absent, matching their "explicitly
  /// confirmed only" contract.
  bool isAvailable(String provider) => switch (provider) {
    'claude' => claude ?? true,
    'codex' => codex ?? true,
    'ollama' => ollama ?? true,
    'cursor' => cursor ?? false,
    'copilot' => copilot ?? false,
    _ => true,
  };

  factory ProviderAvailability.fromJson(Map<String, dynamic> json) =>
      ProviderAvailability(
        claude: _boolOrNull(json['claude']),
        codex: _boolOrNull(json['codex']),
        ollama: _boolOrNull(json['ollama']),
        cursor: _boolOrNull(json['cursor']),
        copilot: _boolOrNull(json['copilot']),
      );

  static ProviderAvailability? maybeFromJson(Object? value) =>
      value is Map<String, dynamic>
      ? ProviderAvailability.fromJson(value)
      : null;
}

String? _stringOrNull(Object? value) => value is String ? value : null;

String _stringValue(Object? value, {String fallback = ''}) =>
    _stringOrNull(value) ?? fallback;

bool? _boolOrNull(Object? value) => value is bool ? value : null;

List<String> _stringList(Object? value) => value is List
    ? value.whereType<String>().toList(growable: false)
    : const [];

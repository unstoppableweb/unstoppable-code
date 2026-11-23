import 'dart:async';
import 'dart:convert';

import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/agent_catalog_selection.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/composer_command.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/device_link/chats/dto.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/settings_catalog.dart';
import 'package:mobile/device_link/chats/state.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/rust_core/value_codec.dart';
import 'package:mobile/ui/core/chat/view_models/composer_menu_controller.dart';
import 'package:mobile/ui/core/chat/view_models/composer_plugins_controller.dart';

import '../../chats_view_model.dart';
import '../composer_model.dart';
import 'rust_chats.dart';

Object? _decode(String json) =>
    deviceChatDto(decodeRustValue(jsonDecode(json)));

DeviceChatRef _chat(core.ChatRefView v) => DeviceChatRef(
  projectId: v.projectId,
  worktreeId: v.worktreeId,
  id: v.id,
  title: v.title,
);

/// No cached invocation text is safe without the host's chat-aware resolver.
/// See the CAN-5792 audit for the missing effective-selection boundary.
const _invocableUnavailable =
    'Choose this skill or command in the desktop app.';

/// The existing tunneled settings patch lacks an atomic selection guard.
const _pluginSelectionsReadOnly =
    'Catalog only. Change selections in the desktop app.';

/// [row] as the shared composer widgets read it.
ModelOption modelOption(core.ModelRowView row) => ModelOption(
  id: row.id,
  label: row.label,
  provider: row.provider,
  kind: row.kind,
  available: row.available,
  description: row.description,
  agentSelection: switch (row.agentSelection) {
    final a? => AgentCatalogSelection(
      preferredModel: a.preferredModel,
      supportedModels: Map.unmodifiable({
        for (final m in a.supportedModels)
          m.modelId: List<String>.unmodifiable(m.harnesses),
      }),
    ),
    null => null,
  },
  vendor: row.vendor,
  extraChargeOnly: row.extraChargeOnly,
  extraChargeMessage: row.extraChargeMessage,
  supportedThinkingLevels: switch (row.supportedThinkingLevels) {
    final l? => List.unmodifiable(l),
    null => null,
  },
  thinkingLevels: switch (row.thinkingLevels) {
    final l? => List.unmodifiable(l),
    null => null,
  },
  harnessThinkingLevels: Map.unmodifiable({
    for (final c in row.harnessChoices)
      if (c.thinkingLevels case final l?)
        c.harness: List<String>.unmodifiable(l),
  }),
  harnessProviders: {
    for (final c in row.harnessChoices) c.harness: ?c.provider,
  },
  harnessFastModes: {
    for (final c in row.harnessChoices) c.harness: ?c.fastMode,
  },
  harnessContextWindows: {
    for (final c in row.harnessChoices) c.harness: ?c.contextWindow,
  },
  isDefault: row.isDefault,
  supportsFastMode: row.supportsFastMode,
  showMoreOnly: row.showMoreOnly,
  source: row.source,
  harness: row.harness,
  family: row.family,
  familyLabel: row.familyLabel,
  contextWindow: row.contextWindow,
  sortOrder: row.sortOrder,
  unavailableReason: row.unavailableReason,
);

final _models = Expando<List<ModelOption>>('models');

/// [rows] as shared catalog rows, mapped once per list the core sent.
List<ModelOption> modelOptions(List<core.ModelRowView> rows) =>
    _models[rows] ??= List.unmodifiable(rows.map(modelOption));

ProviderAvailability? availabilityOf(core.AvailabilityView? v) => v == null
    ? null
    : ProviderAvailability(
        claude: v.claude,
        codex: v.codex,
        ollama: v.ollama,
        cursor: v.cursor,
        copilot: v.copilot,
      );

final _questions = Expando<List<AskUserQuestionState>>('questions');

/// The core's questions as the shared question card reads them, mapped once
/// per view.
List<AskUserQuestionState> askStates(List<core.QuestionView> views) =>
    _questions[views] ??= List.unmodifiable([
      for (final q in views)
        AskUserQuestionState(
          requestId: q.requestId,
          toolUseId: q.toolUseId,
          questions: List.unmodifiable([
            for (final i in q.questions)
              AskUserQuestion(
                id: i.id,
                header: i.header,
                question: i.question,
                options: List.unmodifiable(i.options),
                multiSelect: i.multiSelect,
                optionDescriptions: List.unmodifiable(i.optionDescriptions),
                allowOther: i.allowOther,
                secret: i.secret,
              ),
          ]),
          answered: q.answered,
          answers: List.unmodifiable([
            for (final a in q.answers)
              AskUserQuestionAnswer(
                questionId: a.questionId,
                question: a.question,
                selectedOptions: List.unmodifiable(a.selectedOptions),
                freeformText: a.freeformText,
              ),
          ]),
        ),
    ]);

/// The settings catalog the core read (P5c).
final class RustChatSettingsCatalog implements DeviceChatSettingsCatalog {
  RustChatSettingsCatalog(this.reader);
  final RustChatReader reader;
  core.ComposerView? get _view => reader.composer;

  @override
  String? get scopeKey => _view?.catalogKey;
  @override
  List<ModelOption> get models =>
      _view == null ? const [] : modelOptions(_view!.models);
  @override
  ProviderAvailability? get providerAvailability =>
      availabilityOf(_view?.providerAvailability);
  @override
  String? get executionHarness => _view?.executionHarness;
  @override
  String? get modelLabel => _view?.modelLabel;
  @override
  String? get defaultModelId => _view?.defaultModelId;
  @override
  String? get defaultThinkingLevel => _view?.defaultThinkingLevel;
  @override
  bool get modelRoutingSupported => _view?.routingSupported ?? false;
  @override
  bool? get modelHarnessLocked => _view?.harnessLocked;
  @override
  bool get loading => _view?.catalogLoading ?? false;
  @override
  bool get loaded => _view?.catalogLoaded ?? false;

  @override
  Future<void> load(DeviceChatRef ref) =>
      reader.settle(const core.ChatIntent.loadSettings(report: false));

  Future<int> _saved(core.ChatIntent intent) async {
    final settled = await reader.settle(intent);
    return switch (settled.outcome) {
      core.ChatOutcome_Saved(:final revision) => revision,
      _ => throw const FormatException('Missing chat revision'),
    };
  }

  @override
  Future<int> selectModel(DeviceChatRef ref, ModelOption choice) => _saved(
    core.ChatIntent.selectModel(
      chat: RustChatReader.chatRefView(ref),
      id: choice.id,
      provider: choice.provider,
      harness: choice.harness,
    ),
  );

  @override
  Future<int> selectAuto(DeviceChatRef ref) => _saved(
    core.ChatIntent.patchSettings(
      chat: RustChatReader.chatRefView(ref),
      patchJson: jsonEncode({'modelSelectionMode': 'auto'}),
    ),
  );

  @override
  Future<int> patch(DeviceChatRef ref, Map<String, dynamic> patch) => _saved(
    core.ChatIntent.patchSettings(
      chat: RustChatReader.chatRefView(ref),
      patchJson: jsonEncode(patch),
    ),
  );
}

/// The selected chat's composer on the core's [core.ChatsService] (P5c):
/// the core reads the settings catalog when the chat changes (in order
/// with the open's own reads), queues and saves the picks, computes the
/// controls and the picker, answers questions, forks and reads the
/// composer catalogs. This model sends the intents and passes the core's
/// views through.
final class RustComputerChatComposer implements ComputerChatComposer {
  RustComputerChatComposer(this.reader)
    : settings = RustChatSettingsCatalog(reader) {
    service.send(intent: const core.ChatIntent.enableComposer());
  }
  final RustChatReader reader;
  core.ChatsService get service => reader.service;
  @override
  final RustChatSettingsCatalog settings;
  core.ComposerView? get _view => reader.composer;

  @override
  String? get catalogError => _view?.catalogError;

  /// The last shown state this listener reported.
  (String, String, String, bool)? _synced;

  /// Reports the shown state; the core decides whether to read, as of the
  /// moment that state showed.
  @override
  void sync(DeviceChatState? state, {required bool online}) {
    if (!online || state == null) return;
    final input = (
      state.ref.key,
      jsonEncode(state.tab['model']),
      jsonEncode(state.tab['executionHarness']),
      state.running,
    );
    if (input == _synced) return;
    _synced = input;
    service.send(
      intent: core.ChatIntent.syncSettings(
        chat: RustChatReader.chatRefView(state.ref),
        modelJson: input.$2,
        harnessJson: input.$3,
        running: input.$4,
      ),
    );
  }

  @override
  Future<void> load() async {
    await reader.settle(const core.ChatIntent.loadSettings(report: true));
  }

  @override
  Future<void> restore(bool Function() current) async {
    await reader.settle(const core.ChatIntent.restoreSettings());
  }

  @override
  void invalidate() {
    _synced = null;
    service.send(intent: const core.ChatIntent.invalidateSettings());
  }

  final _tabs = Expando<Map<String, dynamic>>('tab');
  @override
  Map<String, dynamic> get tab => switch (_view) {
    final view? => _tabs[view] ??= Map.unmodifiable(
      deviceLinkObject(_decode(view.tabJson)),
    ),
    null => const {},
  };

  @override
  ComputerSettingsFailure? get failure => switch (_view?.failure) {
    final f? => (
      message: f.message,
      reported: f.reported,
      modelChange: f.modelChange,
    ),
    null => null,
  };

  /// Picks issued here whose frame has not come yet.
  int _issued = 0;
  @override
  bool get saving => _issued > 0 || (_view?.saving ?? false);
  @override
  bool get refreshing => _view?.refreshing ?? false;

  @override
  Future<bool> change(DeviceChatRef ref, core.SettingsPick pick) async {
    _issued++;
    try {
      final settled = await reader.settle(
        core.ChatIntent.changeSetting(
          chat: RustChatReader.chatRefView(ref),
          pick: pick,
        ),
      );
      return switch (settled.outcome) {
        core.ChatOutcome_Changed(:final applied) => applied,
        _ => false,
      };
    } finally {
      _issued--;
    }
  }

  @override
  void invalidatePicks() =>
      service.send(intent: const core.ChatIntent.invalidatePicks());

  /// The core releases picks as the chat's revision reaches them.
  @override
  void syncPicks() {}

  @override
  core.ControlsView? get controls => _view?.controls;

  @override
  List<AskUserQuestionState> pendingQuestions(DeviceChatState? state) {
    final header = reader.header;
    if (state == null || header == null) return const [];
    return askStates(header.questions);
  }

  @override
  Future<void> answer(
    DeviceChatRef ref,
    String requestId,
    List<AskUserQuestionAnswer> answers,
  ) => reader.settle(
    core.ChatIntent.answer(
      chat: RustChatReader.chatRefView(ref),
      requestId: requestId,
      answersJson: jsonEncode([for (final a in answers) a.toJson()]),
    ),
  );

  @override
  Future<void> dismiss(DeviceChatRef ref, String requestId) => reader.settle(
    core.ChatIntent.dismissQuestion(
      chat: RustChatReader.chatRefView(ref),
      requestId: requestId,
    ),
  );

  @override
  Future<DeviceChatRef> fork(DeviceChatRef source, String atMessageId) async {
    final settled = await reader.settle(
      core.ChatIntent.fork(
        chat: RustChatReader.chatRefView(source),
        atMessageId: atMessageId,
      ),
    );
    return switch (settled.outcome) {
      core.ChatOutcome_Forked(:final chat) => _chat(chat),
      _ => throw const DeviceLinkException(
        'The computer did not confirm the fork.',
      ),
    };
  }

  @override
  void forkOpened(DeviceChatRef source, String atMessageId) => service.send(
    intent: core.ChatIntent.forkOpened(
      chat: RustChatReader.chatRefView(source),
      atMessageId: atMessageId,
    ),
  );

  @override
  ComputerComposerSources createSources(DeviceChatsViewModel model) =>
      RustComposerSources(model, this);

  @override
  void dispose() {}
}

/// One chat screen's composer catalogs on the core: the core checks the
/// captured chat, reads and decodes; this keeps the shared sources'
/// synchronous answers.
final class RustComposerSources extends ChangeNotifier
    implements ComputerComposerSources {
  RustComposerSources(this.model, this.composer) {
    _updates = composer.reader.updates.listen((_) {
      final revision = composer._view?.inventoryRevision ?? 0;
      if (revision != _revision) {
        _revision = revision;
        notifyListeners();
      }
    });
    _revision = composer._view?.inventoryRevision ?? 0;
  }
  final DeviceChatsViewModel model;
  final RustComputerChatComposer composer;
  late final StreamSubscription<void> _updates;
  int _revision = 0;
  ({Object scope, bool unsettled})? _inventoryState;
  bool _disposed = false;

  String? get _harness => composer.settings.scopeKey == model.state?.ref.key
      ? composer.settings.executionHarness
      : null;

  Future<T> _read<T>(
    core.ComposerSource source,
    core.SourceScopeView scope,
    T Function(core.ChatOutcome? outcome) read,
  ) async {
    final settled = await composer.reader.settle(
      core.ChatIntent.loadComposerSource(source: source, scope: scope),
    );
    return read(settled.outcome);
  }

  @override
  ({ComposerCommandSource commands, ComposerPluginsSource plugins})? current() {
    final state = model.state;
    if (state == null || state.closed || !model.chats.ready) return null;
    final ref = state.ref;
    final generation = model.chats.selectionGeneration;
    final harness = _harness;
    final modelId = state.tab['model'];
    final tabHarness = state.tab['executionHarness'];
    final scope = (ref.key, generation, harness, modelId, tabHarness);
    final captured = core.SourceScopeView(
      chat: RustChatReader.chatRefView(ref),
      generation: generation,
      modelJson: jsonEncode(modelId),
      harnessJson: jsonEncode(tabHarness),
    );
    bool current() =>
        !_disposed &&
        model.online &&
        model.chats.ready &&
        model.chats.selectionGeneration == generation &&
        model.state?.ref.key == ref.key &&
        model.state?.closed == false &&
        model.state?.tab['model'] == modelId &&
        model.state?.tab['executionHarness'] == tabHarness;
    return (
      commands: ComposerCommandSource(
        scope: scope,
        revision: () =>
            (_revision, jsonEncode(model.state?.tab['pluginSelections'])),
        load: () => _read(core.ComposerSource.inventory, captured, (outcome) {
          final (rows, unsettled) = switch (outcome) {
            core.ChatOutcome_Inventory(:final commands, :final unsettled) => (
              commands,
              unsettled,
            ),
            _ => (const <core.CommandRowView>[], false),
          };
          _inventoryState = (scope: scope, unsettled: unsettled);
          return [
            for (final row in rows)
              ComposerCommand(
                name: row.name,
                displayName: row.displayName,
                description: row.description,
                entryId: row.entryId,
                requiresResolution: true,
                unavailableReason: _invocableUnavailable,
              ),
          ];
        }),
        unsettled: () =>
            _inventoryState?.scope == scope &&
            _inventoryState?.unsettled == true,
      ),
      plugins: ComposerPluginsSource(
        providerType: () => _harness,
        readOnlyReason: _pluginSelectionsReadOnly,
        loadCatalog: () => _read(
          core.ComposerSource.pluginCatalog,
          captured,
          (outcome) => switch (outcome) {
            core.ChatOutcome_PluginCatalog(:final json) =>
              ComposerPluginCatalog.fromJson(deviceLinkObject(_decode(json))),
            _ => throw const FormatException('Missing composer catalog'),
          },
        ),
        loadSelections: () => _read(
          core.ComposerSource.selections,
          captured,
          (outcome) => switch (outcome) {
            core.ChatOutcome_Selections(:final json) =>
              normalizePluginSelections(
                json == null ? null : deviceLinkObject(_decode(json)),
              ),
            _ => throw const FormatException('Missing chat state'),
          },
        ),
        save: (_) async {
          if (!current()) {
            throw const DeviceLinkException(
              'The chat changed. Close the picker and open it again.',
            );
          }
          throw const DeviceLinkException(_pluginSelectionsReadOnly);
        },
        selectedCount: () {
          if (!current()) return null;
          final selections = model.state?.tab['pluginSelections'];
          if (selections == null) return 0;
          return selections is Map<String, Object?>
              ? countPluginSelections(selections)
              : null;
        },
      ),
    );
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_updates.cancel());
    super.dispose();
  }
}

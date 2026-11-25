import 'dart:async';

import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/questions.dart';
import 'package:mobile/device_link/chats/repository.dart';
import 'package:mobile/device_link/rust_core/failures.dart';

import '../../chats_view_model.dart';
import '../../computer_link_model.dart';
import '../orchestrator/model.dart';
import 'rust_activity.dart';
import 'rust_chats.dart';
import 'rust_composer.dart';
import 'rust_pipelines.dart';
import 'rust_sends.dart';

/// One computer's Orchestrator on the core's [core.OrchestratorService]
/// (P9). The core owns the work entries, the tool requests, the window
/// state, the renderer handshake, the entries' chat interest and the
/// bounded refresh after pushes; the Orchestrator chat runs on the core's
/// chats over the `app-advisor` surface. This model only tells the core
/// when its chat model or route is visible and renders the core's views.
final class RustComputerOrchestrator extends ChangeNotifier
    implements ComputerOrchestrator {
  factory RustComputerOrchestrator({
    required ComputerLinkModel connection,
    required core.OrchestratorService service,
  }) {
    final questions = RustOrchestratorQuestions(service);
    final reader = RustChatReader(service.chats());
    late final RustComputerOrchestrator model;
    final chats = DeviceChatsViewModel(
      connection: connection,
      chats: DeviceChatsRepository(
        reader,
        readCatalog: () => model._readCatalog(),
        sender: RustChatSender(reader),
      ),
      ownsConnection: false,
      questionSource: questions,
      feed: reader.feed,
      drafts: RustChatDrafts(reader),
      createActivity: () => RustComputerActivity(
        reader.service.activity(),
        pipelines: RustComputerPipelines(reader.service.pipelines(), reader),
      ),
      createFiles: () => RustComputerFiles(reader.service.files(), reader),
      composer: RustComputerChatComposer(reader),
    );
    return model = RustComputerOrchestrator._(
      chats,
      service,
      questions,
      reader,
    );
  }

  /// An ended session's questions go when the connection goes offline
  /// ([_connectionChanged]): the computer's bound connection forwards no
  /// `closed`.
  RustComputerOrchestrator._(
    this.chats,
    this.service,
    this.questions,
    this._reader,
  ) {
    chats.addListener(_changed);
    chats.connection.addListener(_connectionChanged);
    _views = service.watch().listen(_apply);
    _connectionChanged();
  }

  @override
  final DeviceChatsViewModel chats;
  final core.OrchestratorService service;
  final RustOrchestratorQuestions questions;
  late final StreamSubscription<core.OrchestratorView> _views;
  core.OrchestratorView? _view;
  bool _disposed = false, _online = false;

  @override
  List<OrchestratorEntry> get entries => _view?.entries ?? const [];
  @override
  List<AskUserQuestionState> pendingFor(String chatId) =>
      questions.pendingFor(chatId);

  void _apply(core.OrchestratorView view) {
    if (_disposed) return;
    final previous = _view;
    _view = view;
    questions._apply(view.questions);
    // The pushes the list follows asked for a fresh one.
    if (previous != null && view.refreshes != previous.refreshes) {
      unawaited(refresh());
    }
    if (!identical(previous?.entries, view.entries)) notifyListeners();
  }

  void _changed() {
    if (_disposed) return;
    if (!chats.catalogLoading) {
      service.send(intent: const core.OrchestratorIntent.catalogShown());
    }
    notifyListeners();
  }

  void _connectionChanged() {
    if (_disposed || _online == chats.online) return;
    _online = chats.online;
    service.send(intent: core.OrchestratorIntent.setOnline(online: _online));
  }

  Future<core.OrchestratorOutcome> _settle(
    core.OrchestratorIntent intent,
  ) async {
    try {
      final settled = await service.settled(
        ticket: service.request(intent: intent),
      );
      return settled.outcome;
    } on core.CoreFailure catch (error) {
      throw rustFailure(error);
    }
  }

  Future<DeviceChatCatalog> _readCatalog() async {
    final outcome = await _settle(const core.OrchestratorIntent.readCatalog());
    return switch (outcome) {
      core.OrchestratorOutcome_Catalog(:final catalog) => (
        chats: [
          for (final c in catalog.chats)
            DeviceChatRef(
              projectId: c.projectId,
              worktreeId: c.worktreeId,
              id: c.id,
              title: c.title,
            ),
        ],
        workspaces: [
          for (final w in catalog.workspaces) DeviceChatWorkspace(w.id, w.name),
        ],
      ),
      core.OrchestratorOutcome_Failed(:final failure) => throw chatFailure(
        failure,
      ),
      _ => throw StateError('Unexpected catalog outcome: $outcome'),
    };
  }

  @override
  void setVisible(bool value) {
    if (_disposed) return;
    final ticket = service.request(
      intent: core.OrchestratorIntent.setVisible(visible: value),
    );
    unawaited(
      service.settled(ticket: ticket).then((settled) {
        if (settled.outcome case core.OrchestratorOutcome_Visible(
          refresh: true,
        ) when !_disposed) {
          unawaited(refresh());
        }
      }, onError: (Object _) {}),
    );
  }

  @override
  Future<void> refresh() async {
    await chats.refreshCatalog();
    if (_disposed) return;
    try {
      await _settle(const core.OrchestratorIntent.watchEntries());
    } catch (_) {}
  }

  final RustChatReader _reader;

  @override
  Future<bool> open(OrchestratorEntry? entry) async {
    if (_disposed || !chats.online || chats.creating || chats.catalogLoading) {
      return false;
    }
    final outcome = await _settle(
      core.OrchestratorIntent.enter(entryId: entry?.id),
    );
    if (_disposed) return false;
    switch (outcome) {
      case core.OrchestratorOutcome_Opened(
        :final chatRevision,
        :final chatGeneration,
      ):
        try {
          await _reader.waitForRevision(chatRevision);
        } catch (_) {
          if (_disposed) return false;
          rethrow;
        }
        if (_disposed ||
            !chats.online ||
            _reader.selectionGeneration != chatGeneration) {
          return false;
        }
        chats.error = null;
        return true;
      case core.OrchestratorOutcome_Failed(:final failure):
        chats.error = failure.message;
        _changed();
        return false;
      default:
        return false;
    }
  }

  @override
  Future<void> leaveChat({bool refreshCatalog = true}) async {
    if (_disposed) return;
    service.send(intent: const core.OrchestratorIntent.leave());
    await chats.leaveChat();
    if (_disposed || !chats.online) return;
    if (refreshCatalog) {
      await refresh();
    } else {
      // Failed opens must still release chat interests and restore the
      // list's subscriptions; a refresh would erase their error.
      try {
        await _settle(const core.OrchestratorIntent.watchEntries());
      } catch (_) {}
    }
  }

  @override
  void dispose() {
    _disposed = true;
    service.send(intent: const core.OrchestratorIntent.close());
    chats.removeListener(_changed);
    chats.connection.removeListener(_connectionChanged);
    unawaited(_views.cancel());
    questions.dispose();
    chats.dispose();
    super.dispose();
  }
}

/// The Orchestrator's questions as the core holds them: the desktop's
/// `ask_user_question` tool requests for each chat.
final class RustOrchestratorQuestions implements DeviceChatQuestions {
  RustOrchestratorQuestions(this.service);
  final core.OrchestratorService service;
  final _updates = StreamController<void>.broadcast();
  List<core.ToolQuestionView> _questions = const [];
  final _states = <String, List<AskUserQuestionState>>{};
  bool _disposed = false;

  @override
  Stream<void> get updates => _updates.stream;

  void _apply(List<core.ToolQuestionView> questions) {
    if (_disposed || listEquals(questions, _questions)) return;
    _questions = questions;
    _states.clear();
    _updates.add(null);
  }

  @override
  List<AskUserQuestionState> pendingFor(String chatId) =>
      _states[chatId] ??= askStates([
        for (final q in _questions)
          if (q.chatId == chatId) q.question,
      ]);

  Future<void> _decide(core.OrchestratorIntent intent) async {
    final core.OrchestratorSettled settled;
    try {
      settled = await service.settled(ticket: service.request(intent: intent));
    } on core.CoreFailure catch (error) {
      throw rustFailure(error);
    }
    if (settled.outcome case core.OrchestratorOutcome_Failed(:final failure)) {
      throw chatFailure(failure);
    }
  }

  @override
  Future<void> answer(
    String chatId,
    String requestId,
    List<AskUserQuestionAnswer> answers,
  ) => _decide(
    core.OrchestratorIntent.answer(
      chatId: chatId,
      requestId: requestId,
      answers: [
        for (final a in answers)
          core.QuestionAnswerView(
            questionId: a.questionId,
            question: a.question,
            selectedOptions: a.selectedOptions,
            freeformText: a.freeformText,
          ),
      ],
    ),
  );

  @override
  Future<void> dismiss(String chatId, String requestId) => _decide(
    core.OrchestratorIntent.dismiss(chatId: chatId, requestId: requestId),
  );

  void dispose() {
    _disposed = true;
    unawaited(_updates.close());
  }
}

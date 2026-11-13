import 'package:mobile/device_link/chats/attachments.dart';
import 'package:mobile/device_link/chats/title.dart';
import 'package:mobile/device_link/files/tabs.dart';
import 'package:mobile/ui/core/chat/view_models/attachment_thumbnail_cache.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_draft.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/device_link/activity/repository.dart';
import 'package:mobile/device_link/chats/read_receipts.dart';
import 'package:mobile/device_link/chats/questions.dart';
import 'dart:async';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/device_link/chats/decisions.dart';
import 'package:mobile/device_link/chats/navigation.dart';
import 'package:mobile/device_link/chats/forks.dart';
import 'package:mobile/ui/core/chat/view_models/response_action_target.dart';
import 'package:flutter/foundation.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/repository.dart';
import 'package:mobile/device_link/chats/state.dart';
import 'package:mobile/device_link/protocol.dart';
import 'desktop_link_model.dart';
import 'package:mobile/device_link/chats/settings.dart';
import 'computer_connect/settings_controller.dart';

final class DeviceChatsViewModel extends ChangeNotifier {
  DeviceChatsViewModel({
    required this.connection,
    required this.chats,
    this.ownsConnection = true,
    this.questionSource,
  }) {
    _questionSubscription = questionSource?.updates.listen((_) {
      if (!_disposed) notifyListeners();
    });
    _subscription = chats.updates.listen((_) {
      if (!_disposed) {
        _reconcileDraft();
        composerSettings.sync();
        _syncSettings();
        if (state case final current?) {
          activity.updateChats(current.ref, current.scope.tabs);
        }
        _observeReadReceipts();
        notifyListeners();
      }
    });
    connection.addListener(_connectionChanged);
    _connectionChanged();
  }
  bool _transcriptVisible = false;
  void setTranscriptVisible(bool visible) {
    if (_disposed || _transcriptVisible == visible) return;
    _transcriptVisible = visible;
    _observeReadReceipts();
  }

  void _observeReadReceipts() => readReceipts.observe(
    state,
    enabled: _transcriptVisible && online && !_restoring && chats.ready,
  );

  final bool ownsConnection;
  final DeviceChatQuestions? questionSource;
  StreamSubscription<void>? _questionSubscription;
  List<AskUserQuestionState> pendingQuestionsFor(String id) => [
    ...?state?.scope.pendingQuestions(id),
    ...?questionSource?.pendingFor(id),
  ];
  final DesktopLinkModel connection;
  final DeviceChatsRepository chats;
  late final activity = DeviceActivityRepository(chats.ipc);
  late final settings = DeviceChatSettings(chats.ipc);
  late final composerSettings = DeviceComposerSettingsController(
    current: () => state,
    sessionGeneration: () => _connectionRevision,
    refresh: chats.refresh,
    onChanged: () {
      if (!_disposed) notifyListeners();
    },
  );
  late final decisions = DeviceChatDecisions(chats.ipc);
  late final navigation = DeviceChatNavigation(chats.ipc);
  late final forks = DeviceChatForks(chats.ipc);
  late final readReceipts = DeviceChatReadReceipts(navigation);
  late final attachments = DeviceChatAttachments(chats.ipc);
  late final files = DeviceFileLocator(chats.ipc);

  /// Previews of images this phone sent, keyed by their computer paths.
  final attachmentThumbnails = AttachmentThumbnailCache();
  final _answering = <String>{};
  bool get deciding => _answering.isNotEmpty;
  List<DeviceChatRef> get tabs => [
    if (state case final current?)
      for (final tab in current.scope.tabs)
        if (tab['kind'] != 'file' && tab['archivedAt'] == null)
          DeviceChatRef(
            projectId: current.ref.projectId,
            worktreeId: current.ref.worktreeId,
            id: tab['id'] as String,
            title: deviceChatTitle(tab),
          ),
  ];

  /// Files the computer has open in this worktree, such as agent reports.
  List<DeviceFileTab> get fileTabs => [
    if (state case final current?)
      ...deviceFileTabs(current.ref, current.scope.tabs),
  ];

  Future<void> answer(String id, List<AskUserQuestionAnswer> answers) =>
      _decide(
        id,
        (ref) =>
            questionSource?.pendingFor(ref.id).any((q) => q.requestId == id) ==
                true
            ? questionSource!.answer(ref.id, id, answers)
            : decisions.answer(ref, id, answers),
      );
  Future<void> dismissQuestion(String id) => _decide(
    id,
    (ref) =>
        questionSource?.pendingFor(ref.id).any((q) => q.requestId == id) == true
        ? questionSource!.dismiss(ref.id, id)
        : decisions.dismiss(ref, id),
  );
  Future<void> _decide(
    String id,
    Future<void> Function(DeviceChatRef) action,
  ) async {
    final current = state;
    if (!online ||
        !chats.ready ||
        current == null ||
        _answering.contains(id) ||
        !pendingQuestionsFor(current.ref.id).any((q) => q.requestId == id)) {
      return;
    }
    _answering.add(id);
    error = null;
    notifyListeners();
    try {
      await action(current.ref);
      if (!_disposed && online && state?.ref.key == current.ref.key) {
        await chats.refresh();
      }
    } catch (cause) {
      if (!_disposed && state?.ref.key == current.ref.key) {
        error = _describe(cause);
      }
    } finally {
      _answering.remove(id);
      if (!_disposed) notifyListeners();
    }
  }

  Future<void> closeTab(String id) async {
    final ref = tabs.where((t) => t.id == id).firstOrNull;
    final current = state;
    if (!online ||
        !chats.ready ||
        ref == null ||
        current == null ||
        chats.pendingSend?.ref.key == ref.key ||
        current.scope.running(id)) {
      return;
    }
    final selection = chats.selectionGeneration;
    if (id == current.ref.id) composerSettings.invalidate();
    try {
      await navigation.archive(ref);
      if (_disposed ||
          !online ||
          chats.selectionGeneration != selection ||
          state?.ref.key != current.ref.key) {
        return;
      }
      final next = tabs.where((t) => t.id != id).firstOrNull;
      if (id != current.ref.id) {
        await chats.refresh();
      } else if (next != null) {
        await open(next);
      } else {
        await chats.createTab(ref.projectId, ref.worktreeId);
      }
    } catch (cause) {
      if (!_disposed) {
        error = _describe(cause);
        notifyListeners();
      }
    }
  }

  Future<void> newTab() async {
    final ref = state?.ref;
    if (!online || ref == null || creating) return;
    composerSettings.invalidate();
    creating = true;
    notifyListeners();
    try {
      await chats.createTab(ref.projectId, ref.worktreeId);
    } catch (cause) {
      if (!_disposed) error = _describe(cause);
    } finally {
      creating = false;
      if (!_disposed) notifyListeners();
    }
  }

  Object? _settingsInput;
  void _syncSettings() {
    final current = state;
    if (!online || _restoring || current == null) return;
    final input = (
      current.ref.key,
      current.tab['model'],
      current.tab['executionHarness'],
      current.running,
    );
    if (input == _settingsInput) return;
    _settingsInput = input;
    unawaited(loadSettings());
  }

  bool get settingsSaving => composerSettings.saving;
  String? _settingsError;
  String? get settingsError => composerSettings.error ?? _settingsError;
  StreamSubscription<void>? _subscription;
  bool _connected = false, _disposed = false, _restoring = false;
  int _connectionRevision = 0;
  Future<void>? _restoration;
  bool catalogLoading = false, creating = false;
  String? error;
  final _drafts = <String, String>{};
  ChatDraftStore? _draftStore;
  String? _computerId;
  void bindDrafts(String computerId, ChatDraftStore store) {
    if (_computerId != null && _computerId != computerId) {
      throw StateError('A chat model belongs to one computer.');
    }
    _computerId = computerId;
    _draftStore = store;
  }

  ComputerChatDraftTarget? _draftTarget(DeviceChatRef ref) =>
      _computerId == null
      ? null
      : ComputerChatDraftTarget(
          computerId: _computerId!,
          projectId: ref.projectId,
          worktreeId: ref.worktreeId,
          chatId: ref.id,
        );
  String _draftFor(DeviceChatRef ref) {
    final target = _draftTarget(ref);
    return _drafts[ref.key] ??
        (target == null ? '' : _draftStore?.draftFor(target) ?? '');
  }

  void _writeDraft(DeviceChatRef ref, String text) {
    _drafts[ref.key] = text;
    if (_draftTarget(ref) case final target?) {
      _draftStore?.setDraft(target, text);
    }
    if (_drafts.length > 50) _drafts.remove(_drafts.keys.first);
  }

  String? _lastConfirmed;
  void _reconcileDraft() {
    final confirmed = chats.confirmedSend;
    if (confirmed == null || confirmed.id == _lastConfirmed) return;
    _lastConfirmed = confirmed.id;
    if (_draftFor(confirmed.ref) == confirmed.text) {
      _writeDraft(confirmed.ref, '');
    }
  }

  DeviceChatState? get state => chats.state;
  bool get online => connection.phase == DesktopLinkPhase.connected;
  bool get canSend => canChangeSettings && !settingsSaving && chats.ready;
  bool get canChangeSettings =>
      online &&
      !_restoring &&
      !deciding &&
      state != null &&
      !state!.closed &&
      (chats.ready || composerSettings.refreshing) &&
      !chats.sending &&
      chats.pendingSend == null;
  String get draft => state == null ? '' : _draftFor(state!.ref);
  void setDraft(String value) {
    if (state case final current?) _writeDraft(current.ref, value);
  }

  String _describe(Object cause) => cause is DeviceLinkException
      ? cause.message
      : 'Could not complete that chat action. Try again.';
  void _connectionChanged() {
    if (_disposed) return;
    final current = online;
    if (current != _connected) {
      _connected = current;
      final revision = ++_connectionRevision;
      composerSettings.sync();
      _restoring = current;
      catalogLoading = current;
      if (!current) {
        unawaited(activity.setConnected(false));
        settings.invalidate();
        _settingsInput = null;
        readReceipts.invalidate();
        files.clear();
        unawaited(chats.setConnected(false));
        _restoration = null;
      } else {
        _restoration = _restore(revision);
      }
    }
    notifyListeners();
  }

  bool _currentConnection(int revision) =>
      !_disposed && online && revision == _connectionRevision;

  Future<void> _restore(int revision) async {
    try {
      try {
        // Rehydrate the retained selection before starting drawer refreshes.
        await chats.setConnected(true);
        while (_currentConnection(revision) && state != null) {
          final current = state!;
          final input = (
            current.ref.key,
            current.tab['model'],
            current.tab['executionHarness'],
            current.running,
          );
          await _loadSettings();
          if (!_currentConnection(revision)) return;
          final latest = state;
          if (latest != null &&
              input ==
                  (
                    latest.ref.key,
                    latest.tab['model'],
                    latest.tab['executionHarness'],
                    latest.running,
                  )) {
            _settingsInput = input;
            break;
          }
        }
      } catch (cause) {
        if (_currentConnection(revision)) error = _describe(cause);
      }
      if (!_currentConnection(revision)) return;
      await activity.setConnected(true);
    } catch (cause) {
      if (_currentConnection(revision)) error = _describe(cause);
    } finally {
      if (_currentConnection(revision)) {
        _restoration = null;
        _restoring = false;
        catalogLoading = false;
        _observeReadReceipts();
        notifyListeners();
      }
    }
  }

  Future<void> refreshCatalog() async {
    if (catalogLoading || !online) return;
    catalogLoading = true;
    error = null;
    notifyListeners();
    try {
      await chats.refreshCatalog();
    } catch (cause) {
      error = _describe(cause);
    }
    if (!_disposed) {
      catalogLoading = false;
      notifyListeners();
    }
  }

  Future<bool> open(DeviceChatRef ref) async {
    composerSettings.invalidate();
    readReceipts.invalidate();
    error = null;
    final pending = chats.open(ref);
    final generation = chats.selectionGeneration;
    try {
      await pending;
      return !_disposed &&
          generation == chats.selectionGeneration &&
          state?.ref.key == ref.key;
    } catch (cause) {
      if (!_disposed && generation == chats.selectionGeneration) {
        error = _describe(cause);
        notifyListeners();
      }
      return false;
    }
  }

  Future<void> forkResponse(ResponseActionTarget target) async {
    final current = state;
    if (!online ||
        !chats.ready ||
        current == null ||
        current.closed ||
        current.tab['readOnly'] == true ||
        current.ref.id != target.chatId) {
      throw const DeviceLinkException('Reconnect to your computer first.');
    }
    final generation = chats.selectionGeneration;
    final connectionRevision = _connectionRevision;
    final destination = await forks.fork(current.ref, target.atMessageId);
    if (_disposed ||
        !online ||
        connectionRevision != _connectionRevision ||
        generation != chats.selectionGeneration) {
      return;
    }
    if (!await open(destination)) {
      throw const DeviceLinkException(
        'The fork was created. Open it from the chat list.',
      );
    }
    forks.opened(current.ref, target.atMessageId);
  }

  Future<bool> create(DeviceChatWorkspace workspace, {String? title}) async {
    if (creating || !online) return false;
    composerSettings.invalidate();
    creating = true;
    error = null;
    notifyListeners();
    try {
      await chats.createChat(workspace.id, title: title);
      return true;
    } catch (cause) {
      if (!_disposed) error = _describe(cause);
      return false;
    } finally {
      if (!_disposed) {
        creating = false;
        notifyListeners();
      }
    }
  }

  /// Sends the draft with [attachments], which must be uploaded. Returns
  /// whether the computer has or may have the message: its files are then
  /// spent, and a retry resends their paths.
  Future<bool> send({
    bool retry = false,
    bool dictated = false,
    List<ChatAttachmentDraft> attachments = const [],
  }) async {
    if (!retry && !canSend) return false;
    final ref = state?.ref;
    final text = retry ? chats.pendingSend?.text : draft;
    if (ref == null || text == null) return false;
    error = null;
    var sent = false;
    try {
      final result = await chats.send(
        text,
        retry: retry,
        dictated: dictated,
        attachmentPaths: [
          for (final attachment in attachments)
            if (attachment.uploaded case final uploaded?) uploaded.attachmentId,
        ],
      );
      sent = true;
      for (final attachment in attachments) {
        if (attachment.uploaded case final uploaded?) {
          unawaited(
            attachmentThumbnails.retain(
              attachmentId: uploaded.attachmentId,
              mediaType: attachment.mediaType,
              bytes: attachment.bytes,
            ),
          );
        }
      }
      if (result == DeviceChatSendOutcome.accepted && _draftFor(ref) == text) {
        _writeDraft(ref, '');
      }
    } catch (cause) {
      if (!_disposed) error = _describe(cause);
    }
    if (!_disposed) notifyListeners();
    return sent;
  }

  Future<void> refreshChat() async {
    final pending = chats.pendingSend;
    try {
      await chats.refresh();
      _observeReadReceipts();
      readReceipts.retry();
      if (pending != null &&
          chats.confirmedSend?.id == pending.id &&
          _draftFor(pending.ref) == pending.text) {
        _writeDraft(pending.ref, '');
      }
      error = null;
    } catch (cause) {
      if (!_disposed) error = _describe(cause);
    }
    if (!_disposed) notifyListeners();
  }

  Future<void> loadSettings() => _restoration ?? _loadSettings();

  Future<void> _loadSettings() async {
    final ref = state?.ref;
    if (_disposed || !online || ref == null) return;
    if (settings.scopeKey != ref.key) _settingsError = null;
    final errorRevision = composerSettings.errorRevision;
    final loading = settings.load(ref);
    try {
      await loading;
      if (!_disposed && state?.ref.key == ref.key) {
        _settingsError = null;
        composerSettings.clearError(expectedRevision: errorRevision);
      }
    } catch (cause) {
      if (!_disposed && state?.ref.key == ref.key) {
        _settingsError = cause is DeviceLinkException
            ? cause.message
            : 'Could not load models from your computer. Retry models.';
      }
    }
    if (!_disposed) notifyListeners();
  }

  Future<bool> changeSetting(
    DeviceChatRef ref,
    Map<String, dynamic> patch,
    Future<int> Function(Map<String, dynamic> tab) save,
  ) => canChangeSettings
      ? composerSettings.change(ref, patch, save)
      : Future.value(false);

  Future<void> stop() async {
    try {
      await chats.stop();
    } catch (cause) {
      if (!_disposed) {
        error = _describe(cause);
        notifyListeners();
      }
    }
  }

  Future<void> leaveChat({int? expectedGeneration}) async {
    if (expectedGeneration != null &&
        expectedGeneration != chats.selectionGeneration) {
      return;
    }
    readReceipts.invalidate();
    try {
      composerSettings.invalidate();
      await chats.clearSelection(expectedGeneration: expectedGeneration);
    } catch (_) {}
  }

  @override
  void dispose() {
    _disposed = true;
    composerSettings.dispose();
    attachmentThumbnails.dispose();
    settings.invalidate();
    readReceipts.dispose();
    unawaited(activity.dispose());
    connection.removeListener(_connectionChanged);
    unawaited(_subscription?.cancel());
    unawaited(chats.dispose());
    unawaited(_questionSubscription?.cancel());
    if (ownsConnection) connection.dispose();
    super.dispose();
  }
}

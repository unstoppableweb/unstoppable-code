import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:mobile/device_link/chats/attachments.dart';
import 'package:mobile/device_link/chats/drafts.dart';
import 'package:mobile/ui/core/chat/view_models/attachment_thumbnail_cache.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_draft.dart';
import 'computer_connect/activity_model.dart';
import 'computer_connect/files_model.dart';
import 'package:mobile/device_link/chats/reader.dart';
import 'package:mobile/device_link/chats/questions.dart';
import 'dart:async';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/chat/view_models/response_action_target.dart';
import 'package:flutter/foundation.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/repository.dart';
import 'package:mobile/device_link/chats/state.dart';
import 'package:mobile/device_link/protocol.dart';
import 'computer_link_model.dart';
import 'package:mobile/device_link/chats/settings_catalog.dart';
import 'computer_connect/composer_model.dart';
import 'computer_connect/chat_feed_model.dart';

typedef _ChatSelection = ({String? key, int generation});

final class DeviceChatsViewModel extends ChangeNotifier {
  DeviceChatsViewModel({
    required this.connection,
    required this.chats,
    this.ownsConnection = true,
    this.questionSource,
    required this.feed,
    required this.drafts,
    required ComputerActivity Function() createActivity,
    required this.createFiles,
    required this.composer,
  }) : activity = createActivity() {
    _questionSubscription = questionSource?.updates.listen((_) {
      if (!_disposed) notifyListeners();
    });
    _subscription = chats.updates.listen((_) {
      if (!_disposed) {
        _reconcileDraft();
        composer.syncPicks();
        _syncSettings();
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
    if (state?.ref.id == id) ...composer.pendingQuestions(state),
    ...?questionSource?.pendingFor(id),
  ];
  final ComputerLinkModel connection;
  final DeviceChatsRepository chats;

  final ComputerFiles Function() createFiles;

  final ComputerActivity activity;
  final ComputerChatComposer composer;

  /// The settings catalog (Home's new task reads it too).
  DeviceChatSettingsCatalog get settings => composer.settings;

  /// The connection's revision, bumped by every online change.
  int get connectionRevision => _connectionRevision;
  DeviceChatReadMarker get readReceipts => chats.reader.readReceipts;

  /// The selected chat's feed: its messages, rows and open turns.
  final ComputerChatFeed feed;
  void toggleTurn(String key) {
    feed.toggleTurn(key);
    if (!_disposed) notifyListeners();
  }

  DeviceChatAttachments get attachments => chats.attachments;
  late final ComputerFiles files = createFiles();

  /// Previews of images this phone sent, keyed by their computer paths.
  final attachmentThumbnails = AttachmentThumbnailCache();
  final _answering = <String>{};
  bool get deciding => _answering.isNotEmpty;
  List<DeviceChatRef> get tabs => [
    if (state case final current?)
      for (final tab in current.openTabs)
        DeviceChatRef(
          projectId: current.ref.projectId,
          worktreeId: current.ref.worktreeId,
          id: tab.id,
          title: tab.title,
        ),
  ];

  /// Files the computer has open in this worktree, such as agent reports.
  List<ComputerFileTab> get fileTabs => files.tabs(state);

  Future<void> answer(String id, List<AskUserQuestionAnswer> answers) =>
      _decide(
        id,
        (ref) =>
            questionSource?.pendingFor(ref.id).any((q) => q.requestId == id) ==
                true
            ? questionSource!.answer(ref.id, id, answers)
            : composer.answer(ref, id, answers),
      );
  Future<void> dismissQuestion(String id) => _decide(
    id,
    (ref) =>
        questionSource?.pendingFor(ref.id).any((q) => q.requestId == id) == true
        ? questionSource!.dismiss(ref.id, id)
        : composer.dismiss(ref, id),
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
    final selection = _chatSelection;
    error = null;
    notifyListeners();
    try {
      await action(current.ref);
      if (!_disposed && online && selection == _chatSelection) {
        await chats.refresh();
      }
    } catch (cause) {
      _setChatError(selection, cause);
    } finally {
      _answering.remove(id);
      if (!_disposed) notifyListeners();
    }
  }

  Future<void> closeTab(String id) async {
    final selection = _chatSelection;
    try {
      await chats.reader.closeTab(id);
    } catch (cause) {
      if (_setChatError(selection, cause)) notifyListeners();
    }
  }

  Future<void> newTab() async {
    final ref = state?.ref;
    if (!online || ref == null || creating) return;
    final selection = _chatSelection;
    composer.invalidatePicks();
    creating = true;
    notifyListeners();
    try {
      await chats.createTab(ref.projectId, ref.worktreeId);
    } catch (cause) {
      _setChatError(selection, cause);
    } finally {
      creating = false;
      if (!_disposed) notifyListeners();
    }
  }

  void _syncSettings() {
    final current = state;
    if (!online || _restoring || current == null) return;
    composer.sync(current, online: online);
  }

  bool get settingsSaving => composer.saving;
  String? get settingsCatalogError => composer.catalogError;
  StreamSubscription<void>? _subscription;
  bool _connected = false, _disposed = false, _restoring = false;
  int _connectionRevision = 0;
  Future<void>? _restoration;
  bool catalogLoading = false, creating = false;
  String? _error;
  int _errorRevision = 0;
  _ChatSelection? _errorSelection;
  _ChatSelection get _chatSelection =>
      (key: state?.ref.key, generation: chats.selectionGeneration);

  String? get error =>
      _errorSelection == null || _errorSelection == _chatSelection
      ? _error
      : null;

  set error(String? value) {
    _errorRevision++;
    _errorSelection = null;
    _error = value;
  }

  bool _setChatError(_ChatSelection selection, Object cause) {
    if (_disposed || selection != _chatSelection) return false;
    error = _describe(cause);
    _errorSelection = selection;
    return true;
  }

  /// The composer drafts of this computer's chats.
  final DeviceChatDrafts drafts;

  String? _lastConfirmed;
  void _reconcileDraft() {
    final confirmed = chats.confirmedSend;
    if (confirmed == null || confirmed.id == _lastConfirmed) return;
    _lastConfirmed = confirmed.id;
    drafts.sent(confirmed.ref, confirmed.text);
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
      (chats.ready || composer.refreshing) &&
      !chats.sending &&
      chats.pendingSend == null;
  String get draft => state == null ? '' : drafts.draftFor(state!.ref);
  void setDraft(String value) {
    if (state case final current?) drafts.setDraft(current.ref, value);
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
      composer.syncPicks();
      _restoring = current;
      catalogLoading = current;
      if (!current) {
        composer.invalidate();
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
      await chats.setConnected(true);
      var catalogLoaded = false;
      try {
        await chats.refreshCatalog();
        catalogLoaded = true;
      } catch (cause) {
        if (_currentConnection(revision)) error = _describe(cause);
      }
      if (!_currentConnection(revision)) return;
      await chats.reader.restoreConnection(catalogLoaded: catalogLoaded);
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
    composer.invalidatePicks();
    readReceipts.invalidate();
    error = null;
    final pending = chats.open(ref);
    final selection = _chatSelection;
    try {
      return await pending && !_disposed;
    } catch (cause) {
      if (_setChatError(selection, cause)) notifyListeners();
      return false;
    }
  }

  Future<void> forkResponse(ResponseActionTarget target) async {
    final current = state;
    if (!online ||
        !chats.ready ||
        current == null ||
        current.closed ||
        current.readOnly ||
        current.ref.id != target.chatId) {
      throw const DeviceLinkException('Reconnect to your computer first.');
    }
    if (await composer.fork(current.ref, target.atMessageId) && !_disposed) {
      error = null;
      notifyListeners();
    }
  }

  Future<bool> create(DeviceChatWorkspace workspace, {String? title}) async {
    if (creating || !online) return false;
    composer.invalidatePicks();
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
    required DeviceChatRef chat,
    bool retry = false,
    bool dictated = false,
    List<ChatAttachmentDraft> attachments = const [],
  }) async {
    if (!retry && !canSend) return false;
    if (state?.ref.key != chat.key) return false;
    final text = retry ? chats.pendingSend?.text : draft;
    if (text == null) return false;
    final selection = _chatSelection;
    error = null;
    var sent = false;
    try {
      final result = await chats.send(
        text,
        chat: chat,
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
      if (result == DeviceChatSendOutcome.accepted) drafts.sent(chat, text);
    } catch (cause) {
      _setChatError(selection, cause);
    }
    if (!_disposed) notifyListeners();
    return sent;
  }

  Future<void> refreshChat() async {
    final pending = chats.pendingSend;
    final selection = _chatSelection;
    final errorRevision = _errorRevision;
    try {
      await chats.refresh();
      _observeReadReceipts();
      readReceipts.retry();
      if (pending != null && chats.confirmedSend?.id == pending.id) {
        drafts.sent(pending.ref, pending.text);
      }
      if (!_disposed &&
          selection == _chatSelection &&
          errorRevision == _errorRevision) {
        error = null;
      }
    } catch (cause) {
      if (errorRevision == _errorRevision) _setChatError(selection, cause);
    }
    if (!_disposed) notifyListeners();
  }

  Future<void> loadSettings() =>
      _restoration ?? (_disposed ? Future.value() : composer.load());

  /// Shows [pick] at once and saves it after the picks before it.
  Future<bool> changeSetting(DeviceChatRef ref, core.SettingsPick pick) =>
      canChangeSettings ? composer.change(ref, pick) : Future.value(false);

  Future<void> stop(DeviceChatRef chat) async {
    final selection = _chatSelection;
    if (selection.key != chat.key) return;
    try {
      await chats.stop(chat);
    } catch (cause) {
      if (_setChatError(selection, cause)) notifyListeners();
    }
  }

  Future<void> leaveChat({int? expectedGeneration}) async {
    if (expectedGeneration != null &&
        expectedGeneration != chats.selectionGeneration) {
      return;
    }
    readReceipts.invalidate();
    try {
      composer.invalidatePicks();
      await chats.clearSelection(expectedGeneration: expectedGeneration);
    } catch (_) {}
  }

  @override
  void dispose() {
    _disposed = true;
    composer.dispose();
    attachmentThumbnails.dispose();
    readReceipts.dispose();
    feed.dispose();
    unawaited(activity.dispose());
    connection.removeListener(_connectionChanged);
    unawaited(_subscription?.cancel());
    unawaited(chats.dispose());
    unawaited(_questionSubscription?.cancel());
    if (ownsConnection) connection.dispose();
    super.dispose();
  }
}

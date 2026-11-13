import 'dart:async';
import '../desktop/ipc.dart';
import '../protocol.dart';
import 'models.dart';
import 'state.dart';
import 'dto.dart';
import 'cache.dart';
import 'catalog.dart';

enum DeviceChatSendOutcome { accepted, uncertain }

/// The initial task creation was refused locally; no task mutation was sent.
final class DeviceChatCreationNotSent extends DeviceLinkException {
  const DeviceChatCreationNotSent(super.message);
}

final class DeviceChatPendingSend {
  DeviceChatPendingSend(
    this.ref,
    this.id,
    this.text, {
    this.dictated = false,
    this.attachmentPaths = const [],
  });
  final bool dictated;
  final DeviceChatRef ref;
  final String id, text;

  /// Files already stored on the computer; a retry sends the same paths.
  final List<String> attachmentPaths;
}

/// Chat state over existing tunneled desktop calls. No Portal projection,
/// persistence writer or provider-event reducer exists in this client.
final class DeviceChatsRepository {
  DeviceChatsRepository(
    this.ipc, {
    this.createTimer = Timer.new,
    this.readCatalog = readDeviceChatCatalog,
    DeviceChatCache? cache,
  }) : cache = cache ?? DeviceChatCache() {
    _subscription = ipc.events.listen(_receive);
    _cacheSubscription = this.cache.updates.listen((key) {
      if (key == _selectedKey) _notify();
    });
  }
  final DesktopIpc ipc;
  final DeviceChatCatalogReader readCatalog;
  final DeviceChatCache cache;
  late final StreamSubscription<String> _cacheSubscription;
  String? _selectedKey;
  void Function()? _releaseSelection;
  final Timer Function(Duration, void Function()) createTimer;
  Future<Object?> _invoke(
    String channel, [
    List<Object?> args = const [],
  ]) async => deviceChatDto(await ipc.invoke(channel, args));
  StreamSubscription<Map<String, dynamic>>? _subscription;
  final _updates = StreamController<void>.broadcast();
  Stream<void> get updates => _updates.stream;
  List<DeviceChatRef> catalog = [];
  List<DeviceChatWorkspace> workspaces = [];
  DeviceChatState? get state =>
      _selectedKey == null ? null : cache.peek(_selectedKey!);
  bool _synchronized = false;
  bool get ready => connected && _synchronized && !loading;
  DeviceChatPendingSend? pendingSend;
  DeviceChatPendingSend? confirmedSend;
  void _confirm(DeviceChatPendingSend attempt) {
    confirmedSend = attempt;
    if (identical(pendingSend, attempt)) pendingSend = null;
  }

  bool connected = false,
      loading = false,
      sending = false,
      loadingOlder = false;
  String? error;
  int _generation = 0;
  int get selectionGeneration => _generation;
  bool _disposed = false, _hydrating = false, _overflow = false;
  final _buffer = <Map<String, dynamic>>[];
  Timer? _recovery;
  void _notify() {
    _releaseClosedSend();
    if (!_disposed) _updates.add(null);
  }

  void _releaseClosedSend() {
    final current = state, pending = pendingSend;
    if (!ready ||
        _hydrating ||
        loading ||
        current == null ||
        pending == null ||
        current.revision == 0 ||
        !pending.ref.matchesScope(current.ref.scope)) {
      return;
    }
    final tab = current.scope.tab(pending.ref.id);
    if (tab.isEmpty || tab['archivedAt'] != null || tab['kind'] == 'file') {
      pendingSend = null;
      error = 'The original chat is closed. Your draft is kept.';
    }
  }

  Future<void> setConnected(bool value) async {
    connected = value;
    if (!value) {
      _synchronized = false;
      _generation++;
      _hydrating = false;
      loading = false;
      loadingOlder = false;
      _recovery?.cancel();
      _buffer.clear();
      _notify();
      return;
    }
    await refreshCatalog();
    final current = state?.ref;
    if (current != null) await open(current);
  }

  Future<void> refreshCatalog() async {
    if (!connected) return;
    final generation = _generation;
    final result = await readCatalog(ipc);
    if (_disposed || generation != _generation || !connected) return;
    catalog = result.chats;
    workspaces = result.workspaces;
    _notify();
  }

  Future<void> open(DeviceChatRef ref) async {
    if (!connected) {
      throw const DeviceLinkException('Reconnect to your computer first.');
    }
    final generation = ++_generation;
    _recovery?.cancel();
    _synchronized = false;
    final release = _releaseSelection;
    _selectedKey = ref.key;
    _releaseSelection = cache.retain(ref.key);
    if (cache.read(ref.key) == null) cache.put(DeviceChatState(ref));
    release?.call();
    loading = true;
    loadingOlder = false;
    error = null;
    _hydrating = true;
    _overflow = false;
    _buffer.clear();
    _notify();
    try {
      await _invoke('chat:set-state-scopes', [
        {
          'kind': 'scopes',
          'scopes': [ref.scope],
        },
      ]);
      if (generation != _generation || _disposed) return;
      await _invoke('chat:set-interest', [
        {
          'focused': [ref.target],
          'warm': [],
        },
      ]);
      if (generation != _generation || _disposed) return;
      final snapshot = deviceLinkObject(
        await _invoke('chat:get-state', [ref.scope]),
      );
      final page = deviceLinkObject(
        await _invoke('chat:get-transcript-page', [ref.target]),
      );
      if (generation != _generation || _disposed) return;
      final next = DeviceChatState(ref)..hydrate(snapshot, page);
      var recover = _overflow;
      for (final event in _buffer) {
        if (!next.apply(event)) {
          recover = true;
          break;
        }
      }
      cache.hydrate(next);
      _buffer.clear();
      _hydrating = false;
      loading = false;
      _synchronized = !recover;
      if (pendingSend?.ref.key == ref.key &&
          next.containsUserMessage(pendingSend!.id)) {
        _confirm(pendingSend!);
      }
      _notify();
      if (recover) _scheduleRecovery();
    } catch (cause) {
      if (generation == _generation && !_disposed) {
        _hydrating = false;
        loading = false;
        _buffer.clear();
        error = _describe(cause);
        _notify();
      }
      rethrow;
    }
  }

  void _receive(Map<String, dynamic> message) {
    if (_disposed) return;
    if (message['kind'] == 'closed') {
      unawaited(setConnected(false));
      return;
    }
    if (!connected) return;
    if (message['name'] != 'ipc.push' ||
        message['payload'] is! Map<String, dynamic>) {
      return;
    }
    final push = deviceLinkObject(message['payload']);
    if (push['channel'] != 'chat:state-changed' ||
        push['args'] is! List ||
        (push['args'] as List).isEmpty) {
      return;
    }
    final event = deviceChatDto((push['args'] as List).first);
    if (event is! Map<String, dynamic>) return;
    // Only apply events actually delivered by the host. Unsubscribed chats
    // remain stale until reopened; caching never expands socket interests.
    for (final cached in cache.states) {
      if (cached.ref.key == _selectedKey || !cached.ref.matchesScope(event)) {
        continue;
      }
      try {
        cached.apply(event);
        cache.put(cached);
      } catch (_) {
        // A fresh snapshot on open repairs omitted or incompatible updates.
      }
    }
    if (state?.ref.matchesScope(event) != true) return;
    if (_hydrating) {
      if (_buffer.length < 128) {
        _buffer.add(event);
      } else {
        _overflow = true;
      }
      return;
    }
    try {
      if (!state!.apply(event)) _scheduleRecovery();
      cache.put(state!);
    } catch (_) {
      _scheduleRecovery();
    }
    if (pendingSend != null &&
        state!.ref.key == pendingSend!.ref.key &&
        state!.containsUserMessage(pendingSend!.id)) {
      _confirm(pendingSend!);
    }
  }

  void _scheduleRecovery() {
    _synchronized = false;
    if (_recovery?.isActive == true || !connected) return;
    loading = true;
    _notify();
    _recovery = createTimer(const Duration(milliseconds: 150), () {
      final ref = state?.ref;
      if (ref != null && connected) {
        unawaited(open(ref).catchError((Object _) {}));
      }
    });
  }

  Future<void> refresh() async {
    final ref = state?.ref;
    if (ref != null) await open(ref);
  }

  Future<void> loadOlder() async {
    final current = state;
    final cursor = current?.before;
    if (current == null || cursor == null || !ready || loadingOlder) return;
    final generation = _generation;
    final revision = current.transcriptRevision;
    loadingOlder = true;
    _notify();
    try {
      final page = deviceLinkObject(
        await _invoke('chat:get-transcript-page', [
          {
            ...current.ref.target,
            'before': cursor,
            'transcriptRevision': revision,
          },
        ]),
      );
      if (_disposed || generation != _generation) return;
      if (current.transcriptRevision != revision ||
          page['transcriptRevision'] != revision) {
        throw const DeviceLinkException(
          'The history changed. Load older messages again.',
        );
      }
      final existing = current.messages.map((m) => m.id).toSet();
      current.messages.insertAll(
        0,
        (page['messages'] as List)
            .map((m) => DeviceChatMessage(deviceLinkObject(m)))
            .where((m) => !existing.contains(m.id)),
      );
      current.before = (page['before'] as num?)?.toInt();
      cache.put(current);
    } catch (cause) {
      if (generation == _generation) error = _describe(cause);
    } finally {
      if (!_disposed && generation == _generation) {
        loadingOlder = false;
        _notify();
      }
    }
  }

  Future<DeviceChatRef> createChat(
    String workspaceId, {
    String? title,
    void Function(DeviceChatRef)? onCreated,
  }) async {
    final requestedTitle = title?.trim();
    if (!connected || !workspaces.any((w) => w.id == workspaceId)) {
      throw const DeviceLinkException('Choose an available workspace first.');
    }
    final generation = _generation;
    Object? reply;
    try {
      reply = await _invoke('work-entries:create', [
        {
          'projectId': workspaceId,
          if (requestedTitle != null && requestedTitle.isNotEmpty)
            'title': requestedTitle,
        },
      ]);
    } on DesktopIpcNotSent catch (error) {
      throw DeviceChatCreationNotSent(error.message);
    }
    final created = deviceLinkObject(reply);
    final entry = deviceLinkObject(created['entry']);
    final worktreeId = deviceLinkString(entry, 'id');
    final id = chatId();
    final commandId = chatId();
    final result = deviceLinkObject(
      await _invoke('chat:command', [
        {
          'schemaVersion': 1,
          'commandId': commandId,
          'projectId': workspaceId,
          'worktreeId': worktreeId,
          'command': {
            'type': 'chat.create_tab',
            'tabId': id,
            'starter': true,
            'title': requestedTitle?.isNotEmpty == true
                ? requestedTitle
                : 'New chat',
          },
        },
      ]),
    );
    if (!['applied', 'already_applied'].contains(result['outcome'])) {
      throw const DeviceLinkException(
        'The computer could not create this chat.',
      );
    }
    if (_disposed || !connected || generation != _generation) {
      throw const DeviceLinkException(
        'Reconnect and refresh the chat list to find the new chat.',
      );
    }
    final ref = DeviceChatRef(
      projectId: workspaceId,
      worktreeId: worktreeId,
      id: result['entityId'] is String ? result['entityId'] as String : id,
      title: requestedTitle?.isNotEmpty == true ? requestedTitle! : 'New chat',
    );
    onCreated?.call(ref);
    catalog = [ref, ...catalog.where((c) => c.key != ref.key)];
    await open(ref);
    return ref;
  }

  Future<void> createTab(
    String projectId,
    String worktreeId, {
    void Function(DeviceChatRef)? onCreated,
  }) async {
    if (!connected) {
      throw const DeviceLinkException('Reconnect to your computer first.');
    }
    final id = chatId(), generation = _generation;
    final result = deviceLinkObject(
      await _invoke('chat:command', [
        {
          'schemaVersion': 1,
          'commandId': chatId(),
          'projectId': projectId,
          'worktreeId': worktreeId,
          'command': {
            'type': 'chat.create_tab',
            'tabId': id,
            'title': 'New chat',
          },
        },
      ]),
    );
    if (!['applied', 'already_applied'].contains(result['outcome'])) {
      throw const DeviceLinkException(
        'The computer could not create this chat.',
      );
    }
    if (_disposed || !connected || generation != _generation) return;
    final ref = DeviceChatRef(
      projectId: projectId,
      worktreeId: worktreeId,
      id: result['entityId'] as String? ?? id,
      title: 'New chat',
    );
    final opening = open(ref);
    // Publish the durable creation after its selection is established, before
    // awaiting hydration. Callers retain the receipt and its selection owner
    // even if that first read fails.
    onCreated?.call(ref);
    await opening;
  }

  Future<DeviceChatSendOutcome> send(
    String text, {
    bool retry = false,
    bool dictated = false,
    List<String> attachmentPaths = const [],
  }) async {
    final current = state;
    if (!ready || current == null || current.closed || sending) {
      throw const DeviceLinkException('Wait for this chat to be ready.');
    }
    final attached = retry
        ? pendingSend?.attachmentPaths ?? const <String>[]
        : attachmentPaths;
    if ((text.trim().isEmpty && attached.isEmpty) || text.length > 32000) {
      throw const DeviceLinkException(
        'Enter a message shorter than 32,000 characters.',
      );
    }
    if (pendingSend != null && !retry) {
      throw const DeviceLinkException(
        'Check the previous message before sending another.',
      );
    }
    final attempt = retry
        ? pendingSend
        : DeviceChatPendingSend(
            current.ref,
            chatId(),
            text,
            dictated: dictated,
            attachmentPaths: List.unmodifiable(attachmentPaths),
          );
    if (attempt == null ||
        attempt.ref.key != current.ref.key ||
        attempt.text != text) {
      throw const DeviceLinkException(
        'Open the original chat to retry this message.',
      );
    }
    pendingSend = attempt;
    sending = true;
    error = null;
    _notify();
    final settings = <String, dynamic>{};
    for (final key in [
      'model',
      'modelSelectionMode',
      'providerType',
      'modelConfig',
      'thinkingLevel',
      'codexFastModeEnabled',
      'planMode',
      'sdkSessionId',
      'pluginSelections',
      'deferredToolsAllowed',
      'interfaceMode',
      'selectedRepoId',
      'executionHarness',
      'aiCreditsRouting',
      'subscriptionBillingOverride',
    ]) {
      if (current.tab[key] != null) settings[key] = current.tab[key];
    }
    var authRefusedBeforeAcceptance = false;
    try {
      final result = deviceLinkObject(
        await _invoke('chat:send-message', [
          {
            ...attempt.ref.target,
            ...settings,
            'userMessageId': attempt.id,
            'clientUserMessageId': attempt.id,
            'text': attempt.text,
            if (attempt.attachmentPaths.isNotEmpty)
              'attachmentPaths': attempt.attachmentPaths,
            'inputMode': attempt.dictated ? 'voice' : 'typed',
          },
        ]),
      );
      if (result['refusedAuthDependencies'] != null) {
        authRefusedBeforeAcceptance = true;
        throw const DesktopIpcRefusal(
          'Sign in to the required provider on your computer, then try again.',
        );
      }
      _confirm(attempt);
      return DeviceChatSendOutcome.accepted;
    } catch (cause) {
      if (confirmedSend?.id == attempt.id) {
        return DeviceChatSendOutcome.accepted;
      }
      if (authRefusedBeforeAcceptance) {
        if (identical(pendingSend, attempt)) pendingSend = null;
        error = _describe(cause);
        rethrow;
      }
      // A generic IPC exception can occur after the desktop's durable write.
      // Keep its receipt identity even when the peer returned an error.
      error = cause is DesktopIpcRefusal
          ? '${cause.message} Check delivery before retrying this message.'
          : 'The message may have reached your computer. Check delivery or retry the same message.';
      return DeviceChatSendOutcome.uncertain;
    } finally {
      sending = false;
      _notify();
    }
  }

  Future<void> stop() async {
    final ref = state?.ref;
    final generation = _generation;
    if (ref == null || !connected) return;
    await _invoke('chat:cancel', [ref.target]);
    // The cancel acknowledgement is authoritative; a filtered or missed push
    // must not leave a reopened chat looking active. Never retarget a late reply.
    if (connected &&
        !_disposed &&
        generation == _generation &&
        state?.ref.key == ref.key) {
      await refresh();
    }
  }

  Future<void> clearSelection({int? expectedGeneration}) async {
    if (expectedGeneration != null && expectedGeneration != _generation) return;
    final generation = ++_generation;
    _synchronized = false;
    _recovery?.cancel();
    _selectedKey = null;
    _releaseSelection?.call();
    _releaseSelection = null;
    loading = false;
    loadingOlder = false;
    _buffer.clear();
    _hydrating = false;
    _notify();
    if (connected) {
      await _invoke('chat:set-interest', [
        {'focused': [], 'warm': []},
      ]);
      if (generation != _generation || _disposed || !connected) return;
      await _invoke('chat:set-state-scopes', [
        {'kind': 'scopes', 'scopes': []},
      ]);
    }
  }

  String _describe(Object cause) => cause is DeviceLinkException
      ? cause.message
      : 'Could not read the chat from your computer. Try again.';
  Future<void> dispose() async {
    _disposed = true;
    _generation++;
    _recovery?.cancel();
    await _subscription?.cancel();
    await _cacheSubscription.cancel();
    await cache.close();
    await _updates.close();
  }
}

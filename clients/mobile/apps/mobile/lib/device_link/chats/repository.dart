import 'dart:async';
import 'attachments.dart';
import 'models.dart';
import 'state.dart';
import 'reader.dart';
import 'sender.dart';

export 'sender.dart'
    show
        DeviceChatCreationNotSent,
        DeviceChatPendingSend,
        DeviceChatSendOutcome;

/// One computer's chats: the read path ([DeviceChatReader]: the selected
/// chat, its cache, hydration, recovery, older pages, read receipts), the
/// writes ([DeviceChatSender]: sends, chat creation, stop, attachments) and
/// the catalog. No Portal projection, persistence writer or provider-event
/// reducer exists in this client.
final class DeviceChatsRepository {
  DeviceChatsRepository(
    this.reader, {
    required this.readCatalog,
    required this.sender,
  }) {
    _subscription = sender.updates.listen((_) => _notify());
  }
  final DeviceChatReader reader;
  final DeviceChatSender sender;
  final Future<DeviceChatCatalog> Function() readCatalog;
  late final StreamSubscription<void> _subscription;
  final _updates = StreamController<void>.broadcast();
  Stream<void> get updates => _updates.stream;
  List<DeviceChatRef> catalog = [];
  List<DeviceChatWorkspace> workspaces = [];
  DeviceChatState? get state => reader.state;
  bool get ready => reader.ready;
  DeviceChatPendingSend? get pendingSend => sender.pendingSend;
  DeviceChatPendingSend? get confirmedSend => sender.confirmedSend;
  bool get sending => sender.sending;
  DeviceChatAttachments get attachments => sender.attachments;
  bool get connected => reader.connected;
  bool get loading => reader.loading;
  bool get loadingOlder => reader.loadingOlder;
  String? get error => reader.error;
  set error(String? value) => reader.error = value;
  int get selectionGeneration => reader.selectionGeneration;
  int get _generation => reader.selectionGeneration;
  bool _disposed = false;

  void _notify() {
    if (!_disposed) _updates.add(null);
  }

  Future<void> setConnected(bool value) async {
    await reader.setConnected(value);
    if (!value) return;
    await refreshCatalog();
    await reader.refresh();
  }

  Future<void> refreshCatalog() async {
    if (!connected) return;
    final generation = _generation;
    final result = await readCatalog();
    if (_disposed || generation != _generation || !connected) return;
    applyCatalog(result);
  }

  /// Adopts a catalog read beside this repository (the Rust overview's).
  void applyCatalog(DeviceChatCatalog result) {
    if (_disposed) return;
    catalog = result.chats;
    workspaces = result.workspaces;
    sender.catalogChanged(workspaces);
    _notify();
  }

  Future<bool> open(DeviceChatRef ref) => reader.open(ref);
  Future<void> refresh() => reader.refresh();
  Future<void> loadOlder() => reader.loadOlder();

  Future<DeviceChatRef> createChat(
    String workspaceId, {
    String? title,
    void Function(DeviceChatRef)? onCreated,
  }) => sender.createChat(
    workspaceId,
    title: title,
    onCreated: (ref) {
      onCreated?.call(ref);
      catalog = [ref, ...catalog.where((c) => c.key != ref.key)];
    },
  );

  Future<void> createTab(
    String projectId,
    String worktreeId, {
    void Function(DeviceChatRef)? onCreated,
  }) => sender.createTab(projectId, worktreeId, onCreated: onCreated);

  Future<DeviceChatSendOutcome> send(
    String text, {
    DeviceChatRef? chat,
    bool retry = false,
    bool dictated = false,
    List<String> attachmentPaths = const [],
  }) => sender.send(
    text,
    chat: chat,
    retry: retry,
    dictated: dictated,
    attachmentPaths: attachmentPaths,
  );

  Future<void> stop() => sender.stop();

  Future<void> clearSelection({int? expectedGeneration}) =>
      reader.clearSelection(expectedGeneration: expectedGeneration);

  Future<void> dispose() async {
    _disposed = true;
    await _subscription.cancel();
    await sender.dispose();
    await reader.dispose();
    await _updates.close();
  }
}

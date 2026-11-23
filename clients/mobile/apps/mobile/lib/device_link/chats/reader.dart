import 'models.dart';
import 'state.dart';

/// One computer's chat read path as [DeviceChatsRepository] reads it: the
/// selected chat's desktop-owned state and its cache, hydration, revision
/// recovery, older pages, read receipts and tab navigation. Sends, chat
/// creation and the catalog stay in the repository, over this reader.
///
abstract interface class DeviceChatReader {
  /// Fires after every change of the members below.
  Stream<void> get updates;

  /// The selected chat, or null. Unported Dart features (sends, settings,
  /// activity, pipelines) read it; treat it as read-only.
  DeviceChatState? get state;
  bool get connected;
  bool get loading;
  bool get loadingOlder;

  /// A snapshot is being read; events wait for it.
  bool get hydrating;

  /// Connected, synchronized and not loading.
  bool get ready;

  /// Bumped by every selection change, before its first await.
  int get selectionGeneration;

  /// The read path's last failure; the repository also reports its own.
  String? get error;
  set error(String? value);

  /// Disconnecting stops reads; connecting only marks the session usable
  /// (the repository reads the catalog, then [refresh]es).
  Future<void> setConnected(bool value);

  /// Selects [ref] and reads its state and newest transcript page.
  /// Returns false if another selection displaced this open.
  Future<bool> open(DeviceChatRef ref);

  /// Re-reads the selected chat.
  Future<void> refresh();
  Future<void> loadOlder();
  Future<void> clearSelection({int? expectedGeneration});

  /// Acknowledges reads of the visible chat.
  DeviceChatReadMarker get readReceipts;

  /// Archives [ref]'s tab on the computer.
  Future<void> archive(DeviceChatRef ref);
  Future<void> dispose();
}

/// Read acknowledgements for the visible chat ([DeviceChatReadReceipts]).
abstract interface class DeviceChatReadMarker {
  void observe(DeviceChatState? state, {required bool enabled});
  void invalidate();
  void retry();
  void dispose();
}

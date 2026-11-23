import 'dart:async';

import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/recent_chat.dart';
import 'package:mobile/device_link/desktop/saved_computer.dart';
import 'package:mobile/ui/core/navigation/home_chat_open_request.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';
import 'account_model.dart';
import 'computer_chat_row.dart';

/// Opens a notification's chat on the saved computer that owns it.
///
/// Selecting the computer is the visible part of the tap: it stays selected
/// even when the computer is offline or no longer lists the chat, and the
/// shell keeps the Chat home on screen. A computer this phone has not saved
/// leaves the selection alone.
final class ComputerPushChatRouter implements PushChatRouter {
  ComputerPushChatRouter({
    required this.account,
    required this.rows,
    this.timeout = const Duration(seconds: 8),
    this.createTimer = Timer.new,
  });

  final ComputerAccountModel account;
  final ComputerChatRows rows;

  /// The whole budget for one tap: restoring saved computers, reconnecting,
  /// and one refresh when the chat is newer than the cached inventory.
  final Duration timeout;
  final Timer Function(Duration, void Function()) createTimer;

  @override
  Future<HomeRecentChat?> resolve({
    required String computerId,
    required String clientChatId,
    required WorkspaceContext? workspaceContext,
  }) async {
    final expired = Completer<void>();
    final timer = createTimer(timeout, () {
      if (!expired.isCompleted) expired.complete();
    });
    try {
      // On a cold start the saved computers are still being read.
      if (!await _until(() => account.ready, expired.future)) return null;
      if (_saved(computerId) == null) return null;
      // The resolved row waits for the selection before it opens the chat;
      // persisting it must not hold the tap on secure storage I/O.
      unawaited(account.select(computerId));
      if (!await _until(() => _ready(computerId), expired.future)) return null;
      final found = _find(computerId, clientChatId, workspaceContext);
      if (found != null) return found;
      // A push often names a chat newer than the cached inventory.
      final controller = account.sessions.sessions[computerId];
      if (controller == null || expired.isCompleted) return null;
      await Future.any<void>([
        controller.overview.refresh().catchError((Object _) {}),
        expired.future,
      ]);
      return _find(computerId, clientChatId, workspaceContext);
    } catch (_) {
      return null;
    } finally {
      timer.cancel();
    }
  }

  SavedComputer? _saved(String computerId) =>
      account.computers.where((c) => c.id == computerId).firstOrNull;

  bool _ready(String computerId) {
    final controller = account.sessions.sessions[computerId];
    return controller != null &&
        controller.chats.online &&
        (controller.overview.hasRecents || !controller.scopePending);
  }

  /// [account] notifies when a session connects or its inventory changes.
  Future<bool> _until(bool Function() ready, Future<void> expired) async {
    if (ready()) return true;
    final done = Completer<bool>();
    void check() {
      if (!done.isCompleted && ready()) done.complete(true);
    }

    account.addListener(check);
    try {
      return await Future.any([done.future, expired.then((_) => false)]);
    } finally {
      account.removeListener(check);
    }
  }

  HomeRecentChat? _find(
    String computerId,
    String chatId,
    WorkspaceContext? workspaceContext,
  ) {
    final controller = account.sessions.sessions[computerId];
    final computer = _saved(computerId);
    if (controller == null || computer == null) return null;
    DeviceRecentChat? chat;
    if (workspaceContext != null) {
      chat = controller.overview
          .recents(workspaceContext)
          .where((chat) => chat.ref.id == chatId)
          .firstOrNull;
    }
    // The search catalog follows the computer's own context; the row opens
    // only if the phone's context includes it.
    chat ??= switch (controller.overview.catalog
        .where((ref) => ref.id == chatId)
        .firstOrNull) {
      final ref? => DeviceRecentChat(
        ref: ref,
        worktreeName: null,
        activityAt: null,
        attention: DeviceRecentAttention.none,
      ),
      null => null,
    };
    return chat == null ? null : rows.row(computerId, computer.name, chat);
  }
}

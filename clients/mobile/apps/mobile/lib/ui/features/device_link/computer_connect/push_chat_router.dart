import 'dart:async';

import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/recents.dart';
import 'package:mobile/ui/core/navigation/home_chat_open_request.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';
import 'account.dart';
import 'computer_chat_row.dart';
import 'controller.dart';
import 'recent_chat_inventory.dart';

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

  final ComputerConnectAccount account;
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
      if (!account.saved.computers.containsKey(computerId)) return null;
      // Selection takes effect synchronously; persisting it must not hold
      // the tap on secure storage I/O.
      unawaited(account.select(computerId));
      if (!await _until(() => _ready(computerId), expired.future)) return null;
      final found = _find(computerId, clientChatId, workspaceContext);
      if (found != null) return found;
      // A push often names a chat newer than the cached inventory.
      final controller = account.engine.sessions[computerId];
      if (controller == null || expired.isCompleted) return null;
      await Future.any<void>([
        Future.wait([
          controller.recents.refresh(),
          controller.chats.chats.refreshCatalog(),
        ]).catchError((Object _) => const <void>[]),
        expired.future,
      ]);
      return _find(computerId, clientChatId, workspaceContext);
    } catch (_) {
      return null;
    } finally {
      timer.cancel();
    }
  }

  bool _ready(String computerId) {
    final controller = account.engine.sessions[computerId];
    return controller != null &&
        controller.chats.online &&
        (controller.recents.hasInventory || !controller.scopePending);
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
    final controller = account.engine.sessions[computerId];
    final computer = account.saved.computers[computerId];
    if (controller == null || computer == null) return null;
    DeviceRecentChat? chat;
    if (workspaceContext != null) {
      chat = _inventory(
        controller,
        workspaceContext,
      ).where((chat) => chat.ref.id == chatId).firstOrNull;
    }
    // The search catalog follows the computer's own context; the row opens
    // only if the phone's context includes it.
    chat ??= switch (controller.chats.chats.catalog
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

  List<DeviceRecentChat> _inventory(
    ComputerConnectController controller,
    WorkspaceContext workspaceContext,
  ) => buildComputerRecentChatInventory(
    context: workspaceContext,
    summaries: controller.recents.chats(workspaceContext),
    projects: controller.worktrees.projects,
    worktrees: controller.worktrees.worktrees,
  );
}

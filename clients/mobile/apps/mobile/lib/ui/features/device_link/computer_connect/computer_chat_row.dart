import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/recents.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';
import '../chats_screen.dart';
import 'account.dart';

/// Builds the shell's row for one computer chat. The drawer's Recents and
/// notification taps share it, so a chat opens the same way from either.
final class ComputerChatRows {
  ComputerChatRows(this.account);
  final ComputerConnectAccount account;
  bool _opening = false;

  HomeRecentChat row(
    String computerId,
    String computerName,
    DeviceRecentChat chat,
  ) => HomeRecentChat(
    key: 'computer-$computerId-${chat.ref.key}',
    isCurrent: () =>
        account.engine.selectedId == computerId &&
        account.engine.sessions[computerId]?.chats.state?.ref.key ==
            chat.ref.key,
    title: chat.ref.title,
    computerName: computerName,
    locationLabel: chat.worktreeName,
    activityAt: chat.activityAt,
    attention: switch (chat.attention) {
      DeviceRecentAttention.none => RecentChatAttention.none,
      DeviceRecentAttention.unread => RecentChatAttention.unread,
      DeviceRecentAttention.awaitingAnswer =>
        RecentChatAttention.awaitingAnswer,
    },
    open: (context, showChat) =>
        _open(context, computerId, chat.ref, chat.worktreeName, showChat),
  );

  /// Switches to the chat's computer, so its overview and Home follow, then
  /// lets the shell host the chat with its navigation menu.
  Future<void> _open(
    BuildContext context,
    String computerId,
    DeviceChatRef ref,
    String? worktreeName,
    Future<void> Function(Widget page) showChat,
  ) async {
    final controller = account.engine.sessions[computerId];
    if (_opening || controller == null || !controller.chats.online) return;
    final workspaceContext = context.read<WorkspaceContext?>();
    _opening = true;
    try {
      // Selection takes effect synchronously. Persisting the next cold-start
      // choice must not hold up the chat page on secure storage I/O.
      unawaited(account.select(computerId));
      // Open only what the current context still shows after switching
      // computers; selection listeners may have changed the shell.
      if (!context.mounted ||
          context.read<WorkspaceContext?>() != workspaceContext ||
          !controller.scopeFor(workspaceContext).includesChat(ref)) {
        return;
      }
      controller.enterChat();
      final opening = controller.chats.open(ref);
      var generation = controller.chats.chats.selectionGeneration;
      try {
        await showChat(
          DeviceChatScreen(
            model: controller.chats,
            locationLabel: worktreeName,
            worktree: controller.activityContext(ref),
          ),
        );
        // The page owned the selection, including tab switches and reconnects
        // inside it. Read it as the shell leaves the page:
        // a chat opened after that, while this open finishes, keeps its own.
        generation = controller.chats.chats.selectionGeneration;
      } finally {
        // Navigation must not wait for hydration or a full overview refresh.
        // Generation checks keep retiring work off the next chat's selection.
        unawaited(opening.then((_) => controller.restoreOverview(generation)));
      }
    } finally {
      _opening = false;
    }
  }
}

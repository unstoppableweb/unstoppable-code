import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/recents.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';
import '../chats_screen.dart';
import 'account.dart';
import 'recent_chat_inventory.dart';

/// The drawer's Recents across every connected computer, newest first. Rows
/// follow the phone's selected context, whatever context each computer has
/// selected.
final class ComputerRecentChats implements HomeRecentChatsSource {
  ComputerRecentChats(this.account);
  final ComputerConnectAccount account;
  bool _opening = false;

  @override
  void addListener(VoidCallback listener) => account.addListener(listener);
  @override
  void removeListener(VoidCallback listener) =>
      account.removeListener(listener);

  @override
  Future<void> refresh() async {
    await Future.wait([
      for (final computer in account.connectedComputers)
        if (account.engine.sessions[computer.id] case final controller?)
          // Also update ownership evidence so newly listed worktrees can open.
          // refresh() reads inventory without changing the active chat scopes.
          controller.refresh(),
    ]);
  }

  @override
  HomeRecentChatsSnapshot read(WorkspaceContext context) {
    final computers = [
      for (final computer in account.connectedComputers)
        if (account.engine.sessions[computer.id] case final controller?)
          (id: computer.id, name: computer.name, controller: controller),
    ];
    return (
      chats: buildComputerRecentChats([
        for (final computer in computers)
          [
            for (final chat in buildComputerRecentChatInventory(
              context: context,
              summaries: computer.controller.recents.chats(context),
              projects: computer.controller.worktrees.projects,
              worktrees: computer.controller.worktrees.worktrees,
            ))
              _row(computer.id, computer.name, chat),
          ],
      ]),
      loading: computers.any(
        (computer) =>
            !computer.controller.recents.hasInventory &&
            (computer.controller.loading || computer.controller.scopePending),
      ),
      connected: computers.isNotEmpty,
    );
  }

  HomeRecentChat _row(
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

/// Interleaves each computer's rows by activity, newest first, then caps them
/// at [limit] per computer. A busy computer cannot hide every chat from
/// another one. Rows without a timestamp sort last, keeping their source order.
List<HomeRecentChat> buildComputerRecentChats(
  List<List<HomeRecentChat>> computers, {
  int limit = recentChatsLimit,
}) {
  final indexed =
      [
        for (final (computer, rows) in computers.indexed)
          for (final chat in rows) (computer: computer, chat: chat),
      ].indexed.toList()..sort((left, right) {
        final a = left.$2.chat.activityAt, b = right.$2.chat.activityAt;
        if (a == null && b == null) return left.$1.compareTo(right.$1);
        if (a == null) return 1;
        if (b == null) return -1;
        final byActivity = b.compareTo(a);
        return byActivity != 0 ? byActivity : left.$1.compareTo(right.$1);
      });
  final counts = <int, int>{};
  final result = <HomeRecentChat>[];
  for (final (_, entry) in indexed) {
    final count = counts[entry.computer] ?? 0;
    if (count >= limit) continue;
    result.add(entry.chat);
    counts[entry.computer] = count + 1;
  }
  return List.unmodifiable(result);
}

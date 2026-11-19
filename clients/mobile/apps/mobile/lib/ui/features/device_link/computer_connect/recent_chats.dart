import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';
import 'account.dart';
import 'computer_chat_row.dart';
import 'recent_chat_inventory.dart';

/// The drawer's Recents across every connected computer, newest first. Rows
/// follow the phone's selected context, whatever context each computer has
/// selected.
final class ComputerRecentChats implements HomeRecentChatsSource {
  ComputerRecentChats(this.account) : rows = ComputerChatRows(account);
  final ComputerConnectAccount account;

  /// Builds rows that open their chat; push taps open chats through it too.
  final ComputerChatRows rows;

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
              rows.row(computer.id, computer.name, chat),
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

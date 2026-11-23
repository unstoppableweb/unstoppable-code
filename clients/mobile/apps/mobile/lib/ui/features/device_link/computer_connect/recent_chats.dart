import 'package:flutter/widgets.dart';
import 'package:mobile/data/models/computer_recent_order.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';
import 'account_model.dart';
import 'computer_chat_row.dart';

/// The drawer's Recents across every connected computer, newest first. Rows
/// follow the phone's selected context, whatever context each computer has
/// selected.
final class ComputerRecentChats implements HomeRecentChatsSource {
  ComputerRecentChats(this.account, {required this.order})
    : rows = ComputerChatRows(account);
  final ComputerAccountModel account;
  final ComputerRecentOrder order;

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
        if (account.sessions.sessions[computer.id] case final controller?)
          // Also update ownership evidence so newly listed worktrees can open.
          // refresh() reads inventory without changing the active chat scopes.
          controller.refresh(),
    ]);
  }

  @override
  HomeRecentChatsSnapshot read(WorkspaceContext context) {
    final computers = [
      for (final computer in account.connectedComputers)
        if (account.sessions.sessions[computer.id] case final controller?)
          (id: computer.id, name: computer.name, controller: controller),
    ];
    final groups = [
      for (final computer in computers)
        [
          for (final chat in computer.controller.overview.recents(context))
            rows.row(computer.id, computer.name, chat),
        ],
    ];
    return (
      chats: _ordered(groups),
      loading: computers.any(
        (computer) =>
            !computer.controller.overview.hasRecents &&
            (computer.controller.loading || computer.controller.scopePending),
      ),
      connected: computers.isNotEmpty,
    );
  }

  List<HomeRecentChat> _ordered(List<List<HomeRecentChat>> groups) {
    final flat = groups.expand((group) => group).toList(growable: false);
    if (flat.isEmpty) return const [];
    final indexes = order(
      computers: [
        for (final group in groups)
          [for (final row in group) row.activityAt?.microsecondsSinceEpoch],
      ],
      limit: recentChatsLimit,
    );
    return List.unmodifiable([for (final index in indexes) flat[index]]);
  }
}

import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/recents.dart';
import 'package:mobile/device_link/worktrees/context_scope.dart';
import 'package:mobile/device_link/worktrees/models.dart';

/// Complete summaries add activity and attention metadata, but a failed or
/// unsupported summary read must not hide tabs the worktree inventory loaded.
/// Scope the fallback to this phone's context without hiding other computers.
List<DeviceRecentChat> buildComputerRecentChatInventory({
  required WorkspaceContext context,
  required List<DeviceRecentChat> summaries,
  required List<DeviceProject> projects,
  required List<DeviceWorktree> worktrees,
}) {
  final rows = {for (final chat in summaries) chat.ref.key: chat};
  final scope = DeviceContextScope(context, projects, worktrees);
  for (final worktree in scope.worktrees) {
    for (final chat in worktree.chats) {
      rows.putIfAbsent(
        chat.key,
        () => DeviceRecentChat(
          ref: chat,
          worktreeName: worktree.name,
          // The worktree row has no per-chat activity or attention evidence.
          // Do not assign its aggregate status to every chat in the worktree.
          activityAt: null,
          attention: DeviceRecentAttention.none,
        ),
      );
    }
  }
  return List.unmodifiable(rows.values);
}

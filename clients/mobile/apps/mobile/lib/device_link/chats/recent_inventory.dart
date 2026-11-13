import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import '../desktop/ipc.dart';
import '../protocol.dart';
import 'dto.dart';

/// A strict overview can fail on one unreadable chat scope. Recover the other
/// scopes with their real activity dates, rather than losing the whole computer.
Future<RemoteSessionSnapshot> readRecentInventory(
  DesktopIpc ipc, {
  required bool Function() isCurrent,
}) async {
  Future<RemoteSessionSnapshot> read([Map<String, Object?>? request]) async =>
      RemoteSessionSnapshot.fromJson(
        deviceLinkObject(
          deviceChatDto(
            await ipc.invoke('desktop:session-snapshot', [?request]),
          ),
        ),
      );
  try {
    return await read({'includeChatSummaries': true});
  } on DesktopIpcRefusal {
    if (!isCurrent()) rethrow;
    final overview = await read();
    final projects = {
      for (final project in overview.workspaces)
        if (!project.hidden &&
            (project.type == RemoteWorkspaceType.singleRepo ||
                project.type == RemoteWorkspaceType.multiRepo))
          project.localId,
    };
    final worktrees = overview.worktrees
        .where((w) => w.hidden != true && projects.contains(w.workspaceLocalId))
        .toList();
    final summaries = <RemoteChatSummary>[];
    for (var offset = 0; offset < worktrees.length; offset += 3) {
      if (!isCurrent()) break;
      final batch = await Future.wait(
        worktrees.skip(offset).take(3).map((worktree) async {
          try {
            final snapshot = await read({
              'includeChatSummaries': true,
              'workspaceLocalId': worktree.workspaceLocalId,
              'worktreeLocalId': worktree.localId,
            });
            return snapshot.chatSummaries.where(
              (chat) =>
                  chat.workspaceLocalId == worktree.workspaceLocalId &&
                  chat.worktreeLocalId == worktree.localId,
            );
          } on DesktopIpcRefusal {
            // Leave the failed scope unavailable; never repair stored chats
            // or let its failure discard independently readable scopes.
            return const <RemoteChatSummary>[];
          }
        }),
      );
      summaries.addAll(batch.expand((rows) => rows));
    }
    return overview.copyWith(chatSummaries: summaries);
  }
}

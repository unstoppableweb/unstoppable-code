import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_context_scope.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/workspace_context.dart';
import '../desktop/ipc.dart';
import 'models.dart';
import 'recent_inventory.dart';

/// Why a recent chat carries the attention dot, if it does.
enum DeviceRecentAttention { none, unread, awaitingAnswer }

/// One chat in a computer's Recents.
final class DeviceRecentChat {
  const DeviceRecentChat({
    required this.ref,
    required this.worktreeName,
    required this.activityAt,
    required this.attention,
  });
  final DeviceChatRef ref;

  /// The worktree's name; null for Cowork chats.
  final String? worktreeName;

  /// Null when the computer does not say when the chat was last active.
  final DateTime? activityAt;
  final DeviceRecentAttention attention;
}

/// The computer's complete chat inventory. Unlike the search catalog, the
/// snapshot's chat summaries are not narrowed to the context selected on the
/// computer, so the phone's own context decides which chats it shows.
final class DeviceRecentChatsRepository {
  DeviceRecentChatsRepository(this.ipc, {this.onChanged});
  final DesktopIpc ipc;
  final void Function()? onChanged;
  RemoteSessionSnapshot? _snapshot;
  int _generation = 0;
  Future<void>? _refreshing;
  bool _refreshAgain = false;
  bool get hasInventory => _snapshot != null;

  /// Publish each completed observation before re-reading. Superseding a slow
  /// read on every activity push can otherwise leave a busy computer empty.
  Future<void> refresh() {
    final pending = _refreshing;
    if (pending != null) {
      _refreshAgain = true;
      return pending;
    }
    return _refreshing = _refresh(++_generation);
  }

  Future<void> _refresh(int generation) async {
    try {
      do {
        _refreshAgain = false;
        await _read(generation);
        if (generation != _generation) return;
      } while (_refreshAgain);
    } finally {
      if (generation == _generation) _refreshing = null;
    }
  }

  Future<void> _read(int generation) async {
    try {
      final snapshot = await readRecentInventory(
        ipc,
        isCurrent: () => generation == _generation,
      );
      if (generation != _generation) return;
      _snapshot = snapshot;
      onChanged?.call();
    } catch (_) {
      // Keep the last observation until a later refresh succeeds. Recents
      // must not fail the overview's inventory read.
    }
  }

  /// Retain the rows while retiring reads from the old session.
  void pause() {
    _generation++;
    _refreshing = null;
    _refreshAgain = false;
  }

  void invalidate() {
    pause();
    _snapshot = null;
  }

  List<DeviceRecentChat> chats(WorkspaceContext context) => switch (_snapshot) {
    final snapshot? => buildDeviceRecentChats(context, snapshot),
    null => const [],
  };
}

/// The snapshot's chats in [context], unordered. Rows the user could not open
/// are left out: chats in hidden workspaces or worktrees, worktree chats whose
/// worktree is missing, and archived Cowork chats.
List<DeviceRecentChat> buildDeviceRecentChats(
  WorkspaceContext context,
  RemoteSessionSnapshot snapshot,
) {
  final scope = RemoteContextScope(context, snapshot.workspaces);
  final hiddenWorkspaceIds = {
    for (final workspace in scope.workspaces)
      if (workspace.hidden) workspace.localId,
  };
  final worktreesById = {
    for (final worktree in scope.worktrees(snapshot.worktrees))
      if (worktree.hidden != true &&
          !hiddenWorkspaceIds.contains(worktree.workspaceLocalId))
        worktree.localId: worktree,
  };
  final rows = <DeviceRecentChat>[];
  for (final chat in snapshot.chatSummaries) {
    if (chat.scope == RemoteChatScope.standalone) continue;
    final worktree = worktreesById[chat.worktreeLocalId];
    if (worktree == null) continue;
    final workspace = chat.workspaceLocalId;
    if (workspace != null &&
        workspace.isNotEmpty &&
        workspace != worktree.workspaceLocalId) {
      continue;
    }
    rows.add(
      DeviceRecentChat(
        ref: DeviceChatRef(
          projectId: worktree.workspaceLocalId,
          worktreeId: worktree.localId,
          id: chat.chatId,
          title: chat.displayTitle,
        ),
        worktreeName: worktree.label ?? worktree.branch,
        activityAt: _parse(chat.lastMessageAt) ?? _parse(chat.createdAt),
        attention: _hasOpenQuestion(chat.pendingQuestions)
            ? DeviceRecentAttention.awaitingAnswer
            : chat.hasUnread == true
            ? DeviceRecentAttention.unread
            : DeviceRecentAttention.none,
      ),
    );
  }

  final standaloneSummaries = {
    for (final chat in snapshot.chatSummaries)
      if (chat.scope == RemoteChatScope.standalone) chat.chatId: chat,
  };
  for (final chat in scope.standaloneChats(snapshot.standaloneChats)) {
    if (chat.archived == true ||
        hiddenWorkspaceIds.contains(chat.projectLocalId)) {
      continue;
    }
    final summary = standaloneSummaries[chat.localId];
    final rowActivity = _parse(chat.lastMessageAt);
    final summaryActivity = _parse(summary?.lastMessageAt);
    final entryId = chat.workEntryId;
    rows.add(
      DeviceRecentChat(
        // A Cowork chat's scope is its work entry; migrated chats without one
        // use the chat id as the entry id.
        ref: DeviceChatRef(
          projectId: chat.projectLocalId,
          worktreeId: entryId != null && entryId.isNotEmpty
              ? entryId
              : chat.localId,
          id: chat.localId,
          title: chat.displayTitle,
        ),
        worktreeName: null,
        activityAt:
            summaryActivity != null &&
                (rowActivity == null || summaryActivity.isAfter(rowActivity))
            ? summaryActivity
            : rowActivity,
        attention: _hasOpenQuestion(summary?.pendingQuestions)
            ? DeviceRecentAttention.awaitingAnswer
            : chat.hasUnread == true || summary?.hasUnread == true
            ? DeviceRecentAttention.unread
            : DeviceRecentAttention.none,
      ),
    );
  }
  return rows;
}

bool _hasOpenQuestion(List<AskUserQuestionState>? questions) =>
    questions != null && questions.any((question) => !question.answered);

DateTime? _parse(String? iso) => iso == null ? null : DateTime.tryParse(iso);

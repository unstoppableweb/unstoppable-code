import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/recent_chat.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import 'package:mobile/device_link/worktrees/overview_scope.dart';

export 'package:mobile/device_link/worktrees/overview_scope.dart';

/// One computer's project and worktree inventory.
abstract interface class ComputerOverviewModel implements Listenable {
  bool get loading;

  /// Ownership evidence is being re-read; actions must wait for it.
  bool get scopePending;
  String? get error;

  /// A roster was read since the last invalidation.
  bool get hasInventory;

  /// Every listed project and non-archived worktree, in sidebar order.
  List<DeviceProject> get projects;
  List<DeviceWorktree> get worktrees;
  Set<String> get codeProjectIds;
  bool codeGraphBuilding(DeviceWorktree worktree);

  /// The shared worktree row's input for [worktree].
  RemoteWorktree row(DeviceWorktree worktree);
  DeviceOverviewScope scope(WorkspaceContext context);

  /// The search catalog and its workspaces.
  List<DeviceChatRef> get catalog;
  List<DeviceChatWorkspace> get catalogWorkspaces;

  /// A Cowork chat's states, from its scope's desktop state.
  bool chatUnread(DeviceChatRef chat);
  bool chatWorking(DeviceChatRef chat);

  /// The computer's chat inventory for Recents was read.
  bool get hasRecents;

  /// This computer's Recents in [context], unordered.
  List<DeviceRecentChat> recents(WorkspaceContext context);

  /// The server notification space of Cowork chat [chatId]'s Work Entry,
  /// when the computer has registered one. The search catalog behind the
  /// Cowork rows does not carry it; the session snapshot does.
  String? workEntryNotificationSpaceId(String chatId);

  /// Re-reads inventory, ownership, the catalog and Recents. Resolves when
  /// the read finished; does nothing while one is running.
  Future<void> refresh();

  /// [refresh], or once more after the running one.
  Future<void> refreshSoon();

  /// Re-reads the worktree roster only.
  Future<void> reloadWorktrees();

  /// Re-reads [worktree]'s chats into it, as the desktop has them now. A
  /// read from before a reconnect or a newer roster leaves it unchanged.
  Future<void> loadWorktree(DeviceWorktree worktree);

  /// Shows the overview: claims every chat scope and refreshes.
  Future<void> watch();

  /// A chat takes over: overview reads stop.
  void enterChat();

  /// Called at the start of every refresh, before its reads.
  set onRefreshStarted(VoidCallback? callback);
  void dispose();
}

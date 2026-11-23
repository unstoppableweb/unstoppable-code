import 'dart:async';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/ui/core/activity/worktree_activity_context.dart';
import 'package:mobile/device_link/projects/clones.dart';
import 'package:mobile/device_link/worktrees/writes.dart';
import 'package:flutter/foundation.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import '../chats_view_model.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'home_flows.dart';
import 'overview_model.dart';

// An interrupted open needs a next step while ownership is being re-read.
const deviceScopeRefreshingMessage =
    'Projects are refreshing. Try opening this task again when they finish.';

/// One computer's writes the overview and Home drive (P8): worktree creation
/// and archive, project clones, and Home's launcher options.
typedef ComputerConnectWrites = ({
  DeviceWorktreeCreation worktrees,
  DeviceWorktreeArchive archive,
  DeviceProjectClones clones,
  ComputerHomeFlows homeFlows,
});

/// The selected computer's Projects screen and its chat navigation.
class ComputerConnectController extends ChangeNotifier {
  ComputerConnectController(
    this.chats, {
    required this.overview,
    required ComputerConnectWrites Function(VoidCallback onChanged) writes,
  }) {
    _writes = writes(_notify);
    _writes.archive.addListener(_notify);
    overview
      ..onRefreshStarted = clones.readBack
      ..addListener(_overviewChanged);
  }

  final DeviceChatsViewModel chats;
  final ComputerOverviewModel overview;
  late final ComputerConnectWrites _writes;

  ComputerHomeFlows get homeFlows => _writes.homeFlows;
  DeviceWorktreeCreation get worktrees => _writes.worktrees;
  DeviceProjectClones get clones => _writes.clones;
  bool _disposed = false;
  bool get loading => overview.loading;
  bool get scopePending => overview.scopePending;
  String? get error => overview.error;
  bool _active = true;
  bool get active => !_disposed && _active;

  /// Navigation only. Other computers keep their sessions, caches and drafts.
  void setActive(bool value) {
    if (_active == value) return;
    _active = value;
    _notify();
  }

  /// Actions need current ownership even while the overview shows cached rows.
  DeviceOverviewScope scopeFor(WorkspaceContext? context) =>
      scopePending ? const EmptyOverviewScope() : overviewScopeFor(context);

  DeviceOverviewScope overviewScopeFor(WorkspaceContext? context) => active
      ? overview.scope(context ?? const WorkspaceContext.personal())
      : const EmptyOverviewScope();

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  void _overviewChanged() {
    clones.retireListed({for (final project in overview.projects) project.id});
    _notify();
  }

  /// Explicit search retry acknowledges prior open errors before reloading.
  Future<void> retrySearch() {
    if (!active) return Future.value();
    chats.error = null;
    return refresh();
  }

  Future<void> refresh() => overview.refresh();

  /// Re-reads [worktree]'s chats into it.
  Future<void> loadWorktree(DeviceWorktree worktree) =>
      overview.loadWorktree(worktree);

  bool canArchiveWorktree(DeviceWorktree worktree) =>
      chats.online &&
      !scopePending &&
      overview.codeProjectIds.contains(worktree.projectId);
  bool isArchivingWorktree(DeviceWorktree worktree) =>
      _writes.archive.isArchiving(worktree);

  /// Keeps the row archiving until a re-read drops it, so it does not flash
  /// back between the archive reply and the overview refresh.
  Future<void> archiveWorktree(DeviceWorktree worktree) async {
    if (!canArchiveWorktree(worktree)) return;
    await _writes.archive.archive(worktree);
  }

  WorktreeActivityContext? activityContext(DeviceChatRef ref) {
    final project = overview.projects
        .where((p) => p.id == ref.projectId)
        .firstOrNull;
    chats.activity.setWorkspaceKind(
      ref.projectId,
      project?.type ?? 'single-repo',
    );
    return overview.codeProjectIds.contains(ref.projectId)
        ? WorktreeActivityContext(
            workspaceLocalId: ref.projectId,
            localId: ref.worktreeId,
          )
        : null;
  }

  void enterChat() => overview.enterChat();

  Future<void> watchOverview() => overview.watch();

  Future<void> restoreOverview(int selectionGeneration) async {
    if (_disposed || chats.chats.selectionGeneration != selectionGeneration) {
      return;
    }
    await chats.leaveChat(expectedGeneration: selectionGeneration);
    if (_disposed ||
        chats.chats.selectionGeneration != selectionGeneration + 1) {
      return;
    }
    await watchOverview();
  }

  @override
  void dispose() {
    _disposed = true;
    overview.removeListener(_overviewChanged);
    overview.dispose();
    _writes.archive
      ..removeListener(_notify)
      ..dispose();
    unawaited(worktrees.dispose());
    clones.dispose();
    super.dispose();
  }
}

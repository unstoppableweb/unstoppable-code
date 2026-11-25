import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/worktrees/models.dart';

import 'controller.dart';
import 'overview_model.dart';

enum ProjectOpenKind { worktree, chat }

typedef ProjectOpenRequest = ({
  WorkspaceContext? workspace,
  ProjectOpenKind kind,
  String key,
  int? lostSession,
});

/// Holds the latest tap until the current session has read its target.
final class ProjectOpenQueue {
  ProjectOpenRequest? pending;
  int _generation = 0;
  int? _worktreeRead;
  bool _openingChat = false;

  int get generation => _generation;
  bool get readingWorktree => _worktreeRead != null;
  bool get openingChat => _openingChat;

  void invalidate() {
    pending = null;
    _worktreeRead = null;
    _generation++;
  }

  int beginWorktreeRead() {
    invalidate();
    return _worktreeRead = generation;
  }

  bool finishWorktreeRead(int token) {
    if (_worktreeRead != token) return false;
    _worktreeRead = null;
    return true;
  }

  bool waiting(
    ComputerConnectController controller,
    ProjectOpenRequest request,
  ) {
    if (!controller.chats.online) {
      return controller.chats.connection.reconnecting;
    }
    if (request.lostSession == controller.chats.connection.connectedSession &&
        request.lostSession != null) {
      return true;
    }
    return controller.error == null &&
        (controller.scopePending ||
            (request.kind == ProjectOpenKind.chat &&
                controller.overview.currentCatalog == null));
  }

  void checkPending({
    required ComputerConnectController? controller,
    required void Function(void Function()) afterFrame,
    required bool Function() isMounted,
    required bool Function() paused,
    required bool Function(WorkspaceContext?) canOpen,
    required void Function(ProjectOpenRequest?) onSettled,
  }) {
    final request = pending;
    if (request == null || controller == null) return;
    final scheduledGeneration = generation;
    afterFrame(() {
      if (!isMounted() ||
          generation != scheduledGeneration ||
          pending != request) {
        return;
      }
      final stillHere = canOpen(request.workspace);
      if (stillHere && (paused() || waiting(controller, request))) return;
      pending = null;
      onSettled(
        stillHere && controller.chats.online && !controller.scopePending
            ? request
            : null,
      );
    });
  }

  WorktreeRead? completeWorktreeRead(
    ComputerConnectController controller, {
    required int token,
    required WorktreeRead read,
    required WorkspaceContext? workspace,
    required String key,
    required int? session,
    required bool switcherInterrupted,
    required DeviceWorktree worktree,
  }) {
    if (!finishWorktreeRead(token)) return null;
    final sessionLost =
        read == WorktreeRead.sessionLost ||
        session != controller.chats.connection.connectedSession;
    if (!sessionLost &&
        read != WorktreeRead.stale &&
        !(read == WorktreeRead.loaded &&
            (switcherInterrupted ||
                _snapshotSuperseded(controller, workspace, worktree))) &&
        !controller.scopePending) {
      return read;
    }
    pending = (
      workspace: workspace,
      kind: ProjectOpenKind.worktree,
      key: key,
      lostSession: sessionLost ? session : null,
    );
    return null;
  }

  bool _snapshotSuperseded(
    ComputerConnectController controller,
    WorkspaceContext? workspace,
    DeviceWorktree read,
  ) {
    final current = controller
        .scopeFor(workspace)
        .worktrees
        .where((row) => row.key == read.key)
        .firstOrNull;
    return current == null ||
        current.inventoryInstance != read.inventoryInstance ||
        current.chatReadSequence > read.chatReadSequence;
  }

  Future<void> openWorktreeChat(
    ComputerConnectController controller,
    DeviceWorktree worktree, {
    required int token,
    required Future<void> Function() waitForDestination,
    required Future<void> Function() showChat,
    required void Function() onChanged,
  }) async {
    _openingChat = true;
    onChanged();
    var selection = controller.chats.chats.selectionGeneration;
    try {
      controller.enterChat();
      final ref =
          worktree.chats
              .where((c) => c.id == worktree.activeChatId)
              .firstOrNull ??
          worktree.chats.firstOrNull;
      if (ref != null) {
        // The target is set before the transcript loads.
        final opening = controller.chats.open(ref);
        selection = controller.chats.chats.selectionGeneration;
        await showChat();
        selection = controller.chats.chats.selectionGeneration;
        await opening;
        return;
      }
      await controller.chats.chats.createTab(
        worktree.projectId,
        worktree.id,
        onCreated: (_) =>
            selection = controller.chats.chats.selectionGeneration,
      );
      await waitForDestination();
      if (selection != controller.chats.chats.selectionGeneration) return;
      if (generation == token) await showChat();
      selection = controller.chats.chats.selectionGeneration;
    } finally {
      _openingChat = false;
      onChanged();
      await controller.restoreOverview(selection);
    }
  }

  DeviceChatRef? resolveChat(
    ComputerConnectController controller,
    ProjectOpenRequest request,
  ) {
    final catalog = controller.overview.currentCatalog;
    if (catalog == null) return null;
    final scope = controller.scopeFor(request.workspace);
    return catalog
        .where((ref) => ref.key == request.key && scope.includesChat(ref))
        .firstOrNull;
  }
}

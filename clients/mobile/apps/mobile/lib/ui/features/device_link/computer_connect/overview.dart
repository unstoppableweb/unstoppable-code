import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/ui/core/chat/widgets/chat_overview_row.dart';
import 'package:mobile/device_link/projects/clone_repository.dart';
import 'package:mobile/device_link/worktrees/repository.dart';
import 'package:mobile/ui/core/action_dialogs.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/workspaces/add_project_sheet.dart';
import 'package:mobile/ui/core/workspaces/project_clone_row.dart';
import 'package:mobile/ui/core/workspaces/workspace_section_header.dart';
import 'controller.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/ui/core/widgets/chat_list_notice.dart';
import 'worktree_archive_row.dart';

class DeviceProjectsOverview extends StatefulWidget {
  const DeviceProjectsOverview({
    super.key,
    required this.controller,
    required this.onOpenWorktree,
    this.opening = false,
    this.openError,
    required this.onOpenChat,
    this.onCreateTask,
  });
  final ComputerConnectController controller;
  final ValueChanged<DeviceProject>? onCreateTask;
  final bool opening;
  final String? openError;
  final ValueChanged<DeviceWorktree> onOpenWorktree;
  final ValueChanged<DeviceChatRef> onOpenChat;
  @override
  State<DeviceProjectsOverview> createState() => _DeviceProjectsOverviewState();
}

class _DeviceProjectsOverviewState extends State<DeviceProjectsOverview> {
  final _expanded = <String>{};
  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final workspaceContext = context.watch<WorkspaceContext?>();
    final scope = controller.overviewScopeFor(workspaceContext);
    // A clone is added as Personal, so adding one and its pending rows stay
    // out of organization contexts.
    final addsProjects = workspaceContext?.isPersonal ?? true;
    final clones = addsProjects && controller.active
        ? controller.clones.clones
        : const <DeviceProjectClone>[];
    final worktrees = scope.worktrees;
    final projects = scope.projects;
    final colors = AppColors.of(context);
    final allChats = scope.chats(controller.chats.chats.catalog);
    final coworkProjectIds = {
      for (final project in projects)
        if (project.type == 'cowork') project.id,
    };
    final standalone = allChats
        .where((chat) => coworkProjectIds.contains(chat.projectId))
        .toList();
    final rows = <Widget>[
      if (controller.error case final error?) Text(error),
      if (widget.openError case final error?) Text(error),
      if (scope.hasUnknownOwners)
        // Missing ownership is not an empty computer or a Personal project.
        ChatListNotice(
          message:
              'Some projects are hidden because their ownership is unavailable.',
          onRetry: controller.refresh,
        ),
      // Worktrees belong under their projects, without a duplicate attention queue.
      Padding(
        padding: const EdgeInsets.only(bottom: 4),
        child: Row(
          children: [
            Text(
              'Projects',
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: colors.foregroundSecondary,
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
            ),
            const SizedBox(width: 8),
            if (projects.isNotEmpty)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  '${projects.length}',
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ),
            const Spacer(),
            if (addsProjects)
              CanopyIconButton(
                key: const ValueKey('add-project-header'),
                glyph: CanopyGlyph.plusMedium,
                tooltip: 'Add project',
                size: CanopyIconButtonSize.small,
                onPressed: controller.chats.online
                    ? () => unawaited(_addProject())
                    : null,
              ),
          ],
        ),
      ),
      for (final clone in clones)
        ProjectCloneRow(
          key: ValueKey('device-project-clone-${clone.jobId}'),
          name: clone.name,
          status: switch (clone.phase) {
            DeviceProjectClonePhase.cloning => ProjectCloneStatus.cloning,
            DeviceProjectClonePhase.awaitingProject =>
              ProjectCloneStatus.awaitingProject,
            DeviceProjectClonePhase.failed => ProjectCloneStatus.failed,
            DeviceProjectClonePhase.unknown => ProjectCloneStatus.unknown,
          },
          failure: clone.failure,
          onDismiss: clone.dismissible
              ? () => controller.clones.dismiss(clone.jobId)
              : null,
        ),
    ];
    for (final project in projects) {
      final branches = worktrees
          .where((w) => w.projectId == project.id)
          .toList();
      final chats = standalone.where((c) => c.projectId == project.id).toList();
      final empty = project.type == 'cowork' ? chats.isEmpty : branches.isEmpty;
      if (!project.alwaysShow && empty) continue;
      rows.add(
        WorkspaceSectionHeader(
          key: ValueKey('device-project-${project.id}'),
          id: project.id,
          name: project.name,
          itemLabel: project.type == 'cowork'
              ? '${chats.length} ${chats.length == 1 ? 'chat' : 'chats'}'
              : '${branches.length} ${branches.length == 1 ? 'worktree' : 'worktrees'}',
          icon: workspaceTypeGlyph(project.type),
          accent: project.temporary
              ? colors.foregroundSecondary
              : workspaceColor(project.color) ??
                    Theme.of(context).colorScheme.primary,
          collapsed: !_expanded.contains(project.id),
          onCreateTask: widget.onCreateTask == null
              ? null
              : () => widget.onCreateTask!(project),
          createTaskEnabled:
              !widget.opening &&
              controller.chats.online &&
              !controller.scopePending,
          onToggle: () => setState(() {
            if (!_expanded.remove(project.id)) _expanded.add(project.id);
          }),
        ),
      );
      if (!_expanded.contains(project.id)) continue;
      if (branches.isEmpty && chats.isEmpty) {
        rows.add(
          Padding(
            padding: const EdgeInsets.only(
              left: AppDimens.navRowTitleInset,
              bottom: 10,
            ),
            child: Text(
              project.type == 'cowork' ? 'No chats' : 'No worktrees',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colors.foregroundSecondary,
              ),
            ),
          ),
        );
      }
      for (final worktree in branches) {
        rows.add(_worktree(worktree));
      }
      for (final chat in chats) {
        rows.add(_chat(chat));
      }
      rows.add(const SizedBox(height: 4));
    }
    final nothingLoaded =
        worktrees.isEmpty && standalone.isEmpty && projects.isEmpty;
    final pending =
        !controller.chats.online ||
        controller.loading ||
        controller.scopePending;
    if (pending &&
        !controller.worktrees.hasInventory &&
        nothingLoaded &&
        controller.error == null) {
      // Initial loads and invalidated ownership are pending, never known empty.
      // Refreshes behind loaded rows stay silent.
      rows.add(
        const Padding(
          key: ValueKey('device-projects-loading'),
          padding: EdgeInsets.all(24),
          child: Center(child: LoadingSpinner(size: 22)),
        ),
      );
    } else if (worktrees.isEmpty &&
        standalone.isEmpty &&
        clones.isEmpty &&
        (!pending || controller.worktrees.hasInventory) &&
        controller.error == null &&
        !scope.hasUnknownOwners) {
      rows.add(
        const Padding(
          padding: EdgeInsets.all(24),
          child: Text('No worktrees are available in this context.'),
        ),
      );
    }
    final indexByKey = {
      for (var index = 0; index < rows.length; index++) ?rows[index].key: index,
    };
    return RefreshIndicator(
      edgeOffset: CanopyScaffold.contentPaddingOf(context).top,
      onRefresh: controller.refresh,
      child: ListView.builder(
        key: const ValueKey('device-projects-list'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding:
            CanopyScaffold.contentPaddingOf(context) +
            const EdgeInsets.fromLTRB(16, 12, 16, 32),
        itemCount: rows.length,
        findChildIndexCallback: (key) => indexByKey[key],
        itemBuilder: (_, index) => rows[index],
      ),
    );
  }

  Future<void> _addProject() async {
    final controller = widget.controller;
    // An unknown result blocks another clone, even when its row is hidden,
    // until the user checks Projects on the computer and accepts a possible
    // duplicate. Dismiss only hides the row.
    if (controller.clones.unconfirmed case final unknown?) {
      final confirmed = await confirmDestructive(
        context,
        title: 'Add another project?',
        message:
            "Your computer didn't confirm whether it added “${unknown.name}”. "
            'Check Projects on your computer first. Adding it again could '
            'create a duplicate.',
        confirmLabel: 'Add project',
        confirmKey: const ValueKey('add-project-unknown-confirm'),
      );
      if (!confirmed ||
          !_canAdd(controller) ||
          !controller.clones.acknowledgeUnknown(unknown.jobId)) {
        return;
      }
    }
    if (!mounted || !_canAdd(controller)) return;
    await showAddProjectSheet(
      context,
      description:
          'Your computer clones the repository and adds it to Personal.',
      // The context or selected computer can change while the computer looks
      // up its clone folder.
      onSubmit: (url) =>
          controller.clones.add(url, stillAllowed: () => _canAdd(controller)),
    );
  }

  bool _canAdd(ComputerConnectController controller) =>
      mounted &&
      identical(widget.controller, controller) &&
      controller.active &&
      (context.read<WorkspaceContext?>()?.isPersonal ?? true);

  Widget _chat(DeviceChatRef chat) {
    return ChatOverviewRow(
      key: ValueKey('device-overview-chat-${chat.id}'),
      title: chat.title,
      unread: widget.controller.overviewChats.unread(chat),
      working: widget.controller.overviewChats.working(chat),
      onTap: () => widget.onOpenChat(chat),
    );
  }

  Widget _worktree(DeviceWorktree worktree) => DeviceWorktreeArchiveRow(
    key: ValueKey('device-worktree-${worktree.key}'),
    controller: widget.controller,
    worktree: worktree,
    onTap: () => widget.onOpenWorktree(worktree),
  );
}

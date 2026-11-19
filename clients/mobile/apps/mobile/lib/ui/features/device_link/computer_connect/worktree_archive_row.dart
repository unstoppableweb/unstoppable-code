import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:provider/provider.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/device_link/worktrees/repository.dart';
import 'package:mobile/device_link/worktrees/row_projection.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/core/workspaces/worktree_archive_menu.dart';
import 'package:mobile/ui/core/workspaces/worktree_row.dart';
import '../space_notifications/space_notification_menu.dart';
import '../space_notifications/space_notifications_sheet.dart';
import '../space_notifications/space_notifications_view_model.dart';
import 'controller.dart';

/// A Computer connect worktree row whose long press offers Archive, and the
/// worktree's notification choices once the computer has registered its
/// notification space.
class DeviceWorktreeArchiveRow extends StatefulWidget {
  const DeviceWorktreeArchiveRow({
    super.key,
    required this.controller,
    required this.worktree,
    required this.onTap,
    this.contextLabel,
  });
  final ComputerConnectController controller;
  final DeviceWorktree worktree;
  final VoidCallback onTap;
  final String? contextLabel;

  @override
  State<DeviceWorktreeArchiveRow> createState() =>
      _DeviceWorktreeArchiveRowState();
}

class _DeviceWorktreeArchiveRowState extends State<DeviceWorktreeArchiveRow> {
  bool _menuOpen = false;
  bool _confirming = false;

  Future<void> _archive() async {
    final controller = widget.controller;
    final worktree = widget.worktree;
    if (_confirming || controller.isArchivingWorktree(worktree)) return;
    _confirming = true;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final confirmed = await confirmWorktreeArchive(context, worktree.name);
      if (!mounted || !confirmed) return;
      await controller.archiveWorktree(worktree);
    } catch (error) {
      if (!messenger.mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            error is DeviceLinkException
                ? error.message
                : 'Could not archive the worktree. Check your connection and try again.',
          ),
        ),
      );
    } finally {
      _confirming = false;
    }
  }

  Future<void> _showMenu(Offset position) async {
    if (_menuOpen || _confirming) return;
    final controller = widget.controller;
    final overlay =
        Overlay.of(context).context.findRenderObject()! as RenderBox;
    final local = overlay.globalToLocal(position);
    final enabled = controller.canArchiveWorktree(widget.worktree);
    final pending = controller.isArchivingWorktree(widget.worktree);
    final notifications = context.read<SpaceNotificationsViewModel?>();
    final row = deviceWorktreeRow(widget.worktree);
    final spaceId = row.notificationSpaceId;
    _menuOpen = true;
    try {
      final selected = await showMenu<String>(
        context: context,
        position: RelativeRect.fromRect(
          Rect.fromLTWH(local.dx, local.dy, 0, 0),
          Offset.zero & overlay.size,
        ),
        items: [
          if (notifications != null && spaceId != null)
            spaceNotificationsMenuItem(
              context,
              key: ValueKey('device-space-notify-open-${widget.worktree.key}'),
            ),
          worktreeArchiveMenuItem(
            context,
            key: ValueKey('device-archive-worktree-${widget.worktree.key}'),
            enabled: enabled,
            pending: pending,
          ),
          if (!enabled && !pending)
            const PopupMenuItem<String>(
              enabled: false,
              child: Text('Archiving is unavailable for this connection.'),
            ),
        ],
      );
      if (!mounted) return;
      if (selected == spaceNotificationsMenuValue &&
          notifications != null &&
          spaceId != null) {
        // The row outlives the dismissed menu, so its context opens the sheet.
        await showSpaceNotificationsSheet(
          context,
          viewModel: notifications,
          spaceId: spaceId,
          title: switch (row.label?.trim()) {
            final label? when label.isNotEmpty => label,
            _ => row.branch,
          },
        );
      }
      if (selected == 'archive' &&
          controller.canArchiveWorktree(widget.worktree)) {
        await _archive();
      }
    } finally {
      _menuOpen = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final worktree = widget.worktree;
    final pending = controller.isArchivingWorktree(worktree);
    void openMenu() {
      final box = context.findRenderObject()! as RenderBox;
      _showMenu(box.localToGlobal(box.size.center(Offset.zero)));
    }

    return Semantics(
      customSemanticsActions: {
        const CustomSemanticsAction(label: 'Worktree actions'): openMenu,
      },
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onLongPressStart: (details) => _showMenu(details.globalPosition),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            WorktreeRow(
              worktree: deviceWorktreeRow(worktree),
              needsAnswer: worktree.pendingQuestion,
              codeGraphBuilding: controller.worktrees.codeGraphBuilding
                  .contains(worktree.key),
              onTap: pending ? null : widget.onTap,
              contextLabel: widget.contextLabel,
            ),
            if (pending)
              const Padding(
                padding: EdgeInsets.only(
                  left: AppDimens.navRowTitleInset,
                  bottom: 8,
                ),
                child: Text('Archiving…'),
              ),
          ],
        ),
      ),
    );
  }
}

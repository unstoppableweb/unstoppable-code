import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/device_link/worktrees/models.dart';
import 'controller.dart';
import 'account_model.dart';
import 'connection_view.dart';
import 'computer_switcher.dart';
import 'overview.dart';
import 'new_task_screen.dart';
import 'search_screen.dart';
import '../chats_screen.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:provider/provider.dart';

class ComputerConnectScreen extends StatefulWidget {
  const ComputerConnectScreen({
    super.key,
    required this.controller,
    required this.account,
  });
  final ComputerConnectController? controller;
  final ComputerAccountModel account;
  @override
  State<ComputerConnectScreen> createState() => _ComputerConnectScreenState();
}

class _ComputerConnectScreenState extends State<ComputerConnectScreen> {
  bool _opening = false;
  String? _openError;

  Future<void> _open(DeviceWorktree worktree) async {
    if (_opening || !widget.controller!.chats.online || !_includes(worktree)) {
      _explainPendingScope();
      return;
    }
    setState(() {
      _opening = true;
      _openError = null;
    });
    final controller = widget.controller!;
    controller.enterChat();
    var generation = controller.chats.chats.selectionGeneration;
    try {
      await controller.loadWorktree(worktree);
      if (!_includes(worktree)) {
        _explainPendingScope();
        return;
      }
      if (worktree.status == 'Unavailable') {
        throw const DeviceLinkException(
          'Could not load this worktree. Refresh and try again.',
        );
      }
      final ref =
          worktree.chats
              .where((c) => c.id == worktree.activeChatId)
              .firstOrNull ??
          worktree.chats.firstOrNull;
      if (ref != null) {
        // The repository establishes the target before its first await. Open
        // the shared chat shell now, so loading and failures are visible.
        final opening = controller.chats.open(ref);
        generation = controller.chats.chats.selectionGeneration;
        if (mounted) await _showChat(worktree);
        generation = controller.chats.chats.selectionGeneration;
        await opening;
        return;
      } else {
        await controller.chats.chats.createTab(
          worktree.projectId,
          worktree.id,
          onCreated: (_) =>
              generation = controller.chats.chats.selectionGeneration,
        );
        if (generation != controller.chats.chats.selectionGeneration) return;
      }
      if (mounted) await _showChat(worktree);
      generation = controller.chats.chats.selectionGeneration;
    } catch (cause) {
      if (mounted) {
        setState(
          () => _openError = cause is DeviceLinkException
              ? cause.message
              : 'Could not open this worktree. Refresh and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _opening = false);
      await controller.restoreOverview(generation);
    }
  }

  Future<void> _newTask(DeviceProject project) async {
    if (_opening ||
        !widget.controller!.chats.online ||
        !_includesProject(project)) {
      _explainPendingScope();
      return;
    }
    setState(() {
      _opening = true;
      _openError = null;
    });
    final controller = widget.controller!;
    controller.enterChat();
    var generation = controller.chats.chats.selectionGeneration;
    try {
      await controller.chats.leaveChat();
      generation = controller.chats.chats.selectionGeneration;
      if (mounted && controller.chats.online && _includesProject(project)) {
        await Navigator.of(context).push<void>(
          MaterialPageRoute(
            builder: (_) =>
                DeviceNewTaskScreen(controller: controller, project: project),
          ),
        );
        generation = controller.chats.chats.selectionGeneration;
      } else {
        _explainPendingScope();
      }
    } finally {
      if (mounted) setState(() => _opening = false);
      await controller.restoreOverview(generation);
    }
  }

  Future<void> _openChat(DeviceChatRef ref) async {
    if (_opening || !widget.controller!.chats.online || !_includesChat(ref)) {
      _explainPendingScope();
      return;
    }
    setState(() {
      _opening = true;
      _openError = null;
    });
    final controller = widget.controller!;
    controller.enterChat();
    var generation = controller.chats.chats.selectionGeneration;
    try {
      final opening = controller.chats.open(ref);
      generation = controller.chats.chats.selectionGeneration;
      if (mounted) await _showChat();
      generation = controller.chats.chats.selectionGeneration;
      await opening;
    } finally {
      if (mounted) setState(() => _opening = false);
      await controller.restoreOverview(generation);
    }
  }

  void _manageComputers(ComputerAccountModel account) => unawaited(
    Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => CanopyScaffold(
          appBar: const CanopyAppBar(
            content: Text('Computers'),
            automaticallyImplyLeading: true,
          ),
          body: ComputerConnectionView(account: account),
        ),
      ),
    ),
  );

  Future<void> _showChat([DeviceWorktree? worktree]) {
    final controller = widget.controller!;
    final ref = controller.chats.state?.ref;
    final included = worktree == null
        ? ref != null && _includesChat(ref)
        : _includes(worktree) &&
              ref?.projectId == worktree.projectId &&
              ref?.worktreeId == worktree.id;
    if (ref == null || !included) {
      _explainPendingScope();
      return Future.value();
    }
    return Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (_) => DeviceChatScreen(
          model: widget.controller!.chats,
          locationLabel: worktree?.name,
          worktree: controller.activityContext(ref),
        ),
      ),
    );
  }

  bool _includes(DeviceWorktree worktree) =>
      mounted &&
      widget.controller!
          .scopeFor(context.read<WorkspaceContext?>())
          .includesWorktree(worktree);

  bool _includesProject(DeviceProject project) =>
      mounted &&
      widget.controller!
          .scopeFor(context.read<WorkspaceContext?>())
          .projects
          .any((p) => p.id == project.id);

  bool _includesChat(DeviceChatRef ref) =>
      mounted &&
      widget.controller!
          .scopeFor(context.read<WorkspaceContext?>())
          .includesChat(ref);

  void _explainPendingScope() {
    if (mounted &&
        widget.controller?.active == true &&
        widget.controller?.scopePending == true) {
      setState(() => _openError = deviceScopeRefreshingMessage);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([?widget.controller, widget.account]),
    builder: (context, _) {
      final controller = widget.controller;
      final connection = controller?.chats.connection;
      final online = controller?.chats.online == true;
      final navigation = HomeNavigationScope.maybeOf(context);
      final account = widget.account;
      final retainingComputer =
          controller != null &&
          (online ||
              connection?.reconnecting == true ||
              account.hasSelectedComputer);
      final hostName = retainingComputer ? connection?.hostName : null;
      final title = hostName ?? account.selectedName ?? 'Computer connect';
      final status = online ? 'Connected' : '';
      return CanopyScaffold(
        appBar: CanopyAppBar(
          // Hosted in the home shell, the drawer is the way out, as on
          // Remote control. Standalone hosts keep their back button.
          leading: navigation == null
              ? null
              : CanopyIconButton(
                  key: const ValueKey('home-menu-button'),
                  glyph: CanopyGlyph.barsThree,
                  tooltip: 'Open navigation menu',
                  onPressed: navigation.openDrawer,
                ),
          automaticallyImplyLeading: navigation == null,
          content: retainingComputer || account.selectableComputers.isNotEmpty
              ? ComputerSwitcher(
                  account: account,
                  title: title,
                  label: status,
                  onManage: () => _manageComputers(account),
                )
              : const Text('Computer connect'),
          trailing: retainingComputer
              ? MenuAnchor(
                  builder: (context, menu, _) => CanopyIconButton(
                    key: const ValueKey('computer-connect-options'),
                    glyph: CanopyGlyph.dotGrid1x3Horizontal,
                    tooltip: 'Remote options',
                    onPressed: () => menu.isOpen ? menu.close() : menu.open(),
                  ),
                  menuChildren: [
                    MenuItemButton(
                      leadingIcon: CanopyIcon(
                        glyph: CanopyGlyph.magnifyingGlass,
                        tint: AppColors.of(context).foregroundSecondary,
                      ),
                      onPressed: () => Navigator.of(context).push<void>(
                        MaterialPageRoute(
                          builder: (_) =>
                              DeviceChatSearchScreen(controller: controller),
                        ),
                      ),
                      child: const Text('Search chats'),
                    ),
                    MenuItemButton(
                      leadingIcon: const SizedBox(width: 24, height: 24),
                      onPressed: () {
                        if (account.sessions.selectedId case final id?) {
                          unawaited(account.disconnect(id));
                        }
                      },
                      child: const Text('Disconnect'),
                    ),
                  ],
                )
              : null,
        ),
        // Each body applies the scaffold insets inside its scroll view, so
        // content scrolls under the translucent app bar.
        body: Builder(
          builder: (context) => retainingComputer
              ? DeviceProjectsOverview(
                  controller: controller,
                  opening: _opening,
                  openError: _openError,
                  onOpenWorktree: _open,
                  onCreateTask: (project) => unawaited(_newTask(project)),
                  onOpenChat: _openChat,
                )
              : ComputerConnectionView(account: account),
        ),
      );
    },
  );
}

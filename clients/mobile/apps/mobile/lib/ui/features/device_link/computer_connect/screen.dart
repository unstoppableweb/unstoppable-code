import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/ui/core/navigation/app_route_scope.dart';
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
import 'overview_model.dart';
import 'project_open_queue.dart';
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

enum _Opening { chat, newTask }

class _ComputerConnectScreenState extends State<ComputerConnectScreen> {
  _Opening? _opening;
  bool get _busy =>
      _opening != null || _openQueue.openingChat || _openQueue.readingWorktree;
  String? _openError;
  final _openQueue = ProjectOpenQueue();
  WorkspaceContext? _workspace;
  Completer<void>? _switcherDismissed;
  int _switcherGeneration = 0;

  @override
  void initState() {
    super.initState();
    widget.controller?.addListener(_checkQueuedOpen);
    widget.account.addListener(_checkQueuedOpen);
  }

  @override
  void didUpdateWidget(ComputerConnectScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller?.removeListener(_checkQueuedOpen);
      widget.controller?.addListener(_checkQueuedOpen);
      _openQueue.invalidate();
    }
    if (oldWidget.account != widget.account) {
      oldWidget.account.removeListener(_checkQueuedOpen);
      widget.account.addListener(_checkQueuedOpen);
      _openQueue.invalidate();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final workspace = context.watch<WorkspaceContext?>();
    if (!_projectDestinationCurrent || _workspace != workspace) {
      _openQueue.invalidate();
    }
    _workspace = workspace;
  }

  @override
  void dispose() {
    widget.controller?.removeListener(_checkQueuedOpen);
    widget.account.removeListener(_checkQueuedOpen);
    _switcherDismissed?.complete();
    super.dispose();
  }

  bool get _projectDestinationCurrent =>
      widget.controller?.active == true &&
      AppRouteScope.isCurrentOf(
        context,
        requireLocalRoute: _switcherDismissed == null,
      );

  bool get _canOpenFromHere =>
      _switcherDismissed == null && _projectDestinationCurrent;

  void _switcherVisibilityChanged(bool visible) {
    if (!mounted) return;
    if (visible) {
      _switcherGeneration++;
      _switcherDismissed = Completer<void>();
      return;
    }
    final dismissed = _switcherDismissed;
    _switcherDismissed = null;
    dismissed?.complete();
    _checkQueuedOpen();
  }

  Future<void> _waitForDestination() async {
    if (!mounted) return;
    // Home publishes destination visibility when the shell rebuilds.
    await WidgetsBinding.instance.endOfFrame;
    while (mounted && _switcherDismissed != null) {
      await _switcherDismissed!.future;
      if (mounted) await WidgetsBinding.instance.endOfFrame;
    }
  }

  bool _queueWhileRefreshing(
    ComputerConnectController controller,
    ProjectOpenKind kind,
    String key,
  ) {
    final ProjectOpenRequest request = (
      workspace: context.read<WorkspaceContext?>(),
      kind: kind,
      key: key,
      lostSession: _openQueue.pending?.lostSession,
    );
    if (!_openQueue.waiting(controller, request)) return false;
    setState(() {
      _openError = null;
      _openQueue.invalidate();
      _openQueue.pending = request;
    });
    return true;
  }

  void _checkQueuedOpen() {
    _openQueue.checkPending(
      controller: widget.controller,
      afterFrame: (run) {
        // Let the shell apply destination and workspace changes first.
        WidgetsBinding.instance.addPostFrameCallback((_) => run());
        WidgetsBinding.instance.ensureVisualUpdate();
      },
      isMounted: () => mounted,
      paused: () => _switcherDismissed != null,
      canOpen: (workspace) =>
          _projectDestinationCurrent &&
          context.read<WorkspaceContext?>() == workspace,
      onSettled: _replayQueuedOpen,
    );
  }

  void _replayQueuedOpen(ProjectOpenRequest? request) {
    setState(() {});
    if (request == null) return;
    switch (request.kind) {
      case ProjectOpenKind.worktree:
        unawaited(_openWorktree(request.key));
      case ProjectOpenKind.chat:
        if (_openQueue.resolveChat(widget.controller!, request)
            case final ref?) {
          unawaited(_openChat(ref));
        }
    }
  }

  Future<void> _openWorktree(String key) async {
    final controller = widget.controller!;
    if (_opening != null || _openQueue.openingChat || !_canOpenFromHere) return;
    if (_queueWhileRefreshing(controller, ProjectOpenKind.worktree, key)) {
      return;
    }
    if (!controller.chats.online) return;
    final worktree = controller
        .scopeFor(context.read<WorkspaceContext?>())
        .worktrees
        .where((worktree) => worktree.key == key)
        .firstOrNull;
    if (worktree == null) return;
    final workspace = context.read<WorkspaceContext?>();
    final session = controller.chats.connection.connectedSession;
    final navigation = _openQueue.beginWorktreeRead();
    setState(() => _openError = null);
    final selection = controller.chats.chats.selectionGeneration;
    final switcherGeneration = _switcherGeneration;
    try {
      final result = await controller.loadWorktree(worktree);
      await _waitForDestination();
      if (!mounted ||
          !_canOpenFromHere ||
          context.read<WorkspaceContext?>() != workspace) {
        return;
      }
      final read = _openQueue.completeWorktreeRead(
        controller,
        token: navigation,
        read: result,
        workspace: workspace,
        key: key,
        session: session,
        switcherInterrupted: switcherGeneration != _switcherGeneration,
        worktree: worktree,
      );
      setState(() {});
      if (read == null) {
        _checkQueuedOpen();
        return;
      }
      if (!_includes(worktree)) return;
      if (read == WorktreeRead.unavailable) {
        throw const DeviceLinkException(
          'Could not load this worktree. Refresh and try again.',
        );
      }
      if (selection != controller.chats.chats.selectionGeneration) return;
      await _openQueue.openWorktreeChat(
        controller,
        worktree,
        token: navigation,
        waitForDestination: _waitForDestination,
        showChat: () => mounted ? _showChat(worktree) : Future.value(),
        onChanged: () {
          if (mounted) setState(() {});
        },
      );
    } catch (cause) {
      if (mounted && _openQueue.generation == navigation) {
        setState(
          () => _openError = cause is DeviceLinkException
              ? cause.message
              : 'Could not open this worktree. Refresh and try again.',
        );
      }
    } finally {
      if (_openQueue.finishWorktreeRead(navigation) && mounted) setState(() {});
    }
  }

  Future<void> _newTask(DeviceProject project) async {
    if (_busy ||
        !widget.controller!.chats.online ||
        !_includesProject(project)) {
      _explainPendingScope();
      return;
    }
    setState(() {
      _opening = _Opening.newTask;
      _openError = null;
      _openQueue.invalidate();
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
      if (mounted) setState(() => _opening = null);
      await controller.restoreOverview(generation);
    }
  }

  Future<void> _openChat(DeviceChatRef ref) async {
    final controller = widget.controller!;
    if (_opening != null || _openQueue.openingChat || !_canOpenFromHere) return;
    if (_queueWhileRefreshing(controller, ProjectOpenKind.chat, ref.key)) {
      return;
    }
    if (!controller.chats.online || !_includesChat(ref)) return;
    setState(() {
      _opening = _Opening.chat;
      _openError = null;
      _openQueue.invalidate();
    });
    controller.enterChat();
    var generation = controller.chats.chats.selectionGeneration;
    try {
      final opening = controller.chats.open(ref);
      generation = controller.chats.chats.selectionGeneration;
      if (mounted) await _showChat();
      generation = controller.chats.chats.selectionGeneration;
      await opening;
    } finally {
      if (mounted) setState(() => _opening = null);
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
    if (!_canOpenFromHere) return Future.value();
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
      // A tap waiting on the roster gets feedback without shifting the rows.
      final status =
          _openQueue.pending != null ||
              _openQueue.readingWorktree ||
              _openQueue.openingChat ||
              _opening == _Opening.chat
          ? 'Opening chat…'
          : online
          ? 'Connected'
          : '';
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
                  onMenuVisibilityChanged: _switcherVisibilityChanged,
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
                  opening: _busy,
                  openError: _openError,
                  onOpenWorktree: (worktree) =>
                      unawaited(_openWorktree(worktree.key)),
                  onCreateTask: (project) => unawaited(_newTask(project)),
                  onOpenChat: _openChat,
                )
              : ComputerConnectionView(account: account),
        ),
      );
    },
  );
}

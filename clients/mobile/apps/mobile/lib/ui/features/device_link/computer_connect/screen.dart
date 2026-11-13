import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/ui/core/widgets/computer_connection_title.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/text-field/canopy_text_field.dart';
import 'package:mobile/device_link/worktrees/repository.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import '../desktop_link_model.dart';
import 'controller.dart';
import 'account.dart';
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
    required this.apiOrigin,
    this.account,
  });
  final ComputerConnectController controller;
  final String apiOrigin;
  final ComputerConnectAccount? account;
  @override
  State<ComputerConnectScreen> createState() => _ComputerConnectScreenState();
}

class _ComputerConnectScreenState extends State<ComputerConnectScreen> {
  late final _origin = TextEditingController(text: widget.apiOrigin);
  final _apiKey = TextEditingController();
  bool _enterKey = false;
  bool _readingClipboard = false;
  bool _opening = false;
  String? _openError;
  @override
  void dispose() {
    _origin.dispose();
    _apiKey.dispose();
    super.dispose();
  }

  Future<void> _find(String key) async {
    FocusManager.instance.primaryFocus?.unfocus();
    _apiKey.clear();
    setState(() => _enterKey = false);
    await widget.controller.findComputers(_origin.text, key);
  }

  Future<void> _pasteAndFind() async {
    setState(() => _readingClipboard = true);
    String key;
    try {
      key = (await Clipboard.getData(Clipboard.kTextPlain))?.text ?? '';
    } on PlatformException {
      key = '';
    }
    if (!mounted) return;
    setState(() => _readingClipboard = false);
    if (key.trim().isEmpty) {
      setState(() => _enterKey = true);
      return;
    }
    await _find(key);
  }

  Future<void> _open(DeviceWorktree worktree) async {
    if (_opening || !widget.controller.chats.online || !_includes(worktree)) {
      _explainPendingScope();
      return;
    }
    setState(() {
      _opening = true;
      _openError = null;
    });
    final controller = widget.controller;
    controller.enterChat();
    var generation = controller.chats.chats.selectionGeneration;
    try {
      await controller.worktrees.load(worktree);
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
        !widget.controller.chats.online ||
        !_includesProject(project)) {
      _explainPendingScope();
      return;
    }
    setState(() {
      _opening = true;
      _openError = null;
    });
    final controller = widget.controller;
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
    if (_opening || !widget.controller.chats.online || !_includesChat(ref)) {
      _explainPendingScope();
      return;
    }
    setState(() {
      _opening = true;
      _openError = null;
    });
    final controller = widget.controller;
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

  void _manageComputers(ComputerConnectAccount account) => unawaited(
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
    final controller = widget.controller;
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
          model: widget.controller.chats,
          locationLabel: worktree?.name,
          worktree: controller.activityContext(ref),
        ),
      ),
    );
  }

  bool _includes(DeviceWorktree worktree) =>
      mounted &&
      widget.controller
          .scopeFor(context.read<WorkspaceContext?>())
          .includesWorktree(worktree);

  bool _includesProject(DeviceProject project) =>
      mounted &&
      widget.controller
          .scopeFor(context.read<WorkspaceContext?>())
          .projects
          .any((p) => p.id == project.id);

  bool _includesChat(DeviceChatRef ref) =>
      mounted &&
      widget.controller
          .scopeFor(context.read<WorkspaceContext?>())
          .includesChat(ref);

  void _explainPendingScope() {
    if (mounted && widget.controller.active && widget.controller.scopePending) {
      setState(() => _openError = deviceScopeRefreshingMessage);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.controller, ?widget.account]),
    builder: (context, _) {
      final controller = widget.controller;
      final connection = controller.chats.connection;
      final online = controller.chats.online;
      final navigation = HomeNavigationScope.maybeOf(context);
      final account = widget.account;
      final retainingComputer =
          online ||
          connection.reconnecting ||
          account?.hasSelectedComputer == true;
      final hostName = retainingComputer
          ? (connection.host?['name'] as String?)
          : null;
      final title = hostName ?? account?.selectedName ?? 'Computer connect';
      final status = online
          ? 'Connected'
          : account != null
          ? ''
          : connection.reconnecting
          ? 'Reconnecting…'
          : 'Not connected';
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
          content:
              account != null &&
                  (retainingComputer || account.selectableComputers.isNotEmpty)
              ? ComputerSwitcher(
                  account: account,
                  title: title,
                  label: status,
                  onManage: () => _manageComputers(account),
                )
              : retainingComputer
              ? ComputerConnectionTitle(
                  title: title,
                  label: status,
                  titleKey: const ValueKey('computer-connect-device-name'),
                  labelKey: const ValueKey('computer-connect-device-status'),
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
                      onPressed: widget.account != null
                          ? () => widget.account!.disconnect(
                              widget.account!.engine.selectedId!,
                            )
                          : controller.disconnect,
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
              : widget.account != null
              ? ComputerConnectionView(account: widget.account!)
              : ListView(
                  padding:
                      CanopyScaffold.contentPaddingOf(context) +
                      const EdgeInsets.all(24),
                  children: [
                    Text(
                      'Connect to your computer',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      'Turn on Remote access on your computer. Use a temporary manual API key from the same account to find it.',
                    ),
                    const SizedBox(height: 20),
                    CanopyTextField(
                      key: const ValueKey('computer-connect-origin'),
                      controller: _origin,
                      labelText: 'Server URL',
                      onChanged: (_) => unawaited(controller.disconnect()),
                      enabled: !controller.discovering && !connection.busy,
                    ),
                    const SizedBox(height: 12),
                    if (!connection.busy)
                      CanopyButton(
                        label: 'Paste API key and find computers',
                        loading: controller.discovering || _readingClipboard,
                        onPressed: controller.discovering || _readingClipboard
                            ? null
                            : _pasteAndFind,
                      ),
                    if (_enterKey && !connection.busy) ...[
                      const SizedBox(height: 16),
                      const Text('Enter the temporary API key below.'),
                      const SizedBox(height: 12),
                      CanopyTextField(
                        key: const ValueKey('computer-connect-api-key'),
                        controller: _apiKey,
                        labelText: 'API key',
                        obscureText: true,
                        enabled: !controller.discovering,
                        textInputAction: TextInputAction.done,
                      ),
                      const SizedBox(height: 12),
                      ValueListenableBuilder(
                        valueListenable: _apiKey,
                        builder: (context, value, _) => CanopyButton(
                          label: 'Find computers',
                          onPressed:
                              controller.discovering ||
                                  value.text.trim().isEmpty
                              ? null
                              : () => _find(value.text),
                        ),
                      ),
                    ],
                    if (controller.error ?? connection.error case final error?)
                      _notice(error),
                    if (connection.busy) ...[
                      const SizedBox(height: 20),
                      Semantics(
                        liveRegion: true,
                        child: Text(
                          connection.phase == DesktopLinkPhase.pairing
                              ? 'Compare the code on your computer'
                              : 'Connecting…',
                        ),
                      ),
                      if (connection.code case final code?)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 16),
                          child: Text(
                            code,
                            key: const ValueKey('computer-connect-code'),
                            style: Theme.of(context).textTheme.headlineLarge,
                          ),
                        ),
                      if (connection.code != null)
                        const Text(
                          'Allow only when both codes match. Your computer will grant this device control.',
                        ),
                      CanopyButton(
                        label: 'Cancel',
                        variant: CanopyButtonVariant.inline,
                        onPressed: controller.disconnect,
                      ),
                    ],
                    for (final computer in controller.computers)
                      ListTile(
                        key: ValueKey('computer-connect-peer-${computer.id}'),
                        title: Text(computer.name),
                        subtitle: const Text('Remote access is on'),
                        onTap: () => controller.connect(computer),
                      ),
                    if (!controller.discovering &&
                        controller.computers.isEmpty &&
                        controller.error == null &&
                        !connection.busy)
                      const Padding(
                        padding: EdgeInsets.symmetric(vertical: 16),
                        child: Text(
                          'Only online computers with Remote access enabled appear here.',
                        ),
                      ),
                    if (connection.canReconnect && !connection.busy)
                      CanopyButton(
                        label: 'Reconnect',
                        variant: CanopyButtonVariant.inline,
                        onPressed: connection.reconnect,
                      ),
                    if (!connection.busy)
                      CanopyButton(
                        label: 'Forget pairing',
                        variant: CanopyButtonVariant.inline,
                        onPressed: () async {
                          await controller.disconnect();
                          await connection.forget();
                        },
                      ),
                    const SizedBox(height: 16),
                    const Text(
                      'The API key stays in memory until you disconnect or close this version. Pairing keys are stored separately from Remote Control. Revoke the temporary API key on your computer when finished.',
                    ),
                  ],
                ),
        ),
      );
    },
  );
  Widget _notice(String message) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: InlineNotice(glyph: CanopyGlyph.circleInfo, state: message),
  );
}

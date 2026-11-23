import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/ui/core/chat/widgets/pending_question_indicator.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import 'package:mobile/ui/core/status_colors.dart';
import '../../chats_screen.dart';
import '../account_model.dart';
import '../computer_switcher.dart';
import '../connection_view.dart';
import '../details_picker.dart';
import 'model.dart';

class ComputerOrchestratorScreen extends StatefulWidget {
  const ComputerOrchestratorScreen({
    super.key,
    required this.account,
    this.isActive = true,
  });
  final ComputerAccountModel account;
  final bool isActive;
  @override
  State<ComputerOrchestratorScreen> createState() =>
      _ComputerOrchestratorScreenState();
}

class _ComputerOrchestratorScreenState extends State<ComputerOrchestratorScreen>
    with WidgetsBindingObserver {
  ComputerOrchestrator? _controller;
  bool _opening = false, _routeVisible = true;
  // The observer reports only later changes: a screen opened while the app
  // is not resumed starts hidden from the desktop.
  bool _foreground = switch (WidgetsBinding.instance.lifecycleState) {
    null || AppLifecycleState.resumed => true,
    _ => false,
  };
  ComputerOrchestrator? _chatController;
  bool _visibilityQueued = false;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.account.addListener(_sync);
    _sync();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _routeVisible = ModalRoute.isCurrentOf(context) ?? true;
    _queueVisibility();
  }

  @override
  void didUpdateWidget(ComputerOrchestratorScreen old) {
    super.didUpdateWidget(old);
    if (old.account != widget.account) {
      old.account.removeListener(_sync);
      widget.account.addListener(_sync);
    }
    _sync();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _syncVisibility();
  }

  void _sync() {
    final next = widget.account.sessions.orchestrator;
    if (!identical(next, _controller)) {
      _controller?.setVisible(false);
      _controller = next;
    }
    _queueVisibility();
  }

  void _queueVisibility() {
    if (_visibilityQueued) return;
    _visibilityQueued = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _visibilityQueued = false;
      if (mounted) _syncVisibility();
    });
  }

  void _syncVisibility() {
    final active = widget.isActive && _foreground;
    _controller?.setVisible(
      active && (_routeVisible || identical(_chatController, _controller)),
    );
    if (_chatController != null && !identical(_chatController, _controller)) {
      _chatController!.setVisible(active);
    }
  }

  void _manage() => unawaited(showComputerConnections(context, widget.account));

  Future<void> _open(OrchestratorEntry? entry) async {
    final controller = _controller;
    if (controller == null || _opening) return;
    setState(() => _opening = true);
    var opened = false;
    try {
      opened = await controller.open(entry);
      if (opened && mounted && identical(controller, _controller)) {
        _chatController = controller;
        _syncVisibility();
        await Navigator.of(context).push<void>(
          MaterialPageRoute(
            builder: (_) => DeviceChatScreen(
              model: controller.chats,
              locationLabel: 'Orchestrator',
            ),
          ),
        );
      }
    } finally {
      _chatController = null;
      _syncVisibility();
      await controller.leaveChat(refreshCatalog: opened);
      if (mounted) setState(() => _opening = false);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.account.removeListener(_sync);
    _controller?.setVisible(false);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.account,
    builder: (context, _) {
      final controller = _controller;
      return ListenableBuilder(
        listenable: controller ?? widget.account,
        builder: (context, _) {
          final account = widget.account;
          final model = controller?.chats;
          final online = model?.online == true;
          final computerName =
              model?.connection.hostName ?? account.selectedName;
          final entries = controller?.entries ?? const <OrchestratorEntry>[];
          final error = model?.error ?? model?.chats.error;
          final navigation = HomeNavigationScope.maybeOf(context);
          return CanopyScaffold(
            appBar: CanopyAppBar(
              automaticallyImplyLeading: navigation == null,
              leading: HomeMenuButton.maybeOf(context, designSystem: true),
              content: ComputerSwitcher(
                account: account,
                title: 'Orchestrator',
                label: computerName ?? 'Choose a computer',
                onManage: _manage,
              ),
              trailing: online
                  ? CanopyIconButton(
                      key: const ValueKey('app-advisor-new-chat'),
                      glyph: CanopyGlyph.bubblePlus,
                      tooltip: 'New chat',
                      onPressed: _opening || model!.catalogLoading
                          ? null
                          : () => unawaited(_open(null)),
                    )
                  : null,
            ),
            body: !account.hasSelectedComputer || controller == null
                ? ComputerConnectionView(account: account)
                : Builder(
                    builder: (context) => RefreshIndicator(
                      onRefresh: controller.refresh,
                      child: ListView(
                        key: const ValueKey('app-advisor-list'),
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: CanopyScaffold.contentPaddingOf(context),
                        children: [
                          if (error != null)
                            Padding(
                              padding: const EdgeInsets.all(16),
                              child: InlineNotice(
                                glyph: CanopyGlyph.circleInfo,
                                state: error,
                                actions: [
                                  if (online && !model!.catalogLoading)
                                    (
                                      label: 'Try again',
                                      glyph: CanopyGlyph.arrowRotateClockwise,
                                      onPressed: () =>
                                          unawaited(controller.refresh()),
                                    ),
                                ],
                              ),
                            ),
                          if (entries.isEmpty &&
                              (!online || model!.catalogLoading))
                            const Padding(
                              padding: EdgeInsets.all(24),
                              child: Center(child: LoadingSpinner(size: 22)),
                            )
                          else if (entries.isEmpty && error == null)
                            const Padding(
                              padding: EdgeInsets.all(24),
                              child: Center(child: Text('No chats yet')),
                            ),
                          for (final entry in entries)
                            ListTile(
                              key: ValueKey('app-advisor-entry-${entry.id}'),
                              title: Text(
                                entry.title,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              trailing: Row(
                                mainAxisSize: MainAxisSize.min,
                                spacing: 8,
                                children: [
                                  if (entry.chats.any(
                                    (chat) => controller
                                        .pendingFor(chat.id)
                                        .isNotEmpty,
                                  ))
                                    const PendingQuestionIndicator(size: 16),
                                  if (entry.running)
                                    const ThinkingSpinner(size: 12),
                                  if (entry.unread && !entry.running)
                                    Semantics(
                                      label: 'Unread',
                                      child: Container(
                                        width: 8,
                                        height: 8,
                                        decoration: BoxDecoration(
                                          color: StatusColors.of(
                                            context,
                                          ).unread,
                                          shape: BoxShape.circle,
                                        ),
                                      ),
                                    ),
                                ],
                              ),
                              onTap:
                                  online && !_opening && !model!.catalogLoading
                                  ? () => unawaited(_open(entry))
                                  : null,
                            ),
                        ],
                      ),
                    ),
                  ),
          );
        },
      );
    },
  );
}

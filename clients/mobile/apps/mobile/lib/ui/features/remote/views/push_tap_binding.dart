import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_context_scope.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/services/push_messaging.dart';
import 'package:mobile/services/push_deep_link.dart';
import 'package:mobile/services/push_message_coordinator.dart';
import 'package:mobile/ui/core/external_links.dart';
import 'package:mobile/ui/core/workspace_context_copy.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_route.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';

/// Turns the coordinator's pending notification tap into navigation. Mounted
/// inside the authenticated shell (below RemoteControlViewModel and
/// HomeTabController providers) so taps are only consumed when the app can
/// actually navigate; a tap arriving earlier waits in [PushMessageCoordinator.pendingTap].
///
/// A chat owned by another workspace context switches to that context first
/// (CAN-4429). The owner comes from the raw snapshot, never from the visible
/// scoped lists, and routes from the previous context are closed. A refused
/// switch opens nothing and offers Retry from the fallback tab, and so does a
/// chat whose owner is unknown or a switch whose owner stopped being active
/// while it saved. A switch superseded by a newer choice opens nothing, and
/// so does a tap whose pairing ended or changed while it was handled.
class PushTapBinding extends StatefulWidget {
  const PushTapBinding({
    super.key,
    required this.coordinator,
    required this.child,
    this.selectWorkspaceContext,
    this.workspaceContext,
    this.personalActivityAvailable,
    this.hydrationTimeout = const Duration(seconds: 10),
    this.openUrl = openExternalUrl,
  });

  final PushMessageCoordinator coordinator;
  final Widget child;

  /// Selects the context that owns a tapped chat; null leaves the context.
  final Future<WorkspaceContextSelection> Function(WorkspaceContext context)?
  selectWorkspaceContext;

  /// Reads the live context, so a chat opens only while its owner is active.
  final WorkspaceContext Function()? workspaceContext;

  /// Reads whether Personal Activity shows the account's own feed; null
  /// treats Personal as having none.
  final bool Function()? personalActivityAvailable;
  final Duration hydrationTimeout;

  /// Opens a cloud run's web link outside the app.
  final Future<void> Function(String url) openUrl;

  @override
  State<PushTapBinding> createState() => _PushTapBindingState();
}

class _PushTapBindingState extends State<PushTapBinding> {
  bool _handling = false;

  @override
  void initState() {
    super.initState();
    widget.coordinator.pendingTap.addListener(_onPendingTapChanged);
    // A tap may already be pending from before this shell mounted
    // (cold-start launch, pre-auth tap): consume it after first frame.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _onPendingTapChanged();
    });
  }

  @override
  void dispose() {
    widget.coordinator.pendingTap.removeListener(_onPendingTapChanged);
    super.dispose();
  }

  void _onPendingTapChanged() => unawaited(_handlePendingTap());

  Future<void> _handlePendingTap() async {
    final message = widget.coordinator.pendingTap.value;
    if (message == null || _handling) return;
    _handling = true;
    var handled = false;
    VoidCallback? releaseVisibility;
    try {
      // A cloud run has no desktop to route through: open it on the web.
      final runUrl = cloudRunPushUrl(message.data, AppConfig.apiBaseUrl);
      if (runUrl != null) {
        await widget.openUrl(runUrl);
        handled = true;
        return;
      }
      final viewModel = context.read<RemoteControlViewModel>();
      await viewModel.restoreIfIdle();
      if (!mounted) return;
      releaseVisibility = viewModel.beginRemoteRouteVisibility();
      await _waitForRestoreToSettle(viewModel);
      if (!mounted) return;
      // The tap belongs to the desktop paired now. After a disconnect or a
      // re-pair, its chat would open through another desktop.
      final generation = viewModel.sessionGeneration;
      bool sessionChanged() => viewModel.sessionGeneration != generation;
      final target = await _resolveTarget(
        viewModel,
        message.data,
        sessionChanged,
      );
      if (!mounted) return;
      if (sessionChanged()) {
        handled = true;
        return;
      }
      final selection = await _enterOwnerContext(viewModel, target);
      if (!mounted) return;
      if (sessionChanged()) {
        handled = true;
        return;
      }
      switch (selection) {
        case WorkspaceContextSelection.refused:
          _showFeed();
          _offerRetry(message);
          handled = true;
          return;
        case WorkspaceContextSelection.superseded:
          // A newer choice replaced the owner's context; keep it.
          handled = true;
          return;
        case WorkspaceContextSelection.saved ||
            WorkspaceContextSelection.unsaved:
          break;
      }
      switch (target) {
        case PushWorktreeChatTarget(:final worktree, :final chatId):
          _openRemoteChat(
            RemoteChatScreen.worktree(
              worktree: worktree,
              initialChatId: chatId,
            ),
            releaseVisibility,
          );
          releaseVisibility = null;
        case PushStandaloneChatTarget(:final chat):
          _openRemoteChat(
            RemoteChatScreen.standalone(standaloneChat: chat),
            releaseVisibility,
          );
          releaseVisibility = null;
        case PushFeedFallback():
          _showFeed();
      }
      handled = true;
    } catch (_) {
      // Best-effort: a malformed payload or torn-down provider must never
      // crash the shell. Land on the feed instead.
      if (mounted) {
        try {
          _showFeed();
          handled = true;
        } catch (_) {
          // No navigator/controller in scope — nothing to do.
        }
      }
    } finally {
      releaseVisibility?.call();
      _handling = false;
      final pendingTap = widget.coordinator.pendingTap.value;
      if (handled && pendingTap == message) {
        widget.coordinator.clearPendingTap();
      } else if (mounted && pendingTap != null && pendingTap != message) {
        // A newer tap arrived while this one was being handled; the guard
        // swallowed its notification, so re-enter for it.
        _onPendingTapChanged();
      }
    }
  }

  Future<PushDeepLinkTarget> _resolveTarget(
    RemoteControlViewModel viewModel,
    Map<String, String> data,
    bool Function() sessionChanged,
  ) async {
    if (viewModel.status != RemoteConnectionStatus.connected) {
      return const PushFeedFallback();
    }
    PushDeepLinkTarget resolve() => resolvePushDeepLink(
      data: data,
      workspaces: viewModel.workspaces,
      worktreesFor: viewModel.worktreesFor,
      worktreeForChatId: viewModel.worktreeForChatId,
      standaloneChatById: viewModel.standaloneChatById,
    );

    final initial = resolve();
    final chatId = data['clientChatId'];
    if (initial is! PushFeedFallback || chatId == null || chatId.isEmpty) {
      return initial;
    }

    // The missing chat may be in an overview reconciliation that was deferred
    // while Remote was hidden. A push tap has a shorter navigation deadline
    // than the normal delta throttle, so read once before waiting on indexes.
    await viewModel.refresh();
    final afterRefresh = resolve();
    if (afterRefresh is! PushFeedFallback || sessionChanged()) {
      return afterRefresh;
    }

    var requestedHydration = false;
    if (viewModel.canSearchChats) {
      // Resolve the owner with one lightweight index request; once known,
      // RemoteChatScreen uses the same foreground path as direct navigation.
      requestedHydration = true;
      viewModel.ensureChatSummariesIndex();
    } else {
      for (final workspace in viewModel.workspaces) {
        for (final worktree in viewModel.worktreesFor(workspace.localId)) {
          requestedHydration = true;
          viewModel.ensureWorktreeState(
            workspaceLocalId: workspace.localId,
            worktreeLocalId: worktree.localId,
          );
        }
      }
    }
    if (!requestedHydration) return initial;

    final completer = Completer<PushDeepLinkTarget>();
    late final Timer timeout;
    void retry() {
      if (completer.isCompleted) return;
      if (sessionChanged()) {
        completer.complete(initial);
        return;
      }
      final candidate = resolve();
      if (candidate is! PushFeedFallback) {
        completer.complete(candidate);
      }
    }

    viewModel.addListener(retry);
    timeout = Timer(widget.hydrationTimeout, () {
      if (!completer.isCompleted) completer.complete(initial);
    });
    retry();
    try {
      return await completer.future;
    } finally {
      timeout.cancel();
      viewModel.removeListener(retry);
    }
  }

  Future<void> _waitForRestoreToSettle(RemoteControlViewModel viewModel) async {
    if (!viewModel.isRestoring) return;

    final completer = Completer<void>();
    late final Timer timeout;
    void completeWhenSettled() {
      if (!viewModel.isRestoring && !completer.isCompleted) {
        completer.complete();
      }
    }

    viewModel.addListener(completeWhenSettled);
    timeout = Timer(widget.hydrationTimeout, () {
      if (!completer.isCompleted) completer.complete();
    });
    completeWhenSettled();
    try {
      await completer.future;
    } finally {
      timeout.cancel();
      viewModel.removeListener(completeWhenSettled);
    }
  }

  /// Completes with [WorkspaceContextSelection.saved] when no switch is
  /// needed. The chat opens only when the owner's context is active; a chat
  /// whose owner is unknown is refused, so it stays closed until a retry
  /// resolves it.
  Future<WorkspaceContextSelection> _enterOwnerContext(
    RemoteControlViewModel viewModel,
    PushDeepLinkTarget target,
  ) async {
    final select = widget.selectWorkspaceContext;
    // The provided value updates on the next frame; the live one is current.
    final current =
        widget.workspaceContext?.call() ?? context.read<WorkspaceContext?>();
    final owner = switch (target) {
      PushWorktreeChatTarget(:final worktree) => remoteOwnerContext(
        viewModel.workspaces,
        worktree.workspaceLocalId,
      ),
      PushStandaloneChatTarget(:final chat) => remoteOwnerContext(
        viewModel.workspaces,
        chat.projectLocalId,
      ),
      // The feed belongs to every context.
      PushFeedFallback() => current,
    };
    if (select == null || current == null || owner == current) {
      return WorkspaceContextSelection.saved;
    }
    if (owner == null) return WorkspaceContextSelection.refused;
    // Routes above the shell show the previous context.
    Navigator.of(context).popUntil((route) => route.isFirst);
    final selection = await select(owner);
    // Memberships can reload while the switch saves and leave the owner.
    final live = widget.workspaceContext?.call();
    if (live != null &&
        live != owner &&
        (selection == WorkspaceContextSelection.saved ||
            selection == WorkspaceContextSelection.unsaved)) {
      return WorkspaceContextSelection.refused;
    }
    return selection;
  }

  void _offerRetry(PushMessage message) {
    final coordinator = widget.coordinator;
    ScaffoldMessenger.maybeOf(context)
      ?..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: const Text(switchContextFailedMessage),
          action: SnackBarAction(
            label: 'Retry',
            onPressed: () => coordinator.requestOpen(message),
          ),
        ),
      );
  }

  void _showFeed() {
    // A route stacked above the shell (an open chat, settings) would hide a
    // bare tab switch; return to the shell first so the feed is visible.
    Navigator.of(context).popUntil((route) => route.isFirst);
    // Selecting by identity, not index — the visible tab set varies, so index
    // 0 no longer names the feed. A user with no organization has no Activity
    // tab at all; send them to Remote rather than no-opping, which would make
    // the notification look broken.
    //
    // Remote is named explicitly rather than taken as the shell's first tab or
    // its `HomeTabController.initialTab`: this is a Remote Control
    // notification that could not resolve to a chat, so it should lead to
    // Remote independently of menu order and the configured landing destination.
    //
    // In Personal, Activity shows the Personal organization's feed
    // (CAN-3715). Without one it asks the user to choose an organization
    // instead (CAN-4429), so that Personal leads to Remote.
    final controller = context.read<HomeTabController>();
    final personal = widget.workspaceContext?.call().isPersonal ?? false;
    final activityGated =
        personal && !(widget.personalActivityAvailable?.call() ?? false);
    controller.select(
      controller.tabs.contains(HomeTab.activity) && !activityGated
          ? HomeTab.activity
          : controller.tabs.contains(HomeTab.remote)
          ? HomeTab.remote
          : controller.tabs.first,
    );
  }

  void _openRemoteChat(Widget screen, VoidCallback releaseVisibility) {
    try {
      unawaited(
        Navigator.of(context)
            .push(
              // The provided value updates on the next frame; the chat
              // belongs to the live context it opens in.
              remoteChatRoute(
                context,
                screen,
                workspaceContext: widget.workspaceContext?.call(),
              ),
            )
            .whenComplete(releaseVisibility),
      );
    } catch (_) {
      releaseVisibility();
      rethrow;
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

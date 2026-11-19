import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/services/push_messaging.dart';
import 'package:mobile/services/push_deep_link.dart';
import 'package:mobile/services/push_message_coordinator.dart';
import 'package:mobile/ui/core/external_links.dart';
import 'package:mobile/ui/core/navigation/home_chat_open_request.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';

/// Turns the coordinator's pending notification tap into navigation. Mounted
/// inside the authenticated shell (below the [HomeTabController] provider and
/// Computer connect's scope) so taps are only consumed when the app can
/// actually navigate; a tap arriving earlier waits in
/// [PushMessageCoordinator.pendingTap].
///
/// A cloud run's tap opens the run on the web. Any other tap shows the Chat
/// home, Computer connect's landing page, at once. When the payload names a
/// chat on a computer ([computerChatPushTarget]) and a [PushChatRouter] is in
/// scope, the binding then asks the router for that chat and hands it to the
/// shell through [HomeChatOpenRequests]. Without a match the Chat home stays.
class PushTapBinding extends StatefulWidget {
  const PushTapBinding({
    super.key,
    required this.coordinator,
    required this.child,
    this.openUrl = openExternalUrl,
  });

  final PushMessageCoordinator coordinator;
  final Widget child;

  /// Opens a cloud run's web link outside the app.
  final Future<void> Function(String url) openUrl;

  @override
  State<PushTapBinding> createState() => _PushTapBindingState();
}

class _PushTapBindingState extends State<PushTapBinding> {
  final _requests = HomeChatOpenRequests();

  /// The tap being handled. A newer tap starts at once and wins: an older
  /// tap's result is discarded and does not clear the newer one.
  PushMessage? _current;
  int _generation = 0;

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
    _requests.dispose();
    super.dispose();
  }

  void _onPendingTapChanged() => unawaited(_handlePendingTap());

  Future<void> _handlePendingTap() async {
    final message = widget.coordinator.pendingTap.value;
    if (message == null || message == _current) return;
    _current = message;
    final generation = ++_generation;
    bool isCurrent() => mounted && generation == _generation;
    var handled = false;
    try {
      final runUrl = cloudRunPushUrl(message.data, AppConfig.apiBaseUrl);
      if (runUrl != null) {
        await widget.openUrl(runUrl);
        handled = true;
      } else if (mounted) {
        // Home first, so the user never looks at a blank wait.
        final home = _showHome();
        await _openComputerChat(
          message,
          () => isCurrent() && _isOn(home),
          since: _requests.navigation,
        );
        // Unmounted mid-resolve (an account change remounts the binding):
        // leave the tap for the replacement, which re-reads it. After a
        // sign-out that is another account's shell; the router only acts on
        // computers that account saved, so keep it that way.
        handled = mounted;
      } else {
        handled = true;
      }
    } catch (_) {
      // Best-effort: a failed link or torn-down provider must never crash
      // the shell. Land on the home destination instead.
      if (isCurrent()) {
        try {
          _showHome();
          handled = true;
        } catch (_) {
          // No navigator/controller in scope — nothing to do.
        }
      }
    } finally {
      if (generation == _generation) {
        _current = null;
        if (handled && widget.coordinator.pendingTap.value == message) {
          widget.coordinator.clearPendingTap();
        }
      }
    }
  }

  /// Asks the router for the tap's chat and requests it from the shell when
  /// this tap is still the current one. The router never throws; a null
  /// result leaves the Chat home on screen.
  Future<void> _openComputerChat(
    PushMessage message,
    bool Function() isCurrent, {
    required int since,
  }) async {
    final target = computerChatPushTarget(message.data);
    if (target == null) return;
    final router = context.read<PushChatRouter?>();
    if (router == null) return;
    final chat = await router.resolve(
      computerId: target.computerId,
      clientChatId: target.clientChatId,
      workspaceContext: context.read<WorkspaceContext?>(),
    );
    if (chat == null || !isCurrent()) return;
    _requests.request(chat, since: since);
  }

  /// Returns the shell to its home destination and returns that tab.
  HomeTab _showHome() {
    // A route stacked above the shell (an open chat, settings) would hide a
    // bare tab switch; return to the shell first so home is visible.
    Navigator.of(context).popUntil((route) => route.isFirst);
    // Selected by identity, not index: the visible tab set varies. A shell
    // without the Chat home, such as a guest's, opens its first destination.
    final controller = context.read<HomeTabController>();
    final home = controller.tabs.contains(HomeTab.chat)
        ? HomeTab.chat
        : controller.tabs.first;
    controller.select(home);
    return home;
  }

  /// Whether the user is still where [_showHome] left them: on [home] with
  /// nothing pushed above the shell. A chat resolved after they moved on
  /// must not pull them away from what they opened during the wait.
  bool _isOn(HomeTab home) =>
      context.read<HomeTabController>().value == home &&
      !Navigator.of(context).canPop();

  @override
  Widget build(BuildContext context) =>
      ListenableProvider<HomeChatOpenRequests>.value(
        value: _requests,
        child: widget.child,
      );
}

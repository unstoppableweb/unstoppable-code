import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/services/desktop_app/desktop_app_prompt_policy.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_controller.dart';
import 'package:mobile/ui/features/device_link/computer_connect/account.dart';
import 'package:provider/provider.dart';

/// Tells the app-lifetime [DesktopAppPromptController] which account is
/// signed in and whether it has a computer paired through Computer connect,
/// from the shell's [AuthViewModel] and [ComputerConnectAccount]. A shell
/// without Computer connect, such as a guest's, cannot pair a computer, so it
/// counts as having none. Leaving the shell (sign-out) clears both. Inert when
/// no controller is provided.
class DesktopAppPromptBinding extends StatefulWidget {
  const DesktopAppPromptBinding({super.key, required this.child});

  final Widget child;

  @override
  State<DesktopAppPromptBinding> createState() =>
      _DesktopAppPromptBindingState();
}

class _DesktopAppPromptBindingState extends State<DesktopAppPromptBinding> {
  late final DesktopAppPromptController? _controller = context
      .read<DesktopAppPromptController?>();
  late final AuthViewModel _auth = context.read<AuthViewModel>();
  late final ComputerConnectAccount? _computers = context
      .read<ComputerConnectAccount?>();
  bool _publishScheduled = false;

  @override
  void initState() {
    super.initState();
    if (_controller == null) return;
    _auth.addListener(_schedulePublish);
    _computers?.addListener(_schedulePublish);
    _schedulePublish();
  }

  @override
  void dispose() {
    final controller = _controller;
    if (controller != null) {
      _auth.removeListener(_schedulePublish);
      _computers?.removeListener(_schedulePublish);
      // The controller outlives the shell; its listeners may not rebuild
      // while this tree is being torn down.
      scheduleMicrotask(
        () => controller.updateContext(
          accountScope: null,
          pairing: DesktopPairing.unknown,
        ),
      );
    }
    super.dispose();
  }

  /// Coalesces bursts of notifications into one update, outside the
  /// notifying call, since the update notifies in turn.
  void _schedulePublish() {
    if (_publishScheduled) return;
    _publishScheduled = true;
    scheduleMicrotask(() {
      _publishScheduled = false;
      if (!mounted) return;
      final userId = _auth.status == AuthStatus.authenticated
          ? _auth.user?.id
          : null;
      final computers = _computers;
      _controller?.updateContext(
        // Environment-qualified: production user 7 and staging user 7 are
        // different accounts.
        accountScope: userId == null
            ? null
            : '${AppConfig.environment.name}:$userId',
        pairing: computers == null
            ? DesktopPairing.none
            : DesktopPairing.of(
                settled: computers.ready,
                hasComputers: computers.computers.isNotEmpty,
              ),
      );
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

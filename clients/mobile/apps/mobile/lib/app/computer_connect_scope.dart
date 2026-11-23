import 'dart:async';
import 'package:mobile/data/models/start_screen.dart';
import 'package:mobile/ui/core/start_screen_controller.dart';
import 'package:mobile/ui/core/navigation/home_chat_destination.dart';
import 'package:mobile/ui/features/device_link/computer_connect/home.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/ui/core/navigation/home_extra_destination.dart';
import 'package:mobile/ui/features/device_link/computer_connect/account_model.dart';
import 'package:mobile/ui/features/device_link/computer_connect/usage_model.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/core/widgets/computer_picker_builder.dart';
import 'package:mobile/ui/features/device_link/computer_connect/details_picker.dart';
import 'package:mobile/ui/features/device_link/computer_connect/screen.dart';
import 'package:mobile/ui/core/navigation/home_orchestrator_destination.dart';
import 'package:mobile/ui/features/device_link/computer_connect/orchestrator/screen.dart';
import 'package:mobile/ui/features/device_link/computer_connect/recent_chats.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';
import 'package:mobile/ui/core/navigation/home_chat_open_request.dart';
import 'package:mobile/ui/features/device_link/computer_connect/push_chat_router.dart';
import 'computer_connect_transport.dart';
import 'space_notifications_provider.dart';

/// Account-scoped composition for the Computer Connect home and overview.
/// The installation identity keeps old desktop pairings; credentials
/// and remembered computers are account/server scoped.
class ComputerConnectScope extends StatefulWidget {
  const ComputerConnectScope({
    super.key,
    required this.child,
    required this.accountId,
    required this.sessionToken,
    required this.twoFactorProof,
    required this.enabled,
  });
  final Widget child;
  final String? accountId, sessionToken, twoFactorProof;
  final bool enabled;
  @override
  State<ComputerConnectScope> createState() => _ComputerConnectScopeState();
}

class _ComputerConnectScopeState extends State<ComputerConnectScope>
    with WidgetsBindingObserver {
  ComputerAccountModel? _account;
  ComputerRecentChats? _recentChats;
  PushChatRouter? _pushChatRouter;
  ComputerUsageModel? _usage;
  bool get _enabled =>
      widget.enabled && widget.accountId != null && widget.sessionToken != null;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_enabled || _account != null) return;
    final binding = context.read<ComputerConnectTransport>().bind(
      origin: AppConfig.apiBaseUrl,
      accountId: widget.accountId!,
      sessionToken: () => widget.sessionToken,
      twoFactorProof: () => widget.twoFactorProof,
    );
    final account = binding.createAccount();
    _account = account;
    _usage = binding.createUsage(account);
    _recentChats = ComputerRecentChats(account, order: binding.orderRecents);
    _pushChatRouter = ComputerPushChatRouter(
      account: account,
      rows: _recentChats!.rows,
    );
    WidgetsBinding.instance.addObserver(this);
    // The observer reports only later changes: an account created while the
    // app is not resumed starts in the app's state, so its restore does not
    // act as if the app were in the foreground.
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    if (lifecycle != null && lifecycle != AppLifecycleState.resumed) {
      unawaited(account.lifecycleChanged(lifecycle));
    }
    unawaited(account.restore());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    unawaited(_account?.lifecycleChanged(state));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _account?.dispose();
    _usage?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableProvider<ProviderUsageSource?>.value(
      value: _usage,
      child: _buildDestinations(context),
    );
  }

  Widget _buildDestinations(BuildContext context) {
    final account = _account;
    final recentChats = _recentChats;
    final pushChatRouter = _pushChatRouter;
    if (!_enabled ||
        account == null ||
        recentChats == null ||
        pushChatRouter == null) {
      return widget.child;
    }
    return MultiProvider(
      providers: [
        // Read by account-wide bindings, such as the desktop app prompt.
        ListenableProvider<ComputerAccountModel>.value(value: account),
        Provider<ComputerPickerBuilder>.value(
          value: (title) =>
              ComputerDetailsPicker(account: account, title: title),
        ),
        ListenableProvider<HomeRecentChatsSource>.value(value: recentChats),
        // Read by the notification-tap binding to open a chat on its computer.
        Provider<PushChatRouter>.value(value: pushChatRouter),
        // Read by worktree and Cowork rows for their notification choices.
        spaceNotificationsProvider(
          sessionToken: () => widget.sessionToken,
          twoFactorProof: () => widget.twoFactorProof,
        ),
      ],
      child: ListenableBuilder(
        listenable: account,
        child: widget.child,
        builder: (context, child) => HomeChatDestination(
          builder: (_) => ComputerChatHome(account: account),
          child: HomeOrchestratorDestination(
            builder: (_, isActive) => ComputerOrchestratorScreen(
              account: account,
              isActive: isActive,
            ),
            child: HomeExtraDestination(
              takeInitialSelection: () =>
                  context.read<StartScreenController?>()?.takeInitialScreen() ==
                  StartScreen.projects,
              label: 'Computer connect',
              subtitle: account.selectedName ?? 'Connect a computer',
              pageBuilder: (_) => ListenableBuilder(
                listenable: account,
                builder: (_, _) => ComputerConnectScreen(
                  key: ObjectKey(account.sessions.selected),
                  controller: account.sessions.selected,
                  account: account,
                ),
              ),
              child: child!,
            ),
          ),
        ),
      ),
    );
  }
}

import 'dart:async';
import 'package:mobile/data/services/computer_chat_selection_store.dart';
import 'package:mobile/data/models/start_screen.dart';
import 'package:mobile/ui/core/start_screen_controller.dart';
import 'package:mobile/ui/core/navigation/home_chat_destination.dart';
import 'package:mobile/ui/features/device_link/computer_connect/home.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/device_link/desktop/hub.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/core/navigation/home_extra_destination.dart';
import 'package:mobile/ui/features/device_link/computer_connect/account.dart';
import 'package:mobile/ui/features/device_link/computer_connect/engine.dart';
import 'package:mobile/ui/features/device_link/computer_connect/provider_usage_source.dart';
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
import 'computer_connect_access.dart';
import 'device_link_device_name.dart';
import 'device_link_secure_store.dart';
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
  ComputerConnectEngine? _engine;
  ComputerConnectAccount? _account;
  ComputerRecentChats? _recentChats;
  PushChatRouter? _pushChatRouter;
  final _usage = ComputerProviderUsageSource();
  bool get _enabled =>
      widget.enabled && widget.accountId != null && widget.sessionToken != null;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final draftStore = context.watch<ChatDraftStoreHolder?>()?.store;
    if (!_enabled) return;
    if (_engine case final engine?) {
      if (draftStore != null) engine.bindDraftStore(draftStore);
      return;
    }
    final origin = AppConfig.apiBaseUrl;
    final engine = ComputerConnectEngine(
      DesktopLinkHub(
        store: DeviceLinkSecureStore.desktop(),
        deviceName: deviceLinkDeviceName,
      ),
      drafts: draftStore,
    );
    // Read per request: the scope is keyed by account, so a rebuilt widget
    // only ever carries this account's refreshed session.
    final access = ComputerConnectAccess(
      origin: origin,
      sessionToken: () => widget.sessionToken,
      twoFactorProof: () => widget.twoFactorProof,
    );
    _engine = engine;
    _usage.bind(engine);
    _account = ComputerConnectAccount(
      engine: engine,
      store: DeviceLinkSecureStore.connection(
        accountId: widget.accountId!,
        origin: origin,
      ),
      accountId: widget.accountId!,
      origin: origin,
      fetchToken: access.token,
      revokeLegacyKey: access.revokeLegacyKey,
    );
    _recentChats = ComputerRecentChats(_account!);
    _pushChatRouter = ComputerPushChatRouter(
      account: _account!,
      rows: _recentChats!.rows,
    );
    WidgetsBinding.instance.addObserver(this);
    unawaited(_account!.restore());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final account = _account;
    if (account == null) return;
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused) {
      unawaited(account.suspend());
    }
    if (state == AppLifecycleState.resumed) unawaited(account.resume());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _account?.dispose();
    _usage.dispose();
    _engine?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableProvider<ProviderUsageSource>.value(
      value: _usage,
      child: _buildDestinations(context),
    );
  }

  Widget _buildDestinations(BuildContext context) {
    final engine = _engine;
    final account = _account;
    final recentChats = _recentChats;
    final pushChatRouter = _pushChatRouter;
    if (!_enabled ||
        engine == null ||
        account == null ||
        recentChats == null ||
        pushChatRouter == null) {
      return widget.child;
    }
    return MultiProvider(
      providers: [
        // Read by account-wide bindings, such as the desktop app prompt.
        ListenableProvider<ComputerConnectAccount>.value(value: account),
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
          builder: (_) => ComputerChatHome(
            account: account,
            selectionStore: (computerId, workspaceContext) =>
                ComputerChatSelectionStore(
                  accountId: widget.accountId!,
                  origin: AppConfig.apiBaseUrl,
                  computerId: computerId,
                  contextId: workspaceContext.organizationId == null
                      ? 'personal'
                      : 'organization:${workspaceContext.organizationId}',
                ),
          ),
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
                  key: ObjectKey(engine.selected),
                  controller: engine.selected,
                  apiOrigin: AppConfig.apiBaseUrl,
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

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/feedback_outbox_store.dart';
import 'package:mobile/data/services/turn_feedback_api_service.dart';
import 'package:mobile/ui/core/chat/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:provider/provider.dart';

/// Owns the [TurnFeedbackController] behind the transcript thumbs and keeps
/// it in step with the signed-in account and the app lifecycle.
///
/// - Ratings go to `/api/v1/feedback/turns` with the sign-in session, the
///   same server rows desktop writes. Without API config the in-memory mock
///   serves them.
/// - The durable outbox (`canopy.feedback_outbox`) stamps every entry with
///   the environment-qualified account that queued it, and only that
///   account's entries are ever sent.
/// - It flushes the outbox when an account signs in (or is already signed in
///   at mount) and on every return to the foreground, and drops cached
///   ratings when the account changes.
class TurnFeedbackScope extends StatefulWidget {
  const TurnFeedbackScope({
    super.key,
    required this.apiClient,
    required this.child,
  });

  final ApiClient apiClient;
  final Widget child;

  @override
  State<TurnFeedbackScope> createState() => _TurnFeedbackScopeState();
}

class _TurnFeedbackScopeState extends State<TurnFeedbackScope>
    with WidgetsBindingObserver {
  AuthViewModel? _auth;
  String? _account;
  late final TurnFeedbackController _controller = TurnFeedbackController(
    repository: AppConfig.hasAuthApiConfig
        ? HttpTurnFeedbackRepository(
            service: TurnFeedbackApiService(apiClient: widget.apiClient),
            outbox: SharedPrefsFeedbackOutboxStore(),
            accountScope: () => _account,
          )
        : MockTurnFeedbackRepository(),
  );

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  /// Runs on mount and on every [AuthViewModel] notification (the build
  /// below depends on it).
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final auth = context.watch<AuthViewModel>();
    final first = _auth == null;
    _auth = auth;
    final userId = auth.user?.id;
    final account = auth.hasAccount && userId != null
        ? '${AppConfig.environment.name}:$userId'
        : null;
    if (!first && account == _account) return;
    _account = account;
    if (!first) _controller.resetHydration();
    if (account != null) unawaited(_controller.flushOutbox());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _account != null) {
      unawaited(_controller.flushOutbox());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      ChangeNotifierProvider<TurnFeedbackController>.value(
        value: _controller,
        child: widget.child,
      );
}

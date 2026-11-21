import 'dart:async';
import 'dart:io';

import 'package:mobile/app/computer_connect_scope.dart';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_crashlytics/firebase_crashlytics.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import 'package:provider/single_child_widget.dart';
import 'package:mobile/app/desktop_app_prompt_binding.dart';
import 'package:mobile/ui/features/desktop_app/views/desktop_app_prompt_sheet.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/config/demo_mode.dart';
import 'package:mobile/ui/core/layout/fold_safe_area.dart';
import 'package:mobile/ui/core/layout/ios_fold_region_scope.dart';
import 'package:mobile/data/models/account_organizations.dart';
import 'package:mobile/data/models/model_picker_tab_store.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/services/model_picker_tab_preference_store.dart';
import 'package:mobile/data/models/chat_drafts.dart';

import 'package:mobile/data/models/device_registration.dart';
import 'package:mobile/data/services/chat_draft_store.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/auth_sources_repository.dart';
import 'package:mobile/data/repositories/device_repository.dart';
import 'package:mobile/data/repositories/feed_repository.dart';
import 'package:mobile/data/repositories/feedback_report_repository.dart';
import 'package:mobile/data/repositories/incoming_invitations_repository.dart';
import 'package:mobile/data/repositories/member_detail_repository.dart';
import 'package:mobile/data/repositories/members_repository.dart';
import 'package:mobile/data/repositories/notification_preferences_repository.dart';
import 'package:mobile/data/repositories/org_settings_repository.dart';
import 'package:mobile/data/repositories/org_repository.dart';
import 'package:mobile/data/repositories/profile_repository.dart';
import 'package:mobile/data/repositories/stats_repository.dart';
import 'package:mobile/data/repositories/sub_teams_repository.dart';
import 'package:mobile/data/repositories/two_factor_repository.dart';
import 'package:mobile/data/services/account_api_service.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/api_keys_api_service.dart';
import 'package:mobile/data/services/org_api_service.dart';
import 'package:mobile/data/services/auth_api_service.dart';
import 'package:mobile/data/services/auth_sources_api_service.dart';
import 'package:mobile/data/services/device_api_service.dart';
import 'package:mobile/data/services/feed_api_service.dart';
import 'package:mobile/data/services/feedback_report_api_service.dart';
import 'package:mobile/data/services/install_beacon_service.dart';
import 'package:mobile/data/services/firebase_push_messaging.dart';
import 'package:mobile/data/services/member_detail_api_service.dart';
import 'package:mobile/data/services/members_api_service.dart';
import 'package:mobile/data/services/notification_preferences_api_service.dart';
import 'package:mobile/data/services/oauth_authenticator.dart';
import 'package:mobile/data/services/org_settings_api_service.dart';
import 'package:mobile/data/services/profile_api_service.dart';
import 'package:mobile/data/services/push_messaging.dart';
import 'package:mobile/services/link_sharer.dart';
import 'package:mobile/ui/core/external_links.dart';
import 'package:mobile/ui/features/desktop_app/view_models/desktop_app_prompt_controller.dart';
import 'package:mobile/data/services/satisfaction_prompt_store.dart';
import 'package:mobile/data/services/session_store.dart';
import 'package:mobile/data/services/stats_api_service.dart';
import 'package:mobile/data/services/sub_teams_api_service.dart';
import 'package:mobile/data/services/two_factor_api_service.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:mobile/data/services/start_screen_preference_store.dart';
import 'package:mobile/data/services/usage_data_preference_store.dart';
import 'package:mobile/data/services/workspace_context_store.dart';
import 'package:mobile/services/analytics/app_open_reporter.dart';
import 'package:mobile/services/analytics/posthog_product_analytics.dart';
import 'package:mobile/services/analytics/product_analytics.dart';
import 'package:mobile/services/app_build_info.dart';
import 'package:mobile/services/crash_reporting.dart';
import 'package:mobile/services/push_message_coordinator.dart';
import 'package:mobile/services/push_service.dart';
import 'package:mobile/services/remote_transcript_cache_directory.dart';
import 'package:mobile/services/satisfaction/satisfaction_policy.dart';
import 'package:mobile/services/store_review_launcher.dart';
import 'package:mobile/ui/core/font_licenses.dart';
import 'package:mobile/ui/core/launch_view.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/theme_controller.dart';
import 'package:mobile/ui/core/start_screen_controller.dart';
import 'package:mobile/ui/core/usage_data_controller.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';
import 'package:mobile/ui/features/account/view_models/auth_sources_view_model.dart';
import 'package:mobile/ui/features/account/view_models/profile_view_model.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/workspace_context_provider.dart';
import 'package:mobile/ui/features/account/views/guest_account_screen.dart';
import 'package:mobile/ui/features/auth/views/guest_sign_in_screen.dart';
import 'package:mobile/ui/features/auth/views/sign_in_screen.dart';
import 'package:mobile/ui/features/auth/views/session_recovery_screen.dart';
import 'package:mobile/ui/features/auth/views/two_factor_screen.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/chat/views/chat_draft_store_scope.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:mobile/ui/features/members/view_models/incoming_invitations_view_model.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:mobile/ui/features/organizations/view_models/org_settings_view_model.dart';
import 'package:mobile/ui/features/organizations/view_models/org_view_model.dart';
import 'package:mobile/app/push_tap_binding.dart';
import 'package:mobile/app/turn_feedback_scope.dart';
import 'package:mobile/ui/features/satisfaction/view_models/satisfaction_prompt_controller.dart';
import 'package:mobile/ui/features/settings/view_models/notifications_view_model.dart';
import 'package:mobile/ui/features/stats/view_models/stats_view_model.dart';
import 'package:mobile/ui/features/sub_teams/view_models/sub_teams_view_model.dart';

/// Shared across the auth repository and the authenticated data repositories so
/// they all send the same bearer token.  Harmless in mock mode (empty base URL,
/// never used).
final SessionStore _sessionStore = SecureSessionStore();

/// `version+build` from the platform package info, read once in [main]. Null
/// until that read resolves, and for good if it fails: requests then omit the
/// client version header instead of waiting on it.
String? _clientVersion;
final ApiClient _apiClient = ApiClient.withBaseUrlProvider(
  baseUrlProvider: () => AppConfig.apiBaseUrl,
  defaultHeaders: const {'Content-Type': 'application/json'},
  tokenProvider: () => _sessionStore.currentToken,
  twoFactorProofProvider: () => _sessionStore.currentTwoFactorProof,
  clientVersionProvider: () => _clientVersion,
);

/// Builds the real Better Auth-backed [HttpAuthRepository] when an API base
/// URL is configured, else null for the mock.
HttpAuthRepository? _buildHttpAuthRepository() {
  if (!AppConfig.hasAuthApiConfig) return null;
  return HttpAuthRepository(
    service: AuthApiService(apiClient: _apiClient),
    sessionStore: _sessionStore,
    oauthAuthenticator: const WebAuthOAuthenticator(),
  );
}

/// Loads the signed-in user's organizations and Personal id (real mode only).
/// Empty in mock mode, where the org id is ignored and the data screens render
/// mock data. [AuthViewModel] chooses the active context from the result.
Future<AccountOrganizations> _loadOrganizations() async {
  if (!AppConfig.hasAuthApiConfig) return const AccountOrganizations();
  return AccountApiService(apiClient: _apiClient).listOrganizations();
}

/// Builds the active team [FeedRepository]: live when signed in with an org
/// id, else the mock (keeping `flutter test` and CI green without config).
FeedRepository _buildFeedRepository(String? orgId) {
  if (AppConfig.hasAuthApiConfig && orgId != null) {
    final service = FeedApiService(apiClient: _apiClient);
    return HttpFeedRepository(
      service: service,
      orgId: orgId,
      readSharingStatus: service.fetchSharingStatus,
    );
  }
  return MockFeedRepository();
}

/// Builds the Personal [FeedRepository], live or mock as above. Personal
/// Activity has no organization sharing evidence to read.
FeedRepository _buildPersonalFeedRepository(String orgId) {
  if (AppConfig.hasAuthApiConfig) {
    return HttpFeedRepository(
      service: FeedApiService(apiClient: _apiClient),
      orgId: orgId,
      readSharingStatus: noFeedSharingStatus,
    );
  }
  return MockFeedRepository();
}

StatsRepository _buildStatsRepository(String? orgId) {
  if (AppConfig.hasAuthApiConfig && orgId != null) {
    return HttpStatsRepository(
      service: StatsApiService(apiClient: _apiClient),
      orgId: orgId,
    );
  }
  return MockStatsRepository();
}

MembersRepository _buildMembersRepository(String? orgId) {
  if (AppConfig.hasAuthApiConfig && orgId != null) {
    return HttpMembersRepository(
      service: MembersApiService(apiClient: _apiClient),
      orgId: orgId,
    );
  }
  return MockMembersRepository();
}

OrgSettingsRepository _buildOrgSettingsRepository(String? orgId) {
  if (AppConfig.hasAuthApiConfig && orgId != null) {
    return HttpOrgSettingsRepository(
      service: OrgSettingsApiService(apiClient: _apiClient),
      orgId: orgId,
    );
  }
  return MockOrgSettingsRepository();
}

/// Builds a [MemberDetailRepository] for one member's profile drill-down.
///
/// Org- and member-scoped, so it is constructed on demand at the navigation
/// call site (the members-list row tap) and handed to the pushed
/// `MemberDetailScreen`, rather than living as a global provider. Falls back to
/// the mock in mock mode (no API config) so `flutter test` and CI stay green.
MemberDetailRepository buildMemberDetailRepository({
  required String orgId,
  required String memberId,
}) {
  if (AppConfig.hasAuthApiConfig) {
    return HttpMemberDetailRepository(
      service: MemberDetailApiService(apiClient: _apiClient),
      orgId: orgId,
      memberId: memberId,
    );
  }
  return MockMemberDetailRepository();
}

SubTeamsRepository _buildSubTeamsRepository(String? orgId) {
  if (AppConfig.hasAuthApiConfig && orgId != null) {
    return HttpSubTeamsRepository(
      subTeamsService: SubTeamsApiService(apiClient: _apiClient),
      membersService: MembersApiService(apiClient: _apiClient),
      orgId: orgId,
    );
  }
  return MockSubTeamsRepository();
}

/// Builds the [ApiKeysRepository]. API keys are account-scoped (not org-scoped),
/// so no org id is required.
ApiKeysRepository _buildApiKeysRepository() {
  if (AppConfig.hasAuthApiConfig) {
    return HttpApiKeysRepository(
      service: ApiKeysApiService(apiClient: _apiClient),
    );
  }
  return MockApiKeysRepository();
}

/// Builds the [AuthSourcesRepository]. Linked login methods are account-scoped
/// (not org-scoped), so no org id is required.
AuthSourcesRepository _buildAuthSourcesRepository() {
  if (AppConfig.hasAuthApiConfig) {
    return HttpAuthSourcesRepository(
      service: AuthSourcesApiService(apiClient: _apiClient),
    );
  }
  return MockAuthSourcesRepository();
}

/// Builds the [ProfileRepository] (account-scoped, no org id required).
ProfileRepository _buildProfileRepository() {
  if (AppConfig.hasAuthApiConfig) {
    return HttpProfileRepository(
      service: ProfileApiService(apiClient: _apiClient),
    );
  }
  return MockProfileRepository();
}

/// Builds the [TwoFactorRepository]. 2FA is account-scoped (not org-scoped),
/// so no org id is required.
TwoFactorRepository _buildTwoFactorRepository() {
  if (AppConfig.hasAuthApiConfig) {
    return HttpTwoFactorRepository(
      service: TwoFactorApiService(apiClient: _apiClient),
    );
  }
  return MockTwoFactorRepository();
}

/// Builds the [OrgRepository] for the organization lifecycle actions. These
/// endpoints are account-scoped (they create/leave/delete orgs by id), so no
/// active org id is required.
OrgRepository _buildOrgRepository() {
  if (AppConfig.hasAuthApiConfig) {
    return HttpOrgRepository(service: OrgApiService(apiClient: _apiClient));
  }
  return MockOrgRepository();
}

/// The signed-in account's environment-qualified key, or null while nobody
/// is signed in. Scopes the account's chat drafts.
String? _accountScopeOf(AuthViewModel auth) {
  final userId = auth.status == AuthStatus.authenticated ? auth.user?.id : null;
  return userId == null ? null : '${AppConfig.environment.name}:$userId';
}

Future<ChatDraftStore> _openChatDraftStore(String accountScope) async =>
    FileChatDraftStore.open(
      directory: await getApplicationSupportDirectory(),
      accountScope: accountScope,
    );

/// Builds the [FeedbackReportRepository] backing the app-wide "Send feedback"
/// sheet (Account tab + Settings). Feedback reports are device/user-scoped
/// (not org-scoped), so this gates on config alone.
///
/// [FeedbackReportRepository] is provided in [buildRootProviders] rather than
/// [buildSharedShellProviders] — see that provider's registration and
/// `showFeedbackReportSheet`'s doc comment for why — which means this is
/// built only once at module load, above the demo-mode/API-environment
/// reactive boundary in [App.build]. A plain [HttpFeedbackReportRepository] or
/// [MockFeedbackReportRepository] chosen here would freeze that choice for
/// the app's lifetime; [LiveConfigFeedbackReportRepository] defers it to
/// every individual submit instead.
FeedbackReportRepository _buildFeedbackReportRepository() =>
    LiveConfigFeedbackReportRepository(
      isConfigured: () => AppConfig.hasAuthApiConfig,
      http: HttpFeedbackReportRepository(
        service: FeedbackReportApiService(apiClient: _apiClient),
      ),
      mock: MockFeedbackReportRepository(),
    );

/// Single [FeedbackReportRepository] instance for the app's lifetime — see
/// [_buildFeedbackReportRepository]'s doc comment for why this is built once
/// at module load rather than per-shell like most other repositories in this
/// file.
final FeedbackReportRepository _feedbackReportRepository =
    _buildFeedbackReportRepository();

/// Builds the [IncomingInvitationsRepository] for the no-organization screen.
/// The incoming-invitation endpoints are user-scoped, so no org id is needed.
IncomingInvitationsRepository _buildIncomingInvitationsRepository() {
  if (AppConfig.hasAuthApiConfig) {
    return HttpIncomingInvitationsRepository(
      service: MembersApiService(apiClient: _apiClient),
    );
  }
  return MockIncomingInvitationsRepository();
}

/// Builds the [DeviceRepository] used to register/unregister this device's
/// push token (account-scoped, no org id required).
DeviceRepository _buildDeviceRepository() {
  if (AppConfig.hasAuthApiConfig) {
    return HttpDeviceRepository(
      service: DeviceApiService(apiClient: _apiClient),
    );
  }
  return MockDeviceRepository();
}

/// Builds the [NotificationPreferencesRepository] for the account-wide
/// push-notifications toggle (account-scoped, no org id required).
NotificationPreferencesRepository _buildNotificationPreferencesRepository() {
  if (AppConfig.hasAuthApiConfig) {
    return HttpNotificationPreferencesRepository(
      service: NotificationPreferencesApiService(apiClient: _apiClient),
    );
  }
  return MockNotificationPreferencesRepository();
}

/// Single messaging backend shared by token registration ([PushService]) and
/// message handling ([PushMessageCoordinator]). Static choice, matching the
/// existing PushService pattern: demo mode gets the inert fake.
final PushMessaging _pushMessaging = AppConfig.hasAuthApiConfig
    ? const FirebasePushMessaging()
    : FakePushMessaging();

/// Single [PushService] instance for the app's lifetime. Provided above the
/// auth gate (see [App.build]) so it survives sign-out, environment changes,
/// and organization switches; [_PushLifecycleBinding] drives it from
/// [AuthViewModel] transitions. Its repository uses [_apiClient], whose fixed
/// origin is resolved immediately before each request, while [isPushConfigured]
/// stays a live closure so demo mode still makes every call a safe no-op.
final PushService _pushService = PushService(
  messaging: _pushMessaging,
  deviceRepository: _buildDeviceRepository(),
  platform: Platform.isIOS ? DevicePlatform.ios : DevicePlatform.android,
  isPushConfigured: () => AppConfig.hasAuthApiConfig,
);

/// Module-level singleton for push message handling: [_pushMessageCoordinator]
/// turns [_pushMessaging] notification taps into pending navigation.
/// Foreground messages render nothing in the app. Provided above the auth gate
/// (see [App.build]) alongside [_pushService] so it survives sign-out and
/// organization switches; [_PushLifecycleBindingState._handleAuthChange]
/// starts the coordinator once authenticated.
final PushMessageCoordinator _pushMessageCoordinator = PushMessageCoordinator(
  messaging: _pushMessaging,
);

/// Single [NotificationsViewModel] instance for the app's lifetime, provided
/// above the auth gate alongside [_pushService] so the Settings toggle keeps
/// its state across sign-out and organization switches. Its repository shares
/// the dynamically resolved [_apiClient], while `isConfigured` stays a live
/// closure so demo mode still makes [NotificationsViewModel.load] and
/// [NotificationsViewModel.setPushEnabled] safe no-ops. [_PushLifecycleBinding]
/// triggers the initial [NotificationsViewModel.load] once authenticated.
final NotificationsViewModel _notificationsViewModel = NotificationsViewModel(
  repository: _buildNotificationPreferencesRepository(),
  isConfigured: () => AppConfig.hasAuthApiConfig,
);

/// The member's Crash reports and Usage analytics choices. `main()` loads
/// them before Firebase and PostHog start; provided above [MaterialApp]
/// beside [ThemeController].
final UsageDataController _usageDataController = UsageDataController(
  store: SharedPrefsUsageDataPreferenceStore(),
);

/// App-lifetime product analytics. A no-op until `main()` starts PostHog;
/// every capture is re-gated on [AppConfig.hasAuthApiConfig] so reviewer
/// demo mode (entered after launch) captures nothing, and on the member's
/// Usage analytics choice.
final AppProductAnalytics _productAnalytics = AppProductAnalytics(
  isAllowed: () =>
      AppConfig.hasAuthApiConfig && _usageDataController.analyticsEnabled,
);

/// Single [SatisfactionPromptController] for the app's lifetime. Root-provided
/// so routes pushed on the ROOT navigator can read it. Staging (internal
/// testers only) uses the verification thresholds so the native review flow
/// can be checked on real TestFlight / Play internal builds.
final SatisfactionPromptController _satisfactionPromptController =
    SatisfactionPromptController(
      store: SharedPrefsSatisfactionPromptStore(),
      analytics: _productAnalytics,
      reviewLauncher: InAppReviewLauncher(),
      isActive: () => AppConfig.hasAuthApiConfig,
      thresholds: () => AppConfig.isStaging
          ? SatisfactionThresholds.verification
          : SatisfactionThresholds.production,
    );

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  registerBundledFontLicenses();
  // Decoded alongside the rest of startup so the first frame can paint it.
  final launchMarkReady = LaunchView.precacheMark();
  await AppConfig.initialize();
  // Before Firebase and PostHog start. Crashlytics collection is off natively
  // until the choice is applied below, so it uploads nothing first. PostHog
  // captures check the choice from the start; its SDK is set up first and
  // then disabled while the choice is off.
  await _usageDataController.load();

  // Guarded: a missing native config file (google-services.json /
  // GoogleService-Info.plist) makes this throw. Push notifications and crash
  // reporting simply won't be available until Firebase is configured for this
  // platform/build — that must never block the rest of the app from booting.
  try {
    await Firebase.initializeApp();
    // Inside the try, and only after initializeApp resolves: touching
    // Crashlytics without an initialized app throws, which would turn a
    // missing config file into a boot failure. Native crashes need no wiring
    // here — the SDK captures them once the platform config is present.
    //
    // Collection is off natively (`firebase_crashlytics_collection_enabled`
    // in the manifest and Info.plist) so reports from the previous session
    // upload only once the member's choice is applied here. Crashlytics
    // persists the value, so later launches start from the last choice.
    final crashlytics = FirebaseCrashlytics.instance;
    // Applied one at a time, so a quick on/off can't land out of order.
    // Reports stored while the member has it off are deleted, so turning it
    // back on never uploads crashes from that period; a fail-closed
    // placeholder keeps them.
    var crashReportsApplied = Future<void>.value();
    Future<void> applyCrashReports(bool enabled) {
      final choiceKnown = _usageDataController.crashReportsChoiceKnown;
      final applied = crashReportsApplied.then((_) async {
        await crashlytics.setCrashlyticsCollectionEnabled(enabled);
        if (!enabled && choiceKnown) {
          await crashlytics.deleteUnsentReports();
        }
      });
      crashReportsApplied = applied.catchError((Object _) {});
      return applied;
    }

    // Its own try, so a failure here still installs the Dart handlers below.
    try {
      await applyCrashReports(_usageDataController.crashReportsEnabled);
    } catch (error) {
      debugPrint('Crashlytics collection setting failed: $error');
    }
    _usageDataController.onCrashReportsChanged = (enabled) => unawaited(
      applyCrashReports(enabled).catchError(
        (Object error) =>
            debugPrint('Crashlytics collection setting failed: $error'),
      ),
    );
    installCrashHandlers(
      reporter: GatedCrashReporter(
        FirebaseCrashReporter(crashlytics: crashlytics),
        isEnabled: () => _usageDataController.crashReportsEnabled,
      ),
    );
  } catch (error) {
    debugPrint('Firebase.initializeApp failed, continuing without it: $error');
  }
  // App version for the client-surface header. Deliberately NOT awaited: it is
  // optional metadata, and requests sent before it resolves simply omit it.
  unawaited(
    AppBuildInfo.load().then<void>(
      (info) {
        _clientVersion = info.appVersion;
      },
      onError: (Object error) {
        debugPrint('Client version unavailable, omitting its header: $error');
      },
    ),
  );
  // First-launch install beacon. Deliberately NOT awaited: it is best-effort
  // telemetry and startup must never wait on the network for it.
  final installBeacon = InstallBeaconService(
    baseUrlProvider: () => AppConfig.apiBaseUrl,
  );
  // Read before the beacon starts: it flips the marker once accepted.
  final appOpenReporter = AppOpenReporter(
    analytics: _productAnalytics,
    isFirstLaunch: installBeacon.isFirstLaunch(),
  );
  unawaited(installBeacon.reportFirstLaunchIfNeeded());
  // Anonymous product analytics. Deliberately NOT awaited, like the install
  // beacon: startup never waits on the SDK. Off unless the build enables it.
  const analyticsConfig = ProductAnalyticsConfig(
    enabled: Brand.posthogEnabled,
    projectKey: Brand.posthogProjectKey,
    host: Brand.posthogHost,
  );
  if (analyticsConfig.canStart(hasAuthApiConfig: AppConfig.hasAuthApiConfig)) {
    unawaited(
      PostHogProductAnalytics.start(
        analyticsConfig,
        isStaging: () => AppConfig.isStaging,
      ).then(
        (analytics) async {
          _productAnalytics.delegate = analytics;
          _usageDataController.onAnalyticsChanged = (enabled) =>
              unawaited(analytics.setEnabled(enabled));
          // Captures are already gated on the choice; also stop the SDK
          // itself while it is off. Apply the current choice either way:
          // the SDK persists an opt-out natively, so a choice turned back on
          // before setup finished must re-enable it.
          await analytics.setEnabled(_usageDataController.analyticsEnabled);
          await appOpenReporter.reportOnce();
        },
        onError: (Object error) =>
            debugPrint('PostHog setup failed, continuing without it: $error'),
      ),
    );
  }
  final themeStore = SharedPrefsThemePreferenceStore();
  ThemeMode initialThemeMode;
  try {
    initialThemeMode = await themeStore.read();
  } catch (_) {
    initialThemeMode = ThemeMode.system;
  }
  final startScreenController = await StartScreenController.restore(
    SharedPrefsStartScreenPreferenceStore(),
  );
  await launchMarkReady;
  runApp(
    App(
      startScreenController: startScreenController,
      themeController: ThemeController(
        store: themeStore,
        initialMode: initialThemeMode,
      ),
    ),
  );
  // Best-effort and not awaited: removes chat tails an earlier build cached
  // for the retired Remote tab, so they do not outlive it on disk.
  unawaited(deleteRetiredRemoteTranscripts());
}

/// Providers held above [MaterialApp] for the app's lifetime (see
/// [App.build]), so a route pushed on the ROOT navigator can still read
/// them.
///
/// This matters because [buildSharedShellProviders] mounts INSIDE
/// `MaterialApp(home:)` (see `_shell` in `authenticated_shell.dart`), and
/// Flutter's `Navigator` inserts a route pushed via
/// `Navigator.of(context).push(...)` as a SIBLING overlay entry of the route
/// that pushed it, not as a descendant of that route's local providers. A
/// provider registered only inside [buildSharedShellProviders] is therefore
/// invisible to any screen reached by a push. [AuthViewModel] solves this by
/// living up here; [SatisfactionPromptController] follows the same fix rather
/// than requiring every push site to re-provide it. [FeedbackReportRepository]
/// and [NotificationsViewModel] follow it because Settings' feedback and push
/// rows must keep working wherever the page is shown, including from a pushed
/// route.
///
/// Public — like [buildSharedShellProviders] — so production and widget
/// tests compose the identical list instead of a hand-copied duplicate that
/// can silently drift out of sync with what a pushed route can actually see.
List<SingleChildWidget> buildRootProviders() => [
  Provider<PushService>.value(value: _pushService),
  Provider<PushMessageCoordinator>.value(value: _pushMessageCoordinator),
  Provider<FeedbackReportRepository>.value(value: _feedbackReportRepository),
  Provider<ModelPickerTabStore>(
    create: (_) => SharedPrefsModelPickerTabStore(),
  ),
  ChangeNotifierProvider<NotificationsViewModel>.value(
    value: _notificationsViewModel,
  ),
  ChangeNotifierProvider<SatisfactionPromptController>.value(
    value: _satisfactionPromptController,
  ),
  ChangeNotifierProvider<DesktopAppPromptController>(
    create: (_) => DesktopAppPromptController(
      isActive: () => AppConfig.hasAuthApiConfig,
      downloadUrl: desktopDownloadUrl,
      sharer: SharePlusLinkSharer(),
      showPrompt: showDesktopAppPromptSheet,
    ),
  ),
];

/// Root widget.  Provides [AuthViewModel] and applies the application theme;
/// the [AuthGate] chooses which screen to show based on auth state.  Brand
/// name and colours are resolved from injected brand configuration in a later
/// slice; the title here is a neutral placeholder.
class App extends StatelessWidget {
  const App({
    super.key,
    required this.themeController,
    required this.startScreenController,
  });

  final ThemeController themeController;
  final StartScreenController startScreenController;

  @override
  Widget build(BuildContext context) {
    // Rebuild the auth provider whenever reviewer demo mode or the fixed API
    // environment changes. [_buildAuthRepository] reads the current config at
    // creation time, so a fresh AuthViewModel is needed to swap repositories
    // and restore only against the selected origin. The provider stays above
    // MaterialApp so pushed routes can still read it.
    //
    // [buildRootProviders] supplies the rest of the app-lifetime singletons
    // that must be visible to pushed routes too — see its doc comment.
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<ThemeController>.value(value: themeController),
        ChangeNotifierProvider<StartScreenController>.value(
          value: startScreenController,
        ),
        ChangeNotifierProvider<UsageDataController>.value(
          value: _usageDataController,
        ),
        ...buildRootProviders(),
      ],
      child: ValueListenableBuilder<ApiEnvironment>(
        valueListenable: AppConfig.environmentListenable,
        builder: (context, apiEnvironment, _) => ValueListenableBuilder<bool>(
          valueListenable: DemoMode.enabled,
          builder: (context, demoModeEnabled, _) =>
              ChangeNotifierProvider<AuthViewModel>(
                key: ValueKey((demoModeEnabled, apiEnvironment)),
                create: (_) {
                  final live = _buildHttpAuthRepository();
                  return AuthViewModel(
                    repository: live ?? MockAuthRepository(),
                    loadOrganizations: _loadOrganizations,
                    workspaceContextStore: SharedPrefsWorkspaceContextStore(
                      namespace: apiEnvironment.name,
                    ),
                    beforeSignOut: () => _pushService.onSignedOut(null),
                  )..restore();
                },
                child: MultiProvider(
                  providers: [workspaceContextProvider()],
                  // Above MaterialApp so routes pushed on the root navigator
                  // read the same account draft store as the shell.
                  child: Builder(
                    builder: (context) => ChatDraftStoreScope(
                      account: context.read<AuthViewModel>(),
                      accountScope: () =>
                          _accountScopeOf(context.read<AuthViewModel>()),
                      open: _openChatDraftStore,
                      child: PushLifecycleBinding(
                        child: Consumer<ThemeController>(
                          builder: (context, theme, _) => MaterialApp(
                            title: Brand.displayName,
                            debugShowCheckedModeBanner: false,
                            navigatorObservers: [appRouteObserver],
                            theme: AppTheme.light,
                            darkTheme: AppTheme.dark,
                            themeMode: theme.mode,
                            builder: (context, child) =>
                                AnnotatedRegion<SystemUiOverlayStyle>(
                                  value: SystemUiOverlayStyle(
                                    systemNavigationBarColor: Theme.of(
                                      context,
                                    ).scaffoldBackgroundColor,
                                    systemNavigationBarDividerColor:
                                        Colors.transparent,
                                    systemNavigationBarIconBrightness:
                                        Theme.of(context).brightness ==
                                            Brightness.dark
                                        ? Brightness.light
                                        : Brightness.dark,
                                    systemNavigationBarContrastEnforced: false,
                                  ),
                                  child: IosFoldRegionScope(
                                    child: ColoredBox(
                                      color: Theme.of(
                                        context,
                                      ).scaffoldBackgroundColor,
                                      child: FoldSafeArea(child: child!),
                                    ),
                                  ),
                                ),
                            home: const AuthGate(),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
        ),
      ),
    );
  }
}

/// Wires [AuthViewModel] status transitions to [PushService] and
/// [NotificationsViewModel] (both read via `context.read` from providers above
/// this widget — see [buildRootProviders] — so a test can substitute its own
/// instances): the transition to [AuthStatus.authenticated] registers the push
/// token and loads the notification preference; the transition to
/// [AuthStatus.unauthenticated] unregisters the token. A transparent wrapper —
/// it renders [child] unchanged. Recreated whenever the keyed [AuthViewModel]
/// provider above it is recreated (reviewer demo-mode toggle), so it always
/// binds to the current [AuthViewModel] instance.
class PushLifecycleBinding extends StatefulWidget {
  const PushLifecycleBinding({super.key, required this.child});

  final Widget child;

  @override
  State<PushLifecycleBinding> createState() => _PushLifecycleBindingState();
}

class _PushLifecycleBindingState extends State<PushLifecycleBinding>
    with WidgetsBindingObserver {
  late final AuthViewModel _auth = context.read<AuthViewModel>();
  late final PushService _service = context.read<PushService>();
  late final NotificationsViewModel _notifications = context
      .read<NotificationsViewModel>();
  late AuthStatus _previousStatus;
  late bool _previousHasAccount;

  @override
  void initState() {
    super.initState();
    _previousStatus = _auth.status;
    _previousHasAccount = _auth.hasAccount;
    _auth.addListener(_handleAuthChange);
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _auth.removeListener(_handleAuthChange);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    // Re-attempt push registration on every foreground return: enabling
    // notifications in OS settings necessarily backgrounds the app, so this
    // is the moment a previously-denied permission becomes usable. The
    // service itself no-ops when signed out, already registered, or still
    // denied (see PushService.onAppResumed).
    unawaited(_service.onAppResumed());
  }

  void _handleAuthChange() {
    final status = _auth.status;
    final hasAccount = _auth.hasAccount;
    if (status == _previousStatus && hasAccount == _previousHasAccount) return;
    _previousStatus = status;
    _previousHasAccount = hasAccount;
    // Push and notification preferences are account-only (CAN-2872): a guest
    // is not registered, so "Continue as guest" asks the OS for nothing.
    if (hasAccount) {
      unawaited(_service.onAuthenticated());
      unawaited(_notifications.load());
      // Idempotent and restartable after the sign-out stop below.
      unawaited(_pushMessageCoordinator.start());
    } else if (status == AuthStatus.unauthenticated) {
      unawaited(_pushMessageCoordinator.stop());
      unawaited(_service.onSignedOut(null));
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// Routes between the startup splash, the sign-in screen, and the app shell.
/// The data view models are created only once authenticated, wired to the
/// resolved organization id.
class AuthGate extends StatelessWidget {
  const AuthGate({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthViewModel>();
    return switch (auth.status) {
      AuthStatus.validationFailed => const SessionRecoveryScreen(),
      AuthStatus.unknown => const LaunchView(),
      AuthStatus.unauthenticated ||
      AuthStatus.authenticating => const SignInScreen(),
      AuthStatus.twoFactorPending => const TwoFactorScreen(),
      // Composers read their drafts synchronously, so the shell waits for
      // the account's draft store (see [ChatDraftStoreScope]).
      AuthStatus.authenticated => switch (context
          .watch<ChatDraftStoreHolder?>()) {
        ChatDraftStoreHolder(store: null) => const LaunchView(),
        _ => _authenticatedApp(context, auth),
      },
    };
  }

  Widget _authenticatedApp(BuildContext context, AuthViewModel auth) {
    final orgId = auth.activeOrgId;
    final mode = resolveAuthenticatedShellMode(
      hasApiConfig: AppConfig.hasAuthApiConfig,
      isGuest: auth.isGuest,
      orgId: orgId,
      hasOrganizations: auth.organizations.isNotEmpty,
      hasPersonalOrganization: auth.personalOrganizationId != null,
      organizationsLoadFailed: auth.organizationsLoadFailed,
    );
    // Tabs and Members-tab content come from `homeTabsForShellMode` /
    // `membersTabForShellMode` rather than being written out per branch here:
    // which of the two org-less screens a mode gets decides whether a
    // create-organization CTA is offered, and that mapping is worth a test.
    final hasTeams = auth.organizations.isNotEmpty;
    final tabs = homeTabsForShellMode(mode, hasTeams: hasTeams);
    final landingTab = landingTabForShellMode(mode);
    final membersTab = membersTabForShellMode(mode, hasTeams: hasTeams);
    final shell = switch (mode) {
      // Membership is unknown, not empty. Offering "create an organization"
      // here could hand a user a duplicate of an org they already own, so this
      // shell only retries. It is otherwise the no-organization shell: the
      // teams API can be flag-gated off for an account, where retrying never
      // succeeds, and walling the app off would lock that user out of
      // Computer connect and Account for good.
      AuthenticatedShellMode.organizationsUnavailable => _shell(
        auth: auth,
        tabs: tabs,
        landingTab: landingTab,
        child: HomeShell(
          refreshActivity: refreshActivityFeed,
          activityAccount: watchActivityAccount,
          membersTab: membersTab,
        ),
      ),
      // An individual or Pro account with no organization is a legitimate
      // user. Computer connect and Account are user/account-scoped, so they
      // work untouched; the org-scoped tabs are dropped rather than faked
      // (CAN-2576).
      AuthenticatedShellMode.noOrganization => _shell(
        auth: auth,
        tabs: tabs,
        landingTab: landingTab,
        // The org-scoped view models are deliberately left unmounted here:
        // `_buildFeedRepository` and friends fall back to MOCK repositories
        // when the org id is null, and showing a real signed-in user sample
        // data would be worse than showing them nothing. No tab in this shell
        // reads them.
        child: MultiProvider(
          providers: buildNoOrganizationShellProviders(),
          child: HomeShell(
            refreshActivity: refreshActivityFeed,
            activityAccount: watchActivityAccount,
            membersTab: membersTab,
          ),
        ),
      ),
      // Personal (CAN-4429): the full shell, without the org-scoped view
      // models for the same reason as above. Activity shows the viewer's own
      // work from the Personal organization (CAN-3715); the other
      // organization destinations ask the user to choose an organization.
      // The key differs from every organization's, so a switch rebuilds the
      // shell and closes a chat from the previous context. It includes the
      // Personal organization, so a promoted one rebuilds its providers.
      AuthenticatedShellMode.personal => _shell(
        auth: auth,
        tabs: tabs,
        landingTab: landingTab,
        child: KeyedSubtree(
          key: ValueKey('personal-context:${auth.personalOrganizationId}'),
          child: MultiProvider(
            providers: buildPersonalShellProviders(auth.personalOrganizationId),
            child: HomeShell(
              refreshActivity: refreshActivityFeed,
              activityAccount: watchActivityAccount,
              membersTab: membersTab,
            ),
          ),
        ),
      ),
      // Existing guest sessions get sign-in and a guest Settings page. No
      // org-scoped provider is mounted, and Settings swaps the
      // account-security sections, which a guest's session cannot read, for
      // sign-in. A guest has no Computer connect, so it pairs no computer.
      AuthenticatedShellMode.guest => _shell(
        auth: auth,
        tabs: tabs,
        landingTab: landingTab,
        child: HomeShell(
          refreshActivity: refreshActivityFeed,
          activityAccount: watchActivityAccount,
          membersTab: membersTab,
          accountTab: GuestAccountScreen(
            onSignIn: GuestSignInScreen.open,
            onLeaveGuestMode: auth.signOut,
          ),
        ),
      ),
      AuthenticatedShellMode.organization => _shell(
        auth: auth,
        tabs: tabs,
        landingTab: landingTab,
        // Key the org-scoped subtree by the active org id: switching orgs
        // changes the key, which rebuilds the feed/stats/members providers so
        // they re-fetch against the newly selected org.
        child: KeyedSubtree(
          key: ValueKey(orgId),
          child: MultiProvider(
            providers: buildOrganizationShellProviders(orgId),
            child: HomeShell(
              refreshActivity: refreshActivityFeed,
              activityAccount: watchActivityAccount,
              membersTab: membersTab,
            ),
          ),
        ),
      ),
    };
    return shell;
  }

  /// Wraps [child] in the providers every authenticated shell needs, whatever
  /// its organization state.
  ///
  /// Everything here is user-, device- or account-scoped, so none of it sits
  /// under the org-keyed subtree: the org lifecycle view model manages the org
  /// list itself (switching orgs must not tear it down mid-action), Computer
  /// connect is device/user-scoped so its pairings must survive org switches,
  /// the selected tab must survive org switches too (a notification tap
  /// shouldn't be undone by a concurrent org change), and the account view
  /// models describe the person rather than the org — an org switch has no
  /// business re-fetching their API keys or 2FA state.
  ///
  /// The notification-tap binding sits here too, above the org-keyed subtree,
  /// so a tap is not lost when that subtree rebuilds. It sits inside Computer
  /// connect's scope so it can open a chat on the computer the push names;
  /// the scope remounts on an account change, which is safe because the
  /// pending tap lives in the coordinator and is re-read after the first frame.
  Widget _shell({
    required AuthViewModel auth,
    required List<HomeTab> tabs,
    required HomeTab landingTab,
    required Widget child,
  }) {
    return MultiProvider(
      providers: buildSharedShellProviders(),
      // Turn feedback is account-scoped, not organization-scoped.
      child: TurnFeedbackScope(
        apiClient: _apiClient,
        // Not a plain provider: the visible tab set changes when the user gains
        // or loses an organization, and the controller has to change with it.
        child: HomeTabControllerProvider(
          tabs: tabs,
          initialTab: landingTab,
          child: ComputerConnectScope(
            key: ValueKey(
              '${AppConfig.apiBaseUrl}:${auth.user?.id ?? 'guest'}',
            ),
            accountId: auth.user?.id,
            sessionToken: _sessionStore.currentToken,
            twoFactorProof: _sessionStore.currentTwoFactorProof,
            enabled: auth.hasAccount && AppConfig.hasAuthApiConfig,
            child: PushTapBinding(
              coordinator: _pushMessageCoordinator,
              child: DesktopAppPromptBinding(child: child),
            ),
          ),
        ),
      ),
    );
  }
}

/// Providers every authenticated shell needs, whatever its organization state.
///
/// Public so the shell, the capture harness and the widget tests all compose
/// the same list — a hand-copied duplicate would drift, and provider lookup is
/// resolved at runtime, so `flutter analyze` would not notice.
List<SingleChildWidget> buildSharedShellProviders() => [
  ChangeNotifierProvider<OrgViewModel>(
    create: (_) => OrgViewModel(repository: _buildOrgRepository()),
  ),
  ChangeNotifierProvider<ApiKeysViewModel>(
    create: (_) =>
        ApiKeysViewModel(repository: _buildApiKeysRepository())..load(),
  ),
  ChangeNotifierProvider<AuthSourcesViewModel>(
    create: (_) =>
        AuthSourcesViewModel(repository: _buildAuthSourcesRepository())..load(),
  ),
  ChangeNotifierProvider<ProfileViewModel>(
    create: (_) => ProfileViewModel(repository: _buildProfileRepository()),
  ),
  ChangeNotifierProvider<TwoFactorViewModel>(
    create: (_) => TwoFactorViewModel(
      repository: _buildTwoFactorRepository(),
      issuer: Brand.displayName,
    )..load(),
  ),
];

/// The extra provider the no-organization shell needs. Pending invitations are
/// user-scoped, so they resolve without an organization.
List<SingleChildWidget> buildNoOrganizationShellProviders() => [
  ChangeNotifierProvider<IncomingInvitationsViewModel>(
    create: (_) => IncomingInvitationsViewModel(
      repository: _buildIncomingInvitationsRepository(),
    )..load(),
  ),
];

/// Reloads Activity from the nearest [FeedViewModel]. [HomeShell] calls it
/// from inside the account-keyed providers below, so it reaches the feed of
/// the current account context.
void refreshActivityFeed(BuildContext context) =>
    context.read<FeedViewModel>().loadFeed();

/// Activity's account facts from the nearest [AuthViewModel]. [HomeShell]
/// calls it while Activity builds, so Activity follows the current account.
ActivityAccount watchActivityAccount(BuildContext context) {
  final auth = context.watch<AuthViewModel>();
  return (
    isPersonalActive: auth.isPersonalActive,
    organizationName: auth.activeOrganization?.name,
    viewPersonal: auth.personalOrganizationId == null
        ? null
        : () => unawaited(
            auth.selectWorkspaceContext(const WorkspaceContext.personal()),
          ),
  );
}

/// The Personal shell's providers: the Personal organization's Activity feed
/// when the account has one, plus the invitations the Members tab offers when
/// the account has no team. No team-only provider is mounted, so Personal
/// never calls a team-only endpoint.
List<SingleChildWidget> buildPersonalShellProviders(
  String? personalOrganizationId,
) => [
  if (personalOrganizationId != null)
    ChangeNotifierProvider<FeedViewModel>(
      create: (_) => FeedViewModel(
        repository: _buildPersonalFeedRepository(personalOrganizationId),
      )..loadFeed(),
    ),
  ...buildNoOrganizationShellProviders(),
];

/// The org-scoped providers. Only ever built with a resolved [orgId] in the
/// real app: the repository builders below fall back to `Mock*` when it is
/// null, and showing a real signed-in user sample data would be worse than
/// showing them nothing.
List<SingleChildWidget> buildOrganizationShellProviders(String? orgId) => [
  ChangeNotifierProvider<FeedViewModel>(
    create: (_) =>
        FeedViewModel(repository: _buildFeedRepository(orgId))..loadFeed(),
  ),
  ChangeNotifierProvider<StatsViewModel>(
    create: (_) =>
        StatsViewModel(repository: _buildStatsRepository(orgId))..loadUsage(),
  ),
  ChangeNotifierProvider<MembersViewModel>(
    create: (_) =>
        MembersViewModel(repository: _buildMembersRepository(orgId))..load(),
  ),
  // Lazy (no eager ..load): only the pushed Organization-settings screen reads
  // this, and it kicks off its own load on mount. No HomeShell tab touches it
  // at build, so it stays free until opened.
  ChangeNotifierProvider<OrgSettingsViewModel>(
    create: (_) =>
        OrgSettingsViewModel(repository: _buildOrgSettingsRepository(orgId)),
  ),
  // Lazy (no eager ..load): only the pushed Sub-teams screen reads this, and it
  // kicks off its own load on mount. No HomeShell tab touches it at build, so
  // it stays free until opened.
  ChangeNotifierProvider<SubTeamsViewModel>(
    create: (_) =>
        SubTeamsViewModel(repository: _buildSubTeamsRepository(orgId)),
  ),
];

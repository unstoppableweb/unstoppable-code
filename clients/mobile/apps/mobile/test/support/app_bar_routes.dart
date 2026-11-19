import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/feedback_report_repository.dart';
import 'package:mobile/data/repositories/notification_preferences_repository.dart';
import 'package:mobile/data/repositories/org_settings_repository.dart';
import 'package:mobile/data/repositories/sub_teams_repository.dart';
import 'package:mobile/data/repositories/member_detail_repository.dart';
import 'package:mobile/data/services/theme_preference_store.dart';
import 'package:mobile/data/services/usage_data_preference_store.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/theme_controller.dart';
import 'package:mobile/ui/core/usage_data_controller.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/settings/view_models/notifications_view_model.dart';
import 'package:mobile/ui/features/organizations/view_models/org_settings_view_model.dart';
import 'package:mobile/ui/features/sub_teams/view_models/sub_teams_view_model.dart';
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/data/repositories/auth_sources_repository.dart';
import 'package:mobile/data/repositories/two_factor_repository.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';
import 'package:mobile/ui/features/account/view_models/auth_sources_view_model.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:mobile/ui/features/account/views/api_keys_screen.dart';
import 'package:mobile/ui/features/account/views/login_methods_screen.dart';
import 'package:mobile/ui/features/account/views/two_factor_settings_screen.dart';
import 'package:mobile/ui/features/developer_options/views/settings_list_screen.dart';
import 'package:mobile/ui/features/organizations/views/org_settings_screen.dart';
import 'package:mobile/ui/features/sub_teams/views/sub_teams_screen.dart';
import 'package:mobile/ui/features/members/views/member_detail_screen.dart';
import 'package:mobile/ui/features/developer_options/views/developer_options_screen.dart';
import 'package:mobile/ui/features/developer_options/views/design_system_screen.dart';
import 'package:mobile/ui/features/developer_options/views/icons_screen.dart';
import 'package:mobile/ui/features/developer_options/views/icon_buttons_screen.dart';
import 'package:mobile/ui/features/developer_options/views/foundations_screen.dart';
import 'package:mobile/ui/features/developer_options/views/fonts_screen.dart';
import 'package:mobile/ui/features/developer_options/views/typography_screen.dart';
import 'package:mobile/ui/features/developer_options/views/code_markdown_screen.dart';
import 'package:mobile/ui/features/device_link/chats_screen.dart';
import 'package:mobile/ui/features/device_link/computer_connect/controller.dart';
import 'package:mobile/ui/features/device_link/computer_connect/search_screen.dart';

import 'device_chat_harness.dart';
import 'fake_attachment_picker.dart';
import 'fake_desktop_computer.dart';

/// A route's screen, or for a screen that reads a connected computer, the
/// async setup that builds it. [setUp] runs inside the capture test, so it can
/// register teardowns.
final class AppBarRoute {
  const AppBarRoute(Widget this.screen) : setUp = null;
  const AppBarRoute.setUp(
    Future<Widget> Function(WidgetTester tester) this.setUp,
  ) : screen = null;
  final Widget? screen;
  final Future<Widget> Function(WidgetTester tester)? setUp;
}

Map<String, AppBarRoute> appBarRoutes() => {
  for (final MapEntry(:key, :value) in _screens().entries)
    key: AppBarRoute(value),
  'search-chats': AppBarRoute.setUp((tester) async {
    final harness = buildDeviceChatHarness(
      computer: FakeDesktopComputer(answers: fakeInventoryAnswers()),
    );
    final controller = ComputerConnectController(harness.model);
    addTearDown(harness.dispose);
    addTearDown(controller.dispose);
    await harness.select(tester, 'chat-pkce');
    return DeviceChatSearchScreen(controller: controller);
  }),
  'computer-chat': AppBarRoute.setUp((tester) async {
    final harness = buildDeviceChatHarness();
    addTearDown(harness.dispose);
    await harness.select(tester, 'chat-pkce');
    return DeviceChatScreen(
      model: harness.model,
      attachmentPicker: FakeAttachmentPicker(),
    );
  }),
};

Map<String, Widget> _screens() => {
  'login-methods': const LoginMethodsScreen(),
  'two-factor': const TwoFactorSettingsScreen(),
  'api-keys': const ApiKeysScreen(),
  'organization-settings': const OrgSettingsScreen(),
  'sub-teams': const SubTeamsScreen(),
  'member-details': MemberDetailScreen(
    repository: MockMemberDetailRepository(latency: Duration.zero),
    member: const OrganizationMember(
      id: 'member-1',
      name: 'Sam Chen',
      email: 'sam@acme.dev',
      role: OrganizationRole.member,
      subTeamIds: [],
    ),
    canViewStats: true,
  ),
  'developer-options': const DeveloperOptionsScreen(),
  'design-system': const DesignSystemScreen(),
  'icons': const IconsScreen(),
  'icon-buttons': const IconButtonsScreen(),
  'colors': const ColorsScreen(),
  'corner-radii': const RadiiScreen(),
  'fonts': const FontsScreen(),
  'typography': const TypographyScreen(),
  'code-markdown': const CodeMarkdownScreen(),
  'settings-list': const SettingsListScreen(),
};

Widget appBarRouteHost({required Widget screen, required bool dark}) =>
    MultiProvider(
      providers: [
        ChangeNotifierProvider(
          create: (_) => AuthViewModel(
            repository: MockAuthRepository(latency: Duration.zero),
          ),
        ),
        ChangeNotifierProvider(
          create: (_) => ThemeController(store: InMemoryThemePreferenceStore()),
        ),
        ChangeNotifierProvider(
          create: (_) =>
              UsageDataController(store: InMemoryUsageDataPreferenceStore()),
        ),
        Provider<FeedbackReportRepository>(
          create: (_) => MockFeedbackReportRepository(latency: Duration.zero),
        ),
        ChangeNotifierProvider(
          create: (_) => NotificationsViewModel(
            repository: MockNotificationPreferencesRepository(
              latency: Duration.zero,
            ),
            isConfigured: () => true,
          )..load(),
        ),
        ChangeNotifierProvider(
          create: (_) => ApiKeysViewModel(
            repository: MockApiKeysRepository(latency: Duration.zero),
          )..load(),
        ),
        ChangeNotifierProvider(
          create: (_) => AuthSourcesViewModel(
            repository: MockAuthSourcesRepository(latency: Duration.zero),
          )..load(),
        ),
        ChangeNotifierProvider(
          create: (_) => TwoFactorViewModel(
            repository: MockTwoFactorRepository(latency: Duration.zero),
            issuer: 'Test',
          )..load(),
        ),
        ChangeNotifierProvider(
          create: (_) => OrgSettingsViewModel(
            repository: MockOrgSettingsRepository(latency: Duration.zero),
          ),
        ),
        ChangeNotifierProvider(
          create: (_) => SubTeamsViewModel(
            repository: MockSubTeamsRepository(latency: Duration.zero),
          ),
        ),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: dark ? AppTheme.dark : AppTheme.light,
        home: Scaffold(
          body: Builder(
            builder: (context) => Center(
              child: TextButton(
                onPressed: () => Navigator.of(
                  context,
                ).push(MaterialPageRoute<void>(builder: (_) => screen)),
                child: const Text('Open screen'),
              ),
            ),
          ),
        ),
      ),
    );

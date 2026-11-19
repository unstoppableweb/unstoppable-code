import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_section.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';
import 'package:mobile/ui/features/account/view_models/profile_view_model.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:mobile/ui/features/account/views/account_dialogs.dart';
import 'package:mobile/ui/features/account/views/account_profile_header.dart';
import 'package:mobile/ui/features/account/views/api_keys_screen.dart';
import 'package:mobile/ui/features/account/views/login_methods_screen.dart';
import 'package:mobile/ui/features/account/views/two_factor_settings_screen.dart';
import 'package:mobile/ui/features/account/views/usage_limits_row.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/developer_options/views/developer_options_screen.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/widgets/home_navigation_drawer.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/features/settings/views/app_settings_section.dart';
import 'package:mobile/ui/features/settings/views/help_settings_section.dart';
import 'package:mobile/ui/features/settings/views/widgets/app_version_footer.dart';
import 'package:provider/provider.dart';

/// Settings (CAN-4449): the signed-in user's profile and name editing, plan
/// usage, the organization pages moved out of the drawer (CAN-3558), account
/// security summaries that open their own screens, app settings, help, and
/// sign out, in grouped sections.
class AccountScreen extends StatelessWidget {
  const AccountScreen({super.key, this.showDeveloperOptions = !kReleaseMode});

  /// Override used by widget tests and deterministic visual captures.
  ///
  /// Production builds use the default and never expose internal tools.
  final bool showDeveloperOptions;

  static const _sectionGap = SizedBox(height: AppDimens.padding32);

  @override
  Widget build(BuildContext context) {
    final user = context.watch<AuthViewModel>().user;

    return CanopyScaffold(
      appBar: CanopyAppBar(
        leading: HomeMenuButton.maybeOf(context, designSystem: true),
        content: const Text('Settings'),
      ),
      body: Builder(
        builder: (context) => ListView(
          padding:
              CanopyScaffold.contentPaddingOf(context) +
              const EdgeInsets.all(AppDimens.padding16),
          children: [
            if (user != null) ...[
              AccountProfileHeader(
                name: user.name,
                email: user.email,
                onEdit: () => _editProfile(context, user.name),
              ),
              _sectionGap,
            ],
            // Both render nothing, gap included, when they have no content.
            const UsageLimitsRow(),
            const _OrganizationSection(),
            _AccountSection(email: user?.email),
            _sectionGap,
            const AppSettingsSection(),
            _sectionGap,
            const HelpSettingsSection(),
            _sectionGap,
            if (showDeveloperOptions) ...[
              CanopySettingsSection(
                heading: 'Developer',
                children: [
                  CanopySettingsRow(
                    key: const ValueKey('developer-options-button'),
                    glyph: CanopyGlyph.console,
                    title: 'Developer options',
                    trailing: const CanopySettingsChevron(),
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const DeveloperOptionsScreen(),
                      ),
                    ),
                  ),
                ],
              ),
              _sectionGap,
            ],
            CanopySettingsSection(
              children: [
                CanopySettingsRow.destructive(
                  glyph: CanopyGlyph.arrowBoxRight,
                  title: 'Sign out',
                  onTap: () =>
                      unawaited(context.read<AuthViewModel>().signOut()),
                ),
              ],
            ),
            const AppVersionFooter(),
          ],
        ),
      ),
    );
  }

  Future<void> _editProfile(BuildContext context, String currentName) async {
    final name = await promptForName(
      context,
      title: 'Edit name',
      label: 'Display name',
      hint: null,
      confirmLabel: 'Save',
      initial: currentName,
    );
    final trimmed = name?.trim();
    if (trimmed == null || trimmed.isEmpty || trimmed == currentName) return;
    if (!context.mounted) return;
    final profileVm = context.read<ProfileViewModel>();
    final authVm = context.read<AuthViewModel>();
    final result = await profileVm.updateName(trimmed);
    if (!context.mounted) return;
    if (result != null) {
      authVm.applyProfileName(result.name);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not update your name.')),
      );
    }
  }
}

/// Rows for the [settingsHomeTabs] this shell shows, so an account without an
/// organization still sees Members. Each row selects its shell destination,
/// which shows a back button to Settings.
///
/// Renders nothing outside the shell, where there is no [HomeTabController].
class _OrganizationSection extends StatelessWidget {
  const _OrganizationSection();

  @override
  Widget build(BuildContext context) {
    final shellTabs = context.select<HomeTabController?, List<HomeTab>>(
      (controller) => controller?.tabs ?? const [],
    );
    final tabs = [
      for (final tab in settingsHomeTabs)
        if (shellTabs.contains(tab)) tab,
    ];
    if (tabs.isEmpty) return const SizedBox.shrink();
    // Personal Activity is the viewer's own work, not an organization's.
    final personal = context.select<AuthViewModel?, bool>(
      (auth) => auth?.isPersonalActive ?? false,
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: AppDimens.padding32),
      child: CanopySettingsSection(
        heading: personal ? 'Personal' : 'Organization',
        children: [
          for (final tab in tabs)
            CanopySettingsRow(
              key: ValueKey('account-nav-${tab.name}'),
              glyph: HomeNavigationDrawer.glyphFor(tab),
              title: HomeNavigationDrawer.labelFor(tab),
              trailing: const CanopySettingsChevron(),
              onTap: () => context.read<HomeTabController>().select(tab),
            ),
        ],
      ),
    );
  }
}

/// Email, then summaries that open the login methods, two-factor and API key
/// screens. A value that is still loading shows a placeholder; one that
/// failed to load shows nothing until its screen retries.
class _AccountSection extends StatelessWidget {
  const _AccountSection({required this.email});

  final String? email;

  @override
  Widget build(BuildContext context) {
    final twoFactor = context.watch<TwoFactorViewModel>();
    final apiKeys = context.watch<ApiKeysViewModel>();
    final email = this.email;
    return CanopySettingsSection(
      heading: 'Account',
      children: [
        if (email != null)
          CanopySettingsRow(
            glyph: CanopyGlyph.email1,
            title: 'Email',
            value: CanopySettingsValue(email),
          ),
        CanopySettingsRow(
          glyph: CanopyGlyph.lock,
          title: 'Login methods',
          trailing: const CanopySettingsChevron(),
          onTap: () => LoginMethodsScreen.open(context),
        ),
        CanopySettingsRow(
          glyph: CanopyGlyph.shieldCheck,
          title: 'Two-factor authentication',
          value: twoFactor.isLoading
              ? const CanopySettingsValue.loading()
              : twoFactor.loadFailed
              ? null
              : CanopySettingsValue(twoFactor.enabled ? 'On' : 'Off'),
          trailing: const CanopySettingsChevron(),
          onTap: () => TwoFactorSettingsScreen.open(context),
        ),
        CanopySettingsRow(
          glyph: CanopyGlyph.codeBrackets,
          title: 'API keys',
          value: apiKeys.isLoading
              ? const CanopySettingsValue.loading()
              : apiKeys.error != null && apiKeys.keys.isEmpty
              ? null
              : CanopySettingsValue('${apiKeys.keys.length}'),
          trailing: const CanopySettingsChevron(),
          onTap: () => ApiKeysScreen.open(context),
        ),
      ],
    );
  }
}

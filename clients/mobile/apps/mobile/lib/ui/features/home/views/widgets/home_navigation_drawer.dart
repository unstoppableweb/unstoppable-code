import 'home_recent_chat_row.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';

/// Chat-style side navigation panel for the authenticated mobile app.
///
/// The brand title is the list's first row and scrolls with it. The optional
/// [contextRow] follows it, above the destination rows (CAN-4429). The list runs
/// edge to edge, under the status and navigation bars; a short scrim dims the
/// status bar strip so rows passing beneath it stay out of the way.
///
/// Rendered by [HomeShell] as the base layer of its slide-behind menu: the
/// panel is pinned underneath the main content, which slides aside to reveal
/// it. Closing happens by tapping or dragging the content card, so the panel
/// itself carries no close affordance.
///
/// [HomeTab.chat] and [HomeTab.account] never get a row. Their entry points
/// are pinned along the bottom edge above the list and stay put while the rows
/// scroll underneath: the Chat button on the left (CAN-2930) and the Settings
/// button, which opens Settings, on the right. The [settingsHomeTabs] get no
/// row either; Settings lists them (CAN-3558). Remote Control is the exception:
/// the shell includes its drawer row only while a session is paired.
///
/// Below the destination rows, and in the same scrolling list, a Recents
/// section lists [recentChats] (CAN-2931): chats from every connected
/// computer interwoven by activity, one line each, with a dot for chats that
/// are unread or waiting for an answer.
class HomeNavigationDrawer extends StatelessWidget {
  const HomeNavigationDrawer({
    required this.tabs,
    this.contextRow,
    this.extraDestination,
    required this.selectedTab,
    required this.onSelected,
    this.recentChats = const [],
    this.recentChatsNotice,
    this.onOpenChat,
    this.onNewChat,
    this.onOpenSettings,
    super.key,
  });

  final List<HomeTab> tabs;

  /// The workspace context control, between the wordmark and the destination
  /// rows (CAN-4429); null omits it.
  final Widget? contextRow;

  /// An app-composed destination row after the tab rows, such as
  /// [HomeNavigationDrawerRow] for Computer connect; null omits it.
  final Widget? extraDestination;

  /// The highlighted tab; null while [extraDestination] is showing instead.
  final HomeTab? selectedTab;
  final ValueChanged<HomeTab> onSelected;

  /// Recent chat history, newest first.
  final List<HomeRecentChat> recentChats;

  /// Inventory loading, failure, or context-specific empty feedback.
  final Widget? recentChatsNotice;

  /// Resumes the tapped chat.
  final ValueChanged<HomeRecentChat>? onOpenChat;

  /// Opens a new chat from the pinned Chat button; null hides the button.
  final VoidCallback? onNewChat;

  /// Opens Settings from the pinned Settings button; null hides the button.
  final VoidCallback? onOpenSettings;

  /// Gap between the pinned buttons and the drawer's side and bottom safe
  /// edges.
  static const double _pinnedInset = 32;

  /// Height of the pinned button row; both buttons clear the 44px touch-target
  /// floor, like `CanopyButton`.
  static const double _pinnedHeight = 48;

  bool get _hasPinnedRow => onNewChat != null || onOpenSettings != null;

  /// Destinations reached from the pinned row, or from Settings, instead of a
  /// list row.
  static bool _hasNoRow(HomeTab tab) =>
      tab == HomeTab.chat ||
      tab == HomeTab.account ||
      (settingsHomeTabs.contains(tab) && tab != HomeTab.remote);

  /// Shared with the shell behind the rounded content card, so its exposed
  /// corners blend into the menu even beyond the panel's bounds.
  static Color backgroundColorOf(BuildContext context) {
    final theme = Theme.of(context);
    return theme.brightness == Brightness.dark
        ? Colors.black
        : theme.colorScheme.surface;
  }

  /// How far the top scrim reaches past the status bar, just enough to ease
  /// rows into the dimmed strip instead of cutting them off at its edge.
  static const double _topScrimOverhang = 16;

  @override
  Widget build(BuildContext context) {
    final background = backgroundColorOf(context);
    final insets = MediaQuery.paddingOf(context);
    return Material(
      key: const ValueKey('home-navigation-drawer'),
      // Pure black in dark mode, like the reference, so the panel reads as
      // the lowest layer under the tinted content card.
      color: background,
      // Rows scroll edge to edge, under the status and navigation bars; the
      // list pads its content by those insets instead.
      child: SafeArea(
        top: false,
        right: false,
        bottom: false,
        child: Stack(
          children: [
            Positioned.fill(
              // Ink from the selected row paints on the nearest Material,
              // so this one keeps it clipped to the scrolling list.
              child: Material(
                type: MaterialType.transparency,
                clipBehavior: Clip.hardEdge,
                child: _buildRows(context, insets),
              ),
            ),
            if (insets.top > 0)
              // Dims rows as they scroll under the status bar.
              Positioned(
                key: const ValueKey('home-navigation-drawer-top-scrim'),
                left: 0,
                right: 0,
                top: 0,
                height: insets.top + _topScrimOverhang,
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [background, background.withValues(alpha: 0)],
                      ),
                    ),
                  ),
                ),
              ),
            if (_hasPinnedRow) ...[
              // Fades rows out as they scroll under the pinned buttons and
              // the navigation bar below them.
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                height: _pinnedHeight + _pinnedInset * 2 + insets.bottom,
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [background.withValues(alpha: 0), background],
                      ),
                    ),
                  ),
                ),
              ),
              Positioned(
                left: _pinnedInset,
                right: _pinnedInset,
                bottom: _pinnedInset + insets.bottom,
                child: Row(
                  children: [
                    if (onNewChat case final onNewChat?)
                      _NewChatButton(onPressed: onNewChat),
                    const Spacer(),
                    if (onOpenSettings case final onOpenSettings?)
                      _SettingsButton(onPressed: onOpenSettings),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildRows(BuildContext context, EdgeInsets insets) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    return ListView(
      // Starts below the status bar, and leaves room for the last row to
      // scroll clear of the pinned buttons and the navigation bar.
      padding: EdgeInsets.fromLTRB(
        8,
        insets.top,
        8,
        insets.bottom + (_hasPinnedRow ? _pinnedHeight + _pinnedInset * 2 : 16),
      ),
      children: [
        // The brand title is the first row, so it scrolls away with the list.
        Padding(
          key: const ValueKey('home-navigation-brand'),
          padding: const EdgeInsets.fromLTRB(12, 16, 12, 24),
          child: switch (Brand.wordmarkSvg) {
            final wordmark? => Align(
              alignment: AlignmentDirectional.centerStart,
              child: SvgPicture.string(
                wordmark,
                height: 36,
                semanticsLabel: Brand.shortName,
                colorFilter: ColorFilter.mode(
                  colorScheme.onSurface,
                  BlendMode.srcIn,
                ),
              ),
            ),
            null => Text(
              Brand.shortName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.titleLarge?.copyWith(
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
            ),
          },
        ),
        ?contextRow,
        for (final tab in tabs)
          if (!_hasNoRow(tab))
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: HomeNavigationDrawerRow(
                key: ValueKey('home-nav-${tab.name}'),
                glyph: glyphFor(tab),
                label: labelFor(tab),
                selected: tab == selectedTab,
                onTap: () => onSelected(tab),
              ),
            ),
        if (extraDestination case final extraDestination?)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: extraDestination,
          ),
        if (recentChats.isNotEmpty || recentChatsNotice != null) ...[
          Padding(
            key: const ValueKey('home-recents-header'),
            padding: const EdgeInsets.fromLTRB(16, 24, 16, 8),
            child: Text(
              'Recents',
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                fontWeight: AppTypography.emphasisWeight,
                fontVariations: AppTypography.emphasisVariations,
              ),
            ),
          ),
          ?recentChatsNotice,
          for (final entry in recentChats)
            HomeRecentChatRow(
              key: ValueKey('home-recent-${entry.key}'),
              entry: entry,
              onTap: onOpenChat == null ? null : () => onOpenChat!(entry),
            ),
        ],
      ],
    );
  }

  /// The destination's name, shared with Settings' rows for the
  /// [settingsHomeTabs].
  static String labelFor(HomeTab tab) => switch (tab) {
    HomeTab.activity => 'Timeline',
    HomeTab.usage => 'Usage',
    HomeTab.members => 'Members',
    HomeTab.advisor => 'Orchestrator',
    HomeTab.remote => 'Remote control',
    HomeTab.account => 'Settings',
    HomeTab.chat => 'Chat',
  };

  /// The destination's glyph, shared with Settings' rows for the
  /// [settingsHomeTabs].
  static CanopyGlyph glyphFor(HomeTab tab) => switch (tab) {
    HomeTab.activity => CanopyGlyph.electrocardiogram,
    HomeTab.usage => CanopyGlyph.stackedBarChart,
    HomeTab.members => CanopyGlyph.userGroup,
    HomeTab.advisor => CanopyGlyph.orbit,
    HomeTab.remote => CanopyGlyph.globe2,
    HomeTab.account => CanopyGlyph.settingsGear2,
    HomeTab.chat => CanopyGlyph.editBig,
  };
}

/// One destination row in the drawer: a design-system glyph, an emphasized
/// label and, optionally, a secondary line such as the connected computer.
class HomeNavigationDrawerRow extends StatelessWidget {
  const HomeNavigationDrawerRow({
    required this.glyph,
    required this.label,
    required this.selected,
    required this.onTap,
    this.subtitle,
    super.key,
  });

  final CanopyGlyph glyph;
  final String label;
  final String? subtitle;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return ListTile(
      // Tinted explicitly: an untinted glyph paints black, which vanishes
      // on the dark drawer.
      leading: CanopyIcon(
        glyph: glyph,
        tint: selected ? colorScheme.onSurface : colorScheme.onSurfaceVariant,
      ),
      selected: selected,
      selectedTileColor: colorScheme.surfaceContainerHighest,
      selectedColor: colorScheme.onSurface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      title: Text(
        label,
        style: const TextStyle(
          fontWeight: AppTypography.emphasisWeight,
          fontVariations: AppTypography.emphasisVariations,
        ),
      ),
      subtitle: subtitle == null
          ? null
          : Text(
              subtitle!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colorScheme.onSurfaceVariant,
              ),
            ),
      onTap: onTap,
    );
  }
}

/// The drawer's pinned new-chat action, using the shared primary-action colors.
class _NewChatButton extends StatelessWidget {
  const _NewChatButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final label = HomeNavigationDrawer.labelFor(HomeTab.chat);
    // One node named for the action; it carries the tap itself because
    // excluding the children also drops the InkWell's semantic action.
    return Semantics(
      button: true,
      label: 'New chat',
      onTap: onPressed,
      excludeSemantics: true,
      child: Material(
        key: const ValueKey('home-new-chat-button'),
        color: colors.accent,
        shape: const StadiumBorder(),
        elevation: 2,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onPressed,
          child: SizedBox(
            height: HomeNavigationDrawer._pinnedHeight,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  CanopyIcon(
                    glyph: CanopyGlyph.editBig,
                    size: 20,
                    tint: colors.onAccent,
                  ),
                  const SizedBox(width: 8),
                  Text(
                    label,
                    style: AppTypography.title.copyWith(color: colors.onAccent),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The drawer's pinned Settings button opens [HomeTab.account].
class _SettingsButton extends StatelessWidget {
  const _SettingsButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Tooltip(
      message: 'Settings',
      child: Material(
        key: const ValueKey('home-settings-button'),
        color: colors.surfaceRaised,
        shape: CircleBorder(side: BorderSide(color: colors.border)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onPressed,
          child: SizedBox.square(
            dimension: HomeNavigationDrawer._pinnedHeight,
            child: Center(
              child: CanopyIcon(
                glyph: CanopyGlyph.settingsGear2,
                tint: colors.foreground,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

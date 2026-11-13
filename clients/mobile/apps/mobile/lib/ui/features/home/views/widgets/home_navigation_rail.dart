import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/overlay-action/canopy_overlay_action.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'home_navigation_drawer.dart';

class HomeNavigationRail extends StatelessWidget {
  const HomeNavigationRail({
    super.key,
    required this.tabs,
    required this.selectedTab,
    required this.onSelected,
    required this.listVisible,
    required this.onToggleList,
    required this.onSearch,
    this.onNewChat,
    this.extraLabel,
    this.onExtra,
    this.extraSelected = false,
  });
  final List<HomeTab> tabs;
  final HomeTab? selectedTab;
  final ValueChanged<HomeTab> onSelected;
  final bool listVisible, extraSelected;
  final VoidCallback onToggleList, onSearch;
  final VoidCallback? onNewChat, onExtra;
  final String? extraLabel;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final destinations = [
      if (tabs.contains(HomeTab.chat)) HomeTab.chat,
      if (tabs.contains(HomeTab.advisor)) HomeTab.advisor,
      if (tabs.contains(HomeTab.remote)) HomeTab.remote,
      if (tabs.contains(HomeTab.usage)) HomeTab.usage,
      if (tabs.contains(HomeTab.account)) HomeTab.account,
    ];
    Widget action(
      CanopyGlyph glyph,
      String label,
      VoidCallback? press, {
      bool selected = false,
    }) => Semantics(
      selected: selected,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: selected ? colors.background : null,
          borderRadius: BorderRadius.circular(24),
        ),
        child: CanopyIconButton(
          shape: CanopyIconButtonShape.circular,
          glyph: glyph,
          tooltip: label,
          onPressed: press,
          tint: selected ? colors.foreground : colors.foregroundSecondary,
        ),
      ),
    );
    return Material(
      key: const ValueKey('home-adaptive-rail'),
      color: colors.background,
      child: LayoutBuilder(
        builder: (context, constraints) => SingleChildScrollView(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              minHeight: math.max(0, constraints.maxHeight),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      CanopyOverlayAction(
                        glyph: CanopyGlyph.sidebar,
                        label: listVisible ? 'Hide chats' : 'Show chats',
                        onPressed: onToggleList,
                      ),
                      const SizedBox(height: 8),
                      if (onNewChat case final onNewChat?) ...[
                        CanopyOverlayAction(
                          glyph: CanopyGlyph.editBig,
                          label: 'New chat',
                          onPressed: onNewChat,
                        ),
                        const SizedBox(height: 8),
                      ],
                      CanopyOverlayAction(
                        glyph: CanopyGlyph.magnifyingGlass,
                        label: 'Search chats',
                        onPressed: onSearch,
                      ),
                    ],
                  ),
                  Padding(
                    padding: const EdgeInsets.only(top: 24),
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: colors.surfaceRaised,
                        borderRadius: BorderRadius.circular(28),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            for (final tab in destinations) ...[
                              action(
                                tab == HomeTab.chat
                                    ? CanopyGlyph.bubbleText
                                    : HomeNavigationDrawer.glyphFor(tab),
                                tab == HomeTab.chat
                                    ? 'Chats'
                                    : HomeNavigationDrawer.labelFor(tab),
                                () => onSelected(tab),
                                selected: !extraSelected && selectedTab == tab,
                              ),
                              if (tab == HomeTab.chat && onExtra != null)
                                action(
                                  CanopyGlyph.macbook,
                                  extraLabel!,
                                  onExtra,
                                  selected: extraSelected,
                                ),
                            ],
                            if (!destinations.contains(HomeTab.chat) &&
                                onExtra != null)
                              action(
                                CanopyGlyph.macbook,
                                extraLabel!,
                                onExtra,
                                selected: extraSelected,
                              ),
                          ],
                        ),
                      ),
                    ),
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

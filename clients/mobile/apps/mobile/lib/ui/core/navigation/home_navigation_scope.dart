import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';

import 'home_back_handlers.dart';

/// Makes the authenticated shell's drawer available to nested top-level
/// screens, even though each screen owns its own [Scaffold] and [AppBar].
class HomeNavigationScope extends InheritedWidget {
  const HomeNavigationScope({
    required this.openDrawer,
    required super.child,
    this.goBack,
    this.backHandlers,
    this.contentVisible = true,
    super.key,
  });

  final VoidCallback openDrawer;
  final HomeBackHandlers? backHandlers;

  /// False while the shell's navigation menu obscures its content.
  final bool contentVisible;

  /// Set for a destination opened from another one, such as an organization
  /// page opened from Settings (CAN-3558); [HomeMenuButton] then goes back instead
  /// of opening the drawer.
  final VoidCallback? goBack;

  static HomeNavigationScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<HomeNavigationScope>();

  @override
  bool updateShouldNotify(HomeNavigationScope oldWidget) =>
      openDrawer != oldWidget.openDrawer ||
      goBack != oldWidget.goBack ||
      contentVisible != oldWidget.contentVisible ||
      backHandlers != oldWidget.backHandlers;
}

/// The leading app-bar affordance shown only when a screen is mounted in the
/// authenticated drawer shell. Standalone screen routes keep their normal
/// back button behavior.
///
/// A destination with [HomeNavigationScope.goBack] gets a back button instead;
/// the drawer stays one edge swipe away.
class HomeMenuButton extends StatelessWidget {
  const HomeMenuButton({super.key, this.designSystem = false});

  final bool designSystem;

  /// Returns a menu button inside [HomeNavigationScope], otherwise `null` so
  /// independently mounted screens do not reserve empty leading space.
  static Widget? maybeOf(BuildContext context, {bool designSystem = false}) =>
      HomeNavigationScope.maybeOf(context) == null ||
          ModalRoute.isFirstOf(context) == false ||
          (HomeRailPresentation.of(context) &&
              HomeNavigationScope.maybeOf(context)?.goBack == null)
      ? null
      : HomeMenuButton(designSystem: designSystem);

  @override
  Widget build(BuildContext context) {
    final scope = HomeNavigationScope.maybeOf(context);
    assert(scope != null, 'HomeMenuButton requires HomeNavigationScope');
    if (scope?.goBack case final goBack?) {
      final tooltip = MaterialLocalizations.of(context).backButtonTooltip;
      return designSystem
          ? CanopyIconButton(
              key: const ValueKey('home-back-button'),
              glyph: CanopyGlyph.arrowLeft,
              tooltip: tooltip,
              onPressed: goBack,
            )
          : IconButton(
              key: const ValueKey('home-back-button'),
              icon: const BackButtonIcon(),
              tooltip: tooltip,
              onPressed: goBack,
            );
    }
    if (designSystem) {
      return CanopyIconButton(
        key: const ValueKey('home-menu-button'),
        glyph: CanopyGlyph.barsThree,
        tooltip: 'Open navigation menu',
        onPressed: scope?.openDrawer,
      );
    }
    return IconButton(
      key: const ValueKey('home-menu-button'),
      icon: const Icon(Icons.menu),
      tooltip: 'Open navigation menu',
      onPressed: scope?.openDrawer,
    );
  }
}

/// The shell already exposes navigation beside the content in this layout.
class HomeRailPresentation extends InheritedWidget {
  const HomeRailPresentation({super.key, required super.child});
  static bool of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<HomeRailPresentation>() !=
      null;
  @override
  bool updateShouldNotify(HomeRailPresentation oldWidget) => false;
}

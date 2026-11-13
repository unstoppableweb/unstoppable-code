import 'package:flutter/widgets.dart';
import '../app_route_observer.dart';
import 'home_navigation_scope.dart';

/// Route-aware screens subscribe to their nearest navigator, with the root
/// observer retained for screens outside the authenticated detail pane.
class AppRouteScope extends InheritedWidget {
  const AppRouteScope({
    super.key,
    required this.observer,
    required this.parentIsCurrent,
    required super.child,
  });
  final RouteObserver<ModalRoute<Object?>> observer;
  final bool parentIsCurrent;
  static RouteObserver<ModalRoute<Object?>> of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppRouteScope>()?.observer ??
      appRouteObserver;
  static bool isCurrentOf(BuildContext context) =>
      (context
              .dependOnInheritedWidgetOfExactType<AppRouteScope>()
              ?.parentIsCurrent ??
          true) &&
      (ModalRoute.isCurrentOf(context) ?? true) &&
      HomeDetailVisibility.of(context) &&
      (HomeNavigationScope.maybeOf(context)?.contentVisible ?? true);
  @override
  bool updateShouldNotify(AppRouteScope oldWidget) =>
      observer != oldWidget.observer ||
      parentIsCurrent != oldWidget.parentIsCurrent;
}

/// Hidden compact panes retain drafts without acknowledging unseen messages.
class HomeDetailVisibility extends InheritedWidget {
  const HomeDetailVisibility({
    super.key,
    required this.visible,
    required super.child,
  });
  final bool visible;
  static bool of(BuildContext context) =>
      context
          .dependOnInheritedWidgetOfExactType<HomeDetailVisibility>()
          ?.visible ??
      true;
  @override
  bool updateShouldNotify(HomeDetailVisibility oldWidget) =>
      visible != oldWidget.visible;
}

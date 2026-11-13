import 'package:flutter/material.dart';
import 'app_route_scope.dart';

/// One navigator for the selected content, retained across compact and split
/// layouts. The outer shell owns navigation chrome, not the detail routes.
class HomeDetailPane extends StatefulWidget {
  const HomeDetailPane({
    super.key,
    required this.child,
    required this.onCanPopChanged,
  });
  final ValueChanged<bool> onCanPopChanged;
  final Widget child;

  @override
  State<HomeDetailPane> createState() => HomeDetailPaneState();
}

class HomeDetailPaneState extends State<HomeDetailPane> {
  final navigator = GlobalKey<NavigatorState>();
  late final _routes = _DetailRoutes(() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        widget.onCanPopChanged(navigator.currentState?.canPop() ?? false);
      }
    });
  });

  /// Replace nested detail without an exit animation. Wait only for widget
  /// disposal so outgoing visibility cleanup cannot hide the new chat.
  Future<void> reset() async {
    final pending = _routes.pendingDisposals;
    // Selecting another destination replaces detail, rather than animating
    // through the screens underneath its outgoing routes.
    for (final route in _routes.activeDetails.reversed) {
      navigator.currentState?.removeRoute(route);
    }
    if (pending.isEmpty) return;
    await Future.wait(pending);
    await WidgetsBinding.instance.endOfFrame;
  }

  @override
  Widget build(BuildContext context) => _RootContent(
    content: widget.child,
    child: AppRouteScope(
      observer: _routes,
      parentIsCurrent: ModalRoute.isCurrentOf(context) ?? true,
      child: Navigator(
        key: navigator,
        observers: [_routes],
        onGenerateRoute: (_) => MaterialPageRoute<void>(
          builder: (context) => context
              .dependOnInheritedWidgetOfExactType<_RootContent>()!
              .content,
        ),
      ),
    ),
  );
}

class _RootContent extends InheritedWidget {
  const _RootContent({required this.content, required super.child});
  final Widget content;
  @override
  bool updateShouldNotify(_RootContent oldWidget) =>
      content != oldWidget.content;
}

/// Keeps retiring routes until their overlays have finished disposing too.
class _DetailRoutes extends RouteObserver<ModalRoute<Object?>> {
  _DetailRoutes(this.onChanged);
  final VoidCallback onChanged;
  final _tracked = <Route<dynamic>, Future<void>>{};
  Route<dynamic>? _root;

  List<Future<void>> get pendingDisposals => [
    for (final entry in _tracked.entries)
      if (entry.key != _root) entry.value,
  ];

  List<Route<dynamic>> get activeDetails => [
    for (final route in _tracked.keys)
      if (route != _root && route.isActive) route,
  ];

  void _track(Route<dynamic> route) {
    final completion = route is TransitionRoute<dynamic>
        ? route.completed
        : route.popped;
    _tracked[route] = completion.then((_) {
      _tracked.remove(route);
    });
  }

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _root ??= route;
    _track(route);
    super.didPush(route, previousRoute);
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    if (oldRoute == _root) _root = newRoute;
    if (newRoute != null) _track(newRoute);
    super.didReplace(newRoute: newRoute, oldRoute: oldRoute);
  }

  @override
  void didChangeTop(Route<dynamic> topRoute, Route<dynamic>? previousTopRoute) {
    super.didChangeTop(topRoute, previousTopRoute);
    onChanged();
  }
}

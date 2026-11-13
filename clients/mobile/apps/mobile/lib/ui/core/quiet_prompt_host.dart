import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile/ui/core/navigation/app_route_scope.dart';

/// Wraps a chat body and presents a one-off prompt only when [isDue] AND the
/// chat is [isQuiet] (idle, no error surface, no pending question, visible
/// tab) AND its route is on top AND the app is in the foreground. Every
/// condition is re-checked after [settleDelay] so a prompt never lands on top
/// of something that just happened.
///
/// [source] notifies when [isDue] may have changed; null renders the child
/// alone, so screens whose prompt controller is not provided need no setup.
class QuietPromptHost extends StatefulWidget {
  const QuietPromptHost({
    super.key,
    required this.source,
    required this.isDue,
    required this.present,
    required this.isQuiet,
    required this.child,
    this.settleDelay = const Duration(milliseconds: 1500),
  });

  final Listenable? source;
  final bool Function() isDue;
  final void Function(BuildContext context) present;
  final bool isQuiet;
  final Widget child;
  final Duration settleDelay;

  @override
  State<QuietPromptHost> createState() => _QuietPromptHostState();
}

class _QuietPromptHostState extends State<QuietPromptHost>
    with WidgetsBindingObserver {
  Timer? _timer;
  bool _routeIsCurrent = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.source?.addListener(_evaluate);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Includes the outer route and retained pane, not just the nearest
    // navigator's top route. Visibility changes cancel or restart settling.
    _routeIsCurrent = AppRouteScope.isCurrentOf(context);
    _evaluate();
  }

  @override
  void didUpdateWidget(QuietPromptHost oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.source, widget.source)) {
      oldWidget.source?.removeListener(_evaluate);
      widget.source?.addListener(_evaluate);
    }
    _evaluate();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => _evaluate();

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.source?.removeListener(_evaluate);
    _timer?.cancel();
    super.dispose();
  }

  bool get _isForeground {
    final state = WidgetsBinding.instance.lifecycleState;
    return state == null || state == AppLifecycleState.resumed;
  }

  bool get _canPresent =>
      mounted &&
      widget.source != null &&
      widget.isDue() &&
      widget.isQuiet &&
      _routeIsCurrent &&
      _isForeground;

  void _evaluate() {
    if (!_canPresent) {
      _timer?.cancel();
      _timer = null;
      return;
    }
    _timer ??= Timer(widget.settleDelay, _fire);
  }

  void _fire() {
    _timer = null;
    if (!_canPresent) return;
    widget.present(context);
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

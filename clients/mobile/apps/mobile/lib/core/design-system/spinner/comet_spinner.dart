import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// Flutter port of the shared desktop/web `CometSpinner`
/// (`packages/ui-shared/src/primitives/CometSpinner.tsx` and the
/// `.canopy-comet-*` rules in `canopy-tokens-core.css`): a ring whose ink
/// fades in toward a round head, turning clockwise once every 1.2s. Desktop
/// and web draw their thinking, loading, and run spinners as this ring, so
/// the wrappers below differ only in their accessible name.
class CometSpinner extends StatefulWidget {
  const CometSpinner({
    super.key,
    required this.semanticsLabel,
    this.size = 12,
    this.color,
  });

  final String semanticsLabel;

  /// Width and height of the ring.
  final double size;

  /// Ink of the ring. Defaults to the primary foreground, the ink desktop's
  /// comet uses for activity in place of the brand accent.
  final Color? color;

  @override
  State<CometSpinner> createState() => _CometSpinnerState();
}

/// Convenience wrapper matching desktop's `ThinkingSpinner`.
class ThinkingSpinner extends StatelessWidget {
  const ThinkingSpinner({super.key, this.size = 12, this.color});

  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) =>
      CometSpinner(semanticsLabel: 'Thinking', size: size, color: color);
}

/// Convenience wrapper matching desktop's `LoadingSpinner`.
class LoadingSpinner extends StatelessWidget {
  const LoadingSpinner({super.key, this.size = 12, this.color});

  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) =>
      CometSpinner(semanticsLabel: 'Loading', size: size, color: color);
}

/// Convenience wrapper matching desktop's `RunSpinner`.
class RunSpinner extends StatelessWidget {
  const RunSpinner({super.key, this.size = 12, this.color});

  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) =>
      CometSpinner(semanticsLabel: 'Running', size: size, color: color);
}

class _CometSpinnerState extends State<CometSpinner>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Under reduce-motion the ring holds still, as on desktop. (This also
    // lets widget tests pumpAndSettle over always-on spinners.) Only re-sync
    // when the setting changed: repeat() resets the phase, so an
    // unconditional call would visibly restart every spinner on any
    // inherited-widget change.
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (reduceMotion) {
      _controller.stop();
    } else if (!_controller.isAnimating) {
      _controller.repeat();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.color ?? AppColors.of(context).foreground;
    // The bare CustomPaint carries no accessibility information, unlike the
    // Material progress indicators it replaces, so name it explicitly.
    return Semantics(
      label: widget.semanticsLabel,
      child: SizedBox(
        width: widget.size,
        height: widget.size,
        // An always-on spinner repaints every frame. Without its own layer
        // that repaint dirties the enclosing list and, through it, the
        // blurred app bar over it, so an idle screen with one working row
        // re-rasterized the whole viewport at full frame rate.
        child: RepaintBoundary(
          child: CustomPaint(
            painter: _CometPainter(turn: _controller, color: color),
          ),
        ),
      ),
    );
  }
}

class _CometPainter extends CustomPainter {
  _CometPainter({required this.turn, required this.color})
    : super(repaint: turn);

  final Animation<double> turn;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final side = size.shortestSide;
    // Desktop: `max(1.5px, size * 0.12)`.
    final stroke = math.max(1.5, side * 0.12);
    final center = Offset(side / 2, side / 2);
    final radius = (side - stroke) / 2;

    canvas
      ..translate(center.dx, center.dy)
      ..rotate(turn.value * 2 * math.pi);

    // The tail: a sweep from clear at the top, clockwise, to full ink back at
    // the top, where the head sits. SweepGradient starts at 3 o'clock, so it
    // is turned a quarter back. The clear stop keeps the ring's own hue so the
    // fade never passes through black.
    final ring = Rect.fromCircle(center: Offset.zero, radius: radius);
    final tail = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..shader = SweepGradient(
        colors: [color.withValues(alpha: 0), color],
        transform: const GradientRotation(-math.pi / 2),
      ).createShader(ring);
    canvas.drawCircle(Offset.zero, radius, tail);

    canvas.drawCircle(Offset(0, -radius), stroke / 2, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_CometPainter oldDelegate) =>
      oldDelegate.turn != turn || oldDelegate.color != color;
}

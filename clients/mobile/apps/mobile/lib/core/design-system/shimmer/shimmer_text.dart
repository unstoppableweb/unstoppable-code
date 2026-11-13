import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';

/// Flutter port of the desktop clean chat look's live-step shimmer
/// (`.canopy-text-shimmer-strong` in `canopy-tokens-core.css`): the words
/// rest in quaternary ink and a soft primary-ink band sweeps across them in
/// one continuous linear pass. The gradient is a seamless tile twice the
/// child's width that moves exactly one tile per cycle, so the loop never
/// restarts visibly. With reduced motion the child draws in its own colors.
class Shimmer extends StatefulWidget {
  const Shimmer({super.key, required this.child});

  /// Text to paint through the sweep; its own colors are replaced.
  final Widget child;

  /// One sweep, matching `canopy-text-shimmer-strong` (2.4s).
  static const Duration cycle = Duration(milliseconds: 2400);

  @override
  State<Shimmer> createState() => _ShimmerState();
}

class _ShimmerState extends State<Shimmer> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: Shimmer.cycle,
  );

  bool _still = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _still = MediaQuery.disableAnimationsOf(context);
    if (_still) {
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
    if (_still) return widget.child;
    final base = StatusColors.of(context).quaternary;
    final band = AppColors.of(context).foreground;
    // `color-mix(in oklab, base N%, band)` approximated in sRGB.
    final soft = Color.lerp(band, base, 0.75)!;
    final mid = Color.lerp(band, base, 0.3)!;
    final colors = [base, base, soft, mid, band, mid, soft, base, base];
    const stops = [0.0, 0.22, 0.32, 0.42, 0.5, 0.58, 0.68, 0.78, 1.0];
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, child) => ShaderMask(
          blendMode: BlendMode.srcIn,
          shaderCallback: (bounds) {
            final tile = bounds.width * 2;
            // CSS `background-position` 200% → 0% over a 200%-wide tile:
            // the band travels left to right by one tile per cycle.
            final left = -tile * (1 - _controller.value);
            return LinearGradient(
              colors: colors,
              stops: stops,
              tileMode: TileMode.repeated,
            ).createShader(Rect.fromLTWH(left, 0, tile, bounds.height));
          },
          child: child,
        ),
        child: widget.child,
      ),
    );
  }
}

/// Shimmering status words ("Thinking"). With reduced motion they read in
/// plain secondary ink, as on desktop.
class ShimmerText extends StatelessWidget {
  const ShimmerText(this.text, {super.key, this.style});

  final String text;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => Shimmer(
    child: Text(
      text,
      style: (style ?? const TextStyle()).copyWith(
        color: AppColors.of(context).foregroundSecondary,
      ),
    ),
  );
}

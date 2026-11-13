import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';

import '../icon/canopy_glyph.dart';
import '../icon/canopy_icon.dart';

/// Visual control sizes; both retain a 48px mobile touch target.
enum CanopyIconButtonSize {
  small(32, 20),
  medium(40, 24);

  const CanopyIconButtonSize(this.dimension, this.glyphSize);

  final double dimension;
  final double glyphSize;
}

/// Keep interaction feedback aligned with the surrounding control chrome.
enum CanopyIconButtonShape { rounded, circular }

/// Transparent glyph action with a rounded, bounded Material ripple.
///
/// [tooltip] also supplies the accessible action label. A null [onPressed]
/// disables the button. Defaults to [CanopyIconButtonSize.medium].
///
/// Use [CanopyIconButton.custom] for a glyph outside the CanopyGlyph catalog
/// (e.g. the desktop-ported chat feedback thumbs); the control keeps the same
/// chrome, sizing, and disabled tint.
class CanopyIconButton extends StatelessWidget {
  const CanopyIconButton({
    super.key,
    required CanopyGlyph this.glyph,
    required this.tooltip,
    required this.onPressed,
    this.size = CanopyIconButtonSize.medium,
    this.shape = CanopyIconButtonShape.rounded,
    this.compactTouchTarget = false,
    this.tint,
    this.glyphSize,
  }) : iconBuilder = null;

  const CanopyIconButton.custom({
    super.key,
    required Widget Function(Color tint, double size) this.iconBuilder,
    required this.tooltip,
    required this.onPressed,
    this.size = CanopyIconButtonSize.medium,
    this.shape = CanopyIconButtonShape.rounded,
    this.compactTouchTarget = false,
    this.tint,
    this.glyphSize,
  }) : glyph = null;

  final CanopyGlyph? glyph;

  /// Builds a non-catalog glyph at the resolved tint and size.
  final Widget Function(Color tint, double size)? iconBuilder;
  final String tooltip;
  final VoidCallback? onPressed;
  final CanopyIconButtonSize size;
  final CanopyIconButtonShape shape;

  /// Opt into a touch target matching the visual size for compact toolbars.
  final bool compactTouchTarget;
  final Color? tint;

  /// Optional glyph-only override; control and touch-target sizes stay intact.
  final double? glyphSize;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final enabled = onPressed != null;

    // Own the ink surface so the ripple is visible even on an opaque parent.
    return Material(
      type: MaterialType.transparency,
      child: IconButton(
        tooltip: tooltip,
        onPressed: onPressed,
        style: IconButton.styleFrom(
          backgroundColor: Colors.transparent,
          disabledBackgroundColor: Colors.transparent,
          foregroundColor: tint ?? colors.foregroundSecondary,
          disabledForegroundColor: colors.disabledTint,
          highlightColor: colors.foreground.withValues(alpha: 0.12),
          hoverColor: colors.foreground.withValues(alpha: 0.08),
          focusColor: colors.focus.withValues(alpha: 0.16),
          padding: EdgeInsets.zero,
          minimumSize: Size.square(size.dimension),
          fixedSize: Size.square(size.dimension),
          tapTargetSize: compactTouchTarget
              ? MaterialTapTargetSize.shrinkWrap
              : MaterialTapTargetSize.padded,
          visualDensity: VisualDensity.standard,
          shape: switch (shape) {
            CanopyIconButtonShape.rounded => RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppRadii.md),
            ),
            CanopyIconButtonShape.circular => const CircleBorder(),
          },
        ).copyWith(splashFactory: InkRipple.splashFactory),
        icon: switch ((glyph, iconBuilder)) {
          (final CanopyGlyph glyph, _) => CanopyIcon(
            glyph: glyph,
            size: glyphSize ?? size.glyphSize,
            tint: enabled
                ? tint ?? colors.foregroundSecondary
                : colors.disabledTint,
          ),
          (_, final builder?) => builder(
            enabled ? tint ?? colors.foregroundSecondary : colors.disabledTint,
            glyphSize ?? size.glyphSize,
          ),
          _ => const SizedBox.shrink(),
        },
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/account/view_models/usage_limits_policy.dart';
import 'package:mobile/ui/features/account/views/widgets/usage_limit_meter.dart';

/// One plan limit window: its label, bar and used percentage, reset time and
/// any reported credits. Once the reset time has passed the values are stale
/// until the desktop reads again, so an overlay says so, as on the desktop.
class UsageLimitWindowCard extends StatelessWidget {
  const UsageLimitWindowCard({
    required this.window,
    required this.resetPassed,
    required this.resetLabel,
    super.key,
  });

  final RemoteControlProviderUsageWindow window;
  final bool resetPassed;
  final String? resetLabel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    final percent = window.unlimited == true ? null : window.usedPercent;
    final secondary = theme.textTheme.bodySmall?.copyWith(
      color: colors.foregroundSecondary,
    );
    final credits = usageCreditLines(window.credits);
    return Container(
      key: ValueKey('usage-limit-window-${window.id}'),
      decoration: BoxDecoration(
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(AppRadii.lg),
      ),
      child: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  window.label,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: AppTypography.emphasisWeight,
                    fontVariations: AppTypography.emphasisVariations,
                  ),
                ),
                if (window.unlimited == true ||
                    (percent == null && credits.isEmpty)) ...[
                  const SizedBox(height: 8),
                  Text(
                    window.unlimited == true
                        ? 'Unlimited'
                        : 'Usage unavailable',
                    style: secondary,
                  ),
                ],
                if (percent != null) ...[
                  const SizedBox(height: 8),
                  UsageLimitMeter(usedPercent: percent),
                  const SizedBox(height: 8),
                  Text(
                    formatUsedPercent(percent),
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: _percentInk(colors, percent),
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ],
                if (resetLabel case final label?) ...[
                  const SizedBox(height: 4),
                  Text(label, style: secondary),
                ],
                for (final line in credits) ...[
                  const SizedBox(height: 4),
                  Text(line, style: secondary),
                ],
              ],
            ),
          ),
          if (resetPassed)
            Positioned.fill(
              child: DecoratedBox(
                key: ValueKey('usage-limit-reset-passed-${window.id}'),
                decoration: BoxDecoration(
                  color: colors.surface.withValues(alpha: 0.85),
                  borderRadius: BorderRadius.circular(AppRadii.lg),
                ),
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(8),
                    child: Text(
                      'Reset time has passed',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.foregroundSecondary,
                        fontWeight: AppTypography.emphasisWeight,
                        fontVariations: AppTypography.emphasisVariations,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  static Color _percentInk(AppColors colors, num percent) =>
      switch (usageToneFor(percent)) {
        UsageTone.normal => colors.foreground,
        UsageTone.warning => colors['fg-attention'],
        UsageTone.critical => colors['fg-destructive'],
      };
}

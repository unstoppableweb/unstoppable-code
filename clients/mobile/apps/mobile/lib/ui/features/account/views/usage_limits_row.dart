import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_section.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/core/widgets/computer_picker_builder.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/account/view_models/usage_limits_policy.dart';
import 'package:mobile/ui/features/account/views/usage_limits_screen.dart';
import 'package:mobile/ui/features/account/views/widgets/usage_limit_meter.dart';
import 'package:provider/provider.dart';

/// Settings' Usage limits card (CAN-3636): one line per provider signed in on
/// the paired desktop, each showing its most-used window. Renders nothing,
/// including its bottom gap, unless the selected computer supplies usage
/// and a provider is signed in or OpenCode account metadata is present.
/// Opens [UsageLimitsScreen].
class UsageLimitsRow extends StatelessWidget {
  const UsageLimitsRow({super.key});

  @override
  Widget build(BuildContext context) {
    final lines = context.select<ProviderUsageSource?, List<UsageSummaryLine>?>(
      (source) => source == null
          ? null
          : usageSummaryLines(
              desktopAvailable: source.isAvailable,
              projection: source.projection,
            ),
    );
    if (lines == null) return const SizedBox.shrink();
    final hasOpenCode = context.select<ProviderUsageSource?, bool>(
      (source) => source?.projection?.openCodeAccounts != null,
    );
    final theme = Theme.of(context);
    // Large text stacks each line so the bar keeps a usable width.
    final stacked = MediaQuery.textScalerOf(context).scale(14) > 14 * 1.3;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppDimens.padding32),
      child: CanopySettingsSection(
        children: [
          InkWell(
            key: const ValueKey('account-usage-limits'),
            onTap: () => _open(context),
            child: Padding(
              padding: const EdgeInsets.all(AppDimens.padding16),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          'Usage limits',
                          style: theme.textTheme.titleSmall?.copyWith(
                            fontWeight: AppTypography.emphasisWeight,
                            fontVariations: AppTypography.emphasisVariations,
                          ),
                        ),
                        for (final line in lines) ...[
                          const SizedBox(height: AppDimens.padding8),
                          _SummaryLine(line: line, stacked: stacked),
                        ],
                        if (hasOpenCode) ...[
                          const SizedBox(height: AppDimens.padding8),
                          Text(
                            'OpenCode provider accounts',
                            style: theme.textTheme.bodyMedium,
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(width: AppDimens.padding8),
                  const CanopySettingsChevron(),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  void _open(BuildContext context) {
    final source = context.read<ProviderUsageSource?>();
    if (source == null) return;
    final computerPicker = context.read<ComputerPickerBuilder?>();
    // The root navigator does not see shell-local providers; re-provide the
    // borrowed source without taking ownership of it.
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ListenableProvider<ProviderUsageSource>.value(
          value: source,
          child: UsageLimitsScreen(
            computerPicker: computerPicker?.call('Usage limits'),
          ),
        ),
      ),
    );
  }
}

class _SummaryLine extends StatelessWidget {
  const _SummaryLine({required this.line, required this.stacked});

  final UsageSummaryLine line;
  final bool stacked;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final secondary = theme.textTheme.bodyMedium?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
      fontFeatures: const [FontFeature.tabularFigures()],
    );
    final name = Text(
      usageProviderName(line.provider),
      style: theme.textTheme.bodyMedium,
    );
    final value = Text(line.valueLabel, style: secondary);
    final percent = line.usedPercent;
    final meter = percent == null
        ? null
        : UsageLimitMeter(usedPercent: percent, height: 4);
    if (stacked) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          name,
          if (meter != null) ...[const SizedBox(height: 4), meter],
          const SizedBox(height: 4),
          value,
        ],
      );
    }
    return Row(
      children: [
        SizedBox(width: 64, child: name),
        const SizedBox(width: 8),
        Expanded(flex: 2, child: meter ?? const SizedBox.shrink()),
        const SizedBox(width: 8),
        Flexible(flex: 3, child: value),
      ],
    );
  }
}

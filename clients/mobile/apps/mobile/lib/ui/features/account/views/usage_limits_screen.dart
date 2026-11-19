import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/account/view_models/usage_limits_policy.dart';
import 'package:mobile/ui/features/account/view_models/usage_limits_view_model.dart';
import 'package:mobile/ui/features/account/views/widgets/usage_limit_window_card.dart';
import 'package:mobile/ui/features/account/views/widgets/opencode_accounts_section.dart';
import 'package:provider/provider.dart';

/// Provider plan usage from the paired desktop (CAN-3636), mirroring
/// the desktop Usage page: per provider, the plan and account, one card per
/// limit window, and a refresh. Reads [ProviderUsageSource], which the
/// pushing route re-provides.
class UsageLimitsScreen extends StatefulWidget {
  const UsageLimitsScreen({
    super.key,
    this.clock,
    this.timer,
    this.computerPicker,
  });

  /// Borrowed app-bar content supplied by the account's computer connection.
  final Widget? computerPicker;

  /// Injected by tests; the real clock and timers otherwise.
  final DateTime Function()? clock;
  final Timer Function(Duration, void Function())? timer;

  @override
  State<UsageLimitsScreen> createState() => _UsageLimitsScreenState();
}

class _UsageLimitsScreenState extends State<UsageLimitsScreen> {
  late final UsageLimitsViewModel _viewModel = UsageLimitsViewModel(
    source: context.read<ProviderUsageSource>(),
    clock: widget.clock,
    timer: widget.timer,
  );

  @override
  void dispose() {
    _viewModel.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CanopyScaffold(
      appBar: _appBar(context, widget.computerPicker),
      body: ListenableBuilder(
        listenable: _viewModel,
        builder: (context, _) {
          final insets = CanopyScaffold.contentPaddingOf(context);
          final note = _staleNote(_viewModel);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Pinned under the bar, so it is in view wherever the list is
              // scrolled; the list keeps its offset and starts below it.
              if (note != null)
                Container(
                  padding: EdgeInsets.fromLTRB(
                    insets.left + 16,
                    insets.top,
                    insets.right + 16,
                    12,
                  ),
                  decoration: BoxDecoration(
                    border: Border(
                      bottom: BorderSide(color: AppColors.of(context).border),
                    ),
                  ),
                  child: note,
                ),
              Expanded(
                child: ListView(
                  padding:
                      (note == null ? insets : insets.copyWith(top: 0)) +
                      const EdgeInsets.all(16),
                  children: [
                    for (final provider in usageProviders(
                      _viewModel.projection,
                    )) ...[
                      _ProviderSection(
                        viewModel: _viewModel,
                        provider: provider,
                      ),
                      const SizedBox(height: 24),
                    ],
                    if (_viewModel.projection?.openCodeAccounts
                        case final accounts?)
                      OpenCodeAccountsSection(
                        snapshot: accounts,
                        now: _viewModel.now(),
                      ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// Why the values on screen stopped updating; null while they are live.
Widget? _staleNote(UsageLimitsViewModel viewModel) {
  if (!viewModel.isDesktopAvailable) {
    return const _StaleNote(
      key: ValueKey('usage-limits-disconnected'),
      reason: 'Desktop disconnected',
    );
  }
  return switch (_deliveryReason(viewModel.delivery)) {
    final reason? => _StaleNote(
      key: const ValueKey('usage-limits-delivery'),
      reason: reason,
    ),
    null => null,
  };
}

/// At large text scales the title wraps instead of truncating, and the bar
/// grows to fit it, moving the body down with it.
CanopyAppBar _appBar(BuildContext context, Widget? computerPicker) {
  if (computerPicker != null) {
    return CanopyAppBar(
      automaticallyImplyLeading: true,
      content: computerPicker,
    );
  }
  const title = 'Usage limits';
  const sizing = CanopyAppBar(
    automaticallyImplyLeading: true,
    content: SizedBox.shrink(),
  );
  var style = Theme.of(context).textTheme.titleMedium!;
  if (MediaQuery.boldTextOf(context)) {
    style = style.merge(const TextStyle(fontWeight: FontWeight.bold));
  }
  final painter = TextPainter(
    text: TextSpan(text: title, style: style),
    textAlign: TextAlign.center,
    textDirection: Directionality.of(context),
    textScaler: MediaQuery.textScalerOf(context),
    locale: Localizations.maybeLocaleOf(context),
  )..layout(maxWidth: sizing.contentWidth(context));
  final lines = painter.computeLineMetrics().length;
  final height = painter.height;
  painter.dispose();
  return CanopyAppBar(
    automaticallyImplyLeading: true,
    toolbarHeight: math.max(sizing.toolbarHeight, height + 8),
    content: Text(title, maxLines: lines),
  );
}

/// Why nothing new can arrive while this phone is not delivering updates;
/// null while it is.
String? _deliveryReason(ProviderUsageDelivery delivery) => switch (delivery) {
  ProviderUsageDelivery.live => null,
  ProviderUsageDelivery.reconnecting => 'Reconnecting',
  ProviderUsageDelivery.unreachable => "Can't reach the server",
};

/// Says the values on screen are the last received, and why.
class _StaleNote extends StatelessWidget {
  const _StaleNote({super.key, required this.reason});

  final String reason;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    // Announced when it appears or its reason changes.
    return Semantics(
      liveRegion: true,
      child: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: reason,
              style: TextStyle(color: colors.foreground),
            ),
            TextSpan(
              text: '. Showing the last values received.',
              style: TextStyle(color: colors.foregroundMuted),
            ),
          ],
        ),
        style: theme.textTheme.bodyMedium,
      ),
    );
  }
}

class _ProviderSection extends StatelessWidget {
  const _ProviderSection({required this.viewModel, required this.provider});

  final UsageLimitsViewModel viewModel;
  final RemoteControlProviderUsageProvider provider;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    final entry = usageEntryFor(viewModel.projection, provider);
    final name = usageProviderName(provider);
    final secondary = theme.textTheme.bodyMedium?.copyWith(
      color: colors.foregroundSecondary,
    );
    final failure = viewModel.refreshFailure(provider);
    final updatedAt = entry?.lastUpdatedAt == null
        ? null
        : DateTime.tryParse(entry!.lastUpdatedAt!);
    return Column(
      key: ValueKey('usage-limits-section-${provider.wire}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                name,
                style: theme.textTheme.titleSmall?.copyWith(
                  fontWeight: AppTypography.emphasisWeight,
                  fontVariations: AppTypography.emphasisVariations,
                ),
              ),
            ),
            _RefreshButton(viewModel: viewModel, provider: provider),
          ],
        ),
        if (entry?.planLabel case final plan?) Text(plan, style: secondary),
        if ((entry?.accountLabel ?? entry?.accountEmail) case final account?)
          Text(account, style: secondary),
        const SizedBox(height: 8),
        ..._body(context, entry, secondary),
        if (updatedAt != null) ...[
          const SizedBox(height: 8),
          Text(
            'Updated ${_formatDateTime(context, updatedAt)}',
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors.foregroundMuted,
            ),
          ),
        ],
        if (failure != null) ...[
          const SizedBox(height: 8),
          Text(
            failure,
            style: theme.textTheme.bodySmall?.copyWith(
              color: colors['fg-destructive'],
            ),
          ),
        ],
      ],
    );
  }

  List<Widget> _body(
    BuildContext context,
    RemoteControlProviderUsageEntry? entry,
    TextStyle? secondary,
  ) {
    final windows =
        entry?.windows ?? const <RemoteControlProviderUsageWindow>[];
    final message = switch (entry?.authState) {
      RemoteControlProviderUsageAuthState.unauthenticated =>
        'Not signed in on desktop',
      RemoteControlProviderUsageAuthState.error =>
        entry?.error?.message ?? "Couldn't load usage on the desktop.",
      RemoteControlProviderUsageAuthState.authenticated when windows.isEmpty =>
        'No usage limits reported.',
      RemoteControlProviderUsageAuthState.unknown ||
      null => 'Usage is not available yet.',
      _ => null,
    };
    final now = viewModel.now();
    return [
      if (message != null) Text(message, style: secondary),
      for (final window in windows) ...[
        if (message != null || window != windows.first)
          const SizedBox(height: 8),
        UsageLimitWindowCard(
          window: window,
          resetPassed: isUsageResetPassed(window, now),
          resetLabel: switch (usageResetAt(window)) {
            final resetAt? => 'Resets ${_formatDateTime(context, resetAt)}',
            null => null,
          },
        ),
      ],
    ];
  }
}

class _RefreshButton extends StatelessWidget {
  const _RefreshButton({required this.viewModel, required this.provider});

  final UsageLimitsViewModel viewModel;
  final RemoteControlProviderUsageProvider provider;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final refreshing = viewModel.isRefreshing(provider);
    final enabled = viewModel.canRefresh(provider);
    return KeyedSubtree(
      key: ValueKey('usage-limits-refresh-${provider.wire}'),
      child: IconButton(
        tooltip: 'Refresh ${usageProviderName(provider)} usage',
        onPressed: enabled
            ? () => unawaited(viewModel.refresh(provider))
            : null,
        icon: refreshing
            ? SizedBox.square(
                key: ValueKey('usage-limits-progress-${provider.wire}'),
                dimension: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: colors.foregroundSecondary,
                ),
              )
            : CanopyIcon(
                glyph: CanopyGlyph.arrowRotateClockwise,
                tint: enabled
                    ? colors.foregroundSecondary
                    : colors.disabledTint,
              ),
      ),
    );
  }
}

String _formatDateTime(BuildContext context, DateTime value) {
  final local = value.toLocal();
  final localizations = MaterialLocalizations.of(context);
  return '${localizations.formatMediumDate(local)}, '
      '${localizations.formatTimeOfDay(TimeOfDay.fromDateTime(local), alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context))}';
}

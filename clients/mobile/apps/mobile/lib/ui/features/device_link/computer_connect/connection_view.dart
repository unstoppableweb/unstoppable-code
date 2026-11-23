import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/action_dialogs.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/external_links.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/inline_notice.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'account_model.dart';

/// Saved and available computers share one list in setup and the switcher.
/// Relay access comes from the sign-in session through
/// [ComputerAccountModel]; this view never asks for a credential.
class ComputerConnectionView extends StatelessWidget {
  const ComputerConnectionView({super.key, required this.account});
  final ComputerAccountModel account;

  Future<void> _forget(BuildContext context, SetupRow computer) async {
    if (await confirmDestructive(
      context,
      title: 'Forget ${computer.name}?',
      message:
          'You will need to approve pairing on this computer to connect again.',
      confirmLabel: 'Forget computer',
    )) {
      await account.forget(computer.computerId);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: account,
    builder: (context, _) {
      // Local restore decides whether setup is needed. Do not flash setup
      // before a returning person's saved computer has been read.
      if (!account.ready && account.busy) return const SizedBox.shrink();
      final theme = Theme.of(context);
      final colors = AppColors.of(context);
      final rows = account.setupRows;
      final error = account.notice;
      final hasRows = rows.isNotEmpty;
      final searched = account.ready && account.discovered && !account.busy;
      return SingleChildScrollView(
        padding:
            CanopyScaffold.contentPaddingOf(context) +
            const EdgeInsets.fromLTRB(20, 24, 20, 24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: colors.surfaceRaised,
                      shape: BoxShape.circle,
                      border: Border.all(color: colors.border),
                    ),
                    child: SizedBox.square(
                      dimension: 56,
                      child: Center(
                        child: CanopyIcon(
                          glyph: CanopyGlyph.macbook,
                          tint: colors.foreground,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  account.computers.isEmpty
                      ? 'Connect to your computer'
                      : 'Your computers',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.headlineSmall?.copyWith(
                    fontWeight: AppTypography.emphasisWeight,
                    fontVariations: AppTypography.emphasisVariations,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  account.computers.isEmpty
                      ? 'Work with your projects and chats from your phone.'
                      : 'Paired computers reconnect on their own while the desktop app is running.',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: colors.foregroundSecondary,
                  ),
                ),
                const SizedBox(height: 24),
                if (error != null) ...[
                  InlineNotice(glyph: CanopyGlyph.circleInfo, state: error),
                  const SizedBox(height: 16),
                ],
                if (hasRows) ...[
                  _ComputerList(
                    children: [
                      for (final row in rows)
                        _ComputerRow(
                          key: ValueKey(
                            row.saved
                                ? 'computer-connect-saved-${row.computerId}'
                                : 'computer-connect-peer-${row.computerId}',
                          ),
                          row: row,
                          onCancel: () => account.cancelConnect(row.computerId),
                          onTap: account.busy
                              ? null
                              : () => account.connect(row.computerId),
                          trailing: row.saved
                              ? PopupMenuButton<String>(
                                  tooltip: 'Options for ${row.name}',
                                  icon: CanopyIcon(
                                    glyph: CanopyGlyph.dotGrid1x3Horizontal,
                                    tint: colors.foregroundSecondary,
                                  ),
                                  onSelected: (value) {
                                    if (value == 'forget') {
                                      unawaited(_forget(context, row));
                                    }
                                    if (value == 'disconnect') {
                                      unawaited(
                                        account.disconnect(row.computerId),
                                      );
                                    }
                                  },
                                  itemBuilder: (_) => [
                                    if (row.reconnect)
                                      const PopupMenuItem(
                                        value: 'disconnect',
                                        child: Text('Disconnect'),
                                      ),
                                    const PopupMenuItem(
                                      value: 'forget',
                                      child: Text('Forget computer'),
                                    ),
                                  ],
                                )
                              : CanopyIcon(
                                  glyph: CanopyGlyph.chevronRightMedium,
                                  tint: colors.foregroundSecondary,
                                ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 24),
                ] else ...[
                  if (searched && error == null) ...[
                    const _NoComputersFound(),
                    const SizedBox(height: 16),
                  ],
                  const _SetupSteps(),
                  const SizedBox(height: 8),
                  const _DesktopLinks(),
                  const SizedBox(height: 16),
                ],
                CanopyButton(
                  expand: true,
                  label: account.finding
                      ? 'Finding computers…'
                      : error != null || account.accessDenied
                      ? 'Try again'
                      : !account.discovered
                      ? 'Connect a computer'
                      : 'Find computers',
                  loading: account.finding,
                  onPressed: account.busy ? null : account.findComputers,
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}

/// A search came back empty: point at Remote Control for people who already
/// run the desktop app, and at the download for people who don't.
class _NoComputersFound extends StatelessWidget {
  const _NoComputersFound();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      key: const ValueKey('computer-connect-none-found'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'No computers found',
          textAlign: TextAlign.center,
          style: theme.textTheme.titleSmall,
        ),
        const SizedBox(height: 6),
        Text(
          'If you already have the desktop app, turn on Remote Control in its '
          'Settings. Otherwise, download it or build it from source.',
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: AppColors.of(context).foregroundSecondary,
          ),
        ),
      ],
    );
  }
}

/// Where to get the desktop app: the download, or the source to build it.
class _DesktopLinks extends StatelessWidget {
  const _DesktopLinks();

  @override
  Widget build(BuildContext context) => Wrap(
    alignment: WrapAlignment.center,
    spacing: 8,
    children: [
      CanopyButton(
        key: const ValueKey('computer-connect-download'),
        label: 'Download the desktop app',
        glyph: CanopyGlyph.squareArrowTopRight,
        variant: CanopyButtonVariant.inline,
        onPressed: () => unawaited(openExternalUrl(desktopDownloadUrl())),
      ),
      CanopyButton(
        key: const ValueKey('computer-connect-github'),
        label: 'View on GitHub',
        glyph: CanopyGlyph.github,
        variant: CanopyButtonVariant.inline,
        onPressed: () => unawaited(openExternalUrl(sourceRepositoryUrl)),
      ),
    ],
  );
}

/// The three things a person does on the desktop before a computer appears.
class _SetupSteps extends StatelessWidget {
  const _SetupSteps();

  static const _steps = [
    'Open ${Brand.productDisplayName} on your computer',
    // Names the desktop's Settings → Remote Control switch
    // (ALLOW_INCOMING_LABEL in the desktop's remote-access-copy.ts).
    'In the settings menu, open Remote Control and turn on '
        '"Allow your other devices to control this computer"',
    'Sign in with this account on both devices',
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (index, step) in _steps.indexed)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(
                    color: colors.surfaceRaised,
                    shape: BoxShape.circle,
                    border: Border.all(color: colors.border),
                  ),
                  child: SizedBox.square(
                    dimension: 28,
                    child: Center(
                      child: Text(
                        '${index + 1}',
                        style: AppTypography.compactLabel.copyWith(
                          color: colors.foreground,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(step, style: theme.textTheme.bodyMedium),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// Approval stays attached to the computer whose identity is being checked.
class _PairingCode extends StatelessWidget {
  const _PairingCode(this.code);
  final String code;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Check the code on your computer',
            style: theme.textTheme.titleSmall,
          ),
          const SizedBox(height: 12),
          Text(
            code,
            key: const ValueKey('computer-connect-code'),
            style: theme.textTheme.headlineLarge?.copyWith(
              fontFamily: AppTypography.monoFamily,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(height: 12),
          Text(
            'Approve on your computer only if both codes match. You only need to do this once.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: AppColors.of(context).foregroundSecondary,
            ),
          ),
        ],
      ),
    );
  }
}

/// One bordered group so saved and available computers read as one list.
class _ComputerList extends StatelessWidget {
  const _ComputerList({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Material(
      color: colors.surfaceRaised,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: colors.border),
      ),
      child: Column(
        children: [
          for (final (index, child) in children.indexed) ...[
            if (index > 0) Divider(height: 1, color: colors.border),
            child,
          ],
        ],
      ),
    );
  }
}

class _ComputerRow extends StatelessWidget {
  const _ComputerRow({
    super.key,
    required this.row,
    required this.onTap,
    required this.trailing,
    required this.onCancel,
  });
  final SetupRow row;
  final VoidCallback onCancel;
  final VoidCallback? onTap;
  final Widget trailing;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final status = StatusColors.of(context);
    final tone = switch (row.tone) {
      StatusTone.success => status.success,
      StatusTone.active => status.active,
      StatusTone.warning => status.warning,
      StatusTone.neutral => status.neutral,
    };
    final busy = row.busy;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ListTile(
          contentPadding: const EdgeInsetsDirectional.only(start: 16, end: 8),
          leading: CanopyIcon(
            glyph: CanopyGlyph.macbook,
            tint: colors.foreground,
          ),
          title: Text(
            row.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: AppTypography.title.copyWith(color: colors.foreground),
          ),
          subtitle: Semantics(
            liveRegion: true,
            child: Row(
              children: [
                if (busy)
                  const LoadingSpinner(size: 12)
                else
                  DecoratedBox(
                    decoration: BoxDecoration(
                      color: tone,
                      shape: BoxShape.circle,
                    ),
                    child: const SizedBox.square(dimension: 8),
                  ),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    row.label,
                    style: AppTypography.bodySmall.copyWith(
                      color: colors.foregroundSecondary,
                    ),
                  ),
                ),
              ],
            ),
          ),
          trailing: busy
              ? CanopyButton(
                  label: 'Cancel',
                  semanticsLabel: 'Cancel connection to ${row.name}',
                  variant: CanopyButtonVariant.inline,
                  onPressed: onCancel,
                )
              : trailing,
          onTap: busy ? null : onTap,
        ),
        if (row.pairingCode case final code?) _PairingCode(code),
      ],
    );
  }
}

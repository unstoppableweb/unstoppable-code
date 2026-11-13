import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/device_link/desktop/saved_connection.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/widgets/computer_connection_title.dart';
import 'account.dart';
import '../desktop_link_model.dart';

/// The app bar title for Computer connect. A tap lists saved computers,
/// including ones reconnecting in the background, with Manage computers
/// last.
class ComputerSwitcher extends StatelessWidget {
  const ComputerSwitcher({
    super.key,
    required this.account,
    required this.title,
    required this.label,
    required this.onManage,
  });
  final ComputerConnectAccount account;
  final String title, label;
  final VoidCallback onManage;

  /// The menu's preferred width; narrow screens keep a side margin.
  static const double _menuWidth = 280;

  /// Checkmark size and the matching empty slot on other computers.
  static const double _checkSize = 20;

  /// Space between the checkmark slot and the computer name.
  static const double _labelGap = 12;

  String _name(SavedComputer computer) =>
      account.engine.sessions[computer.id]?.chats.connection.host?['name']
          as String? ??
      computer.name;

  String _status(SavedComputer computer) {
    final phase = account.engine.sessions[computer.id]?.chats.connection.phase;
    if (phase == DesktopLinkPhase.connected) return 'Connected';
    // An absent peer on a live relay is offline even while retries continue.
    if (account.computerAvailable(computer.id) == false) return 'Offline';
    return switch (phase) {
      DesktopLinkPhase.connected => 'Connected',
      DesktopLinkPhase.connecting => 'Connecting…',
      DesktopLinkPhase.pairing => 'Waiting for approval',
      DesktopLinkPhase.reconnecting => 'Reconnecting…',
      DesktopLinkPhase.disconnected ||
      DesktopLinkPhase.failed ||
      null => 'Offline',
    };
  }

  /// Opens the menu as a route under the title. A route keeps each option in
  /// one semantics parent; the pinned iOS bridge misplaces overlay-portal
  /// menus (flutter/flutter#182604).
  Future<void> _open(BuildContext context) async {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    final anchor = context.findRenderObject()! as RenderBox;
    final overlay =
        Navigator.of(context).overlay!.context.findRenderObject()! as RenderBox;
    final size = overlay.size;
    final width = math.min(_menuWidth, size.width - 2 * AppDimens.padding16);
    final bottomCenter = anchor.localToGlobal(
      anchor.size.bottomCenter(Offset.zero),
      ancestor: overlay,
    );
    final left = (bottomCenter.dx - width / 2)
        .clamp(
          AppDimens.padding16,
          math.max(
            AppDimens.padding16,
            size.width - width - AppDimens.padding16,
          ),
        )
        .toDouble();
    final selectedId = account.engine.selectedId;
    final labelStyle = theme.textTheme.labelLarge?.copyWith(
      color: colors.foreground,
    );
    final choice = await showMenu<_Choice>(
      context: context,
      position: RelativeRect.fromLTRB(
        left,
        bottomCenter.dy,
        size.width - left - width,
        size.height - bottomCenter.dy,
      ),
      constraints: BoxConstraints.tightFor(width: width),
      color: colors.surfaceRaised,
      elevation: 8,
      menuPadding: const EdgeInsets.symmetric(vertical: AppDimens.padding4),
      shape: RoundedRectangleBorder(
        side: BorderSide(color: colors.border),
        borderRadius: BorderRadius.circular(AppRadii.lg),
      ),
      popUpAnimationStyle: AnimationStyle.noAnimation,
      items: [
        for (final computer in account.selectableComputers)
          PopupMenuItem<_Choice>(
            key: ValueKey('computer-switcher-${computer.id}'),
            value: _Select(computer.id),
            height: AppDimens.settingsRowMinHeight,
            padding: const EdgeInsets.symmetric(
              horizontal: AppDimens.padding16,
            ),
            child: Row(
              children: [
                // The checked state is announced; the glyph is decoration.
                if (computer.id == selectedId)
                  ExcludeSemantics(
                    child: CanopyIcon(
                      glyph: CanopyGlyph.checkmark1,
                      size: _checkSize,
                      tint: colors.foreground,
                    ),
                  )
                else
                  const SizedBox.square(dimension: _checkSize),
                const SizedBox(width: _labelGap),
                Expanded(
                  child: Semantics(
                    checked: computer.id == selectedId,
                    inMutuallyExclusiveGroup: true,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          _name(computer),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: labelStyle,
                        ),
                        ListenableBuilder(
                          listenable: account,
                          builder: (context, _) => Text(
                            _status(computer),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: colors.foregroundSecondary,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        PopupMenuDivider(color: colors.border),
        PopupMenuItem<_Choice>(
          key: const ValueKey('computer-switcher-manage'),
          value: const _Manage(),
          height: AppDimens.settingsRowMinHeight,
          padding: const EdgeInsets.symmetric(horizontal: AppDimens.padding16),
          child: Row(
            children: [
              ExcludeSemantics(
                child: CanopyIcon(
                  glyph: CanopyGlyph.settingsGear2,
                  size: _checkSize,
                  tint: colors.foregroundSecondary,
                ),
              ),
              const SizedBox(width: _labelGap),
              Expanded(child: Text('Manage computers', style: labelStyle)),
            ],
          ),
        ),
      ],
    );
    switch (choice) {
      case _Select(:final id) when id != selectedId:
        await account.select(id);
      case _Manage():
        onManage();
      case _Select() || null:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Semantics(
      button: true,
      hint: 'Switch computer',
      child: InkWell(
        key: const ValueKey('computer-switcher'),
        borderRadius: BorderRadius.circular(AppRadii.lg),
        onTap: () => unawaited(_open(context)),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppDimens.padding8),
          child: ComputerConnectionTitle(
            title: title,
            // Brief reconnects stay quiet. The explicit menu still shows each
            // computer's current status and offers Manage computers.
            label: account.offline
                ? label.isEmpty
                      ? 'Computer offline'
                      : '$label · Computer offline'
                : label,
            statusColor: account.offline
                ? StatusColors.of(context).destructive
                : null,
            titleKey: const ValueKey('computer-connect-device-name'),
            labelKey: const ValueKey('computer-connect-device-status'),
            titleTrailing: ExcludeSemantics(
              child: CanopyIcon(
                glyph: CanopyGlyph.chevronDownSmall,
                size: _checkSize,
                tint: colors.foregroundSecondary,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

sealed class _Choice {
  const _Choice();
}

final class _Select extends _Choice {
  const _Select(this.id);
  final String id;
}

final class _Manage extends _Choice {
  const _Manage();
}

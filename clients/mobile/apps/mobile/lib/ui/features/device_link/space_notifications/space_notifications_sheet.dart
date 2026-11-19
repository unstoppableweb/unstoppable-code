import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'space_notification_menu.dart';
import 'space_notifications_view_model.dart';

/// Opens the notification choices for one space (a worktree or a Cowork Work
/// Entry) and reads its saved choice as the sheet opens.
///
/// [viewModel] is passed in rather than looked up: a modal route is a sibling
/// overlay entry of the route that opened it, not a descendant, so the shell's
/// providers are not visible from inside the sheet. Pass a [context] that
/// outlives a dismissed long-press menu, such as the row's own.
Future<void> showSpaceNotificationsSheet(
  BuildContext context, {
  required SpaceNotificationsViewModel viewModel,
  required String spaceId,
  required String title,
}) {
  unawaited(viewModel.refresh(spaceId));
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (_) => SpaceNotificationsSheet(
      viewModel: viewModel,
      spaceId: spaceId,
      title: title,
    ),
  );
}

/// The three notification choices for [spaceId], with the one status line.
///
/// The checked choice is always the one the server acknowledged; a save in
/// flight shows a spinner on the pending choice and ignores taps until it
/// settles. A failed save leaves the acknowledged choice checked.
class SpaceNotificationsSheet extends StatelessWidget {
  const SpaceNotificationsSheet({
    super.key,
    required this.viewModel,
    required this.spaceId,
    required this.title,
  });

  final SpaceNotificationsViewModel viewModel;
  final String spaceId;

  /// The row's name, so the sheet says which space it changes.
  final String title;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListenableBuilder(
      listenable: viewModel,
      builder: (context, _) {
        final state = viewModel.menuStateFor(spaceId);
        final status = state.statusLine;
        final enabled = state.choicesEnabled;
        final pending = state.pending;
        return SingleChildScrollView(
          key: ValueKey('space-notify-sheet-$spaceId'),
          padding: const EdgeInsets.only(bottom: 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 24),
                child: Semantics(
                  header: true,
                  child: Text(
                    SpaceNotificationCopy.heading,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: AppTypography.emphasisWeight,
                      fontVariations: AppTypography.emphasisVariations,
                    ),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 2, 24, 8),
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              RadioGroup<SpaceNotificationChoice>(
                groupValue: state.checked,
                onChanged: (choice) {
                  if (choice == null || !state.canSelect) return;
                  unawaited(viewModel.select(spaceId, choice.level));
                },
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (final choice in SpaceNotificationChoice.values)
                      RadioListTile<SpaceNotificationChoice>(
                        key: ValueKey('space-notify-${choice.key}-$spaceId'),
                        value: choice,
                        enabled: enabled,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 16,
                        ),
                        title: Text(spaceNotificationChoiceLabel(choice)),
                        subtitle: Text(
                          spaceNotificationChoiceDescription(choice),
                        ),
                        // A fixed slot on every row, so the pending spinner
                        // never reflows the text or changes the height.
                        secondary: SizedBox.square(
                          dimension: 16,
                          child: choice == pending
                              ? CircularProgressIndicator(
                                  key: ValueKey(
                                    'space-notify-pending-${choice.key}-$spaceId',
                                  ),
                                  strokeWidth: 2,
                                )
                              : null,
                        ),
                      ),
                  ],
                ),
              ),
              if (status != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 8, 24, 0),
                  child: Semantics(
                    liveRegion: true,
                    child: Text(
                      status.text,
                      key: ValueKey('space-notify-status-$spaceId'),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: status.isFailure
                            ? theme.colorScheme.error
                            : theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

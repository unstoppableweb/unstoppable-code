import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/space_notification_policy.dart';

/// Presentation of one space's notification choices (CAN-3615).
///
/// Mirrors `SpaceNotificationMenu` in `@canopy/ui-shared`, so every host
/// shows the same choices, order, copy, and disabled states.

/// The `showMenu` value of [spaceNotificationsMenuItem].
const spaceNotificationsMenuValue = 'notifications';

/// The row long-press menu entry that opens a space's notification choices.
/// Rows add it only when they have a notification space id.
PopupMenuItem<String> spaceNotificationsMenuItem(
  BuildContext context, {
  required Key key,
}) => PopupMenuItem<String>(
  key: key,
  value: spaceNotificationsMenuValue,
  child: Row(
    children: [
      CanopyIcon(
        glyph: CanopyGlyph.bell,
        size: 20,
        tint: Theme.of(context).colorScheme.onSurface,
      ),
      const SizedBox(width: 12),
      const Text(SpaceNotificationCopy.heading),
    ],
  ),
);

/// Status and failure lines every host shows for the same situation.
abstract final class SpaceNotificationCopy {
  static const heading = 'Notifications';
  static const loading = 'Loading…';
  static const writesClosed = 'Changing this isn’t available right now.';
  static const loadFailed = 'Couldn’t load. Reopen this menu to try again.';
  static const saveFailed = 'Couldn’t save. Try again.';
  static const changedElsewhere =
      'This changed somewhere else. Showing the latest.';
  static const deliveryInProgress =
      'A notification is being delivered. Try again in a moment.';
  static const unconfirmed =
      'Couldn’t confirm the change. Check your connection.';
}

/// One row of the menu: one of the three levels.
///
/// A space without an override gets every notification, so All activity
/// saves no override rather than storing `all`.
enum SpaceNotificationChoice {
  all(null, 'all'),
  attention(SpaceNotificationLevel.attention, 'attention'),
  mute(SpaceNotificationLevel.mute, 'mute');

  const SpaceNotificationChoice(this.level, this.key);

  /// The override this choice saves; null removes it.
  final SpaceNotificationLevel? level;

  /// Stable identifier for widget keys.
  final String key;

  /// The row for a saved override. No override and an explicit `all` are
  /// both All activity.
  static SpaceNotificationChoice of(SpaceNotificationLevel? level) =>
      switch (level) {
        null || SpaceNotificationLevel.all => all,
        SpaceNotificationLevel.attention => attention,
        SpaceNotificationLevel.mute => mute,
      };
}

enum SpaceNotificationMenuStatus { loading, ready, saving, failed }

/// What the app knows about one space's saved choice.
///
/// [override] is always the last choice the server acknowledged; a save in
/// flight is never shown as selected. Its choice is [pending] instead.
class SpaceNotificationMenuState {
  const SpaceNotificationMenuState({
    required this.status,
    required this.override,
    required this.selectionKnown,
    this.pendingOverride,
    this.disabledReason,
    this.failure,
  });

  final SpaceNotificationMenuStatus status;
  final SpaceNotificationLevel? override;

  /// The override a save in flight is storing; meaningful only while saving.
  final SpaceNotificationLevel? pendingOverride;

  /// False until a saved choice has been read, including after a failed
  /// first read.
  final bool selectionKnown;

  /// Set when the choices can be read but not changed; shown as the reason.
  final String? disabledReason;

  /// Set with [SpaceNotificationMenuStatus.failed]: why the last read or save
  /// did not go through.
  final String? failure;

  /// The choice to show checked, or null when nothing is known.
  SpaceNotificationChoice? get checked =>
      selectionKnown ? SpaceNotificationChoice.of(override) : null;

  /// The choice a save in flight is storing, shown with a spinner rather
  /// than as selected. Null when nothing is saving.
  SpaceNotificationChoice? get pending {
    if (status != SpaceNotificationMenuStatus.saving) return null;
    final choice = SpaceNotificationChoice.of(pendingOverride);
    return choice == checked ? null : choice;
  }

  /// Every choice is disabled while the saved value is unknown or while the
  /// server is not accepting changes. A save in flight leaves them enabled
  /// so the sheet keeps its look on every change; see [canSelect].
  bool get choicesEnabled => selectionKnown && disabledReason == null;

  /// Whether a tap starts a save: never while one is in flight.
  bool get canSelect =>
      choicesEnabled && status != SpaceNotificationMenuStatus.saving;

  /// The one line under the heading: a first read, a failure, or why it is
  /// read-only. Null when there is nothing to say, including while saving:
  /// the pending choice's spinner shows that, so the sheet keeps its height.
  ({String text, bool isFailure})? get statusLine => switch (status) {
    SpaceNotificationMenuStatus.loading => (
      text: SpaceNotificationCopy.loading,
      isFailure: false,
    ),
    SpaceNotificationMenuStatus.saving => null,
    SpaceNotificationMenuStatus.failed => (
      text: failure ?? SpaceNotificationCopy.saveFailed,
      isFailure: true,
    ),
    SpaceNotificationMenuStatus.ready => switch (disabledReason) {
      final reason? => (text: reason, isFailure: false),
      null => null,
    },
  };
}

/// The choice's label, e.g. "All activity".
String spaceNotificationChoiceLabel(SpaceNotificationChoice choice) =>
    switch (choice) {
      SpaceNotificationChoice.all => 'All activity',
      SpaceNotificationChoice.attention => 'Needs my attention',
      SpaceNotificationChoice.mute => 'Mute',
    };

/// What the choice delivers.
String spaceNotificationChoiceDescription(
  SpaceNotificationChoice choice,
) => switch (choice) {
  SpaceNotificationChoice.all => 'Notify me about everything in this space',
  SpaceNotificationChoice.attention =>
    'Notify me only when work needs input, approval, or review, is blocked, or fails',
  SpaceNotificationChoice.mute => 'Send no notifications from this space',
};

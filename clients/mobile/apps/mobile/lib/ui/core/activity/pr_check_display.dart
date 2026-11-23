/// Shared with Remote Control. Computer Connect uses the Rust port in
/// cc-domain::activity (display) with its words in cc-app copy::activity;
/// keep both in step until cleanup C5.
library;

import 'dart:ui';

import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/data/models/computer_activity/pr_check.dart';
import 'package:mobile/ui/core/status_colors.dart';

/// Pure presentation helpers for a PR's CI checks (CAN-3618), kept out of
/// the widgets so the status vocabulary is unit-testable.
enum PrCheckDisplayState {
  queued('Queued'),
  running('Running'),
  succeeded('Succeeded'),
  failed('Failed'),
  canceled('Canceled'),
  timedOut('Timed out'),
  skipped('Skipped'),
  actionRequired('Action required'),
  neutral('Neutral'),

  /// Only from an older desktop that sends the four-value status, which
  /// cannot tell queued from running.
  pending('Pending');

  const PrCheckDisplayState(this.label);
  final String label;

  /// Running alone shows motion; every other state has a static glyph.
  bool get isRunning => this == running;

  Color color(StatusColors colors) => switch (this) {
    running => colors.active,
    queued || skipped || pending => colors.quaternary,
    succeeded => colors.success,
    failed || timedOut => colors.failed,
    actionRequired => colors.warning,
    canceled || neutral => colors.neutral,
  };

  /// Null for [running], which renders a spinner instead.
  CanopyGlyph? get glyph => switch (this) {
    running => null,
    queued || pending => CanopyGlyph.clock,
    succeeded => CanopyGlyph.checkmark1,
    failed => CanopyGlyph.crossSmall,
    timedOut => CanopyGlyph.stopwatch,
    canceled => CanopyGlyph.stop,
    actionRequired => CanopyGlyph.warningSign,
    skipped || neutral => CanopyGlyph.minusSmall,
  };
}

/// The detailed state wins; an older desktop's four-value status is the
/// fallback. Any value this build does not know reads as Neutral.
PrCheckDisplayState prCheckDisplayState(RemotePrCheck check) =>
    switch (check.executionState) {
      'queued' => PrCheckDisplayState.queued,
      'running' => PrCheckDisplayState.running,
      'success' => PrCheckDisplayState.succeeded,
      'failure' => PrCheckDisplayState.failed,
      'cancelled' => PrCheckDisplayState.canceled,
      'timed_out' => PrCheckDisplayState.timedOut,
      'skipped' => PrCheckDisplayState.skipped,
      'action_required' => PrCheckDisplayState.actionRequired,
      'neutral' => PrCheckDisplayState.neutral,
      null => switch (check.status) {
        'success' => PrCheckDisplayState.succeeded,
        'failure' => PrCheckDisplayState.failed,
        'pending' => PrCheckDisplayState.pending,
        _ => PrCheckDisplayState.neutral,
      },
      _ => PrCheckDisplayState.neutral,
    };

/// `Checks (X/Y passed)`: X counts Succeeded checks, Y every check.
String prChecksHeaderLabel(List<RemotePrCheck> checks) {
  final passed = checks
      .where(
        (check) => prCheckDisplayState(check) == PrCheckDisplayState.succeeded,
      )
      .length;
  return 'Checks ($passed/${checks.length} passed)';
}

/// Open while the PR's summary CI status needs attention. The desktop's
/// aggregate decides, so this never disagrees with the merge rules.
bool prChecksExpandedByDefault(String? checkStatus) =>
    checkStatus == 'failing' || checkStatus == 'pending';

/// Screen-reader label for one row; the full name survives visual truncation.
String prCheckSemanticsLabel(RemotePrCheck check) {
  final label = '${check.name}, ${prCheckDisplayState(check).label}';
  return check.detailsUri == null ? label : '$label, opens in browser';
}

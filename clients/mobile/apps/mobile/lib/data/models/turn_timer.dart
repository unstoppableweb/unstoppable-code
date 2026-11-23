/// Pure turn-timer logic for the mobile chat transcript. Dart port
/// of the shared desktop/web `TurnTimer` rules
/// (`packages/ui-shared/src/components/TurnTimer.tsx`): elapsed time excludes
/// completed and active pause windows, clamps at zero against desktop/phone
/// clock skew, and a finished turn reads "Worked for 3m 24s".
///
/// Shared with Remote Control. Computer Connect uses the Rust port in
/// cc-domain::feed::turns; keep both in step until cleanup C5.
library;

import 'dart:math' as math;

import 'package:mobile/data/models/chat_message.dart';

/// Parsed `turn_timer` part payload (`createPortalTurnTimer` /
/// `persistedParts` on the desktop). All fields are epoch milliseconds from
/// the desktop's clock.
class TurnTimer {
  const TurnTimer({
    this.startedAt,
    this.pausedAt,
    this.resumedAt,
    this.accumulatedPausedDurationMs,
    this.completedAt,
    this.endReason,
  });

  final int? startedAt;
  final int? pausedAt;
  final int? resumedAt;
  final int? accumulatedPausedDurationMs;
  final int? completedAt;

  /// Why the turn ended abnormally (`cancelled` or `failed`), stamped by the
  /// desktop on the completed timer. Null for a normal completion and for
  /// producers that predate the field.
  final String? endReason;

  /// Waiting on user input mid-turn: paused and never resumed.
  bool get isPaused =>
      completedAt == null && pausedAt != null && resumedAt == null;

  /// Actively running: not finished, not paused.
  bool get isLive => completedAt == null && !isPaused;

  /// Parses a `turn_timer` chat part; null for other kinds or missing data.
  static TurnTimer? fromPart(ChatPart part) {
    if (part.kind != 'turn_timer') return null;
    final data = part.data;
    if (data == null) return null;
    int? epoch(String key) {
      final value = data[key];
      return value is num ? value.toInt() : null;
    }

    final endReason = data['endReason'];
    return TurnTimer(
      startedAt: epoch('startedAt'),
      pausedAt: epoch('pausedAt'),
      resumedAt: epoch('resumedAt'),
      accumulatedPausedDurationMs: epoch('accumulatedPausedDurationMs'),
      completedAt: epoch('completedAt'),
      endReason: endReason is String ? endReason : null,
    );
  }

  /// Elapsed milliseconds at desktop-clock instant [nowMs], excluding pause
  /// time and clamped at zero. Zero without a start timestamp.
  int elapsedMs(int nowMs) {
    final startedAt = this.startedAt;
    if (startedAt == null) return 0;
    final endAt = completedAt ?? nowMs;
    final accumulated = accumulatedPausedDurationMs;
    final pausedAt = this.pausedAt;
    final resumedAt = this.resumedAt;
    final int completedPauseMs = accumulated != null
        ? math.max(0, accumulated)
        : pausedAt != null && resumedAt != null
        ? math.max(0, resumedAt - math.max(startedAt, pausedAt))
        : 0;
    final int activePauseMs = pausedAt == null || resumedAt != null
        ? 0
        : math.max(0, endAt - math.max(startedAt, pausedAt));
    final elapsed = endAt - startedAt - completedPauseMs - activePauseMs;
    return elapsed < 0 ? 0 : elapsed;
  }
}

/// "28s", "3m 24s", "1h 5m": a turn's duration in words, as desktop's
/// `formatWorkDuration`. Surface-specific exception to the spelled-out
/// elapsed-time rule: the header is one quiet step line that must read the
/// same as the desktop clean turn header it mirrors.
String formatWorkDuration(int seconds) {
  final hours = seconds ~/ 3600;
  final minutes = (seconds % 3600) ~/ 60;
  final remaining = seconds % 60;
  if (hours > 0) return minutes > 0 ? '${hours}h ${minutes}m' : '${hours}h';
  if (minutes > 0) {
    return remaining > 0 ? '${minutes}m ${remaining}s' : '${minutes}m';
  }
  return '${remaining}s';
}

/// A finished turn's header, as desktop's clean `TurnWorkHeader`: "Worked
/// for 3m 24s", "Stopped after 12s" or "Failed after 4s", or the bare words
/// when the turn carries no start timestamp. Reads only desktop timestamps.
String turnWorkLabel(TurnTimer? timer) {
  final completedAt = timer?.completedAt;
  final seconds = timer?.startedAt == null || completedAt == null
      ? null
      : timer!.elapsedMs(completedAt) ~/ 1000;
  final time = seconds == null ? null : formatWorkDuration(seconds);
  return switch (timer?.endReason) {
    'cancelled' => time == null ? 'Stopped' : 'Stopped after $time',
    'failed' => time == null ? 'Failed' : 'Failed after $time',
    _ => time == null ? 'Worked' : 'Worked for $time',
  };
}

/// The transcript's newest turn-timer part, parsed. Only the newest matters:
/// at most one turn is ever live, and a completed newest timer means the last
/// turn settled.
TurnTimer? findNewestTurnTimer(List<ChatMessage> messages) {
  for (var i = messages.length - 1; i >= 0; i -= 1) {
    final message = messages[i];
    for (final part in message.parts) {
      final timer = TurnTimer.fromPart(part);
      if (timer != null) return timer;
    }
  }
  return null;
}

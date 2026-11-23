/// Shared with Remote Control. Computer Connect uses the Rust port in
/// cc-domain::feed::turns; keep both in step until cleanup C5.
library;

import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/turn_timer.dart';

/// Agent-turn liveness is separate from individual tool execution. A completed
/// timer settles its turn even if a tool's completion event was lost. Preserve
/// those rows and their actual status; a later result can still update them.
/// A new user prompt or activity positioned after completion starts fresh work.
bool isChatTurnRunning(Iterable<ChatMessage> messages) {
  var streaming = false;
  var runningTimer = false;
  int? userAt;
  int? completedAt;
  int? streamingAt;
  int? runningTimerStartedAt;

  for (final message in messages) {
    if (message.role == ChatRole.user && !message.continuesTurn) {
      streaming = false;
      runningTimer = false;
      userAt = message.positionAt?.millisecondsSinceEpoch;
      completedAt = null;
      streamingAt = null;
      runningTimerStartedAt = null;
    }
    var carriesTimer = false;
    for (final part in message.parts) {
      final timer = TurnTimer.fromPart(part);
      if (timer == null) continue;
      carriesTimer = true;
      final end = timer.completedAt;
      if (end != null) {
        // A late timer from the previous turn must not settle a newer prompt.
        final start = timer.startedAt;
        if (userAt != null &&
            (end < userAt ||
                (end == userAt && start != null && start < userAt))) {
          continue;
        }
        if (completedAt == null || end > completedAt) completedAt = end;
      } else {
        runningTimer = true;
        final start = timer.startedAt;
        if (start != null &&
            (runningTimerStartedAt == null || start > runningTimerStartedAt)) {
          runningTimerStartedAt = start;
        }
      }
    }
    if (message.isStreaming && !carriesTimer) {
      streaming = true;
      final at = message.positionAt?.millisecondsSinceEpoch;
      if (at != null && (streamingAt == null || at > streamingAt)) {
        streamingAt = at;
      }
    }
  }

  if (completedAt == null) return streaming || runningTimer;
  return (streamingAt != null && streamingAt > completedAt) ||
      (runningTimerStartedAt != null && runningTimerStartedAt > completedAt);
}

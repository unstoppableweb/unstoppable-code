import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/turn_timer.dart';
import 'package:mobile/ui/core/chat/view_models/step_runs.dart';
import 'package:mobile/ui/core/chat/view_models/tool_call_display.dart';
import 'package:mobile/ui/core/chat/view_models/turn_grouping.dart';
import 'package:mobile/ui/core/chat/view_models/response_action_target.dart';

/// One row of the turn-structured transcript.
sealed class TranscriptRow {
  const TranscriptRow();

  /// Stable identity across revisions, or null for a row without one.
  String? get key;
}

/// Actions belong to the completed answer, outside any collapsed steps.
final class TranscriptResponseActionsRow extends TranscriptRow {
  const TranscriptResponseActionsRow(this.message, this.target);

  final ChatMessage message;
  final ResponseActionTarget target;

  @override
  String get key => 'response-actions-${target.turnKey}';
}

final class TranscriptMessageRow extends TranscriptRow {
  const TranscriptMessageRow(
    this.message, {
    this.toolResults = const {},
    this.streamingSpinner = true,
    this.parts = true,
  });

  final ChatMessage message;

  /// False when the message's steps draw in the run before it.
  final bool parts;

  /// The owning turn's `tool_result` parts keyed by `toolUseId`, so each
  /// tool-call row can show its outcome inline.
  final Map<String, ToolCallResult> toolResults;

  /// False when the turn's working row already shows progress, so a
  /// streaming message does not add a second spinner.
  final bool streamingSpinner;

  @override
  String get key => 'message-${message.messageId}';

  @override
  bool operator ==(Object other) =>
      other is TranscriptMessageRow &&
      identical(other.message, message) &&
      identical(other.toolResults, toolResults) &&
      other.streamingSpinner == streamingSpinner &&
      other.parts == parts;

  @override
  int get hashCode => Object.hash(
    identityHashCode(message),
    identityHashCode(toolResults),
    streamingSpinner,
    parts,
  );
}

/// A run of agent steps between two replies (desktop `ChatToolStepGroup`):
/// one line in words that opens the steps before [shownFrom]; the steps
/// from [shownFrom] on stay in view under it (a running turn's newest).
/// Fewer than two calls draw as their own rows, with no line.
final class TranscriptRunRow extends TranscriptRow {
  const TranscriptRunRow(
    this.runKey,
    this.steps, {
    required this.shownFrom,
    required this.expanded,
    this.toolResults = const {},
    this.anchorMessageId,
  });

  /// The owner's expansion key for this run's line.
  final String runKey;

  /// The message this row holds the reader on across history loads
  /// (see [RunSegment.anchorMessageId]).
  final String? anchorMessageId;
  final List<RunStep> steps;
  final int shownFrom;
  final bool expanded;
  final Map<String, ToolCallResult> toolResults;

  @override
  String get key => runKey;

  @override
  bool operator ==(Object other) =>
      other is TranscriptRunRow &&
      other.runKey == runKey &&
      listEquals(other.steps, steps) &&
      other.shownFrom == shownFrom &&
      other.expanded == expanded &&
      other.anchorMessageId == anchorMessageId &&
      identical(other.toolResults, toolResults);

  @override
  int get hashCode => Object.hash(
    runKey,
    Object.hashAll(steps),
    shownFrom,
    expanded,
    anchorMessageId,
    identityHashCode(toolResults),
  );
}

/// A completed turn's "Worked for 3m 24s" header, which folds its steps.
final class TranscriptStepsRow extends TranscriptRow {
  const TranscriptStepsRow(
    this.turnKey,
    this.counts, {
    required this.expanded,
    this.timer,
  });

  /// The turn's key ([ChatTurn.key]).
  final String turnKey;
  final List<TurnStepCount> counts;
  final bool expanded;

  /// The turn's completed timer, for the header's duration and ending.
  final TurnTimer? timer;

  @override
  String? get key => turnKey.isEmpty ? null : 'turn-steps-row-$turnKey';

  @override
  bool operator ==(Object other) =>
      other is TranscriptStepsRow &&
      other.turnKey == turnKey &&
      identical(other.counts, counts) &&
      identical(other.timer, timer) &&
      other.expanded == expanded;

  @override
  int get hashCode => Object.hash(
    turnKey,
    identityHashCode(counts),
    identityHashCode(timer),
    expanded,
  );
}

/// A running turn's live or paused timer, or the bottom "Thinking" bridge
/// when [turnKey] is null.
final class TranscriptTimerRow extends TranscriptRow {
  const TranscriptTimerRow(this.timer, {this.turnKey});

  /// The turn's authoritative timer, or null when only a streaming flag (no
  /// timer part) says the turn is running.
  final TurnTimer? timer;
  final String? turnKey;

  @override
  String? get key => switch (turnKey) {
    null => 'turn-timer-bridge',
    '' => null,
    final turnKey => 'turn-timer-$turnKey',
  };

  @override
  bool operator ==(Object other) =>
      other is TranscriptTimerRow &&
      identical(other.timer, timer) &&
      other.turnKey == turnKey;

  @override
  int get hashCode => Object.hash(identityHashCode(timer), turnKey);
}

/// A host-supplied row closing one turn, after its footer (or, for a live
/// turn, under its working row).
final class TranscriptTurnFooterRow extends TranscriptRow {
  const TranscriptTurnFooterRow(this.turnKey);

  final String turnKey;

  @override
  String get key => 'turn-footer-$turnKey';

  @override
  bool operator ==(Object other) =>
      other is TranscriptTurnFooterRow && other.turnKey == turnKey;

  @override
  int get hashCode => turnKey.hashCode;
}

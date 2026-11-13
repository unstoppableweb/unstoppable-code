import 'dart:collection';

import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/turn_timer.dart';
import 'package:mobile/ui/core/chat/view_models/incremental_turn_groups.dart';
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
    this.turn,
    this.counts, {
    required this.expanded,
    this.timer,
  });

  final ChatTurn turn;
  final List<TurnStepCount> counts;
  final bool expanded;

  /// The turn's completed timer, for the header's duration and ending.
  final TurnTimer? timer;

  @override
  String? get key => turn.key.isEmpty ? null : 'turn-steps-row-${turn.key}';

  @override
  bool operator ==(Object other) =>
      other is TranscriptStepsRow &&
      identical(other.turn, turn) &&
      identical(other.counts, counts) &&
      identical(other.timer, timer) &&
      other.expanded == expanded;

  @override
  int get hashCode => Object.hash(
    identityHashCode(turn),
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

/// Projects a transcript into [TranscriptRow]s: prompt, then the
/// intermediate agent steps collapsed behind one summary row, then the
/// answer — the desktop/web turn treatment.
///
/// Holds one transcript's turns and what each derives from its rows, so a
/// revision re-derives only the turns [IncrementalTurnGroups] regrouped, and
/// an unchanged turn hands back the same row objects. Assembling the row list
/// still visits every row, by reference.
class TranscriptProjection {
  final IncrementalTurnGroups _groups = IncrementalTurnGroups();
  List<ChatTurn> _turns = const [];
  List<_TurnFacts> _facts = const [];
  List<ChatMessage>? _messages;
  bool? _turnInProgress;
  Set<String> _expandedTurns = const {};
  Set<String> _footerTurns = const {};
  List<TranscriptRow> _rows = const [];

  /// Rows handed to turn grouping so far.
  int get groupedMessageCount => _groups.groupedMessageCount;

  /// Turns whose derived facts (timer, tool results, step counts) were
  /// computed so far.
  int projectedTurnCount = 0;

  /// [footerTurns] are the turn keys that get a [TranscriptTurnFooterRow].
  List<TranscriptRow> rows({
    required List<ChatMessage> messages,
    required bool turnInProgress,
    required Set<String> expandedTurns,
    Set<String> footerTurns = const {},
  }) {
    if (identical(messages, _messages) &&
        turnInProgress == _turnInProgress &&
        setEquals(expandedTurns, _expandedTurns) &&
        setEquals(footerTurns, _footerTurns)) {
      return _rows;
    }
    _messages = messages;
    _turnInProgress = turnInProgress;
    // Callers mutate expansion in place; retain values, not their set.
    _expandedTurns = Set.of(expandedTurns);
    _footerTurns = Set.of(footerTurns);
    final turns = _groups.update(messages);
    if (!identical(turns, _turns)) {
      final previous = HashMap<ChatTurn, _TurnFacts>.identity();
      final byFirstRow = HashMap<ChatMessage, _TurnFacts>.identity();
      for (final facts in _facts) {
        previous[facts.turn] = facts;
        byFirstRow[_firstRow(facts.turn)] = facts;
      }
      _facts = [
        for (final turn in turns)
          previous[turn] ?? _project(turn, byFirstRow[_firstRow(turn)]),
      ];
      _turns = turns;
    }
    final rows = <TranscriptRow>[];
    TurnTimer? newestTimer;
    String? newestFooter;
    for (var index = 0; index < _facts.length; index += 1) {
      final facts = _facts[index];
      final isNewest = index == _facts.length - 1;
      if (isNewest) newestTimer = facts.timer;
      rows.addAll(
        facts.rows(
          isNewest: isNewest,
          turnInProgress: turnInProgress,
          expanded: expandedTurns.contains(facts.turn.key),
          expandedKeys: expandedTurns,
        ),
      );
      final key = facts.turn.key;
      if (key.isNotEmpty && footerTurns.contains(key)) {
        if (isNewest) {
          newestFooter = key;
        } else {
          rows.add(TranscriptTurnFooterRow(key));
        }
      }
    }
    // Without an authoritative timer part, retain the send/streaming bridge
    // as a bottom-of-transcript "Thinking" row.
    if (turnInProgress &&
        (newestTimer == null || newestTimer.completedAt != null)) {
      rows.add(const TranscriptTimerRow(null));
    }
    // The newest turn's footer follows that bridge, which belongs to it.
    if (newestFooter != null) rows.add(TranscriptTurnFooterRow(newestFooter));
    return _rows = rows;
  }

  /// Derives a regrouped turn. [replaced] is the turn it supersedes, if
  /// any, whose tool results are kept when unchanged so the turn's other
  /// rows stay equal while its live answer streams.
  _TurnFacts _project(ChatTurn turn, _TurnFacts? replaced) {
    projectedTurnCount += 1;
    final toolResults = _turnToolResults(turn);
    final previous = replaced?.toolResults;
    return _TurnFacts(
      turn,
      previous != null && mapEquals(previous, toolResults)
          ? previous
          : toolResults,
    );
  }

  static ChatMessage _firstRow(ChatTurn turn) =>
      turn.user ?? turn.assistantMessages.first;
}

/// What a turn's rows derive from its messages alone, and the rows it last
/// produced.
final class _TurnFacts {
  _TurnFacts(this.turn, this.toolResults)
    : timer = findNewestTurnTimer([
        ...turn.intermediate,
        ...turn.finalMessages,
      ]),
      isLive = turn.isLive;

  final ChatTurn turn;
  final TurnTimer? timer;
  final bool isLive;
  final Map<String, ToolCallResult> toolResults;
  late final List<TurnStepCount> stepCounts = turn.hasCollapsibleIntermediate
      ? summarizeTurnSteps(turn.intermediate)
      : const [];

  ({bool isNewest, bool turnInProgress, bool expanded, String openRuns})?
  _inputs;
  List<TranscriptRow> _rows = const [];

  /// Run keys the last build drew, so an opened run reads as a new input.
  List<String> _runKeys = const [];

  /// The turn's rows. Host liveness reaches only the newest turn.
  /// [expandedKeys] holds opened turns and run lines alike; the owner may
  /// mutate it in place, so only its members are read.
  List<TranscriptRow> rows({
    required bool isNewest,
    required bool turnInProgress,
    required bool expanded,
    Set<String> expandedKeys = const {},
  }) {
    String openRuns() =>
        [for (final key in _runKeys) expandedKeys.contains(key)].join();
    final inputs = (
      isNewest: isNewest,
      turnInProgress: isNewest && turnInProgress,
      expanded: expanded,
      openRuns: openRuns(),
    );
    if (inputs == _inputs) return _rows;
    _rows = _build(
      isNewest: isNewest,
      turnInProgress: turnInProgress,
      expanded: expanded,
      expandedKeys: expandedKeys,
    );
    _inputs = (
      isNewest: inputs.isNewest,
      turnInProgress: inputs.turnInProgress,
      expanded: expanded,
      openRuns: openRuns(),
    );
    return _rows;
  }

  /// Replies and step runs for [messages]. While [live], the last run keeps
  /// its newest steps in view under its line.
  void _addSegments(
    List<TranscriptRow> rows,
    List<ChatMessage> messages, {
    required bool live,
    required bool streamingSpinner,
    required Set<String> expandedKeys,
  }) {
    final segments = segmentTurn(messages, renderable: hasRenderableContent);
    for (final (index, segment) in segments.indexed) {
      switch (segment) {
        case MessageSegment(:final message, :final parts):
          rows.add(
            TranscriptMessageRow(
              message,
              toolResults: toolResults,
              streamingSpinner: streamingSpinner,
              parts: parts,
            ),
          );
        case RunSegment(:final key, :final steps, :final anchorMessageId):
          _runKeys.add(key);
          final tail = live && index == segments.length - 1;
          rows.add(
            TranscriptRunRow(
              key,
              steps,
              shownFrom: tail
                  ? (steps.length - recentStepCount).clamp(0, steps.length)
                  : steps.length,
              expanded: expandedKeys.contains(key),
              toolResults: toolResults,
              anchorMessageId: anchorMessageId,
            ),
          );
      }
    }
  }

  List<TranscriptRow> _build({
    required bool isNewest,
    required bool turnInProgress,
    required bool expanded,
    required Set<String> expandedKeys,
  }) {
    _runKeys = [];
    final timer = this.timer;
    final inProgress = isLive || (isNewest && turnInProgress);
    // Either the turn's live timer row or the bottom fallback row.
    final showsWorkingRow =
        (timer?.isLive ?? false) ||
        (isNewest &&
            turnInProgress &&
            (timer == null || timer.completedAt != null));
    final rows = <TranscriptRow>[];
    final user = turn.user;
    if (user != null && hasRenderableContent(user)) {
      rows.add(TranscriptMessageRow(user));
    }
    if (inProgress) {
      // Desktop parity: a running turn reads in transcript order, each run
      // of steps one line with its newest steps under it; it folds up and
      // applies the intermediate/final partition only when it completes.
      _addSegments(
        rows,
        turn.assistantMessages,
        live: true,
        streamingSpinner: !showsWorkingRow,
        expandedKeys: expandedKeys,
      );
    } else {
      final counts = stepCounts;
      final finished = timer?.completedAt == null ? null : timer;
      if (counts.isNotEmpty) {
        rows.add(
          TranscriptStepsRow(turn, counts, expanded: expanded, timer: finished),
        );
        if (expanded) {
          for (final message in turn.intermediate) {
            if (hasRenderableContent(message)) {
              rows.add(TranscriptMessageRow(message, toolResults: toolResults));
            }
          }
        }
      } else if (finished != null) {
        // A turn with nothing folded still says how long it took; its
        // header has nothing to open.
        rows.add(
          TranscriptStepsRow(turn, const [], expanded: false, timer: finished),
        );
      }
    }
    // An opened turn lists its folded steps above (its header already says
    // what they did); the replies it shows read like a running turn's.
    if (!inProgress) {
      _addSegments(
        rows,
        turn.finalMessages,
        live: false,
        streamingSpinner: true,
        expandedKeys: expandedKeys,
      );
      final response = turn.finalMessages
          .where(
            (message) =>
                message.role == ChatRole.assistant &&
                message.text.trim().isNotEmpty,
          )
          .lastOrNull;
      if (response != null) {
        rows.add(
          TranscriptResponseActionsRow(
            response,
            ResponseActionTarget(
              chatId: response.chatId,
              turnKey: turn.key,
              atMessageId: turn.assistantMessages.last.messageId,
            ),
          ),
        );
      }
    }
    // A running turn closes with its "Thinking" or waiting row. A finished
    // turn's duration reads in its steps header instead, as on desktop.
    if (timer != null && timer.completedAt == null) {
      rows.add(TranscriptTimerRow(timer, turnKey: turn.key));
    }
    return rows;
  }
}

/// Collects a turn's `tool_result` outcomes across every message, keyed by
/// `toolUseId` — the portal can project a call and its result as separate
/// messages.
Map<String, ToolCallResult> _turnToolResults(ChatTurn turn) {
  final results = <String, ToolCallResult>{};
  final messages = [?turn.user, ...turn.intermediate, ...turn.finalMessages];
  for (final message in messages) {
    for (final part in message.parts) {
      if (part.kind != 'tool_result') continue;
      final id = part.toolUseId;
      final output = part.toolOutput;
      if (id == null || id.isEmpty) continue;
      if (output == null && !part.isToolError) continue;
      results[id] = (content: output ?? 'Error', isError: part.isToolError);
    }
  }
  return results;
}

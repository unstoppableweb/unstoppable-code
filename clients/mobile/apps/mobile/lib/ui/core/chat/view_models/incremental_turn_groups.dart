import 'dart:collection';
import 'dart:math' as math;

import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/transcript_list.dart';
import 'package:mobile/ui/core/chat/view_models/turn_grouping.dart';

/// [groupChatTurns] across successive revisions of one transcript, regrouping
/// only from the first turn whose rows changed.
///
/// Rows are compared by identity: the transcript stores publish a new object
/// for every revision of a row and keep unchanged rows, so an identical row
/// is unchanged. Turns before the first changed row keep their objects. A
/// live answer streaming into the last turn therefore regroups that turn
/// alone, while an authoritative correction of an older row regroups from
/// that row's turn. Regrouped turns whose rows all survived (later turns
/// after a correction, every loaded turn after an older-history prepend) are
/// matched back to their previous objects, so their consumers can keep
/// derived state keyed on turn identity.
///
/// Store snapshots report the first changed position; other lists fall back
/// to identity comparisons. Grouping is limited to the changed suffix. The
/// desktop's `TurnGroupCache` keeps completed group identities the same way, but its
/// merge pipeline still regroups the whole transcript on every pass.
class IncrementalTurnGroups {
  List<ChatMessage> _messages = const [];
  List<ChatTurn> _turns = const [];

  /// Index in [_messages] of each turn's first row.
  List<int> _starts = const [];

  /// Rows handed to [groupChatTurns] so far.
  int groupedMessageCount = 0;

  /// The transcript's turns. Returns the previous list itself when no row
  /// changed.
  List<ChatTurn> update(List<ChatMessage> messages) {
    if (identical(messages, _messages)) return _turns;
    final previous = _messages;
    final limit = math.min(previous.length, messages.length);
    final knownChange = messages is TranscriptList<ChatMessage>
        ? messages.firstChangeSince(previous)
        : null;
    var unchanged = knownChange?.clamp(0, limit) ?? 0;
    if (knownChange == null) {
      while (unchanged < limit &&
          identical(previous[unchanged], messages[unchanged])) {
        unchanged += 1;
      }
    }

    // A turn is final once the row after it opens another turn, so a turn
    // ending at the first changed row is kept only when that row is a prompt
    // or the transcript ends there.
    var low = 0;
    var high = _turns.length;
    final boundaryClosed =
        unchanged == messages.length ||
        messages[unchanged].role == ChatRole.user;
    while (low < high) {
      final middle = (low + high) ~/ 2;
      final end = middle + 1 < _starts.length
          ? _starts[middle + 1]
          : previous.length;
      if (end < unchanged || (end == unchanged && boundaryClosed)) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    final kept = low;
    if (kept == _turns.length && unchanged == messages.length) {
      // Same rows in a new list: nothing to regroup.
      _messages = messages;
      return _turns;
    }

    // Every turn after the first starts at a prompt, so grouping from a kept
    // boundary yields exactly the full grouping's remaining turns.
    final start = kept < _starts.length
        ? _starts[kept]
        : (_turns.isEmpty ? 0 : previous.length);
    final regrouped = groupChatTurns(messages.sublist(start));
    groupedMessageCount += messages.length - start;

    final replaced = HashMap<ChatMessage, ChatTurn>.identity();
    for (final turn in _turns.skip(kept)) {
      replaced[_firstRow(turn)] = turn;
    }
    final turns = [..._turns.take(kept)];
    final starts = [..._starts.take(kept)];
    var position = start;
    for (final turn in regrouped) {
      final match = replaced[_firstRow(turn)];
      turns.add(match != null && _sameRows(match, turn) ? match : turn);
      starts.add(position);
      position += (turn.user == null ? 0 : 1) + turn.assistantMessages.length;
    }
    _messages = messages;
    _turns = List.unmodifiable(turns);
    _starts = starts;
    return _turns;
  }

  static ChatMessage _firstRow(ChatTurn turn) =>
      turn.user ?? turn.assistantMessages.first;

  /// Grouping is a function of a turn's rows, so equal rows mean an equal
  /// turn.
  static bool _sameRows(ChatTurn a, ChatTurn b) {
    if (!identical(a.user, b.user)) return false;
    final rows = a.assistantMessages;
    final other = b.assistantMessages;
    if (rows.length != other.length) return false;
    for (var index = 0; index < rows.length; index++) {
      if (!identical(rows[index], other[index])) return false;
    }
    return true;
  }
}

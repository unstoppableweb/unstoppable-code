import 'package:flutter/foundation.dart';
import 'package:mobile/device_link/chats/state.dart';
import 'package:mobile/device_link/chats/turn_ends.dart';

/// What the completion detector reads from the selected computer chat.
@immutable
final class TurnCompletionSample {
  const TurnCompletionSample({
    required this.chatKey,
    required this.chatId,
    required this.online,
    required this.running,
    required this.timerOwner,
    required this.timerCompleted,
    required this.tab,
  });

  /// The chat's scope-qualified key; a different key is a different chat.
  final String chatKey;
  final String chatId;
  final bool online;
  final bool running;

  /// The user message id that opened the turn of the newest turn timer.
  final String? timerOwner;
  final bool timerCompleted;
  final Map<String, dynamic> tab;
}

/// Samples [state] for the detector, or null when no chat is selected.
TurnCompletionSample? deviceTurnCompletionSample({
  required bool online,
  required DeviceChatState? state,
}) {
  if (state == null) return null;
  Map<String, dynamic>? timer;
  for (final message in state.messages.reversed) {
    timer = message.blocks.where((b) => b['type'] == 'turn_timer').lastOrNull;
    if (timer != null) break;
  }
  final owner = timer?['userMessageId'];
  return TurnCompletionSample(
    chatKey: state.ref.key,
    chatId: state.ref.id,
    online: online,
    running: state.running,
    timerOwner: owner is String ? owner : null,
    timerCompleted: timer?['completedAt'] is num,
    tab: state.tab,
  );
}

/// Decides, sample by sample, when a turn this client watched run has
/// completed successfully. A turn counts once it was seen running (its newest
/// timer live), the chat is idle, the timer is completed, and the desktop
/// recorded a `completed` outcome with no abnormal end. The outcome record
/// can land after the chat goes idle, so every sample re-checks.
///
/// A chat opened already idle, a switch to another chat, and a state replayed
/// after a disconnect never count: switching chats and going offline forget
/// which turns were seen running. Each turn is reported at most once.
final class TurnCompletionDetector {
  static const int _maxReported = 256;

  String? _chatKey;
  final _seenRunning = <String>{};
  final _reported = <String>{};

  /// Returns the owner of the turn that just completed, if any.
  String? observe(TurnCompletionSample? sample) {
    if (sample?.chatKey != _chatKey) {
      _chatKey = sample?.chatKey;
      _seenRunning.clear();
    }
    if (sample == null) return null;
    if (!sample.online) {
      _seenRunning.clear();
      return null;
    }
    final owner = sample.timerOwner;
    if (owner == null) return null;
    if (sample.running) {
      if (!sample.timerCompleted) _seenRunning.add(owner);
      return null;
    }
    if (!sample.timerCompleted || !_seenRunning.contains(owner)) return null;
    if (deviceTurnOutcome(sample.tab, owner) != 'completed' ||
        deviceTurnEndReasons(sample.tab).containsKey(owner)) {
      return null;
    }
    _seenRunning.remove(owner);
    if (!_reported.add('${sample.chatKey}\n$owner')) return null;
    if (_reported.length > _maxReported) _reported.remove(_reported.first);
    return owner;
  }
}

/// Feeds [source]'s changes through a [TurnCompletionDetector] and reports
/// each successful turn as `computer:<chatId>:<owner>`.
final class TurnCompletionWatcher {
  TurnCompletionWatcher({
    required this._source,
    required this._read,
    required this._onSuccessfulTurn,
  }) {
    _source.addListener(_sample);
    _sample();
  }

  final Listenable _source;
  final TurnCompletionSample? Function() _read;
  final void Function(String turnKey) _onSuccessfulTurn;
  final _detector = TurnCompletionDetector();
  bool _disposed = false;

  void _sample() {
    if (_disposed) return;
    final sample = _read();
    final owner = _detector.observe(sample);
    if (sample != null && owner != null) {
      _onSuccessfulTurn('computer:${sample.chatId}:$owner');
    }
  }

  void dispose() {
    _disposed = true;
    _source.removeListener(_sample);
  }
}

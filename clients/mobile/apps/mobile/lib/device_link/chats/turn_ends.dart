/// How each abnormally ended turn in a desktop chat tab ended, keyed by the
/// turn's user message id: `failed`, `cancelled` or `interrupted`. Follows the
/// desktop projection's precedence (`persisted-chat-projection.ts`): the
/// recorded `turnEnds` outcome, else the `unacceptedTurnEnds` entry, when
/// either is failed or cancelled; else `interrupted` when an app restart
/// interrupted the turn. Malformed maps contribute nothing.
Map<String, String> deviceTurnEndReasons(Map<String, dynamic> tab) {
  final ends = _map(tab['turnEnds']);
  final unaccepted = _map(tab['unacceptedTurnEnds']);
  final interrupted = _map(tab['interruptedTurns']);
  final reasons = <String, String>{};
  for (final owner in {...ends.keys, ...unaccepted.keys, ...interrupted.keys}) {
    final end = ends[owner];
    final recorded = end is Map && end['outcome'] != null
        ? end['outcome']
        : unaccepted[owner];
    if (recorded case final String reason
        when reason == 'failed' || reason == 'cancelled') {
      reasons[owner] = reason;
    } else if (interrupted[owner] != null) {
      reasons[owner] = 'interrupted';
    }
  }
  return reasons;
}

/// The recorded outcome of the turn [owner] opened (`completed`, `failed` or
/// `cancelled`), or null while none is recorded.
String? deviceTurnOutcome(Map<String, dynamic> tab, String owner) {
  final end = _map(tab['turnEnds'])[owner];
  final outcome = end is Map ? end['outcome'] : null;
  return outcome is String ? outcome : null;
}

Map<String, Object?> _map(Object? value) => value is Map
    ? {
        for (final entry in value.entries)
          if (entry.key is String) entry.key as String: entry.value,
      }
    : const {};

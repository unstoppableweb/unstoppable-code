import 'dart:async';

import 'package:computer_connect_core/computer_connect_core.dart';
import 'package:mobile/device_link/rust_core/failures.dart';

/// Waits until a view stream reached the revision a settled intent reports,
/// so a caller that awaited the intent reads its effect (read-your-writes).
///
/// Its owner follows the stream with [ended] as both its `onError` and its
/// `onDone`: a service's views end with its account scope or the core, and
/// no wait may outlive them.
final class ViewRevisions {
  ViewRevisions({this.current = 0});

  /// The revision the last view showed.
  int current;
  final _waiting = <(int, Completer<void>)>[];
  Object? _failure;

  void reached(int revision) {
    current = revision;
    _waiting.removeWhere((w) {
      if (w.$1 > revision) return false;
      w.$2.complete();
      return true;
    });
  }

  Future<void> wait(int revision) {
    if (_failure case final failure?) return Future.error(failure);
    if (revision <= current) return Future.value();
    final done = Completer<void>();
    _waiting.add((revision, done));
    return done.future;
  }

  /// The views ended, or failed with [error]: no further view arrives.
  void ended([Object? error]) => fail(switch (error) {
    null => rustFailure(viewsEnded),
    final CoreFailure failure => rustFailure(failure),
    final other => other,
  });

  /// Fails every pending and later [wait] with [failure], or with the
  /// failure an earlier call gave.
  void fail(Object failure) {
    final first = _failure ??= failure;
    for (final (_, done) in _waiting) {
      done.completeError(first);
    }
    _waiting.clear();
  }
}

import 'package:mobile/data/models/computer_activity/pr_status.dart';

/// Wire `RemoteControlPrMergeQueuePhase`: a queued PR's GitHub merge queue entry
/// state. [unknown] also covers a phase string this build does not know.
enum RemotePrMergeQueuePhase {
  queued,
  awaitingChecks,
  mergeable,
  locked,
  unmergeable,
  unknown;

  static RemotePrMergeQueuePhase? fromWire(Object? value) => value is! String
      ? null
      : switch (value) {
          'queued' => queued,
          'awaiting_checks' => awaitingChecks,
          'mergeable' => mergeable,
          'locked' => locked,
          'unmergeable' => unmergeable,
          _ => unknown,
        };
}

/// `lastKnownPrStatus.repos[].status.mergeQueue`. The Portal omits it while
/// membership is unknown, so absence never means "not queued".
class RemotePrMergeQueue {
  const RemotePrMergeQueue({required this.inQueue, this.position, this.phase});

  final bool inQueue;

  /// 1-based queue position, when GitHub reports one.
  final int? position;

  /// Only describes a queued PR; absent on older desktops.
  final RemotePrMergeQueuePhase? phase;

  /// Null for a missing or malformed value.
  static RemotePrMergeQueue? tryParse(Object? raw) {
    if (raw is! Map<String, dynamic>) return null;
    final inQueue = raw['inQueue'];
    if (inQueue is! bool) return null;
    final position = raw['position'];
    return RemotePrMergeQueue(
      inQueue: inQueue,
      position: position is num ? position.toInt() : null,
      phase: inQueue ? RemotePrMergeQueuePhase.fromWire(raw['phase']) : null,
    );
  }
}

/// Whether [candidate] is the same pull request as [pr]: the same URL, or
/// the same number when [pr] has no URL. PR numbers repeat across
/// repositories, so a URL is the stronger key.
bool isSameRemotePr(RemoteWorktreePr pr, RemoteWorktreePr candidate) {
  final url = pr.url;
  if (url != null && url.isNotEmpty) return candidate.url == url;
  return pr.prNumber != null && candidate.prNumber == pr.prNumber;
}

/// Live `pr_status` updates carry no queue fields; worktree rows are the
/// only source. An open or draft [incoming] PR without a queue value keeps
/// the matching [previous] row PR's value. Merged and closed PRs drop it.
List<RemoteWorktreePr> carryOverMergeQueue(
  List<RemoteWorktreePr> previous,
  List<RemoteWorktreePr> incoming,
) => [for (final pr in incoming) _carryOver(previous, pr)];

RemoteWorktreePr _carryOver(
  List<RemoteWorktreePr> previous,
  RemoteWorktreePr pr,
) {
  if (pr.mergeQueue != null || (pr.state != 'open' && pr.state != 'draft')) {
    return pr;
  }
  final queue = previous
      .where((old) => isSameRemotePr(pr, old))
      .firstOrNull
      ?.mergeQueue;
  return queue == null ? pr : pr.withMergeQueue(queue);
}

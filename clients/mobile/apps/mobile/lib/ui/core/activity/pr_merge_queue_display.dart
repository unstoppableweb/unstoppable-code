/// Shared with Remote Control. Computer Connect uses the Rust port in
/// cc-domain::activity (display) with its words in cc-app copy::activity;
/// keep both in step until cleanup C5.
library;

import 'package:mobile/data/models/computer_activity/pr_merge_queue.dart';
import 'package:mobile/data/models/computer_activity/pr_status.dart';

/// Pure presentation rules for a PR in GitHub's merge queue (CAN-4454),
/// matching the shared desktop/web worktree row (`WorktreeRow.tsx`,
/// `sidebar-model.ts`). Queue membership never reads as merged.

/// The shared row's phase copy; none for an unknown or absent phase.
String? mergeQueuePhaseLabel(RemotePrMergeQueuePhase? phase) => switch (phase) {
  RemotePrMergeQueuePhase.queued => 'Waiting in queue',
  RemotePrMergeQueuePhase.awaitingChecks => 'Awaiting queue checks',
  RemotePrMergeQueuePhase.mergeable => 'Queue checks passed',
  RemotePrMergeQueuePhase.locked => 'Locked for merge',
  RemotePrMergeQueuePhase.unmergeable => "Can't merge from queue",
  RemotePrMergeQueuePhase.unknown || null => null,
};

/// The row's queue state. One PR carries its own position and phase. With
/// several repositories, the row is queued only when every open PR is, and
/// the summary has no position or phase because those are per PR.
RemotePrMergeQueue? worktreeRowMergeQueue(List<RemoteWorktreePr> statuses) {
  final open = statuses.where(
    (pr) => pr.state == 'open' || pr.state == 'draft',
  );
  if (open.isEmpty || !open.every((pr) => pr.isInMergeQueue)) return null;
  return statuses.length == 1
      ? open.single.mergeQueue
      : const RemotePrMergeQueue(inQueue: true);
}

/// Appended to the row's `PR #N` badge.
String mergeQueueBadgeLabel(RemotePrMergeQueue queue) =>
    queue.position == null ? 'Queued' : 'Queued #${queue.position}';

/// Tooltip and screen-reader label for the row's queue glyph.
String mergeQueueSemanticsLabel(RemotePrMergeQueue queue) {
  final position = queue.position == null
      ? 'In merge queue'
      : 'In merge queue, position ${queue.position}';
  final phase = mergeQueuePhaseLabel(queue.phase);
  return phase == null ? position : '$position. $phase';
}

/// The Pull Requests card's detail line, without the unknown parts.
String? mergeQueueDetail(RemotePrMergeQueue queue) {
  final parts = [
    if (queue.position case final position?) 'Position #$position',
    ?mergeQueuePhaseLabel(queue.phase),
  ];
  return parts.isEmpty ? null : parts.join(' · ');
}

/// `get_actions` statuses carry no queue fields, so an action's PR reads its
/// queue state from the live worktree row's matching PR.
RemotePrMergeQueue? mergeQueueForActionPr(
  RemoteWorktreePr pr,
  List<RemoteWorktreePr> rowStatuses,
) {
  if (pr.state != 'open') return null;
  final row = rowStatuses.where((row) => isSameRemotePr(pr, row)).firstOrNull;
  return row != null && row.isInMergeQueue ? row.mergeQueue : null;
}

/// Feedback for a Merge whose result added PRs to the merge queue
/// (`mergedRepos[].status == 'enqueued'`); null when it added none.
String? mergeEnqueuedMessage(Map<String, dynamic> result) {
  final repos = result['mergedRepos'];
  if (repos is! List) return null;
  final enqueued = [
    for (final repo in repos)
      if (repo case {'status': 'enqueued', 'prNumber': final num number})
        (number: number.toInt(), position: repo['queuePosition']),
  ];
  if (enqueued.length > 1) {
    return 'Added ${enqueued.length} pull requests to the merge queue.';
  }
  return switch (enqueued.firstOrNull) {
    null => null,
    (:final number, position: final num position) =>
      'Added #$number to the merge queue (position ${position.toInt()}).',
    (:final number, position: _) => 'Added #$number to the merge queue.',
  };
}

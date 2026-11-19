import 'pr_check.dart';
import 'pr_merge_queue.dart';

class RemoteWorktreePr {
  const RemoteWorktreePr({
    this.repoId,
    this.lookupAvailable = true,
    this.prNumber,
    this.url,
    required this.state,
    this.title,
    this.baseRefName,
    this.checkStatus,
    this.checks = const [],
    this.reviewStatus,
    this.mergeReady,
    this.hasConflicts,
    this.commentCount,
    this.unresolvedReviewThreadCount,
    this.mergeQueue,
  });

  final String? repoId;

  /// False only in incoming partial observations. The session store retains
  /// that repository's previous PR instead of publishing this placeholder.
  final bool lookupAvailable;
  final int? prNumber;
  final String? url;

  factory RemoteWorktreePr.fromRemoteControl(
    Map<String, dynamic> json, {
    String? repoId,
  }) => RemoteWorktreePr(
    repoId: repoId,
    prNumber: (json['number'] as num?)?.toInt(),
    url: json['url'] as String?,
    state: json['state'] as String? ?? '',
    title: json['title'] as String?,
    baseRefName: json['baseRefName'] as String?,
    checkStatus: json['checkStatus'] as String?,
    checks: RemotePrCheck.listFromJson(json['checkDetails']),
    reviewStatus: switch (json['reviewStatus'] as String?) {
      'none' => null,
      'changes_requested' => 'changes-requested',
      final value => value,
    },
    mergeReady: json['mergeReady'] as bool?,
    hasConflicts: json['hasConflicts'] as bool?,
    commentCount: (json['commentCount'] as num?)?.toInt(),
    unresolvedReviewThreadCount: (json['unresolvedReviewThreadCount'] as num?)
        ?.toInt(),
  );

  /// Wire `'open' | 'merged' | 'closed' | 'draft'` (open set).
  final String state;
  final String? title;
  final String? baseRefName;

  /// Aggregate CI state: `'passing' | 'failing' | 'pending' | 'neutral' |
  /// 'none'` (open set).
  final String? checkStatus;

  /// Every CI check in the desktop's (name) order. Empty when the PR has no
  /// checks or the data came from `lastKnownPrStatus`.
  final List<RemotePrCheck> checks;

  /// Review state: `'approved' | 'changes-requested' | 'pending'` (open
  /// set). Wire `'none'` is normalized to null — the contract says readers
  /// treat absent and `'none'` identically.
  final String? reviewStatus;

  /// Host mergeability, independent of aggregate checks and reviews.
  final bool? mergeReady;
  final bool? hasConflicts;
  final int? commentCount;

  /// Count of unresolved review threads. When present it supersedes
  /// [commentCount] for attention badges — resolved comments are not
  /// actionable (desktop/web portal-badge parity).
  final int? unresolvedReviewThreadCount;

  /// GitHub merge queue state. Only worktree rows carry it; null means
  /// unknown, and live `pr_status` updates keep the row's value
  /// ([carryOverMergeQueue]).
  final RemotePrMergeQueue? mergeQueue;

  /// Queue membership applies only to an open PR: merged and closed states
  /// win over a stale queue value.
  bool get isInMergeQueue => state == 'open' && mergeQueue?.inQueue == true;

  /// Overview summaries omit check rows and host merge readiness. Keep them
  /// only for the same PR and aggregate result.
  RemoteWorktreePr inheritChecks(RemoteWorktreePr previous) {
    if (checks.isNotEmpty ||
        url == null ||
        url != previous.url ||
        state != previous.state ||
        checkStatus != previous.checkStatus) {
      return this;
    }
    return RemoteWorktreePr(
      repoId: repoId,
      lookupAvailable: lookupAvailable,
      prNumber: prNumber,
      url: url,
      state: state,
      title: title,
      baseRefName: baseRefName ?? previous.baseRefName,
      checkStatus: checkStatus,
      checks: previous.checks,
      reviewStatus: reviewStatus,
      mergeReady: mergeReady ?? previous.mergeReady,
      hasConflicts: hasConflicts,
      commentCount: commentCount,
      unresolvedReviewThreadCount: unresolvedReviewThreadCount,
      mergeQueue: mergeQueue,
    );
  }

  RemoteWorktreePr withMergeQueue(RemotePrMergeQueue? mergeQueue) =>
      RemoteWorktreePr(
        repoId: repoId,
        lookupAvailable: lookupAvailable,
        prNumber: prNumber,
        url: url,
        state: state,
        title: title,
        baseRefName: baseRefName,
        checkStatus: checkStatus,
        checks: checks,
        reviewStatus: reviewStatus,
        mergeReady: mergeReady,
        hasConflicts: hasConflicts,
        commentCount: commentCount,
        unresolvedReviewThreadCount: unresolvedReviewThreadCount,
        mergeQueue: mergeQueue,
      );
}

/// Semantic equality across action reads, pushed observations and overview rows.
/// Single-repo producers may use different repository aliases for the same PR.
bool sameRemotePrStatuses(
  List<RemoteWorktreePr>? a,
  List<RemoteWorktreePr>? b,
) {
  if (identical(a, b)) return true;
  if (a == null || b == null || a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    final left = a[i];
    final right = b[i];
    if ((a.length > 1 && left.repoId != right.repoId) ||
        _prObservation(left) != _prObservation(right) ||
        left.checks.length != right.checks.length) {
      return false;
    }
    for (var j = 0; j < left.checks.length; j++) {
      final x = left.checks[j];
      final y = right.checks[j];
      if ((x.name, x.status, x.executionState, x.detailsUri) !=
          (y.name, y.status, y.executionState, y.detailsUri)) {
        return false;
      }
    }
  }
  return true;
}

Record _prObservation(RemoteWorktreePr pr) => (
  pr.prNumber,
  pr.url,
  pr.state,
  pr.baseRefName,
  pr.title,
  pr.checkStatus,
  pr.reviewStatus,
  pr.mergeReady,
  pr.hasConflicts,
  pr.commentCount,
  pr.unresolvedReviewThreadCount,
  pr.lookupAvailable,
  pr.mergeQueue?.inQueue,
  pr.mergeQueue?.phase,
  pr.mergeQueue?.position,
);

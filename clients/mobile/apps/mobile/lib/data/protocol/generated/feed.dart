// dart format off
// GENERATED FILE. Do not edit by hand.
// Maintainer-generated API bindings; verify with the adjacent public digest manifest.

/// Parses a JSON list, skipping any element this build cannot decode.
///
/// These collections are `required` on their parent, so letting one bad
/// element throw would fail the entire response. Dropping the row degrades
/// a single table instead of blanking every surface that shares the payload.
List<T> _parseList<T>(dynamic json, T Function(dynamic) parse) {
  final out = <T>[];
  for (final e in json as List<dynamic>) {
    try {
      out.add(parse(e));
    } catch (_) {
      // Unparseable row: skip it rather than failing the whole response.
      continue;
    }
  }
  return List<T>.of(out, growable: false);
}

/// Who a feed item is attributed to. Resolved server-side from the row's `ownerUserId` / `createdByUserId`. `displayName` is null when the user can no longer be resolved (e.g. removed from the org).
class FeedActor {
  const FeedActor({this.displayName, required this.userId});

  final String? displayName;
  final String userId;

  factory FeedActor.fromJson(Map<String, dynamic> json) => FeedActor(
        displayName: json['displayName'] as String?,
        userId: json['userId'] as String,
      );
}

/// The feed item types.  [wire] is the serialized discriminator.
enum FeedItemType {
  prOpened('pr_opened'),
  prMerged('pr_merged'),
  planApproved('plan_approved'),
  planShared('plan_shared'),
  planUpdated('plan_updated'),
  runShared('run_shared'),
  worktreeStarted('worktree_started'),
  worktreeUpdated('worktree_updated'),
  agentSession('agent_session'),
  pipelineRun('pipeline_run'),
  runFailed('run_failed'),
  ;

  const FeedItemType(this.wire);

  final String wire;

  static FeedItemType fromWire(String wire) => values.firstWhere(
        (t) => t.wire == wire,
        orElse: () => throw FormatException('Unknown FeedItem type: $wire'),
      );
}

/// Fields common to every feed item, plus a discriminator-dispatching parser.
/// Each concrete variant supplies its own [type] via the overridden getter.
sealed class FeedItem {
  FeedItem({
    required this.actor,
    required this.id,
    required this.occurredAt,
    this.worktreeId,
  });

  final FeedActor actor;
  /// Stable, shareable permalink id. Unique within a scope.
  final String id;
  /// ISO-8601 instant used for newest-first ordering.
  final String occurredAt;
  /// Server `Worktree.externalId` this item belongs to, when applicable.
  final String? worktreeId;

  /// The discriminator identifying this item's concrete variant.
  FeedItemType get type;

  /// Parses any feed item by dispatching on the `type` discriminator.
  factory FeedItem.fromJson(Map<String, dynamic> json) {
    final type = FeedItemType.fromWire(json['type'] as String);
    return switch (type) {
      FeedItemType.prOpened => PrOpenedFeedItem.fromJson(json),
      FeedItemType.prMerged => PrMergedFeedItem.fromJson(json),
      FeedItemType.planApproved => PlanApprovedFeedItem.fromJson(json),
      FeedItemType.planShared => PlanSharedFeedItem.fromJson(json),
      FeedItemType.planUpdated => PlanUpdatedFeedItem.fromJson(json),
      FeedItemType.runShared => RunSharedFeedItem.fromJson(json),
      FeedItemType.worktreeStarted => WorktreeStartedFeedItem.fromJson(json),
      FeedItemType.worktreeUpdated => WorktreeUpdatedFeedItem.fromJson(json),
      FeedItemType.agentSession => AgentSessionFeedItem.fromJson(json),
      FeedItemType.pipelineRun => PipelineRunFeedItem.fromJson(json),
      FeedItemType.runFailed => RunFailedFeedItem.fromJson(json),
    };
  }
}

/// Reads the [FeedItem] base fields shared by every variant's `fromJson`.
({FeedActor actor, String id, String occurredAt, String? worktreeId}) _base(
  Map<String, dynamic> j,
) =>
    (
      actor: FeedActor.fromJson(j['actor'] as Map<String, dynamic>),
      id: j['id'] as String,
      occurredAt: j['occurredAt'] as String,
      worktreeId: j['worktreeId'] as String?,
    );

final class PrOpenedFeedItem extends FeedItem {
  PrOpenedFeedItem({
    required super.actor,
    required super.id,
    required super.occurredAt,
    super.worktreeId,
    this.branchName,
    required this.checkStatus,
    required this.commentCount,
    required this.hasConflicts,
    required this.prNumber,
    required this.prUrl,
    required this.repoName,
    required this.reviewStatus,
    this.summary,
    required this.title,
  });

  @override
  FeedItemType get type => FeedItemType.prOpened;

  final String? branchName;
  final String checkStatus;
  final num commentCount;
  final bool hasConflicts;
  final num prNumber;
  final String prUrl;
  final String repoName;
  final String reviewStatus;
  final String? summary;
  final String title;

  factory PrOpenedFeedItem.fromJson(Map<String, dynamic> j) {
    final b = _base(j);
    return PrOpenedFeedItem(
      actor: b.actor,
      id: b.id,
      occurredAt: b.occurredAt,
      worktreeId: b.worktreeId,
      branchName: j['branchName'] as String?,
      checkStatus: j['checkStatus'] as String,
      commentCount: (j['commentCount'] as num?) ?? 0,
      hasConflicts: j['hasConflicts'] as bool,
      prNumber: (j['prNumber'] as num?) ?? 0,
      prUrl: j['prUrl'] as String,
      repoName: j['repoName'] as String,
      reviewStatus: j['reviewStatus'] as String,
      summary: j['summary'] as String?,
      title: j['title'] as String,
    );
  }
}

final class PrMergedFeedItem extends FeedItem {
  PrMergedFeedItem({
    required super.actor,
    required super.id,
    required super.occurredAt,
    super.worktreeId,
    this.additions,
    this.branchName,
    this.changedFiles,
    this.deletions,
    required this.models,
    this.planId,
    this.planTitle,
    required this.prNumber,
    required this.prUrl,
    required this.repoName,
    this.runUrl,
    this.sharedPlanId,
    this.summary,
    required this.title,
    this.totalCostUsd,
    this.totalTokens,
  });

  @override
  FeedItemType get type => FeedItemType.prMerged;

  /// Diff stats (CAN-373 F1).
  final num? additions;
  final String? branchName;
  final num? changedFiles;
  final num? deletions;
  /// All distinct models used for the actual work, most-recently-used first. Empty when no primary-work turn was correlated.
  final List<String> models;
  final String? planId;
  /// Human-readable title of the correlated plan, for the plan chip.
  final String? planTitle;
  final num prNumber;
  final String prUrl;
  final String repoName;
  final String? runUrl;
  /// Collaborative `/plans/{id}` link, when the plan was shared.
  final String? sharedPlanId;
  final String? summary;
  final String title;
  /// Enrichment from the worktree's agent activity, when derivable.
  final num? totalCostUsd;
  final num? totalTokens;

  factory PrMergedFeedItem.fromJson(Map<String, dynamic> j) {
    final b = _base(j);
    return PrMergedFeedItem(
      actor: b.actor,
      id: b.id,
      occurredAt: b.occurredAt,
      worktreeId: b.worktreeId,
      additions: j['additions'] as num?,
      branchName: j['branchName'] as String?,
      changedFiles: j['changedFiles'] as num?,
      deletions: j['deletions'] as num?,
      models: (j['models'] as List<dynamic>).cast<String>(),
      planId: j['planId'] as String?,
      planTitle: j['planTitle'] as String?,
      prNumber: (j['prNumber'] as num?) ?? 0,
      prUrl: j['prUrl'] as String,
      repoName: j['repoName'] as String,
      runUrl: j['runUrl'] as String?,
      sharedPlanId: j['sharedPlanId'] as String?,
      summary: j['summary'] as String?,
      title: j['title'] as String,
      totalCostUsd: j['totalCostUsd'] as num?,
      totalTokens: j['totalTokens'] as num?,
    );
  }
}

final class PlanApprovedFeedItem extends FeedItem {
  PlanApprovedFeedItem({
    required super.actor,
    required super.id,
    required super.occurredAt,
    super.worktreeId,
    required this.planId,
    this.planVersion,
    this.reviewStatus,
    required this.title,
  });

  @override
  FeedItemType get type => FeedItemType.planApproved;

  final String planId;
  final num? planVersion;
  final String? reviewStatus;
  final String title;

  factory PlanApprovedFeedItem.fromJson(Map<String, dynamic> j) {
    final b = _base(j);
    return PlanApprovedFeedItem(
      actor: b.actor,
      id: b.id,
      occurredAt: b.occurredAt,
      worktreeId: b.worktreeId,
      planId: j['planId'] as String,
      planVersion: j['planVersion'] as num?,
      reviewStatus: j['reviewStatus'] as String?,
      title: j['title'] as String,
    );
  }
}

final class PlanSharedFeedItem extends FeedItem {
  PlanSharedFeedItem({
    required super.actor,
    required super.id,
    required super.occurredAt,
    super.worktreeId,
    required this.shareScope,
    required this.sharedPlanId,
    required this.title,
  });

  @override
  FeedItemType get type => FeedItemType.planShared;

  final String shareScope;
  final String sharedPlanId;
  final String title;

  factory PlanSharedFeedItem.fromJson(Map<String, dynamic> j) {
    final b = _base(j);
    return PlanSharedFeedItem(
      actor: b.actor,
      id: b.id,
      occurredAt: b.occurredAt,
      worktreeId: b.worktreeId,
      shareScope: j['shareScope'] as String,
      sharedPlanId: j['sharedPlanId'] as String,
      title: j['title'] as String,
    );
  }
}

final class PlanUpdatedFeedItem extends FeedItem {
  PlanUpdatedFeedItem({
    required super.actor,
    required super.id,
    required super.occurredAt,
    super.worktreeId,
    this.remoteRevisionNumber,
    required this.shareScope,
    required this.sharedPlanId,
    required this.title,
  });

  @override
  FeedItemType get type => FeedItemType.planUpdated;

  final num? remoteRevisionNumber;
  final String shareScope;
  final String sharedPlanId;
  final String title;

  factory PlanUpdatedFeedItem.fromJson(Map<String, dynamic> j) {
    final b = _base(j);
    return PlanUpdatedFeedItem(
      actor: b.actor,
      id: b.id,
      occurredAt: b.occurredAt,
      worktreeId: b.worktreeId,
      remoteRevisionNumber: j['remoteRevisionNumber'] as num?,
      shareScope: j['shareScope'] as String,
      sharedPlanId: j['sharedPlanId'] as String,
      title: j['title'] as String,
    );
  }
}

final class RunSharedFeedItem extends FeedItem {
  RunSharedFeedItem({
    required super.actor,
    required super.id,
    required super.occurredAt,
    super.worktreeId,
    this.model,
    required this.shareScope,
    required this.sharedRunId,
    required this.status,
    required this.title,
    required this.toolUseCount,
    this.totalCostUsd,
    required this.turnCount,
  });

  @override
  FeedItemType get type => FeedItemType.runShared;

  /// Model of the session, when known.
  final String? model;
  final String shareScope;
  final String sharedRunId;
  /// Terminal status of the shared session (drives the card badge).
  final String status;
  final String title;
  /// Number of tool invocations across the session's turns.
  final num toolUseCount;
  /// Total cost of the session in USD, when recorded.
  final num? totalCostUsd;
  /// Number of turns in the shared session.
  final num turnCount;

  factory RunSharedFeedItem.fromJson(Map<String, dynamic> j) {
    final b = _base(j);
    return RunSharedFeedItem(
      actor: b.actor,
      id: b.id,
      occurredAt: b.occurredAt,
      worktreeId: b.worktreeId,
      model: j['model'] as String?,
      shareScope: j['shareScope'] as String,
      sharedRunId: j['sharedRunId'] as String,
      status: j['status'] as String,
      title: j['title'] as String,
      toolUseCount: (j['toolUseCount'] as num?) ?? 0,
      totalCostUsd: j['totalCostUsd'] as num?,
      turnCount: (j['turnCount'] as num?) ?? 0,
    );
  }
}

final class WorktreeStartedFeedItem extends FeedItem {
  WorktreeStartedFeedItem({
    required super.actor,
    required super.id,
    required super.occurredAt,
    super.worktreeId,
    required this.branchName,
    this.workspaceName,
  });

  @override
  FeedItemType get type => FeedItemType.worktreeStarted;

  final String branchName;
  final String? workspaceName;

  factory WorktreeStartedFeedItem.fromJson(Map<String, dynamic> j) {
    final b = _base(j);
    return WorktreeStartedFeedItem(
      actor: b.actor,
      id: b.id,
      occurredAt: b.occurredAt,
      worktreeId: b.worktreeId,
      branchName: j['branchName'] as String,
      workspaceName: j['workspaceName'] as String?,
    );
  }
}

final class WorktreeUpdatedFeedItem extends FeedItem {
  WorktreeUpdatedFeedItem({
    required super.actor,
    required super.id,
    required super.occurredAt,
    super.worktreeId,
    required this.branchName,
    this.summary,
  });

  @override
  FeedItemType get type => FeedItemType.worktreeUpdated;

  final String branchName;
  /// Latest synced summary; updated in place as the worktree evolves.
  final String? summary;

  factory WorktreeUpdatedFeedItem.fromJson(Map<String, dynamic> j) {
    final b = _base(j);
    return WorktreeUpdatedFeedItem(
      actor: b.actor,
      id: b.id,
      occurredAt: b.occurredAt,
      worktreeId: b.worktreeId,
      branchName: j['branchName'] as String,
      summary: j['summary'] as String?,
    );
  }
}

final class AgentSessionFeedItem extends FeedItem {
  AgentSessionFeedItem({
    required super.actor,
    required super.id,
    required super.occurredAt,
    super.worktreeId,
    required this.clientChatId,
    this.latestModel,
    required this.latestStatus,
    this.toolUseCount,
    this.totalCostUsd,
    this.transcriptSessionId,
    required this.turnCount,
  });

  @override
  FeedItemType get type => FeedItemType.agentSession;

  final String clientChatId;
  final String? latestModel;
  /// Latest turn status in the session (drives the card badge).
  final String latestStatus;
  /// Number of tool invocations across the session's turns.
  final num? toolUseCount;
  final num? totalCostUsd;
  /// The canonical organization transcript session ID, set only for an organization owner with the transcript browser on when the session has a shared transcript. Absent otherwise; older clients ignore it.
  final String? transcriptSessionId;
  final num turnCount;

  factory AgentSessionFeedItem.fromJson(Map<String, dynamic> j) {
    final b = _base(j);
    return AgentSessionFeedItem(
      actor: b.actor,
      id: b.id,
      occurredAt: b.occurredAt,
      worktreeId: b.worktreeId,
      clientChatId: j['clientChatId'] as String,
      latestModel: j['latestModel'] as String?,
      latestStatus: j['latestStatus'] as String,
      toolUseCount: j['toolUseCount'] as num?,
      totalCostUsd: j['totalCostUsd'] as num?,
      transcriptSessionId: j['transcriptSessionId'] as String?,
      turnCount: (j['turnCount'] as num?) ?? 0,
    );
  }
}

final class PipelineRunFeedItem extends FeedItem {
  PipelineRunFeedItem({
    required super.actor,
    required super.id,
    required super.occurredAt,
    super.worktreeId,
    this.agentStepCount,
    this.completedAt,
    this.jobCount,
    required this.pipelineId,
    required this.pipelineName,
    this.retryCount,
    this.runDurationMs,
    required this.startedAt,
    required this.status,
    this.stepCount,
  });

  @override
  FeedItemType get type => FeedItemType.pipelineRun;

  final num? agentStepCount;
  final String? completedAt;
  final num? jobCount;
  final String pipelineId;
  final String pipelineName;
  final num? retryCount;
  final num? runDurationMs;
  final String startedAt;
  final String status;
  final num? stepCount;

  factory PipelineRunFeedItem.fromJson(Map<String, dynamic> j) {
    final b = _base(j);
    return PipelineRunFeedItem(
      actor: b.actor,
      id: b.id,
      occurredAt: b.occurredAt,
      worktreeId: b.worktreeId,
      agentStepCount: j['agentStepCount'] as num?,
      completedAt: j['completedAt'] as String?,
      jobCount: j['jobCount'] as num?,
      pipelineId: j['pipelineId'] as String,
      pipelineName: j['pipelineName'] as String,
      retryCount: j['retryCount'] as num?,
      runDurationMs: j['runDurationMs'] as num?,
      startedAt: j['startedAt'] as String,
      status: j['status'] as String,
      stepCount: j['stepCount'] as num?,
    );
  }
}

final class RunFailedFeedItem extends FeedItem {
  RunFailedFeedItem({
    required super.actor,
    required super.id,
    required super.occurredAt,
    super.worktreeId,
    this.clientChatId,
    required this.label,
    this.model,
    required this.notificationWorthy,
    required this.status,
  });

  @override
  FeedItemType get type => FeedItemType.runFailed;

  final String? clientChatId;
  final String label;
  final String? model;
  /// Always true — only emitted for the terminal failure of a session.
  final bool notificationWorthy;
  final String status;

  factory RunFailedFeedItem.fromJson(Map<String, dynamic> j) {
    final b = _base(j);
    return RunFailedFeedItem(
      actor: b.actor,
      id: b.id,
      occurredAt: b.occurredAt,
      worktreeId: b.worktreeId,
      clientChatId: j['clientChatId'] as String?,
      label: j['label'] as String,
      model: j['model'] as String?,
      notificationWorthy: j['notificationWorthy'] as bool,
      status: j['status'] as String,
    );
  }
}

/// One page of the feed. `nextCursor` is an opaque base64url keyset cursor; null when the page is the last one.
class FeedPageResponse {
  const FeedPageResponse({required this.items, this.nextCursor});

  final List<FeedItem> items;
  final String? nextCursor;

  factory FeedPageResponse.fromJson(Map<String, dynamic> json) => FeedPageResponse(
        items: _parseList(json['items'], (e) => FeedItem.fromJson(e as Map<String, dynamic>)),
        nextCursor: json['nextCursor'] as String?,
      );
}

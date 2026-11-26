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

enum TelemetryCardUnit {
  currency('currency'),
  count('count'),
  tokens('tokens'),
  ;

  const TelemetryCardUnit(this.wire);

  final String wire;

  static TelemetryCardUnit fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown TelemetryCardUnit: $wire'),
      );
}

enum TelemetryProvider {
  claude('claude'),
  codex('codex'),
  ollama('ollama'),
  ;

  const TelemetryProvider(this.wire);

  final String wire;

  static TelemetryProvider fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown TelemetryProvider: $wire'),
      );
}

enum TelemetryTimeGranularity {
  hour('hour'),
  day('day'),
  week('week'),
  ;

  const TelemetryTimeGranularity(this.wire);

  final String wire;

  static TelemetryTimeGranularity fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown TelemetryTimeGranularity: $wire'),
      );
}

enum TelemetryUsageScope {
  organization('organization'),
  team('team'),
  ;

  const TelemetryUsageScope(this.wire);

  final String wire;

  static TelemetryUsageScope fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown TelemetryUsageScope: $wire'),
      );
}

/// One billed-cost rollup row grouped by provider + normalized plan key. No per-account rows are exposed; `accountCount` is the distinct-account tally.
class SubscriptionPlanUsageRow {
  const SubscriptionPlanUsageRow({required this.accountCount, required this.billedUsd, this.effectiveMonthlyUsd, required this.label, required this.monthsActive, required this.planKey, required this.provider});

  final num accountCount;
  /// Estimated billed cost for this plan across the range.
  final num billedUsd;
  final num? effectiveMonthlyUsd;
  final String label;
  /// Total distinct account-months of activity across the range.
  final num monthsActive;
  final String planKey;
  final TelemetryProvider provider;

  factory SubscriptionPlanUsageRow.fromJson(Map<String, dynamic> json) => SubscriptionPlanUsageRow(
        accountCount: (json['accountCount'] as num?) ?? 0,
        billedUsd: (json['billedUsd'] as num?) ?? 0,
        effectiveMonthlyUsd: json['effectiveMonthlyUsd'] as num?,
        label: json['label'] as String,
        monthsActive: (json['monthsActive'] as num?) ?? 0,
        planKey: json['planKey'] as String,
        provider: TelemetryProvider.fromWire(json['provider'] as String),
      );
}

/// One cost time-series bucket keyed by provider or model.
class TelemetryCostBucket {
  const TelemetryCostBucket({required this.bucketStartIso, required this.key, required this.totalCostUsd});

  final String bucketStartIso;
  /// Provider or model name.
  final String key;
  final num totalCostUsd;

  factory TelemetryCostBucket.fromJson(Map<String, dynamic> json) => TelemetryCostBucket(
        bucketStartIso: json['bucketStartIso'] as String,
        key: json['key'] as String,
        totalCostUsd: (json['totalCostUsd'] as num?) ?? 0,
      );
}

/// Turn counts grouped by event type + terminal status.
class TelemetryEventStatusCount {
  const TelemetryEventStatusCount({required this.count, required this.eventType, required this.status});

  final num count;
  final String eventType;
  final String status;

  factory TelemetryEventStatusCount.fromJson(Map<String, dynamic> json) => TelemetryEventStatusCount(
        count: (json['count'] as num?) ?? 0,
        eventType: json['eventType'] as String,
        status: json['status'] as String,
      );
}

/// A single most-expensive session for the click-through panel.
class TelemetryExpensiveRun {
  const TelemetryExpensiveRun({this.authorName, required this.branchName, this.durationMs, required this.eventType, required this.inputTokens, required this.label, this.model, required this.outputTokens, this.prUrl, required this.provider, required this.sessionId, required this.startedAtIso, required this.status, required this.totalCostUsd, this.transcriptSessionId, required this.turnCount, required this.worktreeId});

  /// `users.name` for the attribution actor; null → render "Unknown".
  final String? authorName;
  final String branchName;
  /// Summed per-turn agent durations across the session in ms; null when unrecorded.
  final num? durationMs;
  /// Raw turn event-type enum value from the latest turn, e.g. "WORKTREE_CHAT".
  final String eventType;
  /// Summed across all of the session's turns.
  final num inputTokens;
  /// From the session's latest turn.
  final String label;
  /// From the session's latest turn.
  final String? model;
  /// Summed across all of the session's turns.
  final num outputTokens;
  /// Most-recent PR url for the worktree, when one exists.
  final String? prUrl;
  /// From the session's latest turn.
  final String provider;
  /// Stable per-session id: `${worktreeExternalId}:${sessionKey}`.
  final String sessionId;
  /// Most-recent turn start (`MAX(started_at)`) across the session.
  final String startedAtIso;
  /// Raw turn status enum value from the latest turn, e.g. "SUCCESS" / "FAILURE".
  final String status;
  /// Summed across all of the session's turns.
  final num totalCostUsd;
  /// The canonical organization transcript session ID (or null when the session has no shared transcript), set only for an organization owner with the transcript browser on. Absent for every other viewer.
  final String? transcriptSessionId;
  /// Number of turns summed into this session.
  final num turnCount;
  final String worktreeId;

  factory TelemetryExpensiveRun.fromJson(Map<String, dynamic> json) => TelemetryExpensiveRun(
        authorName: json['authorName'] as String?,
        branchName: json['branchName'] as String,
        durationMs: json['durationMs'] as num?,
        eventType: json['eventType'] as String,
        inputTokens: (json['inputTokens'] as num?) ?? 0,
        label: json['label'] as String,
        model: json['model'] as String?,
        outputTokens: (json['outputTokens'] as num?) ?? 0,
        prUrl: json['prUrl'] as String?,
        provider: json['provider'] as String,
        sessionId: json['sessionId'] as String,
        startedAtIso: json['startedAtIso'] as String,
        status: json['status'] as String,
        totalCostUsd: (json['totalCostUsd'] as num?) ?? 0,
        transcriptSessionId: json['transcriptSessionId'] as String?,
        turnCount: (json['turnCount'] as num?) ?? 0,
        worktreeId: json['worktreeId'] as String,
      );
}

/// A headline metric card with an optional prior-window value for trend.
class TelemetryHeadlineCard {
  const TelemetryHeadlineCard({required this.key, required this.label, this.previousValue, required this.unit, required this.value});

  /// Stable key, e.g. `totalCostUsd` / `totalTokens` / `turns`.
  final String key;
  final String label;
  /// Prior comparison-window value; null when no comparison applies.
  final num? previousValue;
  final TelemetryCardUnit unit;
  final num value;

  factory TelemetryHeadlineCard.fromJson(Map<String, dynamic> json) => TelemetryHeadlineCard(
        key: json['key'] as String,
        label: json['label'] as String,
        previousValue: json['previousValue'] as num?,
        unit: TelemetryCardUnit.fromWire(json['unit'] as String),
        value: (json['value'] as num?) ?? 0,
      );
}

/// One Impact time-series bucket keyed by person (display name, or `Others` for the folded remainder beyond the charted top contributors). Each person's values across all buckets sum to their leaderboard `impactScore`, so a stacked chart of these buckets reads as the team's total impact over time.
class TelemetryImpactBucket {
  const TelemetryImpactBucket({required this.bucketStartIso, required this.impactScore, required this.key});

  final String bucketStartIso;
  final num impactScore;
  /// Person display name, or `Others` for the folded remainder.
  final String key;

  factory TelemetryImpactBucket.fromJson(Map<String, dynamic> json) => TelemetryImpactBucket(
        bucketStartIso: json['bucketStartIso'] as String,
        impactScore: (json['impactScore'] as num?) ?? 0,
        key: json['key'] as String,
      );
}

/// Per-pipeline usage rollup derived from `pipeline_agent_turn` turns.
class TelemetryPipelineUsage {
  const TelemetryPipelineUsage({required this.agentTimeMs, required this.clientPipelineId, required this.inputTokens, required this.outputTokens, this.pipelineName, required this.runCount, required this.totalCostUsd, required this.turnCount});

  final num agentTimeMs;
  final String clientPipelineId;
  final num inputTokens;
  final num outputTokens;
  /// Friendly pipeline name resolved from pipeline_runs; null if unresolved.
  final String? pipelineName;
  /// Distinct pipeline execution count.
  final num runCount;
  final num totalCostUsd;
  final num turnCount;

  factory TelemetryPipelineUsage.fromJson(Map<String, dynamic> json) => TelemetryPipelineUsage(
        agentTimeMs: (json['agentTimeMs'] as num?) ?? 0,
        clientPipelineId: json['clientPipelineId'] as String,
        inputTokens: (json['inputTokens'] as num?) ?? 0,
        outputTokens: (json['outputTokens'] as num?) ?? 0,
        pipelineName: json['pipelineName'] as String?,
        runCount: (json['runCount'] as num?) ?? 0,
        totalCostUsd: (json['totalCostUsd'] as num?) ?? 0,
        turnCount: (json['turnCount'] as num?) ?? 0,
      );
}

/// One token time-series bucket keyed by provider or model.
class TelemetryTokenBucket {
  const TelemetryTokenBucket({required this.bucketStartIso, required this.cacheCreationInputTokens, required this.cacheReadInputTokens, required this.inputTokens, required this.key, required this.outputTokens});

  final String bucketStartIso;
  final num cacheCreationInputTokens;
  final num cacheReadInputTokens;
  final num inputTokens;
  /// Provider or model name.
  final String key;
  final num outputTokens;

  factory TelemetryTokenBucket.fromJson(Map<String, dynamic> json) => TelemetryTokenBucket(
        bucketStartIso: json['bucketStartIso'] as String,
        cacheCreationInputTokens: (json['cacheCreationInputTokens'] as num?) ?? 0,
        cacheReadInputTokens: (json['cacheReadInputTokens'] as num?) ?? 0,
        inputTokens: (json['inputTokens'] as num?) ?? 0,
        key: json['key'] as String,
        outputTokens: (json['outputTokens'] as num?) ?? 0,
      );
}

/// Tool usage rolled up by category.
class TelemetryToolCategoryTotal {
  const TelemetryToolCategoryTotal({required this.toolCategory, required this.total});

  final String toolCategory;
  final num total;

  factory TelemetryToolCategoryTotal.fromJson(Map<String, dynamic> json) => TelemetryToolCategoryTotal(
        toolCategory: json['toolCategory'] as String,
        total: (json['total'] as num?) ?? 0,
      );
}

/// Per-person leaderboard row for the People tab. Every field is a plain serializable number/string/null derived from owner-scoped plaintext rollup columns. `impactScore` is the headline KPI; the `prImpactRaw` / `deliveryImpactRaw` / `executionBonus` / `agentWorkBonus` breakdown fields back the header tooltip. The remaining fields are PR-, plan-, worktree-, pipeline-, Cowork-delivery-, and turn-derived aggregates the table sorts on.
class TelemetryUserLeaderboardRow {
  const TelemetryUserLeaderboardRow({required this.agentTurns, required this.agentWorkBonus, required this.agentWorkUnits, required this.avgCycleTimeMs, required this.avgPrSize, required this.cacheCreationInputTokens, required this.cacheReadInputTokens, required this.changedFiles, required this.checksDecided, required this.checksPassing, required this.deliveryArtifacts, required this.deliveryEntries, required this.deliveryEntriesDone, required this.deliveryEntriesWithTicket, required this.deliveryExternalActions, required this.deliveryImpactRaw, required this.deliverySharedRuns, required this.executionBonus, required this.impactScore, required this.inputTokens, required this.linesChanged, required this.outputTokens, required this.pipelineAgentSteps, required this.pipelineAvgRunMs, required this.pipelineDistinctPipelines, required this.pipelineRetries, required this.pipelineRuns, required this.pipelineRunsCancelled, required this.pipelineRunsFailed, required this.pipelineRunsSucceeded, required this.plansCreated, required this.plansImplemented, required this.prImpactRaw, required this.prsCreated, required this.prsMerged, required this.prsOpen, required this.prsWithTicket, required this.toolUseCount, required this.totalCostUsd, required this.turnCount, this.userId, this.userName, required this.worktreesCreated});

  /// Terminal primary-work transcript turns in range.
  final num agentTurns;
  /// Soft-capped bonus for terminal primary agent work in range.
  final num agentWorkBonus;
  /// Agent turns plus the weighted tool-call modulation used for Impact.
  ///
  /// Currently serialized for score auditability rather than display: it is the only field that makes `agentWorkBonus` reproducible from the row (the tool weights and soft cap are server-side), so support and score disputes can be settled without re-querying. No UI surface reads it yet.
  final num agentWorkUnits;
  /// Mean (mergedAt - openedAt) over merged PRs with both timestamps; 0 when none.
  final num avgCycleTimeMs;
  /// Mean (additions + deletions) over the user's PRs; 0 when none.
  final num avgPrSize;
  final num cacheCreationInputTokens;
  final num cacheReadInputTokens;
  final num changedFiles;
  final num checksDecided;
  final num checksPassing;
  /// Σ WRITE_EDIT + FILE_ADD + FILE_EDIT tool counts over scoring entries.
  final num deliveryArtifacts;
  /// Work Entries that scored above the floor (substantive or engaged).
  final num deliveryEntries;
  /// Scoring entries the user marked Done.
  final num deliveryEntriesDone;
  /// Scoring entries whose label carries a Linear-style ticket id.
  final num deliveryEntriesWithTicket;
  /// Σ MCP tool counts over scoring entries.
  final num deliveryExternalActions;
  /// Non-code delivery track: Σ per-Cowork-Work-Entry points (after the entry-count soft cap) + the capped shared-run bonus.
  final num deliveryImpactRaw;
  /// Cowork shared runs in range (the bonus is capped at `deliveryEntries`).
  final num deliverySharedRuns;
  /// +1 per implemented plan in range, capped at prsMerged.
  final num executionBonus;
  /// Composite headline KPI: `round1(prImpactRaw + deliveryImpactRaw + executionBonus + agentWorkBonus)`.
  final num impactScore;
  final num inputTokens;
  final num linesChanged;
  final num outputTokens;
  /// Σ executed agent steps over completed runs; Detailed-only, not scored.
  final num pipelineAgentSteps;
  /// Mean run_duration_ms over completed runs; 0 when none.
  final num pipelineAvgRunMs;
  /// Distinct pipeline_id values across the user's completed runs.
  final num pipelineDistinctPipelines;
  /// Σ retry_count over completed runs.
  final num pipelineRetries;
  /// Completed pipeline runs in range.
  final num pipelineRuns;
  final num pipelineRunsCancelled;
  final num pipelineRunsFailed;
  final num pipelineRunsSucceeded;
  final num plansCreated;
  final num plansImplemented;
  /// Σ per-merged-PR base points + linkage/cross-repo bonuses.
  final num prImpactRaw;
  final num prsCreated;
  final num prsMerged;
  final num prsOpen;
  final num prsWithTicket;
  final num toolUseCount;
  final num totalCostUsd;
  final num turnCount;
  /// Member externalId; null when the actor is no longer resolvable.
  final String? userId;
  final String? userName;
  final num worktreesCreated;

  factory TelemetryUserLeaderboardRow.fromJson(Map<String, dynamic> json) => TelemetryUserLeaderboardRow(
        agentTurns: (json['agentTurns'] as num?) ?? 0,
        agentWorkBonus: (json['agentWorkBonus'] as num?) ?? 0,
        agentWorkUnits: (json['agentWorkUnits'] as num?) ?? 0,
        avgCycleTimeMs: (json['avgCycleTimeMs'] as num?) ?? 0,
        avgPrSize: (json['avgPrSize'] as num?) ?? 0,
        cacheCreationInputTokens: (json['cacheCreationInputTokens'] as num?) ?? 0,
        cacheReadInputTokens: (json['cacheReadInputTokens'] as num?) ?? 0,
        changedFiles: (json['changedFiles'] as num?) ?? 0,
        checksDecided: (json['checksDecided'] as num?) ?? 0,
        checksPassing: (json['checksPassing'] as num?) ?? 0,
        deliveryArtifacts: (json['deliveryArtifacts'] as num?) ?? 0,
        deliveryEntries: (json['deliveryEntries'] as num?) ?? 0,
        deliveryEntriesDone: (json['deliveryEntriesDone'] as num?) ?? 0,
        deliveryEntriesWithTicket: (json['deliveryEntriesWithTicket'] as num?) ?? 0,
        deliveryExternalActions: (json['deliveryExternalActions'] as num?) ?? 0,
        deliveryImpactRaw: (json['deliveryImpactRaw'] as num?) ?? 0,
        deliverySharedRuns: (json['deliverySharedRuns'] as num?) ?? 0,
        executionBonus: (json['executionBonus'] as num?) ?? 0,
        impactScore: (json['impactScore'] as num?) ?? 0,
        inputTokens: (json['inputTokens'] as num?) ?? 0,
        linesChanged: (json['linesChanged'] as num?) ?? 0,
        outputTokens: (json['outputTokens'] as num?) ?? 0,
        pipelineAgentSteps: (json['pipelineAgentSteps'] as num?) ?? 0,
        pipelineAvgRunMs: (json['pipelineAvgRunMs'] as num?) ?? 0,
        pipelineDistinctPipelines: (json['pipelineDistinctPipelines'] as num?) ?? 0,
        pipelineRetries: (json['pipelineRetries'] as num?) ?? 0,
        pipelineRuns: (json['pipelineRuns'] as num?) ?? 0,
        pipelineRunsCancelled: (json['pipelineRunsCancelled'] as num?) ?? 0,
        pipelineRunsFailed: (json['pipelineRunsFailed'] as num?) ?? 0,
        pipelineRunsSucceeded: (json['pipelineRunsSucceeded'] as num?) ?? 0,
        plansCreated: (json['plansCreated'] as num?) ?? 0,
        plansImplemented: (json['plansImplemented'] as num?) ?? 0,
        prImpactRaw: (json['prImpactRaw'] as num?) ?? 0,
        prsCreated: (json['prsCreated'] as num?) ?? 0,
        prsMerged: (json['prsMerged'] as num?) ?? 0,
        prsOpen: (json['prsOpen'] as num?) ?? 0,
        prsWithTicket: (json['prsWithTicket'] as num?) ?? 0,
        toolUseCount: (json['toolUseCount'] as num?) ?? 0,
        totalCostUsd: (json['totalCostUsd'] as num?) ?? 0,
        turnCount: (json['turnCount'] as num?) ?? 0,
        userId: json['userId'] as String?,
        userName: json['userName'] as String?,
        worktreesCreated: (json['worktreesCreated'] as num?) ?? 0,
      );
}

/// Flag-gated Auto comparison over the same scope, range, and user filter.
class TeamUsageResponseAutoRoutingSavings {
  const TeamUsageResponseAutoRoutingSavings({this.actualWithAutoCostUsd, required this.autoTurnCount, this.benchmarkEstimatedExecutionCostUsd, required this.comparableTurnCount, this.netEstimatedSavingsUsd, this.previousNetEstimatedSavingsUsd, this.routingCostUsd, this.selectedExecutionCostUsd});

  final num? actualWithAutoCostUsd;
  final num autoTurnCount;
  final num? benchmarkEstimatedExecutionCostUsd;
  final num comparableTurnCount;
  /// Period-total net savings, clamped at 0: a period where Auto cost more reads as saving nothing. It can therefore exceed `benchmarkEstimatedExecutionCostUsd - actualWithAutoCostUsd`.
  final num? netEstimatedSavingsUsd;
  /// Prior-window  {@link  netEstimatedSavingsUsd  } , clamped the same way.
  final num? previousNetEstimatedSavingsUsd;
  final num? routingCostUsd;
  final num? selectedExecutionCostUsd;

  factory TeamUsageResponseAutoRoutingSavings.fromJson(Map<String, dynamic> json) => TeamUsageResponseAutoRoutingSavings(
        actualWithAutoCostUsd: json['actualWithAutoCostUsd'] as num?,
        autoTurnCount: (json['autoTurnCount'] as num?) ?? 0,
        benchmarkEstimatedExecutionCostUsd: json['benchmarkEstimatedExecutionCostUsd'] as num?,
        comparableTurnCount: (json['comparableTurnCount'] as num?) ?? 0,
        netEstimatedSavingsUsd: json['netEstimatedSavingsUsd'] as num?,
        previousNetEstimatedSavingsUsd: json['previousNetEstimatedSavingsUsd'] as num?,
        routingCostUsd: json['routingCostUsd'] as num?,
        selectedExecutionCostUsd: json['selectedExecutionCostUsd'] as num?,
      );
}

/// Estimated subscription billing derived from the plan types the team actually used. Omitted entirely when zero subscription accounts were attributed in the range (honest empty state — observed cost still shows).
class TeamUsageResponseBilledCost {
  const TeamUsageResponseBilledCost({required this.byBucket, required this.plans, this.previousTotalUsd, required this.savingsUsd, required this.totalUsd, required this.unpricedAccountCount});

  final List<TelemetryCostBucket> byBucket;
  /// Per-plan rollup rows grouped by provider + plan key.
  final List<SubscriptionPlanUsageRow> plans;
  /// Prior comparison-window billed total; null when no comparison applies.
  final num? previousTotalUsd;
  /// Observed minus billed for the range; may be negative.
  final num savingsUsd;
  final num totalUsd;
  /// Count of active accounts whose plan has no price (catalog + override).
  final num unpricedAccountCount;

  factory TeamUsageResponseBilledCost.fromJson(Map<String, dynamic> json) => TeamUsageResponseBilledCost(
        byBucket: _parseList(json['byBucket'], (e) => TelemetryCostBucket.fromJson(e as Map<String, dynamic>)),
        plans: _parseList(json['plans'], (e) => SubscriptionPlanUsageRow.fromJson(e as Map<String, dynamic>)),
        previousTotalUsd: json['previousTotalUsd'] as num?,
        savingsUsd: (json['savingsUsd'] as num?) ?? 0,
        totalUsd: (json['totalUsd'] as num?) ?? 0,
        unpricedAccountCount: (json['unpricedAccountCount'] as num?) ?? 0,
      );
}

class TeamUsageResponseRange {
  const TeamUsageResponseRange({required this.endIso, required this.granularity, required this.startIso});

  final String endIso;
  final TelemetryTimeGranularity granularity;
  final String startIso;

  factory TeamUsageResponseRange.fromJson(Map<String, dynamic> json) => TeamUsageResponseRange(
        endIso: json['endIso'] as String,
        granularity: TelemetryTimeGranularity.fromWire(json['granularity'] as String),
        startIso: json['startIso'] as String,
      );
}

/// Full team usage dashboard payload for a scope/range/filter.
class TeamUsageResponse {
  const TeamUsageResponse({this.autoRoutingSavings, this.billedCost, required this.byUser, required this.costByModel, required this.costByProvider, required this.eventTypeStatusCounts, this.filterUserId, required this.headline, required this.impactByUser, required this.mostExpensiveRuns, required this.pipelines, required this.range, required this.scope, this.teamId, required this.tokensByModel, required this.tokensByProvider, required this.toolCategoryTotals});

  /// Flag-gated Auto comparison over the same scope, range, and user filter.
  final TeamUsageResponseAutoRoutingSavings? autoRoutingSavings;
  /// Estimated subscription billing derived from the plan types the team actually used. Omitted entirely when zero subscription accounts were attributed in the range (honest empty state — observed cost still shows).
  final TeamUsageResponseBilledCost? billedCost;
  final List<TelemetryUserLeaderboardRow> byUser;
  final List<TelemetryCostBucket> costByModel;
  final List<TelemetryCostBucket> costByProvider;
  final List<TelemetryEventStatusCount> eventTypeStatusCounts;
  /// Active attribution-user filter (member externalId), or null.
  final String? filterUserId;
  final List<TelemetryHeadlineCard> headline;
  /// Team Impact over time: per-person impact bucketed by `range.granularity`.
  final List<TelemetryImpactBucket> impactByUser;
  final List<TelemetryExpensiveRun> mostExpensiveRuns;
  final List<TelemetryPipelineUsage> pipelines;
  final TeamUsageResponseRange range;
  final TelemetryUsageScope scope;
  /// Sub-team externalId when scoped to a team; null for org-wide.
  final String? teamId;
  final List<TelemetryTokenBucket> tokensByModel;
  final List<TelemetryTokenBucket> tokensByProvider;
  final List<TelemetryToolCategoryTotal> toolCategoryTotals;

  factory TeamUsageResponse.fromJson(Map<String, dynamic> json) => TeamUsageResponse(
        autoRoutingSavings: json['autoRoutingSavings'] == null ? null : TeamUsageResponseAutoRoutingSavings.fromJson(json['autoRoutingSavings'] as Map<String, dynamic>),
        billedCost: json['billedCost'] == null ? null : TeamUsageResponseBilledCost.fromJson(json['billedCost'] as Map<String, dynamic>),
        byUser: _parseList(json['byUser'], (e) => TelemetryUserLeaderboardRow.fromJson(e as Map<String, dynamic>)),
        costByModel: _parseList(json['costByModel'], (e) => TelemetryCostBucket.fromJson(e as Map<String, dynamic>)),
        costByProvider: _parseList(json['costByProvider'], (e) => TelemetryCostBucket.fromJson(e as Map<String, dynamic>)),
        eventTypeStatusCounts: _parseList(json['eventTypeStatusCounts'], (e) => TelemetryEventStatusCount.fromJson(e as Map<String, dynamic>)),
        filterUserId: json['filterUserId'] as String?,
        headline: _parseList(json['headline'], (e) => TelemetryHeadlineCard.fromJson(e as Map<String, dynamic>)),
        impactByUser: _parseList(json['impactByUser'], (e) => TelemetryImpactBucket.fromJson(e as Map<String, dynamic>)),
        mostExpensiveRuns: _parseList(json['mostExpensiveRuns'], (e) => TelemetryExpensiveRun.fromJson(e as Map<String, dynamic>)),
        pipelines: _parseList(json['pipelines'], (e) => TelemetryPipelineUsage.fromJson(e as Map<String, dynamic>)),
        range: TeamUsageResponseRange.fromJson(json['range'] as Map<String, dynamic>),
        scope: TelemetryUsageScope.fromWire(json['scope'] as String),
        teamId: json['teamId'] as String?,
        tokensByModel: _parseList(json['tokensByModel'], (e) => TelemetryTokenBucket.fromJson(e as Map<String, dynamic>)),
        tokensByProvider: _parseList(json['tokensByProvider'], (e) => TelemetryTokenBucket.fromJson(e as Map<String, dynamic>)),
        toolCategoryTotals: _parseList(json['toolCategoryTotals'], (e) => TelemetryToolCategoryTotal.fromJson(e as Map<String, dynamic>)),
      );
}

// Portable execution observability (CAN-4136): record sanitization, usage
// aggregation and the ports a host supplies. Pure and host-neutral; the host
// owns storage and stays the single writer.
export { normalizeAuditEntry } from './audit-entry-parser';
export {
  buildAuditDayWindow,
  compareEntries,
  getRetentionCutoffTime,
  isAuditFileInsideWindow,
  isStartedAtInsideRange,
  retainedDayStartTime,
  toIsoDay,
  type AuditDayWindow,
} from './audit-days';
export { labelForEventType } from './audit-labels';
export {
  defaultTokens,
  defaultToolCounts,
  observedModelIdentity,
} from './audit-records';
export {
  isRecord,
  readArray,
  readBoolean,
  readNumber,
  readRecord,
  readString,
  safeJsonParse,
} from './record-readers';
export { isValidIsoTimestamp, normalizeUsageMetricEvent } from './usage-events';
export { countPlanUsageEvent, upsertUsageEventById } from './usage-identity';
export {
  USAGE_EVENT_RETENTION_DAYS,
  buildUsageMetricsResponse,
  entryMatchesWorktree,
  isUsageEventInsideRange,
  isUsageEventWithinRetention,
  matchesHistoryRequest,
  matchesUsageMetricsRequest,
} from './usage-metrics';
export {
  computeCountsTimeseries,
  computeDistributionTimeseries,
  computeMetricsView,
  computeTabSummary,
  toDelegationStatisticsEvent,
  type DelegationStatisticsEvent,
  type StatisticsEvent,
} from './usage-tab-aggregation';
export {
  createPipelineObservabilityFeed,
  type PipelineObservabilityFeed,
} from './pipeline-feed';
export type {
  AgentObservabilityHostTypes,
  AgentObservabilityIngest,
  CanonicalChatTurnDuration,
  ExecutionObservabilityIngest,
  ObservabilityAccountProvider,
  ObservabilityBillingAccountKind,
  ObservabilityHostServices,
  ObservabilityInstrumentationContext,
  ObservabilityInstrumentationPort,
  ObservabilityOperationFailureReason,
  ObservabilityOperationName,
  ObservabilityOperationOptions,
  ObservabilityPricingPort,
  ObservabilityPricingState,
  ObservabilityProviderAccountIdentity,
  ObservabilityProviderAccountPort,
  ObservedTaskPatch,
  ObservedTaskUsage,
  PipelineStepOutputObservation,
} from './ports';
export {
  AuditEventJournal,
  type AuditEventFeed,
  type AuditJournalItem,
  type AuditJournalReplay,
} from './audit-event-journal';
export {
  createCoreObservabilityHandlers,
  type CoreObservabilityHandlerOptions,
  type CoreObservabilityHandlers,
  type ObservabilityReadModel,
} from './handlers';

'use client';

import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import {
  SettingsOperationError,
  type SettingsErrorCode,
  type SettingsReadMap,
} from '@canopy/protocol/settings';
import type {
  ExplorerEntity,
  ExplorerEntityGraph,
  ExplorerFact,
  ExplorerFactDetail,
  ExplorerFactSource,
  ExplorerIngestJob,
  ExplorerIngestJobStatus,
  ExplorerRankedFact,
  ExplorerRetrievalCandidate,
  ExplorerRetrievalPreview,
  ExplorerSourceTranscript,
} from '@canopy/protocol/settings/organization-memory';

// Structural payload guards. The settings client validates every result
// against the operation table's schemas (`organization-memory.ts` mirrors
// these checks), so the views no longer call them; they stay exported for
// callers that hold a raw payload.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isEntity(value: unknown): value is ExplorerEntity {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.canonicalName === 'string' &&
    (value.entityType === 'SERVICE' ||
      value.entityType === 'CODE' ||
      value.entityType === 'TOOL')
  );
}

export function isExplorerFact(value: unknown): value is ExplorerFact {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.factText === 'string' &&
    (value.evidenceType === 'OBSERVED' ||
      value.evidenceType === 'ASSERTED' ||
      value.evidenceType === 'INFERRED') &&
    isNullableString(value.evidenceQuote) &&
    isNullableString(value.validAt) &&
    isNullableString(value.invalidAt) &&
    typeof value.createdAt === 'string' &&
    isNullableString(value.expiredAt) &&
    isNullableString(value.invalidatedById) &&
    (value.liveness === 'live' || value.liveness === 'superseded') &&
    Array.isArray(value.entities) &&
    value.entities.every(isEntity)
  );
}

function isRankedFact(value: unknown): value is ExplorerRankedFact {
  return (
    isExplorerFact(value) &&
    'score' in value &&
    typeof value.score === 'number' &&
    'rrfScore' in value &&
    typeof value.rrfScore === 'number'
  );
}

export interface FactPagePayload {
  facts: Array<ExplorerFact | ExplorerRankedFact>;
  nextCursor: string | null;
}

export function isFactPagePayload(value: unknown): value is FactPagePayload {
  return (
    isRecord(value) &&
    Array.isArray(value.facts) &&
    value.facts.every((fact) => isExplorerFact(fact) || isRankedFact(fact)) &&
    isNullableString(value.nextCursor)
  );
}

function isSource(value: unknown): value is ExplorerFactSource {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isNullableString(value.transcriptTurnId) ||
    typeof value.referenceTime !== 'string'
  ) {
    return false;
  }
  if (value.actor === null) {
    return true;
  }
  return (
    isRecord(value.actor) &&
    typeof value.actor.id === 'string' &&
    isNullableString(value.actor.name) &&
    typeof value.actor.email === 'string'
  );
}

export function isFactDetail(value: unknown): value is ExplorerFactDetail {
  return (
    isExplorerFact(value) &&
    'sources' in value &&
    Array.isArray(value.sources) &&
    value.sources.every(isSource) &&
    'supersessionChain' in value &&
    Array.isArray(value.supersessionChain)
  );
}

export interface FactDetailBatchPayload {
  facts: ExplorerFactDetail[];
}

export function isFactDetailBatchPayload(
  value: unknown,
): value is FactDetailBatchPayload {
  return (
    isRecord(value) &&
    Array.isArray(value.facts) &&
    value.facts.every(isFactDetail)
  );
}

function isGraphNode(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.canonicalName === 'string' &&
    (value.entityType === 'SERVICE' ||
      value.entityType === 'CODE' ||
      value.entityType === 'TOOL') &&
    typeof value.factCount === 'number' &&
    Array.isArray(value.factIds) &&
    value.factIds.every((id) => typeof id === 'string')
  );
}

function isGraphEdge(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    typeof value.target === 'string' &&
    typeof value.weight === 'number' &&
    Array.isArray(value.factIds) &&
    value.factIds.every((id) => typeof id === 'string')
  );
}

export function isEntityGraph(value: unknown): value is ExplorerEntityGraph {
  return (
    isRecord(value) &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isGraphNode) &&
    Array.isArray(value.edges) &&
    value.edges.every(isGraphEdge) &&
    typeof value.truncated === 'boolean'
  );
}

const JOB_STATUSES: readonly ExplorerIngestJobStatus[] = [
  'PENDING',
  'RUNNING',
  'DONE',
  'FAILED',
  'DEAD',
];

function isJob(value: unknown): value is ExplorerIngestJob {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    JOB_STATUSES.some((status) => status === value.status) &&
    typeof value.attempts === 'number' &&
    typeof value.heartbeatStale === 'boolean' &&
    isNullableString(value.lastError) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

export interface JobsPayload {
  jobs: ExplorerIngestJob[];
  counts: Record<ExplorerIngestJobStatus, number>;
  nextCursor: string | null;
}

export function isJobsPayload(value: unknown): value is JobsPayload {
  return (
    isRecord(value) &&
    Array.isArray(value.jobs) &&
    value.jobs.every(isJob) &&
    isRecord(value.counts) &&
    isNullableString(value.nextCursor)
  );
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'number')
  );
}

function isNullableNumber(value: unknown): value is number | null {
  return typeof value === 'number' || value === null;
}

function isPreviewDiagnostics(
  value: unknown,
): value is ExplorerRetrievalPreview['diagnostics'] {
  if (!isRecord(value)) return false;
  const { laneCounts, topScores } = value;
  return (
    isRecord(laneCounts) &&
    typeof laneCounts.vector === 'number' &&
    typeof laneCounts.fts === 'number' &&
    typeof laneCounts.trigram === 'number' &&
    typeof laneCounts.graph === 'number' &&
    typeof value.rerankUsed === 'boolean' &&
    isNullableNumber(value.topRerankScore) &&
    isNullableNumber(value.topCosineScore) &&
    typeof value.latencyMs === 'number' &&
    isRecord(topScores) &&
    isNumberArray(topScores.rerank) &&
    isNumberArray(topScores.cosine) &&
    isNumberArray(topScores.rrf)
  );
}

function isRetrievalCandidate(
  value: unknown,
): value is ExplorerRetrievalCandidate {
  return (
    isRecord(value) &&
    typeof value.factId === 'string' &&
    typeof value.score === 'number' &&
    Array.isArray(value.entityIds) &&
    value.entityIds.every((id) => typeof id === 'string')
  );
}

export function isRetrievalPreviewPayload(
  value: unknown,
): value is ExplorerRetrievalPreview {
  return (
    isRecord(value) &&
    typeof value.gatePassed === 'boolean' &&
    typeof value.candidateCount === 'number' &&
    Array.isArray(value.facts) &&
    value.facts.every(isExplorerFact) &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isRetrievalCandidate) &&
    isNullableString(value.renderedBlock) &&
    typeof value.truncated === 'boolean' &&
    isPreviewDiagnostics(value.diagnostics)
  );
}

export const MEMORY_RATE_LIMIT_MESSAGE =
  'Rate limit reached — try again in a moment.';

/** The copy a failed memory explorer read shows. */
export interface MemoryRequestMessages {
  /** The server answered with a body the explorer cannot read. */
  readonly unexpected: string;
  /** The request never produced a response (offline, refused input). */
  readonly fallback: string;
}

/**
 * A failed memory explorer read. Its message is fixed local copy; the
 * transport's facts (`status`, `code`, `serverCode`) stay on the error for
 * `settings/errors`, and the server's own text is the log-only
 * `serverDetail`.
 */
export class MemoryRequestError extends Error {
  readonly status: number | undefined;
  readonly code: SettingsErrorCode;
  readonly serverCode: string | undefined;
  /** The server's message, for logs only: never render it. */
  readonly serverDetail: string | undefined;

  constructor(message: string, failed: SettingsOperationError) {
    super(message);
    this.name = 'MemoryRequestError';
    this.status = failed.status;
    this.code = failed.code;
    this.serverCode = failed.serverCode;
    this.serverDetail =
      failed.message !== failed.code ? failed.message : undefined;
  }
}

/**
 * Maps a settings client failure onto the explorer's local copy: a 429 is
 * the rate-limit notice, a malformed body is the caller's "unexpected
 * response" message, and anything else is the caller's fallback. Server text
 * never becomes the message. Errors that did not come from the settings
 * client keep their own message.
 */
export function memoryRequestError(
  error: unknown,
  messages: MemoryRequestMessages,
): Error {
  if (!(error instanceof SettingsOperationError)) {
    return error instanceof Error ? error : new Error(messages.fallback);
  }
  if (error.status === 429)
    return new MemoryRequestError(MEMORY_RATE_LIMIT_MESSAGE, error);
  if (error.code === 'invalid_response')
    return new MemoryRequestError(messages.unexpected, error);
  return new MemoryRequestError(messages.fallback, error);
}

async function memoryRequest<T>(
  request: () => Promise<T>,
  messages: MemoryRequestMessages,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw memoryRequestError(error, messages);
  }
}

type ReadInput<K extends keyof SettingsReadMap> = SettingsReadMap[K]['input'];

export const FACT_PAGE_MESSAGES: MemoryRequestMessages = {
  unexpected: 'Unexpected fact response',
  fallback: "Couldn't load facts",
};

/** One page of facts, or ranked search results when `q` is set. */
export function fetchMemoryFacts(
  client: AccountOrganizationSettingsClient,
  input: ReadInput<'organization.memory.facts'>,
  messages: MemoryRequestMessages = FACT_PAGE_MESSAGES,
): Promise<FactPagePayload> {
  return memoryRequest(
    () => client.read('organization.memory.facts', input),
    messages,
  );
}

export function fetchMemoryFact(
  client: AccountOrganizationSettingsClient,
  organizationId: string,
  factId: string,
): Promise<ExplorerFactDetail> {
  return memoryRequest(
    () => client.read('organization.memory.fact', { organizationId, factId }),
    {
      unexpected: 'Unexpected fact detail response',
      fallback: "Couldn't load fact detail",
    },
  );
}

export function fetchMemoryFactsBatch(
  client: AccountOrganizationSettingsClient,
  organizationId: string,
  factIds: string[],
): Promise<FactDetailBatchPayload> {
  return memoryRequest(
    () =>
      client.read('organization.memory.factsBatch', {
        organizationId,
        factIds,
      }),
    { unexpected: "Couldn't load facts", fallback: "Couldn't load facts" },
  );
}

export function fetchMemoryFactSource(
  client: AccountOrganizationSettingsClient,
  organizationId: string,
  factId: string,
  sourceId: string,
): Promise<ExplorerSourceTranscript> {
  return memoryRequest(
    () =>
      client.read('organization.memory.factSource', {
        organizationId,
        factId,
        sourceId,
      }),
    {
      unexpected: 'Unexpected transcript response',
      fallback: "Couldn't load the source transcript",
    },
  );
}

export function fetchMemoryGraph(
  client: AccountOrganizationSettingsClient,
  input: ReadInput<'organization.memory.graph'>,
): Promise<ExplorerEntityGraph> {
  return memoryRequest(() => client.read('organization.memory.graph', input), {
    unexpected: "Couldn't load graph",
    fallback: "Couldn't load graph",
  });
}

export function fetchMemoryJobs(
  client: AccountOrganizationSettingsClient,
  organizationId: string,
  status: ExplorerIngestJobStatus,
): Promise<JobsPayload> {
  return memoryRequest(
    () => client.read('organization.memory.jobs', { organizationId, status }),
    { unexpected: 'Unexpected jobs response', fallback: "Couldn't load jobs" },
  );
}

/** Runs the turn-time retrieval pipeline for `query` (metered). */
export function previewMemorySearch(
  client: AccountOrganizationSettingsClient,
  organizationId: string,
  query: string,
): Promise<ExplorerRetrievalPreview> {
  return memoryRequest(
    () =>
      client.read('organization.memory.previewSearch', {
        organizationId,
        query,
      }),
    {
      unexpected: 'Unexpected preview response',
      fallback: "Couldn't preview retrieval",
    },
  );
}

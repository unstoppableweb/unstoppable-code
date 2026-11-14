import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  CreateTrackedPlanRequest,
  DataModelDiffDiagram,
  LogicDiffDiagram,
  ParsedPlanGraph,
  PlanComment,
  PlanCommentThread,
  PlanDiagramArtifact,
  PlanDiagramArtifacts,
  PlanUsageEvent,
  SaveTrackedPlanCommentsRequest,
  WirePlanComment,
  WirePlanCommentThread,
  TrackedPlanData,
  TrackedPlanListWithSkippedResult,
  TrackedPlansFile,
  TrackedPlanReviewStatus,
  TrackedPlanRevisionData,
  TrackedPlanShareState,
  TrackedPlanShareSyncStatus,
  TrackedPlanSource,
  UpdateTrackedPlanRequest,
  UsageInitiationSource,
  UsageMetricProvider,
} from '@canopy/desktop-shared/types';
import {
  isDataModelDiffDiagram,
  isLogicDiffDiagram,
  isParsedPlanGraph,
  isPlanDiagramArtifacts,
  isPlanCommentThreadArray,
} from '@canopy/desktop-shared/types';
import {
  createPlanEngine,
  removePlanState,
  withPlanStateLock,
  writePlanStateText,
  type PlanCommit,
  type PlanScopeIds,
  type StoredPlan,
} from '@canopy/core-runtime/node/plans';
import { isUsageInitiationSource } from '@canopy/desktop-shared/lib/turn-utils';
import { resolveTrackedPlansFilePath } from './resolve-worktree';
import { getPlanExplorePlanFilePath } from './paths';
import { isRecord } from './type-guards';
import { logMainProcessWarn } from './main-process-logging';
import { getExecutionObservabilityIngest } from '../observability/ingest';

/**
 * Serializes read-modify-write operations on one tracked-plans file, so
 * concurrent writes cannot silently drop data. The lock and the atomic file
 * replacement are the core-runtime plan state file's (CAN-4165), the one
 * writer of this store.
 */
const withFileLock = withPlanStateLock;

/**
 * Dependency-inverted hook fired when a tracked plan's content is created or
 * changed. The plan-diagram scheduler registers here so persistence does not
 * import scheduler/Electron code directly. It is intentionally NOT invoked by
 * {@link setPlanDiagramArtifact}, which only mutates derived diagram artifacts
 * and must never re-trigger generation (that would loop forever).
 */
type PlanContentChangeListener = (plan: TrackedPlanData) => void;
type PlanShareChangeListener = (plan: TrackedPlanData) => void;
type PlanDiagramArtifactChangeListener = (plan: TrackedPlanData) => void;
type TrackedPlanShareStateUpdater = (
  current: TrackedPlanShareState | undefined,
) => TrackedPlanShareState | undefined;

const planContentChangeListeners = new Set<PlanContentChangeListener>();
const planShareChangeListeners = new Set<PlanShareChangeListener>();
const planDiagramArtifactChangeListeners =
  new Set<PlanDiagramArtifactChangeListener>();

export function setPlanContentChangeListener(
  fn: PlanContentChangeListener | null,
): void {
  planContentChangeListeners.clear();
  if (fn) {
    planContentChangeListeners.add(fn);
  }
}

export function addPlanContentChangeListener(
  fn: PlanContentChangeListener,
): void {
  planContentChangeListeners.add(fn);
}

export function removePlanContentChangeListener(
  fn: PlanContentChangeListener,
): void {
  planContentChangeListeners.delete(fn);
}

/**
 * Dependency-inverted hook fired after every tracked-plans file write
 * (including the empty-file removal on last-plan delete). The chat-search
 * index registers here so this persistence module stays Electron-free; the
 * payload is the exact file content just written, so subscribers never
 * re-read from disk.
 */
type TrackedPlansWriteListener = (
  projectId: string,
  worktreeId: string,
  file: TrackedPlansFile,
) => void;

const trackedPlansWriteListeners = new Set<TrackedPlansWriteListener>();

export function addTrackedPlansWriteListener(
  fn: TrackedPlansWriteListener,
): void {
  trackedPlansWriteListeners.add(fn);
}

export function removeTrackedPlansWriteListener(
  fn: TrackedPlansWriteListener,
): void {
  trackedPlansWriteListeners.delete(fn);
}

export function addPlanShareChangeListener(fn: PlanShareChangeListener): void {
  planShareChangeListeners.add(fn);
}

export function removePlanShareChangeListener(
  fn: PlanShareChangeListener,
): void {
  planShareChangeListeners.delete(fn);
}

export function addPlanDiagramArtifactChangeListener(
  fn: PlanDiagramArtifactChangeListener,
): void {
  planDiagramArtifactChangeListeners.add(fn);
}

export function removePlanDiagramArtifactChangeListener(
  fn: PlanDiagramArtifactChangeListener,
): void {
  planDiagramArtifactChangeListeners.delete(fn);
}

function emitPlanContentChange(plan: TrackedPlanData): void {
  planContentChangeListeners.forEach((listener) => {
    listener(plan);
  });
}

function emitPlanShareChange(plan: TrackedPlanData): void {
  planShareChangeListeners.forEach((listener) => {
    listener(plan);
  });
}

function emitPlanDiagramArtifactChange(plan: TrackedPlanData): void {
  planDiagramArtifactChangeListeners.forEach((listener) => {
    listener(plan);
  });
}

function isTrackedPlanReviewStatus(
  value: unknown,
): value is TrackedPlanReviewStatus {
  return value === 'pending' || value === 'approved' || value === 'dismissed';
}

function isTrackedPlanSource(value: unknown): value is TrackedPlanSource {
  return (
    value === 'copilot' ||
    value === 'claude' ||
    value === 'codex' ||
    value === 'opencode' ||
    value === 'cursor' ||
    value === 'ollama' ||
    value === 'pipeline' ||
    value === 'imported' ||
    value === 'detected'
  );
}

function planSourceToUsageMetricProvider(
  source: TrackedPlanSource,
): UsageMetricProvider | undefined {
  // Only agent/pipeline sources map to a usage-metric provider; file-origin
  // sources (imported/detected) have no provider to attribute usage to.
  switch (source) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'ollama':
    case 'pipeline':
      return source;
    case 'imported':
    case 'detected':
      return undefined;
  }
}

function isTrackedPlanShareSyncStatus(
  value: unknown,
): value is TrackedPlanShareSyncStatus {
  return (
    value === 'pending' ||
    value === 'syncing' ||
    value === 'synced' ||
    value === 'error'
  );
}

function isTrackedPlanShareState(
  value: unknown,
): value is TrackedPlanShareState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.serverId === 'string' &&
    typeof value.remoteId === 'string' &&
    (value.shareScope === 'private' ||
      value.shareScope === 'team' ||
      value.shareScope === 'organization') &&
    (value.teamId === undefined || typeof value.teamId === 'string') &&
    (value.organizationId === undefined ||
      typeof value.organizationId === 'string') &&
    isTrackedPlanShareSyncStatus(value.syncStatus) &&
    (value.lastSyncedAt === undefined ||
      typeof value.lastSyncedAt === 'string') &&
    (value.lastSyncedLocalRevisionNumber === undefined ||
      typeof value.lastSyncedLocalRevisionNumber === 'number') &&
    (value.lastSyncedRemoteRevisionNumber === undefined ||
      typeof value.lastSyncedRemoteRevisionNumber === 'number') &&
    (value.lastSyncedSnapshotHash === undefined ||
      typeof value.lastSyncedSnapshotHash === 'string') &&
    (value.lastSyncError === undefined ||
      typeof value.lastSyncError === 'string')
  );
}

function isTrackedPlanRevisionData(
  value: unknown,
): value is TrackedPlanRevisionData {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.proposalRequestId === undefined ||
      (typeof value.proposalRequestId === 'string' &&
        value.proposalRequestId.length > 0 &&
        value.proposalRequestId.length <= 256)) &&
    typeof value.revisionNumber === 'number' &&
    typeof value.content === 'string' &&
    isTrackedPlanSource(value.source) &&
    isTrackedPlanReviewStatus(value.reviewStatus) &&
    typeof value.createdAt === 'string' &&
    (value.approvedAt === undefined || typeof value.approvedAt === 'string') &&
    (value.dismissedAt === undefined || typeof value.dismissedAt === 'string')
  );
}

function isTrackedPlanData(value: unknown): value is TrackedPlanData {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    isTrackedPlanSource(value.source) &&
    (value.proposalChatId === undefined ||
      (typeof value.proposalChatId === 'string' &&
        value.proposalChatId.length > 0 &&
        value.proposalChatId.length <= 256)) &&
    typeof value.title === 'string' &&
    typeof value.content === 'string' &&
    isTrackedPlanReviewStatus(value.reviewStatus) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.latestRevisionNumber === 'number' &&
    (value.approvedAt === undefined || typeof value.approvedAt === 'string') &&
    (value.dismissedAt === undefined ||
      typeof value.dismissedAt === 'string') &&
    Array.isArray(value.revisions) &&
    value.revisions.every((revision) => isTrackedPlanRevisionData(revision)) &&
    Array.isArray(value.linkedExecutionIds) &&
    value.linkedExecutionIds.every((entry) => typeof entry === 'string') &&
    (value.hidden === undefined || typeof value.hidden === 'boolean') &&
    (value.diagrams === undefined || isPlanDiagramArtifacts(value.diagrams)) &&
    (value.commentThreads === undefined ||
      isPlanCommentThreadArray(value.commentThreads)) &&
    (value.lastEditSource === undefined ||
      value.lastEditSource === 'agent' ||
      value.lastEditSource === 'pipeline') &&
    (value.share === undefined || isTrackedPlanShareState(value.share)) &&
    (value.sourceFilePath === undefined ||
      typeof value.sourceFilePath === 'string') &&
    (value.sourceRepoId === undefined || typeof value.sourceRepoId === 'string')
  );
}

export function isTrackedPlansFile(value: unknown): value is TrackedPlansFile {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    Array.isArray(value.plans) &&
    value.plans.every((plan) => isTrackedPlanData(plan))
  );
}

async function readTrackedPlansFile(
  projectId: string,
  worktreeId: string,
): Promise<TrackedPlansFile> {
  try {
    const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isTrackedPlansFile(parsed)) {
      return parsed;
    }
  } catch {
    // Use empty state when missing or invalid.
  }

  return {
    version: 1,
    plans: [],
  };
}

/**
 * Strict reader for destructive whole-store replacement paths. Unlike the
 * general reader, unreadable, malformed, and invalid files are propagated so
 * a transient failure cannot be mistaken for authoritative empty plan state.
 * Callers that define a missing file as an empty store must handle ENOENT at
 * their boundary; this strict variant must not be used for ordinary reads.
 */
export async function readTrackedPlansFileForIndex(
  projectId: string,
  worktreeId: string,
): Promise<TrackedPlansFile> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  const raw = await readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isTrackedPlansFile(parsed)) {
    throw new Error(`Invalid tracked plans file: ${filePath}`);
  }
  return parsed;
}

async function writeTrackedPlansFile(
  projectId: string,
  worktreeId: string,
  file: TrackedPlansFile,
): Promise<void> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  if (file.plans.length === 0) {
    await removePlanState(filePath);
    emitTrackedPlansWrite(projectId, worktreeId, file);
    return;
  }

  await writePlanStateText(filePath, JSON.stringify(file, null, 2));
  emitTrackedPlansWrite(projectId, worktreeId, file);
}

function emitTrackedPlansWrite(
  projectId: string,
  worktreeId: string,
  file: TrackedPlansFile,
): void {
  trackedPlansWriteListeners.forEach((listener) => {
    try {
      listener(projectId, worktreeId, file);
    } catch (error) {
      // Plan persistence must never fail because a derived-index subscriber
      // threw; the index rebuilds itself on the next scan.
      // eslint-disable-next-line no-console
      console.error('Tracked-plans write listener failed:', error);
    }
  });
}

function markDiagramsStale(
  diagrams: PlanDiagramArtifacts | undefined,
): PlanDiagramArtifacts | undefined {
  if (!diagrams) return diagrams;
  const next: PlanDiagramArtifacts = {};
  if (diagrams.sequence) {
    next.sequence = { ...diagrams.sequence, status: 'stale' };
  }
  if (diagrams.logicDiff) {
    next.logicDiff = { ...diagrams.logicDiff, status: 'stale' };
  }
  if (diagrams.dataModelDiff) {
    next.dataModelDiff = { ...diagrams.dataModelDiff, status: 'stale' };
  }
  return next;
}

function reevaluateCommentAnchors(
  threads: PlanCommentThread[] | undefined,
  content: string,
): PlanCommentThread[] | undefined {
  if (!threads || threads.length === 0) {
    return threads;
  }
  return threads.map((thread) => {
    // Unanchored (general) comments have no plan passage to match against, so
    // they can never go outdated.
    if (thread.anchor.unanchored) {
      return thread.anchorState === 'matched'
        ? thread
        : { ...thread, anchorState: 'matched' };
    }
    return content.includes(thread.anchor.quote)
      ? thread.anchorState === 'matched'
        ? thread
        : { ...thread, anchorState: 'matched' }
      : thread.anchorState === 'outdated'
        ? thread
        : { ...thread, anchorState: 'outdated' };
  });
}

function isDurableComment(comment: PlanComment): boolean {
  return comment.author === 'agent' || comment.staged !== true;
}

function mergePlanComments(
  existingComments: PlanComment[],
  incomingComments: PlanComment[],
): PlanComment[] {
  const incomingIds = new Set(incomingComments.map((comment) => comment.id));
  const preservedExisting = existingComments.filter(
    (comment) => !incomingIds.has(comment.id) && isDurableComment(comment),
  );
  return [...incomingComments, ...preservedExisting].sort((left, right) => {
    const created = left.createdAt.localeCompare(right.createdAt);
    return created !== 0 ? created : left.id.localeCompare(right.id);
  });
}

function mergeCommentThread(
  existing: PlanCommentThread,
  incoming: PlanCommentThread,
): PlanCommentThread {
  const incomingCommentIds = new Set(
    incoming.comments.map((comment) => comment.id),
  );
  const missingDurableExisting = existing.comments.some(
    (comment) =>
      isDurableComment(comment) && !incomingCommentIds.has(comment.id),
  );

  return {
    ...incoming,
    // Anchor matching is owned by plan persistence when content changes. A
    // renderer save may carry an older anchorState snapshot, so preserve the
    // latest persisted anchor fields for existing threads.
    anchor: existing.anchor,
    anchorState: existing.anchorState,
    status:
      missingDurableExisting && existing.status === 'resolved'
        ? existing.status
        : incoming.status,
    comments: mergePlanComments(existing.comments, incoming.comments),
  };
}

function mergeCommentThreads(
  existingThreads: PlanCommentThread[],
  incomingThreads: PlanCommentThread[],
): PlanCommentThread[] {
  const existingById = new Map(
    existingThreads.map((thread) => [thread.id, thread]),
  );
  const incomingIds = new Set(incomingThreads.map((thread) => thread.id));

  const merged = incomingThreads.map((incoming) => {
    const existing = existingById.get(incoming.id);
    return existing ? mergeCommentThread(existing, incoming) : incoming;
  });

  for (const existing of existingThreads) {
    if (incomingIds.has(existing.id)) {
      continue;
    }
    if (existing.comments.some((comment) => isDurableComment(comment))) {
      merged.push(existing);
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Remote (server) comment-thread merge (CAN-393).
//
// Distinct from `mergeCommentThreads` (which reconciles renderer saves): a
// server pull must NEVER drop locally-staged drafts (which are not "durable"),
// and the server is authoritative for thread resolution status while the local
// side stays authoritative for anchor matching against plan content.
// ---------------------------------------------------------------------------

function toLocalComment(comment: WirePlanComment): PlanComment {
  const local: PlanComment = {
    id: comment.id,
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt,
  };
  if (comment.author === 'remote' && comment.remoteAuthor) {
    local.remoteAuthor = comment.remoteAuthor;
  }
  return local;
}

function toLocalThread(thread: WirePlanCommentThread): PlanCommentThread {
  return {
    id: thread.id,
    status: thread.status,
    createdAt: thread.createdAt,
    anchor: thread.anchor,
    anchorState: thread.anchorState,
    comments: thread.comments.map(toLocalComment),
  };
}

function mergeRemoteThreadComments(
  existing: PlanComment[],
  incoming: PlanComment[],
): PlanComment[] {
  const existingIds = new Set(existing.map((comment) => comment.id));
  const serverOnly = incoming.filter((comment) => !existingIds.has(comment.id));
  // Keep every existing local comment (including staged drafts) and append the
  // server-only ones (e.g. teammate replies), ordered by creation time.
  return [...existing, ...serverOnly].sort((left, right) => {
    const created = left.createdAt.localeCompare(right.createdAt);
    return created !== 0 ? created : left.id.localeCompare(right.id);
  });
}

function mergeRemoteThread(
  existing: PlanCommentThread,
  incoming: PlanCommentThread,
): PlanCommentThread {
  return {
    ...existing,
    // Server is canonical for resolution status; local owns anchor matching, so
    // the local anchor + anchorState are preserved verbatim.
    status: incoming.status,
    comments: mergeRemoteThreadComments(existing.comments, incoming.comments),
  };
}

function mergeRemoteCommentThreads(
  existing: PlanCommentThread[],
  incoming: PlanCommentThread[],
): PlanCommentThread[] {
  const incomingById = new Map(incoming.map((thread) => [thread.id, thread]));
  const existingIds = new Set(existing.map((thread) => thread.id));
  const merged = existing.map((thread) => {
    const incomingThread = incomingById.get(thread.id);
    return incomingThread ? mergeRemoteThread(thread, incomingThread) : thread;
  });
  for (const thread of incoming) {
    if (!existingIds.has(thread.id)) {
      merged.push(thread);
    }
  }
  return merged;
}

/**
 * Merge server-authored comment threads (pulled from a shared plan) into the
 * local store (CAN-393). Preserves locally-staged drafts, attributes remote
 * authors, and re-evaluates anchor state against the current local content.
 * Returns `null` when the plan is unknown; otherwise the plan plus whether the
 * merge changed anything (so callers can skip a redundant update event).
 */
export async function applyRemoteSharedPlanComments(
  projectId: string,
  worktreeId: string,
  planId: string,
  remoteThreads: WirePlanCommentThread[],
): Promise<{ plan: TrackedPlanData; changed: boolean } | null> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(projectId, worktreeId);
    const existing = file.plans.find((plan) => plan.id === planId);
    if (!existing) {
      return null;
    }
    const incoming = remoteThreads.map(toLocalThread);
    const mergedThreads = mergeRemoteCommentThreads(
      existing.commentThreads ?? [],
      incoming,
    );
    const reevaluated =
      reevaluateCommentAnchors(mergedThreads, existing.content) ??
      mergedThreads;

    const changed =
      JSON.stringify(existing.commentThreads ?? []) !==
      JSON.stringify(reevaluated);
    if (!changed) {
      return { plan: existing, changed: false };
    }

    const updated: TrackedPlanData = {
      ...existing,
      commentThreads: reevaluated,
    };
    file.plans = file.plans.map((plan) =>
      plan.id === planId ? updated : plan,
    );
    await writeTrackedPlansFile(projectId, worktreeId, file);
    return { plan: updated, changed: true };
  });
}

function getPlanLineCount(content: string): number {
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function buildPlanUsageEventId(
  type: PlanUsageEvent['type'],
  plan: TrackedPlanData,
  request: {
    chatId?: string;
  },
): string {
  return `plan-${type.replace('plan_', '')}:${plan.projectId}/${plan.worktreeId}/${request.chatId ?? 'unknown-chat'}:${plan.id}:${String(plan.latestRevisionNumber)}`;
}

function buildPlanUsageEvent(
  type: PlanUsageEvent['type'],
  plan: TrackedPlanData,
  request: {
    chatId?: string;
    initiationSource?: PlanUsageEvent['initiationSource'];
  },
): PlanUsageEvent {
  const timestamp = new Date().toISOString();
  return {
    version: 1,
    id: buildPlanUsageEventId(type, plan, request),
    type,
    timestamp,
    workspaceId: plan.projectId,
    worktreeId: plan.worktreeId,
    provider: planSourceToUsageMetricProvider(plan.source),
    initiationSource: request.initiationSource ?? 'unknown',
    chatId: request.chatId,
    planId: plan.id,
    planVersion: plan.latestRevisionNumber,
    planTextBytes: Buffer.byteLength(plan.content, 'utf8'),
    planLineCount: getPlanLineCount(plan.content),
  };
}

function recordPlanUsageEvent(
  type: PlanUsageEvent['type'],
  plan: TrackedPlanData,
  request: {
    chatId?: string;
    initiationSource?: PlanUsageEvent['initiationSource'];
  },
): void {
  getExecutionObservabilityIngest().recordUsageMetricEvent(
    buildPlanUsageEvent(type, plan, request),
  );
}

/** A stored plan desktop can type; any other plan is left out of reads. */
function toTrackedPlan(plan: StoredPlan | null): TrackedPlanData | null {
  return plan && isTrackedPlanData(plan) ? plan : null;
}

function usageRequest(
  input: { chatId?: string; initiationSource?: string } | undefined,
): { chatId?: string; initiationSource?: UsageInitiationSource } {
  const initiationSource = input?.initiationSource;
  return {
    chatId: input?.chatId,
    ...(isUsageInitiationSource(initiationSource) ? { initiationSource } : {}),
  };
}

/**
 * Usage events and listeners for a committed lifecycle write, in the order
 * they always ran: under the file's lock, after the write is durable.
 */
function announceTrackedPlanCommit(
  scope: PlanScopeIds,
  plans: readonly StoredPlan[],
  commit: PlanCommit,
  input: { chatId?: string; initiationSource?: string } | undefined,
): void {
  emitTrackedPlansWrite(scope.projectId, scope.worktreeId, {
    version: 1,
    plans: plans.filter((plan) => isTrackedPlanData(plan)),
  });
  const request = usageRequest(input);
  if (commit.kind === 'created') {
    const plan = toTrackedPlan(commit.plan);
    if (!plan) return;
    recordPlanUsageEvent('plan_created', plan, request);
    emitPlanContentChange(plan);
    emitPlanShareChange(plan);
    return;
  }
  if (commit.kind !== 'updated') return;
  const existing = toTrackedPlan(commit.previous);
  const updated = toTrackedPlan(commit.plan);
  if (!existing || !updated) return;
  const contentChanged =
    updated.latestRevisionNumber > existing.latestRevisionNumber;
  const becameApproved =
    existing.reviewStatus !== 'approved' && updated.reviewStatus === 'approved';
  if (
    contentChanged &&
    updated.reviewStatus !== 'dismissed' &&
    (updated.reviewStatus !== 'approved' || becameApproved)
  ) {
    recordPlanUsageEvent('plan_updated', updated, request);
  }
  if (becameApproved) {
    recordPlanUsageEvent('plan_approved', updated, request);
  }
  if (contentChanged) {
    emitPlanContentChange(updated);
  }
  const shareRelevantChanged =
    existing.title !== updated.title ||
    existing.content !== updated.content ||
    existing.source !== updated.source ||
    existing.reviewStatus !== updated.reviewStatus ||
    existing.latestRevisionNumber !== updated.latestRevisionNumber ||
    // Linking an execution changes the derived "implementation started" signal
    // (telemetry maps linkedExecutionIds.length > 0 to implementationStartedAt),
    // so a new linked execution must propagate to the shared/synced plan.
    existing.linkedExecutionIds.length !== updated.linkedExecutionIds.length;
  if (shareRelevantChanged) {
    emitPlanShareChange(updated);
  }
}

/**
 * The tracked-plan lifecycle (CAN-4165): the core-runtime plan engine, over
 * the same state file, lock and atomic writes as the rest of this module.
 * Comment threads and diagrams stay desktop's until CAN-4166 and CAN-4167
 * move them; the engine carries them and this host updates them when the
 * content changes.
 */
const trackedPlanEngine = createPlanEngine({
  statePath: ({ projectId, worktreeId }) =>
    resolveTrackedPlansFilePath(projectId, worktreeId),
  onContentChange: (plan) => ({
    ...plan,
    ...(isPlanDiagramArtifacts(plan.diagrams)
      ? { diagrams: markDiagramsStale(plan.diagrams) }
      : {}),
    ...(isPlanCommentThreadArray(plan.commentThreads)
      ? {
          commentThreads: reevaluateCommentAnchors(
            plan.commentThreads,
            plan.content,
          ),
        }
      : {}),
  }),
  onSkippedRecords: ({ projectId, worktreeId }, skipped) =>
    logMainProcessWarn(
      `[tracked-plans] skipped ${skipped} unreadable plan record${skipped === 1 ? '' : 's'}`,
      { projectId, worktreeId, skipped },
    ),
  afterCommit: announceTrackedPlanCommit,
});

export async function listTrackedPlans(
  projectId: string,
  worktreeId: string,
): Promise<TrackedPlanData[]> {
  return (await listTrackedPlansWithSkipped(projectId, worktreeId)).plans;
}

/**
 * The worktree's plans, counting the stored records left out: those the
 * engine couldn't read and those desktop can't type (CAN-6666).
 */
export async function listTrackedPlansWithSkipped(
  projectId: string,
  worktreeId: string,
): Promise<TrackedPlanListWithSkippedResult> {
  const read = await trackedPlanEngine.listWithSkipped({
    projectId,
    worktreeId,
  });
  const plans = read.plans.filter((plan) => isTrackedPlanData(plan));
  const skipped = read.skipped + read.plans.length - plans.length;
  return skipped > 0 ? { plans, skipped } : { plans };
}

export async function getTrackedPlan(
  projectId: string,
  worktreeId: string,
  planId: string,
): Promise<TrackedPlanData | null> {
  return toTrackedPlan(
    await trackedPlanEngine.get({ projectId, worktreeId }, planId),
  );
}

function storedTrackedPlan(plan: StoredPlan): TrackedPlanData {
  const tracked = toTrackedPlan(plan);
  if (!tracked) throw new Error('The stored plan could not be read.');
  return tracked;
}

export async function createTrackedPlan(
  request: CreateTrackedPlanRequest,
): Promise<TrackedPlanData> {
  return storedTrackedPlan(
    await trackedPlanEngine.create({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      source: request.source,
      content: request.content,
      title: request.title,
      id: request.id,
      proposalRequestId: request.proposalRequestId,
      reviewStatus: request.reviewStatus,
      linkedExecutionId: request.linkedExecutionId,
      chatId: request.chatId,
      initiationSource: request.initiationSource,
      sourceFilePath: request.sourceFilePath,
      sourceRepoId: request.sourceRepoId,
    }),
  );
}

/** Keep the reviewed revision stable until its implementation message commits. */
export async function withTrackedPlanRevision<T>(
  request: {
    projectId: string;
    worktreeId: string;
    planId: string;
    revisionNumber: number;
    source?: TrackedPlanData['source'];
    reviewStatus?: TrackedPlanData['reviewStatus'];
  },
  commit: (plan: TrackedPlanData) => Promise<T>,
): Promise<{ accepted: false } | { accepted: true; result: T }> {
  const filePath = resolveTrackedPlansFilePath(
    request.projectId,
    request.worktreeId,
  );
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(
      request.projectId,
      request.worktreeId,
    );
    const plan = file.plans.find((entry) => entry.id === request.planId);
    if (
      !plan ||
      plan.latestRevisionNumber !== request.revisionNumber ||
      (request.source !== undefined && plan.source !== request.source) ||
      (request.reviewStatus !== undefined &&
        plan.reviewStatus !== request.reviewStatus)
    ) {
      return { accepted: false as const };
    }
    if (plan.source === 'opencode' && request.reviewStatus === 'approved') {
      // The implementation instruction reads this working copy. Its edits can
      // still be waiting for the sync debounce or another worktree turn, so
      // checking only the stored revision does not validate the reviewed bytes.
      try {
        const content = await readFile(
          getPlanExplorePlanFilePath(
            request.projectId,
            request.worktreeId,
            request.planId,
          ),
          'utf8',
        );
        if (content !== plan.content) return { accepted: false as const };
      } catch {
        // Missing or unreadable content cannot authorize implementation.
        return { accepted: false as const };
      }
    }
    return { accepted: true as const, result: await commit(plan) };
  });
}

export async function updateTrackedPlan(
  request: UpdateTrackedPlanRequest,
  guard?: {
    revisionNumber: number;
    source: TrackedPlanData['source'];
  },
): Promise<TrackedPlanData | null> {
  const plan = await trackedPlanEngine.update(
    {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      planId: request.planId,
      proposalRequestId: request.proposalRequestId,
      content: request.content,
      title: request.title,
      source: request.source,
      reviewStatus: request.reviewStatus,
      linkedExecutionId: request.linkedExecutionId,
      approvedAt: request.approvedAt,
      dismissedAt: request.dismissedAt,
      hidden: request.hidden,
      chatId: request.chatId,
      initiationSource: request.initiationSource,
      lastEditSource: request.lastEditSource,
    },
    guard,
  );
  return plan ? storedTrackedPlan(plan) : null;
}

export async function setTrackedPlanShareState(
  projectId: string,
  worktreeId: string,
  planId: string,
  share: TrackedPlanShareState | undefined | TrackedPlanShareStateUpdater,
): Promise<TrackedPlanData | null> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(projectId, worktreeId);
    const existing = file.plans.find((plan) => plan.id === planId);
    if (!existing) {
      return null;
    }

    const nextShare =
      typeof share === 'function' ? share(existing.share) : share;
    const updated: TrackedPlanData = {
      ...existing,
      ...(nextShare ? { share: nextShare } : {}),
    };
    if (!nextShare) {
      delete updated.share;
    }

    file.plans = file.plans.map((plan) =>
      plan.id === planId ? updated : plan,
    );
    await writeTrackedPlansFile(projectId, worktreeId, file);
    return updated;
  });
}

export async function saveTrackedPlanComments(
  request: SaveTrackedPlanCommentsRequest,
): Promise<TrackedPlanData | null> {
  if (!isPlanCommentThreadArray(request.commentThreads)) {
    throw new Error('Invalid plan comment threads payload.');
  }

  const filePath = resolveTrackedPlansFilePath(
    request.projectId,
    request.worktreeId,
  );
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(
      request.projectId,
      request.worktreeId,
    );
    const existing = file.plans.find((plan) => plan.id === request.planId);
    if (!existing) {
      return null;
    }
    const mergedCommentThreads = mergeCommentThreads(
      existing.commentThreads ?? [],
      request.commentThreads,
    );
    const updated: TrackedPlanData = {
      ...existing,
      commentThreads: mergedCommentThreads,
      updatedAt: new Date().toISOString(),
    };
    file.plans = file.plans.map((plan) =>
      plan.id === request.planId ? updated : plan,
    );
    await writeTrackedPlansFile(request.projectId, request.worktreeId, file);
    return updated;
  });
}

export interface AppendPlanCommentReplyRequest {
  projectId: string;
  worktreeId: string;
  planId: string;
  threadId: string;
  body: string;
  resolve?: boolean;
  /**
   * When true, reject the reply (no write, no side effects) unless the thread
   * has at least one non-draft comment. Callers that expose replies to a
   * shared collaborator (e.g. the plan-comment agent tool) set this so an
   * agent can never respond to a thread the owner has not yet submitted.
   */
  requireSubmittedThread?: boolean;
}

export interface AppendPlanCommentReplyResult {
  ok: boolean;
  plan?: TrackedPlanData;
  error?: string;
  /**
   * Set only when `requireSubmittedThread` rejected a draft-only thread, so a
   * caller can wait for the submit hand-off and retry. `error` keeps the same
   * text.
   */
  reason?: 'not-submitted';
}

/**
 * A plan comment thread's owning plan, projected to the fields a formatter or
 * caller needs without exposing the whole {@link TrackedPlanData} record.
 */
export interface PlanCommentThreadOwner {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly planId: string;
  readonly title: string;
  readonly latestRevisionNumber: number;
  readonly content: string;
}

function toPlanCommentThreadOwner(
  plan: TrackedPlanData,
): PlanCommentThreadOwner {
  return {
    projectId: plan.projectId,
    worktreeId: plan.worktreeId,
    planId: plan.id,
    title: plan.title,
    latestRevisionNumber: plan.latestRevisionNumber,
    content: plan.content,
  };
}

/**
 * Whether a plan comment thread has been submitted to the agent at least
 * once, i.e. it has at least one comment that is not still a local-only
 * draft. Draft-only threads must never be exposed to (or replied to by) an
 * agent tool.
 */
export function isPlanCommentThreadSubmitted(
  thread: PlanCommentThread,
): boolean {
  return thread.comments.some((comment) => comment.staged !== true);
}

/** Identifies one comment thread on one tracked plan. */
export interface PlanCommentThreadRef {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly planId: string;
  readonly threadId: string;
}

/**
 * How long the agent-facing plan comment tools wait for a thread to become
 * submitted before treating it as a draft. The renderer acknowledges a
 * handed-off snapshot (drafts become `staged: false`) only after the owning
 * chat accepted the send, and acceptance means the provider turn has already
 * started. A thread named in the message that started the turn can therefore
 * still be draft-only for about one IPC round trip when the agent's first
 * tool call reads or replies to it. The grace bounds that wait; a thread that
 * stays draft-only past it is treated as unsubmitted.
 */
export const PLAN_COMMENT_HANDOFF_GRACE_MS = 5_000;

type PlanCommentThreadSubmission = 'submitted' | 'draft' | 'missing';

function planCommentThreadSubmission(
  file: TrackedPlansFile,
  ref: PlanCommentThreadRef,
): PlanCommentThreadSubmission {
  const plan = file.plans.find((entry) => entry.id === ref.planId);
  const thread = plan?.commentThreads?.find(
    (entry) => entry.id === ref.threadId,
  );
  if (!thread) {
    return 'missing';
  }
  return isPlanCommentThreadSubmitted(thread) ? 'submitted' : 'draft';
}

/**
 * Wait up to `timeoutMs` for a plan comment thread to have at least one
 * submitted comment (see {@link PLAN_COMMENT_HANDOFF_GRACE_MS}). Resolves
 * `true` as soon as it does, including immediately when it already has one,
 * and `false` on timeout or once the plan or thread is gone. Never rejects.
 *
 * The write listener is registered before the current file is read, so an
 * acknowledgment that lands between the two is still observed. The plan file
 * lock is never held while waiting: the acknowledgment itself needs it.
 */
export function waitForSubmittedPlanCommentThread(
  ref: PlanCommentThreadRef,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (submitted: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeTrackedPlansWriteListener(onWrite);
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(submitted);
    };

    const check = (file: TrackedPlansFile): void => {
      const submission = planCommentThreadSubmission(file, ref);
      if (submission !== 'draft') {
        finish(submission === 'submitted');
      }
    };

    function onWrite(
      projectId: string,
      worktreeId: string,
      file: TrackedPlansFile,
    ): void {
      if (projectId === ref.projectId && worktreeId === ref.worktreeId) {
        check(file);
      }
    }

    addTrackedPlansWriteListener(onWrite);
    timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    readTrackedPlansFile(ref.projectId, ref.worktreeId).then(check, () => {
      finish(false);
    });
  });
}

export type ReadScopedPlanCommentThreadsResult =
  | { ok: false; reason: 'not-found' | 'ambiguous'; error: string }
  | {
      ok: true;
      mode: 'single';
      owner: PlanCommentThreadOwner;
      thread: PlanCommentThread;
    }
  | {
      ok: true;
      mode: 'all';
      threads: Array<{
        owner: PlanCommentThreadOwner;
        thread: PlanCommentThread;
      }>;
    };

/**
 * Read-only access to every tracked plan's comment threads within a
 * `(projectId, worktreeId)` scope, for the shared file-comment tool surface
 * (which searches file annotations, code-review, and plan storage together).
 * No file lock is needed because nothing is mutated.
 *
 * With a `threadId`, searches every plan in the scope: a match in exactly one
 * plan returns it (`mode: 'single'`); a match in more than one plan is
 * `ambiguous` (thread ids are only unique within their own store); no match is
 * `not-found`. Without a `threadId`, returns every OPEN thread across every
 * plan in the scope (`mode: 'all'`), ordered the same as {@link
 * listTrackedPlans} (most-recently-updated plan first).
 */
export async function readScopedPlanCommentThreads(request: {
  projectId: string;
  worktreeId: string;
  threadId?: string;
}): Promise<ReadScopedPlanCommentThreadsResult> {
  const file = await readTrackedPlansFile(
    request.projectId,
    request.worktreeId,
  );
  const plans = [...file.plans].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );

  if (request.threadId !== undefined) {
    const matches: Array<{
      owner: PlanCommentThreadOwner;
      thread: PlanCommentThread;
    }> = [];
    for (const plan of plans) {
      const thread = (plan.commentThreads ?? []).find(
        (entry) => entry.id === request.threadId,
      );
      if (thread) {
        matches.push({ owner: toPlanCommentThreadOwner(plan), thread });
      }
    }
    if (matches.length === 0) {
      return {
        ok: false,
        reason: 'not-found',
        error: 'Comment thread not found.',
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        error: 'Ambiguous comment thread id.',
      };
    }
    const [match] = matches;
    return {
      ok: true,
      mode: 'single',
      owner: match.owner,
      thread: match.thread,
    };
  }

  const threads: Array<{
    owner: PlanCommentThreadOwner;
    thread: PlanCommentThread;
  }> = [];
  for (const plan of plans) {
    const owner = toPlanCommentThreadOwner(plan);
    for (const thread of plan.commentThreads ?? []) {
      if (thread.status === 'open') {
        threads.push({ owner, thread });
      }
    }
  }
  return { ok: true, mode: 'all', threads };
}

/**
 * Append an agent reply to a single plan comment thread, optionally resolving
 * it. Performs a read-modify-write under the per-file lock and mutates ONLY the
 * matched thread so concurrent UI edits to other threads (or staged drafts) are
 * not clobbered. The thread's other fields (anchor, anchorState, prior
 * comments) are preserved verbatim.
 */
export async function appendPlanCommentReply(
  request: AppendPlanCommentReplyRequest,
): Promise<AppendPlanCommentReplyResult> {
  const filePath = resolveTrackedPlansFilePath(
    request.projectId,
    request.worktreeId,
  );
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(
      request.projectId,
      request.worktreeId,
    );
    const existing = file.plans.find((plan) => plan.id === request.planId);
    if (!existing) {
      return { ok: false, error: 'Plan not found.' };
    }

    const threads = existing.commentThreads ?? [];
    const thread = threads.find((entry) => entry.id === request.threadId);
    if (!thread) {
      return { ok: false, error: 'Comment thread not found.' };
    }

    if (
      request.requireSubmittedThread &&
      !isPlanCommentThreadSubmitted(thread)
    ) {
      return {
        ok: false,
        reason: 'not-submitted',
        error: 'Comment thread has not been submitted.',
      };
    }

    const now = new Date().toISOString();
    const reply: PlanComment = {
      id: randomUUID(),
      author: 'agent',
      body: request.body,
      createdAt: now,
      staged: false,
    };
    const nextThread: PlanCommentThread = {
      ...thread,
      comments: [...thread.comments, reply],
      ...(request.resolve ? { status: 'resolved' } : {}),
    };
    const nextThreads = threads.map((entry) =>
      entry.id === request.threadId ? nextThread : entry,
    );

    const updated: TrackedPlanData = {
      ...existing,
      commentThreads: nextThreads,
      updatedAt: now,
    };
    file.plans = file.plans.map((plan) =>
      plan.id === request.planId ? updated : plan,
    );
    await writeTrackedPlansFile(request.projectId, request.worktreeId, file);
    return { ok: true, plan: updated };
  });
}

export interface ReadPlanCommentThreadRequest {
  projectId: string;
  worktreeId: string;
  planId: string;
  threadId?: string;
}

export type ReadPlanCommentThreadResult =
  | { ok: false; error: string }
  | { ok: true; mode: 'single'; thread: PlanCommentThread }
  | { ok: true; mode: 'all'; threads: PlanCommentThread[] };

/**
 * Read-only access to a plan's comment threads for the plan-explore tool. With
 * a `threadId` it returns that single thread; without one it returns every
 * thread on the plan (the session-runtime formats the open-thread summary). No
 * file lock is needed because nothing is mutated.
 */
export async function readPlanCommentThread(
  request: ReadPlanCommentThreadRequest,
): Promise<ReadPlanCommentThreadResult> {
  const file = await readTrackedPlansFile(
    request.projectId,
    request.worktreeId,
  );
  const plan = file.plans.find((entry) => entry.id === request.planId);
  if (!plan) {
    return { ok: false, error: 'Plan not found.' };
  }

  const threads = plan.commentThreads ?? [];
  if (request.threadId !== undefined) {
    const thread = threads.find((entry) => entry.id === request.threadId);
    if (!thread) {
      return { ok: false, error: 'Comment thread not found.' };
    }
    return { ok: true, mode: 'single', thread };
  }

  return { ok: true, mode: 'all', threads };
}

/**
 * Persist a generated diagram artifact onto a tracked plan. This mutates only
 * the derived `diagrams` map; it does NOT alter plan content and therefore must
 * NOT invoke the content-change listener (doing so would cause generation to
 * loop forever).
 */
export async function setPlanDiagramArtifact(
  projectId: string,
  worktreeId: string,
  planId: string,
  key: 'sequence' | 'logicDiff' | 'dataModelDiff',
  artifact: AnyPlanDiagramArtifact,
): Promise<TrackedPlanData | null> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(projectId, worktreeId);
    const existing = file.plans.find((plan) => plan.id === planId);
    if (!existing) {
      return null;
    }

    const lagsCurrentRevision =
      (artifact.status === 'ready' || artifact.status === 'error') &&
      artifact.derivedFromRevision < existing.latestRevisionNumber;
    const nextArtifact = lagsCurrentRevision
      ? { ...artifact, status: 'stale' as const }
      : artifact;
    const nextDiagrams: PlanDiagramArtifacts = { ...existing.diagrams };
    if (key === 'sequence' && isSequenceArtifact(nextArtifact)) {
      nextDiagrams.sequence = nextArtifact;
    } else if (key === 'logicDiff' && isLogicDiffArtifact(nextArtifact)) {
      nextDiagrams.logicDiff = nextArtifact;
    } else if (
      key === 'dataModelDiff' &&
      isDataModelDiffArtifact(nextArtifact)
    ) {
      const existingDataModelArtifact = existing.diagrams?.dataModelDiff;
      if (
        lagsCurrentRevision &&
        (existingDataModelArtifact === undefined ||
          existingDataModelArtifact.derivedFromRevision >
            artifact.derivedFromRevision)
      ) {
        return existing;
      }
      nextDiagrams.dataModelDiff = nextArtifact;
    } else {
      return existing;
    }

    const updated: TrackedPlanData = {
      ...existing,
      diagrams: nextDiagrams,
    };
    file.plans = file.plans.map((plan) =>
      plan.id === planId ? updated : plan,
    );
    await writeTrackedPlansFile(projectId, worktreeId, file);
    emitPlanDiagramArtifactChange(updated);
    return updated;
  });
}

type AnyPlanDiagramArtifact =
  | PlanDiagramArtifact<ParsedPlanGraph>
  | PlanDiagramArtifact<LogicDiffDiagram>
  | PlanDiagramArtifact<DataModelDiffDiagram>;

function isSequenceArtifact(
  artifact: AnyPlanDiagramArtifact,
): artifact is PlanDiagramArtifact<ParsedPlanGraph> {
  const data = artifact.data;
  return data === null || isParsedPlanGraph(data);
}

function isLogicDiffArtifact(
  artifact: AnyPlanDiagramArtifact,
): artifact is PlanDiagramArtifact<LogicDiffDiagram> {
  const data = artifact.data;
  return data === null || isLogicDiffDiagram(data);
}

function isDataModelDiffArtifact(
  artifact: AnyPlanDiagramArtifact,
): artifact is PlanDiagramArtifact<DataModelDiffDiagram> {
  const data = artifact.data;
  return data === null || isDataModelDiffDiagram(data);
}

export async function removePlanDiagramArtifact(
  projectId: string,
  worktreeId: string,
  planId: string,
  key: 'dataModelDiff',
  expectedRevision: number,
): Promise<TrackedPlanData | null> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(projectId, worktreeId);
    const existing = file.plans.find((plan) => plan.id === planId);
    if (!existing) {
      return null;
    }

    if (expectedRevision < existing.latestRevisionNumber) {
      return existing;
    }

    if (!existing.diagrams?.dataModelDiff) {
      return existing;
    }

    const nextDiagrams: PlanDiagramArtifacts = { ...existing.diagrams };
    delete nextDiagrams.dataModelDiff;
    const updated: TrackedPlanData = {
      ...existing,
      diagrams: nextDiagrams,
    };
    file.plans = file.plans.map((plan) =>
      plan.id === planId ? updated : plan,
    );
    await writeTrackedPlansFile(projectId, worktreeId, file);
    emitPlanDiagramArtifactChange(updated);
    return updated;
  });
}

export async function deleteTrackedPlan(
  projectId: string,
  worktreeId: string,
  planId: string,
): Promise<void> {
  await trackedPlanEngine.delete({ projectId, worktreeId }, planId);
}

export async function deleteTrackedPlansForWorktree(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  // Under the lock, so a write in flight cannot recreate the file after it.
  await withFileLock(filePath, () => removePlanState(filePath));
}

/**
 * Installs plans captured from an archived container into a restored
 * worktree. Each plan is re-bound to the destination ids; everything else
 * (revisions, comments, diagrams, share state, execution links) is preserved
 * verbatim. An empty list is a no-op rather than clearing the destination.
 */
export async function installRestoredTrackedPlans(
  projectId: string,
  worktreeId: string,
  plans: TrackedPlanData[],
): Promise<void> {
  if (plans.length === 0) return;
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  await withFileLock(filePath, async () => {
    await writeTrackedPlansFile(projectId, worktreeId, {
      version: 1,
      plans: plans.map((plan) => ({ ...plan, projectId, worktreeId })),
    });
  });
}

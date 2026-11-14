import { randomUUID } from 'node:crypto';
import {
  PLAN_ERROR_CODES,
  PLAN_RESOURCE,
  PLAN_SOURCES,
  type PlanSource,
} from '@canopy/protocol/canopy-core';
import { derivePlanTitle } from '@canopy/protocol/plans';
import { CanopyOperationError } from '../../runtime/errors';
import {
  readPlanStateText,
  removePlanState,
  withPlanStateLock,
  writePlanStateText,
} from './state-file';

/*
 * The tracked-plan lifecycle of one worktree (CAN-4165): list, get, create,
 * update and delete over the v1 plans file, with the revision, proposal
 * replay and review-state rules desktop has always applied. It is the one
 * implementation: desktop's plan-persistence wraps it, and the core.plan
 * operations will dispatch to it.
 *
 * Records keep every field the engine does not know (comment threads,
 * diagrams, share state) verbatim; a host transform updates those when the
 * content changes. Reads are forgiving, as they have always been; a write
 * over a file it cannot read is refused rather than replacing it.
 */

export type StoredPlanReviewStatus = 'pending' | 'approved' | 'dismissed';
export type StoredPlanEditSource = 'agent' | 'pipeline';

export interface StoredPlanRevision {
  readonly [field: string]: unknown;
  revisionNumber: number;
  content: string;
  source: string;
  reviewStatus: StoredPlanReviewStatus;
  createdAt: string;
  approvedAt?: string;
  dismissedAt?: string;
  proposalRequestId?: string;
}

export interface StoredPlan {
  readonly [field: string]: unknown;
  id: string;
  projectId: string;
  worktreeId: string;
  source: string;
  title: string;
  content: string;
  reviewStatus: StoredPlanReviewStatus;
  createdAt: string;
  updatedAt: string;
  latestRevisionNumber: number;
  revisions: StoredPlanRevision[];
  linkedExecutionIds: string[];
  approvedAt?: string;
  dismissedAt?: string;
  hidden?: boolean;
  proposalChatId?: string;
  lastEditSource?: StoredPlanEditSource;
  sourceFilePath?: string;
  sourceRepoId?: string;
}

export interface PlanScopeIds {
  projectId: string;
  worktreeId: string;
}

export interface CreatePlanInput extends PlanScopeIds {
  source: string;
  content: string;
  title?: string;
  /** With an id already stored, that plan is returned unchanged. */
  id?: string;
  proposalRequestId?: string;
  reviewStatus?: StoredPlanReviewStatus;
  linkedExecutionId?: string;
  chatId?: string;
  /** Who started the write, carried to the host's commit hook only. */
  initiationSource?: string;
  sourceFilePath?: string;
  sourceRepoId?: string;
}

export interface UpdatePlanInput extends PlanScopeIds {
  planId: string;
  /** With it, a write against another revision is refused. */
  expectedRevision?: number;
  proposalRequestId?: string;
  content?: string;
  title?: string;
  source?: string;
  reviewStatus?: StoredPlanReviewStatus;
  linkedExecutionId?: string;
  approvedAt?: string | null;
  dismissedAt?: string | null;
  hidden?: boolean;
  lastEditSource?: StoredPlanEditSource;
  chatId?: string;
  /** Who started the write, carried to the host's commit hook only. */
  initiationSource?: string;
}

/** Desktop's revision guard: answer null unless the plan still matches. */
export interface PlanUpdateGuard {
  revisionNumber: number;
  source: string;
}

export type PlanCommit =
  | { kind: 'created'; plan: StoredPlan }
  | { kind: 'updated'; previous: StoredPlan; plan: StoredPlan }
  | { kind: 'deleted'; planId: string };

export interface PlanEngineHost {
  /** The worktree's plans file, from the host's canonical path helper. */
  statePath(this: void, scope: PlanScopeIds): string;
  /**
   * The record after its content changed, with derived fields the engine
   * does not own (diagrams, comment anchors) brought up to date.
   */
  onContentChange?(this: void, plan: StoredPlan): StoredPlan;
  /**
   * Runs under the file's lock once a write is durable, with the stored
   * plans and what changed. Its failures are logged by the host, never
   * thrown: the write already happened.
   */
  /**
   * A read skipped `skipped` records it could not read, and listed the rest
   * (CAN-6666). Writes still refuse the file, so nothing is lost.
   */
  onSkippedRecords?(this: void, scope: PlanScopeIds, skipped: number): void;
  afterCommit?(
    this: void,
    scope: PlanScopeIds,
    plans: readonly StoredPlan[],
    commit: PlanCommit,
    input: CreatePlanInput | UpdatePlanInput | undefined,
  ): void;
  now?(this: void): string;
  newId?(this: void): string;
}

export interface PlanEngine {
  /** Newest first; an unreadable file reads as empty, as it always has. */
  list(scope: PlanScopeIds): Promise<StoredPlan[]>;
  /**
   * `list`, with the number of stored records it skipped because it
   * couldn't read them (CAN-6666), so a view can tell the person.
   */
  listWithSkipped(
    scope: PlanScopeIds,
  ): Promise<{ plans: StoredPlan[]; skipped: number }>;
  get(scope: PlanScopeIds, planId: string): Promise<StoredPlan | null>;
  create(input: CreatePlanInput): Promise<StoredPlan>;
  update(
    input: UpdatePlanInput,
    guard?: PlanUpdateGuard,
  ): Promise<StoredPlan | null>;
  /** False when the scope did not have the plan. */
  delete(scope: PlanScopeIds, planId: string): Promise<boolean>;
}

const REVIEW_STATUSES: ReadonlySet<unknown> = new Set([
  'pending',
  'approved',
  'dismissed',
]);
const SOURCES: ReadonlySet<unknown> = new Set(PLAN_SOURCES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isStoredPlanRevision(value: unknown): value is StoredPlanRevision {
  return (
    isRecord(value) &&
    typeof value.revisionNumber === 'number' &&
    typeof value.content === 'string' &&
    typeof value.source === 'string' &&
    REVIEW_STATUSES.has(value.reviewStatus) &&
    typeof value.createdAt === 'string' &&
    isOptionalString(value.approvedAt) &&
    isOptionalString(value.dismissedAt) &&
    isOptionalString(value.proposalRequestId)
  );
}

/**
 * A plan the engine can carry. Structural only, so a plan from a newer or
 * differently-sourced writer is kept and passed through rather than
 * treated as damage.
 */
export function isStoredPlan(value: unknown): value is StoredPlan {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.source === 'string' &&
    typeof value.title === 'string' &&
    typeof value.content === 'string' &&
    REVIEW_STATUSES.has(value.reviewStatus) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.latestRevisionNumber === 'number' &&
    Array.isArray(value.revisions) &&
    value.revisions.every(isStoredPlanRevision) &&
    Array.isArray(value.linkedExecutionIds) &&
    value.linkedExecutionIds.every((id) => typeof id === 'string') &&
    isOptionalString(value.approvedAt) &&
    isOptionalString(value.dismissedAt) &&
    (value.hidden === undefined || typeof value.hidden === 'boolean') &&
    isOptionalString(value.proposalChatId) &&
    (value.lastEditSource === undefined ||
      value.lastEditSource === 'agent' ||
      value.lastEditSource === 'pipeline') &&
    isOptionalString(value.sourceFilePath) &&
    isOptionalString(value.sourceRepoId)
  );
}

type PlansFileRead =
  | { kind: 'ok'; plans: StoredPlan[]; skipped: number }
  | { kind: 'damaged'; cause: unknown };

/**
 * `strict` (every write) treats one unreadable record as a damaged file, so a
 * write never drops what it could not read. `lenient` (reads) skips such
 * records and counts them, so one bad record doesn't hide the rest.
 */
function parsePlansFile(
  text: string | null,
  mode: 'strict' | 'lenient',
): PlansFileRead {
  if (text === null) return { kind: 'ok', plans: [], skipped: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { kind: 'damaged', cause };
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.plans))
    return { kind: 'damaged', cause: new Error('Unsupported plans file.') };
  const plans = parsed.plans.filter(isStoredPlan);
  const skipped = parsed.plans.length - plans.length;
  if (skipped > 0 && mode === 'strict')
    return { kind: 'damaged', cause: new Error('Unsupported plans file.') };
  return { kind: 'ok', plans, skipped };
}

function damagedStateError(cause: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'failed_precondition',
      code: PLAN_ERROR_CODES.DAMAGED_STATE,
      message:
        "This worktree's plans could not be read, so they were left unchanged.",
      details: { reason: 'DAMAGED_STATE' },
      retry: { kind: 'never' },
    },
    cause,
  );
}

function invalidArgument(message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    message,
    retry: { kind: 'never' },
  });
}

function proposalConflict(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    message:
      'This proposal request was already used for different plan content.',
    retry: { kind: 'never' },
  });
}

function revisionConflict(currentRevision: number): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    code: PLAN_ERROR_CODES.REVISION_CONFLICT,
    message: 'The plan changed since it was read.',
    details: { reason: 'REVISION_CONFLICT', currentRevision },
    retry: { kind: 'after_refresh', resource: PLAN_RESOURCE },
  });
}

function assertSource(source: string): asserts source is PlanSource {
  if (!SOURCES.has(source))
    throw invalidArgument(`Unknown plan source: ${source}`);
}

function validateProposalRequestId(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== 'string' || !value.trim() || value.length > 256)
  )
    throw invalidArgument('The proposal request identity is invalid.');
}

function assertProposalReplay(
  plan: StoredPlan,
  requestId: string,
  content: string | undefined,
  source: string,
): void {
  const revision = plan.revisions.find(
    (entry) => entry.proposalRequestId === requestId,
  );
  if (!revision || revision.content !== content || revision.source !== source)
    throw proposalConflict();
}

function linkExecutionIds(
  current: string[],
  linkedExecutionId: string | undefined,
): string[] {
  if (!linkedExecutionId || current.includes(linkedExecutionId)) return current;
  return [...current, linkedExecutionId];
}

export function createPlanEngine(host: PlanEngineHost): PlanEngine {
  const now = host.now ?? ((): string => new Date().toISOString());
  const newId = host.newId ?? ((): string => randomUUID());

  const readForWrite = async (path: string): Promise<StoredPlan[]> => {
    let text: string | null;
    try {
      text = await readPlanStateText(path);
    } catch (cause) {
      throw damagedStateError(cause);
    }
    const read = parsePlansFile(text, 'strict');
    if (read.kind === 'damaged') throw damagedStateError(read.cause);
    return read.plans;
  };

  const commit = async (
    scope: PlanScopeIds,
    path: string,
    plans: StoredPlan[],
    change: PlanCommit,
    input?: CreatePlanInput | UpdatePlanInput,
  ): Promise<void> => {
    if (plans.length === 0) await removePlanState(path);
    else
      await writePlanStateText(
        path,
        JSON.stringify({ version: 1, plans }, null, 2),
      );
    host.afterCommit?.(scope, plans, change, input);
  };

  const listWithSkipped = async (
    scope: PlanScopeIds,
  ): Promise<{ plans: StoredPlan[]; skipped: number }> => {
    let read: PlansFileRead;
    try {
      read = parsePlansFile(
        await readPlanStateText(host.statePath(scope)),
        'lenient',
      );
    } catch {
      return { plans: [], skipped: 0 };
    }
    if (read.kind === 'damaged') return { plans: [], skipped: 0 };
    if (read.skipped > 0) host.onSkippedRecords?.(scope, read.skipped);
    return {
      plans: [...read.plans].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
      skipped: read.skipped,
    };
  };
  const list = async (scope: PlanScopeIds): Promise<StoredPlan[]> =>
    (await listWithSkipped(scope)).plans;

  const update = async (
    input: UpdatePlanInput,
    guard?: PlanUpdateGuard,
  ): Promise<StoredPlan | null> => {
    validateProposalRequestId(input.proposalRequestId);
    if (input.proposalRequestId && input.content === undefined)
      throw invalidArgument('A proposal revision requires plan content.');
    if (input.source !== undefined) assertSource(input.source);
    const path = host.statePath(input);
    return withPlanStateLock(path, async () => {
      const plans = await readForWrite(path);
      const existing = plans.find((plan) => plan.id === input.planId);
      if (
        !existing ||
        (guard &&
          (existing.latestRevisionNumber !== guard.revisionNumber ||
            existing.source !== guard.source))
      )
        return null;

      if (
        input.proposalRequestId &&
        existing.revisions.some(
          (revision) => revision.proposalRequestId === input.proposalRequestId,
        )
      ) {
        assertProposalReplay(
          existing,
          input.proposalRequestId,
          input.content,
          input.source ?? existing.source,
        );
        return existing;
      }

      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== existing.latestRevisionNumber
      )
        throw revisionConflict(existing.latestRevisionNumber);

      const updatedAt = now();
      const contentChanged = input.content !== undefined;
      const nextContent = input.content ?? existing.content;
      const nextTitle =
        input.title?.trim() ||
        (contentChanged ? derivePlanTitle(nextContent) : existing.title);
      const nextSource = input.source ?? existing.source;
      const nextReviewStatus = input.reviewStatus ?? existing.reviewStatus;
      const nextRevisionNumber = contentChanged
        ? existing.latestRevisionNumber + 1
        : existing.latestRevisionNumber;
      const preserveExistingApprovedAt =
        input.approvedAt !== null &&
        existing.reviewStatus === 'approved' &&
        nextReviewStatus === 'approved' &&
        existing.approvedAt !== undefined;
      const nextApprovedAt =
        input.approvedAt === null
          ? undefined
          : preserveExistingApprovedAt
            ? existing.approvedAt
            : (input.approvedAt ?? existing.approvedAt);
      const nextDismissedAt =
        input.dismissedAt === null
          ? undefined
          : (input.dismissedAt ?? existing.dismissedAt);
      const revisions = contentChanged
        ? [
            ...existing.revisions,
            {
              ...(input.proposalRequestId
                ? { proposalRequestId: input.proposalRequestId }
                : {}),
              revisionNumber: nextRevisionNumber,
              content: nextContent,
              source: nextSource,
              reviewStatus: nextReviewStatus,
              createdAt: updatedAt,
              ...(nextApprovedAt ? { approvedAt: nextApprovedAt } : {}),
              ...(nextDismissedAt ? { dismissedAt: nextDismissedAt } : {}),
            },
          ]
        : existing.revisions;
      const nextHidden =
        input.hidden !== undefined ? input.hidden : existing.hidden;

      let updated: StoredPlan = {
        ...existing,
        source: nextSource,
        title: nextTitle,
        content: nextContent,
        reviewStatus: nextReviewStatus,
        updatedAt,
        latestRevisionNumber: nextRevisionNumber,
        revisions,
        linkedExecutionIds: linkExecutionIds(
          existing.linkedExecutionIds,
          input.linkedExecutionId,
        ),
        ...(nextApprovedAt ? { approvedAt: nextApprovedAt } : {}),
        ...(nextDismissedAt ? { dismissedAt: nextDismissedAt } : {}),
        ...(nextHidden !== undefined ? { hidden: nextHidden } : {}),
        ...(input.lastEditSource
          ? { lastEditSource: input.lastEditSource }
          : {}),
      };
      if (!nextApprovedAt) delete updated.approvedAt;
      if (!nextDismissedAt) delete updated.dismissedAt;
      // Derived fields the engine does not own change only with the content;
      // other updates leave them untouched.
      if (contentChanged && host.onContentChange)
        updated = host.onContentChange(updated);

      const next = plans.map((plan) =>
        plan.id === input.planId ? updated : plan,
      );
      await commit(
        input,
        path,
        next,
        { kind: 'updated', previous: existing, plan: updated },
        input,
      );
      return updated;
    });
  };

  return {
    list,
    listWithSkipped,

    async get(scope, planId): Promise<StoredPlan | null> {
      return (await list(scope)).find((plan) => plan.id === planId) ?? null;
    },

    async create(input): Promise<StoredPlan> {
      validateProposalRequestId(input.proposalRequestId);
      assertSource(input.source);
      const proposalChatId =
        input.source === 'cursor' && input.proposalRequestId && !input.id
          ? input.chatId
          : undefined;
      if (
        proposalChatId !== undefined &&
        (typeof proposalChatId !== 'string' ||
          proposalChatId.length === 0 ||
          proposalChatId.length > 256)
      )
        throw invalidArgument('Invalid proposal chat identity.');
      const path = host.statePath(input);
      const result = await withPlanStateLock<
        { kind: 'plan'; plan: StoredPlan } | { kind: 'pending'; planId: string }
      >(path, async () => {
        const plans = await readForWrite(path);

        if (input.proposalRequestId) {
          const replay = plans.find((plan) =>
            plan.revisions.some(
              (revision) =>
                revision.proposalRequestId === input.proposalRequestId,
            ),
          );
          if (replay) {
            assertProposalReplay(
              replay,
              input.proposalRequestId,
              input.content,
              input.source,
            );
            return { kind: 'plan', plan: replay };
          }
        }

        // Idempotent with an explicit id: the stored plan, unchanged.
        if (input.id) {
          const existing = plans.find((plan) => plan.id === input.id);
          if (existing) return { kind: 'plan', plan: existing };
        }

        if (proposalChatId && (input.reviewStatus ?? 'pending') === 'pending') {
          const pending = plans.filter(
            (plan) =>
              plan.source === 'cursor' &&
              plan.proposalChatId === proposalChatId &&
              plan.reviewStatus === 'pending',
          );
          if (pending.length > 1)
            throw new CanopyOperationError({
              kind: 'conflict',
              message: 'Multiple pending plans match this proposal chat.',
              retry: { kind: 'never' },
            });
          const [existing] = pending;
          if (existing) return { kind: 'pending', planId: existing.id };
        }

        const createdAt = now();
        const reviewStatus = input.reviewStatus ?? 'pending';
        const plan: StoredPlan = {
          id: input.id ?? newId(),
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          source: input.source,
          ...(proposalChatId ? { proposalChatId } : {}),
          title: input.title?.trim() || derivePlanTitle(input.content),
          content: input.content,
          reviewStatus,
          createdAt,
          updatedAt: createdAt,
          latestRevisionNumber: 1,
          ...(reviewStatus === 'approved' ? { approvedAt: createdAt } : {}),
          ...(reviewStatus === 'dismissed' ? { dismissedAt: createdAt } : {}),
          revisions: [
            {
              ...(input.proposalRequestId
                ? { proposalRequestId: input.proposalRequestId }
                : {}),
              revisionNumber: 1,
              content: input.content,
              source: input.source,
              reviewStatus,
              createdAt,
              ...(reviewStatus === 'approved' ? { approvedAt: createdAt } : {}),
              ...(reviewStatus === 'dismissed'
                ? { dismissedAt: createdAt }
                : {}),
            },
          ],
          linkedExecutionIds: input.linkedExecutionId
            ? [input.linkedExecutionId]
            : [],
          ...(input.sourceFilePath
            ? { sourceFilePath: input.sourceFilePath }
            : {}),
          ...(input.sourceRepoId ? { sourceRepoId: input.sourceRepoId } : {}),
        };
        const next = [plan, ...plans];
        await commit(input, path, next, { kind: 'created', plan }, input);
        return { kind: 'plan', plan };
      });
      if (result.kind === 'plan') return result.plan;
      // The creation lock is released before the revision writer takes it.
      // The stored association survives a failed update or a reload.
      const updated = await update({
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        planId: result.planId,
        proposalRequestId: input.proposalRequestId,
        source: input.source,
        content: input.content,
        title: input.title,
        reviewStatus: 'pending',
        approvedAt: null,
        dismissedAt: null,
        chatId: input.chatId,
        initiationSource: input.initiationSource,
      });
      if (!updated)
        throw new CanopyOperationError({
          kind: 'conflict',
          message: 'The pending proposal plan is no longer available.',
          retry: { kind: 'never' },
        });
      return updated;
    },

    update,

    async delete(scope, planId): Promise<boolean> {
      const path = host.statePath(scope);
      return withPlanStateLock(path, async () => {
        const plans = await readForWrite(path);
        const next = plans.filter((plan) => plan.id !== planId);
        if (next.length === plans.length) return false;
        await commit(scope, path, next, { kind: 'deleted', planId });
        return true;
      });
    },
  };
}

import { types } from 'node:util';
import type { z } from 'zod';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  PLAN_ERROR_CODES,
  PLAN_SOURCES,
  type PlanCreateParamsSchema,
  type PlanRecord,
  type PlanScope,
  type PlanSource,
  type PlanUpdateParamsSchema,
} from '@canopy/protocol/canopy-core';
import type {
  CreateTrackedPlanRequest,
  TrackedPlanData,
  UpdateTrackedPlanRequest,
} from '@canopy/desktop-shared/types';
import { isTrackedPlanData } from '../lib/plan-persistence';

const PLAN_SOURCE_NAMES: ReadonlySet<string> = new Set(PLAN_SOURCES);

function isPlanSource(source: string): source is PlanSource {
  return PLAN_SOURCE_NAMES.has(source);
}

/** Refused before dispatch with the engine's own message, as it always was. */
export function knownSource(source: string): PlanSource {
  if (isPlanSource(source)) return source;
  throw new CanopyOperationError({
    kind: 'invalid_argument',
    message: `Unknown plan source: ${source}`,
    retry: { kind: 'never' },
  });
}

/**
 * The error a caller answered before it dispatched: a scope with no plans,
 * or a failure the dispatcher reports as internal, keeps its original error;
 * a typed refusal is answered as it is.
 */
export function legacyError(error: unknown): unknown {
  if (
    error instanceof CanopyOperationError &&
    // A Node errno error may come from another realm, which instanceof misses.
    (error.runtimeCause instanceof Error ||
      types.isNativeError(error.runtimeCause)) &&
    (error.payload.kind === 'internal' ||
      error.payload.code === PLAN_ERROR_CODES.UNSUPPORTED_SCOPE)
  )
    return error.runtimeCause;
  return error;
}

export function trackedPlan(record: PlanRecord | null): TrackedPlanData | null {
  return record && isTrackedPlanData(record) ? record : null;
}

export function writtenTrackedPlan(record: PlanRecord | null): TrackedPlanData {
  const plan = trackedPlan(record);
  if (!plan) throw new Error('The stored plan could not be read.');
  return plan;
}

export function planCreateParams(
  scope: PlanScope,
  request: CreateTrackedPlanRequest,
): z.input<typeof PlanCreateParamsSchema> {
  return {
    scope,
    source: knownSource(request.source),
    content: request.content,
    title: request.title,
    planId: request.id,
    proposalRequestId: request.proposalRequestId,
    reviewStatus: request.reviewStatus,
    linkedExecutionId: request.linkedExecutionId,
    chatId: request.chatId,
    sourceFilePath: request.sourceFilePath,
    sourceRepoId: request.sourceRepoId,
    initiationSource: request.initiationSource,
  };
}

export function planUpdateParams(
  scope: PlanScope,
  request: UpdateTrackedPlanRequest,
): z.input<typeof PlanUpdateParamsSchema> {
  return {
    scope,
    planId: request.planId,
    proposalRequestId: request.proposalRequestId,
    content: request.content,
    title: request.title,
    source:
      request.source === undefined ? undefined : knownSource(request.source),
    reviewStatus: request.reviewStatus,
    linkedExecutionId: request.linkedExecutionId,
    approvedAt: request.approvedAt,
    dismissedAt: request.dismissedAt,
    hidden: request.hidden,
    chatId: request.chatId,
    lastEditSource: request.lastEditSource,
    initiationSource: request.initiationSource,
  };
}

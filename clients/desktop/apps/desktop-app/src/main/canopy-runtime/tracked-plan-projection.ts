import { isAbsolute, normalize, sep } from 'node:path';
import { types } from 'node:util';
import type { z } from 'zod';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  PLAN_ERROR_CODES,
  PLAN_SOURCES,
  type PlanCreateParamsSchema,
  type PlanImportParamsSchema,
  type PlanRecord,
  type PlanScope,
  type PlanSource,
  type PlanUpdateParamsSchema,
} from '@canopy/protocol/canopy-core';
import {
  isTrackedPlanData,
  type CreateTrackedPlanRequest,
  type ImportTrackedPlanRequest,
  type TrackedPlanData,
  type UpdateTrackedPlanRequest,
} from '@canopy/desktop-shared/types';
import {
  trackedPlanImportParams,
  trackedPlanCreateParams,
  trackedPlanUpdateParams,
} from '@canopy/desktop-shared/lib/tracked-plan-params';

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
 * an import path plan-import refused, or a failure the dispatcher reports as
 * internal, keeps its original error; a typed refusal is answered as it is.
 */
export function legacyError(error: unknown): unknown {
  if (
    error instanceof CanopyOperationError &&
    // A Node errno error may come from another realm, which instanceof misses.
    (error.runtimeCause instanceof Error ||
      types.isNativeError(error.runtimeCause)) &&
    (error.payload.kind === 'internal' ||
      error.payload.code === PLAN_ERROR_CODES.UNSUPPORTED_SCOPE ||
      error.payload.code === PLAN_ERROR_CODES.IMPORT_PATH)
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

/** A create the engine refuses for its source is refused before dispatch. */
export function planCreateParams(
  scope: PlanScope,
  request: CreateTrackedPlanRequest,
): z.input<typeof PlanCreateParamsSchema> {
  return {
    ...trackedPlanCreateParams(scope, request),
    source: knownSource(request.source),
  };
}

export function planUpdateParams(
  scope: PlanScope,
  request: UpdateTrackedPlanRequest,
): z.input<typeof PlanUpdateParamsSchema> {
  return {
    ...trackedPlanUpdateParams(scope, request),
    ...(request.source === undefined
      ? {}
      : { source: knownSource(request.source) }),
  };
}

/**
 * Refused before dispatch with plan-import's own messages, as it always was:
 * the operation takes only a worktree-relative path that stays inside it.
 */
export function planImportParams(
  scope: PlanScope,
  request: ImportTrackedPlanRequest & { filePath: string },
): z.input<typeof PlanImportParamsSchema> {
  return trackedPlanImportParams(scope, request, {
    isAbsolute,
    normalize: (path) => normalize(path).split(sep).join('/'),
  });
}

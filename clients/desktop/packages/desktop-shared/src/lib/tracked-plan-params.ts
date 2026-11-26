import type { z } from 'zod';
import type {
  DetectedPlanScanParamsSchema,
  DetectedPlanUpdateParamsSchema,
  PlanCreateParamsSchema,
  PlanImportParamsSchema,
  PlanScope,
  PlanUpdateParamsSchema,
} from '@canopy/protocol/canopy-core';
import { isSafePortableRelativePath } from '@canopy/protocol/safe-relative-path';
import type {
  CreateTrackedPlanRequest,
  DetectedPlanUpdateRequest,
  DetectedPlansScanRequest,
  ImportTrackedPlanRequest,
  UpdateTrackedPlanRequest,
} from '../types';

/*
 * The tracked- and detected-plan requests as core.plan params, shared by
 * main's IPC projections and the main window's relay writes (CAN-4165 PRs 7b
 * and 7c), so both send the same fields and refuse the same import paths with
 * the same words.
 */

/**
 * The params without their undefined-valued keys: the relay carries them as
 * JSON, which has no undefined. A null stays, since it clears a value.
 */
function defined<T extends Record<string, unknown>>(params: T): T {
  const copy = { ...params };
  for (const key of Object.keys(copy))
    if (copy[key] === undefined) delete copy[key];
  return copy;
}

export function trackedPlanCreateParams(
  scope: PlanScope,
  request: CreateTrackedPlanRequest,
): z.input<typeof PlanCreateParamsSchema> {
  return defined({
    scope,
    source: request.source,
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
  });
}

export function trackedPlanUpdateParams(
  scope: PlanScope,
  request: UpdateTrackedPlanRequest,
): z.input<typeof PlanUpdateParamsSchema> {
  return defined({
    scope,
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
    lastEditSource: request.lastEditSource,
    initiationSource: request.initiationSource,
  });
}

interface ImportPathHost {
  isAbsolute(path: string): boolean;
  /** To '/'-separated form; identity where the caller can't normalise. */
  normalize(path: string): string;
}

const AS_GIVEN: ImportPathHost = {
  isAbsolute: (path) => /^(?:[/\\]|[A-Za-z]:[/\\])/.test(path),
  normalize: (path) => path,
};

/**
 * The core.plan.import params, or plan-import's own refusal of the path. Main
 * normalises the path first; the renderer sends it as given, so a path such as
 * `./plan.md` is refused there rather than normalised.
 */
export function trackedPlanImportParams(
  scope: PlanScope,
  request: ImportTrackedPlanRequest & { filePath: string },
  host: ImportPathHost = AS_GIVEN,
): z.input<typeof PlanImportParamsSchema> {
  if (!request.repoId)
    throw new Error(
      'Plan import requires repoId; use WORKSPACE_ROOT_REPO_ID for the worktree root.',
    );
  if (host.isAbsolute(request.filePath))
    throw new Error('Plan import paths must be relative to the worktree.');
  // A portable path can't carry one, so a macOS name with a literal backslash
  // is refused here with its own message rather than as invalid parameters.
  if (request.filePath.includes('\\'))
    throw new Error("Plan import paths can't contain a backslash.");
  const path = host.normalize(request.filePath);
  if (path === '..' || path.startsWith('../'))
    throw new Error('Plan import path must stay inside the worktree.');
  // Any other shape core's portable path refuses (a drive-like prefix such as
  // 'A: Plan.md', a trailing slash) gets a clear message, not invalid params.
  if (!isSafePortableRelativePath(path))
    throw new Error(
      'Plan import paths must be plain relative paths inside the worktree.',
    );
  return defined({
    scope,
    repoId: request.repoId,
    path,
    initiationSource: request.initiationSource,
  });
}

/** The scan's longest candidate path; a longer one can't match a rule. */
const MAX_CANDIDATE_PATH = 4_096;

/** Drops the paths no rule can match, which the scan would refuse whole. */
export function detectedPlanScanParams(
  scope: PlanScope,
  request: DetectedPlansScanRequest,
): z.input<typeof DetectedPlanScanParamsSchema> {
  return {
    scope,
    chatId: request.chatId,
    candidatePaths: request.candidatePaths.filter(
      (path) => path.length > 0 && path.length <= MAX_CANDIDATE_PATH,
    ),
  };
}

export function detectedPlanUpdateParams(
  scope: PlanScope,
  request: DetectedPlanUpdateRequest,
): z.input<typeof DetectedPlanUpdateParamsSchema> {
  return {
    scope,
    entryId: request.entryId,
    ...(request.status ? { status: request.status } : {}),
    ...(request.bannerSeen !== undefined
      ? { bannerSeen: request.bannerSeen }
      : {}),
    ...(request.importedPlanId
      ? { importedPlanId: request.importedPlanId }
      : {}),
  };
}

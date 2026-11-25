import {
  CanopyOperationError,
  canopyCancelledError,
  canopyInternalError,
  type CanopyDispatcherHandlerMap,
  type CanopyDispatcherInstructionHandlerMap,
} from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import type {
  DetectedPlanEntry,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import {
  DetectedPlanSchema,
  PLAN_DIAGRAM_ERROR_CODES,
  PLAN_DIAGRAM_KINDS,
  PLAN_ERROR_CODES,
  PLAN_RESOURCE,
  PlanRecordSchema,
  type CanopyCallerDescriptor,
  type DetectedPlan,
  type PlanRecord,
} from '@canopy/protocol/canopy-core';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type { DesktopInstructionDefinitions } from './desktop-instruction-definitions';
import type { DesktopQueryDefinitions } from './desktop-query-definitions';
import {
  desktopPlanOperations,
  type DesktopPlanOperations,
} from './plan-operations';
import type * as PlanDiagramHost from './plan-diagram-host';
import {
  publishDispatchedPlanChange,
  type DispatchedPlanChange,
} from './plan-update-publisher';

/*
 * Registers the tracked-plan lifecycle of `core.plan.*` on the desktop
 * dispatcher (CAN-4165 PR 3b-2): list, get, create, update and delete over
 * the plan engine behind plan-persistence, and import (PR 5a) over plan-import.
 * The `tracked-plans:*` IPC handlers, and Remote Control through them, reach
 * plans only through these operations, but for the import channel's browse
 * branch, whose dialog-picked file has no worktree path. The detected-plan
 * list, scan and update (PR 5b) run over the detected-plans writer. A
 * detected-plan write from another binding reaches every window (PR 7c).
 */

type PlanQueryName =
  | 'core.plan.list'
  | 'core.plan.get'
  | 'core.plan.detected.list';
type PlanInstructionName =
  | 'core.plan.create'
  | 'core.plan.update'
  | 'core.plan.delete'
  | 'core.plan.import'
  | 'core.plan.detected.scan'
  | 'core.plan.detected.update'
  | 'core.plan.diagram.generate';

export interface CorePlanAdapter {
  queries: Pick<
    CanopyDispatcherHandlerMap<DesktopQueryDefinitions>,
    PlanQueryName
  >;
  instructions: Pick<
    CanopyDispatcherInstructionHandlerMap<DesktopInstructionDefinitions>,
    PlanInstructionName
  >;
}

/**
 * A stored plan as the portable record. A plan that an early import build
 * saved with a host path as its source file keeps everything but that path,
 * which no portable record carries. Null when the plan still doesn't fit.
 */
function toPlanRecord(plan: TrackedPlanData): PlanRecord | null {
  const parsed = PlanRecordSchema.safeParse(plan);
  if (parsed.success) return parsed.data;
  const { sourceFilePath, ...withoutHostPath } = plan;
  if (sourceFilePath === undefined) return null;
  const repaired = PlanRecordSchema.safeParse(withoutHostPath);
  return repaired.success ? repaired.data : null;
}

function unreadablePlan(scope: {
  projectId: string;
  worktreeId: string;
}): void {
  logMainProcessWarn('[tracked-plans] a stored plan is not a portable record', {
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
  });
}

/** Stored entries as portable records; one that doesn't fit is left out. */
function portableDetected(
  scope: { projectId: string; worktreeId: string },
  entries: DetectedPlanEntry[],
): DetectedPlan[] {
  const detected: DetectedPlan[] = [];
  for (const entry of entries) {
    const parsed = DetectedPlanSchema.safeParse(entry);
    if (parsed.success) detected.push(parsed.data);
  }
  if (detected.length < entries.length)
    logMainProcessWarn(
      '[detected-plans] a stored entry is not a portable record',
      { projectId: scope.projectId, worktreeId: scope.worktreeId },
    );
  return detected;
}

/** A plan this write just stored; it always fits the portable record. */
function writtenRecord(plan: TrackedPlanData): PlanRecord {
  const record = toPlanRecord(plan);
  if (!record) throw canopyInternalError('The written plan could not be read.');
  return record;
}

function keyReused(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    message: 'This idempotency key was used with other parameters.',
    retry: { kind: 'never' },
  });
}

/** Diagram generation, as the desktop diagram scheduler serves it. */
export interface PlanDiagramRequests {
  /** Why no harness serves the configured diagram model, or null. */
  modelUnavailable(): Promise<string | null>;
  request(
    plan: TrackedPlanData,
    attended: boolean,
  ): Promise<'started' | 'queued'>;
}

// The host pulls in the generators and helper runs, which import the
// dispatcher's own graph; loading it on first use keeps that out of a cycle.
let diagramHost: typeof PlanDiagramHost | undefined;
const loadDiagramHost = async (): Promise<typeof PlanDiagramHost> =>
  (diagramHost ??= await import('./plan-diagram-host'));
const desktopPlanDiagrams: PlanDiagramRequests = {
  modelUnavailable: async () =>
    (await loadDiagramHost()).planDiagramModelUnavailable(),
  request: async (plan, attended) =>
    (await loadDiagramHost()).requestPlanDiagramGeneration(plan, attended),
};

export interface CorePlanAdapterOptions {
  operations?: DesktopPlanOperations;
  publish?: (change: DispatchedPlanChange) => void;
  diagrams?: PlanDiagramRequests;
}

/**
 * Whether a person asked: the desktop window's user, or a paired controller
 * acting as its own device. Only their requests may fall back to AI Credits
 * for lack of a native login; every other principal, whatever its
 * `initiationSource`, is a background caller.
 */
function isPersonCaller(caller: CanopyCallerDescriptor): boolean {
  return (
    caller.principalId === 'local-desktop-user' ||
    caller.principalId.startsWith('remote-device:')
  );
}

/** Whether `kinds` names every diagram kind, which is all this version serves. */
function namesEveryKind(kinds: readonly string[]): boolean {
  return PLAN_DIAGRAM_KINDS.every((kind) => kinds.includes(kind));
}

export function createCorePlanAdapter({
  operations = desktopPlanOperations,
  publish = publishDispatchedPlanChange,
  diagrams = desktopPlanDiagrams,
}: CorePlanAdapterOptions = {}): CorePlanAdapter {
  // A repeat under the same caller and key answers the first outcome without
  // writing again; a failed attempt may be retried under its key.
  const forget = (): boolean => true;
  const creates = new KeyedOutcomes<{ plan: PlanRecord }>({
    reusedError: keyReused,
    forget,
  });
  const updates = new KeyedOutcomes<{ plan: PlanRecord | null }>({
    reusedError: keyReused,
    forget,
  });
  const deletes = new KeyedOutcomes<{ deleted: boolean }>({
    reusedError: keyReused,
    forget,
  });
  // An import answers the whole document, and the channel keys every call
  // afresh, so only the recent outcomes a retry could replay are kept.
  // shortcut: a count cap, not a byte budget; CAN-7633 adds one for all writes.
  const imports = new KeyedOutcomes<{ plan: PlanRecord }>({
    reusedError: keyReused,
    forget,
    max: 16,
  });
  // Each answers the whole detected list, and the channels key every call
  // afresh, so only the recent outcomes a retry could replay are kept.
  // shortcut: a count cap, not a byte budget; CAN-7633 adds one for all writes.
  const detectedScans = new KeyedOutcomes<{
    detected: DetectedPlan[];
    newlyDetected: DetectedPlan[];
  }>({ reusedError: keyReused, forget, max: 16 });
  const detectedUpdates = new KeyedOutcomes<{ detected: DetectedPlan[] }>({
    reusedError: keyReused,
    forget,
    max: 16,
  });
  const diagramRequests = new KeyedOutcomes<{
    status: 'started' | 'queued' | 'missing';
    revision?: number;
  }>({ reusedError: keyReused, forget });
  return {
    queries: {
      'core.plan.list': async ({ scope }) => {
        const listed = await operations.list(scope);
        const plans: PlanRecord[] = [];
        for (const plan of listed.plans) {
          const record = toPlanRecord(plan);
          if (record) plans.push(record);
        }
        const unportable = listed.plans.length - plans.length;
        if (unportable > 0) unreadablePlan(scope);
        const skipped = (listed.skipped ?? 0) + unportable;
        return skipped > 0 ? { plans, skipped } : { plans };
      },
      'core.plan.get': async ({ scope, planId }) => {
        const plan = await operations.get({ ...scope, planId });
        if (!plan) return { plan: null };
        const record = toPlanRecord(plan);
        if (!record) unreadablePlan(scope);
        return { plan: record };
      },
      'core.plan.detected.list': async ({ scope }) => ({
        detected: portableDetected(scope, await operations.detectedList(scope)),
      }),
    },
    instructions: {
      'core.plan.create': (params, context) =>
        creates.run(context, params, async () => {
          const stored = await operations.create({
            projectId: params.scope.projectId,
            worktreeId: params.scope.worktreeId,
            source: params.source,
            content: params.content,
            title: params.title,
            id: params.planId,
            proposalRequestId: params.proposalRequestId,
            reviewStatus: params.reviewStatus,
            linkedExecutionId: params.linkedExecutionId,
            chatId: params.chatId,
            sourceFilePath: params.sourceFilePath,
            sourceRepoId: params.sourceRepoId,
            initiationSource: params.initiationSource,
          });
          const plan = writtenRecord(stored);
          publish({ kind: 'upserted', scope: params.scope, plan: stored });
          return { plan };
        }),
      'core.plan.update': (params, context) =>
        updates.run(context, params, async () => {
          const stored = await operations.update({
            projectId: params.scope.projectId,
            worktreeId: params.scope.worktreeId,
            planId: params.planId,
            expectedRevision: params.expectedRevision,
            expectedSource: params.expectedSource,
            proposalRequestId: params.proposalRequestId,
            content: params.content,
            title: params.title,
            source: params.source,
            reviewStatus: params.reviewStatus,
            linkedExecutionId: params.linkedExecutionId,
            approvedAt: params.approvedAt,
            dismissedAt: params.dismissedAt,
            hidden: params.hidden,
            chatId: params.chatId,
            lastEditSource: params.lastEditSource,
            initiationSource: params.initiationSource,
          });
          if (!stored) return { plan: null };
          const plan = writtenRecord(stored);
          publish({ kind: 'upserted', scope: params.scope, plan: stored });
          return { plan };
        }),
      'core.plan.delete': (params, context) =>
        deletes.run(context, params, async () => {
          const deleted = await operations.delete({
            ...params.scope,
            planId: params.planId,
          });
          if (deleted)
            publish({
              kind: 'removed',
              scope: params.scope,
              planId: params.planId,
            });
          return { deleted };
        }),
      'core.plan.import': (params, context) =>
        imports.run(context, params, async () => {
          const stored = await operations.import({
            projectId: params.scope.projectId,
            worktreeId: params.scope.worktreeId,
            repoId: params.repoId,
            filePath: params.path,
            initiationSource: params.initiationSource,
          });
          const plan = writtenRecord(stored);
          publish({ kind: 'upserted', scope: params.scope, plan: stored });
          return { plan };
        }),
      'core.plan.detected.scan': (params, context) =>
        detectedScans.run(context, params, async () => {
          const { entries, newlyDetected } = await operations.detectedScan({
            ...params.scope,
            chatId: params.chatId,
            candidatePaths: params.candidatePaths,
          });
          const detected = portableDetected(params.scope, entries);
          if (newlyDetected.length > 0)
            publish({
              kind: 'detected',
              scope: params.scope,
              entries: detected,
            });
          return {
            detected,
            newlyDetected: portableDetected(params.scope, newlyDetected),
          };
        }),
      'core.plan.detected.update': (params, context) =>
        detectedUpdates.run(context, params, async () => {
          const detected = portableDetected(
            params.scope,
            await operations.detectedUpdate({
              ...params.scope,
              entryId: params.entryId,
              status: params.status,
              bannerSeen: params.bannerSeen,
              importedPlanId: params.importedPlanId,
            }),
          );
          publish({ kind: 'detected', scope: params.scope, entries: detected });
          return { detected };
        }),
      'core.plan.diagram.generate': (params, context) =>
        diagramRequests.run(context, params, async () => {
          if (params.kinds !== undefined && !namesEveryKind(params.kinds))
            throw new CanopyOperationError({
              kind: 'invalid_argument',
              message:
                'Diagrams are generated for every kind a plan qualifies for; a subset of kinds is not served yet.',
              retry: { kind: 'never' },
            });
          const plan = await operations.diagramPlan({
            ...params.scope,
            planId: params.planId,
          });
          if (!plan) return { status: 'missing' };
          if (
            params.expectedRevision !== undefined &&
            params.expectedRevision !== plan.latestRevisionNumber
          )
            throw new CanopyOperationError({
              kind: 'conflict',
              code: PLAN_ERROR_CODES.REVISION_CONFLICT,
              message: 'The plan changed since it was read.',
              details: {
                reason: 'REVISION_CONFLICT',
                currentRevision: plan.latestRevisionNumber,
              },
              retry: { kind: 'after_refresh', resource: PLAN_RESOURCE },
            });
          const unavailable = await diagrams.modelUnavailable();
          if (unavailable !== null)
            throw new CanopyOperationError({
              kind: 'failed_precondition',
              code: PLAN_DIAGRAM_ERROR_CODES.DIAGRAM_MODEL_UNAVAILABLE,
              message: unavailable,
              details: { reason: 'DIAGRAM_MODEL_UNAVAILABLE' },
              retry: { kind: 'never' },
            });
          // The dispatcher has already answered an aborted or late caller;
          // its request must not still schedule a generation. Only the loaded
          // host's settled promise runs between this check and the schedule.
          if (context.signal.aborted) throw canopyCancelledError();
          const status = await diagrams.request(
            plan,
            isPersonCaller(context.caller),
          );
          return { status, revision: plan.latestRevisionNumber };
        }),
    },
  };
}

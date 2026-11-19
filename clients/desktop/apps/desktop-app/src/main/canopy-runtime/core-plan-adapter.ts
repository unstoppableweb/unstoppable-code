import {
  CanopyOperationError,
  canopyInternalError,
  type CanopyDispatcherHandlerMap,
  type CanopyDispatcherInstructionHandlerMap,
} from '@canopy/core-runtime';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import {
  PlanRecordSchema,
  type PlanRecord,
} from '@canopy/protocol/canopy-core';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type { DesktopInstructionDefinitions } from './desktop-instruction-definitions';
import type { DesktopQueryDefinitions } from './desktop-query-definitions';
import {
  desktopPlanOperations,
  type DesktopPlanOperations,
} from './plan-operations';
import {
  publishDispatchedPlanChange,
  type DispatchedPlanChange,
} from './plan-update-publisher';

/*
 * Registers the tracked-plan lifecycle of `core.plan.*` on the desktop
 * dispatcher (CAN-4165 PR 3b-2): list, get, create, update and delete over
 * the plan engine behind plan-persistence. The `tracked-plans:*` IPC
 * handlers, and Remote Control through them, reach plans only through these
 * operations. Import and detected plans join in PR 5; the event stream has
 * no binding yet.
 */

type PlanQueryName = 'core.plan.list' | 'core.plan.get';
type PlanInstructionName =
  | 'core.plan.create'
  | 'core.plan.update'
  | 'core.plan.delete';

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

export interface CorePlanAdapterOptions {
  operations?: DesktopPlanOperations;
  publish?: (change: DispatchedPlanChange) => void;
}

export function createCorePlanAdapter({
  operations = desktopPlanOperations,
  publish = publishDispatchedPlanChange,
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
    },
  };
}

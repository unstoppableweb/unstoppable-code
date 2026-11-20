import { randomUUID } from 'node:crypto';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  PLAN_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  CreateTrackedPlanRequest,
  TrackedPlanData,
  UpdateTrackedPlanRequest,
} from '@canopy/desktop-shared/types';
import type { ExecutionPlanPersistenceHooks } from '@canopy/execution-engine/node/pipelines/executor/types';
import { agentCoreInstructions } from '../canopy-tools/agent-core-operations';
import { getDesktopCanopyRuntime } from './desktop-runtime-access';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import {
  legacyError,
  planCreateParams,
  planUpdateParams,
  writtenTrackedPlan,
} from './tracked-plan-projection';

const HOST_WRITER_PRINCIPALS = {
  planMode: 'desktop-agent-plan-mode',
  pipelinePlans: 'desktop-pipeline-plans',
} as const;

type HostWriter = keyof typeof HOST_WRITER_PRINCIPALS;

interface TrackedPlanHostWriter {
  createTrackedPlan(
    request: CreateTrackedPlanRequest,
  ): Promise<TrackedPlanData>;
  updateTrackedPlan(
    request: UpdateTrackedPlanRequest,
  ): Promise<TrackedPlanData | null>;
}

function hostPlanWriter(
  writer: HostWriter,
  clientInstanceId: string,
): TrackedPlanHostWriter {
  const caller: CanopyCallerDescriptor = {
    principalId: HOST_WRITER_PRINCIPALS[writer],
    clientInstanceId,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: [PLAN_GRANTS.write],
  };
  const operations = (): ReturnType<typeof agentCoreInstructions> =>
    agentCoreInstructions(writer, getDesktopCanopyRuntime());
  return {
    async createTrackedPlan(request) {
      const scope = {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
      };
      try {
        const { plan } = await operations().instruction(
          'core.plan.create',
          planCreateParams(scope, request),
          { caller, metadata: { idempotencyKey: randomUUID() } },
        );
        return writtenTrackedPlan(plan);
      } catch (error) {
        throw legacyError(error);
      }
    },
    async updateTrackedPlan(request) {
      const scope = {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
      };
      try {
        const { plan } = await operations().instruction(
          'core.plan.update',
          planUpdateParams(scope, request),
          { caller, metadata: { idempotencyKey: randomUUID() } },
        );
        return plan ? writtenTrackedPlan(plan) : null;
      } catch (error) {
        throw legacyError(error);
      }
    },
  };
}

export const planModeTrackedPlans = hostPlanWriter(
  'planMode',
  'electron-main-plan-mode',
);

export const pipelineRuntimePlanPersistence = hostPlanWriter(
  'pipelinePlans',
  'electron-main-pipeline-runtime',
);

export function pipelineOwnerPlanWriter(
  executionId: string,
): ExecutionPlanPersistenceHooks {
  return hostPlanWriter('pipelinePlans', `pipeline-owner:${executionId}`);
}

export function approvePlanForPipelineRun(request: {
  projectId: string;
  worktreeId: string;
  planId: string;
  executionId: string;
  approvedAt: string;
  chatId?: string;
  initiationSource?: UpdateTrackedPlanRequest['initiationSource'];
}): Promise<TrackedPlanData | null> {
  return pipelineRuntimePlanPersistence.updateTrackedPlan({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    planId: request.planId,
    reviewStatus: 'approved',
    approvedAt: request.approvedAt,
    linkedExecutionId: request.executionId,
    ...(request.chatId !== undefined ? { chatId: request.chatId } : {}),
    ...(request.initiationSource !== undefined
      ? { initiationSource: request.initiationSource }
      : {}),
  });
}

const planReviewCaller: CanopyCallerDescriptor = {
  principalId: HOST_WRITER_PRINCIPALS.planMode,
  clientInstanceId: 'electron-main-plan-review',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [PLAN_GRANTS.write],
};

export async function approveProposalPlanReview(request: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  planId: string;
  revisionNumber: number;
  approvedAt: string;
}): Promise<boolean> {
  const scope = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
  };
  try {
    const { plan } = await agentCoreInstructions(
      'planMode',
      getDesktopCanopyRuntime(),
    ).instruction(
      'core.plan.update',
      {
        ...planUpdateParams(scope, {
          ...scope,
          planId: request.planId,
          chatId: request.chatId,
          reviewStatus: 'approved',
          approvedAt: request.approvedAt,
          dismissedAt: null,
          initiationSource: 'user',
        }),
        expectedRevision: request.revisionNumber,
        expectedSource: 'opencode',
      },
      {
        caller: planReviewCaller,
        metadata: { idempotencyKey: randomUUID() },
      },
    );
    return plan !== null;
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.payload.kind === 'conflict'
    )
      return false;
    throw legacyError(error);
  }
}

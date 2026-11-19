import { randomUUID } from 'node:crypto';
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

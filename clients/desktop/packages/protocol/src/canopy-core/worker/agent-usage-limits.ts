import { z } from 'zod';
import { UsageLimitsSnapshotSchema } from '../../provider-usage/usage-limits';
import { defineCanopyQuery, defineCanopyQueryRegistry } from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';
import { WORKER_AGENT_GRANTS } from './agent-helpers';

const id = z.string().min(1).max(512);
export const WorkerAgentUsageLimitsGetParamsSchema = z.strictObject({
  scope: z.strictObject({
    authorityId: id.optional(),
    targetId: id.optional(),
  }),
});
export type WorkerAgentUsageLimitsGetParams = z.output<
  typeof WorkerAgentUsageLimitsGetParamsSchema
>;
export const WorkerAgentUsageLimitsGetResultSchema = UsageLimitsSnapshotSchema;
export type WorkerAgentUsageLimitsGetResult = z.output<
  typeof WorkerAgentUsageLimitsGetResultSchema
>;
export const WorkerAgentUsageLimitsGetErrorSchema =
  CanopyErrorPayloadSchema.extend({
    // This query has no operation-specific error codes; callers branch on kind.
    code: z.never().optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WORKER_AGENT_USAGE_LIMITS_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('worker', {
    'worker.agent.usageLimits.get': defineCanopyQuery({
      plane: 'worker',
      domain: 'agent',
      version: 1,
      placement: 'target-selectable',
      params: WorkerAgentUsageLimitsGetParamsSchema,
      result: WorkerAgentUsageLimitsGetResultSchema,
      error: WorkerAgentUsageLimitsGetErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_AGENT_GRANTS.usageRead],
    }),
  });

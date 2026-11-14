import { z } from 'zod';

import { THINKING_LEVELS } from '../../thinking';
import { CanopyWorkspaceScopeSchema } from '../common';
import { defineCanopyQuery, defineCanopyQueryRegistry } from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';
import { WORKER_AGENT_GRANTS } from './agent-helpers';

/*
 * `worker.agent.provider.list` (CAN-4121): the selected worker's providers,
 * their models, sign-in readiness, plan usage limits and billing sources.
 * Codes and facts only: credentials, account identity, gateway URLs, paths
 * and raw provider text stay on the host.
 */
export const WORKER_AGENT_PROVIDER_IDS = [
  'claude',
  'codex',
  'ollama',
  'cursor',
  'copilot',
  'antigravity',
  'opencode',
] as const;
export type WorkerAgentProviderId = (typeof WORKER_AGENT_PROVIDER_IDS)[number];
export const WORKER_AGENT_PROVIDER_NAMES: Readonly<
  Record<WorkerAgentProviderId, string>
> = {
  claude: 'Claude',
  codex: 'Codex',
  ollama: 'Ollama',
  cursor: 'Cursor',
  copilot: 'Copilot',
  antigravity: 'Google',
  opencode: 'OpenCode',
};
/** `expired` is part of the catalog contract; the desktop host never reports it. `error` means not determined. */
export const WORKER_AGENT_PROVIDER_AUTH_STATES = [
  'ready',
  'missing',
  'expired',
  'error',
] as const;
export type WorkerAgentProviderAuthState =
  (typeof WORKER_AGENT_PROVIDER_AUTH_STATES)[number];
export const WORKER_AGENT_MODEL_BILLING_SOURCES = [
  'provider_account',
  'ai_credits',
  'local',
] as const;
export type WorkerAgentModelBillingSource =
  (typeof WORKER_AGENT_MODEL_BILLING_SOURCES)[number];
export const WORKER_AGENT_MODEL_GATEWAY_ORIGINS = [
  'hosted',
  'org-gateway',
] as const;
export const WORKER_AGENT_USAGE_AUTH_STATES = [
  'authenticated',
  'unauthenticated',
  'unknown',
  'error',
] as const;
export const WORKER_AGENT_USAGE_ERROR_KINDS = [
  'auth',
  'network',
  'service',
  'unsupported',
  'unknown',
] as const;
export const WORKER_AGENT_USAGE_ACCOUNT_STATUSES = [
  'active',
  'cooling',
  'error',
  'disabled',
  'refreshing',
  'pending',
] as const;
export const WORKER_AGENT_USAGE_ACCOUNT_SOURCES = ['live', 'passive'] as const;
/** Kept from the catalog page; the desktop host emits none of them. */
export const WORKER_AGENT_PROVIDER_ERROR_CODES = [
  'worker.agent.provider.invalidState',
  'worker.agent.provider.revisionConflict',
  'worker.agent.provider.notFound',
] as const;
export const WORKER_AGENT_PROVIDER_MAX_MODELS = 500;
export const WORKER_AGENT_PROVIDER_MAX_USAGE_WINDOWS = 20;
export const WORKER_AGENT_PROVIDER_MAX_USAGE_ACCOUNTS = 50;

const id = z.string().min(1).max(512);
const text = z.string().min(1).max(320);
const at = z.iso.datetime({ offset: true });
const amount = z.number();

export const WorkerAgentProviderListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema,
  /** Refresh provider status through the host's cached probes; false reads observations only. */
  probe: z.boolean(),
});
export type WorkerAgentProviderListParams = z.output<
  typeof WorkerAgentProviderListParamsSchema
>;

export const WorkerAgentModelSchema = z.strictObject({
  modelId: id,
  name: z.string().min(1).max(256),
  contextWindow: z.number().int().min(1).nullable(),
  /** The registry reports no output limit; always null on the desktop host. */
  outputLimit: z.number().int().min(1).nullable(),
  billingSources: z.array(z.enum(WORKER_AGENT_MODEL_BILLING_SOURCES)).max(3),
  gatewayOrigin: z.enum(WORKER_AGENT_MODEL_GATEWAY_ORIGINS).nullable(),
  /** Exact supported thinking levels; null when the registry does not say. */
  thinkingLevels: z
    .array(z.enum(THINKING_LEVELS))
    .max(THINKING_LEVELS.length)
    .nullable(),
  /** The organization's model policy blocks this model for the scope's owner. */
  blockedByOrganization: z.boolean(),
});
export type WorkerAgentModel = z.output<typeof WorkerAgentModelSchema>;

export const WorkerAgentUsageErrorSchema = z.strictObject({
  kind: z.enum(WORKER_AGENT_USAGE_ERROR_KINDS),
  message: z.string().min(1).max(1_024),
});
export const WorkerAgentUsageWindowSchema = z.strictObject({
  id: text,
  label: text,
  unlimited: z.boolean().optional(),
  usedPercent: z.number().min(0).optional(),
  resetsAt: at.optional(),
  windowDurationMs: z.number().min(0).optional(),
  credits: z
    .strictObject({
      unit: z.enum(['usd', 'credits']),
      spent: amount.optional(),
      remaining: amount.optional(),
      total: amount.optional(),
    })
    .optional(),
  spend: z
    .strictObject({
      currency: z.string().min(1).max(16).optional(),
      used: amount.optional(),
      /** Absent when no reliable cap is reported; null only for a known uncapped cap. */
      limit: amount.nullable().optional(),
      isEnabled: z.boolean().optional(),
    })
    .optional(),
});
export type WorkerAgentUsageWindow = z.output<
  typeof WorkerAgentUsageWindowSchema
>;
export const WorkerAgentUsageAccountSchema = z.strictObject({
  status: z.enum(WORKER_AGENT_USAGE_ACCOUNT_STATUSES),
  availableAt: at.optional(),
  usageSource: z.enum(WORKER_AGENT_USAGE_ACCOUNT_SOURCES).optional(),
  lastUpdatedAt: at.optional(),
  error: WorkerAgentUsageErrorSchema.optional(),
  retryAt: at.optional(),
  windows: z
    .array(WorkerAgentUsageWindowSchema)
    .max(WORKER_AGENT_PROVIDER_MAX_USAGE_WINDOWS),
});
export const WorkerAgentProviderUsageLimitSchema = z.strictObject({
  authState: z.enum(WORKER_AGENT_USAGE_AUTH_STATES),
  lastUpdatedAt: at.nullable(),
  error: WorkerAgentUsageErrorSchema.nullable(),
  windows: z
    .array(WorkerAgentUsageWindowSchema)
    .max(WORKER_AGENT_PROVIDER_MAX_USAGE_WINDOWS),
  /** Present while the multi-account proxy serves the provider; its accounts without identity. */
  accountProxy: z
    .strictObject({
      accounts: z
        .array(WorkerAgentUsageAccountSchema)
        .max(WORKER_AGENT_PROVIDER_MAX_USAGE_ACCOUNTS),
    })
    .nullable(),
});
export type WorkerAgentProviderUsageLimit = z.output<
  typeof WorkerAgentProviderUsageLimitSchema
>;

export const WorkerAgentProviderSchema = z.strictObject({
  providerId: z.enum(WORKER_AGENT_PROVIDER_IDS),
  name: z.string().min(1).max(64),
  authState: z.enum(WORKER_AGENT_PROVIDER_AUTH_STATES),
  /** When this call read the provider's status. */
  checkedAt: at,
  models: z.array(WorkerAgentModelSchema).max(WORKER_AGENT_PROVIDER_MAX_MODELS),
  usageLimit: WorkerAgentProviderUsageLimitSchema.nullable(),
});
export type WorkerAgentProvider = z.output<typeof WorkerAgentProviderSchema>;

export const WorkerAgentProviderListResultSchema = z.strictObject({
  authorityId: id,
  targetId: id,
  /** Echoes params.probe. */
  probed: z.boolean(),
  providers: z
    .array(WorkerAgentProviderSchema)
    .max(WORKER_AGENT_PROVIDER_IDS.length),
});
export type WorkerAgentProviderListResult = z.output<
  typeof WorkerAgentProviderListResultSchema
>;

export const WorkerAgentProviderListErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(WORKER_AGENT_PROVIDER_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WORKER_AGENT_PROVIDER_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('worker', {
    'worker.agent.provider.list': defineCanopyQuery({
      plane: 'worker',
      domain: 'agent',
      version: 1,
      placement: 'target-selectable',
      params: WorkerAgentProviderListParamsSchema,
      result: WorkerAgentProviderListResultSchema,
      error: WorkerAgentProviderListErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_AGENT_GRANTS.read],
    }),
  });
export type WorkerAgentProviderQueryDefinitions =
  typeof WORKER_AGENT_PROVIDER_QUERY_DEFINITIONS;

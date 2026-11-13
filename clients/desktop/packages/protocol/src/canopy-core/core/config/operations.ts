import { z } from 'zod';

import {
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../../common';
import { CanopyJsonValueSchema } from '../../errors';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { PROFILE_ROLES } from '../../../plugin-catalog';
import { THINKING_LEVELS } from '../../../thinking';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';

export const CONFIG_GRANTS = {
  read: 'core.config.read',
  write: 'core.config.write',
} as const;

export const ConfigGetParamsSchema = z.strictObject({
  namespace: z.string().regex(/^[a-z][a-zA-Z0-9.-]{0,127}$/),
  scope: CanopyWorkspaceScopeSchema.optional(),
});

export const ConfigGetResultSchema = z
  .object({
    namespace: z.string(),
    scope: CanopyWorkspaceScopeSchema,
    /**
     * An opaque tag: an equal revision means the same document. Compare it
     * for equality only, never order by it.
     */
    revision: z.number().int().min(0),
    value: z.object({}).catchall(CanopyJsonValueSchema),
    enforcedPaths: z.array(z.string()),
  })
  .catchall(CanopyJsonValueSchema);

export type ConfigGetResult = z.output<typeof ConfigGetResultSchema>;

export const ConfigGetErrorSchema = inherentOperationErrorSchema([
  'core.config.invalidState',
  'core.config.revisionConflict',
  'core.config.notFound',
]);

/** The read-only Git preferences namespace a desktop core serves (CAN-5992). */
export const CONFIG_GIT_NAMESPACE = 'git';

/** `value` of the `git` namespace: the effective branch, PR and commit settings. */
export const ConfigGitValueSchema = z.strictObject({
  branchName: z.strictObject({
    instructions: z.string(),
    prefixMode: z.enum(['none', 'github', 'custom']),
    /** The resolved prefix with its trailing slash, or null when none applies. */
    prefix: z.string().nullable(),
  }),
  pullRequest: z.strictObject({ instructions: z.string() }),
  commitMessage: z.strictObject({ instructions: z.string() }),
});
export type ConfigGitValue = z.output<typeof ConfigGitValueSchema>;

/** Config reads; outside `CORE_QUERY_DEFINITIONS` for the same reason as the catalog's. */
export const CORE_CONFIG_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.config.get': defineCanopyQuery({
    plane: 'core',
    domain: 'config',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [CONFIG_GRANTS.read],
    params: ConfigGetParamsSchema,
    result: ConfigGetResultSchema,
    error: ConfigGetErrorSchema,
  }),
});

/*
 * The writable namespaces a desktop core serves (CAN-6004). Each is a fixed
 * set of settings with a strict schema; nothing outside them can be written.
 * Values a host bounds further (a model it offers, a maximum it allows) are
 * checked by the host.
 */

const MODEL = z.string().min(1).max(256);
const THINKING = z.enum(THINKING_LEVELS);
const DAYS = z.number().int().min(0);

/** Claude turns, the handoff summary model and managed delegation. */
export const ConfigAgentValueSchema = z.strictObject({
  /** null: no cap. */
  claudeMaxTurns: z.number().int().min(1).nullable(),
  handoffSummaryModel: MODEL,
  handoffSummaryThinkingLevel: THINKING,
  managedDelegationMode: z.enum(['off', 'explicit-only', 'proactive']),
  managedDelegationMaxDepth: z.number().int().min(1),
});
export type ConfigAgentValue = z.output<typeof ConfigAgentValueSchema>;

/** Local memory: whether it records, and the model that maintains it. */
export const ConfigMemoryValueSchema = z.strictObject({
  enabled: z.boolean(),
  model: MODEL,
  thinkingLevel: THINKING,
  /** Whether a person chose the model rather than the default. */
  modelSetByUser: z.boolean(),
});
export type ConfigMemoryValue = z.output<typeof ConfigMemoryValueSchema>;

/** The Feed: whether agents' work is recorded. */
export const ConfigLedgerValueSchema = z.strictObject({
  agentRecordingEnabled: z.boolean(),
});
export type ConfigLedgerValue = z.output<typeof ConfigLedgerValueSchema>;

/** The person's role and the skill suggestions it drives. */
export const ConfigProfileValueSchema = z.strictObject({
  role: z.enum(PROFILE_ROLES).nullable(),
  /** Only for the role `other`. */
  roleDetail: z.string().nullable(),
  skillSuggestionsEnabled: z.boolean(),
});
export type ConfigProfileValue = z.output<typeof ConfigProfileValueSchema>;

export const ConfigNavigationValueSchema = z.strictObject({
  mode: z.enum(['code', 'work']),
});
export type ConfigNavigationValue = z.output<
  typeof ConfigNavigationValueSchema
>;

/** How long archived App Advisor chats are kept, and when chats archive. */
export const ConfigAppAdvisorValueSchema = z.strictObject({
  /** null: the default. */
  archiveRetentionDays: DAYS.nullable(),
  /** null: never. */
  autoArchiveDays: DAYS.min(1).nullable(),
});
export type ConfigAppAdvisorValue = z.output<
  typeof ConfigAppAdvisorValueSchema
>;

/** Which providers' traffic the account proxy routes. */
export const ConfigAccountProxyValueSchema = z.strictObject({
  routeClaude: z.boolean(),
  routeCodex: z.boolean(),
  keepChatOnOneAccount: z.boolean(),
});
export type ConfigAccountProxyValue = z.output<
  typeof ConfigAccountProxyValueSchema
>;

export const CONFIG_WRITABLE_NAMESPACES = [
  'agent',
  'memory',
  'ledger',
  'profile',
  'navigation',
  'appAdvisor',
  'accountProxy',
] as const;
export type ConfigWritableNamespace =
  (typeof CONFIG_WRITABLE_NAMESPACES)[number];

const nonEmpty = <T extends object>(patch: T): boolean =>
  Object.keys(patch).length > 0;
const PATCH_MESSAGE = 'A patch changes at least one setting.';

const UPDATE_FIELDS = {
  /** The revision `core.config.get` returned for this namespace. */
  expectedRevision: z.number().int().min(0),
  _meta: CanopyRequestMetadataSchema.extend({
    idempotencyKey: z.string().min(1).max(512),
  }),
};

export const ConfigUpdateParamsSchema = z.discriminatedUnion('namespace', [
  z.strictObject({
    namespace: z.literal('agent'),
    ...UPDATE_FIELDS,
    patch: ConfigAgentValueSchema.partial().refine(nonEmpty, PATCH_MESSAGE),
  }),
  z.strictObject({
    namespace: z.literal('memory'),
    ...UPDATE_FIELDS,
    patch: ConfigMemoryValueSchema.omit({ modelSetByUser: true })
      .partial()
      .refine(nonEmpty, PATCH_MESSAGE),
  }),
  z.strictObject({
    namespace: z.literal('ledger'),
    ...UPDATE_FIELDS,
    patch: ConfigLedgerValueSchema.partial().refine(nonEmpty, PATCH_MESSAGE),
  }),
  z.strictObject({
    namespace: z.literal('profile'),
    ...UPDATE_FIELDS,
    patch: z
      .strictObject({
        role: z.enum(PROFILE_ROLES),
        /** For `other` only; omitted keeps the stored text, '' clears it. */
        roleDetail: z.string(),
        skillSuggestionsEnabled: z.boolean(),
      })
      .partial()
      .refine(nonEmpty, PATCH_MESSAGE),
  }),
  z.strictObject({
    namespace: z.literal('navigation'),
    ...UPDATE_FIELDS,
    patch: ConfigNavigationValueSchema.partial().refine(
      nonEmpty,
      PATCH_MESSAGE,
    ),
  }),
  z.strictObject({
    namespace: z.literal('appAdvisor'),
    ...UPDATE_FIELDS,
    patch: ConfigAppAdvisorValueSchema.partial().refine(
      nonEmpty,
      PATCH_MESSAGE,
    ),
  }),
  z.strictObject({
    namespace: z.literal('accountProxy'),
    ...UPDATE_FIELDS,
    patch: ConfigAccountProxyValueSchema.partial().refine(
      nonEmpty,
      PATCH_MESSAGE,
    ),
  }),
]);
export type ConfigUpdateParams = z.output<typeof ConfigUpdateParamsSchema>;

export const ConfigUpdateResultSchema = ConfigGetResultSchema;

/** Config writes; desktop-only, like the reads. */
export const CORE_CONFIG_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.config.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'config',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CONFIG_GRANTS.write],
      params: ConfigUpdateParamsSchema,
      result: ConfigUpdateResultSchema,
      error: keyedOperationErrorSchema([
        'core.config.invalidState',
        'core.config.revisionConflict',
        'core.config.notFound',
      ]),
    }),
  });

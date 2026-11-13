import { z } from 'zod';

import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
} from '../../common';
import { canopyJsonValueSchemaWithin } from '../../errors';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';

export const CORE_INITIATED_WORK_WATCHER_GRANTS = {
  read: 'core.initiatedWork.read',
  write: 'core.initiatedWork.write',
} as const;

const ID = z.string().min(1).max(512);
/**
 * A watcher tool's input as JSON: at most ten watchers with their labels and
 * follow-up instructions, so far above the 32 KiB error-details bound.
 */
export const WATCHER_REQUEST_JSON_MAX_BYTES = 262_144;
const WATCHER_JSON = canopyJsonValueSchemaWithin(
  WATCHER_REQUEST_JSON_MAX_BYTES,
);
export const WatcherJsonObjectSchema = z
  .record(z.string(), WATCHER_JSON)
  .refine(
    (value) =>
      JSON.stringify(value).length <= WATCHER_REQUEST_JSON_MAX_BYTES &&
      new TextEncoder().encode(JSON.stringify(value)).length <=
        WATCHER_REQUEST_JSON_MAX_BYTES,
    'A watcher request is too large.',
  );
const JSON_OBJECT = WatcherJsonObjectSchema;
const FOLLOW_UP = z.string().max(8000).optional();

/**
 * The chat a watcher notifies: its project, worktree and chat, and for a
 * managed delegate, the delegation that is its only recipient. The host
 * supplies it from the calling session, never from tool input.
 */
export const WatcherRecipientSchema = z.strictObject({
  workspaceId: ID,
  worktreeId: ID,
  chatId: ID,
  delegation: z
    .strictObject({
      delegationId: ID,
      description: z.string().max(512).optional(),
      depth: z.number().int().min(0).optional(),
    })
    .optional(),
});
export type WatcherRecipient = z.output<typeof WatcherRecipientSchema>;

/** What a watcher request reports back to the agent that made it. */
export const WatcherReportSchema = z.strictObject({
  accepted: z.boolean(),
  /** The agent-facing report: the watcher catalog, setup or delete result. */
  report: z.string().max(1_000_000),
  /** An integration failure the host may surface as a reconnect prompt. */
  failure: z
    .strictObject({ code: z.string().max(256), message: z.string() })
    .optional(),
});
export type WatcherReport = z.output<typeof WatcherReportSchema>;

export const WatcherCreateRequestSchema = z.discriminatedUnion('kind', [
  /** SetupWatchers: catalog watchers (pipeline, hook, chat, automation). */
  z.strictObject({ kind: z.literal('setup'), input: JSON_OBJECT }),
  /** WatchGitHubItems: workflow runs or pull requests. */
  z.strictObject({
    kind: z.literal('github'),
    input: JSON_OBJECT,
    /** The calling session's selected repository, for repository resolution. */
    repoId: ID.optional(),
  }),
  /**
   * WatchCommand: a repeat-safe probe the host runs in the session's
   * directory, which it resolves from the recipient (CAN-6031).
   */
  z.strictObject({
    kind: z.literal('command'),
    command: z.string().min(1).max(16384),
    intervalSeconds: z.number().int().min(5).max(3600),
    maxAttempts: z.number().int().min(1).max(100),
    /** The calling session's selected repository. */
    repoId: ID.optional(),
    followUpInstruction: FOLLOW_UP,
  }),
  /** ScheduleWakeup: one wakeup after a delay. */
  z.strictObject({
    kind: z.literal('wakeup'),
    delaySeconds: z.number().int().min(60).max(3600),
    followUpInstruction: FOLLOW_UP,
  }),
]);
export type WatcherCreateRequest = z.output<typeof WatcherCreateRequestSchema>;

export const WatcherCreateParamsSchema = z.strictObject({
  recipient: WatcherRecipientSchema,
  request: WatcherCreateRequestSchema,
  /** The tool call that asked for the watchers; the service records it as their creator. */
  createdBy: ID.optional(),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
});

export const WatcherListParamsSchema = z.strictObject({
  recipient: WatcherRecipientSchema,
  /** SearchWatchers input: catalog query and active-watcher paging. */
  search: JSON_OBJECT,
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const WatcherDeleteParamsSchema = z.strictObject({
  recipient: WatcherRecipientSchema,
  watcherIds: z.array(z.string().min(1).max(256)).min(1).max(20),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: ID }),
});

const BASE = {
  plane: 'core',
  domain: 'initiatedWork',
  version: 1,
  placement: 'core-only',
} as const;

// Served by the desktop dispatcher over Electron main's watcher service
// (CAN-5994). Not composed into the shared registries: the daemon and the
// web core do not serve them.
export const CORE_INITIATED_WORK_WATCHER_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.initiatedWork.watcher.list': defineCanopyQuery({
      ...BASE,
      idempotency: 'inherent',
      requiredGrants: [CORE_INITIATED_WORK_WATCHER_GRANTS.read],
      params: WatcherListParamsSchema,
      result: WatcherReportSchema,
      error: inherentOperationErrorSchema([
        'core.initiatedWork.watcher.unavailable',
      ]),
    }),
  });

export const CORE_INITIATED_WORK_WATCHER_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.initiatedWork.watcher.create': defineCanopyInstruction({
      ...BASE,
      idempotency: 'keyed',
      requiredGrants: [CORE_INITIATED_WORK_WATCHER_GRANTS.write],
      params: WatcherCreateParamsSchema,
      result: WatcherReportSchema,
      error: keyedOperationErrorSchema([
        'core.initiatedWork.watcher.unavailable',
      ]),
    }),
    'core.initiatedWork.watcher.delete': defineCanopyInstruction({
      ...BASE,
      idempotency: 'keyed',
      requiredGrants: [CORE_INITIATED_WORK_WATCHER_GRANTS.write],
      params: WatcherDeleteParamsSchema,
      result: WatcherReportSchema,
      error: keyedOperationErrorSchema([
        'core.initiatedWork.watcher.unavailable',
      ]),
    }),
  });

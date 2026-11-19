import { z } from 'zod';
import { CODEX_SPEEDS } from '../../automations';
import { THINKING_LEVELS } from '../../thinking';
import { CanopyQueryRequestMetadataSchema } from '../common';
import {
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';
import { WORKER_AGENT_GRANTS } from './agent-helpers';
import { WorkerCodeGraphJsonValueSchema } from './code-graph-reads';

/*
 * `worker.agent.turn.run` and `worker.agent.subagent.run` (CAN-4115): one chat
 * turn, or one managed subagent run generation, executed on a worker as the
 * child dispatch of a `core.chat.turn.run` or `core.agent.subagent.run`
 * operation. Params carry ids, and optionally the portable `launch`
 * (CAN-6995): without it the owning core's host stages the request in its own
 * process, so only an in-process worker can serve the run.
 */
export const WORKER_AGENT_RUN_ERROR_CODES = [
  'worker.agent.runLaunchUnavailable',
  'worker.agent.idempotencyKeyReused',
] as const;
export const WORKER_AGENT_TURN_FAILED_CODE = 'worker.agent.turnFailed';
export const WORKER_AGENT_TURN_FAILED_MESSAGE =
  'The chat turn ended with an error.';
export const WORKER_AGENT_SUBAGENT_FAILED_CODE = 'worker.agent.subagentFailed';
export const WORKER_AGENT_SUBAGENT_FAILED_MESSAGE =
  'The subagent run ended with an error.';
export const WORKER_AGENT_TURN_PAYLOAD_FORMAT = 'canopy.chat-event.v1';
export const WORKER_AGENT_TURN_PAYLOAD_MAX_BYTES = 1_048_576;
export const WORKER_AGENT_TURN_OUTCOMES = [
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkerAgentTurnOutcome =
  (typeof WORKER_AGENT_TURN_OUTCOMES)[number];
export const WORKER_AGENT_TURN_WAIT_KINDS = [
  'approval',
  'question',
  'deferred_tools',
  'plan_review',
] as const;
export type WorkerAgentTurnWaitKind =
  (typeof WORKER_AGENT_TURN_WAIT_KINDS)[number];
export const WORKER_AGENT_TURN_WAIT_RESOLUTIONS = [
  'answered',
  'cancelled',
  'expired',
] as const;
export type WorkerAgentTurnWaitResolution =
  (typeof WORKER_AGENT_TURN_WAIT_RESOLUTIONS)[number];

const id = z.string().min(1).max(512);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const utf8 = new TextEncoder();

export const WorkerAgentTurnScopeSchema = z.strictObject({
  workspaceId: id,
  worktreeId: id,
  chatId: id,
});
export type WorkerAgentTurnScope = z.output<typeof WorkerAgentTurnScopeSchema>;

/*
 * The portable turn launch (CAN-6995 S1a): what a worker needs to start one
 * chat turn without anything the owning core staged in its own process. It
 * carries no host paths, closures, credentials or keys. The working directory
 * crosses as a worker root id, attachments as canonical chat attachment ids,
 * billing routes as references the owner resolves through owner requests (the
 * CAN-5095 rule), and approval as the core's admitted decision for this send,
 * since the core evaluates approval policy (ADR 22a rule 1). Capability
 * overlays cross as `materializationId` (CAN-4123). Field names follow the
 * proposed `worker.agent.session.*` family so the two converge. A null member
 * the session reads as optional is unset, so the session's own default applies:
 * several defaults are on, so unset is not false.
 */
export const WORKER_AGENT_TURN_LAUNCH_FORMAT = 'canopy.agent-turn-launch.v1';
export const WORKER_AGENT_HARNESSES = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
  'antigravity',
] as const;
export type WorkerAgentHarness = (typeof WORKER_AGENT_HARNESSES)[number];
/** The chat surface the turn belongs to; it selects the session's tool families. */
export const WORKER_AGENT_TURN_SURFACES = [
  'worktree',
  'cowork',
  'standalone',
  'app_advisor',
  'pipeline_editor',
  'hook',
] as const;
export const WORKER_AGENT_APPROVAL_MODES = [
  'ask',
  'auto',
  'full-access',
] as const;
export const WORKER_AGENT_ROUTE_KINDS = [
  'ai_credits',
  'account_proxy',
  'organization_gateway',
] as const;
export const WORKER_AGENT_DELEGATION_SURFACES = [
  'worktree-chat',
  'cowork-chat',
  'app-advisor-chat',
] as const;
export const WORKER_AGENT_DELEGATION_MODES = [
  'off',
  'explicit-only',
  'proactive',
] as const;
export const WORKER_AGENT_CONTEXT_WINDOW_PRESETS = [
  'model-default',
  'standard-pricing',
  'maximum',
] as const;
export const WORKER_AGENT_TURN_LAUNCH_LIMITS = Object.freeze({
  promptBlocks: 64,
  promptTextChars: 1_000_000,
  instructionChars: 1_000_000,
  forkToolResults: 256,
  forkToolResultChars: 1_000_000,
  routes: 4,
});

const executionContext = z
  .string()
  .regex(
    /^(personal|org:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  );
const instruction = z
  .string()
  .max(WORKER_AGENT_TURN_LAUNCH_LIMITS.instructionChars)
  .nullable();
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const WorkerAgentTurnPromptBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('text'),
    text: z.string().max(WORKER_AGENT_TURN_LAUNCH_LIMITS.promptTextChars),
  }),
  z.strictObject({
    type: z.literal('attachment'),
    /** A canonical chat attachment id; the worker reads it from its own store. */
    attachmentId: id,
    name: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(128),
  }),
]);

export const WorkerAgentTurnLaunchSchema = z.strictObject({
  format: z.literal(WORKER_AGENT_TURN_LAUNCH_FORMAT),
  /** The worker root of the session's working directory, never a path. */
  cwdRootId: id,
  repoId: id.nullable(),
  surface: z.enum(WORKER_AGENT_TURN_SURFACES),
  executionHarness: z.enum(WORKER_AGENT_HARNESSES).nullable(),
  model: z.strictObject({
    /** The model the person chose; params' `model` is the one the turn runs. */
    selectedModelId: z.string().min(1).max(256).nullable(),
    thinkingLevel: z.enum(THINKING_LEVELS).nullable(),
    speed: z.enum(CODEX_SPEEDS).nullable(),
    contextWindow: z
      .union([z.enum(WORKER_AGENT_CONTEXT_WINDOW_PRESETS), positive])
      .nullable(),
  }),
  mode: z.strictObject({
    planMode: z.boolean().nullable(),
    /** Codex plan proposals: optional or required; null for other harnesses. */
    codexProposalMode: z.enum(['optional', 'required']).nullable(),
  }),
  approval: z.strictObject({
    mode: z.enum(WORKER_AGENT_APPROVAL_MODES),
    /** The approval authority revision the core evaluated against (ADR 22a rule 2). */
    policyRevision: count,
    /**
     * The core's admitted approval decision for this send; the worker reads
     * its session rules through the core, never from the launch.
     */
    admissionId: id,
  }),
  session: z.strictObject({
    /** The provider conversation to resume: a session id or Codex thread id. */
    providerSessionId: z.string().min(1).max(512).nullable(),
    reconstructionSeedId: id.nullable(),
    /**
     * A fork of the resumed provider session: whether to fork, its resume
     * point, and the answers for tool calls left open there. Null when the
     * session sets none of them.
     */
    fork: z
      .strictObject({
        forkSession: z.boolean().nullable(),
        resumeAt: z.string().min(1).max(512).nullable(),
        startsFresh: z.boolean().nullable(),
        toolResults: z
          .array(
            z.strictObject({
              toolUseId: id,
              content: z
                .string()
                .max(WORKER_AGENT_TURN_LAUNCH_LIMITS.forkToolResultChars),
            }),
          )
          .max(WORKER_AGENT_TURN_LAUNCH_LIMITS.forkToolResults)
          .nullable(),
      })
      .nullable(),
  }),
  instructions: z.strictObject({
    systemPromptAppend: instruction,
    /** Captured only for a new provider session; excluded from session matching. */
    globalInstructionsBlock: instruction,
    /** Captured at session creation and reused on resume. */
    globalInstructionsSnapshot: instruction,
  }),
  capabilities: z.strictObject({
    applyGlobalPluginDefaults: z.boolean().nullable(),
    deferredToolsAllowed: z.boolean().nullable(),
    codeGraphToolsAdvertised: z.boolean().nullable(),
    rtkEnabled: z.boolean().nullable(),
  }),
  /** Managed delegation limits; null when the surface delegates nothing. */
  delegation: z
    .strictObject({
      surface: z.enum(WORKER_AGENT_DELEGATION_SURFACES),
      mode: z.enum(WORKER_AGENT_DELEGATION_MODES).nullable(),
      maxConcurrent: positive.nullable(),
      maxDepth: positive.nullable(),
      lifetimeLimit: positive.nullable(),
    })
    .nullable(),
  /** Codex app-server settings; null when the session sets none. */
  codex: z
    .strictObject({
      appServerIdleTimeoutMinutes: positive.nullable(),
      multiAgentEnabled: z.boolean().nullable(),
      /**
       * Canopy's subagent limit: a count, 'none' to remove any limit Canopy
       * set, or null to leave the provider's own configuration as it is.
       */
      maxConcurrentSubagents: z.union([positive, z.literal('none')]).nullable(),
    })
    .nullable(),
  /** The work owner bound when the turn was admitted; null for the live context. */
  executionContext: executionContext.nullable(),
  billing: z.strictObject({
    /** Billing routes by reference; their URLs and keys stay with the owner. */
    routes: z
      .array(
        z.strictObject({
          kind: z.enum(WORKER_AGENT_ROUTE_KINDS),
          routeId: id,
        }),
      )
      .max(WORKER_AGENT_TURN_LAUNCH_LIMITS.routes),
    /** Force the native subscription over a global AI Credits mode. */
    subscriptionOverride: z.boolean().nullable(),
    /** The account proxy decision; null lets the session decide. */
    accountProxy: z.enum(['proxy', 'off']).nullable(),
    /** A trusted quota continuation refuses any other proxy connection. */
    requiredAccountProxyConnectionId: id.nullable(),
  }),
  prompt: z.strictObject({
    /** The canonical user message the turn answers. */
    messageId: id,
    blocks: z
      .array(WorkerAgentTurnPromptBlockSchema)
      .min(1)
      .max(WORKER_AGENT_TURN_LAUNCH_LIMITS.promptBlocks),
  }),
});
export type WorkerAgentTurnLaunch = z.output<
  typeof WorkerAgentTurnLaunchSchema
>;

export const WorkerAgentTurnRunParamsSchema = z.strictObject({
  turnRunId: id,
  scope: WorkerAgentTurnScopeSchema,
  /** The turn's user message id, the id `core.chat.turn.cancel` takes. */
  turnId: id,
  /** `providerEventSequenceNamespace`, or 'initial'. */
  eventNamespace: z.string().min(1).max(256),
  providerId: z.string().min(1).max(64),
  model: z.string().min(1).max(256).nullable(),
  /** A `worker.catalog.materialize` result (CAN-4123); null until a launch carries one. */
  materializationId: id.nullable(),
  /**
   * The portable launch (CAN-6995). Absent, the worker serves only a run its
   * own process staged, and refuses any other with `worker.agent.runLaunchUnavailable`.
   */
  launch: WorkerAgentTurnLaunchSchema.optional(),
});
export type WorkerAgentTurnRunParams = z.output<
  typeof WorkerAgentTurnRunParamsSchema
>;

const turnBase = { turnRunId: id, eventCount: count };
export const WorkerAgentTurnRunResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...turnBase, status: z.literal('completed') }),
  z.strictObject({
    ...turnBase,
    status: z.literal('failed'),
    error: z.strictObject({
      code: z.literal(WORKER_AGENT_TURN_FAILED_CODE),
      message: z.string().min(1).max(1_024),
    }),
  }),
  z.strictObject({ ...turnBase, status: z.literal('cancelled') }),
]);
export type WorkerAgentTurnRunResult = z.output<
  typeof WorkerAgentTurnRunResultSchema
>;

// Chat-event frames routinely exceed the bounded error-details JSON limit, so
// the payload is JSON of any shape, bounded only by its serialized size.
function fitsTranscriptPayload(value: unknown): boolean {
  try {
    return (
      utf8.encode(JSON.stringify(value) ?? 'null').byteLength <=
      WORKER_AGENT_TURN_PAYLOAD_MAX_BYTES
    );
  } catch {
    return false;
  }
}
const transcriptPayload = WorkerCodeGraphJsonValueSchema.refine(
  fitsTranscriptPayload,
  { message: 'The transcript payload is too large.' },
);

const eventBase = { turnRunId: id, sequence: count };
export const WorkerAgentTurnEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...eventBase, kind: z.literal('accepted') }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('transcript'),
    format: z.literal(WORKER_AGENT_TURN_PAYLOAD_FORMAT),
    /** The worker's root-terminal classification of this frame. */
    terminal: z.boolean(),
    payload: transcriptPayload,
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('wait_opened'),
    waitId: id,
    waitKind: z.enum(WORKER_AGENT_TURN_WAIT_KINDS),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('wait_resolved'),
    waitId: id,
    resolution: z.enum(WORKER_AGENT_TURN_WAIT_RESOLUTIONS),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('terminal'),
    outcome: z.enum(WORKER_AGENT_TURN_OUTCOMES),
  }),
]);
export type WorkerAgentTurnEvent = z.output<typeof WorkerAgentTurnEventSchema>;
export type WorkerAgentTurnEventKind = WorkerAgentTurnEvent['kind'];

export const WorkerAgentSubagentRunParamsSchema = z.strictObject({
  subagentRunId: id,
  delegationId: id,
  runGeneration: count,
  harnessId: z.string().min(1).max(64),
  scope: WorkerAgentTurnScopeSchema,
});
export type WorkerAgentSubagentRunParams = z.output<
  typeof WorkerAgentSubagentRunParamsSchema
>;

export const WorkerAgentSubagentRunResultSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({ subagentRunId: id, status: z.literal('completed') }),
    z.strictObject({
      subagentRunId: id,
      status: z.literal('failed'),
      error: z.strictObject({
        code: z.literal(WORKER_AGENT_SUBAGENT_FAILED_CODE),
        message: z.string().min(1).max(1_024),
      }),
    }),
    z.strictObject({ subagentRunId: id, status: z.literal('cancelled') }),
  ],
);
export type WorkerAgentSubagentRunResult = z.output<
  typeof WorkerAgentSubagentRunResultSchema
>;

export const WorkerAgentRunErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(WORKER_AGENT_RUN_ERROR_CODES).optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

export const WORKER_AGENT_RUN_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.agent.subagent.run': defineCanopyInstruction({
      plane: 'worker',
      domain: 'agent',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'keyed',
      requiredGrants: [WORKER_AGENT_GRANTS.execute],
      params: WorkerAgentSubagentRunParamsSchema,
      result: WorkerAgentSubagentRunResultSchema,
      error: WorkerAgentRunErrorSchema,
    }),
    'worker.agent.turn.run': defineCanopyInstruction({
      plane: 'worker',
      domain: 'agent',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'keyed',
      requiredGrants: [WORKER_AGENT_GRANTS.execute],
      params: WorkerAgentTurnRunParamsSchema,
      result: WorkerAgentTurnRunResultSchema,
      error: WorkerAgentRunErrorSchema,
    }),
  });

/*
 * `worker.agent.turn.events` (CAN-6995 S1a): the turn's envelopes for an
 * owning core in another process. In process, the worker hands each envelope
 * to the core's sink directly; across a binding, the core opens this stream for
 * the run it dispatched and receives the same envelopes, in order.
 */
export const WORKER_AGENT_TURN_EVENTS_ERROR_CODES = [
  'worker.agent.runNotFound',
  'worker.agent.eventsExpired',
] as const;

export const WorkerAgentTurnEventsParamsSchema = z.strictObject({
  turnRunId: id,
  /**
   * The last cursor the core received, to resume after it; without one the
   * stream starts at the run's first envelope. The cursor's sequence is the
   * envelope sequence. The worker keeps a run's envelopes until its terminal
   * envelope is delivered; an older cursor, or one from another worker epoch,
   * answers `worker.agent.eventsExpired`.
   */
  cursor: CanopyStreamCursorSchema.nullable().optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export type WorkerAgentTurnEventsParams = z.output<
  typeof WorkerAgentTurnEventsParamsSchema
>;

export const WorkerAgentTurnEventsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});

export const WorkerAgentTurnEventsErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z.enum(WORKER_AGENT_TURN_EVENTS_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  },
);

export const WorkerAgentTurnEventsEndSchema = CanopyStreamEndSchema.extend({
  error: WorkerAgentTurnEventsErrorSchema.nullable(),
});

/** Exported for explicit composition; no host registers it yet (CAN-6995 S1b, S5). */
export const WORKER_AGENT_RUN_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'worker',
  {
    'worker.agent.turn.events': defineCanopyStream({
      plane: 'worker',
      domain: 'agent',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: [WORKER_AGENT_GRANTS.execute],
      params: WorkerAgentTurnEventsParamsSchema,
      openResult: WorkerAgentTurnEventsOpenResultSchema,
      item: WorkerAgentTurnEventSchema,
      end: WorkerAgentTurnEventsEndSchema,
      error: WorkerAgentTurnEventsErrorSchema,
    }),
  },
);

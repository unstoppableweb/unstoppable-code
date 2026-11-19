import { z } from 'zod';

import type { OperationOriginKind } from '../operation/schemas';

/*
 * Initiated-work runs (CAN-4144). Work a source starts on its own behalf (a
 * hook today; automations and watchers later) is one `core.initiatedWork.run`
 * operation. Its origin names the source and the occurrence that fired it;
 * its owner is the project's saved owner. Every gate the run passed or
 * stopped at is recorded with it, together with the artifacts it produced,
 * so other clients read the same answer through `core.operation.*`.
 */

export const CORE_INITIATED_WORK_RUN_KIND = 'core.initiatedWork.run';

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });

/**
 * The gates a run can stop at, in the order the engine meets them:
 * admission gates before the run is queued, `busyTarget` while it waits for
 * its target, `client` while a run that needs a connected client waits for
 * one (CAN-4145), and `commandGate` while it runs.
 */
export const INITIATED_WORK_GATES = [
  'dedup',
  'pause',
  'splitLock',
  'activePr',
  'deletionFence',
  'owner',
  'executionContext',
  'busyTarget',
  'client',
  'commandGate',
] as const;
export const InitiatedWorkGateSchema = z.enum(INITIATED_WORK_GATES);
export type InitiatedWorkGate = z.output<typeof InitiatedWorkGateSchema>;

/**
 * `passed`: the run went on. `waited`: the run queued behind other work on
 * its target first. `skipped`: the gate stopped the run on purpose, such as
 * a paused hook or a command gate exiting 2. `refused`: the gate did not
 * allow the run. `failed`: the gate itself could not decide. `cancelled`:
 * someone cancelled the run while it stood at this gate.
 */
export const INITIATED_WORK_GATE_DECISIONS = [
  'passed',
  'waited',
  'skipped',
  'refused',
  'failed',
  'cancelled',
] as const;
export const InitiatedWorkGateDecisionSchema = z.enum(
  INITIATED_WORK_GATE_DECISIONS,
);
export type InitiatedWorkGateDecision = z.output<
  typeof InitiatedWorkGateDecisionSchema
>;

export const InitiatedWorkGateOutcomeSchema = z.strictObject({
  gate: InitiatedWorkGateSchema,
  decision: InitiatedWorkGateDecisionSchema,
  decidedAt: timestamp,
  message: z.string().min(1).max(4_096).optional(),
  /** The action a command gate belongs to. */
  actionIndex: z.int().min(0).optional(),
});
export type InitiatedWorkGateOutcome = z.output<
  typeof InitiatedWorkGateOutcomeSchema
>;

export const INITIATED_WORK_ARTIFACT_KINDS = [
  'runLog',
  'chat',
  'pipelineExecution',
] as const;

/** Something a run produced: its own log, or work it handed to a domain. */
export const InitiatedWorkArtifactSchema = z.strictObject({
  kind: z.enum(INITIATED_WORK_ARTIFACT_KINDS),
  id,
  actionIndex: z.int().min(0).optional(),
});
export type InitiatedWorkArtifact = z.output<
  typeof InitiatedWorkArtifactSchema
>;

/**
 * How a run that went on ended: `succeeded`, `failed` (an action failed),
 * `timedOut`, or `stopped` by a command gate.
 */
export const InitiatedWorkRunResultSchema = z.strictObject({
  status: z.enum(['succeeded', 'failed', 'timedOut', 'stopped']),
  exitCode: z.int().nullable(),
  durationMs: z.int().min(0),
});
export type InitiatedWorkRunResult = z.output<
  typeof InitiatedWorkRunResultSchema
>;

/**
 * What a run's operation records: the outcome of a completed run, and the
 * error details of a refused or failed one. `ran`: its work went ahead.
 * `skipped`: a gate stopped it on purpose. `refused`: a gate did not allow
 * it.
 */
export const InitiatedWorkRunRecordSchema = z.strictObject({
  disposition: z.enum(['ran', 'skipped', 'refused']),
  gates: z.array(InitiatedWorkGateOutcomeSchema).max(64),
  artifacts: z.array(InitiatedWorkArtifactSchema).max(256),
  result: InitiatedWorkRunResultSchema.nullable(),
});
export type InitiatedWorkRunRecord = z.output<
  typeof InitiatedWorkRunRecordSchema
>;

/** The hook a `hook` origin names, kept in the origin's context. */
export const InitiatedWorkHookOriginContextSchema = z.strictObject({
  triggerName: z.string().min(1).max(512),
  target: z.enum(['project', 'workspace-root', 'workspace-repo']),
  repoId: id.optional(),
  invocation: z.enum(['automatic', 'manual']),
  /**
   * Whether the worktree's pause applies to the run (CAN-4146). A request
   * bypasses it explicitly; a manual run does. Absent on runs recorded before
   * the flag, where a manual run bypassed it and an automatic one did not.
   */
  pause: z.enum(['enforce', 'bypass']).optional(),
  /** The pull request the run was fired for, when a PR snapshot started it. */
  pullRequest: z
    .strictObject({
      repository: z.string().min(1).max(512),
      number: z.int().min(1),
    })
    .optional(),
  /** The project's saved owner the run was authorized against. */
  projectOwner: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('personal') }),
    z.strictObject({ kind: z.literal('organization'), organizationId: id }),
    z.strictObject({ kind: z.literal('unknown') }),
  ]),
});
export type InitiatedWorkHookOriginContext = z.output<
  typeof InitiatedWorkHookOriginContextSchema
>;

/** The source of the code-graph scheduler's builds (CAN-5617). */
export const INITIATED_WORK_CODE_GRAPH_SCHEDULER_SOURCE =
  'code-graph.scheduler';

/**
 * What a `system` origin from the code-graph scheduler keeps in its context:
 * why it built (a new worktree, or a refresh whose fingerprint changed) and
 * the bounded signal that asked for the refresh.
 */
export const InitiatedWorkCodeGraphBuildOriginContextSchema = z.strictObject({
  trigger: z.enum(['worktree-created', 'refresh']),
  refreshSource: z.string().min(1).max(128),
});
export type InitiatedWorkCodeGraphBuildOriginContext = z.output<
  typeof InitiatedWorkCodeGraphBuildOriginContextSchema
>;

/** The source of the code-graph base manager's maintenance (CAN-5619). */
export const INITIATED_WORK_CODE_GRAPH_BASE_MAINTENANCE_SOURCE =
  'code-graph.base-maintenance';

/**
 * What a `system` origin from base maintenance keeps in its context: how
 * many of the workspace's repositories the cycle maintains.
 */
export const InitiatedWorkCodeGraphBaseMaintenanceOriginContextSchema =
  z.strictObject({
    trigger: z.literal('maintenance'),
    repositoryCount: z.number().int().min(0).max(1_000),
  });
export type InitiatedWorkCodeGraphBaseMaintenanceOriginContext = z.output<
  typeof InitiatedWorkCodeGraphBaseMaintenanceOriginContextSchema
>;

/** The source of a pipeline's automatic transient retries (CAN-4175). */
export const INITIATED_WORK_PIPELINE_TRANSIENT_RETRY_SOURCE =
  'pipeline.transient-retry';

/**
 * What a `system` origin from the transient-retry scheduler keeps in its
 * context: the paused execution and the status reasons the retry resumes,
 * which attempt this is and when it is due, and the attempts each step had
 * used when it was scheduled, with the steps this retry resumes marked, so a
 * restart continues the count. Steps are kept by digest, so the context stays
 * within an origin's size limit however long their IDs are.
 */
export const InitiatedWorkPipelineTransientRetryOriginContextSchema =
  z.strictObject({
    executionId: z.string().min(1).max(256),
    statusReasonIds: z.array(z.uuid()).min(1).max(256),
    attempt: z.number().int().min(1).max(64),
    notBefore: z.iso.datetime({ offset: true }),
    stepAttempts: z
      .array(
        z.strictObject({
          /** The first 16 hex digits of the SHA-256 of `jobId\0stepId`. */
          step: z.string().regex(/^[0-9a-f]{16}$/),
          used: z.number().int().min(0).max(64),
          scheduled: z.boolean(),
        }),
      )
      .max(256),
  });
export type InitiatedWorkPipelineTransientRetryOriginContext = z.output<
  typeof InitiatedWorkPipelineTransientRetryOriginContextSchema
>;

export const CORE_INITIATED_WORK_HOOK_CHAT_KIND = 'core.initiatedWork.hookChat';

export const InitiatedWorkHookChatOutcomeSchema = z.strictObject({
  chatId: id,
  userMessageId: id,
  accepted: z.boolean(),
  reason: z.enum(['returned', 'removed', 'cancelled']).optional(),
});
export type InitiatedWorkHookChatOutcome = z.output<
  typeof InitiatedWorkHookChatOutcomeSchema
>;

/** A receipted hook queue entry whose details are saved beside the ledger. */
export const CORE_INITIATED_WORK_QUEUED_HOOK_CHAT_KIND =
  'core.initiatedWork.queuedHookChat';
export const CORE_INITIATED_WORK_QUEUED_HOOK_PIPELINE_KIND =
  'core.initiatedWork.queuedHookPipeline';

export const InitiatedWorkQueuedHookOutcomeSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('chat'),
      chatId: id,
      result: z.enum(['started', 'already_started', 'removed']),
    }),
    z.strictObject({
      kind: z.literal('pipeline'),
      executionId: id,
      result: z.literal('started'),
    }),
  ],
);
export type InitiatedWorkQueuedHookOutcome = z.output<
  typeof InitiatedWorkQueuedHookOutcomeSchema
>;

export const CORE_INITIATED_WORK_RUN_ERROR_CODES = [
  'core.initiatedWork.gate.dedup',
  'core.initiatedWork.gate.pause',
  'core.initiatedWork.gate.splitLock',
  'core.initiatedWork.gate.activePr',
  'core.initiatedWork.gate.deletionFence',
  'core.initiatedWork.gate.owner',
  'core.initiatedWork.gate.executionContext',
  'core.initiatedWork.gate.busyTarget',
  'core.initiatedWork.gate.client',
  'core.initiatedWork.gate.commandGate',
  'core.initiatedWork.run.failed',
  'core.initiatedWork.run.invalidated',
  'core.initiatedWork.hookChat.failed',
  'core.initiatedWork.hookQueue.invalidated',
  'core.initiatedWork.hookQueue.startFailed',
] as const;
export type CoreInitiatedWorkRunErrorCode =
  (typeof CORE_INITIATED_WORK_RUN_ERROR_CODES)[number];

/**
 * What initiated work does when no client is connected (CAN-4145, ADR 14).
 * `headless`: it runs anyway; nothing it does needs a client. `defer`: it
 * stays queued, recorded at the `client` gate, until a client connects, and
 * any client can cancel it meanwhile. Nothing initiated fails merely because
 * no client is connected.
 *
 * Hooks are the only origin the initiated-work engine runs today. Their
 * commands, pipelines and chats run headless: hook chats start without a client
 * since CAN-4138. Every other origin keeps running its work in core whether or
 * not a client is connected. The `client` gate stays for a policy that defers.
 */
export const INITIATED_WORK_NO_CLIENT_POLICIES = {
  client: { default: 'headless' },
  hook: {
    default: 'headless',
    command: 'headless',
    pipeline: 'headless',
    chat: 'headless',
  },
  automation: { default: 'headless' },
  watcher: { default: 'headless' },
  system: { default: 'headless' },
  delegation: { default: 'headless' },
} as const satisfies Record<
  OperationOriginKind,
  Readonly<Record<string, InitiatedWorkNoClientPolicy>>
>;
export type InitiatedWorkNoClientPolicy = 'headless' | 'defer';

/** The no-client policy for an origin kind and, where it varies, an action kind. */
export function initiatedWorkNoClientPolicy(
  origin: OperationOriginKind,
  actionKind?: string,
): InitiatedWorkNoClientPolicy {
  const policies: Readonly<Record<string, InitiatedWorkNoClientPolicy>> =
    INITIATED_WORK_NO_CLIENT_POLICIES[origin];
  return (
    (actionKind !== undefined ? policies[actionKind] : undefined) ??
    policies.default ??
    'headless'
  );
}

/** The error code a refusal at this gate records. */
export function initiatedWorkGateErrorCode(
  gate: InitiatedWorkGate,
): CoreInitiatedWorkRunErrorCode {
  return `core.initiatedWork.gate.${gate}`;
}

/** Parses an operation's recorded run outcome or error details. */
export function parseInitiatedWorkRunRecord(
  value: unknown,
): InitiatedWorkRunRecord | null {
  const parsed = InitiatedWorkRunRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

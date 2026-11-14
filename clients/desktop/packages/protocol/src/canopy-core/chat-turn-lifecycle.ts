import { z } from 'zod';

export type TurnOrigin = 'user' | 'steer' | 'autonomous' | 'restart';

export interface SpawnedBy {
  taskId?: string;
  toolUseId?: string;
  /**
   * The task reported an event and keeps running (a Monitor's output line),
   * rather than finishing.
   */
  event?: true;
  /**
   * A scheduled prompt fired (a Claude `CronCreate` job); `toolUseId` names
   * the call that scheduled it when only one job could have.
   */
  scheduled?: true;
  /**
   * Canopy restarted the session to load tools and continued the prompt's
   * work; `toolUseId` names the load call. Unlike the other causes, this one
   * stays when the turn binds to its prompt.
   */
  toolsLoaded?: true;
}

export interface TurnBinding {
  turnId: string;
  origin: TurnOrigin;
  binding: 'pending' | 'bound' | 'unbound';
  submissionIds: string[];
  userMessageIds: string[];
  providerUserMessageUuids: string[];
  providerOriginKind?: string;
  resultIndex?: number;
  spawnedBy?: SpawnedBy;
}

export interface ProducerBase {
  version: 1;
  provider:
    | 'claude'
    | 'codex'
    | 'cursor'
    | 'copilot'
    | 'antigravity'
    | 'opencode';
  projectId: string;
  worktreeId: string;
  chatId: string;
  processEpoch?: string;
  sequence: number;
  eventId: string;
  observedAtMs: number;
  providerSessionId?: string;
  sourceFrameUuid?: string;
}

export interface TurnStarted extends ProducerBase, TurnBinding {
  type: 'TurnStarted';
  phase: 'start' | 'binding-update';
  startedAtMs: number;
}

export interface TurnEnded extends ProducerBase, TurnBinding {
  type: 'TurnEnded';
  endedAtMs: number;
  outcome: 'completed' | 'cancelled' | 'failed';
  terminalReason?: string;
  /**
   * The provider's elapsed wall time for the turn, including any time spent
   * waiting on host approvals or questions. The reducer subtracts the turn's
   * host-owned pauses, so the recorded duration is active time only.
   */
  durationMs?: number;
  source: 'result' | 'abort-fallback' | 'turn-completed';
}

export interface SessionState extends ProducerBase {
  type: 'SessionState';
  state: 'running' | 'requires_action' | 'idle' | 'reconnecting';
  observedDuringTurnId?: string;
  source: 'provider' | 'result-fallback';
}

export interface BackgroundSet extends ProducerBase {
  type: 'BackgroundSet';
  semantics: 'replace';
  observedDuringTurnId?: string;
  native: Array<{
    id: string;
    taskType?: string;
    toolUseId?: string;
    spawnedByTurnId?: string;
  }>;
  managed: { live: number; queued: number };
}

export type ChatTurnLifecycleEvent =
  | TurnStarted
  | TurnEnded
  | SessionState
  | BackgroundSet;

/** @deprecated Use ChatTurnLifecycleEvent. */
export type ClaudeLifecycleEvent = ChatTurnLifecycleEvent;

const identifierSchema = z.string().min(1).max(512);
const timestampSchema = z.number().finite().nonnegative();

export const TurnOriginSchema = z.enum([
  'user',
  'steer',
  'autonomous',
  'restart',
]);

export const SpawnedBySchema = z.strictObject({
  taskId: identifierSchema.optional(),
  toolUseId: identifierSchema.optional(),
  event: z.literal(true).optional(),
  scheduled: z.literal(true).optional(),
  toolsLoaded: z.literal(true).optional(),
});

export const TurnBindingSchema = z.strictObject({
  turnId: identifierSchema,
  origin: TurnOriginSchema,
  binding: z.enum(['pending', 'bound', 'unbound']),
  submissionIds: z.array(identifierSchema),
  userMessageIds: z.array(identifierSchema),
  providerUserMessageUuids: z.array(identifierSchema),
  providerOriginKind: z.string().optional(),
  resultIndex: z.number().int().nonnegative().optional(),
  spawnedBy: SpawnedBySchema.optional(),
});

export const ProducerBaseSchema = z.strictObject({
  version: z.literal(1),
  provider: z.enum([
    'claude',
    'codex',
    'cursor',
    'copilot',
    'antigravity',
    'opencode',
  ]),
  projectId: identifierSchema,
  worktreeId: identifierSchema,
  chatId: identifierSchema,
  processEpoch: identifierSchema.optional(),
  sequence: z.number().int().positive(),
  eventId: identifierSchema,
  observedAtMs: timestampSchema,
  providerSessionId: identifierSchema.optional(),
  sourceFrameUuid: identifierSchema.optional(),
});

export const TurnStartedSchema = z.strictObject({
  version: z.literal(1),
  provider: z.enum([
    'claude',
    'codex',
    'cursor',
    'copilot',
    'antigravity',
    'opencode',
  ]),
  projectId: identifierSchema,
  worktreeId: identifierSchema,
  chatId: identifierSchema,
  processEpoch: identifierSchema.optional(),
  sequence: z.number().int().positive(),
  eventId: identifierSchema,
  observedAtMs: timestampSchema,
  providerSessionId: identifierSchema.optional(),
  sourceFrameUuid: identifierSchema.optional(),
  turnId: identifierSchema,
  origin: TurnOriginSchema,
  binding: z.enum(['pending', 'bound', 'unbound']),
  submissionIds: z.array(identifierSchema),
  userMessageIds: z.array(identifierSchema),
  providerUserMessageUuids: z.array(identifierSchema),
  providerOriginKind: z.string().optional(),
  resultIndex: z.number().int().nonnegative().optional(),
  spawnedBy: SpawnedBySchema.optional(),
  type: z.literal('TurnStarted'),
  phase: z.enum(['start', 'binding-update']),
  startedAtMs: timestampSchema,
});

export const TurnEndedSchema = z.strictObject({
  version: z.literal(1),
  provider: z.enum([
    'claude',
    'codex',
    'cursor',
    'copilot',
    'antigravity',
    'opencode',
  ]),
  projectId: identifierSchema,
  worktreeId: identifierSchema,
  chatId: identifierSchema,
  processEpoch: identifierSchema.optional(),
  sequence: z.number().int().positive(),
  eventId: identifierSchema,
  observedAtMs: timestampSchema,
  providerSessionId: identifierSchema.optional(),
  sourceFrameUuid: identifierSchema.optional(),
  turnId: identifierSchema,
  origin: TurnOriginSchema,
  binding: z.enum(['pending', 'bound', 'unbound']),
  submissionIds: z.array(identifierSchema),
  userMessageIds: z.array(identifierSchema),
  providerUserMessageUuids: z.array(identifierSchema),
  providerOriginKind: z.string().optional(),
  resultIndex: z.number().int().nonnegative().optional(),
  spawnedBy: SpawnedBySchema.optional(),
  type: z.literal('TurnEnded'),
  endedAtMs: timestampSchema,
  outcome: z.enum(['completed', 'cancelled', 'failed']),
  terminalReason: z.string().optional(),
  durationMs: timestampSchema.optional(),
  source: z.enum(['result', 'abort-fallback', 'turn-completed']),
});

export const SessionStateSchema = z.strictObject({
  version: z.literal(1),
  provider: z.enum([
    'claude',
    'codex',
    'cursor',
    'copilot',
    'antigravity',
    'opencode',
  ]),
  projectId: identifierSchema,
  worktreeId: identifierSchema,
  chatId: identifierSchema,
  processEpoch: identifierSchema.optional(),
  sequence: z.number().int().positive(),
  eventId: identifierSchema,
  observedAtMs: timestampSchema,
  providerSessionId: identifierSchema.optional(),
  sourceFrameUuid: identifierSchema.optional(),
  type: z.literal('SessionState'),
  state: z.enum(['running', 'requires_action', 'idle', 'reconnecting']),
  observedDuringTurnId: identifierSchema.optional(),
  source: z.enum(['provider', 'result-fallback']),
});

export const BackgroundSetSchema = z.strictObject({
  version: z.literal(1),
  provider: z.enum([
    'claude',
    'codex',
    'cursor',
    'copilot',
    'antigravity',
    'opencode',
  ]),
  projectId: identifierSchema,
  worktreeId: identifierSchema,
  chatId: identifierSchema,
  processEpoch: identifierSchema.optional(),
  sequence: z.number().int().positive(),
  eventId: identifierSchema,
  observedAtMs: timestampSchema,
  providerSessionId: identifierSchema.optional(),
  sourceFrameUuid: identifierSchema.optional(),
  type: z.literal('BackgroundSet'),
  semantics: z.literal('replace'),
  observedDuringTurnId: identifierSchema.optional(),
  native: z.array(
    z.strictObject({
      id: identifierSchema,
      taskType: z.string().optional(),
      toolUseId: identifierSchema.optional(),
      spawnedByTurnId: identifierSchema.optional(),
    }),
  ),
  managed: z.strictObject({
    live: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
  }),
});

export const ChatTurnLifecycleEventSchema = z.discriminatedUnion('type', [
  TurnStartedSchema,
  TurnEndedSchema,
  SessionStateSchema,
  BackgroundSetSchema,
]);

export function isChatTurnLifecycleEvent(
  value: unknown,
): value is ChatTurnLifecycleEvent {
  return ChatTurnLifecycleEventSchema.safeParse(value).success;
}

/** @deprecated Use ChatTurnLifecycleEventSchema. */
export const ClaudeLifecycleEventSchema = ChatTurnLifecycleEventSchema;

/** @deprecated Use isChatTurnLifecycleEvent. */
export const isClaudeLifecycleEvent = isChatTurnLifecycleEvent;

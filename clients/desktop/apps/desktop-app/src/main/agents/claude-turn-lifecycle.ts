import {
  type BackgroundSet,
  type ClaudeLifecycleEvent,
  type SpawnedBy,
  type TurnBinding,
} from '@canopy/protocol/canopy-core';
import type { ActivityLiveBgTask } from '@canopy/desktop-shared/types/activity-panel';
import { subscribeBackgroundWork } from './background-work';
import {
  activeDelegationCount,
  parseDelegationSessionKey,
  queuedDelegationCount,
} from './delegation/activity';
import { buildChatSessionKey } from './session-key';
import {
  getLiveBackgroundTasksForChat,
  getSessionExecutionHarness,
  getSessionProviderType,
} from './session-manager';
import {
  getTurnLifecycleProducer,
  onTurnLifecycleSinkChange,
  releaseTurnLifecycleProducer,
  setTurnLifecycleClockForTests,
  setTurnLifecycleSink,
  type BackgroundSetFields as ProviderBackgroundSetFields,
  type SessionStateFields as ProviderSessionStateFields,
  type TurnLifecycleProvider,
  type TurnLifecycleProducer,
  type TurnEndedFields as ProviderTurnEndedFields,
  type TurnStartedFields as ProviderTurnStartedFields,
} from './provider-turn-lifecycle';

export interface ClaudeTurnLifecycleScope {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export type ClaudeTurnStartedFields = ProviderTurnStartedFields;
export type ClaudeTurnEndedFields = ProviderTurnEndedFields;
export type ClaudeSessionStateFields = ProviderSessionStateFields;
export type ClaudeBackgroundSetFields = ProviderBackgroundSetFields;

export type ClaudeTurnLifecycleProducer = TurnLifecycleProducer;
export type ClaudeTurnLifecycleSink =
  | ((event: ClaudeLifecycleEvent) => void)
  | null;

let stopBackgroundSetPublisher: (() => void) | undefined;
let lifecycleSinkRegistered = false;

const MAX_REMEMBERED_PROVIDER_SCOPES = 256;
const rememberedProviderByScope = new Map<string, TurnLifecycleProvider>();

export function setClaudeTurnLifecycleSink(
  sink: ((event: ClaudeLifecycleEvent) => void) | null,
): void {
  setTurnLifecycleSink(sink);
}

/** Injects the host receipt clock; passing null restores the system clock. */
export function setClaudeTurnLifecycleClockForTests(
  clock: (() => number) | null,
): void {
  setTurnLifecycleClockForTests(clock);
}

export function getClaudeTurnLifecycleProducer(
  scope: ClaudeTurnLifecycleScope,
): ClaudeTurnLifecycleProducer {
  return getTurnLifecycleProducer('claude', scope);
}

export function releaseClaudeTurnLifecycleProducer(
  scope: ClaudeTurnLifecycleScope,
): void {
  releaseTurnLifecycleProducer('claude', scope);
}

onTurnLifecycleSinkChange((registered) => {
  lifecycleSinkRegistered = registered;
  // Background work has no session-local trigger, so publish its set only
  // while a consumer is registered.
  if (registered && !stopBackgroundSetPublisher) {
    stopBackgroundSetPublisher = startClaudeBackgroundSetPublisher();
  } else if (!registered && stopBackgroundSetPublisher) {
    stopBackgroundSetPublisher();
    stopBackgroundSetPublisher = undefined;
  }
});

interface YieldedSend {
  submissionId: string;
  userMessageId?: string;
  kind: 'ordinary' | 'steer';
}

interface TrackedTurn extends TurnBinding {
  closed: boolean;
  hasBoundEvidence: boolean;
  /** A wake cause withheld while one of our sends may still bind the turn. */
  heldSpawnedBy?: SpawnedBy;
}

function publicBinding(turn: TrackedTurn): TurnBinding {
  return {
    turnId: turn.turnId,
    origin: turn.origin,
    binding: turn.binding,
    submissionIds: [...turn.submissionIds],
    userMessageIds: [...turn.userMessageIds],
    providerUserMessageUuids: [...turn.providerUserMessageUuids],
    ...(turn.providerOriginKind === undefined
      ? {}
      : { providerOriginKind: turn.providerOriginKind }),
    ...(turn.resultIndex === undefined
      ? {}
      : { resultIndex: turn.resultIndex }),
    ...(turn.spawnedBy === undefined
      ? {}
      : { spawnedBy: { ...turn.spawnedBy } }),
  };
}

/**
 * The task a root task notification reports as ended: the cause of the wake
 * turn the CLI starts for it. Ambient tasks (watchers) aren't activity.
 */
export function readClaudeWakeCause(data: unknown): SpawnedBy | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const event: Record<string, unknown> = { ...data };
  if (
    event.type !== 'system' ||
    event.subtype !== 'task_notification' ||
    event.parent_tool_use_id != null ||
    event.ambient === true ||
    (event.status !== 'completed' &&
      event.status !== 'failed' &&
      event.status !== 'stopped') ||
    typeof event.task_id !== 'string'
  )
    return undefined;
  return {
    taskId: event.task_id,
    ...(typeof event.tool_use_id === 'string'
      ? { toolUseId: event.tool_use_id }
      : {}),
  };
}

/**
 * A result for a queued task notification that is neither a scheduled run nor
 * a peer message: a running task's event, such as a Monitor's output line.
 */
export function isClaudeTaskEventResult(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || !('origin' in data))
    return false;
  const origin = data.origin;
  if (typeof origin !== 'object' || origin === null) return false;
  const fields: Record<string, unknown> = { ...origin };
  return fields.kind === 'task-notification' && fields.subkind === undefined;
}

/**
 * The command a root `command_lifecycle` frame reports started. A cron job's
 * fire starts its turn with a command no send queued.
 */
export function readClaudeStartedCommandUuid(
  data: unknown,
): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const fields: Record<string, unknown> = { ...data };
  return fields.type === 'command_lifecycle' &&
    fields.state === 'started' &&
    fields.parent_tool_use_id == null &&
    typeof fields.command_uuid === 'string'
    ? fields.command_uuid
    : undefined;
}

const MAX_TRACKED_EVENT_TASKS = 256;

function trimOldest<K>(collection: Set<K> | Map<K, unknown>): void {
  if (collection.size <= MAX_TRACKED_EVENT_TASKS) return;
  const oldest = collection.keys().next().value;
  if (oldest !== undefined) collection.delete(oldest);
}

interface ScheduledJob {
  toolUseId: string;
  recurring: boolean;
  durable: boolean;
}

/** The first tool result's call id in a user frame, if any. */
function toolResultCallId(message: unknown): string | undefined {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('content' in message) ||
    !Array.isArray(message.content)
  )
    return undefined;
  const content: unknown[] = message.content;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const fields: Record<string, unknown> = { ...block };
    if (fields.type === 'tool_result' && typeof fields.tool_use_id === 'string')
      return fields.tool_use_id;
  }
  return undefined;
}

/**
 * The live root tasks Monitor calls started. A Monitor's events reach the
 * model as task notifications the SDK stream never reports, so the turn one
 * wakes takes its cause from this set instead.
 *
 * Also the session's live cron jobs (`CronCreate`). A job's fire starts a
 * turn with a command no send queued and reports no origin, so that turn
 * takes its cause from these jobs.
 */
export class ClaudeEventTaskTracker {
  private readonly monitorToolUseIds = new Set<string>();
  private readonly toolUseIdByTaskId = new Map<string, string>();
  private liveTaskIds = new Set<string>();
  /** CronCreate / CronDelete calls awaiting their result, by call id. */
  private readonly cronCalls = new Map<string, 'CronCreate' | 'CronDelete'>();
  private readonly scheduledJobs = new Map<string, ScheduledJob>();

  observe(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const frame: Record<string, unknown> = { ...data };
    if (frame.parent_tool_use_id != null) return;
    if (frame.type === 'assistant') {
      this.observeToolCalls(frame.message);
      return;
    }
    if (frame.type === 'user') {
      this.observeCronResult(frame);
      return;
    }
    if (frame.type !== 'system') return;
    if (frame.subtype === 'background_tasks_changed') {
      if (!Array.isArray(frame.tasks)) return;
      const tasks: unknown[] = frame.tasks;
      const taskIds: string[] = [];
      for (const task of tasks) {
        if (typeof task !== 'object' || task === null) continue;
        const fields: Record<string, unknown> = { ...task };
        if (typeof fields.task_id === 'string') taskIds.push(fields.task_id);
      }
      this.liveTaskIds = new Set(taskIds.slice(-MAX_TRACKED_EVENT_TASKS));
      return;
    }
    if (typeof frame.task_id !== 'string') return;
    if (frame.subtype === 'task_started') {
      this.liveTaskIds.add(frame.task_id);
      trimOldest(this.liveTaskIds);
      if (typeof frame.tool_use_id === 'string') {
        this.toolUseIdByTaskId.set(frame.task_id, frame.tool_use_id);
        trimOldest(this.toolUseIdByTaskId);
      }
    } else if (frame.subtype === 'task_notification') {
      this.liveTaskIds.delete(frame.task_id);
    }
  }

  /**
   * A new CLI process owns no tasks yet, and keeps only the durable cron jobs
   * it reloads from disk.
   */
  resetLiveTasks(): void {
    this.liveTaskIds = new Set();
    for (const [jobId, job] of Array.from(this.scheduledJobs)) {
      if (!job.durable) this.scheduledJobs.delete(jobId);
    }
  }

  /**
   * The cause of a turn a cron job's fire started, while any job is live: the
   * call that scheduled it when only one is. A one-shot job deletes itself
   * once it fires.
   */
  scheduledCause(): SpawnedBy | undefined {
    if (this.scheduledJobs.size === 0) return undefined;
    const jobs = Array.from(this.scheduledJobs);
    const only = jobs.length === 1 ? jobs[0] : undefined;
    if (only === undefined) return { scheduled: true };
    const [jobId, job] = only;
    if (!job.recurring) this.scheduledJobs.delete(jobId);
    return { toolUseId: job.toolUseId, scheduled: true };
  }

  private observeCronResult(frame: Record<string, unknown>): void {
    const callId = toolResultCallId(frame.message);
    const call = callId === undefined ? undefined : this.cronCalls.get(callId);
    if (callId === undefined || call === undefined) return;
    this.cronCalls.delete(callId);
    const result = frame.tool_use_result;
    if (typeof result !== 'object' || result === null) return;
    const fields: Record<string, unknown> = { ...result };
    if (typeof fields.id !== 'string') return;
    if (call === 'CronDelete') {
      this.scheduledJobs.delete(fields.id);
      return;
    }
    this.scheduledJobs.set(fields.id, {
      toolUseId: callId,
      recurring: fields.recurring !== false,
      durable: fields.durable === true,
    });
    trimOldest(this.scheduledJobs);
  }

  /** The cause of an event wake: the Monitor task, when exactly one is live. */
  eventCause(): SpawnedBy {
    const monitorTasks: Array<{ taskId: string; toolUseId: string }> = [];
    for (const taskId of Array.from(this.liveTaskIds)) {
      const toolUseId = this.toolUseIdByTaskId.get(taskId);
      if (toolUseId !== undefined && this.monitorToolUseIds.has(toolUseId))
        monitorTasks.push({ taskId, toolUseId });
    }
    const only = monitorTasks.length === 1 ? monitorTasks[0] : undefined;
    return only === undefined ? { event: true } : { ...only, event: true };
  }

  private observeToolCalls(message: unknown): void {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('content' in message) ||
      !Array.isArray(message.content)
    )
      return;
    const content: unknown[] = message.content;
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const fields: Record<string, unknown> = { ...block };
      if (fields.type !== 'tool_use' || typeof fields.id !== 'string') continue;
      if (fields.name === 'Monitor') {
        this.monitorToolUseIds.add(fields.id);
        trimOldest(this.monitorToolUseIds);
      } else if (fields.name === 'CronCreate' || fields.name === 'CronDelete') {
        this.cronCalls.set(fields.id, fields.name);
        trimOldest(this.cronCalls);
      }
    }
  }
}

const MAX_YIELDED_ALIASES = 256;
export const MAX_BOUND_INPUTS_PER_TURN = 64;
const MAX_BINDING_LIMIT_DIAGNOSTIC_IDENTIFIERS = 8;
const MAX_BINDING_LIMIT_DIAGNOSTIC_IDENTIFIER_LENGTH = 128;

export interface ClaudeBindingLimitDiagnostic {
  rejectedInputCount: number;
  providerUserMessageUuids: string[];
  userMessageIds: string[];
  submissionIds: string[];
  truncated: boolean;
}

function boundDiagnosticIdentifiers(values: string[]): {
  identifiers: string[];
  truncated: boolean;
} {
  const identifiers: string[] = [];
  let truncated = false;
  for (const value of values) {
    if (identifiers.includes(value)) continue;
    if (identifiers.length >= MAX_BINDING_LIMIT_DIAGNOSTIC_IDENTIFIERS) {
      truncated = true;
      continue;
    }
    const bounded = value.slice(
      0,
      MAX_BINDING_LIMIT_DIAGNOSTIC_IDENTIFIER_LENGTH,
    );
    if (bounded !== value) truncated = true;
    identifiers.push(bounded);
  }
  return { identifiers, truncated };
}

export class ClaudeTurnBindingTracker {
  private readonly yieldedByWireUuid = new Map<string, YieldedSend>();
  private turn: TrackedTurn | undefined;
  private bindingLimitExceeded = false;
  private bindingLimitRejectedCount = 0;
  private bindingLimitDiagnostic: ClaudeBindingLimitDiagnostic | undefined;

  registerYielded(
    wireUuid: string,
    send: {
      submissionId: string;
      userMessageId?: string;
      kind: 'ordinary' | 'steer';
    },
  ): void {
    this.yieldedByWireUuid.delete(wireUuid);
    this.yieldedByWireUuid.set(wireUuid, { ...send });
    // Sends that are never consumed (withdrawn or cancelled) age out oldest-first.
    if (this.yieldedByWireUuid.size > MAX_YIELDED_ALIASES) {
      const oldest = Array.from(this.yieldedByWireUuid.keys())[0];
      if (oldest !== undefined) this.yieldedByWireUuid.delete(oldest);
    }
  }

  /** `wakeCause` is the task notification that preceded the turn, if any. */
  openTurn(turnId: string, wakeCause?: SpawnedBy): TurnBinding {
    this.bindingLimitExceeded = false;
    this.bindingLimitRejectedCount = 0;
    this.bindingLimitDiagnostic = undefined;
    this.turn = {
      turnId,
      origin: 'autonomous',
      binding: 'pending',
      submissionIds: [],
      userMessageIds: [],
      providerUserMessageUuids: [],
      // A send still awaiting its turn likely opened this one; publishing the
      // cause before it binds would flash a wake boundary over the prompt.
      ...(wakeCause === undefined
        ? {}
        : this.yieldedByWireUuid.size > 0
          ? { heldSpawnedBy: { ...wakeCause } }
          : { spawnedBy: { ...wakeCause } }),
      closed: false,
      hasBoundEvidence: false,
    };
    return publicBinding(this.turn);
  }

  /** Whether a wire uuid is one of this session's sends. */
  isOwnSend(wireUuid: string): boolean {
    return this.yieldedByWireUuid.has(wireUuid);
  }

  observeCommandStarted(commandUuid: string): TurnBinding | undefined {
    return this.observeUuids([commandUuid]);
  }

  observeUserMessageUuids(uuids: string[]): TurnBinding | undefined {
    return this.observeUuids(uuids);
  }

  markRestart(): void {
    if (this.turn && !this.turn.closed) this.turn.origin = 'restart';
  }

  /** `eventCause` names the running task whose event woke the turn, if any. */
  sealAtResult(
    result: {
      originKind?: string;
      resultIndex?: number;
    },
    eventCause?: SpawnedBy,
  ): TurnBinding | undefined {
    const turn = this.turn;
    if (!turn || turn.closed) return undefined;
    turn.binding = turn.hasBoundEvidence ? 'bound' : 'unbound';
    if (!turn.hasBoundEvidence && turn.origin !== 'restart') {
      turn.origin = 'autonomous';
      if (turn.heldSpawnedBy !== undefined && turn.spawnedBy === undefined)
        turn.spawnedBy = { ...turn.heldSpawnedBy };
      // An event wake has no notification frame, so its cause comes with
      // the result.
      if (eventCause !== undefined && turn.spawnedBy === undefined)
        turn.spawnedBy = { ...eventCause };
    }
    if (result.originKind !== undefined) {
      turn.providerOriginKind = result.originKind;
    }
    if (result.resultIndex !== undefined) {
      turn.resultIndex = result.resultIndex;
    }
    turn.closed = true;
    // A consumed send binds exactly one turn, so a late echo of its uuid must
    // not bind a later one.
    for (const [uuid, yielded] of Array.from(this.yieldedByWireUuid)) {
      if (turn.submissionIds.includes(yielded.submissionId)) {
        this.yieldedByWireUuid.delete(uuid);
      }
    }
    return publicBinding(turn);
  }

  current(): TurnBinding | undefined {
    return this.turn ? publicBinding(this.turn) : undefined;
  }

  consumeBindingLimitExceeded(): number {
    const rejectedCount = this.bindingLimitRejectedCount;
    this.bindingLimitRejectedCount = 0;
    return rejectedCount;
  }

  consumeBindingLimitDiagnostic(): ClaudeBindingLimitDiagnostic | undefined {
    const diagnostic = this.bindingLimitDiagnostic;
    this.bindingLimitDiagnostic = undefined;
    return diagnostic
      ? {
          ...diagnostic,
          providerUserMessageUuids: [...diagnostic.providerUserMessageUuids],
          userMessageIds: [...diagnostic.userMessageIds],
          submissionIds: [...diagnostic.submissionIds],
        }
      : undefined;
  }

  private observeUuids(uuids: string[]): TurnBinding | undefined {
    const turn = this.turn;
    if (!turn || turn.closed) return undefined;

    // Preflight the whole evidence frame before changing any arrays. Partial
    // binding could otherwise publish an incomplete membership list for a
    // frame that was rejected for crossing the cap.
    const candidateInputs = new Set<string>();
    for (const uuid of uuids) {
      const send = this.yieldedByWireUuid.get(uuid);
      if (send?.userMessageId !== undefined)
        candidateInputs.add(send.userMessageId);
    }
    const newInputs = Array.from(candidateInputs).filter(
      (userMessageId) => !turn.userMessageIds.includes(userMessageId),
    );
    if (this.bindingLimitExceeded) return undefined;
    if (
      turn.userMessageIds.length + newInputs.length >
      MAX_BOUND_INPUTS_PER_TURN
    ) {
      this.bindingLimitExceeded = true;
      this.bindingLimitRejectedCount = newInputs.length;
      const offendingWireUuids: string[] = [];
      const offendingSubmissionIds: string[] = [];
      for (const uuid of uuids) {
        const send = this.yieldedByWireUuid.get(uuid);
        if (
          send?.userMessageId !== undefined &&
          newInputs.includes(send.userMessageId)
        ) {
          offendingWireUuids.push(uuid);
          offendingSubmissionIds.push(send.submissionId);
        }
      }
      const boundedWireUuids = boundDiagnosticIdentifiers(offendingWireUuids);
      const boundedUserMessageIds = boundDiagnosticIdentifiers(newInputs);
      const boundedSubmissionIds = boundDiagnosticIdentifiers(
        offendingSubmissionIds,
      );
      this.bindingLimitDiagnostic = {
        rejectedInputCount: newInputs.length,
        providerUserMessageUuids: boundedWireUuids.identifiers,
        userMessageIds: boundedUserMessageIds.identifiers,
        submissionIds: boundedSubmissionIds.identifiers,
        truncated:
          boundedWireUuids.truncated ||
          boundedUserMessageIds.truncated ||
          boundedSubmissionIds.truncated,
      };
      return undefined;
    }

    let changed = false;
    for (const uuid of uuids) {
      if (!turn.providerUserMessageUuids.includes(uuid)) {
        turn.providerUserMessageUuids.push(uuid);
        changed = true;
      }

      const send = this.yieldedByWireUuid.get(uuid);
      if (!send) continue;

      if (!turn.hasBoundEvidence) {
        turn.hasBoundEvidence = true;
        turn.binding = 'bound';
        changed = true;
      }
      if (!turn.submissionIds.includes(send.submissionId)) {
        turn.submissionIds.push(send.submissionId);
        changed = true;
      }
      if (
        send.userMessageId !== undefined &&
        !turn.userMessageIds.includes(send.userMessageId)
      ) {
        turn.userMessageIds.push(send.userMessageId);
        changed = true;
      }
      if (send.kind === 'ordinary' && turn.origin !== 'restart') {
        if (turn.origin !== 'user') changed = true;
        turn.origin = 'user';
      }
    }

    return changed ? publicBinding(turn) : undefined;
  }
}

function toNativeTasks(
  liveTasks: ActivityLiveBgTask[] | undefined,
): BackgroundSet['native'] {
  return (liveTasks ?? []).map((task) => ({
    id: task.taskId,
    ...(task.taskType === undefined ? {} : { taskType: task.taskType }),
    ...(task.toolUseId === undefined ? {} : { toolUseId: task.toolUseId }),
  }));
}

function lifecycleScopeKey(scope: ClaudeTurnLifecycleScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId, scope.chatId]);
}

function rememberLifecycleProvider(
  scope: ClaudeTurnLifecycleScope,
  provider: TurnLifecycleProvider,
): void {
  const key = lifecycleScopeKey(scope);
  rememberedProviderByScope.delete(key);
  rememberedProviderByScope.set(key, provider);
  if (rememberedProviderByScope.size > MAX_REMEMBERED_PROVIDER_SCOPES) {
    const oldestKey = rememberedProviderByScope.keys().next().value;
    if (oldestKey !== undefined) rememberedProviderByScope.delete(oldestKey);
  }
}

function getRememberedLifecycleProvider(
  scope: ClaudeTurnLifecycleScope,
): TurnLifecycleProvider | undefined {
  const key = lifecycleScopeKey(scope);
  const provider = rememberedProviderByScope.get(key);
  if (provider === undefined) return undefined;
  rememberedProviderByScope.delete(key);
  rememberedProviderByScope.set(key, provider);
  return provider;
}

function isTurnLifecycleProvider(
  provider: string | undefined,
): provider is TurnLifecycleProvider {
  return (
    provider === 'claude' ||
    provider === 'codex' ||
    provider === 'cursor' ||
    provider === 'copilot' ||
    provider === 'antigravity' ||
    provider === 'opencode'
  );
}

function publishBackgroundSet(
  scope: ClaudeTurnLifecycleScope,
  provider: TurnLifecycleProvider,
): void {
  const liveTasks = getLiveBackgroundTasksForChat(
    scope.projectId,
    scope.worktreeId,
    scope.chatId,
  );
  const sessionKey = buildChatSessionKey(
    scope.projectId,
    scope.worktreeId,
    scope.chatId,
  );
  const producer = getTurnLifecycleProducer(provider, scope);
  producer.backgroundSet({
    semantics: 'replace',
    native: toNativeTasks(liveTasks),
    managed: {
      live: activeDelegationCount(sessionKey),
      queued: queuedDelegationCount(sessionKey),
    },
  });
}

export function requestBackgroundSnapshot(scope: {
  provider: TurnLifecycleProvider;
  projectId: string;
  worktreeId: string;
  chatId: string;
}): void {
  if (!lifecycleSinkRegistered) return;
  rememberLifecycleProvider(scope, scope.provider);
  publishBackgroundSet(scope, scope.provider);
}

function startClaudeBackgroundSetPublisher(): () => void {
  return subscribeBackgroundWork((sessionKey) => {
    const scope = parseDelegationSessionKey(sessionKey);
    if (!scope) return;
    const sessionProvider = getSessionProviderType(
      scope.projectId,
      scope.worktreeId,
      scope.chatId,
    );
    // Ollama names the model's provider; its turn lifecycle, and so its
    // background set, runs under its execution harness (turn-state 40a).
    const harness = getSessionExecutionHarness(
      scope.projectId,
      scope.worktreeId,
      scope.chatId,
    );
    const provider =
      sessionProvider === undefined
        ? getRememberedLifecycleProvider(scope)
        : isTurnLifecycleProvider(sessionProvider)
          ? sessionProvider
          : isTurnLifecycleProvider(harness)
            ? harness
            : undefined;
    if (provider === undefined) {
      // Unknown sessionless chats have no provider to publish under.
      return;
    }
    rememberLifecycleProvider(scope, provider);
    publishBackgroundSet(scope, provider);
  });
}

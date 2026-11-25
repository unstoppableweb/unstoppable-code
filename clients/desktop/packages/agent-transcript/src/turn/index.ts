import type {
  ChatTurnLifecycleEvent,
  TurnOrigin,
  SpawnedBy,
} from '@canopy/protocol/canopy-core';

export type ChatTurnPhase = 'foreground' | 'background' | 'idle';
export type ChatTurnOutcome = 'completed' | 'cancelled' | 'failed';
export type ChatTurnPauseOwnerKind = 'approval' | 'question';

export interface ChatTurnPause {
  ownerKind: ChatTurnPauseOwnerKind;
  ownerId: string;
  startedAtMs: number;
  endedAtMs?: number;
}
export interface ChatTurnRecord {
  id: string;
  origin: TurnOrigin;
  userMessageId?: string;
  /** Ordered message ids from the start binding and subsequent additions. */
  inputIds?: string[];
  spawnedBy?: SpawnedBy;
  startedAtMs: number;
  /** Host-owned approval and question pause intervals. */
  pauses: ChatTurnPause[];
  endedAtMs?: number;
  outcome?: ChatTurnOutcome;
  durationMs?: number;
  terminalReason?: string;
}
export interface ChatTurnBackground {
  native: ReadonlyArray<{
    id: string;
    taskType?: string;
    toolUseId?: string;
    spawnedByTurnId?: string;
  }>;
  managed: { live: number; queued: number };
}
export interface ChatTurnState {
  phase: ChatTurnPhase;
  /** Provider requires_action observation, never a timer pause. */
  decisionPending: boolean;
  /** Host-owned catch-up flag, carried unchanged by the reducer. */
  catchingUp: boolean;
  current?: ChatTurnRecord;
  lastEnded?: ChatTurnRecord;
  /** Last 32 settled ids, oldest first. */
  endedTurnIds: string[];
  background: ChatTurnBackground;
  /** Provider scope sequences plus the independent host pause counter in `host`. */
  cursors: Record<string, number>;
}

export type PersistedChatTurnState = Omit<ChatTurnState, 'cursors'>;

export interface ChatTurnHostPauseEvent {
  type: 'PauseOpened' | 'PauseClosed';
  turnId: string;
  ownerKind: ChatTurnPauseOwnerKind;
  ownerId: string;
  atMs: number;
  hostSequence: number;
}

export type ChatTurnEffect =
  | { type: 'timer.open'; timerId: string; turnId: string; atMs: number }
  | { type: 'timer.pause'; timerId: string; turnId: string; atMs: number }
  | { type: 'timer.resume'; timerId: string; turnId: string; atMs: number }
  | {
      type: 'timer.close';
      timerId: string;
      turnId: string;
      atMs: number;
      durationMs?: number;
    }
  | { type: 'turn.ended'; turnId: string; outcome: ChatTurnOutcome }
  | { type: 'chat.idle' };

export function initialChatTurnState(): ChatTurnState {
  return {
    phase: 'idle',
    decisionPending: false,
    catchingUp: false,
    endedTurnIds: [],
    background: { native: [], managed: { live: 0, queued: 0 } },
    cursors: {},
  };
}

export function chatTurnTimerId(turnId: string): string {
  return `${turnId}:timer`;
}

/**
 * The display key of a wake's turn: its boundary row's id, and the key its
 * own turn diff is stored under (turn-state phases 40d and 40f).
 */
export function wakeTurnKey(turnId: string): string {
  return `${chatTurnTimerId(turnId)}:wake`;
}

type ChatTurnReduction = {
  state: ChatTurnState;
  effects: ChatTurnEffect[];
};

const MAX_ENDED_TURN_IDS = 32;
const MAX_INPUT_IDS = 64;
// Reducer and persistence share this bound so reachable collections always hydrate.
const MAX_TURN_COLLECTION_ITEMS = 4_096;

function hasBackgroundWork(background: ChatTurnBackground): boolean {
  return (
    background.native.length > 0 ||
    background.managed.live > 0 ||
    background.managed.queued > 0
  );
}

function mergeSpawnedBy(
  existing: SpawnedBy | undefined,
  incoming: SpawnedBy | undefined,
): SpawnedBy | undefined {
  if (incoming === undefined) {
    return existing;
  }

  const taskId = incoming.taskId ?? existing?.taskId;
  const toolUseId = incoming.toolUseId ?? existing?.toolUseId;
  const event = incoming.event ?? existing?.event;
  const scheduled = incoming.scheduled ?? existing?.scheduled;
  const toolsLoaded = incoming.toolsLoaded ?? existing?.toolsLoaded;
  return {
    ...(taskId === undefined ? {} : { taskId }),
    ...(toolUseId === undefined ? {} : { toolUseId }),
    ...(event === true ? { event } : {}),
    ...(scheduled === true ? { scheduled } : {}),
    ...(toolsLoaded === true ? { toolsLoaded } : {}),
  };
}

function mergeInputIds(
  existing: ReadonlyArray<string> | undefined,
  incoming: ReadonlyArray<string>,
): string[] | undefined {
  if (existing === undefined && incoming.length === 0) {
    return undefined;
  }

  const inputIds: string[] = [];
  const seen = new Set<string>();
  for (const id of existing ?? []) {
    if (seen.has(id)) continue;
    if (inputIds.length >= MAX_INPUT_IDS) break;
    seen.add(id);
    inputIds.push(id);
  }
  for (const id of incoming) {
    if (seen.has(id)) continue;
    if (inputIds.length >= MAX_INPUT_IDS) break;
    seen.add(id);
    inputIds.push(id);
  }

  return inputIds;
}

function mergeCurrentTurn(
  current: ChatTurnRecord,
  event: Extract<ChatTurnLifecycleEvent, { type: 'TurnStarted' }>,
): ChatTurnRecord {
  const userMessageId = event.userMessageIds[0];
  const spawnedBy = mergeSpawnedBy(current.spawnedBy, event.spawnedBy);
  const priorInputIds =
    current.inputIds ??
    (current.userMessageId === undefined ? undefined : [current.userMessageId]);
  const inputIds = mergeInputIds(priorInputIds, event.userMessageIds);
  return {
    ...current,
    origin: event.origin,
    ...(current.userMessageId === undefined && userMessageId !== undefined
      ? { userMessageId }
      : {}),
    ...(inputIds === undefined ? {} : { inputIds }),
    ...(spawnedBy === undefined ? {} : { spawnedBy }),
  };
}

function turnFromStart(
  event: Extract<ChatTurnLifecycleEvent, { type: 'TurnStarted' }>,
): ChatTurnRecord {
  const userMessageId = event.userMessageIds[0];
  const spawnedBy = mergeSpawnedBy(undefined, event.spawnedBy);
  const inputIds = mergeInputIds(undefined, event.userMessageIds);
  return {
    id: event.turnId,
    origin: event.origin,
    ...(userMessageId === undefined ? {} : { userMessageId }),
    ...(inputIds === undefined ? {} : { inputIds }),
    ...(spawnedBy === undefined ? {} : { spawnedBy }),
    startedAtMs: event.startedAtMs,
    pauses: [],
  };
}

function closeOpenPauseIntervals(
  pauses: ReadonlyArray<ChatTurnPause>,
  endedAtMs: number,
): ChatTurnPause[] {
  return pauses.map((pause) => ({
    ...pause,
    ...(pause.endedAtMs === undefined
      ? { endedAtMs: Math.max(pause.startedAtMs, endedAtMs) }
      : {}),
  }));
}

function unionPausedDurationMs(
  turn: ChatTurnRecord,
  endedAtMs: number,
): number {
  const intervals = turn.pauses
    .map((pause) => ({
      start: Math.max(turn.startedAtMs, pause.startedAtMs),
      end: Math.min(endedAtMs, pause.endedAtMs ?? endedAtMs),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  let pausedMs = 0;
  let unionStart: number | undefined;
  let unionEnd: number | undefined;
  for (const interval of intervals) {
    if (unionStart === undefined || unionEnd === undefined) {
      unionStart = interval.start;
      unionEnd = interval.end;
    } else if (interval.start <= unionEnd) {
      unionEnd = Math.max(unionEnd, interval.end);
    } else {
      pausedMs += unionEnd - unionStart;
      unionStart = interval.start;
      unionEnd = interval.end;
    }
  }
  if (unionStart !== undefined && unionEnd !== undefined) {
    pausedMs += unionEnd - unionStart;
  }

  return pausedMs;
}

/**
 * The paused time an ended turn's `durationMs` was netted by: the union of
 * its approval and question pause intervals inside the turn. Zero for a turn
 * that has not ended.
 */
export function chatTurnPausedDurationMs(record: ChatTurnRecord): number {
  return record.endedAtMs === undefined
    ? 0
    : unionPausedDurationMs(record, record.endedAtMs);
}

function finalizeCurrentTurn(
  state: ChatTurnState,
  endedAtMs: number,
  outcome: ChatTurnOutcome,
  suppliedDurationMs?: number,
  terminalReason?: string,
): ChatTurnReduction {
  const { current, ...stateWithoutCurrent } = state;
  if (current === undefined) {
    return { state, effects: [] };
  }

  // A provider-reported duration is elapsed wall time, which includes the
  // host-owned approval and question pauses. The record keeps active time
  // only, so net either source of the turn's paused time exactly once.
  const pausedMs = unionPausedDurationMs(current, endedAtMs);
  const durationMs = Math.max(
    0,
    (suppliedDurationMs ?? endedAtMs - current.startedAtMs) - pausedMs,
  );
  const ended: ChatTurnRecord = {
    ...current,
    pauses: closeOpenPauseIntervals(current.pauses, endedAtMs),
    endedAtMs,
    outcome,
    durationMs,
    ...(terminalReason === undefined ? {} : { terminalReason }),
  };
  const hasBackground = hasBackgroundWork(state.background);
  const effects: ChatTurnEffect[] = [
    {
      type: 'timer.close',
      timerId: chatTurnTimerId(current.id),
      turnId: current.id,
      atMs: endedAtMs,
      durationMs,
    },
    { type: 'turn.ended', turnId: current.id, outcome },
  ];

  if (!hasBackground) {
    effects.push({ type: 'chat.idle' });
  }

  return {
    state: {
      ...stateWithoutCurrent,
      phase: hasBackground ? 'background' : 'idle',
      decisionPending: false,
      lastEnded: ended,
      endedTurnIds: [...state.endedTurnIds, current.id].slice(
        -MAX_ENDED_TURN_IDS,
      ),
    },
    effects,
  };
}

function referencesSettledTurn(
  state: ChatTurnState,
  event: ChatTurnLifecycleEvent,
): boolean {
  switch (event.type) {
    case 'TurnStarted':
    case 'TurnEnded':
      return state.endedTurnIds.includes(event.turnId);
    case 'SessionState':
      return (
        event.observedDuringTurnId !== undefined &&
        state.endedTurnIds.includes(event.observedDuringTurnId)
      );
    case 'BackgroundSet':
      // Replace-sets describe current work; the turn id is correlation only.
      return false;
  }
}

export function reduceChatTurn(
  state: ChatTurnState,
  event: ChatTurnLifecycleEvent,
): { state: ChatTurnState; effects: ChatTurnEffect[] } {
  const scope = `${event.provider}:${event.processEpoch ?? ''}`;
  const previousSequence = state.cursors[scope];
  if (previousSequence !== undefined && event.sequence <= previousSequence) {
    return { state, effects: [] };
  }

  // Every fresh event advances its producer cursor, including semantic no-ops.
  const stateWithCursor: ChatTurnState = {
    ...state,
    cursors: { ...state.cursors, [scope]: event.sequence },
  };
  if (referencesSettledTurn(state, event)) {
    return { state: stateWithCursor, effects: [] };
  }

  switch (event.type) {
    case 'TurnStarted': {
      const current = stateWithCursor.current;
      if (event.phase === 'binding-update') {
        if (current === undefined || current.id !== event.turnId) {
          return { state: stateWithCursor, effects: [] };
        }
        return {
          state: {
            ...stateWithCursor,
            current: mergeCurrentTurn(current, event),
          },
          effects: [],
        };
      }

      if (current?.id === event.turnId) {
        return {
          state: {
            ...stateWithCursor,
            current: mergeCurrentTurn(current, event),
          },
          effects: [],
        };
      }

      let nextState = stateWithCursor;
      const effects: ChatTurnEffect[] = [];
      if (current !== undefined) {
        const finalized = finalizeCurrentTurn(
          stateWithCursor,
          event.startedAtMs,
          'cancelled',
        );
        nextState = finalized.state;
        // Supersession goes directly from foreground to foreground.
        effects.push(
          ...finalized.effects.filter((effect) => effect.type !== 'chat.idle'),
        );
      }

      const newCurrent = turnFromStart(event);
      return {
        state: {
          ...nextState,
          phase: 'foreground',
          decisionPending: false,
          current: newCurrent,
        },
        effects: [
          ...effects,
          {
            type: 'timer.open',
            timerId: chatTurnTimerId(event.turnId),
            turnId: event.turnId,
            atMs: event.startedAtMs,
          },
        ],
      };
    }

    case 'TurnEnded': {
      if (stateWithCursor.current?.id !== event.turnId) {
        return { state: stateWithCursor, effects: [] };
      }
      return finalizeCurrentTurn(
        stateWithCursor,
        event.endedAtMs,
        event.outcome,
        event.durationMs,
        event.terminalReason,
      );
    }

    case 'SessionState': {
      const current = stateWithCursor.current;
      if (
        current === undefined ||
        (event.state !== 'requires_action' && event.state !== 'running') ||
        (event.observedDuringTurnId !== undefined &&
          event.observedDuringTurnId !== current.id)
      ) {
        return { state: stateWithCursor, effects: [] };
      }
      return {
        state: {
          ...stateWithCursor,
          decisionPending: event.state === 'requires_action',
        },
        effects: [],
      };
    }

    case 'BackgroundSet': {
      const background: ChatTurnBackground = {
        native: event.native
          .slice(0, MAX_TURN_COLLECTION_ITEMS)
          .map((task) => ({ ...task })),
        managed: { ...event.managed },
      };
      const hasBackground = hasBackgroundWork(background);
      const phase: ChatTurnPhase =
        stateWithCursor.current !== undefined
          ? 'foreground'
          : hasBackground
            ? 'background'
            : 'idle';
      const becameIdle =
        stateWithCursor.current === undefined &&
        stateWithCursor.phase === 'background' &&
        !hasBackground;
      return {
        state: { ...stateWithCursor, background, phase },
        effects: becameIdle ? [{ type: 'chat.idle' }] : [],
      };
    }
  }
}

export function reduceChatTurnHostEvent(
  state: ChatTurnState,
  event: ChatTurnHostPauseEvent,
): { state: ChatTurnState; effects: ChatTurnEffect[] } {
  const previousSequence = state.cursors.host;
  if (
    previousSequence !== undefined &&
    event.hostSequence <= previousSequence
  ) {
    return { state, effects: [] };
  }

  const stateWithCursor: ChatTurnState = {
    ...state,
    cursors: { ...state.cursors, host: event.hostSequence },
  };
  const current = stateWithCursor.current;
  if (current === undefined || current.id !== event.turnId) {
    return { state: stateWithCursor, effects: [] };
  }

  const timerId = chatTurnTimerId(current.id);
  if (event.type === 'PauseOpened') {
    if (current.pauses.length >= MAX_TURN_COLLECTION_ITEMS) {
      return { state: stateWithCursor, effects: [] };
    }
    const existingPause = current.pauses.some(
      (pause) =>
        pause.ownerKind === event.ownerKind &&
        pause.ownerId === event.ownerId &&
        // Re-observing a released interval must not reacquire its owner.
        // The same owner may still open a new interval at a later boundary.
        (pause.endedAtMs === undefined || pause.startedAtMs === event.atMs),
    );
    if (existingPause) {
      return { state: stateWithCursor, effects: [] };
    }

    const alreadyPaused = current.pauses.some(
      (pause) => pause.endedAtMs === undefined,
    );
    return {
      state: {
        ...stateWithCursor,
        current: {
          ...current,
          pauses: [
            ...current.pauses.map((pause) => ({ ...pause })),
            {
              ownerKind: event.ownerKind,
              ownerId: event.ownerId,
              startedAtMs: event.atMs,
            },
          ],
        },
      },
      effects: alreadyPaused
        ? []
        : [
            {
              type: 'timer.pause',
              timerId,
              turnId: current.id,
              atMs: event.atMs,
            },
          ],
    };
  }

  const openPauseIndex = current.pauses.findIndex(
    (pause) =>
      pause.endedAtMs === undefined &&
      pause.ownerKind === event.ownerKind &&
      pause.ownerId === event.ownerId,
  );
  if (openPauseIndex < 0) {
    return { state: stateWithCursor, effects: [] };
  }

  const openPause = current.pauses[openPauseIndex];
  if (openPause === undefined) {
    return { state: stateWithCursor, effects: [] };
  }
  const pauses = current.pauses.map((pause, index) =>
    index === openPauseIndex
      ? { ...pause, endedAtMs: Math.max(pause.startedAtMs, event.atMs) }
      : { ...pause },
  );
  const hasOpenPauses = pauses.some((pause) => pause.endedAtMs === undefined);
  return {
    state: { ...stateWithCursor, current: { ...current, pauses } },
    effects: hasOpenPauses
      ? []
      : [
          {
            type: 'timer.resume',
            timerId,
            turnId: current.id,
            atMs: event.atMs,
          },
        ],
  };
}

/**
 * Ends the turn an app restart orphaned. It is cancelled unless restart
 * cleanup found its answer saved and no work left open (CAN-7612), in which
 * case it completed. Either way its terminal reason records the restart.
 */
export function settleChatTurnForRestart(
  state: ChatTurnState,
  endedAtMs: number,
  outcome: Extract<ChatTurnOutcome, 'cancelled' | 'completed'> = 'cancelled',
): { state: ChatTurnState; effects: ChatTurnEffect[] } {
  if (state.current === undefined) {
    return { state, effects: [] };
  }
  return finalizeCurrentTurn(state, endedAtMs, outcome, undefined, 'restart');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isTurnOrigin(value: unknown): value is TurnOrigin {
  return (
    value === 'user' ||
    value === 'steer' ||
    value === 'autonomous' ||
    value === 'restart'
  );
}

function isChatTurnOutcome(value: unknown): value is ChatTurnOutcome {
  return value === 'completed' || value === 'cancelled' || value === 'failed';
}

function isPauseOwnerKind(value: unknown): value is ChatTurnPauseOwnerKind {
  return value === 'approval' || value === 'question';
}

function copyPause(pause: ChatTurnPause): ChatTurnPause {
  return {
    ownerKind: pause.ownerKind,
    ownerId: pause.ownerId,
    startedAtMs: pause.startedAtMs,
    ...(pause.endedAtMs === undefined ? {} : { endedAtMs: pause.endedAtMs }),
  };
}

function copySpawnedBy(spawnedBy: SpawnedBy): SpawnedBy {
  return {
    ...(spawnedBy.taskId === undefined ? {} : { taskId: spawnedBy.taskId }),
    ...(spawnedBy.toolUseId === undefined
      ? {}
      : { toolUseId: spawnedBy.toolUseId }),
    ...(spawnedBy.event === true ? { event: spawnedBy.event } : {}),
    ...(spawnedBy.scheduled === true ? { scheduled: spawnedBy.scheduled } : {}),
    ...(spawnedBy.toolsLoaded === true ? { toolsLoaded: true } : {}),
  };
}

function copyTurnRecord(record: ChatTurnRecord): ChatTurnRecord {
  const inputIds =
    record.inputIds === undefined
      ? undefined
      : mergeInputIds(record.inputIds, []);
  return {
    id: record.id,
    origin: record.origin,
    ...(record.userMessageId === undefined
      ? {}
      : { userMessageId: record.userMessageId }),
    ...(inputIds === undefined ? {} : { inputIds }),
    ...(record.spawnedBy === undefined
      ? {}
      : { spawnedBy: copySpawnedBy(record.spawnedBy) }),
    startedAtMs: record.startedAtMs,
    pauses: record.pauses.map(copyPause),
    ...(record.endedAtMs === undefined ? {} : { endedAtMs: record.endedAtMs }),
    ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
    ...(record.durationMs === undefined
      ? {}
      : { durationMs: record.durationMs }),
    ...(record.terminalReason === undefined
      ? {}
      : { terminalReason: record.terminalReason }),
  };
}

export function serializeChatTurnState(
  state: ChatTurnState,
): PersistedChatTurnState {
  return {
    phase: state.phase,
    decisionPending: state.decisionPending,
    catchingUp: state.catchingUp,
    ...(state.current === undefined
      ? {}
      : { current: copyTurnRecord(state.current) }),
    ...(state.lastEnded === undefined
      ? {}
      : { lastEnded: copyTurnRecord(state.lastEnded) }),
    endedTurnIds: [...state.endedTurnIds],
    background: {
      native: state.background.native.map((task) => ({
        id: task.id,
        ...(task.taskType === undefined ? {} : { taskType: task.taskType }),
        ...(task.toolUseId === undefined ? {} : { toolUseId: task.toolUseId }),
        ...(task.spawnedByTurnId === undefined
          ? {}
          : { spawnedByTurnId: task.spawnedByTurnId }),
      })),
      managed: {
        live: state.background.managed.live,
        queued: state.background.managed.queued,
      },
    },
  };
}

function parseSpawnedBy(value: unknown): SpawnedBy | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const taskId = value.taskId;
  const toolUseId = value.toolUseId;
  if (
    (taskId !== undefined && !isString(taskId)) ||
    (toolUseId !== undefined && !isString(toolUseId))
  ) {
    return undefined;
  }
  const event = value.event;
  const scheduled = value.scheduled;
  return {
    ...(taskId === undefined ? {} : { taskId }),
    ...(toolUseId === undefined ? {} : { toolUseId }),
    ...(event === true ? { event } : {}),
    ...(scheduled === true ? { scheduled } : {}),
    ...(value.toolsLoaded === true ? { toolsLoaded: true } : {}),
  };
}

function parseChatTurnPause(value: unknown): ChatTurnPause | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const endedAtMs = value.endedAtMs;
  if (
    !isPauseOwnerKind(value.ownerKind) ||
    !isString(value.ownerId) ||
    !isFiniteNumber(value.startedAtMs) ||
    (endedAtMs !== undefined &&
      (!isFiniteNumber(endedAtMs) || endedAtMs < value.startedAtMs))
  ) {
    return undefined;
  }
  return {
    ownerKind: value.ownerKind,
    ownerId: value.ownerId,
    startedAtMs: value.startedAtMs,
    ...(endedAtMs === undefined ? {} : { endedAtMs }),
  };
}

function parseChatTurnRecord(value: unknown): ChatTurnRecord | undefined {
  if (!isRecord(value) || !isUnknownArray(value.pauses)) {
    return undefined;
  }
  if (
    !isString(value.id) ||
    !isTurnOrigin(value.origin) ||
    !isFiniteNumber(value.startedAtMs) ||
    value.pauses.length > MAX_TURN_COLLECTION_ITEMS
  ) {
    return undefined;
  }

  const userMessageId = value.userMessageId;
  const inputIdsValue = value.inputIds;
  const spawnedByValue = value.spawnedBy;
  const endedAtMs = value.endedAtMs;
  const outcome = value.outcome;
  const durationMs = value.durationMs;
  const terminalReason = value.terminalReason;
  if (
    (userMessageId !== undefined && !isString(userMessageId)) ||
    (inputIdsValue !== undefined &&
      (!isUnknownArray(inputIdsValue) ||
        inputIdsValue.length > MAX_INPUT_IDS)) ||
    (spawnedByValue !== undefined && !isRecord(spawnedByValue)) ||
    (endedAtMs !== undefined && !isFiniteNumber(endedAtMs)) ||
    (outcome !== undefined && !isChatTurnOutcome(outcome)) ||
    (durationMs !== undefined && !isFiniteNumber(durationMs)) ||
    (terminalReason !== undefined && !isString(terminalReason))
  ) {
    return undefined;
  }

  let inputIds: string[] | undefined;
  if (inputIdsValue !== undefined) {
    const parsedInputIds: string[] = [];
    for (const inputId of inputIdsValue) {
      if (!isString(inputId)) {
        return undefined;
      }
      parsedInputIds.push(inputId);
    }
    inputIds = mergeInputIds(parsedInputIds, []);
  }

  let spawnedBy: SpawnedBy | undefined;
  if (spawnedByValue !== undefined) {
    spawnedBy = parseSpawnedBy(spawnedByValue);
    if (spawnedBy === undefined) {
      return undefined;
    }
  }

  const pauses: ChatTurnPause[] = [];
  for (const pauseValue of value.pauses) {
    const pause = parseChatTurnPause(pauseValue);
    if (pause === undefined) {
      return undefined;
    }
    pauses.push(pause);
  }
  const openOwners = new Map<ChatTurnPauseOwnerKind, Set<string>>();
  for (const pause of pauses) {
    if (pause.endedAtMs !== undefined) continue;
    const owners = openOwners.get(pause.ownerKind) ?? new Set<string>();
    if (owners.has(pause.ownerId)) return undefined;
    owners.add(pause.ownerId);
    openOwners.set(pause.ownerKind, owners);
  }

  return {
    id: value.id,
    origin: value.origin,
    ...(userMessageId === undefined ? {} : { userMessageId }),
    ...(inputIds === undefined ? {} : { inputIds }),
    ...(spawnedBy === undefined ? {} : { spawnedBy }),
    startedAtMs: value.startedAtMs,
    pauses,
    ...(endedAtMs === undefined ? {} : { endedAtMs }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(terminalReason === undefined ? {} : { terminalReason }),
  };
}

function parseChatTurnBackground(
  value: unknown,
): ChatTurnBackground | undefined {
  if (
    !isRecord(value) ||
    !isUnknownArray(value.native) ||
    !isRecord(value.managed) ||
    value.native.length > MAX_TURN_COLLECTION_ITEMS
  ) {
    return undefined;
  }
  const live = value.managed.live;
  const queued = value.managed.queued;
  if (
    typeof live !== 'number' ||
    !Number.isSafeInteger(live) ||
    live < 0 ||
    typeof queued !== 'number' ||
    !Number.isSafeInteger(queued) ||
    queued < 0
  ) {
    return undefined;
  }

  const native: Array<ChatTurnBackground['native'][number]> = [];
  for (const taskValue of value.native) {
    if (!isRecord(taskValue)) {
      return undefined;
    }
    const taskType = taskValue.taskType;
    const toolUseId = taskValue.toolUseId;
    const spawnedByTurnId = taskValue.spawnedByTurnId;
    if (
      !isString(taskValue.id) ||
      (taskType !== undefined && !isString(taskType)) ||
      (toolUseId !== undefined && !isString(toolUseId)) ||
      (spawnedByTurnId !== undefined && !isString(spawnedByTurnId))
    ) {
      return undefined;
    }
    native.push({
      id: taskValue.id,
      ...(taskType === undefined ? {} : { taskType }),
      ...(toolUseId === undefined ? {} : { toolUseId }),
      ...(spawnedByTurnId === undefined ? {} : { spawnedByTurnId }),
    });
  }
  return { native, managed: { live, queued } };
}

export function hydrateChatTurnState(
  value: unknown,
): ChatTurnState | undefined {
  if (
    !isRecord(value) ||
    (value.phase !== 'foreground' &&
      value.phase !== 'background' &&
      value.phase !== 'idle') ||
    typeof value.decisionPending !== 'boolean' ||
    typeof value.catchingUp !== 'boolean' ||
    !isUnknownArray(value.endedTurnIds) ||
    value.endedTurnIds.length > MAX_ENDED_TURN_IDS
  ) {
    return undefined;
  }

  const endedTurnIds: string[] = [];
  for (const id of value.endedTurnIds) {
    if (!isString(id)) {
      return undefined;
    }
    endedTurnIds.push(id);
  }

  const background = parseChatTurnBackground(value.background);
  if (background === undefined) {
    return undefined;
  }

  let current: ChatTurnRecord | undefined;
  if (value.current !== undefined) {
    current = parseChatTurnRecord(value.current);
    if (current === undefined) {
      return undefined;
    }
  }

  let lastEnded: ChatTurnRecord | undefined;
  if (value.lastEnded !== undefined) {
    lastEnded = parseChatTurnRecord(value.lastEnded);
    if (lastEnded === undefined) {
      return undefined;
    }
  }

  if (new Set(endedTurnIds).size !== endedTurnIds.length) {
    return undefined;
  }
  if (
    current !== undefined &&
    (current.endedAtMs !== undefined ||
      current.outcome !== undefined ||
      current.durationMs !== undefined ||
      current.terminalReason !== undefined ||
      endedTurnIds.includes(current.id))
  ) {
    return undefined;
  }
  if (
    lastEnded !== undefined &&
    (lastEnded.endedAtMs === undefined ||
      lastEnded.outcome === undefined ||
      lastEnded.durationMs === undefined ||
      lastEnded.pauses.some((pause) => pause.endedAtMs === undefined))
  ) {
    return undefined;
  }
  const expectedPhase: ChatTurnPhase =
    current !== undefined
      ? 'foreground'
      : hasBackgroundWork(background)
        ? 'background'
        : 'idle';
  if (
    value.phase !== expectedPhase ||
    (current === undefined && value.decisionPending)
  ) {
    return undefined;
  }

  return {
    phase: value.phase,
    decisionPending: value.decisionPending,
    catchingUp: value.catchingUp,
    ...(current === undefined ? {} : { current }),
    ...(lastEnded === undefined ? {} : { lastEnded }),
    endedTurnIds,
    background,
    cursors: {},
  };
}

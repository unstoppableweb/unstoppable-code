import { randomUUID } from 'node:crypto';

export type CodexNativeBackgroundWork =
  | {
      kind: 'child';
      id: string;
      threadId: string;
      parentThreadId: string;
      turnId?: string;
      spawnedByTurnId?: string;
      toolUseId?: string;
    }
  | {
      kind: 'terminal';
      id: string;
      threadId: string;
      itemId: string;
      processId: string;
      spawnedByTurnId?: string;
      /**
       * Codex gives every command a processId at start, so a running command
       * is foreground while the turn that started it is still open. It turns
       * background when that turn completes or Codex lists it as a background
       * terminal.
       */
      foreground?: true;
    };

export interface CodexBackgroundSnapshot {
  epoch: string;
  revision: number;
  rootThreadId: string;
  work: readonly CodexNativeBackgroundWork[];
  reconciling: boolean;
}

export interface CodexBackgroundTerminalRecord {
  threadId: string;
  itemId: string;
  processId: string;
}

export interface CodexBackgroundReconciliationToken {
  readonly epoch: string;
  readonly threadId: string;
  readonly sequence: number;
}

export interface CodexBackgroundWorkRegistry {
  observe(method: string, params: unknown): void;
  snapshot(): CodexBackgroundSnapshot;
  hasLiveWork(): boolean;
  beginReconciliation(threadId: string): CodexBackgroundReconciliationToken;
  commitTerminalPages(
    token: CodexBackgroundReconciliationToken,
    records: readonly CodexBackgroundTerminalRecord[],
  ): boolean;
  failReconciliation(token: CodexBackgroundReconciliationToken): void;
  retireEpoch(): void;
  subscribe(listener: (snapshot: CodexBackgroundSnapshot) => void): () => void;
}

interface ChildWorkEntry {
  work: Extract<CodexNativeBackgroundWork, { kind: 'child' }>;
}

interface TerminalWorkEntry {
  work: Extract<CodexNativeBackgroundWork, { kind: 'terminal' }>;
}

interface CommandItemMemory {
  threadId: string;
  itemId: string;
  turnId?: string;
}

type TerminalObservation =
  | {
      kind: 'start';
      threadId: string;
      itemId: string;
      processId: string;
      spawnedByTurnId?: string;
    }
  | {
      kind: 'end';
      threadId: string;
      itemId: string;
      processId?: string;
    };

interface PendingReconciliation {
  token: CodexBackgroundReconciliationToken;
  observations: TerminalObservation[];
}

const COMPLETED_HISTORY_LIMIT = 256;
const CHILD_LIFECYCLE_EVIDENCE_LIMIT = 256;
const COMMAND_ITEM_MEMORY_LIMIT = 4_096;
const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 1_000;

export function encodeCodexBackgroundWorkId(parts: readonly string[]): string {
  return JSON.stringify(parts) ?? '[]';
}

export function createCodexBackgroundWorkRegistry(options: {
  rootThreadId: () => string | undefined;
  newEpoch?: () => string;
}): CodexBackgroundWorkRegistry {
  const readRootThreadId = (): string => {
    try {
      const threadId = options.rootThreadId();
      return typeof threadId === 'string' ? threadId : '';
    } catch {
      return '';
    }
  };

  const createEpoch = (): string => {
    try {
      const epoch = options.newEpoch?.();
      return typeof epoch === 'string' && epoch.length > 0
        ? epoch
        : randomUUID();
    } catch {
      return randomUUID();
    }
  };

  let epoch = createEpoch();
  let revision = 0;
  let rootThreadId = readRootThreadId();
  let nextTokenSequence = 0;
  let epochSequence = 0;

  const children = new Map<string, ChildWorkEntry>();
  const childHistory = new Map<
    string,
    Extract<CodexNativeBackgroundWork, { kind: 'child' }>
  >();
  const childLifecycleEvidence = new Map<string, 'live' | 'ended'>();
  const terminals = new Map<string, TerminalWorkEntry>();
  const completedHistory = new Map<string, true>();
  const completedTurns = new Map<string, true>();
  const commandItemMemory = new Map<string, CommandItemMemory>();
  const reconciliations = new Map<string, PendingReconciliation>();
  const listeners = new Set<(snapshot: CodexBackgroundSnapshot) => void>();

  const terminalCompletionKey = (threadId: string, itemId: string): string =>
    encodeCodexBackgroundWorkId(['completed-terminal', threadId, itemId]);

  const commandItemMemoryKey = (threadId: string, itemId: string): string =>
    encodeCodexBackgroundWorkId(['command-item', threadId, itemId]);

  const completedTurnKey = (threadId: string, turnId: string): string =>
    encodeCodexBackgroundWorkId(['completed-turn', threadId, turnId]);

  const rememberCompletedTurn = (key: string): void => {
    completedTurns.delete(key);
    completedTurns.set(key, true);
    while (completedTurns.size > COMPLETED_HISTORY_LIMIT) {
      const oldest = completedTurns.keys().next();
      if (oldest.done) {
        break;
      }
      completedTurns.delete(oldest.value);
    }
  };

  const rememberCompleted = (key: string): void => {
    completedHistory.delete(key);
    completedHistory.set(key, true);
    while (completedHistory.size > COMPLETED_HISTORY_LIMIT) {
      const oldest = completedHistory.keys().next();
      if (oldest.done) {
        break;
      }
      completedHistory.delete(oldest.value);
    }
  };

  const rememberChildLifecycle = (
    threadId: string,
    state: 'live' | 'ended',
  ): void => {
    childLifecycleEvidence.delete(threadId);
    childLifecycleEvidence.set(threadId, state);
    while (childLifecycleEvidence.size > CHILD_LIFECYCLE_EVIDENCE_LIMIT) {
      const oldest = childLifecycleEvidence.keys().next();
      if (oldest.done) {
        break;
      }
      childLifecycleEvidence.delete(oldest.value);
    }
  };

  const rememberCommandItem = (
    threadId: string,
    itemId: string,
    turnId: string | undefined,
  ): void => {
    const key = commandItemMemoryKey(threadId, itemId);
    const previous = commandItemMemory.get(key);
    commandItemMemory.delete(key);
    commandItemMemory.set(key, {
      threadId,
      itemId,
      ...((turnId ?? previous?.turnId)
        ? { turnId: turnId ?? previous?.turnId }
        : {}),
    });
    while (commandItemMemory.size > COMMAND_ITEM_MEMORY_LIMIT) {
      const oldest = commandItemMemory.keys().next();
      if (oldest.done) {
        break;
      }
      commandItemMemory.delete(oldest.value);
    }
  };

  const readCommandItemTurnId = (
    threadId: string,
    itemId: string,
  ): string | undefined => {
    const key = commandItemMemoryKey(threadId, itemId);
    const memory = commandItemMemory.get(key);
    if (!memory) return undefined;
    commandItemMemory.delete(key);
    commandItemMemory.set(key, memory);
    return memory.turnId;
  };

  const rememberChildCompletion = (
    work: Extract<CodexNativeBackgroundWork, { kind: 'child' }>,
  ): void => {
    childHistory.delete(work.threadId);
    childHistory.set(work.threadId, { ...work });
    while (childHistory.size > COMPLETED_HISTORY_LIMIT) {
      const oldest = childHistory.keys().next();
      if (oldest.done) {
        break;
      }
      childHistory.delete(oldest.value);
    }
  };

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const readString = (
    record: Record<string, unknown>,
    key: string,
  ): string | undefined => {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  const readEitherString = (
    record: Record<string, unknown>,
    camelCaseKey: string,
    snakeCaseKey: string,
  ): string | undefined =>
    readString(record, camelCaseKey) ?? readString(record, snakeCaseKey);

  const normalizeType = (value: string | undefined): string =>
    value?.replace(/[_-]/g, '').toLowerCase() ?? '';

  const sameChildWork = (
    left: Extract<CodexNativeBackgroundWork, { kind: 'child' }>,
    right: Extract<CodexNativeBackgroundWork, { kind: 'child' }>,
  ): boolean =>
    left.id === right.id &&
    left.threadId === right.threadId &&
    left.parentThreadId === right.parentThreadId &&
    left.turnId === right.turnId &&
    left.spawnedByTurnId === right.spawnedByTurnId &&
    left.toolUseId === right.toolUseId;

  const sameTerminalWork = (
    left: Extract<CodexNativeBackgroundWork, { kind: 'terminal' }>,
    right: Extract<CodexNativeBackgroundWork, { kind: 'terminal' }>,
  ): boolean =>
    left.id === right.id &&
    left.threadId === right.threadId &&
    left.itemId === right.itemId &&
    left.processId === right.processId &&
    left.spawnedByTurnId === right.spawnedByTurnId &&
    left.foreground === right.foreground;

  const makeSnapshot = (): CodexBackgroundSnapshot => {
    const work: CodexNativeBackgroundWork[] = [
      ...Array.from(children.values(), (entry) => ({ ...entry.work })),
      ...Array.from(terminals.values(), (entry) => ({ ...entry.work })),
    ];
    work.sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    return {
      epoch,
      revision,
      rootThreadId,
      work,
      reconciling: reconciliations.size > 0,
    };
  };

  const notifyListeners = (): void => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(makeSnapshot());
      } catch {
        // Observers must never influence provider state or one another.
      }
    }
  };

  const commitVisibleChange = (): void => {
    revision += 1;
    notifyListeners();
  };

  const syncRootThreadId = (): boolean => {
    const nextRootThreadId = readRootThreadId();
    if (nextRootThreadId === rootThreadId) {
      return false;
    }
    rootThreadId = nextRootThreadId;
    return true;
  };

  const removeChild = (threadId: string): boolean => {
    const entry = children.get(threadId);
    if (!entry) {
      return false;
    }
    children.delete(threadId);
    rememberChildCompletion(entry.work);
    return true;
  };

  const isKnownParentThread = (threadId: string): boolean =>
    threadId === rootThreadId ||
    children.has(threadId) ||
    childHistory.has(threadId);

  const makeChildWork = (
    threadId: string,
    parentThreadId: string,
    details: {
      turnId?: string;
      spawnedByTurnId?: string;
      toolUseId?: string;
    } = {},
  ): Extract<CodexNativeBackgroundWork, { kind: 'child' }> => {
    const previous = children.get(threadId)?.work;
    const historical = childHistory.get(threadId);
    return {
      kind: 'child',
      id: encodeCodexBackgroundWorkId(['child', threadId]),
      threadId,
      parentThreadId,
      ...((details.turnId ?? previous?.turnId ?? historical?.turnId)
        ? {
            turnId: details.turnId ?? previous?.turnId ?? historical?.turnId,
          }
        : {}),
      ...((details.spawnedByTurnId ??
      previous?.spawnedByTurnId ??
      historical?.spawnedByTurnId)
        ? {
            spawnedByTurnId:
              details.spawnedByTurnId ??
              previous?.spawnedByTurnId ??
              historical?.spawnedByTurnId,
          }
        : {}),
      ...((details.toolUseId ?? previous?.toolUseId ?? historical?.toolUseId)
        ? {
            toolUseId:
              details.toolUseId ?? previous?.toolUseId ?? historical?.toolUseId,
          }
        : {}),
    };
  };

  const setChild = (
    threadId: string,
    parentThreadId: string,
    details: {
      turnId?: string;
      spawnedByTurnId?: string;
      toolUseId?: string;
    } = {},
  ): boolean => {
    if (
      !threadId ||
      !parentThreadId ||
      threadId === rootThreadId ||
      !isKnownParentThread(parentThreadId)
    ) {
      return false;
    }
    const previous = children.get(threadId)?.work;
    const nextWork = makeChildWork(threadId, parentThreadId, details);
    if (previous && sameChildWork(previous, nextWork)) {
      return false;
    }
    children.set(threadId, { work: nextWork });
    childHistory.delete(threadId);
    return true;
  };

  const setSpawnedChild = (
    threadId: string,
    parentThreadId: string,
    details: {
      turnId?: string;
      spawnedByTurnId?: string;
      toolUseId?: string;
    } = {},
  ): boolean => {
    if (
      !threadId ||
      !parentThreadId ||
      threadId === rootThreadId ||
      !isKnownParentThread(parentThreadId)
    ) {
      return false;
    }
    if (childLifecycleEvidence.get(threadId) === 'ended') {
      rememberChildLifecycle(threadId, 'ended');
      rememberChildCompletion(makeChildWork(threadId, parentThreadId, details));
      return false;
    }
    if (
      !children.has(threadId) &&
      childHistory.has(threadId) &&
      childLifecycleEvidence.get(threadId) !== 'live'
    ) {
      return false;
    }
    const changed = setChild(threadId, parentThreadId, details);
    if (changed || children.has(threadId)) {
      rememberChildLifecycle(threadId, 'live');
    }
    return changed;
  };

  const makeTerminalWork = (
    threadId: string,
    itemId: string,
    processId: string,
    spawnedByTurnId?: string,
  ): Extract<CodexNativeBackgroundWork, { kind: 'terminal' }> => ({
    kind: 'terminal',
    id: encodeCodexBackgroundWorkId(['terminal', threadId, itemId, processId]),
    threadId,
    itemId,
    processId,
    ...(spawnedByTurnId ? { spawnedByTurnId } : {}),
  });

  const applyTerminalStart = (
    observation: Extract<TerminalObservation, { kind: 'start' }>,
    respectCompletedHistory: boolean,
  ): boolean => {
    const completionKey = terminalCompletionKey(
      observation.threadId,
      observation.itemId,
    );
    if (respectCompletedHistory && completedHistory.has(completionKey)) {
      return false;
    }
    const work = makeTerminalWork(
      observation.threadId,
      observation.itemId,
      observation.processId,
      observation.spawnedByTurnId,
    );
    const previous = terminals.get(work.id)?.work;
    if (previous && previous.spawnedByTurnId === work.spawnedByTurnId) {
      return false;
    }
    const turnOpen =
      work.spawnedByTurnId !== undefined &&
      !completedTurns.has(
        completedTurnKey(work.threadId, work.spawnedByTurnId),
      );
    if (previous ? previous.foreground : turnOpen) {
      work.foreground = true;
    }
    terminals.set(work.id, { work });
    return true;
  };

  const observeTerminalTurnCompleted = (
    params: Record<string, unknown>,
  ): boolean => {
    const threadId = readEitherString(params, 'threadId', 'thread_id');
    const turn = isRecord(params.turn) ? params.turn : undefined;
    const turnId =
      readString(turn ?? {}, 'id') ??
      readEitherString(params, 'turnId', 'turn_id');
    if (!threadId || !turnId) {
      return false;
    }
    rememberCompletedTurn(completedTurnKey(threadId, turnId));
    let changed = false;
    terminals.forEach((entry: TerminalWorkEntry) => {
      if (
        entry.work.foreground &&
        entry.work.threadId === threadId &&
        entry.work.spawnedByTurnId === turnId
      ) {
        delete entry.work.foreground;
        changed = true;
      }
    });
    return changed;
  };

  const applyTerminalEnd = (
    observation: Extract<TerminalObservation, { kind: 'end' }>,
  ): boolean => {
    let changed = false;
    terminals.forEach((entry: TerminalWorkEntry, id: string) => {
      if (
        entry.work.threadId === observation.threadId &&
        entry.work.itemId === observation.itemId &&
        (!observation.processId ||
          entry.work.processId === observation.processId)
      ) {
        terminals.delete(id);
        changed = true;
      }
    });
    rememberCompleted(
      terminalCompletionKey(observation.threadId, observation.itemId),
    );
    return changed;
  };

  const applyTerminalObservation = (
    observation: TerminalObservation,
    replaying: boolean,
  ): boolean =>
    observation.kind === 'start'
      ? applyTerminalStart(observation, !replaying)
      : applyTerminalEnd(observation);

  const appendAndApplyTerminalObservation = (
    observation: TerminalObservation,
  ): boolean => {
    if (
      observation.kind === 'start' &&
      completedHistory.has(
        terminalCompletionKey(observation.threadId, observation.itemId),
      )
    ) {
      // A delayed duplicate start is not a live edge. Do not let replay
      // resurrect it after the live observation already rejected it.
      return false;
    }
    const pending = reconciliations.get(observation.threadId);
    if (pending) {
      pending.observations.push(observation);
    }
    return applyTerminalObservation(observation, false);
  };

  const readThreadParentId = (
    thread: Record<string, unknown>,
  ): string | undefined => {
    const source = isRecord(thread.source) ? thread.source : undefined;
    const subAgent = source
      ? isRecord(source.subAgent)
        ? source.subAgent
        : isRecord(source.subagent)
          ? source.subagent
          : undefined
      : undefined;
    if (subAgent) {
      const directParent = readEitherString(
        subAgent,
        'parentThreadId',
        'parent_thread_id',
      );
      if (directParent) {
        return directParent;
      }
      const threadSpawn = isRecord(subAgent.thread_spawn)
        ? subAgent.thread_spawn
        : isRecord(subAgent.threadSpawn)
          ? subAgent.threadSpawn
          : undefined;
      if (threadSpawn) {
        const nestedParent = readEitherString(
          threadSpawn,
          'parentThreadId',
          'parent_thread_id',
        );
        if (nestedParent) {
          return nestedParent;
        }
      }
    }

    // Retain compatibility with older protocol fixtures that placed the field
    // directly on Thread, while preferring the app-server source metadata.
    return readEitherString(thread, 'parentThreadId', 'parent_thread_id');
  };

  const observeThreadStarted = (params: Record<string, unknown>): boolean => {
    const thread = isRecord(params.thread) ? params.thread : undefined;
    if (!thread) {
      return false;
    }
    const threadId = readString(thread, 'id');
    if (!threadId || threadId === rootThreadId) {
      return false;
    }
    const status = isRecord(thread.status) ? thread.status : undefined;
    if (readString(status ?? {}, 'type') === 'idle') {
      rememberChildLifecycle(threadId, 'ended');
      return removeChild(threadId);
    }
    rememberChildLifecycle(threadId, 'live');
    const parentThreadId = readThreadParentId(thread);
    if (!parentThreadId || !isKnownParentThread(parentThreadId)) {
      return false;
    }
    return setChild(threadId, parentThreadId);
  };

  const readStringArray = (
    record: Record<string, unknown>,
    key: string,
    snakeCaseKey: string,
  ): string[] => {
    const value = record[key] ?? record[snakeCaseKey];
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
  };

  const observeSpawnItem = (
    item: Record<string, unknown>,
    parentThreadId: string | undefined,
    spawnedByTurnId: string | undefined,
  ): boolean => {
    if (!parentThreadId) {
      return false;
    }
    const itemType = normalizeType(readString(item, 'type'));
    const itemId = readString(item, 'id');
    let changed = false;
    if (itemType === 'subagentactivity') {
      const childThreadId = readEitherString(
        item,
        'agentThreadId',
        'agent_thread_id',
      );
      return childThreadId
        ? setSpawnedChild(childThreadId, parentThreadId, { spawnedByTurnId })
        : false;
    }
    if (
      itemType !== 'collabagenttoolcall' ||
      normalizeType(readString(item, 'tool')) !== 'spawnagent'
    ) {
      return false;
    }
    for (const childThreadId of readStringArray(
      item,
      'receiverThreadIds',
      'receiver_thread_ids',
    )) {
      changed =
        setSpawnedChild(childThreadId, parentThreadId, {
          spawnedByTurnId,
          ...(itemId ? { toolUseId: itemId } : {}),
        }) || changed;
    }
    return changed;
  };

  const observeItemStarted = (params: Record<string, unknown>): boolean => {
    const item = isRecord(params.item) ? params.item : undefined;
    if (!item) {
      return false;
    }
    const threadId = readEitherString(params, 'threadId', 'thread_id');
    const turnId = readEitherString(params, 'turnId', 'turn_id');
    let changed = observeSpawnItem(item, threadId, turnId);

    if (normalizeType(readString(item, 'type')) !== 'commandexecution') {
      return changed;
    }
    const itemId = readString(item, 'id');
    if (threadId && itemId) {
      rememberCommandItem(threadId, itemId, turnId);
    }
    const processId = readEitherString(item, 'processId', 'process_id');
    const itemStatus = normalizeType(readString(item, 'status'));
    const isKnownTerminalStatus =
      itemStatus === 'completed' ||
      itemStatus === 'failed' ||
      itemStatus === 'declined' ||
      itemStatus === 'interrupted';
    if (!threadId || !itemId || !processId || isKnownTerminalStatus) {
      return changed;
    }
    changed =
      appendAndApplyTerminalObservation({
        kind: 'start',
        threadId,
        itemId,
        processId,
        ...(turnId ? { spawnedByTurnId: turnId } : {}),
      }) || changed;
    return changed;
  };

  const observeItemCompleted = (params: Record<string, unknown>): boolean => {
    const item = isRecord(params.item) ? params.item : undefined;
    if (!item) {
      return false;
    }
    const threadId = readEitherString(params, 'threadId', 'thread_id');
    const turnId = readEitherString(params, 'turnId', 'turn_id');
    let changed = observeSpawnItem(item, threadId, turnId);
    const itemType = normalizeType(readString(item, 'type'));
    if (itemType === 'subagentactivity') {
      const activityKind = normalizeType(readString(item, 'kind'));
      const childThreadId = readEitherString(
        item,
        'agentThreadId',
        'agent_thread_id',
      );
      if (activityKind === 'completed' && childThreadId) {
        rememberChildLifecycle(childThreadId, 'ended');
        changed = removeChild(childThreadId) || changed;
      }
      return changed;
    }
    if (itemType !== 'commandexecution') {
      return changed;
    }
    const itemId = readString(item, 'id');
    if (!threadId || !itemId) {
      return changed;
    }
    const processId = readEitherString(item, 'processId', 'process_id');
    changed =
      appendAndApplyTerminalObservation({
        kind: 'end',
        threadId,
        itemId,
        ...(processId ? { processId } : {}),
      }) || changed;
    return changed;
  };

  const observeChildTurnStarted = (
    params: Record<string, unknown>,
  ): boolean => {
    const threadId = readEitherString(params, 'threadId', 'thread_id');
    const turn = isRecord(params.turn) ? params.turn : undefined;
    const turnId =
      readString(turn ?? {}, 'id') ??
      readEitherString(params, 'turnId', 'turn_id');
    if (!threadId || !turnId || threadId === rootThreadId) {
      return false;
    }
    rememberChildLifecycle(threadId, 'live');
    const current = children.get(threadId)?.work;
    const historical = childHistory.get(threadId);
    const previous = current ?? historical;
    return previous
      ? setChild(threadId, previous.parentThreadId, {
          turnId,
          ...(previous.spawnedByTurnId
            ? { spawnedByTurnId: previous.spawnedByTurnId }
            : {}),
          ...(previous.toolUseId ? { toolUseId: previous.toolUseId } : {}),
        })
      : false;
  };

  const observeChildTurnCompleted = (
    params: Record<string, unknown>,
  ): boolean => {
    const threadId = readEitherString(params, 'threadId', 'thread_id');
    const turn = isRecord(params.turn) ? params.turn : undefined;
    const turnId =
      readString(turn ?? {}, 'id') ??
      readEitherString(params, 'turnId', 'turn_id');
    if (!threadId || !turnId || threadId === rootThreadId) {
      return false;
    }
    const current = children.get(threadId)?.work;
    if (current) {
      if (current.turnId !== undefined && current.turnId !== turnId) {
        return false;
      }
      rememberChildLifecycle(threadId, 'ended');
      return removeChild(threadId);
    }
    const historical = childHistory.get(threadId);
    if (historical?.turnId && historical.turnId !== turnId) {
      return false;
    }
    rememberChildLifecycle(threadId, 'ended');
    return false;
  };

  const observeThreadStatusChanged = (
    params: Record<string, unknown>,
  ): boolean => {
    const threadId = readEitherString(params, 'threadId', 'thread_id');
    const status = isRecord(params.status) ? params.status : undefined;
    if (!threadId || !status || threadId === rootThreadId) {
      return false;
    }
    const statusType = normalizeType(readString(status, 'type'));
    if (statusType === 'idle') {
      rememberChildLifecycle(threadId, 'ended');
      return removeChild(threadId);
    }
    if (statusType !== 'active') {
      return false;
    }
    rememberChildLifecycle(threadId, 'live');
    if (children.has(threadId)) return false;
    const historical = childHistory.get(threadId);
    if (!historical) {
      return false;
    }
    return setChild(threadId, historical.parentThreadId, {
      ...(historical.turnId ? { turnId: historical.turnId } : {}),
      ...(historical.spawnedByTurnId
        ? { spawnedByTurnId: historical.spawnedByTurnId }
        : {}),
      ...(historical.toolUseId ? { toolUseId: historical.toolUseId } : {}),
    });
  };

  const isCurrentToken = (
    token: CodexBackgroundReconciliationToken,
  ): boolean => {
    const tokenValue: unknown = token;
    if (!isRecord(tokenValue)) {
      return false;
    }
    const tokenEpoch = readString(tokenValue, 'epoch');
    const threadId = readString(tokenValue, 'threadId');
    const sequence = tokenValue.sequence;
    if (
      !tokenEpoch ||
      !threadId ||
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      tokenEpoch !== epoch
    ) {
      return false;
    }
    const pending = reconciliations.get(threadId);
    return pending?.token.sequence === sequence;
  };

  const validateTerminalRecords = (
    token: CodexBackgroundReconciliationToken,
    records: readonly CodexBackgroundTerminalRecord[],
  ): CodexBackgroundTerminalRecord[] => {
    if (!Array.isArray(records)) {
      throw new Error('Codex background terminal records must be an array');
    }
    const validated: CodexBackgroundTerminalRecord[] = [];
    for (const recordValue of records) {
      const value: unknown = recordValue;
      if (!isRecord(value)) {
        throw new Error('Codex background terminal record is malformed');
      }
      const threadId = readString(value, 'threadId');
      const itemId = readString(value, 'itemId');
      const processId = readString(value, 'processId');
      if (!threadId || threadId !== token.threadId || !itemId || !processId) {
        throw new Error('Codex background terminal record is malformed');
      }
      validated.push({ threadId, itemId, processId });
    }
    return validated;
  };

  const registry: CodexBackgroundWorkRegistry = {
    observe(method: string, params: unknown): void {
      const rootChanged = syncRootThreadId();
      if (!isRecord(params)) {
        if (rootChanged) {
          commitVisibleChange();
        }
        return;
      }

      let changed = false;
      switch (method) {
        case 'thread/started':
          changed = observeThreadStarted(params);
          break;
        case 'thread/status/changed':
          changed = observeThreadStatusChanged(params);
          break;
        case 'turn/started':
          changed = observeChildTurnStarted(params);
          break;
        case 'turn/completed':
          changed = observeChildTurnCompleted(params);
          changed = observeTerminalTurnCompleted(params) || changed;
          break;
        case 'item/started':
          changed = observeItemStarted(params);
          break;
        case 'item/completed':
          changed = observeItemCompleted(params);
          break;
        default:
          break;
      }
      if (rootChanged || changed) {
        commitVisibleChange();
      }
    },

    snapshot(): CodexBackgroundSnapshot {
      if (syncRootThreadId()) {
        commitVisibleChange();
      }
      return makeSnapshot();
    },

    hasLiveWork(): boolean {
      return (
        children.size > 0 || terminals.size > 0 || reconciliations.size > 0
      );
    },

    beginReconciliation(threadId: string): CodexBackgroundReconciliationToken {
      if (threadId.length === 0) {
        throw new Error('Codex background reconciliation requires a thread id');
      }
      const rootChanged = syncRootThreadId();
      const wasReconciling = reconciliations.size > 0;
      nextTokenSequence += 1;
      const token: CodexBackgroundReconciliationToken = Object.freeze({
        epoch,
        threadId,
        sequence: nextTokenSequence,
      });
      reconciliations.set(threadId, {
        token,
        observations: [],
      });
      if (rootChanged || !wasReconciling) {
        commitVisibleChange();
      }
      return token;
    },

    commitTerminalPages(
      token: CodexBackgroundReconciliationToken,
      records: readonly CodexBackgroundTerminalRecord[],
    ): boolean {
      const rootChanged = syncRootThreadId();
      if (!isCurrentToken(token)) {
        if (rootChanged) {
          commitVisibleChange();
        }
        return false;
      }
      const validated = validateTerminalRecords(token, records);
      const pending = reconciliations.get(token.threadId);
      if (!pending) {
        if (rootChanged) {
          commitVisibleChange();
        }
        return false;
      }

      const beforeReconciling = reconciliations.size > 0;
      reconciliations.delete(token.threadId);
      const previousTerminals = new Map(terminals);
      const previousThreadTerminals = new Map(
        Array.from(terminals).filter(
          ([, entry]) => entry.work.threadId === token.threadId,
        ),
      );
      previousThreadTerminals.forEach(
        (_entry: TerminalWorkEntry, id: string) => {
          terminals.delete(id);
        },
      );
      for (const record of validated) {
        const work = makeTerminalWork(
          record.threadId,
          record.itemId,
          record.processId,
          readCommandItemTurnId(record.threadId, record.itemId),
        );
        const prior = previousThreadTerminals.get(work.id);
        if (prior?.work.foreground) {
          // Codex lists only terminals that outlived their command call, so a
          // listed terminal is background even if its start was foreground.
          const listed = { ...prior.work };
          delete listed.foreground;
          terminals.set(work.id, { work: listed });
        } else {
          terminals.set(work.id, prior ?? { work });
        }
      }
      for (const observation of pending.observations) {
        applyTerminalObservation(observation, true);
      }
      const workChanged =
        previousTerminals.size !== terminals.size ||
        Array.from(previousTerminals).some(([id, entry]) => {
          const current = terminals.get(id)?.work;
          return !current || !sameTerminalWork(entry.work, current);
        });
      const afterReconciling = reconciliations.size > 0;
      if (
        rootChanged ||
        workChanged ||
        beforeReconciling !== afterReconciling
      ) {
        commitVisibleChange();
      }
      return true;
    },

    failReconciliation(token: CodexBackgroundReconciliationToken): void {
      const rootChanged = syncRootThreadId();
      if (!isCurrentToken(token)) {
        if (rootChanged) {
          commitVisibleChange();
        }
        return;
      }
      const wasReconciling = reconciliations.size > 0;
      reconciliations.delete(token.threadId);
      if (rootChanged || (wasReconciling && reconciliations.size === 0)) {
        commitVisibleChange();
      }
    },

    retireEpoch(): void {
      const rootChanged = syncRootThreadId();
      const previousEpoch = epoch;
      epochSequence += 1;
      const candidate = createEpoch();
      epoch =
        candidate === previousEpoch
          ? `${candidate}:${epochSequence}`
          : candidate;
      const hadState =
        children.size > 0 ||
        childHistory.size > 0 ||
        childLifecycleEvidence.size > 0 ||
        terminals.size > 0 ||
        completedHistory.size > 0 ||
        completedTurns.size > 0 ||
        commandItemMemory.size > 0 ||
        reconciliations.size > 0;
      children.clear();
      childHistory.clear();
      childLifecycleEvidence.clear();
      terminals.clear();
      completedHistory.clear();
      completedTurns.clear();
      commandItemMemory.clear();
      reconciliations.clear();
      if (rootChanged || hadState || epoch !== previousEpoch) {
        commitVisibleChange();
      }
    },

    subscribe(
      listener: (snapshot: CodexBackgroundSnapshot) => void,
    ): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };

  return registry;
}

export async function readAllCodexBackgroundTerminalPages(
  request: (params: {
    threadId: string;
    cursor?: string;
    limit?: number;
  }) => Promise<unknown>,
  threadId: string,
  options?: { pageLimit?: number; maxPages?: number },
): Promise<CodexBackgroundTerminalRecord[]> {
  if (!threadId) {
    throw new Error('Codex background terminal listing requires a thread id');
  }
  const pageLimit = options?.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isSafeInteger(pageLimit) || pageLimit <= 0) {
    throw new Error(
      'Codex background terminal page limit must be a positive integer',
    );
  }
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    throw new Error(
      'Codex background terminal max pages must be a positive integer',
    );
  }

  const result: CodexBackgroundTerminalRecord[] = [];
  const seenRecordIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const params = {
      threadId,
      ...(cursor ? { cursor } : {}),
      limit: pageLimit,
    };
    const response: unknown = await request(params);
    if (!isPageRecord(response)) {
      throw new Error('Codex background terminal page is malformed');
    }
    const data = response.data;
    if (!Array.isArray(data)) {
      throw new Error('Codex background terminal page is malformed');
    }
    if (!Object.prototype.hasOwnProperty.call(response, 'nextCursor')) {
      throw new Error('Codex background terminal page is missing its cursor');
    }

    for (const row of data) {
      if (!isPageRecord(row)) {
        throw new Error('Codex background terminal row is malformed');
      }
      const itemId = readPageString(row, 'itemId');
      const processId = readPageString(row, 'processId');
      if (!itemId || !processId) {
        throw new Error('Codex background terminal row is malformed');
      }
      const recordId = encodeCodexBackgroundWorkId([
        'terminal',
        threadId,
        itemId,
        processId,
      ]);
      if (!seenRecordIds.has(recordId)) {
        seenRecordIds.add(recordId);
        result.push({ threadId, itemId, processId });
      }
    }

    const nextCursor: unknown = response.nextCursor;
    if (nextCursor === null) {
      return result;
    }
    if (typeof nextCursor !== 'string' || nextCursor.length === 0) {
      throw new Error('Codex background terminal page cursor is malformed');
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error('Codex background terminal pagination repeated a cursor');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new Error('Codex background terminal pagination exceeded maxPages');
}

function isPageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPageString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

import { isNoBillingSourceErrorEventData } from '@canopy/desktop-shared/types';
import { isAgentDelegationTranscript } from '@canopy/protocol/delegation';
import type { AgentInterfacePort } from './agent-interface-port';
import type { AgentSession, AgentSessionOptions } from './types';
import { buildSessionKey, getOrCreateSession } from './session-manager';
import {
  EventPressureGate,
  GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
} from './event-pressure';
import { IngestionAdmissionMetrics } from './ingestion-admission-metrics';
import {
  recordEventReceiptTime,
  takeEventReceiptTime,
} from './event-receipt-time';
import { getChatSecretStore } from '../agent-secrets/chat-secret-store';
import { ChatSecretStorageBackstop } from '../agent-secrets/storage-redaction';
import { hasErroredToolResult } from '../lib/tool-result-entries';
import {
  createPreviewVisualTracker,
  projectPreviewVisualResult,
} from '@canopy/desktop-shared/lib/preview-visual-projection';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import type { ChatQueueRevivalLease } from '../services/chat-queue-service';
import { recordChatEventDropped } from '../lib/chat-event-drop-diagnostics';
import {
  classifyProviderRunEvent,
  copyProviderRunProvenance,
  getProviderRunDescriptor,
  type ProviderRunGeneration,
} from '../lib/provider-run-reconciliation';
import {
  isRecord,
  isRootTerminalChatEventData,
  isStaleCodexRootErrorEvent,
  readCodexRootThreadId,
  readCodexRootTurnId,
} from '../lib/chat-turn-audit';
import { getObservabilityService } from '../observability';
import {
  ChatDispatchOutcomeError,
  type ChatDispatchOutcome,
} from '../services/chat-dispatch-authorization';

export interface ChatTurnRootAcceptance {
  accepted: boolean;
  lease?: ChatQueueRevivalLease;
}

export type ChatTurnRootAcceptanceResult = boolean | ChatTurnRootAcceptance;

export interface PendingTurnRouteLifecycle {
  dispatchOwner: symbol;
  operationEpoch: number;
  turnUserMessageId: string;
  acceptTurnRoot?: (
    turnUserMessageId: string,
  ) => ChatTurnRootAcceptanceResult | Promise<ChatTurnRootAcceptanceResult>;
  drainEventsBeforeRemoval: () => Promise<void>;
  onRemoved?: () => void;
}

type TurnRouteLifecycle = Omit<
  PendingTurnRouteLifecycle,
  'dispatchOwner' | 'operationEpoch'
> &
  Partial<Pick<PendingTurnRouteLifecycle, 'dispatchOwner' | 'operationEpoch'>>;

interface EventRoute {
  session?: AgentSession;
  /** The turn anchor this route admits stamped events for. */
  rootUserMessageId(): string;
  forkExecution(anchor: string): EventRoute;
  bindSession(session: AgentSession): void;
  execution?: boolean;
  drained?: boolean;
  discarded?: boolean;
  disposeMetrics(): void;
  bindMetrics(metrics: IngestionAdmissionMetrics): void;
  handle(data: unknown): void | Promise<void>;
  /** Wait for this route's received prefix and its lifecycle commit tail. */
  drain(): Promise<void>;
  pressureSnapshot(): ReturnType<EventPressureGate['snapshot']>;
  onRemoved?: () => void;
}

const currentRoutes = new Map<string, EventRoute>();
const liveSessions = new Map<string, AgentSession>();
let boundExecutionRoutes = new WeakMap<AgentSession, Map<string, EventRoute>>();
let nativeStartReceipts = new WeakMap<
  AgentSession,
  Map<string, readonly string[]>
>();
const pendingRoutes = new Map<
  string,
  Map<symbol, { epoch: number; route: EventRoute; anchor: string }>
>();
let executionRoutes = new WeakMap<
  ProviderRunGeneration,
  Map<string, EventRoute>
>();
let sessionRoutes = new WeakMap<AgentSession, Set<EventRoute>>();
let sessionIngestionMetrics = new WeakMap<
  AgentSession,
  IngestionAdmissionMetrics
>();
const trackedIngestionMetrics = new Set<IngestionAdmissionMetrics>();
let turnRootAcceptances = new WeakMap<object, ChatTurnRootAcceptance>();
const INGESTION_DIAGNOSTIC_CADENCE_MS = 10_000;

function routeBacklogSnapshot(gate: EventPressureGate): {
  depth: number;
  oldestAgeMs: number;
} {
  const snapshot = gate.snapshot();
  return {
    depth: snapshot.activeCount + snapshot.waitingCount,
    oldestAgeMs: snapshot.oldestAgeMs,
  };
}

function sessionBacklogSnapshot(session: AgentSession): {
  depth: number;
  oldestAgeMs: number;
} {
  const routes = sessionRoutes.get(session) ?? new Set<EventRoute>();
  let depth = 0;
  let oldestAgeMs = 0;
  for (const route of Array.from(routes)) {
    const snapshot = route.pressureSnapshot();
    depth += snapshot.activeCount + snapshot.waitingCount;
    oldestAgeMs = Math.max(oldestAgeMs, snapshot.oldestAgeMs);
  }
  return { depth, oldestAgeMs };
}

function createDormantIngestionMetrics(
  pressure: EventPressureGate,
): IngestionAdmissionMetrics {
  const metrics = new IngestionAdmissionMetrics({
    now: (): number => performance.now(),
    dormant: true,
    readBacklog: (): { depth: number; oldestAgeMs: number } =>
      routeBacklogSnapshot(pressure),
    onFlush: (): void => undefined,
  });
  trackedIngestionMetrics.add(metrics);
  return metrics;
}

function createSessionIngestionMetrics(
  options: AgentSessionOptions,
  key: string,
  session: AgentSession,
): IngestionAdmissionMetrics {
  const metrics = new IngestionAdmissionMetrics({
    now: (): number => performance.now(),
    cadenceMs: INGESTION_DIAGNOSTIC_CADENCE_MS,
    readBacklog: (): { depth: number; oldestAgeMs: number } =>
      sessionBacklogSnapshot(session),
    onFlush: (window): void => {
      try {
        getObservabilityService().recordSessionDiagnostic({
          ...window,
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'ingestion_lag',
          sessionKey: key,
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          providerType: options.providerType ?? 'unknown',
        });
      } catch {
        // Diagnostics are best-effort and must not affect provider delivery.
      }
    },
  });
  trackedIngestionMetrics.add(metrics);
  return metrics;
}

function disposeTrackedIngestionMetrics(
  metrics: IngestionAdmissionMetrics,
): void {
  trackedIngestionMetrics.delete(metrics);
  metrics.dispose();
}

/** Read acceptance metadata without adding lease state to routed event data. */
export function getTurnRootAcceptance(
  data: unknown,
): ChatTurnRootAcceptance | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  return turnRootAcceptances.get(data);
}

function isChatTurnRootAcceptance(
  value: unknown,
): value is ChatTurnRootAcceptance {
  return isRecord(value) && typeof value.accepted === 'boolean';
}

/**
 * A delegate's snapshot keeps the tag of the turn that started it, so every
 * route delivers it whichever root is current.
 */
export function isOwnedDelegationEvent(data: unknown): boolean {
  return (
    isRecord(data) &&
    data.type === 'canopy_delegation' &&
    isAgentDelegationTranscript(data.delegation)
  );
}

/** One delegate run generation's place in line, and the snapshot it carries. */
interface WaitingDelegationSnapshot {
  data: unknown;
  sequence: number;
  settled?: Promise<void>;
  receiptAt?: number;
}

interface HandOffWaiter {
  position: number;
  start: () => void;
}

/**
 * A delegate's run generation and snapshot sequence. Each delegation event
 * carries that run's full snapshot, so a newer one replaces an older one.
 */
function delegationSnapshotIdentity(
  data: unknown,
): { key: string; sequence: number } | undefined {
  if (
    !isRecord(data) ||
    data.type !== 'canopy_delegation' ||
    !isAgentDelegationTranscript(data.delegation) ||
    data.delegation.transcriptMode !== undefined
  )
    return undefined;
  const { delegationId, runGeneration, sequence } = data.delegation;
  return {
    key: `${delegationId}:${String(runGeneration)}${
      data.canopy_replay === true ? ':replay' : ''
    }`,
    sequence,
  };
}

/** Codex's normalized publication can precede its raw turn.started frame. */
export function observeRoutedCodexTurnStart(
  scope: { projectId: string; worktreeId: string; chatId: string },
  session: AgentSession,
  threadId: string,
  turnId: string,
  boundInputIds: readonly string[] = [],
): void {
  const key = buildSessionKey(scope.projectId, scope.worktreeId, scope.chatId);
  if (liveSessions.get(key) !== session) return;
  const receipts =
    nativeStartReceipts.get(session) ?? new Map<string, readonly string[]>();
  const tuple = JSON.stringify([threadId, turnId]);
  receipts.set(
    tuple,
    Array.from(new Set([...(receipts.get(tuple) ?? []), ...boundInputIds])),
  );
  nativeStartReceipts.set(session, receipts);
}

/** Make a destination current; the replaced route drains its received work. */
function activateDestination(key: string, route: EventRoute): void {
  const previous = currentRoutes.get(key);
  currentRoutes.set(key, route);
  if (!previous || previous === route) return;
  void previous.drain().then(
    () => {
      if (previous.session && currentRoutes.get(key) !== previous)
        sessionRoutes.get(previous.session)?.delete(previous);
    },
    () => undefined,
  );
}

/**
 * Activate this prepared destination at its send, for a producer whose start
 * carries no binding receipt: a Claude prompt binds only at its result.
 */
export function activatePendingTurnRoute(
  scope: { projectId: string; worktreeId: string; chatId: string },
  dispatchOwner: symbol,
  operationEpoch: number,
): void {
  const key = buildSessionKey(scope.projectId, scope.worktreeId, scope.chatId);
  const pending = pendingRoutes.get(key);
  const entry = pending?.get(dispatchOwner);
  if (!pending || !entry || entry.epoch !== operationEpoch) return;
  pending.delete(dispatchOwner);
  if (pending.size === 0) pendingRoutes.delete(key);
  activateDestination(key, entry.route);
}

/** Trusted producer binding, called only after normalized lifecycle receipt. */
export function observeRoutedTurnBinding(
  scope: { projectId: string; worktreeId: string; chatId: string },
  session: AgentSession,
  userMessageIds: readonly string[],
  generation?: string,
  turnId?: string,
): void {
  const key = buildSessionKey(scope.projectId, scope.worktreeId, scope.chatId);
  if (liveSessions.get(key) !== session) return;
  const liveGeneration = session.getSteeringCapabilities?.().generation;
  if (liveGeneration !== undefined && generation !== liveGeneration) return;
  const pending = pendingRoutes.get(key);
  const bindings =
    boundExecutionRoutes.get(session) ?? new Map<string, EventRoute>();
  let execution = turnId ? bindings.get(turnId) : undefined;
  if (!execution) {
    // Only the first bound anchor chooses output placement. A later merged
    // input acknowledges its D without taking over the original execution.
    const firstAnchor = userMessageIds[0];
    const firstDestination = Array.from(pending?.values() ?? []).find(
      (entry) =>
        entry.route.session === session && entry.anchor === firstAnchor,
    );
    execution = firstDestination?.route ?? currentRoutes.get(key);
    if (firstDestination) activateDestination(key, firstDestination.route);
    if (turnId && execution) {
      bindings.set(turnId, execution);
      for (const [oldTurnId, oldRoute] of Array.from(bindings)) {
        if (bindings.size <= 64) break;
        if (oldRoute !== execution) bindings.delete(oldTurnId);
      }
      boundExecutionRoutes.set(session, bindings);
    }
  }
  for (const [owner, entry] of Array.from(pending ?? [])) {
    if (
      entry.route.session !== session ||
      !userMessageIds.includes(entry.anchor)
    )
      continue;
    // Legacy four-argument callers retain their old single-binding behavior.
    if (!turnId) currentRoutes.set(key, entry.route);
    pending?.delete(owner);
    if (execution && entry.route !== execution) {
      const mergedDestination = entry.route;
      void mergedDestination.drain().then(
        () => {
          if (mergedDestination.session)
            sessionRoutes
              .get(mergedDestination.session)
              ?.delete(mergedDestination);
        },
        () => undefined,
      );
    }
  }
  if (pending?.size === 0) pendingRoutes.delete(key);
}

/** Abandon only this prepared destination, never an activated execution. */
export async function discardPendingTurnRoute(
  scope: { projectId: string; worktreeId: string; chatId: string },
  dispatchOwner: symbol,
  operationEpoch: number,
): Promise<void> {
  const key = buildSessionKey(scope.projectId, scope.worktreeId, scope.chatId);
  const pending = pendingRoutes.get(key);
  const entry = pending?.get(dispatchOwner);
  if (!entry || entry.epoch !== operationEpoch) return;
  await entry.route.drain();
  if (pending?.get(dispatchOwner) !== entry) return;
  entry.route.discarded = true;
  pending.delete(dispatchOwner);
  if (pending.size === 0) pendingRoutes.delete(key);
  if (!entry.route.session) entry.route.disposeMetrics();
  if (entry.route.session)
    sessionRoutes.get(entry.route.session)?.delete(entry.route);
}

/** The session this chat's routes are bound to, if one is live. */
export function getLiveRoutedSession(scope: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): AgentSession | undefined {
  return liveSessions.get(
    buildSessionKey(scope.projectId, scope.worktreeId, scope.chatId),
  );
}

/** Park behind a wake: drop the unsent destination, then report the outcome. */
export async function parkBehindWake(
  scope: { projectId: string; worktreeId: string; chatId: string },
  parked: Extract<ChatDispatchOutcome, { kind: 'parked' }>,
): Promise<never> {
  await discardPendingTurnRoute(
    scope,
    parked.dispatchOwner,
    parked.operationEpoch,
  );
  throw new ChatDispatchOutcomeError(parked);
}

function dispatchExecutionEvent(
  key: string,
  data: unknown,
  current: EventRoute,
): void | Promise<void> {
  const descriptor = getProviderRunDescriptor(data);
  if (descriptor?.phase === 'running') {
    const classification = classifyProviderRunEvent(
      data,
      descriptor.generation.scope,
    );
    const scope = descriptor.generation.scope;
    const matchesScope =
      key === buildSessionKey(scope.projectId, scope.worktreeId, scope.chatId);
    if (
      !matchesScope ||
      classification.kind !== 'ordinary' ||
      !classification.run ||
      classification.reason !== 'running_run'
    ) {
      recordChatEventDropped({
        ...scope,
        providerType: 'codex',
        gate: 'router_stamp_mismatch',
        reason: !matchesScope ? 'run_scope_mismatch' : classification.reason,
        data,
      });
      return;
    }
    const tuple = JSON.stringify([descriptor.threadId, descriptor.turnId]);
    const executions =
      executionRoutes.get(descriptor.generation) ??
      new Map<string, EventRoute>();
    let execution = executions.get(tuple);
    if (execution?.session !== current.session) execution = undefined;
    if (!execution) {
      if (
        !isRecord(data) ||
        !isRecord(data.event) ||
        (data.event.type !== 'turn.started' &&
          (!current.session ||
            !nativeStartReceipts.get(current.session)?.has(tuple)))
      ) {
        recordChatEventDropped({
          ...scope,
          providerType: 'codex',
          gate: 'router_stamp_mismatch',
          reason: 'unregistered_execution',
          data,
        });
        return;
      }
      const pending = pendingRoutes.get(key);
      const destination =
        descriptor.origin === 'dispatched'
          ? Array.from(pending?.entries() ?? []).find(
              ([, value]) =>
                value.anchor === descriptor.executionUserMessageId &&
                value.route.session === current.session,
            )
          : undefined;
      execution =
        destination?.[1].route ??
        current.forkExecution(descriptor.executionUserMessageId);
      if (destination) pending?.delete(destination[0]);
      execution.execution = true;
      executions.set(tuple, execution);
      executionRoutes.set(descriptor.generation, executions);
      currentRoutes.set(key, execution);
    }
    const bindingInputs = current.session
      ? nativeStartReceipts.get(current.session)?.get(tuple)
      : undefined;
    if (current.session)
      nativeStartReceipts.get(current.session)?.delete(tuple);
    // A merged binding acknowledges D, but output stays on T's original
    // execution destination. The raw frame's authenticated tuple fences this
    // normalized evidence against replaced generations and transports.
    const pending = pendingRoutes.get(key);
    for (const [owner, entry] of Array.from(pending ?? [])) {
      if (
        entry.route.session !== current.session ||
        !bindingInputs?.includes(entry.anchor)
      )
        continue;
      pending?.delete(owner);
      if (entry.route !== execution) {
        const boundDestination = entry.route;
        void boundDestination.drain().then(
          () => {
            if (boundDestination.session)
              sessionRoutes
                .get(boundDestination.session)
                ?.delete(boundDestination);
          },
          () => undefined,
        );
      }
    }
    if (pending?.size === 0) pendingRoutes.delete(key);
    const delivery = execution.handle(data);
    if (
      isRecord(data) &&
      isRecord(data.event) &&
      data.event.type === 'turn.completed'
    ) {
      const settledRoute = execution;
      void Promise.resolve(delivery)
        .then(() => settledRoute.drain())
        .then(
          () => {
            settledRoute.drained = true;
            if (settledRoute.session)
              sessionRoutes.get(settledRoute.session)?.delete(settledRoute);
            // Keep bounded tuple history while producers independently exclude
            // native replay. Never evict an execution with undrained work.
            for (const [oldTuple, oldRoute] of Array.from(executions)) {
              if (executions.size <= 64) break;
              if (oldRoute.drained && oldRoute !== currentRoutes.get(key))
                executions.delete(oldTuple);
            }
          },
          () => undefined,
        );
    }
    return delivery;
  }
  // A prepared prompt's own events before its native start carry its stamp
  // but no run. Unless the current route admits that stamp, they reach the
  // pending destination without activating it; a terminal delivered there (a
  // failure before native start) retires the destination.
  const stamp =
    isRecord(data) && typeof data.canopy_turn_user_message_id === 'string'
      ? data.canopy_turn_user_message_id
      : undefined;
  const pending = pendingRoutes.get(key);
  const own =
    stamp === undefined
      ? undefined
      : Array.from(pending ?? []).find(
          ([, entry]) =>
            entry.anchor === stamp && entry.route.session === current.session,
        );
  if (!own) return current.handle(data);
  const [owner, { route }] = own;
  const target = stamp === current.rootUserMessageId() ? current : route;
  const delivery = target.handle(data);
  if (target === route && isRootTerminalChatEventData(data, undefined)) {
    pending?.delete(owner);
    if (pending?.size === 0) pendingRoutes.delete(key);
  }
  return delivery;
}

function createEventRoute(
  options: AgentSessionOptions,
  onEvent: (
    data: unknown,
    markPersistenceSettled?: () => void,
  ) => void | Promise<void>,
  lifecycle: TurnRouteLifecycle,
): EventRoute {
  let codexRootThreadId = options.sdkSessionId;
  let codexRootTurnId: string | undefined;
  let rootUserMessageId = lifecycle.turnUserMessageId;
  let pendingRouteEvents: Promise<void> | undefined;
  let received = 0;
  let handedOff = 0;
  let routingDepth = 0;
  const handOffWaiters: Array<HandOffWaiter | undefined> = [];
  let handOffWaitersHead = 0;
  // While chat storage group-commits, several of this chat's commits are in
  // flight together, bounded by bytes instead of one unmeasured event at a
  // time.
  const pressure = new EventPressureGate(
    () => GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
  );
  let ingestionMetrics = createDormantIngestionMetrics(pressure);
  const checkHandOffWaiters = (): void => {
    if (handOffWaitersHead === handOffWaiters.length) return;
    while (handOffWaitersHead < handOffWaiters.length) {
      const waiter = handOffWaiters[handOffWaitersHead];
      if (!waiter || waiter.position > handedOff) break;
      handOffWaiters[handOffWaitersHead] = undefined;
      handOffWaitersHead += 1;
      waiter.start();
    }
    if (handOffWaitersHead === handOffWaiters.length) {
      handOffWaiters.length = 0;
      handOffWaitersHead = 0;
    } else if (
      handOffWaitersHead > 1024 &&
      handOffWaitersHead * 2 >= handOffWaiters.length
    ) {
      handOffWaiters.splice(0, handOffWaitersHead);
      handOffWaitersHead = 0;
    }
  };
  const markHandedOff = (sequence: number): void => {
    // Hand-off order matches receive order except during synchronous re-entry:
    // producers await admission by default, group-commit limits preserve hand-
    // off order, and pendingRouteEvents serializes async arbitration. The
    // routing-depth guard below covers the re-entrant callback case.
    handedOff = Math.max(handedOff, sequence);
    if (routingDepth === 0) checkHandOffWaiters();
  };
  const leaveRouting = (): void => {
    routingDepth -= 1;
    if (routingDepth === 0) checkHandOffWaiters();
  };
  const deliverRouteEvent = (data: unknown, release: () => void): void => {
    const providerRunClassification = classifyProviderRunEvent(data, {
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: options.chatId,
    });
    if (providerRunClassification.kind === 'reject') {
      recordChatEventDropped({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        providerType: options.providerType,
        gate: 'router_stamp_mismatch',
        reason: providerRunClassification.reason,
        data,
        turnUserMessageId: rootUserMessageId,
      });
      release();
      return;
    }
    const ownedDelegation = isOwnedDelegationEvent(data);
    if (
      data !== null &&
      typeof data === 'object' &&
      'canopy_turn_user_message_id' in data &&
      typeof data.canopy_turn_user_message_id === 'string' &&
      data.canopy_turn_user_message_id !== rootUserMessageId &&
      providerRunClassification.kind !== 'transcript_only' &&
      !ownedDelegation
    ) {
      recordChatEventDropped({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        providerType: options.providerType,
        gate: 'router_stamp_mismatch',
        reason: 'route_turn_mismatch',
        data,
        turnUserMessageId: rootUserMessageId,
      });
      release();
      return;
    }
    if (providerRunClassification.kind === 'transcript_only') {
      // The row belongs to the originating native run. Deliver it to canonical
      // ingestion without changing this route's current root/thread identity,
      // pickup arbitration, or any provider lifecycle gates below.
      try {
        const delivered = onEvent(data, release);
        if (delivered && typeof delivered.then === 'function') {
          void Promise.resolve(delivered).then(release, release);
        } else {
          release();
        }
      } catch (error) {
        release();
        throw error;
      }
      return;
    }
    const nextRootThreadId = readCodexRootThreadId(data);
    if (nextRootThreadId && nextRootThreadId !== codexRootThreadId) {
      codexRootThreadId = nextRootThreadId;
      codexRootTurnId = undefined;
    }
    codexRootTurnId =
      readCodexRootTurnId(data, codexRootThreadId) ?? codexRootTurnId;
    if (isStaleCodexRootErrorEvent(data, codexRootThreadId, codexRootTurnId)) {
      recordChatEventDropped({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        providerType: options.providerType,
        gate: 'router_stale_codex_root_error',
        reason: 'stale_codex_root_error',
        data,
        providerThreadId: codexRootThreadId,
        providerTurnId: codexRootTurnId,
      });
      release();
      return;
    }
    if (
      isRecord(data) &&
      isRootTerminalChatEventData(data, codexRootThreadId, codexRootTurnId) &&
      deferredToolsReloadCoordinator.shouldSuppressProviderTerminal(options)
    ) {
      recordChatEventDropped({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        providerType: options.providerType,
        gate: 'router_deferred_tools_suppressed',
        reason: 'deferred_tools_terminal_suppressed',
        data,
        providerThreadId: codexRootThreadId,
        providerTurnId: codexRootTurnId,
      });
      release();
      return;
    }
    try {
      // The adapter settles this charge after persistence. Its remaining UI
      // delivery may recursively enqueue another event; do not await it here.
      const delivered = onEvent(data, release);
      if (delivered && typeof delivered.then === 'function') {
        void Promise.resolve(delivered).then(release, release);
      } else {
        // Legacy synchronous observers have no persistence boundary.
        release();
      }
    } catch (error) {
      release();
      throw error;
    }
  };
  const routeEvent = (
    data: unknown,
    release: () => void,
  ): void | Promise<void> => {
    // A correlated Claude pickup can open another execution window on this
    // same query without an ordinary dispatch installing another route.
    if (
      isRecord(data) &&
      data.type === 'canopy_input_delivery' &&
      data.provider === 'claude' &&
      data.phase === 'picked-up' &&
      data.startsTurn === true &&
      typeof data.userMessageId === 'string' &&
      typeof data.attemptId === 'string' &&
      typeof data.generation === 'string' &&
      data.generation === route.session?.getSteeringCapabilities?.().generation
    ) {
      const candidateRootUserMessageId = data.userMessageId;
      const accept =
        lifecycle.acceptTurnRoot?.(candidateRootUserMessageId) ?? true;
      const deliverAcceptance = (
        result: ChatTurnRootAcceptanceResult,
      ): void => {
        const acceptance: ChatTurnRootAcceptance =
          typeof result === 'boolean' ? { accepted: result } : result;
        if (!acceptance.accepted) {
          recordChatEventDropped({
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            chatId: options.chatId,
            providerType: options.providerType,
            gate: 'turn_root_refused',
            reason: 'turn_root_refused',
            data,
            turnUserMessageId: candidateRootUserMessageId,
          });
        }
        if (acceptance.accepted) {
          rootUserMessageId = candidateRootUserMessageId;
        }
        const deliveredPickup = copyProviderRunProvenance(data, {
          ...data,
          turnRootAccepted: acceptance.accepted,
        });
        turnRootAcceptances.set(deliveredPickup, acceptance);
        deliverRouteEvent(deliveredPickup, release);
      };
      if (typeof accept !== 'boolean' && !isChatTurnRootAcceptance(accept)) {
        return Promise.resolve(accept)
          .then(deliverAcceptance)
          .catch((error: unknown) => {
            release();
            throw error;
          });
      }
      deliverAcceptance(accept);
      return;
    }
    deliverRouteEvent(data, release);
  };
  const trackPendingRouteEvent = (promise: Promise<void>): void => {
    // A rejected provider/arbitration callback still reaches its producer,
    // but must not poison every subsequent event on this route.
    const current = promise.then(
      () => undefined,
      () => undefined,
    );
    pendingRouteEvents = current;
    void current.then(() => {
      if (pendingRouteEvents === current) pendingRouteEvents = undefined;
    });
  };
  const dispatchRouteEvent = (
    data: unknown,
    release: () => void,
    sequence: number,
  ): void | Promise<void> => {
    routingDepth += 1;
    try {
      const routed = routeEvent(data, release);
      if (routed) return routed.finally(() => markHandedOff(sequence));
      markHandedOff(sequence);
      return;
    } catch (error) {
      markHandedOff(sequence);
      throw error;
    } finally {
      leaveRouting();
    }
  };
  // Delegation snapshots still waiting for admission, by delegate run.
  const waitingSnapshots = new Map<string, WaitingDelegationSnapshot>();
  const prebindingForks = new Set<EventRoute>();
  const route: EventRoute = {
    rootUserMessageId: (): string => rootUserMessageId,
    bindSession(session): void {
      route.session = session;
      const routes = sessionRoutes.get(session) ?? new Set<EventRoute>();
      if (!route.discarded) routes.add(route);
      sessionRoutes.set(session, routes);
      for (const fork of Array.from(prebindingForks)) fork.bindSession(session);
      prebindingForks.clear();
    },
    disposeMetrics(): void {
      disposeTrackedIngestionMetrics(ingestionMetrics);
    },
    bindMetrics(metrics): void {
      if (ingestionMetrics === metrics) return;
      const previous = ingestionMetrics;
      try {
        metrics.merge(previous);
      } catch {
        disposeTrackedIngestionMetrics(previous);
      } finally {
        trackedIngestionMetrics.delete(previous);
      }
      ingestionMetrics = metrics;
    },
    forkExecution(anchor): EventRoute {
      const fork = createEventRoute(options, onEvent, {
        ...lifecycle,
        turnUserMessageId: anchor,
      });
      fork.bindMetrics(ingestionMetrics);
      if (route.session) fork.bindSession(route.session);
      else prebindingForks.add(fork);
      return fork;
    },
    handle(data): void | Promise<void> {
      const receiptAt =
        data !== null && typeof data === 'object'
          ? takeEventReceiptTime(data)
          : undefined;
      // A busy delegation tree publishes a snapshot per child event, and each
      // one is committed durably before the next is admitted. A snapshot
      // that is still waiting takes the newer content instead of queueing
      // another commit, so the chat never falls behind its delegates.
      const snapshot = delegationSnapshotIdentity(data);
      const waiting = snapshot && waitingSnapshots.get(snapshot.key);
      if (snapshot && waiting) {
        if (snapshot.sequence >= waiting.sequence) {
          waiting.data = data;
          waiting.sequence = snapshot.sequence;
          if (receiptAt !== undefined) waiting.receiptAt = receiptAt;
        }
        return waiting.settled;
      }
      const admission = {
        alone: hasErroredToolResult(data),
      };
      const sequence = ++received;
      // Charge before async root arbitration: events retained in that route
      // chain are part of the same backlog as the downstream commit queue.
      // While chat storage group-commits, several events are in flight at
      // once; an errored tool result is admitted alone, so the authentication
      // failure paired with it is queued before any later event (its terminal
      // event would otherwise settle the turn first).
      const admittedAt = performance.now();
      let admitted: (() => void) | Promise<() => void>;
      try {
        admitted = pressure.admit(data, admission);
      } catch (error) {
        markHandedOff(sequence);
        throw error;
      }
      try {
        ingestionMetrics.observeBacklog();
      } catch {
        // Diagnostics must not alter admission or route ordering.
      }
      const dispatch = (
        payload: unknown,
        release: () => void,
        receiptTime: number | undefined,
      ): void | Promise<void> => {
        let released = false;
        const trackedRelease = (): void => {
          if (released) return;
          released = true;
          try {
            release();
          } finally {
            try {
              ingestionMetrics.recordSettled(admittedAt, receiptTime);
            } catch {
              // A failed diagnostic sample must not affect event settlement.
            }
          }
        };
        if (pendingRouteEvents) {
          const pending = pendingRouteEvents.then(() =>
            dispatchRouteEvent(payload, trackedRelease, sequence),
          );
          trackPendingRouteEvent(pending);
          return pending.catch((error: unknown) => {
            trackedRelease();
            throw error;
          });
        }
        const pending = dispatchRouteEvent(payload, trackedRelease, sequence);
        if (pending) {
          trackPendingRouteEvent(pending);
          return pending.catch((error: unknown) => {
            trackedRelease();
            throw error;
          });
        }
        return;
      };
      if (typeof admitted === 'function')
        return dispatch(data, admitted, receiptAt);
      if (!snapshot)
        return admitted.then(
          (release) => dispatch(data, release, receiptAt),
          (error: unknown) => {
            markHandedOff(sequence);
            throw error;
          },
        );
      // The gate charged the first snapshot; a replacement is the same
      // delegate's cumulative snapshot, admitted in its place.
      const entry: WaitingDelegationSnapshot = {
        data,
        sequence: snapshot.sequence,
      };
      if (receiptAt !== undefined) entry.receiptAt = receiptAt;
      waitingSnapshots.set(snapshot.key, entry);
      entry.settled = admitted.then(
        (release) => {
          if (waitingSnapshots.get(snapshot.key) === entry)
            waitingSnapshots.delete(snapshot.key);
          return dispatch(entry.data, release, entry.receiptAt ?? receiptAt);
        },
        (error: unknown) => {
          if (waitingSnapshots.get(snapshot.key) === entry)
            waitingSnapshots.delete(snapshot.key);
          markHandedOff(sequence);
          throw error;
        },
      );
      return entry.settled;
    },
    drain: async (): Promise<void> => {
      const position = received;
      const released = pressure.drain();
      let lifecycleDrain: Promise<void>;
      if (handedOff >= position && routingDepth === 0) {
        lifecycleDrain = lifecycle.drainEventsBeforeRemoval();
      } else {
        lifecycleDrain = new Promise<void>((resolve, reject) => {
          const start = (): void => {
            try {
              resolve(lifecycle.drainEventsBeforeRemoval());
            } catch (error) {
              reject(
                error instanceof Error
                  ? error
                  : new Error(`Lifecycle event drain failed: ${String(error)}`),
              );
            }
          };
          handOffWaiters.push({ position, start });
        });
      }
      // Pressure release bounds admission through `position`; hand-off starts
      // the lifecycle snapshot exactly after that prefix is routed.
      await Promise.all([released, lifecycleDrain]);
    },
    pressureSnapshot: () => pressure.snapshot(),
    onRemoved: lifecycle.onRemoved,
  };
  return route;
}

/**
 * All native chat entry points share this route, including desktop and Portal
 * sends to the same cowork chat. Providers retain their creation callback.
 * Prepared D destinations activate on producer evidence, or at their send when
 * the producer's start carries none; legacy callers retain immediate
 * destination replacement while preserving queued work.
 */
export async function getOrCreateRoutedSession(
  options: AgentSessionOptions,
  onEvent: (
    data: unknown,
    markPersistenceSettled?: () => void,
  ) => void | Promise<void>,
  interfacePort: AgentInterfacePort,
  lifecycle: TurnRouteLifecycle,
): Promise<AgentSession> {
  // The storage backstop reads the chat secret store synchronously, so it
  // must have loaded first. A store that can't be read leaves it refusing.
  await getChatSecretStore()
    .ensureLoaded()
    .catch(() => undefined);
  // Resolved before any route changes, so nothing interleaves with them.
  const secretScope = {
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    chatId: options.chatId,
  };
  const secretBackstop = await ChatSecretStorageBackstop.forSession(
    secretScope,
    options.cwd,
  );
  const key = buildSessionKey(
    options.projectId,
    options.worktreeId,
    options.chatId,
  );
  const route = createEventRoute(options, onEvent, lifecycle);

  // A dispatch of an anchor supersedes an earlier pending destination for it
  // that never started (an unsent or cancelled attempt), which would otherwise
  // activate in its place.
  const superseded = pendingRoutes.get(key);
  for (const [owner, entry] of Array.from(superseded ?? []))
    if (entry.anchor === lifecycle.turnUserMessageId) superseded?.delete(owner);
  if (superseded?.size === 0) pendingRoutes.delete(key);

  if (
    lifecycle.dispatchOwner !== undefined &&
    lifecycle.operationEpoch !== undefined
  ) {
    const pending =
      pendingRoutes.get(key) ??
      new Map<symbol, { epoch: number; route: EventRoute; anchor: string }>();
    pending.set(lifecycle.dispatchOwner, {
      epoch: lifecycle.operationEpoch,
      route,
      anchor: lifecycle.turnUserMessageId,
    });
    pendingRoutes.set(key, pending);
  } else {
    currentRoutes.set(key, route);
  }
  let boundSession: AgentSession | undefined;
  let routeRemoved = false;
  // The provider keeps this call's callback for the session's lifetime, so
  // the PreviewVisual calls it has seen survive a later dispatch or steer.
  const previewVisualTracker = createPreviewVisualTracker();
  const onRemoved = (): void => {
    if (routeRemoved) return;
    routeRemoved = true;
    const removedPending: EventRoute[] = [];
    if (boundSession && liveSessions.get(key) === boundSession)
      liveSessions.delete(key);
    if (!boundSession) route.disposeMetrics();
    const pending = pendingRoutes.get(key);
    if (pending) {
      for (const [owner, entry] of Array.from(pending)) {
        if (
          entry.route === route ||
          (boundSession && entry.route.session === boundSession)
        ) {
          pending.delete(owner);
          removedPending.push(entry.route);
        }
      }
      if (pending.size === 0) pendingRoutes.delete(key);
    }
    const current = currentRoutes.get(key);
    const metrics = boundSession
      ? sessionIngestionMetrics.get(boundSession)
      : undefined;
    if (metrics) {
      // The session's last partial window is recorded once, not lost.
      metrics.flushFinal();
      disposeTrackedIngestionMetrics(metrics);
      if (boundSession) sessionIngestionMetrics.delete(boundSession);
    }
    if (
      current === route ||
      (boundSession && current?.session === boundSession)
    ) {
      currentRoutes.delete(key);
      // A reused session retains its creation callback, but removal belongs
      // to its latest route. Never notify a replacement transport's route.
      current?.onRemoved?.();
    }
    for (const destination of removedPending) {
      if (destination !== current) destination.onRemoved?.();
    }
  };
  try {
    const deliver = (data: unknown): void | Promise<void> => {
      const active = currentRoutes.get(key);
      const current =
        active?.session &&
        boundSession &&
        active.session !== boundSession &&
        liveSessions.get(key) === boundSession
          ? route
          : (active ?? (!routeRemoved && !route.discarded ? route : undefined));
      if (isOwnedDelegationEvent(data)) {
        // Managed children can outlive the provider transport that created
        // this callback. Route their explicitly parent-owned snapshots to
        // the latest chat route when one exists, or finish on the retained
        // route after removal.
        return (current ?? route).handle(data);
      }
      // Creation can emit synchronously. Once bound, the old transport must
      // never forward output into a replacement session, even without a tag.
      if (
        current &&
        (!boundSession ||
          !liveSessions.has(key) ||
          liveSessions.get(key) === boundSession) &&
        (boundSession ? current.session === boundSession : current === route)
      ) {
        return dispatchExecutionEvent(key, data, current);
      }
      recordChatEventDropped({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        providerType: options.providerType,
        gate: 'router_no_route',
        reason: current ? 'replaced_transport' : 'no_route',
        data,
      });
    };
    const session = await getOrCreateSession(
      options,
      (providerData): void | Promise<void> => {
        // A preview screenshot is for the agent only. It leaves the event
        // here, before any route can store, log, or forward it, for every
        // chat entry point.
        // Startup can refuse before the provider has received sendMessage,
        // so its pre-flight error has no turn metadata yet. Bind it to this
        // creation dispatch, never to whichever newer route is now visible.
        const scopedProviderData =
          isRecord(providerData) &&
          isNoBillingSourceErrorEventData(providerData) &&
          typeof providerData.canopy_turn_user_message_id !== 'string' &&
          typeof providerData.parent_tool_use_id !== 'string'
            ? {
                ...providerData,
                canopy_turn_user_message_id: lifecycle.turnUserMessageId,
              }
            : providerData;
        const projected = projectPreviewVisualResult(
          scopedProviderData,
          previewVisualTracker,
        );
        // Agent secret values that reached the chat another way (a native
        // command printing a secrets file) are replaced here, before any
        // route stores, logs or forwards the event (agent secret requests).
        const backstop = secretBackstop.apply(projected);
        // Values that can't be read back: the event is dropped (one that
        // settles a turn or a route goes on without its conversation text)
        // and only metadata is recorded; so is a delegation that can't stay
        // valid once redacted.
        if (backstop.refused)
          recordChatEventDropped({
            ...secretScope,
            providerType: options.providerType,
            gate: 'agent_secret_redaction_unavailable',
            reason: backstop.refused,
            data: projected,
          });
        const receiptAt =
          typeof projected === 'object' && projected !== null
            ? takeEventReceiptTime(projected)
            : undefined;
        const pending: Array<Promise<void>> = [];
        for (const event of backstop.events) {
          if (typeof event === 'object' && event !== null) {
            if (receiptAt !== undefined)
              recordEventReceiptTime(event, receiptAt);
            // The provider-run tag routes the event to its execution.
            if (event !== projected)
              copyProviderRunProvenance(projected, event);
          }
          const delivered = deliver(event);
          if (delivered) pending.push(delivered);
        }
        return pending.length
          ? Promise.all(pending).then(() => undefined)
          : undefined;
      },
      interfacePort,
      {
        onRemoved,
        drainEventsBeforeRemoval: async (): Promise<void> => {
          const routes = boundSession
            ? sessionRoutes.get(boundSession)
            : undefined;
          if (routes) {
            await Promise.all(Array.from(routes, (entry) => entry.drain()));
          } else {
            await route.drain();
          }
        },
      },
    );
    boundSession = session;
    if (!routeRemoved) liveSessions.set(key, session);
    route.bindSession(session);
    const routes = sessionRoutes.get(session) ?? new Set<EventRoute>();
    if (!route.discarded) routes.add(route);
    sessionRoutes.set(session, routes);
    if (routeRemoved) {
      const removedSessionMetrics = sessionIngestionMetrics.get(session);
      if (removedSessionMetrics) {
        disposeTrackedIngestionMetrics(removedSessionMetrics);
        sessionIngestionMetrics.delete(session);
      }
    } else {
      let sessionMetrics = sessionIngestionMetrics.get(session);
      if (!sessionMetrics) {
        sessionMetrics = createSessionIngestionMetrics(options, key, session);
        sessionIngestionMetrics.set(session, sessionMetrics);
      }
      for (const entry of Array.from(routes)) entry.bindMetrics(sessionMetrics);
      try {
        sessionMetrics.observeBacklog();
      } catch {
        // Backlog observation is best-effort and must not delay route binding.
      }
    }
    // Retain old routes only while their queued/derived work is still pending.
    // Their concrete-session drain remains reachable during concurrent teardown.
    for (const previous of Array.from(routes)) {
      if (
        previous === route ||
        previous.execution ||
        lifecycle.dispatchOwner !== undefined
      )
        continue;
      void Promise.resolve()
        .then(() => previous.drain())
        .then(
          () => routes.delete(previous),
          () => undefined,
        );
    }
    return session;
  } catch (error) {
    onRemoved();
    throw error;
  }
}

function routesForScope(key: string): EventRoute[] {
  const current = currentRoutes.get(key);
  const session = liveSessions.get(key) ?? current?.session;
  const routes = new Set<EventRoute>(
    session ? sessionRoutes.get(session) : undefined,
  );
  if (current) routes.add(current);
  for (const entry of Array.from(pendingRoutes.get(key)?.values() ?? []))
    routes.add(entry.route);
  return Array.from(routes);
}

/** Read-only route pressure across the current route and retained handoff
 * routes for the same live provider session. No event payloads are exposed. */
export function getRoutedSessionPressureSnapshot(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): {
  routeCount: number;
  activeCount: number;
  waitingCount: number;
  estimatedChargedBytes: number;
  oldestAgeMs: number;
  activeUncertainCount: number;
  waitingUncertainCount: number;
} {
  const routes = routesForScope(
    buildSessionKey(target.projectId, target.worktreeId, target.chatId),
  );
  const total = {
    routeCount: routes.length,
    activeCount: 0,
    waitingCount: 0,
    estimatedChargedBytes: 0,
    oldestAgeMs: 0,
    activeUncertainCount: 0,
    waitingUncertainCount: 0,
  };
  for (const route of routes) {
    const snapshot = route.pressureSnapshot();
    total.activeCount += snapshot.activeCount;
    total.waitingCount += snapshot.waitingCount;
    total.estimatedChargedBytes += snapshot.chargedBytes;
    total.oldestAgeMs = Math.max(total.oldestAgeMs, snapshot.oldestAgeMs);
    total.activeUncertainCount += snapshot.activeUncertainCount;
    total.waitingUncertainCount += snapshot.uncertainWaitingCount;
  }
  return total;
}

/**
 * Commit each route's pre-call event prefix and lifecycle work without waiting
 * for events that arrive later or stopping the live turn.
 */
export async function drainCurrentSessionEvents(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): Promise<void> {
  const routes = routesForScope(
    buildSessionKey(target.projectId, target.worktreeId, target.chatId),
  );
  await Promise.all(routes.map((route) => route.drain()));
}

export const sessionEventRouterTestExports = {
  currentRouteCount: (): number => currentRoutes.size,
  pendingRouteCount: (): number =>
    Array.from(pendingRoutes.values()).reduce(
      (count, owners) => count + owners.size,
      0,
    ),
  reset: (): void => {
    currentRoutes.clear();
    liveSessions.clear();
    boundExecutionRoutes = new WeakMap();
    nativeStartReceipts = new WeakMap();
    pendingRoutes.clear();
    executionRoutes = new WeakMap();
    for (const metrics of Array.from(trackedIngestionMetrics))
      metrics.dispose();
    trackedIngestionMetrics.clear();
    sessionRoutes = new WeakMap();
    sessionIngestionMetrics = new WeakMap();
    turnRootAcceptances = new WeakMap();
  },
};

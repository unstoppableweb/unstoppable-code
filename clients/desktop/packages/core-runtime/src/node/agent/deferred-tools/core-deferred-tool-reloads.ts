import { randomUUID } from 'node:crypto';
import type {
  CanopyErrorPayload,
  CanopyJsonValue,
  OperationOrigin,
  OperationOwner,
} from '@canopy/protocol/canopy-core';

import type { OperationServicePort } from '../../operations';

export const CORE_DEFERRED_TOOLS_DOMAIN = 'core.agent.deferredTools';
export const CORE_DEFERRED_TOOLS_RELOAD_KIND =
  'core.agent.deferredTools.reload';
/** From admission to the provider's acknowledgement (today's RELOAD_RESULT_DELIVERY_TIMEOUT_MS). */
export const DEFERRED_TOOL_RELOAD_RESULT_DELIVERY_MS = 30_000;
/** Each active stage, re-armed at every stage (today's RELOAD_ACTIVE_PHASE_TIMEOUT_MS). */
export const DEFERRED_TOOL_RELOAD_ACTIVE_STAGE_MS = 600_000;

export const DEFERRED_TOOL_RELOAD_ERRORS = {
  notAcknowledged: {
    kind: 'failed_precondition',
    code: 'core.agent.deferredTools.notAcknowledged',
    message: 'The provider did not accept the load result in time.',
    retry: { kind: 'never' },
  },
  enableFailed: {
    kind: 'failed_precondition',
    code: 'core.agent.deferredTools.enableFailed',
    message: 'The requested deferred items could not be enabled.',
    retry: { kind: 'never' },
  },
  resumeFailed: {
    kind: 'failed_precondition',
    code: 'core.agent.deferredTools.resumeFailed',
    message: 'The chat could not resume after enabling the requested items.',
    retry: { kind: 'never' },
  },
} as const satisfies Record<string, CanopyErrorPayload>;

export const DEFERRED_TOOL_RELOAD_MESSAGES = {
  catalogChanged:
    'Deferred-tools catalog item disappeared or became unavailable before enablement: ',
  catalogUnreadable:
    'Deferred-tools catalog could not be checked before enablement.',
  captureFailed:
    'Deferred-tools reload could not read the chat before enablement.',
  enableFailed: 'Deferred-tools enablement failed.',
  turnMissing: 'The interrupted turn could not be found.',
  resumeFailed: 'Deferred-tools resume failed.',
  timedOut:
    'Deferred-tools reload timed out before the reload handshake completed.',
  cancelled: 'Deferred-tools reload was cancelled.',
  operationCancelled:
    'Deferred-tools reload was cancelled through its operation.',
  closed: 'Deferred-tools reload stopped because the runtime closed.',
  materializationFailed:
    'The enabled items could not be materialized for this chat.',
  entryUnavailable: 'An enabled item is unavailable to this chat: ',
} as const;

export type DeferredToolReloadState =
  | 'result_pending'
  | 'ui_prepared'
  | 'interrupting'
  | 'enabling'
  | 'resuming'
  | 'completed';
export type DeferredToolReloadFailure =
  | 'rejected'
  | 'cancelled'
  | 'enable_failed'
  | 'resume_failed';
export type DeferredToolReloadLifecycle =
  | { readonly kind: 'state'; readonly state: DeferredToolReloadState }
  | { readonly kind: 'outcome'; readonly outcome: DeferredToolReloadFailure };
export interface DeferredToolReloadScope {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}
export type DeferredToolReloadDisplay = 'live' | 'headless' | 'unknown';

export interface DeferredToolReloadSnapshot<P> {
  readonly requestId: string;
  readonly operationId: string;
  readonly scope: DeferredToolReloadScope;
  readonly toolCallId: string;
  readonly payload: P;
  readonly state: DeferredToolReloadState;
  readonly acknowledged: boolean;
  readonly display: DeferredToolReloadDisplay;
}
export interface DeferredToolReloadEvent<P> {
  readonly reload: DeferredToolReloadSnapshot<P>;
  readonly lifecycle: DeferredToolReloadLifecycle;
  /** Present on failure outcomes. */
  readonly error?: {
    readonly outcome: DeferredToolReloadFailure;
    readonly message: string;
  };
  /** Present on `resuming`: the provider session id the continuation resumes, when known. */
  readonly sdkSessionId?: string;
}
export interface DeferredToolReloadCapture {
  readonly userMessageId: string | null;
  readonly sdkSessionId: string | null;
}
export interface DeferredToolReloadEnabled {
  readonly sdkSessionId: string | null;
}
export interface DeferredToolReloadResumeInput {
  readonly userMessageId: string;
  readonly sdkSessionId: string | null;
  /** Null until PR4 composes materialization, and for scopes that are not materialized. */
  readonly materializationId: string | null;
}
export interface DeferredToolReloadSettlement {
  readonly outcome: 'enable_failed' | 'resume_failed' | 'cancelled';
  readonly message: string;
  readonly userMessageId: string | null;
  /** True when the reload reached `interrupting`; false when it failed after acknowledgement but before. */
  readonly interrupted: boolean;
}

/** Desktop effects. Each method is called at most once per reload. */
export interface DeferredToolReloadHost<P> {
  /** Null when every requested item is still loadable; otherwise a safe, path-free reason. */
  revalidate(reload: DeferredToolReloadSnapshot<P>): Promise<string | null>;
  /** Read what resume needs before the session restarts. */
  capture(
    reload: DeferredToolReloadSnapshot<P>,
  ): Promise<DeferredToolReloadCapture>;
  /** Write the additions to the chat's selections and restart its provider session. Throw to fail enablement. */
  enable(
    reload: DeferredToolReloadSnapshot<P>,
    capture: DeferredToolReloadCapture,
    signal: AbortSignal,
  ): Promise<DeferredToolReloadEnabled>;
  /** Start the hidden continuation. Resolves once it is handed off; throw to fail the resume. */
  resume(
    reload: DeferredToolReloadSnapshot<P>,
    input: DeferredToolReloadResumeInput,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Settle the turn of an acknowledged reload that did not resume. Called for
   * every acknowledged reload that fails or is cancelled, interrupted or not;
   * the host decides whether its provider's turn needs settling. Must be
   * idempotent per request id; never throws to the core.
   */
  settleInterruptedTurn(
    reload: DeferredToolReloadSnapshot<P>,
    settlement: DeferredToolReloadSettlement,
  ): Promise<void>;
  /** The scope to materialize, or null when this chat is not materialized. Absent: the reload's own scope. */
  materializationScope?(
    reload: DeferredToolReloadSnapshot<P>,
  ): DeferredToolReloadScope | null;
}

export interface DeferredToolReloadMaterializationOutcome {
  readonly state: 'ready' | 'failed';
  readonly materializationId: string;
  readonly unavailable: readonly { readonly entryId: string }[];
}

/** Structurally satisfied by CoreCatalogMaterializations (CAN-4123 PR6). */
export interface DeferredToolReloadMaterializer {
  materialize(request: {
    scope: DeferredToolReloadScope;
    origin: OperationOrigin;
    owner: OperationOwner;
  }): Promise<DeferredToolReloadMaterializationOutcome>;
}

export interface DeferredToolReloadWaits {
  opened(scope: DeferredToolReloadScope, waitId: string): void;
  resolved(
    scope: DeferredToolReloadScope,
    waitId: string,
    resolution: 'answered' | 'cancelled' | 'expired',
  ): void;
}

export interface DeferredToolReloadRequest<P> {
  readonly scope: DeferredToolReloadScope;
  readonly toolCallId: string;
  readonly payload: P;
  readonly origin: OperationOrigin;
  readonly owner: OperationOwner;
  /** Catalog entry ids the reload enables (CAN-4123 D4); checked against the materialization. */
  readonly enabledEntryIds?: readonly string[];
}
export type DeferredToolReloadAdmission =
  | {
      readonly accepted: true;
      readonly requestId: string;
      readonly operationId: string;
    }
  | {
      readonly accepted: false;
      readonly reason: 'reload_in_progress' | 'unavailable';
    };
export type DeferredToolReloadAcknowledgementKey =
  | { readonly scope: DeferredToolReloadScope; readonly toolCallId: string }
  | { readonly scope: DeferredToolReloadScope; readonly requestId: string };

export interface CoreDeferredToolReloadsOptions<P> {
  operations: OperationServicePort;
  host: DeferredToolReloadHost<P>;
  /** CAN-4131: read once at acknowledgement, never waited on. */
  display?: { hasLiveLease(): boolean } | null;
  setTimer?: (callback: () => void, delayMs: number) => { cancel(): void };
  newRequestId?: () => string;
  onError?: (error: unknown, context: string) => void;
  resultDeliveryMs?: number;
  activeStageMs?: number;
  /** CAN-4115 wait seam; a throw is reported to onError and ignored. */
  waits?: DeferredToolReloadWaits | null;
  /** CAN-4123: checked once after enablement, before resume. */
  materializations?: DeferredToolReloadMaterializer | null;
}

interface ReloadRecord<P> {
  readonly requestId: string;
  operationId: string;
  readonly scope: DeferredToolReloadScope;
  readonly toolCallId: string;
  readonly payload: P;
  readonly origin: OperationOrigin;
  readonly owner: OperationOwner;
  readonly enabledEntryIds: readonly string[];
  state: DeferredToolReloadState;
  acknowledged: boolean;
  display: DeferredToolReloadDisplay;
  settled: boolean;
  stageReached: DeferredToolReloadState;
  readonly controller: AbortController;
  timer: { cancel(): void } | null;
  capture: DeferredToolReloadCapture | null;
  materializationId: string | null;
  readonly settleCallbacks: Array<() => void>;
  waitOpen: boolean;
}

const MAX_RECENT_SETTLED = 64;

function scopeKey(scope: DeferredToolReloadScope): string {
  return `${scope.workspaceId}\u0000${scope.worktreeId}\u0000${scope.chatId}`;
}

function defaultSetTimer(
  callback: () => void,
  delayMs: number,
): { cancel(): void } {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return { cancel: (): void => clearTimeout(handle) };
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The core deferred-tool reload lifecycle (CAN-4127). One reload per chat:
 * admitted at Load, driven after the provider acknowledges the result
 * through validation, capture, the session restart and resume, each once
 * per request id. Nothing waits for a display; a reload settles exactly once.
 */
export class CoreDeferredToolReloads<P> {
  private readonly byScope = new Map<string, ReloadRecord<P>>();
  private readonly byOperation = new Map<string, ReloadRecord<P>>();
  private readonly recentSettled = new Map<
    string,
    {
      readonly requestId: string;
      readonly lifecycle: DeferredToolReloadLifecycle;
    }
  >();
  private readonly listeners = new Set<
    (event: DeferredToolReloadEvent<P>) => void
  >();
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => { cancel(): void };
  private readonly newRequestId: () => string;
  private readonly resultDeliveryMs: number;
  private readonly activeStageMs: number;
  private closed = false;

  constructor(private readonly options: CoreDeferredToolReloadsOptions<P>) {
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.newRequestId = options.newRequestId ?? randomUUID;
    this.resultDeliveryMs =
      options.resultDeliveryMs ?? DEFERRED_TOOL_RELOAD_RESULT_DELIVERY_MS;
    this.activeStageMs =
      options.activeStageMs ?? DEFERRED_TOOL_RELOAD_ACTIVE_STAGE_MS;
    options.operations.registerDomain({
      domain: CORE_DEFERRED_TOOLS_DOMAIN,
      kinds: [CORE_DEFERRED_TOOLS_RELOAD_KIND],
      restartClass: 'lost',
      cancel: (operation) => {
        const reload = this.byOperation.get(operation.operationId);
        if (reload)
          this.settle(
            reload,
            'cancelled',
            DEFERRED_TOOL_RELOAD_MESSAGES.operationCancelled,
          );
        return Promise.resolve('requested');
      },
    });
  }

  /** Admit one reload for a chat; refuses while another is live there. */
  async request(
    request: DeferredToolReloadRequest<P>,
  ): Promise<DeferredToolReloadAdmission> {
    if (this.closed) return { accepted: false, reason: 'unavailable' };
    const key = scopeKey(request.scope);
    if (this.byScope.has(key))
      return { accepted: false, reason: 'reload_in_progress' };
    const record: ReloadRecord<P> = {
      requestId: this.newRequestId(),
      operationId: '',
      scope: request.scope,
      toolCallId: request.toolCallId,
      payload: request.payload,
      origin: request.origin,
      owner: request.owner,
      enabledEntryIds: request.enabledEntryIds ?? [],
      state: 'result_pending',
      acknowledged: false,
      display: 'unknown',
      settled: false,
      stageReached: 'result_pending',
      controller: new AbortController(),
      timer: null,
      capture: null,
      materializationId: null,
      settleCallbacks: [],
      waitOpen: false,
    };
    this.byScope.set(key, record);
    let operationId: string;
    try {
      const { workspaceId, worktreeId, chatId } = request.scope;
      const admitted = await this.options.operations.admit({
        kind: CORE_DEFERRED_TOOLS_RELOAD_KIND,
        status: 'running',
        origin: request.origin,
        owner: request.owner,
        scope: { workspaceId, worktreeId, chatId },
      });
      operationId = admitted.operation.operationId;
    } catch (error) {
      if (this.byScope.get(key) === record) this.byScope.delete(key);
      this.report(error, 'deferred tools reload admission');
      if (!record.settled) {
        record.settled = true;
        this.runSettleCallbacks(record);
      }
      return { accepted: false, reason: 'unavailable' };
    }
    if (record.settled) {
      void this.options.operations
        .finish(operationId, { status: 'cancelled' })
        .catch((error: unknown) =>
          this.report(error, 'deferred tools reload finish'),
        );
      return { accepted: false, reason: 'unavailable' };
    }
    record.operationId = operationId;
    this.byOperation.set(operationId, record);
    this.arm(record, this.resultDeliveryMs);
    return { accepted: true, requestId: record.requestId, operationId };
  }

  /** Synchronous. True exactly once per reload, for the first key naming the live, unacknowledged, admitted reload. */
  acknowledge(key: DeferredToolReloadAcknowledgementKey): boolean {
    const record = this.byScope.get(scopeKey(key.scope));
    if (
      !record ||
      record.settled ||
      record.operationId === '' ||
      record.acknowledged
    )
      return false;
    if ('toolCallId' in key && key.toolCallId !== record.toolCallId)
      return false;
    if ('requestId' in key && key.requestId !== record.requestId) return false;
    record.acknowledged = true;
    record.display = this.readDisplay();
    this.arm(record, this.activeStageMs);
    this.emit(record, { kind: 'state', state: 'result_pending' });
    if (!record.settled) {
      this.callWaits((waits) => waits.opened(record.scope, record.requestId));
      record.waitOpen = true;
    }
    if (!record.settled) void this.drive(record);
    return true;
  }

  /** Synchronous. Cancels only while unacknowledged. */
  cancelUnacknowledged(
    scope: DeferredToolReloadScope,
    toolCallId: string,
    reason: string,
  ): boolean {
    const record = this.byScope.get(scopeKey(scope));
    if (!record || record.toolCallId !== toolCallId || record.acknowledged)
      return false;
    return this.settle(record, 'cancelled', reason);
  }

  /** Synchronous. Cancels the chat's live reload (only the one with `requestId` when given). */
  cancel(
    scope: DeferredToolReloadScope,
    reason: string,
    options?: { requestId?: string },
  ): boolean {
    const record = this.byScope.get(scopeKey(scope));
    if (!record) return false;
    if (
      options?.requestId !== undefined &&
      options.requestId !== record.requestId
    )
      return false;
    return this.settle(record, 'cancelled', reason);
  }

  active(scope: DeferredToolReloadScope): DeferredToolReloadSnapshot<P> | null {
    const record = this.byScope.get(scopeKey(scope));
    return record ? this.snapshot(record) : null;
  }

  /** The last settled reload of a chat tool call, kept for read-only compatibility acks (newest 64). */
  recent(
    scope: DeferredToolReloadScope,
    toolCallId: string,
  ): {
    readonly requestId: string;
    readonly lifecycle: DeferredToolReloadLifecycle;
  } | null {
    return (
      this.recentSettled.get(`${scopeKey(scope)}\u0000${toolCallId}`) ?? null
    );
  }

  /** Calls `onSettled` once when the chat's live reload settles; false, registering nothing, when none is live. */
  whenSettled(scope: DeferredToolReloadScope, onSettled: () => void): boolean {
    const record = this.byScope.get(scopeKey(scope));
    if (!record || record.settled) return false;
    record.settleCallbacks.push(onSettled);
    return true;
  }

  subscribe(listener: (event: DeferredToolReloadEvent<P>) => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** Shutdown: settles every live reload locally (message `closed`) without finishing its operation; later requests answer `unavailable`. */
  close(): void {
    this.closed = true;
    for (const record of Array.from(this.byScope.values()))
      this.settle(record, 'cancelled', DEFERRED_TOOL_RELOAD_MESSAGES.closed, {
        local: true,
      });
  }

  private async drive(record: ReloadRecord<P>): Promise<void> {
    const key = scopeKey(record.scope);
    const { host } = this.options;
    const stillCurrent = (): boolean =>
      !record.settled && this.byScope.get(key) === record;

    let reason: string | null;
    try {
      reason = await host.revalidate(this.snapshot(record));
    } catch (error) {
      this.report(error, 'deferred tools reload revalidation');
      if (stillCurrent())
        this.settle(
          record,
          'enable_failed',
          DEFERRED_TOOL_RELOAD_MESSAGES.catalogUnreadable,
        );
      return;
    }
    if (!stillCurrent()) return;
    if (reason !== null) {
      this.settle(
        record,
        'enable_failed',
        DEFERRED_TOOL_RELOAD_MESSAGES.catalogChanged + reason,
      );
      return;
    }

    let capture: DeferredToolReloadCapture;
    try {
      capture = await host.capture(this.snapshot(record));
    } catch (error) {
      this.report(error, 'deferred tools reload capture');
      if (stillCurrent())
        this.settle(
          record,
          'enable_failed',
          DEFERRED_TOOL_RELOAD_MESSAGES.captureFailed,
        );
      return;
    }
    if (!stillCurrent()) return;
    record.capture = capture;

    this.arm(record, this.activeStageMs);
    for (const state of ['ui_prepared', 'interrupting', 'enabling'] as const) {
      if (state === 'interrupting') this.resolveWait(record, 'answered');
      this.advance(record, state);
      this.emit(record, { kind: 'state', state });
      if (!stillCurrent()) return;
    }

    let enabled: DeferredToolReloadEnabled;
    try {
      enabled = await host.enable(
        this.snapshot(record),
        capture,
        record.controller.signal,
      );
    } catch (error) {
      if (stillCurrent())
        this.settle(
          record,
          'enable_failed',
          messageOf(error, DEFERRED_TOOL_RELOAD_MESSAGES.enableFailed),
        );
      return;
    }
    if (!stillCurrent()) return;

    const { materializations } = this.options;
    const materializationScope = host.materializationScope
      ? host.materializationScope(this.snapshot(record))
      : record.scope;
    if (materializations && materializationScope) {
      let outcome: DeferredToolReloadMaterializationOutcome;
      try {
        outcome = await materializations.materialize({
          scope: materializationScope,
          origin: record.origin,
          owner: record.owner,
        });
      } catch (error) {
        this.report(error, 'deferred tools reload materialization');
        if (stillCurrent())
          this.settle(
            record,
            'enable_failed',
            DEFERRED_TOOL_RELOAD_MESSAGES.materializationFailed,
          );
        return;
      }
      if (!stillCurrent()) return;
      if (outcome.state === 'failed') {
        this.settle(
          record,
          'enable_failed',
          DEFERRED_TOOL_RELOAD_MESSAGES.materializationFailed,
        );
        return;
      }
      const unavailable = new Set(
        outcome.unavailable.map((entry) => entry.entryId),
      );
      const missing = record.enabledEntryIds.find((entryId) =>
        unavailable.has(entryId),
      );
      if (missing !== undefined) {
        this.settle(
          record,
          'enable_failed',
          DEFERRED_TOOL_RELOAD_MESSAGES.entryUnavailable + missing,
        );
        return;
      }
      record.materializationId = outcome.materializationId;
    }

    const { userMessageId } = capture;
    if (userMessageId === null) {
      this.settle(
        record,
        'resume_failed',
        DEFERRED_TOOL_RELOAD_MESSAGES.turnMissing,
      );
      return;
    }

    const sdkSessionId = enabled.sdkSessionId ?? capture.sdkSessionId;
    this.advance(record, 'resuming');
    this.arm(record, this.activeStageMs);
    this.emit(
      record,
      { kind: 'state', state: 'resuming' },
      sdkSessionId !== null ? { sdkSessionId } : {},
    );
    if (!stillCurrent()) return;
    try {
      await host.resume(
        this.snapshot(record),
        {
          userMessageId,
          sdkSessionId,
          materializationId: record.materializationId,
        },
        record.controller.signal,
      );
    } catch (error) {
      if (stillCurrent())
        this.settle(
          record,
          'resume_failed',
          messageOf(error, DEFERRED_TOOL_RELOAD_MESSAGES.resumeFailed),
        );
      return;
    }
    if (!stillCurrent()) return;
    this.settle(record, 'completed');
  }

  private settle(
    record: ReloadRecord<P>,
    outcome: DeferredToolReloadFailure | 'completed',
    message = '',
    options: { local?: boolean; byTimer?: boolean } = {},
  ): boolean {
    if (record.settled) return false;
    record.settled = true;
    record.timer?.cancel();
    record.timer = null;
    if (outcome !== 'completed') record.controller.abort();
    this.resolveWait(record, options.byTimer ? 'expired' : 'cancelled');
    if (outcome === 'completed') record.state = 'completed';

    const lifecycle: DeferredToolReloadLifecycle =
      outcome === 'completed'
        ? { kind: 'state', state: 'completed' }
        : { kind: 'outcome', outcome };
    this.emit(
      record,
      lifecycle,
      outcome === 'completed' ? {} : { error: { outcome, message } },
    );

    const key = scopeKey(record.scope);
    if (this.byScope.get(key) === record) this.byScope.delete(key);
    if (record.operationId !== '') this.byOperation.delete(record.operationId);
    const recentKey = `${key}\u0000${record.toolCallId}`;
    this.recentSettled.delete(recentKey);
    this.recentSettled.set(recentKey, {
      requestId: record.requestId,
      lifecycle,
    });
    while (this.recentSettled.size > MAX_RECENT_SETTLED) {
      const oldest = this.recentSettled.keys().next();
      if (oldest.done) break;
      this.recentSettled.delete(oldest.value);
    }

    this.runSettleCallbacks(record);

    if (options.local) return true;

    if (outcome !== 'completed' && record.acknowledged) {
      const settlement: DeferredToolReloadSettlement = {
        outcome: outcome === 'rejected' ? 'enable_failed' : outcome,
        message,
        userMessageId: record.capture?.userMessageId ?? null,
        interrupted:
          record.stageReached === 'interrupting' ||
          record.stageReached === 'enabling' ||
          record.stageReached === 'resuming',
      };
      void this.options.host
        .settleInterruptedTurn(this.snapshot(record), settlement)
        .catch((error: unknown) =>
          this.report(error, 'deferred tools interrupted turn settlement'),
        );
    }

    if (record.operationId !== '') {
      void this.options.operations
        .finish(record.operationId, this.terminal(record, outcome))
        .catch((error: unknown) =>
          this.report(error, 'deferred tools reload finish'),
        );
    }
    return true;
  }

  private terminal(
    record: ReloadRecord<P>,
    outcome: DeferredToolReloadFailure | 'completed',
  ): {
    status: 'completed' | 'cancelled' | 'failed';
    outcome?: CanopyJsonValue;
    error?: CanopyErrorPayload;
  } {
    if (outcome === 'completed')
      return {
        status: 'completed',
        outcome: {
          requestId: record.requestId,
          toolCallId: record.toolCallId,
          display: record.display,
          materializationId: record.materializationId,
        },
      };
    if (outcome === 'cancelled') return { status: 'cancelled' };
    const error: CanopyErrorPayload = !record.acknowledged
      ? DEFERRED_TOOL_RELOAD_ERRORS.notAcknowledged
      : outcome === 'resume_failed'
        ? DEFERRED_TOOL_RELOAD_ERRORS.resumeFailed
        : DEFERRED_TOOL_RELOAD_ERRORS.enableFailed;
    return { status: 'failed', error };
  }

  private runSettleCallbacks(record: ReloadRecord<P>): void {
    for (const callback of record.settleCallbacks.splice(0)) {
      try {
        callback();
      } catch (error) {
        this.report(error, 'deferred tools reload settle callback');
      }
    }
  }

  private arm(record: ReloadRecord<P>, delayMs: number): void {
    record.timer?.cancel();
    record.timer = this.setTimer(() => {
      if (record.settled || this.byScope.get(scopeKey(record.scope)) !== record)
        return;
      this.settle(
        record,
        record.state === 'resuming' ? 'resume_failed' : 'enable_failed',
        DEFERRED_TOOL_RELOAD_MESSAGES.timedOut,
        { byTimer: true },
      );
    }, delayMs);
  }

  private resolveWait(
    record: ReloadRecord<P>,
    resolution: 'answered' | 'cancelled' | 'expired',
  ): void {
    if (!record.waitOpen) return;
    record.waitOpen = false;
    this.callWaits((waits) =>
      waits.resolved(record.scope, record.requestId, resolution),
    );
  }

  private callWaits(call: (waits: DeferredToolReloadWaits) => void): void {
    const { waits } = this.options;
    if (!waits) return;
    try {
      call(waits);
    } catch (error) {
      this.report(error, 'deferred tools reload wait');
    }
  }

  private advance(
    record: ReloadRecord<P>,
    state: DeferredToolReloadState,
  ): void {
    record.state = state;
    record.stageReached = state;
  }

  private readDisplay(): DeferredToolReloadDisplay {
    const { display } = this.options;
    if (!display) return 'unknown';
    try {
      return display.hasLiveLease() ? 'live' : 'headless';
    } catch (error) {
      this.report(error, 'deferred tools reload display');
      return 'unknown';
    }
  }

  private snapshot(record: ReloadRecord<P>): DeferredToolReloadSnapshot<P> {
    return {
      requestId: record.requestId,
      operationId: record.operationId,
      scope: record.scope,
      toolCallId: record.toolCallId,
      payload: record.payload,
      state: record.state,
      acknowledged: record.acknowledged,
      display: record.display,
    };
  }

  private emit(
    record: ReloadRecord<P>,
    lifecycle: DeferredToolReloadLifecycle,
    extra: Pick<DeferredToolReloadEvent<P>, 'error' | 'sdkSessionId'> = {},
  ): void {
    const event: DeferredToolReloadEvent<P> = {
      reload: this.snapshot(record),
      lifecycle,
      ...extra,
    };
    const settledAtEmit = record.settled;
    for (const listener of Array.from(this.listeners)) {
      // A listener that settles the reload has already delivered the
      // terminal event; the stage event it interrupted is stale.
      if (record.settled && !settledAtEmit) return;
      try {
        listener(event);
      } catch (error) {
        this.report(error, 'deferred tools reload listener');
      }
    }
  }

  private report(error: unknown, context: string): void {
    try {
      this.options.onError?.(error, context);
    } catch {
      // Reporting is best effort; a throwing reporter must not skip settlement.
    }
  }
}

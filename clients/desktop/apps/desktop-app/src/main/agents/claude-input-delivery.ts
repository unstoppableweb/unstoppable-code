import type {
  ChatInputAdmission,
  ChatInputDeliveryEvent,
  ChatInputDeliveryFailure,
  ChatInputRefusalCode,
  ChatInputWithdrawal,
  ChatSteeringCapabilities,
} from '@canopy/protocol/remote-control/shell';
import {
  chatInputDeliveryFailure,
  chatInputRefusal,
} from '@canopy/protocol/remote-control/shell/input-delivery';
import type { ChatInputSubmitResult } from './types';

interface Attempt {
  yielded?: boolean;
  userMessageId: string;
  admitted: boolean;
  pickedUp: boolean;
  startsTurn?: boolean;
  receivedStarted?: boolean;
  pickedUpObserved?: boolean;
  receivedCancelled?: boolean;
  withdrawn: boolean;
  unknown: boolean;
  /** Submit returned `pending`; later events, not `settle`, report it. */
  pending?: boolean;
  completed?: boolean;
  receivedCompleted?: boolean;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  pendingTimer?: ReturnType<typeof setTimeout>;
  deadlineReported?: boolean;
  settle?: (result: ChatInputSubmitResult) => void;
  withdrawalObserved?: () => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The provider did not answer within the delivery deadline. */
export class DeliveryDeadlineError extends Error {
  constructor() {
    super('Provider delivery confirmation timed out');
    this.name = 'DeliveryDeadlineError';
  }
}

export interface ClaudeInputSubmitOptions {
  /**
   * A root chat's live session may still take the input after the deadline,
   * so expiry reads as `pending` and later lifecycle events settle it.
   */
  pendingOnDeadline?: boolean;
}

const UNCONFIRMED_REASON =
  'Delivery was not confirmed. This message will not be resent automatically.';
const PENDING_DEADLINE_MS = 5000;
const CONFIRMATION_DEADLINE_MS = 60000;

export async function withDeliveryDeadline<T>(
  operation: Promise<T>,
  milliseconds = 5000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DeliveryDeadlineError()),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pin-sensitive SDK seam (0.3.258 / Claude 2.1.258). These private methods
 * are intentionally checked at runtime; the SDK remains the sole I/O owner.
 * Never infer withdrawal from a false receipt or the absence of a started event.
 */
export class ClaudeInputDelivery {
  private query: Record<string, unknown> | undefined;
  private capabilities = new Set<string>();
  private receivedEvents = new WeakSet<object>();
  private attempts = new Map<string, Attempt>();
  private disposed = false;
  private frozen = false;
  private sweepOperation: Promise<void> | undefined;

  constructor(
    readonly generation: string,
    private readonly emit: (event: ChatInputDeliveryEvent) => void,
    private readonly pickup: (userMessageId: string) => boolean,
    private readonly onEligibilityChanged: () => void = (): void => undefined,
  ) {}

  setQuery(query: unknown): void {
    this.query = record(query) ? query : undefined;
    this.onEligibilityChanged();
  }

  getCapabilities(): ChatSteeringCapabilities {
    const live = !this.disposed && !this.frozen;
    const withdraw =
      this.capabilities.has('msg_lifecycle_v1') &&
      typeof this.query?.cancelAsyncMessage === 'function';
    const interrupt =
      this.capabilities.has('interrupt_receipt_v1') &&
      this.capabilities.has('interrupt_cancel_queued_v1') &&
      typeof this.query?.interrupt === 'function';
    return {
      provider: 'claude',
      generation: this.generation,
      steer: live && withdraw && interrupt,
      withdraw: live && withdraw,
      interrupt: !this.disposed && interrupt,
    };
  }

  hasPending(): boolean {
    return (
      !this.disposed &&
      Array.from(this.attempts.values()).some(
        (a) => !a.pickedUp && !a.withdrawn,
      )
    );
  }

  /** How many inputs the SDK has started a turn for. */
  startedCount(): number {
    return Array.from(this.attempts.values()).filter(
      (attempt) => attempt.pickedUp,
    ).length;
  }

  /** Inputs the SDK queued that no turn has started yet. */
  admittedUnstarted(): string[] {
    if (this.disposed) return [];
    return Array.from(this.attempts)
      .filter(
        ([, attempt]) =>
          attempt.admitted &&
          !attempt.pickedUp &&
          !attempt.withdrawn &&
          !attempt.unknown,
      )
      .map(([id]) => id);
  }

  claimYield(id: string): boolean {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.withdrawn || this.disposed || this.frozen)
      return false;
    attempt.yielded = true;
    if (!attempt.admitted && !attempt.pickedUp)
      this.startConfirmationDeadline(id, attempt);
    return true;
  }

  private clearTimers(attempt: Attempt): void {
    if (attempt.deadlineTimer) clearTimeout(attempt.deadlineTimer);
    if (attempt.pendingTimer) clearTimeout(attempt.pendingTimer);
    delete attempt.deadlineTimer;
    delete attempt.pendingTimer;
  }

  private startConfirmationDeadline(id: string, attempt: Attempt): void {
    if (attempt.admitted || attempt.pickedUp || attempt.withdrawn) return;
    if (attempt.deadlineTimer) clearTimeout(attempt.deadlineTimer);
    attempt.deadlineReported = false;
    attempt.deadlineTimer = setTimeout(() => {
      delete attempt.deadlineTimer;
      if (
        this.disposed ||
        attempt.admitted ||
        attempt.pickedUp ||
        attempt.withdrawn
      )
        return;
      attempt.unknown = true;
      const failure = chatInputDeliveryFailure('delivery-deadline');
      if (!attempt.deadlineReported) {
        attempt.deadlineReported = true;
        this.observation(id, 'unknown', undefined, failure);
      }
      attempt.settle?.({
        kind: 'unknown',
        attemptId: id,
        reason: UNCONFIRMED_REASON,
        failure,
      });
    }, CONFIRMATION_DEADLINE_MS);
    attempt.deadlineTimer.unref?.();
  }

  private startPendingDeadline(id: string, attempt: Attempt): void {
    attempt.pendingTimer = setTimeout(() => {
      delete attempt.pendingTimer;
      if (
        this.disposed ||
        attempt.admitted ||
        attempt.pickedUp ||
        attempt.withdrawn ||
        !attempt.settle
      )
        return;
      attempt.pending = true;
      attempt.settle({ kind: 'pending', attemptId: id });
    }, PENDING_DEADLINE_MS);
    attempt.pendingTimer.unref?.();
  }

  private confirm(attempt: Attempt): void {
    this.clearTimers(attempt);
  }

  private settleAccepted(id: string, attempt: Attempt): void {
    attempt.settle?.({ kind: 'accepted', attemptId: id });
  }

  private settleWithdrawn(id: string, attempt: Attempt): void {
    this.confirm(attempt);
    attempt.settle?.({
      kind: 'rejected',
      attemptId: id,
      reason: 'Submission withdrawn before delivery',
      refusal: chatInputRefusal('handoff-interrupted'),
    });
  }

  private readCapabilities(event: Record<string, unknown>): Set<string> {
    return new Set(
      Array.isArray(event.capabilities)
        ? event.capabilities.filter(
            (capability): capability is string =>
              typeof capability === 'string',
          )
        : [],
    );
  }

  private observation(
    id: string,
    phase: ChatInputDeliveryEvent['phase'],
    startsTurn?: boolean,
    failure?: ChatInputDeliveryFailure,
  ): void {
    this.emit({
      type: 'canopy_input_delivery',
      provider: 'claude',
      generation: this.generation,
      attemptId: id,
      phase,
      ...(startsTurn
        ? { startsTurn, userMessageId: this.attempts.get(id)?.userMessageId }
        : {}),
      ...(failure ? { failure } : {}),
    });
  }

  observe(event: unknown): void {
    if (!record(event) || event.parent_tool_use_id != null) return;
    // A pickup decided on receipt is still reported in order after Stop
    // disposes the session, while already-read events are admitted.
    if (this.receivedEvents.has(event)) {
      if (
        event.type === 'command_lifecycle' &&
        event.state === 'started' &&
        typeof event.command_uuid === 'string'
      ) {
        const attempt = this.attempts.get(event.command_uuid);
        if (attempt?.receivedStarted && !attempt.pickedUpObserved) {
          attempt.pickedUpObserved = true;
          this.observation(event.command_uuid, 'picked-up', attempt.startsTurn);
        }
      }
      return;
    }
    if (this.disposed) return;
    if (event.type === 'system' && event.subtype === 'init') {
      this.capabilities = this.readCapabilities(event);
      this.onEligibilityChanged();
      return;
    }
    if (
      event.type !== 'command_lifecycle' ||
      typeof event.command_uuid !== 'string'
    )
      return;
    const id = event.command_uuid;
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    if (event.state === 'queued' && !attempt.admitted) {
      attempt.admitted = true;
      // A late acknowledgement returns an uncertain row to pending, so later
      // cancellations are judged on their own evidence again.
      if (!attempt.withdrawn) attempt.unknown = false;
      this.confirm(attempt);
      this.observation(id, 'accepted');
      this.settleAccepted(id, attempt);
    } else if (event.state === 'started' && !attempt.pickedUp) {
      attempt.pickedUp = true;
      if (attempt.withdrawn) attempt.unknown = true;
      attempt.startsTurn = this.pickup(attempt.userMessageId);
      attempt.pickedUpObserved = true;
      this.confirm(attempt);
      this.observation(id, 'picked-up', attempt.startsTurn);
      this.settleAccepted(id, attempt);
    } else if (event.state === 'cancelled' && !attempt.receivedCancelled) {
      if (!attempt.pickedUp && !attempt.unknown && !attempt.withdrawn) {
        attempt.withdrawn = true;
        this.settleWithdrawn(id, attempt);
        this.observation(id, 'withdrawn');
        attempt.withdrawalObserved?.();
      }
    } else if (event.state === 'completed' && !attempt.receivedCompleted) {
      attempt.completed = true;
      this.observation(id, 'completed');
    }
  }

  /**
   * Receipt-time processing of a root `system/init` or `command_lifecycle`,
   * before the event's durable admission. Confirmations and withdrawals stop
   * their timers; lifecycle observations are emitted now except `picked-up`,
   * which stays admission-ordered. A received `started` event stores its
   * pickup decision for `observe` to report exactly once.
   */
  receive(event: unknown): void {
    if (!record(event) || event.parent_tool_use_id != null || this.disposed)
      return;
    if (event.type === 'system' && event.subtype === 'init') {
      if (this.receivedEvents.has(event)) return;
      this.receivedEvents.add(event);
      this.capabilities = this.readCapabilities(event);
      this.onEligibilityChanged();
      return;
    }
    if (
      event.type !== 'command_lifecycle' ||
      typeof event.command_uuid !== 'string'
    )
      return;
    if (this.receivedEvents.has(event)) return;
    this.receivedEvents.add(event);
    const id = event.command_uuid;
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    if (event.state === 'queued' && !attempt.admitted) {
      attempt.admitted = true;
      // A late acknowledgement returns an uncertain row to pending, so later
      // cancellations are judged on their own evidence again.
      if (!attempt.withdrawn) attempt.unknown = false;
      this.confirm(attempt);
      this.observation(id, 'accepted');
      this.settleAccepted(id, attempt);
    } else if (event.state === 'started') {
      attempt.receivedStarted = true;
      if (!attempt.pickedUp) {
        attempt.pickedUp = true;
        if (attempt.withdrawn) attempt.unknown = true;
        attempt.startsTurn = this.pickup(attempt.userMessageId);
        this.confirm(attempt);
        this.settleAccepted(id, attempt);
      }
    } else if (event.state === 'cancelled') {
      attempt.receivedCancelled = true;
      if (!attempt.pickedUp && !attempt.unknown && !attempt.withdrawn) {
        attempt.withdrawn = true;
        this.settleWithdrawn(id, attempt);
        this.observation(id, 'withdrawn');
        attempt.withdrawalObserved?.();
      } else if (attempt.withdrawn) {
        this.settleWithdrawn(id, attempt);
      }
    } else if (event.state === 'completed' && !attempt.completed) {
      attempt.receivedCompleted = true;
      attempt.completed = true;
      this.observation(id, 'completed');
    } else if (event.state === 'completed') {
      attempt.receivedCompleted = true;
    }
  }

  submit(
    text: string,
    id: string,
    userMessageId: string,
    enqueue: () => void,
    options?: { pendingOnDeadline?: false },
  ): Promise<ChatInputAdmission>;
  submit(
    text: string,
    id: string,
    userMessageId: string,
    enqueue: () => void,
    options: ClaudeInputSubmitOptions,
  ): Promise<ChatInputSubmitResult>;
  async submit(
    text: string,
    id: string,
    userMessageId: string,
    enqueue: () => void,
    options: ClaudeInputSubmitOptions = {},
  ): Promise<ChatInputSubmitResult> {
    if (!this.getCapabilities().steer)
      return {
        kind: 'rejected',
        attemptId: id,
        reason: 'Steering is unavailable for this session',
        refusal: chatInputRefusal('steering-unavailable'),
      };
    if (this.attempts.has(id))
      return {
        kind: 'unknown',
        attemptId: id,
        reason: 'This submission identity was already used',
        failure: chatInputDeliveryFailure('duplicate-attempt'),
      };
    // The durable ledger owns historical facts. Keep a bounded correlation
    // window here and never evict an input still owned by the live query.
    if (this.attempts.size >= 1024) {
      for (const [previousId, previous] of Array.from(this.attempts)) {
        if ((previous.withdrawn && !previous.unknown) || previous.completed) {
          this.attempts.delete(previousId);
          if (this.attempts.size < 1024) break;
        }
      }
    }
    if (this.attempts.size >= 1024)
      return {
        kind: 'rejected',
        attemptId: id,
        reason:
          'Too many messages are awaiting delivery confirmation. Keep this message queued.',
        refusal: chatInputRefusal('delivery-backlog'),
      };
    const attempt: Attempt = {
      userMessageId,
      admitted: false,
      pickedUp: false,
      withdrawn: false,
      unknown: false,
    };
    this.attempts.set(id, attempt);
    try {
      const admitted = new Promise<ChatInputSubmitResult>((resolve) => {
        attempt.settle = resolve;
      });
      if (options.pendingOnDeadline) this.startPendingDeadline(id, attempt);
      else this.startConfirmationDeadline(id, attempt);
      enqueue();
      return await admitted;
    } catch {
      this.clearTimers(attempt);
      const failure = chatInputDeliveryFailure('enqueue-failed');
      attempt.unknown = true;
      this.observation(id, 'unknown', undefined, failure);
      return {
        kind: 'unknown',
        attemptId: id,
        reason: UNCONFIRMED_REASON,
        failure,
      };
    } finally {
      delete attempt.settle;
    }
  }

  /** A failed SDK handoff has not entered the provider's input queue. */
  rejectUnaccepted(
    id: string,
    reason: string,
    refusal?: ChatInputRefusalCode,
  ): void {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.admitted || attempt.pickedUp || attempt.withdrawn)
      return;
    // A pending submission has already returned, so nothing would carry this
    // rejection; leave it to the session end, which reports it as unknown.
    if (attempt.pending) return;
    attempt.withdrawn = true;
    this.confirm(attempt);
    attempt.settle?.({
      kind: 'rejected',
      attemptId: id,
      reason,
      fallback: 'ordinary',
      ...(refusal ? { refusal: chatInputRefusal(refusal) } : {}),
    });
  }

  endTurn(): void {
    if (this.disposed) return;
    this.frozen = true;
    this.onEligibilityChanged();
    for (const id of Array.from(this.attempts.keys()))
      this.rejectUnaccepted(
        id,
        'The delegated SDK turn has ended',
        'turn-ended',
      );
    this.dispose();
  }

  async withdraw(id: string): Promise<ChatInputWithdrawal> {
    const attempt = this.attempts.get(id);
    if (attempt?.pickedUp) return { kind: 'picked-up', attemptId: id };
    if (attempt?.withdrawn && !attempt.unknown)
      return { kind: 'withdrawn', attemptId: id, evidenceId: id };
    if (!this.getCapabilities().withdraw)
      return { kind: 'unsupported', attemptId: id };
    if (!attempt)
      return {
        kind: 'unconfirmed',
        attemptId: id,
        reason: 'This session does not own the message',
      };
    try {
      const method = this.query?.cancelAsyncMessage;
      if (typeof method !== 'function')
        return { kind: 'unsupported', attemptId: id };
      const observed = new Promise<boolean>((resolve) => {
        attempt.withdrawalObserved = (): void => resolve(true);
      });
      const receipt: unknown = await withDeliveryDeadline(
        Promise.race([
          Promise.resolve(Reflect.apply(method, this.query, [id])),
          observed,
        ]),
      );
      if (attempt.pickedUp) return { kind: 'picked-up', attemptId: id };
      if (
        (receipt === true || attempt.withdrawn) &&
        !attempt.unknown &&
        !this.disposed
      ) {
        if (!attempt.withdrawn) {
          attempt.withdrawn = true;
          this.settleWithdrawn(id, attempt);
          this.observation(id, 'withdrawn');
        }
        return { kind: 'withdrawn', attemptId: id, evidenceId: id };
      }
    } catch {
      /* The query may still consume the message. Keep ownership. */
    } finally {
      delete attempt.withdrawalObserved;
    }
    attempt.unknown = true;
    this.observation(id, 'unknown');
    return {
      kind: 'unconfirmed',
      attemptId: id,
      reason: 'Cancellation was not confirmed',
    };
  }

  sweep(timeoutMs = 5000): Promise<void> {
    if (!this.sweepOperation)
      this.sweepOperation = this.sweepOnce(timeoutMs).finally(() => {
        this.sweepOperation = undefined;
      });
    return this.sweepOperation;
  }

  private async sweepOnce(timeoutMs: number): Promise<void> {
    if (!this.getCapabilities().interrupt)
      throw new Error('Safe interruption is unavailable for this session');
    this.frozen = true;
    this.onEligibilityChanged();
    try {
      // Prompt normalization can still be awaiting I/O. Withdraw those local
      // staging entries before sweeping the SDK so they cannot arrive afterward.
      for (const [id, attempt] of Array.from(this.attempts)) {
        if (!attempt.yielded && !attempt.pickedUp) {
          attempt.withdrawn = true;
          this.confirm(attempt);
          this.observation(id, 'withdrawn');
          attempt.settle?.({
            kind: 'rejected',
            attemptId: id,
            reason: 'Submission interrupted before handoff',
            refusal: chatInputRefusal('handoff-interrupted'),
          });
        }
      }
      const method = this.query?.interrupt;
      if (typeof method !== 'function')
        throw new Error('Interruption is unavailable');
      const receipt: unknown = await withDeliveryDeadline(
        Promise.resolve(
          Reflect.apply(method, this.query, [{ cancelQueued: true }]),
        ),
        timeoutMs,
      );
      if (
        !record(receipt) ||
        !Array.isArray(receipt.cancelled) ||
        !receipt.cancelled.every((id) => typeof id === 'string') ||
        !Array.isArray(receipt.still_queued) ||
        !receipt.still_queued.every((id) => typeof id === 'string')
      )
        throw new Error('Invalid interruption receipt');
      for (const id of receipt.cancelled) {
        const attempt = this.attempts.get(id);
        if (attempt && !attempt.pickedUp && !attempt.unknown) {
          attempt.withdrawn = true;
          this.settleWithdrawn(id, attempt);
          this.observation(id, 'withdrawn');
        }
      }
      if (this.hasPending())
        throw new Error(
          'Pending input could not be withdrawn; replacement remains queued',
        );
    } finally {
      this.frozen = false;
      this.onEligibilityChanged();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onEligibilityChanged();
    for (const [id, attempt] of Array.from(this.attempts)) {
      this.clearTimers(attempt);
      if (attempt.pickedUp || attempt.withdrawn) continue;
      const failure = chatInputDeliveryFailure('session-ended');
      attempt.unknown = true;
      this.observation(id, 'unknown', undefined, failure);
      attempt.settle?.({
        kind: 'unknown',
        attemptId: id,
        reason: 'Provider session ended',
        failure,
      });
    }
  }
}

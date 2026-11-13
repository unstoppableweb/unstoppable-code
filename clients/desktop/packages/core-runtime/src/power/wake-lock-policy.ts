import type {
  PlatformPowerAssertion,
  PlatformPowerAssertionEnd,
  PlatformPowerServices,
} from '../platform/platform-services';

/**
 * Work that keeps the computer awake while it runs. `remote-session`: this
 * computer is hosting a Remote Control session for another device.
 */
export type WakeLockHolderKind =
  | 'chat'
  | 'delegation'
  | 'pipeline'
  | 'remote-session';

export const WAKE_LOCK_HOLDER_REASONS: Readonly<
  Record<WakeLockHolderKind, string>
> = {
  chat: 'agent chat turn',
  delegation: 'delegated task',
  pipeline: 'pipeline execution',
  'remote-session': 'remote control session',
};

export function wakeLockHolderKey(
  kind: WakeLockHolderKind,
  id: string,
): string {
  return `${kind}:${id}`;
}

/** The holder key and reason for one piece of work, in `acquire` order. */
export function wakeLockHolder(
  kind: WakeLockHolderKind,
  id: string,
): readonly [key: string, reason: string] {
  return [wakeLockHolderKey(kind, id), WAKE_LOCK_HOLDER_REASONS[kind]];
}

export interface WakeLockHolder {
  readonly key: string;
  readonly reason: string;
  readonly acquiredAt: number;
}

export interface WakeLockPolicyState {
  readonly active: boolean;
  readonly enabled: boolean;
  readonly holderCount: number;
}

export type WakeLockRecordKind =
  | 'wake_lock_acquired'
  | 'wake_lock_released'
  | 'wake_lock_started'
  | 'wake_lock_stopped'
  | 'wake_lock_error';

/** Never carries a holder key: holders appear as `<kind>#<ordinal>`. */
export interface WakeLockRecord {
  readonly kind: WakeLockRecordKind;
  readonly reason?: string;
  readonly holderKey?: string;
  readonly holderCount: number;
  readonly enabled: boolean;
  readonly blockerId?: number;
}

export interface WakeLockPolicyOptions {
  readonly record?: (record: WakeLockRecord) => void;
  /** Called once per recorded error, after `record`. */
  readonly warn?: (reason: string) => void;
  readonly now?: () => number;
}

const ASSERTION_REASON = 'Agent work is running';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type RecordExtra = Omit<
  WakeLockRecord,
  'kind' | 'holderCount' | 'enabled' | 'reason'
>;

/**
 * Holder policy for keeping the computer awake. Holders are counted by key;
 * one power assertion is held while any holder remains and the preference is
 * enabled. Holders are released explicitly or by `holdUntil` when their work
 * settles, whether it succeeded, failed, or was cancelled. A host crash ends
 * the assertion with the process (see `PlatformPowerServices`).
 */
export class WakeLockPolicy {
  private readonly holders = new Map<string, WakeLockHolder>();
  /**
   * Holder keys embed session keys (`chat:<workspace>/<worktree>/<chat>`),
   * and these records land in global diagnostics, which must never carry
   * worktree or chat ids. Each holder is recorded as its category and a
   * per-policy ordinal instead, so acquire and release still pair up.
   */
  private readonly holderOrdinals = new Map<string, number>();
  private nextHolderOrdinal = 0;
  private readonly power: PlatformPowerServices;
  private readonly recordSink: (record: WakeLockRecord) => void;
  private readonly warn: (reason: string) => void;
  private readonly now: () => number;
  private assertion: PlatformPowerAssertion | null = null;
  /** The current assertion was requested but is not held yet. */
  private starting = false;
  /** Released assertions whose release was not confirmed; retried later. */
  private readonly unreleased = new Set<PlatformPowerAssertion>();
  /** Released assertions whose release has not settled yet. */
  private readonly releasing = new Set<PlatformPowerAssertion>();
  private enabled = true;
  private listener: ((state: WakeLockPolicyState) => void) | null = null;
  private lastEmittedState: WakeLockPolicyState | null = null;
  private unavailableReported = false;

  constructor(
    power: PlatformPowerServices,
    options: WakeLockPolicyOptions = {},
  ) {
    this.power = power;
    this.recordSink = options.record ?? ((): void => undefined);
    this.warn = options.warn ?? ((): void => undefined);
    this.now = options.now ?? Date.now;
  }

  acquire(key: string, reason: string): void {
    const existing = this.holders.get(key);
    if (existing) {
      this.holders.set(key, { ...existing, reason });
      // A failed start leaves holders without an assertion; a same-key
      // re-acquire retries rather than waiting for another holder change.
      if (this.assertion === null) {
        this.reconcile();
      } else {
        this.emitStateIfChanged();
      }
      return;
    }

    this.holders.set(key, { key, reason, acquiredAt: this.now() });
    this.record('wake_lock_acquired', {
      holderKey: this.holderLabel(key),
    });
    this.reconcile();
  }

  release(key: string): void {
    if (!this.holders.delete(key)) {
      return;
    }

    const holderKey = this.holderLabel(key);
    this.holderOrdinals.delete(key);
    this.record('wake_lock_released', { holderKey });
    this.reconcile();
  }

  /** Holds `kind:id` until `settled` resolves or rejects. */
  holdUntil(
    kind: WakeLockHolderKind,
    id: string,
    settled: PromiseLike<unknown>,
  ): void {
    const [key, reason] = wakeLockHolder(kind, id);
    this.acquire(key, reason);
    const release = (): void => this.release(key);
    void Promise.resolve(settled).then(release, release);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.reconcile();
  }

  getState(): WakeLockPolicyState {
    return {
      active:
        (this.assertion !== null && this.isHeld(this.assertion)) ||
        Array.from(this.releasing)
          .concat(Array.from(this.unreleased))
          .some((assertion) => this.isHeld(assertion)),
      enabled: this.enabled,
      holderCount: this.holders.size,
    };
  }

  getHolders(): WakeLockHolder[] {
    return Array.from(this.holders.values()).map((holder) => ({ ...holder }));
  }

  /** The latest state is delivered at once, then each change. */
  onStateChanged(listener: (state: WakeLockPolicyState) => void): void {
    this.listener = listener;
    this.emitStateIfChanged();
  }

  /**
   * Releases the assertion and clears holders. Resolves `true` once release
   * is confirmed; `false` leaves the assertion for a later retry.
   */
  shutdown(): Promise<boolean> {
    const released = [this.releaseAssertion(), ...this.retryUnreleased()];
    this.holders.clear();
    this.holderOrdinals.clear();
    this.emitStateIfChanged();
    return Promise.all(released).then((results) => results.every(Boolean));
  }

  /** `chat#3`: the key's category and this holder's ordinal, no ids. */
  private holderLabel(key: string): string {
    let ordinal = this.holderOrdinals.get(key);
    if (ordinal === undefined) {
      this.nextHolderOrdinal += 1;
      ordinal = this.nextHolderOrdinal;
      this.holderOrdinals.set(key, ordinal);
    }
    const separator = key.indexOf(':');
    const category = separator > 0 ? key.slice(0, separator) : 'holder';
    return `${category}#${ordinal}`;
  }

  private reconcile(): void {
    const shouldRun =
      this.power.mechanism !== 'unavailable' &&
      this.enabled &&
      this.holders.size > 0;
    const current = this.assertion;
    if (current !== null && !this.starting && !this.isHeld(current)) {
      this.record('wake_lock_stopped', { blockerId: current.id });
      this.assertion = null;
    }
    if (shouldRun && this.assertion === null) {
      this.requestAssertion();
    } else if (!shouldRun && this.assertion !== null) {
      void this.releaseAssertion();
    }
    void this.retryUnreleased();
    this.emitStateIfChanged();
  }

  private requestAssertion(): void {
    let result;
    try {
      result = this.power.preventSystemSleep({ reason: ASSERTION_REASON });
    } catch (error) {
      this.recordError(getErrorMessage(error));
      return;
    }
    if (result.kind === 'unavailable') {
      if (!this.unavailableReported) {
        this.unavailableReported = true;
        this.recordError(result.reason);
      }
      return;
    }
    if (result.kind === 'failed') {
      this.recordError(
        result.reason,
        result.id === undefined ? {} : { blockerId: result.id },
      );
      return;
    }

    const { assertion } = result;
    this.assertion = assertion;
    this.starting = !this.isHeld(assertion);
    if (!this.starting) {
      this.record('wake_lock_started', { blockerId: assertion.id });
    }
    void assertion.held.then((held) => {
      if (!held || assertion !== this.assertion || !this.starting) return;
      this.starting = false;
      this.record('wake_lock_started', { blockerId: assertion.id });
      this.emitStateIfChanged();
    });
    void assertion.ended.then((end) => this.onEnded(assertion, end));
  }

  /** An assertion the policy still holds ended without being released. */
  private onEnded(
    assertion: PlatformPowerAssertion,
    end: PlatformPowerAssertionEnd,
  ): void {
    if (assertion !== this.assertion || end.kind === 'released') return;
    const wasHeld = !this.starting;
    this.assertion = null;
    this.starting = false;
    if (wasHeld) {
      this.record('wake_lock_stopped', { blockerId: assertion.id });
    }
    this.recordError(end.reason, { blockerId: assertion.id });
    // Only a held assertion is replaced at once; one that never held waits
    // for the next holder change, so a refused backend is not retried in a loop.
    if (wasHeld) {
      this.reconcile();
    } else {
      this.emitStateIfChanged();
    }
  }

  private releaseAssertion(): Promise<boolean> {
    const assertion = this.assertion;
    if (assertion === null) {
      return Promise.resolve(true);
    }

    let done: Promise<void>;
    try {
      done = assertion.release();
    } catch (error) {
      // Keep the assertion so a later reconcile or shutdown retries release.
      this.recordError(getErrorMessage(error), { blockerId: assertion.id });
      return Promise.resolve(false);
    }
    this.assertion = null;
    this.starting = false;
    this.record('wake_lock_stopped', { blockerId: assertion.id });
    return this.confirmRelease(assertion, done);
  }

  /** A rejected release keeps the assertion for the next reconcile or shutdown. */
  private confirmRelease(
    assertion: PlatformPowerAssertion,
    done: Promise<void>,
  ): Promise<boolean> {
    this.releasing.add(assertion);
    return done.then(
      () => {
        this.releasing.delete(assertion);
        this.unreleased.delete(assertion);
        this.emitStateIfChanged();
        return true;
      },
      (error: unknown) => {
        this.releasing.delete(assertion);
        this.unreleased.add(assertion);
        this.recordError(getErrorMessage(error), { blockerId: assertion.id });
        this.emitStateIfChanged();
        return false;
      },
    );
  }

  private retryUnreleased(): Promise<boolean>[] {
    return Array.from(this.unreleased, (assertion) => {
      this.unreleased.delete(assertion);
      let done: Promise<void>;
      try {
        done = assertion.release();
      } catch (error) {
        this.unreleased.add(assertion);
        this.recordError(getErrorMessage(error), { blockerId: assertion.id });
        return Promise.resolve(false);
      }
      return this.confirmRelease(assertion, done);
    });
  }

  private isHeld(assertion: PlatformPowerAssertion): boolean {
    try {
      return assertion.isHeld();
    } catch (error) {
      this.recordError(getErrorMessage(error), { blockerId: assertion.id });
      return false;
    }
  }

  private emitStateIfChanged(): void {
    const state = this.getState();
    const last = this.lastEmittedState;
    if (
      last &&
      last.active === state.active &&
      last.enabled === state.enabled &&
      last.holderCount === state.holderCount
    ) {
      return;
    }

    this.lastEmittedState = state;
    this.listener?.(state);
  }

  private record(kind: WakeLockRecordKind, extra: RecordExtra = {}): void {
    this.recordSink({
      kind,
      ...extra,
      holderCount: this.holders.size,
      enabled: this.enabled,
    });
  }

  private recordError(reason: string, extra: RecordExtra = {}): void {
    this.recordSink({
      kind: 'wake_lock_error',
      reason,
      holderCount: this.holders.size,
      enabled: this.enabled,
      ...extra,
    });
    this.warn(reason);
  }
}

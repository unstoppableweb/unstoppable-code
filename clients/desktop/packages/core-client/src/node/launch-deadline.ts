import { CanopyClientError } from '../errors';
import { canopyConnectError } from './endpoint';

export type Redact = (error: unknown) => CanopyClientError;
export const ignore = (): void => {};
const TIMED_OUT = 'Core startup timed out.';

/** Port failures keep their kind but take fixed text: details may name paths or tokens. */
export const fixed =
  (
    message: string,
    codeOf?: (error: unknown) => Readonly<Record<string, string | number>>,
  ): Redact =>
  (error) =>
    canopyConnectError(
      error instanceof CanopyClientError ? error.payload.kind : 'unavailable',
      message,
      codeOf?.(error),
    );
/** For ports whose typed errors are already redacted (classification, K1 attach). */
export const typed =
  (message: string): Redact =>
  (error) =>
    error instanceof CanopyClientError
      ? error
      : canopyConnectError('internal', message);

/** One monotonic deadline plus caller abort, bounding every awaited port call. */
export class Deadline {
  failure: CanopyClientError | undefined;
  private readonly controller = new AbortController();
  private readonly failed: Promise<never>;
  private expiresAt = 0;
  private expiry = TIMED_OUT;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onAbort = (): void =>
    this.fail('cancelled', 'Core startup was cancelled.');
  private readonly expire = (): void =>
    this.fail('deadline_exceeded', this.expiry);

  constructor(
    timeoutMs: number,
    private readonly caller?: AbortSignal,
  ) {
    this.failed = new Promise<never>((_resolve, reject) =>
      this.controller.signal.addEventListener('abort', () => {
        if (this.failure) reject(this.failure);
      }),
    );
    this.failed.catch(ignore);
    this.arm(timeoutMs, TIMED_OUT);
    caller?.addEventListener('abort', this.onAbort, { once: true });
    if (caller?.aborted) this.onAbort();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  remainingMs(): number {
    return Math.max(1, Math.ceil(this.expiresAt - performance.now()));
  }

  isBeforeExpiration(): boolean {
    return !this.failure && performance.now() < this.expiresAt;
  }

  /** Once a failure wins, `late` owns the still-settling call. */
  async run<V>(
    call: (signal: AbortSignal) => PromiseLike<V>,
    redact: Redact,
    late?: (pending: Promise<V>) => void,
  ): Promise<V> {
    if (performance.now() >= this.expiresAt) this.expire();
    const { failure } = this;
    if (failure) throw failure;
    const pending = new Promise<V>((resolve) =>
      resolve(call(this.controller.signal)),
    );
    pending.catch(ignore);
    try {
      const value = await Promise.race([pending, this.failed]);
      if (performance.now() >= this.expiresAt) this.expire();
      if (!this.failure) return value;
    } catch (error) {
      if (performance.now() >= this.expiresAt) this.expire();
      if (!this.failure) throw redact(error);
    }
    late?.(pending);
    throw this.failure ?? redact(undefined);
  }

  /**
   * Runs `call` under its own budget instead of the shared one, whose clock
   * stops meanwhile; caller abort still applies. Expiry fails the whole
   * deadline with `expiry`.
   */
  async runOwnBudget<V>(
    budgetMs: number,
    expiry: string,
    call: (signal: AbortSignal) => PromiseLike<V>,
    redact: Redact,
  ): Promise<V> {
    if (performance.now() >= this.expiresAt) this.expire();
    if (this.failure) throw this.failure;
    const remaining = this.expiresAt - performance.now();
    this.arm(budgetMs, expiry);
    try {
      return await this.run(call, redact);
    } finally {
      if (!this.failure) this.arm(remaining, TIMED_OUT);
    }
  }

  async sleep(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (): Promise<void> =>
      new Promise((resolve) => (timer = setTimeout(resolve, ms)));
    try {
      await this.run(wait, fixed('Core startup failed.'));
    } finally {
      clearTimeout(timer);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.caller?.removeEventListener('abort', this.onAbort);
  }

  private arm(ms: number, expiry: string): void {
    clearTimeout(this.timer);
    this.expiry = expiry;
    this.expiresAt = performance.now() + ms;
    this.timer = setTimeout(this.expire, ms);
  }

  private fail(kind: 'cancelled' | 'deadline_exceeded', message: string): void {
    if (this.failure) return;
    this.failure = canopyConnectError(kind, message);
    this.controller.abort(this.failure);
  }
}

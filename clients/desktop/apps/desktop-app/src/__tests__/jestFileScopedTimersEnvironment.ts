import { promisify } from 'node:util';
import { TestEnvironment } from 'jest-environment-node';

const noop = (): void => undefined;

/**
 * Jest runs many test files in one worker process, and a file's teardown
 * leaves the real timers it armed running. An unref'd debounce, such as the
 * observability service's flush, then fires while a later file in the worker
 * runs: it writes with the earlier file's data root, through the `node:fs`
 * module every file in the worker shares, so a golden guarding its own data
 * root sees a write it never made (CAN-7662). Cancel a file's pending timers
 * when its environment tears down, and any it arms afterwards, as if each file
 * ran in its own process.
 */
export default class FileScopedTimersEnvironment extends TestEnvironment {
  private readonly pending = new Set<NodeJS.Timeout>();
  private ended = false;

  constructor(...args: ConstructorParameters<typeof TestEnvironment>) {
    super(...args);
    const { pending } = this;
    const ended = (): boolean => this.ended;

    function setFileTimeout(
      callback: unknown,
      delay?: number,
      ...args: unknown[]
    ): NodeJS.Timeout {
      if (typeof callback !== 'function') {
        Reflect.apply(setTimeout, undefined, [callback, delay, ...args]);
        throw new TypeError('The "callback" argument must be a function.');
      }
      if (ended()) {
        const timer = setTimeout(noop, delay);
        clearTimeout(timer);
        return timer;
      }
      const timer = setTimeout(
        function (this: unknown, ...callbackArgs: unknown[]): void {
          pending.delete(timer);
          Reflect.apply(callback, this, callbackArgs);
        },
        delay,
        ...args,
      );
      pending.add(timer);
      return timer;
    }

    function setFileInterval(
      callback: unknown,
      delay?: number,
      ...args: unknown[]
    ): NodeJS.Timeout {
      if (typeof callback !== 'function') {
        Reflect.apply(setInterval, undefined, [callback, delay, ...args]);
        throw new TypeError('The "callback" argument must be a function.');
      }
      if (ended()) {
        const timer = setInterval(noop, delay);
        clearInterval(timer);
        return timer;
      }
      const timer = setInterval(
        function (this: unknown, ...callbackArgs: unknown[]): void {
          Reflect.apply(callback, this, callbackArgs);
        },
        delay,
        ...args,
      );
      pending.add(timer);
      return timer;
    }

    const clearFileTimer = (
      timer: NodeJS.Timeout | string | number | undefined,
    ): void => {
      if (typeof timer === 'object' && timer !== null) pending.delete(timer);
      clearTimeout(timer);
    };

    Object.defineProperty(setFileTimeout, promisify.custom, {
      value: Reflect.get(setTimeout, promisify.custom),
    });
    const fileTimers = {
      setTimeout: setFileTimeout,
      setInterval: setFileInterval,
      clearTimeout: clearFileTimer,
      clearInterval: clearFileTimer,
    };
    Object.assign(this.global, fileTimers);
    // Legacy fake timers saved the real APIs before this constructor replaced
    // them, and useRealTimers() would put those back untracked.
    const legacyApis: unknown =
      this.fakeTimers === null
        ? undefined
        : Reflect.get(this.fakeTimers, '_timerAPIs');
    if (typeof legacyApis !== 'object' || legacyApis === null) {
      throw new Error(
        'jest LegacyFakeTimers no longer exposes _timerAPIs; update jestFileScopedTimersEnvironment.',
      );
    }
    Object.assign(legacyApis, fileTimers);
  }

  override async teardown(): Promise<void> {
    this.ended = true;
    for (const timer of this.pending) clearTimeout(timer);
    this.pending.clear();
    await super.teardown();
  }
}

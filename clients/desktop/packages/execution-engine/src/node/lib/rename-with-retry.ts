import { rename } from 'node:fs/promises';

const RENAME_RETRY_DELAYS_MS = [50, 100, 150, 200, 250] as const;

export interface RenameWithRetryOptions {
  /** Delays before each retry after a transient sharing violation. */
  retryDelaysMs?: readonly number[];
  /**
   * Runs after each retry delay, before the next attempt. A throw aborts
   * without renaming, so a commit fence checked before the first attempt
   * also holds across the backoff.
   */
  beforeRetry?: () => void | Promise<void>;
}

/** Retry transient sharing violations without ever deleting the destination. */
export async function renameWithRetry(
  source: string,
  target: string,
  options?: RenameWithRetryOptions,
): Promise<void> {
  const retryDelaysMs = options?.retryDelaysMs ?? RENAME_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code: unknown =
        error !== null && typeof error === 'object'
          ? Reflect.get(error, 'code')
          : undefined;
      const delay = retryDelaysMs[attempt];
      if (
        delay === undefined ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(String(code))
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      await options?.beforeRetry?.();
    }
  }
}

import { safeErrorProperty } from '@canopy/desktop-shared/ipc/app-error-rejection';
import { AppErrorSchema, type AppError } from '@canopy/protocol/app-errors';

/**
 * The shape main built for a caught IPC rejection, matched by message text.
 * Best effort: same-message failures resolve to the newest shape, and expiry or
 * eviction cause misses, so use this only for recording and presentation, never
 * authorization or correctness-critical branching. A miss returns undefined; a
 * bridge failure throws to the guard in `resolveClientAppError`.
 */
export function resolveIpcAppError(value: unknown): AppError | undefined {
  // A failure main already recorded, carried by a resolved result as its
  // `appError`: it is its own shape, and no rejection cache holds it.
  const carried = AppErrorSchema.safeParse(value);
  if (carried.success && carried.data.recordedBy !== undefined)
    return carried.data;
  const message = safeErrorProperty(value, 'message');
  if (typeof message !== 'string') return undefined;
  const parsed = AppErrorSchema.safeParse(window.appErrors?.resolve(message));
  return parsed.success ? parsed.data : undefined;
}

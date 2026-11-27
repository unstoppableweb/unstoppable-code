import { isPairedComputerId } from '@canopy/protocol/authority-qualified-id';

const PAIRED_TARGET_ID_KEYS = new Set([
  'projectId',
  'worktreeId',
  'chatId',
  'taskId',
]);

const PAIRED_TARGET_ARRAY_KEYS = new Set(['targets', 'scopes', 'entries']);

/**
 * Returns true when a local Electron IPC request carries a paired-computer
 * authority-qualified project, worktree, or chat ID (`computer-<deviceId>:...`).
 * Non-paired requests fail the prefix check immediately and pass through unchanged.
 */
export function hasPairedComputerTarget(request: unknown): boolean {
  if (typeof request === 'string') {
    return isPairedComputerId(request);
  }
  if (Array.isArray(request)) {
    return request.some(hasPairedComputerTarget);
  }
  if (typeof request !== 'object' || request === null) {
    return false;
  }
  for (const [key, value] of Object.entries(request)) {
    if (
      PAIRED_TARGET_ID_KEYS.has(key) &&
      typeof value === 'string' &&
      isPairedComputerId(value)
    ) {
      return true;
    }
    if (
      PAIRED_TARGET_ARRAY_KEYS.has(key) &&
      Array.isArray(value) &&
      value.some(hasPairedComputerTarget)
    ) {
      return true;
    }
  }
  return false;
}

export function rejectPairedComputerLocalIpc(channel: string): Promise<never> {
  return Promise.reject(
    Object.assign(
      new Error(
        `Local IPC ${channel} is not available for paired computer scopes.`,
      ),
      { code: 'capability_unavailable' as const },
    ),
  );
}

import {
  isW5CommitLogWorkerData,
  type W5CommitLogHostWorkerData,
} from '@canopy/core-runtime/node/w5/commit-log/worker-contract';

// Typed, so a rename on the host's side fails to compile here.
const ADDON_FIELD =
  'confinementAddon' satisfies keyof W5CommitLogHostWorkerData;

/**
 * The worker data `W5CommitLogHost` starts the daemon's W5 worker with: the
 * portable data and, on win32, the confinement addon's path. Mirrors the
 * desktop's `isDesktopW5CommitLogWorkerData`; folding both into core-runtime
 * is a follow-up.
 */
export function isDaemonW5CommitLogWorkerData(
  value: unknown,
): value is W5CommitLogHostWorkerData {
  if (!isW5CommitLogWorkerData(value)) return false;
  const addon: unknown = Reflect.get(value, ADDON_FIELD);
  return addon === undefined || typeof addon === 'string';
}

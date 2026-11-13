import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { acquireW5DesktopDeleteGate } from '@canopy/core-platform/w5-process-file-lock';
import {
  registerW5Host,
  W5HostCohortRefusedError,
  type W5HostRegistrationOptions,
} from '@canopy/execution-engine/node/w5-host-cohort';

/*
 * TRANSITIONAL (CAN-3797 W11-2): Electron main's membership in the W5 host
 * cohort, and the admission its W5 writers wait for. Membership lasts until
 * process death; there is no release path. Remove when the W5 rows move to
 * `daemon` and the legacy Electron writers are deleted (CAN-3795 / CAN-3802).
 *
 * Deletion presence must succeed before cohort registration. Within the
 * cohort, only `maintenance-held` stops the app. A registration failure that also
 * stops maintenance on that root (a linked or non-private runtime folder, no
 * hard links; see w5-maintenance.ts) admits writers unregistered, like the
 * legacy writers. Any other failure refuses writers until a retry registers.
 */

/** Test seams; production composition passes none. */
type DesktopW5HostSeams = Pick<
  W5HostRegistrationOptions,
  'inspect' | 'retryDelaysMs'
>;

/** A root maintenance cannot run on, so its writers need no membership. */
type MaintenanceBlocked = 'runtime-not-private' | 'no-hard-links';

type DesktopW5HostAdmission =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'unregistered'; readonly reason: MaintenanceBlocked }
  /** Deletion presence or maintenance admission refuses: the app does not start. */
  | {
      readonly kind: 'refused';
      readonly message: string;
      readonly error: W5HostCohortRefusedError;
    }
  /** Writers refuse; the next admission retries registration. */
  | { readonly kind: 'failed'; readonly error: W5HostCohortRefusedError };

let startup: Promise<DesktopW5HostAdmission> | undefined;
// Never close on renderer reload or cohort failure: presence ends at process death.
const deletionPresence = new Map<string, Promise<{ close(): void }>>();

/** Lifetime presence also protects roots shared with a differently selected CLI. */
export async function admitDesktopDeletionPresence(
  dataRoot: string,
): Promise<void> {
  const root = await realpath(dataRoot).catch((error: unknown) => {
    if (property(error, 'code') !== 'ENOENT') throw error;
    return resolve(dataRoot);
  });
  let admission = deletionPresence.get(root);
  if (!admission) {
    admission = acquireW5DesktopDeleteGate(root, 'desktop');
    deletionPresence.set(root, admission);
  }
  try {
    await admission;
  } catch (error) {
    if (deletionPresence.get(root) === admission) deletionPresence.delete(root);
    throw error;
  }
}

function property(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

function underlyingOf(error: unknown): unknown {
  return error instanceof W5HostCohortRefusedError ? error.underlying : error;
}

/** Errnos of a filesystem without hard links (FAT, exFAT, some SMB mounts). */
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS']);

/**
 * Re-checks what maintenance itself requires of `runtime`: a real, owned,
 * owner-only directory, and `link()` for its record. `null` when the failure
 * proves nothing about maintenance (transient I/O, an unknown error).
 */
async function maintenanceBlockedBy(
  root: string,
  error: unknown,
): Promise<MaintenanceBlocked | null> {
  const underlying = underlyingOf(error);
  if (
    property(underlying, 'syscall') === 'link' &&
    NO_HARD_LINKS.has(String(property(underlying, 'code')))
  )
    return 'no-hard-links';
  const runtime = join(root, 'runtime');
  try {
    const stat = await lstat(runtime);
    if (
      !stat.isDirectory() ||
      (await realpath(runtime)) !== runtime ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      return 'runtime-not-private';
  } catch {
    return null;
  }
  return null;
}

/** Present or unreadable: a failed registration cannot rule maintenance out. */
async function maintenanceRecordMayExist(root: string): Promise<boolean> {
  try {
    await lstat(join(root, 'runtime', 'w5-maintenance.json'));
    return true;
  } catch (error) {
    const code = property(error, 'code');
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

/**
 * Joins the cohort for a data root this process writes. Idempotent per
 * canonical root; refuses `maintenance-held` after a brief retry. A failure
 * is never cached, so the next call registers again.
 */
export async function registerDesktopW5Root(
  dataRoot: string,
  seams: DesktopW5HostSeams = {},
): Promise<DesktopW5HostAdmission> {
  try {
    await admitDesktopDeletionPresence(dataRoot);
  } catch (error) {
    const refusal = new W5HostCohortRefusedError('runtime-unavailable', error);
    return {
      kind: 'refused',
      message: error instanceof Error ? error.message : refusal.message,
      error: refusal,
    };
  }
  try {
    await registerW5Host({ dataRoot, hostKind: 'electron', ...seams });
    return { kind: 'admitted' };
  } catch (error) {
    if (
      error instanceof W5HostCohortRefusedError &&
      error.reason === 'maintenance-held'
    )
      return { kind: 'refused', message: error.message, error };
    const root = await realpath(dataRoot).catch(() => resolve(dataRoot));
    if (await maintenanceRecordMayExist(root)) {
      const held = new W5HostCohortRefusedError('maintenance-held', error);
      return { kind: 'refused', message: held.message, error: held };
    }
    const blocked = await maintenanceBlockedBy(root, error);
    // No message or path: the underlying error can name the data folder.
    // eslint-disable-next-line no-console
    console.warn('W5 host registration failed.', {
      reason:
        error instanceof W5HostCohortRefusedError ? error.reason : 'unexpected',
      code: property(underlyingOf(error), 'code'),
      writers: blocked ? `admitted unregistered (${blocked})` : 'refused',
    });
    if (blocked) return { kind: 'unregistered', reason: blocked };
    return {
      kind: 'failed',
      error:
        error instanceof W5HostCohortRefusedError
          ? error
          : new W5HostCohortRefusedError('runtime-unavailable', error),
    };
  }
}

/**
 * Startup registration at the top of `whenReady`, before anything reads or
 * writes W5. Only the first call registers; later calls share its outcome.
 */
export function admitDesktopW5Host(
  dataRoot: string,
  seams: DesktopW5HostSeams = {},
): Promise<DesktopW5HostAdmission> {
  startup ??= registerDesktopW5Root(dataRoot, seams);
  return startup;
}

/**
 * The default commit-log host's gate, run before each worker start. Waits
 * for startup registration, so an early call never races it, and refuses
 * before it ran or after it refused. Otherwise it registers `dataRoot` again,
 * a no-op once registered, so a failed registration retries here.
 */
export async function desktopW5HostAdmission(dataRoot: string): Promise<void> {
  if (!startup) throw new W5HostCohortRefusedError('unregistered-writer');
  const first = await startup;
  if (first.kind === 'refused') throw first.error;
  const current = await registerDesktopW5Root(dataRoot);
  if (current.kind === 'refused') throw current.error;
  if (current.kind === 'failed') throw current.error;
}

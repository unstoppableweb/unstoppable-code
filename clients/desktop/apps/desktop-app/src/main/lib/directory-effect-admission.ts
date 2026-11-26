import {
  lstat,
  mkdir,
  open,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import {
  writeFileAtomically,
  type AtomicFileWriteOptions,
} from '@canopy/execution-engine/node/lib/atomic-file';
import { logMainProcessWarn } from './main-process-logging';
import { dirname, resolve, sep } from 'node:path';

interface Boundary {
  epoch: number;
  owners: Set<symbol>;
  /** Owners whose removal has no answer yet. */
  uncertain: Set<symbol>;
}

export interface DirectoryEffectAdmission {
  readonly directory: string;
  readonly epoch: number;
}

export type DirectoryDeletionOutcome =
  | 'abandoned'
  | 'removed'
  | 'cleanup-debt'
  | 'uncertain';

const boundaries = new Map<string, Boundary>();
let epoch = 0;

function contains(parent: string, child: string): boolean {
  return parent === child || child.startsWith(`${parent}${sep}`);
}

export function captureDirectoryEffects(
  directory: string,
): DirectoryEffectAdmission {
  return { directory: resolve(directory), epoch };
}

/** Whether a deletion over the directory began or settled since capture. */
export function directoryDeletionSince(
  admission: DirectoryEffectAdmission,
): boolean {
  for (const [directory, boundary] of boundaries)
    if (
      contains(directory, admission.directory) &&
      boundary.epoch > admission.epoch
    )
      return true;
  return false;
}

/** Check at execution. Releasing a deletion never revalidates an old callback. */
function epochCurrent(admission: DirectoryEffectAdmission): boolean {
  if (directoryDeletionSince(admission)) return false;
  for (const [directory, boundary] of boundaries)
    if (contains(directory, admission.directory) && boundary.owners.size > 0)
      return false;
  return true;
}

export const DIRECTORY_EFFECT_DRAIN_BOUND_MS = 2_000;

interface IssuedEffect {
  admission: DirectoryEffectAdmission;
  settled: Promise<void>;
  /** Set by the first drain: later drains never grant the effect a new window. */
  drainDeadline?: number;
}
const issued = new Set<IssuedEffect>();

export function directoryEffectsAdmitted(
  admission: DirectoryEffectAdmission,
): boolean {
  return epochCurrent(admission);
}

/** Only issued local filesystem work, never RPCs, outbox IO or queued callbacks. */
export async function drainDirectoryEffects(directory: string): Promise<void> {
  const target = resolve(directory);
  const now = Date.now();
  const pending = Array.from(issued).filter((effect) =>
    contains(target, effect.admission.directory),
  );
  const timers: ReturnType<typeof setTimeout>[] = [];
  await Promise.all(
    pending.map((effect) => {
      effect.drainDeadline ??= now + DIRECTORY_EFFECT_DRAIN_BOUND_MS;
      const remaining = effect.drainDeadline - now;
      if (remaining <= 0) return Promise.resolve();
      return Promise.race([
        effect.settled,
        new Promise<void>((resolve) => {
          timers.push(setTimeout(resolve, remaining));
        }),
      ]);
    }),
  );
  for (const timer of timers) clearTimeout(timer);
}

export async function directoryRemovalOutcome(
  directory: string,
): Promise<'removed' | 'cleanup-debt'> {
  try {
    await lstat(directory);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return 'removed';
  }
  return 'cleanup-debt';
}

function codeOf(error: unknown): unknown {
  return error !== null && typeof error === 'object'
    ? Reflect.get(error, 'code')
    : undefined;
}

/** Unknown counts as present: an uncompensated install leaks, never loses. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return codeOf(error) !== 'ENOENT';
  }
}

/**
 * Inode numbers are reused at once on Linux, and birthtimes are coarse or
 * absent there: only an inode this lease still holds open proves the path
 * names what it created. Anything else is a possible successor's, and leaks.
 */
async function stillPinned(pin: FileHandle, path: string): Promise<boolean> {
  const [pinned, current] = await Promise.all([
    pin.stat({ bigint: true }),
    lstat(path, { bigint: true }),
  ]);
  return pinned.dev === current.dev && pinned.ino === current.ino;
}

async function pin(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, 'r');
  } catch {
    return undefined;
  }
}

export interface DirectoryMutationLease {
  mkdir: (directory: string) => Promise<void>;
  install: (
    path: string,
    bytes: string,
    options: AtomicFileWriteOptions,
  ) => Promise<void>;
  rename: (source: string, target: string) => Promise<void>;
}

/**
 * An async mutation owns only the files and empty folders it newly created and
 * identified while still admitted, never what it renames or replaces.
 */
export function mutateDirectory(
  admission: DirectoryEffectAdmission,
  write: (lease: DirectoryMutationLease) => Promise<void>,
  stillOwned: () => boolean = () => true,
): Promise<boolean> {
  return runDirectoryMutation(
    admission,
    () => directoryEffectsAdmitted(admission) && stillOwned(),
    () => epochCurrent(admission) && stillOwned(),
    write,
  );
}

async function runDirectoryMutation(
  admission: DirectoryEffectAdmission,
  admit: () => boolean,
  current: () => boolean,
  write: (lease: DirectoryMutationLease) => Promise<void>,
): Promise<boolean> {
  if (!admit()) return false;
  let finish: () => void = () => undefined;
  const effect: IssuedEffect = {
    admission,
    settled: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  };
  issued.add(effect);
  const files = new Map<string, FileHandle>();
  const directories = new Map<string, FileHandle>();
  const check = (): void => {
    if (!current()) throw new Error('Directory metadata admission revoked');
  };
  try {
    await write({
      async mkdir(directory) {
        check();
        const first = await mkdir(directory, { recursive: true });
        if (first !== undefined) {
          for (
            let path = resolve(directory);
            contains(resolve(first), path);
            path = dirname(path)
          ) {
            const handle = await pin(path);
            // A lookup that revocation crossed may see a successor's folder.
            if (!current()) {
              await handle?.close();
              break;
            }
            if (handle) directories.set(path, handle);
            if (path === resolve(first)) break;
          }
        }
        check();
      },
      async install(path, bytes, options) {
        check();
        // Unlinking a replacement would lose the bytes it replaced as well.
        const creates = !(await pathExists(path));
        await writeFileAtomically(path, bytes, {
          ...options,
          beforeInstall: async (temporaryPath) => {
            await options.beforeInstall?.(temporaryPath);
            // A rename retry installs the same staged inode.
            if (creates && !files.has(path)) {
              const handle = await open(temporaryPath, 'r');
              files.set(path, handle);
            }
            check();
          },
        });
        check();
      },
      // A rename moves bytes the lease did not create: never compensated, so a
      // set-aside copy survives revocation (leak, never lose).
      async rename(source, target) {
        check();
        await rename(source, target);
        check();
      },
    });
    check();
    return true;
  } catch (error) {
    if (current()) throw error;
    return false;
  } finally {
    // A revoked lease may outlive the deletion bound. Never recursively remove:
    // other data and changed inodes belong to somebody else (leak, never block).
    const revoked = !current();
    for (const [path, handle] of files) {
      try {
        if (revoked && (await stillPinned(handle, path))) await unlink(path);
      } catch (error) {
        if (codeOf(error) !== 'ENOENT')
          logMainProcessWarn('Could not undo retired metadata install');
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    for (const [path, handle] of directories) {
      try {
        if (revoked && (await stillPinned(handle, path))) await rmdir(path);
      } catch (error) {
        if (codeOf(error) !== 'ENOENT')
          logMainProcessWarn('Retired metadata directory retained');
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    issued.delete(effect);
    finish();
  }
}

export function beginDirectoryDeletion(directory: string): {
  settle: (outcome: DirectoryDeletionOutcome) => void;
} {
  const target = resolve(directory);
  const owner = Symbol();
  const boundary = boundaries.get(target) ?? {
    epoch: 0,
    owners: new Set<symbol>(),
    uncertain: new Set<symbol>(),
  };
  boundary.epoch = ++epoch;
  boundary.owners.add(owner);
  boundaries.set(target, boundary);
  return {
    settle(outcome) {
      if (!boundary.owners.has(owner)) return;
      boundary.epoch = ++epoch;
      // Only uncertainty keeps exclusion. Settled deletion never refuses reuse;
      // old callbacks remain revoked by the epoch. A process restart clears
      // unresolved local owners; boot retirement replay acquires no new fence.
      if (outcome === 'uncertain') {
        boundary.uncertain.add(owner);
        return;
      }
      boundary.owners.delete(owner);
      boundary.uncertain.delete(owner);
      // A later removal of the same directory answers every unanswered one.
      if (outcome !== 'abandoned') answer(boundary);
    },
  };
}

function answer(boundary: Boundary): void {
  for (const owner of boundary.uncertain) boundary.owners.delete(owner);
  boundary.uncertain.clear();
  boundary.epoch = ++epoch;
}

/** For proof that no unanswered removal of the directory ever applied. */
export function answerUncertainDirectoryDeletions(directory: string): void {
  const boundary = boundaries.get(resolve(directory));
  if (boundary) answer(boundary);
}

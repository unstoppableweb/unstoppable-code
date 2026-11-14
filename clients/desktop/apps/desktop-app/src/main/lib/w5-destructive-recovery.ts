import { getCanopyDataDir } from '@canopy/desktop-shared/canopy-paths';
import {
  archiveRecoveryStore,
  assertNoArchiveResolution,
} from './archive-recovery-refs';
import {
  destructiveFailureCode,
  rememberDestructiveFailure,
} from './destructive-failure-context';
import { canonicalizePossiblyMissingPath } from './worktree-registration-removal';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, relative } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { RmOptions, Stats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  rmdir,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import {
  LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL,
  LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN,
  LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
} from '@canopy/protocol/portal/lifecycle-journal';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { syncDirectory } from '@canopy/execution-engine/node/lib/atomic-file';
import { writeFileAtomically } from './atomic-file';
import {
  getW5DestructiveLifecycleDir,
  getWorkspaceDir,
  getWorkspaceWorktreeDir,
  getWorktreeDataDir,
} from './paths';
import { logMainProcessWarn } from './main-process-logging';
import { createSerialQueue } from './w5-file-store';

export const destructiveArchiveOutcomeSchema = z.object({
  success: z.boolean(),
  warnings: z.array(z.string()),
  removedTemporaryWorkspaceId: z.string().optional(),
  removedTemporaryWorkspaceName: z.string().optional(),
});

import {
  journalSchema,
  isArchiveCleanupPhase,
  readDestructiveJournal,
  type DestructiveRecoveryRecord,
  type ArchiveTrigger,
} from '@canopy/desktop-shared/node/w5-destructive-journal';
export type { DestructiveRecoveryRecord } from '@canopy/desktop-shared/node/w5-destructive-journal';
interface Lifecycle {
  record: DestructiveRecoveryRecord;
  exactJournal?: ExactArchiveJournal;
  checkIdentity: () => Promise<void>;
  queue: ReturnType<typeof createSerialQueue>;
  failed: boolean;
  canonicalRemoved: boolean;
  resumingArchiveCleanup: boolean;
  beforeEffects?: () => void;
  active: boolean;
  previous?: DestructiveRecoveryRecord;
  /** What the journal path held before this lifecycle; absent for a resumed cleanup. */
  journalBefore?: { record: DestructiveRecoveryRecord | null };
  /** Inside {@link runStepFreeChildLifecycles}. */
  childrenStepFree: boolean;
  /** {@link withdrawStepFreeJournal} ran; a failed withdrawal is not retried. */
  withdrawalAttempted: boolean;
  parent?: Lifecycle;
  parentStep?: DestructiveRecoveryRecord['steps'][number];
  /**
   * A recreated empty metadata directory a resumed cleanup took over. Never
   * saved: every check, and every later retry, proves it still holds no files.
   */
  adoptedMetadata?: { path: string; identity: string };
  /** A worktree discard owns this stranded record's copy while it runs. */
  supersedes?: string;
  /** The unfinished journal this lifecycle took over, until its first save. */
  takesOver?: DestructiveRecoveryRecord;
}
const context = new AsyncLocalStorage<Lifecycle>();
const stepFreeFailures = new WeakSet<object>();
function current(): Lifecycle | undefined {
  const lifecycle = context.getStore();
  return lifecycle?.active ? lifecycle : undefined;
}
/** Lifecycles this process is running, across async contexts. */
const running = new Set<Lifecycle>();
/**
 * An unfinished journal is stranded unless this process is still running it.
 * The in-memory state decides: a resumed cleanup tail is `active` before its
 * first save replaces the `recovery-required` journal on disk, and a finishing
 * one is `completed` while its completion save is in flight. Only a lifecycle
 * that has marked itself `recovery-required` is failing.
 */
function isInFlight(record: DestructiveRecoveryRecord): boolean {
  return Array.from(running).some(
    (lifecycle) =>
      lifecycle.active &&
      lifecycle.record.state !== 'recovery-required' &&
      ownsRecord(lifecycle, record),
  );
}
/** No lifecycle of this process owns it, even one still saving its failure. */
function isOwnerless(record: DestructiveRecoveryRecord): boolean {
  return !Array.from(running).some((lifecycle) =>
    ownsRecord(lifecycle, record),
  );
}
function ownsRecord(
  lifecycle: Lifecycle,
  record: DestructiveRecoveryRecord,
): boolean {
  return (
    lifecycle.record.operationId === record.operationId ||
    lifecycle.supersedes === record.operationId
  );
}
/** An ownerless `active` journal: a crash, or a failure whose save failed. */
function isCrashed(record: DestructiveRecoveryRecord): boolean {
  return record.state === 'active' && isOwnerless(record);
}

/**
 * CAN-5011: an ownerless unfinished project deletion journal with only
 * step-free steps, its child archives and resumable steps, over a project
 * directory and protected paths that still match. A crash before its
 * withdrawal, a failed withdrawal, or an earlier version that kept such a
 * journal left it. It refuses nothing, and the next deletion supersedes it.
 */
async function isSupersedableDeletion(
  record: DestructiveRecoveryRecord,
): Promise<boolean> {
  return (
    record.operation === 'workspace-delete' &&
    record.worktreeId === undefined &&
    record.state !== 'completed' &&
    isOwnerless(record) &&
    record.steps.every(
      (step) => isStepFreeStep(step) || isPreUpgradeRetainedGitCleanup(step),
    ) &&
    isRecordedProjectDirectory(
      await projectDirectoryIdentity(record.workspaceId),
      record.directoryIdentity,
    ) &&
    (await areOwnedPathsUnreplaced(record))
  );
}

/**
 * Builds before CAN-5011 recorded this step without the `resumable` marker;
 * the archive's own journal resumes its work either way. This build records it
 * unmarked only after an ordinary step, which still refuses. Not in
 * {@link isStepFreeStep}: worktree lifecycles take this phase as an ordinary
 * step.
 */
function isPreUpgradeRetainedGitCleanup(
  step: DestructiveRecoveryRecord['steps'][number],
): boolean {
  return (
    step.phase === 'retained-git-cleanup' &&
    step.resumable === undefined &&
    step.state !== 'failed'
  );
}

/** Each protected path still has its recorded identity, or is absent; never an unverifiable one. */
export async function areOwnedPathsUnreplaced(
  record: DestructiveRecoveryRecord,
): Promise<boolean> {
  for (const owned of record.ownedPaths) {
    const actual = await directoryIdentity(owned.path);
    if (actual !== null && actual !== owned.identity) return false;
  }
  return true;
}

function journalDirectory(): string {
  return getW5DestructiveLifecycleDir();
}

/**
 * CAN-5335: journal scans, the quarantine inspection and this module's journal
 * writes share access; a quarantine move holds it alone, so no scan sees an
 * entry missing mid-move and no save lands inside the move. Shared access
 * waits only for a running move, never a pending one, so nested shared access
 * cannot deadlock. The exclusive work must not take shared access.
 */
const journalAccess: {
  shared: number;
  exclusive?: Promise<void>;
  drained: Array<() => void>;
} = { shared: 0, drained: [] };
async function withSharedJournalAccess<T>(work: () => Promise<T>): Promise<T> {
  while (journalAccess.exclusive) await journalAccess.exclusive;
  journalAccess.shared += 1;
  try {
    return await work();
  } finally {
    journalAccess.shared -= 1;
    if (journalAccess.shared === 0)
      for (const resolve of journalAccess.drained.splice(0)) resolve();
  }
}
export function withSharedLifecycleJournalAccess<T>(
  work: () => Promise<T>,
): Promise<T> {
  return withSharedJournalAccess(work);
}
export async function withExclusiveLifecycleJournalAccess<T>(
  work: () => Promise<T>,
): Promise<T> {
  for (;;) {
    if (journalAccess.exclusive) await journalAccess.exclusive;
    else if (journalAccess.shared > 0)
      await new Promise<void>((resolve) => journalAccess.drained.push(resolve));
    else break;
  }
  let release = (): void => {};
  journalAccess.exclusive = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    return await work();
  } finally {
    journalAccess.exclusive = undefined;
    release();
  }
}
function journalPath(workspaceId: string, worktreeId?: string): string {
  const key = createHash('sha256')
    .update(JSON.stringify([workspaceId, worktreeId ?? null]))
    .digest('hex');
  return join(journalDirectory(), `${key}.json`);
}
function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
async function directoryStats(path: string): Promise<Stats | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw recoveryRequired();
    return stat;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
function statIdentity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}
/** Stat identity only: Linux can give a directory recreated at `path` the same one (CAN-5024). */
async function directoryIdentity(path: string): Promise<string | null> {
  const stat = await directoryStats(path);
  return stat && statIdentity(stat);
}

/**
 * CAN-5024: the project directory's identity adds the token of a marker file
 * it keeps, which a directory recreated there lacks even when it reuses the
 * removed one's inode and birth time. `create` adds the marker, before
 * effects; comparisons only read it.
 */
export const INCARNATION_MARKER = '.w5-incarnation';
async function projectDirectoryIdentity(
  workspaceId: string,
  create = false,
): Promise<string | null> {
  const path = getWorkspaceDir(workspaceId);
  const stat = await directoryStats(path);
  if (!stat) return null;
  const token =
    (await readIncarnationToken(path)) ??
    (create ? await createIncarnationToken(path) : null);
  // An existing link may belong to a concurrent or previously failed publisher.
  if (create) await syncDirectory(path);
  return token ? `${statIdentity(stat)}:${token}` : statIdentity(stat);
}
/** A journal from before CAN-5024 recorded no token and keeps comparing on stat alone. */
function isRecordedProjectDirectory(
  actual: string | null,
  recorded: string | null,
): boolean {
  if (actual === null || recorded === null) return actual === recorded;
  return recorded.split(':').length === 3
    ? actual.split(':').slice(0, 3).join(':') === recorded
    : actual === recorded;
}
async function readIncarnationToken(directory: string): Promise<string | null> {
  const marker = join(directory, INCARNATION_MARKER);
  try {
    if (!(await lstat(marker)).isFile()) throw recoveryRequired();
    const token = await readFile(marker, 'utf8');
    if (!z.string().uuid().safeParse(token).success) throw recoveryRequired();
    return token;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
/** Publish a complete, synced file without replacing a concurrent lifecycle's token. */
async function createIncarnationToken(
  directory: string,
  token: string = randomUUID(),
): Promise<string> {
  const staged = join(directory, `${INCARNATION_MARKER}.${token}`);
  const handle = await open(staged, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(token);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(staged, join(directory, INCARNATION_MARKER)).catch(
      (error: unknown) => {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
      },
    );
  } finally {
    await rm(staged, { force: true });
  }
  const adopted = await readIncarnationToken(directory);
  if (!adopted) throw recoveryRequired();
  return adopted;
}
function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

/**
 * CAN-5024: protected paths include user checkouts and managed clones, which
 * never take a marker. Linux can give a directory recreated at one the removed
 * one's inode, and its birth time until the filesystem clock ticks. A probe
 * directory on the same device must be born later than the target sampled
 * after that probe. Every subsequent directory is then born later too,
 * assuming the realtime clock does not step back. Otherwise the identity is
 * unverifiable and a resume over the present path refuses:
 * filesystems without birth times, such as NFS and older ext4, lose that
 * resume and need manual recovery. The recording lifecycle still compares
 * the stat identity while it runs.
 */
const UNVERIFIABLE_IDENTITY = 'unverifiable:';
/** Covers coarse timestamp ticks; only a path born just before protection waits. */
const BIRTH_ORDER_TIMEOUT_MS = 1_000;
const BIRTH_ORDER_RETRY_MS = 10;
async function protectedPathIdentity(
  path: string,
  workspaceId: string,
): Promise<string | null> {
  const { stat, verified } = await isBornBeforeLaterDirectories(
    path,
    getWorkspaceDir(workspaceId),
  );
  if (!stat) return null;
  return verified
    ? statIdentity(stat)
    : `${UNVERIFIABLE_IDENTITY}${statIdentity(stat)}`;
}
/** Probes in the Canopy-owned `probeParent` and removes each probe. */
async function isBornBeforeLaterDirectories(
  path: string,
  probeParent: string,
  readStats: (path: string) => Promise<Stats | null> = directoryStats,
): Promise<{ stat: Stats | null; verified: boolean }> {
  let stat = await readStats(path);
  if (!stat || !(stat.birthtimeMs > 0)) return { stat, verified: false };
  const deadline = performance.now() + BIRTH_ORDER_TIMEOUT_MS;
  for (;;) {
    const probe = join(probeParent, `.w5-birth-order-${randomUUID()}`);
    let born: Stats;
    let created = false;
    try {
      await mkdir(probe);
      created = true;
      born = await lstat(probe);
    } catch {
      return { stat, verified: false };
    } finally {
      if (created)
        await rmdir(probe).catch((error: unknown) => {
          if (!missing(error)) throw error;
        });
    }
    // Probe first: after a successful proof, directories born after this stat cannot match it.
    stat = await readStats(path);
    if (!stat || !(stat.birthtimeMs > 0) || born.dev !== stat.dev)
      return { stat, verified: false };
    if (born.birthtimeMs > stat.birthtimeMs) return { stat, verified: true };
    if (performance.now() >= deadline) return { stat, verified: false };
    // With valid same-device birth times, only a target born within a filesystem
    // tick of protection waits; an older target passes the first probe.
    await new Promise<void>((resolve) =>
      setTimeout(resolve, BIRTH_ORDER_RETRY_MS),
    );
  }
}
/** What the lifecycle that recorded a protected path compares while it runs. */
function recordedStatIdentity(identity: string | null): string | null {
  return identity?.startsWith(UNVERIFIABLE_IDENTITY)
    ? identity.slice(UNVERIFIABLE_IDENTITY.length)
    : identity;
}
function recoveryRequired(
  record?: DestructiveRecoveryRecord,
  check = 'destructive-lifecycle-state',
): W5CommitRefusedError {
  const error = new W5CommitRefusedError(
    'recovery-required',
    'An interrupted destructive operation needs manual recovery. Preserve remaining files and inspect the lifecycle journal.',
    {
      phase: 'destructive-lifecycle',
      check,
      ...(record
        ? { operationId: record.operationId, operation: record.operation }
        : {}),
    },
  );
  if (record) rememberDestructiveFailure(error, record);
  return error;
}

/**
 * CAN-5335: an unattributable refusal, distinct from {@link recoveryRequired}.
 * It names the entry and its stat identity so the user can quarantine it.
 */
async function unreadableJournalEntry(
  name: string,
): Promise<W5CommitRefusedError> {
  let stat: Stats;
  try {
    stat = await lstat(join(journalDirectory(), name));
  } catch (error) {
    // A vanished entry was not unreadable evidence; refuse as before.
    if (missing(error)) return recoveryRequired();
    // EACCES or ENOTDIR: the folder itself can't be searched.
    return journalDirectoryUnreadable();
  }
  return new W5CommitRefusedError(
    'recovery-required',
    LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
    {
      phase: 'lifecycle-journal',
      check: 'unreadable-entry',
      entryName: name,
      entryIdentity: statIdentity(stat),
    },
  );
}
export function journalDirectoryUnreadable(): W5CommitRefusedError {
  return new W5CommitRefusedError(
    'recovery-required',
    LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL,
    { phase: 'lifecycle-journal', check: 'journal-directory-unreadable' },
  );
}

/** Every scanner's parse: any failure refuses for every project. */
async function parseJournalEntry(
  name: string,
): Promise<DestructiveRecoveryRecord> {
  try {
    return await readDestructiveJournal(join(journalDirectory(), name));
  } catch {
    throw await unreadableJournalEntry(name);
  }
}

/**
 * Whether the scanners would refuse on this recognized entry. Missing is
 * neither; any other read or parse failure is unreadable.
 */
export async function lifecycleJournalEntryState(
  name: string,
): Promise<'readable' | 'unreadable' | 'missing'> {
  try {
    journalSchema.parse(
      JSON.parse(await readFile(join(journalDirectory(), name), 'utf8')),
    );
    return 'readable';
  } catch (error) {
    if (missing(error)) {
      // A dangling link at the name still refuses every scanner.
      const stat = await lstat(join(journalDirectory(), name)).catch(
        () => null,
      );
      return stat ? 'unreadable' : 'missing';
    }
    return 'unreadable';
  }
}

/** The hashed slot a project (no worktree) or worktree journal uses. */
export function lifecycleJournalSlotName(
  workspaceId: string,
  worktreeId?: string,
): string {
  return basename(journalPath(workspaceId, worktreeId));
}

/**
 * CAN-5024's birth-order identity for a journal entry of any kind, probed in
 * `probeParent` on the entry's device. `unverifiable:` when unproven.
 */
export async function lifecycleJournalEntryIdentity(
  path: string,
  probeParent: string,
): Promise<{ identity: string; verified: boolean; stat: Stats } | null> {
  const { stat, verified } = await isBornBeforeLaterDirectories(
    path,
    probeParent,
    entryStats,
  );
  if (!stat) return null;
  return {
    identity: verified
      ? journalEntryIdentity(stat)
      : `${UNVERIFIABLE_IDENTITY}${journalEntryIdentity(stat)}`,
    verified,
    stat,
  };
}
/**
 * A file also adds its size and mtime, which a rename keeps, so an in-place
 * rewrite after review reads as changed. A directory's mtime changes with
 * its listing, so its physical identity stands alone.
 */
function journalEntryIdentity(stat: Stats): string {
  return stat.isFile()
    ? `${statIdentity(stat)}:${stat.size}:${stat.mtimeMs}`
    : statIdentity(stat);
}
export function isUnverifiableLifecycleIdentity(identity: string): boolean {
  return identity.startsWith(UNVERIFIABLE_IDENTITY);
}
/** Stat identity without the birth-order proof, for re-checks against a proven one. */
export async function lifecycleJournalEntryStatIdentity(
  path: string,
): Promise<string | null> {
  const stat = await entryStats(path);
  return stat && journalEntryIdentity(stat);
}
async function entryStats(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** Outside the deleted workspace: namespace backups cannot recover erased payloads. */
export interface ExactArchiveJournal {
  record: DestructiveRecoveryRecord;
  persist: (record: DestructiveRecoveryRecord) => Promise<void>;
}

/** The existing journal writer, restricted to a reviewed operation's own copies. */
export function exactArchiveJournal(
  record: DestructiveRecoveryRecord,
  names: readonly string[],
): ExactArchiveJournal {
  const slot = lifecycleJournalSlotName(record.workspaceId, record.worktreeId);
  if (
    record.operation !== 'worktree-archive' ||
    names.length === 0 ||
    names.length > 2 ||
    new Set(names).size !== names.length ||
    names.some((name) => name !== slot && name !== `${record.operationId}.json`)
  )
    throw recoveryRequired(record, 'exact-journal-targets');
  let expected = journalSchema.parse(JSON.parse(JSON.stringify(record)));
  return {
    record,
    persist: (next) =>
      withSharedJournalAccess(async () => {
        for (const name of names) {
          const path = join(journalDirectory(), name);
          const stat = await lstat(path);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            !isDeepStrictEqual(
              journalSchema.parse(JSON.parse(await readFile(path, 'utf8'))),
              expected,
            )
          )
            throw recoveryRequired(next, 'exact-journal-changed');
        }
        // Concurrent best-effort owners may mark debt while this write flushes.
        const serialized = JSON.stringify(next);
        const written = journalSchema.parse(JSON.parse(serialized));
        // A crash between copies leaves conflicting evidence and fails closed on retry.
        for (const name of names)
          await writeFileAtomically(
            join(journalDirectory(), name),
            serialized,
            { durable: true, mode: 0o600 },
          );
        expected = written;
      }),
  };
}

async function save(record: DestructiveRecoveryRecord): Promise<void> {
  const exact = current()?.exactJournal;
  if (exact && exact.record.operationId === record.operationId)
    await exact.persist(record);
  else
    await withSharedJournalAccess(async () => {
      const created = await mkdir(journalDirectory(), {
        recursive: true,
        mode: 0o700,
      });
      if (created) {
        for (
          let directory = journalDirectory();
          ;
          directory = dirname(directory)
        ) {
          await syncDirectory(directory);
          if (directory === dirname(created)) break;
        }
      }
      await writeFileAtomically(
        journalPath(record.workspaceId, record.worktreeId),
        JSON.stringify(record),
        { durable: true, mode: 0o600 },
      );
    });
  if (record.state === 'completed')
    await withExclusiveLifecycleJournalAccess(() =>
      archiveRecoveryStore().normalizeWorkspace(record.workspaceId),
    );
}

export function readDestructiveRecovery(
  workspaceId: string,
  worktreeId?: string,
): Promise<DestructiveRecoveryRecord | null> {
  return withSharedJournalAccess(() =>
    readSlotRecovery(workspaceId, worktreeId),
  );
}
async function readSlotRecovery(
  workspaceId: string,
  worktreeId?: string,
): Promise<DestructiveRecoveryRecord | null> {
  const name = lifecycleJournalSlotName(workspaceId, worktreeId);
  let text: string;
  try {
    text = await readFile(join(journalDirectory(), name), 'utf8');
  } catch (error) {
    if (missing(error)) return null;
    // Unreadable evidence is never overwritten or treated as permission to retry.
    throw await unreadableJournalEntry(name);
  }
  let record: DestructiveRecoveryRecord;
  try {
    record = journalSchema.parse(JSON.parse(text));
  } catch {
    throw await unreadableJournalEntry(name);
  }
  if (record.workspaceId !== workspaceId || record.worktreeId !== worktreeId)
    throw recoveryRequired(record, 'journal-slot-identity');
  return record;
}

export async function findCompletedDestructiveArchive(
  workspaceId: string,
  worktreeId: string,
  createdAt?: string,
): Promise<DestructiveRecoveryRecord | null> {
  const latest = await readDestructiveRecovery(workspaceId, worktreeId);
  const matches = (record: DestructiveRecoveryRecord): boolean =>
    record.state === 'completed' &&
    record.workspaceId === workspaceId &&
    record.worktreeId === worktreeId &&
    (createdAt === undefined || record.createdAt === createdAt);
  if (latest && matches(latest)) return latest;
  return withSharedJournalAccess(async () => {
    let names: string[];
    try {
      names = await readdir(journalDirectory());
    } catch (error) {
      if (missing(error)) return null;
      throw journalDirectoryUnreadable();
    }
    for (const name of names) {
      if (!LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN.test(name)) continue;
      const record = await parseJournalEntry(name);
      if (matches(record)) return record;
    }
    return null;
  });
}

/** Explicit repair of an idempotent derived index only; pending attempts require inspection. */
export async function retryDeletedWorkspaceSearchCleanup(
  workspaceId: string,
  operationId: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  const record = await readDestructiveRecovery(workspaceId);
  if (
    !record ||
    record.operation !== 'workspace-delete' ||
    record.operationId !== operationId ||
    record.state !== 'completed' ||
    record.steps.some((step) => step.state === 'pending') ||
    (await directoryIdentity(getWorkspaceDir(workspaceId))) !== null
  )
    throw recoveryRequired(record ?? undefined);
  const step: DestructiveRecoveryRecord['steps'][number] = {
    phase: 'chat-search-repair',
    state: 'pending',
  };
  record.steps.push(step);
  await save(record);
  // Leave pending on failure: a second repair must not bypass uncertain work.
  await cleanup();
  step.state = 'done';
  record.cleanupRequired = record.steps.some(
    (step) => step.state === 'failed' && step.phase !== 'chat-search-rows',
  );
  await save(record);
}

/** Project-deletion children leave completed holds for the parent's committed cleanup. */
async function assertNoLifecycleArchiveResolution(
  workspaceId: string,
  worktreeId?: string,
): Promise<void> {
  let scope = current();
  while (scope) {
    if (
      scope.active &&
      scope.childrenStepFree &&
      scope.record.operation === 'workspace-delete' &&
      scope.record.workspaceId === workspaceId
    )
      return assertNoArchiveResolution(
        workspaceId,
        worktreeId,
        'workspace-delete',
      );
    scope = scope.parent;
  }
  return assertNoArchiveResolution(workspaceId, worktreeId);
}

export async function assertNoDestructiveRecovery(
  workspaceId: string,
  worktreeId?: string,
  includeCleanup = false,
): Promise<void> {
  await assertNoLifecycleArchiveResolution(workspaceId, worktreeId);
  const record = (
    await readBlockingDestructiveRecoveries(
      workspaceId,
      worktreeId,
      includeCleanup,
    )
  ).find(
    // The archive of this worktree resumes it; janitors keep refusing.
    (record) =>
      !(
        worktreeId !== undefined &&
        record.worktreeId === worktreeId &&
        (canResumeFailedChildArchive(record) ||
          (!includeCleanup && canResumeInterruptedArchive(record)))
      ),
  );
  if (record) throw recoveryRequired(record, 'stranded-journal-scan');
}

/**
 * Workspace-wide {@link assertNoDestructiveRecovery} that tells a worktree
 * archive or delete this process is still running from a stranded journal.
 * Any stranded journal refuses `recovery-required` first; the in-flight ones
 * are returned for the caller's retryable refusal.
 *
 * A scan can predate a lifecycle that finished since. An owner leaves
 * {@link running} only after its final save, so a journal without a running
 * owner is stranded only if a rescan still finds it unfinished and ownerless.
 *
 * `resumingChildArchivesOf` admits the failed child archives that lifecycle
 * resumes ({@link canResumeFailedChildArchive}); it must then archive those
 * worktrees and call {@link assertFailedChildArchivesResumed}.
 */
export async function readInFlightWorktreeDestructiveOperations(
  workspaceId: string,
  resumingChildArchivesOf?: DestructiveRecoveryRecord['operation'],
): Promise<DestructiveRecoveryRecord[]> {
  const read = async (): Promise<DestructiveRecoveryRecord[]> =>
    (await readBlockingDestructiveRecoveries(workspaceId)).filter(
      (record) =>
        resumingChildArchivesOf === undefined ||
        (!isResumableChildArchiveFailure(record, resumingChildArchivesOf) &&
          !isSupersededChildArchiveFailure(
            record,
            resumingChildArchivesOf,
            false,
          )),
    );
  let blocking = await read();
  for (;;) {
    const deletion = blocking.find(
      (record) => record.operation === 'workspace-delete',
    );
    if (deletion) throw recoveryRequired(deletion, 'stranded-journal-rescan');
    const ownerless = new Set(
      blocking
        .filter((record) => !isInFlight(record))
        .map((record) => record.operationId),
    );
    if (!ownerless.size) return blocking;
    const rescan = await read();
    const stranded = rescan.find(
      (record) => ownerless.has(record.operationId) && !isInFlight(record),
    );
    if (stranded) throw recoveryRequired(stranded, 'stranded-journal-rescan');
    blocking = rescan;
  }
}

export async function readBlockingDestructiveRecoveries(
  workspaceId: string,
  worktreeId?: string,
  includeCleanup = false,
): Promise<DestructiveRecoveryRecord[]> {
  return filterBlockingDestructiveRecoveries(
    await readWorkspaceDestructiveRecoveries(workspaceId),
    worktreeId,
    includeCleanup,
  );
}

/** Shared admission classification for executors and background preflight. */
export async function filterBlockingDestructiveRecoveries(
  records: readonly DestructiveRecoveryRecord[],
  worktreeId?: string,
  includeCleanup = false,
): Promise<DestructiveRecoveryRecord[]> {
  const blocking: DestructiveRecoveryRecord[] = [];
  const active = current();
  for (const record of records)
    if (
      (worktreeId === undefined ||
        record.worktreeId === undefined ||
        record.worktreeId === worktreeId) &&
      (record.state !== 'completed' ||
        (includeCleanup && record.cleanupRequired)) &&
      (!active ||
        (record.operationId !== active.record.operationId &&
          record.operationId !== active.supersedes)) &&
      !(await isSupersedableDeletion(record))
    )
      blocking.push(record);
  return blocking;
}

/** Includes completed history and children absent from the canonical inventory. */
export function readWorkspaceDestructiveRecoveries(
  workspaceId: string,
): Promise<DestructiveRecoveryRecord[]> {
  return withSharedJournalAccess(async () => {
    let names: string[];
    try {
      names = await readdir(journalDirectory());
    } catch (error) {
      if (missing(error)) return [];
      throw journalDirectoryUnreadable();
    }
    const records: DestructiveRecoveryRecord[] = [];
    for (const name of names) {
      if (!LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN.test(name)) continue;
      const record = await parseJournalEntry(name);
      if (record.workspaceId === workspaceId) records.push(record);
    }
    return records;
  });
}

/**
 * Conservative, non-throwing guard for retention and purge janitors. A
 * supersedable deletion journal ({@link isSupersedableDeletion}) is resolved:
 * its child archives and resumable steps keep their own journals.
 */
export async function hasUnresolvedDestructiveRecovery(
  workspaceId: string,
  worktreeId?: string,
): Promise<boolean> {
  try {
    for (const record of await readWorkspaceDestructiveRecoveries(workspaceId))
      if (
        (worktreeId === undefined ||
          record.worktreeId === undefined ||
          record.worktreeId === worktreeId) &&
        (record.state !== 'completed' || record.cleanupRequired === true) &&
        !(await isSupersedableDeletion(record))
      )
        return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Older domain journals are evidence for inspection, never a new operation's
 * authority.
 *
 * `admitMissingCheckoutCapture` is for archive/delete admission only
 * (CAN-3039): a capture staged before its checkout was deleted outside the app
 * never reached teardown. Archive degrades it to a Git-less container that
 * keeps it pinned, and delete releases it; neither resumes or adopts it. The
 * lifecycle records the checkout as absent, so a reappearing one is refused.
 * Janitors keep refusing, so they still protect that container's refs.
 *
 * `readOnly` leaves a legacy staged descriptor unwritten, for project
 * deletion's admission of its worktree archives (CAN-4985).
 */
export async function assertNoLegacyArchiveRecovery(
  workspaceId: string,
  worktreeId: string,
  options?: { admitMissingCheckoutCapture?: boolean; readOnly?: boolean },
): Promise<void> {
  if (await readDestructiveRecovery(workspaceId, worktreeId)) return;
  const { readArchivedGitStagedDescriptor } =
    await import('./archived-container-git');
  const { readArchivedContainerRecoveryEvidence } =
    await import('./archived-container-recovery');
  let legacyJournal = false;
  try {
    legacyJournal = await readArchivedContainerRecoveryEvidence(
      workspaceId,
      worktreeId,
    );
  } catch {
    await refuseInterruptedArchiveJournal(
      workspaceId,
      worktreeId,
      'legacy-journal-unreadable',
    );
  }
  const staged = await readArchivedGitStagedDescriptor(
    workspaceId,
    worktreeId,
    options?.readOnly ? { readOnly: true } : undefined,
  );
  if (!staged && !legacyJournal) return;
  if (
    !legacyJournal &&
    staged &&
    options?.admitMissingCheckoutCapture === true &&
    staged.status === 'capturing' &&
    !staged.teardown &&
    (await directoryIdentity(
      getWorkspaceWorktreeDir(workspaceId, worktreeId),
    )) === null
  )
    return;
  await refuseInterruptedArchiveJournal(
    workspaceId,
    worktreeId,
    legacyJournal ? 'legacy-journal' : 'staged-git-capture',
  );
}

/** `check` names the failed condition, since every site shares one phase. */
export async function refuseInterruptedArchiveJournal(
  workspaceId: string,
  worktreeId: string,
  check: string,
): Promise<void> {
  const record = await readDestructiveRecovery(workspaceId, worktreeId).catch(
    () => null,
  );
  const error = new W5CommitRefusedError(
    'recovery-required',
    'An interrupted archive needs manual recovery. Preserve its remaining checkout, retained payload and journals.',
    {
      workspaceId,
      worktreeId,
      phase: 'archive-journal',
      check,
      ...(record
        ? { operation: record.operation, operationId: record.operationId }
        : {}),
    },
  );
  if (record) rememberDestructiveFailure(error, record);
  throw error;
}

type ChildArchiveStepRule = {
  resume: 'redo' | 'redo-or-tolerate' | 'redo-while-pending' | 'never';
  subsumedAfterRowRemoval?: true;
};

/**
 * How a project deletion's retry treats a failed or crashed child archive
 * holding a step of each phase (CAN-4993, CAN-5011). Every destructive step
 * phase is listed: {@link DestructivePhase} derives from these keys, so a
 * step cannot take a phase this table does not classify.
 *
 * - `redo`: a redo is safe whether the step completed or was left pending by
 *   a failure or a crash.
 * - `redo-or-tolerate`: as `redo`, and the archive also tolerated a recorded
 *   failure and went on: a Git capture refusal that took the files-only
 *   recovery path, a best-effort branch deletion, and the best-effort turn
 *   diff cleanup.
 * - `redo-while-pending`: a failed row removal resumes while the row is
 *   listed; once done, {@link isSupersededChildArchiveFailure} applies.
 * - `never`: refuses `recovery-required`: the unretained checkout removal,
 *   which a project deletion's retained archives never take, and steps only
 *   a project or cowork deletion itself takes.
 *
 * Each redo is safe because of the archive's own staged state: payload
 * capture restarts, a capturing Git descriptor is released and recaptured, a
 * ready one is revalidated or reused, and a verified quarantine is
 * identity-checked and removed again. The pinned snapshots hold the
 * quarantined checkout. CAN-5011 adds the quarantine removal; the branch
 * deletion, whose redo in a project deletion's archive deletes only a merged
 * branch or one at the recorded tip, and skips one already gone; the
 * files-only recovery, whose own journal resumes its capture and finish; the
 * pipeline cleanup, which copies artifacts again from their live copies; the
 * turn diff cleanup, which deletes only the refs it still lists; and the
 * steps after the retained manifest commits, which a redo reaches through
 * the committed manifest, skipping teardown and capture; the checkout
 * quarantine move, whose redo re-enters its staged teardown journal: an
 * unmoved checkout is moved again, a moved one is identity-checked, repaired
 * and verified against the pinned snapshots, and a mismatch refuses again
 * without moving anything back; and the teardown script, which every redo
 * reruns.
 *
 * `subsumedAfterRowRemoval`: a project deletion's own cleanup covers what a
 * child archive does after it removes its row: the project's browser
 * profiles and watchers, and the project itself.
 */
const CHILD_ARCHIVE_STEP_RULES = {
  'teardown-script': { resume: 'redo' },
  'live-state-teardown': { resume: 'redo' },
  'retained-payload-capture': { resume: 'redo' },
  'git-capture': { resume: 'redo-or-tolerate' },
  'provider-capture': { resume: 'redo' },
  'checkout-quarantine': { resume: 'redo' },
  // Child redo stays broader than CAN-5717's standalone admission below.
  'git-worktree-removal': { resume: 'redo' },
  'quarantine-directory-removal': { resume: 'redo' },
  'branch-deletion': { resume: 'redo' },
  'branch-delete-ref': { resume: 'redo-or-tolerate' },
  'file-quarantine': { resume: 'redo' },
  'retained-git-cleanup': { resume: 'redo' },
  'pipeline-cleanup': { resume: 'redo' },
  'turn-diff-cleanup': { resume: 'redo-or-tolerate' },
  'retained-manifest-commit': { resume: 'redo' },
  'git-capture-completion': { resume: 'redo' },
  'sidecar-cleanup': { resume: 'redo' },
  'compatibility-symlinks': { resume: 'redo' },
  'canonical-row-removal': { resume: 'redo-while-pending' },
  'browser-retirement': { resume: 'redo', subsumedAfterRowRemoval: true },
  'deferred-browser-retirement': {
    resume: 'never',
    subsumedAfterRowRemoval: true,
  },
  'watcher-commit': { resume: 'never', subsumedAfterRowRemoval: true },
  'temporary-workspace-cleanup': {
    resume: 'never',
    subsumedAfterRowRemoval: true,
  },
  'checkout-removal': { resume: 'never' },
  'directory-removal': { resume: 'never' },
  'git-worktree-unregister': { resume: 'never' },
  'checkout-directory-removal': { resume: 'never' },
  'checkout-native-removal': { resume: 'never' },
  'session-teardown': { resume: 'never' },
  'cowork-deletion': { resume: 'never' },
  'cowork-summaries-removal': { resume: 'never' },
  'workspace-directory-removal': { resume: 'never' },
  'workspace-non-w5-children-removal': { resume: 'never' },
  'managed-repository-removal': { resume: 'never' },
  'canonical-index-removal': { resume: 'never' },
  'archived-git-refs': { resume: 'never' },
  'archive-recovery-holds': { resume: 'never' },
  'chat-search-rows': { resume: 'never' },
} satisfies Record<string, ChildArchiveStepRule>;

/**
 * A step's phase; the sidecar cleanup names its own best-effort steps. A
 * worktree discard's own steps (CAN-5334) are never resumable children.
 */
export type DestructivePhase =
  | keyof typeof CHILD_ARCHIVE_STEP_RULES
  | `sidecar:${string}`
  | `discard:${string}`;

const childArchiveStepRules: ReadonlyMap<string, ChildArchiveStepRule> =
  new Map(Object.entries(CHILD_ARCHIVE_STEP_RULES));

/** A resumable child archive may hold this step ({@link CHILD_ARCHIVE_STEP_RULES}). */
function isResumableChildArchiveStep(
  step: DestructiveRecoveryRecord['steps'][number],
): boolean {
  // The sidecar cleanup's own idempotent, best-effort steps.
  if (step.phase.startsWith('sidecar:')) return true;
  const resume = childArchiveStepRules.get(step.phase)?.resume;
  switch (step.state) {
    case 'pending':
      return (
        resume === 'redo' ||
        resume === 'redo-or-tolerate' ||
        resume === 'redo-while-pending'
      );
    case 'done':
      return resume === 'redo' || resume === 'redo-or-tolerate';
    case 'failed':
      return resume === 'redo-or-tolerate';
  }
}

/**
 * A failed child archive of `parentOperation`. CAN-5011: a journal a crash
 * left `active`, which no lifecycle of this process runs, counts as failed in
 * the step it was taking.
 */
function isFailedChildArchive(
  record: DestructiveRecoveryRecord,
  parentOperation: DestructiveRecoveryRecord['operation'],
): boolean {
  return (
    record.operation === 'worktree-archive' &&
    record.parentOperation === parentOperation &&
    (record.state === 'recovery-required' || isCrashed(record)) &&
    record.worktreeId !== undefined &&
    record.createdAt !== undefined &&
    record.steps.length > 0
  );
}

/**
 * Read-only: a failed child archive of `parentOperation` that a retry may
 * redo. Each step failed in, or completed or tolerated, a redoable phase; it
 * may have failed between steps. Pipeline and turn diff cleanup run together,
 * so a failed one may precede the other's record, and a crash may leave
 * either pending.
 */
export function isResumableChildArchiveFailure(
  record: DestructiveRecoveryRecord,
  parentOperation: DestructiveRecoveryRecord['operation'],
): boolean {
  return (
    isFailedChildArchive(record, parentOperation) &&
    record.steps.every(isResumableChildArchiveStep)
  );
}

/**
 * Read-only (CAN-5011): a failed child archive of `parentOperation` whose
 * retained manifest committed and whose row is gone, failed only in the
 * cleanup that {@link CHILD_ARCHIVE_STEP_RULES} marks
 * `subsumedAfterRowRemoval`. Its worktree leaves the list, so no archive
 * resumes it; the parent finishes for it.
 * `rowLeft`: a failed row removal whose row is no longer listed counts as
 * done.
 */
function isSupersededChildArchiveFailure(
  record: DestructiveRecoveryRecord,
  parentOperation: DestructiveRecoveryRecord['operation'],
  rowLeft: boolean,
): boolean {
  if (!isFailedChildArchive(record, parentOperation)) return false;
  const removal = record.steps.findIndex(
    (step) => step.phase === 'canonical-row-removal',
  );
  const removed = record.steps[removal];
  return (
    record.steps.some(
      (step) =>
        step.phase === 'retained-manifest-commit' && step.state === 'done',
    ) &&
    removed !== undefined &&
    (removed.state === 'done' || (rowLeft && removed.state === 'pending')) &&
    record.steps.every((step, index) =>
      index < removal
        ? step.state !== 'pending'
        : index === removal ||
          childArchiveStepRules.get(step.phase)?.subsumedAfterRowRemoval ===
            true,
    )
  );
}

/**
 * CAN-4993: inside {@link runStepFreeChildLifecycles}, a child archive of
 * this worktree resumes its failed journal instead of refusing it. The
 * lifecycle rechecks its identities before taking it over.
 */
export function canResumeFailedChildArchive(
  record: DestructiveRecoveryRecord,
): boolean {
  const scope = current();
  return (
    scope?.childrenStepFree === true &&
    record.workspaceId === scope.record.workspaceId &&
    isResumableChildArchiveFailure(record, scope.record.operation)
  );
}

/**
 * Phases a standalone archive takes before its Git capture. None touches the
 * checkout or Git, and without a committed manifest the payload capture
 * recreates the staged payload.
 */
const PRE_GIT_CAPTURE_ARCHIVE_PHASES: ReadonlySet<string> = new Set([
  'teardown-script',
  'live-state-teardown',
  'retained-payload-capture',
]);

function isInterruptedPreGitCaptureArchive(
  record: DestructiveRecoveryRecord,
): boolean {
  return (
    record.operation === 'worktree-archive' &&
    record.parentOperation === undefined &&
    isOwnerless(record) &&
    (record.state === 'recovery-required' || isCrashed(record)) &&
    record.steps.length > 0 &&
    record.steps.every(
      (step) =>
        PRE_GIT_CAPTURE_ARCHIVE_PHASES.has(step.phase) &&
        step.state !== 'failed',
    )
  );
}

// CAN-5717: standalone retry is narrower than the child redo rules. Capture
// must have succeeded; no tolerated git-capture failure qualifies here.
const GIT_REMOVAL_ARCHIVE_RETRY_PHASES = [
  'live-state-teardown',
  'retained-payload-capture',
  'git-capture',
  'provider-capture',
  'checkout-quarantine',
  'git-worktree-removal',
] as const;

function isInterruptedArchiveGitRemoval(
  record: DestructiveRecoveryRecord,
): boolean {
  if (
    !isOwnerless(record) ||
    (record.state !== 'recovery-required' && !isCrashed(record))
  )
    return false;
  const steps =
    record.steps[0]?.phase === 'teardown-script'
      ? record.steps.slice(1)
      : record.steps;
  return (
    (steps === record.steps || record.steps[0].state === 'done') &&
    steps.length === GIT_REMOVAL_ARCHIVE_RETRY_PHASES.length &&
    steps.every(
      (step, index) =>
        step.phase === GIT_REMOVAL_ARCHIVE_RETRY_PHASES[index] &&
        step.state === (index === steps.length - 1 ? 'pending' : 'done'),
    )
  );
}

/** A standalone delete's checkout removal, which must not have finished. */
const DELETE_CHECKOUT_REMOVAL_PHASES: ReadonlySet<string> = new Set([
  'checkout-removal',
  'git-worktree-unregister',
]);

/**
 * A standalone Archive or Delete retry, including Auto Delete, redoes an
 * ownerless archive left `active` or `recovery-required` before Git capture,
 * with no failed step. The lifecycle rechecks its identities before takeover.
 * Pending Git removal after all ordered capture and quarantine steps are done
 * is also admitted (CAN-5717), including an ownerless crashed active journal.
 * Admission only permits revalidation through the lifecycle and verified
 * teardown; it never authorizes attributing gitdir-less administrative residue.
 * Project deletion and the archive janitors keep refusing standalone journals.
 *
 * It also takes over a standalone delete that failed or crashed before its
 * checkout removal finished, such as a failed `git worktree remove`. An
 * Archive retry retains whatever checkout remains; a Delete retry redoes the
 * removal ({@link assertChildArchiveResumable}).
 */
export function canResumeInterruptedArchive(
  record: DestructiveRecoveryRecord,
): boolean {
  if (
    current() !== undefined ||
    record.parentOperation !== undefined ||
    record.worktreeId === undefined ||
    record.createdAt === undefined ||
    record.steps.length === 0
  )
    return false;
  if (record.operation === 'worktree-delete')
    return (
      (record.state === 'recovery-required' || isCrashed(record)) &&
      record.steps.every((step) =>
        DELETE_CHECKOUT_REMOVAL_PHASES.has(step.phase)
          ? step.state !== 'done'
          : step.state === 'done' &&
            (step.phase === 'teardown-script' ||
              step.phase === 'live-state-teardown'),
      )
    );
  return (
    record.operation === 'worktree-archive' &&
    (isInterruptedArchiveGitRemoval(record) ||
      isInterruptedPreGitCaptureArchive(record))
  );
}

/**
 * Refuses a failed child archive admitted by
 * {@link readInFlightWorktreeDestructiveOperations} that no child archive
 * resumed, such as one whose worktree left the list. One superseded once its
 * row left is admitted: {@link completeSupersededChildArchives} finishes it.
 */
export async function assertFailedChildArchivesResumed(
  workspaceId: string,
  parentOperation: DestructiveRecoveryRecord['operation'],
): Promise<void> {
  const left = (await readWorkspaceDestructiveRecoveries(workspaceId)).find(
    (record) =>
      isResumableChildArchiveFailure(record, parentOperation) &&
      !isSupersededChildArchiveFailure(record, parentOperation, true),
  );
  if (left) throw recoveryRequired(left);
}

/**
 * CAN-5011: once `parentOperation` has removed the project, marks each child
 * archive it superseded ({@link isSupersededChildArchiveFailure}) completed,
 * so no stale journal reports manual recovery or fences a later project with
 * this id. Call only after the parent's own cleanup has run.
 */
export async function completeSupersededChildArchives(
  workspaceId: string,
  parentOperation: DestructiveRecoveryRecord['operation'],
): Promise<void> {
  for (const record of await readWorkspaceDestructiveRecoveries(workspaceId)) {
    if (!isSupersededChildArchiveFailure(record, parentOperation, true))
      continue;
    await save({
      ...record,
      state: 'completed',
      outcome: { success: true, warnings: [] },
    });
    logMainProcessWarn(
      'W5 destructive lifecycle completes a superseded archive',
      {
        operationId: record.operationId,
        workspaceId: record.workspaceId,
        worktreeId: record.worktreeId,
        steps: record.steps,
      },
    );
  }
}

/** The resumed journal's paths may be absent now, never replaced. */
async function assertChildArchiveResumable(
  previous: DestructiveRecoveryRecord,
  input: { operation: string; worktreeId?: string; createdAt?: string },
  identity: string | null,
): Promise<void> {
  if (
    (input.operation !== 'worktree-archive' &&
      !(
        input.operation === 'worktree-delete' &&
        (previous.operation === 'worktree-delete' ||
          isInterruptedPreGitCaptureArchive(previous))
      )) ||
    input.worktreeId !== previous.worktreeId ||
    input.createdAt !== previous.createdAt ||
    !isRecordedProjectDirectory(identity, previous.directoryIdentity)
  )
    throw recoveryRequired(previous, 'child-archive-resumable');
  if (!(await areOwnedPathsUnreplaced(previous)))
    throw recoveryRequired(previous, 'child-archive-resumable');
}

/** The journal's project directory, including its incarnation marker, still agrees. */
export async function isRecoveryProjectUnreplaced(
  record: DestructiveRecoveryRecord,
): Promise<boolean> {
  return isRecordedProjectDirectory(
    await projectDirectoryIdentity(record.workspaceId),
    record.directoryIdentity,
  );
}

/** Read-only projection of standalone takeover; execution repeats these checks. */
export async function canAdmitInterruptedArchive(
  record: DestructiveRecoveryRecord,
  input: {
    operation: 'worktree-archive' | 'worktree-delete';
    worktreeId: string;
    createdAt: string;
  },
): Promise<boolean> {
  if (!canResumeInterruptedArchive(record)) return false;
  try {
    await assertChildArchiveResumable(
      record,
      input,
      await projectDirectoryIdentity(record.workspaceId),
    );
    return true;
  } catch {
    return false;
  }
}

/** Only a verified committed archive can re-enter its idempotent cleanup tail. */
async function assertArchiveCleanupRecovery(
  record: DestructiveRecoveryRecord,
  createdAt: string | undefined,
  archiveManifestVersion: 2 | 3,
): Promise<void> {
  const completed = (phase: string): boolean =>
    record.steps.some((step) => step.phase === phase && step.state === 'done');
  // v3 recovery may defer Git registrations; the cleanup tail never retries them.
  const requiredPhases =
    archiveManifestVersion === 3
      ? ['retained-git-cleanup', 'pipeline-cleanup', 'retained-manifest-commit']
      : [
          'git-worktree-removal',
          'quarantine-directory-removal',
          'pipeline-cleanup',
          'retained-manifest-commit',
          'git-capture-completion',
        ];
  if (
    record.operation !== 'worktree-archive' ||
    !record.worktreeId ||
    !createdAt ||
    record.createdAt !== createdAt ||
    !record.directoryIdentity ||
    !requiredPhases.every(completed) ||
    record.steps.some(
      (step) =>
        step.state !== 'done' &&
        !isArchiveCleanupPhase(step.phase) &&
        !(
          archiveManifestVersion === 3 &&
          step.phase === 'git-capture' &&
          step.state === 'failed'
        ),
    ) ||
    !isRecordedProjectDirectory(
      await projectDirectoryIdentity(record.workspaceId),
      record.directoryIdentity,
    ) ||
    (await directoryIdentity(
      getWorkspaceWorktreeDir(record.workspaceId, record.worktreeId),
    )) !== null
  )
    throw recoveryRequired(record, 'assert-archive-cleanup-recovery');
  const metadata = getWorktreeDataDir(record.workspaceId, record.worktreeId);
  const actual = await directoryIdentity(metadata);
  const owned = record.ownedPaths.find((entry) => entry.path === metadata);
  if (
    actual !== null &&
    actual !== owned?.identity &&
    !(await isRecreatedEmptyMetadata(record, metadata))
  )
    throw recoveryRequired(record, 'assert-archive-cleanup-recovery');
}

/**
 * A live writer, such as a delegation run store, can recreate the worktree
 * metadata directory after the sidecar cleanup removed it. Holding no files,
 * it has nothing to lose, and the resumed cleanup removes it again. Any
 * recorded metadata step qualifies: a resumed attempt saves it pending again
 * before its removal, and a crash there must not lock out the next retry.
 */
async function isRecreatedEmptyMetadata(
  record: DestructiveRecoveryRecord,
  metadata: string,
): Promise<boolean> {
  return (
    record.steps.some((step) => step.phase === 'sidecar:worktree metadata') &&
    (await holdsNoFiles(metadata))
  );
}

/**
 * The removal the running lifecycle allows for `path`. A tree it adopted as
 * recreated and empty is removed only directory by directory, so a file
 * written since its last check fails the removal with ENOTEMPTY and survives.
 */
export function lifecycleTreeRemoval<
  Remove extends (path: string, options: RmOptions) => Promise<void>,
>(
  path: string,
  removeTree: Remove,
): Remove | ((path: string) => Promise<void>) {
  return current()?.adoptedMetadata?.path === path
    ? removeEmptyDirectories
    : removeTree;
}

/** Removes only this deletion's marker and empty root, restoring the marker on refusal. */
export async function removeDestructiveWorkspaceDirectory(
  workspaceId: string,
): Promise<void> {
  const directory = getWorkspaceDir(workspaceId);
  const lifecycle = current();
  if (!lifecycle) return rmdir(directory);
  if (
    lifecycle.record.operation !== 'workspace-delete' ||
    lifecycle.record.workspaceId !== workspaceId ||
    lifecycle.record.worktreeId !== undefined
  )
    throw recoveryRequired(lifecycle.record);
  await lifecycle.queue(async () => {
    await lifecycle.checkIdentity();
    const identity = await directoryIdentity(directory);
    if (identity === null) {
      try {
        return await rmdir(directory);
      } catch (error) {
        await lifecycle.checkIdentity();
        throw error;
      }
    }
    const token = await readIncarnationToken(directory);
    let markerRemoved = false;
    try {
      if (
        token !== null &&
        (await readdir(directory)).every(
          (child) => child.toLowerCase() === INCARNATION_MARKER,
        )
      ) {
        await lifecycle.checkIdentity();
        await rm(join(directory, INCARNATION_MARKER));
        markerRemoved = true;
        if ((await directoryIdentity(directory)) !== identity)
          throw recoveryRequired(lifecycle.record);
      }
      await rmdir(directory);
    } catch (error) {
      try {
        const actual = await directoryIdentity(directory);
        if (actual === identity) {
          // Never overwrite a peer's marker, even when it kept the same root.
          if (markerRemoved) {
            if (
              token === null ||
              (await createIncarnationToken(directory, token)) !== token
            )
              throw recoveryRequired(lifecycle.record);
            await syncDirectory(directory);
          }
          await lifecycle.checkIdentity();
        } else if (actual !== null || !missing(error)) {
          throw recoveryRequired(lifecycle.record);
        }
      } catch {
        // Restoration and identity failures must not be tolerated as rmdir errno codes.
        throw recoveryRequired(lifecycle.record);
      }
      throw error;
    }
  });
}

async function removeEmptyDirectories(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  for (const entry of entries)
    if (entry.isDirectory())
      await removeEmptyDirectories(join(directory, entry.name));
  await rmdir(directory);
}

async function holdsNoFiles(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (
      !entry.isDirectory() ||
      !(await holdsNoFiles(join(directory, entry.name)))
    )
      return false;
  return true;
}

/** Runs under the existing workspace/archive lock. */
export async function withDestructiveLifecycle<T>(
  input: {
    operation: DestructiveRecoveryRecord['operation'];
    trigger?: ArchiveTrigger;
    workspaceId: string;
    worktreeId?: string;
    createdAt?: string;
    /** Internal needs-repair rollback may have intentionally removed the row. */
    allowMissingRow?: boolean;
    /** Internal: the caller verified the retained manifest for this incarnation. */
    resumeArchiveCleanup?: boolean;
    /** Locked, exact-operation resolver; never projects history into the current slot. */
    exactJournal?: ExactArchiveJournal;
    /** Internal: verified committed manifest format; defaults to v2. */
    archiveManifestVersion?: 2 | 3;
    /** Authoritative row read; null after canonical removal, never a replacement. */
    readCreatedAt?: () => Promise<string | null>;
    beforeEffects?: () => void;
    projectOutcome?: (result: T) => unknown;
    replay?: (outcome: unknown) => T;
  },
  work: () => Promise<T>,
): Promise<T> {
  await assertNoLifecycleArchiveResolution(input.workspaceId, input.worktreeId);
  const previous =
    input.exactJournal?.record ??
    (await readDestructiveRecovery(input.workspaceId, input.worktreeId));
  const resumingArchiveCleanup =
    previous !== null &&
    (previous.state !== 'completed' || input.exactJournal !== undefined) &&
    input.resumeArchiveCleanup === true;
  const resumedFailure =
    previous !== null &&
    !resumingArchiveCleanup &&
    (canResumeFailedChildArchive(previous) ||
      canResumeInterruptedArchive(previous))
      ? previous
      : undefined;
  const supersededDeletion =
    previous !== null &&
    input.operation === 'workspace-delete' &&
    (await isSupersedableDeletion(previous))
      ? previous
      : undefined;
  if (
    previous &&
    (previous.state !== 'completed' || resumingArchiveCleanup) &&
    !resumedFailure &&
    !supersededDeletion
  ) {
    if (!resumingArchiveCleanup)
      throw recoveryRequired(previous, 'destructive-lifecycle-admission');
    await assertArchiveCleanupRecovery(
      previous,
      input.createdAt,
      input.archiveManifestVersion ?? 2,
    );
  }
  if (
    previous?.state === 'completed' &&
    input.replay &&
    (input.createdAt === undefined || previous.createdAt === input.createdAt)
  )
    return input.replay(previous.outcome);
  if (
    input.worktreeId &&
    !input.allowMissingRow &&
    (input.createdAt === undefined ||
      (input.readCreatedAt && (await input.readCreatedAt()) === null))
  )
    throw new W5CommitRefusedError(
      'recovery-required',
      'This checkout has no recorded identity. Preserve it for manual repair.',
      {
        workspaceId: input.workspaceId,
        worktreeId: input.worktreeId,
        phase: 'unrecorded-checkout',
        check: 'destructive-lifecycle-admission',
      },
    );
  const identity =
    resumingArchiveCleanup && previous
      ? previous.directoryIdentity
      : await projectDirectoryIdentity(input.workspaceId, true);
  if (resumedFailure) {
    await assertChildArchiveResumable(resumedFailure, input, identity);
    logMainProcessWarn('W5 destructive lifecycle resumes a failed archive', {
      operationId: resumedFailure.operationId,
      workspaceId: resumedFailure.workspaceId,
      worktreeId: resumedFailure.worktreeId,
      steps: resumedFailure.steps,
    });
  }
  if (supersededDeletion)
    logMainProcessWarn(
      'W5 destructive lifecycle supersedes an interrupted deletion',
      {
        operationId: supersededDeletion.operationId,
        workspaceId: supersededDeletion.workspaceId,
        steps: supersededDeletion.steps,
      },
    );
  const parent = current();
  const lifecycle: Lifecycle = {
    exactJournal: input.exactJournal,
    record:
      resumingArchiveCleanup && previous
        ? previous
        : {
            version: 1,
            operationId: randomUUID(),
            operation: input.operation,
            ...(resumedFailure
              ? {
                  supersedesArchives: [
                    ...(resumedFailure.supersedesArchives ?? []),
                    ...(resumedFailure.operation === 'worktree-archive'
                      ? [resumedFailure.operationId]
                      : []),
                  ],
                }
              : {}),
            trigger: input.trigger,
            ...(parent?.childrenStepFree
              ? { parentOperation: parent.record.operation }
              : {}),
            workspaceId: input.workspaceId,
            worktreeId: input.worktreeId,
            createdAt: input.createdAt,
            directoryIdentity: identity,
            state: 'active',
            steps: [],
            ownedPaths: [],
          },
    queue: createSerialQueue(),
    failed: false,
    canonicalRemoved: false,
    resumingArchiveCleanup,
    beforeEffects: input.beforeEffects,
    active: true,
    // A resumed failure is superseded, never kept as an outcome copy.
    previous:
      resumingArchiveCleanup || resumedFailure || supersededDeletion
        ? undefined
        : (previous ?? undefined),
    // A withdrawal drops a superseded deletion, as its own would have.
    ...(resumingArchiveCleanup
      ? {}
      : { journalBefore: { record: supersededDeletion ? null : previous } }),
    ...(resumingArchiveCleanup && previous && !input.exactJournal
      ? { takesOver: previous }
      : resumedFailure
        ? { takesOver: resumedFailure }
        : {}),
    childrenStepFree: false,
    withdrawalAttempted: false,
    parent,
    checkIdentity: async () => {
      const actual = await projectDirectoryIdentity(input.workspaceId);
      if (
        !isRecordedProjectDirectory(actual, identity) &&
        !(actual === null && lifecycle.canonicalRemoved)
      )
        throw recoveryRequired(lifecycle.record, 'check-identity');
      if (input.readCreatedAt) {
        const actualCreatedAt = await input.readCreatedAt();
        if (
          actualCreatedAt !== (input.createdAt ?? null) &&
          !(input.allowMissingRow && actualCreatedAt === null) &&
          !(actualCreatedAt === null && lifecycle.canonicalRemoved)
        )
          throw recoveryRequired(lifecycle.record, 'check-identity');
      }
      if (
        resumingArchiveCleanup &&
        input.worktreeId &&
        (await directoryIdentity(
          getWorkspaceWorktreeDir(input.workspaceId, input.worktreeId),
        )) !== null
      )
        throw recoveryRequired(lifecycle.record, 'check-identity');
      for (const owned of lifecycle.record.ownedPaths) {
        const actual = await directoryIdentity(owned.path);
        // A resumed cleanup's paths are another lifecycle's.
        const expected = resumingArchiveCleanup
          ? owned.identity
          : recordedStatIdentity(owned.identity);
        if (actual === expected || actual === null) continue;
        const adopted = lifecycle.adoptedMetadata;
        if (
          adopted?.path === owned.path &&
          adopted.identity === actual &&
          (await holdsNoFiles(owned.path).catch(missing))
        )
          continue;
        throw recoveryRequired(lifecycle.record, 'check-identity');
      }
    },
  };
  if (resumingArchiveCleanup && previous) {
    lifecycle.record.state = 'active';
    if (!input.exactJournal) lifecycle.record.cleanupRequired = false;
    if (input.worktreeId) {
      const metadata = getWorktreeDataDir(input.workspaceId, input.worktreeId);
      if (!lifecycle.record.ownedPaths.some((entry) => entry.path === metadata))
        lifecycle.record.ownedPaths.push({ path: metadata, identity: null });
      const actual = await directoryIdentity(metadata);
      // The resumed sidecar cleanup takes over a recreated empty directory.
      if (
        actual !== null &&
        (await isRecreatedEmptyMetadata(lifecycle.record, metadata))
      )
        lifecycle.adoptedMetadata = { path: metadata, identity: actual };
    }
    const row = await input.readCreatedAt?.();
    lifecycle.canonicalRemoved =
      row === null &&
      previous.steps.some((step) => step.phase === 'canonical-row-removal');
    await lifecycle.checkIdentity();
  }
  return context.run(lifecycle, async () => {
    running.add(lifecycle);
    try {
      if (resumingArchiveCleanup)
        await assertNoDestructiveRecovery(input.workspaceId, input.worktreeId);
      const result = await work();
      if (
        lifecycle.failed ||
        (resumingArchiveCleanup &&
          lifecycle.record.steps.some((step) => step.state === 'pending'))
      )
        throw recoveryRequired(lifecycle.record);
      if (lifecycle.record.steps.length) {
        recordDeferredEffects(lifecycle);
        lifecycle.record.state = 'completed';
        lifecycle.record.outcome = input.projectOutcome
          ? input.projectOutcome(result)
          : result;
        await save(lifecycle.record);
      }
      const parent = lifecycle.parent;
      if (parent && lifecycle.parentStep) {
        lifecycle.parentStep.state = 'done';
        await parent.queue(() => save(parent.record));
      }
      return result;
    } catch (error) {
      rememberDestructiveFailure(error, lifecycle.record);
      // CAN-5011: a failure outside those steps, such as the strict archive
      // listing after the child archives, is step-free while they are its
      // only steps.
      if (
        lifecycle.record.steps.length &&
        lifecycle.record.state !== 'completed' &&
        !isStepFreeDestructiveFailure(error)
      )
        await lifecycle
          .queue(() => withdrawStepFreeJournal(lifecycle, error))
          .catch(() => undefined);
      recordDeferredEffects(lifecycle);
      if (
        lifecycle.record.steps.length &&
        lifecycle.record.state !== 'completed'
      ) {
        lifecycle.record.state = 'recovery-required';
        await save(lifecycle.record).catch(() => undefined);
        report(lifecycle.record);
      }
      throw error;
    } finally {
      lifecycle.active = false;
      running.delete(lifecycle);
    }
  });
}

/** Write intent before resolving an effect's target, and completion only after it returns. */
export async function destructiveStep<T>(
  phase: DestructivePhase,
  work: () => Promise<T>,
  canonicalRemovalOrOptions:
    | boolean
    | {
        bestEffort?: boolean;
        /** Diagnostic only; never changes best-effort completion semantics. */
        error?: string;
        /**
         * The work runs scripts and leaves no app state to recover: as the
         * first step of a standalone archive/delete or a child in
         * {@link runStepFreeChildLifecycles}, failure withdraws its journal.
         */
        stepFreeAsFirstChildStep?: boolean;
      } = false,
): Promise<T> {
  return runDestructiveStep(phase, work, canonicalRemovalOrOptions, false);
}

/** The repair must verify and clean every archived repository before returning. */
export function destructiveTurnDiffCleanupRepair(
  work: () => Promise<void>,
): Promise<void> {
  return runDestructiveStep('turn-diff-cleanup', work, false, false, 'phase');
}

async function runDestructiveStep<T>(
  phase: DestructivePhase,
  work: () => Promise<T>,
  canonicalRemovalOrOptions: Parameters<typeof destructiveStep>[2],
  resumable: boolean,
  completion: 'step' | 'phase' = 'step',
): Promise<T> {
  const canonicalRemoval =
    typeof canonicalRemovalOrOptions === 'boolean'
      ? canonicalRemovalOrOptions
      : false;
  const options =
    typeof canonicalRemovalOrOptions === 'object'
      ? canonicalRemovalOrOptions
      : {};
  const bestEffort = options.bestEffort === true;
  const lifecycle = current();
  if (!lifecycle) return work();
  if (lifecycle.resumingArchiveCleanup && !isArchiveCleanupPhase(phase))
    throw recoveryRequired(lifecycle.record);
  const existing = lifecycle.resumingArchiveCleanup
    ? lifecycle.record.steps.find((step) => step.phase === phase)
    : undefined;
  const step: DestructiveRecoveryRecord['steps'][number] = existing ?? {
    phase,
    state: 'pending',
    ...(options.error ? { error: options.error } : {}),
  };
  await lifecycle
    .queue(async () => {
      if (lifecycle.failed) throw recoveryRequired(lifecycle.record);
      await lifecycle.checkIdentity();
      if (!resumable) lifecycle.beforeEffects?.();
      const parent = lifecycle.parent;
      if (parent && !lifecycle.parentStep) {
        await parent.queue(async () => {
          await parent.checkIdentity();
          if (!parent.childrenStepFree) parent.beforeEffects?.();
          const step: DestructiveRecoveryRecord['steps'][number] = {
            phase: `child:${lifecycle.record.operationId}`,
            state: 'pending',
          };
          lifecycle.parentStep = step;
          parent.record.steps.push(step);
          await save(parent.record);
        });
      }
      if (lifecycle.previous) {
        // Keep B5's original outcome when a later incarnation reuses this id.
        const previous = lifecycle.previous;
        await withSharedJournalAccess(async () => {
          await mkdir(journalDirectory(), { recursive: true, mode: 0o700 });
          await writeFileAtomically(
            join(journalDirectory(), `${previous.operationId}.json`),
            JSON.stringify(previous),
            { durable: true, mode: 0o600 },
          );
        });
        lifecycle.previous = undefined;
      }
      if (lifecycle.takesOver) {
        await retireStaleDiscardCopy(lifecycle.takesOver);
        lifecycle.takesOver = undefined;
      }
      step.state = 'pending';
      delete step.code;
      if (!existing) lifecycle.record.steps.push(step);
      if (resumable) step.resumable = true;
      await save(lifecycle.record);
    })
    .catch((error: unknown) => {
      // Failing to record intent is never tolerable, even for best-effort work.
      lifecycle.failed = true;
      const code = destructiveFailureCode(error);
      if (code !== 'unknown') step.code = code;
      rememberDestructiveFailure(error, lifecycle.record);
      throw error;
    });
  let result: T;
  try {
    result = await work();
  } catch (error) {
    const code = destructiveFailureCode(error);
    if (code !== 'unknown') step.code = code;
    rememberDestructiveFailure(error, lifecycle.record);
    if (bestEffort) {
      // The caller tolerates this rejection; record it without failing the
      // lifecycle, but an unrecordable failure still requires recovery.
      step.state = 'failed';
      await lifecycle
        .queue(() => save(lifecycle.record))
        .catch(() => {
          lifecycle.failed = true;
        });
    } else {
      lifecycle.failed = true;
      if (
        options.stepFreeAsFirstChildStep === true &&
        (lifecycle.parent?.childrenStepFree === true ||
          (lifecycle.parent === undefined &&
            phase === 'teardown-script' &&
            (lifecycle.record.operation === 'worktree-archive' ||
              lifecycle.record.operation === 'worktree-delete'))) &&
        lifecycle.record.steps.length === 1 &&
        lifecycle.record.steps[0] === step
      )
        // A failed withdrawal keeps the step, so the lifecycle still requires recovery.
        await lifecycle
          .queue(() => withdrawJournal(lifecycle))
          .catch(() => undefined);
    }
    throw error;
  }
  await lifecycle
    .queue(async () => {
      if (canonicalRemoval) lifecycle.canonicalRemoved = true;
      step.state = 'done';
      if (completion === 'phase') {
        // Multi-repo archives record one obligation per repository.
        for (const obligation of lifecycle.record.steps) {
          if (obligation.phase !== phase) continue;
          obligation.state = 'done';
          delete obligation.code;
          delete obligation.error;
        }
      }
      await save(lifecycle.record);
    })
    .catch((error: unknown) => {
      lifecycle.failed = true;
      const code = destructiveFailureCode(error);
      if (code !== 'unknown') step.code = code;
      rememberDestructiveFailure(error, lifecycle.record);
      throw error;
    });
  return result;
}

/** Evaluate typed arguments before the callback, preserving incarnation narrowing. */
export function destructiveCall<Args extends unknown[], Result>(
  phase: DestructivePhase,
  work: (...args: Args) => Promise<Result>,
  ...args: Args
): Promise<Result> {
  return destructiveStep(phase, () => work(...args));
}

/** A failed destructive step cannot enter legacy automatic removal fallbacks. */
export function hasDestructiveLifecycle(): boolean {
  return current() !== undefined;
}

/** Called in the journal writer's existing list lock, without acquiring another lock. */
export function assertDestructiveRowIdentity(createdAt: string): void {
  const lifecycle = current();
  if (lifecycle?.record.worktreeId && lifecycle.record.createdAt !== createdAt)
    throw recoveryRequired(lifecycle.record);
}

/** A typed capture refusal precedes checkout teardown; keep its evidence and the existing files-only path. */
export function acknowledgeArchiveCaptureRefusal(): void {
  const lifecycle = current();
  if (!lifecycle) return;
  const step = [...lifecycle.record.steps]
    .reverse()
    .find((step) => step.phase === 'git-capture' && step.state === 'pending');
  if (!step) throw recoveryRequired(lifecycle.record);
  step.state = 'failed';
  lifecycle.failed = false;
}

/**
 * Runs nested lifecycles, such as a project deletion's worktree archives,
 * before this lifecycle's own effects (CAN-4993). When they fail, this
 * lifecycle's journal is withdrawn and the failure is step-free
 * ({@link isStepFreeDestructiveFailure}): each child keeps its own journal,
 * completed or requiring recovery, and a retry runs them again. Children
 * count as this lifecycle's effects once it takes an ordinary step or ends
 * with its journal.
 */
export async function runStepFreeChildLifecycles<T>(
  work: () => Promise<T>,
): Promise<T> {
  const lifecycle = current();
  if (!lifecycle) return work();
  const enclosing = lifecycle.childrenStepFree;
  lifecycle.childrenStepFree = true;
  try {
    return await work();
  } catch (error) {
    lifecycle.childrenStepFree = enclosing;
    await lifecycle
      .queue(async () => {
        if (!lifecycle.failed) await withdrawStepFreeJournal(lifecycle, error);
      })
      // A failed check or withdrawal keeps the steps, so the lifecycle still
      // requires recovery.
      .catch(() => undefined);
    throw error;
  } finally {
    lifecycle.childrenStepFree = enclosing;
  }
}

/**
 * A step whose work keeps its own journal, which a redo resumes, such as a
 * retained archive's recovery finish (CAN-5011). While every earlier step is a
 * child of {@link runStepFreeChildLifecycles} or another such step, it defers
 * the keyed attempt's effects as children do, and its failure withdraws this
 * lifecycle's journal and is step-free. Otherwise it is a
 * {@link destructiveStep}.
 */
export async function resumableDestructiveStep<T>(
  phase: DestructivePhase,
  work: () => Promise<T>,
): Promise<T> {
  const lifecycle = current();
  if (
    !lifecycle ||
    lifecycle.failed ||
    lifecycle.resumingArchiveCleanup ||
    !hasOnlyStepFreeSteps(lifecycle)
  )
    return destructiveStep(phase, work);
  try {
    return await runDestructiveStep(phase, work, false, true);
  } catch (error) {
    await lifecycle
      .queue(() => withdrawStepFreeJournal(lifecycle, error))
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Children and resumable steps defer the keyed attempt's effects; a journal
 * that keeps them records the effects when the lifecycle ends.
 */
function recordDeferredEffects(lifecycle: Lifecycle): void {
  if (lifecycle.record.steps.some(isStepFreeStep)) lifecycle.beforeEffects?.();
}

function hasOnlyStepFreeSteps(lifecycle: Lifecycle): boolean {
  return lifecycle.record.steps.every(isStepFreeStep);
}

function isStepFreeStep(
  step: DestructiveRecoveryRecord['steps'][number],
): boolean {
  return step.phase.startsWith('child:') || step.resumable === true;
}

/** Runs in the lifecycle queue; leaves the journal in place when it cannot. */
async function withdrawStepFreeJournal(
  lifecycle: Lifecycle,
  error: unknown,
): Promise<void> {
  if (!hasOnlyStepFreeSteps(lifecycle) || lifecycle.withdrawalAttempted) return;
  lifecycle.withdrawalAttempted = true;
  // A replaced directory is the parent's own failure, never step-free.
  await lifecycle.checkIdentity();
  if (lifecycle.record.steps.length && !(await withdrawJournal(lifecycle)))
    return;
  lifecycle.failed = true;
  if (typeof error === 'object' && error !== null) stepFreeFailures.add(error);
}

/** A failure that left its lifecycle without a journal (CAN-4993, CAN-5011). */
export function isStepFreeDestructiveFailure(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && stepFreeFailures.has(error)
  );
}

/** Restores the journal path to its state before the lifecycle, then drops the steps. */
async function withdrawJournal(lifecycle: Lifecycle): Promise<boolean> {
  const before = lifecycle.journalBefore;
  if (!before) return false;
  if (before.record) {
    await save(before.record);
  } else {
    await withSharedJournalAccess(async () => {
      await rm(
        journalPath(lifecycle.record.workspaceId, lifecycle.record.worktreeId),
        { force: true },
      );
      await syncDirectory(journalDirectory());
    });
  }
  lifecycle.record.steps = [];
  return true;
}

/** Capture before effects; absence never authorizes removing a later occupant. */
export async function protectDestructivePath(
  path: string,
  allowCreation = false,
): Promise<void> {
  const lifecycle = current();
  const identity = lifecycle
    ? await protectedPathIdentity(path, lifecycle.record.workspaceId)
    : null;
  if (lifecycle && !(identity === null && allowCreation))
    lifecycle.record.ownedPaths.push({
      path,
      identity,
    });
}

/** Exact membership is saved before the parent's canonical removal can run. */
export async function prepareArchiveRecoveryCleanup(
  holds: readonly { operationId: string; revision: string }[],
): Promise<DestructiveRecoveryRecord | null> {
  const lifecycle = current();
  if (!lifecycle) {
    if (holds.length)
      throw recoveryRequired(undefined, 'archive-recovery-handoff');
    return null;
  }
  if (lifecycle.record.operation !== 'workspace-delete')
    throw recoveryRequired(lifecycle.record);
  lifecycle.record.archiveRecoveryCleanup = holds.map(
    ({ operationId, revision }) => ({ operationId, revision }),
  );
  await lifecycle.queue(() => save(lifecycle.record));
  return lifecycle.record;
}

/** Only cleanup acknowledgements may differ between redundant parent copies. */
function archiveRecoveryCleanupParentBinding(
  record: DestructiveRecoveryRecord,
): DestructiveRecoveryRecord {
  const binding = {
    ...record,
    archiveRecoveryCleanup: record.archiveRecoveryCleanup?.map(
      ({ operationId, revision }) => ({ operationId, revision }),
    ),
    steps: record.steps.map((step) => {
      if (step.phase !== 'archive-recovery-holds') return step;
      const pending = { ...step, state: 'pending' as const };
      delete pending.error;
      delete pending.code;
      return pending;
    }),
  };
  delete binding.cleanupRequired;
  return binding;
}

/** Refresh commit proof from durable parent copies before any adopted hold effect. */
export async function qualifyArchiveRecoveryCleanupParent(
  expected: DestructiveRecoveryRecord,
): Promise<DestructiveRecoveryRecord> {
  return withSharedJournalAccess(async () => {
    const inspection = await (
      await import('@canopy/desktop-shared/node/w5-destructive-journal')
    ).inspectDestructiveJournals(getCanopyDataDir());
    if (inspection.issues.length)
      throw recoveryRequired(expected, 'archive-recovery-parent-unreadable');
    const copies = inspection.records.filter(
      ({ record }) => record.operationId === expected.operationId,
    );
    const actual =
      copies.find(({ record }) =>
        record.archiveRecoveryCleanup?.some((member) => !member.done),
      )?.record ?? copies[0]?.record;
    if (
      !actual ||
      actual.operation !== 'workspace-delete' ||
      actual.workspaceId !== expected.workspaceId ||
      !isDeepStrictEqual(
        archiveRecoveryCleanupParentBinding(actual).archiveRecoveryCleanup,
        archiveRecoveryCleanupParentBinding(expected).archiveRecoveryCleanup,
      ) ||
      copies.some(
        ({ record }) =>
          !isDeepStrictEqual(
            archiveRecoveryCleanupParentBinding(record),
            archiveRecoveryCleanupParentBinding(actual),
          ),
      )
    )
      throw recoveryRequired(expected, 'archive-recovery-parent-changed');
    // An unacknowledged copy replays the tombstone; it cannot authorize a second deletion.
    return {
      ...actual,
      archiveRecoveryCleanup: actual.archiveRecoveryCleanup?.map((member) => ({
        ...member,
        done: copies.every(({ record }) =>
          record.archiveRecoveryCleanup?.some(
            (copy) => copy.operationId === member.operationId && copy.done,
          ),
        ),
      })),
    };
  });
}

function settleArchiveRecoveryCleanupStep(
  record: DestructiveRecoveryRecord,
): void {
  if (!record.archiveRecoveryCleanup?.every((member) => member.done)) return;
  for (const step of record.steps) {
    if (step.phase !== 'archive-recovery-holds') continue;
    step.state = 'done';
    delete step.error;
    delete step.code;
  }
  record.cleanupRequired = record.steps.some((step) => step.state !== 'done');
}

/** Only the parent cleanup driver calls this, under the existing workspace writer. */
export async function acknowledgeArchiveRecoveryCleanup(
  record: DestructiveRecoveryRecord,
  operationId: string,
): Promise<void> {
  const member = record.archiveRecoveryCleanup?.find(
    (entry) => entry.operationId === operationId,
  );
  if (!member) throw recoveryRequired(record, 'archive-recovery-handoff');
  const lifecycle = current();
  if (lifecycle?.record.operationId === record.operationId) {
    const ownedMember = lifecycle.record.archiveRecoveryCleanup?.find(
      (entry) =>
        entry.operationId === operationId && entry.revision === member.revision,
    );
    if (!ownedMember)
      throw recoveryRequired(record, 'archive-recovery-handoff-changed');
    ownedMember.done = true;
    member.done = true;
    settleArchiveRecoveryCleanupStep(lifecycle.record);
    await lifecycle.queue(() => save(lifecycle.record));
    return;
  }
  await withExclusiveLifecycleJournalAccess(async () => {
    const copies: { path: string; record: DestructiveRecoveryRecord }[] = [];
    for (const name of await readdir(journalDirectory())) {
      if (!LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN.test(name)) continue;
      const path = join(journalDirectory(), name);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw recoveryRequired(record);
      const actual = journalSchema.parse(
        JSON.parse(await readFile(path, 'utf8')),
      );
      if (actual.operationId !== record.operationId) continue;
      if (
        actual.workspaceId !== record.workspaceId ||
        !isDeepStrictEqual(
          archiveRecoveryCleanupParentBinding(actual),
          archiveRecoveryCleanupParentBinding(record),
        )
      )
        throw recoveryRequired(record, 'archive-recovery-handoff-changed');
      copies.push({ path, record: actual });
    }
    if (!copies.length)
      throw recoveryRequired(record, 'archive-recovery-parent-disappeared');
    for (const copy of copies) {
      const selected = copy.record.archiveRecoveryCleanup?.find(
        (entry) => entry.operationId === operationId,
      );
      if (!selected) throw recoveryRequired(record);
      selected.done = true;
      settleArchiveRecoveryCleanupStep(copy.record);
      await writeFileAtomically(copy.path, JSON.stringify(copy.record), {
        durable: true,
        mode: 0o600,
      });
    }
    member.done = true;
    settleArchiveRecoveryCleanupStep(record);
  });
}

/** Cleanup failures after the owner commit keep their warnings and never earn a false done. */
export async function destructiveCleanup<T>(
  phase: DestructivePhase,
  work: () => Promise<T>,
): Promise<T> {
  const lifecycle = current();
  let workRejected = false;
  try {
    return await destructiveStep(
      phase,
      async () => {
        try {
          return await work();
        } catch (error) {
          workRejected = true;
          throw error;
        }
      },
      { bestEffort: true },
    );
  } catch (error) {
    // The best-effort step already leaves `failed` untouched for the work's
    // own rejection; a journal or concurrent step failure must stay fatal.
    if (lifecycle && workRejected) {
      lifecycle.record.cleanupRequired = true;
      const step = [...lifecycle.record.steps]
        .reverse()
        .find((step) => step.phase === phase && step.state === 'pending');
      if (step) step.state = 'failed';
    }
    throw error;
  }
}

/** Exact repair clears only positively identified debt after its owners settled. */
export async function settleDestructiveCleanupDebt(): Promise<void> {
  const lifecycle = current();
  if (!lifecycle?.exactJournal) throw recoveryRequired();
  if (
    lifecycle.record.steps.some(
      (step) =>
        (!childArchiveStepRules.has(step.phase) &&
          !step.phase.startsWith('sidecar:')) ||
        (step.state !== 'done' &&
          !(step.phase === 'git-capture' && step.state === 'failed')),
    )
  )
    return;
  lifecycle.record.cleanupRequired = false;
  await lifecycle.queue(() => save(lifecycle.record));
}

export function markDestructiveCleanupRequired(): void {
  const lifecycle = current();
  if (lifecycle) lifecycle.record.cleanupRequired = true;
}

function report(record: DestructiveRecoveryRecord): void {
  logMainProcessWarn('W5 destructive lifecycle requires manual recovery', {
    operationId: record.operationId,
    operation: record.operation,
    workspaceId: record.workspaceId,
    worktreeId: record.worktreeId,
    createdAt: record.createdAt,
    state: record.state,
    steps: record.steps,
    journalPath: journalPath(record.workspaceId, record.worktreeId),
    reason:
      record.state === 'completed'
        ? 'subordinate-cleanup'
        : 'interrupted-destructive-effect',
  });
}

/**
 * Read-only launch report, including deleted parents. No Git, cleanup or
 * compensation. A supersedable deletion journal needs no recovery and is left
 * for the next deletion.
 */
export function reportDestructiveRecovery(): Promise<
  DestructiveRecoveryRecord[]
> {
  return withSharedJournalAccess(readLaunchRecovery);
}
async function readLaunchRecovery(): Promise<DestructiveRecoveryRecord[]> {
  let names: string[];
  try {
    names = await readdir(journalDirectory());
  } catch (error) {
    if (missing(error)) return [];
    throw recoveryRequired(undefined, 'launch-stranded-journal-scan');
  }
  const records: DestructiveRecoveryRecord[] = [];
  for (const name of names) {
    if (!/^([a-f0-9]{64}|[a-f0-9-]{36})\.json$/.test(name)) continue;
    let record: DestructiveRecoveryRecord;
    try {
      record = journalSchema.parse(
        JSON.parse(await readFile(join(journalDirectory(), name), 'utf8')),
      );
    } catch {
      throw recoveryRequired(undefined, 'launch-stranded-journal-scan');
    }
    if (record.state !== 'completed' || record.cleanupRequired) {
      if (
        records.some((found) => found.operationId === record.operationId) ||
        (await isSupersedableDeletion(record).catch(() => false))
      )
        continue;
      if (record.state === 'active') record.state = 'recovery-required';
      records.push(record);
      report(record);
    }
  }
  return records;
}

// CAN-5334: the user-only worktree discard. It reuses the `worktree-delete`
// operation and adds only `discard:*` phases, so every older reader parses its
// journal; an older desktop treats an unknown phase as never resumable.

const DISCARD_PHASE_PREFIX = 'discard:';
const SUPERSEDE_PHASE_PREFIX = `${DISCARD_PHASE_PREFIX}supersede:`;

/** A worktree discard's journal, finished or not. */
export function isWorktreeDiscardRecord(
  record: DestructiveRecoveryRecord,
): boolean {
  return (
    record.operation === 'worktree-delete' &&
    record.worktreeId !== undefined &&
    record.steps[0]?.phase.startsWith(DISCARD_PHASE_PREFIX) === true
  );
}

/** The stranded record a discard journal superseded, if it names one. */
export function supersededDiscardOperationId(
  record: DestructiveRecoveryRecord,
): string | undefined {
  const phase = record.steps[0]?.phase;
  return phase?.startsWith(SUPERSEDE_PHASE_PREFIX)
    ? phase.slice(SUPERSEDE_PHASE_PREFIX.length)
    : undefined;
}

/** Read-only: no lifecycle of this process owns the record. */
export function isDestructiveRecoveryOwnerless(
  record: DestructiveRecoveryRecord,
): boolean {
  return isOwnerless(record);
}

/** Read-only: an unfinished project deletion journal that the next deletion does not supersede. */
export async function hasUnfinishedWorkspaceDeletion(
  workspaceId: string,
): Promise<boolean> {
  const record = await readDestructiveRecovery(workspaceId);
  return (
    record !== null &&
    record.state !== 'completed' &&
    !(await isSupersedableDeletion(record))
  );
}

/**
 * CAN-5337: read-only. An unfinished journal a user's project deletion admits
 * ({@link readInFlightWorktreeDestructiveOperations} with `workspace-delete`):
 * a failed child archive its worktree archives resume or supersede, or a
 * supersedable deletion. Ownership is the caller's check.
 */
export async function isAdmittedByUserProjectDeletion(
  record: DestructiveRecoveryRecord,
): Promise<boolean> {
  return (
    isResumableChildArchiveFailure(record, 'workspace-delete') ||
    isSupersededChildArchiveFailure(record, 'workspace-delete', false) ||
    (await isSupersedableDeletion(record))
  );
}

/**
 * CAN-5337: read-only. An ownerless unfinished project deletion journal whose
 * one effect beyond its step-free children and finished resumable steps is a
 * canonical index removal that never finished, over a project directory and
 * protected paths that still match. While the index still lists the project
 * (the caller's check), that removal never committed: each child keeps its own
 * journal, so the record holds nothing a recovery needs, and a confirmed
 * project deletion supersedes it ({@link withdrawInterruptedWorkspaceDeletion}).
 */
export async function isInterruptedIndexRemovalDeletion(
  record: DestructiveRecoveryRecord,
): Promise<boolean> {
  const last = record.steps[record.steps.length - 1];
  if (
    record.operation !== 'workspace-delete' ||
    record.worktreeId !== undefined ||
    record.state === 'completed' ||
    !isOwnerless(record) ||
    last?.phase !== 'canonical-index-removal' ||
    last.state === 'done' ||
    !record.steps
      .slice(0, -1)
      .every(
        (step) =>
          (isStepFreeStep(step) || isPreUpgradeRetainedGitCleanup(step)) &&
          (step.phase !== 'retained-git-cleanup' || step.state === 'done'),
      )
  )
    return false;
  try {
    return (
      isRecordedProjectDirectory(
        await projectDirectoryIdentity(record.workspaceId),
        record.directoryIdentity,
      ) && (await areOwnedPathsUnreplaced(record))
    );
  } catch {
    return false;
  }
}

/**
 * CAN-5337 (Q2 option b): the user confirmed superseding this interrupted
 * deletion, so its journal is withdrawn before the next deletion's journal
 * admission, as a step-free deletion withdraws its own. It runs first because
 * every worktree discard refuses while it is in place. Only the named record
 * goes, and only while {@link isInterruptedIndexRemovalDeletion} and
 * `isIndexed` hold; anything else is left for the admission to refuse. The
 * caller holds the project's mutation queue, the slot's only writer. Returns
 * whether it was withdrawn.
 */
export async function withdrawInterruptedWorkspaceDeletion(
  workspaceId: string,
  operationId: string,
  isIndexed: () => Promise<boolean>,
): Promise<boolean> {
  const record = await readDestructiveRecovery(workspaceId);
  if (
    record?.operationId !== operationId ||
    !(await isInterruptedIndexRemovalDeletion(record)) ||
    !(await isIndexed())
  )
    return false;
  logMainProcessWarn(
    'W5 destructive lifecycle supersedes an interrupted deletion',
    {
      operationId: record.operationId,
      workspaceId: record.workspaceId,
      steps: record.steps,
    },
  );
  await withSharedJournalAccess(async () => {
    await rm(journalPath(workspaceId), { force: true });
    await syncDirectory(journalDirectory());
  });
  return true;
}

/** Read-only: the verified committed-archive cleanup would accept this journal. */
export async function canFinishArchiveCleanup(
  record: DestructiveRecoveryRecord,
  createdAt: string,
  archiveManifestVersion: 2 | 3 = 2,
): Promise<boolean> {
  try {
    await assertArchiveCleanupRecovery(
      record,
      createdAt,
      archiveManifestVersion,
    );
    return true;
  } catch {
    return false;
  }
}

/** The stat identity a recorded protected-path identity compares by. */
export function statIdentityOf(identity: string): string {
  return recordedStatIdentity(identity) ?? identity;
}

/** A directory's stat identity, or null when absent; a symlink or file refuses. */
export function readDirectoryStatIdentity(
  path: string,
): Promise<string | null> {
  return directoryIdentity(path);
}

/**
 * CAN-5024's identity for a path a discard may remove although no journal
 * recorded it: verified, or prefixed `unverifiable:`. Its probe creates and
 * removes a `.w5-birth-order-*` directory in the project directory.
 */
export function probeProtectedPathIdentity(
  path: string,
  workspaceId: string,
): Promise<string | null> {
  return protectedPathIdentity(path, workspaceId);
}

export function isVerifiedProtectedPathIdentity(identity: string): boolean {
  return !identity.startsWith(UNVERIFIABLE_IDENTITY);
}

/**
 * Worktree ids an unfinished destructive journal of this project still names
 * (CAN-5334 Q7): a new worktree must not take one, since the journal would
 * then block it and never resume. Unreadable journals are skipped; their
 * scanners refuse on their own.
 */
export async function listUnfinishedDestructiveWorktreeIds(
  workspaceId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let names: string[];
  try {
    names = await readdir(journalDirectory());
  } catch {
    return ids;
  }
  for (const name of names) {
    if (!/^([a-f0-9]{64}|[a-f0-9-]{36})\.json$/.test(name)) continue;
    try {
      const record = journalSchema.parse(
        JSON.parse(await readFile(join(journalDirectory(), name), 'utf8')),
      );
      if (
        record.workspaceId === workspaceId &&
        record.worktreeId !== undefined &&
        record.state !== 'completed'
      )
        ids.add(record.worktreeId);
    } catch {
      // Not this guard's evidence to judge.
    }
  }
  return ids;
}

/**
 * Removes the copy of the stranded record a discard superseded, once every
 * target is gone. Only a copy of that record for this worktree is removed.
 */
export async function retireSupersededDestructiveRecord(
  workspaceId: string,
  worktreeId: string,
  operationId: string,
): Promise<void> {
  if (!z.string().uuid().safeParse(operationId).success)
    throw recoveryRequired();
  const path = join(journalDirectory(), `${operationId}.json`);
  let record: DestructiveRecoveryRecord;
  try {
    record = journalSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (missing(error)) return;
    throw recoveryRequired();
  }
  if (
    record.operationId !== operationId ||
    record.workspaceId !== workspaceId ||
    record.worktreeId !== worktreeId
  )
    throw recoveryRequired(record);
  await rm(path, { force: true });
  await syncDirectory(journalDirectory());
}

/**
 * A discard that stopped before its claim left a copy of the journal it was
 * superseding. An ordinary lifecycle that takes that journal over removes the
 * copy before its first save: until then the slot still holds the same record,
 * so a crash in between leaves the state from before the discard. A discard
 * that refuses before its claim removes its own copy the same way (`owner`).
 */
async function retireStaleDiscardCopy(
  record: DestructiveRecoveryRecord,
  owner?: Lifecycle,
): Promise<void> {
  if (
    Array.from(running).some(
      (lifecycle) =>
        lifecycle !== owner && lifecycle.supersedes === record.operationId,
    )
  )
    return;
  const path = join(journalDirectory(), `${record.operationId}.json`);
  let copy: DestructiveRecoveryRecord;
  try {
    copy = journalSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (missing(error)) return;
    throw recoveryRequired(record);
  }
  if (
    copy.operationId !== record.operationId ||
    copy.workspaceId !== record.workspaceId ||
    copy.worktreeId !== record.worktreeId ||
    copy.state === 'completed'
  )
    return;
  await rm(path, { force: true });
  await syncDirectory(journalDirectory());
}

/**
 * Runs a user-confirmed worktree discard (CAN-5334) under the existing
 * worktree deletion envelope and archive lock. The caller verified every
 * target before calling, so no refusal follows a journal write and nothing is
 * ever withdrawn: a failure leaves the journal `recovery-required`, and an
 * explicit retry resumes it with `resume`.
 *
 * `supersede` is the stranded record this discard replaces: it is first
 * copied durably to `<operationId>.json`, then the slot takes the discard
 * journal. `ownedPaths` are the confirmed targets plus the protected paths
 * (`identity: null` must stay absent). An absent path is done, an unchanged
 * one is still a target, and any other refuses.
 */
export async function withWorktreeDiscardLifecycle<T>(
  input: {
    workspaceId: string;
    worktreeId: string;
    createdAt: string;
    supersede?: DestructiveRecoveryRecord;
    resume?: DestructiveRecoveryRecord;
    ownedPaths: DestructiveRecoveryRecord['ownedPaths'];
    /** Authoritative row read; null once the row is removed. */
    readCreatedAt: () => Promise<string | null>;
    projectOutcome: (result: T) => unknown;
  },
  work: () => Promise<T>,
): Promise<T> {
  if (current()) throw recoveryRequired(current()?.record);
  await assertNoArchiveResolution(input.workspaceId, input.worktreeId);
  const previous = await readDestructiveRecovery(
    input.workspaceId,
    input.worktreeId,
  );
  const unfinished =
    previous !== null && previous.state !== 'completed' ? previous : null;
  if (input.resume) {
    if (
      unfinished?.operationId !== input.resume.operationId ||
      !isWorktreeDiscardRecord(unfinished) ||
      unfinished.createdAt !== input.createdAt ||
      !isOwnerless(unfinished)
    )
      throw recoveryRequired(unfinished ?? undefined);
  } else if (input.supersede) {
    if (
      unfinished?.operationId !== input.supersede.operationId ||
      unfinished.createdAt !== input.createdAt ||
      !isOwnerless(unfinished)
    )
      throw recoveryRequired(unfinished ?? undefined);
  } else if (unfinished) throw recoveryRequired(unfinished);
  const resumed = input.resume ? unfinished : null;
  const identity = resumed
    ? resumed.directoryIdentity
    : await projectDirectoryIdentity(input.workspaceId, true);
  if (
    resumed &&
    !isRecordedProjectDirectory(
      await projectDirectoryIdentity(input.workspaceId),
      resumed.directoryIdentity,
    )
  )
    throw recoveryRequired(resumed);
  const record: DestructiveRecoveryRecord = resumed
    ? { ...resumed, state: 'active', cleanupRequired: false }
    : {
        version: 1,
        operationId: randomUUID(),
        operation: 'worktree-delete',
        trigger: 'manual',
        ...(input.supersede?.supersedesArchives
          ? { supersedesArchives: input.supersede.supersedesArchives }
          : {}),
        workspaceId: input.workspaceId,
        worktreeId: input.worktreeId,
        createdAt: input.createdAt,
        directoryIdentity: identity,
        state: 'active',
        steps: [],
        ownedPaths: input.ownedPaths,
      };
  const supersedes = resumed
    ? supersededDiscardOperationId(resumed)
    : input.supersede?.operationId;
  const lifecycle: Lifecycle = {
    record,
    queue: createSerialQueue(),
    failed: false,
    canonicalRemoved:
      resumed !== null &&
      resumed.steps.some((step) => step.phase === 'canonical-row-removal') &&
      (await input.readCreatedAt()) === null,
    resumingArchiveCleanup: false,
    active: true,
    childrenStepFree: false,
    withdrawalAttempted: false,
    ...(supersedes ? { supersedes } : {}),
    checkIdentity: async () => {
      if (
        !isRecordedProjectDirectory(
          await projectDirectoryIdentity(input.workspaceId),
          identity,
        )
      )
        throw recoveryRequired(lifecycle.record, 'check-identity');
      const createdAt = await input.readCreatedAt();
      if (
        createdAt !== input.createdAt &&
        !(createdAt === null && lifecycle.canonicalRemoved)
      )
        throw recoveryRequired(lifecycle.record, 'check-identity');
      for (const owned of lifecycle.record.ownedPaths) {
        const actual = await directoryIdentity(owned.path);
        if (actual === null) continue;
        if (
          owned.identity === null ||
          actual !== statIdentityOf(owned.identity)
        )
          throw recoveryRequired(lifecycle.record, 'check-identity');
      }
    },
  };
  return context.run(lifecycle, async () => {
    running.add(lifecycle);
    try {
      if (!resumed) {
        // Copy aside first: a crash before the claim leaves both files with
        // the same record, which a retry supersedes again.
        await mkdir(journalDirectory(), { recursive: true, mode: 0o700 });
        // A completed earlier incarnation keeps its outcome, as B5's does.
        const completed = previous?.state === 'completed' ? previous : null;
        for (const kept of [input.supersede, completed])
          if (kept)
            await writeFileAtomically(
              join(journalDirectory(), `${kept.operationId}.json`),
              JSON.stringify(kept),
              { durable: true, mode: 0o600 },
            );
        await lifecycle.checkIdentity();
        record.steps.push({
          phase: input.supersede
            ? `${SUPERSEDE_PHASE_PREFIX}${input.supersede.operationId}`
            : `${DISCARD_PHASE_PREFIX}begin`,
          state: 'done',
        });
      } else await lifecycle.checkIdentity();
      await save(record);
      const result = await work();
      if (lifecycle.failed) throw recoveryRequired(record);
      record.state = 'completed';
      record.outcome = input.projectOutcome(result);
      await save(record);
      return result;
    } catch (error) {
      if (record.steps.length && record.state !== 'completed') {
        record.state = 'recovery-required';
        await save(record).catch(() => undefined);
        report(record);
      } else if (!record.steps.length && input.supersede)
        // Refused before the claim: the slot still holds the superseded record.
        await retireStaleDiscardCopy(input.supersede, lifecycle).catch(
          () => undefined,
        );
      throw error;
    } finally {
      lifecycle.active = false;
      running.delete(lifecycle);
    }
  });
}

/** Fresh ownership evidence for startup's absent-registration repair. Unreadable evidence refuses repair. */
export async function hasDestructiveWorktreeOwner(
  workspaceId: string,
  worktreeId: string,
  checkoutPath: string,
): Promise<boolean> {
  const checkout = await canonicalizePossiblyMissingPath(checkoutPath);
  const contains = (parent: string, child: string): boolean => {
    const suffix = relative(parent, child);
    return (
      !suffix ||
      (!isAbsolute(suffix) &&
        suffix !== '..' &&
        !suffix.startsWith('../') &&
        !suffix.startsWith('..\\'))
    );
  };
  const owns = async (record: DestructiveRecoveryRecord): Promise<boolean> => {
    if (record.state === 'completed') return false;
    if (
      record.workspaceId === workspaceId &&
      (record.worktreeId === undefined || record.worktreeId === worktreeId)
    )
      return true;
    for (const owned of record.ownedPaths) {
      const path = await canonicalizePossiblyMissingPath(owned.path);
      if (contains(path, checkout) || contains(checkout, path)) return true;
    }
    return false;
  };
  for (const { record, active } of running)
    if (active && (await owns(record))) return true;
  return withSharedJournalAccess(async () => {
    let names: string[];
    try {
      names = await readdir(journalDirectory());
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
    for (const name of names) {
      if (!LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN.test(name)) continue;
      if (
        await owns(await readDestructiveJournal(join(journalDirectory(), name)))
      )
        return true;
    }
    return false;
  });
}

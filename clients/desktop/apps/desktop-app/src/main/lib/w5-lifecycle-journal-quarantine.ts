import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import {
  LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN,
  LifecycleJournalQuarantineRequestSchema,
  type LifecycleJournalEntryMatch,
  type LifecycleJournalInspection,
  type LifecycleJournalQuarantineResult,
  type LifecycleJournalUnreadableEntry,
} from '@canopy/protocol/portal/lifecycle-journal';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { syncDirectory } from '@canopy/execution-engine/node/lib/atomic-file';
import {
  getDataDir,
  getW5DestructiveLifecycleDir,
  getW5QuarantinedLifecycleDir,
} from './paths';
import { logMainProcessWarn } from './main-process-logging';
import { readWorkspaceIndexEntries } from './sidebar-items';
import { readWorkspaceWorktrees } from './workspace-persistence';
import {
  isUnverifiableLifecycleIdentity,
  lifecycleJournalEntryIdentity,
  lifecycleJournalEntryState,
  lifecycleJournalEntryStatIdentity,
  lifecycleJournalSlotName,
  withExclusiveLifecycleJournalAccess,
  withSharedLifecycleJournalAccess,
} from './w5-destructive-recovery';
import { createSerialQueue } from './w5-file-store';

/**
 * Every failure of the move, in user-facing copy: a refusal, or `failed` and
 * `unconfirmed` for filesystem errors before and after the rename. The
 * underlying error, which names host paths, is logged instead.
 */
export class LifecycleJournalQuarantineRefusedError extends Error {
  constructor(
    readonly reason:
      | 'changed'
      | 'missing'
      | 'readable'
      | 'unverifiable'
      | 'failed'
      | 'unconfirmed',
    message: string,
  ) {
    super(message);
    this.name = 'LifecycleJournalQuarantineRefusedError';
  }
}

const MAX_REPORTED_ENTRIES = 100;
const serialize = createSerialQueue();

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function entryKind(stat: Stats): LifecycleJournalUnreadableEntry['kind'] {
  if (stat.isSymbolicLink()) return 'other';
  if (stat.isDirectory()) return 'directory';
  return stat.isFile() ? 'file' : 'other';
}

/** Projects a host location into the contract's display-only label. */
export type LifecycleJournalLocationProjector = (path: string) => string;

/**
 * The portable label, and the default: the location relative to the data
 * folder (`<data>/w5/…`), so no host path reaches the Portal.
 */
export function portableLifecycleJournalLocationLabel(
  path: string,
  dataDir: string = getDataDir(),
): string {
  const inside = relative(dataDir, path);
  if (!inside) return '<data>';
  const segments = inside.split(/[\\/]/);
  // Outside the data folder (no current caller): the name alone.
  if (segments[0] === '..' || isAbsolute(inside))
    return `<data>/…/${basename(path)}`;
  return `<data>/${segments.join('/')}`;
}

/**
 * The desktop host adapter's local label: the home folder becomes `~`
 * (`%USERPROFILE%` on Windows); any other location is shown as is.
 */
export function lifecycleJournalLocationLabel(
  path: string,
  home: string = homedir(),
  platform: ReturnType<typeof hostOperatingSystem> = hostOperatingSystem(),
): string {
  const windows = platform === 'win32';
  const separator = windows ? '\\' : '/';
  const base = home.endsWith(separator) ? home.slice(0, -1) : home;
  const fold = (value: string): string =>
    windows ? value.toLowerCase() : value;
  if (!base || !fold(path).startsWith(`${fold(base)}${separator}`)) return path;
  return `${windows ? '%USERPROFILE%' : '~'}${path.slice(base.length)}`;
}

/**
 * Hashed slots of listed projects and worktrees. Best effort: an unreadable
 * index only loses names, since a name is shown on a positive match alone.
 */
async function listedSlots(): Promise<Map<string, LifecycleJournalEntryMatch>> {
  const slots = new Map<string, LifecycleJournalEntryMatch>();
  let workspaces;
  try {
    workspaces = await readWorkspaceIndexEntries();
  } catch {
    return slots;
  }
  for (const workspace of workspaces) {
    slots.set(lifecycleJournalSlotName(workspace.id), {
      kind: 'project',
      workspaceId: workspace.id,
      projectName: workspace.name,
    });
    if (workspace.type === 'cowork') continue;
    const worktrees = await readWorkspaceWorktrees(workspace.id, {
      persistRemovalCleanup: false,
    }).catch(() => []);
    for (const worktree of worktrees)
      slots.set(lifecycleJournalSlotName(workspace.id, worktree.id), {
        kind: 'worktree',
        workspaceId: workspace.id,
        worktreeId: worktree.id,
        projectName: workspace.name,
        worktreeName: worktree.label ?? worktree.branchName,
      });
  }
  return slots;
}

/**
 * CAN-5335: the recognized entries every journal scanner refuses on. Writes
 * only the CAN-5024 birth-order probes, which it removes; never an entry.
 * Scans with the journal scanners' shared access, so it waits for a running
 * move and never reports an entry clear while the move puts it back.
 */
export async function inspectLifecycleJournal(
  label: LifecycleJournalLocationProjector = portableLifecycleJournalLocationLabel,
): Promise<LifecycleJournalInspection> {
  const directory = getW5DestructiveLifecycleDir();
  const scan = await withSharedLifecycleJournalAccess(() =>
    scanUnreadableEntries(directory),
  );
  if (scan.status === 'directory-unreadable') {
    logMainProcessWarn('W5 destructive lifecycle journal cannot be listed', {
      journalDirectory: directory,
      error: scan.error,
    });
    return {
      status: 'directory-unreadable',
      locationLabel: label(directory),
    };
  }
  if (!scan.entries.length)
    return {
      status: 'clear',
      locationLabel: label(directory),
    };
  // Outside the journal access: names come from the workspace index alone.
  const slots = await listedSlots();
  return {
    status: 'unreadable-entries',
    locationLabel: label(directory),
    quarantineLocationLabel: label(getW5QuarantinedLifecycleDir()),
    entries: scan.entries.map((entry) => {
      const match = slots.get(entry.name);
      return match ? { ...entry, match } : entry;
    }),
  };
}

async function scanUnreadableEntries(
  directory: string,
): Promise<
  | { status: 'listed'; entries: LifecycleJournalUnreadableEntry[] }
  | { status: 'directory-unreadable'; error: unknown }
> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { status: 'listed', entries: [] };
    return { status: 'directory-unreadable', error };
  }
  const entries: LifecycleJournalUnreadableEntry[] = [];
  for (const name of names.sort()) {
    if (entries.length >= MAX_REPORTED_ENTRIES) break;
    if (!LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN.test(name)) continue;
    if ((await lifecycleJournalEntryState(name)) !== 'unreadable') continue;
    let identity;
    try {
      identity = await lifecycleJournalEntryIdentity(
        join(directory, name),
        directory,
      );
    } catch (error) {
      // Listable but not searchable: no entry can be examined, as the scanners report.
      return { status: 'directory-unreadable', error };
    }
    if (!identity) continue;
    entries.push({
      name,
      kind: entryKind(identity.stat),
      identity: identity.identity,
      identityVerified: identity.verified,
    });
  }
  return { status: 'listed', entries };
}

/** Sorts by move time; the original name stays a readable suffix. */
function quarantinedName(name: string): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `${stamp}-${randomUUID().slice(0, 8)}-${name}`;
}

async function ensureQuarantineDirectory(): Promise<string> {
  const quarantine = getW5QuarantinedLifecycleDir();
  const created = await mkdir(quarantine, { recursive: true, mode: 0o700 });
  if (created)
    for (let directory = quarantine; ; directory = dirname(directory)) {
      await syncDirectory(directory);
      if (directory === dirname(created)) break;
    }
  const stat = await lstat(quarantine);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('The quarantine location is not a folder.');
  return quarantine;
}

const CHANGED =
  'This record changed after you reviewed it, so it was not moved. Review it again.';

/** A replacement left the journal name and isn't confirmed back there. */
function putBackUnconfirmed(): LifecycleJournalQuarantineRefusedError {
  return new LifecycleJournalQuarantineRefusedError(
    'unconfirmed',
    'This record changed during the move, and the newer record may not be back in place. Check the quarantine folder before you continue.',
  );
}

/**
 * User-only (CAN-5335, Q6 A): moves exactly the confirmed unreadable entry,
 * bytes unchanged, into {@link getW5QuarantinedLifecycleDir}. Never deletes.
 * It refuses when the entry changed, was replaced, became readable or has an
 * unverifiable identity; a failed move leaves the original in place. Journal
 * scans and saves wait for the move, so none sees it half done.
 */
export function quarantineLifecycleJournalEntry(
  request: unknown,
  label: LifecycleJournalLocationProjector = portableLifecycleJournalLocationLabel,
): Promise<LifecycleJournalQuarantineResult> {
  const parsed = LifecycleJournalQuarantineRequestSchema.safeParse(request);
  if (!parsed.success)
    return Promise.reject(new Error('Invalid operation record request.'));
  const { name, identity } = parsed.data;
  const progress = { renamed: false };
  return serialize(() =>
    withExclusiveLifecycleJournalAccess(() =>
      moveEntry(name, identity, progress, label),
    ),
  ).catch((error: unknown) => {
    // A definite refusal stands only while the journal name is in place.
    if (
      error instanceof LifecycleJournalQuarantineRefusedError &&
      (error.reason === 'unconfirmed' || !progress.renamed)
    )
      throw error;
    logMainProcessWarn('W5 lifecycle journal quarantine failed', {
      name,
      renamed: progress.renamed,
      error,
    });
    throw progress.renamed
      ? new LifecycleJournalQuarantineRefusedError(
          'unconfirmed',
          "The record was moved, but saving the move couldn't be confirmed. Review it again before you continue.",
        )
      : new LifecycleJournalQuarantineRefusedError(
          'failed',
          "Couldn't move the record. It's still where it was. Try again.",
        );
  });
}

async function moveEntry(
  name: string,
  identity: string,
  progress: { renamed: boolean },
  label: LifecycleJournalLocationProjector,
): Promise<LifecycleJournalQuarantineResult> {
  const directory = getW5DestructiveLifecycleDir();
  const source = join(directory, name);
  // Only an identity verified at review cannot match a later replacement;
  // the fresh probe also refuses a filesystem that lost birth order since.
  const current = await lifecycleJournalEntryIdentity(source, directory);
  if (!current)
    throw new LifecycleJournalQuarantineRefusedError(
      'missing',
      'This record is no longer there, so nothing was moved.',
    );
  if (isUnverifiableLifecycleIdentity(identity) || !current.verified)
    throw new LifecycleJournalQuarantineRefusedError(
      'unverifiable',
      "This record's identity couldn't be confirmed, so it was not moved. Move it manually.",
    );
  // Readable first: whatever is there now no longer refuses as unreadable.
  if ((await lifecycleJournalEntryState(name)) === 'readable')
    throw new LifecycleJournalQuarantineRefusedError(
      'readable',
      'This record can be read now, so it was not moved. Try your action again.',
    );
  if (current.identity !== identity)
    throw new LifecycleJournalQuarantineRefusedError('changed', CHANGED);
  const quarantine = await ensureQuarantineDirectory();
  const move = { name, identity, source, directory, quarantine, progress };
  const destinationName = current.stat.isFile()
    ? await linkFileEntry(move, current.stat)
    : await renameEntry(move, current.stat);
  const destination = join(quarantine, destinationName);
  await syncDirectory(quarantine);
  await syncDirectory(directory);
  logMainProcessWarn('W5 unreadable lifecycle journal entry quarantined', {
    name,
    identity,
    journalDirectory: directory,
    destination,
  });
  return {
    status: 'quarantined',
    name,
    quarantinedName: destinationName,
    quarantineLocationLabel: label(quarantine),
  };
}

interface EntryMove {
  name: string;
  identity: string;
  source: string;
  directory: string;
  quarantine: string;
  progress: { renamed: boolean };
}

/** Collisions are retried under a new name; the first claim almost always wins. */
const MAX_DESTINATION_ATTEMPTS = 5;
/** FAT-family volumes, and Linux `protected_hardlinks`, refuse the link. */
const LINK_UNSUPPORTED = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'];

/**
 * Claims a fresh quarantine name with `claim`, which fails EEXIST rather than
 * replace whatever holds it, so no earlier quarantined record is overwritten.
 */
async function claimDestination(
  move: EntryMove,
  claim: (destination: string) => Promise<void>,
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const destinationName = quarantinedName(move.name);
    try {
      await claim(join(move.quarantine, destinationName));
      return destinationName;
    } catch (error) {
      if (!hasCode(error, 'EEXIST') || attempt >= MAX_DESTINATION_ATTEMPTS)
        throw error;
    }
  }
}

async function isSameEntry(first: string, second: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    lstat(first).catch(() => null),
    lstat(second).catch(() => null),
  ]);
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

/**
 * Drops the quarantine name of a file whose journal name still links to it.
 * Removes a name only, never bytes; anything else at either name is kept.
 * Residual: by path, so a same-user swap after the check loses its name.
 */
async function dropExtraLink(
  move: EntryMove,
  destination: string,
): Promise<void> {
  if (await isSameEntry(move.source, destination))
    await unlink(destination).catch((error: unknown) => {
      logMainProcessWarn('W5 lifecycle journal quarantine left a second link', {
        name: move.name,
        destination,
        error,
      });
    });
}

/**
 * A file is hard-linked into the quarantine, which never replaces a name, and
 * stays in the journal folder until that link holds the confirmed entry and
 * is synced. Only then is its journal name moved aside, never unlinked.
 */
async function linkFileEntry(move: EntryMove, stat: Stats): Promise<string> {
  const { name, identity, source, quarantine } = move;
  if ((await lifecycleJournalEntryStatIdentity(source)) !== identity)
    throw new LifecycleJournalQuarantineRefusedError('changed', CHANGED);
  let destinationName: string;
  try {
    destinationName = await claimDestination(move, (destination) =>
      link(source, destination),
    );
  } catch (error) {
    // A filesystem without hard links for this file still allows the rename.
    if (!LINK_UNSUPPORTED.some((code) => hasCode(error, code))) throw error;
    return renameEntry(move, stat);
  }
  const destination = join(quarantine, destinationName);
  try {
    if ((await lifecycleJournalEntryStatIdentity(destination)) !== identity) {
      // Replaced before the link: the replacement keeps its journal name.
      await dropExtraLink(move, destination);
      throw new LifecycleJournalQuarantineRefusedError('changed', CHANGED);
    }
    await syncDirectory(quarantine);
    // Changed after the link: whatever holds the journal name stays there.
    // A replaced entry keeps only its quarantine name; nothing is unlinked.
    if ((await lifecycleJournalEntryStatIdentity(source)) !== identity) {
      await dropExtraLink(move, destination);
      logMainProcessWarn(
        'W5 lifecycle journal entry changed during quarantine',
        { name, destination },
      );
      throw new LifecycleJournalQuarantineRefusedError('changed', CHANGED);
    }
  } catch (error) {
    if (!(error instanceof LifecycleJournalQuarantineRefusedError))
      await dropExtraLink(move, destination);
    throw error;
  }
  await moveJournalNameAside(move, destination);
  return destinationName;
}

/**
 * Removes a linked file's journal name by renaming it to a fresh quarantine
 * name, so an entry that replaced it after the last check is moved, not
 * deleted, and goes back (`unconfirmed` when that put-back isn't confirmed).
 * Only then is the spare name of the confirmed entry unlinked. Residual (by
 * path; Node has no unlinkat or renameat2 NOREPLACE): a same-user process that
 * fills or swaps that fresh, random name loses it.
 */
async function moveJournalNameAside(
  move: EntryMove,
  destination: string,
): Promise<void> {
  const spare = join(move.quarantine, quarantinedName(move.name));
  try {
    await rename(move.source, spare);
  } catch (error) {
    await dropExtraLink(move, destination);
    throw error;
  }
  move.progress.renamed = true;
  if (await isSameEntry(spare, destination)) {
    await unlink(spare).catch((error: unknown) => {
      logMainProcessWarn('W5 lifecycle journal quarantine left a second link', {
        name: move.name,
        destination: spare,
        error,
      });
    });
    return;
  }
  // Replaced after the last check: the confirmed entry keeps its quarantine
  // name, and the replacement returns to the journal.
  const restored = await putBackSpare(move, spare);
  logMainProcessWarn('W5 lifecycle journal entry changed during quarantine', {
    name: move.name,
    destination,
    restored,
  });
  if (!restored) throw putBackUnconfirmed();
  // The identity check can fail on the confirmed entry itself; once it is
  // back in the journal, its quarantine link is a second name, not a move.
  await dropExtraLink(move, destination);
  move.progress.renamed = false;
  throw new LifecycleJournalQuarantineRefusedError('changed', CHANGED);
}

/**
 * A file goes back by hard link, which never replaces a newer journal entry;
 * anything else by rename only while the slot is free. What can't go back
 * stays in the quarantine, never deleted. True only when the replacement holds
 * its journal name again and both folders are synced.
 */
async function putBackSpare(move: EntryMove, spare: string): Promise<boolean> {
  let restored = false;
  try {
    const stat = await lstat(spare);
    if (stat.isFile()) {
      await link(spare, move.source);
      restored = await isSameEntry(move.source, spare);
      if (restored)
        await unlink(spare).catch((error: unknown) => {
          logMainProcessWarn(
            'W5 lifecycle journal quarantine left a second link',
            { name: move.name, destination: spare, error },
          );
        });
    } else if (
      (await lifecycleJournalEntryStatIdentity(move.source)) === null
    ) {
      // Residual: by path, as in renameEntry's put-back.
      await rename(spare, move.source);
      restored = true;
    }
  } catch (error) {
    logMainProcessWarn('W5 lifecycle journal replacement left in quarantine', {
      name: move.name,
      spare,
      error,
    });
  }
  return syncAfterPutBack(move, restored);
}

/** Syncs both folders after a put-back; any failure leaves it unconfirmed. */
async function syncAfterPutBack(
  move: EntryMove,
  restored: boolean,
): Promise<boolean> {
  let synced = true;
  for (const directory of [move.directory, move.quarantine]) {
    try {
      await syncDirectory(directory);
    } catch (error) {
      synced = false;
      logMainProcessWarn('W5 lifecycle journal put-back sync failed', {
        name: move.name,
        directory,
        error,
      });
    }
  }
  return restored && synced;
}

/**
 * A directory, a link, or a file without hard-link support moves by rename
 * into an exclusively created empty placeholder (a folder for a directory), so
 * the rename replaces only that placeholder. Windows never renames a directory
 * over an existing name, so a directory there takes no placeholder.
 */
async function renameEntry(move: EntryMove, stat: Stats): Promise<string> {
  const { name, identity, source, quarantine, progress } = move;
  const isDirectory = stat.isDirectory();
  const placeholder = !isDirectory || hostOperatingSystem() !== 'win32';
  const destinationName = await claimDestination(move, async (destination) => {
    if (!placeholder) return;
    if (isDirectory) await mkdir(destination, { mode: 0o700 });
    else await writeFile(destination, '', { flag: 'wx', mode: 0o600 });
  });
  const destination = join(quarantine, destinationName);
  const claimed = placeholder ? await lstat(destination) : null;
  // The narrowest window: re-check right before the atomic rename.
  if ((await lifecycleJournalEntryStatIdentity(source)) !== identity) {
    await dropPlaceholder(destination, claimed);
    throw new LifecycleJournalQuarantineRefusedError('changed', CHANGED);
  }
  // Residual (by-path, no renameat2 NOREPLACE): another same-user process
  // can still replace the source, caught below, or put a file at a file
  // placeholder's name, which this rename replaces.
  try {
    await rename(source, destination);
  } catch (error) {
    await dropPlaceholder(destination, claimed);
    // Moving a directory to another folder rewrites its `..` entry, which
    // needs write permission on it. Retrying can't help; changing it would.
    if (
      isDirectory &&
      (stat.mode & 0o200) === 0 &&
      (hasCode(error, 'EACCES') || hasCode(error, 'EPERM'))
    ) {
      logMainProcessWarn('W5 lifecycle journal quarantine failed', {
        name,
        renamed: false,
        error,
      });
      throw new LifecycleJournalQuarantineRefusedError(
        'failed',
        "Couldn't move this folder because its permissions don't allow it. It's still where it was. Move it manually.",
      );
    }
    throw error;
  }
  progress.renamed = true;
  if ((await lifecycleJournalEntryStatIdentity(destination)) !== identity) {
    // Replaced inside the window: put back what was moved if its slot is
    // free. Residual: an external writer filling the slot after this check is
    // replaced; this process's saves wait for the move.
    let restored = false;
    try {
      if ((await lifecycleJournalEntryStatIdentity(source)) === null) {
        await rename(destination, source);
        restored = true;
      }
    } catch (error) {
      logMainProcessWarn(
        'W5 lifecycle journal replacement left in quarantine',
        {
          name,
          spare: destination,
          error,
        },
      );
    }
    restored = await syncAfterPutBack(move, restored);
    logMainProcessWarn('W5 lifecycle journal entry changed during quarantine', {
      name,
      destination,
      restored,
    });
    if (!restored) throw putBackUnconfirmed();
    progress.renamed = false;
    throw new LifecycleJournalQuarantineRefusedError('changed', CHANGED);
  }
  return destinationName;
}

/**
 * Removes this move's own unused placeholder: an empty folder (`rmdir` fails
 * on any content) or an empty file still on the inode it was created on.
 * Residual: by path, as {@link dropExtraLink}.
 */
async function dropPlaceholder(
  destination: string,
  claimed: Stats | null,
): Promise<void> {
  if (!claimed) return;
  try {
    const stat = await lstat(destination);
    if (stat.dev !== claimed.dev || stat.ino !== claimed.ino) return;
    if (stat.isDirectory()) await rmdir(destination);
    else if (stat.isFile() && stat.size === 0) await unlink(destination);
  } catch (error) {
    logMainProcessWarn('W5 lifecycle journal quarantine left a placeholder', {
      destination,
      error,
    });
  }
}

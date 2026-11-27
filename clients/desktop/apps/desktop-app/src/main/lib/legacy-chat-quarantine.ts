/**
 * A legacy chat snapshot no reader can recover (CAN-7851). When a scope's
 * tabs or archives file, and its `.bak`, both fail to parse or validate, the
 * scope's migration fails on every attempt and the format 4 sweep can never
 * finish. This module tells that case apart from a missing or unreadable
 * file, and sets such a family aside under a new name so the next migration
 * keeps its bytes as required recovery evidence and builds the scope from
 * whatever else it can read.
 *
 * It reads each file through the same streaming reader and validators the
 * migration uses, so a file is only ever called corrupt when migration would
 * reject it too. An errno other than ENOENT is never corrupt. Nor is a family
 * the journal still needs: migration's own loader must read the scope with
 * the corrupt families absent, skipping no journal write, and no journal
 * record may refer to a chat only they held, before any of them is set aside.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ChatCoreMutation } from '@canopy/desktop-shared/types';
import { isArchivedSnapshot, isChatTabsSnapshot } from './chat-state-snapshots';
import { fsyncDirectory } from './fsync-directory';
import { LegacyChatInput } from './legacy-chat-input';
import {
  loadLegacyChatMigrationSource,
  type LegacyChatScopePaths,
} from './legacy-chat-migration';
import { isErrnoException } from './type-guards';

export type LegacyFamilyState = 'missing' | 'valid' | 'corrupt' | 'io';

/** What a scope's legacy snapshots read as, with a content-free fingerprint. */
export interface LegacyScopeProbe {
  /** `corrupt` when at least one family is corrupt and none reads as `io`. */
  readonly state: LegacyFamilyState;
  /** The corrupt families' primary paths. */
  readonly corrupt: readonly string[];
  /** A hash of the corrupt files' identity and times; never their bytes. */
  readonly fingerprint?: string;
  /**
   * `journal` when migration fails, or would skip journal writes, with the
   * corrupt families absent: the journal refers to what only they held, so
   * they are never set aside.
   */
  readonly blocked?: 'journal';
}

/** What a failed legacy load learns about its corrupt snapshots. */
export type LegacyUnrecoverable =
  | { readonly kind: 'set_aside'; readonly fingerprint: string }
  | { readonly kind: 'journal' };

const QUARANTINE_SUFFIX = /\.unrecoverable-(\d+)$/;

type FileState = 'missing' | 'valid' | 'invalid' | 'io';

/** A snapshot's state, and the chats it holds when it is valid. */
interface FileRead {
  readonly state: FileState;
  readonly chats: readonly string[];
}

const tabsChats = (value: unknown): readonly string[] | undefined =>
  isChatTabsSnapshot(value) ? value.tabs.map((tab) => tab.id) : undefined;

const archivedChats = (value: unknown): readonly string[] | undefined =>
  isArchivedSnapshot(value)
    ? value.archived.map((entry) => entry.tab.id)
    : undefined;

/**
 * A filesystem errno such as ENOENT or EACCES. Node's own `ERR_*` codes, the
 * fatal UTF-8 decoder's among them, are about the bytes, not the disk.
 */
function isFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return (
    isErrnoException(error) &&
    typeof error.code === 'string' &&
    /^E[A-Z0-9]+$/.test(error.code)
  );
}

function hasFilesystemCause(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (isFilesystemError(current)) return true;
    current =
      typeof current === 'object' && current !== null
        ? Reflect.get(current, 'cause')
        : undefined;
  }
  return false;
}

async function readState(
  input: LegacyChatInput,
  file: string,
  chatsOf: (value: unknown) => readonly string[] | undefined,
): Promise<FileRead> {
  try {
    const chats = chatsOf(await input.snapshot(file));
    return chats === undefined
      ? { state: 'invalid', chats: [] }
      : { state: 'valid', chats };
  } catch (error) {
    if (isFilesystemError(error))
      return { state: error.code === 'ENOENT' ? 'missing' : 'io', chats: [] };
    return { state: 'invalid', chats: [] };
  }
}

/**
 * The chats a journal mutation makes known (created or removed), and the
 * groups of chat ids it refers to; a group resolves when any of its ids is
 * known.
 */
function mutationChats(mutation: ChatCoreMutation): {
  readonly known: readonly string[];
  readonly refers: ReadonlyArray<readonly string[]>;
} {
  switch (mutation.type) {
    case 'tab.created':
      return { known: [mutation.tab.id], refers: [] };
    case 'archive.upserted':
      return { known: [mutation.entry.tab.id], refers: [] };
    case 'tab.removed':
      return { known: [mutation.tabId], refers: [] };
    case 'archive.removed':
      return { known: [mutation.chatId, mutation.archiveEntryId], refers: [] };
    case 'tab.active_changed':
      return { known: [], refers: [] };
    case 'tab.metadata_patched':
      return { known: [], refers: [[mutation.tabId]] };
    case 'tab.order_changed':
      return { known: [], refers: mutation.tabIds.map((id) => [id]) };
    case 'pending_question.upserted':
      return { known: [], refers: [[mutation.question.chatId]] };
    case 'archive.read_state_changed':
      return {
        known: [],
        refers: [[mutation.chatId, mutation.archiveEntryId]],
      };
    default:
      return { known: [], refers: [[mutation.chatId]] };
  }
}

/**
 * Whether a journal record refers to a chat that no readable snapshot holds
 * and the journal neither creates nor removes: a chat only the corrupt files
 * held. Migration drops some such records without counting them (a runtime
 * patch, an archive's read state), so setting the files aside would lose
 * them unseen.
 */
async function refersToLostChats(
  input: LegacyChatInput,
  journal: string,
  readable: ReadonlySet<string>,
): Promise<boolean> {
  const known = new Set(readable);
  const refers: Array<readonly string[]> = [];
  try {
    for await (const record of input.journal(journal, true))
      for (const mutation of record.mutations) {
        const chats = mutationChats(mutation);
        for (const id of chats.known) known.add(id);
        refers.push(...chats.refers);
      }
  } catch (error) {
    if (isFilesystemError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
  return refers.some((group) => !group.some((id) => known.has(id)));
}

function familyState(primary: FileState, backup: FileState): LegacyFamilyState {
  if (primary === 'valid' || backup === 'valid') return 'valid';
  if (primary === 'io' || backup === 'io') return 'io';
  if (primary === 'missing' && backup === 'missing') return 'missing';
  return 'corrupt';
}

async function identity(file: string): Promise<string | undefined> {
  try {
    const value = await stat(file, { bigint: true });
    return `${basename(file)}:${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Reads the scope's tabs and archives families as migration would. The
 * journal family is never judged here: a journal that can't be replayed stays
 * a migration failure.
 */
export async function probeLegacyScope(
  paths: LegacyChatScopePaths,
): Promise<LegacyScopeProbe> {
  const root = dirname(dirname(paths.tabs));
  await mkdir(root, { recursive: true });
  const scratch = await mkdtemp(join(root, '.chat-quarantine-probe-'));
  let input: LegacyChatInput | undefined;
  try {
    input = await LegacyChatInput.create(scratch);
    const families: Array<
      [string, (value: unknown) => readonly string[] | undefined]
    > = [
      [paths.tabs, tabsChats],
      [paths.archives, archivedChats],
    ];
    const corrupt: string[] = [];
    const readable = new Set<string>();
    let io = false;
    for (const [path, chatsOf] of families) {
      const primary = await readState(input, path, chatsOf);
      const backup = await readState(input, `${path}.bak`, chatsOf);
      for (const id of [...primary.chats, ...backup.chats]) readable.add(id);
      const state = familyState(primary.state, backup.state);
      if (state === 'io') io = true;
      if (state === 'corrupt') corrupt.push(path);
    }
    if (io) return { state: 'io', corrupt: [] };
    if (corrupt.length === 0) return { state: 'valid', corrupt };
    const without = (path: string): string =>
      corrupt.includes(path)
        ? join(scratch, 'set-aside', basename(path))
        : path;
    try {
      if (await refersToLostChats(input, paths.journal, readable))
        return { state: 'corrupt', corrupt, blocked: 'journal' };
      const source = await loadLegacyChatMigrationSource(input, {
        tabs: without(paths.tabs),
        archives: without(paths.archives),
        journal: paths.journal,
      });
      // Gap recovery would promote the scope without the writes it skips.
      if ((source.revisionGapRecovery?.skippedMutationCount ?? 0) > 0)
        return { state: 'corrupt', corrupt, blocked: 'journal' };
    } catch (error) {
      if (hasFilesystemCause(error)) return { state: 'io', corrupt: [] };
      return { state: 'corrupt', corrupt, blocked: 'journal' };
    }
    const identities: string[] = [];
    for (const path of corrupt)
      for (const file of [path, `${path}.bak`]) {
        const value = await identity(file);
        if (value !== undefined) identities.push(value);
      }
    const fingerprint = createHash('sha256')
      .update(identities.sort().join('\n'))
      .digest('hex');
    return { state: 'corrupt', corrupt, fingerprint };
  } finally {
    await input?.close().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Whether the scope's snapshots are unrecoverable, and whether setting them
 * aside would let the scope migrate.
 */
export async function unrecoverableLegacyScope(
  paths: LegacyChatScopePaths,
): Promise<LegacyUnrecoverable | undefined> {
  const probe = await probeLegacyScope(paths);
  if (probe.blocked === 'journal') return { kind: 'journal' };
  return probe.fingerprint === undefined
    ? undefined
    : { kind: 'set_aside', fingerprint: probe.fingerprint };
}

async function nextIndex(path: string): Promise<number> {
  const prefix = `${basename(path)}.`;
  let highest = 0;
  for (const name of await readdir(dirname(path))) {
    if (!name.startsWith(prefix)) continue;
    const match = QUARANTINE_SUFFIX.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/**
 * Sets aside each corrupt family, primary and `.bak`, as
 * `<file>.unrecoverable-<n>`, but only when the scope still probes corrupt
 * with exactly `expected` as its fingerprint. Returns whether it did. The
 * caller holds the scope's lease and loads the scope at once, so migration
 * copies the set-aside bytes into recovery evidence before anything else.
 */
export async function quarantineLegacyScope(
  paths: LegacyChatScopePaths,
  expected: string,
): Promise<boolean> {
  const probe = await probeLegacyScope(paths);
  if (probe.state !== 'corrupt' || probe.fingerprint !== expected) return false;
  for (const path of probe.corrupt) {
    const index = await nextIndex(path);
    for (const file of [path, `${path}.bak`]) {
      if ((await identity(file)) === undefined) continue;
      await rename(file, `${file}.unrecoverable-${index}`);
    }
    await fsyncDirectory(dirname(path));
  }
  return true;
}

/** Whether a legacy file name is a set-aside copy, and the name it came from. */
export function quarantinedSource(name: string): string | undefined {
  const match = QUARANTINE_SUFFIX.exec(name);
  return match ? name.slice(0, match.index) : undefined;
}

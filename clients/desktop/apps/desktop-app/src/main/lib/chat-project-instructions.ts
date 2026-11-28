import { ensureWorkspaceWriteDirectory } from './cowork-folder-guard';
import { constants as bufferConstants } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  open,
  readlink,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
  win32,
} from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  instructionFileErrorCode,
  InstructionCounterpartCopyError,
  isDirectInstructionAlias,
  EDITABLE_INSTRUCTION_ALIAS_RULES,
  resolveProjectInstructionFile,
  UnsupportedInstructionLayoutError,
} from '@canopy/core-runtime/node/workspace/instruction-files';
import type {
  AppAdvisorClaudeMdLoadResponse,
  AppAdvisorClaudeMdSaveRequest,
  ChatProjectClaudeMdResponse,
  ChatProjectInstructionFileName,
  SaveChatProjectClaudeMdResult,
} from '@canopy/desktop-shared/types';
import {
  createInstructionCounterpartExclusive,
  type InstructionCounterpartCreation,
} from './instruction-files';
import { writeStoreFileDurably } from './durable-store-write';
import { serializeChatProjectOperation } from './chat-project-operation-queue';

const names: readonly ChatProjectInstructionFileName[] = [
  'AGENTS.md',
  'CLAUDE.md',
];
const epochs = new Map<string, number>();
const managedRevisionSession = randomUUID();
// The managed home queue serializes loads and saves. Keep one verified
// rollback mapping so open drafts can retry with their original revision.
let recoveredManagedRevision: { physical: string; draft: string } | undefined;
export class InstructionsChangedError extends Error {}
type Entry = { stats: Stats; bytes?: Buffer; link?: string };
type Observation = {
  rootStat: Stats | undefined;
  response: ChatProjectClaudeMdResponse;
  entries: Record<ChatProjectInstructionFileName, Entry | undefined>;
};

function managedDraftRevision(physical: string): string {
  return recoveredManagedRevision?.physical === physical
    ? recoveredManagedRevision.draft
    : physical;
}

function identity(stats: Stats): string {
  return [
    stats.dev,
    stats.ino,
    stats.nlink,
    stats.mode,
    stats.size,
    stats.mtimeMs,
    stats.ctimeMs,
  ].join(':');
}

function sameInode(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function assertManagedInstructionLinks(
  agents: Stats | undefined,
  claude: Stats | undefined,
): void {
  const limit =
    agents?.isFile() && claude?.isFile() && sameInode(agents, claude) ? 2 : 1;
  if (
    (agents?.isFile() && agents.nlink > limit) ||
    (claude?.isFile() && claude.nlink > limit)
  )
    throw new UnsupportedInstructionLayoutError(
      'An instruction file has a hard link outside the instructions pair.',
    );
}

/** Windows must inspect link components before any lookup that follows them. */
async function inspectWindowsInstructionTarget(
  root: string,
  linkTarget: string,
): Promise<{ path: string; stats: Stats | undefined }> {
  const refuse = (): never => {
    throw new UnsupportedInstructionLayoutError(
      'The instruction link must stay within the Orchestrator home.',
    );
  };
  const target = linkTarget.replace(/\//g, '\\');
  const home = root.replace(/\//g, '\\').replace(/\\+$/, '');
  let relativeTarget = target;
  if (win32.isAbsolute(target)) {
    if (target.startsWith('\\\\')) refuse();
    const targetHome = target.slice(0, home.length);
    const suffix = target.slice(home.length);
    if (targetHome.toLowerCase() !== home.toLowerCase()) refuse();
    if (!suffix) relativeTarget = '.';
    else if (suffix.startsWith('\\')) relativeTarget = suffix.slice(1);
    else refuse();

    // On case-sensitive Windows directories, a case variant may name a
    // different entry. Inspect changed components through the trusted spelling
    // of their parent before rebasing the target onto the managed home.
    let canonical = root;
    let alternate = targetHome;
    while (targetHome !== home && dirname(canonical) !== canonical) {
      const parent = dirname(canonical);
      const alternateName = win32.basename(alternate);
      if (alternateName !== basename(canonical)) {
        const differentlyCased = await lstat(join(parent, alternateName), {
          bigint: true,
        });
        const expected = await lstat(canonical, { bigint: true });
        if (
          differentlyCased.dev !== expected.dev ||
          differentlyCased.ino !== expected.ino
        )
          refuse();
      }
      canonical = parent;
      alternate = win32.dirname(alternate);
    }
  }
  const segments = relativeTarget.split('\\').filter(Boolean);
  let path = root;
  for (const [index, segment] of segments.entries()) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (path === root) refuse();
      path = dirname(path);
      continue;
    }
    // Refuse drive-relative paths, alternate streams and names Windows may
    // normalize into a different component.
    if (segment.includes(':') || /[. ]$/.test(segment)) refuse();
    path = join(path, segment);
    if (index < segments.length - 1) {
      const directory = await lstat(path);
      if (!directory.isDirectory() || directory.isSymbolicLink()) refuse();
    }
  }
  const stats = await optionalStat(path);
  if (stats?.isSymbolicLink()) refuse();
  return { path, stats };
}

async function managedAliasReachesCounterpart(
  path: string,
  counterpart: string,
  target: Entry | undefined,
  linkTarget: string,
): Promise<boolean> {
  const name = basename(counterpart);
  const windows = hostOperatingSystem() === 'win32';
  const targetName = windows
    ? win32.basename(linkTarget)
    : basename(linkTarget);
  // basename drops a trailing separator, which requires a directory target.
  if (!linkTarget.endsWith(targetName)) return false;
  // Keep the parent segments for the filesystem to resolve. Normalizing first
  // can hide an intermediate symlink that changes the parent directory.
  const root = dirname(path);
  const rawTarget = isAbsolute(linkTarget)
    ? linkTarget
    : `${root}${sep}${linkTarget}`;
  try {
    if (windows) {
      const inspected = await inspectWindowsInstructionTarget(root, linkTarget);
      if (dirname(inspected.path) !== root) return false;
      if (!target) return inspected.path === counterpart && !inspected.stats;
      return Boolean(
        targetName.toLowerCase() === name.toLowerCase() &&
        inspected.stats?.isFile() &&
        sameInode(inspected.stats, target.stats),
      );
    }
    if (targetName !== name) {
      if (!target || targetName.toLowerCase() !== name.toLowerCase())
        return false;
      // A case variant is valid only when this filesystem treats it as the
      // same regular entry in the home. A further symlink cannot establish that.
      const direct = await lstat(rawTarget);
      return (
        direct.isFile() &&
        sameInode(direct, target.stats) &&
        sameInode(await stat(dirname(rawTarget)), await stat(root)) &&
        sameInode(await stat(path), target.stats)
      );
    }
    if (target)
      return (
        sameInode(await stat(path), target.stats) &&
        (await realpath(path)) === (await realpath(counterpart))
      );
    return (await realpath(dirname(rawTarget))) === (await realpath(root));
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(
        instructionFileErrorCode(error) ?? '',
      )
    )
      return false;
    throw error;
  }
}

async function physicalTargetIsInHome(
  root: string,
  target: string,
): Promise<boolean> {
  const home = await stat(root, { bigint: true });
  // Windows path comparisons can fold case even when the directory is
  // case-sensitive. Check the resolved target and its parents by identity.
  let directory = target;
  while (true) {
    const ancestor = await stat(directory, { bigint: true });
    if (ancestor.dev === home.dev && ancestor.ino === home.ino) return true;
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

async function optionalStat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (instructionFileErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function observe(
  root: string,
  managedHome = false,
): Promise<Observation> {
  let rootStat: Stats | undefined;
  try {
    rootStat = await stat(root);
    if (!rootStat.isDirectory())
      throw new UnsupportedInstructionLayoutError(
        'The instructions folder must be a directory.',
      );
  } catch (error) {
    if (instructionFileErrorCode(error) !== 'ENOENT') throw error;
  }
  const entries: Observation['entries'] = {
    'AGENTS.md': undefined,
    'CLAUDE.md': undefined,
  };
  for (const name of names) {
    const path = join(root, name);
    const stats = await optionalStat(path);
    if (!stats) continue;
    if (!stats.isFile() && !stats.isSymbolicLink())
      throw new UnsupportedInstructionLayoutError(
        `${name} must be a regular file or a link to the other instruction file in this folder.`,
      );
    entries[name] = { stats };
  }
  if (managedHome)
    assertManagedInstructionLinks(
      entries['AGENTS.md']?.stats,
      entries['CLAUDE.md']?.stats,
    );
  for (const name of names) {
    const entry = entries[name];
    if (!entry) continue;
    const path = join(root, name);
    if (entry.stats.isSymbolicLink()) {
      const other = name === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
      const target = entries[other];
      const linkTarget = await readlink(path);
      const matchesCounterpart =
        !target?.stats.isSymbolicLink() &&
        (managedHome
          ? await managedAliasReachesCounterpart(
              path,
              join(root, other),
              target,
              linkTarget,
            )
          : await isDirectInstructionAlias(
              path,
              join(root, other),
              { readlink: () => Promise.resolve(linkTarget) },
              EDITABLE_INSTRUCTION_ALIAS_RULES,
            ));
      if (!matchesCounterpart)
        throw new UnsupportedInstructionLayoutError(
          `Cannot edit ${name} through this symbolic link. Use a link to the other instruction file in the same folder.`,
        );
      entry.link = linkTarget;
    } else {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (identity(await file.stat()) !== identity(entry.stats))
          throw new InstructionsChangedError(
            'The instructions changed while loading. Reload the folder.',
          );
        entry.bytes = await file.readFile();
        if (identity(await file.stat()) !== identity(entry.stats))
          throw new InstructionsChangedError(
            'The instructions changed while loading. Reload the folder.',
          );
      } finally {
        await file.close();
      }
    }
  }
  // Resolve against the same observed entries, rather than a second set of reads.
  const observedEntry = (path: string): Entry | undefined =>
    path === join(root, 'AGENTS.md')
      ? entries['AGENTS.md']
      : entries['CLAUDE.md'];
  const target = await resolveProjectInstructionFile(
    root,
    {
      lstat: (path) => {
        const entry = observedEntry(path);
        return entry
          ? Promise.resolve(entry.stats)
          : Promise.reject(
              Object.assign(new Error('Missing instruction file'), {
                code: 'ENOENT',
              }),
            );
      },
      // Managed links already passed physical validation above. Present the
      // verified same-folder counterpart to the shared layout resolver.
      readlink: (path) => {
        const link = observedEntry(path)?.link;
        if (!managedHome || link === undefined)
          return Promise.resolve(link ?? '');
        const counterpart =
          path === join(root, 'AGENTS.md') ? 'CLAUDE.md' : 'AGENTS.md';
        return Promise.resolve(counterpart);
      },
      readText: (path) =>
        Promise.resolve(observedEntry(path)?.bytes?.toString('utf8') ?? ''),
      assertReadable: () => Promise.resolve(),
    },
    EDITABLE_INSTRUCTION_ALIAS_RULES,
  );
  const empty = !entries['AGENTS.md'] && !entries['CLAUDE.md'];
  const fileName =
    empty || target.filePath === join(root, 'CLAUDE.md')
      ? 'CLAUDE.md'
      : 'AGENTS.md';
  const counterpart = fileName === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
  const layout =
    entries[counterpart]?.link !== undefined
      ? 'alias'
      : target.mirrorPath
        ? 'mirrors'
        : entries[counterpart]
          ? 'divergent'
          : 'create-counterpart';
  const hash = createHash('sha256').update(
    JSON.stringify([
      root,
      rootStat ? [rootStat.dev, rootStat.ino] : null,
      managedHome ? managedRevisionSession : (epochs.get(root) ?? 0),
    ]),
  );
  for (const name of names) {
    const entry = entries[name];
    hash.update(
      JSON.stringify([name, entry ? identity(entry.stats) : null, entry?.link]),
    );
    if (entry?.bytes) hash.update(entry.bytes);
  }
  if (managedHome) {
    // A later file read can overlap replacement of an entry already observed.
    for (const name of names) {
      const path = join(root, name);
      const earlier = entries[name];
      const current = await optionalStat(path);
      const counterpart = name === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
      if (
        (earlier && identity(earlier.stats)) !==
          (current && identity(current)) ||
        (earlier?.link !== undefined &&
          ((await readlink(path)) !== earlier.link ||
            !(await managedAliasReachesCounterpart(
              path,
              join(root, counterpart),
              entries[counterpart],
              earlier.link,
            ))))
      )
        throw new InstructionsChangedError(
          'The instructions changed while loading. Reload the folder.',
        );
    }
    if (!rootStat || !sameInode(rootStat, await stat(root)))
      throw new InstructionsChangedError(
        'The instructions folder changed. Reload the folder.',
      );
  }
  return {
    rootStat,
    entries,
    response: {
      content: entries[fileName]?.bytes?.toString('utf8') ?? '',
      fileName,
      layout,
      revision: hash.digest('hex'),
    },
  };
}

/** Read-only, including when a managed home does not exist yet. */
export async function loadChatProjectInstructions(
  rootDir: string,
): Promise<ChatProjectClaudeMdResponse> {
  return (await observe(resolve(rootDir))).response;
}

/**
 * Writes use an exclusively created or no-follow descriptor and preserve existing
 * inodes. Revision validation is not a filesystem transaction: another process
 * can still write an opened inode or replace an ancestor directory after checks.
 */
async function openObservedFile(
  root: string,
  name: ChatProjectInstructionFileName,
  entry: Entry | undefined,
): Promise<FileHandle> {
  const flags =
    constants.O_RDWR |
    constants.O_NOFOLLOW |
    (entry ? 0 : constants.O_CREAT | constants.O_EXCL);
  let file;
  try {
    file = await open(join(root, name), flags, 0o666);
  } catch (error) {
    if (
      ['EEXIST', 'ELOOP', 'ENOENT'].includes(
        instructionFileErrorCode(error) ?? '',
      )
    )
      throw new InstructionsChangedError(
        'The instruction file changed. Reload the folder before saving.',
      );
    throw error;
  }
  try {
    if (entry && identity(await file.stat()) !== identity(entry.stats))
      throw new InstructionsChangedError(
        'The instruction file changed. Reload the folder before saving.',
      );
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

type WriteProgress = {
  before: Buffer;
  offset: number;
  truncated: boolean;
  revision?: string;
};

async function matchesInstructionBytes(
  file: FileHandle,
  expected: Buffer,
): Promise<boolean> {
  const observed = await file.stat();
  if (observed.size !== expected.length) return false;
  const buffer = Buffer.alloc(Math.min(expected.length, 64 * 1024));
  let position = 0;
  while (position < expected.length) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, expected.length - position),
      position,
    );
    if (
      bytesRead === 0 ||
      !buffer
        .subarray(0, bytesRead)
        .equals(expected.subarray(position, position + bytesRead))
    )
      return false;
    position += bytesRead;
  }
  return identity(await file.stat()) === identity(observed);
}

async function writeInstructionBytes(
  file: FileHandle,
  bytes: Buffer,
  mode?: WriteProgress | 'replace',
): Promise<void> {
  const progress = typeof mode === 'object' ? mode : undefined;
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (result.bytesWritten === 0)
      throw new Error('The instruction file could not be written.');
    offset += result.bytesWritten;
    if (progress) {
      progress.offset = offset;
      delete progress.revision;
      progress.revision = identity(await file.stat());
    }
  }
  if (progress) {
    const previousTail = progress.before.subarray(bytes.length);
    if (previousTail.length) {
      const expected = Buffer.concat([bytes, previousTail]);
      if (!(await matchesInstructionBytes(file, expected)))
        throw new InstructionsChangedError(
          'The instructions changed during the save. Reload the folder.',
        );
      await file.truncate(bytes.length);
    }
  } else if (mode === 'replace') {
    await file.truncate(bytes.length);
  }
  if (progress) {
    progress.truncated = true;
    delete progress.revision;
    progress.revision = identity(await file.stat());
  }
  await file.sync();
}

async function writeObservedFile(
  root: string,
  name: ChatProjectInstructionFileName,
  entry: Entry | undefined,
  content: string,
  writing: () => void,
): Promise<void> {
  if (entry?.bytes?.toString('utf8') === content) return;
  const file = await openObservedFile(root, name, entry);
  try {
    writing();
    await writeInstructionBytes(file, Buffer.from(content, 'utf8'), 'replace');
  } finally {
    await file.close();
  }
}

async function restoreInstructionBytes(
  file: FileHandle,
  before: Buffer,
  after: Buffer,
  progress: WriteProgress,
): Promise<string | undefined> {
  if (progress.offset === 0 && !progress.truncated) return;
  const expected = progress.truncated
    ? after
    : Buffer.concat([
        after.subarray(0, progress.offset),
        before.subarray(progress.offset),
      ]);
  const observed = identity(await file.stat());
  if (
    observed !== progress.revision ||
    !(await matchesInstructionBytes(file, expected)) ||
    identity(await file.stat()) !== observed
  )
    throw new InstructionsChangedError(
      'The instructions changed during the save. Reload the folder.',
    );
  // Restore only our recorded write on the same descriptor, even if the
  // parent directory moved. Never reopen a path that may now name another file.
  const restoring: WriteProgress = {
    before: expected,
    offset: 0,
    truncated: false,
  };
  await writeInstructionBytes(file, before, restoring);
  return restoring.revision;
}

function matchesRestoredEntry(
  before: Entry | undefined,
  after: Entry | undefined,
  restoredIdentity: string | undefined,
): boolean {
  return Boolean(
    before &&
    after &&
    sameInode(before.stats, after.stats) &&
    before.stats.mode === after.stats.mode &&
    before.stats.nlink === after.stats.nlink &&
    before.link === after.link &&
    identity(after.stats) === (restoredIdentity ?? identity(before.stats)) &&
    (!before.bytes || after.bytes?.equals(before.bytes)),
  );
}

async function verifySavedManagedPair(
  root: string,
  observed: Observation,
  savedBytes: Buffer,
  layout = observed.response.layout,
): Promise<Observation> {
  const saved = await observe(root, true);
  const samePair = names.every((name): boolean => {
    const before = observed.entries[name];
    const after = saved.entries[name];
    return Boolean(
      before &&
      after &&
      sameInode(before.stats, after.stats) &&
      before.link === after.link,
    );
  });
  if (
    !observed.rootStat ||
    !saved.rootStat ||
    !sameInode(observed.rootStat, saved.rootStat) ||
    !samePair ||
    saved.response.layout !== layout ||
    saved.response.fileName !== observed.response.fileName ||
    !saved.entries[observed.response.fileName]?.bytes?.equals(savedBytes) ||
    (layout === 'mirrors' &&
      !saved.entries['CLAUDE.md']?.bytes?.equals(savedBytes))
  )
    throw new InstructionsChangedError(
      'The instructions changed during the save. Reload the folder.',
    );
  return saved;
}

async function observeClosedManagedPair(
  root: string,
  verified: Observation,
  written: readonly Stats[],
): Promise<Observation> {
  // Windows can update write timestamps when the last writer closes. Only
  // accept that drift on inodes we wrote and whose bytes still match.
  if (hostOperatingSystem() !== 'win32') return verified;
  const closed = await observe(root, true);
  if (
    !verified.rootStat ||
    !closed.rootStat ||
    !sameInode(verified.rootStat, closed.rootStat) ||
    !names.every((name) => {
      const before = verified.entries[name];
      const after = closed.entries[name];
      if (!before) return after === undefined;
      if (!after) return false;
      if (!written.some((stats) => sameInode(stats, before.stats)))
        return matchesRestoredEntry(before, after, undefined);
      return (
        sameInode(before.stats, after.stats) &&
        before.stats.birthtimeMs === after.stats.birthtimeMs &&
        before.stats.mode === after.stats.mode &&
        before.stats.nlink === after.stats.nlink &&
        before.link === after.link &&
        before.bytes !== undefined &&
        after.bytes !== undefined &&
        before.bytes.equals(after.bytes)
      );
    })
  )
    throw new InstructionsChangedError(
      'The instructions changed. Reload the folder.',
    );
  return closed;
}

// Only a verified, synced primary write authorizes recovery. Version 1
// receipts recorded intent before that write, so recovery must ignore them.
function copySaveReceipt(
  root: Stats,
  primary: Stats,
  mirror: Stats,
  before: Buffer,
  after: Buffer,
): string {
  return JSON.stringify([
    2,
    [root.dev, root.ino, root.birthtimeMs],
    [primary.birthtimeMs, identity(primary)],
    identity(mirror),
    createHash('sha256').update(before).digest('hex'),
    createHash('sha256').update(after).digest('hex'),
  ]);
}

function writeCopySaveReceipt(path: string, receipt: string): Promise<void> {
  return writeStoreFileDurably(path, receipt, { mode: 0o600 });
}

async function hasCopySaveReceipt(
  path: string,
  expected: string,
): Promise<boolean> {
  let file: FileHandle;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (
      ['ENOENT', 'ELOOP', 'EACCES', 'EPERM'].includes(
        instructionFileErrorCode(error) ?? '',
      )
    )
      return false;
    throw error;
  }
  try {
    const stats = await file.stat();
    return (
      stats.isFile() &&
      stats.nlink === 1 &&
      (await matchesInstructionBytes(file, Buffer.from(expected)))
    );
  } finally {
    await file.close();
  }
}

async function recoverManagedCopySave(
  root: string,
  observed: Observation,
  pendingPath: string,
): Promise<Observation> {
  const primary = observed.entries['CLAUDE.md'];
  const mirror = observed.entries['AGENTS.md'];
  const after = primary?.bytes;
  const before = mirror?.bytes;
  if (
    !observed.rootStat ||
    !primary ||
    !mirror ||
    !after ||
    !before ||
    before.equals(after) ||
    !(await hasCopySaveReceipt(
      pendingPath,
      copySaveReceipt(
        observed.rootStat,
        primary.stats,
        mirror.stats,
        before,
        after,
      ),
    ))
  )
    return observed;

  const file = await openObservedFile(root, 'AGENTS.md', mirror);
  const progress = { before, offset: 0, truncated: false };
  let outcome:
    | { recovered: Observation }
    | { cause: unknown; restored?: Observation };
  try {
    const current = await observe(root, true);
    if (current.response.revision !== observed.response.revision)
      throw new InstructionsChangedError('Reload the folder before saving.');
    await writeInstructionBytes(file, after, progress);
    outcome = {
      recovered: await verifySavedManagedPair(root, observed, after, 'mirrors'),
    };
  } catch (error) {
    const restoredIdentity = await restoreInstructionBytes(
      file,
      before,
      after,
      progress,
    );
    outcome = { cause: error };
    if (restoredIdentity) {
      const restored = await observe(root, true).catch(() => undefined);
      if (
        restored?.rootStat &&
        sameInode(observed.rootStat, restored.rootStat) &&
        matchesRestoredEntry(
          primary,
          restored.entries['CLAUDE.md'],
          undefined,
        ) &&
        matchesRestoredEntry(
          mirror,
          restored.entries['AGENTS.md'],
          restoredIdentity,
        )
      )
        outcome.restored = restored;
    }
  } finally {
    await file.close();
  }
  if ('recovered' in outcome) {
    const recovered = await observeClosedManagedPair(root, outcome.recovered, [
      mirror.stats,
    ]);
    // A retained receipt cannot match the now-equal pair.
    await unlink(pendingPath).catch(() => undefined);
    return recovered;
  }
  const restored =
    outcome.restored &&
    (await observeClosedManagedPair(root, outcome.restored, [
      mirror.stats,
    ]).catch(() => undefined));
  const restoredMirror = restored?.entries['AGENTS.md'];
  if (restored?.rootStat && restoredMirror)
    await writeCopySaveReceipt(
      pendingPath,
      copySaveReceipt(
        restored.rootStat,
        primary.stats,
        restoredMirror.stats,
        before,
        after,
      ),
    );
  throw outcome.cause;
}

async function saveManagedPair(
  root: string,
  observed: Observation,
  content: string,
  pendingPath: string,
): Promise<string> {
  const isCopyPair = observed.response.layout === 'mirrors';
  const fileName = isCopyPair ? 'CLAUDE.md' : observed.response.fileName;
  const primaryEntry = observed.entries[fileName];
  const mirrorEntry = isCopyPair ? observed.entries['AGENTS.md'] : undefined;
  const before = primaryEntry?.bytes;
  if (!before || (isCopyPair && !mirrorEntry?.bytes?.equals(before)))
    throw new InstructionsChangedError('Reload the folder before saving.');
  const after =
    !isCopyPair && before.toString('utf8') === content
      ? before
      : Buffer.from(content, 'utf8');
  if (before.equals(after))
    return (await verifySavedManagedPair(root, observed, after)).response
      .revision;
  // Open both copies before either can change. Hard links share one inode.
  const primary = await openObservedFile(root, fileName, primaryEntry);
  let mirror: FileHandle | undefined;
  const written: Stats[] = [];
  let outcome:
    | { saved: Observation }
    | { cause: unknown; restored?: Observation };
  try {
    if (mirrorEntry && !sameInode(primaryEntry.stats, mirrorEntry.stats))
      mirror = await openObservedFile(root, 'AGENTS.md', mirrorEntry);
    const current = await observe(root, true);
    if (
      current.response.revision !== observed.response.revision ||
      identity(await primary.stat()) !== identity(primaryEntry.stats)
    )
      throw new InstructionsChangedError('Reload the folder before saving.');
    const primaryProgress: WriteProgress = {
      before,
      offset: 0,
      truncated: false,
    };
    const mirrorProgress: WriteProgress = {
      before,
      offset: 0,
      truncated: false,
    };
    try {
      await writeInstructionBytes(primary, after, primaryProgress);
      const rootStat = observed.rootStat;
      if (mirror && mirrorEntry && rootStat) {
        const primaryStats = await primary.stat();
        const primaryVersion = identity(primaryStats);
        const mirrorVersion = identity(mirrorEntry.stats);
        const mirrorHandle = mirror;
        const verifyCopyPaths = async (): Promise<void> => {
          if (
            identity(await primary.stat()) !== primaryVersion ||
            identity(await lstat(join(root, fileName))) !== primaryVersion ||
            identity(await mirrorHandle.stat()) !== mirrorVersion ||
            identity(await lstat(join(root, 'AGENTS.md'))) !== mirrorVersion ||
            !sameInode(rootStat, await stat(root))
          )
            throw new InstructionsChangedError(
              'The instructions changed during the save. Reload the folder.',
            );
        };
        if (
          primaryVersion !== primaryProgress.revision ||
          !(await matchesInstructionBytes(primary, after))
        )
          throw new InstructionsChangedError(
            'The instructions changed during the save. Reload the folder.',
          );
        await verifyCopyPaths();
        await writeCopySaveReceipt(
          pendingPath,
          copySaveReceipt(
            rootStat,
            primaryStats,
            mirrorEntry.stats,
            before,
            after,
          ),
        );
        await verifyCopyPaths();
        await writeInstructionBytes(mirrorHandle, after, mirrorProgress);
      }
      // Keep the original handles available for recovery until the complete
      // pair has been verified.
      outcome = { saved: await verifySavedManagedPair(root, observed, after) };
      written.push(primaryEntry.stats);
      if (mirror && mirrorEntry) written.push(mirrorEntry.stats);
    } catch (error) {
      const [primaryRollback, mirrorRollback] = await Promise.allSettled([
        restoreInstructionBytes(primary, before, after, primaryProgress),
        mirror &&
          restoreInstructionBytes(mirror, before, after, mirrorProgress),
      ]);
      outcome = { cause: error };
      if (
        primaryRollback.status === 'fulfilled' &&
        mirrorRollback.status === 'fulfilled'
      ) {
        const restored = await observe(root, true).catch(() => undefined);
        if (
          observed.rootStat &&
          restored?.rootStat &&
          sameInode(observed.rootStat, restored.rootStat) &&
          names.every((name) => {
            const entry = observed.entries[name];
            return matchesRestoredEntry(
              entry,
              restored.entries[name],
              entry && sameInode(entry.stats, primaryEntry.stats)
                ? primaryRollback.value
                : mirrorRollback.value,
            );
          })
        ) {
          outcome.restored = restored;
          if (primaryRollback.value) written.push(primaryEntry.stats);
          if (mirrorRollback.value && mirrorEntry)
            written.push(mirrorEntry.stats);
        }
      }
    }
  } finally {
    try {
      await mirror?.close();
    } finally {
      await primary.close();
    }
  }
  if ('saved' in outcome) {
    const saved = await observeClosedManagedPair(root, outcome.saved, written);
    if (mirror) await unlink(pendingPath).catch(() => undefined);
    return saved.response.revision;
  }
  const restored =
    outcome.restored &&
    (await observeClosedManagedPair(root, outcome.restored, written).catch(
      () => undefined,
    ));
  if (restored) {
    recoveredManagedRevision = {
      physical: restored.response.revision,
      draft: managedDraftRevision(observed.response.revision),
    };
    if (mirror) await unlink(pendingPath).catch(() => undefined);
  }
  const message = restored
    ? "Couldn't save the instructions. Try saving again."
    : 'The instruction save could not be fully restored. Reload the folder.';
  throw Object.assign(new Error(message), { cause: outcome.cause });
}

function conflict(): SaveChatProjectClaudeMdResult {
  return {
    status: 'conflict',
    reloadRequired: true,
    message:
      'The instructions folder changed. Reload it before saving. Your edits have not been saved.',
  };
}

/** Home startup can use an existing layout without opening it for editing. */
export async function scaffoldManagedInstructionPair(
  root: string,
  defaultContent: string,
): Promise<void> {
  const entries = await Promise.all(
    names.map((name) => optionalStat(join(root, name))),
  );
  assertManagedInstructionLinks(entries[0], entries[1]);
  if (entries[0]?.isSymbolicLink()) {
    const alias = join(root, 'AGENTS.md');
    let target: string | undefined;
    try {
      if (hostOperatingSystem() === 'win32') {
        const inspected = await inspectWindowsInstructionTarget(
          root,
          await readlink(alias),
        );
        assertManagedInstructionLinks(inspected.stats, undefined);
      } else {
        target = await realpath(alias);
        const effective = await stat(alias);
        if (
          !(await physicalTargetIsInHome(root, target)) ||
          !sameInode(effective, await stat(target))
        )
          throw new UnsupportedInstructionLayoutError(
            'The agent instructions link resolves outside the Orchestrator home.',
          );
        assertManagedInstructionLinks(effective, undefined);
      }
    } catch (error) {
      const code = instructionFileErrorCode(error);
      // An inaccessible alias cannot supply instructions. Preserve it; once
      // a target resolves, permission errors during validation still fail.
      if (target === undefined && (code === 'EACCES' || code === 'EPERM'))
        return;
      // A broken alias can't provide instructions to the runtime. Leave it in
      // place while the ordinary scaffold handles any supported missing pair.
      if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code ?? '')) throw error;
    }
  }
  if (entries.every(Boolean)) return;
  if (
    entries.some(
      (entry) =>
        entry?.isFile() && entry.size > bufferConstants.MAX_STRING_LENGTH,
    )
  )
    return;
  let observed: Observation;
  try {
    observed = await observe(root, true);
  } catch (error) {
    // Pairing an existing local file is optional at startup. The settings
    // read and save paths still surface errors when they cannot open it.
    const code = instructionFileErrorCode(error);
    if (
      error instanceof UnsupportedInstructionLayoutError ||
      code === 'ERR_FS_FILE_TOO_LARGE' ||
      code === 'ERR_STRING_TOO_LONG' ||
      ((code === 'EACCES' || code === 'EPERM') &&
        entries.some((entry) => entry?.isFile()))
    )
      return;
    throw error;
  }
  await syncObservedManagedPair(root, defaultContent, observed);
}

/** The caller serializes operations on this managed home. */
export async function loadManagedInstructionPair(
  root: string,
  defaultContent: string,
  pendingPath: string,
): Promise<AppAdvisorClaudeMdLoadResponse> {
  const observed = await observe(root, true);
  return syncObservedManagedPair(
    root,
    defaultContent,
    await recoverManagedCopySave(root, observed, pendingPath),
  );
}

export async function saveManagedInstructionPair(
  root: string,
  { content, revision }: AppAdvisorClaudeMdSaveRequest,
  pendingPath: string,
): Promise<string> {
  const observed = await observe(root, true);
  if (managedDraftRevision(observed.response.revision) !== revision)
    throw new InstructionsChangedError(
      'The instructions changed. Reload them before saving.',
    );

  const { layout } = observed.response;
  if (layout === 'divergent' || managedInstructionBytesDiffer(observed))
    throw new UnsupportedInstructionLayoutError(
      'AGENTS.md and CLAUDE.md contain different instructions. Reconcile them before editing.',
    );
  if (layout === 'create-counterpart')
    throw new InstructionsChangedError(
      'Reload the instructions before saving.',
    );
  const savedRevision = await saveManagedPair(
    root,
    observed,
    content,
    pendingPath,
  );
  if (savedRevision !== observed.response.revision)
    recoveredManagedRevision = undefined;
  return managedDraftRevision(savedRevision);
}

function managedInstructionBytesDiffer({ entries }: Observation): boolean {
  const agents = entries['AGENTS.md']?.bytes;
  const claude = entries['CLAUDE.md']?.bytes;
  // Different invalid UTF-8 byte sequences can decode to the same text.
  return agents !== undefined && claude !== undefined && !agents.equals(claude);
}

async function syncObservedManagedPair(
  root: string,
  defaultContent: string,
  initial: Observation,
): Promise<AppAdvisorClaudeMdLoadResponse> {
  let observed = initial;
  const { fileName, layout } = observed.response;
  const counterpart = fileName === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
  const primary = observed.entries[fileName];
  const alias = observed.entries[counterpart];
  if (layout === 'divergent' || managedInstructionBytesDiffer(observed)) {
    // Display the historical Claude view of separately authored instructions.
    return {
      content: observed.entries['CLAUDE.md']?.bytes?.toString('utf8') ?? '',
      revision: observed.response.revision,
    };
  }

  let expected = primary;
  if (!expected) {
    const file = await openObservedFile(root, fileName, undefined);
    try {
      const bytes = Buffer.from(defaultContent, 'utf8');
      await writeInstructionBytes(file, bytes);
      if (!(await matchesInstructionBytes(file, bytes)))
        throw new InstructionsChangedError(
          'The instructions changed while creating the default file.',
        );
      expected = { stats: await file.stat(), bytes };
    } finally {
      await file.close();
    }
    if (layout === 'create-counterpart') {
      const closed = await observeClosedManagedPair(
        root,
        {
          ...observed,
          entries: { ...observed.entries, [fileName]: expected },
        },
        [expected.stats],
      );
      expected = closed.entries[fileName];
    }
  }
  let createdCounterpart: InstructionCounterpartCreation | undefined;
  if (layout === 'create-counterpart') {
    if (!expected?.bytes)
      throw new InstructionsChangedError('Reload the folder before pairing.');
    try {
      createdCounterpart = await createInstructionCounterpartExclusive(
        root,
        fileName,
        undefined,
        {
          allowWindowsCompatibilityFallback: true,
          sourceSnapshot: { bytes: expected.bytes, stats: expected.stats },
        },
      );
    } catch (error) {
      if (error instanceof InstructionCounterpartCopyError)
        throw Object.assign(error, { cause: error.copyError });
      throw error;
    }
  }

  if (!primary || layout === 'create-counterpart') {
    const paired = await observe(root, true);
    const pairedPrimary = paired.entries[fileName];
    const pairedAlias = paired.entries[counterpart];
    // Adding a hard link changes the inode's metadata. Compare that inode
    // and the exact bytes instead of its old metadata or decoded text.
    if (
      (paired.response.layout !== 'alias' &&
        paired.response.layout !== 'mirrors') ||
      (layout === 'create-counterpart' &&
        (!createdCounterpart ||
          !pairedAlias ||
          (createdCounterpart.method === 'copy'
            ? paired.response.layout !== 'mirrors'
            : identity(createdCounterpart.stats) !==
              identity(pairedAlias.stats)))) ||
      (alias &&
        (!pairedAlias ||
          !sameInode(alias.stats, pairedAlias.stats) ||
          alias.link !== pairedAlias.link)) ||
      !expected ||
      !pairedPrimary ||
      !sameInode(pairedPrimary.stats, expected.stats) ||
      !expected.bytes ||
      !pairedPrimary.bytes?.equals(expected.bytes) ||
      (paired.response.layout === 'mirrors' &&
        !pairedAlias?.bytes?.equals(expected.bytes))
    )
      throw new InstructionsChangedError(
        'The instructions changed. Reload the folder before saving.',
      );
    observed = paired;
  }
  const { content, revision } = observed.response;
  return { content, revision: managedDraftRevision(revision) };
}

export async function saveChatProjectInstructions(
  rootDir: string,
  request: { content: string; revision: string },
): Promise<SaveChatProjectClaudeMdResult> {
  if (
    typeof request.content !== 'string' ||
    typeof request.revision !== 'string' ||
    !request.revision
  )
    throw new Error('Instructions and a loaded revision are required.');
  const root = resolve(rootDir);
  return serializeChatProjectOperation(async () => {
    let observed;
    try {
      observed = await observe(root);
    } catch (error) {
      if (
        error instanceof InstructionsChangedError ||
        error instanceof UnsupportedInstructionLayoutError ||
        ['ELOOP', 'ENOENT'].includes(instructionFileErrorCode(error) ?? '')
      )
        return conflict();
      throw error;
    }
    if (observed.response.revision !== request.revision) return conflict();
    return saveObservedInstructions(root, observed, request.content);
  });
}

async function saveObservedInstructions(
  root: string,
  observed: Observation,
  content: string,
): Promise<SaveChatProjectClaudeMdResult> {
  const { fileName, layout } = observed.response;
  const counterpart = fileName === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
  const savedFiles: ChatProjectInstructionFileName[] = [];
  let failedFile = fileName;
  let stage: 'primary' | 'mirror' | 'counterpart' = 'primary';
  let mayHaveChanged = false;
  // Invalidates even a partial/no-op attempt; callers must reload before retry.
  epochs.set(root, (epochs.get(root) ?? 0) + 1);
  try {
    await ensureWorkspaceWriteDirectory(root);
    await writeObservedFile(
      root,
      fileName,
      observed.entries[fileName],
      content,
      () => {
        mayHaveChanged = true;
      },
    );
    savedFiles.push(fileName);
    failedFile = counterpart;
    mayHaveChanged = false;
    if (layout === 'mirrors') {
      stage = 'mirror';
      // Hard links already contain the new bytes; regular copies need a write.
      const primary = observed.entries[fileName]?.stats;
      const mirror = observed.entries[counterpart]?.stats;
      if (
        !primary ||
        !mirror ||
        primary.dev !== mirror.dev ||
        primary.ino !== mirror.ino
      )
        await writeObservedFile(
          root,
          counterpart,
          observed.entries[counterpart],
          content,
          () => {
            mayHaveChanged = true;
          },
        );
      savedFiles.push(counterpart);
    } else if (layout === 'create-counterpart') {
      stage = 'counterpart';
      await createInstructionCounterpartExclusive(root, fileName);
    }
    return { status: 'saved' };
  } catch (error) {
    if (error instanceof InstructionCounterpartCopyError) mayHaveChanged = true;
    if (savedFiles.length === 0 && !mayHaveChanged) {
      if (error instanceof InstructionsChangedError) return conflict();
      throw error;
    }
    const message =
      stage === 'counterpart'
        ? mayHaveChanged
          ? `${fileName} was saved, but ${counterpart} could not be fully copied and may have changed. Reload the folder before saving again.`
          : `${fileName} was saved, but ${counterpart} could not be paired. Reload the folder before saving again.`
        : stage === 'mirror'
          ? `${fileName} was saved, but ${counterpart} could not be fully saved. Reload the folder before saving again.`
          : `${fileName} could not be fully saved and may have changed. Reload the folder before saving again.`;
    return {
      status: 'partial-save',
      reloadRequired: true,
      savedFiles,
      failedFile,
      stage,
      failedFileMayHaveChanged: mayHaveChanged,
      message,
    };
  }
}

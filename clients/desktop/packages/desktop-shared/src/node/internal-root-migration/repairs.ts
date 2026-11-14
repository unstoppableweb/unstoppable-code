import { execFile } from 'node:child_process';
import { constants, lstatSync, rmSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import {
  internalRootMigrationAbortSignal,
  internalRootMigrationProgress,
  runInternalRootMigrationPhase,
} from './progress';
import { coordinateInternalRootMigration } from './index';
import {
  collectInternalRootCleanupCandidates,
  saveInternalRootCleanupReport,
  type InternalRootCleanupReport,
} from './cleanup-candidates';
import { promisify, isDeepStrictEqual } from 'node:util';
import {
  chmod,
  copyFile,
  open,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { observeStoragePathSync } from '@canopy/core-platform/storage-path-observation';
import {
  internalRootFilesystemHost,
  type InternalRootFilesystemHost,
} from './filesystem-host';
import {
  deriveLocalAuthorityIdentity,
  observeLocalAuthorityRelocation,
  hostLocalAuthorityObservation,
  type LocalAuthorityObservation,
} from '@canopy/core-platform';
import {
  createInternalRootRepairs,
  projectInternalRootMetadata,
  type InternalRootRepairWorker,
  type InternalRootRepairPlan,
  type InternalRootLifecycleJournalEvidence,
} from '@canopy/core-runtime/node/internal-root-repairs';
import {
  InternalRootMigrationRefused,
  type InternalRootIdentity,
  type InternalRootRepairContext,
} from '@canopy/core-runtime/node/internal-root-migration';
import {
  prepareRelocationGit,
  isMissingPrunableGitWorktree,
  qualifyRelocationGit,
  projectRelocationBacklinks,
  assertRelocationOwnedPathsSafe,
  relocationWorktreeOwnedPaths,
  isWithin,
  movedOwnedPath,
  type RelocationGit,
  type RelocationGitPlan,
  type RelocationWorkspaceEvidence,
} from '@canopy/core-runtime/node/relocation';
import { createWorkspaceIndexRepository } from '@canopy/core-runtime/node/w5/workspace-index-repository';
import { createWorkspaceManifestRepository } from '@canopy/core-runtime/node/w5/workspace-manifest-repository';
import { createWorktreeListRepository } from '@canopy/core-runtime/node/w5/worktree-list-repository';
import {
  readNodeW5File,
  type W5FileStore,
} from '@canopy/core-runtime/node/w5/file-store';
import { W5CommitLog } from '@canopy/core-runtime/node/w5/commit-log/commit-log';
import { applyW5Commit } from '@canopy/core-runtime/node/w5/commit-log/apply';
import { w5CommitLogLocation } from '@canopy/core-runtime/node/w5/commit-log/data-root';
import { assertRelocationW5Settled } from '@canopy/core-runtime/node/relocation';
import { fingerprintW5File } from '@canopy/core-runtime/node/w5/commit-log/fingerprint';
import type { W5DurabilityPort } from '@canopy/core-runtime/node/w5/commit-log';
import {
  abandonedArchivePaths,
  selectedAbandonedArchivePaths,
  assertAbandonedCheckouts,
} from './abandoned-paths';
import {
  freezeInternalRootJournals,
  internalRootJournalOwnedPaths,
  relocateInternalRootJournals,
} from './lifecycle-journals';
import {
  durableJson,
  assertPrivateMigrationFile,
  isPrunedInternalRootCheckout,
  privateDirectory,
  readInternalRootJournal,
  readInternalRootAbandonmentPlan,
  statIfPresent,
  validateExternalRootFiles,
} from './filesystem';

import { relocateInternalRootPipelineRecords } from './pipeline-records';
import {
  freezeInternalRootArchiveRecovery,
  normalizeInternalRootArchiveRecovery,
  internalRootArchiveRecoveryRepositories,
  relocateInternalRootArchiveRecovery,
} from './archive-recovery';

function pipelineRecordRepairEvidence(context: InternalRootRepairContext): {
  path: string;
  value: {
    version: 1;
    transactionId: string;
    source: string;
    destination: string;
  };
} {
  return {
    path: join(
      context.workingRoot,
      `.pipeline-record-relocation-${context.transactionId}.json`,
    ),
    value: {
      version: 1,
      transactionId: context.transactionId,
      source: context.identity.source,
      destination: context.identity.destination,
    },
  };
}

const execute = promisify(execFile);
function portableGitFilesystem(): boolean {
  const os = hostOperatingSystem();
  return os === 'win32' || os === 'linux';
}
function unlinkedStoragePath(path: string): boolean {
  const observation = observeStoragePathSync(path);
  return (
    observation.kind !== 'missing' &&
    observation.symbolicLinkComponents.length === 0 &&
    (hostOperatingSystem() === 'win32' || observation.canonicalPath === path)
  );
}
const git: RelocationGit = async (cwd, args) => {
  const command = ['--no-optional-locks', ...args];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: 'C',
  };
  // Inherited Git overrides, including config, can redirect the checkout probe.
  for (const key of Object.keys(env))
    if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  env.GIT_OPTIONAL_LOCKS = '0';
  try {
    return await execute('git', command, {
      cwd,
      env,
      // Cloned indexes can need minutes to re-hash; the operator watchdog owns stalls.
      timeout: args[0] === 'status' ? 0 : 30_000,
      signal: internalRootMigrationAbortSignal(),
      maxBuffer: 64 * 1024 * 1024,
    }).then(({ stdout }) => {
      internalRootMigrationProgress('Git probe completed');
      return stdout;
    });
  } catch (error) {
    const details = typeof error === 'object' && error !== null ? error : {};
    const message =
      'message' in details && typeof details.message === 'string'
        ? details.message
        : String(error);
    const stderr =
      'stderr' in details && typeof details.stderr === 'string'
        ? details.stderr
        : '';
    throw Object.assign(
      new Error(
        `Git command failed at ${JSON.stringify(cwd)}: git ${command.join(' ')}\n${message}${stderr ? `\nGit stderr:\n${stderr}` : ''}`,
      ),
      {
        code: 'code' in details ? details.code : undefined,
        stderr: 'stderr' in details ? details.stderr : undefined,
      },
    );
  }
};

/** Reuses the migration's read-only Git host, not a new execution surface. */
export async function reportInternalRootCleanup(
  identity: InternalRootIdentity,
  applied: boolean,
  host: InternalRootFilesystemHost,
  sourceBytes?: number,
  abandonArchives: readonly string[] = [],
  abandonCheckouts: readonly string[] = [],
): Promise<InternalRootCleanupReport> {
  // Only the exclusive holder can distinguish abandoned staging from a live writer.
  const release = await coordinateInternalRootMigration(identity, host);
  try {
    if (abandonCheckouts.length) {
      const frozen = (
        await readInternalRootAbandonmentPlan(
          identity,
          await readInternalRootJournal(identity, host),
          host,
        )
      )?.abandonedCheckouts;
      await assertAbandonedCheckouts(
        identity.source,
        abandonCheckouts.filter((path) => !frozen?.includes(path)),
        git,
      );
    }
    const report = await collectInternalRootCleanupCandidates(identity, {
      applied,
      git,
      sourceBytes,
      abandonArchives,
      abandonCheckouts,
    });
    await saveInternalRootCleanupReport(report, host);
    return report;
  } finally {
    await release();
  }
}
function refuse(reason: string, path?: string): never {
  throw new InternalRootMigrationRefused(
    'repair-refused',
    `${reason}${path === undefined ? '' : `: ${JSON.stringify(path)}`}. Preserve both roots and the journal; obtain offline relocation recovery.`,
  );
}
const readonlyStore: W5FileStore = {
  read: readNodeW5File,
  replace: () => Promise.reject(new Error('Read-only relocation inventory')),
  remove: () => Promise.reject(new Error('Read-only relocation inventory')),
};

async function relocationWorkspaceIds(source: string): Promise<string[]> {
  const file = join(source, 'workspaces/index.json');
  const index = createWorkspaceIndexRepository({
    store: readonlyStore,
    filePath: () => file,
    onCommitted: () => {},
    onRefused: () => {},
    storage: { namespace: 'workspace_index', writer: 'electron_main' },
    normalizeActivitySectionOrder: () => undefined,
  });
  const membership = await index.read();
  if (membership.authority !== 'ok' && membership.authority !== 'absent')
    refuse('Unreadable workspace membership', file);
  const ids = membership.entries.map((entry) => entry.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[A-Za-z0-9_-]+$/.test(id))
  )
    refuse('Ambiguous workspace membership', file);
  return ids;
}

function relocationWorkspaceManifest(
  source: string,
): ReturnType<typeof createWorkspaceManifestRepository> {
  return createWorkspaceManifestRepository({
    store: readonlyStore,
    filePath: (id) => join(source, 'workspaces', id, 'workspace.json'),
    storage: { namespace: 'workspace_manifest', writer: 'electron_main' },
    knownFields: new Set(),
    knownRepoFields: new Set(),
  });
}

function relocationRepositoryPaths(
  document: Readonly<Record<string, unknown>>,
  file: string,
): string[] {
  const paths: string[] = [];
  for (const key of ['repoPath', 'sourceRepoPath'] as const) {
    const path = document[key];
    if (typeof path === 'string') paths.push(path);
  }
  if (Array.isArray(document.repos))
    for (const entry of document.repos) {
      const repo: unknown = entry;
      if (
        typeof repo !== 'object' ||
        repo === null ||
        !('repoPath' in repo) ||
        typeof repo.repoPath !== 'string'
      )
        refuse('Unreadable repository owner evidence', file);
      paths.push(repo.repoPath);
    }
  return paths;
}

async function relocationAbandonedPaths(
  source: string,
  lifecycleJournals: readonly InternalRootLifecycleJournalEvidence[],
  abandonCheckouts: readonly string[],
): Promise<string[]> {
  return [
    ...(await abandonedArchivePaths(source, lifecycleJournals)),
    ...abandonCheckouts,
  ];
}

/** Best-effort read scope; canonical preparation and cold proof remain the backstop. */
async function coldGitScope(
  source: string,
  abandonArchives: readonly string[],
  abandonedCheckouts: readonly string[],
): Promise<readonly string[]> {
  const roots = new Set<string>();
  const gitDirectories = new Set<string>();
  const repositories = new Set<string>();
  let workspaceIds: readonly string[] = [];
  let incomplete = false;
  async function hint<T>(read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await read();
    } catch {
      incomplete = true;
      return undefined;
    }
  }
  const abandonedPaths = await hint(async () =>
    relocationAbandonedPaths(
      source,
      abandonArchives.length
        ? await freezeInternalRootJournals(source, abandonArchives)
        : [],
      abandonedCheckouts,
    ),
  );
  const ignored = (path: string): boolean =>
    abandonedPaths?.some((root) => isWithin(root, path)) ?? true;
  async function gitPath(file: string): Promise<string | undefined> {
    return hint(async () => {
      const before = await statIfPresent(file);
      if (!before) return undefined;
      if (!before.isFile()) {
        incomplete = true;
        return undefined;
      }
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino
        )
          throw new Error(`Git census link changed: ${JSON.stringify(file)}`);
        const bytes = Buffer.alloc(4097);
        const read = await handle.read(bytes, 0, bytes.length, 0);
        const contents = bytes.subarray(0, read.bytesRead);
        if (read.bytesRead > 4096 || !isUtf8(contents) || contents.includes(0))
          throw new Error(
            `Unreadable Git census link: ${JSON.stringify(file)}`,
          );
        const value = contents.toString('utf8').replace(/\r?\n$/, '');
        if (!value || /[\r\n]/.test(value)) {
          incomplete = true;
          return undefined;
        }
        return value;
      } finally {
        await hint(() => handle.close());
      }
    });
  }
  async function directory(root: string): Promise<void> {
    if (gitDirectories.has(root)) return;
    gitDirectories.add(root);
    await hint(async () => {
      const common = await gitPath(join(root, 'commondir'));
      if (common) {
        for (const name of ['gitdir', 'commondir']) {
          const file = join(root, name);
          if (!isWithin(source, file)) roots.add(file);
        }
        await directory(resolve(root, common));
        return;
      }
      const admin = join(root, 'worktrees');
      const state = await statIfPresent(admin);
      if (!state) return;
      if (!state.isDirectory()) {
        incomplete = true;
        return;
      }
      for (const name of await readdir(admin))
        await hint(async () => {
          const backlink = await gitPath(join(admin, name, 'gitdir'));
          if (!backlink) return;
          const target = resolve(admin, name, backlink);
          if (ignored(dirname(target))) return;
          if (!(await statIfPresent(target))?.isFile()) return;
          // Mirror journaled sibling backlinks so apply-peak prediction is not low.
          await checkout(target, join(admin, name));
        });
    });
  }
  async function checkout(file: string, expectedAdmin?: string): Promise<void> {
    await hint(async () => {
      if (ignored(file) || isWithin(join(source, 'w5'), file)) return;
      const state = await statIfPresent(file);
      if (state?.isDirectory()) {
        // A checkout's .git directory is common, not a linked admin directory.
        if (await statIfPresent(join(file, 'commondir'))) incomplete = true;
        else await directory(file);
      } else if (state?.isFile()) {
        const link = await gitPath(file);
        if (link?.startsWith('gitdir: ') && link.slice(8)) {
          const admin = resolve(dirname(file), link.slice(8));
          const common = await gitPath(join(admin, 'commondir'));
          const backlink = await gitPath(join(admin, 'gitdir'));
          if (
            (expectedAdmin !== undefined && admin !== expectedAdmin) ||
            !common ||
            !backlink ||
            resolve(admin, backlink) !== file ||
            !(await statIfPresent(admin))?.isDirectory() ||
            !(await statIfPresent(resolve(admin, common)))?.isDirectory()
          ) {
            incomplete = true;
            return;
          }
          if (!isWithin(source, file)) roots.add(file);
          await directory(admin);
        } else incomplete = true;
      } else if (state) incomplete = true;
    });
  }
  let completed = 0;
  async function visit(
    file: string,
    ancestors: ReadonlySet<string>,
  ): Promise<void> {
    await hint(async () => {
      // Omit interpretation only; the independent metadata census excludes nothing.
      if (
        ignored(file) ||
        isWithin(join(source, 'w5'), file) ||
        basename(file) === '.git'
      )
        return;
      const state = await lstat(file);
      internalRootMigrationProgress(
        `Linux Git census scope: ${++completed} entries completed`,
      );
      const local = relative(source, file);
      if (
        state.isDirectory() &&
        dirname(local) === 'workspaces' &&
        !workspaceIds.includes(basename(file))
      )
        return;
      if (/^workspaces\/[^/]+\/(?:workspace|worktrees)\.json$/.test(local)) {
        if (!state.isFile()) {
          incomplete = true;
          return;
        }
        if (state.size > 32 * 1024 * 1024)
          throw new Error('Oversize owner image');
        if (basename(file) === 'worktrees.json') {
          // List paths alone do not grant external checkout interpretation.
          const list = await createWorktreeListRepository({
            store: readonlyStore,
            filePath: () => file,
            storage: { namespace: 'worktree_list', writer: 'electron_main' },
            knownRowFields: new Set(),
            readRow: (row) => row,
          }).read(basename(dirname(file)));
          if (list.authority !== 'ok' || !list.complete) incomplete = true;
          return;
        }
        const document = await relocationWorkspaceManifest(source).read(
          basename(dirname(file)),
        );
        if (document.authority !== 'ok') {
          incomplete = true;
          return;
        }
        for (const path of relocationRepositoryPaths(document.document, file))
          if (
            path.startsWith('/') &&
            !path.includes('\0') &&
            resolve(path) === path
          )
            repositories.add(path);
          else incomplete = true;
      }
      if (!state.isDirectory()) return;
      const key = `${state.dev}:${state.ino}`;
      if (ancestors.has(key))
        throw new Error(`Cyclic Git census scope: ${JSON.stringify(file)}`);
      const nested = new Set([...ancestors, key]);
      const names = await readdir(file);
      // Canonical inventory stops at a checkout; nested repositories are opaque.
      if (!isWithin(join(source, 'w5'), file) && names.includes('.git')) {
        await checkout(join(file, '.git'));
        return;
      }
      for (const name of names) await visit(join(file, name), nested);
    });
  }
  const log = w5CommitLogLocation(source).dbPath;
  let ownersSettled = false;
  let temporary: string | undefined;
  let db: DatabaseSync | undefined;
  try {
    const state = await statIfPresent(log);
    if (state) {
      if (!state.isFile() || !unlinkedStoragePath(log))
        throw new Error('Unreadable W5 log');
      // SQLite readOnly may write source WAL/SHM. Query a disposable copy, never the source.
      temporary = await mkdtemp(join(tmpdir(), 'canopy-cold-scope-'));
      for (const suffix of ['', '-wal', '-journal']) {
        const file = `${log}${suffix}`;
        const before = await statIfPresent(file);
        if (!before) continue;
        if (!before.isFile() || !unlinkedStoragePath(file))
          throw new Error('Unreadable W5 sidecar');
        await copyFile(
          file,
          join(temporary, `commit-log.sqlite${suffix}`),
          constants.COPYFILE_EXCL,
        );
        const after = await lstat(file);
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error('W5 log changed during scope discovery');
      }
      db = new DatabaseSync(join(temporary, 'commit-log.sqlite'), {
        readOnly: true,
      });
      // Pending images may replace membership; only W5 settlement projects them.
      ownersSettled =
        db
          .prepare("SELECT 1 FROM w5_commits WHERE state != 'applied' LIMIT 1")
          .get() === undefined;
    } else ownersSettled = true;
  } catch {
    incomplete = true;
  } finally {
    await hint(() => Promise.resolve(db?.close()));
    if (temporary) {
      const directory = temporary;
      await hint(() => rm(directory, { recursive: true, force: true }));
    }
  }
  if (ownersSettled)
    workspaceIds = (await hint(() => relocationWorkspaceIds(source))) ?? [];
  else incomplete = true;
  await visit(source, new Set());
  for (const repository of repositories)
    await checkout(join(repository, '.git'));
  if (incomplete)
    process.stderr.write(
      'Migration: Linux Git census scope skipped evidence (unreadable, malformed or unsettled); inventory capacity is a lower bound until canonical preparation.\n',
    );
  return [...roots];
}

/** Inventory links and Git roots; W5 supplies the other exact owned path fields. */
async function inventoryTree(
  root: string,
  opaqueDirectories: ReadonlySet<string>,
  abandonedPaths: readonly string[] = [],
): Promise<{ paths: string[]; checkouts: string[] }> {
  const paths: string[] = [root];
  const checkouts: string[] = [];
  const visit = async (path: string): Promise<void> => {
    if (
      opaqueDirectories.has(path) ||
      abandonedPaths.some((root) => isWithin(root, path))
    )
      return;
    const state = await lstat(path);
    internalRootMigrationProgress('inventoried relocation path');
    if (state.isSymbolicLink()) {
      paths.push(path);
      return;
    }
    if (!state.isDirectory()) return;
    if (
      !isWithin(join(root, 'w5'), path) &&
      (await statIfPresent(join(path, '.git')))
    ) {
      paths.push(path);
      checkouts.push(path);
      return;
    }
    for (const name of await readdir(path)) await visit(join(path, name));
  };
  await visit(root);
  return { paths, checkouts };
}

async function freeze(
  context: InternalRootRepairContext,
  observation: LocalAuthorityObservation,
  diagnostics?: string[],
  abandonArchives: readonly string[] = [],
  abandonCheckouts: readonly string[] = [],
): Promise<InternalRootRepairPlan> {
  const { identity } = context;
  const transition = await observeLocalAuthorityRelocation(
    {
      brandId: identity.brandId,
      installationId: context.transactionId,
      sourceRoot: identity.source,
      destinationRoot: identity.destination,
    },
    observation,
  );
  const workspaceRoot = join(identity.source, 'workspaces');
  const ids = await relocationWorkspaceIds(identity.source);
  const workspaces: RelocationWorkspaceEvidence[] = [];
  const manifest = relocationWorkspaceManifest(identity.source);
  const list = createWorktreeListRepository({
    store: readonlyStore,
    filePath: (id) => join(workspaceRoot, id, 'worktrees.json'),
    storage: { namespace: 'worktree_list', writer: 'electron_main' },
    knownRowFields: new Set(),
    readRow: (row) => row,
  });
  // Unindexed sidecars carry no Git/owned-path discovery grant. Lifecycle and
  // indexed records still supply their explicit owner paths below.
  const opaqueDirectories = new Set<string>();
  if (await statIfPresent(workspaceRoot)) {
    for (const entry of await readdir(workspaceRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !ids.includes(entry.name))
        opaqueDirectories.add(join(workspaceRoot, entry.name));
    }
  }
  const archiveRecovery = await freezeInternalRootArchiveRecovery(
    identity.source,
  );
  const lifecycleJournals = await freezeInternalRootJournals(
    identity.source,
    abandonArchives,
  ).catch((error: unknown) => {
    if (!diagnostics) throw error;
    diagnostics.push(
      error instanceof Error
        ? error.message
        : 'Unreadable lifecycle owner evidence',
    );
    return [];
  });
  await assertAbandonedCheckouts(identity.source, abandonCheckouts, git);
  const abandonedPaths = await relocationAbandonedPaths(
    identity.source,
    lifecycleJournals,
    abandonCheckouts,
  );
  const ignored = (path: string): boolean =>
    abandonedPaths.some((root) => isWithin(root, path));
  const inventory = await inventoryTree(
    identity.source,
    opaqueDirectories,
    abandonedPaths,
  );
  inventory.paths.push(
    ...internalRootJournalOwnedPaths(identity.source, lifecycleJournals),
  );
  for (const repository of internalRootArchiveRecoveryRepositories(
    archiveRecovery,
  )) {
    if ([repository.commonDir, repository.referenceRepoPath].some(ignored))
      refuse('Archive recovery repository overlaps an abandoned path');
    if (await statIfPresent(repository.referenceRepoPath)) {
      const savedCommon = (
        await git(repository.referenceRepoPath, [
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ])
      ).trim();
      if (savedCommon !== repository.commonDir)
        refuse(
          'Archive recovery reference repository common directory mismatch',
          repository.referenceRepoPath,
        );
    }
    inventory.paths.push(repository.commonDir);
    // The saved linked checkout is historical; Git common-directory ownership survives it.
    const listing = await git(repository.commonDir, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ]);
    let liveCheckout: string | undefined;
    for (const field of listing.split('\0')) {
      if (!field.startsWith('worktree ')) continue;
      const path = field.slice(9);
      if (ignored(path) || !(await statIfPresent(path))) continue;
      liveCheckout = path;
      break;
    }
    if (!liveCheckout)
      refuse(
        'No live checkout for retained Git common directory',
        repository.commonDir,
      );
    inventory.paths.push(liveCheckout);
    inventory.checkouts.push(liveCheckout);
  }
  for (const workspaceId of ids) {
    try {
      if (ignored(join(workspaceRoot, workspaceId)))
        refuse(
          'Abandoned checkout omission overlaps workspace metadata',
          join(workspaceRoot, workspaceId),
        );
      const document = await manifest.read(workspaceId);
      const trees = await list.read(workspaceId);
      if (
        document.authority !== 'ok' ||
        trees.authority === 'unreadable' ||
        (trees.authority === 'ok' && !trees.complete)
      )
        refuse(
          'Unreadable workspace owner evidence',
          join(workspaceRoot, workspaceId),
        );
      const ownerDirectories: string[] = [];
      for (const key of ['folderPath', 'externalPath'] as const) {
        const path = document.document[key];
        if (typeof path === 'string' && isWithin(identity.source, path)) {
          const state = await statIfPresent(path);
          if (!state?.isDirectory() || !unlinkedStoragePath(path))
            refuse('Unproven managed folder', path);
          if (ignored(path))
            refuse('Abandoned checkout omission overlaps managed folder', path);
          ownerDirectories.push(path);
          inventory.paths.push(path);
        }
      }
      const repoPaths = relocationRepositoryPaths(
        document.document,
        join(workspaceRoot, workspaceId, 'workspace.json'),
      );
      if (trees.authority === 'ok') {
        const abandonedIds = lifecycleJournals.flatMap((entry) =>
          entry.abandoned?.workspaceId === workspaceId
            ? [entry.abandoned.worktreeId]
            : [],
        );
        for (const row of trees.worktrees.filter(
          (row) => !abandonedIds.includes(row.id),
        ))
          for (const path of relocationWorktreeOwnedPaths(
            JSON.stringify({ version: 1, worktrees: [row] }),
          ))
            if (ignored(path))
              refuse(`Abandoned omission overlaps live checkout ${path}`);
      }
      for (const path of repoPaths) {
        if (ignored(path))
          refuse(`Abandoned omission overlaps repository ${path}`);
        // External owner references are read only, never a recursive walk grant.
        if (
          (await statIfPresent(path)) &&
          (await statIfPresent(join(path, '.git')))
        )
          inventory.checkouts.push(path);
      }
      const worktreePaths = relocationWorktreeOwnedPaths(
        trees.authority === 'ok' ? trees.raw : null,
      );
      for (const path of worktreePaths) {
        if (resolve(path) !== path) refuse('Noncanonical owner path', path);
        inventory.paths.push(path);
        const stat = await statIfPresent(path);
        if (stat?.isDirectory() && (await isPrunedInternalRootCheckout(path)))
          inventory.checkouts.push(path);
        if (stat?.isSymbolicLink())
          inventory.paths.push(resolve(dirname(path), await readlink(path)));
      }
      workspaces.push({
        workspaceId,
        targetId: 'local',
        manifestRaw: document.raw,
        listRaw: trees.authority === 'ok' ? trees.raw : null,
        repositoryPaths: ownerDirectories,
        ownedPaths: worktreePaths,
      });
    } catch (error) {
      if (!diagnostics) throw error;
      diagnostics.push(
        `Workspace ${workspaceId}: ${error instanceof Error ? error.message : 'unreadable owner evidence'}`,
      );
    }
  }
  // Complete each common repository's membership, including external linked checkouts.
  const checkouts = new Set(
    inventory.checkouts.filter((path) => !ignored(path)),
  );
  const reportedMissingPrunable = new Set<string>();
  for (const path of checkouts) {
    if (await isPrunedInternalRootCheckout(path)) {
      process.stderr.write(
        `Migration: pruned Git admin directory for checkout ${JSON.stringify(path)}. Files are retained at ${JSON.stringify(movedOwnedPath(transition, path))}, but Git requires recovery; see docs/internal-root-migration-troubleshooting.md#pruned-git-worktree-records.\n`,
      );
      checkouts.delete(path);
      continue;
    }
    let listed: string;
    try {
      listed = await git(path, ['worktree', 'list', '--porcelain', '-z']);
    } catch (error) {
      const failure = isWithin(identity.source, path)
        ? new Error(
            `${error instanceof Error ? error.message : String(error)}\nIf this folder is an unneeded broken checkout, opt in with --abandon-checkout ${JSON.stringify(path)}; the folder stays in the old root.`,
          )
        : error;
      if (!diagnostics) throw failure;
      diagnostics.push(
        `Git ${path}: ${failure instanceof Error ? failure.message : 'unreadable checkout'}`,
      );
      checkouts.delete(path);
      continue;
    }
    for (const record of listed.split('\0\0')) {
      const fields = record.split('\0');
      if (
        fields.includes('bare') ||
        (await isMissingPrunableGitWorktree(fields, reportedMissingPrunable))
      )
        continue;
      const member = fields
        .find((field) => field.startsWith('worktree '))
        ?.slice(9);
      if (member && !ignored(member)) checkouts.add(member);
    }
  }
  let gitPlan: RelocationGitPlan = { checkouts: [], backlinks: [] };
  if (diagnostics) {
    const groups = new Map<string, string[]>();
    for (const path of checkouts) {
      try {
        const common = (
          await git(path, [
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
          ])
        ).trim();
        const members = groups.get(common) ?? [];
        members.push(path);
        groups.set(common, members);
      } catch (error) {
        diagnostics.push(
          `Git ${path}: ${error instanceof Error ? error.message : 'unreadable checkout'}`,
        );
      }
    }
    for (const [common, paths] of groups) {
      try {
        const group = await prepareRelocationGit(git, paths, {
          portableFilesystem: portableGitFilesystem(),
          reportedMissingPrunable,
          ignoredWorktrees: abandonedPaths,
        });
        gitPlan = {
          checkouts: [...gitPlan.checkouts, ...group.checkouts],
          backlinks: [...gitPlan.backlinks, ...group.backlinks],
        };
      } catch (error) {
        diagnostics.push(
          `Git ${common}: ${error instanceof Error ? error.message : 'preparation refused'}`,
        );
      }
    }
  } else
    gitPlan = await prepareRelocationGit(git, [...checkouts], {
      portableFilesystem: portableGitFilesystem(),
      reportedMissingPrunable,
      ignoredWorktrees: abandonedPaths,
    });
  assertArchiveRecoveryRepositoryBindings(archiveRecovery, gitPlan);
  for (const common of new Set(
    abandonedPaths.length
      ? gitPlan.checkouts.map((row) => row.commonDirectory)
      : [],
  )) {
    const admin = join(common, 'worktrees');
    if (!(await statIfPresent(admin))) continue;
    if ((await realpath(admin)) !== admin)
      refuse(`Aliased Git worktree records: ${admin}`);
    for (const name of await readdir(admin)) {
      const path = join(admin, name);
      const file = join(path, 'gitdir');
      const state = await statIfPresent(file);
      if (
        !state?.isFile() ||
        state.nlink !== 1 ||
        (await realpath(file)) !== file
      )
        continue;
      const backlink = await readFile(file, 'utf8');
      if (ignored(dirname(resolve(path, backlink.trim()))))
        abandonedPaths.push(path);
    }
  }
  const repositoryPaths = gitPlan.checkouts.map((row) => row.path);
  return {
    transition,
    lifecycleJournals,
    ...(archiveRecovery === undefined ? {} : { archiveRecovery }),
    ...(abandonCheckouts.length
      ? { abandonedCheckouts: abandonCheckouts }
      : {}),
    ...(abandonedPaths.length ? { abandonedPaths } : {}),
    gitPlan,
    ownedPaths: [...new Set(inventory.paths)],
    workspaces: workspaces.map((evidence) => ({
      ...evidence,
      repositoryPaths: [...repositoryPaths, ...evidence.repositoryPaths],
    })),
  };
}

/** Legacy inventory included external payload targets, which confer no owner authority. */
function ownedPathsForProof(plan: InternalRootRepairPlan): readonly string[] {
  return [
    ...plan.ownedPaths.filter((path) =>
      isWithin(plan.transition.from.canonicalDataRoot, path),
    ),
    ...plan.workspaces.flatMap((row) => [
      ...(row.ownedPaths ?? relocationWorktreeOwnedPaths(row.listRaw)),
      ...row.repositoryPaths,
    ]),
    ...internalRootJournalOwnedPaths(
      plan.transition.from.canonicalDataRoot,
      plan.lifecycleJournals ?? [],
    ),
    ...internalRootArchiveRecoveryRepositories(plan.archiveRecovery).flatMap(
      (repo) => [repo.commonDir, repo.referenceRepoPath],
    ),
    ...plan.gitPlan.checkouts.flatMap((row) => [row.path, row.commonDirectory]),
    ...plan.gitPlan.backlinks.map((row) => row.path),
  ].filter(
    (path) => !(plan.abandonedPaths ?? []).some((root) => isWithin(root, path)),
  );
}

function assertArchiveRecoveryRepositoryBindings(
  archiveRecovery: string | undefined,
  gitPlan: RelocationGitPlan,
): void {
  for (const repository of internalRootArchiveRecoveryRepositories(
    archiveRecovery,
  )) {
    if (
      !gitPlan.checkouts.some(
        (checkout) => checkout.commonDirectory === repository.commonDir,
      )
    )
      refuse(
        'Archive recovery reference repository common directory mismatch',
        repository.referenceRepoPath,
      );
  }
}

function checkedPlan(
  context: InternalRootRepairContext,
  plan: InternalRootRepairPlan,
): void {
  assertArchiveRecoveryRepositoryBindings(plan.archiveRecovery, plan.gitPlan);
  const { transition } = plan;
  if (
    transition.installationId !== context.transactionId ||
    transition.brandId !== context.identity.brandId ||
    transition.from.canonicalDataRoot !== context.identity.source ||
    transition.to.canonicalDataRoot !== context.identity.destination
  )
    refuse('Frozen authority mapping does not match this transaction');
  const external = plan.gitPlan.backlinks
    .filter((image) => !isWithin(context.identity.source, image.path))
    .map((image) => image.path);
  if (!isDeepStrictEqual(external, context.externalFiles))
    refuse('External repair membership changed');
}

/** Live B/C composition. It has no dependency on ordinary routing or destination startup. */
export function createInternalRootRelocationRepairs(options: {
  readonly abandonArchives?: readonly string[];
  readonly abandonCheckouts?: readonly string[];
  readonly durability: W5DurabilityPort;
  /** Host-selected TokenUser observer; Windows refuses when it is absent. */
  readonly windowsPrincipal?: () => Promise<string>;
  readonly ownedChildPath?: string;
  readonly filesystemHost?: InternalRootFilesystemHost;
}): ReturnType<typeof createInternalRootRepairs> {
  const observation = hostLocalAuthorityObservation(options.windowsPrincipal);
  const host =
    options.filesystemHost ??
    internalRootFilesystemHost(options.ownedChildPath);
  const worker: InternalRootRepairWorker = {
    onProgress: internalRootMigrationProgress,
    ownedPathsForProof,
    ...(host.windows
      ? {
          replaceBacklink: async (image: {
            readonly path: string;
            readonly contents: string;
          }): Promise<void> => {
            const windows = host.windows;
            if (!windows) refuse('Windows filesystem custody unavailable');
            const before = windows.inspect(image.path);
            const temp = join(
              dirname(image.path),
              `.${basename(image.path)}.relocation-${randomUUID()}.tmp`,
            );
            windows.copy(image.path, temp);
            const identity = lstatSync(temp, { bigint: true });
            const cleanupOnExit = (): void => {
              const current = lstatSync(temp, {
                bigint: true,
                throwIfNoEntry: false,
              });
              // A published backlink no longer owns a reused temporary path.
              if (current?.dev === identity.dev && current.ino === identity.ino)
                rmSync(temp, { force: true });
            };
            process.once('exit', cleanupOnExit);
            try {
              // Only the private copy becomes writable; the preimage stays untouched.
              await chmod(temp, 0o600);
              const handle = await open(temp, 'r+');
              try {
                const opened = await handle.stat({ bigint: true });
                if (opened.dev !== identity.dev || opened.ino !== identity.ino)
                  refuse('Git backlink temporary changed', temp);
                await handle.writeFile(image.contents);
                await handle.truncate(Buffer.byteLength(image.contents));
                await handle.sync();
              } finally {
                await handle.close();
              }
              windows.finish(image.path, temp);
              const current = windows.inspect(image.path);
              if (!isDeepStrictEqual(current, before))
                refuse(
                  'Git backlink changed during private replacement',
                  image.path,
                );
              windows.replace(temp, image.path);
              const after = windows.inspect(image.path);
              if (
                after.attributes !== before.attributes ||
                after.security !== before.security ||
                windows.read(image.path).toString('utf8') !== image.contents
              )
                refuse(
                  'Git backlink attributes or contents changed during replacement',
                  image.path,
                );
            } finally {
              try {
                cleanupOnExit();
              } finally {
                process.removeListener('exit', cleanupOnExit);
              }
            }
          },
        }
      : {}),
    freeze: async (context) => {
      await normalizeInternalRootArchiveRecovery(context.identity.source);
      return freeze(
        context,
        observation,
        undefined,
        options.abandonArchives,
        options.abandonCheckouts,
      );
    },
    admit: async (context, plan) => {
      checkedPlan(context, plan);
      for (const repository of internalRootArchiveRecoveryRepositories(
        plan.archiveRecovery,
      )) {
        // The Git plan qualifies tracked checkouts; a missing historical path can be reused after freeze.
        if (
          plan.gitPlan.checkouts.some(
            (checkout) => checkout.path === repository.referenceRepoPath,
          ) ||
          !(await statIfPresent(repository.referenceRepoPath))
        )
          continue;
        const common = (
          await git(repository.referenceRepoPath, [
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
          ]).catch(() =>
            refuse(
              'Archive recovery reference repository common directory mismatch',
              repository.referenceRepoPath,
            ),
          )
        ).trim();
        if (common !== repository.commonDir)
          refuse(
            'Archive recovery reference repository common directory mismatch',
            repository.referenceRepoPath,
          );
      }
      const observed = await observeLocalAuthorityRelocation(
        {
          brandId: context.identity.brandId,
          installationId: context.transactionId,
          sourceRoot: context.identity.source,
          destinationRoot: context.identity.destination,
        },
        observation,
      );
      if (!isDeepStrictEqual(observed, plan.transition))
        refuse('Authority observation changed');
      await validateExternalRootFiles(
        context.identity,
        context.externalFiles,
        host,
      );
      // Shared repositories outlive either root; startup may prune the original archive refs.
      for (const common of new Set(
        plan.gitPlan.checkouts.map((row) => row.commonDirectory),
      )) {
        if (isWithin(context.identity.source, common)) continue;
        for (const entry of plan.lifecycleJournals ?? []) {
          if (!entry.abandoned) continue;
          const { workspaceId, worktreeId } = entry.abandoned;
          const prefix = `refs/app/archived-containers/${workspaceId}/${worktreeId}/`;
          const refs = await git(common, [
            'for-each-ref',
            '--format=%(refname) %(objectname)',
            prefix,
          ]);
          for (const line of refs.trim().split('\n').filter(Boolean)) {
            const [ref, oid] = line.split(' ');
            if (
              !ref?.startsWith(prefix) ||
              !oid ||
              !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)
            )
              refuse('Unreadable abandoned archive ref', common);
            const retained = `refs/canopy-migration-abandoned/${ref.slice('refs/app/'.length)}/${oid}`;
            const existing = (
              await git(common, [
                'for-each-ref',
                '--format=%(objectname)',
                retained,
              ])
            ).trim();
            if (existing && existing !== oid)
              refuse(`Conflicting abandoned archive ref: ${retained}`, common);
            if (!existing) await git(common, ['update-ref', retained, oid, '']);
          }
        }
      }
    },
    recordAuthority: async (context, plan) => {
      const path = join(context.workingRoot, 'internal-root-authority.json');
      if (await statIfPresent(path)) {
        if (
          !isDeepStrictEqual(
            JSON.parse(await readFile(path, 'utf8')),
            plan.transition,
          )
        )
          refuse('Conflicting recorded authority', path);
      } else await durableJson(path, plan.transition, host);
    },
    repairMetadata: async (context, plan, images) => {
      await relocateInternalRootPipelineRecords(
        context.identity,
        context.workingRoot,
        host,
      );
      const evidence = pipelineRecordRepairEvidence(context);
      await durableJson(evidence.path, evidence.value, host);
      await relocateInternalRootJournals(
        plan.transition,
        context.workingRoot,
        host,
        plan.lifecycleJournals ?? [],
      );
      await relocateInternalRootArchiveRecovery(
        plan.transition,
        context.workingRoot,
        host,
        plan.archiveRecovery,
        false,
        plan.lifecycleJournals,
      );
      if (!images.length) return;
      const root = context.workingRoot;
      await mkdir(join(root, 'w5'), { recursive: true, mode: 0o700 });
      const log = W5CommitLog.open(join(root, 'w5', 'commit-log.sqlite'));
      try {
        assertRelocationW5Settled(log);
        const files = [];
        for (const image of images) {
          const original = plan.workspaces.find(
            (row) => row.workspaceId === image.workspaceId,
          );
          if (!original)
            refuse(
              'Missing frozen workspace evidence',
              join(root, 'workspaces', image.workspaceId),
            );
          for (const [name, contents, previous] of [
            ['workspace.json', image.manifestRaw, original.manifestRaw],
            ['worktrees.json', image.listRaw, original.listRaw],
          ] as const) {
            if (contents === previous) continue;
            const finalPath = join(
              context.identity.destination,
              'workspaces',
              image.workspaceId,
              name,
            );
            const path = join(root, 'workspaces', image.workspaceId, name);
            const current = await readNodeW5File(path);
            if ((current.state === 'present' ? current.raw : null) !== previous)
              refuse('Staging owner image differs from frozen evidence', path);
            files.push({
              path: finalPath,
              contents,
              previousFingerprint:
                previous === null ? null : fingerprintW5File(previous),
            });
          }
        }
        if (!files.length) return;
        const decision = log.commit({
          operation: 'core.internalRoot.relocate',
          files,
          advance: images.flatMap((image) => image.advance),
          outcome: { kind: 'relocated', transactionId: context.transactionId },
        });
        if (decision.status !== 'committed')
          refuse('Unexpected relocation replay');
        const pending = log
          .listPendingCommits()
          .find((entry) => entry.commitId === decision.commitId);
        if (!pending) refuse('Missing relocation decision');
        // Historical/new log paths are final identities; only the execution projection
        // points at private staging. No daemon/ordinary writer runs here.
        const result = await applyW5Commit(
          log,
          {
            ...pending,
            files: pending.files.map((file) => ({
              ...file,
              path: join(
                root,
                relative(context.identity.destination, file.path),
              ),
            })),
          },
          {
            root: join(root, 'workspaces'),
            durability: options.durability,
          },
        );
        if (result.status !== 'applied')
          refuse('Relocation W5 decision requires recovery');
      } finally {
        log.close();
      }
    },
    verify: async (context, plan, images, published) => {
      checkedPlan(context, plan);
      const evidence = pipelineRecordRepairEvidence(context);
      // Older builds can already have sealed this tree; preserve their resume path.
      if (await statIfPresent(evidence.path)) {
        await assertPrivateMigrationFile(evidence.path, host);
        if (
          !isDeepStrictEqual(
            JSON.parse(await readFile(evidence.path, 'utf8')),
            evidence.value,
          )
        )
          refuse('Pipeline record repair evidence differs', evidence.path);
        await relocateInternalRootPipelineRecords(
          context.identity,
          context.workingRoot,
          host,
          { verifyOnly: true },
        );
      }
      const root = context.workingRoot;
      await privateDirectory(root, host);
      if (published) {
        const observed = await deriveLocalAuthorityIdentity(
          {
            brandId: context.identity.brandId,
            dataRoot: root,
          },
          observation,
        );
        if (!isDeepStrictEqual(observed, plan.transition.to))
          refuse('Published authority differs from frozen mapping', root);
      } else await worker.admit(context, plan);
      if (
        !isDeepStrictEqual(
          JSON.parse(
            await readFile(join(root, 'internal-root-authority.json'), 'utf8'),
          ),
          plan.transition,
        )
      )
        refuse(
          'Recorded authority differs',
          join(root, 'internal-root-authority.json'),
        );
      await assertRelocationOwnedPathsSafe(
        plan.transition,
        [
          ...ownedPathsForProof(plan),
          ...plan.gitPlan.checkouts.flatMap((row) => [
            row.path,
            row.commonDirectory,
          ]),
        ],
        root,
        published,
        {
          preserveSourceTargetsWithin: plan.gitPlan.checkouts.map((row) =>
            movedOwnedPath(plan.transition, row.path),
          ),
        },
        internalRootMigrationProgress,
      );
      for (const image of await projectRelocationBacklinks(
        plan.transition,
        plan.gitPlan,
      )) {
        const path = isWithin(context.identity.destination, image.path)
          ? join(root, relative(context.identity.destination, image.path))
          : image.path;
        if (
          !unlinkedStoragePath(path) ||
          (await readFile(path, 'utf8')) !== image.contents
        )
          refuse('Git backlink verification failed', path);
      }
      for (const image of images) {
        for (const [name, expected] of [
          ['workspace.json', image.manifestRaw],
          ['worktrees.json', image.listRaw],
        ] as const) {
          const current = await readNodeW5File(
            join(root, 'workspaces', image.workspaceId, name),
          );
          if ((current.state === 'present' ? current.raw : null) !== expected)
            refuse(
              'Owner projection verification failed',
              join(root, 'workspaces', image.workspaceId, name),
            );
        }
      }
      await relocateInternalRootJournals(
        plan.transition,
        root,
        host,
        plan.lifecycleJournals ?? [],
        true,
        published,
      );
      await relocateInternalRootArchiveRecovery(
        plan.transition,
        root,
        host,
        plan.archiveRecovery,
        true,
        plan.lifecycleJournals,
      );
      if (published)
        await qualifyRelocationGit(git, plan.transition, plan.gitPlan, {
          portableFilesystem: portableGitFilesystem(),
          ignoredWorktrees: (plan.abandonedPaths ?? []).flatMap((path) => [
            path,
            movedOwnedPath(plan.transition, path),
          ]),
        });
    },
  };
  return {
    ...createInternalRootRepairs(worker),
    // Git admin omissions are discovered later by freeze(); project operator selections only.
    preflightOmissions: async (identity) => [
      ...(await selectedAbandonedArchivePaths(
        identity.source,
        options.abandonArchives ?? [],
      )),
      ...(options.abandonCheckouts ?? []),
    ],
    coldExternalFiles: (context) =>
      runInternalRootMigrationPhase(
        'Linux Git census scope',
        () =>
          coldGitScope(
            context.identity.source,
            options.abandonArchives ?? [],
            options.abandonCheckouts ?? [],
          ),
        { announce: false },
      ),
    inspect: async (
      context: InternalRootRepairContext,
    ): Promise<readonly string[]> => {
      const diagnostics: string[] = [];
      try {
        const plan = await freeze(
          context,
          observation,
          diagnostics,
          options.abandonArchives,
          options.abandonCheckouts,
        );
        await assertRelocationOwnedPathsSafe(
          plan.transition,
          [
            ...ownedPathsForProof(plan),
            ...plan.gitPlan.checkouts.flatMap((row) => [
              row.path,
              row.commonDirectory,
            ]),
          ],
          context.identity.source,
          false,
          { source: true },
          internalRootMigrationProgress,
        );
        await projectInternalRootMetadata(plan);
      } catch (error) {
        diagnostics.push(
          error instanceof Error
            ? error.message
            : 'Git/owner inspection failed',
        );
      }
      return diagnostics;
    },
  };
}

import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN } from '@canopy/protocol/portal/lifecycle-journal';
import type { W5CommitLogFileStore } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import { W5CommitRefusedError } from '@canopy/core-runtime/node/w5/commit-log/errors';
import { currentW5CommitScope } from '@canopy/core-runtime/node/w5/commit-scope';
import { isJsonObject } from '@canopy/core-runtime/node/w5/file-store';
import {
  readWorkspaceIndex,
  readWorkspaceManifest,
  readWorktreeList,
} from '@canopy/core-runtime/node/workspace/read-formats';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { validateId } from '@canopy/execution-engine/node/lib/validation';
import { isPathInside } from '@canopy/execution-engine/node/lib/path-safety';
import { journalSchema } from '../w5-destructive-journal';

export function deleteRefusal(message: string): W5CommitRefusedError {
  return new W5CommitRefusedError('recovery-required', message);
}

export function deletionRecordPaths(workspaceId: string): {
  index: string;
  manifest: string;
  list: string;
} {
  validateId(workspaceId, 'workspaceId');
  const root = join(getCanopyDataDir(), 'workspaces');
  return {
    index: join(root, 'index.json'),
    manifest: join(root, workspaceId, 'workspace.json'),
    list: join(root, workspaceId, 'worktrees.json'),
  };
}

export interface WorktreeDeletePlan {
  workspaceId: string;
  worktreeId: string;
  createdAt: string;
  description: string;
  checkouts: Array<{ repositoryPath: string; checkoutPath: string }>;
  root: string;
  multiRepo: boolean;
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function validateLifecycle(row: Record<string, unknown>): void {
  if (row.setupPhase !== undefined && row.setupPhase !== 'git-ready')
    throw deleteRefusal('Worktree creation is incomplete or unreadable.');
  for (const field of [
    'splitRecoveryRequired',
    'pendingArchiveBranchDeletion',
    'pendingArchiveBranchDeletions',
  ])
    if (row[field] !== undefined)
      throw deleteRefusal('This worktree has unresolved lifecycle evidence.');
  const creation = row.creation;
  if (creation === undefined) return;
  if (
    !isJsonObject(creation) ||
    typeof creation.operationId !== 'string' ||
    !creation.operationId ||
    creation.state !== 'complete' ||
    creation.phase !== 'git-ready' ||
    !Array.isArray(creation.checkouts) ||
    creation.checkouts.some(
      (entry: unknown) =>
        !isJsonObject(entry) ||
        typeof entry.repositoryPath !== 'string' ||
        typeof entry.checkoutPath !== 'string',
    )
  )
    throw deleteRefusal('Worktree creation needs recovery.');
}

/** Uses entry images when a decision has fenced these files, not a second observation. */
async function readRecord(
  store: W5CommitLogFileStore,
  path: string,
): Promise<{ state: 'present'; raw: string }> {
  const observed = currentW5CommitScope()?.observed.get(path);
  const read = observed
    ? observed.previousRaw === null
      ? { state: 'absent' as const }
      : { state: 'present' as const, raw: observed.previousRaw }
    : await store.read(path);
  if (read.state !== 'present')
    throw deleteRefusal('Project records are missing or unreadable.');
  return read;
}

/** No convenience projections: unknown list/row fields survive final removal. */
export async function readWorktreeDeletePlan(
  store: W5CommitLogFileStore,
  workspaceId: string,
  worktreeId: string,
): Promise<WorktreeDeletePlan> {
  validateId(workspaceId, 'workspaceId');
  validateId(worktreeId, 'worktreeId');
  const paths = deletionRecordPaths(workspaceId);
  const index = readWorkspaceIndex(
    await readRecord(store, paths.index),
    () => undefined,
  );
  if (
    index.authority !== 'ok' ||
    new Set(index.entries.map((row) => row.id)).size !== index.entries.length
  )
    throw deleteRefusal('The project list is incomplete or ambiguous.');
  for (const entry of index.entries) validateId(entry.id, 'workspaceId');
  const workspace = index.entries.find((row) => row.id === workspaceId);
  if (!workspace || workspace.type === 'cowork')
    throw deleteRefusal('The project was not found or has no worktrees.');
  const manifest = readWorkspaceManifest(
    await readRecord(store, paths.manifest),
  );
  const listRead = await readRecord(store, paths.list);
  const list = readWorktreeList(listRead);
  if (
    manifest.authority !== 'ok' ||
    manifest.document.type !== workspace.type ||
    list.authority !== 'ok' ||
    !list.complete ||
    new Set(list.worktrees.map((row) => row.id)).size !== list.worktrees.length
  )
    throw deleteRefusal(
      'Project settings or worktree records are incomplete or ambiguous.',
    );
  for (const row of list.worktrees) {
    validateId(row.id, 'worktreeId');
    if (!timestamp(row.createdAt) || !row.branchName)
      throw deleteRefusal('A worktree incarnation is unreadable.');
    validateLifecycle(row);
  }
  const target = list.worktrees.find((row) => row.id === worktreeId);
  if (!target) throw deleteRefusal('The worktree was not found.');
  const config = manifest.document;
  const workspaceRecord = index.rawEntriesById.get(workspaceId);
  for (const field of ['creation', 'recovery', 'splitRecoveryRequired'])
    if (config[field] !== undefined || workspaceRecord?.[field] !== undefined)
      throw deleteRefusal('The project has unresolved lifecycle evidence.');
  const root = join(
    getCanopyDataDir(),
    'workspaces',
    workspaceId,
    'worktrees',
    worktreeId,
  );
  let checkouts: WorktreeDeletePlan['checkouts'] = [];
  const add = (repositoryPath: unknown, checkoutPath: string): void => {
    if (
      typeof repositoryPath !== 'string' ||
      !isAbsolute(repositoryPath) ||
      repositoryPath.includes('\0') ||
      isPathInside(root, repositoryPath) ||
      checkouts.some(
        (entry) => resolve(entry.repositoryPath) === resolve(repositoryPath),
      )
    )
      throw deleteRefusal('The repository targets are unsafe or ambiguous.');
    checkouts.push({ repositoryPath, checkoutPath });
  };
  if (workspace.type === 'single-repo') add(config.repoPath, root);
  else {
    if (!Array.isArray(config.repos))
      throw deleteRefusal('The repository list is unreadable.');
    const ids = new Set<string>();
    for (const repo of config.repos) {
      if (
        !isJsonObject(repo) ||
        typeof repo.id !== 'string' ||
        ids.has(repo.id)
      )
        throw deleteRefusal('The repository list is ambiguous.');
      validateId(repo.id, 'repoId');
      ids.add(repo.id);
      add(repo.repoPath, join(root, 'repos', repo.id));
    }
    if (config.sourceRepoPath !== undefined) add(config.sourceRepoPath, root);
    const includedRepoIds = target.includedRepoIds;
    if (
      includedRepoIds !== undefined &&
      (!Array.isArray(includedRepoIds) ||
        new Set(includedRepoIds).size !== includedRepoIds.length ||
        includedRepoIds.some(
          (id: unknown) => typeof id !== 'string' || !ids.has(id),
        ))
    )
      throw deleteRefusal('The worktree repository scope is unreadable.');
    if (Array.isArray(includedRepoIds)) {
      const includedPaths = new Set(
        includedRepoIds.map((id: string) => join(root, 'repos', id)),
      );
      checkouts = checkouts.filter(
        (entry) =>
          entry.checkoutPath === root || includedPaths.has(entry.checkoutPath),
      );
    }
  }
  if (isJsonObject(target.creation)) {
    const key = (entry: WorktreeDeletePlan['checkouts'][number]): string =>
      JSON.stringify([entry.repositoryPath, entry.checkoutPath]);
    const expected = new Set(checkouts.map(key));
    const recorded = target.creation.checkouts;
    const selected = new Set<string>();
    if (!Array.isArray(recorded))
      throw deleteRefusal(
        'The recorded checkout targets disagree with project settings.',
      );
    for (const entry of recorded) {
      if (
        !isJsonObject(entry) ||
        typeof entry.repositoryPath !== 'string' ||
        typeof entry.checkoutPath !== 'string'
      )
        throw deleteRefusal('Worktree creation needs recovery.');
      const entryKey = key({
        repositoryPath: entry.repositoryPath,
        checkoutPath: entry.checkoutPath,
      });
      if (!expected.has(entryKey) || selected.has(entryKey))
        throw deleteRefusal(
          'The recorded checkout targets disagree with project settings.',
        );
      selected.add(entryKey);
    }
    // Only source-backed creation can filter repos through mutable canopy.json.
    // Pin that subset to creation; other scopes must remain exact.
    if (
      checkouts.some(
        (entry) =>
          (workspace.type === 'single-repo' ||
            config.sourceRepoPath === undefined ||
            target.includedRepoIds !== undefined ||
            entry.checkoutPath === root) &&
          !selected.has(key(entry)),
      )
    )
      throw deleteRefusal(
        'The recorded checkout targets disagree with project settings.',
      );
    checkouts = checkouts.filter((entry) => selected.has(key(entry)));
  }
  return {
    workspaceId,
    worktreeId,
    createdAt: target.createdAt,
    root,
    checkouts,
    multiRepo: workspace.type === 'multi-repo',
    description: JSON.stringify([
      workspace.type,
      config.createdAt,
      target.createdAt,
      target.branchName,
      checkouts,
    ]),
  };
}

export async function assertNoConflictingW5Reservation(
  store: W5CommitLogFileStore,
  workspaceId: string,
  ownId?: string,
  onlyOperation?: string,
): Promise<void> {
  for (const reservation of await store.readReservations()) {
    if (reservation.reservationId === ownId) continue;
    if (onlyOperation !== undefined && reservation.operation !== onlyOperation)
      continue;
    const diagnostics = reservation.diagnostics;
    if (
      !isJsonObject(diagnostics) ||
      typeof diagnostics.workspaceId !== 'string' ||
      diagnostics.workspaceId === workspaceId
    )
      throw deleteRefusal(
        'Another operation in this project needs completion or manual recovery. Keep its files and idempotency key.',
      );
  }
}

function absent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}

/** Refuse aliases in managed effect targets, including their existing parents. */
export async function assertDeleteTargetUnaliased(path: string): Promise<void> {
  let current = path;
  for (;;) {
    const stat = await lstat(current).catch((error: unknown) => {
      if (!absent(error)) throw error;
      return undefined;
    });
    if (
      stat &&
      (stat.isSymbolicLink() ||
        resolve(await realpath(current)) !== resolve(current))
    )
      throw deleteRefusal('A deletion target is linked or ambiguous.');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Read only. Even an unreadable foreign journal refuses before workspace filtering. */
export async function assertDeleteLifecycleClear(
  plan: WorktreeDeletePlan,
): Promise<void> {
  const directory = join(getCanopyDataDir(), 'w5', 'destructive-lifecycles');
  await assertDeleteTargetUnaliased(directory);
  const names = await readdir(directory).catch((error: unknown) => {
    if (!absent(error)) throw error;
    return [];
  });
  for (const name of names) {
    if (!LIFECYCLE_JOURNAL_ENTRY_NAME_PATTERN.test(name)) continue;
    const path = join(directory, name);
    await assertDeleteTargetUnaliased(path);
    const record = journalSchema.parse(
      JSON.parse(await readFile(path, 'utf8')),
    );
    if (
      record.workspaceId === plan.workspaceId &&
      (record.worktreeId === undefined ||
        record.worktreeId === plan.worktreeId) &&
      (record.state !== 'completed' || record.cleanupRequired)
    )
      throw deleteRefusal('An interrupted lifecycle needs manual recovery.');
  }
  const archive = join(
    getCanopyDataDir(),
    'workspaces',
    plan.workspaceId,
    'archived-containers',
    plan.worktreeId,
  );
  for (const path of [
    join(archive, 'recovery.staged.json'),
    join(archive, 'git-state.staged.json'),
    join(dirname(plan.root), `.${plan.worktreeId}.archive-quarantine`),
    join(
      getCanopyDataDir(),
      'workspaces',
      plan.workspaceId,
      'worktree-data',
      plan.worktreeId,
      'archive-recovery-evidence',
    ),
  ]) {
    await assertDeleteTargetUnaliased(path);
    const stat = await lstat(path).catch((error: unknown) => {
      if (!absent(error)) throw error;
      return undefined;
    });
    if (stat)
      throw deleteRefusal(
        'Legacy archive or staged Git evidence needs manual recovery.',
      );
  }
}

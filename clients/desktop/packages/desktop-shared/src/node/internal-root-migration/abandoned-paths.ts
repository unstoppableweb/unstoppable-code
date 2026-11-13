import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readWorktreeList } from '@canopy/core-runtime/node/workspace/read-formats';
import {
  isWithin,
  type RelocationGit,
  relocationWorktreeOwnedPaths,
} from '@canopy/core-runtime/node/relocation';
import type { InternalRootLifecycleJournalEvidence } from '@canopy/core-runtime/node/internal-root-repairs';
import { statIfPresent } from './filesystem';

/** Exact omission inventory, frozen before construction; never follows payload links. */
export async function abandonedArchivePaths(
  source: string,
  evidence: readonly Pick<
    InternalRootLifecycleJournalEvidence,
    'name' | 'abandoned'
  >[],
): Promise<string[]> {
  const paths = new Set<string>();
  for (const entry of evidence) {
    if (!entry.abandoned) continue;
    const { workspaceId, worktreeId } = entry.abandoned;
    const workspace = join(source, 'workspaces', workspaceId);
    if (
      (await statIfPresent(workspace)) &&
      (await realpath(workspace)) !== workspace
    )
      throw new Error(
        `Aliased abandoned workspace: ${workspaceId}/${worktreeId}`,
      );
    paths.add(join(source, 'w5/destructive-lifecycles', entry.name));
    paths.add(join(workspace, 'worktrees', worktreeId));
    paths.add(
      join(workspace, 'worktrees', `.${worktreeId}.archive-quarantine`),
    );
    paths.add(join(source, 'chat-plugins', workspaceId, worktreeId));
    for (const folder of [
      'archived-containers',
      'worktree-data',
      'attachments',
      'script-runs',
      'cost',
      'chat-storage-v2',
    ])
      paths.add(join(workspace, folder, worktreeId));
    for (const folder of [
      'chats',
      'chat-archives',
      'chat-journals',
      'chat-storage-manifests',
      'summaries',
      'plans',
      'detected-plans',
      'split-maps',
    ]) {
      const directory = join(workspace, folder);
      if (!(await statIfPresent(directory))) continue;
      if ((await realpath(directory)) !== directory)
        throw new Error(
          `Aliased abandoned payload directory: ${JSON.stringify(directory)}`,
        );
      for (const name of (await readdir(directory)).sort())
        if (
          ['json', 'jsonl'].some(
            (extension) =>
              name === `${worktreeId}.${extension}` ||
              name.startsWith(`${worktreeId}.${extension}.`),
          )
        )
          paths.add(join(directory, name));
    }
    const listPath = join(workspace, 'worktrees.json');
    const listStat = await statIfPresent(listPath);
    if (!listStat) continue;
    if (
      !listStat?.isFile() ||
      listStat.nlink !== 1 ||
      (await realpath(listPath)) !== listPath
    )
      throw new Error(
        `Unsafe abandoned worktree membership: ${JSON.stringify(listPath)}`,
      );
    const list = readWorktreeList({
      state: 'present',
      raw: await readFile(listPath, 'utf8'),
    });
    if (list.authority !== 'ok' || !list.complete)
      throw new Error(
        `Unreadable abandoned worktree membership: ${JSON.stringify(listPath)}`,
      );
    for (const row of list.worktrees.filter((row) => row.id === worktreeId))
      for (const path of relocationWorktreeOwnedPaths(
        JSON.stringify({ version: 1, worktrees: [row] }),
        { checkoutsOnly: true },
      )) {
        if (isWithin(path, workspace) || isWithin(path, join(source, 'w5')))
          throw new Error(
            `Abandoned checkout overlaps workspace or W5 metadata: ${path}`,
          );
        paths.add(path);
      }
  }
  return [...paths];
}

/** Repository-discovery failures qualify; runtime/configuration failures do not. */
export async function assertAbandonedCheckouts(
  source: string,
  paths: readonly string[],
  git: RelocationGit,
): Promise<void> {
  for (const path of paths) {
    const refusal = (): never => {
      throw new Error(
        `--abandon-checkout ${JSON.stringify(path)} must name a broken checkout directory under ${JSON.stringify(source)}; preserve the folder.`,
      );
    };
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      path === source ||
      !isWithin(source, path) ||
      isWithin(join(source, 'w5'), path) ||
      isWithin(path, join(source, 'workspaces'))
    )
      refusal();
    const state = await statIfPresent(path);
    if (!state?.isDirectory() || (await realpath(path)) !== path) refusal();
    const dotGit = await statIfPresent(join(path, '.git'));
    if (!dotGit || (!dotGit.isFile() && !dotGit.isDirectory())) refusal();
    try {
      await git(path, ['rev-parse', '--absolute-git-dir']);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 128 &&
        'stderr' in error &&
        typeof error.stderr === 'string' &&
        /^fatal: (?:not a git repository|invalid gitfile format)/m.test(
          error.stderr,
        )
      )
        continue;
      throw error;
    }
    refusal();
  }
}

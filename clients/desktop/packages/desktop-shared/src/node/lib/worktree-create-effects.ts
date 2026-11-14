import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { classifyWorktreeAddFailure } from '@canopy/core-runtime/node/git';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID } from '../../types';
import {
  initializePanelLayoutModeFile,
  PANEL_LAYOUT_MODE_FILENAME,
  readWorkspaceDefaultLayoutMode,
} from './panel-layout-mode';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import type {
  SidebarItem,
  WorktreeData,
  WorkspaceWorktreeRepairIssue,
} from '../../types';
import type { CreateWorktreeServiceOptions } from './worktree-service';
import { readCanopyJson, writeCanopyJson } from './canopy-json';
import {
  isProjectInstructionFileReadable,
  resolveProjectInstructionFile,
  restoreProjectInstructionFiles,
} from './project-instruction-files';
import {
  getMultiRepoRepoWorktreeDir,
  getMultiRepoRootWorktreeDir,
  getMultiRepoWorktreeDir,
  getSingleRepoWorktreeDir,
  pathExists,
  runGit,
} from './worktree-cli-reads';
import { isErrnoException } from '@canopy/execution-engine/node/lib/type-guards';
import { settleAll } from './detached-work';

export function normalizeBranchName(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function makeWorktreeId(
  existingIds: string[],
  branchName: string | null,
): string {
  const base =
    branchName
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'worktree';
  const existing = new Set(existingIds);
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function addGitWorktree(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(path.dirname(worktreePath), { recursive: true });
  signal?.throwIfAborted();
  const startPoint = baseBranch ?? 'HEAD';
  try {
    await runGit(
      ['worktree', 'add', '-b', branchName, worktreePath, startPoint],
      repoPath,
      signal,
    );
  } catch (error) {
    await classifyWorktreeAddFailure(error, repoPath, startPoint, () =>
      runGit(
        ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
        repoPath,
        signal,
        2000,
      ),
    );
    throw error;
  }
}

async function gitignoreContainsReposEntry(
  worktreeRoot: string,
): Promise<boolean> {
  try {
    const content = await readFile(
      path.join(worktreeRoot, '.gitignore'),
      'utf8',
    );
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .some((line) => line === 'repos' || line === 'repos/');
  } catch {
    return false;
  }
}

async function ensureGitignoreContainsReposEntry(
  worktreeRoot: string,
): Promise<void> {
  const gitignorePath = path.join(worktreeRoot, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf8');
  } catch {
    await writeFile(gitignorePath, 'repos/\n', 'utf8');
    return;
  }

  if (await gitignoreContainsReposEntry(worktreeRoot)) {
    return;
  }

  const separator =
    existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await writeFile(gitignorePath, `${existing}${separator}repos/\n`, 'utf8');
}

export async function ensureAgentsMdSymlinkOrCopy(
  worktreeRoot: string,
  platform: NodeJS.Platform = hostPlatformOperatingSystem(),
): Promise<void> {
  const agentsPath = path.join(worktreeRoot, 'AGENTS.md');
  await rm(agentsPath, { recursive: true, force: true });

  if (platform !== 'win32') {
    try {
      await symlink('CLAUDE.md', agentsPath);
      return;
    } catch (error) {
      if (
        !isErrnoException(error) ||
        (error.code !== 'EPERM' && error.code !== 'EACCES')
      ) {
        throw error;
      }
    }
  }

  const claudePath = path.join(worktreeRoot, 'CLAUDE.md');
  try {
    await link(claudePath, agentsPath);
  } catch {
    await copyFile(claudePath, agentsPath);
  }
}

async function validateWorkspaceRootWorktree(
  workspaceId: string,
  worktreeId: string,
): Promise<WorkspaceWorktreeRepairIssue[]> {
  const worktreeRoot = getMultiRepoRootWorktreeDir(workspaceId, worktreeId);
  const issues: WorkspaceWorktreeRepairIssue[] = [];

  if (!(await gitignoreContainsReposEntry(worktreeRoot))) {
    issues.push({
      code: (await pathExists(path.join(worktreeRoot, '.gitignore')))
        ? 'invalid-gitignore'
        : 'missing-gitignore',
      message: '.gitignore must include "repos/" for nested project repos',
      blocking: true,
    });
  }

  try {
    const manifest = await readCanopyJson(worktreeRoot);
    if (manifest === null) {
      issues.push({
        code: 'missing-canopy-json',
        message: 'canopy.json is missing from the project root',
        blocking: true,
      });
    }
  } catch (error) {
    issues.push({
      code: 'invalid-canopy-json',
      message:
        error instanceof Error
          ? error.message
          : 'canopy.json is invalid in the project root',
      blocking: true,
    });
  }

  const [hasAgentsMd, hasClaudeMd] = await settleAll([
    isProjectInstructionFileReadable(worktreeRoot, 'AGENTS.md').catch(
      () => false,
    ),
    isProjectInstructionFileReadable(worktreeRoot, 'CLAUDE.md').catch(
      () => false,
    ),
  ]);
  if (!hasAgentsMd && !hasClaudeMd) {
    issues.push({
      code: 'missing-claude-md',
      message: 'AGENTS.md is missing from the project root',
      blocking: false,
    });
  }

  if (!hasAgentsMd) {
    issues.push({
      code: 'invalid-agents-md',
      message: 'AGENTS.md must mirror CLAUDE.md',
      blocking: false,
    });
  }

  return issues;
}

async function repairWorkspaceRootWorktree(options: {
  workspace: SidebarItem & { type: 'multi-repo' };
  worktreeId: string;
  restoreClaudeMd: boolean;
}): Promise<WorkspaceWorktreeRepairIssue[]> {
  const worktreeRoot = getMultiRepoRootWorktreeDir(
    options.workspace.id,
    options.worktreeId,
  );
  await mkdir(worktreeRoot, { recursive: true });
  await ensureGitignoreContainsReposEntry(worktreeRoot);

  const manifest = options.workspace.sourceRepoPath
    ? await readCanopyJson(options.workspace.sourceRepoPath)
    : null;
  await writeCanopyJson(worktreeRoot, manifest ?? { version: 1, repos: [] });

  try {
    const existing = await resolveProjectInstructionFile(worktreeRoot);
    if (existing.exists) {
      if (
        path.basename(existing.filePath) === 'CLAUDE.md' &&
        !existing.aliasPath
      ) {
        await ensureAgentsMdSymlinkOrCopy(worktreeRoot);
      }
    } else if (options.restoreClaudeMd && options.workspace.sourceRepoPath) {
      const source = await resolveProjectInstructionFile(
        options.workspace.sourceRepoPath,
      );
      if (source.exists) {
        await restoreProjectInstructionFiles(source, existing);
        if (
          !existing.aliasPath &&
          path.basename(source.filePath) === 'CLAUDE.md'
        ) {
          await ensureAgentsMdSymlinkOrCopy(worktreeRoot);
        }
      }
    }
  } catch {
    return validateWorkspaceRootWorktree(
      options.workspace.id,
      options.worktreeId,
    );
  }

  return validateWorkspaceRootWorktree(
    options.workspace.id,
    options.worktreeId,
  );
}

export async function removeGitWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  try {
    await runGit(['worktree', 'remove', '--force', worktreePath], repoPath);
  } catch {
    await rm(worktreePath, { recursive: true, force: true });
  }
}

export function buildTrackedRepoBaseBranches(
  entries: Array<{ id: string }>,
  baseBranch: string | undefined,
): Record<string, string> | undefined {
  if (!baseBranch) {
    return undefined;
  }
  const tracked: Record<string, string> = {};
  for (const entry of entries) {
    tracked[entry.id] = baseBranch;
  }
  return tracked;
}

export type GitWorktreeWorkspace = Exclude<SidebarItem, { type: 'cowork' }>;

export async function createWorktreeGit(
  workspace: GitWorktreeWorkspace,
  worktree: WorktreeData,
  options: CreateWorktreeServiceOptions,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const { id, branchName } = worktree;
  if (workspace.type === 'single-repo') {
    await addGitWorktree(
      workspace.repoPath,
      getSingleRepoWorktreeDir(workspace.id, id),
      branchName,
      options.baseBranch,
      signal,
    );
    return;
  }
  const worktreeDir = getMultiRepoWorktreeDir(workspace.id, id);
  if (workspace.sourceRepoPath) {
    await addGitWorktree(
      workspace.sourceRepoPath,
      getMultiRepoRootWorktreeDir(workspace.id, id),
      branchName,
      options.baseBranch,
      signal,
    );
    const repairIssues = await validateWorkspaceRootWorktree(workspace.id, id);
    if (repairIssues.some((issue) => issue.blocking)) {
      if (options.repairWorkspaceRoot === true) {
        signal?.throwIfAborted();
        const repairedIssues = await repairWorkspaceRootWorktree({
          workspace,
          worktreeId: id,
          restoreClaudeMd: options.restoreClaudeMd ?? true,
        });
        const blockingIssues = repairedIssues.filter((issue) => issue.blocking);
        if (blockingIssues.length > 0) {
          throw new Error(
            blockingIssues.map((issue) => issue.message).join('; '),
          );
        }
      } else {
        throw new Error(
          'Created project root worktree requires repair and cannot be finalized from the CLI. ' +
            'Re-run this command with --repair to repair project root files during creation. ' +
            'Add --no-restore-claude-md if repair should not restore project instructions from the project source repo.',
        );
      }
    }
  } else {
    signal?.throwIfAborted();
    await mkdir(path.dirname(worktreeDir), { recursive: true });
    await mkdir(worktreeDir);
  }

  for (const repo of workspace.repos) {
    await addGitWorktree(
      repo.repoPath,
      getMultiRepoRepoWorktreeDir(workspace.id, id, repo.id),
      branchName,
      options.baseBranch,
      signal,
    );
  }
}

/** A closed child alone is insufficient: every planned creation effect must be absent. */
export async function proveFailedWorktreeCreationAbsent(
  error: unknown,
  workspace: GitWorktreeWorkspace,
  worktree: WorktreeData,
  signal: AbortSignal,
): Promise<boolean> {
  if (
    !(error instanceof Error) ||
    typeof Reflect.get(error, 'code') !== 'number' ||
    Reflect.get(error, 'killed') === true ||
    Reflect.get(error, 'signal') != null ||
    signal.aborted
  )
    return false;
  const checkouts = worktree.creation?.checkouts;
  if (!checkouts?.length) return false;
  try {
    if (workspace.type === 'multi-repo' && !workspace.sourceRepoPath) {
      try {
        await lstat(getMultiRepoWorktreeDir(workspace.id, worktree.id));
        return false;
      } catch (failure) {
        if (
          typeof failure !== 'object' ||
          failure === null ||
          Reflect.get(failure, 'code') !== 'ENOENT'
        )
          return false;
      }
    }
    for (const checkout of checkouts) {
      try {
        await lstat(checkout.checkoutPath);
        return false;
      } catch (failure) {
        if (
          typeof failure !== 'object' ||
          failure === null ||
          Reflect.get(failure, 'code') !== 'ENOENT'
        )
          return false;
      }
      const branch = `refs/heads/${worktree.branchName}`;
      const refs = await runGit(
        ['for-each-ref', '--format=%(refname)', branch],
        checkout.repositoryPath,
        signal,
      );
      if (refs.split('\n').includes(branch)) return false;
      const registered = await runGit(
        ['worktree', 'list', '--porcelain', '-z'],
        checkout.repositoryPath,
        signal,
      );
      if (registered.split('\0').includes(`worktree ${checkout.checkoutPath}`))
        return false;
    }
    return !signal.aborted;
  } catch {
    return false;
  }
}

export async function seedCreatedWorktreePanelLayoutMode(
  options: CreateWorktreeServiceOptions,
  worktreeId: string,
): Promise<void> {
  if (
    options.seedPanelLayoutMode === false ||
    (options.workspaceId === APP_ADVISOR_PROJECT_ID &&
      worktreeId === APP_ADVISOR_WORKTREE_ID)
  ) {
    return;
  }
  try {
    const mode = await readWorkspaceDefaultLayoutMode();
    await initializePanelLayoutModeFile(
      {
        workspaceId: options.workspaceId,
        worktreeId,
        filePath: path.join(
          getCanopyDataDir(),
          'workspaces',
          options.workspaceId,
          'worktree-data',
          worktreeId,
          PANEL_LAYOUT_MODE_FILENAME,
        ),
      },
      mode,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      'Failed to seed worktree panel layout mode ' +
        `(workspaceId=${options.workspaceId}, worktreeId=${worktreeId}): ` +
        `${errorMessage}\n`,
    );
  }
}

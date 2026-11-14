import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { withArchivedWorkspaceOperationLock } from './archived-containers';
import { withW5RepositoryLock } from './w5-repository-locks';
import {
  hasDestructiveWorktreeOwner,
  withSharedLifecycleJournalAccess,
} from './w5-destructive-recovery';
import { isWorkspaceTargetRemovalPending } from './workspace-target-exclusion';
import { getArchivedContainerManifestPath, w5RecordReadPaths } from './paths';
import { withW5Commit } from './w5-commit-log-file-store';
import { afterW5Apply } from './w5-commit-scope';
import { WORKTREE_LIST_STORAGE, withStorageAdmission } from './w5-storage';
import { getGitCommonDir } from './git';
import {
  removeAbsentWorktreeRegistrations,
  hasWorktreeRegistration,
} from './worktree-registration-removal';
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  WorkspaceConfigFile,
  WorkspaceReadinessIssue,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { listCheckedOutBranches, listRegisteredWorktreePaths } from './git';
import {
  getWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
  getWorkspaceWorktreesRootDir,
} from './paths';
import {
  readWorkspaceWorktreesDetailed,
  readWorkspaceWorktreesUnlocked,
} from './workspace-persistence';
import { resolveProjectReferenceRepoPath } from './project-reference-repo';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';
import { canonicalizePossiblyMissingPath } from './worktree-registration-removal';

function issue(
  recovery: NonNullable<WorkspaceReadinessIssue['recovery']>,
): WorkspaceReadinessIssue {
  return {
    code: 'recovery-required',
    title: 'Recover interrupted worktree creation',
    message:
      recovery.phase === 'reserved'
        ? `${recovery.branchName}: ${recovery.checkoutPath}. Creation stopped before Git ran, so this checkout may not exist. Review this path before creating another worktree. Any files there have been kept.`
        : `${recovery.branchName}: ${recovery.checkoutPath}. Review this checkout before creating another worktree. Its files and Git registration have been kept.`,
    repoName: recovery.repositoryPath,
    // This issue reports evidence only; recovery requires an explicit decision.
    fixPrompt: null,
    recovery,
  };
}

/** Read-only D3/B4 diagnostics. Never adopts, resumes or removes a checkout. */
export async function inspectWorktreeCreationRecovery(
  workspaceId: string,
  config: WorkspaceConfigFile,
  rows?: readonly WorktreeData[],
): Promise<WorkspaceReadinessIssue[]> {
  if (config.type === 'cowork') return [];
  let registryComplete = true;
  if (!rows) {
    const read = await readWorkspaceWorktreesDetailed(workspaceId, {
      persistRemovalCleanup: false,
    });
    // Partial rows still contain authoritative recovery metadata. They only
    // cannot prove that an unlisted checkout is orphaned.
    registryComplete = read.authority === 'ok' || read.authority === 'absent';
    rows = read.worktrees;
  }
  const issues = rows.flatMap((row) =>
    row.creation?.state === 'recovery-required'
      ? (row.creation.checkouts.length
          ? row.creation.checkouts
          : [
              {
                repositoryPath:
                  config.sourceRepoPath ??
                  getWorkspaceWorktreeRootRepoDir(workspaceId, row.id),
                checkoutPath: getWorkspaceWorktreeRootRepoDir(
                  workspaceId,
                  row.id,
                ),
              },
            ]
        ).map((checkout) =>
          issue({
            workspaceId,
            worktreeId: row.id,
            operationId: row.creation?.operationId,
            phase: row.creation?.phase ?? 'reserved',
            branchName: row.branchName,
            ...checkout,
          }),
        )
      : [],
  );
  if (!registryComplete) return issues;
  const canonicalPaths = new Map<string, Promise<string | null>>();
  function canonicalPath(path: string): Promise<string | null> {
    const absolute = resolve(path);
    let result = canonicalPaths.get(absolute);
    if (!result) {
      result = canonicalizePossiblyMissingPath(absolute).catch(() => null);
      canonicalPaths.set(absolute, result);
    }
    return result;
  }
  const repositories =
    config.type === 'single-repo'
      ? config.repoPath
        ? [await resolveProjectReferenceRepoPath(config.repoPath)]
        : []
      : [
          ...(config.sourceRepoPath
            ? [await resolveWorkspaceReferenceRepoPath(config.sourceRepoPath)]
            : []),
          ...config.repos.map((repo) => repo.repoPath),
        ];
  const ownedPaths = new Set(
    await Promise.all(
      rows
        .flatMap((row) => [
          getWorktreeDir(workspaceId, row.id),
          getWorkspaceWorktreeRootRepoDir(workspaceId, row.id),
          // Creation only checks out the selected child repositories; a missing
          // scope means every configured repository, and [] is root-only.
          ...config.repos
            .filter(
              (repo) =>
                row.includedRepoIds === undefined ||
                row.includedRepoIds.includes(repo.id),
            )
            .map((repo) =>
              getWorkspaceWorktreeRepoDir(workspaceId, row.id, repo.id),
            ),
          ...(row.creation?.checkouts.map(
            (checkout) => checkout.checkoutPath,
          ) ?? []),
        ])
        .map(canonicalPath),
    ),
  );
  const root = await canonicalPath(getWorkspaceWorktreesRootDir(workspaceId));
  // Unresolved ownership cannot prove an orphan. Missing paths still resolve
  // through their existing ancestors, including macOS /var aliases.
  if (root === null || ownedPaths.has(null)) return issues;
  for (const repositoryPath of Array.from(new Set(repositories))) {
    // An unreadable repository cannot prove a checkout is orphaned. Keep the
    // persisted diagnostics and continue scanning the other repositories.
    const listing = await Promise.all([
      listRegisteredWorktreePaths(repositoryPath),
      listCheckedOutBranches(repositoryPath),
    ]).catch(() => null);
    if (!listing) continue;
    const [registered, branches] = listing;
    const branchByPath = new Map(
      await Promise.all(
        Array.from(
          branches,
          async ([branch, path]) =>
            [await canonicalPath(path), branch] as const,
        ),
      ),
    );
    for (const checkoutPath of Array.from(registered)) {
      const canonicalCheckout = await canonicalPath(checkoutPath);
      if (canonicalCheckout === null) continue;
      const child = relative(root, canonicalCheckout);
      if (
        !child ||
        child === '..' ||
        child.startsWith('../') ||
        child.startsWith('..\\') ||
        isAbsolute(child) ||
        ownedPaths.has(canonicalCheckout)
      )
        continue;
      issues.push(
        issue({
          workspaceId,
          phase: 'orphan-checkout',
          repositoryPath,
          checkoutPath,
          branchName: branchByPath.get(canonicalCheckout) ?? 'HEAD',
        }),
      );
    }
  }
  return issues;
}

/** Startup only repairs an unlisted, absent checkout; it never removes files or branches. */
export async function repairOrphanedWorktreeRegistration(
  workspaceId: string,
  config: WorkspaceConfigFile,
  recovery: NonNullable<WorkspaceReadinessIssue['recovery']>,
): Promise<boolean> {
  if (
    recovery.phase !== 'orphan-checkout' ||
    recovery.workspaceId !== workspaceId
  )
    return false;
  const root = await canonicalizePossiblyMissingPath(
    getWorkspaceWorktreesRootDir(workspaceId),
  );
  const checkout = await canonicalizePossiblyMissingPath(recovery.checkoutPath);
  const child = relative(root, checkout);
  const worktreeId = child.split(/[\\/]/)[0];
  if (!worktreeId || child.startsWith('..') || isAbsolute(child)) return false;
  const common = await getGitCommonDir(recovery.repositoryPath);
  const identity = await lstat(common);
  const sameRepository = async (
    repositoryPath: string = recovery.repositoryPath,
  ): Promise<boolean> => {
    // The source may be rebound while its former common directory still exists.
    if ((await getGitCommonDir(repositoryPath)) !== common) return false;
    const fresh = await lstat(common);
    return (
      fresh.dev === identity.dev &&
      fresh.ino === identity.ino &&
      fresh.birthtimeMs === identity.birthtimeMs
    );
  };
  const absent = async (path: string): Promise<boolean> => {
    try {
      await lstat(path);
      return false;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return true;
      throw error;
    }
  };
  const listLock = {
    kind: 'list',
    path: w5RecordReadPaths.worktrees(workspaceId),
  } as const;
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    withArchivedWorkspaceOperationLock(workspaceId, () =>
      withW5RepositoryLock(listLock, () =>
        withSharedLifecycleJournalAccess(async () => {
          const canRemove = async (): Promise<boolean> => {
            if (
              isWorkspaceTargetRemovalPending(workspaceId, worktreeId) ||
              (await hasDestructiveWorktreeOwner(
                workspaceId,
                worktreeId,
                recovery.checkoutPath,
              ))
            )
              return false;
            if (
              !(await absent(
                join(root, `.${worktreeId}.archive-quarantine`),
              )) ||
              !(await absent(
                getArchivedContainerManifestPath(workspaceId, worktreeId),
              )) ||
              !(await absent(recovery.checkoutPath))
            )
              return false;
            if (!(await sameRepository())) return false;
            const read = await readWorkspaceWorktreesUnlocked(workspaceId);
            if (read.authority !== 'ok' && read.authority !== 'absent')
              return false;
            // The same inspection proves scope/ownership again under the list lock.
            const issues = await inspectWorktreeCreationRecovery(
              workspaceId,
              config,
              read.worktrees,
            );
            let orphan = false;
            for (const { recovery: candidate } of issues) {
              if (
                candidate?.phase === 'orphan-checkout' &&
                candidate.checkoutPath === recovery.checkoutPath &&
                candidate.branchName === recovery.branchName &&
                (await sameRepository(candidate.repositoryPath))
              ) {
                orphan = true;
                break;
              }
            }
            return (
              orphan &&
              (await sameRepository()) &&
              !isWorkspaceTargetRemovalPending(workspaceId, worktreeId) &&
              !(await hasDestructiveWorktreeOwner(
                workspaceId,
                worktreeId,
                recovery.checkoutPath,
              )) &&
              (await absent(recovery.checkoutPath))
            );
          };
          if (!(await canRemove())) return false;
          let repaired = false;
          await withW5Commit(
            {
              operation: 'internal.worktree.recovery.repair-registration',
              locks: [listLock],
              fenceLockedFiles: true,
            },
            async () => {
              // Refuse before Git effects if the authority cannot fence ownership.
              await afterW5Apply(async () => {
                if (!(await canRemove())) return;
                await removeAbsentWorktreeRegistrations(
                  common,
                  [recovery.checkoutPath],
                  { canRemove },
                );
                repaired = !(await hasWorktreeRegistration(common, [
                  recovery.checkoutPath,
                ]));
              });
            },
          );
          return repaired;
        }),
      ),
    ),
  );
}

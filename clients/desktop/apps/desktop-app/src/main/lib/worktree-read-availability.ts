import { relative, sep } from 'node:path';
import {
  assertWorkingDirectoryAvailable,
  withWorkingDirectoryReadCheck,
} from '@canopy/desktop-shared/node/lib/working-directory';
import {
  APP_ADVISOR_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { getDataDir } from './paths';
import {
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from './resolve-worktree';
import { readWorkspaceWorktreesUnlocked } from './workspace-persistence';
import { isCoworkWorkspace } from './workspace-registry';
import { isWorkspaceTargetRemovalPending } from './workspace-target-exclusion';

/** Observation membership admission, before health checks probe the folder. */
export async function isWorktreeObservationTarget(
  projectId: string,
  worktreeId: string,
): Promise<boolean> {
  const target = resolveWorktreeTargetIds(projectId, worktreeId);
  if (!target) return false;
  const retiring = (): boolean =>
    isWorkspaceTargetRemovalPending(target.projectId, target.worktreeId);
  if (retiring()) return false;
  try {
    if (
      target.projectId !== APP_ADVISOR_PROJECT_ID &&
      target.projectId !== SHARED_CONTAINER_VIEWER_PROJECT_ID &&
      !isCoworkWorkspace(target.projectId)
    ) {
      const list = await readWorkspaceWorktreesUnlocked(target.projectId);
      if (
        list.authority !== 'ok' &&
        list.authority !== 'partial' &&
        list.authority !== 'absent'
      )
        return false;
      const row = list.worktrees.find(
        (entry) => entry.id === target.worktreeId,
      );
      if (!row || row.setupPhase === 'git-pending') return false;
    }
    return !retiring();
  } catch {
    return false;
  }
}

/** Re-probe observation targets and folders; never cache absence or retirement. */
export async function isWorktreeReadAvailable(
  projectId: string,
  worktreeId: string,
  cwd?: string,
): Promise<boolean> {
  if (!(await isWorktreeObservationTarget(projectId, worktreeId))) return false;
  try {
    await assertWorkingDirectoryAvailable(
      cwd ?? resolveWorktreeCwd(projectId, worktreeId),
    );
    const target = resolveWorktreeTargetIds(projectId, worktreeId);
    return (
      !!target &&
      !isWorkspaceTargetRemovalPending(target.projectId, target.worktreeId)
    );
  } catch {
    return false;
  }
}

/** Path-only background reads retain retirement admission across their awaits. */
export async function withGitReadPath<T>(
  cwd: string,
  unavailable: T,
  read: () => Promise<T>,
): Promise<T> {
  const parts = relative(getDataDir(), cwd).split(sep);
  if (
    parts[0] === 'workspaces' &&
    parts[2] === 'worktrees' &&
    parts[1] &&
    parts[3]
  ) {
    if (!(await isWorktreeReadAvailable(parts[1], parts[3], cwd)))
      return unavailable;
    return withWorktreeGitRead(parts[1], parts[3], unavailable, read);
  }
  try {
    await assertWorkingDirectoryAvailable(cwd);
  } catch {
    return unavailable;
  }
  return read();
}

/** Carries retirement checks through awaited and detached Git launches. */
export async function withWorktreeGitRead<T>(
  projectId: string,
  worktreeId: string,
  unavailable: T,
  read: () => Promise<T>,
): Promise<T> {
  if (!(await isWorktreeReadAvailable(projectId, worktreeId)))
    return unavailable;
  const target = resolveWorktreeTargetIds(projectId, worktreeId);
  if (!target) return unavailable;
  return withWorkingDirectoryReadCheck(
    () => !isWorkspaceTargetRemovalPending(target.projectId, target.worktreeId),
    read,
  );
}

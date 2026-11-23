import type { ProjectStartPage } from '@canopy/protocol/start-page';
import { readCanopyJson } from '../../lib/canopy-json';
import { resolveCoworkWorkspaceId } from '../../lib/cowork-migration-map';
import {
  getWorktreeDir,
  getWorkspaceWorktreeRootRepoDir,
} from '../../lib/paths';
import { resolveProjectReferenceRepoPath } from '../../lib/project-reference-repo';
import { validateId } from '../../lib/validation';
import { readWorkspaceConfig } from '../../lib/workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from '../../lib/workspace-reference-repo';
import { RemoteControllerRefusedError } from '../remote-protocol';
import {
  CONTROLLER_START_PAGE_UNREADABLE,
  type StoredStartPages,
} from './controller-url-writebacks';

function isValidId(value: string, label: string): boolean {
  try {
    validateId(value, label);
    return true;
  } catch {
    return false;
  }
}

async function manifestStartPage(
  repoPath: string,
): Promise<ProjectStartPage | undefined> {
  return (await readCanopyJson(repoPath).catch(() => null))?.startPage;
}

/**
 * The start pages a project stores now (CAN-7082), by field: its own setting,
 * its Cowork setting, the target worktree's canopy.json and its source's, as
 * `resolveProjectStartPage` finds them. An id the handler would refuse reads
 * nothing, so it never names another record. A project whose settings can't
 * be read refuses the call, since a stripped URL would otherwise replace its
 * stored one.
 */
export const readStoredStartPages: StoredStartPages = async (
  projectId,
  worktreeId,
) => {
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  if (!isValidId(workspaceId, 'projectId')) return {};
  const config = await readWorkspaceConfig(workspaceId).catch(() => {
    throw new RemoteControllerRefusedError(CONTROLLER_START_PAGE_UNREADABLE);
  });
  const worktreeManifest =
    worktreeId !== undefined && isValidId(worktreeId, 'worktreeId')
      ? await manifestStartPage(
          config.type === 'single-repo'
            ? getWorktreeDir(workspaceId, worktreeId)
            : getWorkspaceWorktreeRootRepoDir(workspaceId, worktreeId),
        )
      : undefined;
  const sourceRoot =
    config.type === 'single-repo' && config.repoPath
      ? await resolveProjectReferenceRepoPath(config.repoPath)
      : config.type === 'multi-repo' && config.sourceRepoPath
        ? await resolveWorkspaceReferenceRepoPath(config.sourceRepoPath)
        : undefined;
  const sourceManifest =
    sourceRoot === undefined ? undefined : await manifestStartPage(sourceRoot);
  return {
    ...(config.startPage !== undefined ? { local: config.startPage } : {}),
    ...(config.cowork?.startPage ? { cowork: config.cowork.startPage } : {}),
    ...(worktreeManifest ? { worktreeManifest } : {}),
    ...(sourceManifest ? { sourceManifest } : {}),
  };
};

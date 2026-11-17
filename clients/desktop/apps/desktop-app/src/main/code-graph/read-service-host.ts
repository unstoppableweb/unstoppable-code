import { existsSync } from 'node:fs';
import {
  CodeGraphReadServiceError,
  createCodeGraphReadService,
  type CodeGraphReadService,
  type CodeGraphReadServiceHost,
} from '@canopy/code-graph/host/read-service';
import { CodeGraphReadFailureError } from '@canopy/code-graph/host/read-failure';
import { createCodeGraphReadServiceWorker } from '@canopy/code-graph/host/read-worker';
import { getWorktreeCodeGraphDbPath } from '@canopy/desktop-shared/node/code-graph/worktree-paths';
import { getBundledCodeGraphDir } from '@canopy/execution-engine/pipelines/config-paths';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import {
  WORKSPACE_ROOT_REPO_ID,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { getActiveDesktopRuntimeIfAccepting } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  describeCodeGraphBaseWorkspace,
  resolveCodeGraphBaseWorkspaceFingerprint,
} from '../lib/code-graph-base-manager';
import {
  codeGraphBaseRunnerKey,
  readCompatibleCodeGraphBase,
} from '../lib/code-graph-base-store';
import { getHeadCommitSha } from '../lib/git';
import { getRepoShadowDir } from '../lib/repo-shadow';
import { resolveWorkspaceReferenceRepoPath } from '../lib/workspace-reference-repo';
import { getCodeGraphSourceBuildState } from './build-runner';
import {
  evaluateStorageWrite,
  STORAGE_OWNERSHIP,
} from '@canopy/core-runtime/storage';
import { runCodeGraphWorkerRead } from './read-runner';

// Composes the worker's code-graph read service for this process: worktree
// graphs under the desktop data directory and the base manager's published
// workspace bases, read on the desktop read hosts, with source build state
// from the desktop build scheduler.

const WORKSPACE_BASES_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-code-graph-workspace-bases',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: ['core.workspace.read'],
};

/** The project's sidebar row, through `core.workspace.list` (CAN-5632). */
async function readWorkspaceItem(
  workspaceId: string,
): Promise<SidebarItem | undefined> {
  const runtime = getActiveDesktopRuntimeIfAccepting();
  // No runtime means the app is starting or quitting: the read is canceled.
  if (runtime === null) throw new CodeGraphReadFailureError('canceled');
  const { legacyResult } = await runtime.queryWorkspaceListForLegacyIpc(
    { scope: { workspaceId } },
    { caller: WORKSPACE_BASES_CALLER },
  );
  return legacyResult.items.find((candidate) => candidate.id === workspaceId);
}

const workspaceBases: NonNullable<
  CodeGraphReadServiceHost['workspaceBases']
> = async ({ workspaceId }) => {
  const item = await readWorkspaceItem(workspaceId);
  const workspace =
    item === undefined ? null : describeCodeGraphBaseWorkspace(item);
  if (workspace === null)
    throw new CodeGraphReadServiceError('not-found', 'Project not found.');
  const fingerprint = await resolveCodeGraphBaseWorkspaceFingerprint(workspace);
  // No fingerprint means Code Graph was never prepared for this project.
  if (fingerprint === null)
    return {
      prepared: false,
      repoIds: workspace.repositories.map(({ repoId }) => repoId),
    };
  return {
    prepared: true,
    repositories: workspace.repositories.map(({ repoId, repoPath }) => ({
      repoId,
      graph: async () => {
        const canonicalRepoRoot =
          await resolveWorkspaceReferenceRepoPath(repoPath);
        const identity = {
          canonicalRepoRoot,
          repoId,
          customLanguagesFingerprint: fingerprint,
        };
        const key = codeGraphBaseRunnerKey(canonicalRepoRoot, identity);
        // Manifest-only; no SQLite on main.
        const published = await readCompatibleCodeGraphBase(identity);
        return {
          key,
          buildState: getCodeGraphSourceBuildState(key),
          published:
            published === null
              ? null
              : {
                  dbPath: published.dbPath,
                  behindCheckout: async () => {
                    const checkoutHead = await getHeadCommitSha(
                      `${getRepoShadowDir(canonicalRepoRoot)}/checkout`,
                    ).catch(() => null);
                    return (
                      checkoutHead !== null &&
                      published.manifest.gitHead !== null &&
                      checkoutHead !== published.manifest.gitHead
                    );
                  },
                },
        };
      },
    })),
  };
};

const readService = createCodeGraphReadService({
  scheduler: { run: (input) => runCodeGraphWorkerRead(input) },
  dbPath: ({ workspaceId, worktreeId }) =>
    getWorktreeCodeGraphDbPath(workspaceId, worktreeId),
  hasGraph: ({ workspaceId, worktreeId }) =>
    existsSync(getWorktreeCodeGraphDbPath(workspaceId, worktreeId)),
  buildState: ({ workspaceId, worktreeId }) =>
    getCodeGraphSourceBuildState(`${workspaceId}/${worktreeId}`),
  worktreeRoot: ({ workspaceId, worktreeId }) =>
    resolveWorktreeCwd(workspaceId, worktreeId),
  // The tools' repository set: a worktree that lists no repositories is read
  // as its one root repository.
  repositories: async ({ workspaceId, worktreeId }) => {
    const worktreePath = resolveWorktreeCwd(workspaceId, worktreeId);
    const entries = await listWorkspaceWorktreeRepoEntries(
      workspaceId,
      worktreePath,
    );
    return entries.length === 0
      ? [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: worktreePath }]
      : entries.map((entry) => ({
          repoId: entry.repoId,
          rootPath: entry.repoPath,
        }));
  },
  resourcesDir: () => getBundledCodeGraphDir(),
  now: () => new Date(),
  workspaceBases,
});

/**
 * A snapshot import replaces a worktree graph from a read utility process
 * (CAN-6985). It is admitted while `worktree_code_graph` stays legacy and
 * refused, before any graph work, once the daemon owns the store.
 */
export const desktopCodeGraphReadService: CodeGraphReadService = {
  ...readService,
  importSnapshot: (input) => {
    const decision = evaluateStorageWrite(
      'worktree_code_graph',
      'utility_process',
      STORAGE_OWNERSHIP,
    );
    if (!decision.allowed)
      return Promise.reject(
        new CodeGraphReadServiceError(
          'failed-precondition',
          "This worktree's code graph is written by the background service.",
        ),
      );
    return readService.importSnapshot(input);
  },
};

export const desktopCodeGraphReadWorker = createCodeGraphReadServiceWorker(
  desktopCodeGraphReadService,
);

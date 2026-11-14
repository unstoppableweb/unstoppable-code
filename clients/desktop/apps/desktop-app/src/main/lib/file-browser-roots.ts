import {
  buildCoworkRootCatalog,
  buildMultiRepoRootCatalog,
  buildSingleRepoRootCatalog,
  createFilesystemRoot,
  readRootVisibility,
  readFilesystemWorkspaceIndexEntry,
  resolveCoworkWorkspaceRootName,
  filesystemScopeError,
  type AttachmentsRootSource,
  type FilesystemRoot,
  type FilesystemRootCatalog,
} from '@canopy/core-runtime/node';
import {
  APP_ADVISOR_PROJECT_ID,
  COWORK_WORKSPACE_FILE_ROOT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
  type FileTreeRoot,
} from '@canopy/desktop-shared/types';
import {
  w5RecordReadPaths,
  getWorktreeAttachmentsDir,
  getWorkspaceWorktreeAttachmentsDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeReposDir,
  getWorkspaceWorktreeRootRepoDir,
} from './paths';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import {
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from './resolve-worktree';
import { basename } from 'node:path';
import { desktopW5FileStore } from './w5-commit-log-file-store';
import { readWorkspaceConfig } from './workspace-persistence';
import { isCoworkWorkspace, isMultiRepoWorkspace } from './workspace-registry';
import { resolveSharedContainerViewerReadRoots } from '../shared-containers/read/viewer-root';

export type FileBrowserRootKind = FileTreeRoot['rootKind'];

export interface FileBrowserRoot extends FileTreeRoot {
  gitAware: boolean;
  excludedDescendantRoots: string[];
  /** Revision root used by the sealed-replica no-follow read boundary. */
  readBoundaryRoot?: string;
}

export interface FileBrowserRootsResult {
  roots: FileBrowserRoot[];
  rootMap: Map<string, FileBrowserRoot>;
}

export function getFileBrowserSupplementalWatchPaths(
  projectId: string,
  worktreeId: string,
): string[] {
  if (
    projectId === APP_ADVISOR_PROJECT_ID ||
    projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID
  )
    return [];
  if (isCoworkWorkspace(projectId)) {
    return [
      getCoworkManagedSubdir(
        resolveWorktreeCwd(projectId, worktreeId),
        'attachments',
      ),
    ];
  }
  if (isMultiRepoWorkspace(projectId)) {
    return [getWorkspaceWorktreeAttachmentsDir(projectId, worktreeId)];
  }
  return [getWorktreeAttachmentsDir(projectId, worktreeId)];
}

function toFileBrowserRoot(root: FilesystemRoot): FileBrowserRoot {
  return {
    repoId: root.id,
    repoName: root.name,
    absolutePath: root.absolutePath,
    rootKind: root.kind,
    gitAware: root.gitAware,
    excludedDescendantRoots: root.excludedDescendantRoots,
  };
}

function finalizeRoots(roots: FileBrowserRoot[]): FileBrowserRootsResult {
  const rootMap = new Map<string, FileBrowserRoot>();
  roots.forEach((root) => {
    rootMap.set(root.repoId, root);
  });
  return { roots, rootMap };
}

function projectCatalog(
  catalog: FilesystemRootCatalog,
): FileBrowserRootsResult {
  return finalizeRoots(catalog.roots.map(toFileBrowserRoot));
}

async function readAttachmentsSource(
  absolutePath: string,
): Promise<AttachmentsRootSource> {
  return { absolutePath, visible: await readRootVisibility(absolutePath) };
}

function createStandaloneRoot(
  id: string,
  name: string,
  absolutePath: string,
): FileBrowserRoot {
  return toFileBrowserRoot(
    createFilesystemRoot({ id, name, kind: 'standalone', absolutePath }),
  );
}

export async function getFileBrowserRoots(
  projectId: string,
  worktreeId: string,
): Promise<FileBrowserRootsResult> {
  if (projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    const roots = await resolveSharedContainerViewerReadRoots(worktreeId);
    return finalizeRoots(
      roots.map((root) => ({
        ...createStandaloneRoot(root.repoId, root.repoName, root.absolutePath),
        readBoundaryRoot: root.revisionRoot,
      })),
    );
  }
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    // App Advisor's per-entry attachment store is private app metadata. Its
    // file explorer exposes only the shared agent cwd, including the
    // user-facing .{brand} folders nested inside it.
    const home = resolveWorktreeCwd(projectId, worktreeId);
    return finalizeRoots([createStandaloneRoot(projectId, projectId, home)]);
  }

  if (isCoworkWorkspace(projectId)) {
    // `resolveWorktreeCwd` already resolves to the cowork home dir for both
    // the legacy sentinel keying and real cowork workspace ids. The renderer's
    // `getCwdFromFileIndex` special-cases the workspace root id to resolve
    // the cowork cwd.
    const target = resolveWorktreeTargetIds(projectId, worktreeId);
    if (!target) throw filesystemScopeError('roots', 'notFound');
    const entry = readFilesystemWorkspaceIndexEntry(
      target.projectId,
      await desktopW5FileStore.read(w5RecordReadPaths.index()),
    );
    if (entry.type !== 'cowork')
      throw filesystemScopeError('roots', 'invalidState');
    const home = resolveWorktreeCwd(projectId, worktreeId);
    return projectCatalog(
      buildCoworkRootCatalog({
        workspace: {
          id: COWORK_WORKSPACE_FILE_ROOT_ID,
          name: resolveCoworkWorkspaceRootName(
            entry.name,
            basename(home) || home,
          ),
          absolutePath: home,
        },
        notesPath: getCoworkManagedSubdir(home, 'notes'),
        promptsPath: getCoworkManagedSubdir(home, 'prompts'),
        attachments: await readAttachmentsSource(
          getCoworkManagedSubdir(home, 'attachments'),
        ),
      }),
    );
  }

  if (isMultiRepoWorkspace(projectId)) {
    const config = await readWorkspaceConfig(projectId);
    return projectCatalog(
      buildMultiRepoRootCatalog({
        workspaceRoot: {
          id: WORKSPACE_ROOT_REPO_ID,
          name: WORKSPACE_ROOT_REPO_NAME,
          absolutePath: getWorkspaceWorktreeRootRepoDir(projectId, worktreeId),
          gitAware: Boolean(config.sourceRepoPath),
        },
        reposDir: getWorkspaceWorktreeReposDir(projectId, worktreeId),
        repos: config.repos.map((repo) => ({
          id: repo.id,
          name: repo.name,
          absolutePath: getWorkspaceWorktreeRepoDir(
            projectId,
            worktreeId,
            repo.id,
          ),
        })),
        attachments: await readAttachmentsSource(
          getWorkspaceWorktreeAttachmentsDir(projectId, worktreeId),
        ),
      }),
    );
  }

  return projectCatalog(
    buildSingleRepoRootCatalog({
      repo: {
        id: projectId,
        name: projectId,
        absolutePath: resolveWorktreeCwd(projectId, worktreeId),
      },
      attachments: await readAttachmentsSource(
        getWorktreeAttachmentsDir(projectId, worktreeId),
      ),
    }),
  );
}

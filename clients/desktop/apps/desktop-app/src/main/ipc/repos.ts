import {
  normalizeRepositoryCloneUrl,
  repositoryNameFromCloneUrl,
} from '@canopy/protocol/remote-control/shell';
import { type Dirent } from 'node:fs';
import { mkdir, readdir, rmdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, posix, win32 } from 'node:path';
import {
  IPC_CHANNELS,
  type AddRemoteRepoRequest,
  type BrowseDirResponse,
  type CanopyJsonReadRequest,
  type CanopyJsonReadResponse,
  type GetRemoteUrlRequest,
  type GetRemoteUrlResponse,
  type InitLocalRepoRequest,
  type LinkRemoteRequest,
  type ProbeCloneDestinationRequest,
  type ProbeCloneDestinationResponse,
  type RepoBrowseRequest,
  type RepoSelection,
} from '@canopy/desktop-shared/types';
import {
  addRemoteAndSync,
  getRemoteUrl,
  getRepoName,
  isGitRepo,
} from '../lib/git';
import { getDefaultReposDir } from '../lib/paths';
import { readCanopyJson } from '../lib/canopy-json';
import { remoteUrlsMatch } from '../lib/repo-url-matcher';
import { showOpenDialogForEvent } from '../lib/dialog-window';
import { registerIpcHandler } from './register';
import { reserveUniqueDestination } from '../lib/unique-destination';
import { readRepositoryRemoteUrl } from '../canopy-runtime/worker-git-dispatch';
import { remoteUrlForCaller } from '../canopy-runtime/remote-url-redaction';
import type { WorkerGitDispatcher } from '../canopy-runtime/worker-git-adapter';
import {
  cloneRepositoryThroughWorker,
  initializeRepositoryThroughWorker,
  type WorkerGitRepositoryCreationDispatcher,
} from '../canopy-runtime/worker-git-repository-creation-dispatch';
import type { DesktopIpcCallerResolver } from './file-tree';

function inferRepoNameFromRemote(remoteUrl: string): string {
  return repositoryNameFromCloneUrl(remoteUrl);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isValidRepoName(name: string): boolean {
  return (
    name !== '.' &&
    name !== '..' &&
    name === basename(name) &&
    name === posix.basename(name) &&
    name === win32.basename(name)
  );
}

async function validateAndReturnRepo(repoPath: string): Promise<RepoSelection> {
  const valid = await isGitRepo(repoPath);
  if (!valid) {
    throw new Error('Selected directory is not a git repository');
  }

  const name = await getRepoName(repoPath);
  return { name, path: repoPath };
}

/**
 * Resolves a browsed folder without requiring it to be a git repository.
 * Non-git folders become Cowork workspaces further down the add-workspace
 * flow (see `importWorkspaceFromRepoPath`), so this must not throw the way
 * `validateAndReturnRepo` does for the git-required callers below.
 */
async function resolveBrowsedRepoSelection(
  repoPath: string,
): Promise<RepoSelection> {
  const isRepo = await isGitRepo(repoPath);
  if (!isRepo) {
    return { name: basename(repoPath), path: repoPath };
  }

  const name = await getRepoName(repoPath);
  return { name, path: repoPath };
}

async function getAndEnsureDefaultReposDir(): Promise<string> {
  const defaultReposDir = getDefaultReposDir();
  await mkdir(defaultReposDir, { recursive: true });
  return defaultReposDir;
}

export function registerRepoHandlers(runtime: {
  dispatcher: WorkerGitDispatcher & WorkerGitRepositoryCreationDispatcher;
  resolveCaller: DesktopIpcCallerResolver;
}): void {
  registerIpcHandler(
    IPC_CHANNELS.repoDefaultCloneDir,
    async (): Promise<string> => {
      return getAndEnsureDefaultReposDir();
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.repoListDefaultRepos,
    async (): Promise<RepoSelection[]> => {
      const defaultReposDir = await getAndEnsureDefaultReposDir();

      let entries: Dirent[] = [];
      try {
        entries = await readdir(defaultReposDir, { withFileTypes: true });
      } catch {
        return [];
      }

      const candidates = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => join(defaultReposDir, entry.name));

      const results = await Promise.all(
        candidates.map(async (repoPath): Promise<RepoSelection | null> => {
          try {
            if (!(await isGitRepo(repoPath))) {
              return null;
            }
            const name = await getRepoName(repoPath);
            return { name, path: repoPath };
          } catch {
            return null;
          }
        }),
      );

      return results.filter((entry): entry is RepoSelection => entry !== null);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.repoBrowse,
    async (
      event,
      request?: RepoBrowseRequest,
    ): Promise<RepoSelection | null> => {
      const result = await showOpenDialogForEvent(event, {
        title: 'Select local repository',
        properties: ['openDirectory'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      const selectedPath = result.filePaths[0];
      return request?.allowNonGit
        ? resolveBrowsedRepoSelection(selectedPath)
        : validateAndReturnRepo(selectedPath);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.repoAddLocal,
    async (_event, repoPath: string) => {
      if (!repoPath || !isAbsolute(repoPath)) {
        throw new Error('Repository path must be an absolute path');
      }

      return validateAndReturnRepo(repoPath);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.repoBrowseDir,
    async (event): Promise<BrowseDirResponse> => {
      const defaultReposDir = await getAndEnsureDefaultReposDir();

      const result = await showOpenDialogForEvent(event, {
        title: 'Select clone destination',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: defaultReposDir,
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, directoryPath: null };
      }

      return { canceled: false, directoryPath: result.filePaths[0] };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.repoProbeCloneDestination,
    async (
      _event,
      request: ProbeCloneDestinationRequest,
    ): Promise<ProbeCloneDestinationResponse> => {
      const remoteUrl = normalizeRepositoryCloneUrl(request.remoteUrl);
      if (!remoteUrl) {
        throw new Error('Remote URL is required');
      }

      const destinationDir = request.destinationDir.trim();
      if (!destinationDir || !isAbsolute(destinationDir)) {
        throw new Error('Destination directory must be an absolute path');
      }

      const repoName = inferRepoNameFromRemote(remoteUrl);
      if (!repoName) {
        throw new Error('Unable to determine repository name from URL');
      }

      const candidatePath = join(destinationDir, repoName);
      if (!(await pathExists(candidatePath))) {
        return { repoName, candidateExists: false, reusablePath: null };
      }

      let reusablePath: string | null = null;
      try {
        if (await isGitRepo(candidatePath)) {
          const existingRemote = await getRemoteUrl(candidatePath);
          if (existingRemote && remoteUrlsMatch(existingRemote, remoteUrl)) {
            reusablePath = candidatePath;
          }
        }
      } catch {
        // Treat probe errors as "not reusable" — caller will dedupe.
      }

      return { repoName, candidateExists: true, reusablePath };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.repoAddRemote,
    async (event, request: AddRemoteRepoRequest): Promise<RepoSelection> => {
      const caller = runtime.resolveCaller(event);
      const remoteUrl = normalizeRepositoryCloneUrl(request.remoteUrl);
      if (!remoteUrl) {
        throw new Error('Remote URL is required');
      }

      const destinationDir = request.destinationDir.trim();
      if (!destinationDir || !isAbsolute(destinationDir)) {
        throw new Error('Destination directory must be an absolute path');
      }

      await mkdir(destinationDir, { recursive: true });

      const preferredName = inferRepoNameFromRemote(remoteUrl);
      if (!preferredName) {
        throw new Error('Unable to determine repository name from URL');
      }

      const destinationPath = await reserveUniqueDestination(
        destinationDir,
        preferredName,
      );
      try {
        await cloneRepositoryThroughWorker(
          {
            kind: 'clone',
            url: remoteUrl,
            destination: destinationPath,
            destinationCreatedByRequest: true,
          },
          { dispatcher: runtime.dispatcher, caller },
        );
      } catch (error) {
        // A failed `git clone` empties the directory it was given but keeps it.
        await rmdir(destinationPath).catch(() => undefined);
        throw error;
      }

      return validateAndReturnRepo(destinationPath);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.repoInitLocal,
    async (event, request: InitLocalRepoRequest): Promise<RepoSelection> => {
      const caller = runtime.resolveCaller(event);
      const name = request.name.trim();
      if (!name) {
        throw new Error('Repository name is required');
      }
      if (!isValidRepoName(name)) {
        throw new Error(
          'Repository name must be a single directory name without path separators',
        );
      }

      const baseDir = await getAndEnsureDefaultReposDir();
      const destinationPath = await reserveUniqueDestination(baseDir, name);
      await initializeRepositoryThroughWorker(
        { kind: 'seeded', directory: destinationPath, name },
        { dispatcher: runtime.dispatcher, caller },
      );

      return validateAndReturnRepo(destinationPath);
    },
  );

  // ---- Remote URL (worker.git.remote.get) ----
  registerIpcHandler(
    IPC_CHANNELS.repoGetRemoteUrl,
    async (
      event,
      request: GetRemoteUrlRequest,
    ): Promise<GetRemoteUrlResponse> => {
      const repoPath = request.repoPath.trim();
      if (!repoPath || !isAbsolute(repoPath)) {
        throw new Error('Repository path must be an absolute path');
      }

      const caller = runtime.resolveCaller(event);
      const { remoteUrl } = await readRepositoryRemoteUrl(
        runtime.dispatcher,
        caller,
        repoPath,
      );
      // A paired controller gets the redacted URL (CAN-7017).
      return { remoteUrl: remoteUrlForCaller(caller, remoteUrl) };
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.repoLinkRemote,
    async (_event, request: LinkRemoteRequest): Promise<void> => {
      const repoPath = request.repoPath.trim();
      if (!repoPath || !isAbsolute(repoPath)) {
        throw new Error('Repository path must be an absolute path');
      }

      const remoteUrl = request.remoteUrl.trim();
      if (!remoteUrl) {
        throw new Error('Remote URL is required');
      }

      const existingRemote = await getRemoteUrl(repoPath);
      if (existingRemote) {
        throw new Error('Repository already has an origin remote');
      }

      await addRemoteAndSync(repoPath, remoteUrl);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.canopyJsonRead,
    async (
      _event,
      request: CanopyJsonReadRequest,
    ): Promise<CanopyJsonReadResponse> => {
      const repoPath = request.repoPath.trim();
      if (!repoPath || !isAbsolute(repoPath)) {
        throw new Error('Repository path must be an absolute path');
      }

      return {
        manifest: await readCanopyJson(repoPath),
      };
    },
  );
}

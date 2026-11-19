import { isAbsolute, join } from 'node:path';
import {
  createFileIndexingMatchPolicy,
  createGitReadHost,
  createGitWriteHost,
  type GitReadHost,
  type GitReadSelections,
  type GitWriteHost,
} from '@canopy/core-platform';
import type {
  PlatformOperatingSystem,
  RuntimeHealthCheck,
  RuntimeService,
} from '@canopy/core-runtime';
import {
  createDirectoryReadPreferenceSource,
  createReadOnlyDirectoryInputs,
  type DirectoryReadPreferenceSource,
  type GitIgnoreHostPort,
  type ReadOnlyDirectoryInputs,
} from '@canopy/core-runtime/node';
import {
  GitRepositoryReadError,
  GitRepositoryWriteError,
  type GitRepositoryReader,
  type GitHubCredentialLeasePort,
  type GitRepositoryReadPort,
  type GitRepositoryWritePort,
} from '@canopy/core-runtime/node/git';
import { daemonOwnedChildAddon } from './companion-paths';

export const GIT_READ_SERVICE = 'worker.filesystem.git-read';

export interface DaemonDirectoryInputsOptions {
  readonly os: PlatformOperatingSystem;
  readonly githubLeases?: GitHubCredentialLeasePort;
  readonly canonicalDataRoot: string;
  /**
   * The daemon's own startup environment after claim-marker removal; never a
   * peer's. Selection, the Files Git reads and a repository read without a
   * forwarded environment use it; a `worker.git.*` request's forwarded
   * environment replaces it for that read only (CAN-5496).
   */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Test seam: replaces the Git read host, which is then never created. */
  readonly git?: GitIgnoreHostPort;
  /** With `git`: the repository reads; absent, every read is unavailable. */
  readonly repository?: GitRepositoryReadPort;
  /** Test seam for the host factory. */
  readonly createGitHost?: typeof createGitReadHost;
  /** Test seam for the write host factory. */
  readonly createGitWriteHost?: typeof createGitWriteHost;
}

export interface DaemonDirectoryInputs {
  readonly directoryInputs: ReadOnlyDirectoryInputs;
  /**
   * The same Git read host's repository reads for the `worker.git` module,
   * with the saved Git preference read per request; never a second host.
   */
  readonly git: GitRepositoryReader;
  /**
   * The `worker.git` branch writes, on a write host that runs the Git the
   * read host selects (CAN-4108); unavailable with a test port.
   */
  readonly writes: GitRepositoryWritePort;
  /** The Git hosts' worker-plane lifecycle; empty with a test port. */
  readonly services: readonly RuntimeService[];
  /**
   * Stops the Git write host, letting started commands end, then the read
   * host, unless phase 5 already did, and shares that one stop; a startup
   * that never reached phase 5 still ends every Git child.
   */
  readonly close: (
    signal: AbortSignal,
  ) => Promise<'stopped' | 'cleanup_unconfirmed'>;
  /** The Gits the host ran `check-ignore` with; none with a test port. */
  readonly gitSelections: () => GitReadSelections;
  /**
   * The Git a worker-owned process runs, as the write host selects it
   * (CAN-5089); `git` on the PATH with a test port.
   */
  readonly selectGitExecutable: (signal: AbortSignal) => Promise<string>;
}

const NO_SELECTIONS: GitReadSelections = Object.freeze({
  selections: Object.freeze([]),
  overflow: false,
});

const UNAVAILABLE_WRITES: GitRepositoryWritePort = Object.freeze({
  run: () => Promise.reject(new GitRepositoryWriteError('git_unavailable')),
});

const UNAVAILABLE_REPOSITORY: GitRepositoryReadPort = Object.freeze({
  readRepository: () =>
    Promise.reject(new GitRepositoryReadError('git_unavailable')),
  selectExecutable: () =>
    Promise.reject(new GitRepositoryReadError('git_unavailable')),
});

function repositoryReader(
  port: GitRepositoryReadPort,
  preferences: DirectoryReadPreferenceSource,
): GitRepositoryReader {
  const readSavedExecutablePath = async (
    signal: AbortSignal,
  ): Promise<string> =>
    (await preferences.read(signal)).preferences.gitExecutablePath;
  const reader: GitRepositoryReader = {
    read: (read, cwd, { signal, environment }) =>
      port.readRepository({
        cwd,
        read,
        readSavedExecutablePath,
        signal,
        ...(environment === undefined ? {} : { environment }),
      }),
    selectExecutable: ({ recheck, signal }) =>
      port.selectExecutable({ readSavedExecutablePath, recheck, signal }),
  };
  return Object.freeze(reader);
}

/**
 * Starts the login-PATH prewarm and, in phase 5, waits for started branch
 * writes, then stops every Git read child.
 */
function gitReadService(
  host: GitReadHost,
  stop: DaemonDirectoryInputs['close'],
  unconfirmed: () => boolean,
): RuntimeService {
  return {
    name: GIT_READ_SERVICE,
    plane: 'worker',
    start: (): void => host.prewarm(),
    health: (): RuntimeHealthCheck =>
      unconfirmed()
        ? {
            name: GIT_READ_SERVICE,
            status: 'warn',
            message: 'Git read cleanup is unconfirmed.',
          }
        : { name: GIT_READ_SERVICE, status: 'pass', message: null },
    stop: {
      5: async (signal): Promise<void> => {
        if ((await stop(signal)) !== 'stopped')
          throw new Error('Git read processes did not stop.');
      },
    },
  };
}

/**
 * Directory-read policy inputs over the canonical data root: preferences and
 * matching rules are reread per request, and Git ignore checks run on the
 * all-OS read-only host.
 */
export function createDaemonDirectoryInputs(
  options: DaemonDirectoryInputsOptions,
): DaemonDirectoryInputs {
  const { os, canonicalDataRoot } = options;
  const preferences = createDirectoryReadPreferenceSource({
    canonicalDataRoot,
    paths: { join, isAbsolute },
  });
  const inputs = (git: GitIgnoreHostPort): ReadOnlyDirectoryInputs =>
    createReadOnlyDirectoryInputs({
      preferences,
      matchPolicy: createFileIndexingMatchPolicy(os),
      git,
    });
  if (options.git)
    return {
      directoryInputs: inputs(options.git),
      git: repositoryReader(
        options.repository ?? UNAVAILABLE_REPOSITORY,
        preferences,
      ),
      writes: UNAVAILABLE_WRITES,
      services: [],
      close: () => Promise.resolve('stopped'),
      gitSelections: () => NO_SELECTIONS,
      selectGitExecutable: () => Promise.resolve('git'),
    };
  let unconfirmed = false;
  const host = (options.createGitHost ?? createGitReadHost)({
    os,
    nativePath: daemonOwnedChildAddon(os),
    environment: options.environment,
    probeDirectory: canonicalDataRoot,
    onCleanupReport: () => {
      unconfirmed = true;
    },
  });
  const readSavedExecutablePath = async (
    signal: AbortSignal,
  ): Promise<string> =>
    (await preferences.read(signal)).preferences.gitExecutablePath;
  const writeHost = (options.createGitWriteHost ?? createGitWriteHost)({
    os,
    githubLeases: options.githubLeases,
    environment: options.environment,
    selectExecutable: (signal) =>
      host.selectWriteExecutable(readSavedExecutablePath, signal),
  });
  let writesStopping: ReturnType<GitWriteHost['stop']> | undefined;
  const closeWrites = async (
    signal: AbortSignal,
  ): Promise<'stopped' | 'cleanup_unconfirmed'> =>
    (await (writesStopping ??= writeHost.stop(signal))).state;
  // A second host.stop rejects, so phase 5 and close share the first.
  let stopping: ReturnType<GitReadHost['stop']> | undefined;
  const close = async (
    signal: AbortSignal,
  ): Promise<'stopped' | 'cleanup_unconfirmed'> => {
    // Writes select through the read host, so they end first.
    const writes = await closeWrites(signal);
    const reads = (await (stopping ??= host.stop(signal))).state;
    return writes === 'stopped' && reads === 'stopped'
      ? 'stopped'
      : 'cleanup_unconfirmed';
  };
  return {
    directoryInputs: inputs(host.port),
    git: repositoryReader(host.repository, preferences),
    writes: writeHost.port,
    // One phase-5 stop: started writes end, none killed (Q11), then reads.
    services: [gitReadService(host, close, () => unconfirmed)],
    close,
    gitSelections: () => host.selections(),
    selectGitExecutable: (signal) =>
      host.selectWriteExecutable(readSavedExecutablePath, signal),
  };
}

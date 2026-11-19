import type {
  DirectoryReadOptions,
  GitIgnoreReadPort,
} from './directory-reader';
import type {
  DirectoryReadPreferenceSnapshot,
  DirectoryReadPreferenceSource,
} from './directory-read-preferences';
import {
  buildFileExplorerGlobMatcher,
  buildFileGlobMatcher,
  type FileIndexingMatchPolicy,
} from './file-indexing';
import type {
  FilesystemSearchInputs,
  FilesystemSearchPurpose,
} from './file-search';

export type GitIgnoreHostFailureCode =
  | 'git_unavailable'
  | 'selection_rejected'
  | 'invalid_request'
  | 'environment_invalid'
  | 'unsupported_command'
  | 'timeout'
  | 'deadline_exceeded'
  | 'output_limit'
  | 'exit_status'
  | 'cleanup_unconfirmed'
  | 'stopped';

const GIT_IGNORE_HOST_FAILURE_MESSAGES: Record<
  GitIgnoreHostFailureCode,
  string
> = {
  git_unavailable: 'Git is unavailable.',
  selection_rejected: 'The selected Git executable cannot be accessed.',
  invalid_request: 'The Git ignore request was rejected.',
  environment_invalid: 'The Git host environment is invalid.',
  unsupported_command: 'The Git command is not supported.',
  timeout: 'Git timed out.',
  deadline_exceeded: 'The Git ignore request deadline was exceeded.',
  output_limit: 'Git output exceeded its limit.',
  exit_status: 'Git exited with an unexpected status.',
  cleanup_unconfirmed: 'Git process cleanup could not be confirmed.',
  stopped: 'The Git host stopped.',
};

/** Fixed, value-free text: hosts must not leak paths or Git output here. */
export class GitIgnoreHostError extends Error {
  readonly code: GitIgnoreHostFailureCode;

  constructor(code: GitIgnoreHostFailureCode) {
    super(GIT_IGNORE_HOST_FAILURE_MESSAGES[code]);
    this.name = 'GitIgnoreHostError';
    this.code = code;
  }
}

export interface GitIgnoreCheckRequest {
  /** Trusted catalog root; the check-ignore working directory. */
  readonly root: string;
  readonly relativePaths: readonly string[];
  /** P2 value, untrimmed; called once before each chunk that needs selection. */
  readonly readSavedExecutablePath: (signal: AbortSignal) => Promise<string>;
  /** An aborted request rejects with `signal.reason`, never with a code. */
  readonly signal: AbortSignal;
}

export interface GitIgnoredListingRequest {
  /** Trusted catalog root; the `ls-files` working directory. */
  readonly root: string;
  /** P2 value, untrimmed; called once before the listing selects a Git. */
  readonly readSavedExecutablePath: (signal: AbortSignal) => Promise<string>;
  /** An aborted request rejects with `signal.reason`, never with a code. */
  readonly signal: AbortSignal;
}

export interface GitIgnoreHostPort {
  checkIgnoredPaths(
    this: void,
    request: GitIgnoreCheckRequest,
  ): Promise<Set<string>>;
  /**
   * Ignored untracked paths under `root`, one entry per wholly ignored
   * directory (ending in `/`), as `git ls-files --others --ignored
   * --exclude-standard --directory -z` lists them.
   */
  listIgnoredPathEntries(
    this: void,
    request: GitIgnoredListingRequest,
  ): Promise<string[]>;
}

type ReadOnlyDirectoryReadOptions = DirectoryReadOptions & {
  readonly gitIgnore: GitIgnoreReadPort;
};

export interface ReadOnlyDirectoryInputs {
  readOptions(
    this: void,
    signal: AbortSignal,
  ): Promise<ReadOnlyDirectoryReadOptions>;
  /**
   * One new search walk's inputs from a single preference read: the
   * purpose's matcher and the Git ignored-path listing.
   */
  searchOptions(
    this: void,
    signal: AbortSignal,
    purpose: FilesystemSearchPurpose,
  ): Promise<FilesystemSearchInputs>;
}

export interface ReadOnlyDirectoryInputsOptions {
  readonly preferences: DirectoryReadPreferenceSource;
  readonly matchPolicy: FileIndexingMatchPolicy;
  readonly git: GitIgnoreHostPort;
}

/**
 * Composes one directory request's inputs from a single preference read.
 * `readBoundary` stays unset; a host listing sealed trees supplies its own.
 */
export function createReadOnlyDirectoryInputs(
  options: ReadOnlyDirectoryInputsOptions,
): ReadOnlyDirectoryInputs {
  const { preferences, matchPolicy, git } = options;
  /**
   * The saved Git path for one request's selections. The first reuses the
   * request's snapshot; later ones reread so an edit mid-request reaches the
   * next selection.
   */
  const savedExecutablePath = (
    signal: AbortSignal,
    snapshot: DirectoryReadPreferenceSnapshot,
  ): ((readSignal: AbortSignal) => Promise<string>) => {
    let snapshotPathUsed = false;
    return async (readSignal) => {
      signal.throwIfAborted();
      readSignal.throwIfAborted();
      if (!snapshotPathUsed) {
        snapshotPathUsed = true;
        return snapshot.preferences.gitExecutablePath;
      }
      // Either signal cancels the read, so a request abort stops it even when
      // the host's selection signal is not derived from the request. Both
      // outcomes recheck the request first: the combined signal's reason is
      // whichever aborted first, which would break that precedence.
      let fresh: DirectoryReadPreferenceSnapshot;
      try {
        fresh = await preferences.read(
          readSignal === signal
            ? signal
            : AbortSignal.any([signal, readSignal]),
        );
      } catch (error) {
        signal.throwIfAborted();
        readSignal.throwIfAborted();
        throw error;
      }
      signal.throwIfAborted();
      readSignal.throwIfAborted();
      return fresh.preferences.gitExecutablePath;
    };
  };
  return {
    async readOptions(signal): Promise<ReadOnlyDirectoryReadOptions> {
      const snapshot = await preferences.read(signal);
      signal.throwIfAborted();
      const matchingRules = buildFileGlobMatcher(
        snapshot.preferences.fileIndexing,
        matchPolicy,
      );
      const readSavedExecutablePath = savedExecutablePath(signal, snapshot);

      // The engine turns any port rejection into the default ignore list, so
      // this abort does not reach the listing caller. The host directory handler
      // must recheck its signal after listing (CAN-4304).
      const gitIgnore: GitIgnoreReadPort = {
        async checkIgnoredPaths(root, relativePaths) {
          signal.throwIfAborted();
          let ignored: Set<string>;
          try {
            ignored = await git.checkIgnoredPaths({
              root,
              relativePaths,
              readSavedExecutablePath,
              signal,
            });
          } catch (error) {
            // A host failure that races an abort reports the abort reason.
            signal.throwIfAborted();
            throw error;
          }
          signal.throwIfAborted();
          return ignored;
        },
      };

      return { matchingRules, gitIgnore };
    },
    async searchOptions(signal, purpose): Promise<FilesystemSearchInputs> {
      const snapshot = await preferences.read(signal);
      signal.throwIfAborted();
      const readSavedExecutablePath = savedExecutablePath(signal, snapshot);
      return {
        matcher:
          purpose === 'file-explorer'
            ? buildFileExplorerGlobMatcher(matchPolicy)
            : buildFileGlobMatcher(
                snapshot.preferences.fileIndexing,
                matchPolicy,
              ),
        policy: matchPolicy,
        // A rejection falls back to the default ignore list, so the host
        // handler rechecks its signal after the search, as for directory reads.
        listIgnoredPathEntries: async (root): Promise<string[]> => {
          signal.throwIfAborted();
          let entries: string[];
          try {
            entries = await git.listIgnoredPathEntries({
              root,
              readSavedExecutablePath,
              signal,
            });
          } catch (error) {
            // A host failure that races an abort reports the abort reason.
            signal.throwIfAborted();
            throw error;
          }
          signal.throwIfAborted();
          return entries;
        },
      };
    },
  };
}

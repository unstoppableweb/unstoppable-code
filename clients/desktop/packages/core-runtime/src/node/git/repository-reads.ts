import type { GitIgnoreHostFailureCode } from '../filesystem/read-only-directory-inputs';
import type { GitChangeSetRead } from './change-set';

/** The conventional default branches, checked in this order. */
export const GIT_CONVENTIONAL_DEFAULT_BRANCHES = [
  'main',
  'master',
  'develop',
] as const;

export type GitConventionalDefaultBranch =
  (typeof GIT_CONVENTIONAL_DEFAULT_BRANCHES)[number];

/**
 * The fixed repository reads the `worker.git.*` queries run through a
 * read-only Git host. Each names one command; nothing else is expressible.
 */
export type GitRepositoryRead =
  /** `rev-parse --verify --quiet HEAD^{commit}`; never infer unborn from rejection. */
  | { readonly kind: 'head-commit' }
  /** {@link GIT_BRANCH_LIST_REF_ARGS} */
  | { readonly kind: 'branch-refs' }
  /** `rev-parse --git-common-dir` */
  | { readonly kind: 'common-dir' }
  /** `worktree list --porcelain` */
  | { readonly kind: 'worktree-list' }
  /** `remote get-url origin` */
  | { readonly kind: 'origin-url' }
  /** `remote` */
  | { readonly kind: 'remote-names' }
  /** `rev-parse --git-dir` */
  | { readonly kind: 'git-dir' }
  /** `ls-remote --symref origin HEAD`, which contacts the remote */
  | { readonly kind: 'remote-head' }
  /** `symbolic-ref refs/remotes/origin/HEAD` */
  | { readonly kind: 'origin-head' }
  /** `rev-parse --verify refs/remotes/origin/<branch>` */
  | {
      readonly kind: 'origin-branch';
      readonly branch: GitConventionalDefaultBranch;
    }
  /** `rev-parse --is-inside-work-tree` */
  | { readonly kind: 'inside-work-tree' }
  /**
   * The `worker.git.diff.get` change-set reads: the first repository reads
   * that take arguments, which are only `HEAD` and object ids.
   */
  | GitChangeSetRead;

export interface GitRepositoryReadRequest {
  /** Trusted absolute directory the command runs in. */
  readonly cwd: string;
  readonly read: GitRepositoryRead;
  /** The saved Git preference, untrimmed; read when selection needs it. */
  readonly readSavedExecutablePath: (signal: AbortSignal) => Promise<string>;
  /** An aborted request rejects with `signal.reason`, never with a code. */
  readonly signal: AbortSignal;
  /**
   * The complete environment the command runs with, in place of the host's
   * own; absent, the host's startup snapshot. The non-interactive switches
   * still apply. Used for this request only; never retained or reported.
   */
  readonly environment?: GitChildEnvironment;
}

/** A forwarded child environment (CAN-5496), never merged with the host's. */
export type GitChildEnvironment = Readonly<Record<string, string>>;

/** One repository read's per-request inputs, as the `worker.git.*` hosts pass them. */
export interface GitRepositoryReadInvocation {
  readonly signal: AbortSignal;
  /** The request's forwarded environment; undefined keeps the host's snapshot. */
  readonly environment: GitChildEnvironment | undefined;
}

const GIT_REPOSITORY_READ_FAILURE_MESSAGES: Record<
  GitIgnoreHostFailureCode,
  string
> = {
  git_unavailable: 'Git is unavailable.',
  selection_rejected: 'The selected Git executable cannot be accessed.',
  invalid_request: 'The Git repository read was rejected.',
  environment_invalid: 'The Git host environment is invalid.',
  unsupported_command: 'The Git command is not supported on this host.',
  timeout: 'Git timed out.',
  deadline_exceeded: 'The Git repository read deadline was exceeded.',
  output_limit: 'Git output exceeded its limit.',
  exit_status: 'Git exited with an unexpected status.',
  cleanup_unconfirmed: 'Git process cleanup could not be confirmed.',
  stopped: 'The Git host stopped.',
};

/** Fixed, value-free text: no paths, arguments or Git output. */
export class GitRepositoryReadError extends Error {
  readonly code: GitIgnoreHostFailureCode;
  /** `exit_status` only: Git's exit code, `null` when a signal ended it. */
  readonly exitCode: number | null | undefined;

  constructor(
    code: GitIgnoreHostFailureCode,
    detail: { readonly exitCode?: number | null } = {},
  ) {
    super(GIT_REPOSITORY_READ_FAILURE_MESSAGES[code]);
    this.name = 'GitRepositoryReadError';
    this.code = code;
    this.exitCode = code === 'exit_status' ? detail.exitCode : undefined;
  }
}

/** How a read-only host's selection chose the Git it would run. */
export type GitExecutableSelectionOrigin =
  /** The saved preference. */
  | 'saved'
  /** The startup environment's `CANOPY_GIT_EXECUTABLE`. */
  | 'override'
  /** Linux x64/arm64: the earlier discovery, revalidated. */
  | 'discovery-cache'
  /** Linux x64/arm64: a login-PATH candidate. */
  | 'login-path'
  /** Linux x64/arm64: the standard system location. */
  | 'system'
  /** macOS and Windows: a discovered candidate. */
  | 'discovered'
  /** Platforms that do not require Git: run unvalidated. */
  | 'unvalidated';

/** What a read-only host's selection reports; its path stays on the host. */
export type GitExecutableSelectionFacts = (
  | {
      readonly ready: true;
      /** The `git version …` text validation parsed; null when unvalidated. */
      readonly version: string | null;
      readonly origin: GitExecutableSelectionOrigin;
      /** An override is set (`unvalidated` reports run it, else `git`). */
      readonly override: boolean;
    }
  | {
      readonly ready: false;
      readonly code: GitIgnoreHostFailureCode;
      /** The failure is the explicit choice's (Linux x64/arm64's saved or override). */
      readonly explicit: boolean;
    }
) & {
  /** Windows discovery fact; absent on hosts that do not probe winget. */
  readonly wingetAvailable?: boolean;
};

export interface GitExecutableSelectionRequest {
  readonly readSavedExecutablePath: (signal: AbortSignal) => Promise<string>;
  /** Skips the fast path that keeps an unchanged earlier selection. */
  readonly recheck: boolean;
  readonly signal: AbortSignal;
}

/**
 * Read-only Git repository reads and executable selection, as a host that
 * runs no other Git command and writes no Canopy store provides them.
 */
export interface GitRepositoryReadPort {
  /** Stdout of a command that exited 0; any other outcome rejects. */
  readRepository(
    this: void,
    request: GitRepositoryReadRequest,
  ): Promise<string>;
  /** The selection a repository read would use, without running it. */
  selectExecutable(
    this: void,
    request: GitExecutableSelectionRequest,
  ): Promise<GitExecutableSelectionFacts>;
}

/**
 * A {@link GitRepositoryReadPort} with the saved-preference read bound, as
 * the `worker.git.*` hosts call it.
 */
export interface GitRepositoryReader {
  read(
    this: void,
    read: GitRepositoryRead,
    cwd: string,
    invocation: GitRepositoryReadInvocation,
  ): Promise<string>;
  selectExecutable(
    this: void,
    request: { readonly recheck: boolean; readonly signal: AbortSignal },
  ): Promise<GitExecutableSelectionFacts>;
}

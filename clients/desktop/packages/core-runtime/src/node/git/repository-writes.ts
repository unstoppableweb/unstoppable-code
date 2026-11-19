import { CanopyOperationError } from '../../runtime/errors';
import type { GitChildEnvironment } from './repository-reads';

/**
 * The fixed commands the `worker.git` mutations run through a Git write host,
 * beyond the read host's repository reads. Each names one command; nothing
 * else is expressible. Values are branch names, start points, object IDs,
 * commit messages and a host-local credential audience key, never argv.
 * Merge-worktree paths come only from trusted host resolution.
 */
export type GitRepositoryWrite =
  /** `status --porcelain --untracked-files=normal` */
  | { readonly kind: 'status' }
  /** `show-ref --verify --quiet refs/heads/<branch>` */
  | { readonly kind: 'local-branch'; readonly branch: string }
  /** `show-ref --verify --quiet refs/remotes/origin/<branch>` */
  | { readonly kind: 'remote-branch'; readonly branch: string }
  | {
      readonly kind: 'catalog-branch-tip';
      readonly branch: string;
      readonly remote: boolean;
    }
  | { readonly kind: 'branch-tracking-config' }
  /**
   * `fetch --no-tags origin refs/heads/<branch>:refs/remotes/origin/<branch>`,
   * non-interactive and bounded at 10 seconds, which contacts `origin`.
   */
  | { readonly kind: 'fetch-origin-branch'; readonly branch: string }
  /** `check-ref-format --branch <name>` */
  | { readonly kind: 'check-branch-name'; readonly name: string }
  /** `for-each-ref --format=%(refname) refs/heads/<name>/` */
  | { readonly kind: 'local-branches-under'; readonly name: string }
  /** `rev-parse --abbrev-ref HEAD` */
  | { readonly kind: 'current-branch' }
  /** `symbolic-ref --quiet HEAD` */
  | { readonly kind: 'symbolic-head' }
  /** Effect: `checkout <branch>`; never killed once started. */
  | { readonly kind: 'checkout'; readonly branch: string }
  /** Effect: `checkout -b <name> <startPoint>`; never killed once started. */
  | {
      readonly kind: 'checkout-new-branch' | 'prepare-new-branch';
      readonly name: string;
      readonly startPoint: string;
    }
  /** Effect: `branch -m <name>`; never killed once started. */
  | { readonly kind: 'rename-current-branch'; readonly name: string }
  /** Effect: `branch -d <branch>`; never killed once started. */
  | { readonly kind: 'delete-branch'; readonly branch: string }
  /** Effect: `branch -D <branch>`; never killed once started. */
  | { readonly kind: 'force-delete-branch'; readonly branch: string }
  /**
   * Effect: `update-ref -d refs/heads/<branch> <tip>`, `tip` a full object
   * ID; never killed once started.
   */
  | {
      readonly kind: 'delete-branch-ref';
      readonly branch: string;
      readonly tip: string;
    }
  | GitRepositorySyncWrite
  | { readonly kind: 'head-sha' }
  | { readonly kind: 'tracking-head-sha'; readonly branch: string }
  | { readonly kind: 'stage-all' }
  | { readonly kind: 'commit-message'; readonly message: string }
  /**
   * Pushes exactly `headSha` to `branch` on origin, never whatever HEAD is
   * by then (CAN-6869). The key binds the daemon's recipient lease to this
   * dispatch.
   */
  | {
      readonly kind: 'push-head';
      readonly key: string;
      readonly branch: string;
      readonly headSha: string;
    }
  /** Tracks `origin/<branch>` from the local branch after its push. */
  | { readonly kind: 'set-upstream'; readonly branch: string }
  | GitRepositoryMergeWrite
  | {
      readonly kind: 'worktree-add';
      readonly path: string;
      readonly branch: string;
      readonly create: boolean;
      readonly startPoint: string | null;
    }
  | { readonly kind: 'worktree-remove'; readonly path: string }
  | { readonly kind: 'worktree-prune' };

/**
 * The fixed commands `worker.git.fetch` and `worker.git.pull` run (CAN-5517).
 * None is bounded or killed once started.
 */
export type GitRepositorySyncWrite =
  /** `fetch --prune origin`, or `fetch origin`; contacts `origin`. */
  | { readonly kind: 'fetch-origin'; readonly prune: boolean }
  /** Effect: `pull --ff-only origin <branch>`; contacts `origin`. */
  | { readonly kind: 'pull-fast-forward'; readonly branch: string }
  /** Effect: `pull --rebase --autostash origin <branch>`; contacts `origin`. */
  | { readonly kind: 'pull-rebase'; readonly branch: string }
  /** `rev-parse --git-path <name>`, for a rebase's state directory. */
  | {
      readonly kind: 'rebase-state-path';
      readonly name: 'rebase-merge' | 'rebase-apply';
    }
  /** `stash list` */
  | { readonly kind: 'stash-list' }
  /** `status --porcelain=v1` */
  | { readonly kind: 'porcelain-status' };

/**
 * Why a Git write exited non-zero, classified on the write host from Git's
 * own output (CAN-7113). Git's text never leaves the host; only this does.
 */
export type GitRepositoryWriteFailureReason =
  | 'authFailed'
  | 'nonFastForward'
  | 'hookRejected'
  | 'nothingToCommit'
  | 'gpgFailed'
  | 'other';

/** A command that ran to its end; its exit status is the caller's to judge. */
export interface GitRepositoryWriteOutput {
  readonly exitCode: number;
  /** Untrimmed. */
  readonly stdout: string;
  /** A non-zero exit only: why Git failed. */
  readonly failure?: GitRepositoryWriteFailureReason;
}

/**
 * The value-free facts a failure carries: the classified `gitFailure` and Git's
 * exit code, an allowlisted signal name, or a spawn's allowlisted errno.
 */
type GitRepositoryWriteFailureDetails = {
  readonly gitFailure?: GitRepositoryWriteFailureReason;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly errno?: string;
  readonly stage?: 'spawn';
};

export type GitRepositoryWriteFailureCode =
  | 'git_unavailable'
  | 'invalid_request'
  | 'unsupported_command'
  | 'timeout'
  | 'exit_status'
  | 'stopped';

const GIT_REPOSITORY_WRITE_FAILURE_MESSAGES: Record<
  GitRepositoryWriteFailureCode,
  string
> = {
  git_unavailable: 'Git is unavailable.',
  invalid_request: 'The Git command was rejected.',
  unsupported_command: 'The Git command is not supported on this host.',
  timeout: 'Git timed out.',
  exit_status: 'Git exited with an unexpected status.',
  stopped: 'The Git host stopped.',
};

/** Fixed, value-free text: no paths, arguments or Git output. */
export class GitRepositoryWriteError extends Error {
  readonly code: GitRepositoryWriteFailureCode;
  readonly details: GitRepositoryWriteFailureDetails | undefined;

  constructor(
    code: GitRepositoryWriteFailureCode,
    details?: GitRepositoryWriteFailureDetails,
  ) {
    super(GIT_REPOSITORY_WRITE_FAILURE_MESSAGES[code]);
    this.name = 'GitRepositoryWriteError';
    this.code = code;
    this.details = details;
  }
}

/** The `exit_status` failure of a command that ran and exited non-zero. */
export function gitWriteExitError(
  output: GitRepositoryWriteOutput,
): GitRepositoryWriteError {
  return new GitRepositoryWriteError('exit_status', {
    gitFailure: output.failure ?? 'other',
    exitCode: output.exitCode,
  });
}

/** A write-host failure's value-free details, as an error payload field. */
export function gitWriteDetailsOf(error: unknown): {
  readonly details?: GitRepositoryWriteFailureDetails;
} {
  return error instanceof GitRepositoryWriteError && error.details
    ? { details: { ...error.details } }
    : {};
}

/**
 * A write-host failure with details as the `internal` answer the dispatcher
 * gave it before, now carrying those value-free details; anything else is
 * returned unchanged. The host error stays the runtime cause, so in-process
 * projections still rethrow it.
 */
export function gitWriteOperationError(error: unknown): unknown {
  const { details } = gitWriteDetailsOf(error);
  if (details === undefined) return error;
  return new CanopyOperationError(
    {
      kind: 'internal',
      message: 'The operation failed.',
      details,
      retry: { kind: 'never' },
    },
    error,
  );
}

/**
 * Runs one {@link GitRepositoryWrite} in a trusted absolute directory. It
 * takes no signal: a started command runs to its end, and only the bounded
 * fetch is stopped at its timeout. `environment` is the request's forwarded
 * child environment (CAN-5496), used in place of the host's own for this
 * command only; undefined keeps the host's startup snapshot. Rejects with a
 * {@link GitRepositoryWriteError} when the command cannot run.
 */
export interface GitRepositoryWritePort {
  run(
    this: void,
    write: GitRepositoryWrite,
    cwd: string,
    environment?: GitChildEnvironment,
  ): Promise<GitRepositoryWriteOutput>;
}

/** CAN-5884: fixed local-base merge commands; all run without a signal or timeout. */
export type GitRepositoryMergeWrite =
  | { readonly kind: 'merge-worktree-list' }
  | {
      readonly kind: 'merge-worktree-add';
      readonly path: string;
      readonly branch: string;
    }
  | { readonly kind: 'merge-worktree-remove'; readonly path: string }
  | { readonly kind: 'merge-local'; readonly branch: string }
  | { readonly kind: 'merge-abort' }
  | { readonly kind: 'merge-head' };

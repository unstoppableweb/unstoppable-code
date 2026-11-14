import type { WorkerGitBranchCreateResult } from '@canopy/protocol/canopy-core';
import { worktreeSourceFailure } from './head-state';
import {
  occupiedGitWorktreeBranches,
  parseGitWorktreeListPorcelain,
} from './branch-list';

/**
 * The Git reads and effects one checkout's branch checkout and creation run,
 * each named by the command the desktop runs for it. Hosts supply their own
 * runners and environments; the effects are never aborted once started. Any
 * member may reject with {@link GitBranchWriteInterrupted}, which the policy
 * never reads as an answer.
 */
export interface GitBranchWritePort {
  readonly signal?: AbortSignal;
  readTrackingConfig(this: void): Promise<string>;
  /** `status --porcelain --untracked-files=normal` printed anything. */
  hasUncommittedChanges(this: void): Promise<boolean>;
  /**
   * `worktree list --porcelain` in the main repository root. Any rejection
   * other than {@link GitBranchWriteInterrupted} reads as no occupied branch.
   */
  readWorktreeList(
    this: void,
  ): Promise<{ output: string; checkoutPath: string }>;
  /** `show-ref --verify --quiet refs/heads/<branch>` exited 0. */
  localBranchExists(this: void, branch: string): Promise<boolean>;
  /** `show-ref --verify --quiet refs/remotes/origin/<branch>` exited 0. */
  remoteBranchExists(this: void, branch: string): Promise<boolean>;
  /**
   * `fetch --no-tags origin refs/heads/<branch>:refs/remotes/origin/<branch>`,
   * non-interactive and bounded; rejects when Git fails.
   */
  fetchRemoteBranch(this: void, branch: string): Promise<void>;
  /** `check-ref-format --branch <name>` exited 0. */
  isValidBranchName(this: void, name: string): Promise<boolean>;
  /** Stdout of `for-each-ref --format=%(refname) refs/heads/<name>/`. */
  listLocalBranchesUnder(this: void, name: string): Promise<string>;
  /** `rev-parse --abbrev-ref HEAD`. */
  currentBranch(this: void): Promise<string>;
  /** Exact symbolic HEAD, or null when detached. */
  readHeadRef(this: void): Promise<string | null>;
  /** Attach to an existing local branch by its literal branch name. */
  checkout(
    this: void,
    branch: string,
    continuingCreation?: true,
  ): Promise<void>;
  /** Exact branch ref lookup with no revision fallback. */
  resolveCatalogBranch(
    this: void,
    branch: string,
    remote: boolean,
  ): Promise<string | undefined>;
  /** Effect: `checkout -b <name> <startPoint>`. */
  checkoutNewBranch(
    this: void,
    name: string,
    startPoint: string,
  ): Promise<void>;
  createBranch(this: void, name: string, startPoint: string): Promise<void>;
  /** Effect: `branch -m <name>`, renaming the current branch. */
  renameCurrentBranch(this: void, name: string): Promise<void>;
}

function trackingValues(config: readonly string[], key: string): string[] {
  const prefix = `${key}\n`;
  return config
    .filter((entry) => entry === key || entry.startsWith(prefix))
    .map((entry) => (entry === key ? 'true' : entry.slice(prefix.length)));
}

export class GitCheckoutCreationError extends Error {
  constructor(
    readonly branch: string,
    readonly branchExists: boolean | undefined,
    message: string,
    cause: unknown,
  ) {
    super(message);
    Object.assign(this, { cause });
  }
}

interface GitCreationReads {
  readHeadRef(): Promise<string | null>;
  branchExists(): Promise<boolean>;
  readBranchTip?(): Promise<string | undefined>;
  readSourceTip?(): Promise<string | undefined>;
  readTrackingConfig(): Promise<string>;
  worktreeExists?: () => Promise<boolean>;
}

/** A failed creation may have changed Git state. Read it before answering. */
export async function createAndVerifyGitCheckout(
  reads: GitCreationReads,
  input: {
    branch: string;
    expectedTip?: string;
    signal?: AbortSignal;
    create: () => Promise<void>;
    checkout?: () => Promise<void>;
  },
): Promise<WorkerGitBranchCreateResult> {
  const { branch, expectedTip, signal, create, checkout } = input;
  // With no pinned tip, create is the combined checkout -b command.
  let checkoutStarted = expectedTip === undefined;
  let failure: { error: unknown } | undefined;
  if (signal?.aborted)
    throw new GitBranchWriteInterrupted(
      'cancelled',
      'The operation was cancelled.',
      signal.reason,
    );
  try {
    await create();
    if (checkout) {
      if ((await reads.readBranchTip?.()) !== expectedTip)
        throw new Error('Branch tip changed during setup.');
      if (!(await reads.readSourceTip?.()))
        throw new Error('The selected base ref disappeared during setup.');
      checkoutStarted = true;
      await checkout();
    }
  } catch (error) {
    failure = { error };
  }

  // A hook can advance an attached branch. The pin guards preparation and
  // hook-disabled worktree add, while a switch is verified by symbolic HEAD.
  const checkPinnedTip = expectedTip !== undefined && !checkoutStarted;
  const [head, tip, config, worktree, source] = await Promise.allSettled([
    reads.readHeadRef(),
    checkPinnedTip ? reads.readBranchTip?.() : undefined,
    reads.readTrackingConfig(),
    reads.worktreeExists?.(),
    checkPinnedTip ? reads.readSourceTip?.() : undefined,
  ]);
  const fields =
    config.status === 'fulfilled' ? config.value.split('\0') : null;
  const remote = fields
    ? trackingValues(fields, `branch.${branch}.remote`)
    : [];
  const merge = fields ? trackingValues(fields, `branch.${branch}.merge`) : [];
  const upstream =
    remote.length && merge.length
      ? 'configured'
      : remote.length || merge.length
        ? 'partial'
        : 'unset';
  const complete =
    head.status === 'fulfilled' &&
    head.value === `refs/heads/${branch}` &&
    (!checkPinnedTip ||
      (tip.status === 'fulfilled' &&
        tip.value === expectedTip &&
        source.status === 'fulfilled' &&
        source.value !== undefined &&
        fields !== null)) &&
    worktree.status === 'fulfilled' &&
    (!reads.worktreeExists || worktree.value === true);
  if (complete && !failure) return { branch };
  if (complete && checkoutStarted && fields !== null) {
    return { branch, warning: { code: 'checkout-command-failed', upstream } };
  }

  const branchExists = await reads.branchExists().catch(() => undefined);
  if (
    failure &&
    (worktreeSourceFailure(failure.error) ||
      (expectedTip === undefined && branchExists === false))
  )
    throw failure.error;
  const headStatus =
    worktree.status === 'fulfilled' && worktree.value === false
      ? 'HEAD is unavailable.'
      : head.status === 'rejected'
        ? 'HEAD could not be checked.'
        : head.value === null
          ? 'HEAD is detached.'
          : `HEAD is on "${head.value.replace(/^refs\/heads\//, '')}".`;
  const branchStatus =
    branchExists === undefined
      ? 'Branch could not be checked.'
      : branchExists
        ? 'Branch exists.'
        : 'Branch does not exist.';
  const upstreamStatus =
    fields === null
      ? 'Upstream could not be checked.'
      : `Upstream is ${upstream}.`;
  const worktreeStatus =
    worktree.status === 'rejected'
      ? 'Worktree could not be checked.'
      : worktree.value === true
        ? 'Worktree exists.'
        : worktree.value === false
          ? 'Worktree does not exist.'
          : '';
  const message = [
    `Could not finish creating "${branch}".`,
    branchStatus,
    headStatus,
    upstreamStatus,
    worktreeStatus,
    checkPinnedTip && source.status === 'rejected'
      ? 'The selected base ref could not be checked.'
      : checkPinnedTip &&
          source.status === 'fulfilled' &&
          source.value === undefined
        ? 'The selected base ref disappeared during setup.'
        : '',
    checkPinnedTip &&
    tip.status === 'fulfilled' &&
    tip.value &&
    tip.value !== expectedTip
      ? 'Branch tip changed during setup.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  throw new GitCheckoutCreationError(
    branch,
    branchExists,
    message,
    failure?.error,
  );
}

export const GIT_BRANCH_TRACKING_CONFIG_PATTERN =
  '^branch\\..*\\.(remote|merge)$';

// Exact catalogue names have already been verified. Git's literal ref
// match takes precedence over DWIM candidates such as tags with that name.
export const GIT_EXACT_CATALOGUE_REF_ARGS = [
  '-c',
  'core.warnAmbiguousRefs=false',
] as const;

/**
 * The Git read and effects one recorded repository's branch delete runs,
 * each named by the command the desktop runs for it. Effects are never
 * aborted once started; any member may reject with
 * {@link GitBranchWriteInterrupted}.
 */
export interface GitBranchDeletePort {
  /**
   * `worktree list --porcelain` in the repository, as
   * {@link parseGitCheckedOutBranches} reads it; rejects when Git fails.
   */
  listCheckedOutBranches(this: void): Promise<ReadonlyMap<string, string>>;
  /** Effect: `branch -d <branch>`, or `branch -D <branch>` when `force`. */
  deleteBranch(this: void, branch: string, force: boolean): Promise<void>;
  /** Effect: `update-ref -d refs/heads/<branch> <tip>`. */
  deleteBranchRef(this: void, branch: string, tip: string): Promise<void>;
}

export type GitBranchWriteRefusalReason =
  | 'uncommitted-changes'
  | 'branch-occupied'
  | 'branch-not-found'
  | 'invalid-name'
  | 'invalid-start-point'
  | 'name-unavailable'
  | 'checked-out'
  | 'head-changed';

/**
 * A refusal before any effect, carrying the desktop's message unchanged so
 * its compatibility projections answer as before. It keeps the name `Error`:
 * Electron's IPC rejection prints it ahead of the message.
 */
export class GitBranchWriteRefusal extends Error {
  public readonly reason: GitBranchWriteRefusalReason;
  /** The message a protocol caller sees: never a host path. */
  public readonly publicMessage: string;

  public constructor(
    reason: GitBranchWriteRefusalReason,
    message: string,
    publicMessage: string = message,
  ) {
    super(message);
    this.reason = reason;
    this.publicMessage = publicMessage;
  }
}

/**
 * A port read or probe that did not complete because the request was
 * cancelled or the host is unavailable. Unlike a failed Git answer, it is
 * never read as "no" or skipped as best effort: the change stops before any
 * later effect.
 */
export class GitBranchWriteInterrupted extends Error {
  public readonly reason: 'cancelled' | 'unavailable';
  /** The host's own failure, kept for diagnostics. */
  public readonly hostCause: unknown;

  public constructor(
    reason: 'cancelled' | 'unavailable',
    message: string,
    hostCause?: unknown,
  ) {
    super(message);
    this.name = 'GitBranchWriteInterrupted';
    this.reason = reason;
    this.hostCause = hostCause;
  }
}

/** Rethrows an interruption; any other failure is the caller's best effort. */
function rethrowInterrupted(error: unknown): void {
  if (error instanceof GitBranchWriteInterrupted) throw error;
}

/** The message a compare-and-swap head mismatch carries (docs/ux-writing.md). */
export const GIT_BRANCH_HEAD_CHANGED_MESSAGE =
  'The branch changed since this was shown. Check the latest status and try again.';

export interface GitBranchWriteOptions {
  /** Rename precondition. Switch/create retain this field for caller compatibility. */
  readonly expectedBranch?: string;
}

/** `<name>-<n>`, keeping the whole name within 100 characters. */
export function appendBranchSuffix(
  branchName: string,
  suffixNumber: number,
): string {
  const suffix = `-${suffixNumber}`;
  const maxBaseLength = Math.max(1, 100 - suffix.length);
  return `${branchName.slice(0, maxBaseLength)}${suffix}`;
}

/** `a`, `a/b` for `a/b/c`: the names a branch's directories would shadow. */
export function parentBranchNames(branchName: string): string[] {
  const branchSegments = branchName.split('/').filter(Boolean);
  const names: string[] = [];
  let prefix = '';
  for (const segment of branchSegments.slice(0, -1)) {
    prefix = prefix.length > 0 ? `${prefix}/${segment}` : segment;
    names.push(prefix);
  }
  return names;
}

/** The reads that decide whether a new branch name is free. */
export interface GitBranchNameReads {
  localBranchExists(this: void, branch: string): Promise<boolean>;
  listLocalBranchesUnder(this: void, name: string): Promise<string>;
}

/**
 * Whether `branchName` collides with a branch hierarchy: a branch under
 * `<name>/` exists, or a parent name is itself a branch. Git stores refs as
 * files and directories, so a name cannot be both.
 */
export async function hasGitBranchRefConflict(
  reads: GitBranchNameReads,
  branchName: string,
): Promise<boolean> {
  try {
    if ((await reads.listLocalBranchesUnder(branchName)).length > 0)
      return true;
  } catch (error) {
    // Best effort. Fall through to the parent checks.
    rethrowInterrupted(error);
  }
  for (const parent of parentBranchNames(branchName))
    if (await reads.localBranchExists(parent)) return true;
  return false;
}

/** Whether no local branch has `branchName` and no hierarchy shadows it. */
export async function isGitBranchNameFree(
  reads: GitBranchNameReads,
  branchName: string,
): Promise<boolean> {
  return (
    !(await reads.localBranchExists(branchName)) &&
    !(await hasGitBranchRefConflict(reads, branchName))
  );
}

/**
 * `branchName` when it is free, else the first free `-2`…`-100` suffix, else
 * `branchName` unchanged (Git then reports the collision).
 */
export async function selectAvailableGitBranchName(
  reads: GitBranchNameReads,
  branchName: string,
): Promise<string> {
  if (await isGitBranchNameFree(reads, branchName)) return branchName;
  for (let index = 2; index <= 100; index++) {
    const candidate = appendBranchSuffix(branchName, index);
    if (await reads.localBranchExists(candidate)) continue;
    if (await hasGitBranchRefConflict(reads, candidate)) continue;
    return candidate;
  }
  return branchName;
}

async function occupiedBranches(
  port: GitBranchWritePort,
): Promise<ReadonlySet<string>> {
  try {
    const { output, checkoutPath } = await port.readWorktreeList();
    return occupiedGitWorktreeBranches(
      parseGitWorktreeListPorcelain(output),
      checkoutPath,
    );
  } catch (error) {
    rethrowInterrupted(error);
    return new Set<string>();
  }
}

async function assertExpectedHead(
  port: GitBranchWritePort,
  options: GitBranchWriteOptions,
): Promise<void> {
  if (
    options.expectedBranch !== undefined &&
    (await port.currentBranch()) !== options.expectedBranch
  )
    throw new GitBranchWriteRefusal(
      'head-changed',
      GIT_BRANCH_HEAD_CHANGED_MESSAGE,
    );
}

/**
 * Checks out `branch` in a clean checkout: the local branch, else a new branch
 * tracking `origin/<branch>`, fetching that one branch first when the checkout
 * has no remote-tracking ref for it. A branch another worktree holds is
 * refused. Git checks whether the switch is safe when it executes.
 */
export async function checkoutGitBranch(
  port: GitBranchWritePort,
  branch: string,
  options: GitBranchWriteOptions & { readonly remote?: boolean } = {},
): Promise<void> {
  if (await port.hasUncommittedChanges())
    throw new GitBranchWriteRefusal(
      'uncommitted-changes',
      'Cannot switch branches with uncommitted changes',
    );
  if ((await occupiedBranches(port)).has(branch))
    throw new GitBranchWriteRefusal(
      'branch-occupied',
      `Branch "${branch}" is already checked out in another worktree`,
    );
  if (options.remote !== true && (await port.localBranchExists(branch))) {
    await port.checkout(branch);
    return;
  }
  const remote =
    options.remote !== false &&
    ((await port.remoteBranchExists(branch)) ||
      (await port.fetchRemoteBranch(branch).then(
        () => port.remoteBranchExists(branch),
        (error: unknown) => {
          rethrowInterrupted(error);
          return false;
        },
      )));
  if (remote) {
    await port.checkoutNewBranch(branch, `refs/remotes/origin/${branch}`);
    return;
  }
  throw new GitBranchWriteRefusal(
    'branch-not-found',
    `Branch "${branch}" was not found`,
  );
}

/**
 * Creates `name` at `startPoint` and checks it out in a clean checkout. The
 * name must pass `check-ref-format --branch`; a taken name gets the first
 * free suffix. A catalogue base uses its exact namespace and provenance;
 * direct legacy start points retain their existing Git interpretation.
 * Returns the created branch and any warning after a completed switch.
 */
export async function createGitBranch(
  port: GitBranchWritePort,
  name: string,
  startPoint: string,
  options: GitBranchWriteOptions & {
    readonly baseBranch?: { readonly branch: string; readonly remote: boolean };
  } = {},
): Promise<WorkerGitBranchCreateResult> {
  if (await port.hasUncommittedChanges())
    throw new GitBranchWriteRefusal(
      'uncommitted-changes',
      'Cannot create a branch with uncommitted changes',
    );
  if (!(await port.isValidBranchName(name)))
    throw new GitBranchWriteRefusal(
      'invalid-name',
      `Invalid branch name: "${name}"`,
    );
  const resolved = await selectAvailableGitBranchName(port, name);
  const reads = {
    readHeadRef: port.readHeadRef,
    branchExists: (): Promise<boolean> => port.localBranchExists(resolved),
    readTrackingConfig: port.readTrackingConfig,
  };
  const base = options.baseBranch;
  if (!base) {
    // Preserve typed revisions and tags, while using exact refs when the
    // start point identifies an existing branch.
    let ref = startPoint;
    if (!ref.startsWith('refs/')) {
      if (await port.localBranchExists(ref)) {
        ref = `refs/heads/${ref}`;
      } else if (ref.startsWith('origin/')) {
        const remoteName = ref.slice('origin/'.length);
        if (await port.remoteBranchExists(remoteName))
          ref = `refs/remotes/origin/${remoteName}`;
      }
    }
    return createAndVerifyGitCheckout(reads, {
      branch: resolved,
      signal: port.signal,
      create: () => port.checkoutNewBranch(resolved, ref),
    });
  }
  const ref = base.remote
    ? `refs/remotes/origin/${base.branch}`
    : `refs/heads/${base.branch}`;
  const tip = await port.resolveCatalogBranch(base.branch, base.remote);
  if (!tip || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tip))
    throw new GitBranchWriteRefusal(
      'invalid-start-point',
      'Invalid base branch',
    );
  return createAndVerifyGitCheckout(
    {
      ...reads,
      readBranchTip: () => port.resolveCatalogBranch(resolved, false),
      readSourceTip: () => port.resolveCatalogBranch(base.branch, base.remote),
    },
    {
      branch: resolved,
      expectedTip: tip,
      signal: port.signal,
      create: () => port.createBranch(resolved, ref),
      checkout: () => port.checkout(resolved, true),
    },
  );
}

/**
 * Reject empty or option-like inputs before dispatch. Preserve the spelling
 * of the start point and let Git validate the typed branch name in its checkout.
 */
export function gitBranchCreateRequest(
  name: string,
  startPoint: {
    readonly branch: string;
    readonly remote: boolean;
    readonly source?: 'catalog';
  },
): { name: string; startPoint: string } {
  if (!name || name.startsWith('-'))
    throw new GitBranchWriteRefusal('invalid-name', 'Invalid new branch name');
  const base = startPoint.branch;
  if (!base || base.startsWith('-'))
    throw new GitBranchWriteRefusal(
      'invalid-start-point',
      'Invalid base branch',
    );
  return {
    name,
    startPoint: startPoint.remote ? `refs/remotes/origin/${base}` : base,
  };
}

/**
 * Renames the checkout's current branch to `name`: the name must pass
 * `check-ref-format --branch` and be free, and the expected head is checked
 * right before the effect. Uncommitted changes do not block it.
 */
export async function renameGitBranch(
  port: GitBranchWritePort,
  name: string,
  options: GitBranchWriteOptions = {},
): Promise<void> {
  if (!(await port.isValidBranchName(name)))
    throw new GitBranchWriteRefusal(
      'invalid-name',
      `Invalid branch name: "${name}"`,
    );
  if (!(await isGitBranchNameFree(port, name)))
    throw new GitBranchWriteRefusal(
      'name-unavailable',
      `Branch name "${name}" is already in use`,
    );
  await assertExpectedHead(port, options);
  await port.renameCurrentBranch(name);
}

/**
 * Each branch `worktree list --porcelain` shows checked out, with the
 * worktree path that lists it last: the desktop's reading, unchanged.
 */
export function parseGitCheckedOutBranches(
  output: string,
): Map<string, string> {
  const result = new Map<string, string>();
  let currentPath: string | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
      continue;
    }
    if (line.startsWith('branch refs/heads/') && currentPath)
      result.set(
        line.slice('branch refs/heads/'.length).replace(/\r$/, ''),
        currentPath,
      );
  }
  return result;
}

/** How {@link deleteGitBranch} deletes, as `worker.git.branch.delete` names it. */
export type GitBranchDeletion =
  | { readonly kind: 'merged' }
  | { readonly kind: 'force' }
  | { readonly kind: 'tip'; readonly tip: string };

/**
 * Deletes local branch `branch`. `merged` and `force` run `branch -d` and
 * `branch -D`, which Git refuses for a checked-out branch itself. `tip`
 * refuses a branch any worktree has checked out, then deletes the ref only
 * while it still points at `tip`. Git's own refusals reject as Git errors.
 */
export async function deleteGitBranch(
  port: GitBranchDeletePort,
  branch: string,
  deletion: GitBranchDeletion,
): Promise<void> {
  if (deletion.kind !== 'tip') {
    await port.deleteBranch(branch, deletion.kind === 'force');
    return;
  }
  const checkedOutPath = (await port.listCheckedOutBranches()).get(branch);
  if (checkedOutPath)
    throw new GitBranchWriteRefusal(
      'checked-out',
      `Cannot delete branch "${branch}" because it is checked out at ${checkedOutPath}`,
      `Branch "${branch}" is checked out in a worktree.`,
    );
  await port.deleteBranchRef(branch, deletion.tip);
}

/** A branch name a delete may run with: never empty, an option, or NUL-bearing. */
export function gitBranchDeleteName(branch: string): string {
  if (!branch || branch.startsWith('-') || branch.includes('\0'))
    throw new GitBranchWriteRefusal('invalid-name', 'Invalid branch name');
  return branch;
}

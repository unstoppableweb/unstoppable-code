import type { WorkerGitBranch } from '@canopy/protocol/canopy-core';

export interface GitWorktreeListEntry {
  worktreePath: string;
  branchName: string | null;
}

const LOCAL_REF_PREFIX = 'refs/heads/';
const REMOTE_HEAD_REF = 'refs/remotes/origin/HEAD';
const LEGACY_REMOTE_HEAD_SHORT_NAME = 'origin/HEAD';
const ORIGIN_SHORT_PREFIX = 'origin/';
const ORIGIN_REF_PREFIX = 'refs/remotes/origin/';

function branchNameUnder(refName: string, prefix: string): string | null {
  if (!refName.startsWith(prefix)) return null;
  const branchName = refName.slice(prefix.length);
  return branchName.length > 0 ? branchName : null;
}

function localBranchName(refName: string): string | null {
  return branchNameUnder(refName, LOCAL_REF_PREFIX);
}

/** Parses `git worktree list --porcelain` into checkout paths and branches. */
export function parseGitWorktreeListPorcelain(
  output: string,
): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let worktreePath: string | null = null;
  let branchName: string | null = null;
  const commit = (): void => {
    if (!worktreePath) return;
    entries.push({ worktreePath, branchName });
    worktreePath = null;
    branchName = null;
  };
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) {
      commit();
      continue;
    }
    if (line.startsWith('worktree ')) {
      commit();
      worktreePath = line.slice('worktree '.length).trim();
      continue;
    }
    if (line.startsWith('branch '))
      branchName = localBranchName(line.slice('branch '.length));
  }
  commit();
  return entries;
}

/** Branches checked out by worktrees other than `checkoutPath`. */
export function occupiedGitWorktreeBranches(
  entries: readonly GitWorktreeListEntry[],
  checkoutPath: string,
): Set<string> {
  const occupied = new Set<string>();
  for (const entry of entries)
    if (entry.worktreePath !== checkoutPath && entry.branchName)
      occupied.add(entry.branchName);
  return occupied;
}

function compareBranches(
  left: WorkerGitBranch,
  right: WorkerGitBranch,
  defaultBranch: string | null,
): number {
  if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
  const leftIsDefault = defaultBranch !== null && left.name === defaultBranch;
  const rightIsDefault = defaultBranch !== null && right.name === defaultBranch;
  if (leftIsDefault !== rightIsDefault) return leftIsDefault ? -1 : 1;
  return left.name.localeCompare(right.name);
}

/**
 * Merges {@link GIT_BRANCH_LIST_REF_ARGS} output into one entry per branch
 * name, ordered current first, then the default branch, then by name.
 */
export function buildGitBranchList(
  forEachRefOutput: string,
  occupiedBranches: ReadonlySet<string>,
  defaultBranch: string | null,
  useFullRefNames = false,
): WorkerGitBranch[] {
  const branchesByName = new Map<string, WorkerGitBranch>();
  for (const rawLine of forEachRefOutput.split('\n')) {
    const tab = rawLine.indexOf('\t');
    if (tab < 0) continue;
    const refName = rawLine.slice(0, tab);
    const shortField = rawLine.slice(tab + 1).replace(/\r$/, '');
    const marker = shortField.slice(-1);
    const isCurrent = marker === '*';
    // %(HEAD) contributes exactly one asterisk or ASCII space.
    const shortName =
      isCurrent || marker === ' ' ? shortField.slice(0, -1) : shortField;
    if (
      !shortName ||
      refName === REMOTE_HEAD_REF ||
      (!useFullRefNames && shortName === LEGACY_REMOTE_HEAD_SHORT_NAME)
    )
      continue;
    // Today's names: Git's short name, remote when it starts with `origin/`.
    // A shadowed ref keeps Git's qualified spelling (`heads/main`,
    // `remotes/origin/<name>`) as a local entry.
    const remoteName = useFullRefNames
      ? branchNameUnder(refName, ORIGIN_REF_PREFIX)
      : branchNameUnder(shortName, ORIGIN_SHORT_PREFIX);
    const isRemote = remoteName !== null;
    const name =
      remoteName ?? (useFullRefNames ? localBranchName(refName) : shortName);
    if (!name) continue;
    const existing = branchesByName.get(name);
    const hasLocalRef = (existing?.hasLocalRef ?? false) || !isRemote;
    const hasRemoteRef = (existing?.hasRemoteRef ?? false) || isRemote;
    branchesByName.set(name, {
      name,
      isRemote: hasRemoteRef && !hasLocalRef,
      isCurrent: (existing?.isCurrent ?? false) || (!isRemote && isCurrent),
      isUsedByWorktree: occupiedBranches.has(name),
      hasLocalRef,
      hasRemoteRef,
    });
  }
  return Array.from(branchesByName.values()).sort((left, right) =>
    compareBranches(left, right, defaultBranch),
  );
}

// The full name only identifies refs/remotes/origin/HEAD, which Git 2.55
// shortens to `origin` and Git 2.37 to `origin/HEAD`.
export const GIT_BRANCH_LIST_REF_ARGS = [
  'for-each-ref',
  '--format=%(refname)%09%(refname:short)%(HEAD)',
  'refs/heads/',
  'refs/remotes/origin/',
] as const;

/** The reads one branch listing needs from a single checkout. */
export interface GitBranchListSources<DefaultBranch> {
  /** Output of {@link GIT_BRANCH_LIST_REF_ARGS} in the checkout. */
  readBranchRefs(): Promise<string>;
  /** `worktree list --porcelain` from the main repository root. */
  readWorktreeList(): Promise<{ output: string; checkoutPath: string }>;
  resolveDefaultBranch(): Promise<DefaultBranch>;
}

/**
 * Lists a checkout's branches. The three reads run concurrently; a failed
 * worktree listing reports no occupied branches, and only a failed ref read
 * fails the listing.
 */
export async function listGitBranches<DefaultBranch>(
  sources: GitBranchListSources<DefaultBranch>,
  defaultBranchName: (value: DefaultBranch) => string | null,
  useFullRefNames = false,
): Promise<{ branches: WorkerGitBranch[]; defaultBranch: DefaultBranch }> {
  const [refs, occupied, defaultBranch] = await Promise.all([
    sources.readBranchRefs(),
    sources.readWorktreeList().then(
      ({ output, checkoutPath }) =>
        occupiedGitWorktreeBranches(
          parseGitWorktreeListPorcelain(output),
          checkoutPath,
        ),
      () => new Set<string>(),
    ),
    sources.resolveDefaultBranch(),
  ]);
  return {
    branches: buildGitBranchList(
      refs,
      occupied,
      defaultBranchName(defaultBranch),
      useFullRefNames,
    ),
    defaultBranch,
  };
}

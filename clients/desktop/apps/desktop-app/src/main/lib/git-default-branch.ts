import { logMainProcessError } from './main-process-logging';
import { withGitReadPath } from './worktree-read-availability';
import {
  GIT_DEFAULT_BRANCH_HINT_TTL_MS,
  selectGitDefaultBranch,
  type GitDefaultBranchFacts,
  type GitDefaultBranchHint,
  type GitDefaultBranchSelection,
} from '@canopy/core-runtime/node/git';
import {
  getGitCommonDir,
  getLocalRemoteHeadBranch,
  getRemoteDefaultBranch,
  getRemoteHeadBranch,
  getRemoteUrl,
  setLocalRemoteHeadBranch,
} from './git';
import {
  readGitDefaultBranchFreshness,
  recordGitDefaultBranch,
  type GitDefaultBranchFreshnessIdentity,
} from './git-default-branch-freshness';

export const DEFAULT_BRANCH_FRESHNESS_TTL_MS = GIT_DEFAULT_BRANCH_HINT_TTL_MS;

async function resolveIdentity(
  repoPath: string,
  signal?: AbortSignal,
): Promise<GitDefaultBranchFreshnessIdentity | null> {
  const [commonDir, originUrl] = await Promise.all([
    getGitCommonDir(repoPath, signal).catch(() => null),
    getRemoteUrl(repoPath, signal).catch(() => null),
  ]);
  return commonDir && originUrl ? { commonDir, originUrl } : null;
}

/** What the hint read saw, so the effects reuse the identity it resolved. */
export interface DefaultBranchObservation {
  identity?: GitDefaultBranchFreshnessIdentity | null;
}

/** The freshness store's recorded default for the repository's identity. */
export async function readDefaultBranchHint(
  repoPath: string,
  observation: DefaultBranchObservation,
  signal?: AbortSignal,
): Promise<GitDefaultBranchHint | null> {
  const identity =
    observation.identity !== undefined
      ? observation.identity
      : await resolveIdentity(repoPath, signal);
  observation.identity = identity;
  const stored = identity
    ? await readGitDefaultBranchFreshness(identity).catch(() => null)
    : null;
  return stored
    ? { defaultBranch: stored.defaultBranch, resolvedAt: stored.resolvedAt }
    : null;
}

/**
 * Read-only default-branch Git facts for one repository; `readHint` supplies
 * recorded knowledge. Desktop helpers keep their environments and caches.
 */
export function createDesktopDefaultBranchFacts(
  repoPath: string,
  readHint: () => Promise<GitDefaultBranchHint | null>,
  signal?: AbortSignal,
): GitDefaultBranchFacts {
  return {
    readHint,
    readRemoteHead: () => getRemoteHeadBranch(repoPath, { signal }),
    readLocalOriginHead: () => getLocalRemoteHeadBranch(repoPath, { signal }),
    readConventional: () =>
      getRemoteDefaultBranch(repoPath, { allowNetwork: false, signal }),
  };
}

/**
 * The writes a remote-verified default earns: record it in the freshness
 * store, then repair a divergent local origin/HEAD. Both are best effort.
 */
export async function applyDefaultBranchEffects(
  repoPath: string,
  selection: GitDefaultBranchSelection,
  observation: DefaultBranchObservation,
  resolvedAt: number,
): Promise<void> {
  const remoteHead = selection.defaultBranch;
  if (selection.source !== 'remote' || !remoteHead) return;
  const identity = observation.identity ?? (await resolveIdentity(repoPath));
  if (identity) {
    await recordGitDefaultBranch({
      identity,
      defaultBranch: remoteHead,
      resolvedAt,
    }).catch(() => undefined);
  }
  const localRemoteHead = await getLocalRemoteHeadBranch(repoPath).catch(
    () => null,
  );
  if (localRemoteHead !== remoteHead) {
    try {
      await setLocalRemoteHeadBranch(repoPath, remoteHead);
    } catch {
      // Repair is best-effort for read-only repositories and permissions.
    }
  }
}

/**
 * Resolves advisory default-branch knowledge for automatic display/state reads.
 * Remote-capable reads reuse recent identity-matched remote knowledge, then
 * revalidate origin HEAD. Local origin/HEAD remains the offline fallback.
 * Selection is the portable `worker.git.branch.list` precedence; this
 * in-process form also applies its effects before returning.
 */
export function resolveFreshDefaultBranch(
  repoPath: string,
  options: { allowRemoteLookup?: boolean } = {},
): Promise<string | null> {
  return resolveAvailableDefaultBranch(repoPath, options);
}

async function resolveAvailableDefaultBranch(
  repoPath: string,
  options: { allowRemoteLookup?: boolean } = {},
  observation: DefaultBranchObservation = {},
): Promise<string | null> {
  return (await selectAvailableDefaultBranch(repoPath, options, observation))
    .defaultBranch;
}

async function selectAvailableDefaultBranch(
  repoPath: string,
  options: { allowRemoteLookup?: boolean },
  observation: DefaultBranchObservation,
): Promise<GitDefaultBranchSelection> {
  const now = Date.now();
  const selection = await selectGitDefaultBranch(
    createDesktopDefaultBranchFacts(repoPath, () =>
      readDefaultBranchHint(repoPath, observation),
    ),
    { now, allowRemoteLookup: options.allowRemoteLookup },
  );
  await applyDefaultBranchEffects(repoPath, selection, observation, now);
  return selection;
}

const backgroundRevalidations = new Map<string, Promise<void>>();
const repositoryRevalidations = new Map<string, Promise<boolean>>();

async function revalidateRepositoryDefaultBranch(
  repoPath: string,
): Promise<void> {
  const identity = await resolveIdentity(repoPath);
  if (!identity) {
    await resolveAvailableDefaultBranch(repoPath, {}, { identity });
    return;
  }
  const key = JSON.stringify([identity.commonDir, identity.originUrl]);
  for (
    let running = repositoryRevalidations.get(key);
    running;
    running = repositoryRevalidations.get(key)
  ) {
    if (await running) return;
  }

  const revalidation = (async (): Promise<boolean> => {
    const selection = await selectAvailableDefaultBranch(
      repoPath,
      {},
      { identity },
    );
    // A fallback after remote failure is useful to its caller, but must not
    // suppress a healthy sibling whose worktree-local credentials may succeed.
    return (
      (selection.source === 'remote' || selection.source === 'hint') &&
      (await withGitReadPath(repoPath, false, () => Promise.resolve(true)))
    );
  })().catch((error: unknown) => {
    logMainProcessError('Default branch revalidation failed', error);
    return false;
  });
  repositoryRevalidations.set(key, revalidation);
  try {
    await revalidation;
  } finally {
    if (repositoryRevalidations.get(key) === revalidation)
      repositoryRevalidations.delete(key);
  }
}

/**
 * Revalidates stale default-branch knowledge against the remote without making
 * the caller wait. Reads that must not block on the network resolve the
 * default branch locally and call this, so a changed remote default branch is
 * still recorded and a stale local origin/HEAD is still repaired. Concurrent
 * calls for one repository share a single lookup.
 */
export function revalidateDefaultBranchInBackground(repoPath: string): void {
  if (backgroundRevalidations.has(repoPath)) {
    return;
  }
  const revalidation = withGitReadPath(repoPath, null, () =>
    revalidateRepositoryDefaultBranch(repoPath),
  )
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      backgroundRevalidations.delete(repoPath);
    });
  backgroundRevalidations.set(repoPath, revalidation);
}

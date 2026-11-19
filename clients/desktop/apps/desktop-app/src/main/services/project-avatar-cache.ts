/**
 * GitHub owner avatars for single-repo projects, projected onto the session
 * snapshot's workspace rows (`avatarUrl`) so the shared sidebar rail — on the
 * desktop and in the web portal alike — can draw them on project headers.
 *
 * Snapshot construction never waits on git: a read answers from this
 * process-lifetime cache, and a miss or a due entry schedules a serialized
 * `git remote get-url origin` in the background. When a lookup changes the
 * answer, the structural-sync signal republishes the snapshot (desktop rail
 * invalidation plus the portal overview push), which then reads the hit.
 *
 * Only a definite answer changes a cached avatar: a confirmed absent origin
 * or a non-GitHub one clears it, while an operational git failure (a lock, a
 * timeout) keeps the last answer and retries after a short backoff.
 */
import { getGitHubOwnerAvatarUrl } from '@canopy/desktop-shared/lib/github-owner-avatar';
import { getRemoteUrlStrict } from '../lib/git';
import { scheduleDesktopStructureChanged } from './desktop-structure-signal';
import { allowsAutomaticCall } from '../local-only/policy';

/** How long a definite answer is served before it is re-checked in the background. */
export const PROJECT_AVATAR_REFRESH_MS = 10 * 60_000;
/** How soon a lookup that failed operationally is retried. */
export const PROJECT_AVATAR_RETRY_MS = 30_000;

interface ProjectAvatarEntry {
  readonly avatarUrl: string | null;
  /** When a read should schedule the next lookup. */
  readonly refreshAt: number;
}

type ProjectAvatarLookup =
  | { readonly status: 'resolved'; readonly avatarUrl: string | null }
  | { readonly status: 'failed' };

const entries = new Map<string, ProjectAvatarEntry>();
const pendingRepoPaths = new Set<string>();
/** In-flight lookups whose repository a projection pass has since dropped. */
const discardedRepoPaths = new Set<string>();
// One lookup at a time, so a large sidebar cannot fan out git processes.
let lookupQueue: Promise<void> = Promise.resolve();

async function lookUpAvatarUrl(repoPath: string): Promise<ProjectAvatarLookup> {
  try {
    // Strict: `null` means origin is confirmed absent; anything operational
    // throws instead of masquerading as "no origin".
    const remoteUrl = await getRemoteUrlStrict(repoPath);
    return {
      status: 'resolved',
      avatarUrl: remoteUrl ? getGitHubOwnerAvatarUrl(remoteUrl) : null,
    };
  } catch {
    return { status: 'failed' };
  }
}

function recordLookup(repoPath: string, lookup: ProjectAvatarLookup): void {
  if (discardedRepoPaths.delete(repoPath)) return;
  const previousAvatarUrl = entries.get(repoPath)?.avatarUrl ?? null;
  if (lookup.status === 'failed') {
    entries.set(repoPath, {
      avatarUrl: previousAvatarUrl,
      refreshAt: Date.now() + PROJECT_AVATAR_RETRY_MS,
    });
    return;
  }
  entries.set(repoPath, {
    avatarUrl: lookup.avatarUrl,
    refreshAt: Date.now() + PROJECT_AVATAR_REFRESH_MS,
  });
  if (previousAvatarUrl !== lookup.avatarUrl) {
    scheduleDesktopStructureChanged('structural.project-avatar');
  }
}

function scheduleLookup(repoPath: string): void {
  if (pendingRepoPaths.has(repoPath)) return;
  pendingRepoPaths.add(repoPath);
  discardedRepoPaths.delete(repoPath);
  lookupQueue = lookupQueue
    .then(async (): Promise<void> => {
      recordLookup(repoPath, await lookUpAvatarUrl(repoPath));
    })
    // A failed bookkeeping step must not wedge the queue for later lookups.
    .catch(() => undefined)
    .finally(() => {
      pendingRepoPaths.delete(repoPath);
    });
}

/**
 * The GitHub owner avatar for the repository at `repoPath`, or `undefined`
 * when it is not GitHub-backed or has not been resolved yet. Never blocks.
 */
export function readProjectAvatarUrl(repoPath: string): string | undefined {
  // A local-only build projects no remote avatar URL, so nothing loads one.
  if (!allowsAutomaticCall('avatars.project-cache')) return undefined;
  const entry = entries.get(repoPath);
  if (!entry || Date.now() >= entry.refreshAt) {
    scheduleLookup(repoPath);
  }
  return entry?.avatarUrl ?? undefined;
}

/**
 * Forget every repository a complete projection pass no longer names, so a
 * deleted or renamed project does not keep its entry for the process lifetime.
 * Only a pass over every workspace may call this; a scoped pass would prune
 * the projects it skipped.
 */
export function retainProjectAvatarRepoPaths(
  repoPaths: ReadonlySet<string>,
): void {
  entries.forEach((_entry, repoPath) => {
    if (!repoPaths.has(repoPath)) entries.delete(repoPath);
  });
  pendingRepoPaths.forEach((repoPath) => {
    if (repoPaths.has(repoPath)) discardedRepoPaths.delete(repoPath);
    else discardedRepoPaths.add(repoPath);
  });
}

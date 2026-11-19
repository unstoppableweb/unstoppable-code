/**
 * Path-free GitHub repository identities for Portal workspace rows.
 *
 * Snapshot construction only reads this process-lifetime cache. Origin reads
 * run serially in the background through the worker Git boundary. A confirmed
 * GitHub or non-GitHub remote refreshes the cached answer; an unavailable
 * runtime, unreadable manifest, or failed remote read retains the last answer
 * and retries sooner.
 */
import {
  parsePortalRepositoryIdentity,
  type PortalRepositoryIdentity,
} from '@canopy/protocol/portal';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { parseGitHubRemote } from '../lib/github-pr';
import { recordedRepositoryPath } from '../lib/workspace-recorded-repo';
import { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import { peekDesktopCanopyRuntime } from '../canopy-runtime/desktop-runtime-access';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { readRepositoryRemoteUrl } from '../canopy-runtime/worker-git-dispatch';
import { scheduleDesktopStructureChanged } from './desktop-structure-signal';

/** How long a definite repository identity is served before a background refresh. */
export const PROJECT_REPOSITORY_IDENTITY_REFRESH_MS = 10 * 60_000;
/** How soon an operational lookup failure is retried. */
export const PROJECT_REPOSITORY_IDENTITY_RETRY_MS = 30_000;

interface ProjectRepositoryIdentityEntry {
  readonly repositoryIdentity: PortalRepositoryIdentity | null;
  readonly refreshAt: number;
}

type ProjectRepositoryIdentityLookup =
  | {
      readonly status: 'resolved';
      readonly repositoryIdentity: PortalRepositoryIdentity | null;
    }
  | { readonly status: 'failed' };

const PROJECT_REPOSITORY_IDENTITY_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-project-repository-identity-cache',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [],
};

const entries = new Map<string, ProjectRepositoryIdentityEntry>();
const pendingRepoPaths = new Set<string>();
/** In-flight lookups whose repository a complete projection has since dropped. */
const discardedRepoPaths = new Set<string>();
// Keep origin reads from a large sidebar from fanning out over the worker.
let lookupQueue: Promise<void> = Promise.resolve();

function sameRepositoryIdentity(
  left: PortalRepositoryIdentity | null,
  right: PortalRepositoryIdentity | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.owner === right.owner &&
      left.repo === right.repo)
  );
}

async function lookUpRepositoryIdentity(
  workspaceId: string,
  repoPath: string,
): Promise<ProjectRepositoryIdentityLookup> {
  try {
    const detail = await readWorkspaceConfigDetailed(workspaceId);
    if (detail.authority !== 'ok') return { status: 'failed' };

    const rootRepoPath = recordedRepositoryPath(detail.config);
    if (!rootRepoPath) return { status: 'resolved', repositoryIdentity: null };
    // A workspace may change its recorded root while this queued read waits.
    if (rootRepoPath !== repoPath) return { status: 'failed' };

    const runtime = peekDesktopCanopyRuntime();
    if (!runtime) return { status: 'failed' };
    const { remoteUrl } = await readRepositoryRemoteUrl(
      runtime,
      PROJECT_REPOSITORY_IDENTITY_CALLER,
      rootRepoPath,
    );
    // The worker compatibility projection returns null both for no origin
    // and for a read that cannot be served, so neither is a definite refresh.
    if (remoteUrl === null) return { status: 'failed' };

    const githubRemote = parseGitHubRemote(remoteUrl);
    return {
      status: 'resolved',
      repositoryIdentity:
        githubRemote === null
          ? null
          : (parsePortalRepositoryIdentity(githubRemote) ?? null),
    };
  } catch {
    return { status: 'failed' };
  }
}

function recordLookup(
  repoPath: string,
  lookup: ProjectRepositoryIdentityLookup,
): void {
  if (discardedRepoPaths.delete(repoPath)) return;
  const previousIdentity = entries.get(repoPath)?.repositoryIdentity ?? null;
  if (lookup.status === 'failed') {
    entries.set(repoPath, {
      repositoryIdentity: previousIdentity,
      refreshAt: Date.now() + PROJECT_REPOSITORY_IDENTITY_RETRY_MS,
    });
    return;
  }
  entries.set(repoPath, {
    repositoryIdentity: lookup.repositoryIdentity,
    refreshAt: Date.now() + PROJECT_REPOSITORY_IDENTITY_REFRESH_MS,
  });
  if (!sameRepositoryIdentity(previousIdentity, lookup.repositoryIdentity)) {
    scheduleDesktopStructureChanged('structural.project-repository-identity');
  }
}

function scheduleLookup(workspaceId: string, repoPath: string): void {
  if (pendingRepoPaths.has(repoPath)) return;
  pendingRepoPaths.add(repoPath);
  discardedRepoPaths.delete(repoPath);
  lookupQueue = lookupQueue
    .then(async (): Promise<void> => {
      recordLookup(
        repoPath,
        await lookUpRepositoryIdentity(workspaceId, repoPath),
      );
    })
    // A failed bookkeeping step must not wedge later repository lookups.
    .catch(() => undefined)
    .finally(() => {
      pendingRepoPaths.delete(repoPath);
    });
}

/** The root repository identity, or `undefined` until a definite lookup. */
export function readProjectRepositoryIdentity(
  workspaceId: string,
  repoPath: string,
): PortalRepositoryIdentity | undefined {
  if (!repoPath) return undefined;
  const entry = entries.get(repoPath);
  if (!entry || Date.now() >= entry.refreshAt) {
    scheduleLookup(workspaceId, repoPath);
  }
  return entry?.repositoryIdentity ?? undefined;
}

/** Prune only after an unscoped pass has named every projected repository. */
export function retainProjectRepositoryRepoPaths(
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

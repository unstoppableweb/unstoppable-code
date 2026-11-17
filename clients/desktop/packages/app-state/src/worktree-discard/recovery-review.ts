import { create } from 'zustand';
import type { CanopyClient } from '@canopy/app-core';

interface RecoveryReviews {
  readonly sources: ReadonlyMap<CanopyClient, ReadonlySet<string>>;
  readonly workspaceIds: ReadonlySet<string>;
  readonly requestClient: CanopyClient | null;
  readonly requestToken: number;
}

// Page-scoped, as for lifecycle quarantine: the sidebar may hold a composite
// client while the mounted recovery host holds its narrower Portal client.
const recoveryReviews = create<RecoveryReviews>()(() => ({
  sources: new Map(),
  workspaceIds: new Set(),
  requestClient: null,
  requestToken: 0,
}));

function listedWorkspaces(
  sources: RecoveryReviews['sources'],
): ReadonlySet<string> {
  return new Set(Array.from(sources.values()).flatMap((ids) => [...ids]));
}

/** Publishes existing list results only; registration never reads recovery evidence. */
export function registerArchiveRecoveryReview(
  client: CanopyClient,
  workspaceIds: readonly string[],
): () => void {
  const ids = new Set(workspaceIds);
  recoveryReviews.setState((state) => {
    const sources = new Map(state.sources).set(client, ids);
    return { sources, workspaceIds: listedWorkspaces(sources) };
  });
  return (): void => {
    recoveryReviews.setState((state) => {
      if (state.sources.get(client) !== ids) return state;
      const sources = new Map(state.sources);
      sources.delete(client);
      return {
        sources,
        workspaceIds: listedWorkspaces(sources),
        ...(state.requestClient === client ? { requestClient: null } : {}),
      };
    });
  };
}

export function useArchiveRecoveryWorkspaceIds(): ReadonlySet<string> {
  return recoveryReviews((state) => state.workspaceIds);
}

/** Opens the already mounted host without a query or undoing notice dismissal. */
export function requestArchiveRecoveryReview(workspaceId: string): void {
  const source = Array.from(recoveryReviews.getState().sources).find(
    ([, ids]) => ids.has(workspaceId),
  );
  if (!source) return;
  recoveryReviews.setState((state) => ({
    requestClient: source[0],
    requestToken: state.requestToken + 1,
  }));
}

export function useArchiveRecoveryReviewRequest(client: CanopyClient): number {
  return recoveryReviews((state) =>
    state.requestClient === client ? state.requestToken : 0,
  );
}

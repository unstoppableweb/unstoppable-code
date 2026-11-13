import { create } from 'zustand';
import type { ResolvedProjectStartPage } from '@canopy/desktop-shared/types';
import { isWebCoreScope } from '@/lib/chat-authority';

/**
 * Renderer cache of each project's resolved start page, keyed by
 * `projectId` or `projectId:worktreeId` (a worktree's `canopy.json` can
 * differ from the reference repo). Main owns resolution; this only lets
 * synchronous surfaces such as menus and tab glyphs read the last answer.
 */
interface StartPageStoreState {
  resolved: Record<string, ResolvedProjectStartPage | null>;
  refresh: (
    projectId: string,
    worktreeId?: string,
  ) => Promise<ResolvedProjectStartPage | null>;
  /** Drop every cached entry for a project after a write. */
  invalidateProject: (projectId: string) => void;
  /** Re-resolve every cached entry for a project after a write. */
  refreshProject: (projectId: string) => Promise<void>;
}

export function startPageCacheKey(
  projectId: string,
  worktreeId?: string,
): string {
  return worktreeId ? `${projectId}:${worktreeId}` : projectId;
}

const inflight = new Map<string, Promise<ResolvedProjectStartPage | null>>();
const projectEpochs = new Map<string, number>();

function belongsToProject(key: string, projectId: string): boolean {
  return key === projectId || key.startsWith(`${projectId}:`);
}

export const useStartPageStore = create<StartPageStoreState>((set, get) => ({
  resolved: {},
  refresh: (
    projectId,
    worktreeId,
  ): Promise<ResolvedProjectStartPage | null> => {
    const key = startPageCacheKey(projectId, worktreeId);
    // Start pages come from a local project's configuration; main holds none
    // for a web core project and must never be asked (CAN-6175 D1).
    if (isWebCoreScope(projectId)) return Promise.resolve(null);
    const pending = inflight.get(key);
    if (pending) return pending;
    const epoch = projectEpochs.get(projectId) ?? 0;
    const request = window.api
      .resolveProjectStartPage(
        worktreeId ? { projectId, worktreeId } : { projectId },
      )
      .catch(() => null)
      .then((value) => {
        if ((projectEpochs.get(projectId) ?? 0) === epoch) {
          set((state) => ({ resolved: { ...state.resolved, [key]: value } }));
        }
        return value;
      });
    inflight.set(key, request);
    const removeCompletedRequest = (): void => {
      if (inflight.get(key) === request) {
        inflight.delete(key);
      }
    };
    void request.then(removeCompletedRequest, removeCompletedRequest);
    return request;
  },
  invalidateProject: (projectId): void => {
    projectEpochs.set(projectId, (projectEpochs.get(projectId) ?? 0) + 1);
    for (const key of Array.from(inflight.keys())) {
      if (belongsToProject(key, projectId)) inflight.delete(key);
    }
    set((state) => {
      const resolved: Record<string, ResolvedProjectStartPage | null> = {};
      for (const [key, value] of Object.entries(state.resolved)) {
        if (!belongsToProject(key, projectId)) {
          resolved[key] = value;
        }
      }
      return { resolved };
    });
  },
  refreshProject: async (projectId): Promise<void> => {
    const keys = new Set<string>(
      [...Object.keys(get().resolved), ...Array.from(inflight.keys())].filter(
        (key) => belongsToProject(key, projectId),
      ),
    );
    if (keys.size === 0) keys.add(projectId);
    get().invalidateProject(projectId);
    await Promise.all(
      Array.from(keys).map((key) =>
        get().refresh(
          projectId,
          key === projectId ? undefined : key.slice(projectId.length + 1),
        ),
      ),
    );
  },
}));

/** Selector helper: the cached resolved value, or undefined when unknown. */
export function selectResolvedStartPage(
  state: Pick<StartPageStoreState, 'resolved'>,
  projectId: string,
  worktreeId?: string,
): ResolvedProjectStartPage | null | undefined {
  return state.resolved[startPageCacheKey(projectId, worktreeId)];
}

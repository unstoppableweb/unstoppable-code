import { useEffect, useRef, useSyncExternalStore, type JSX } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import { useProjectDeletionDiscardOffer } from '@canopy/app-state';
import type { ProjectDeletionItemDiscarded } from '@canopy/app-state/worktree-discard';
import { recordSurfacedError } from '@canopy/ui-shared/lib';
import type * as PanelModule from './ProjectDeletionDiscardPanel';

type LoadedPanel = typeof PanelModule;

// The confirmation loads with the first refused deletion, not with a route.
let loadedPanel: LoadedPanel | null = null;
let pendingLoad: Promise<LoadedPanel> | null = null;
const listeners = new Set<() => void>();
// Whether a host whose offer waits on the pending import is still mounted.
const waiters = new Set<() => boolean>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

function getSnapshot(): LoadedPanel | null {
  return loadedPanel;
}

function loadPanel(isWaiting: () => boolean): Promise<LoadedPanel> {
  if (loadedPanel === null) waiters.add(isWaiting);
  pendingLoad ??= import('./ProjectDeletionDiscardPanel').then(
    (module) => {
      loadedPanel = module;
      waiters.clear();
      for (const listener of Array.from(listeners)) listener();
      return module;
    },
    (error: unknown) => {
      // Let the next refusal retry a failed chunk load.
      pendingLoad = null;
      // Only a host still waiting on this import is told; the chunk's failure
      // is recorded once, however many offers joined it.
      const waited = Array.from(waiters).some((isLive) => isLive());
      waiters.clear();
      if (waited) {
        recordSurfacedError({
          chokePoint: 'notice',
          identifier: 'project-deletion-discard-load',
          error,
        });
      }
      throw error;
    },
  );
  return pendingLoad;
}

/**
 * CAN-5337: the one confirmation for discarding what keeps a project's
 * deletion from finishing, opened by `offerProjectDeletionDiscard` from a
 * refused deletion. Mounted once per host with that host's client; desktop
 * and Portal differ only in transport and in `onItemDiscarded`, the host's
 * own list and panel cleanup after each discard. Without the capability, or
 * with nothing to discard, the refusing surface keeps its own message.
 */
export function ProjectDeletionDiscardHost({
  client,
  onItemDiscarded,
}: {
  client: CanopyClient;
  onItemDiscarded: (discarded: ProjectDeletionItemDiscarded) => void;
}): JSX.Element | null {
  const supported =
    client.capabilities.projectDeletionDiscard === true &&
    client.capabilities.worktreeDiscard === true;
  const { token, offer } = useProjectDeletionDiscardOffer();
  const answered = useRef(token);
  const onItemDiscardedRef = useRef(onItemDiscarded);
  useEffect(() => {
    onItemDiscardedRef.current = onItemDiscarded;
  });
  // Cleared when the host unmounts, so a load or open that settles afterwards
  // finds nobody to tell.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);
  const loaded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (token === answered.current) return;
    answered.current = token;
    if (!offer || !supported) return;
    // The refusing surface keeps its own message and nothing else shows, so
    // these record with no surface. `loadPanel` records its own failure, once
    // per load, however many refusals joined it, and only for a mounted host.
    void loadPanel(() => mountedRef.current).then(
      (panel) =>
        mountedRef.current
          ? panel
              .openProjectDeletionDiscard(client, offer)
              .catch((error: unknown) => {
                if (!mountedRef.current) return;
                recordSurfacedError({
                  chokePoint: 'notice',
                  identifier: 'project-deletion-discard-open',
                  error,
                });
              })
          : undefined,
      () => undefined,
    );
  }, [client, offer, supported, token]);
  if (!loaded || !supported) return null;
  const { ProjectDeletionDiscardPanel } = loaded;
  return (
    <ProjectDeletionDiscardPanel
      client={client}
      onItemDiscarded={(discarded) => onItemDiscardedRef.current(discarded)}
    />
  );
}

import { useEffect, useRef, useSyncExternalStore, type JSX } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import {
  useWorktreeDiscardOffer,
  type WorktreeDiscardOffer,
} from '@canopy/app-state';
import type * as PanelModule from './WorktreeDiscardPanel';
import type { WorktreeDiscarded } from './types';

export type { WorktreeDiscarded } from './types';

type LoadedPanel = typeof PanelModule;

// The confirmation and its store load with the first refused removal, not
// with every route. A manual `import()`, as for the journal review.
let loadedPanel: LoadedPanel | null = null;
let pendingLoad: Promise<LoadedPanel> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

function getSnapshot(): LoadedPanel | null {
  return loadedPanel;
}

function loadPanel(): Promise<LoadedPanel> {
  pendingLoad ??= import('./WorktreeDiscardPanel').then(
    (module) => {
      loadedPanel = module;
      for (const listener of Array.from(listeners)) listener();
      return module;
    },
    (error: unknown) => {
      // Let the next refusal retry a failed chunk load.
      pendingLoad = null;
      throw error;
    },
  );
  return pendingLoad;
}

/**
 * CAN-5336: the one confirmation for discarding a worktree whose ordinary
 * removal can't finish, opened by `offerWorktreeDiscard` from a refused
 * single-row removal. Mounted once per host with that host's client; desktop
 * and Portal differ only in transport and in what they do afterwards.
 *
 * `notify` shows the refusal's own message when there is nothing to discard
 * (no capability, a refused description, or a failed load). `onDiscarded`
 * runs the host's list and panel cleanup.
 */
export function WorktreeDiscardHost({
  client,
  notify,
  onDiscarded,
}: {
  client: CanopyClient;
  notify: (offer: WorktreeDiscardOffer) => void;
  onDiscarded: (discarded: WorktreeDiscarded) => void;
}): JSX.Element | null {
  const supported = client.capabilities.worktreeDiscard === true;
  const { token, offer } = useWorktreeDiscardOffer();
  const answered = useRef(token);
  const notifyRef = useRef(notify);
  const onDiscardedRef = useRef(onDiscarded);
  useEffect(() => {
    notifyRef.current = notify;
    onDiscardedRef.current = onDiscarded;
  });
  const loaded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (token === answered.current) return;
    answered.current = token;
    if (!offer) return;
    if (!supported) {
      notifyRef.current(offer);
      return;
    }
    loadPanel()
      .then((panel) => panel.openWorktreeDiscard(client, offer))
      .then(
        (opened) => {
          if (!opened) notifyRef.current(offer);
        },
        () => notifyRef.current(offer),
      );
  }, [client, offer, supported, token]);
  if (!loaded || !supported) return null;
  const { WorktreeDiscardPanel } = loaded;
  return (
    <WorktreeDiscardPanel
      client={client}
      onDiscarded={(discarded) => onDiscardedRef.current(discarded)}
    />
  );
}

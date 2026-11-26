import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type JSX,
} from 'react';
import type { CanopyClient } from '@canopy/app-core';
import {
  useWorktreeDiscardOffer,
  type WorktreeDiscardOffer,
} from '@canopy/app-state';
import type * as PanelModule from './WorktreeDiscardPanel';
import { activateWorktreeDiscardComputer } from '@canopy/app-state/worktree-discard';
import type { WorktreeDiscarded } from './types';

export type { WorktreeDiscarded } from './types';

type LoadedPanel = typeof PanelModule;

// The confirmation UI loads with the first refused removal, not with every
// route. A manual `import()`, as for the journal review.
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
  computerScopeKey = null,
  notify,
  onDiscarded,
}: {
  client: CanopyClient;
  computerScopeKey?: string | null;
  notify: (offer: WorktreeDiscardOffer) => void;
  onDiscarded: (discarded: WorktreeDiscarded) => void;
}): JSX.Element | null {
  const supported = client.capabilities.worktreeDiscard === true;
  const { token, offer } = useWorktreeDiscardOffer();
  const answered = useRef(token);
  const pendingOffer = useRef<{
    token: number;
    client: CanopyClient;
    computerScopeKey: string | null;
    active: boolean;
  } | null>(null);
  const notifyRef = useRef(notify);
  const onDiscardedRef = useRef(onDiscarded);
  useEffect(() => {
    notifyRef.current = notify;
    onDiscardedRef.current = onDiscarded;
  });
  const loaded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useLayoutEffect(
    () => activateWorktreeDiscardComputer(client, computerScopeKey),
    [client, computerScopeKey],
  );
  // Cancel a lazy opening during the switch's commit, before its promise can
  // select the old computer again through the still-reused client.
  useLayoutEffect(() => {
    if (token === answered.current) {
      const pending = pendingOffer.current;
      if (
        !pending ||
        pending.token !== token ||
        pending.client !== client ||
        pending.computerScopeKey !== computerScopeKey
      ) {
        pendingOffer.current = null;
        return;
      }
      pending.active = true;
      return (): void => {
        pending.active = false;
      };
    }
    answered.current = token;
    if (!offer) return;
    if (
      !supported ||
      (offer.recovery && client.capabilities.worktreeRecovery !== true)
    ) {
      notifyRef.current(offer);
      return;
    }
    const pending = { token, client, computerScopeKey, active: true };
    pendingOffer.current = pending;
    loadPanel()
      .then((panel) =>
        pending.active
          ? panel.openWorktreeDiscard(client, offer, computerScopeKey)
          : true,
      )
      .then(
        (opened) => {
          if (pending.active && !opened) notifyRef.current(offer);
        },
        () => {
          if (pending.active) notifyRef.current(offer);
        },
      );
    return (): void => {
      pending.active = false;
    };
  }, [client, computerScopeKey, offer, supported, token]);
  if (!loaded || !supported) return null;
  const { WorktreeDiscardPanel } = loaded;
  return (
    <WorktreeDiscardPanel
      key={computerScopeKey ?? undefined}
      client={client}
      computerScopeKey={computerScopeKey}
      onDiscarded={(discarded) => onDiscardedRef.current(discarded)}
    />
  );
}

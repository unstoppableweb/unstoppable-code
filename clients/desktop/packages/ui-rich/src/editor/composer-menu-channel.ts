import { useSyncExternalStore } from 'react';
import type { ComposerMenuController } from './useComposerMenu';

/**
 * Carries a composer menu session from the editor that runs it to the menu
 * the host renders elsewhere (the `+` in its toolbar). A host whose editor
 * loads in its own chunk creates the channel, hands it to `ComposerEditor`,
 * and subscribes its menu. The editor publishes a new controller only when
 * the session changes (it opens or closes, its query, variant or highlight
 * moves), so subscribers re-render for those changes and not for keystrokes
 * that leave the session as it was; the host composer does not re-render.
 */
export interface ComposerMenuChannel {
  readonly getSnapshot: () => ComposerMenuController | null;
  readonly subscribe: (listener: () => void) => () => void;
  readonly publish: (controller: ComposerMenuController | null) => void;
}

export function createComposerMenuChannel(): ComposerMenuChannel {
  let current: ComposerMenuController | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    publish: (controller) => {
      if (controller === current) return;
      current = controller;
      for (const listener of listeners) listener();
    },
  };
}

const noChannel = (): null => null;
const noSubscription = (): (() => void) => () => undefined;

/** The session published on `channel`, or `null` before the editor runs one. */
export function useComposerMenuChannel(
  channel: ComposerMenuChannel | undefined,
): ComposerMenuController | null {
  return useSyncExternalStore(
    channel?.subscribe ?? noSubscription,
    channel?.getSnapshot ?? noChannel,
    noChannel,
  );
}

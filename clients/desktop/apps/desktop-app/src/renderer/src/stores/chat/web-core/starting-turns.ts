import { create } from 'zustand';

/**
 * Cloud chats whose sent turn may still be starting, by the store's chat key
 * (`liveReplyKey`): a send in flight, or a turn its receipt named that no
 * runtime report has named or ended yet (CAN-6592). The composer offers Stop
 * for them, as Stop cancels that turn by the receipt's id; the chat's own
 * runtime reads the turn as running only once Core names it. A turn a report
 * or snapshot names stays here until the store's own runtime runs it, as a
 * snapshot's runtime installs only once its transcript pages load; then it
 * leaves, and the turn reads running, not starting (CAN-6677).
 */
interface StartingTurnState {
  readonly byChat: Readonly<Record<string, true>>;
  readonly set: (key: string, starting: boolean) => void;
  readonly clear: () => void;
}

export const useWebCoreStartingTurnStore = create<StartingTurnState>((set) => ({
  byChat: {},
  set: (key, starting): void =>
    set((state) => {
      if ((state.byChat[key] === true) === starting) return state;
      const byChat = { ...state.byChat };
      if (starting) byChat[key] = true;
      else delete byChat[key];
      return { byChat };
    }),
  clear: (): void => set({ byChat: {} }),
}));

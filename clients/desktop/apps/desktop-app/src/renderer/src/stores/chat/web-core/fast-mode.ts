import { create } from 'zustand';

/**
 * Each cloud chat tab's fast mode, as this window set it (CAN-6322). The web
 * core does not project it, and a tab's own speed fields belong to the Codex
 * harness (hydration resets them for any other provider), so the window keeps
 * the choice here. Each send carries it as `modelConfig.fastMode` while the
 * chat's model runs fast mode; a tab with no choice sends none, so the chat
 * keeps its own.
 */
export interface WebCoreFastModeState {
  /** By the store's chat id. */
  readonly byChat: Readonly<Record<string, boolean>>;
}

export const useWebCoreFastModeStore = create<WebCoreFastModeState>(() => ({
  byChat: {},
}));

export function setWebCoreFastMode(chatId: string, on: boolean): void {
  useWebCoreFastModeStore.setState((state) => ({
    byChat: { ...state.byChat, [chatId]: on },
  }));
}

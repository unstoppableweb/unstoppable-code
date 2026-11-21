'use client';

import {
  createContext,
  createElement,
  useContext,
  type JSX,
  type ReactNode,
} from 'react';
import type { PersistedVisualReference } from '@canopy/agent-transcript/types';

export type ChatVisualOwner = {
  messageId: string;
  toolUseId: string;
  reference: PersistedVisualReference;
};

/** The provider closes over chat scope; transport and range assembly stay with the host. */
export type ChatVisualHost = {
  read(owner: ChatVisualOwner, signal: AbortSignal): Promise<Uint8Array>;
  openLink(url: string): void;
  /**
   * The key the chat's transcript publishes its visuals under, for the Chat
   * visuals panel to read. Absent where the host has no such panel.
   */
  sourceKey?: string;
  /**
   * Show the visual in the host's Chat visuals panel. Hosts without a panel
   * for this chat omit it or return false, and the visual opens in a dialog.
   * A host that places its panel asynchronously returns the outcome as a
   * promise; false or a rejection there opens the dialog too.
   */
  expand?(owner: ChatVisualOwner): boolean | Promise<boolean>;
  /**
   * A same-origin URL where this host serves the visual frame's shell
   * document. A host sets it when its own page policy would apply to an inline
   * frame and block the visual's scripts; the frame then loads from here.
   * Absent, visuals are framed inline.
   */
  frameUrl?: string;
};

const ChatVisualHostContext = createContext<ChatVisualHost | null>(null);

export function ChatVisualHostProvider({
  value,
  children,
}: {
  value: ChatVisualHost | null;
  children: ReactNode;
}): JSX.Element {
  return createElement(ChatVisualHostContext.Provider, { value }, children);
}

export function useChatVisualHost(): ChatVisualHost | null {
  return useContext(ChatVisualHostContext);
}

export const CHAT_VISUAL_TEST_IDS = Object.freeze({
  block: 'chat-visual-block',
  frame: 'chat-visual-frame',
  interactButton: 'chat-visual-interact-button',
  expandButton: 'chat-visual-expand-button',
  sourceButton: 'chat-visual-source-button',
  dialog: 'chat-visual-dialog',
  panel: 'chat-visuals-panel',
  panelItem: 'chat-visuals-panel-item',
  sourceView: 'chat-visual-source-view',
  saveButton: 'chat-visual-save-button',
  unavailableState: 'chat-visual-unavailable-state',
  errorState: 'chat-visual-error-state',
  retryButton: 'chat-visual-retry-button',
});

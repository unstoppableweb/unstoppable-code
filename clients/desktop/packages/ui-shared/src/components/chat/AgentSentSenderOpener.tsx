'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type { ChatAgentSentInfo } from '@canopy/protocol/remote-control/shell';

export type AgentSentSender = ChatAgentSentInfo['sender'];

/**
 * Opens the chat that sent an agent-sent message. Each host supplies its own
 * navigation; the title stays plain text for a sender the host cannot open.
 */
export interface AgentSentSenderOpener {
  canOpen(sender: AgentSentSender): boolean;
  open(sender: AgentSentSender): void;
}

const SenderOpenerContext = createContext<AgentSentSenderOpener | null>(null);

export function AgentSentSenderOpenerProvider({
  opener,
  children,
}: {
  opener: AgentSentSenderOpener | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <SenderOpenerContext.Provider value={opener}>
      {children}
    </SenderOpenerContext.Provider>
  );
}

export function useAgentSentSenderOpener(): AgentSentSenderOpener | null {
  return useContext(SenderOpenerContext);
}

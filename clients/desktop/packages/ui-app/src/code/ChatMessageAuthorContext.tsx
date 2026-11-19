'use client';

import type { RemoteControlChatMessage } from '@canopy/protocol/remote-control/shell';
import {
  createContext,
  type JSX,
  type ReactNode,
  useContext,
  useEffect,
} from 'react';

export type ChatMessageAuthor = NonNullable<RemoteControlChatMessage['author']>;

export interface ChatMessageAuthorResolver {
  readonly resolve: (
    message: RemoteControlChatMessage,
  ) => ChatMessageAuthor | undefined;
  readonly request: (message: RemoteControlChatMessage) => void;
}

const ChatMessageAuthorContext =
  createContext<ChatMessageAuthorResolver | null>(null);

export interface ChatMessageAuthorProviderProps {
  readonly resolver: ChatMessageAuthorResolver;
  readonly children: ReactNode;
}

export function ChatMessageAuthorProvider({
  resolver,
  children,
}: ChatMessageAuthorProviderProps): JSX.Element {
  return (
    <ChatMessageAuthorContext.Provider value={resolver}>
      {children}
    </ChatMessageAuthorContext.Provider>
  );
}

export function useChatMessageAuthor(
  message: RemoteControlChatMessage,
): ChatMessageAuthor | undefined {
  const resolver = useContext(ChatMessageAuthorContext);
  const author = resolver ? resolver.resolve(message) : message.author;

  useEffect(() => {
    if (
      resolver &&
      message.role === 'user' &&
      message.clientRequestId &&
      !message.author
    ) {
      resolver.request(message);
    }
  }, [message, resolver]);

  return author;
}

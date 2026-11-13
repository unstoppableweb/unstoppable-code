import { createContext } from 'react';

export interface ChatMarkdownFileTarget {
  projectId: string;
  worktreeId: string;
}

export const ChatMarkdownFileTargetContext =
  createContext<ChatMarkdownFileTarget | null>(null);

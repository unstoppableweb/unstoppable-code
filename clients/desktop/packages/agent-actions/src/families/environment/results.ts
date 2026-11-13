import type { CanopyQueryResult } from '@canopy/protocol/canopy-core';
import type { ModelCatalogOption } from '@canopy/protocol/models';
import type { AgentChatCreatePlacement } from '../../surface/capabilities';
import type {
  AgentChatDetail,
  AgentChatState,
  AgentModelList,
  AgentPostMessageReceipt,
  AgentStartChatReceipt,
} from '../../port/environment-port';

/*
 * Portable result DTOs. They are type aliases, not interfaces, so they are
 * assignable to AgentJson; absent values are null rather than omitted.
 */

export type AgentWorkspaceResult = {
  workspace: {
    workspaceId: string;
    name: string;
    kind: 'git' | 'cowork';
    repositories: {
      repoId: string;
      remoteUrl: string;
      defaultBranch: string | null;
    }[];
  };
};

export type AgentWorktreeListResult = {
  worktrees: {
    worktreeId: string;
    title: string;
    state: CanopyQueryResult<'core.worktree.list'>['items'][number]['state'];
    isCurrent: boolean;
  }[];
  nextCursor: string | null;
};

export type AgentChatListResult = {
  chats: {
    chatId: string;
    worktreeId: string | null;
    title: string;
    state: AgentChatState;
    modelId: string | null;
    isCurrent: boolean;
    /** False when chat.send_message cannot reach this chat. */
    messageable: boolean;
  }[];
  nextCursor: string | null;
};

export type AgentChatGetResult = {
  chat: {
    chatId: string;
    worktreeId: string | null;
    title: string;
    state: AgentChatState;
    modelId: string | null;
    lastResponse: string | null;
    /** False when chat.send_message cannot reach this chat. */
    messageable: boolean;
  };
};

export type AgentModelListResult = {
  models: {
    modelId: string;
    label: string;
    provider: ModelCatalogOption['provider'];
    available: boolean;
    isDefault: boolean;
    thinkingLevels: string[] | null;
  }[];
  defaultModelId: string | null;
};

export type AgentInlineWatcherResult =
  | { ok: true; watcherId: string }
  | { ok: false; error: { code: string; message: string } };

export type AgentChatCreateResult = {
  chatId: string;
  worktreeId: string;
  placement: AgentChatCreatePlacement;
  delivery: AgentStartChatReceipt['delivery'];
  independent: true;
  watchers: AgentInlineWatcherResult[] | null;
};

export type AgentChatSendMessageResult = {
  chatId: string;
  delivery: AgentPostMessageReceipt['delivery'];
  watchers: AgentInlineWatcherResult[] | null;
};

export function workspaceResult(
  workspace: CanopyQueryResult<'core.workspace.get'>,
): AgentWorkspaceResult {
  return {
    workspace: {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      kind: workspace.kind,
      repositories: workspace.repositorySources.map((source) => ({
        repoId: source.repoId,
        remoteUrl: source.remoteUrl,
        defaultBranch: source.defaultBranch ?? null,
      })),
    },
  };
}

export function worktreeListResult(
  page: CanopyQueryResult<'core.worktree.list'>,
  workspaceId: string,
  currentWorktreeId: string,
): AgentWorktreeListResult {
  return {
    worktrees: page.items
      .filter(
        (worktree) =>
          worktree.workspaceId === workspaceId && worktree.state !== 'archived',
      )
      .map((worktree) => ({
        worktreeId: worktree.worktreeId,
        title: worktree.name,
        state: worktree.state,
        isCurrent: worktree.worktreeId === currentWorktreeId,
      })),
    nextCursor: page.nextCursor,
  };
}

export function chatListResult(
  page: CanopyQueryResult<'core.chat.list'>,
  options: {
    workspaceId: string;
    currentChatId: string;
    includeArchived: boolean;
    unmessageableChatIds?: readonly string[];
  },
): AgentChatListResult {
  const unmessageable = new Set(options.unmessageableChatIds ?? []);
  return {
    chats: page.items
      .filter(
        (chat) =>
          chat.workspaceId === options.workspaceId &&
          (options.includeArchived || chat.state !== 'archived'),
      )
      .map((chat) => ({
        chatId: chat.chatId,
        worktreeId: chat.worktreeId,
        title: chat.title,
        state: chat.state,
        modelId: chat.modelId ?? null,
        isCurrent: chat.chatId === options.currentChatId,
        messageable: !unmessageable.has(chat.chatId),
      })),
    nextCursor: page.nextCursor,
  };
}

export function chatGetResult(chat: AgentChatDetail): AgentChatGetResult {
  return {
    chat: {
      chatId: chat.chatId,
      worktreeId: chat.worktreeId,
      title: chat.title,
      state: chat.state,
      modelId: chat.modelId,
      lastResponse: chat.lastResponse ?? null,
      messageable: chat.messageable !== false,
    },
  };
}

/**
 * Thinking levels a model declares: an empty list when it declares that it
 * supports none, null when the host does not know.
 */
export function modelThinkingLevels(
  model: ModelCatalogOption,
): string[] | null {
  const levels = model.supportedThinkingLevels ?? model.thinkingLevels;
  return levels ? [...levels] : null;
}

export function modelListResult(list: AgentModelList): AgentModelListResult {
  return {
    models: list.models.map((model) => ({
      modelId: model.id,
      label: model.label,
      provider: model.provider,
      available: model.available,
      isDefault: model.id === list.defaultModelId,
      thinkingLevels: modelThinkingLevels(model),
    })),
    defaultModelId: list.defaultModelId,
  };
}

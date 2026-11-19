/**
 * Portal access to a chat's plugin selections (CAN-3923): resolve a worktree
 * or standalone chat to its canonical scope and tab, and commit selections
 * through the trusted chat command dispatcher. Shared by the invocable
 * inventory and standalone selection adapters.
 */
import {
  PIPELINE_EDITOR_PROJECT_ID,
  type ChatCommandRequest,
  type ChatCommandResult,
  type ChatTabPluginSelections,
  type InvocableInventoryEnableRef,
  type PersistedChatTab,
  type PortalCommandEnvelope,
  type PortalInvocableChatTarget,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { appendEnableRef } from '@canopy/desktop-shared/lib/slash-invocable-inventory';
import { validateId } from '../lib/validation';
import { resolveStandaloneChatTarget } from '../services/standalone-chat-service';
import type { InvocableChatScope } from '../services/editor-service';
import { queryPortalChatState } from './chat-state-query';
import type { PortalAdapterContext } from './adapter-context';
import { isRecord } from './validation';

/** A chat named by a Portal payload; standalone chats may omit their project. */
export type PortalChatReference =
  | Extract<PortalInvocableChatTarget, { kind: 'worktree' }>
  | { kind: 'standalone'; projectLocalId?: string; chatId: string };

export interface ResolvedPortalChat {
  scope: InvocableChatScope;
  tab: PersistedChatTab;
}

/**
 * Validate an untrusted `PortalInvocableChatTarget`. Ids must pass the shared
 * validator; embedded chat scopes are not reachable through the Portal.
 */
export function readInvocableChatTarget(
  value: unknown,
): PortalInvocableChatTarget | null {
  if (!isRecord(value) || typeof value.chatId !== 'string') return null;
  try {
    validateId(value.chatId, 'chatId');
    if (
      value.kind === 'worktree' &&
      typeof value.projectId === 'string' &&
      typeof value.worktreeId === 'string'
    ) {
      validateId(value.projectId, 'projectId');
      validateId(value.worktreeId, 'worktreeId');
      if (
        isBotProjectId(value.projectId) ||
        value.projectId === PIPELINE_EDITOR_PROJECT_ID
      )
        return null;
      return {
        kind: 'worktree',
        projectId: value.projectId,
        worktreeId: value.worktreeId,
        chatId: value.chatId,
      };
    }
    if (
      value.kind === 'standalone' &&
      typeof value.projectLocalId === 'string'
    ) {
      validateId(value.projectLocalId, 'projectLocalId');
      return {
        kind: 'standalone',
        projectLocalId: value.projectLocalId,
        chatId: value.chatId,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve a chat to its canonical scope and current tab through the chat
 * state query. Fails the command and returns null when the chat is missing,
 * archived, or chat state is unavailable.
 */
export async function resolvePortalChat(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
  chat: PortalChatReference,
): Promise<ResolvedPortalChat | null> {
  let scope: InvocableChatScope;
  if (chat.kind === 'worktree') {
    scope = {
      projectId: chat.projectId,
      worktreeId: chat.worktreeId,
      standalone: false,
    };
  } else {
    const resolved = await resolveStandaloneChatTarget({
      ...(chat.projectLocalId ? { projectLocalId: chat.projectLocalId } : {}),
      chatId: chat.chatId,
    });
    if (!resolved.entryId || resolved.isArchived) {
      context.fail(command, 'not_found', 'The active chat was not found.');
      return null;
    }
    scope = {
      projectId: resolved.workspaceId,
      worktreeId: resolved.entryId,
      standalone: true,
    };
  }
  const tab = await readPortalChatTab(command, context, scope, chat.chatId);
  return tab ? { scope, tab } : null;
}

/** Read a chat's current canonical tab, failing the command when absent. */
async function readPortalChatTab(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
  scope: InvocableChatScope,
  chatId: string,
): Promise<PersistedChatTab | null> {
  let snapshot;
  try {
    snapshot = await queryPortalChatState(context, {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
    });
  } catch {
    context.fail(
      command,
      'execution_failed',
      'The chat state service is temporarily unavailable.',
      true,
    );
    return null;
  }
  const tab = snapshot.tabsFile.tabs.find(
    (candidate) =>
      candidate.id === chatId && (candidate.kind ?? 'chat') === 'chat',
  );
  if (!tab) {
    context.fail(command, 'not_found', 'The chat was not found.');
    return null;
  }
  return tab;
}

/**
 * Re-read a resolved chat's latest canonical tab, failing the command when
 * the chat is gone.
 */
export async function rereadPortalChat(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
  chat: ResolvedPortalChat,
): Promise<ResolvedPortalChat | null> {
  const tab = await readPortalChatTab(
    command,
    context,
    chat.scope,
    chat.tab.id,
  );
  return tab ? { scope: chat.scope, tab } : null;
}

/**
 * Enable one inventory item for a chat without dropping a concurrent edit.
 * The ref joins the selections of `chat.tab`, the snapshot the item was
 * resolved against, and the patch conflicts (retryably) when those
 * selections change before it commits. Returns the committed selections, or
 * null after failing the command.
 */
export async function enablePortalPluginRef(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
  chat: ResolvedPortalChat,
  enableRef: InvocableInventoryEnableRef,
): Promise<ChatTabPluginSelections | null> {
  const current = normalizePluginSelections(chat.tab.pluginSelections);
  const selections = appendEnableRef(current, enableRef);
  const committed = await commitPortalPluginSelections(
    command,
    context,
    chat,
    selections,
    current,
  );
  return committed ? selections : null;
}

/**
 * Commit a chat's own plugin selections through the migrated
 * `chat.patch_tab_settings` command. Without `expected`, the patch replaces
 * the selections like every desktop selection write (last writer wins); with
 * it, the patch conflicts unless the chat still has those selections. Returns
 * the applied (or already applied) result after the durable commit and, for a
 * standalone chat, after its summary is re-projected. Any other outcome fails
 * the command and returns null.
 */
export async function commitPortalPluginSelections(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
  chat: ResolvedPortalChat,
  selections: ChatTabPluginSelections,
  expected?: ChatTabPluginSelections,
  deferredToolsAllowed?: boolean,
): Promise<ChatCommandResult | null> {
  const dispatch = context.dispatchChatCommand;
  if (!dispatch) {
    context.fail(
      command,
      'execution_failed',
      'The chat state service is temporarily unavailable.',
      true,
    );
    return null;
  }
  let result: ChatCommandResult;
  try {
    const request: ChatCommandRequest = {
      schemaVersion: 1,
      commandId: command.id,
      projectId: chat.scope.projectId,
      worktreeId: chat.scope.worktreeId,
      origin: 'portal',
      command: {
        type: 'chat.patch_tab_settings',
        tabId: chat.tab.id,
        patch: {
          pluginSelections: selections,
          ...(deferredToolsAllowed !== undefined
            ? { deferredToolsAllowed }
            : {}),
        },
        ...(expected ? { expectedPluginSelections: expected } : {}),
      },
    };
    result = await dispatch(request);
  } catch {
    context.fail(
      command,
      'execution_failed',
      'The chat state service is temporarily unavailable.',
      true,
    );
    return null;
  }
  if (result.outcome !== 'applied' && result.outcome !== 'already_applied') {
    context.fail(
      command,
      result.outcome === 'not_found'
        ? 'not_found'
        : result.outcome === 'conflict'
          ? 'conflict'
          : 'execution_failed',
      result.reason ?? 'The plugin selections were not applied.',
      result.outcome === 'conflict',
    );
    return null;
  }
  return result;
}

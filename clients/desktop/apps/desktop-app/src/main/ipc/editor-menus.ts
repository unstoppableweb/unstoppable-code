/**
 * Composer menus and the plugin picker catalog over IPC (CAN-5985): the reads
 * Portal's editor and chat executors serve (`portal.editor.list_slash_commands`,
 * `portal.editor.list_invocables`, `portal.editor.resolve_invocable`,
 * `portal.chat.list_plugin_catalog`), for controllers that reach this computer
 * without Portal, such as a browser over direct Remote Control.
 *
 * Each read uses the same service as Portal's adapter. Resolving an invocable
 * writes no chat state: it prepares the row as the desktop composer does and
 * returns, with the insert text, the plugin selections that would enable it
 * and the selections they were computed from. The controller commits them
 * with the revisioned `chat.patch_tab_settings` command, which conflicts when
 * the chat's selections changed in between, exactly as Portal's executor
 * commits them.
 */
import type { IpcMainInvokeEvent } from 'electron';
import {
  type ChatTabPluginSelections,
  type InvocableInventoryProvider,
  type PersistedChatTab,
  type PortalEditorListInvocablesResult,
  type PortalEditorListSlashCommandsPayload,
  type PortalEditorSlashCommandOption,
  type PortalPluginCatalog,
} from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { appendEnableRef } from '@canopy/desktop-shared/lib/slash-invocable-inventory';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { validateId } from '../lib/validation';
import { readInvocableChatTarget } from '../remote-projection/chat-plugin-selections';
import {
  listChatInvocables,
  listEditorSlashCommands,
  prepareChatInvocable,
  resolveChatInvocable,
  type InvocableChatScope,
} from '../services/editor-service';
import { PortalServiceError } from '../services/portal-service-error';
import { resolveStandaloneChatTarget } from '../services/standalone-chat-service';
import type { DesktopIpcCallerResolver } from './file-tree';
import { registerIpcHandler } from './register';

/** One invocable resolved for a chat; nothing is written. */
export interface EditorResolveInvocableResult {
  readonly insertText: string;
  readonly invocationKey: string;
  /**
   * Present when the chat does not run the item yet: the chat's own
   * selections with the item appended, and the selections they extend.
   */
  readonly enable?: {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly tabId: string;
    readonly pluginSelections: ChatTabPluginSelections;
    readonly expectedPluginSelections: ChatTabPluginSelections;
  };
}

export interface EditorMenuRuntime {
  readonly dispatcher: Pick<
    DesktopCanopyDispatcher,
    'queryChatStateForLegacyIpc'
  >;
  readonly resolveCaller: DesktopIpcCallerResolver;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInvocableProvider(
  value: unknown,
): value is InvocableInventoryProvider {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'ollama' ||
    value === 'cursor' ||
    value === 'copilot' ||
    value === 'opencode'
  );
}

function invalid(message: string): never {
  throw new PortalServiceError('invalid_payload', message);
}

function readProvider(value: unknown): InvocableInventoryProvider | undefined {
  if (value === undefined) return undefined;
  if (!isInvocableProvider(value)) invalid('Invalid provider type.');
  return value;
}

interface ResolvedChat {
  readonly scope: InvocableChatScope;
  readonly tab: PersistedChatTab;
}

async function readChatTab(
  runtime: EditorMenuRuntime,
  event: IpcMainInvokeEvent,
  scope: InvocableChatScope,
  chatId: string,
): Promise<PersistedChatTab> {
  const { legacyResult } = await runtime.dispatcher.queryChatStateForLegacyIpc(
    { scope: { workspaceId: scope.projectId, worktreeId: scope.worktreeId } },
    { caller: runtime.resolveCaller(event) },
  );
  const tab = legacyResult.tabsFile.tabs.find(
    (candidate) =>
      candidate.id === chatId && (candidate.kind ?? 'chat') === 'chat',
  );
  if (!tab)
    throw new PortalServiceError('not_found', 'The chat was not found.');
  return tab;
}

/** The chat a request names, resolved to its canonical scope and tab. */
async function resolveChat(
  runtime: EditorMenuRuntime,
  event: IpcMainInvokeEvent,
  value: unknown,
): Promise<ResolvedChat> {
  const target = readInvocableChatTarget(value);
  if (!target) invalid('Invalid chat target.');
  let scope: InvocableChatScope;
  if (target.kind === 'worktree') {
    scope = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      standalone: false,
    };
  } else {
    const resolved = await resolveStandaloneChatTarget({
      projectLocalId: target.projectLocalId,
      chatId: target.chatId,
    });
    if (!resolved.entryId || resolved.isArchived)
      throw new PortalServiceError(
        'not_found',
        'The active chat was not found.',
      );
    scope = {
      projectId: resolved.workspaceId,
      worktreeId: resolved.entryId,
      standalone: true,
    };
  }
  return {
    scope,
    tab: await readChatTab(runtime, event, scope, target.chatId),
  };
}

export function registerEditorMenuHandlers(runtime: EditorMenuRuntime): void {
  registerIpcHandler<
    [PortalEditorListSlashCommandsPayload],
    { commands: PortalEditorSlashCommandOption[] }
  >(IPC_CHANNELS.editorListSlashCommands, async (event, payload) => {
    if (!isRecord(payload)) invalid('Invalid editor slash-commands payload.');
    validateId(payload.projectId, 'projectId');
    validateId(payload.worktreeId, 'worktreeId');
    const providerType = readProvider(payload.providerType);
    return {
      commands: await listEditorSlashCommands(
        {
          projectId: payload.projectId,
          worktreeId: payload.worktreeId,
          ...(providerType ? { providerType } : {}),
        },
        { caller: runtime.resolveCaller(event) },
      ),
    };
  });

  registerIpcHandler<
    [{ target: unknown; providerType?: unknown }],
    PortalEditorListInvocablesResult
  >(IPC_CHANNELS.editorListInvocables, async (event, payload) => {
    if (!isRecord(payload)) invalid('Invalid invocable list payload.');
    const providerType = readProvider(payload.providerType);
    const chat = await resolveChat(runtime, event, payload.target);
    return listChatInvocables({
      scope: chat.scope,
      tab: chat.tab,
      session: { caller: runtime.resolveCaller(event) },
      ...(providerType ? { providerType } : {}),
    });
  });

  registerIpcHandler<
    [{ target: unknown; entryId: unknown; providerType?: unknown }],
    EditorResolveInvocableResult
  >(IPC_CHANNELS.editorResolveInvocable, async (event, payload) => {
    if (
      !isRecord(payload) ||
      typeof payload.entryId !== 'string' ||
      payload.entryId.length === 0 ||
      payload.entryId.length > 1_024
    )
      invalid('Invalid invocable resolve payload.');
    const providerType = readProvider(payload.providerType);
    const chat = await resolveChat(runtime, event, payload.target);
    const entry = await prepareChatInvocable({
      tab: chat.tab,
      entryId: payload.entryId,
      ...(providerType ? { providerType } : {}),
    });
    // The text and the enabling selections use one snapshot, read after
    // preparation: a provider can name the item by its place in them.
    const latest: ResolvedChat = {
      scope: chat.scope,
      tab: await readChatTab(runtime, event, chat.scope, chat.tab.id),
    };
    const resolved = await resolveChatInvocable({ ...latest, entry });
    if (!resolved.enableRef) {
      return {
        insertText: resolved.insertText,
        invocationKey: resolved.invocationKey,
      };
    }
    const current = normalizePluginSelections(latest.tab.pluginSelections);
    return {
      insertText: resolved.insertText,
      invocationKey: resolved.invocationKey,
      enable: {
        projectId: latest.scope.projectId,
        worktreeId: latest.scope.worktreeId,
        tabId: latest.tab.id,
        pluginSelections: appendEnableRef(current, resolved.enableRef),
        expectedPluginSelections: current,
      },
    };
  });

  registerIpcHandler<[{ projectId: unknown }], PortalPluginCatalog>(
    IPC_CHANNELS.pluginCatalogList,
    async (_event, payload) => {
      if (!isRecord(payload)) invalid('Invalid plugin catalog payload.');
      validateId(payload.projectId, 'projectId');
      const { buildPluginCatalog } =
        await import('../services/plugin-catalog-service');
      return buildPluginCatalog();
    },
  );
}

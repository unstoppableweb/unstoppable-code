import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import type {
  McpServerRef,
  RewriteMcpServerRefsRequest,
  RewriteMcpServerRefsResponse,
} from '@canopy/execution-engine/types/mcp-servers';
import { bumpGlobalPluginDefaultsRevision } from '../agents/session-manager';
import {
  chatStorageScopeIds,
  readChatStorageDiscoveryIndex,
} from '../lib/chat-storage-discovery';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getAppWorkspacesRootDir, getWorkspacesRootDir } from '../lib/paths';
import { isErrnoException } from '../lib/type-guards';
import { broadcastPreferencesSynced } from '../lib/preferences-broadcast';
import {
  projectPreferencesForRuntime,
  updatePreferencesFile,
} from '../lib/preferences-store';
import { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';
import { updateWorkspacePlugins } from '../lib/workspace-plugin-defaults';
import { getChatStateService } from '../services/chat-state-service';
import {
  rewriteMcpSelections,
  rewriteMcpTombstones,
  type McpServerRefMatcher as RefMatcher,
} from './server-ref-matching';
import {
  inMcpRefRewritePhase,
  recordMcpRefRewriteFailure,
} from './server-ref-rewrite-outcome';

export const MCP_SERVER_REF_REWRITE_INCOMPLETE =
  "Couldn't point every chat on this device at the moved server. Try again.";

function rewriteChatTab(
  tab: PersistedChatTab,
  from: readonly RefMatcher[],
  to: McpServerRef,
): PersistedChatTab | null {
  const selections = tab.pluginSelections
    ? rewriteMcpSelections(tab.pluginSelections, from, to)
    : null;
  const tombstones = tab.disabledGlobalPluginSelections
    ? rewriteMcpTombstones(tab.disabledGlobalPluginSelections, from, to)
    : null;
  if (!selections && !tombstones) return null;
  return {
    ...tab,
    ...(selections ? { pluginSelections: selections } : {}),
    ...(tombstones ? { disabledGlobalPluginSelections: tombstones } : {}),
  };
}

// An index ref without a readable config id may still match, so it is kept.
function indexRefMatches(value: unknown, from: readonly RefMatcher[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const serverId: unknown = Reflect.get(value, 'serverId');
  const configId: unknown = Reflect.get(value, 'configId');
  return from.some(
    (matcher): boolean =>
      matcher.serverId === serverId &&
      (matcher.configId === undefined ||
        typeof configId !== 'string' ||
        matcher.configId === configId),
  );
}

/** Whether a discovery-index tab (untyped JSON) references the server. */
function tabReferences(
  tab: Record<string, unknown>,
  from: readonly RefMatcher[],
): boolean {
  return ['pluginSelections', 'disabledGlobalPluginSelections'].some(
    (field): boolean => {
      const value = tab[field];
      if (typeof value !== 'object' || value === null) return false;
      const refs: unknown = Reflect.get(value, 'mcpServerRefs');
      const preferences: unknown = Reflect.get(value, 'mcpHttpAuthPreferences');
      return (
        (Array.isArray(refs) &&
          refs.some((ref: unknown): boolean => indexRefMatches(ref, from))) ||
        (Array.isArray(preferences) &&
          preferences.some(
            (preference: unknown): boolean =>
              typeof preference === 'object' &&
              preference !== null &&
              indexRefMatches(Reflect.get(preference, 'target'), from),
          ))
      );
    },
  );
}

async function workspaceIds(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry): boolean => entry.isDirectory())
      .map((entry): string => entry.name);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function rewriteGlobalDefaults(
  from: readonly RefMatcher[],
  to: McpServerRef,
): Promise<boolean> {
  let changed = false;
  const preferences = await updatePreferencesFile((latest) => {
    if (!latest.globalPluginSelections) return null;
    const next = rewriteMcpSelections(latest.globalPluginSelections, from, to);
    if (!next) return null;
    changed = true;
    return { globalPluginSelections: next };
  });
  if (changed) {
    bumpGlobalPluginDefaultsRevision();
    broadcastPreferencesSynced(preferences, projectPreferencesForRuntime);
  }
  return changed;
}

/**
 * Project and Cowork defaults move through the typed plugins boundary
 * (`core.workspace.plugins.update`, CAN-3817), which rewrites the manifest
 * it reads inside the workspace's write queue.
 */
async function rewriteWorkspaceDefaults(
  workspaceId: string,
  from: readonly RefMatcher[],
  to: McpServerRef,
): Promise<boolean> {
  const { written } = await updateWorkspacePlugins({
    workspaceId,
    change: { kind: 'replaceMcpServerRefs', from, to },
    source: 'mcp_server_move',
  });
  return written;
}

async function rewriteScopeChats(
  scope: { projectId: string; worktreeId: string },
  from: readonly RefMatcher[],
  to: McpServerRef,
  tabIds: readonly string[] | null,
): Promise<number> {
  const chatState = getChatStateService();
  if (tabIds === null) {
    let rewritten = 0;
    await chatState.updateCompatibilityTabs(scope, (tabsFile) => {
      rewritten = 0;
      const tabs = tabsFile.tabs.map((tab): PersistedChatTab => {
        const next = rewriteChatTab(tab, from, to);
        if (!next) return tab;
        rewritten += 1;
        return next;
      });
      return rewritten > 0 ? { ...tabsFile, tabs } : tabsFile;
    });
    return rewritten;
  }
  let rewritten = 0;
  for (const chatId of tabIds) {
    const { updated } = await chatState.updateCompatibilityTab(
      scope,
      chatId,
      (tab): PersistedChatTab | null => rewriteChatTab(tab, from, to),
      undefined,
      { metadataOnly: true },
    );
    if (updated) rewritten += 1;
  }
  return rewritten;
}

/**
 * Saved chats go through the chat state service, the only writer of their
 * canonical storage. The read-only discovery index picks the affected tabs so
 * untouched scopes are never loaded; a scope whose index can't be read is
 * loaded in full instead of skipped.
 */
async function rewriteWorkspaceChats(
  workspaceRoot: string,
  workspaceId: string,
  from: readonly RefMatcher[],
  to: McpServerRef,
): Promise<{ rewritten: number; failedScopes: number; errors: unknown[] }> {
  let rewritten = 0;
  let failedScopes = 0;
  const errors: unknown[] = [];
  for (const scopeId of await inMcpRefRewritePhase('scopeEnumeration', () =>
    chatStorageScopeIds(workspaceRoot),
  )) {
    const tabIds = await readChatStorageDiscoveryIndex(workspaceRoot, scopeId)
      .then((index): string[] =>
        index.tabs
          .filter((tab): boolean => tabReferences(tab, from))
          .map((tab): unknown => tab.id)
          .filter((id): id is string => typeof id === 'string'),
      )
      .catch((): null => null);
    try {
      rewritten += await inMcpRefRewritePhase('chatRewrite', () =>
        rewriteScopeChats(
          { projectId: workspaceId, worktreeId: scopeId },
          from,
          to,
          tabIds,
        ),
      );
    } catch (error) {
      failedScopes += 1;
      errors.push(error);
      logMainProcessWarn('[mcp-server-ref-rewrite] chat rewrite failed', {
        workspaceId,
        scopeId,
        error,
      });
    }
  }
  return { rewritten, failedScopes, errors };
}

/**
 * Points desktop global defaults, project and cowork defaults, and saved
 * chat selections (including Bot Work Entries) at `to` instead of the servers
 * in `from`. Cloud project defaults and cloud chats are not on this device
 * and are left alone.
 */
export async function rewriteMcpServerRefs(
  request: RewriteMcpServerRefsRequest,
): Promise<RewriteMcpServerRefsResponse> {
  const from = request.from.filter(
    (matcher): boolean =>
      matcher.serverId !== request.to.serverId ||
      (matcher.configId !== undefined &&
        matcher.configId !== request.to.configId),
  );
  if (from.length === 0)
    return { globalDefaults: false, workspaces: 0, chats: 0 };
  const globalDefaults = await inMcpRefRewritePhase('globalDefaults', () =>
    rewriteGlobalDefaults(from, request.to),
  );
  const root = getWorkspacesRootDir();
  let workspaces = 0;
  let chats = 0;
  let failures = 0;
  const errors: unknown[] = [];
  for (const workspaceId of await inMcpRefRewritePhase(
    'workspaceEnumeration',
    () => workspaceIds(root),
  )) {
    // Only real projects: read-only viewer scopes and stray folders have no
    // readable project config.
    const { authority } = await inMcpRefRewritePhase('workspaceRead', () =>
      readWorkspaceConfigDetailed(workspaceId),
    );
    if (authority !== 'ok') continue;
    try {
      if (
        await inMcpRefRewritePhase('workspaceDefaults', () =>
          rewriteWorkspaceDefaults(workspaceId, from, request.to),
        )
      )
        workspaces += 1;
      const result = await rewriteWorkspaceChats(
        join(root, workspaceId),
        workspaceId,
        from,
        request.to,
      );
      chats += result.rewritten;
      failures += result.failedScopes;
      errors.push(...result.errors);
    } catch (error) {
      failures += 1;
      errors.push(error);
      logMainProcessWarn('[mcp-server-ref-rewrite] project rewrite failed', {
        workspaceId,
        error,
      });
    }
  }
  // Bots live outside the project registry. They still retain selected MCP
  // refs, and must be rewritten before the caller can retire the old server.
  const appRoot = getAppWorkspacesRootDir();
  for (const botProjectId of await inMcpRefRewritePhase(
    'workspaceEnumeration',
    () => workspaceIds(appRoot),
  )) {
    if (!isBotProjectId(botProjectId)) continue;
    const result = await rewriteWorkspaceChats(
      join(appRoot, botProjectId),
      botProjectId,
      from,
      request.to,
    );
    chats += result.rewritten;
    failures += result.failedScopes;
    errors.push(...result.errors);
  }
  // A caller removes the old server once this resolves, so a reference left
  // behind must fail the rewrite rather than dangle.
  if (failures > 0) {
    throw recordMcpRefRewriteFailure(
      new Error(MCP_SERVER_REF_REWRITE_INCOMPLETE),
      'rewrite',
      'rewriteIncomplete',
      errors,
    );
  }
  return { globalDefaults, workspaces, chats };
}

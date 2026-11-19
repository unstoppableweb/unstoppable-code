import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { useMemo } from 'react';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import {
  hasMcpServerRef,
  withMcpServerAccount,
  withMcpServerRef,
  withoutMcpServerRef,
  type McpServerSelectionRef,
} from '@canopy/ui-app/capability';
import { flattenMcpServerRows } from '@canopy/desktop-shared/lib/mcp-server-rows';
import type { McpWorkspaceDefaultsChoice } from '@canopy/ui-app';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { createEmptySelections } from '@/lib/pluginSelections';

export interface WorkspaceDefaultTarget {
  id: string;
  name: string;
}

/** The workspace the user is currently in, or null outside one. */
export function useWorkspaceDefaultTarget(): WorkspaceDefaultTarget | null {
  const projectId = useChatStore(
    (state): string | undefined => state.selectedWorktree?.projectId,
  );
  const name = useProjectsStore(
    (state): string | undefined =>
      state.projects.find((project): boolean => project.id === projectId)?.name,
  );
  return useMemo(
    (): WorkspaceDefaultTarget | null =>
      projectId !== undefined && name !== undefined
        ? { id: projectId, name }
        : null,
    [projectId, name],
  );
}

/**
 * Every project a server can be on by default, the current one first, with
 * whether its default plugins already include the server. Temporary
 * workspaces are left out: they are not somewhere a user sets defaults.
 */
export function useMcpWorkspaceDefaultChoices(
  ref: McpServerSelectionRef | null,
): McpWorkspaceDefaultsChoice[] {
  const currentId = useChatStore(
    (state): string | undefined => state.selectedWorktree?.projectId,
  );
  const projects = useProjectsStore((state) => state.projects);
  const serverId = ref?.serverId;
  const configId = ref?.configId;
  return useMemo((): McpWorkspaceDefaultsChoice[] => {
    if (serverId === undefined || configId === undefined) return [];
    const choices = projects.flatMap((project): McpWorkspaceDefaultsChoice[] =>
      project.type === 'multi-repo' && project.temporary === true
        ? []
        : [
            {
              id: project.id,
              name: project.name,
              enabled: hasMcpServerRef(project.defaultPluginSelections, {
                serverId,
                configId,
              }),
            },
          ],
    );
    const current = choices.find((choice): boolean => choice.id === currentId);
    return current
      ? [current, ...choices.filter((choice): boolean => choice !== current)]
      : choices;
  }, [configId, currentId, projects, serverId]);
}

const workspaceDefaultsWrites = new Map<string, Promise<void>>();

/**
 * Each change reads the defaults the previous one left behind: a change
 * computed from the same stale copy would overwrite the other.
 */
function updateWorkspaceMcpDefaults(
  workspaceId: string,
  update: (current: ChatTabPluginSelections) => ChatTabPluginSelections,
): Promise<void> {
  const next = (workspaceDefaultsWrites.get(workspaceId) ?? Promise.resolve())
    .catch((): void => undefined)
    .then((): Promise<void> => writeWorkspaceMcpDefaults(workspaceId, update));
  workspaceDefaultsWrites.set(workspaceId, next);
  const settle = (): void => {
    if (workspaceDefaultsWrites.get(workspaceId) === next)
      workspaceDefaultsWrites.delete(workspaceId);
  };
  next.then(settle, settle);
  return next;
}

async function writeWorkspaceMcpDefaults(
  workspaceId: string,
  update: (current: ChatTabPluginSelections) => ChatTabPluginSelections,
): Promise<void> {
  const workspace = useProjectsStore
    .getState()
    .projects.find((project): boolean => project.id === workspaceId);
  if (!workspace) throw new Error('Project not found');
  const current = workspace.defaultPluginSelections ?? createEmptySelections();
  const defaultPluginSelections = update(current);
  if (defaultPluginSelections === current) return;
  const request = { projectId: workspaceId, defaultPluginSelections };
  if (workspace.type === 'cowork') {
    const standalone = useStandaloneChatStore.getState();
    if (standalone.chatProjects.some((project) => project.id === workspaceId))
      await standalone.updateChatProject(request);
    else await window.api.chatProject.update(request);
  } else if (workspace.type === 'multi-repo') {
    await window.api.saveWorkspaceDefaultPlugins(request);
  } else {
    await window.api.saveProjectDefaultPlugins(request);
  }
  await useProjectsStore.getState().loadProjects({ silent: true });
}

/** Adds one MCP server to a workspace's default plugins, once. */
export function addMcpServerToWorkspaceDefaults(
  workspaceId: string,
  ref: McpServerSelectionRef,
): Promise<void> {
  return updateWorkspaceMcpDefaults(workspaceId, (current) =>
    withMcpServerRef(current, ref),
  );
}

/**
 * The configurations of the person's other accounts of `ref`'s connector,
 * from the MCP index; none when they hold one account of it, or the index
 * can't be read.
 */
async function otherAccountConfigIds(
  ref: McpServerSelectionRef,
): Promise<string[]> {
  try {
    const index = await window.mcpServers.loadIndex();
    return flattenMcpServerRows(index.servers).flatMap((row) =>
      row.scope === 'account' &&
      row.accountConnection?.serverKey === ref.serverId &&
      row.accountConnection.configId !== ref.configId
        ? [row.accountConnection.configId]
        : [],
    );
  } catch (error) {
    // Without the index the account is added beside the others, as before.
    reportClientAppError(error);
    return [];
  }
}

/**
 * Adds one account of a connector to a workspace's default plugins and drops
 * the connector's other accounts there (CAN-6229): new chats in the project
 * start with the account chosen for it. A connector held once is added as by
 * {@link addMcpServerToWorkspaceDefaults}.
 */
export async function addMcpAccountToWorkspaceDefaults(
  workspaceId: string,
  ref: McpServerSelectionRef,
): Promise<void> {
  const others = await otherAccountConfigIds(ref);
  return updateWorkspaceMcpDefaults(workspaceId, (current) =>
    withMcpServerAccount(current, ref, others),
  );
}

/** Removes one MCP server from a workspace's default plugins. */
export function removeMcpServerFromWorkspaceDefaults(
  workspaceId: string,
  ref: McpServerSelectionRef,
): Promise<void> {
  return updateWorkspaceMcpDefaults(workspaceId, (current) =>
    withoutMcpServerRef(current, ref),
  );
}

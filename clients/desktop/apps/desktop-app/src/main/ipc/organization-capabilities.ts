import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { chatSurfaceUsesGlobalPluginDefaults } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import type { OrganizationLayerView } from '@canopy/desktop-shared/lib/organization-capabilities';
import {
  organizationAgentAllowed,
  organizationPipelinesFor,
  organizationLayerForWorkspace,
  subscribeOrganizationLayerChanged,
  watchOrganizationAgentsFlag,
} from '../organization-capabilities/service';
import { setOrganizationAgentGate } from '../organization-capabilities/agent-gate';
import { setOrganizationPipelineLookup } from '../organization-capabilities/pipeline-gate';
import { resolveCachedConnectorScope } from '../plugins/connector-scope';
import { pluginDefaultsWorkspaceId } from '../plugins/plugin-defaults-revision';
import { sendToWebContents } from '../lib/web-contents-send';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';

/**
 * The organization layer a chat of `projectId`/`worktreeId` inherits, as its
 * turn resolves it (CAN-6237): the same read, cache and account binding, so
 * the composer and the pickers show what the turn loads.
 */
export async function readOrganizationLayerView(
  projectId: string,
  worktreeId: string,
): Promise<OrganizationLayerView | null> {
  // App-managed surfaces take no workspace layers.
  if (!chatSurfaceUsesGlobalPluginDefaults(projectId)) return null;
  const target = { projectId, worktreeId };
  const layer = await organizationLayerForWorkspace(
    pluginDefaultsWorkspaceId(target),
    await resolveCachedConnectorScope(target),
  ).catch(() => undefined);
  return layer
    ? {
        organizationId: layer.allowed.organizationId,
        layer: layer.layer,
        items: layer.items,
      }
    : null;
}

export function registerOrganizationCapabilitiesHandlers(): void {
  registerIpcHandler<[unknown, unknown], OrganizationLayerView | null>(
    IPC_CHANNELS.organizationCapabilitiesGetLayer,
    async (_event, projectId, worktreeId) => {
      validateId(projectId, 'project id');
      validateId(worktreeId, 'worktree id');
      return readOrganizationLayerView(projectId, worktreeId);
    },
  );
  watchOrganizationAgentsFlag();
  setOrganizationAgentGate(organizationAgentAllowed);
  setOrganizationPipelineLookup(organizationPipelinesFor);
  subscribeOrganizationLayerChanged((workspaceId) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed())
        sendToWebContents(
          window.webContents,
          IPC_CHANNELS.organizationCapabilitiesLayerChanged,
          workspaceId,
        );
  });
}

import type { BrowserWindow } from 'electron';
import {
  CoreChatLifecycleResultSchema,
  CoreChatUpdateParamsSchema,
} from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  askPersonToConfirm,
  type RequestPersonAnswers,
} from '../lib/ask-user-outcomes';
import { sendToWebContents } from '../lib/web-contents-send';
import { getWorkspaceScopingContext } from '../lib/workspace-context-service';
import type { AdvisorChatReadHost } from './advisor-chat-reads';
import type { AdvisorSharingActionHost } from './advisor-sharing-actions';

/** The organization the window's sidebar scopes to, if one. */
export function selectedOrganizationId(): string | undefined {
  const context = getWorkspaceScopingContext();
  return context?.kind === 'organization' ? context.organizationId : undefined;
}

/**
 * The account's own memberships: the workspace context's list is empty while
 * the organization-projects rollout is off.
 */
export async function memberOrganizationIds(): Promise<ReadonlySet<string>> {
  const { loadCanopyCloudAccount } =
    await import('../lib/canopy-cloud-account-store');
  const account = await loadCanopyCloudAccount();
  return new Set(
    (account?.organizations ?? []).map((organization) => organization.id),
  );
}

const PUBLISH_PUBLIC_LINK = 'Publish public link';
const KEEP_PRIVATE = 'Keep it private';

/**
 * The main owners behind App Advisor's sharing actions (CAN-6003): the
 * window's agent, plan and run sharing owners on the hosted clients, the
 * window's organization context and memberships, the stored chat tabs, this
 * chat's AskUserQuestion, and core.chat.update as the advisor chat with only
 * core.chat.write for a run's sharedRun marker.
 */
export function mainAdvisorSharingActionHost(options: {
  chatId: string;
  idempotencyKey: string;
  getWindow: () => BrowserWindow | null;
  readTabs: AdvisorChatReadHost['readTabs'];
  requestUserAnswers: RequestPersonAnswers;
}): AdvisorSharingActionHost {
  let markerWrites = 0;
  return {
    selectedOrganizationId,
    memberOrganizationIds,
    planExists: async (projectId, worktreeId, planId) => {
      const { getTrackedPlan } = await import('../lib/plan-persistence');
      return (await getTrackedPlan(projectId, worktreeId, planId)) !== null;
    },
    planShared: async (projectId, worktreeId, planId) => {
      const { getTrackedPlan } = await import('../lib/plan-persistence');
      return (
        (await getTrackedPlan(projectId, worktreeId, planId))?.share !==
        undefined
      );
    },
    readChat: async (target) => {
      const stored = await options.readTabs(
        target.projectId,
        target.worktreeId,
      );
      const live = stored?.tabs.find((tab) => tab.id === target.chatId);
      if (live) return live;
      const { getChatStateService } =
        await import('../services/chat-state-service');
      const archives = await getChatStateService().getCompatibilityArchives({
        projectId: target.projectId,
        worktreeId: target.worktreeId,
      });
      return archives.archived.some((entry) => entry.tab.id === target.chatId)
        ? { archived: true }
        : null;
    },
    importSharedAgent: async (agentId) => {
      const { importSharedAgentForWindow } =
        await import('../ipc/agent-models');
      return importSharedAgentForWindow(
        { agentId, installMissing: true },
        options.getWindow,
      );
    },
    deleteSharedAgent: async (agentId) => {
      const { deleteSharedAgentForWindow } =
        await import('../ipc/agent-models');
      await deleteSharedAgentForWindow({ agentId }, options.getWindow);
    },
    publishAgentPublicShare: async (agentId) => {
      const { publishAgentPublicShareForWindow } =
        await import('../ipc/agent-models');
      return publishAgentPublicShareForWindow(agentId);
    },
    revokeAgentPublicShare: async (agentId) => {
      const { revokeAgentPublicShareForWindow } =
        await import('../ipc/agent-models');
      await revokeAgentPublicShareForWindow(agentId);
    },
    announceAgentsChanged: () => {
      const window = options.getWindow();
      if (window && !window.isDestroyed())
        sendToWebContents(window.webContents, IPC_CHANNELS.agentsChanged);
    },
    confirmPublicShare: (agentId) =>
      askPersonToConfirm(
        options.requestUserAnswers,
        `Publish a public link to the agent ${agentId}? Anyone with the link can read and import it.`,
        { confirm: PUBLISH_PUBLIC_LINK, decline: KEEP_PRIVATE },
      ),
    sharePlan: async (request) => {
      const { shareTrackedPlanForWindow } = await import('../ipc/plans');
      return shareTrackedPlanForWindow(request);
    },
    shareRun: async (request) => {
      const { shareRunForWindow } = await import('../ipc/runs');
      return shareRunForWindow(request);
    },
    unsharePlan: async (request) => {
      const { unshareTrackedPlanForWindow } = await import('../ipc/plans');
      return unshareTrackedPlanForWindow(request);
    },
    unshareRun: async (target) => {
      const { unshareRunForWindow } = await import('../ipc/runs');
      return unshareRunForWindow(target);
    },
    setSharedRunMarker: async (target, sharedRun) => {
      markerWrites += 1;
      const idempotencyKey = `${options.idempotencyKey}:shared-run:${markerWrites}`;
      const result = CoreChatLifecycleResultSchema.parse(
        await getActiveDesktopRuntime().instruction(
          'core.chat.update',
          CoreChatUpdateParamsSchema.parse({
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            commandId: idempotencyKey,
            origin: 'desktop',
            action: {
              type: 'chat.patch_tab_settings',
              tabId: target.chatId,
              patch: { sharedRun },
            },
            _meta: { idempotencyKey },
          }),
          {
            caller: {
              principalId: 'local-desktop-user',
              clientInstanceId: `agent-action:${options.chatId}`,
              authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
              interfaceKind: 'mcp',
              grants: ['core.chat.write'],
            },
            metadata: { idempotencyKey },
          },
        ),
      );
      if (result.outcome !== 'applied' && result.outcome !== 'already_applied')
        throw new Error("The chat's shared run could not be updated.");
    },
  };
}

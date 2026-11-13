import type { AdvisorAutomationSharingHost } from './advisor-automation-sharing-actions';
import {
  memberOrganizationIds,
  selectedOrganizationId,
} from './advisor-sharing-actions-host';
import { mainPipelineReadPort } from './pipeline-read-port';

/**
 * The owners behind App Advisor's automation sharing actions (CAN-6003 part
 * B): the window's automation handlers, the signed-in account's
 * capabilities, the workflow reads over Electron main's owners, and the
 * window's organization context and memberships.
 */
export function mainAdvisorAutomationSharingHost(): AdvisorAutomationSharingHost {
  return {
    selectedOrganizationId,
    memberOrganizationIds,
    list: async () =>
      (await import('../ipc/automations')).listAutomationsForCaller(),
    getShared: async (automationId) =>
      (await import('../ipc/automations')).getSharedAutomationForCaller(
        automationId,
      ),
    listShared: async (request) =>
      (await import('../ipc/automations')).listSharedAutomationsForCaller(
        request,
      ),
    createShared: async (request) =>
      (await import('../ipc/automations')).createSharedAutomationForCaller(
        request,
      ),
    updateShared: async (request) =>
      (await import('../ipc/automations')).updateSharedAutomationForCaller(
        request,
      ),
    deleteShared: async (request) =>
      (await import('../ipc/automations')).deleteSharedAutomationForCaller(
        request,
      ),
    accountCapabilities: async () =>
      (
        await (
          await import('../lib/canopy-cloud-account-store')
        ).loadCanopyCloudAccount()
      )?.capabilities ?? [],
    pipelines: mainPipelineReadPort,
  };
}

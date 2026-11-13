import type { PipelineReadPort } from '@canopy/desktop-shared/lib/automation-share/port';
import { isRetiredTemporaryWorkspace } from '@canopy/desktop-shared/lib/workspace-visibility';

/**
 * Reading an automation's workflow in Electron main (CAN-6003): the owners
 * the window's pipeline, worktree, project and automation handlers call.
 */
export const mainPipelineReadPort: PipelineReadPort = {
  pipelines: {
    list: async () =>
      (await import('../pipelines/pipeline-handlers')).listPipelinesForCaller(),
    get: async (request) =>
      (await import('../pipelines/pipeline-handlers')).getPipelineForCaller(
        request,
      ),
    getShared: async (request) =>
      (
        await import('../pipelines/pipeline-handlers')
      ).getSharedPipelineForCaller(request),
    discoverProject: async (cwd) =>
      (
        await import('../pipelines/pipeline-handlers')
      ).discoverProjectPipelinesForCaller(cwd),
  },
  api: {
    getWorktreePath: async (request) =>
      (await import('../ipc/open-in')).getWorktreePathForCaller(request),
    // The projects the window lists: retired temporary workspaces are hidden.
    loadProjects: async () => {
      const file = await (
        await import('../lib/sidebar-items')
      ).readAllSidebarItems();
      return {
        ...file,
        items: file.items.filter((item) => !isRetiredTemporaryWorkspace(item)),
      };
    },
    getWorkspaceSettingsData: async (request) =>
      (await import('../ipc/workspaces')).readWorkspaceSettingsDataForCaller(
        request,
      ),
    automations: {
      resolveSharedPipelineInstallPin: async (request) =>
        (await import('../ipc/automations')).resolveSharedPipelinePinForCaller(
          request,
        ),
    },
  },
};

import type { AgentArtifactNavigationRequest } from '@canopy/desktop-shared/types';
import { normalizeCapabilityHttpsUrl } from '@canopy/protocol/agent-artifacts';
import { unifiedEntryIdForRef } from '@canopy/ui-app/capability';
import { requestAgentEditor } from '@/lib/agents/agent-editor-request';
import { useNavigationStore } from '@/stores/navigationStore';
import { useGitHubStore } from '@/stores/githubStore';
import { detectChatStoreSurface } from '@/stores/chat/surface';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { readRemoteControlContext } from '@/stores/remoteControlStore';

export async function openAgentArtifactNavigation(
  target: AgentArtifactNavigationRequest,
): Promise<void> {
  try {
    // A window showing another computer cannot use that computer's browser
    // channels; its own link handler opens the page on this computer.
    if (
      target.kind === 'github_workflow_run' &&
      readRemoteControlContext().mode === 'remote'
    ) {
      window.open(target.htmlUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    if (detectChatStoreSurface() === 'app-advisor') {
      const response = await window.api.appAdvisor.openAgentArtifact(target);
      if (!response.ok) {
        useGitHubStore.getState().addToast(response.error.message, 'error');
      }
      return;
    }
    const navigation = useNavigationStore.getState();
    switch (target.kind) {
      case 'pipeline_editor': {
        if (target.source === 'shared' && target.sharedRemoteId) {
          navigation.openPipelineEdit({
            pipelineId: null,
            sharedRemoteId: target.sharedRemoteId,
          });
          return;
        }
        if (
          target.source === 'project' &&
          target.projectId &&
          target.worktreeId
        ) {
          const cwd = await window.api.getWorktreePath({
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            ...(target.repoId ? { repoId: target.repoId } : {}),
          });
          const result = await window.pipelines.discoverProject(cwd);
          const pipeline = result.data?.find(
            (candidate) => candidate.id === target.pipelineId,
          );
          if (!result.success || !pipeline?.filePath) {
            throw new Error(
              result.error ??
                `Project workflow ${target.pipelineId} not found.`,
            );
          }
          navigation.openPipelineEdit({
            pipelineId: target.pipelineId,
            cwd,
            filePath: pipeline.filePath,
          });
          return;
        }
        navigation.openPipelineEdit({ pipelineId: target.pipelineId });
        return;
      }
      case 'pipeline_execution':
        // The run's own panel in its owner's layout; the receipt's owner is a
        // hint the opener checks against the run. Failures are toasted there.
        await openPipelineExecutionFromUi({
          executionId: target.executionId,
          owner: { projectId: target.projectId, worktreeId: target.worktreeId },
          ...(target.jobId ? { target: { jobId: target.jobId } } : {}),
        });
        return;
      case 'installed_skill':
        navigation.openSkillViewer({
          kind: 'installed',
          sourceId: target.sourceId,
          skillName: target.skillName,
          ...(target.filePath ? { filePath: target.filePath } : {}),
        });
        return;
      case 'shared_skill':
        navigation.openSkillViewer({
          kind: 'shared',
          skillId: target.skillId,
        });
        return;
      case 'automation_editor':
        navigation.openAutomationEdit({
          activityId: target.activityId,
          ...(target.section ? { section: target.section } : {}),
          ...(target.runId ? { runId: target.runId } : {}),
        });
        return;
      case 'agent_editor':
        requestAgentEditor(target.agentId);
        return;
      case 'shared_agent':
        navigation.openPluginsNavigation({
          kind: 'entry-detail',
          entryId: `agent:shared:${target.agentId}`,
        });
        return;
      case 'capability_entry': {
        const entryId = unifiedEntryIdForRef(target.entry);
        if (!entryId) throw new Error('This item cannot be opened here.');
        navigation.openPluginsNavigation({ kind: 'entry-detail', entryId });
        return;
      }
      case 'external_url': {
        // Opened in the browser only after the same HTTPS checks the receipt
        // passed; nothing is fetched here.
        const url = normalizeCapabilityHttpsUrl(target.url);
        if (!url) throw new Error('This link cannot be opened.');
        await window.api.browser.openLink({ url });
        return;
      }
      case 'github_workflow_run':
        // No in-app destination: GitHub's own run page opens in the browser.
        await window.api.browser.openLink({ url: target.htmlUrl });
    }
  } catch (cause) {
    useGitHubStore
      .getState()
      .addToast(
        cause instanceof Error ? cause.message : 'Unable to open artifact.',
        'error',
        undefined,
        { caught: cause },
      );
  }
}

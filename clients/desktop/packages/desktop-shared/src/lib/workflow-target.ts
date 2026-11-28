import { APP_ADVISOR_BOT_ID } from '@canopy/protocol/chat-targets';
import {
  projectWorkflowTarget,
  workflowTargetsBot,
  type WorkflowTarget,
} from '@canopy/pipeline-interop/workflow-target';
import type { AutomationAction, AutomationsListResponse } from '../types';

export const WORKFLOW_BOT_FILTER_UNCLASSIFIED_WARNING: string =
  'Shared or catalog workflows with unavailable targets are unclassified and excluded from the Bot filter.';

export function nativeAutomationTarget(
  action: AutomationAction,
): WorkflowTarget | undefined {
  switch (action.type) {
    case 'app_advisor_prompt':
      return { kind: 'bot', botId: APP_ADVISOR_BOT_ID };
    case 'standalone_prompt':
      return projectWorkflowTarget(action.chatProjectId, action.workEntryId);
    case 'worktree_prompt':
      return projectWorkflowTarget(
        action.workspaceId,
        action.existingWorktreeId,
      );
    case 'worktree_session_prompt':
      return projectWorkflowTarget(action.workspaceId, action.worktreeId);
    case 'pipeline_execution_resume':
      return { kind: 'none' };
    case 'worktree_pipeline':
      return undefined;
  }
}

export function filterAutomationTargets(
  snapshot: AutomationsListResponse,
  targetBotId: string | undefined,
): AutomationsListResponse {
  if (targetBotId === undefined) return snapshot;
  const activities = snapshot.activities.filter((activity) =>
    workflowTargetsBot(activity.target, targetBotId),
  );
  const matchingIds = new Set(activities.map((activity) => activity.id));
  return {
    activities,
    recentRuns: snapshot.recentRuns.filter((run) =>
      matchingIds.has(run.activityId),
    ),
  };
}

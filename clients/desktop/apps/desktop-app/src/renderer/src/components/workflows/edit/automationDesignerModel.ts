import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { describeFiveFieldCron } from '@canopy/ui-shared/lib';
import {
  formatOneTimeTrigger,
  type WorkflowDesignerActionKind,
} from '@canopy/ui-app/workflows';
import type { FormState } from '../../automations/form/automationFormState';
import type { PipelineEditDeepLink } from '@/stores/navigationStore';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import type { useProjectsStore } from '@/stores/projectsStore';

type Project = ReturnType<typeof useProjectsStore.getState>['projects'][number];

/** What an automation's action card shows, read from its form state. */
export interface AutomationActionCardModel {
  readonly action: WorkflowDesignerActionKind;
  readonly title: string;
  readonly detail?: string;
  /** The workflow it runs, when it can be opened. */
  readonly workflow?: PipelineEditDeepLink;
  /** The paused run it resumes. */
  readonly executionId?: string;
  readonly addBlockedReason: string;
}

const ONE_ACTION =
  'An automation does one thing. To run more steps, have it run a workflow.';
const ONE_RUN = 'It resumes one paused run, so nothing can follow it.';

/** A prompt's first line, which the card's title truncates. */
function promptTitle(prompt: string): string {
  const line = prompt
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '');
  return line ?? 'No prompt yet';
}

function projectName(
  projects: readonly Project[],
  id: string,
): string | undefined {
  const project = projects.find((candidate) => candidate.id === id);
  return project ? getWorkspaceDisplayName(project) : undefined;
}

/**
 * The workflow a pipeline automation runs, as the editor opens it: only a
 * stored or shared one the record names. A project's workflow lives in one
 * checkout the record doesn't name, and a record with no source may be one,
 * so neither is opened from here.
 */
function workflowLink(state: FormState): PipelineEditDeepLink | undefined {
  if (state.pipelineId === '') return undefined;
  const source = state.pipelineSource;
  if (source === 'user' || source === 'bundled' || source === 'curated')
    return { pipelineId: state.pipelineId, source };
  const remoteId = state.sharedPipeline?.remoteId;
  if (source === 'shared' && remoteId !== undefined)
    return { pipelineId: state.pipelineId, sharedRemoteId: remoteId };
  return undefined;
}

/**
 * The action card for an automation (CAN-4224 phase 06). It follows the
 * draft, so switching between a chat and a workflow redraws it.
 */
export function automationActionCard(
  state: FormState,
  activity: ScheduledActivity | null,
  projects: readonly Project[],
): AutomationActionCardModel {
  const saved = activity?.action;
  if (saved?.type === 'pipeline_execution_resume') {
    return {
      action: 'resume-run',
      title: saved.pipelineName,
      ...(saved.workspaceName !== undefined
        ? { detail: saved.workspaceName }
        : {}),
      executionId: saved.executionId,
      addBlockedReason: ONE_RUN,
    };
  }
  const detailOf = (id: string): { readonly detail?: string } => {
    const name = projectName(projects, id);
    return name === undefined ? {} : { detail: name };
  };
  switch (state.actionType) {
    case 'app_advisor_prompt':
      return {
        action: 'start-chat',
        title: promptTitle(state.prompt),
        detail: ORCHESTRATOR_LABEL,
        addBlockedReason: ONE_ACTION,
      };
    case 'worktree_prompt':
      return {
        action: 'start-chat',
        title: promptTitle(state.prompt),
        ...detailOf(state.workspaceId),
        addBlockedReason: ONE_ACTION,
      };
    case 'standalone_prompt': {
      const place = detailOf(state.chatProjectId);
      return {
        action: 'start-chat',
        title: promptTitle(state.prompt),
        detail: place.detail ?? 'No project',
        addBlockedReason: ONE_ACTION,
      };
    }
    case 'worktree_session_prompt': {
      // Its chat is the session target, not the form's project.
      const target = state.worktreeSessionTarget;
      const place =
        target === undefined
          ? undefined
          : (projectName(projects, target.workspaceId) ?? target.workspaceName);
      const chat = target?.chatTitle;
      const detail =
        place !== undefined && chat !== undefined
          ? `${place} · ${chat}`
          : (chat ?? place);
      return {
        action: 'send-message',
        title: promptTitle(state.prompt),
        ...(detail !== undefined ? { detail } : {}),
        addBlockedReason: ONE_ACTION,
      };
    }
    case 'worktree_pipeline': {
      const workflow = workflowLink(state);
      return {
        action: 'run-workflow',
        title:
          state.pipelineName.trim() ||
          (state.pipelineId === '' ? 'Choose a workflow' : state.pipelineId),
        ...detailOf(state.workspaceId),
        ...(workflow ? { workflow } : {}),
        addBlockedReason: ONE_ACTION,
      };
    }
    case 'pipeline_execution_resume':
      // Only a saved record resumes a run, which returned above.
      return {
        action: 'resume-run',
        title: state.name,
        addBlockedReason: ONE_RUN,
      };
  }
}

/** The trigger card's title: when the draft runs, as the Library says it. */
export function automationTriggerTitle(
  state: FormState,
  locale?: string,
): string {
  if (state.triggerKind === 'cron') {
    const expression = state.cronExpression.trim();
    if (expression === '') return 'Choose a schedule';
    // An expression with no plain-language form is typed text, which can be
    // a pasted crontab line: the card never echoes it.
    return describeFiveFieldCron(expression) ?? 'Custom schedule';
  }
  if (state.oneTimeDate === '' || state.oneTimeTime === '')
    return 'Choose a time';
  const runAt = new Date(
    `${state.oneTimeDate}T${state.oneTimeTime}:00`,
  ).getTime();
  const text = formatOneTimeTrigger(runAt, locale);
  return text === '' ? 'Choose a time' : `Once, ${text}`;
}

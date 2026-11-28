import { randomUUID } from 'node:crypto';
import {
  parseProjectMessageControlAction,
  type ProjectsScheduleMessageAction,
  type ScheduledMessageReceipt,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import {
  getNextAutomationTriggerRun,
  validateAutomationTrigger,
} from '@canopy/desktop-shared/lib/automations';
import {
  type AutomationTrigger,
  type ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import {
  canonicalSource,
  AgentChatSendError,
  type AgentChatSendContext,
} from './send-orchestration';
import {
  buildAgentSenderRequest,
  isAgentSenderContextError,
} from './sender-context';
import { resolveAuthorizedChat } from '../project-discovery/chat-target';
import { DiscoveryError } from '../project-discovery/errors';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import { getAutomationsService } from '../automations/service';
import {
  AUTOMATION_TURN_SCHEDULE_ERROR,
  refusesAutomationTurnScheduleMutation,
} from '../automations/schedule-mutation-policy';

/**
 * Capture trusted sender facts once; the automation revalidates them at
 * delivery. A root sender's admission is read now and again at delivery.
 */
export async function dispatchAgentChatSchedule(
  action: ProjectsScheduleMessageAction,
  context: Pick<AgentChatSendContext, 'caller' | 'admission'>,
): Promise<{ receipt: ScheduledMessageReceipt; activity: ScheduledActivity }> {
  try {
    return await scheduleMessage(action, context);
  } catch (error) {
    if (isAgentSenderContextError(error)) {
      const hidden =
        error.code === 'owner_boundary' ||
        error.code === 'authorization_conflict';
      throw new AgentChatSendError(
        hidden ? 'not_found' : error.code,
        hidden ? 'The target chat is not available.' : error.message,
      );
    }
    if (error instanceof DiscoveryError)
      throw new AgentChatSendError(
        error.code === 'advisor_access_disabled'
          ? 'advisor_access_disabled'
          : 'not_found',
        'The target chat is not available.',
      );
    throw error;
  }
}

async function scheduleMessage(
  input: ProjectsScheduleMessageAction,
  context: Pick<AgentChatSendContext, 'caller' | 'admission'>,
): Promise<{ receipt: ScheduledMessageReceipt; activity: ScheduledActivity }> {
  const trustedCaller = context.caller;
  const parsed = parseProjectMessageControlAction(input);
  if (!parsed.ok)
    throw new AgentChatSendError('validation_failed', parsed.message);
  if (parsed.action.type !== 'projects.schedule_message')
    throw new AgentChatSendError(
      'validation_failed',
      'Expected projects.schedule_message.',
    );
  const action = parsed.action;
  // A run sends now or not at all; scheduling stays an agent action.
  if (trustedCaller.kind === 'pipeline')
    throw new AgentChatSendError(
      'unsupported_action',
      'A pipeline cannot schedule a message.',
    );
  if (await refusesAutomationTurnScheduleMutation(trustedCaller.source))
    throw new AgentChatSendError(
      AUTOMATION_TURN_SCHEDULE_ERROR.code,
      AUTOMATION_TURN_SCHEDULE_ERROR.message,
    );
  const source = await canonicalSource(trustedCaller.source);
  if (
    (trustedCaller.kind === 'app_advisor') !==
    isBotProjectId(source.projectId)
  )
    throw new AgentChatSendError(
      'validation_failed',
      'The trusted sender runtime is inconsistent.',
    );
  const caller: ProjectDiscoveryCaller =
    trustedCaller.kind === 'app_advisor'
      ? { kind: 'app_advisor', chatId: source.chatId }
      : { kind: 'project_agent', ...source };
  const target = await resolveAuthorizedChat(
    {
      projectId: action.projectId,
      taskId: action.taskId,
      chatId: action.chatId,
    },
    caller,
  );
  if (
    target.tab.readOnly ||
    target.tab.staleSessionDetected !== undefined ||
    target.tab.kind === 'file'
  )
    throw new AgentChatSendError(
      'not_found',
      'The target chat is not available.',
    );
  if (
    source.projectId === target.scope.workspaceId &&
    source.worktreeId === target.scope.worktreeId &&
    source.chatId === target.scope.chatId
  )
    throw new AgentChatSendError(
      'unsupported_action',
      'A chat cannot schedule a message to itself.',
    );
  await context.admission?.(target.scope);
  const trigger: AutomationTrigger = {
    kind: 'one_time',
    runAt: action.runAt,
    timezone: 'local',
  };
  const triggerError = validateAutomationTrigger(trigger);
  if (triggerError)
    throw new AgentChatSendError('validation_failed', triggerError);
  const next = getNextAutomationTriggerRun(trigger, new Date());
  if (!next)
    throw new AgentChatSendError(
      'validation_failed',
      'runAt must be in the future.',
    );
  const fields = await buildAgentSenderRequest(
    source,
    randomUUID(),
    target.scope.workspaceId,
  );
  if (!fields.agentSent || !fields.agentSenderProvenance)
    throw new AgentChatSendError(
      'validation_failed',
      'The scheduled sender context is incomplete.',
    );
  const result = await getAutomationsService().create(
    {
      name: action.name?.trim() ?? 'Scheduled message',
      enabled: true,
      schedule: trigger,
      action: {
        type: 'worktree_session_prompt',
        workspaceId: target.scope.workspaceId,
        worktreeId: target.scope.worktreeId,
        chatId: target.scope.chatId,
        prompt: action.text,
        purpose: 'scheduled_send',
        inputMode: action.inputMode ?? 'typed',
        chatTitle: target.tab.title,
        ...action.attachments,
      },
    },
    {
      agentScheduledSend: {
        version: 1,
        agentSent: fields.agentSent,
        provenance: fields.agentSenderProvenance,
      },
    },
  );
  if (!result.ok)
    throw new AgentChatSendError('validation_failed', result.error);
  if (!result.activity)
    throw new AgentChatSendError(
      'validation_failed',
      'The scheduled message could not be created.',
    );
  const activity = result.activity;
  return {
    activity,
    receipt: {
      address: target.address,
      automationId: activity.id,
      name: activity.name,
      runAt: next.toISOString(),
      timezone: 'local',
      createdAt: activity.createdAt,
    },
  };
}

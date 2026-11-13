import {
  deriveChatWorkflowCapabilities,
  type CanopyCapabilities,
  type ChatWorkflowTarget,
} from '@canopy/app-core';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { isCoworkChatTarget } from '@/lib/cowork';

export interface ComposerWorkflowGates {
  /** Schedule button, editable scheduled-send chip, and schedule shortcut. */
  readonly scheduledSends: boolean;
  /** Plan mode without proposal review reads as "Read only". */
  readonly planModeReadOnly: boolean;
}

function composerWorkflowTarget(
  projectId: string | undefined,
): ChatWorkflowTarget | undefined {
  if (projectId === undefined) return undefined;
  // App Advisor composers send to Work Entry chats; the global slot has none.
  if (projectId === APP_ADVISOR_PROJECT_ID) return 'app-advisor-entry';
  return isCoworkChatTarget(projectId) ? 'cowork' : 'worktree';
}

/**
 * Account harnesses take the shared workflow decision. Other providers keep
 * their existing composer behavior, which predates the shared decision.
 */
export function resolveComposerWorkflowGates(input: {
  readonly providerType: string | undefined;
  readonly interfaceMode: string;
  readonly projectId: string | undefined;
  readonly capabilities: CanopyCapabilities;
}): ComposerWorkflowGates {
  const { providerType, interfaceMode } = input;
  const accountHarness =
    providerType === 'cursor' ||
    providerType === 'copilot' ||
    providerType === 'opencode';
  if (!accountHarness) {
    return {
      // Scheduled sends run on the host's scheduler, which a scope without
      // automations (a cloud chat) can't use.
      scheduledSends:
        interfaceMode !== 'claude-code' &&
        input.capabilities.automations === true,
      planModeReadOnly: false,
    };
  }
  const workflows = deriveChatWorkflowCapabilities({
    resolvedProvider: providerType,
    interfaceMode,
    target: composerWorkflowTarget(input.projectId),
    capabilities: input.capabilities,
  });
  return {
    scheduledSends: workflows.scheduledMessages,
    planModeReadOnly: !(workflows.planMode && workflows.planReview),
  };
}

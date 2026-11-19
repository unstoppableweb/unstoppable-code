import type {
  PersistedChatMessage,
  UsageInitiationSource,
} from '@canopy/desktop-shared/types';
import { isInternalChatRequest } from '@canopy/desktop-shared/lib/internal-chat-row';
import { isUsageInitiationSource } from '@canopy/desktop-shared/lib/turn-utils';
import { readAutoResumeMetadata } from '@canopy/protocol/remote-control/shell';

function getRequestInitiationSource(
  request: unknown,
): UsageInitiationSource | undefined {
  if (
    !request ||
    typeof request !== 'object' ||
    !('initiationSource' in request)
  ) {
    return undefined;
  }
  const value = request.initiationSource;
  return isUsageInitiationSource(value) ? value : undefined;
}

function getRequestAutomationName(request: unknown): string | undefined {
  if (
    !request ||
    typeof request !== 'object' ||
    !('automationName' in request)
  ) {
    return undefined;
  }
  const value = request.automationName;
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isInternalRequest(request: unknown): boolean {
  if (request === null || typeof request !== 'object') return false;
  return isInternalChatRequest({
    managedDelegationDeliveryId:
      'managedDelegationDeliveryId' in request &&
      typeof request.managedDelegationDeliveryId === 'string'
        ? request.managedDelegationDeliveryId
        : undefined,
  });
}

/**
 * Stable id of the automation banner that precedes one automation-initiated
 * prompt. Every writer (the main-owned worktree and Cowork send paths, the
 * trusted-send materialization, and the renderer's optimistic copy) derives
 * the same id from the prompt's user-message id, so the banner is written once
 * and a retry, queued drain, or reload never duplicates or re-times it.
 */
export function automationInfoMessageId(userMessageId: string): string {
  return `${userMessageId}-automation-info`;
}

/**
 * The automation banner for an automation-initiated prompt, or `null` for any
 * other send. When `existingMessages` already hold this prompt's banner, that
 * message is returned unchanged so its launch time survives retries.
 */
export function buildAutomationInfoMessage(
  request: unknown,
  userMessageId: string,
  existingMessages: readonly PersistedChatMessage[] = [],
  timestamp: number = Date.now(),
): PersistedChatMessage | null {
  if (
    isInternalRequest(request) ||
    (typeof request === 'object' &&
      request !== null &&
      'autoResume' in request &&
      readAutoResumeMetadata(request.autoResume) !== undefined) ||
    getRequestInitiationSource(request) !== 'automation'
  ) {
    return null;
  }
  const id = automationInfoMessageId(userMessageId);
  const existing = existingMessages.find((message) => message.id === id);
  if (existing) return existing;
  const automationName = getRequestAutomationName(request);
  return {
    id,
    role: 'system',
    timestamp,
    blocks: [
      {
        type: 'automation_info',
        timestamp,
        ...(automationName ? { activityName: automationName } : {}),
      },
    ],
  };
}

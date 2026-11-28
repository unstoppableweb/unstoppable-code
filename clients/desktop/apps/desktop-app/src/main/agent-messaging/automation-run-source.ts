import type { ChatSendMessageRequest } from '@canopy/desktop-shared/types';
import type { PipelineSenderSource } from './sender-context';

/**
 * Whether a pipeline send belongs to an automation's run: the automation's
 * own send, or a step in a run it started (CAN-4551). Both come from trusted
 * fields, never step inputs.
 */
export function isAutomationRunSource(source: PipelineSenderSource): boolean {
  return source.kind === 'automation' || source.automation !== undefined;
}

/** Read host-owned origin on the exact request dispatched from the queue. */
export function isAutomationRunInput(
  request: Pick<
    ChatSendMessageRequest,
    'userMessageId' | 'agentSenderProvenance' | 'nativeAutomationRunInputId'
  >,
): boolean {
  const provenance = request.agentSenderProvenance;
  return (
    (request.nativeAutomationRunInputId !== undefined &&
      request.nativeAutomationRunInputId === request.userMessageId) ||
    (provenance?.acceptedInputId === request.userMessageId &&
      provenance.sender.kind === 'pipeline' &&
      (provenance.sender.automationId !== undefined ||
        ('automationContinuation' in provenance &&
          provenance.automationContinuation === true)))
  );
}

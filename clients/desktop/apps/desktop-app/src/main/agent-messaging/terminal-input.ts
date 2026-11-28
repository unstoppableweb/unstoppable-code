import { sanitizeImportedUserText } from './terminal-user-text';
import type {
  ChatInputAttempt,
  ChatInputDeliveryRow,
} from '@canopy/protocol/remote-control/shell';
import { observeInputDelivery } from '../services/chat-input-delivery-state';
import { formatPendingSystemInstructionBlock } from '@canopy/desktop-shared/lib/pending-system-instructions';
import { isInputLedger } from '@canopy/desktop-shared/chat-input-delivery';
import type {
  ChatSendMessageRequest,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';

function terminalRequestFromRow(
  tabId: string,
  row: ChatInputDeliveryRow<ChatSendMessageRequest> | undefined,
  includeNativeAutomation = false,
): ChatSendMessageRequest | undefined {
  const request = row && retainedTerminalAttempt(row) ? row.payload : undefined;
  if (!request || request.userMessageId !== row?.id || request.chatId !== tabId)
    return undefined;
  if (
    includeNativeAutomation &&
    request.nativeAutomationRunInputId === request.userMessageId
  )
    return request;
  if (
    request.agentSent &&
    request.agentSenderProvenance?.acceptedInputId === row.id &&
    request.hiddenContext?.kind === 'agent-sender-context'
  )
    return request;
  return undefined;
}

function retainedTerminalAttempt(
  row: ChatInputDeliveryRow<ChatSendMessageRequest>,
): ChatInputAttempt<ChatSendMessageRequest> | undefined {
  return row.attempts.find(
    (attempt) =>
      attempt.id === row.currentAttemptId &&
      attempt.generation === 'managed-terminal' &&
      attempt.withdrawnAt === undefined,
  );
}

/** Lookup only main-retained evidence. A public message id is correlation, not authority. */
export function retainedTerminalAgentInput(
  tab: PersistedChatTab,
  userMessageId: string,
): ChatSendMessageRequest | undefined {
  if (!isInputLedger(tab.inputDelivery)) return undefined;
  return terminalRequestFromRow(
    tab.id,
    tab.inputDelivery.rows.find((candidate) => candidate.id === userMessageId),
  );
}

/** Native scheduler handoffs and agent sends share the durable terminal ledger. */
export function retainedTerminalInput(
  tab: PersistedChatTab,
  userMessageId: string,
): ChatSendMessageRequest | undefined {
  if (!isInputLedger(tab.inputDelivery)) return undefined;
  return terminalRequestFromRow(
    tab.id,
    tab.inputDelivery.rows.find((candidate) => candidate.id === userMessageId),
    true,
  );
}

/** Update only the current, non-withdrawn attempt correlated to this input. */
export function observeTerminalInputDelivery(
  tab: PersistedChatTab,
  inputId: string,
  now: number,
  phase: 'picked-up' | 'unknown' = 'picked-up',
): PersistedChatTab {
  const ledger = tab.inputDelivery;
  if (!isInputLedger(ledger)) return tab;
  const row = ledger.rows.find((candidate) => candidate.id === inputId);
  if (!row || !terminalRequestFromRow(tab.id, row, true)) return tab;
  const attempt = retainedTerminalAttempt(row);
  if (!attempt) return tab;
  const updated = observeInputDelivery(
    ledger,
    {
      type: 'canopy_input_delivery',
      provider: attempt.provider,
      generation: attempt.generation,
      attemptId: attempt.id,
      phase,
    },
    now,
  );
  return updated === ledger ? tab : { ...tab, inputDelivery: updated };
}

/** Mirrors the terminal transport's path-only attachment suffix, not message authority. */
function terminalAttachmentSuffix(request: ChatSendMessageRequest): string {
  const browser = new Set(
    (request.attachmentPromptContexts ?? [])
      .filter((context) => context.promptKind === 'in-app-browser-resource')
      .map((context) => context.attachmentPath),
  );
  const linear = new Set(
    (request.attachmentPromptContexts ?? [])
      .filter((context) => context.promptKind === 'linear-ticket')
      .map((context) => context.attachmentPath),
  );
  const paths = (request.attachmentPaths ?? []).filter(
    (value, index, values) => values.indexOf(value) === index,
  );
  const browserPaths = paths.filter((value) => browser.has(value));
  const linearPaths = paths.filter((value) => linear.has(value));
  const references = [
    ...(request.fileReferences ?? []).map(
      (reference) => reference.absolutePath || reference.displayPath,
    ),
    ...paths.filter((value) => !browser.has(value) && !linear.has(value)),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
  return [
    browserPaths.length
      ? `In-app browser resource attachments:\nThese were captured from the in-app browser session and may reference selected UI elements, page URL/title, locators, DOM excerpts, screenshots, viewport/theme, and recent console/network diagnostics.\n${browserPaths.map((value) => `- ${value}`).join('\n')}`
      : '',
    linearPaths.length
      ? `Linear ticket snapshot attachments:\nRead the referenced markdown file(s) and treat the ticket as the task's source context.\n${linearPaths.map((value) => `- ${value}`).join('\n')}`
      : '',
    references.join('\n'),
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/**
 * Exact trusted-submission correlation, not delimiter parsing or text-derived
 * authority. Unrecognized terminal text is never assigned sender metadata.
 */
export function correlateTerminalAgentMessage(
  tab: PersistedChatTab,
  message: PersistedChatMessage,
): PersistedChatMessage {
  if (message.role !== 'user') return message;
  const ledger = tab.inputDelivery;
  if (!isInputLedger(ledger)) return message;
  const text = message.blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
  for (const row of ledger.rows) {
    const request = terminalRequestFromRow(tab.id, row);
    if (!request) continue;
    const normalize = (value: string): string =>
      value
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .trim();
    const baseSubmission = [
      formatPendingSystemInstructionBlock(request.pendingSystemInstructions),
      request.hiddenContext?.text.trim() ?? '',
      request.text,
    ]
      .filter((part) => part.length > 0)
      .join('\n\n');
    const submission = [
      formatPendingSystemInstructionBlock(request.pendingSystemInstructions),
      request.hiddenContext?.text.trim() ?? '',
      request.text,
      terminalAttachmentSuffix(request),
    ]
      .filter((part) => part.length > 0)
      .join('\n\n')
      .replace(/\r\n?/g, '\n')
      // Same normalization as the terminal bracketed-paste transport.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .trim();
    const convertedSuffix = sanitizeImportedUserText(
      terminalAttachmentSuffix(request),
      [
        ...(request.attachmentPaths ?? []),
        ...(request.fileReferences ?? []).map(
          (reference) => reference.absolutePath || reference.displayPath,
        ),
      ],
    );
    const convertedSubmission = sanitizeImportedUserText(
      normalize([baseSubmission, convertedSuffix].filter(Boolean).join('\n\n')),
    );
    if (
      text !== submission &&
      text !== normalize(baseSubmission) &&
      text !== convertedSubmission
    )
      continue;
    return {
      id: row.id,
      role: 'user',
      timestamp:
        tab.messages.find((candidate) => candidate.id === row.id)?.timestamp ??
        message.timestamp,
      userMessageSource: 'agent',
      agentSent: request.agentSent,
      blocks: [
        ...(request.fileReferences?.length
          ? [
              {
                type: 'file_references' as const,
                references: request.fileReferences,
              },
            ]
          : []),
        { type: 'text', text: request.text },
      ],
      ...(request.attachmentPaths?.length
        ? { attachmentPaths: request.attachmentPaths }
        : {}),
      ...(request.attachmentPromptContexts?.length
        ? { attachmentPromptContexts: request.attachmentPromptContexts }
        : {}),
      ...(request.inputMode ? { inputMode: request.inputMode } : {}),
    };
  }
  return message;
}

/** Settle main-correlated imports in the same commit that appends their visible messages. */
export function settleTerminalAgentImports(
  tab: PersistedChatTab,
  messages: readonly PersistedChatMessage[],
  now: number,
): PersistedChatTab {
  if (!isInputLedger(tab.inputDelivery)) return tab;
  const delivered = new Set(
    messages
      .filter(
        (message) =>
          message.role === 'user' &&
          message.userMessageSource === 'agent' &&
          message.agentSent,
      )
      .map((message) => message.id),
  );
  let updated = tab;
  for (const row of tab.inputDelivery.rows) {
    if (!delivered.has(row.id) || !terminalRequestFromRow(tab.id, row))
      continue;
    updated = observeTerminalInputDelivery(updated, row.id, now);
  }
  return updated;
}

const FORBIDDEN_CHAT_INPUT_FIELDS = [
  'userMessageSource',
  'autoResume',
  'resumesInterruptedTurn',
  'resumesUserMessageId',
  'interruptedTurns',
  'agentSent',
  'agentSenderProvenance',
  'agentSendSetup',
  'agentSteeringActor',
  'delegationNoticeBatchId',
  'watcherPartSnapshots',
  'turnOverride',
  'automationDispatch',
] as const;

const AGENT_SENDER_CONTEXT_KIND = 'agent-sender-context';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inspectAuthoritativeFields(value: Record<string, unknown>): void {
  FORBIDDEN_CHAT_INPUT_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      throw new Error(
        `Untrusted chat input cannot contain the "${field}" field.`,
      );
    }
  });

  const hiddenContext = value.hiddenContext;
  if (
    isRecord(hiddenContext) &&
    hiddenContext.kind === AGENT_SENDER_CONTEXT_KIND
  ) {
    throw new Error(
      'Untrusted chat input cannot contain hiddenContext kind "agent-sender-context".',
    );
  }
}

/**
 * Reject main-authored attribution and delivery identity only at authoritative
 * chat input locations.
 * This deliberately does not recursively inspect arbitrary JSON (for example,
 * tool-result blocks, attachment metadata, or body data), where these property
 * names may be ordinary user content.
 *
 * Known request locations include direct send/request fields, chat command
 * seeds and fork destinations, direct persisted-message fields, and the
 * request payloads in a persisted input-delivery ledger. Ordinary comment and
 * watcher hidden contexts remain valid.
 */
export function assertUntrustedChatInput(value: unknown): void {
  if (!isRecord(value)) return;

  const seenTabs = new WeakSet<object>();
  const seenCommands = new WeakSet<object>();
  const seenRequests = new WeakSet<object>();
  const seenLedgers = new WeakSet<object>();

  const inspectRequest = (request: unknown): void => {
    if (!isRecord(request) || seenRequests.has(request)) {
      return;
    }
    seenRequests.add(request);
    inspectAuthoritativeFields(request);
    if (typeof request.id === 'string' && Array.isArray(request.messages)) {
      inspectTab(request);
    }
    inspectTab(request.seedTab);
    inspectTab(request.tabSnapshot);
    inspectTab(request.destinationTab);
    inspectCommand(request.replacementTab);
    inspectLedger(request.inputDelivery);
  };

  const inspectMessage = (message: unknown): void => {
    if (isRecord(message)) inspectAuthoritativeFields(message);
  };

  const inspectMessages = (messages: unknown): void => {
    if (!Array.isArray(messages)) return;
    for (const message of messages) inspectMessage(message);
  };

  const inspectLedger = (ledger: unknown): void => {
    if (!isRecord(ledger) || seenLedgers.has(ledger)) return;
    seenLedgers.add(ledger);
    if (!Array.isArray(ledger.rows)) return;

    for (const row of ledger.rows) {
      if (!isRecord(row)) continue;
      inspectRequest(row.payload);
      if (!Array.isArray(row.attempts)) continue;
      for (const attempt of row.attempts) {
        if (isRecord(attempt)) inspectRequest(attempt.payloadSnapshot);
      }
    }
  };

  const inspectTab = (tab: unknown): void => {
    if (!isRecord(tab) || seenTabs.has(tab)) return;
    seenTabs.add(tab);
    inspectAuthoritativeFields(tab);
    inspectMessages(tab.messages);
    inspectLedger(tab.inputDelivery);
  };

  const inspectCommand = (command: unknown): void => {
    if (!isRecord(command) || seenCommands.has(command)) return;
    seenCommands.add(command);
    inspectAuthoritativeFields(command);

    inspectTab(command.seedTab);
    inspectTab(command.destinationTab);
    inspectCommand(command.replacementTab);
  };

  inspectAuthoritativeFields(value);

  // A standalone persisted tab is a supported caller shape (including the
  // parent-owned persistedChatTabFromCreateCommand boundary).
  if (typeof value.id === 'string' && Array.isArray(value.messages)) {
    inspectTab(value);
  }

  // Public request/envelope wrappers are traversed only through their known
  // request-bearing fields. Never descend into arbitrary nested payload data.
  inspectRequest(value.payload);
  inspectCommand(value.command);
  inspectTab(value.seedTab);
  inspectTab(value.tabSnapshot);
  inspectTab(value.destinationTab);
  inspectCommand(value.replacementTab);
  inspectLedger(value.inputDelivery);
}

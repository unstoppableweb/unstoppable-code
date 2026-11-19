import type {
  ChatSendAutomationDispatch,
  ChatSendMessageRequest,
} from '@canopy/desktop-shared/types';
import type { PipelineSenderSource } from './sender-context';

/**
 * The native-path request fields an automation's own send keeps (CAN-4549):
 * the banner and usage source, the package overlay and, for a scheduled run,
 * the scope's active tab. Both the admitted project send and the retained
 * Orchestrator send apply it, so a field added to the block lands on both.
 */
export function automationDispatchRequestFields(
  block: ChatSendAutomationDispatch | undefined,
): Partial<ChatSendMessageRequest> {
  if (!block) return {};
  return {
    automationDispatch: block,
    initiationSource: 'automation',
    automationName: block.automationName,
    ...(block.packageOverlay ? { packageOverlay: block.packageOverlay } : {}),
    ...(block.presentation === 'background' ? { preserveActiveTab: true } : {}),
  };
}

const CREATION_SEED_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'providerType',
  'modelConfig',
  'planMode',
  'approvalMode',
  'pluginSelections',
  'interfaceMode',
]);

/**
 * Whether a send carries a creation's new chat seed, the only sign that it is
 * the first message of a chat its creation made (CAN-4174): an object whose
 * every field is a seed field and at least one is set. Anything else, absent,
 * empty or unrecognised, is not one, so the send never selects a chat on a
 * guess.
 */
export function isCreationSeed(seed: unknown): boolean {
  if (typeof seed !== 'object' || seed === null || Array.isArray(seed))
    return false;
  const entries = Object.entries(seed);
  return (
    entries.every(([field]) => CREATION_SEED_FIELDS.has(field)) &&
    entries.some(([, value]) => value !== undefined && value !== null)
  );
}

/**
 * The automation dispatch block with the facts of its `chat.initiated` change
 * (CAN-4174): which automation started the send, and what an attached client
 * should do with the chat, as the send's path does today. An Orchestrator
 * chat is brought forward only by an automation's own chat action: the first
 * message of a chat it created opens the Orchestrator window on that chat,
 * and a send to an existing chat opens the window without selecting it. A
 * workflow step's send leaves it alone. A project chat is brought forward
 * when the send is in the foreground, as the chat becomes the scope's active
 * tab.
 */
export function withAutomationInitiation(
  block: ChatSendAutomationDispatch,
  source: PipelineSenderSource,
  target: 'bot' | 'project',
  createdChat: boolean,
): ChatSendAutomationDispatch {
  // The facts are main's alone: an `initiated` already on the block is dropped.
  const rest: ChatSendAutomationDispatch = { ...block };
  delete rest.initiated;
  const automationId =
    source.kind === 'automation'
      ? source.automationId
      : source.automation?.automationId;
  if (automationId === undefined) return rest;
  const presentation =
    target === 'bot'
      ? source.kind !== 'automation'
        ? 'none'
        : createdChat
          ? 'focus'
          : 'open'
      : block.presentation === 'foreground'
        ? 'focus'
        : 'none';
  return {
    ...rest,
    initiated: {
      origin: {
        kind: 'automation',
        sourceId: automationId,
        ...(source.kind === 'automation'
          ? {}
          : { occurrenceKey: source.executionId }),
      },
      presentation,
    },
  };
}

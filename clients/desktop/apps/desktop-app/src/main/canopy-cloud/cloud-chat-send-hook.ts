import { createCanopyClient } from '@canopy/core-client';
import {
  CLOUD_CUSTOM_SKILL_SOURCE_ID,
  CORE_CATALOG_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  type CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';
import type {
  RelayBindingConnection,
  RelayBindingProvider,
} from '../canopy-runtime/renderer-relay/definitions';
import { getDataDir } from '../lib/paths';
import { CloudCopyConsentStore } from '../skills/cloud-copy-consents';
import { getSkillsRootDir } from '../skills/paths';
import type { KeepInStepOutcome } from '../skills/publish-skill-to-cloud';
import {
  CloudTurnNoticeStore,
  type CloudTurnNotice,
} from './cloud-turn-notices';
import {
  connectWebCore,
  type WebCoreBindingOptions,
} from './web-core-connection';

/** The send fields the hook reads; the rest of the request is untouched. */
interface CloudChatSend {
  workspaceId: string;
  worktreeId: string;
  chatId: string;
  messageId: string;
}

/** What the hook calls; tests inject fakes. */
export interface CloudChatSendHookDeps {
  /** The signed-in account; null when signed out. */
  accountId: () => Promise<string | null>;
  /**
   * Whether any local skill has "Keep the cloud copy up to date" on for this
   * account; when none has, a send opens no connection to read selections.
   */
  hasKeepInStepSkills: (accountId: string) => Promise<boolean>;
  /** The chat's selected catalog entry ids, from the web core. */
  selectedItemIds: (send: CloudChatSend) => Promise<readonly string[]>;
  /**
   * Republishes what fell behind, answering by `deadlineAt` (epoch ms) with
   * whatever is still running named as using its last published copy.
   */
  keepInStep: (
    remoteIds: readonly string[],
    deadlineAt: number,
  ) => Promise<KeepInStepOutcome>;
  recordNotices: (
    accountId: string,
    chatId: string,
    messageId: string,
    notices: readonly CloudTurnNotice[],
  ) => void;
  pruneNotices: (accountId: string, chatId: string) => void;
}

/**
 * The chat's selection read. The web core scopes a selection by the chat
 * alone and refuses a target or a workspace and worktree scope with it.
 */
export function cloudChatSelectionReadParams(send: { chatId: string }): {
  scope: { chatId: string };
} {
  return { scope: { chatId: send.chatId } };
}

/** The longest a send waits for this hook before it goes regardless. */
export const CLOUD_CHAT_SEND_HOOK_TIMEOUT_MS = 10_000;
/**
 * How long before the hook's own timeout the republish must answer, so a
 * republish that runs long is still named on its turn.
 */
export const CLOUD_CHAT_SEND_HOOK_MARGIN_MS = 1_000;

const CLOUD_SKILL_PREFIX = `skill:${CLOUD_CUSTOM_SKILL_SOURCE_ID}/`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Notes a send owes its turn, recorded once its receipt names the turn. */
export interface PendingTurnNotices {
  readonly accountId: string;
  readonly chatId: string;
  readonly notices: readonly CloudTurnNotice[];
}

function readSend(params: unknown): CloudChatSend | null {
  if (!isRecord(params) || !isRecord(params.scope)) return null;
  const { workspaceId, worktreeId } = params.scope;
  const { chatId, messageId } = params;
  return typeof workspaceId === 'string' &&
    typeof worktreeId === 'string' &&
    typeof chatId === 'string' &&
    typeof messageId === 'string'
    ? { workspaceId, worktreeId, chatId, messageId }
    : null;
}

/**
 * Before a desktop cloud chat's send goes, republishes its selected skills
 * whose cloud copy fell behind (CAN-6176, D9 revised), and answers the notes
 * that turn owes for each skill whose last published copy it used instead.
 * Never throws: a send is never held back by this, only delayed up to its
 * timeout.
 */
export async function beforeCloudChatSend(
  params: unknown,
  deps: CloudChatSendHookDeps,
  deadlineAt = Date.now() +
    CLOUD_CHAT_SEND_HOOK_TIMEOUT_MS -
    CLOUD_CHAT_SEND_HOOK_MARGIN_MS,
): Promise<PendingTurnNotices | null> {
  const send = readSend(params);
  if (send === null) return null;
  try {
    const accountId = await deps.accountId();
    if (accountId === null || !(await deps.hasKeepInStepSkills(accountId)))
      return null;
    const remoteIds = (await deps.selectedItemIds(send))
      .filter((id) => id.startsWith(CLOUD_SKILL_PREFIX))
      .map((id) => id.slice(CLOUD_SKILL_PREFIX.length));
    if (remoteIds.length === 0) return null;
    // One deadline for the whole hook: however long the reads above took,
    // the republish answers before the send stops waiting.
    const outcome = await deps.keepInStep(remoteIds, deadlineAt);
    if (outcome.usedLastCopy.length === 0) return null;
    return {
      accountId,
      chatId: send.chatId,
      notices: outcome.usedLastCopy.map(({ name }) => ({
        kind: 'capability_copy_stale',
        name,
      })),
    };
  } catch {
    // An unreadable selection or store leaves the send as it was.
    return null;
  }
}

/**
 * The transcript message a send's receipt names: the web core gives the
 * prompt its own id, which the transcript's turn carries, not the send's
 * `messageId`. The receipt is the send's own answer, or the one
 * `core.chat.send.receipt` matched after an uncertain send.
 */
function receiptMessageId(message: CanopyJsonRpcMessage): string | null {
  if (!('result' in message) || !isRecord(message.result)) return null;
  const receipt =
    message.result.outcome === 'matched'
      ? message.result.receipt
      : message.result;
  if (!isRecord(receipt)) return null;
  const { messageId, outcome } = receipt;
  return typeof messageId === 'string' &&
    (outcome === 'applied' || outcome === 'already_applied')
    ? messageId
    : null;
}

/** The send a `core.chat.send.receipt` query asks after, by chat and command. */
function receiptQueryKey(params: unknown): string | null {
  if (!isRecord(params) || !isRecord(params.scope)) return null;
  const { chatId } = params.scope;
  const { commandId } = params;
  return typeof chatId === 'string' && typeof commandId === 'string'
    ? commandKey(chatId, commandId)
    : null;
}

const commandKey = (chatId: string, commandId: string): string =>
  JSON.stringify([chatId, commandId]);

/** Forgets a chat's notes when it is archived (CAN-6176). Never throws. */
export async function onCloudChatArchived(
  params: unknown,
  deps: Pick<CloudChatSendHookDeps, 'accountId' | 'pruneNotices'>,
): Promise<void> {
  // An archive names the chat as the tab it closes; a restore prunes nothing.
  const action = isRecord(params) ? params.action : undefined;
  if (
    !isRecord(action) ||
    action.type !== 'chat.archive_tab' ||
    typeof action.tabId !== 'string'
  )
    return;
  const chatId = action.tabId;
  try {
    const accountId = await deps.accountId();
    if (accountId !== null) deps.pruneNotices(accountId, chatId);
  } catch {
    // A note left behind is bounded and only ever shown on its own turn.
  }
}

function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Sends awaiting a receipt, per connection; older ones go first. */
const MAX_PENDING_RECEIPTS = 100;

/**
 * Wraps a relay's web core connection so a cloud chat's send waits for
 * {@link beforeCloudChatSend}, and an archive prunes the chat's notes. Every
 * other frame passes through unchanged.
 */
export function withCloudChatSendHook(
  connection: RelayBindingConnection,
  deps: CloudChatSendHookDeps,
  timeoutMs = CLOUD_CHAT_SEND_HOOK_TIMEOUT_MS,
  /**
   * Notes by the send's chat and command, shared by every connection of one
   * provider: a send whose answer was lost is settled by a receipt query
   * that can come on a new connection.
   */
  owed: Map<string, PendingTurnNotices> = new Map(),
): RelayBindingConnection {
  const allowPeer = connection.allowPeerMessageBytes?.bind(connection);
  const releaseStream = connection.releaseStream?.bind(connection);
  // Notes are recorded when a receipt names their turn. An error leaves
  // them: the send may have landed, and the receipt query that settles it
  // (CAN-6273) names the turn instead.
  /** Which owed send each request awaiting an answer is about. */
  const awaiting = new Map<string | number, string>();
  const bound = <K, V>(map: Map<K, V>, key: K, value: V): void => {
    map.set(key, value);
    if (map.size > MAX_PENDING_RECEIPTS) {
      const oldest = map.keys().next();
      if (oldest.done !== true) map.delete(oldest.value);
    }
  };
  return {
    connectionId: connection.connectionId,
    signal: connection.signal,
    ...(connection.maxMessageBytes === undefined
      ? {}
      : { maxMessageBytes: connection.maxMessageBytes }),
    ...(allowPeer === undefined ? {} : { allowPeerMessageBytes: allowPeer }),
    ...(releaseStream === undefined ? {} : { releaseStream }),
    receive: async (options) => {
      const message = await connection.receive(options);
      if ('id' in message && !('method' in message) && message.id !== null) {
        const key = awaiting.get(message.id);
        const notes = key === undefined ? undefined : owed.get(key);
        awaiting.delete(message.id);
        if (key !== undefined && notes !== undefined) {
          const messageId = receiptMessageId(message);
          // A refused send made no turn to note; an error may yet be settled.
          if ('result' in message) owed.delete(key);
          if (messageId !== null)
            try {
              deps.recordNotices(
                notes.accountId,
                notes.chatId,
                messageId,
                notes.notices,
              );
            } catch {
              // A note that can't be kept never holds back the receipt.
            }
        }
      }
      return message;
    },
    openChannel: (request) => connection.openChannel(request),
    onChannel: (listener, options) => connection.onChannel(listener, options),
    close: (error) => connection.close(error),
    send: async (message: CanopyJsonRpcMessage, options) => {
      if ('method' in message && message.method === 'core.chat.message.send') {
        const margin = Math.min(CLOUD_CHAT_SEND_HOOK_MARGIN_MS, timeoutMs / 2);
        const notes = await withTimeout(
          beforeCloudChatSend(
            message.params,
            deps,
            Date.now() + timeoutMs - margin,
          ),
          timeoutMs,
        );
        if (notes !== null && 'id' in message && message.id !== null) {
          const commandId = isRecord(message.params)
            ? message.params.commandId
            : undefined;
          const key =
            typeof commandId === 'string'
              ? commandKey(notes.chatId, commandId)
              : JSON.stringify(['request', message.id]);
          bound(owed, key, notes);
          bound(awaiting, message.id, key);
        }
      } else if (
        'method' in message &&
        message.method === 'core.chat.send.receipt' &&
        'id' in message &&
        message.id !== null
      ) {
        const key = receiptQueryKey(message.params);
        if (key !== null && owed.has(key)) bound(awaiting, message.id, key);
      } else if ('method' in message && message.method === 'core.chat.archive')
        await onCloudChatArchived(message.params, deps);
      return connection.send(message, options);
    },
  };
}

/** Main's hook dependencies, over its own web core connection and stores. */
export function desktopCloudChatSendHookDeps(
  binding: WebCoreBindingOptions,
  clientVersion: string,
): CloudChatSendHookDeps {
  const notices = (): CloudTurnNoticeStore =>
    CloudTurnNoticeStore.inDataDir(getDataDir());
  return {
    accountId: async () => {
      try {
        return (await binding.readCredentials()).accountId || null;
      } catch {
        return null;
      }
    },
    hasKeepInStepSkills: (accountId) =>
      Promise.resolve(
        Object.values(
          CloudCopyConsentStore.inSkillsRoot(getSkillsRootDir()).read(),
        ).some(
          (consent) => consent.keepInStep && consent.accountId === accountId,
        ),
      ),
    selectedItemIds: async (send) => {
      const signal = AbortSignal.timeout(CLOUD_CHAT_SEND_HOOK_TIMEOUT_MS);
      const client = await createCanopyClient({
        connection: await connectWebCore(binding, signal),
        clientName: 'canopy-desktop-cloud-chat-send',
        clientVersion,
        definitions: {
          queries: CORE_CATALOG_QUERY_DEFINITIONS,
          instructions: CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
          streams: {},
        },
        signal,
      });
      try {
        const read = await client.query(
          'core.catalog.selection.get',
          cloudChatSelectionReadParams(send),
        );
        return read.selectedItemIds;
      } finally {
        await client.close();
      }
    },
    keepInStep: async (remoteIds, deadlineAt) =>
      (await import('../skills/publish-skill-to-cloud')).keepCloudSkillsInStep(
        remoteIds,
        { deadlineAt },
      ),
    recordNotices: (accountId, chatId, messageId, recorded) =>
      notices().record(accountId, chatId, messageId, recorded),
    pruneNotices: (accountId, chatId) => notices().prune(accountId, chatId),
  };
}

/** Gives every relay connection the hook. */
export function withCloudChatSendHookProvider(
  provider: RelayBindingProvider,
  deps: CloudChatSendHookDeps,
): RelayBindingProvider {
  const owed = new Map<string, PendingTurnNotices>();
  return async (input) =>
    withCloudChatSendHook(
      await provider(input),
      deps,
      CLOUD_CHAT_SEND_HOOK_TIMEOUT_MS,
      owed,
    );
}

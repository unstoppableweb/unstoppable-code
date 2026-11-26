import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/protocol/chat-targets';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  SLACK_THREAD_JUST_CLOSED_REFUSAL,
  SLACK_THREAD_REMOVED_REFUSAL,
  SLACK_THREAD_TOO_LONG_REFUSAL,
  type HostedSlackTurnStatus,
} from '@canopy/protocol/remote-control/channels';
import type {
  ChatCommand,
  ChatCommandRequest,
  ChatCommandResult,
  ChatGetStateRequest,
  ChatTranscriptPageRequest,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import { writeFileAtomically } from '../../lib/atomic-file';
import { RpcPublicError } from '../transport/rpc-peer';
import {
  createWorkEntry,
  listWorkEntryIds,
} from '../../lib/cowork-work-entries';
import { resolveAppAdvisorDefaultModel } from '../../lib/default-model-lane-resolver';
import { getAppAdvisorSlackConversationsFilePath } from '../../lib/paths';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { getFeatureFlagService } from '../../feature-flags';
import { readPreferencesFile } from '../../lib/preferences-store';
import type {
  HostedChatAttribution,
  HostedOrchestratorDeps,
  HostedSlackTabOutcome,
} from './hosted-chat-dispatch';
import {
  remoteCreateTabNoModelMessage,
  resolveRemoteCreateTabSeed,
} from './remote-chat-create';

/**
 * The Orchestrator's Slack conversations entry and its tabs (CAN-7604). This
 * computer owns the entry: it creates it on the first Slack send, reuses it,
 * and creates a new one (under a new ID) when the person deleted it. Each
 * person's mentions in one Slack thread are one tab, named by the caller's
 * chat ID (derived from the thread and the sender); a closed tab is restored
 * under the same ID, so that person's thread never gets a second tab. The ID
 * is opaque here: two people in one thread are two tabs, like any other two.
 */

/** The entry's title, as the sidebar shows it. */
export const SLACK_CONVERSATIONS_TITLE = 'Slack conversations';

/**
 * Entry IDs kept for reads of older threads. A Slack session can't read a
 * Slack conversations entry older than the last 50 the person deleted and
 * this computer recreated; those reads are refused like any other entry's.
 */
const MAX_RECORDED_ENTRY_IDS = 50;

/**
 * Chats Slack sent to, kept so a Slack session reads only those. The oldest
 * drop out first; a thread that quiet reads as unknown to Slack until its
 * next message.
 */
const MAX_RECORDED_CHATS = 2000;

/** Older transcript pages read to find a resent message in a closed tab. */
const MAX_CLOSED_TAB_PAGES = 40;

export interface HostedOrchestratorChatReads {
  getState(request: ChatGetStateRequest): Promise<ChatStateSnapshot>;
  transcriptPage(request: ChatTranscriptPageRequest): Promise<TranscriptPage>;
}

interface SlackConversationsRecord {
  readonly version: 1;
  /** The entry Slack sends land in now. */
  readonly entryId: string | null;
  /**
   * An entry being created. Set before the create, so a restart midway
   * finishes it instead of leaving a second entry.
   */
  readonly pendingEntryId?: string;
  /** Every entry ID the Slack conversations entry has had, oldest first. */
  readonly entryIds: readonly string[];
  /** Each chat Slack sent to and the entry it last sent to, oldest first. */
  readonly chats: readonly SlackChat[];
}

interface SlackChat {
  readonly chatId: string;
  readonly entryId: string;
}

const EMPTY_RECORD: SlackConversationsRecord = {
  version: 1,
  entryId: null,
  entryIds: [],
  chats: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The record, or null when the file holds something else. */
function parseRecord(value: unknown): SlackConversationsRecord | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const entryIds = Array.isArray(value.entryIds)
    ? value.entryIds.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    version: 1,
    entryId: typeof value.entryId === 'string' ? value.entryId : null,
    ...(typeof value.pendingEntryId === 'string'
      ? { pendingEntryId: value.pendingEntryId }
      : {}),
    entryIds,
    chats: Array.isArray(value.chats)
      ? value.chats.flatMap((chat): SlackChat[] =>
          isRecord(chat) &&
          typeof chat.chatId === 'string' &&
          typeof chat.entryId === 'string'
            ? [{ chatId: chat.chatId, entryId: chat.entryId }]
            : [],
        )
      : [],
  };
}

/**
 * The record on disk: missing reads as empty, and anything unreadable or of
 * another shape as `unreadable`, left in place.
 */
async function peekRecord(): Promise<
  SlackConversationsRecord | { readonly unreadable: string }
> {
  let text: string;
  try {
    text = await readFile(getAppAdvisorSlackConversationsFilePath(), 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return EMPTY_RECORD;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { unreadable: error.message };
  }
  return parseRecord(value) ?? { unreadable: 'unexpected shape' };
}

/**
 * Reads without changing anything. Writes are atomic, so this needs no
 * queue; an unreadable record reads as empty until the next entry
 * resolution sets it aside.
 */
async function readRecordForReads(): Promise<SlackConversationsRecord> {
  const record = await peekRecord();
  return 'unreadable' in record ? EMPTY_RECORD : record;
}

/** The record for entry resolution; runs only inside `serialized`. */
async function readRecord(): Promise<SlackConversationsRecord> {
  const record = await peekRecord();
  if (!('unreadable' in record)) return record;
  // Unreadable: keep it aside for diagnosis rather than overwrite it, then
  // start over. Older Slack entries stay in the sidebar; only their
  // transcript reads by a Slack session are lost.
  const path = getAppAdvisorSlackConversationsFilePath();
  const aside = `${path}.corrupt-${Date.now()}`;
  logMainProcessWarn(
    'Slack conversations record unreadable; set aside and starting over',
    { aside, error: record.unreadable },
  );
  await rename(path, aside).catch((cause: unknown) => {
    if (!(isRecord(cause) && cause.code === 'ENOENT')) throw cause;
  });
  return EMPTY_RECORD;
}

async function writeRecord(record: SlackConversationsRecord): Promise<void> {
  const path = getAppAdvisorSlackConversationsFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomically(path, JSON.stringify(record, null, 2), {
    mode: 0o600,
    admittedWriter: {
      namespace: 'app_advisor_slack_conversations',
      writer: 'electron_main',
      module: 'main/remote-control/host/hosted-orchestrator-desktop',
    },
  });
}

let entryQueue: Promise<unknown> = Promise.resolve();

/** Runs entry resolutions one at a time, so two sends never make two entries. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = entryQueue.then(task, task);
  entryQueue = next.catch(() => undefined);
  return next;
}

const chatQueues = new Map<string, Promise<unknown>>();

/**
 * Readies one Slack tab at a time per chat, so two sends to the same closed
 * thread never both restore it and refuse the loser.
 */
function serializedForChat<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chatQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.catch(() => undefined);
  chatQueues.set(key, settled);
  void settled.then(() => {
    if (chatQueues.get(key) === settled) chatQueues.delete(key);
  });
  return next;
}

/**
 * The Slack conversations entry, created when there is none or the person
 * deleted it. A deleted entry is never recreated under its old ID: archived
 * containers are keyed by entry ID, and reusing one would overwrite the
 * deleted entry's retained copy.
 */
export function resolveSlackConversationsEntry(): Promise<string> {
  return serialized(async () => {
    const record = await readRecord();
    const live = await listWorkEntryIds(APP_ADVISOR_PROJECT_ID);
    if (record.entryId !== null && live.includes(record.entryId))
      return record.entryId;
    // A crash between the create and the write below leaves a live entry
    // known only by pendingEntryId. If the person deletes it before the next
    // send, that send recreates it under the same ID; this narrow window is
    // accepted rather than probing archived containers here.
    const entryId = record.pendingEntryId ?? randomUUID();
    if (record.pendingEntryId === undefined)
      await writeRecord({ ...record, pendingEntryId: entryId });
    await createWorkEntry(APP_ADVISOR_PROJECT_ID, {
      id: entryId,
      title: SLACK_CONVERSATIONS_TITLE,
    });
    await writeRecord({
      version: 1,
      entryId,
      entryIds: [
        ...record.entryIds.filter((id) => id !== entryId),
        entryId,
      ].slice(-MAX_RECORDED_ENTRY_IDS),
      chats: record.chats,
    });
    return entryId;
  });
}

/** Records that Slack sends `chatId`'s messages to `entryId`. */
function recordSlackChat(entryId: string, chatId: string): Promise<void> {
  return serialized(async () => {
    const record = await readRecord();
    const last = record.chats.find((chat) => chat.chatId === chatId);
    if (last?.entryId === entryId) return;
    await writeRecord({
      ...record,
      chats: [
        ...record.chats.filter((chat) => chat.chatId !== chatId),
        { chatId, entryId },
      ].slice(-MAX_RECORDED_CHATS),
    });
  });
}

/**
 * Whether a Slack session may read `chatId` in `entryId`: a chat Slack sent
 * to, in an entry that is, or was, the Slack conversations entry and is still
 * live. Never a chat made on this computer, nor an entry the person deleted.
 */
export async function isSlackConversationsChat(
  entryId: string,
  chatId: string,
): Promise<boolean> {
  const record = await readRecordForReads();
  if (record.entryId !== entryId && !record.entryIds.includes(entryId))
    return false;
  if (!record.chats.some((chat) => chat.chatId === chatId)) return false;
  return (await listWorkEntryIds(APP_ADVISOR_PROJECT_ID)).includes(entryId);
}

/** A sub-command's ID, derived from the send's so a retry replays it. */
function stepCommandId(commandId: string, step: string): string {
  return `slack-${step}-${createHash('sha256')
    .update(commandId, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

function succeeded(result: ChatCommandResult): boolean {
  return result.outcome === 'applied' || result.outcome === 'already_applied';
}

/**
 * Whether a tab's runtime holds `userMessageId` waiting: in its queue,
 * including admitting and dispatching rows, which sit only in
 * queuedMessages and whose prompt isn't in the transcript yet.
 */
function runtimeQueues(
  runtime: ChatStateSnapshot['runtimeByChatId'][string] | undefined,
  userMessageId: string,
): boolean {
  return (
    runtime?.queuedMessageIds.includes(userMessageId) === true ||
    runtime?.queuedMessages?.some(
      (row) =>
        row.id === userMessageId || row.request.userMessageId === userMessageId,
    ) === true
  );
}

/** Whether a tab's transcript holds `userMessageId`, read newest first. */
async function transcriptHasMessage(
  port: HostedOrchestratorChatReads,
  target: { projectId: string; worktreeId: string; chatId: string },
  userMessageId: string,
): Promise<boolean | 'unknown'> {
  return (await scanTranscript(port, target, userMessageId)).present;
}

/**
 * Whether a tab's transcript holds `userMessageId`, read newest page first,
 * and whether it is the latest prompt (read from that same first page).
 */
async function scanTranscript(
  port: HostedOrchestratorChatReads,
  target: { projectId: string; worktreeId: string; chatId: string },
  userMessageId: string,
): Promise<{ present: boolean | 'unknown'; latest: boolean }> {
  let before: number | undefined;
  let latest = false;
  for (let page = 0; page < MAX_CLOSED_TAB_PAGES; page += 1) {
    const result = await port.transcriptPage({
      ...target,
      ...(before === undefined ? {} : { before }),
    });
    if (page === 0) {
      const users = result.messages.filter(
        (message) => message.role === 'user',
      );
      latest = users[users.length - 1]?.id === userMessageId;
    }
    if (result.messages.some((message) => message.id === userMessageId))
      return { present: true, latest };
    if (result.before === undefined || result.before <= 0)
      return { present: false, latest };
    before = result.before;
  }
  return { present: 'unknown', latest };
}

export interface HostedOrchestratorDesktopDeps {
  readonly chatPort: () => HostedOrchestratorChatReads;
  readonly dispatch: (
    request: ChatCommandRequest,
    attribution: HostedChatAttribution,
  ) => Promise<ChatCommandResult>;
}

/** The desktop wiring of a Slack session's Orchestrator send. */
export function createHostedOrchestratorDesktop(
  deps: HostedOrchestratorDesktopDeps,
): HostedOrchestratorDeps {
  const command = (
    entryId: string,
    commandId: string,
    body: ChatCommand,
  ): ChatCommandRequest => ({
    schemaVersion: 1,
    commandId,
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: entryId,
    origin: 'portal',
    command: body,
  });

  return {
    slackRequests: async () => {
      if (
        !getFeatureFlagService().isEnabled(
          CLIENT_FEATURE_FLAGS.canopyDesktopSlackOrchestratorRequests.key,
        )
      )
        return 'unavailable';
      return (await readPreferencesFile()).slackOrchestratorRequestsEnabled ===
        true
        ? 'on'
        : 'off';
    },
    slackConversationsEntry: resolveSlackConversationsEntry,
    openSlackTab: (
      { entryId, chatId, userMessageId, commandId },
      attribution,
      send,
    ): Promise<HostedSlackTabOutcome> =>
      serializedForChat(`${entryId}\u0000${chatId}`, async () => {
        const port = deps.chatPort();
        const target = {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: entryId,
          chatId,
        };
        const state = await port.getState({
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: entryId,
        });
        const wasOpen = state.tabsFile.tabs.some((tab) => tab.id === chatId);
        if (!wasOpen) {
          if (state.archives.some((archive) => archive.chatId === chatId)) {
            // A resent message never reopens its closed tab.
            const sent = await transcriptHasMessage(
              port,
              target,
              userMessageId,
            );
            if (sent === 'unknown')
              return {
                status: 'refused',
                reason: SLACK_THREAD_TOO_LONG_REFUSAL,
              };
            if (sent) return { status: 'sent' };
            const restored = await deps.dispatch(
              command(entryId, stepCommandId(commandId, 'restore'), {
                type: 'chat.restore_archive',
                archiveEntryId: chatId,
              }),
              attribution,
            );
            if (!succeeded(restored))
              return {
                status: 'refused',
                reason: restored.reason ?? SLACK_THREAD_REMOVED_REFUSAL,
              };
          } else {
            // The Orchestrator's own model, never the generic worktree default.
            const model = await resolveAppAdvisorDefaultModel(
              await readPreferencesFile(),
            );
            const seed = await resolveRemoteCreateTabSeed(
              APP_ADVISOR_PROJECT_ID,
              { model },
            );
            if ('noDispatchableModel' in seed)
              return {
                status: 'refused',
                reason: remoteCreateTabNoModelMessage(seed.noDispatchableModel),
              };
            const created = await deps.dispatch(
              command(entryId, stepCommandId(commandId, 'create'), {
                ...seed,
                type: 'chat.create_tab',
                tabId: chatId,
              }),
              attribution,
            );
            // A tombstoned ID whose archive is gone: the thread can't reopen.
            if (created.outcome === 'not_found')
              return {
                status: 'refused',
                reason: SLACK_THREAD_REMOVED_REFUSAL,
              };
            if (!succeeded(created))
              return {
                status: 'refused',
                reason: created.reason ?? SLACK_THREAD_REMOVED_REFUSAL,
              };
          }
        } else {
          // A resent message never starts a second turn: it is queued, running
          // or already in the open tab's transcript, whatever its command ID.
          const runtime = state.runtimeByChatId[chatId];
          if (
            runtimeQueues(runtime, userMessageId) ||
            runtime?.activeTurn?.userMessageId === userMessageId
          )
            return { status: 'sent' };
          const sent = await transcriptHasMessage(port, target, userMessageId);
          if (sent === 'unknown')
            return { status: 'refused', reason: SLACK_THREAD_TOO_LONG_REFUSAL };
          if (sent) return { status: 'sent' };
        }
        // The tab closes once the turn this message starts completes. If the
        // send then fails, the empty tab stays open for the thread's next
        // message; closing it would tombstone the thread with nothing to
        // restore.
        const marked = await deps.dispatch(
          command(entryId, stepCommandId(commandId, 'close'), {
            type: 'chat.patch_tab_settings',
            tabId: chatId,
            patch: { autoArchive: true },
          }),
          attribution,
        );
        // An open tab whose previous turn just ended can auto-close before
        // this mark or the send lands; the thread is still restorable.
        const closedMeanwhile = (result: ChatCommandResult): boolean =>
          wasOpen && result.outcome === 'not_found';
        if (closedMeanwhile(marked))
          return {
            status: 'refused',
            reason: SLACK_THREAD_JUST_CLOSED_REFUSAL,
          };
        if (!succeeded(marked))
          return {
            status: 'refused',
            reason: marked.reason ?? SLACK_THREAD_REMOVED_REFUSAL,
          };
        // Before the send, so a Slack session can read the chat it sends to.
        await recordSlackChat(entryId, chatId);
        // Still under this chat's lock: a second delivery of this message
        // waits here, then finds it queued or sent. The lock relies on the
        // send settling once the message is admitted, not when its turn ends.
        const result = await send();
        if (closedMeanwhile(result))
          return {
            status: 'refused',
            reason: SLACK_THREAD_JUST_CLOSED_REFUSAL,
          };
        return { status: 'dispatched', result };
      }),
  };
}

/** A turn that ended without completing, as its runtime last recorded it. */
const UNFINISHED_STATES: Readonly<
  Partial<Record<string, HostedSlackTurnStatus['state']>>
> = {
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'cancelled',
};

/** A turn the runtime has not finished yet. */
const IN_FLIGHT_STATES: ReadonlySet<string> = new Set([
  'queued',
  'starting',
  'streaming',
  'completing',
]);

/** Where one thread's turn stands in one entry's chat state. */
async function turnStatusIn(
  port: HostedOrchestratorChatReads,
  state: ChatStateSnapshot,
  entryId: string,
  chatId: string,
  userMessageId: string,
): Promise<HostedSlackTurnStatus | null> {
  const open = state.tabsFile.tabs.some((tab) => tab.id === chatId);
  const closed =
    !open && state.archives.some((archive) => archive.chatId === chatId);
  if (!open && !closed) return null;
  const located = {
    worktreeId: entryId,
    ...(closed ? { closed: true as const } : {}),
  };
  const runtime = open ? state.runtimeByChatId[chatId] : undefined;
  if (runtimeQueues(runtime, userMessageId))
    return { state: 'queued', ...located };
  if (runtime?.activeTurn?.userMessageId === userMessageId) {
    const waiting =
      runtime.status === 'awaiting_input' ||
      (state.tabsFile.pendingQuestions ?? []).some(
        (question) => question.chatId === chatId,
      ) ||
      (state.tabsFile.pendingApprovals ?? []).some(
        (approval) => approval.chatId === chatId,
      );
    return { state: waiting ? 'waiting_on_user' : 'running', ...located };
  }
  const target = {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: entryId,
    chatId,
  };
  // An accepted send is durably queued (queuedMessages, any state) or its
  // prompt is committed before the send is acknowledged, so there is no
  // window in which it is neither. The prompt commits together with its
  // `starting` runtime, so an open tab with no runtime is idle, not starting.
  const { present, latest } = await scanTranscript(port, target, userMessageId);
  // Never "not found" for a message a long thread may still hold. This also
  // ends readSlackTurnStatus's search before older entries, deliberately.
  if (present === 'unknown')
    throw new RpcPublicError(SLACK_THREAD_TOO_LONG_REFUSAL);
  if (!present) return { state: 'not_found', ...located };
  // A tab auto-closes only once its turn completes, and the person can't
  // close a tab while a turn runs. A turn that ended unfinished and was then
  // closed by hand still reads completed; its reply is what the transcript
  // holds. In an open tab whose latest prompt is this message, the runtime
  // says whether its turn is still starting (prompt committed before
  // activeTurn shows) or ended unfinished.
  if (runtime !== undefined && latest) {
    if (runtime.status === 'awaiting_input')
      return { state: 'waiting_on_user', ...located };
    if (IN_FLIGHT_STATES.has(runtime.status))
      return { state: 'running', ...located };
    const unfinished = UNFINISHED_STATES[runtime.status];
    if (unfinished !== undefined) return { state: unfinished, ...located };
  }
  return { state: 'completed', ...located };
}

/**
 * Where the turn a Slack message started stands, read from its tab
 * in the Slack conversations entry, or in an earlier one the person deleted
 * since (CAN-7604). Only a Slack session reads it.
 */
export async function readSlackTurnStatus(
  port: HostedOrchestratorChatReads,
  request: { readonly chatId: string; readonly userMessageId: string },
): Promise<HostedSlackTurnStatus> {
  const record = await readRecordForReads();
  // Only a chat Slack sent to has a Slack turn to read.
  const chat = record.chats.find((each) => each.chatId === request.chatId);
  if (chat === undefined) return { state: 'not_found' };
  const live = new Set(await listWorkEntryIds(APP_ADVISOR_PROJECT_ID));
  // The entry Slack last sent this chat to first, so a poll usually reads
  // one entry; the others only when it doesn't hold the message.
  const entries = [
    chat.entryId,
    ...[...record.entryIds].reverse().filter((id) => id !== chat.entryId),
  ].filter((entryId) => live.has(entryId));
  // The newest entry holding the message answers. A tab without it (an
  // older entry the person restored can share the tab ID) doesn't end the
  // search; its not_found stands only if no entry holds the message.
  let missing: HostedSlackTurnStatus | undefined;
  for (const entryId of entries) {
    const state = await port.getState({
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: entryId,
    });
    const status = await turnStatusIn(
      port,
      state,
      entryId,
      request.chatId,
      request.userMessageId,
    );
    if (status === null) continue;
    if (status.state !== 'not_found') return status;
    missing ??= status;
  }
  return missing ?? { state: 'not_found' };
}

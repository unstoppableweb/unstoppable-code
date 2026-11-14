import {
  CanopyErrorPayloadSchema,
  CoreChatCommandReceiptSchema,
  CANOPY_STREAM_DEFINITIONS,
  CORE_CHAT_LIVE_STREAM_DEFINITIONS,
  CoreChatSendReceiptResultSchema,
  CoreChatSnapshotGetResultSchema,
  CoreChatTranscriptPageResultSchema,
  type CanopyErrorPayload,
  type CanopyStreamCursor,
  type CoreChatLatestCompaction,
  type CoreChatMessageMeter,
  type CoreChatQueueEntry,
} from '@canopy/protocol/canopy-core';
import {
  parseAgentTaskRows,
  type AgentTaskRow,
} from '@canopy/protocol/cloud-session';
import {
  readPortalChatMessageAttachments,
  type PortalAskUserQuestion,
  type PortalAskUserQuestionAnswer,
  type PortalAskUserQuestionState,
  type PortalChatMessage,
  type PortalChatPart,
  type PortalQueuedMessage,
  type PortalTurnTimerAutoRoutedModel,
} from '@canopy/protocol/portal';
import {
  messageRevision,
  type ChatHydrationOptions,
  type ChatStoreState,
} from '../chat/create-chat-store';
import { hasAuthoritativeMatch, isOptimisticMessage } from '../chat/optimistic';
import {
  CoreCoworkRequestError,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from './invoker';

/** The chat's queue as the web core snapshot read it (CAN-6509). */
export interface CloudChatQueue {
  /** The Core session read; a continued chat's next session counts again. */
  readonly sessionId: string;
  /** Core's state version for the read, a decimal string. */
  readonly stateVersion: string;
  /** In Core's queue order. */
  readonly entries: readonly CoreChatQueueEntry[];
}

/** The chat's Core session and runtime, as the web core's reads name them (CAN-6509). */
export interface CloudChatSession {
  readonly sessionId: string;
  /** The runtime status core.chat.snapshot.get and core.chat.events report. */
  readonly runtimeStatus: string;
  /** The turn the runtime reports running, or null. */
  readonly activeTurnId: string | null;
}

/** A turn that stopped running, as the web core's runtime reported it. */
export interface CloudChatSettledTurn {
  readonly turnId: string;
  readonly status: 'complete' | 'failed';
}

/** A live answer's meter, as revision 2 of core.chat.events carries it (CAN-6509). */
export interface CloudChatMeter {
  readonly messageId: string;
  readonly meter: CoreChatMessageMeter;
}

/** One read of the chat's newest transcript page, with its latest compaction. */
export interface CloudChatCompactionRead {
  readonly latestCompaction?: CoreChatLatestCompaction;
  /** The thread's first read, which may report a compaction long past. */
  readonly first: boolean;
}

/** One cloud chat: its renderer key and its ids on the web core. */
export interface CloudChatThreadTarget {
  /** The authority-qualified key the shared chat store holds it under. */
  readonly key: string;
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/**
 * Projects transcript messages (the persisted message shape both cores
 * serve) to the shared transcript, with the chat's agent tasks for its
 * subagent cards (CAN-5976). Hosts inject it: this package carries no
 * transcript projection of its own.
 */
export type ProjectCloudChatMessages = (input: {
  readonly chatKey: string;
  readonly messages: readonly unknown[];
  readonly tasks: readonly AgentTaskRow[];
}) => PortalChatMessage[];

export interface CloudChatSendInput {
  readonly text: string;
  /** The optimistic row the shared panel minted for this send, if any. */
  readonly optimisticLocalId?: string;
  readonly attachments?: readonly { readonly attachmentId: string }[];
}

export interface CloudChatThread {
  readonly target: CloudChatThreadTarget;
  send(input: CloudChatSendInput): Promise<void>;
  /** Loads the next older transcript page; resolves at once when none is left. */
  loadOlder(): Promise<void>;
  /** The chat's unanswered questions, as the shared question cards read them. */
  getQuestions(): readonly PortalAskUserQuestionState[];
  subscribeQuestions(listener: () => void): () => void;
  /** The chat's agent tasks (subagents and background work), as they stand. */
  getAgentTasks(): readonly AgentTaskRow[];
  subscribeAgentTasks(listener: () => void): () => void;
  /** The ids of the messages its transcript holds; the host retires accepted sends by them. */
  getMessageIds(): ReadonlySet<string>;
  subscribeMessageIds(listener: () => void): () => void;
  /**
   * The chat's queue from its latest snapshot read, which the host's queue
   * commands and rows read (CAN-6509); null before a read, or from a web
   * core that does not serve it.
   */
  getQueue(): CloudChatQueue | null;
  subscribeQueue(listener: () => void): () => void;
  /** Reads the queue again: an edit changed an entry without moving the queue. */
  refreshQueue(): void;
  /**
   * Each turn that stops running (the runtime names another turn, or none),
   * so the host runs its turn-end reactions without the REST stream
   * (CAN-6509).
   */
  subscribeTurnSettled(
    listener: (turn: CloudChatSettledTurn) => void,
  ): () => void;
  /**
   * Each live answer's meter, once: an assistant message a page read held
   * with its meter is history and never reported (CAN-6509).
   */
  subscribeMeters(listener: (meter: CloudChatMeter) => void): () => void;
  /** Each read of the newest transcript page (CAN-6509). */
  subscribeCompactionReads(
    listener: (read: CloudChatCompactionRead) => void,
  ): () => void;
  /**
   * Whether the web core runs a turn of the chat, as its rail marks it; the
   * listener hears each change (CAN-6509).
   */
  isTurnRunning(): boolean;
  subscribeTurnRunning(listener: () => void): () => void;
  /**
   * The chat's Core session, which the host binds its sends to, with its
   * runtime: undefined until the first read answers, null while reads name
   * none (revision 2 of the snapshot). Re-reads of the queue update it.
   */
  getSession(): CloudChatSession | null | undefined;
  subscribeSession(listener: () => void): () => void;
  answerQuestion(
    requestId: string,
    answers: readonly PortalAskUserQuestionAnswer[],
  ): Promise<void>;
  dismissQuestion(requestId: string): Promise<void>;
  /** Stops the running turn the web core reports, or else the one this client started; rejects when none is known. */
  stop(): Promise<void>;
  /**
   * The model Auto picked for a prompt this client sent, which its turn's
   * timer names. Kept in memory only, as REST's binding keeps it (CAN-6092).
   */
  noteAutoRouting(
    promptMessageId: string,
    routing: PortalTurnTimerAutoRoutedModel,
  ): void;
  /**
   * Follows the running turn's reply as it is written, while the chat is on
   * screen; a hidden thread catches up from the transcript instead.
   */
  setLive(on: boolean): void;
  /** Ends the stream and drops the thread from the shared store. */
  close(): void;
}

export interface BindCloudChatThreadOptions {
  readonly invoker: CoreCoworkInvoker;
  readonly target: CloudChatThreadTarget;
  readonly chatStore: { getState(): ChatStoreState };
  readonly project: ProjectCloudChatMessages;
  readonly newId?: () => string;
  /** Delay before re-reading after a stream ends. */
  readonly reopenDelayMs?: number;
  /** Delay before reopening the live reply stream while a turn runs. */
  readonly liveReopenDelayMs?: number;
  /**
   * The longest a live reply waits, once its turn stops running, for its
   * committed message to reach the transcript.
   */
  readonly liveHoldMs?: number;
  /**
   * The host publishes the chat's status, queue and settings; the thread
   * publishes only its messages and its own read-failure notice, and closing
   * clears only those. The web, until the web core serves queued text
   * (CAN-6106). This is the capability seam, not a host check: it names what
   * the host's transport still owns, and goes away with CAN-6106.
   */
  readonly hostOwnsRuntime?: boolean;
}

/** The longest a re-read waits while reads keep changing nothing. */
const REOPEN_MAX_MS = 30_000;

/** Statuses during which a turn runs and Stop applies. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
]);

/** Refusals a re-read cannot fix: the thread stays closed until reopened. */
const TERMINAL_KINDS: ReadonlySet<CanopyErrorPayload['kind']> = new Set([
  'unauthenticated',
  'permission_denied',
  'not_found',
  'capability_unavailable',
]);

/** Provisional replies held at once: the running turn and those finishing. */
const LIVE_REPLY_LIMIT = 4;

/** A running turn's reply as the web core streams it, before it commits. */
interface LiveReply {
  readonly promptMessageId: string | null;
  /** The transcript message the reply was committed as, once Core names it. */
  messageId: string | null;
  text: string;
  reasoning: string;
  /** The turn's own tool calls by id, in the order they came (revision 2). */
  readonly tools: Map<string, LiveTool>;
  /** When the turn started, for its running timer (revision 2). */
  readonly startedAtMs: number | null;
  finished: boolean;
  readonly createdAtMs: number;
  updatedAtMs: number;
  /** When its turn was first seen stopped, while it waits for the commit. */
  stoppedAt: number | null;
  /** The transcript reads done by then. */
  readsAtStop: number;
}

/** One of a running turn's tool calls, as a `tool` item has it. */
interface LiveTool {
  readonly toolName: string;
  readonly input: string;
  readonly textOffset: number;
  readonly result?: { readonly output: string; readonly isError: boolean };
}

/** One step of a live reply: text, or the tool calls between two texts. */
type LiveStep =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tools'; readonly blocks: Record<string, unknown>[] };

/**
 * A live reply as REST's live view shows it: a message for each step, its
 * text and its tool calls in turn, each card after the text before it.
 */
function liveSteps(reply: {
  readonly text: string;
  readonly tools: ReadonlyMap<string, LiveTool>;
}): LiveStep[] {
  const steps: LiveStep[] = [];
  let at = 0;
  for (const [toolUseId, tool] of reply.tools) {
    const cut = Math.min(Math.max(tool.textOffset, at), reply.text.length);
    if (cut > at) steps.push({ kind: 'text', text: reply.text.slice(at, cut) });
    at = cut;
    const last = steps[steps.length - 1];
    const run: LiveStep =
      last?.kind === 'tools' ? last : { kind: 'tools', blocks: [] };
    if (run !== last) steps.push(run);
    const { toolName, input, result } = tool;
    if (run.kind === 'tools') {
      run.blocks.push({ type: 'tool_use', toolUseId, toolName, input });
      if (result !== undefined)
        run.blocks.push({
          type: 'tool_result',
          toolUseId,
          toolName,
          ...result,
        });
    }
  }
  if (reply.text.length > at)
    steps.push({ kind: 'text', text: reply.text.slice(at) });
  return steps;
}

/**
 * A committed reply as REST's transcript shows it (CAN-6116): a message per
 * step, a new one where text follows a tool call or a tool call follows
 * text, so a finished turn folds as REST's does. The first step keeps the
 * row's id; the others take `<id>:step-<n>`, which desktop's projection
 * does not merge back into the row as it does `<id>:<n>` (CAN-2608).
 */
function replySteps(message: unknown): unknown[] {
  const id = messageId(message);
  if (!isRecord(message) || message.role !== 'assistant' || id === null)
    return [message];
  const blocks: readonly unknown[] = Array.isArray(message.blocks)
    ? message.blocks
    : [];
  const steps: unknown[][] = [[]];
  let text = false;
  let tools = false;
  for (const block of blocks) {
    const type = isRecord(block) ? block.type : undefined;
    const tool = type === 'tool_use' || type === 'tool_result';
    if ((type === 'text' && tools) || (tool && text)) {
      steps.push([]);
      text = false;
      tools = false;
    }
    steps[steps.length - 1]?.push(block);
    text ||= type === 'text';
    tools ||= tool;
  }
  if (steps.length === 1) return [message];
  return steps.map((step, index) => ({
    ...message,
    id: index === 0 ? id : `${id}:step-${index}`,
    blocks: step,
  }));
}

/** A reply's artifact parts as the web core serves them (CAN-6116). */
function servedArtifactParts(value: unknown): PortalChatPart[] {
  return Array.isArray(value)
    ? value.flatMap((part: unknown) =>
        isRecord(part) && part.kind === 'attachment' && isRecord(part.data)
          ? [{ kind: 'attachment' as const, data: part.data }]
          : [],
      )
    : [];
}

export class CloudChatSendRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudChatSendRejectedError';
  }
}

export class CloudChatStopUnavailableError extends Error {
  constructor() {
    super('No running turn this client can stop.');
    this.name = 'CloudChatStopUnavailableError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A cloud turn's abnormal end as the timer's `endReason`, which the renderer
 * reads; the web core's transcript names it `outcome`, as canonical desktop
 * timers do (CAN-6116).
 */
function withTimerEndReason(message: PortalChatMessage): PortalChatMessage {
  let ended = false;
  const parts = message.parts?.map((part) => {
    const data =
      part.kind === 'turn_timer' && isRecord(part.data) ? part.data : undefined;
    if (data?.outcome !== 'failed' && data?.outcome !== 'cancelled')
      return part;
    ended = true;
    return { ...part, data: { ...data, endReason: data.outcome } };
  });
  return ended ? { ...message, parts } : message;
}

function isAskUserQuestion(value: unknown): value is PortalAskUserQuestion {
  return (
    isRecord(value) &&
    typeof value.question === 'string' &&
    Array.isArray(value.options) &&
    value.options.every((option) => typeof option === 'string')
  );
}

function messageId(message: unknown): string | null {
  return isRecord(message) && typeof message.id === 'string'
    ? message.id
    : null;
}

function unwrap(reply: CanopyCoreRelayLikeReply): unknown {
  if (!reply.ok) throw new CoreCoworkRequestError(reply.error);
  return reply.value;
}

function invalid(what: string): CoreCoworkRequestError {
  return new CoreCoworkRequestError({
    kind: 'internal',
    message: `The web core sent an invalid ${what}.`,
    retry: { kind: 'never' },
  });
}

function defaultId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Binds one cloud chat to the shared chat store (CAN-4185 PR-E): reads its
 * snapshot and transcript, then follows `core.chat.events` for its task and
 * applies each batch on top of the revision it holds, re-reading when a
 * batch does not follow or the stream asks. Commands go only to the invoker's
 * core; nothing here falls back to another one.
 */
export function bindCloudChatThread(
  options: BindCloudChatThreadOptions,
): CloudChatThread {
  const { invoker, target, chatStore, project } = options;
  const newId = options.newId ?? defaultId;
  const reopenDelayMs = options.reopenDelayMs ?? 1_000;
  const liveReopenDelayMs = options.liveReopenDelayMs ?? 1_000;
  const liveHoldMs = options.liveHoldMs ?? 5_000;
  let closed = false;
  let epoch = 0;
  let stream: CoreCoworkStream | null = null;
  let appliedRevision = -1;
  /** The revision that last set this chat's runtime. */
  let runtimeRevision = -1;
  let raw: unknown[] = [];
  let runtimeStatus = 'idle';
  /** The running turn's id as the web core reports it, if it does. */
  let activeTurnId: string | null = null;
  /** A turn this client started from idle, until the web core reports it. */
  let pendingTurnId: string | null = null;
  /** Counts runtime reports, so a send can tell whether one arrived since. */
  let runtimeReports = 0;
  /**
   * Host-owned runtime: the web core reported on the host's current raise (a
   * whole read, or a turn it saw run), so its idle may lower that raise.
   */
  let turnNews = false;
  /** The turn state this thread's own raise replaced, until it settles. */
  let raisedFrom: Pick<ChatHydrationOptions, 'status' | 'turnActive'> | null =
    null;
  let reopenTimer: ReturnType<typeof setTimeout> | null = null;
  /** The next re-read's delay: doubles while reads change nothing, to 30 s. */
  let reopenBackoffMs = reopenDelayMs;
  /** Whole reads so far; every one after the first is a re-read. */
  let wholeReads = 0;
  /** A re-read found no running turn: it lowers the host's raise (A). */
  let rereadIdle = false;
  /** The live reply said no turn runs: it stays shut until a runtime report. */
  let liveSaidIdle = false;
  /** Turns this client started, newest last; Stop cancels the newest. */
  const startedTurnIds: string[] = [];
  /** The next older transcript page's position, while one is left. */
  let olderBefore: number | null = null;
  /** Whether older pages were loaded, so a refresh keeps them. */
  let loadedOlder = false;
  /** Moves whenever the transcript is replaced, so a stale older page drops. */
  let transcriptGeneration = 0;
  /** A per-message revision that moves forward whenever its content changes. */
  const revisions = new Map<string, number>();
  /** Each row's subagent cards as last published, to see them change. */
  const agentCards = new Map<string, string>();
  /** The model Auto picked, by the id of the timer its prompt's turn shows. */
  const autoRouting = new Map<string, PortalTurnTimerAutoRoutedModel>();
  /** A timer row with the model Auto picked for its turn, as REST's shows it. */
  const withAutoRouting = (message: PortalChatMessage): PortalChatMessage => {
    const routed = autoRouting.get(message.messageId);
    return routed === undefined
      ? message
      : {
          ...message,
          parts: message.parts?.map((part) =>
            part.kind === 'turn_timer' && isRecord(part.data)
              ? { ...part, data: { ...part.data, ...routed } }
              : part,
          ),
        };
  };
  /** Prompts this client sent, by canonical message id, for queued rows. */
  const sentPrompts = new Map<string, { text: string; at: number }>();
  let queuedMessageIds: readonly string[] = [];
  let questions: readonly PortalAskUserQuestionState[] = [];
  const questionListeners = new Set<() => void>();
  let agentTasks: readonly AgentTaskRow[] = [];
  const agentTaskListeners = new Set<() => void>();
  /** The transcript's message ids, for the host's outbox (CAN-6509). */
  let messageIds: ReadonlySet<string> = new Set();
  const messageIdListeners = new Set<() => void>();
  let queue: CloudChatQueue | null = null;
  const queueListeners = new Set<() => void>();
  /** A queue read in flight, and whether another must follow it. */
  let queueRead: Promise<void> | null = null;
  let queueReadAgain = false;
  const turnSettledListeners = new Set<(turn: CloudChatSettledTurn) => void>();
  const meterListeners = new Set<(meter: CloudChatMeter) => void>();
  const runningListeners = new Set<() => void>();
  let reportedRunning = false;
  /** The Core session the latest snapshot read named. */
  let sessionId: string | null = null;
  /** Undefined until the first snapshot read answers. */
  let session: CloudChatSession | null | undefined;
  const sessionListeners = new Set<() => void>();
  const compactionListeners = new Set<
    (read: CloudChatCompactionRead) => void
  >();
  /** Assistant messages already seen with a meter: never reported again. */
  const metered = new Set<string>();
  let newestReads = 0;
  /** Provisional replies by turn id, oldest first (CAN-5984). */
  const liveReplies = new Map<string, LiveReply>();
  let live: CoreCoworkStream | null = null;
  let liveOpening = false;
  /** Whether the chat is on screen, so its live reply is worth following. */
  let liveWanted = false;
  /** The web core refused live replies for good: show committed ones only. */
  let liveRefused = false;
  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** Counts whole transcript reads, so a held reply knows one came since. */
  let transcriptReads = 0;
  /** The provisional rows the last publish showed. */
  let publishedLive: ReadonlySet<string> = new Set();
  /** The thread shows a read failure: live replies must not publish over it. */
  let failed = false;
  /** A read-failure notice is in the store (host-owned runtime only). */
  let noticeShown = false;
  /** With host-owned runtime, the thread alone writes the chat's messages. */
  const claim = options.hostOwnsRuntime === true ? {} : undefined;
  /**
   * Claimed at the first publish: until then the host's rows stay shown, so
   * a slow first read never empties the chat.
   */
  let claimed = false;
  /**
   * Host sends echoed before the first claim that the transcript does not
   * show yet: kept, and holding the turn, until it does.
   */
  let heldSends: PortalChatMessage[] = [];

  const scope = {
    workspaceId: target.workspaceId,
    worktreeId: target.worktreeId,
  };

  /** Core also parks an idle session as awaiting input: only a known turn runs. */
  function turnRuns(): boolean {
    return (
      pendingTurnId !== null ||
      (ACTIVE_STATUSES.has(runtimeStatus) &&
        (runtimeStatus !== 'awaiting_input' || activeTurnId !== null))
    );
  }

  function statusOptions(): Pick<
    ChatHydrationOptions,
    'status' | 'turnActive' | 'error'
  > {
    const active = turnRuns();
    return {
      status: active ? 'streaming' : 'idle',
      turnActive: active,
      error: null,
    };
  }

  function queuedMessages(): PortalQueuedMessage[] {
    // Only prompts this client sent: the web core lists queued ids, not text.
    return queuedMessageIds.flatMap((id) => {
      const sent = sentPrompts.get(id);
      return sent === undefined
        ? []
        : [
            {
              id,
              text: sent.text,
              origin: 'desktop',
              enqueuedAtMs: sent.at,
              // Replaces the optimistic bubble bound to the same message.
              supersedesUserMessageId: id,
            },
          ];
    });
  }

  /**
   * Whether this reply's own turn still runs: a running chat whose current
   * turn (as reported, or as this client started it) is another one has
   * moved on, as when a queued next turn starts.
   */
  function turnStillRuns(turnId: string): boolean {
    if (!turnRuns()) return false;
    const current = activeTurnId ?? pendingTurnId;
    return current === null || current === turnId;
  }

  /**
   * The transcript holds the reply: the committed message Core named, or,
   * once its turn finished or stopped running and Core named none (yet), the
   * turn's one reply after its prompt. While its turn runs, another assistant
   * message after the prompt is never taken for its reply.
   */
  function committed(turnId: string, reply: LiveReply): boolean {
    if (reply.messageId !== null)
      return raw.some((each) => messageId(each) === reply.messageId);
    if (
      (!reply.finished && turnStillRuns(turnId)) ||
      reply.promptMessageId === null
    )
      return false;
    const at = raw.findIndex(
      (each) => messageId(each) === reply.promptMessageId,
    );
    return (
      at !== -1 &&
      raw
        .slice(at + 1)
        .some((each) => isRecord(each) && each.role === 'assistant')
    );
  }

  /**
   * Provisional replies to show after the transcript. Each goes in the same
   * publish that adds its committed message, so it never shows twice and
   * never blinks out first. A turn's end can reach the feed a batch before
   * its committed message, so once the turn stops running a reply is held
   * until its message commits, a whole transcript read shows it never came
   * (a failed turn may have no reply), or liveHoldMs passes.
   */
  function liveMessages(
    after: number,
    shown: ReadonlySet<string>,
  ): PortalChatMessage[] {
    const now = Date.now();
    for (const [turnId, reply] of liveReplies) {
      if (committed(turnId, reply)) {
        liveReplies.delete(turnId);
        continue;
      }
      if (turnStillRuns(turnId)) {
        reply.stoppedAt = null;
        continue;
      }
      if (reply.stoppedAt === null) {
        reply.stoppedAt = now;
        reply.readsAtStop = transcriptReads;
      } else if (
        transcriptReads > reply.readsAtStop ||
        now - reply.stoppedAt >= liveHoldMs
      )
        liveReplies.delete(turnId);
    }
    const held = [...liveReplies.values()].flatMap((reply) =>
      reply.stoppedAt === null ? [] : [reply.stoppedAt + liveHoldMs],
    );
    if (held.length > 0 && holdTimer === null)
      holdTimer = setTimeout(
        () => {
          holdTimer = null;
          publishLive();
        },
        Math.max(0, Math.min(...held) - now),
      );
    let order = after;
    return [...liveReplies].flatMap(([turnId, reply]) => {
      const messageId = `${target.key}:live:${turnId}`;
      const status: PortalChatMessage['status'] = reply.finished
        ? 'complete'
        : 'streaming';
      const steps: LiveStep[] =
        reply.tools.size > 0
          ? liveSteps(reply)
          : reply.text.length > 0 || reply.reasoning.length > 0
            ? [{ kind: 'text', text: reply.text }]
            : [];
      const messages = steps.flatMap((step, index): PortalChatMessage[] => {
        const id = index === 0 ? messageId : `${messageId}:${index}`;
        // A tool step's cards as the host projects a committed reply's,
        // with the subagent rows its spawn calls nest.
        const tools =
          step.kind === 'tools'
            ? project({
                chatKey: target.key,
                messages: [
                  ...raw.filter(
                    (each) =>
                      isRecord(each) &&
                      typeof each.parentToolUseId === 'string',
                  ),
                  {
                    id,
                    role: 'assistant',
                    blocks: step.blocks,
                    timestamp: reply.createdAtMs,
                  },
                ],
                tasks: agentTasks,
              }).find((each) => each.messageId === id)
            : undefined;
        if (step.kind === 'tools' && tools === undefined) return [];
        const thinking: PortalChatPart[] =
          index === 0 && reply.reasoning.length > 0
            ? [{ kind: 'thinking', data: { text: reply.reasoning } }]
            : [];
        const parts = [...thinking, ...(tools?.parts ?? [])];
        return [
          {
            ...(tools ?? {}),
            messageId: id,
            chatId: target.key,
            role: 'assistant',
            // As REST's: the steps before the newest are done.
            status: index === steps.length - 1 ? status : 'complete',
            text: step.kind === 'text' ? step.text : '',
            ...(parts.length > 0 ? { parts } : {}),
            createdAtMs: reply.createdAtMs,
            updatedAtMs: reply.updatedAtMs,
            presentationOrder: order++,
          },
        ];
      });
      // The running timer, as REST's presentation shows it, under the id of
      // the timer its committed turn shows, which replaces it in place.
      const timerId =
        reply.promptMessageId === null
          ? null
          : `${reply.promptMessageId}:turn-timer`;
      if (
        timerId !== null &&
        reply.startedAtMs !== null &&
        !shown.has(timerId) &&
        // Only while it runs: a held reply never brings back an ended turn.
        !reply.finished &&
        turnStillRuns(turnId)
      )
        messages.push({
          messageId: timerId,
          chatId: target.key,
          role: 'system',
          status: 'streaming',
          text: '',
          parts: [
            {
              kind: 'turn_timer',
              data: {
                startedAt: reply.startedAtMs,
                pausedAt: null,
                resumedAt: null,
                accumulatedPausedDurationMs: 0,
                completedAt: null,
              },
            },
          ],
          createdAtMs: reply.startedAtMs,
          updatedAtMs: reply.updatedAtMs,
          presentationOrder: order++,
        });
      return messages;
    });
  }

  /**
   * A subagent card changes with its own rows and its task, not its spawn
   * row: move the row's revision when the card does, so the store takes it.
   * A reply step moves its row's revision, which `upsert` moves too.
   */
  function noteAgentCards(
    message: PortalChatMessage,
    revisionKey = message.messageId,
  ): void {
    const cards = message.parts?.filter((part) => part.kind === 'agent') ?? [];
    const fingerprint = cards.length === 0 ? '' : JSON.stringify(cards);
    const known = agentCards.get(message.messageId);
    agentCards.set(message.messageId, fingerprint);
    if (known === undefined || known === fingerprint) return;
    revisions.set(
      revisionKey,
      Math.max((revisions.get(revisionKey) ?? 0) + 1, Date.now()),
    );
  }

  function reportSession(): void {
    const named =
      sessionId === null ? null : { sessionId, runtimeStatus, activeTurnId };
    if (
      session !== undefined &&
      named?.sessionId === session?.sessionId &&
      named?.runtimeStatus === session?.runtimeStatus &&
      named?.activeTurnId === session?.activeTurnId
    )
      return;
    session = named;
    for (const listener of sessionListeners) listener();
  }

  function publish(replaceMessages: boolean): void {
    if (closed) return;
    const ids = new Set(raw.flatMap((each) => messageId(each) ?? []));
    if (
      ids.size !== messageIds.size ||
      [...ids].some((id) => !messageIds.has(id))
    ) {
      messageIds = ids;
      for (const listener of messageIdListeners) listener();
    }
    if (turnRuns() !== reportedRunning) {
      reportedRunning = !reportedRunning;
      for (const listener of runningListeners) listener();
    }
    reportSession();
    // A prompt's attachments, as the web core serves them (CAN-6116).
    const attachments = new Map(
      raw.flatMap((each) => {
        const id = messageId(each);
        const read = isRecord(each)
          ? readPortalChatMessageAttachments(each.attachments)
          : undefined;
        return id === null || read === undefined ? [] : [[id, read] as const];
      }),
    );
    // A prompt the web core marks cancelled reads as REST's does (CAN-6092).
    const cancelled = new Set(
      raw.flatMap((each) =>
        isRecord(each) && each.cancelled === true
          ? (messageId(each) ?? [])
          : [],
      ),
    );
    // A reply step shares its row's revision, so every change moves it on.
    const stepRows = new Map<string, string>();
    const rowOf = (id: string): string => stepRows.get(id) ?? id;
    // A reply's artifacts sit where REST puts them: a deliverable's card on
    // its last step, the others before its first step's parts.
    const artifacts = new Map<
      string,
      { before: PortalChatPart[]; after: PortalChatPart[] }
    >();
    const place = (
      id: string | null,
      key: 'before' | 'after',
      parts: PortalChatPart[],
    ): void => {
      if (id === null || parts.length === 0) return;
      const entry = artifacts.get(id) ?? { before: [], after: [] };
      entry[key].push(...parts);
      artifacts.set(id, entry);
    };
    // The web core's transcript order is authoritative; keep it in the store.
    const projected = project({
      chatKey: target.key,
      messages: raw.flatMap((each) => {
        const steps = replySteps(each);
        const row = messageId(each);
        for (const step of steps.slice(1)) {
          const id = messageId(step);
          if (row !== null && id !== null) stepRows.set(id, row);
        }
        const served = isRecord(each) ? servedArtifactParts(each.parts) : [];
        const isDeliverable = (part: PortalChatPart): boolean =>
          isRecord(part.data) && 'deliverable' in part.data;
        place(
          row,
          'before',
          served.filter((part) => !isDeliverable(part)),
        );
        place(
          messageId(steps[steps.length - 1]),
          'after',
          served.filter(isDeliverable),
        );
        return steps;
      }),
      tasks: agentTasks,
    }).map((projected, presentationOrder) => {
      const shown = withAutoRouting(withTimerEndReason(projected));
      const served = artifacts.get(shown.messageId);
      const ended =
        served === undefined
          ? shown
          : {
              ...shown,
              parts: [
                ...served.before,
                ...(shown.parts ?? []),
                ...served.after,
              ],
            };
      const files = attachments.get(ended.messageId);
      const message =
        files === undefined && !cancelled.has(ended.messageId)
          ? ended
          : {
              ...ended,
              ...(cancelled.has(ended.messageId)
                ? { status: 'cancelled' as const }
                : {}),
              ...(files === undefined ? {} : { attachments: files }),
            };
      noteAgentCards(message, rowOf(message.messageId));
      const revision = revisions.get(rowOf(message.messageId));
      return revision === undefined
        ? { ...message, presentationOrder }
        : {
            ...message,
            presentationOrder,
            updatedAtMs: Math.max(
              message.updatedAtMs ?? message.createdAtMs,
              revision,
            ),
          };
    });
    // A live row's subagent card changes with its task too, as a committed
    // row's does (noteAgentCards), so its revision moves with the card.
    const provisional = liveMessages(
      projected.length,
      new Set(projected.map((each) => each.messageId)),
    ).map((live) => {
      const message = withAutoRouting(live);
      noteAgentCards(message);
      const revision = revisions.get(message.messageId);
      return revision === undefined
        ? message
        : {
            ...message,
            updatedAtMs: Math.max(
              message.updatedAtMs ?? message.createdAtMs,
              revision,
            ),
          };
    });
    const shown = new Set(provisional.map((each) => each.messageId));
    // The store keeps rows a merge omits: a provisional row that went away
    // needs the list replaced, or it would sit beside its committed reply.
    const dropped = [...publishedLive].some((id) => !shown.has(id));
    publishedLive = shown;
    // A held send leaves once the transcript shows it: under its id, or by
    // role, text and time, as the store reconciles a send's echo.
    const shownIn = (message: PortalChatMessage): boolean =>
      projected.some((each) => each.messageId === message.messageId) ||
      hasAuthoritativeMatch(projected, message);
    const heldBefore = heldSends.length;
    if (claim !== undefined && !claimed) {
      claimed = true;
      const newest = Math.max(0, ...projected.map((each) => each.createdAtMs));
      heldSends = (
        chatStore.getState().threads[target.key]?.messages ?? []
      ).filter(
        (message) =>
          message.role === 'user' &&
          !isOptimisticMessage(message) &&
          !shownIn(message) &&
          message.createdAtMs > newest,
      );
      chatStore.getState().claimTranscript(target.key, claim);
    } else heldSends = heldSends.filter((message) => !shownIn(message));
    // A held send the store still lists goes only with a replace.
    const heldDropped = heldSends.length < heldBefore;
    // A replace drops what it omits: keep the sends still in flight. A
    // host-owned thread keeps them through every replace, its first read too,
    // since the host's composer sends whenever.
    const keepSends =
      claim === undefined
        ? dropped && !replaceMessages
        : dropped || heldDropped || replaceMessages;
    const pending = keepSends
      ? (chatStore.getState().threads[target.key]?.messages ?? []).filter(
          (message) =>
            isOptimisticMessage(message) &&
            !hasAuthoritativeMatch(projected, message),
        )
      : [];
    chatStore
      .getState()
      .hydrate(
        target.key,
        [...projected, ...provisional, ...pending, ...heldSends],
        {
          replaceMessages: replaceMessages || dropped || heldDropped,
          ...(claim === undefined
            ? { queuedMessages: queuedMessages(), ...statusOptions() }
            : { transcriptOwner: claim }),
        },
      );
    // After the messages, so a send they reconciled no longer holds the turn.
    if (claim !== undefined) {
      const turn = hostRuntime();
      const runtime = { ...turn, ...clearNotice(turn) };
      if (Object.keys(runtime).length > 0)
        chatStore.getState().hydrate(target.key, [], runtime);
    }
    ensureLive();
  }

  /** A publish a live reply caused; a failed thread keeps its notice. */
  function publishLive(): void {
    if (!failed) publish(false);
  }

  function applyLive(item: unknown): boolean {
    const parsed =
      CORE_CHAT_LIVE_STREAM_DEFINITIONS['core.chat.live.events'].item.safeParse(
        item,
      );
    if (!parsed.success) throw invalid('live reply');
    const event = parsed.data;
    if (event.chatId !== target.chatId) return true;
    if (event.kind === 'idle') {
      for (const reply of liveReplies.values()) reply.finished = true;
      return true;
    }
    const held = liveReplies.get(event.turnId);
    const updatedAtMs = Math.max((held?.updatedAtMs ?? 0) + 1, Date.now());
    if (event.kind === 'tool') {
      if (held === undefined) return true;
      const { toolName, input, textOffset, result } = event;
      held.tools.set(event.toolUseId, {
        toolName,
        input,
        textOffset,
        ...(result === undefined ? {} : { result }),
      });
      held.updatedAtMs = updatedAtMs;
      return true;
    }
    if (event.kind === 'turn') {
      const startedAtMs =
        event.startedAt === undefined ? NaN : Date.parse(event.startedAt);
      liveReplies.set(event.turnId, {
        promptMessageId: event.promptMessageId,
        messageId: event.messageId ?? null,
        text: event.text,
        reasoning: event.reasoning,
        // Every attach sends its tools again after its opening item.
        tools:
          event.state === 'streaming' || held === undefined
            ? new Map<string, LiveTool>()
            : held.tools,
        startedAtMs: Number.isFinite(startedAtMs)
          ? startedAtMs
          : (held?.startedAtMs ?? null),
        finished: event.state === 'finished',
        createdAtMs: held?.createdAtMs ?? Date.now(),
        updatedAtMs,
        stoppedAt: held?.stoppedAt ?? null,
        readsAtStop: held?.readsAtStop ?? 0,
      });
      while (liveReplies.size > LIVE_REPLY_LIMIT) {
        const [oldest] = liveReplies.keys();
        if (oldest === undefined) break;
        liveReplies.delete(oldest);
      }
      return true;
    }
    // An append applies only at the lengths it was cut from.
    if (
      held === undefined ||
      held.text.length !== event.textOffset ||
      held.reasoning.length !== event.reasoningOffset
    )
      return false;
    held.text += event.text;
    held.reasoning += event.reasoning;
    held.updatedAtMs = updatedAtMs;
    return true;
  }

  function scheduleLive(): void {
    if (closed || liveRefused || liveTimer !== null) return;
    liveTimer = setTimeout(() => {
      liveTimer = null;
      ensureLive();
    }, liveReopenDelayMs);
  }

  async function pumpLive(opened: CoreCoworkStream): Promise<void> {
    let reopen = true;
    let gap = false;
    let idle = false;
    try {
      for (;;) {
        const next = await opened.next();
        if (closed || live !== opened || next.done) break;
        const frame = next.value;
        if (isRecord(frame) && frame.kind === 'item') {
          // A gap: attach again at once; the next open sends the whole reply.
          if (!applyLive(frame.item)) {
            gap = true;
            break;
          }
          idle = isRecord(frame.item) && frame.item.kind === 'idle';
          if (!idle) reopenBackoffMs = reopenDelayMs;
          publishLive();
          continue;
        }
        if (isRecord(frame) && frame.kind === 'end') {
          const error = CanopyErrorPayloadSchema.safeParse(frame.error);
          if (error.success && TERMINAL_KINDS.has(error.data.kind)) {
            liveRefused = true;
            reopen = false;
          }
        }
        break;
      }
    } finally {
      void opened.close();
      if (live === opened) live = null;
      if (reopen && !closed) {
        // A finished reply whose turn ended may go now; publish reattaches
        // after a gap, and a completed stream reopens after the delay. When
        // the live reply says no turn runs but the held state says one does,
        // read again (backing off) rather than wait on the feed or reopen.
        if (!gap && turnRuns()) {
          if (idle) {
            liveSaidIdle = true;
            scheduleReopen(epoch);
          } else scheduleLive();
        }
        publishLive();
      }
    }
  }

  /** Follows the live reply while a turn runs; the transcript never waits on it. */
  function ensureLive(): void {
    if (
      closed ||
      liveRefused ||
      live !== null ||
      liveOpening ||
      !liveWanted ||
      // Waiting out the reopen delay: a turn the web core has not started yet
      // must not reopen at once.
      liveTimer !== null ||
      liveSaidIdle ||
      !turnRuns()
    )
      return;
    liveOpening = true;
    void invoker
      .openStream('core.chat.live.events', {
        scope: { ...scope, chatId: target.chatId },
      })
      .then(
        (opened) => {
          liveOpening = false;
          // Hidden or closed while it opened: nothing follows it.
          if (closed || !liveWanted) {
            void opened.close();
            return;
          }
          live = opened;
          void pumpLive(opened).catch(() => undefined);
        },
        (error: unknown) => {
          liveOpening = false;
          if (
            error instanceof CoreCoworkRequestError &&
            TERMINAL_KINDS.has(error.payload.kind)
          )
            liveRefused = true;
          else scheduleLive();
        },
      );
  }

  function upsert(message: unknown): void {
    const id = messageId(message);
    if (id === null) return;
    const index = raw.findIndex((each) => messageId(each) === id);
    if (index !== -1 && JSON.stringify(raw[index]) !== JSON.stringify(message))
      revisions.set(id, Math.max((revisions.get(id) ?? 0) + 1, Date.now()));
    raw =
      index === -1
        ? [...raw, message]
        : raw.map((each, at) => (at === index ? message : each));
  }

  function setQuestions(next: readonly PortalAskUserQuestionState[]): void {
    questions = next;
    for (const listener of questionListeners) listener();
  }

  /** The opened chat's queue from a snapshot, when the web core serves it. */
  function queueOf(
    data: ReturnType<typeof CoreChatSnapshotGetResultSchema.parse>,
  ): CloudChatQueue | null {
    const summary = data.queue.find((each) => each.chatId === target.chatId);
    return summary?.stateVersion === undefined ||
      summary.sessionId === undefined
      ? null
      : {
          sessionId: summary.sessionId,
          stateVersion: summary.stateVersion,
          entries: summary.entries,
        };
  }

  /**
   * Keeps `next` unless the queue held is from a later read of the same
   * session: another session's versions count apart, and the snapshot reads
   * the chat's current one.
   */
  function setQueue(next: CloudChatQueue | null): void {
    if (
      next !== null &&
      queue !== null &&
      next.sessionId === queue.sessionId &&
      BigInt(next.stateVersion) < BigInt(queue.stateVersion)
    )
      return;
    queue = next;
    for (const listener of queueListeners) listener();
  }

  /** Whether the held queue lists exactly the queued prompts Core reports. */
  function queueMatches(ids: readonly string[]): boolean {
    if (queue === null) return true;
    const held = new Set(queue.entries.map((entry) => entry.messageId));
    return held.size === ids.length && ids.every((id) => held.has(id));
  }

  /**
   * Reads the snapshot again for its queue alone: one read at a time, and one
   * more when a change came during it. A failed read keeps the queue held;
   * the next change or re-read tries again.
   */
  function refreshQueue(): void {
    if (closed) return;
    if (queueRead !== null) {
      queueReadAgain = true;
      return;
    }
    const current = epoch;
    queueRead = (async (): Promise<void> => {
      try {
        const reply = CoreChatSnapshotGetResultSchema.safeParse(
          unwrap(
            await invoker.request('core.chat.snapshot.get', {
              scope,
              chatId: target.chatId,
            }),
          ),
        );
        if (reply.success && !closed && current === epoch) {
          setQueue(queueOf(reply.data));
          // A continued chat's re-read names its new session, with that
          // session's runtime rather than the ended one's.
          const next = reply.data.sessionId ?? null;
          // A runtime patch newer than the read's revision may describe
          // either session (Core loads the runtime after that revision), so
          // the next read, which starts after it, decides.
          if (next !== sessionId && reply.data.revision < runtimeRevision)
            queueReadAgain = true;
          else if (next !== sessionId) {
            const runtime = reply.data.runtimeByChatId[target.chatId];
            runtimeStatus = runtime?.status ?? 'idle';
            liveSaidIdle = false;
            setActiveTurn(runtime?.activeTurnId ?? null);
            runtimeRevision = reply.data.revision;
            sessionId = next;
            // As a runtime patch does: running state, live reply, session.
            publish(false);
          }
        }
      } catch {
        // Kept: the next change or re-read reads it again.
      } finally {
        queueRead = null;
        if (queueReadAgain && !closed) {
          queueReadAgain = false;
          refreshQueue();
        }
      }
    })();
  }

  /** Moves the running turn, telling the host the one that stopped (after the status). */
  function setActiveTurn(next: string | null): void {
    const ended = activeTurnId;
    activeTurnId = next;
    if (ended === null || ended === next) return;
    const turn: CloudChatSettledTurn = {
      turnId: ended,
      status: runtimeStatus === 'failed' ? 'failed' : 'complete',
    };
    for (const listener of turnSettledListeners) listener(turn);
  }

  function setAgentTasks(next: readonly AgentTaskRow[]): void {
    if (next.length === 0 && agentTasks.length === 0) return;
    agentTasks = next;
    for (const listener of agentTaskListeners) listener();
  }

  function toQuestionState(question: {
    readonly requestId: string;
    readonly questions: readonly unknown[];
    readonly toolUseId?: unknown;
  }): PortalAskUserQuestionState {
    return {
      requestId: question.requestId,
      ...(typeof question.toolUseId === 'string'
        ? { toolUseId: question.toolUseId }
        : {}),
      questions: question.questions.filter(isAskUserQuestion),
      answered: false,
    };
  }

  async function readTranscript(current: number): Promise<void> {
    const page = CoreChatTranscriptPageResultSchema.safeParse(
      unwrap(
        await invoker.request('core.chat.transcript.page', {
          scope: { ...scope, chatId: target.chatId },
        }),
      ),
    );
    if (!page.success) throw invalid('transcript page');
    if (current !== epoch) return;
    const newest = page.data.messages;
    seedMetered(newest);
    newestReads += 1;
    const read: CloudChatCompactionRead = {
      ...(page.data.latestCompaction === undefined
        ? {}
        : { latestCompaction: page.data.latestCompaction }),
      first: newestReads === 1,
    };
    for (const listener of compactionListeners) listener(read);
    const newestIds = new Set(newest.map(messageId));
    const firstNewest = newest.length > 0 ? messageId(newest[0]) : null;
    const overlap =
      firstNewest === null
        ? -1
        : raw.findIndex((each) => messageId(each) === firstNewest);
    if (loadedOlder && overlap > 0) {
      // Keep the older pages already loaded ahead of the refreshed newest page.
      raw = [
        ...raw
          .slice(0, overlap)
          .filter((each) => !newestIds.has(messageId(each))),
        ...newest,
      ];
      return;
    }
    loadedOlder = false;
    transcriptGeneration += 1;
    transcriptReads += 1;
    raw = [...newest];
    olderBefore =
      page.data.before !== undefined && page.data.before > 0
        ? page.data.before
        : null;
  }

  /** A page read's metered answers are history: never reported. */
  function seedMetered(
    messages: readonly { readonly id: string; readonly meter?: unknown }[],
  ): void {
    for (const each of messages)
      if (each.meter !== undefined) metered.add(each.id);
  }

  function scheduleReopen(current: number): void {
    if (closed || current !== epoch || reopenTimer !== null) return;
    reopenTimer = setTimeout(() => {
      reopenTimer = null;
      if (!closed && current === epoch) void open();
    }, reopenBackoffMs);
    reopenBackoffMs = Math.min(reopenBackoffMs * 2, REOPEN_MAX_MS);
  }

  function fail(error: unknown): void {
    if (closed) return;
    failed = true;
    noticeShown = options.hostOwnsRuntime === true;
    const message =
      error instanceof Error ? error.message : 'Cloud chat unavailable.';
    chatStore.getState().hydrate(target.key, [], {
      status: 'error',
      error: message,
      // A host that owns the turn keeps saying whether it runs.
      ...(options.hostOwnsRuntime === true ? {} : { turnActive: false }),
    });
  }

  /**
   * Host-owned runtime: the claim drops the REST turn frames that used to
   * raise and lower `streaming`, so the web core's turn does both. Once it
   * stops running and no send is pending, the host's raise (a composer send)
   * is lowered, but only once it reported on that raise, so a send whose turn
   * it hasn't reported yet stays raised. A late reply settles to idle instead
   * of reviving `streaming` from its messages.
   */
  function hostRuntime(): Pick<
    ChatHydrationOptions,
    'status' | 'error' | 'turnActive'
  > {
    const entry = chatStore.getState().threads[target.key];
    if (turnRuns()) {
      turnNews = true;
      if (entry?.status === 'streaming' && entry.turnActive) return {};
      raisedFrom ??= {
        status: entry?.status ?? 'idle',
        turnActive: entry?.turnActive ?? false,
      };
      return {
        status: 'streaming',
        turnActive: true,
        error: entry?.error ?? null,
      };
    }
    raisedFrom = null;
    if (entry === undefined) return {};
    if (rereadIdle) {
      rereadIdle = false;
      turnNews = false;
      if (entry.turnActive)
        return { status: 'idle', turnActive: false, error: entry.error };
    }
    const sending =
      heldSends.length > 0 || entry.messages.some(isOptimisticMessage);
    if (!entry.turnActive || sending) {
      // Reports so far predate the next raise, or this send's turn.
      turnNews = false;
      return entry.turnActive || sending
        ? {}
        : { status: 'idle', error: entry.error };
    }
    if (!turnNews) return {};
    turnNews = false;
    return { status: 'idle', turnActive: false, error: entry.error };
  }

  /**
   * Clears this thread's failure notice, back to the turn state: `turn`'s,
   * when this publish changes it, else the host's.
   */
  function clearNotice(
    turn: Pick<ChatHydrationOptions, 'turnActive'> = {},
  ): Pick<ChatHydrationOptions, 'status' | 'error'> {
    if (!noticeShown) return {};
    noticeShown = false;
    const turnActive =
      turn.turnActive ??
      chatStore.getState().threads[target.key]?.turnActive === true;
    return {
      status: turnActive || turnRuns() ? 'streaming' : 'idle',
      error: null,
    };
  }

  async function apply(item: unknown, current: number): Promise<boolean> {
    const batch =
      CANOPY_STREAM_DEFINITIONS['core.chat.events'].item.safeParse(item);
    if (!batch.success) throw invalid('chat event');
    // A cursorless open replays the batch that ends at the held revision.
    if (batch.data.revision <= appliedRevision) return true;
    if (batch.data.baseRevision !== appliedRevision) return false;
    let replace = false;
    for (const change of batch.data.changes) {
      if (change.type === 'pending_question.upserted') {
        if (change.question.chatId === target.chatId)
          setQuestions([
            ...questions.filter(
              (each) => each.requestId !== change.question.requestId,
            ),
            toQuestionState(change.question),
          ]);
        continue;
      }
      if (change.type === 'pending_question.removed') {
        if (change.chatId === target.chatId)
          setQuestions(
            questions.filter((each) => each.requestId !== change.requestId),
          );
        continue;
      }
      if (change.type === 'agent_tasks.replaced') {
        if (change.chatId === target.chatId)
          setAgentTasks(parseAgentTaskRows(change.tasks));
        continue;
      }
      if (!('chatId' in change) || change.chatId !== target.chatId) continue;
      switch (change.type) {
        case 'message.upserted': {
          upsert(change.message);
          const { id, role, meter, parentToolUseId } = change.message;
          // A subagent's reply meters its task, not the chat (REST skips it too).
          if (
            role === 'assistant' &&
            parentToolUseId === undefined &&
            meter !== undefined &&
            !metered.has(id)
          ) {
            metered.add(id);
            for (const listener of meterListeners)
              listener({ messageId: id, meter });
          }
          break;
        }
        case 'message.removed':
          raw = raw.filter((each) => messageId(each) !== change.messageId);
          replace = true;
          break;
        case 'messages.replaced':
          transcriptGeneration += 1;
          seedMetered(change.messages);
          raw = [...change.messages];
          replace = true;
          break;
        case 'transcript.updated':
          // A reset rewrites history: older pages kept so far are stale.
          if (change.reset) {
            loadedOlder = false;
            transcriptGeneration += 1;
            olderBefore = null;
          }
          await readTranscript(current);
          replace = true;
          break;
        case 'runtime.patched': {
          runtimeStatus = change.runtime.status;
          runtimeRevision = batch.data.revision;
          pendingTurnId = null;
          runtimeReports += 1;
          liveSaidIdle = false;
          queuedMessageIds = [...change.runtime.queuedMessageIds];
          // A prompt queued or left the queue: its rows come from the snapshot.
          // During a read, read once more: that read may answer from before.
          if (queueRead !== null || !queueMatches(queuedMessageIds))
            refreshQueue();
          setActiveTurn(
            typeof change.runtime.activeTurnId === 'string'
              ? change.runtime.activeTurnId
              : null,
          );
          if (turnRuns()) turnNews = true;
          break;
        }
        default:
          break;
      }
    }
    if (current !== epoch) return true;
    appliedRevision = batch.data.revision;
    publish(replace);
    return true;
  }

  async function pump(
    opened: CoreCoworkStream,
    current: number,
  ): Promise<void> {
    for (;;) {
      const next = await opened.next();
      if (closed || current !== epoch) return;
      if (next.done) break;
      const frame = next.value;
      if (isRecord(frame) && frame.kind === 'item') {
        const before = appliedRevision;
        if (!(await apply(frame.item, current))) {
          // A batch that does not follow the held revision: read again.
          break;
        }
        // Only a new batch is progress: a reopen replays the one held.
        if (appliedRevision > before) reopenBackoffMs = reopenDelayMs;
        continue;
      }
      if (isRecord(frame) && frame.kind === 'end') {
        const error = CanopyErrorPayloadSchema.safeParse(frame.error);
        if (error.success && TERMINAL_KINDS.has(error.data.kind)) {
          fail(new CoreCoworkRequestError(error.data));
          return;
        }
      }
      break;
    }
    void opened.close();
    if (stream === opened) stream = null;
    scheduleReopen(current);
  }

  async function open(): Promise<void> {
    epoch += 1;
    const current = epoch;
    // A send after this read began is newer than what the read can report.
    const readStart = Date.now();
    const previous = stream;
    stream = null;
    if (previous !== null) void previous.close();
    try {
      const snapshot = CoreChatSnapshotGetResultSchema.safeParse(
        unwrap(
          await invoker.request('core.chat.snapshot.get', {
            scope,
            chatId: target.chatId,
          }),
        ),
      );
      if (!snapshot.success) throw invalid('chat snapshot');
      if (closed || current !== epoch) return;
      await readTranscript(current);
      if (closed || current !== epoch) return;
      appliedRevision = snapshot.data.revision;
      runtimeRevision = snapshot.data.revision;
      const runtime = snapshot.data.runtimeByChatId[target.chatId];
      sessionId = snapshot.data.sessionId ?? null;
      runtimeStatus = runtime?.status ?? 'idle';
      // A re-read also settles a turn that ended while the stream was down.
      setActiveTurn(runtime?.activeTurnId ?? null);
      pendingTurnId = null;
      runtimeReports += 1;
      turnNews = true;
      wholeReads += 1;
      rereadIdle =
        wholeReads > 1 &&
        !turnRuns() &&
        !(chatStore.getState().threads[target.key]?.messages ?? []).some(
          (message) =>
            message.role === 'user' && message.createdAtMs >= readStart,
        );
      liveSaidIdle = false;
      queuedMessageIds = runtime?.queuedMessageIds ?? [];
      setQueue(queueOf(snapshot.data));
      setQuestions(
        (snapshot.data.pendingQuestions ?? [])
          .filter((question) => question.chatId === target.chatId)
          .map(toQuestionState),
      );
      setAgentTasks(parseAgentTaskRows(snapshot.data.tasks ?? []));
      failed = false;
      publish(true);
      const cursor: CanopyStreamCursor | null =
        snapshot.data.eventsCursor ?? null;
      const opened = await invoker.openStream('core.chat.events', {
        scope: { projectId: target.workspaceId, worktreeId: target.worktreeId },
        cursor,
      });
      if (closed || current !== epoch) {
        void opened.close();
        return;
      }
      stream = opened;
      void pump(opened, current).catch((error: unknown) => {
        if (closed || current !== epoch) return;
        fail(error);
        scheduleReopen(current);
      });
    } catch (error) {
      if (closed || current !== epoch) return;
      fail(error);
      if (
        !(error instanceof CoreCoworkRequestError) ||
        !TERMINAL_KINDS.has(error.payload.kind)
      )
        scheduleReopen(current);
    }
  }

  async function sendOnce(params: Record<string, unknown>): Promise<unknown> {
    const reply = await invoker.request('core.chat.message.send', params);
    if (reply.ok) return reply.value;
    const { retry } = reply.error;
    if (retry.kind !== 'same_idempotency_key' && retry.kind !== 'same_request')
      throw new CoreCoworkRequestError(reply.error);
    // The send may have landed: ask for its receipt before any resend, and
    // resend only under the same command id and key.
    const receipt = CoreChatSendReceiptResultSchema.safeParse(
      unwrap(
        await invoker.request('core.chat.send.receipt', {
          scope: { ...scope, chatId: target.chatId },
          commandId: params.commandId,
        }),
      ),
    );
    if (!receipt.success) throw invalid('send receipt');
    if (receipt.data.outcome === 'matched') return receipt.data.receipt;
    if (receipt.data.outcome === 'conflict')
      throw new CloudChatSendRejectedError(
        'This send conflicts with an earlier one.',
      );
    return unwrap(await invoker.request('core.chat.message.send', params));
  }

  async function send(input: CloudChatSendInput): Promise<void> {
    if (closed) throw new CloudChatSendRejectedError('The chat is closed.');
    const commandId = newId();
    const userMessageId = newId();
    const reportsAtSend = runtimeReports;
    const store = chatStore.getState();
    if (input.optimisticLocalId !== undefined)
      store.bindOptimisticSend(target.key, {
        optimisticLocalId: input.optimisticLocalId,
        userMessageId,
      });
    try {
      const value = await sendOnce({
        scope,
        commandId,
        chatId: target.chatId,
        messageId: userMessageId,
        text: input.text,
        ...(input.attachments && input.attachments.length > 0
          ? {
              attachments: input.attachments.map(({ attachmentId }) => ({
                attachmentId,
              })),
            }
          : {}),
        _meta: { idempotencyKey: commandId },
      });
      const receipt = CoreChatCommandReceiptSchema.safeParse(value);
      if (!receipt.success) throw invalid('send receipt');
      const {
        outcome,
        entityId,
        reason,
        messageId: canonicalId,
      } = receipt.data;
      if (outcome !== 'applied' && outcome !== 'already_applied')
        throw new CloudChatSendRejectedError(
          reason ?? 'The web core did not accept the message.',
        );
      if (entityId !== undefined) {
        startedTurnIds.push(entityId);
        // Stop works before the web core reports the turn it just accepted.
        if (!turnRuns() && runtimeReports === reportsAtSend) {
          pendingTurnId = entityId;
          publish(false);
        }
      }
      if (canonicalId !== undefined) {
        sentPrompts.set(canonicalId, { text: input.text, at: Date.now() });
        if (raw.some((each) => messageId(each) === canonicalId)) {
          // The echo arrived first: the authoritative list replaces the
          // optimistic row instead of sitting beside it.
          publish(true);
        } else if (input.optimisticLocalId !== undefined) {
          chatStore.getState().bindOptimisticSend(target.key, {
            optimisticLocalId: input.optimisticLocalId,
            userMessageId: canonicalId,
          });
        }
        if (queuedMessageIds.includes(canonicalId)) publish(false);
      }
    } catch (error) {
      if (input.optimisticLocalId !== undefined)
        chatStore.getState().rollbackOptimisticSend(target.key, {
          localId: input.optimisticLocalId,
        });
      // The composer has already cleared its draft: say so in the thread.
      if (!closed)
        chatStore.getState().hydrate(target.key, [], {
          // A turn that is still running keeps running: only add the notice.
          ...statusOptions(),
          error:
            error instanceof Error
              ? `Your message wasn't sent: ${error.message}`
              : "Your message wasn't sent.",
        });
      throw error;
    }
  }

  async function stop(): Promise<void> {
    const turnId =
      activeTurnId ??
      pendingTurnId ??
      startedTurnIds[startedTurnIds.length - 1];
    if (turnId === undefined || !turnRuns())
      throw new CloudChatStopUnavailableError();
    unwrap(
      await invoker.request('core.chat.turn.cancel', {
        chatId: target.chatId,
        turnId,
        reason: 'user',
      }),
    );
  }

  async function loadOlder(): Promise<void> {
    const before = olderBefore;
    if (closed || before === null) return;
    const current = epoch;
    const generation = transcriptGeneration;
    const page = CoreChatTranscriptPageResultSchema.safeParse(
      unwrap(
        await invoker.request('core.chat.transcript.page', {
          scope: { ...scope, chatId: target.chatId },
          before,
        }),
      ),
    );
    if (!page.success) throw invalid('transcript page');
    if (
      closed ||
      current !== epoch ||
      generation !== transcriptGeneration ||
      olderBefore !== before
    )
      return;
    seedMetered(page.data.messages);
    const known = new Set(raw.map(messageId));
    raw = [
      ...page.data.messages.filter((each) => !known.has(messageId(each))),
      ...raw,
    ];
    olderBefore =
      page.data.before !== undefined && page.data.before > 0
        ? page.data.before
        : null;
    loadedOlder = true;
    publish(false);
  }

  async function respond(
    requestId: string,
    body: { answers?: Record<string, unknown>; dismissed?: true },
  ): Promise<void> {
    unwrap(
      await invoker.request('core.chat.question.respond', {
        chatId: target.chatId,
        questionId: requestId,
        ...body,
      }),
    );
    setQuestions(questions.filter((each) => each.requestId !== requestId));
  }

  function answerQuestion(
    requestId: string,
    answers: readonly PortalAskUserQuestionAnswer[],
  ): Promise<void> {
    const question = questions.find((each) => each.requestId === requestId);
    const keyed: Record<string, unknown> = {};
    answers.forEach((answer, index) => {
      const id = answer.questionId ?? question?.questions[index]?.id;
      if (id === undefined) return;
      keyed[id] = {
        selectedOptions: [...answer.selectedOptions],
        ...(answer.freeformText === undefined
          ? {}
          : { freeformText: answer.freeformText }),
      };
    });
    return respond(requestId, { answers: keyed });
  }

  function noteAutoRouting(
    promptMessageId: string,
    routing: PortalTurnTimerAutoRoutedModel,
  ): void {
    if (closed) return;
    const timerId = `${promptMessageId}:turn-timer`;
    autoRouting.set(timerId, routing);
    // A timer already shown takes the chip only when its revision passes the
    // store's, whose completion time is the server's clock, not this one.
    const shown = chatStore
      .getState()
      .threads[target.key]?.messages.find((each) => each.messageId === timerId);
    revisions.set(
      timerId,
      Math.max(
        (revisions.get(timerId) ?? 0) + 1,
        Date.now(),
        shown === undefined ? 0 : messageRevision(shown) + 1,
      ),
    );
    // Before the first read, or after a failure, the next read's publish
    // carries it; publishing now would clear a failed thread's error.
    if (wholeReads > 0 && !failed) publish(false);
  }

  function setLive(on: boolean): void {
    if (closed || on === liveWanted) return;
    liveWanted = on;
    if (on) {
      ensureLive();
      return;
    }
    if (liveTimer !== null) clearTimeout(liveTimer);
    liveTimer = null;
    const following = live;
    live = null;
    if (following !== null) void following.close();
    // Hidden: the transcript catches up, and the next attach rebuilds the
    // reply in progress.
    liveReplies.clear();
    if (publishedLive.size > 0) publishLive();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    epoch += 1;
    if (reopenTimer !== null) clearTimeout(reopenTimer);
    reopenTimer = null;
    const open = stream;
    stream = null;
    if (open !== null) void open.close();
    if (liveTimer !== null) clearTimeout(liveTimer);
    liveTimer = null;
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
    const following = live;
    live = null;
    if (following !== null) void following.close();
    liveReplies.clear();
    setAgentTasks([]);
    agentTaskListeners.clear();
    messageIdListeners.clear();
    queueListeners.clear();
    turnSettledListeners.clear();
    meterListeners.clear();
    compactionListeners.clear();
    runningListeners.clear();
    sessionListeners.clear();
    const store = chatStore.getState();
    const entry = store.threads[target.key];
    if (claim === undefined) {
      store.reset(target.key);
      return;
    }
    // Drop what the thread wrote, then hand the transcript back to the host;
    // the host's settings and sends stay. A turn only this thread raised goes
    // back to the host's state, which REST lowers without touching status.
    const sends = entry?.messages.filter(isOptimisticMessage) ?? [];
    const unraise =
      raisedFrom !== null &&
      sends.length === 0 &&
      entry?.status === 'streaming' &&
      entry.turnActive
        ? raisedFrom
        : {};
    const handBack = {
      // Unclaimed, the thread wrote no messages: the host's stay.
      ...(claimed ? { replaceMessages: true, transcriptOwner: claim } : {}),
      ...clearNotice(),
      ...unraise,
    };
    // Released first, so host echoes the store held go with the thread's rows.
    store.releaseTranscript(target.key, claim);
    if (entry !== undefined && Object.keys(handBack).length > 0)
      store.hydrate(target.key, claimed ? sends : [], handBack);
  }

  void open();
  return {
    target,
    send,
    stop,
    noteAutoRouting,
    loadOlder,
    getQuestions: () => questions,
    subscribeQuestions: (listener) => {
      questionListeners.add(listener);
      return () => {
        questionListeners.delete(listener);
      };
    },
    getAgentTasks: () => agentTasks,
    subscribeAgentTasks: (listener) => {
      agentTaskListeners.add(listener);
      return () => {
        agentTaskListeners.delete(listener);
      };
    },
    subscribeTurnSettled: (listener) => {
      turnSettledListeners.add(listener);
      return () => {
        turnSettledListeners.delete(listener);
      };
    },
    subscribeMeters: (listener) => {
      meterListeners.add(listener);
      return () => {
        meterListeners.delete(listener);
      };
    },
    subscribeCompactionReads: (listener) => {
      compactionListeners.add(listener);
      return () => {
        compactionListeners.delete(listener);
      };
    },
    isTurnRunning: () => reportedRunning,
    getSession: () => session,
    subscribeSession: (listener) => {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    },
    subscribeTurnRunning: (listener) => {
      runningListeners.add(listener);
      return () => {
        runningListeners.delete(listener);
      };
    },
    getMessageIds: () => messageIds,
    subscribeMessageIds: (listener) => {
      messageIdListeners.add(listener);
      return () => {
        messageIdListeners.delete(listener);
      };
    },
    getQueue: () => queue,
    subscribeQueue: (listener) => {
      queueListeners.add(listener);
      return () => {
        queueListeners.delete(listener);
      };
    },
    refreshQueue,
    answerQuestion,
    dismissQuestion: (requestId) => respond(requestId, { dismissed: true }),
    setLive,
    close,
  };
}

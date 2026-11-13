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
  type PortalQueuedMessage,
} from '@canopy/protocol/portal';
import type {
  ChatHydrationOptions,
  ChatStoreState,
} from '../chat/create-chat-store';
import { hasAuthoritativeMatch, isOptimisticMessage } from '../chat/optimistic';
import {
  CoreCoworkRequestError,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from './invoker';

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
  answerQuestion(
    requestId: string,
    answers: readonly PortalAskUserQuestionAnswer[],
  ): Promise<void>;
  dismissQuestion(requestId: string): Promise<void>;
  /** Stops the running turn the web core reports, or else the one this client started; rejects when none is known. */
  stop(): Promise<void>;
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
  finished: boolean;
  readonly createdAtMs: number;
  updatedAtMs: number;
  /** When its turn was first seen stopped, while it waits for the commit. */
  stoppedAt: number | null;
  /** The transcript reads done by then. */
  readsAtStop: number;
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
  /** Prompts this client sent, by canonical message id, for queued rows. */
  const sentPrompts = new Map<string, { text: string; at: number }>();
  let queuedMessageIds: readonly string[] = [];
  let questions: readonly PortalAskUserQuestionState[] = [];
  const questionListeners = new Set<() => void>();
  let agentTasks: readonly AgentTaskRow[] = [];
  const agentTaskListeners = new Set<() => void>();
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
  function liveMessages(after: number): PortalChatMessage[] {
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
    return [...liveReplies]
      .filter(
        ([, reply]) => reply.text.length > 0 || reply.reasoning.length > 0,
      )
      .map(([turnId, reply], index) => ({
        messageId: `${target.key}:live:${turnId}`,
        chatId: target.key,
        role: 'assistant',
        status: reply.finished ? 'complete' : 'streaming',
        text: reply.text,
        ...(reply.reasoning.length > 0
          ? { parts: [{ kind: 'thinking', data: { text: reply.reasoning } }] }
          : {}),
        createdAtMs: reply.createdAtMs,
        updatedAtMs: reply.updatedAtMs,
        presentationOrder: after + index,
      }));
  }

  /**
   * A subagent card changes with its own rows and its task, not its spawn
   * row: move the row's revision when the card does, so the store takes it.
   */
  function noteAgentCards(message: PortalChatMessage): void {
    const cards = message.parts?.filter((part) => part.kind === 'agent') ?? [];
    const fingerprint = cards.length === 0 ? '' : JSON.stringify(cards);
    const known = agentCards.get(message.messageId);
    agentCards.set(message.messageId, fingerprint);
    if (known === undefined || known === fingerprint) return;
    revisions.set(
      message.messageId,
      Math.max((revisions.get(message.messageId) ?? 0) + 1, Date.now()),
    );
  }

  function publish(replaceMessages: boolean): void {
    if (closed) return;
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
    // The web core's transcript order is authoritative; keep it in the store.
    const projected = project({
      chatKey: target.key,
      messages: raw,
      tasks: agentTasks,
    }).map((projected, presentationOrder) => {
      const ended = withTimerEndReason(projected);
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
      noteAgentCards(message);
      const revision = revisions.get(message.messageId);
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
    const provisional = liveMessages(projected.length);
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
    if (event.kind === 'turn') {
      liveReplies.set(event.turnId, {
        promptMessageId: event.promptMessageId,
        messageId: event.messageId ?? null,
        text: event.text,
        reasoning: event.reasoning,
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
        case 'message.upserted':
          upsert(change.message);
          break;
        case 'message.removed':
          raw = raw.filter((each) => messageId(each) !== change.messageId);
          replace = true;
          break;
        case 'messages.replaced':
          transcriptGeneration += 1;
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
        case 'runtime.patched':
          runtimeStatus = change.runtime.status;
          pendingTurnId = null;
          runtimeReports += 1;
          liveSaidIdle = false;
          queuedMessageIds = [...change.runtime.queuedMessageIds];
          activeTurnId =
            typeof change.runtime.activeTurnId === 'string'
              ? change.runtime.activeTurnId
              : null;
          if (turnRuns()) turnNews = true;
          break;
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
      const runtime = snapshot.data.runtimeByChatId[target.chatId];
      runtimeStatus = runtime?.status ?? 'idle';
      activeTurnId = runtime?.activeTurnId ?? null;
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
    answerQuestion,
    dismissQuestion: (requestId) => respond(requestId, { dismissed: true }),
    setLive,
    close,
  };
}

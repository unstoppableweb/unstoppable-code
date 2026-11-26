/**
 * Chat recovery operations (CAN-7435) over desktop IPC: approving a pending
 * Claude/Codex/Ollama plan exit, retrying a failed worktree chat turn, and
 * the automatic-retry state behind them.
 *
 * Each composes calls a controller can already make (`chat:get-state`,
 * `chat:get-transcript-page`, `chat:command`, `tracked-plans:update`) in the
 * order the desktop renderer makes them. The checks here are for correctness
 * and UX, not authorization: the host enforces every rule a send relies on.
 */
import {
  computeUsageLimitResumePrompt,
  isCurrentFailureNotice,
  type PersistedChatMessage,
} from '@canopy/agent-transcript';
import type { ChatEvent } from '@canopy/agent-transcript/lib/chat-event-output';
import { isRootUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import type {
  ChatFailedTurnRetryArgs,
  ChatFailedTurnRetryCheckResult,
  ChatFailedTurnRetryResult,
  ChatFailedTurnRetryUnavailableReason,
  ChatResolvePlanExitArgs,
  ChatResolvePlanExitResult,
  ChatTransientRetryEvent,
  SubscriptionFilter,
  Unsubscribe,
} from '@canopy/app-core';
import {
  isPlanProposal,
  PLAN_EXIT_APPROVAL_MESSAGE,
  PLAN_PROPOSAL_APPROVAL_MESSAGE,
} from '@canopy/protocol/canopy-core';
import { REMOTE_IPC_CHANNELS as C } from '@canopy/protocol/remote-control/channels';
import { isRemoteControlPlanReviewSource } from '@canopy/protocol/remote-control/shell';
import type { ChannelClient } from './channel-client';
import { anyReply, isRecord, reply } from './decoders';
import type { PlanClient } from './ports';
import type {
  WireChatCommandResult,
  WireUpdateTrackedPlanRequest,
} from './wire';

/** The worktree a chat command addresses. */
interface CommandScope {
  readonly projectId: string;
  readonly worktreeId: string;
}

export interface ChatRecoveryDeps {
  readonly channels: ChannelClient;
  readonly now: () => string;
  /** The revisioned `chat:command` envelope, as the shell commands send it. */
  readonly chatCommand: (
    target: CommandScope,
    command: Record<string, unknown>,
  ) => Promise<{ commandId: string; reply: WireChatCommandResult }>;
  /** The host's own plan writes; absent, the tracked-plans channel. */
  readonly plans?: PlanClient;
}

/**
 * Transcript pages a Retry check reads back from the newest one to reach the
 * failed turn's user message. A long failed turn (the `Continue` case) may
 * span several pages; past the bound Retry is unavailable, never guessed.
 */
export const FAILED_TURN_RETRY_MAX_PAGES = 8;

/** Runtime statuses during which a chat is busy, as `chat.closeTab` reads them. */
const BUSY_RUNTIME_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
]);

const TRANSIENT_RETRY_STATE_EVENT_TYPE = 'canopy_transient_retry_state';

/** The tab fields these operations read from `chat:get-state`. */
interface WireRecoveryTab {
  readonly id: string;
  readonly planMode?: unknown;
  readonly pendingPlanExit?: unknown;
  readonly pendingPlanExitRequestId?: unknown;
  readonly trackedPlanId?: unknown;
  readonly trackedPlanSource?: unknown;
  readonly trackedPlanReviewStatus?: unknown;
  readonly latestRevisionNumber?: unknown;
}

interface WireRecoveryState {
  readonly tabsFile: { readonly tabs: readonly unknown[] };
  readonly runtimeByChatId?: Readonly<Record<string, unknown>>;
}

const isRecoveryState = reply<WireRecoveryState>(
  (value) =>
    isRecord(value) &&
    isRecord(value.tabsFile) &&
    Array.isArray(value.tabsFile.tabs),
);

interface WireTranscriptPage {
  readonly messages: readonly PersistedChatMessage[];
  readonly before?: number;
  readonly transcriptRevision: number;
}

const isTranscriptPage = reply<WireTranscriptPage>(
  (value) =>
    isRecord(value) &&
    Array.isArray(value.messages) &&
    typeof value.transcriptRevision === 'number' &&
    (value.before === undefined || typeof value.before === 'number'),
);

function findTab(
  state: WireRecoveryState,
  chatId: string,
): WireRecoveryTab | undefined {
  for (const tab of state.tabsFile.tabs) {
    if (isRecord(tab) && tab.id === chatId) {
      return { ...tab, id: chatId };
    }
  }
  return undefined;
}

function isChatBusy(state: WireRecoveryState, chatId: string): boolean {
  const runtime = state.runtimeByChatId?.[chatId];
  if (!isRecord(runtime)) return false;
  if (
    typeof runtime.status === 'string' &&
    BUSY_RUNTIME_STATUSES.has(runtime.status)
  ) {
    return true;
  }
  return (
    Array.isArray(runtime.queuedMessageIds) &&
    runtime.queuedMessageIds.length > 0
  );
}

/**
 * The newest message that started a root user turn. The web names a failed
 * turn by that message (`lastTurnEnd.userMessageId`, skipping rows it marks
 * `continuesTurn`), so a steer or a native `tool_result` user row inside the
 * turn must not stand in for it.
 */
function lastRootUserTurnIndex(
  messages: readonly PersistedChatMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && isRootUserTurnBoundary(message)) return index;
  }
  return -1;
}

function isAccepted(result: WireChatCommandResult): boolean {
  return result.outcome === 'applied' || result.outcome === 'already_applied';
}

function chatKey(target: {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}): string {
  return `${target.projectId}\u0000${target.worktreeId}\u0000${target.chatId}`;
}

/**
 * A host id (`[a-z0-9][a-z0-9-]*`) derived from `parts`, so a repeated
 * attempt (a double click, a reload, a second tab) sends the same message id
 * and the host answers it with `already_applied`.
 */
async function deterministicMessageId(
  prefix: string,
  parts: readonly string[],
): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join('\u0000'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${prefix}-${hex}`;
}

/**
 * One promise per chat while it runs; removed when it settles, so a failed
 * attempt can be tried again. Concurrent calls join the running one, as
 * desktop's `planApprovalsInFlight` does.
 */
function createInFlight<T>(): (
  key: string,
  run: () => Promise<T>,
) => Promise<T> {
  const running = new Map<string, Promise<T>>();
  return (key, run) => {
    const existing = running.get(key);
    if (existing !== undefined) return existing;
    const promise = run().finally(() => {
      if (running.get(key) === promise) running.delete(key);
    });
    running.set(key, promise);
    return promise;
  };
}

type RetryPlan =
  | {
      readonly available: true;
      readonly noticeMessageId: string | undefined;
      readonly prompt: ReturnType<typeof computeUsageLimitResumePrompt>;
    }
  | {
      readonly available: false;
      readonly reason: ChatFailedTurnRetryUnavailableReason;
    };

export interface ChatRecoveryHandlers {
  readonly resolvePlanExit: (
    args: ChatResolvePlanExitArgs,
  ) => Promise<ChatResolvePlanExitResult>;
  readonly checkFailedTurnRetry: (
    args: ChatFailedTurnRetryArgs,
  ) => Promise<ChatFailedTurnRetryCheckResult>;
  readonly retryFailedTurn: (
    args: ChatFailedTurnRetryArgs,
  ) => Promise<ChatFailedTurnRetryResult>;
}

export function createChatRecoveryHandlers(
  deps: ChatRecoveryDeps,
): ChatRecoveryHandlers {
  const { channels, chatCommand } = deps;
  const planExitsInFlight = createInFlight<ChatResolvePlanExitResult>();
  const retriesInFlight = createInFlight<ChatFailedTurnRetryResult>();

  const readState = (scope: CommandScope): Promise<WireRecoveryState> =>
    channels.invoke(C.chatGetState, isRecoveryState, {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
    });

  const resolvePlanExitNow = async (
    args: ChatResolvePlanExitArgs,
  ): Promise<ChatResolvePlanExitResult> => {
    const scope = { projectId: args.projectId, worktreeId: args.worktreeId };
    const { approval } = args;
    // 1. A fresh read; no write on any early return.
    const tab = findTab(await readState(scope), args.chatId);
    if (tab === undefined) return { outcome: 'rejected' };
    const pending = isRecord(tab.pendingPlanExit)
      ? tab.pendingPlanExit
      : undefined;
    const source = pending?.source;
    if (!isRemoteControlPlanReviewSource(source))
      return { outcome: 'rejected' };
    // OpenCode keeps its atomic `planReviewApproval` send.
    if (source === 'opencode') return { outcome: 'rejected' };
    if (tab.trackedPlanSource !== source) return { outcome: 'rejected' };
    if (
      tab.planMode !== true ||
      tab.trackedPlanReviewStatus !== 'pending' ||
      tab.pendingPlanExitRequestId !== approval.requestId ||
      tab.trackedPlanId !== approval.planId ||
      tab.latestRevisionNumber !== approval.revisionNumber
    ) {
      return { outcome: 'conflict' };
    }
    const proposal = isPlanProposal({
      reviewMode: pending?.reviewMode,
      source,
    });

    // 2. The chat decision. The host answers a stale or racing request, or a
    // proposal whose chat is still running, with `conflict`: exactly one
    // caller gets `applied`.
    const decided = await chatCommand(scope, {
      type: 'chat.patch_tab_settings',
      tabId: args.chatId,
      patch: {
        pendingPlanExit: null,
        pendingPlanExitRequestId: null,
        planMode: false,
        proposalMode: 'optional',
        trackedPlanReviewStatus: 'approved',
        hasOutstandingProposal: false,
      },
      expectedPendingPlanExitRequestId: approval.requestId,
    });
    if (decided.reply.outcome !== 'applied') return { outcome: 'conflict' };

    // From here a failure is terminal, as on desktop: the review is no longer
    // pending, and the user starts the work by sending a message.
    try {
      // 3. The tracked plan's review. Main links an implementation only to an
      // approved revision, so nothing is sent unless this applied.
      const review: WireUpdateTrackedPlanRequest = {
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        planId: approval.planId,
        chatId: args.chatId,
        initiationSource: 'user',
        reviewStatus: 'approved',
        approvedAt: deps.now(),
        dismissedAt: null,
      };
      const plan: unknown = deps.plans
        ? await deps.plans.update(review)
        : await channels.invoke(
            C.trackedPlansUpdate,
            anyReply<unknown>(),
            review,
          );
      if (
        !isRecord(plan) ||
        plan.id !== approval.planId ||
        plan.projectId !== args.projectId ||
        plan.worktreeId !== args.worktreeId ||
        plan.reviewStatus !== 'approved'
      ) {
        return { outcome: 'approved_not_started' };
      }

      // 4. The implementation turn, linked to the approved revision.
      const userMessageId = await deterministicMessageId(
        'plan-implementation',
        [args.chatId, approval.requestId],
      );
      const sent = await chatCommand(scope, {
        type: 'chat.send_message',
        chatId: args.chatId,
        userMessageId,
        text: proposal
          ? PLAN_PROPOSAL_APPROVAL_MESSAGE
          : PLAN_EXIT_APPROVAL_MESSAGE,
        trackedPlanImplementation: {
          planId: approval.planId,
          revisionNumber: approval.revisionNumber,
          userMessageId,
          startedAt: deps.now(),
        },
      });
      return {
        outcome: isAccepted(sent.reply) ? 'started' : 'approved_not_started',
      };
    } catch {
      return { outcome: 'approved_not_started' };
    }
  };

  /** Every Retry check, against fresh host reads. */
  const planRetry = async (
    args: ChatFailedTurnRetryArgs,
  ): Promise<RetryPlan> => {
    const scope = { projectId: args.projectId, worktreeId: args.worktreeId };
    const state = await readState(scope);
    if (findTab(state, args.chatId) === undefined) {
      return { available: false, reason: 'unavailable' };
    }
    if (isChatBusy(state, args.chatId)) {
      return { available: false, reason: 'busy' };
    }
    // Newest page first, then back until the turn's user message.
    let messages: PersistedChatMessage[] = [];
    let position: { before: number; transcriptRevision: number } | undefined;
    for (let pages = 0; pages < FAILED_TURN_RETRY_MAX_PAGES; pages += 1) {
      const page = await channels.invoke(
        C.chatGetTranscriptPage,
        isTranscriptPage,
        {
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          chatId: args.chatId,
          ...(position === undefined ? {} : position),
        },
      );
      messages = [...page.messages, ...messages];
      // The notice must be the last persisted message. One that isn't
      // persisted yet reports `not_current`; the caller asks again on the
      // next state change.
      if (
        pages === 0 &&
        !isCurrentFailureNotice(messages, args.noticeText, undefined)
      ) {
        return { available: false, reason: 'not_current' };
      }
      const lastUser = lastRootUserTurnIndex(messages);
      if (lastUser >= 0) {
        if (messages[lastUser]?.id !== args.turnUserMessageId) {
          return { available: false, reason: 'not_current' };
        }
        return {
          available: true,
          noticeMessageId: messages[messages.length - 1]?.id,
          prompt: computeUsageLimitResumePrompt(messages.slice(lastUser)),
        };
      }
      if (page.before === undefined || page.before <= 0) {
        return { available: false, reason: 'not_current' };
      }
      position = {
        before: page.before,
        transcriptRevision: page.transcriptRevision,
      };
    }
    return { available: false, reason: 'out_of_range' };
  };

  const retryFailedTurnNow = async (
    args: ChatFailedTurnRetryArgs,
  ): Promise<ChatFailedTurnRetryResult> => {
    // Never trusts an earlier check: every rule runs again here.
    const plan = await planRetry(args);
    if (!plan.available) {
      throw new Error("This turn can't be retried right now.");
    }
    // One id per failure notice: a second failure of the retried turn writes
    // a new notice row, and so gets a new id.
    const userMessageId = await deterministicMessageId(
      'failed-turn-retry',
      plan.noticeMessageId === undefined
        ? [args.chatId, args.turnUserMessageId, args.noticeText]
        : [args.chatId, plan.noticeMessageId],
    );
    const { prompt } = plan;
    const sent = await chatCommand(
      { projectId: args.projectId, worktreeId: args.worktreeId },
      {
        type: 'chat.send_message',
        chatId: args.chatId,
        userMessageId,
        text: prompt.text,
        ...(prompt.fileReferences === undefined
          ? {}
          : { fileReferences: prompt.fileReferences }),
        ...(prompt.attachmentPaths === undefined
          ? {}
          : { attachmentPaths: prompt.attachmentPaths }),
        ...(prompt.attachmentPromptContexts === undefined
          ? {}
          : { attachmentPromptContexts: prompt.attachmentPromptContexts }),
        ...(prompt.inputMode === undefined
          ? {}
          : { inputMode: prompt.inputMode }),
      },
    );
    if (sent.reply.outcome === 'applied') {
      return { userMessageId, disposition: 'applied' };
    }
    if (sent.reply.outcome === 'already_applied') {
      return { userMessageId, disposition: 'already_applied' };
    }
    throw new Error(
      sent.reply.reason ?? "The computer didn't retry this turn.",
    );
  };

  return {
    resolvePlanExit: (args) =>
      planExitsInFlight(chatKey(args), () => resolvePlanExitNow(args)),
    checkFailedTurnRetry: async (args) => {
      const plan = await planRetry(args);
      return plan.available
        ? {
            available: true,
            resendsUserMessage: plan.prompt.resendsUserMessage,
          }
        : { available: false, reason: plan.reason };
    },
    retryFailedTurn: (args) =>
      retriesInFlight(chatKey(args), () => retryFailedTurnNow(args)),
  };
}

interface TransientRetryState {
  readonly active: boolean;
  readonly exhausted: boolean;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly nextRetryAt: number | null;
}

/** `canopy_transient_retry_state` from a chat event, or `null` when malformed. */
function decodeTransientRetryState(data: unknown): TransientRetryState | null {
  if (!isRecord(data) || data.type !== TRANSIENT_RETRY_STATE_EVENT_TYPE) {
    return null;
  }
  const { active, exhausted, attempt, maxAttempts, nextRetryAt } = data;
  if (
    typeof active !== 'boolean' ||
    typeof exhausted !== 'boolean' ||
    typeof attempt !== 'number' ||
    typeof maxAttempts !== 'number' ||
    (nextRetryAt !== null && typeof nextRetryAt !== 'number')
  ) {
    return null;
  }
  return { active, exhausted, attempt, maxAttempts, nextRetryAt };
}

/**
 * `chat.transientRetry`: the host's automatic-retry state for worktree chats,
 * from the same `chat:event` source as `chat.message`. A malformed payload is
 * dropped, never thrown.
 */
export function subscribeTransientRetry(
  subscribeChatEvents: (listener: (event: ChatEvent) => void) => Unsubscribe,
  now: () => string,
  handler: (event: ChatTransientRetryEvent) => void,
  filter?: SubscriptionFilter,
): Unsubscribe {
  return subscribeChatEvents((event) => {
    if (
      (filter?.projectId !== undefined &&
        filter.projectId !== event.projectId) ||
      (filter?.worktreeId !== undefined &&
        filter.worktreeId !== event.worktreeId) ||
      (filter?.workspaceLocalId !== undefined &&
        filter.workspaceLocalId !== event.projectId) ||
      (filter?.worktreeLocalId !== undefined &&
        filter.worktreeLocalId !== event.worktreeId) ||
      (filter?.chatLocalId !== undefined && filter.chatLocalId !== event.chatId)
    ) {
      return;
    }
    const state = decodeTransientRetryState(event.data);
    if (state === null) return;
    handler({
      eventId: `${event.projectId}:${event.worktreeId}:${event.chatId}:transient-retry:${String(state.attempt)}:${String(state.active)}:${String(state.exhausted)}:${String(state.nextRetryAt)}`,
      occurredAt: now(),
      projectId: event.projectId,
      worktreeId: event.worktreeId,
      chatId: event.chatId,
      ...state,
    });
  });
}

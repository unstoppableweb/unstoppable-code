import type {
  LedgerChatTarget,
  LedgerFeedAnswerActions,
  LedgerFeedPlanAnswers,
  LedgerLiveWait,
} from '@canopy/app-core';
import { deriveChatWorkflowCapabilities } from '@canopy/app-core';
import type { LedgerNavigator } from '@canopy/app-core';
import type {
  LedgerViewOpenResult,
  LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import type { McpQuestionAnswer } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  cancelPlanWorkflowRequest,
  requestPlanWorkflow,
} from '@/lib/chat/plan-workflow-request';
import { DESKTOP_LEDGER_NAVIGATOR } from './ledger-navigator';

type DesktopChatStoreState = ReturnType<typeof useChatStore.getState>;
type DesktopPipelineStoreState = ReturnType<
  typeof usePipelineRunsStore.getState
>;

export interface DesktopLedgerFeedAnswerDependencies {
  readonly chatStore: {
    getState(): Pick<
      DesktopChatStoreState,
      | 'answerMcpQuestionAndWait'
      | 'approvePlanExit'
      | 'loadTabsForTarget'
      | 'pendingPlanExits'
      | 'selectedWorktree'
      | 'sendMessage'
      | 'worktreeChats'
    >;
    subscribe?(listener: () => void): () => void;
  };
  readonly pipelineRunsStore: {
    getState(): Pick<DesktopPipelineStoreState, 'retryExecution'>;
  };
  readonly navigator: Pick<LedgerNavigator, 'openSource'>;
  /** Asks the plan's chat to open its workflow picker once it shows. */
  readonly planWorkflowRequests: {
    request(target: LedgerChatTarget): void;
    cancel(target: LedgerChatTarget): void;
  };
}

const CHAT_UNAVAILABLE = "That chat isn't available right now.";
const PLAN_UNAVAILABLE = "That plan isn't available right now.";
const QUESTION_UNAVAILABLE = "That question isn't available right now.";
const RUN_UNAVAILABLE = "That run isn't available right now.";
const PLAN_APPROVAL_TIMEOUT_MS = 1_000;
const SEND_FAILED = "Couldn't send the message. Try again.";

function failed(message: string): LedgerViewOpenResult {
  return { ok: false, message };
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  return message.length > 0 ? message : fallback;
}

function chatTarget(wait: LedgerLiveWait): LedgerChatTarget | null {
  if (wait.chatId === null) return null;
  return {
    projectId: wait.projectId,
    worktreeId: wait.worktreeId,
    chatId: wait.chatId,
  };
}

function isLoadedChat(
  state: Pick<DesktopChatStoreState, 'worktreeChats'>,
  target: LedgerChatTarget,
): boolean {
  const key = `${target.projectId}/${target.worktreeId}`;
  return (
    state.worktreeChats[key]?.tabs.some(
      (tab) => tab.id === target.chatId && tab.kind !== 'file',
    ) ?? false
  );
}

function targetScope(target: LedgerChatTarget): LedgerViewScope {
  return {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
  };
}

interface PlanApprovalTarget {
  readonly target: LedgerChatTarget;
  readonly requestId: string;
  readonly provider: string;
  readonly interfaceMode: string;
}

function resolvePlanApprovalTarget(
  state: Pick<
    DesktopChatStoreState,
    'pendingPlanExits' | 'selectedWorktree' | 'worktreeChats'
  >,
  wait: LedgerLiveWait,
): PlanApprovalTarget | null {
  const target = chatTarget(wait);
  if (target === null) return null;
  const key = `${target.projectId}/${target.worktreeId}`;
  const worktreeChat = state.worktreeChats[key];
  const tab = worktreeChat?.tabs.find(
    (candidate) => candidate.id === target.chatId,
  );
  if (tab === undefined || tab.kind === 'file') return null;

  const pending = state.pendingPlanExits[wait.id];
  const matchingPending =
    pending?.requestId === wait.id &&
    pending?.projectId === target.projectId &&
    pending.worktreeId === target.worktreeId &&
    pending.chatId === target.chatId
      ? pending
      : undefined;
  if (pending !== undefined && matchingPending === undefined) {
    return null;
  }

  const tabRequestMatches =
    tab.pendingPlanExit !== undefined &&
    tab.pendingPlanExitRequestId === wait.id;
  const restoredTabWait =
    wait.id ===
      `plan:${target.projectId}/${target.worktreeId}/${target.chatId}` &&
    tab.pendingPlanExit !== undefined &&
    tab.pendingPlanExitRequestId === undefined;
  const requestId =
    matchingPending?.requestId ?? (tabRequestMatches ? wait.id : '');
  if (requestId !== wait.id && !restoredTabWait) return null;

  // approvePlanExit('') follows ChatInput's restored-tab fallback, which only
  // targets the currently selected worktree's active tab.
  if (
    requestId.length === 0 &&
    (state.selectedWorktree?.projectId !== target.projectId ||
      state.selectedWorktree.worktreeId !== target.worktreeId ||
      worktreeChat.activeTabId !== target.chatId)
  ) {
    return null;
  }

  const tabInput = tab.pendingPlanExit;
  const provider =
    matchingPending?.source ??
    (matchingPending !== undefined &&
    typeof matchingPending.toolInput.source === 'string'
      ? matchingPending.toolInput.source
      : tabInput?.source === 'codex' ||
          tabInput?.source === 'cursor' ||
          tabInput?.source === 'opencode' ||
          tabInput?.source === 'antigravity'
        ? tabInput.source
        : 'claude');

  return {
    target,
    requestId,
    provider,
    interfaceMode: tab.interfaceMode ?? 'canopy',
  };
}

/** The plan answers the chat offers, by the chat composer's own rules. */
function planCapabilities(target: PlanApprovalTarget): {
  readonly planImplementation: boolean;
  readonly planPipeline: boolean;
} {
  return deriveChatWorkflowCapabilities({
    resolvedProvider: target.provider,
    interfaceMode: target.interfaceMode,
    target: 'worktree',
    capabilities: ipcCanopyClient.capabilities,
  });
}

function canApprovePlan(target: PlanApprovalTarget): boolean {
  return planCapabilities(target).planImplementation;
}

function planIsPending(
  state: Pick<DesktopChatStoreState, 'pendingPlanExits' | 'worktreeChats'>,
  target: LedgerChatTarget,
  requestId: string,
): boolean {
  const pending = Object.values(state.pendingPlanExits).some(
    (entry) =>
      entry.projectId === target.projectId &&
      entry.worktreeId === target.worktreeId &&
      entry.chatId === target.chatId &&
      (requestId.length === 0 || entry.requestId === requestId),
  );
  const tab = state.worktreeChats[
    `${target.projectId}/${target.worktreeId}`
  ]?.tabs.find((candidate) => candidate.id === target.chatId);
  const tabPending =
    tab !== undefined &&
    tab.kind !== 'file' &&
    tab.pendingPlanExit !== undefined &&
    (requestId.length === 0 ||
      tab.pendingPlanExitRequestId === undefined ||
      tab.pendingPlanExitRequestId === requestId);
  return pending || tabPending;
}

function waitForPlanApproval(
  chatStore: DesktopLedgerFeedAnswerDependencies['chatStore'],
  target: PlanApprovalTarget,
): Promise<LedgerViewOpenResult> {
  return new Promise((resolve) => {
    const resources: {
      unsubscribe?: () => void;
      timeout?: ReturnType<typeof setTimeout>;
    } = {};
    let settled = false;
    const finish = (result: LedgerViewOpenResult): void => {
      if (settled) return;
      settled = true;
      resources.unsubscribe?.();
      if (resources.timeout !== undefined) clearTimeout(resources.timeout);
      resolve(result);
    };
    const check = (): void => {
      try {
        if (
          !planIsPending(chatStore.getState(), target.target, target.requestId)
        ) {
          finish({ ok: true });
        }
      } catch (error: unknown) {
        finish(failed(errorMessage(error, PLAN_UNAVAILABLE)));
      }
    };

    resources.unsubscribe = chatStore.subscribe?.(check);
    resources.timeout = setTimeout(
      () => finish(failed(PLAN_UNAVAILABLE)),
      PLAN_APPROVAL_TIMEOUT_MS,
    );
    check();
  });
}

function defaultDependencies(): DesktopLedgerFeedAnswerDependencies {
  return {
    chatStore: {
      getState: () => useChatStore.getState(),
      subscribe: (listener) => useChatStore.subscribe(() => listener()),
    },
    pipelineRunsStore: { getState: () => usePipelineRunsStore.getState() },
    navigator: DESKTOP_LEDGER_NAVIGATOR,
    planWorkflowRequests: {
      request: requestPlanWorkflow,
      cancel: cancelPlanWorkflowRequest,
    },
  };
}

/** A testable factory around the existing chat and pipeline actions. */
export function createDesktopLedgerFeedAnswerActions(
  injected?: Partial<DesktopLedgerFeedAnswerDependencies>,
): LedgerFeedAnswerActions {
  const deps: DesktopLedgerFeedAnswerDependencies = {
    ...defaultDependencies(),
    ...injected,
  };

  const sendMessage = async (
    target: LedgerChatTarget,
    text: string,
  ): Promise<LedgerViewOpenResult> => {
    try {
      let state = deps.chatStore.getState();
      if (!isLoadedChat(state, target)) {
        // Main offers persisted chats the renderer may not have opened yet.
        try {
          await state.loadTabsForTarget(target.projectId, target.worktreeId);
        } catch {
          return failed(CHAT_UNAVAILABLE);
        }
        state = deps.chatStore.getState();
        if (!isLoadedChat(state, target)) return failed(CHAT_UNAVAILABLE);
      }
      // Some refusals return without throwing; they only report here.
      let refused = false;
      await state.sendMessage(text, undefined, target, undefined, {
        throwOnDispatchFailure: true,
        // Only the Feed's text: the chat's staged files stay in its draft.
        composerAttachmentsReserved: true,
        onPreDispatchRejected: () => {
          refused = true;
        },
      });
      return refused ? failed(SEND_FAILED) : { ok: true };
    } catch (error: unknown) {
      return failed(errorMessage(error, SEND_FAILED));
    }
  };

  const openWait = async (
    wait: LedgerLiveWait,
  ): Promise<LedgerViewOpenResult> => {
    try {
      if (wait.kind === 'failed_run') {
        const executionId = wait.executionId;
        if (executionId === undefined) return failed(RUN_UNAVAILABLE);
        return await deps.navigator.openSource(
          { projectId: wait.projectId, worktreeId: wait.worktreeId },
          {
            kind: 'pipeline',
            projectId: wait.projectId,
            worktreeId: wait.worktreeId,
            executionId,
          },
        );
      }
      const target = chatTarget(wait);
      if (target === null) return failed(CHAT_UNAVAILABLE);
      return await deps.navigator.openSource(targetScope(target), {
        kind: 'chat',
        ...target,
        archived: false,
      });
    } catch (error: unknown) {
      return failed(errorMessage(error, "Couldn't open this wait. Try again."));
    }
  };

  return {
    answerQuestion: async (wait, answers): Promise<LedgerViewOpenResult> => {
      if (wait.kind !== 'question') return failed(QUESTION_UNAVAILABLE);
      try {
        const mappedAnswers: McpQuestionAnswer[] = answers.map((answer) => ({
          ...(answer.questionId === undefined
            ? {}
            : { questionId: answer.questionId }),
          question: answer.question,
          selectedOptions: [...answer.selectedOptions],
          ...(answer.freeformText === undefined
            ? {}
            : { freeformText: answer.freeformText }),
        }));
        await deps.chatStore
          .getState()
          .answerMcpQuestionAndWait(wait.id, mappedAnswers);
        return { ok: true };
      } catch (error: unknown) {
        return failed(
          errorMessage(error, "Couldn't submit the answer. Try again."),
        );
      }
    },

    approvePlan: async (wait): Promise<LedgerViewOpenResult> => {
      if (wait.kind !== 'plan') {
        return failed(PLAN_UNAVAILABLE);
      }
      try {
        const state = deps.chatStore.getState();
        const target = resolvePlanApprovalTarget(state, wait);
        if (target === null || !canApprovePlan(target)) {
          return failed(PLAN_UNAVAILABLE);
        }
        await state.approvePlanExit(target.requestId);
        return await waitForPlanApproval(deps.chatStore, target);
      } catch (error: unknown) {
        return failed(
          errorMessage(error, "Couldn't approve this plan. Try again."),
        );
      }
    },

    rejectPlan: async (wait, reply): Promise<LedgerViewOpenResult> => {
      if (wait.kind !== 'plan') return failed(PLAN_UNAVAILABLE);
      const target = chatTarget(wait);
      return target === null
        ? failed(PLAN_UNAVAILABLE)
        : sendMessage(target, reply);
    },

    planAnswers: (wait): LedgerFeedPlanAnswers => {
      const target =
        wait.kind === 'plan'
          ? resolvePlanApprovalTarget(deps.chatStore.getState(), wait)
          : null;
      // An unresolved plan keeps the plain answers; approving it reports why
      // it can't.
      if (target === null) return { implement: true, workflow: false };
      const capabilities = planCapabilities(target);
      return {
        implement: capabilities.planImplementation,
        workflow: capabilities.planPipeline,
      };
    },

    runPlanAsWorkflow: async (wait): Promise<LedgerViewOpenResult> => {
      if (wait.kind !== 'plan') return failed(PLAN_UNAVAILABLE);
      const target = resolvePlanApprovalTarget(deps.chatStore.getState(), wait);
      if (target === null || !planCapabilities(target).planPipeline) {
        return failed(PLAN_UNAVAILABLE);
      }
      // Asked before the chat opens, so its composer finds it on mount.
      deps.planWorkflowRequests.request(target.target);
      const opened = await openWait(wait);
      if (!opened.ok) deps.planWorkflowRequests.cancel(target.target);
      return opened;
    },

    retryRun: async (wait): Promise<LedgerViewOpenResult> => {
      const executionId = wait.executionId;
      if (wait.kind !== 'failed_run' || executionId === undefined) {
        return failed(RUN_UNAVAILABLE);
      }
      try {
        const result = await deps.pipelineRunsStore
          .getState()
          .retryExecution(executionId);
        return result.success
          ? { ok: true }
          : failed(result.error ?? "Couldn't retry this run. Try again.");
      } catch (error: unknown) {
        return failed(
          errorMessage(error, "Couldn't retry this run. Try again."),
        );
      }
    },

    sendMessage,

    openWait,

    openChat: async (target): Promise<LedgerViewOpenResult> => {
      try {
        return await deps.navigator.openSource(targetScope(target), {
          kind: 'chat',
          ...target,
          archived: false,
        });
      } catch (error: unknown) {
        return failed(
          errorMessage(error, "Couldn't open that chat. Try again."),
        );
      }
    },
  };
}

/** The renderer's in-place Feed answers share the chat and pipeline paths. */
export const DESKTOP_LEDGER_FEED_ANSWERS: LedgerFeedAnswerActions =
  createDesktopLedgerFeedAnswerActions();

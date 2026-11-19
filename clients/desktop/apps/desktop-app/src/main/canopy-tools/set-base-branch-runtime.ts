import { randomUUID } from 'node:crypto';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type {
  AppAdvisorActionResponse,
  McpQuestion,
  McpQuestionAnswer,
} from '@canopy/desktop-shared/types';
import type { WorktreeBaseBranchPorts } from '../lib/worktree-base-branch';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import type { WorktreeActionRuntime } from './worktree-actions';
import { worktreeChatActionKey } from './worktree-chat-core-writes';

export interface SetCurrentWorktreeBaseBranchInput {
  baseBranch: string;
  repoId?: string;
}

export type BaseBranchQuestionAsker = (
  questions: McpQuestion[],
) => Promise<McpQuestionAnswer[]>;

/** The agent's own identity; each dispatched read or write carries only its `baseBranch` row grant. */
export function agentBaseBranchCaller(chatId: string): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: `agent-action:${chatId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'mcp',
    grants: [],
  };
}

/**
 * The ports an agent's base-branch change uses, through the CAN-4125
 * `baseBranch` row. Deferred: the injected tool executor loads this module
 * eagerly, and the ports' Git, PR and worktree services must not join it.
 */
export async function agentBaseBranchPorts(
  chatId: string,
): Promise<WorktreeBaseBranchPorts> {
  const [{ mainWorktreeBaseBranchPorts }, { activeAgentCoreOperations }] =
    await Promise.all([
      import('../lib/worktree-base-branch'),
      import('./active-agent-core-operations'),
    ]);
  return mainWorktreeBaseBranchPorts(
    activeAgentCoreOperations('baseBranch'),
    agentBaseBranchCaller(chatId),
  );
}

/** A chat's approval scope: the chat whose access an agent acts with. */
export interface BaseBranchApprovalChat {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * CAN-7222: whether `chat` has Full access as of now. Its live mode must be
 * Full access, and neither a pending switch nor the mode its live session
 * applied (an admitted agent send's cap) may be stricter. An unknown mode is
 * not Full access.
 */
export async function chatHasFullAccessReader(
  chat: BaseBranchApprovalChat,
): Promise<() => boolean> {
  const { callerBoundingApprovalMode, getLiveApprovalMode } =
    await import('../approvals/live-approval-modes');
  return () =>
    getLiveApprovalMode(chat.projectId, chat.worktreeId, chat.chatId) ===
      'full-access' &&
    callerBoundingApprovalMode(
      chat.projectId,
      chat.worktreeId,
      chat.chatId,
      'full-access',
    ) === 'full-access';
}

/**
 * CAN-6024: change a worktree's base branch in main, for the tool's trusted
 * target (tool input never selects another worktree). An open pull request's
 * "update it too" choice is asked through AskUserQuestion; with nobody to ask
 * the change is refused before any write. CAN-7222: a pull request already on
 * the new base is never asked about, and a chat with Full access updates the
 * pull request without asking.
 */
export async function setWorktreeBaseBranchForAgent(input: {
  target: { projectId: string; worktreeId: string };
  chatId: string;
  /** The chat whose access applies; defaults to `chatId` in `target`. */
  approvalChat?: BaseBranchApprovalChat;
  baseBranch: string;
  repoId?: string;
  requestUserAnswers: BaseBranchQuestionAsker;
  toolUseId?: string;
  signal?: AbortSignal;
  ports?: WorktreeBaseBranchPorts;
}): Promise<AppAdvisorActionResponse> {
  const requestId = input.toolUseId ?? randomUUID();
  const { askUserBaseBranchConfirmation, setWorktreeBaseBranchAction } =
    await import('../lib/worktree-base-branch');
  return setWorktreeBaseBranchAction(
    {
      projectId: input.target.projectId,
      worktreeId: input.target.worktreeId,
      ...(input.repoId ? { repoId: input.repoId } : {}),
      baseBranch: input.baseBranch,
    },
    {
      ports: input.ports ?? (await agentBaseBranchPorts(input.chatId)),
      idempotencyKey: worktreeChatActionKey(
        input.chatId,
        input.toolUseId,
        'base-branch',
      ),
      confirm: askUserBaseBranchConfirmation(input.requestUserAnswers),
      hasFullAccess: await chatHasFullAccessReader(
        input.approvalChat ?? {
          projectId: input.target.projectId,
          worktreeId: input.target.worktreeId,
          chatId: input.chatId,
        },
      ),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    requestId,
  );
}

export async function setCurrentWorktreeBaseBranch(
  input: SetCurrentWorktreeBaseBranchInput,
  runtime: WorktreeActionRuntime,
  requestUserAnswers: BaseBranchQuestionAsker,
  context?: { toolUseId?: string; signal?: AbortSignal },
): Promise<AppAdvisorActionResponse> {
  return setWorktreeBaseBranchForAgent({
    target: { projectId: runtime.projectId, worktreeId: runtime.worktreeId },
    chatId: runtime.chatId,
    approvalChat: runtime.approvalChat ?? {
      projectId: runtime.projectId,
      worktreeId: runtime.worktreeId,
      chatId: runtime.chatId,
    },
    baseBranch: input.baseBranch,
    ...(input.repoId ? { repoId: input.repoId } : {}),
    requestUserAnswers,
    ...(context?.toolUseId ? { toolUseId: context.toolUseId } : {}),
    ...(context?.signal ? { signal: context.signal } : {}),
  });
}

import type { ApprovalRule } from '@canopy/desktop-shared/types';
import {
  AdmittedTurnApprovals,
  type CoreChatTurnApprovalAuthority,
} from '@canopy/core-runtime/node/agent/turns';
import { approvalPolicyWorkspaceId } from '../approvals/approval-rule-sources';
import {
  getApprovalDefaultsRevision,
  getChatApprovalStateRevision,
  getGlobalApprovalRulesRevision,
  getGlobalApprovalRulesSaveGeneration,
  getWorkspaceApprovalRulesRevision,
  getWorkspaceApprovalRulesSaveGeneration,
} from '../approvals/rule-revisions';

/** What core admits a chat turn's launch with: the session's approval rules. */
export type ChatTurnAdmittedRules = ApprovalRule[];

export interface ChatTurnApprovalChat {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/**
 * The revision of the approval policy one chat's turn is admitted under
 * (CAN-6995): the sum of the monotonic counters for its policy workspace's
 * and the global rule tiers, their saves in flight, the approval defaults and
 * the chat's approval state. It moves exactly when one of them does, and
 * never for another chat or another workspace's rules. Live approval modes
 * are left out: they govern the running session, and a turn sets its own
 * before it begins.
 */
export function chatTurnApprovalRevision(chat: ChatTurnApprovalChat): number {
  const workspaceId = approvalPolicyWorkspaceId(chat);
  return (
    getApprovalDefaultsRevision() +
    getChatApprovalStateRevision(chat) +
    getWorkspaceApprovalRulesRevision(workspaceId) +
    getWorkspaceApprovalRulesSaveGeneration(workspaceId) +
    getGlobalApprovalRulesRevision() +
    getGlobalApprovalRulesSaveGeneration()
  );
}

/**
 * The desktop's chat turn approval authority. A launch whose revision moved
 * while its turn was admitted is dispatched without it, so the turn runs as
 * it does today; serving from the launch (S1b-2c) makes that a refusal.
 */
export function createChatTurnApprovalAuthority(): CoreChatTurnApprovalAuthority<ChatTurnAdmittedRules> {
  return {
    currentRevision: (scope) =>
      chatTurnApprovalRevision({
        projectId: scope.workspaceId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      }),
    admitted: new AdmittedTurnApprovals<ChatTurnAdmittedRules>(),
    onStaleLaunch: 'dispatch-without',
  };
}

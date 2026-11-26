import { createHash } from 'node:crypto';
import {
  CORE_INITIATED_WORK_HOOK_CHAT_KIND,
  InitiatedWorkHookChatOutcomeSchema,
} from '@canopy/protocol/canopy-core';
import {
  OperationCancelRefusedError,
  type OperationServicePort,
} from '../operations/service';

import {
  OperationLedgerRefusedError,
  type OperationReceiptInput,
  type OperationReceiptLookup,
} from '../operations/ledger';

type ExistingHookChatClaim = Extract<
  HookChatClaim,
  { status: 'already_claimed' }
>;

function claimReceipt(request: HookChatClaimRequest): OperationReceiptInput {
  return {
    caller: HOOK_CHAT_CLAIM_CALLER,
    idempotencyKey: request.chatId,
    fingerprint: createHash('sha256')
      .update(request.runOperationId)
      .update('\0')
      .update(request.chatId)
      .update('\0')
      .update(request.userMessageId)
      .digest('hex'),
  };
}

function existingClaim(
  result: Extract<OperationReceiptLookup, { operation: unknown }>,
): ExistingHookChatClaim {
  let state: HookChatClaimState;
  if (result.status === 'in-progress') state = 'pending';
  else if (result.status === 'replay-expired') state = 'expired';
  else {
    const outcome = InitiatedWorkHookChatOutcomeSchema.safeParse(
      result.operation.outcome,
    );
    state =
      result.operation.status === 'completed' &&
      outcome.success &&
      outcome.data.accepted
        ? 'accepted'
        : result.operation.error?.code === 'core.operation.interrupted'
          ? 'interrupted'
          : 'not_accepted';
  }
  return {
    status: 'already_claimed',
    claimOperationId: result.operation.operationId,
    state,
  };
}

export const HOOK_CHAT_CLAIM_DOMAIN = 'core.initiatedWork.hookChat';
const HOOK_CHAT_CLAIM_CALLER = 'core.initiatedWork.hookChat';

export type HookChatClaimState =
  | 'pending'
  | 'accepted'
  | 'not_accepted'
  | 'interrupted'
  | 'expired';

export type HookChatClaim =
  | { status: 'claimed'; claimOperationId: string }
  | {
      status: 'already_claimed';
      claimOperationId: string;
      state: HookChatClaimState;
    };

export interface HookChatClaimRequest {
  runOperationId: string;
  chatId: string;
  userMessageId: string;
  scope: { workspaceId: string; worktreeId: string };
}

/** Start claims remain receipted after their saved outcomes expire. */
export class HookChatClaims {
  private readonly operations: OperationServicePort;

  constructor(options: { operations: OperationServicePort }) {
    this.operations = options.operations;
    this.operations.registerDomain({
      domain: HOOK_CHAT_CLAIM_DOMAIN,
      kinds: [CORE_INITIATED_WORK_HOOK_CHAT_KIND],
      restartClass: 'lost',
      cancel: () =>
        Promise.reject(
          new OperationCancelRefusedError(
            'Stop the hook chat from the chat itself.',
          ),
        ),
    });
  }

  async claim(request: HookChatClaimRequest): Promise<HookChatClaim> {
    const run = await this.operations.get(request.runOperationId);
    if (!run) throw new Error('The hook run for this chat is not recorded.');
    const result = await this.operations.admit({
      kind: CORE_INITIATED_WORK_HOOK_CHAT_KIND,
      status: 'running',
      receipt: claimReceipt(request),
      origin: {
        kind: run.origin.kind,
        sourceId: run.origin.sourceId,
        ...(run.origin.context !== undefined
          ? { context: run.origin.context }
          : {}),
      },
      owner: run.owner,
      scope: { ...request.scope, chatId: request.chatId },
    });
    const claimOperationId = result.operation.operationId;
    if (result.status === 'accepted')
      return { status: 'claimed', claimOperationId };
    return existingClaim(result);
  }

  async lookup(
    request: HookChatClaimRequest,
  ): Promise<ExistingHookChatClaim | null> {
    const result = await this.operations.lookupReceipt(
      CORE_INITIATED_WORK_HOOK_CHAT_KIND,
      claimReceipt(request),
    );
    if (result.status === 'none') return null;
    if (result.status === 'key-reused')
      throw new OperationLedgerRefusedError(
        'key-reused',
        'This request was already made with different details.',
      );
    return existingClaim(result);
  }

  async recordAccepted(
    claimOperationId: string,
    ids: { chatId: string; userMessageId: string },
  ): Promise<void> {
    await this.operations.finish(claimOperationId, {
      status: 'completed',
      outcome: {
        chatId: ids.chatId,
        userMessageId: ids.userMessageId,
        accepted: true,
      },
    });
  }

  async recordNotAccepted(
    claimOperationId: string,
    ids: { chatId: string; userMessageId: string },
    reason: 'returned' | 'removed' | 'cancelled',
  ): Promise<void> {
    await this.operations.finish(claimOperationId, {
      status: 'completed',
      outcome: {
        chatId: ids.chatId,
        userMessageId: ids.userMessageId,
        accepted: false,
        reason,
      },
    });
  }

  async recordFailed(claimOperationId: string, message: string): Promise<void> {
    await this.operations.finish(claimOperationId, {
      status: 'failed',
      error: {
        kind: 'internal',
        code: 'core.initiatedWork.hookChat.failed',
        message: message.slice(0, 4096) || 'The hook chat could not start.',
        retry: { kind: 'never' },
      },
    });
  }
}

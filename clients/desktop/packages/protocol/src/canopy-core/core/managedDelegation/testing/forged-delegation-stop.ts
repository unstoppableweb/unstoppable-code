/**
 * A renderer-forged stop and its refusal (CAN-7245), shared by the desktop
 * relay golden and the web core golden so both test one request.
 *
 * The desktop names `chat-B`, another chat of the same user, to stop
 * `DELEGATE_OF_CHAT_A`, a delegate of their chat `chat-A`. The relay can't
 * see which chat the window shows, so it sends the request as is. The web
 * core answers with the same refusal as for `MISSING_DELEGATION_STOP`, a
 * delegate that doesn't exist, so the answer reveals nothing.
 */
export const DELEGATE_OF_CHAT_A = '0c6f4a51-2b7e-4d3c-9a18-5e2f7b9d4c61';

const SCOPE = { workspaceId: 'ws-1', worktreeId: 'wt-1' } as const;

export const FORGED_DELEGATION_STOP = {
  method: 'core.managedDelegation.stop',
  params: {
    scope: SCOPE,
    chatId: 'chat-B',
    delegationId: DELEGATE_OF_CHAT_A,
    _meta: { idempotencyKey: 'forged-stop-1' },
  },
} as const;

export const MISSING_DELEGATION_STOP = {
  method: 'core.managedDelegation.stop',
  params: {
    scope: SCOPE,
    chatId: 'chat-B',
    delegationId: '5d3a9e27-8c41-4f6b-b2d0-7a1e6c9f3b58',
    _meta: { idempotencyKey: 'missing-stop-1' },
  },
} as const;

/** What the web core answers both with, as the renderer receives it. */
export const DELEGATION_STOP_REFUSAL = {
  kind: 'not_found',
  message: 'That delegation is not one of your descendants.',
  code: 'core.managedDelegation.parentUnavailable',
  retry: { kind: 'never' },
} as const;

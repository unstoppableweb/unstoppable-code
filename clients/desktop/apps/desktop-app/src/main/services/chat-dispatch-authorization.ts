/** Process-local dispatch capabilities; never serialized or accepted from clients. */
import type { ChatTurnStateScope } from './chat-turn-state-handoff';
import {
  evaluateTurnAdmission,
  type TurnOwnershipRecord,
} from './chat-turn-phase';
import {
  getChatTurnOwnership,
  type ChatTurnOwnershipSnapshot,
} from './chat-turn-ownership';

export type ChatDispatchKind = 'ordinary';

/** Live pairing check carried with a remote send or queue action (CAN-7877). */
export type ChatPairingCheck = () => boolean;

export const CHAT_SEND_AUTHORIZATION_REVOKED_MESSAGE =
  'The paired session no longer authorizes this send.';

export class ChatSendAuthorizationRevokedError extends Error {
  constructor(message = CHAT_SEND_AUTHORIZATION_REVOKED_MESSAGE) {
    super(message);
    this.name = 'ChatSendAuthorizationRevokedError';
  }
}

export function assertChatPairingAuthorized(
  canCommit: ChatPairingCheck | undefined,
  message?: string,
): void {
  if (canCommit?.() === false) {
    throw new ChatSendAuthorizationRevokedError(message);
  }
}

/** A symbol registry must validate this value; structural shape is not authority. */
export interface AuthorizedChatDispatch {
  readonly authorizationToken: symbol;
  readonly scope: ChatTurnStateScope;
  readonly dispatchOwner: symbol;
  readonly userMessageId: string;
  readonly operationEpoch: number;
  readonly kind: ChatDispatchKind;
  readonly canDispatch?: ChatPairingCheck;
}

export type ChatDispatchAuthorizationCheck =
  | { readonly kind: 'authorized'; readonly ownership: TurnOwnershipRecord }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'unknown-token'
        | 'consumed'
        | 'stale-owner'
        | 'scope-mismatch'
        | 'pairing-revoked';
    };

export interface ChatDispatchAuthorizationPort {
  issue(
    scope: ChatTurnStateScope,
    ownership: TurnOwnershipRecord & {
      readonly kind: 'dispatch';
      readonly userMessageId: string;
    },
    canDispatch?: ChatPairingCheck,
  ): AuthorizedChatDispatch;
  consume(
    authorization: AuthorizedChatDispatch,
    target: ChatTurnStateScope & { readonly userMessageId: string },
  ): ChatDispatchAuthorizationCheck;
  revoke(authorization: AuthorizedChatDispatch): void;
}

/** S5 returns this to S2a; acceptance is not a durable provider start. */
export type ChatDispatchOutcome = {
  readonly dispatchOwner: symbol;
  readonly operationEpoch: number;
} & (
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'parked';
      readonly blockedByTurnId: string;
      readonly receiptGeneration: number;
      readonly promptCommitted: boolean;
    }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'cancelled'
        | 'authorization'
        | 'deleted'
        | 'policy'
        | 'provider-refused';
    }
  | {
      readonly kind: 'failed';
      readonly error: unknown;
      readonly providerStart: 'not-started' | 'uncertain' | 'started';
    }
);

/** Host-only synchronous seam: all operations run under per-chat serialization. */
export interface ChatDispatchAuthorizationHost {
  getSnapshot(scope: ChatTurnStateScope): ChatTurnOwnershipSnapshot;
}

interface AuthorizationEntry {
  readonly authorization: AuthorizedChatDispatch;
  readonly serviceEpoch: symbol;
  readonly canDispatch?: ChatPairingCheck;
  consumed: boolean;
}

type DispatchOwnership = TurnOwnershipRecord & {
  readonly kind: 'dispatch';
  readonly userMessageId: string;
};

function sameScope(
  left: ChatTurnStateScope,
  right: ChatTurnStateScope,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.worktreeId === right.worktreeId &&
    left.chatId === right.chatId
  );
}

function findOwner(
  snapshot: ChatTurnOwnershipSnapshot,
  token: symbol,
): TurnOwnershipRecord | undefined {
  return [...snapshot.dispatchOwners, ...snapshot.stopOwners].find(
    (owner) => owner.token === token,
  );
}

/** Tokens are object-identity capabilities as well as symbol-registry entries. */
export class ChatDispatchAuthorizationRegistry implements ChatDispatchAuthorizationPort {
  private readonly entries = new Map<symbol, AuthorizationEntry>();

  constructor(private readonly host: ChatDispatchAuthorizationHost) {}

  public issue(
    scope: ChatTurnStateScope,
    ownership: DispatchOwnership,
    canDispatch?: ChatPairingCheck,
  ): AuthorizedChatDispatch {
    const snapshot = this.host.getSnapshot(scope);
    const installed = findOwner(snapshot, ownership.token);
    if (
      !sameScope(snapshot.scope, scope) ||
      snapshot.operationEpoch !== ownership.operationEpoch ||
      installed?.kind !== 'dispatch' ||
      installed.operationEpoch !== ownership.operationEpoch ||
      installed.userMessageId !== ownership.userMessageId ||
      installed.turnId !== ownership.turnId ||
      installed.reason !== ownership.reason ||
      evaluateTurnAdmission({ ...snapshot, callerToken: ownership.token })
        .kind !== 'allow'
    ) {
      throw new Error(
        'Dispatch authorization requires an installed, admitted owner',
      );
    }
    return this.register(
      scope,
      ownership,
      'ordinary',
      snapshot.serviceEpoch,
      canDispatch,
    );
  }

  public consume(
    authorization: AuthorizedChatDispatch,
    target: ChatTurnStateScope & { readonly userMessageId: string },
  ): ChatDispatchAuthorizationCheck {
    const entry = this.entries.get(authorization.authorizationToken);
    if (!entry || entry.authorization !== authorization)
      return { kind: 'refused', reason: 'unknown-token' };
    if (entry.consumed) return { kind: 'refused', reason: 'consumed' };
    if (
      !sameScope(authorization.scope, target) ||
      authorization.userMessageId !== target.userMessageId
    )
      return { kind: 'refused', reason: 'scope-mismatch' };
    const snapshot = this.host.getSnapshot(authorization.scope);
    const owner = findOwner(snapshot, authorization.dispatchOwner);
    if (
      snapshot.serviceEpoch !== entry.serviceEpoch ||
      snapshot.operationEpoch !== authorization.operationEpoch ||
      !sameScope(snapshot.scope, authorization.scope) ||
      owner?.kind !== 'dispatch' ||
      owner.operationEpoch !== authorization.operationEpoch ||
      owner.userMessageId !== authorization.userMessageId
    )
      return { kind: 'refused', reason: 'stale-owner' };
    if (entry.canDispatch?.() === false)
      return { kind: 'refused', reason: 'pairing-revoked' };
    entry.consumed = true;
    return { kind: 'authorized', ownership: owner };
  }

  public revoke(authorization: AuthorizedChatDispatch): void {
    if (
      this.entries.get(authorization.authorizationToken)?.authorization ===
      authorization
    ) {
      this.entries.delete(authorization.authorizationToken);
    }
  }

  private register(
    scope: ChatTurnStateScope,
    ownership: DispatchOwnership,
    kind: ChatDispatchKind,
    serviceEpoch: symbol,
    canDispatch?: ChatPairingCheck,
  ): AuthorizedChatDispatch {
    const authorization: AuthorizedChatDispatch = Object.freeze({
      authorizationToken: Symbol('chat dispatch authorization'),
      scope: Object.freeze({ ...scope }),
      dispatchOwner: ownership.token,
      userMessageId: ownership.userMessageId,
      operationEpoch: ownership.operationEpoch,
      kind,
      ...(canDispatch ? { canDispatch } : {}),
    });
    this.entries.set(authorization.authorizationToken, {
      authorization,
      serviceEpoch,
      ...(canDispatch ? { canDispatch } : {}),
      consumed: false,
    });
    return authorization;
  }
}

let dispatchAuthorization: ChatDispatchAuthorizationPort | undefined;
export function getChatDispatchAuthorization(): ChatDispatchAuthorizationPort {
  dispatchAuthorization ??= new ChatDispatchAuthorizationRegistry(
    getChatTurnOwnership(),
  );
  return dispatchAuthorization;
}

/** A dispatcher's typed non-acceptance; the queue's dispatch adapter returns its outcome. */
export class ChatDispatchOutcomeError extends Error {
  constructor(
    readonly outcome: Extract<
      ChatDispatchOutcome,
      { kind: 'refused' | 'parked' }
    >,
  ) {
    super(`Chat dispatch ${outcome.kind}`);
    this.name = 'ChatDispatchOutcomeError';
  }
}

/**
 * Consume a dispatch capability once, before any prompt, start or paid
 * preparation. Every dispatch carries one: the queue issues it to queued and
 * direct host dispatches alike (35c6a), so a missing one is refused.
 */
export function consumeDispatchAuthorization(
  authorization: AuthorizedChatDispatch | undefined,
  target: ChatTurnStateScope & { readonly userMessageId: string },
): void {
  if (!authorization)
    throw new Error('Chat dispatch requires an admitted capability.');
  const check = getChatDispatchAuthorization().consume(authorization, target);
  if (check.kind === 'refused') {
    if (check.reason === 'pairing-revoked')
      throw new ChatSendAuthorizationRevokedError();
    throw new ChatDispatchOutcomeError({
      kind: 'refused',
      reason: 'authorization',
      dispatchOwner: authorization.dispatchOwner,
      operationEpoch: authorization.operationEpoch,
    });
  }
}

/**
 * The last pre-send verdict under this dispatch's owner (contracts §3): when a
 * wake turn started while the prompt was prepared, the prompt parks behind it.
 */
export function wakeParkingOutcome(
  authorization: AuthorizedChatDispatch,
): Extract<ChatDispatchOutcome, { kind: 'parked' }> | undefined {
  const snapshot = getChatTurnOwnership().getSnapshot(authorization.scope);
  const verdict = evaluateTurnAdmission({
    ...snapshot,
    callerToken: authorization.dispatchOwner,
  });
  if (verdict.kind !== 'blocked') return undefined;
  const wake = verdict.blockers.find(
    (blocker) =>
      blocker.kind === 'receipt-foreground' ||
      blocker.kind === 'committed-foreground',
  );
  if (!wake || !('turnId' in wake)) return undefined;
  return {
    kind: 'parked',
    blockedByTurnId: wake.turnId,
    receiptGeneration: snapshot.receipt?.generation ?? 0,
    // Every authorized dispatch path commits its prompt before this check.
    promptCommitted: true,
    dispatchOwner: authorization.dispatchOwner,
    operationEpoch: authorization.operationEpoch,
  };
}

type DispatchAttempt = Pick<
  ChatDispatchOutcome,
  'dispatchOwner' | 'operationEpoch'
>;
export type ChatDispatchQueueAction =
  | { readonly kind: 'ignore-stale' }
  | (DispatchAttempt &
      (
        | { readonly kind: 'retain-accepted-start' }
        | {
            readonly kind: 'durable-hand-back';
            readonly blockedByTurnId: string;
            readonly receiptGeneration: number;
            readonly promptCommitted: boolean;
            readonly preserveOriginalRow: true;
            readonly emitVisiblePrompt: false;
            readonly revokeAuthorization: true;
            readonly releaseOwnerAfter: 'hand-back-commit';
          }
        | {
            readonly kind: 'retire-after-refusal-commit';
            readonly reason: Extract<
              ChatDispatchOutcome,
              { kind: 'refused' }
            >['reason'];
            readonly revokeAuthorization: true;
          }
        | {
            readonly kind:
              | 'recover-undispatched'
              | 'retain-for-reconciliation'
              | 'settle-captured-turn';
            readonly error: unknown;
            readonly revokeAuthorization: true;
          }
      ));

/** Instructions only: the queue must await durable hand-back before releasing D. */
export function getChatDispatchOutcomeAction(
  outcome: ChatDispatchOutcome,
  currentOwner?: Pick<TurnOwnershipRecord, 'token' | 'operationEpoch'>,
): ChatDispatchQueueAction {
  if (
    currentOwner &&
    (currentOwner.token !== outcome.dispatchOwner ||
      currentOwner.operationEpoch !== outcome.operationEpoch)
  )
    return { kind: 'ignore-stale' };
  const attempt = {
    dispatchOwner: outcome.dispatchOwner,
    operationEpoch: outcome.operationEpoch,
  };
  switch (outcome.kind) {
    case 'accepted':
      return { kind: 'retain-accepted-start', ...attempt };
    case 'parked':
      return {
        kind: 'durable-hand-back',
        ...attempt,
        blockedByTurnId: outcome.blockedByTurnId,
        receiptGeneration: outcome.receiptGeneration,
        promptCommitted: outcome.promptCommitted,
        preserveOriginalRow: true,
        emitVisiblePrompt: false,
        revokeAuthorization: true,
        releaseOwnerAfter: 'hand-back-commit',
      };
    case 'refused':
      return {
        kind: 'retire-after-refusal-commit',
        ...attempt,
        reason: outcome.reason,
        revokeAuthorization: true,
      };
    case 'failed':
      return {
        kind:
          outcome.providerStart === 'not-started'
            ? 'recover-undispatched'
            : outcome.providerStart === 'uncertain'
              ? 'retain-for-reconciliation'
              : 'settle-captured-turn',
        ...attempt,
        error: outcome.error,
        revokeAuthorization: true,
      };
  }
}

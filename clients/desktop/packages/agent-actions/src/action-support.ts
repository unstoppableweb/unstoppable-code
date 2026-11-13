import { hasHostAbsolutePath } from '@canopy/protocol/canopy-core';
import type {
  AgentActionLimitKind,
  AgentActionLimitReason,
  AgentActionLimitsPort,
} from './limits';
import { AgentPortError, isUnknownWriteOutcome } from './port/environment-port';
import type {
  AgentActionErrorCode,
  AgentActionResponse,
  AgentJson,
} from './response';
import type { AgentActionReceiptStore } from './receipts';
import { sha256Hex } from './sha256';
import type { AgentActionCall, AgentActionCallScope } from './surface/family';
import type { AgentActionToolResult } from './tools/definition';

export function agentActionError(
  call: AgentActionCall<unknown>,
  code: AgentActionErrorCode,
  message: string,
  options: { retryable?: boolean; result?: AgentJson } = {},
): AgentActionResponse {
  return {
    requestId: call.toolUseId ?? '',
    ok: false,
    ...(options.result !== undefined ? { result: options.result } : {}),
    error: {
      code,
      message,
      ...(options.retryable ? { retryable: true } : {}),
    },
  };
}

/** Free-text fields a portable result may carry verbatim. */
const TEXT_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'title',
  'label',
  'description',
  'lastResponse',
  'message',
]);

/** Whether a result carries a host path outside its free-text fields. */
export function containsHostPath(value: AgentJson): boolean {
  if (Array.isArray(value)) return value.some(containsHostPath);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, field]) => !TEXT_FIELDS.has(key) && containsHostPath(field),
    );
  }
  return hasHostAbsolutePath(value);
}

/** A successful response; results that leak host paths fail instead. */
export function agentActionResult(
  call: AgentActionCall<unknown>,
  type: string,
  result: AgentJson,
): AgentActionResponse {
  if (containsHostPath(result)) {
    return agentActionError(
      call,
      'execution_failed',
      `${type} returned a host-local path, which is not portable.`,
    );
  }
  return { requestId: call.toolUseId ?? '', ok: true, result };
}

export function portErrorResponse(
  call: AgentActionCall<unknown>,
  type: string,
  error: unknown,
): AgentActionResponse {
  if (error instanceof AgentPortError) {
    return agentActionError(call, error.code, error.message, {
      retryable: error.retryable,
    });
  }
  return agentActionError(call, 'execution_failed', `${type} failed.`);
}

export function missingScopeResponse(
  call: AgentActionCall<unknown>,
  type: string,
): AgentActionResponse {
  return agentActionError(
    call,
    'surface_unavailable',
    `${type} needs the calling chat's scope, which this surface did not supply.`,
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${stableJson(field)}`)
      .join(',')}}`;
  }
  const text: string | undefined = JSON.stringify(value);
  return text ?? 'null';
}

/**
 * The fingerprint of a write's request: SHA-256 over its canonical JSON
 * (object keys sorted). A key reused for a different request has a
 * different fingerprint.
 */
export function agentActionFingerprint(payload: unknown): string {
  return sha256Hex(stableJson(payload));
}

/**
 * The replay key of one write: the same tool call from the same calling
 * workspace and chat, by the same actor, in the same turn maps to the same
 * key, so a retried call cannot create a second chat or message, and a call
 * from another chat or actor never maps to it. The workspace and chat come
 * from the trusted call scope, never from the payload. Without a tool-use id
 * the payload's SHA-256 fingerprint stands in for it. Parts are URI-encoded so their separators
 * cannot make two keys collide.
 */
export function agentActionIdempotencyKey(
  type: string,
  call: AgentActionCall<unknown>,
  payload: unknown,
): string {
  return [
    'agent-action',
    type,
    ...[
      call.scope?.workspaceId ?? 'workspace-unknown',
      call.scope?.chatId ?? 'chat-unknown',
      call.actorKey ?? 'actor-unknown',
      call.turnKey ?? 'turn-unknown',
      call.toolUseId ?? `payload-${agentActionFingerprint(payload)}`,
    ].map(encodeURIComponent),
  ].join(':');
}

const LIMIT_MESSAGES: Record<
  AgentActionLimitReason,
  (limit: number) => string
> = {
  per_turn: (limit) =>
    `This turn already started ${limit} agent actions, the most one turn may start.`,
  per_hour: (limit) =>
    `You started ${limit} agent actions in the last hour, the most allowed per hour.`,
  depth: (limit) =>
    `Chats started by agents may nest at most ${limit} levels deep.`,
};

export type AgentLimitOutcome =
  | {
      ok: true;
      commit(): Promise<void>;
      markUncertain(): Promise<void>;
      release(): Promise<void>;
    }
  | { ok: false; response: AgentActionResponse };

/**
 * A limits port bound to the trusted identity its reservations count
 * against: the calling chat, its turn, and its actor.
 */
interface BoundAgentActionLimits {
  port: AgentActionLimitsPort;
  turnKey: string;
  actorKey: string;
  parentChatId: string;
}

const LIMIT_IDENTITY_UNAVAILABLE_MESSAGE =
  'This chat cannot start agent actions right now because its turn could not be identified. Retry shortly.';

/**
 * Bind a host's limits port to the call's identity. A host that enforces
 * limits must supply the turn, the actor, and the calling chat; without
 * one of them the call cannot be counted on its own, so it is refused
 * rather than counted with other calls missing the same identity.
 */
function bindAgentActionLimits(
  limits: AgentActionLimitsPort | null,
  call: AgentActionCall<unknown>,
):
  | { ok: true; limits: BoundAgentActionLimits | null }
  | { ok: false; response: AgentActionResponse } {
  if (!limits) return { ok: true, limits: null };
  const { turnKey, actorKey, scope } = call;
  if (!turnKey || !actorKey || !scope) {
    return {
      ok: false,
      response: agentActionError(
        call,
        'surface_unavailable',
        LIMIT_IDENTITY_UNAVAILABLE_MESSAGE,
        { retryable: true },
      ),
    };
  }
  return {
    ok: true,
    limits: { port: limits, turnKey, actorKey, parentChatId: scope.chatId },
  };
}

/**
 * Reserve capacity before a write; null limits mean the host has none.
 * The reservation is keyed by the write's idempotency key, so a retried tool
 * call gets its original reservation back instead of taking another slot.
 */
async function reserveAgentActionLimit(
  limits: BoundAgentActionLimits | null,
  request: {
    kind: AgentActionLimitKind;
    call: AgentActionCall<unknown>;
    parentDepth: number;
    idempotencyKey: string;
    attemptId: string;
  },
): Promise<AgentLimitOutcome> {
  if (!limits) {
    return {
      ok: true,
      commit: () => Promise.resolve(),
      markUncertain: () => Promise.resolve(),
      release: () => Promise.resolve(),
    };
  }
  const { call } = request;
  const reservation = await limits.port.reserve({
    kind: request.kind,
    turnKey: limits.turnKey,
    actorKey: limits.actorKey,
    parentChatId: limits.parentChatId,
    parentDepth: request.parentDepth,
    idempotencyKey: request.idempotencyKey,
    attemptId: request.attemptId,
  });
  if (reservation.ok) return reservation;
  return {
    ok: false,
    response: agentActionError(
      call,
      'quota_exceeded',
      LIMIT_MESSAGES[reservation.reason](reservation.limit),
      { result: { reason: reservation.reason, limit: reservation.limit } },
    ),
  };
}

export interface AgentWriteAttempt {
  /**
   * An earlier attempt of this key ended with an unknown outcome, so its
   * write may have happened. A definite failure of this attempt then proves
   * nothing about that write, and must not undo what it left behind.
   */
  uncertain: boolean;
}

export type AgentWritePreparation =
  | {
      ok: true;
      parentDepth: number;
      /** Performs the write and returns the complete tool result to record. */
      write(attempt: AgentWriteAttempt): Promise<AgentActionToolResult>;
    }
  | { ok: false; response: AgentActionResponse };

/** The tool result of an action response, as the surface engine renders it. */
export function agentActionToolResult(
  response: AgentActionResponse<string>,
): AgentActionToolResult {
  return {
    text: JSON.stringify(response, null, 2),
    isError: response.ok !== true,
  };
}

export const IDEMPOTENCY_CONFLICT_MESSAGE =
  'This tool call was already made with a different request. Use a new tool call for a new request.';

export const WRITE_IN_PROGRESS_MESSAGE =
  'An earlier attempt of this tool call is still running. Retry it shortly to get its result.';

let attempts = 0;

/** A write attempt id that is unique across processes. */
function newAttemptId(): string {
  attempts += 1;
  return `attempt-${Date.now().toString(36)}-${attempts.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * One idempotent write. A key held for a different request (another
 * fingerprint) is answered with a non-retryable `idempotency_conflict` and
 * nothing runs. A result recorded under the key is returned unchanged before anything that could have changed since: `prepare`'s
 * state checks, the limits, and the write with its inline watchers. While
 * another attempt of the same call holds the key, the call writes nothing
 * and returns a retryable `in_progress` error. Otherwise this attempt owns
 * the key: `prepare` validates the write, the limits reserve capacity for
 * this attempt, a write that definitely failed releases its own
 * reservation and abandons its claim, and a completed write commits the
 * reservation and records its complete result before it is returned.
 *
 * A write whose outcome is unknown ({@link isUnknownWriteOutcome}), or one
 * that happened but whose reservation could not be committed or whose
 * result could not be recorded, makes its key uncertain, and the key stays
 * uncertain until a result is recorded: the receipt store keeps the
 * request's fingerprint, so only the same request may claim the key again
 * and any other gets `idempotency_conflict`, and the limits mark the
 * reservation uncertain, so it keeps counting through every takeover and
 * release. A later attempt is told the key is uncertain
 * (`AgentWriteAttempt.uncertain`); its definite failure frees nothing the
 * uncertain write may depend on, and marks the reservation uncertain
 * instead of releasing it, so the slot stays counted even when the earlier
 * attempt could not mark the reservation itself. A retry that succeeds
 * commits the reservation, counting the write once, and records the result
 * it replays.
 * A host with limits that did not supply the call's turn, actor, or scope
 * gets a retryable `surface_unavailable` before the key is claimed.
 * Checks of the caller's own reach belong before this step.
 */
export async function runIdempotentWrite<H>(options: {
  receipts: AgentActionReceiptStore<H>;
  limits: AgentActionLimitsPort | null;
  kind: AgentActionLimitKind;
  call: AgentActionCall<H>;
  idempotencyKey: string;
  /** The request the key covers; its fingerprint guards against key reuse. */
  payload: unknown;
  prepare(): Promise<AgentWritePreparation>;
}): Promise<AgentActionToolResult> {
  const { receipts, call, idempotencyKey } = options;
  const bound = bindAgentActionLimits(options.limits, call);
  if (!bound.ok) return agentActionToolResult(bound.response);
  const attempt = {
    idempotencyKey,
    attemptId: newAttemptId(),
    fingerprint: agentActionFingerprint(options.payload),
  };
  const claim = await receipts.claim(attempt, call);
  if (claim.status === 'committed') return claim.result;
  if (claim.status === 'conflict') {
    return agentActionToolResult(
      agentActionError(
        call,
        'idempotency_conflict',
        IDEMPOTENCY_CONFLICT_MESSAGE,
      ),
    );
  }
  if (claim.status === 'in_progress') {
    return agentActionToolResult(
      agentActionError(call, 'in_progress', WRITE_IN_PROGRESS_MESSAGE, {
        retryable: true,
      }),
    );
  }
  let recorded = false;
  let mayHaveWritten = false;
  try {
    const prepared = await options.prepare();
    if (!prepared.ok) return agentActionToolResult(prepared.response);
    const reservation = await reserveAgentActionLimit(bound.limits, {
      kind: options.kind,
      call,
      parentDepth: prepared.parentDepth,
      idempotencyKey,
      attemptId: attempt.attemptId,
    });
    if (!reservation.ok) return agentActionToolResult(reservation.response);
    let result: AgentActionToolResult;
    try {
      result = await prepared.write({ uncertain: claim.uncertain });
    } catch (error) {
      if (isUnknownWriteOutcome(error)) {
        mayHaveWritten = true;
        await reservation.markUncertain();
      } else if (claim.uncertain) {
        await reservation.markUncertain();
      } else {
        await reservation.release();
      }
      throw error;
    }
    mayHaveWritten = true;
    try {
      await reservation.commit();
    } catch (error) {
      await reservation.markUncertain();
      throw error;
    }
    await receipts.record({ ...attempt, result }, call);
    recorded = true;
    return result;
  } finally {
    if (!recorded) {
      await (mayHaveWritten
        ? receipts.markUncertain(attempt, call)
        : receipts.abandon(attempt, call));
    }
  }
}

export function lineageOf(
  scope: AgentActionCallScope,
  callerDepth: number,
): { parentChatId: string; depth: number } {
  return { parentChatId: scope.chatId, depth: callerDepth + 1 };
}

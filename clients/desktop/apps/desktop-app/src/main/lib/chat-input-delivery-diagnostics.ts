import type { ChatSendMessageRequest } from '@canopy/desktop-shared/types';
import { isInternalChatRequest } from '@canopy/desktop-shared/lib/internal-chat-row';
import {
  chatInputDeliveryFailure,
  readChatInputDeliveryFailure,
  readChatInputRefusal,
  type ChatInputDeliveryFailure,
} from '@canopy/protocol/remote-control/shell/input-delivery';
import { buildChatSessionKey } from '../agents/session-key';
import type { SessionDiagnosticRecord } from '../observability/service';

export type ChatInputDeliveryOutcome = NonNullable<
  SessionDiagnosticRecord['inputDeliveryOutcome']
>;
export type ChatInputOrigin = NonNullable<
  SessionDiagnosticRecord['inputOrigin']
>;

export interface ChatInputDeliveryOutcomeFacts {
  projectId: string;
  worktreeId: string;
  chatId: string;
  provider: 'claude' | 'codex';
  attemptId: string;
  generation: string;
  origin: ChatInputOrigin;
  outcome: ChatInputDeliveryOutcome;
  /** The attempt's `createdAt` (epoch ms); timings are elapsed from it. */
  createdAt: number;
  /** Epoch-ms times of the phases that were observed; omitted phases are not reported. */
  admittedAt?: number;
  pickedUpAt?: number;
  withdrawnAt?: number;
  completedAt?: number;
  uncertainAt?: number;
  /** Untrusted refusal metadata; only its code is used (rejected outcomes). */
  refusal?: unknown;
  /** Untrusted failure metadata; only its code is used (unknown outcomes). */
  failure?: unknown;
  nowMs?: number;
}

const MAX_FIELD_LENGTH = 200;

/**
 * answer (asyncQuestionId) → watcher (watcherFired) → internal (managed
 * delegation via isInternalChatRequest, or initiationSource 'automation') →
 * typed.
 */
export function chatInputOrigin(
  payload:
    | Pick<
        ChatSendMessageRequest,
        | 'asyncQuestionId'
        | 'watcherFired'
        | 'managedDelegationDeliveryId'
        | 'initiationSource'
      >
    | undefined,
): ChatInputOrigin {
  if (!payload) return 'typed';
  if (payload.asyncQuestionId) return 'answer';
  if (payload.watcherFired) return 'watcher';
  if (
    isInternalChatRequest(payload) ||
    payload.initiationSource === 'automation'
  )
    return 'internal';
  return 'typed';
}

/**
 * The outcome and canonical failure for an unconfirmed attempt: the failure
 * rebuilt from its code, or `transport-error` when absent/malformed (an older
 * provider path); outcome is `unknown-${failure.class}`.
 */
export function unknownDeliveryOutcome(failure: unknown): {
  outcome: 'unknown-timeout' | 'unknown-transport' | 'unknown-restart';
  failure: ChatInputDeliveryFailure;
} {
  const canonical =
    readChatInputDeliveryFailure(failure) ??
    chatInputDeliveryFailure('transport-error');
  switch (canonical.class) {
    case 'timeout':
      return { outcome: 'unknown-timeout', failure: canonical };
    case 'restart':
      return { outcome: 'unknown-restart', failure: canonical };
    case 'transport':
      return { outcome: 'unknown-transport', failure: canonical };
  }
}

type PhaseTimings = NonNullable<SessionDiagnosticRecord['inputPhaseTimingsMs']>;

function phaseTimings(
  facts: ChatInputDeliveryOutcomeFacts,
): PhaseTimings | undefined {
  const timings: PhaseTimings = {};
  const phases: Array<[keyof PhaseTimings, number | undefined]> = [
    ['admitted', facts.admittedAt],
    ['pickedUp', facts.pickedUpAt],
    ['withdrawn', facts.withdrawnAt],
    ['completed', facts.completedAt],
    ['uncertain', facts.uncertainAt],
  ];
  let observed = false;
  for (const [phase, time] of phases) {
    if (typeof time !== 'number' || !Number.isFinite(time)) continue;
    timings[phase] = Math.max(0, time - facts.createdAt);
    observed = true;
  }
  return observed ? timings : undefined;
}

type ErrorFields = Pick<
  SessionDiagnosticRecord,
  'inputErrorClass' | 'inputErrorCode' | 'inputErrorSummary'
>;

// Codes are rebuilt through the protocol tables, so an incoming summary,
// class or error text never reaches the record.
function errorFields(facts: ChatInputDeliveryOutcomeFacts): ErrorFields {
  switch (facts.outcome) {
    case 'rejected-requeued':
    case 'rejected-final': {
      const refusal = readChatInputRefusal(facts.refusal);
      return refusal
        ? {
            inputErrorClass: 'refusal',
            inputErrorCode: refusal.code,
            inputErrorSummary: refusal.summary,
          }
        : { inputErrorClass: 'refusal' };
    }
    case 'unknown-timeout':
    case 'unknown-transport':
    case 'unknown-restart': {
      const { failure } = unknownDeliveryOutcome(facts.failure);
      return {
        inputErrorClass: failure.class,
        inputErrorCode: failure.code,
        inputErrorSummary: failure.summary,
      };
    }
    case 'picked-up':
    case 'withdrawn':
    case 'history-delivered':
    case 'history-not-delivered':
      return {};
  }
}

export function chatInputDeliveryOutcomeDiagnostic(
  facts: ChatInputDeliveryOutcomeFacts,
): SessionDiagnosticRecord {
  const inputPhaseTimingsMs = phaseTimings(facts);
  return {
    version: 1,
    timestamp: new Date(facts.nowMs ?? Date.now()).toISOString(),
    kind: 'chat_input_delivery_outcome',
    sessionKey: buildChatSessionKey(
      facts.projectId,
      facts.worktreeId,
      facts.chatId,
    ),
    projectId: facts.projectId,
    worktreeId: facts.worktreeId,
    chatId: facts.chatId,
    providerType: facts.provider,
    inputAttemptId: facts.attemptId.slice(0, MAX_FIELD_LENGTH),
    inputGeneration: facts.generation.slice(0, MAX_FIELD_LENGTH),
    inputOrigin: facts.origin,
    inputDeliveryOutcome: facts.outcome,
    ...(inputPhaseTimingsMs ? { inputPhaseTimingsMs } : {}),
    ...errorFields(facts),
  };
}

function recordLazily(record: SessionDiagnosticRecord): void {
  // Lazy: observability pulls in the provider runtime graph, which imports
  // callers of this module; a static import would create a cycle.
  void import('../observability')
    .then(({ getObservabilityService }) => {
      getObservabilityService().recordSessionDiagnostic(record);
    })
    .catch(() => undefined);
}

/** Records one outcome. A diagnostic that cannot be recorded never changes delivery. */
export function recordChatInputDeliveryOutcome(
  facts: ChatInputDeliveryOutcomeFacts,
  record: (diagnostic: SessionDiagnosticRecord) => void = recordLazily,
): void {
  try {
    record(chatInputDeliveryOutcomeDiagnostic(facts));
  } catch {
    // Delivery decisions never depend on diagnostics.
  }
}

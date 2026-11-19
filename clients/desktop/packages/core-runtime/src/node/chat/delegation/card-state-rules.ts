import {
  CardStateDraftSchema,
  CardStateV2Schema,
  STREAM_CARD_CAPS,
  type CardState,
  type CardStateDraft,
  type CardStateV2,
  type CardStateCanonical,
} from '@canopy/protocol/canopy-core';
import type {
  DelegationTranscriptSettleRequest,
  DelegationTranscriptAnswer,
  DelegationTranscriptPortResult,
} from './transcript-port';
import { canonicalDelegationJson } from './settlement-identity';
export function cardIdentity(value: unknown): string {
  const json: unknown = JSON.parse(JSON.stringify(value));
  return canonicalDelegationJson(json);
}

export function storedCardDraft(
  state: CardStateV2,
): CardStateDraft | undefined {
  const { cardRevision: _revision, canonical: _canonical, ...draft } = state;
  void _revision;
  void _canonical;
  const parsed = CardStateDraftSchema.safeParse(draft);
  return parsed.success ? parsed.data : undefined;
}

export function admissibleCardDraft(
  previous: CardStateDraft | undefined,
  next: CardStateDraft,
  settled: boolean,
): boolean {
  if (previous === undefined) return true;
  if (previous.status === 'running' && next.status === 'pending') return false;
  for (const key of ['prompt', 'routeSnapshot', 'requestedModelId'] as const) {
    if (previous[key] !== undefined && next[key] === undefined) return false;
  }
  if (previous.status !== 'pending' && previous.prompt !== next.prompt)
    return false;
  if (settled) {
    for (const key of [
      'status',
      'prompt',
      'routeSnapshot',
      'requestedModelId',
      'nativeSessionId',
      'cancelledByUser',
      'stoppedBy',
      'outputTruncated',
    ] as const) {
      if (
        cardIdentity({ value: previous[key] }) !==
        cardIdentity({ value: next[key] })
      )
        return false;
    }
  }
  return true;
}

function fitCanonicalMessage(value: string): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      Buffer.byteLength(JSON.stringify(value.slice(0, middle)), 'utf8') <=
      STREAM_CARD_CAPS.message
    )
      low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

/** Derive display only after the accepted answer reference has been bound. */
export function canonicalCardState(
  input: Pick<
    DelegationTranscriptSettleRequest,
    'outcome' | 'resultIndex' | 'answer'
  >,
  answer: DelegationTranscriptAnswer,
): CardStateCanonical {
  const { outcome } = input;
  const canonical: CardStateCanonical = {
    status: outcome.status,
    resultIndex: input.resultIndex,
    ...(outcome.error === undefined
      ? {}
      : {
          error: {
            ...outcome.error,
            message: fitCanonicalMessage(outcome.error.message),
          },
        }),
    ...(outcome.usage === undefined
      ? {}
      : {
          usage: {
            ...(outcome.usage.inputTokens === undefined
              ? {}
              : { inputTokens: outcome.usage.inputTokens }),
            ...(outcome.usage.outputTokens === undefined
              ? {}
              : { outputTokens: outcome.usage.outputTokens }),
            ...(outcome.usage.cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens: outcome.usage.cachedInputTokens }),
            ...(outcome.usage.cacheCreationInputTokens === undefined
              ? {}
              : {
                  cacheCreationInputTokens:
                    outcome.usage.cacheCreationInputTokens,
                }),
            ...(outcome.usage.costUsd === undefined
              ? {}
              : { costUsd: outcome.usage.costUsd }),
          },
        }),
    ...(outcome.stopReason === undefined
      ? {}
      : { stopReason: outcome.stopReason }),
  };
  let omitted = canonical.error?.message !== outcome.error?.message;
  if (answer.kind === 'lost') canonical.answerUnavailable = true;
  else if (answer.kind === 'empty') {
    if (answer.role === 'final') canonical.finalText = '';
    else canonical.partialText = '';
  } else if (
    answer.kind === 'body' &&
    input.answer !== null &&
    'text' in input.answer
  ) {
    const preview = input.answer.text.slice(
      0,
      STREAM_CARD_CAPS.previewCodeUnits,
    );
    omitted ||= preview !== input.answer.text;
    if (answer.role === 'final') {
      canonical.finalText = preview;
      canonical.finalTextRef = answer.ref;
    } else {
      canonical.partialText = preview;
      canonical.partialTextRef = answer.ref;
    }
  }
  if (omitted) canonical.detailOmitted = true;
  return canonical;
}

function failure<T>(
  code: 'invalid_request' | 'stale_identity' | 'conflict',
  message: string,
): DelegationTranscriptPortResult<T> {
  return { ok: false, error: { code, message, retryable: false } };
}

/** The causal counter, whole-draft presence and settled freeze shared by both hosts. */
export function prepareCardStateUpdate(
  stored: CardState | null | undefined,
  settled: boolean,
  cardRevision: number,
  cardDraft: CardStateDraft,
): DelegationTranscriptPortResult<{
  cardState: CardStateV2;
  replayed: boolean;
}> {
  const parsed = CardStateDraftSchema.safeParse(cardDraft);
  if (
    !Number.isSafeInteger(cardRevision) ||
    cardRevision < 0 ||
    !parsed.success
  )
    return failure('invalid_request', 'The card-state publication is invalid.');
  const previous = stored?.version === 2 ? stored : undefined;
  const priorDraft =
    previous === undefined ? undefined : storedCardDraft(previous);
  const nextDraft: CardStateDraft = {
    ...parsed.data,
    ...(settled && previous?.detailOmitted === true
      ? { detailOmitted: true }
      : {}),
  };
  if (previous !== undefined) {
    if (cardRevision < previous.cardRevision)
      return failure(
        'stale_identity',
        'The card publication is older than the stored state.',
      );
    if (cardRevision === previous.cardRevision)
      return priorDraft !== undefined &&
        cardIdentity(priorDraft) === cardIdentity(nextDraft)
        ? { ok: true, value: { cardState: previous, replayed: true } }
        : failure(
            'conflict',
            'The card revision already names different display metadata.',
          );
  }
  if (!admissibleCardDraft(priorDraft, nextDraft, settled))
    return failure(
      'stale_identity',
      'The card publication changes frozen or retained fields.',
    );
  const state = CardStateV2Schema.safeParse({
    ...nextDraft,
    cardRevision,
    ...(previous?.canonical === undefined
      ? {}
      : { canonical: previous.canonical }),
  });
  return state.success
    ? { ok: true, value: { cardState: state.data, replayed: false } }
    : failure(
        'invalid_request',
        'The card-state publication exceeds its bound.',
      );
}

/** Validate even stale inputs, but ignore well-formed inadmissible drafts at first settle. */
export function chooseSettlementCardDraft(
  stored: CardState | null | undefined,
  input: Pick<DelegationTranscriptSettleRequest, 'cardDraft' | 'cardRevision'>,
): DelegationTranscriptPortResult<CardStateV2> {
  const previous = stored?.version === 2 ? stored : undefined;
  let chosen = previous === undefined ? undefined : storedCardDraft(previous);
  let cardRevision = previous?.cardRevision ?? 0;
  if (input.cardDraft !== undefined || input.cardRevision !== undefined) {
    if (
      input.cardDraft === undefined ||
      input.cardRevision === undefined ||
      !Number.isSafeInteger(input.cardRevision) ||
      input.cardRevision < 0
    )
      return failure(
        'invalid_request',
        'The settlement card draft requires a safe publication counter.',
      );
    const supplied = CardStateDraftSchema.safeParse(input.cardDraft);
    if (!supplied.success)
      return failure(
        'invalid_request',
        'The settlement card draft is invalid.',
      );
    if (
      (chosen === undefined || input.cardRevision > cardRevision) &&
      admissibleCardDraft(chosen, supplied.data, false)
    ) {
      chosen = supplied.data;
      cardRevision = input.cardRevision;
    }
  }
  return { ok: true, value: { ...(chosen ?? { version: 2 }), cardRevision } };
}

import type { CanopyErrorPayload } from './errors';

/**
 * Whether a keyed write's error leaves its outcome unknown, so it may have
 * landed (CAN-7196). Fail-closed: a lost reply (unavailable, never retried)
 * is unknown, and so is every answer that asks for the same key again,
 * unless it carries a not-applied mark ({@link NOT_APPLIED_MARKS}) that a
 * surveyed producer sets only before any write. A running rebuild's refusal
 * before any post, by its exact code, is a refusal too. A producer nobody has
 * surveyed reads unknown. An internal failure with no code, whatever its
 * retry, is unknown too (CAN-7470): it is how a client reads a reply it
 * couldn't use, and how a host reports a fault it didn't type, so the write
 * may have landed. A definite internal refusal carries its code. Nothing is
 * ever sent again on its own: the caller reads what stands.
 * {@link KEYED_WRITE_OUTCOME_SHAPES} pins each shape.
 */
export function isUnknownKeyedWriteOutcome(
  payload: CanopyErrorPayload,
): boolean {
  if (isRebuildAdmissionRefusal(payload)) return false;
  if (payload.kind === 'unavailable' && payload.retry.kind === 'never')
    return true;
  if (payload.kind === 'internal' && payload.code === undefined) return true;
  return (
    payload.retry.kind === 'same_idempotency_key' && !isNotApplied(payload)
  );
}

/**
 * A running rebuild's refusal at admission, before any Core post (REG-3119):
 * definite, so never unknown. Only this exact code counts (CAN-7196).
 */
export function isRebuildAdmissionRefusal(
  payload: CanopyErrorPayload,
): boolean {
  return (
    payload.kind === 'unavailable' &&
    payload.retry.kind === 'same_idempotency_key' &&
    detail(payload, 'cloudCode') === 'cloud-worktree-recovery-in-progress'
  );
}

/** A not-applied mark: an error code a surveyed producer sets only before any write. */
export interface NotAppliedMark {
  readonly code: NonNullable<CanopyErrorPayload['code']>;
  /** The producer that sets it. */
  readonly source: string;
}

/**
 * The surveyed refusals that ask for the same key but never wrote anything:
 * only these read as refusals (CAN-7196, SWAN 05:23 GMT 19 Nov). Any other
 * same-key answer, a rate limit included, reads unknown until its producer
 * carries a mark here.
 */
export const NOT_APPLIED_MARKS: readonly NotAppliedMark[] = [
  {
    code: 'core.chat.attachment.busy',
    source: 'apps/web/src/lib/web-core/chat-attachments.ts:67-75',
  },
  // CAN-7522: the broker refused before raising anything, so no owner was
  // asked and the daemon wrote nothing.
  {
    code: 'core.pipeline.ownerUnavailable',
    source:
      'packages/core-runtime/src/node/pipeline/daemon-definitions.ts:113-124, :186-187',
  },
  // The ledger could not be used, so it recorded nothing.
  {
    code: 'core.operationLedger.unavailable',
    source: 'packages/core-runtime/src/node/operations/ledger-handlers.ts',
  },
];

function detail(payload: CanopyErrorPayload, name: string): unknown {
  const { details } = payload;
  return typeof details === 'object' && details !== null
    ? Reflect.get(details, name)
    : undefined;
}

function isNotApplied(payload: CanopyErrorPayload): boolean {
  return NOT_APPLIED_MARKS.some((mark) => payload.code === mark.code);
}

/** One error shape, whether the shared check reads it as unknown, and its producer. */
export interface KeyedWriteOutcomeShape {
  readonly name: string;
  readonly payload: CanopyErrorPayload;
  readonly unknown: boolean;
  readonly source: string;
}

const shape = (
  name: string,
  unknown: boolean,
  source: string,
  kind: CanopyErrorPayload['kind'],
  retry: CanopyErrorPayload['retry'],
  extra: Partial<Pick<CanopyErrorPayload, 'code' | 'details' | 'message'>> = {},
): KeyedWriteOutcomeShape => ({
  name,
  unknown,
  source,
  payload: { kind, message: 'Answered.', retry, ...extra },
});

const SAME_KEY = { kind: 'same_idempotency_key' } as const;

/**
 * Every error shape a keyed write's caller must read the same way, with the
 * producer it comes from, for the goldens of each caller that classifies one
 * (CAN-7196).
 */
export const KEYED_WRITE_OUTCOME_SHAPES: readonly KeyedWriteOutcomeShape[] = [
  // An answer that never came.
  shape(
    'lost, never retried',
    true,
    'S7c lost reply (packages/core-client/src/outcome.ts)',
    'unavailable',
    { kind: 'never' },
  ),
  shape(
    'a same-key retry',
    true,
    'any keyed transient answer',
    'unavailable',
    SAME_KEY,
  ),
  shape(
    "the client's own deadline after dispatch",
    true,
    'packages/core-client/src/client.ts:145-163 (forDefinition)',
    'deadline_exceeded',
    SAME_KEY,
  ),
  shape(
    'a send checked against a later send',
    true,
    'apps/web/src/lib/web-core/chat.ts:1324-1332',
    'unavailable',
    { kind: 'same_idempotency_key', delayMs: 1000 },
  ),
  shape(
    'a same-key retry with another code',
    true,
    'apps/web/src/lib/web-core/worktree-recovery.ts:95-122',
    'unavailable',
    SAME_KEY,
    {
      details: {
        reason: 'cloud_refused',
        cloudCode: 'cloud-worktree-recovery-needed',
      },
    },
  ),
  shape(
    'a same-key retry with a code that only starts like the rebuild’s',
    true,
    'none: guards the exact match',
    'unavailable',
    SAME_KEY,
    { details: { cloudCode: 'cloud-worktree-recovery-in-progress-later' } },
  ),
  // Answered after a possible write, or by a producer nobody surveyed.
  shape(
    'a rate limit with no not-applied mark',
    true,
    'apps/web/src/lib/web-core/chat.ts:311-346 (fromResponse, 429)',
    'resource_exhausted',
    { kind: 'same_idempotency_key', delayMs: 2000 },
  ),
  shape(
    'a reply over the web-core relay cap',
    true,
    'apps/desktop-app/src/main/canopy-runtime/renderer-relay/relay.ts:1047-1057',
    'resource_exhausted',
    SAME_KEY,
  ),
  shape(
    'a value over the local relay frame cap',
    true,
    'apps/desktop-app/src/main/canopy-runtime/renderer-relay/interim-in-memory-binding.ts:149-154, :241-247',
    'resource_exhausted',
    SAME_KEY,
  ),
  shape(
    'a client that failed closed with calls in flight',
    true,
    'packages/core-client/src/client.ts:990-1004, :1012-1018',
    'resource_exhausted',
    SAME_KEY,
  ),
  shape(
    'internal, asking for the same key',
    true,
    'packages/core-runtime/src/node/workspace/workspace-note-items.ts:316-325',
    'internal',
    SAME_KEY,
  ),
  shape(
    'cancelled, asking for the same key',
    true,
    'packages/core-runtime/src/runtime/worker-executor-receipts.ts:213-224',
    'cancelled',
    SAME_KEY,
  ),
  // Refused before any write.
  shape(
    'a running rebuild, before any post',
    false,
    'apps/web/src/lib/web-core/chat.ts:1333-1343 (REG-3119)',
    'unavailable',
    { kind: 'same_idempotency_key', delayMs: 1000 },
    {
      details: {
        reason: 'cloud_refused',
        cloudCode: 'cloud-worktree-recovery-in-progress',
      },
    },
  ),
  ...NOT_APPLIED_MARKS.map((mark) =>
    shape(
      `refused before any write as ${mark.code}`,
      false,
      mark.source,
      'resource_exhausted',
      { kind: 'same_idempotency_key', delayMs: 1000 },
      { code: mark.code },
    ),
  ),
  shape(
    'a capacity refusal carrying the provisioning-limit code',
    true,
    'apps/web/src/lib/cloud/cloud-service.ts:5568-5583 (a create resume re-runs the limit after its claim write)',
    'resource_exhausted',
    { kind: 'same_idempotency_key', delayMs: 2000 },
    {
      details: {
        reason: 'cloud_refused',
        cloudCode: 'CLOUD_PROVISIONING_LIMIT',
      },
    },
  ),
  shape(
    'a payment refusal carrying the credits code',
    true,
    'apps/web/src/lib/cloud/cloud-service.ts:5568-5583 (a create resume re-runs the spend gate after its claim write)',
    'resource_exhausted',
    SAME_KEY,
    { details: { reason: 'cloud_refused', cloudCode: 'INSUFFICIENT_CREDITS' } },
  ),
  shape(
    'an unmarked refusal whose text names a not-applied code',
    true,
    'none: the mark is never read from text',
    'resource_exhausted',
    SAME_KEY,
    {
      message:
        'Upstream said INSUFFICIENT_CREDITS, cloud_refused, CLOUD_PROVISIONING_LIMIT.',
    },
  ),
  shape(
    'another code asking for the same key',
    true,
    'none: only allowlisted codes are refusals',
    'resource_exhausted',
    SAME_KEY,
    { code: 'core.update.rateLimited' },
  ),
  // Not a same-key answer: the core's own words.
  shape(
    "the core's own deadline",
    false,
    'core deadline',
    'deadline_exceeded',
    {
      kind: 'never',
    },
  ),
  shape(
    "the core's own deadline, same request",
    false,
    'core deadline',
    'deadline_exceeded',
    { kind: 'same_request' },
  ),
  shape('busy, same request', false, 'inherent operations', 'unavailable', {
    kind: 'same_request',
  }),
  shape('busy, after a delay', false, 'inherent operations', 'unavailable', {
    kind: 'same_request',
    delayMs: 500,
  }),
  shape('busy, after a refresh', false, 'refresh retries', 'unavailable', {
    kind: 'after_refresh',
    resource: 'core.chat.snapshot',
  }),
  shape('out of capacity', false, 'never retries', 'resource_exhausted', {
    kind: 'never',
  }),
  shape('cancelled', false, 'never retries', 'cancelled', { kind: 'never' }),
  shape('refused', false, 'never retries', 'failed_precondition', {
    kind: 'never',
  }),
  // An internal failure: unknown unless its producer typed it (CAN-7470).
  shape(
    'an untyped internal, never retried',
    true,
    'packages/core-client/src/client.ts:607-608 (an invalid result), :838 (an undeclared error), :860 (a lease eviction)',
    'internal',
    { kind: 'never' },
  ),
  shape(
    'an untyped internal, same request',
    true,
    'none: guards that the retry hint does not matter',
    'internal',
    { kind: 'same_request' },
  ),
  shape(
    'an internal with a typed code, never retried',
    false,
    "apps/web/src/lib/web-core/cloud-run-definitions.ts:386-392 (a stored package that can't be pinned)",
    'internal',
    { kind: 'never' },
    { code: 'core.pipeline.definitionInvalid' },
  ),
];

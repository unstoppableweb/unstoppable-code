import { z } from 'zod';
import {
  AGENT_DELEGATION_PHASES,
  isDelegationStopReason,
  isDelegationStoppedBy,
  type AgentDelegationError,
  type AgentDelegationErrorCode,
  type AgentDelegationSnapshot,
  type AgentDelegationStatus,
  type AgentDelegationWorkspaceObservation,
} from '@canopy/protocol/delegation';
import {
  cutJsonPreview,
  MANAGED_MESSAGE_ERROR_CODES,
  MANAGED_MESSAGE_MODEL_ID_MAX_CHARS,
  MANAGED_MESSAGE_STATUSES,
  MANAGED_MESSAGE_USAGE_KEYS,
} from './managed-message-receipt-v2';
import { canonicalDelegationJson } from './settlement-identity';
import {
  DELEGATION_REGISTRY_MAX_ENTRY_BYTES,
  DELEGATION_REGISTRY_MAX_ID_LENGTH,
  type DelegationTranscriptReceiptEntry,
  type DelegationTranscriptReceiptKind,
  type DelegationTranscriptReceiptOperation,
} from './transcript-port';

/**
 * Bounded, immutable receipt replies (11c1, C1). Fitted once: a command's
 * acknowledgement at first acknowledgement, leaving a fixed reservation for its
 * later `final`; nothing is re-truncated at rollover. The whole journal effect
 * `{kind: 'delegation-receipt', owner: {kind: 'chat_receipts', chatId}, entry}`
 * stays within the registry's 16 KiB bound.
 */
export const DELEGATION_RECEIPT_FINAL_RESERVATION_BYTES = 4096;
const PREVIEW_BUDGETS = [4096, 1024, 0] as const;
const MESSAGE_BUDGETS = [4096, 1024, 256, 2] as const;

const CONTROL_OPERATIONS = [
  'follow_up',
  'resume',
  'steer',
  'interrupt',
  'apply',
  'discard',
] as const;
const CONTROL_STATUSES = ['accepted', 'completed', 'failed'] as const;
const RECEIPT_OPERATIONS = [
  ...CONTROL_OPERATIONS,
  'stop',
] as const satisfies readonly DelegationTranscriptReceiptOperation[];

export interface DelegationReceiptError {
  readonly code: AgentDelegationErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** Failed-apply diagnostics reduced to their count; details are omitted. */
  readonly apply?: { readonly issueCount: number };
}

export interface DelegationReceiptSnapshot {
  readonly delegationId: string;
  readonly runGeneration?: number;
  readonly resultIndex?: number;
  readonly status: AgentDelegationStatus;
  readonly phase?: AgentDelegationSnapshot['phase'];
  /** Control identity survives every reduction so replay can project it. */
  readonly control?: {
    readonly operationId: string;
    readonly operation: (typeof CONTROL_OPERATIONS)[number];
    readonly status: (typeof CONTROL_STATUSES)[number];
    readonly error?: string;
    readonly applyFailure?: { readonly issueCount: number };
  };
  readonly error?: DelegationReceiptError;
  readonly usage?: AgentDelegationSnapshot['usage'];
  readonly stopReason?: AgentDelegationSnapshot['stopReason'];
  readonly stoppedBy?: AgentDelegationSnapshot['stoppedBy'];
  readonly cancelledByUser?: boolean;
  /** At most 256 UTF-16 code units, as in 11b. */
  readonly requestedModelId?: string;
  readonly partialText?: string;
  readonly finalText?: string;
  /** The launch-time workspace observation, a small fixed shape. */
  readonly workspaceObservation?: AgentDelegationWorkspaceObservation;
  readonly outputTruncated: boolean;
}

export type DelegationReceiptAck =
  | {
      readonly ok: true;
      readonly outcome: 'accepted' | 'completed';
      readonly snapshot: DelegationReceiptSnapshot;
      readonly truncated?: true;
    }
  | {
      readonly ok: false;
      readonly error: DelegationReceiptError;
      readonly truncated?: true;
    };

export interface DelegationReceiptFinal {
  readonly status: 'completed' | 'failed';
  readonly error?: DelegationReceiptError;
}

export type DelegationReceiptReplyV1 =
  | {
      readonly kind: 'command';
      readonly ack: DelegationReceiptAck;
      /** Null while unresolved, and for a terminal acknowledgement. */
      readonly final: DelegationReceiptFinal | null;
    }
  | {
      readonly kind: 'stop';
      readonly ackStatus: 'accepted' | 'completed' | 'failed';
      readonly runGeneration: number | null;
    }
  | {
      readonly kind: 'stop_outcome';
      readonly status: 'completed' | 'failed';
      readonly finishedAt: number;
      readonly runGeneration: number | null;
      readonly error?: DelegationReceiptError;
    };

/** Entry fields fixed before a reply is fitted. */
export type DelegationReceiptDraft = Omit<
  DelegationTranscriptReceiptEntry,
  'version' | 'kind' | 'reply'
>;

export type DelegationReceiptFitResult =
  | { readonly ok: true; readonly entry: DelegationTranscriptReceiptEntry }
  | { readonly ok: false; readonly reason: string };

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const lowerUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const registryId = z.string().min(1).max(DELEGATION_REGISTRY_MAX_ID_LENGTH);
const positiveGeneration = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonNegativeTime = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const issueCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const receiptError = z.strictObject({
  code: z.enum(MANAGED_MESSAGE_ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
  apply: z.strictObject({ issueCount }).optional(),
});

const workspaceObservation = z.strictObject({
  consistency: z.literal('live_shared_worktree'),
  headRevision: z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    .nullable(),
  dirty: z.boolean().nullable(),
  observedAt: nonNegativeTime,
});

const receiptSnapshot = z.strictObject({
  delegationId: registryId,
  runGeneration: positiveGeneration.optional(),
  resultIndex: positiveGeneration.optional(),
  status: z.enum(MANAGED_MESSAGE_STATUSES),
  phase: z.enum(AGENT_DELEGATION_PHASES).optional(),
  control: z
    .strictObject({
      operationId: lowerUuid,
      operation: z.enum(CONTROL_OPERATIONS),
      status: z.enum(CONTROL_STATUSES),
      error: z.string().optional(),
      applyFailure: z.strictObject({ issueCount }).optional(),
    })
    .optional(),
  error: receiptError.optional(),
  usage: z
    .strictObject({
      inputTokens: z.number().finite().min(0).optional(),
      outputTokens: z.number().finite().min(0).optional(),
      cachedInputTokens: z.number().finite().min(0).optional(),
      cacheCreationInputTokens: z.number().finite().min(0).optional(),
      costUsd: z.number().finite().min(0).optional(),
    })
    .optional(),
  stopReason: z
    .custom<
      NonNullable<AgentDelegationSnapshot['stopReason']>
    >(isDelegationStopReason)
    .optional(),
  stoppedBy: z
    .custom<
      NonNullable<AgentDelegationSnapshot['stoppedBy']>
    >(isDelegationStoppedBy)
    .optional(),
  cancelledByUser: z.boolean().optional(),
  requestedModelId: z
    .string()
    .max(MANAGED_MESSAGE_MODEL_ID_MAX_CHARS)
    .optional(),
  partialText: z.string().optional(),
  finalText: z.string().optional(),
  workspaceObservation: workspaceObservation.optional(),
  outputTruncated: z.boolean(),
});

const ack = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    outcome: z.enum(['accepted', 'completed']),
    snapshot: receiptSnapshot,
    truncated: z.literal(true).optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: receiptError,
    truncated: z.literal(true).optional(),
  }),
]);
const final = z.strictObject({
  status: z.enum(['completed', 'failed']),
  error: receiptError.optional(),
});

const reply = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('command'),
    ack,
    final: final.nullable(),
  }),
  z.strictObject({
    kind: z.literal('stop'),
    ackStatus: z.enum(['accepted', 'completed', 'failed']),
    runGeneration: positiveGeneration.nullable(),
  }),
  z.strictObject({
    kind: z.literal('stop_outcome'),
    status: z.enum(['completed', 'failed']),
    finishedAt: nonNegativeTime,
    runGeneration: positiveGeneration.nullable(),
    error: receiptError.optional(),
  }),
]);

const draft = z.strictObject({
  chatId: registryId,
  receiptKind: z.enum(['command', 'stop', 'stop_outcome']),
  key: z.string(),
  delegationId: registryId,
  runGeneration: positiveGeneration.nullable(),
  operationId: lowerUuid,
  requestHash: sha256Hex.nullable(),
  operation: z.enum(RECEIPT_OPERATIONS),
  admittedAt: nonNegativeTime,
});

function draftProblem(value: DelegationReceiptDraft): string | undefined {
  const parsed = draft.safeParse(value);
  if (!parsed.success) return 'Invalid receipt identity or metadata';
  if (value.receiptKind === 'stop_outcome') {
    if (value.key !== value.operationId)
      return 'A stop outcome is keyed by its operationId';
    if (value.requestHash !== null) return 'A stop outcome has no request hash';
    if (value.operation !== 'stop') return 'A stop outcome is a stop operation';
    return undefined;
  }
  if (!sha256Hex.safeParse(value.key).success)
    return 'A command or stop receipt key is 64 lowercase hex';
  if (value.requestHash === null) return 'A request hash is required';
  if ((value.receiptKind === 'stop') !== (value.operation === 'stop'))
    return 'The operation does not match the receipt kind';
  return undefined;
}

/** The exact journal effect the 16 KiB bound measures. */
export function delegationReceiptEffect(
  entry: DelegationTranscriptReceiptEntry,
): unknown {
  return {
    kind: 'delegation-receipt',
    owner: { kind: 'chat_receipts', chatId: entry.chatId },
    entry,
  };
}

export function delegationReceiptEffectBytes(
  entry: DelegationTranscriptReceiptEntry,
): number {
  return Buffer.byteLength(
    canonicalDelegationJson(delegationReceiptEffect(entry)),
    'utf8',
  );
}

/** Strict validation of a stored or submitted entry, including the bound. */
export function validateDelegationReceiptEntry(
  value: unknown,
): DelegationReceiptFitResult {
  if (typeof value !== 'object' || value === null)
    return { ok: false, reason: 'A receipt must be an object' };
  const parsed = z
    .strictObject({
      version: z.literal(1),
      kind: z.literal('receipt'),
      reply,
      ...draft.shape,
    })
    .safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'Invalid receipt entry' };
  const entry: DelegationTranscriptReceiptEntry = parsed.data;
  const problem = draftProblem({
    chatId: entry.chatId,
    receiptKind: entry.receiptKind,
    key: entry.key,
    delegationId: entry.delegationId,
    runGeneration: entry.runGeneration,
    operationId: entry.operationId,
    requestHash: entry.requestHash,
    operation: entry.operation,
    admittedAt: entry.admittedAt,
  });
  if (problem) return { ok: false, reason: problem };
  if (entry.reply.kind !== entry.receiptKind)
    return { ok: false, reason: 'The reply kind does not match' };
  if (
    entry.reply.kind === 'command' &&
    entry.reply.final !== null &&
    !(entry.reply.ack.ok && entry.reply.ack.outcome === 'accepted')
  )
    return { ok: false, reason: 'Only an accepted command has a final state' };
  if (delegationReceiptEffectBytes(entry) > DELEGATION_REGISTRY_MAX_ENTRY_BYTES)
    return { ok: false, reason: 'The receipt exceeds the entry bound' };
  return { ok: true, entry };
}

function cutMessage(
  value: string,
  budget: number,
): { text: string; cut: boolean } {
  return cutJsonPreview(value, budget);
}

/** Issues retained plus omitted, saturating at the largest safe integer. */
function issueCountOf(failure: {
  readonly issues: readonly unknown[];
  readonly omittedIssues?: number;
}): number {
  const omitted =
    typeof failure.omittedIssues === 'number' &&
    Number.isSafeInteger(failure.omittedIssues) &&
    failure.omittedIssues > 0
      ? failure.omittedIssues
      : 0;
  return Math.min(Number.MAX_SAFE_INTEGER, failure.issues.length + omitted);
}

/** Cut to at most `max` UTF-16 code units without splitting a surrogate pair. */
function cutChars(value: string, max: number): { text: string; cut: boolean } {
  if (value.length <= max) return { text: value, cut: false };
  const code = value.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return { text: value.slice(0, end), cut: true };
}

function boundError(
  error: AgentDelegationError,
  budget: number,
): { value: DelegationReceiptError; cut: boolean } {
  const message = cutMessage(error.message, budget);
  const apply = error.apply
    ? { issueCount: issueCountOf(error.apply) }
    : undefined;
  return {
    value: {
      code: error.code,
      message: message.text,
      retryable: error.retryable,
      ...(apply ? { apply } : {}),
    },
    cut: message.cut || error.apply !== undefined,
  };
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function boundSnapshot(
  snapshot: AgentDelegationSnapshot,
  previewBudget: number,
  messageBudget: number,
  minimal: boolean,
): { value: DelegationReceiptSnapshot; cut: boolean } {
  let cut = minimal;
  const control = snapshot.control
    ? ((): NonNullable<DelegationReceiptSnapshot['control']> => {
        const error =
          snapshot.control.error === undefined || minimal
            ? undefined
            : cutMessage(snapshot.control.error, messageBudget);
        cut ||= error?.cut ?? false;
        const applyFailure = snapshot.control.applyFailure
          ? { issueCount: issueCountOf(snapshot.control.applyFailure) }
          : undefined;
        cut ||= applyFailure !== undefined;
        return {
          operationId: snapshot.control.operationId,
          operation: snapshot.control.operation,
          status: snapshot.control.status,
          ...(error ? { error: error.text } : {}),
          ...(applyFailure && !minimal ? { applyFailure } : {}),
        };
      })()
    : undefined;
  if (minimal)
    return {
      value: {
        delegationId: snapshot.delegationId,
        status: snapshot.status,
        ...(control ? { control } : {}),
        outputTruncated: true,
      },
      cut,
    };
  const error = snapshot.error
    ? boundError(snapshot.error, messageBudget)
    : undefined;
  cut ||= error?.cut ?? false;
  const preview = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const next = cutJsonPreview(value, Math.max(2, previewBudget));
    cut ||= next.cut;
    return previewBudget === 0 ? undefined : next.text;
  };
  const partialText = preview(snapshot.partialText);
  const finalText = preview(snapshot.finalText);
  const requestedModelId =
    snapshot.requestedModelId === undefined
      ? undefined
      : cutChars(snapshot.requestedModelId, MANAGED_MESSAGE_MODEL_ID_MAX_CHARS);
  cut ||= requestedModelId?.cut ?? false;
  if (previewBudget === 0)
    cut ||=
      snapshot.partialText !== undefined || snapshot.finalText !== undefined;
  // Copied field by field, so the receipt holds only the bounded shape.
  const parsedObservation = workspaceObservation.safeParse(
    snapshot.workspaceObservation === undefined
      ? undefined
      : {
          consistency: snapshot.workspaceObservation.consistency,
          headRevision: snapshot.workspaceObservation.headRevision,
          dirty: snapshot.workspaceObservation.dirty,
          observedAt: snapshot.workspaceObservation.observedAt,
        },
  );
  const observation = parsedObservation.success
    ? parsedObservation.data
    : undefined;
  const usageEntries = snapshot.usage
    ? MANAGED_MESSAGE_USAGE_KEYS.flatMap((key) => {
        const amount = snapshot.usage?.[key];
        return typeof amount === 'number' &&
          Number.isFinite(amount) &&
          amount >= 0
          ? [[key, amount] as const]
          : [];
      })
    : [];
  return {
    value: {
      delegationId: snapshot.delegationId,
      ...(positive(snapshot.runGeneration)
        ? { runGeneration: snapshot.runGeneration }
        : {}),
      ...(positive(snapshot.resultIndex)
        ? { resultIndex: snapshot.resultIndex }
        : {}),
      status: snapshot.status,
      ...(snapshot.phase !== undefined &&
      AGENT_DELEGATION_PHASES.some((phase) => phase === snapshot.phase)
        ? { phase: snapshot.phase }
        : {}),
      ...(control ? { control } : {}),
      ...(error ? { error: error.value } : {}),
      ...(usageEntries.length > 0
        ? { usage: Object.fromEntries(usageEntries) }
        : {}),
      ...(isDelegationStopReason(snapshot.stopReason)
        ? { stopReason: snapshot.stopReason }
        : {}),
      ...(isDelegationStoppedBy(snapshot.stoppedBy)
        ? { stoppedBy: snapshot.stoppedBy }
        : {}),
      ...(typeof snapshot.cancelledByUser === 'boolean'
        ? { cancelledByUser: snapshot.cancelledByUser }
        : {}),
      ...(requestedModelId === undefined
        ? {}
        : { requestedModelId: requestedModelId.text }),
      ...(partialText === undefined ? {} : { partialText }),
      ...(finalText === undefined ? {} : { finalText }),
      ...(observation === undefined
        ? {}
        : { workspaceObservation: observation }),
      outputTruncated: snapshot.outputTruncated === true || cut,
    },
    cut,
  };
}

function build(
  value: DelegationReceiptDraft,
  replyValue: DelegationReceiptReplyV1,
): DelegationTranscriptReceiptEntry {
  return { version: 1, kind: 'receipt', ...value, reply: replyValue };
}

function finish(
  entry: DelegationTranscriptReceiptEntry,
  reserve: number,
): DelegationReceiptFitResult | undefined {
  if (
    delegationReceiptEffectBytes(entry) + reserve >
    DELEGATION_REGISTRY_MAX_ENTRY_BYTES
  )
    return undefined;
  const checked = validateDelegationReceiptEntry(entry);
  return checked.ok ? checked : { ok: false, reason: checked.reason };
}

export type DelegationReceiptAckInput =
  | {
      readonly ok: true;
      readonly outcome: 'accepted' | 'completed';
      readonly snapshot: AgentDelegationSnapshot;
    }
  | { readonly ok: false; readonly error: AgentDelegationError };

/**
 * Fit a command acknowledgement once, at first acknowledgement, leaving the
 * fixed reservation for `final`. Total over validated drafts: previews, then
 * messages, shrink by encoded bytes, then the minimal legal form applies.
 */
export function fitDelegationReceiptAck(
  value: DelegationReceiptDraft,
  input: DelegationReceiptAckInput,
): DelegationReceiptFitResult {
  if (value.receiptKind !== 'command')
    return { ok: false, reason: 'Acknowledgements belong to command receipts' };
  const problem = draftProblem(value);
  if (problem) return { ok: false, reason: problem };
  const attempts: { preview: number; message: number; minimal: boolean }[] = [
    ...PREVIEW_BUDGETS.map((preview) => ({
      preview,
      message: MESSAGE_BUDGETS[0],
      minimal: false,
    })),
    ...MESSAGE_BUDGETS.slice(1).map((message) => ({
      preview: 0,
      message,
      minimal: false,
    })),
    ...MESSAGE_BUDGETS.slice(2).map((message) => ({
      preview: 0,
      message,
      minimal: true,
    })),
  ];
  for (const attempt of attempts) {
    let ackValue: DelegationReceiptAck;
    if (input.ok) {
      const bounded = boundSnapshot(
        input.snapshot,
        attempt.preview,
        attempt.message,
        attempt.minimal,
      );
      ackValue = {
        ok: true,
        outcome: input.outcome,
        snapshot: bounded.value,
        ...(bounded.cut ? { truncated: true as const } : {}),
      };
    } else {
      const bounded = boundError(input.error, attempt.message);
      ackValue = {
        ok: false,
        error: bounded.value,
        ...(bounded.cut ? { truncated: true as const } : {}),
      };
    }
    const fitted = finish(
      build(value, { kind: 'command', ack: ackValue, final: null }),
      DELEGATION_RECEIPT_FINAL_RESERVATION_BYTES,
    );
    if (fitted) return fitted;
  }
  return { ok: false, reason: 'The receipt identity exceeds the entry bound' };
}

export interface DelegationReceiptFinalInput {
  readonly status: 'completed' | 'failed';
  readonly error?: AgentDelegationError;
}

/** Fit a resolved state within the reservation; independent of the ack. */
export function fitDelegationReceiptFinal(
  input: DelegationReceiptFinalInput,
): DelegationReceiptFinal {
  for (const message of MESSAGE_BUDGETS) {
    const value: DelegationReceiptFinal = {
      status: input.status,
      ...(input.error ? { error: boundError(input.error, message).value } : {}),
    };
    if (
      Buffer.byteLength(canonicalDelegationJson(value), 'utf8') <=
      DELEGATION_RECEIPT_FINAL_RESERVATION_BYTES
    )
      return value;
  }
  return { status: input.status };
}

/** Fill `final` on an accepted command at archival; the ack is unchanged. */
export function completeDelegationCommandReceipt(
  entry: DelegationTranscriptReceiptEntry,
  resolved: DelegationReceiptFinal,
): DelegationReceiptFitResult {
  if (
    entry.reply.kind !== 'command' ||
    entry.reply.final !== null ||
    !entry.reply.ack.ok ||
    entry.reply.ack.outcome !== 'accepted'
  )
    return {
      ok: false,
      reason: 'Only an unresolved accepted command completes',
    };
  return validateDelegationReceiptEntry({
    ...entry,
    reply: { ...entry.reply, final: resolved },
  });
}

/** Stop alias receipts carry no snapshot. */
export function fitDelegationStopReceipt(
  value: DelegationReceiptDraft,
  ackStatus: 'accepted' | 'completed' | 'failed',
): DelegationReceiptFitResult {
  if (value.receiptKind !== 'stop')
    return { ok: false, reason: 'Not a stop receipt' };
  const problem = draftProblem(value);
  if (problem) return { ok: false, reason: problem };
  return (
    finish(
      build(value, {
        kind: 'stop',
        ackStatus,
        runGeneration: value.runGeneration,
      }),
      0,
    ) ?? { ok: false, reason: 'The receipt identity exceeds the entry bound' }
  );
}

export interface DelegationStopOutcomeInput {
  readonly status: 'completed' | 'failed';
  readonly finishedAt: number;
  readonly error?: AgentDelegationError;
}

/** One stop operation's resolved state, keyed by its operationId. */
export function fitDelegationStopOutcomeReceipt(
  value: DelegationReceiptDraft,
  input: DelegationStopOutcomeInput,
): DelegationReceiptFitResult {
  if (value.receiptKind !== 'stop_outcome')
    return { ok: false, reason: 'Not a stop outcome receipt' };
  const problem = draftProblem(value);
  if (problem) return { ok: false, reason: problem };
  for (const message of MESSAGE_BUDGETS) {
    const fitted = finish(
      build(value, {
        kind: 'stop_outcome',
        status: input.status,
        finishedAt: input.finishedAt,
        runGeneration: value.runGeneration,
        ...(input.error
          ? { error: boundError(input.error, message).value }
          : {}),
      }),
      0,
    );
    if (fitted) return fitted;
  }
  return { ok: false, reason: 'The receipt identity exceeds the entry bound' };
}

/**
 * The frozen command replay table (root plan C1, B2). Terminal acknowledgements,
 * every user acknowledgement and an unresolved agent acknowledgement replay as
 * the complete first acknowledgement, unchanged. A resolved agent command
 * copies that acknowledgement and replaces only its snapshot's control status
 * (and, on failure, its control error); `apply_failed` replays as today's
 * durable agent failure, without apply details.
 */
export function projectDelegationCommandReplay(
  replyValue: Extract<DelegationReceiptReplyV1, { kind: 'command' }>,
  caller: 'user' | 'agent',
): DelegationReceiptAck {
  const first = replyValue.ack;
  if (
    !first.ok ||
    caller === 'user' ||
    first.outcome === 'completed' ||
    replyValue.final === null
  )
    return first;
  const resolved = replyValue.final;
  if (resolved.status === 'failed' && resolved.error?.code === 'apply_failed')
    return {
      ok: false,
      error: {
        code: resolved.error.code,
        message: resolved.error.message,
        retryable: resolved.error.retryable,
      },
    };
  const control = first.snapshot.control;
  if (!control) return first;
  return {
    ...first,
    snapshot: {
      ...first.snapshot,
      control: {
        ...control,
        status: resolved.status,
        ...(resolved.status === 'failed' && resolved.error
          ? { error: resolved.error.message }
          : {}),
      },
    },
  };
}

/** Receipt kinds, re-exported for engine validators. */
export const DELEGATION_RECEIPT_KINDS = [
  'command',
  'stop',
  'stop_outcome',
] as const satisfies readonly DelegationTranscriptReceiptKind[];

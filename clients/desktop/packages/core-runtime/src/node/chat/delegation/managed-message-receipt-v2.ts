import { z } from 'zod';
import {
  AGENT_DELEGATION_PHASES,
  isDelegationStopReason,
  isDelegationStoppedBy,
  type AgentDelegationErrorCode,
  type AgentDelegationSnapshot,
  type AgentDelegationStatus,
} from '@canopy/protocol/delegation';

/**
 * Bounded managed-message receipts for stream-backed delegations (phase 11b,
 * B5). Legacy receipts keep their unversioned format; this codec is selected
 * once per operation, before the pending write, and never reselected.
 */
export const MANAGED_MESSAGE_RECEIPT_V2_MAX_BYTES = 64 * 1024;
/** Each answer preview, measured as its JSON string encoding in UTF-8 bytes. */
export const MANAGED_MESSAGE_PREVIEW_MAX_JSON_BYTES = 4096;
export const MANAGED_MESSAGE_ERROR_MAX_CHARS = 4096;
export const MANAGED_MESSAGE_CONTROL_ERROR_MAX_CHARS = 1024;
export const MANAGED_MESSAGE_MODEL_ID_MAX_CHARS = 256;
export const MANAGED_MESSAGE_UNRECORDABLE_OUTCOME =
  'Delegation outcome could not be recorded.';

const STATUSES = [
  'pending',
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
] as const satisfies readonly AgentDelegationStatus[];
const ERROR_CODES = [
  'invalid_request',
  'capability_unavailable',
  'route_unavailable',
  'auth_required',
  'interaction_required',
  'policy_blocked',
  'capacity_exceeded',
  'parent_unavailable',
  'launch_uncertain',
  'runtime_error',
  'apply_failed',
  'terminated_by_parent',
] as const satisfies readonly AgentDelegationErrorCode[];
/** Message operations only: apply and discard never produce these receipts. */
const MESSAGE_OPERATIONS = [
  'follow_up',
  'resume',
  'steer',
  'interrupt',
] as const;
const CONTROL_STATUSES = ['accepted', 'completed', 'failed'] as const;
const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheCreationInputTokens',
  'costUsd',
] as const;

type MessageOperation = (typeof MESSAGE_OPERATIONS)[number];

/** Shared with the registry receipt replies (receipt-reply.ts). */
export const MANAGED_MESSAGE_STATUSES = STATUSES;
export const MANAGED_MESSAGE_ERROR_CODES = ERROR_CODES;
export const MANAGED_MESSAGE_USAGE_KEYS = USAGE_KEYS;

/** The strict v2 snapshot: a bounded whitelist of `AgentDelegationSnapshot`. */
export interface ManagedMessageReceiptSnapshotV2 {
  readonly delegationId: string;
  readonly runGeneration?: number;
  readonly resultIndex?: number;
  readonly status: AgentDelegationStatus;
  readonly phase?: AgentDelegationSnapshot['phase'];
  readonly control?: {
    readonly operationId: string;
    readonly operation: MessageOperation;
    readonly status: (typeof CONTROL_STATUSES)[number];
    readonly error?: string;
  };
  readonly error?: {
    readonly code: AgentDelegationErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly usage?: AgentDelegationSnapshot['usage'];
  readonly stopReason?: AgentDelegationSnapshot['stopReason'];
  readonly stoppedBy?: AgentDelegationSnapshot['stoppedBy'];
  readonly cancelledByUser?: boolean;
  readonly requestedModelId?: string;
  readonly partialText?: string;
  readonly finalText?: string;
  readonly outputTruncated: boolean;
}

export type StoredManagedDelegationMessageResult =
  | { readonly ok: true; readonly snapshot: AgentDelegationSnapshot }
  | {
      readonly ok: false;
      readonly code:
        | 'parent_unavailable'
        | 'busy'
        | 'not_found'
        | 'discarded'
        | 'invalid_request'
        | 'failed';
      readonly error: string;
    };

export type ManagedMessageFailureV2 = Extract<
  StoredManagedDelegationMessageResult,
  { ok: false }
>;
export type ManagedMessageResultV2 =
  | { readonly ok: true; readonly snapshot: ManagedMessageReceiptSnapshotV2 }
  | ManagedMessageFailureV2;

export type ManagedMessageReceiptV2 =
  | {
      readonly version: 2;
      readonly codec: 'stream';
      readonly operationId: string;
      readonly requestHash: string;
      readonly status: 'pending';
    }
  | {
      readonly version: 2;
      readonly codec: 'stream';
      readonly operationId: string;
      readonly requestHash: string;
      readonly status: 'complete';
      readonly result: ManagedMessageResultV2;
    };

export class ManagedMessageReceiptDecodeError extends Error {}

function isLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\0\r\n]/.test(value)
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === 'string' && values.some((entry) => entry === value);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Cut to at most `max` UTF-16 code units without splitting a surrogate pair. */
function cutChars(value: string, max: number): { text: string; cut: boolean } {
  if (value.length <= max) return { text: value, cut: false };
  let end = max;
  if (
    end > 0 &&
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  )
    end -= 1;
  return { text: value.slice(0, end), cut: true };
}

/** UTF-8 bytes `JSON.stringify` emits for one code unit or surrogate pair. */
function jsonUnitBytes(code: number): number {
  if (code === 0x22 || code === 0x5c) return 2;
  if (
    code === 0x08 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0c ||
    code === 0x0d
  )
    return 2;
  if (code < 0x20) return 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (isHighSurrogate(code) || isLowSurrogate(code)) return 6; // lone: \uXXXX
  return 3;
}

/**
 * Cut a preview so `JSON.stringify(preview)` is at most `maxBytes` UTF-8
 * bytes, quotes included. Walks UTF-16 code units and never splits a pair.
 */
export function cutJsonPreview(
  value: string,
  maxBytes: number = MANAGED_MESSAGE_PREVIEW_MAX_JSON_BYTES,
): { text: string; cut: boolean } {
  let bytes = 2;
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    const next = index + 1 < value.length ? value.charCodeAt(index + 1) : -1;
    const pair = isHighSurrogate(code) && isLowSurrogate(next);
    const cost = pair ? 4 : jsonUnitBytes(code);
    if (bytes + cost > maxBytes)
      return { text: value.slice(0, index), cut: true };
    bytes += cost;
    index += pair ? 2 : 1;
  }
  return { text: value, cut: false };
}

const unrecordable: ManagedMessageFailureV2 = {
  ok: false,
  code: 'failed',
  error: MANAGED_MESSAGE_UNRECORDABLE_OUTCOME,
};

/**
 * Total, deterministic bounding of a broker outcome. Every rule cuts or
 * omits; only an outcome failing the identity or enum checks becomes the
 * fixed bounded failure, returned identically on first reply and replay.
 */
export function boundManagedMessageSnapshot(
  snapshot: AgentDelegationSnapshot,
): ManagedMessageResultV2 {
  if (!isLabel(snapshot.delegationId) || !oneOf(STATUSES, snapshot.status))
    return unrecordable;
  let shortened = false;
  let control: ManagedMessageReceiptSnapshotV2['control'];
  if (snapshot.control !== undefined) {
    const value = snapshot.control;
    if (
      !z.uuid().safeParse(value.operationId).success ||
      !oneOf(MESSAGE_OPERATIONS, value.operation) ||
      !oneOf(CONTROL_STATUSES, value.status)
    )
      return unrecordable;
    let error: string | undefined;
    if (value.error !== undefined) {
      const cut = cutChars(
        value.error,
        MANAGED_MESSAGE_CONTROL_ERROR_MAX_CHARS,
      );
      error = cut.text;
      shortened ||= cut.cut;
    }
    control = {
      operationId: value.operationId,
      operation: value.operation,
      status: value.status,
      ...(error === undefined ? {} : { error }),
    };
  }
  let error: ManagedMessageReceiptSnapshotV2['error'];
  if (
    snapshot.error !== undefined &&
    oneOf(ERROR_CODES, snapshot.error.code) &&
    typeof snapshot.error.retryable === 'boolean'
  ) {
    const message = cutChars(
      snapshot.error.message,
      MANAGED_MESSAGE_ERROR_MAX_CHARS,
    );
    shortened ||= message.cut;
    error = {
      code: snapshot.error.code,
      message: message.text,
      retryable: snapshot.error.retryable,
    };
  }
  let usage: ManagedMessageReceiptSnapshotV2['usage'];
  if (snapshot.usage !== undefined) {
    const entries = USAGE_KEYS.flatMap((key) => {
      const amount = snapshot.usage?.[key];
      return typeof amount === 'number' &&
        Number.isFinite(amount) &&
        amount >= 0
        ? [[key, amount] as const]
        : [];
    });
    if (entries.length > 0) usage = Object.fromEntries(entries);
  }
  let requestedModelId: string | undefined;
  if (snapshot.requestedModelId !== undefined) {
    const cut = cutChars(
      snapshot.requestedModelId,
      MANAGED_MESSAGE_MODEL_ID_MAX_CHARS,
    );
    requestedModelId = cut.text;
    shortened ||= cut.cut;
  }
  const preview = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const cut = cutJsonPreview(value);
    shortened ||= cut.cut;
    return cut.text;
  };
  const partialText = preview(snapshot.partialText);
  const finalText = preview(snapshot.finalText);
  return {
    ok: true,
    snapshot: {
      delegationId: snapshot.delegationId,
      ...(positiveInteger(snapshot.runGeneration)
        ? { runGeneration: snapshot.runGeneration }
        : {}),
      ...(positiveInteger(snapshot.resultIndex)
        ? { resultIndex: snapshot.resultIndex }
        : {}),
      status: snapshot.status,
      ...(oneOf(AGENT_DELEGATION_PHASES, snapshot.phase)
        ? { phase: snapshot.phase }
        : {}),
      ...(control ? { control } : {}),
      ...(error ? { error } : {}),
      ...(usage ? { usage } : {}),
      ...(isDelegationStopReason(snapshot.stopReason)
        ? { stopReason: snapshot.stopReason }
        : {}),
      ...(isDelegationStoppedBy(snapshot.stoppedBy)
        ? { stoppedBy: snapshot.stoppedBy }
        : {}),
      ...(typeof snapshot.cancelledByUser === 'boolean'
        ? { cancelledByUser: snapshot.cancelledByUser }
        : {}),
      ...(requestedModelId === undefined ? {} : { requestedModelId }),
      ...(partialText === undefined ? {} : { partialText }),
      ...(finalText === undefined ? {} : { finalText }),
      outputTruncated: snapshot.outputTruncated === true || shortened,
    },
  };
}

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const boundedPreview = z
  .string()
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), 'utf8') <=
      MANAGED_MESSAGE_PREVIEW_MAX_JSON_BYTES,
  );
const snapshotV2 = z.strictObject({
  delegationId: z.string().refine(isLabel),
  runGeneration: z.number().int().min(1).optional(),
  resultIndex: z.number().int().min(1).optional(),
  status: z.enum(STATUSES),
  phase: z.enum(AGENT_DELEGATION_PHASES).optional(),
  control: z
    .strictObject({
      operationId: z.uuid(),
      operation: z.enum(MESSAGE_OPERATIONS),
      status: z.enum(CONTROL_STATUSES),
      error: z.string().max(MANAGED_MESSAGE_CONTROL_ERROR_MAX_CHARS).optional(),
    })
    .optional(),
  error: z
    .strictObject({
      code: z.enum(ERROR_CODES),
      message: z.string().max(MANAGED_MESSAGE_ERROR_MAX_CHARS),
      retryable: z.boolean(),
    })
    .optional(),
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
  partialText: boundedPreview.optional(),
  finalText: boundedPreview.optional(),
  outputTruncated: z.boolean(),
});
const resultV2 = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), snapshot: snapshotV2 }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      'parent_unavailable',
      'busy',
      'not_found',
      'discarded',
      'invalid_request',
      'failed',
    ]),
    error: z.string().max(MANAGED_MESSAGE_ERROR_MAX_CHARS),
  }),
]);
const receiptV2 = z.discriminatedUnion('status', [
  z.strictObject({
    version: z.literal(2),
    codec: z.literal('stream'),
    operationId: z.uuid(),
    requestHash: sha256Hex,
    status: z.literal('pending'),
  }),
  z.strictObject({
    version: z.literal(2),
    codec: z.literal('stream'),
    operationId: z.uuid(),
    requestHash: sha256Hex,
    status: z.literal('complete'),
    result: resultV2,
  }),
]);

/** Whether a decoded receipt file selects the versioned codec. */
export function isVersionedManagedMessageReceipt(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'version' in value;
}

/**
 * Decode a versioned receipt. Any other version, or a malformed v2 file,
 * throws: the service maps it to its existing failed path, never re-executing.
 */
export function decodeManagedMessageReceiptV2(
  value: unknown,
): ManagedMessageReceiptV2 {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 2
  )
    throw new ManagedMessageReceiptDecodeError(
      'Unsupported managed message receipt version',
    );
  const parsed = receiptV2.safeParse(value);
  if (!parsed.success)
    throw new ManagedMessageReceiptDecodeError(
      'Invalid managed message receipt',
    );
  return parsed.data;
}

/** Compact JSON for a v2 receipt; refuses anything over the receipt cap. */
export function encodeManagedMessageReceiptV2(
  receipt: ManagedMessageReceiptV2,
): string {
  const encoded = JSON.stringify(decodeManagedMessageReceiptV2(receipt));
  if (Buffer.byteLength(encoded, 'utf8') > MANAGED_MESSAGE_RECEIPT_V2_MAX_BYTES)
    throw new ManagedMessageReceiptDecodeError(
      'Managed message receipt exceeds its bound',
    );
  return encoded;
}

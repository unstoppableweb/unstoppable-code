/** Durable application-generated transcript provenance; never inferred from text. */
export type AutoResumeReason =
  | 'app_shutdown'
  | 'usage_limit'
  | 'authentication'
  | 'provider_sign_in'
  | 'auth_recovery';

export interface AutoResumeMetadata {
  reason: AutoResumeReason;
  /** Trusted display name captured at resume time, independent of later model changes. */
  providerName?: string;
  resumesUserMessageId?: string;
  resendsUserMessage: boolean;
}

export type ToolInterruptionReason =
  | 'app_restart'
  | 'fork'
  | 'stopped'
  | 'unknown';
export interface ToolInterruption {
  reason: ToolInterruptionReason;
  at: number;
}

export function readAutoResumeMetadata(
  value: unknown,
): AutoResumeMetadata | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('reason' in value) ||
    !('resendsUserMessage' in value) ||
    typeof value.resendsUserMessage !== 'boolean'
  )
    return undefined;
  const reason = value.reason;
  if (
    reason !== 'app_shutdown' &&
    reason !== 'usage_limit' &&
    reason !== 'authentication' &&
    reason !== 'provider_sign_in' &&
    reason !== 'auth_recovery'
  )
    return undefined;
  const anchor =
    'resumesUserMessageId' in value ? value.resumesUserMessageId : undefined;
  if (anchor !== undefined && (typeof anchor !== 'string' || !anchor))
    return undefined;
  const providerName =
    'providerName' in value && typeof value.providerName === 'string'
      ? value.providerName.trim()
      : undefined;
  return {
    reason,
    ...(providerName && providerName.length <= 100 ? { providerName } : {}),
    resendsUserMessage: value.resendsUserMessage,
    ...(typeof anchor === 'string' ? { resumesUserMessageId: anchor } : {}),
  };
}

export function readToolInterruption(
  value: unknown,
): ToolInterruption | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('reason' in value) ||
    !('at' in value) ||
    typeof value.at !== 'number' ||
    !Number.isFinite(value.at) ||
    value.at < 0
  )
    return undefined;
  const reason = value.reason;
  if (
    reason !== 'app_restart' &&
    reason !== 'fork' &&
    reason !== 'stopped' &&
    reason !== 'unknown'
  )
    return undefined;
  return { reason, at: value.at };
}

/** Historical output is retained. Only known synthetic carriers may use this compatibility mapping. */
export const TOOL_SETTLEMENT_OUTPUT = {
  app_restart: 'Interrupted by app restart',
  fork: 'Interrupted by fork',
  stopped: 'Cancelled',
  unknown: 'Interrupted',
} as const;

/** Resume metadata may live in cached prompt_source parts on older relays. */
export function readChatAutoResume(message: {
  autoResume?: unknown;
  parts?: readonly { kind: string; data?: unknown }[];
}): AutoResumeMetadata | undefined {
  const direct = readAutoResumeMetadata(message.autoResume);
  if (direct) return direct;
  for (const part of message.parts ?? []) {
    if (
      part.kind === 'prompt_source' &&
      typeof part.data === 'object' &&
      part.data !== null &&
      'autoResume' in part.data
    ) {
      const value = readAutoResumeMetadata(part.data.autoResume);
      if (value) return value;
    }
  }
  return undefined;
}

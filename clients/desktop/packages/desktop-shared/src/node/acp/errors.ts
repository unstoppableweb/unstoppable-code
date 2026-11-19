export type AcpErrorCode =
  | 'closed'
  | 'timeout'
  | 'cancelled'
  | 'unsupported'
  | 'busy'
  | 'invalid-session'
  | 'invalid-input'
  | 'stale-generation'
  | 'protocol'
  | 'provider'
  /** The host's own update handler threw or rejected (CAN-7117). */
  | 'handler-failed';

/**
 * Deliberately excludes raw provider errors, prompts, and credential-bearing
 * data. A `provider` failure keeps the agent's bounded, redacted explanation
 * in `providerDetails`, separately from the authored display message.
 */
export class AcpClientError extends Error {
  /** JSON-RPC method that failed, when the failure came from a request. */
  readonly method?: string;
  /** Numeric JSON-RPC error code reported by the agent, when one was given. */
  readonly rpcCode?: number;
  /** Bounded, redacted agent text for Copy details, never a display headline. */
  readonly providerDetails?: string;
  /**
   * The host failure behind a `handler-failed` error, for local logs only.
   * Non-enumerable, and not `cause`, so serialization and the cause walkers
   * of telemetry and failure classification never reach it (CAN-7117).
   */
  declare readonly runtimeCause: unknown;

  constructor(
    readonly code: AcpErrorCode,
    message: string,
    details: {
      method?: string;
      rpcCode?: number;
      providerDetails?: string;
      runtimeCause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'AcpClientError';
    if (details.method !== undefined) this.method = details.method;
    if (details.rpcCode !== undefined) this.rpcCode = details.rpcCode;
    if (details.providerDetails !== undefined)
      this.providerDetails = details.providerDetails;
    Object.defineProperty(this, 'runtimeCause', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: details.runtimeCause,
    });
  }
}

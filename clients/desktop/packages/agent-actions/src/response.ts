/**
 * Serializable JSON-only value returned by agent actions. The strict shape
 * rules out classes, functions, dates, etc., so every host can transport
 * results without lossy conversion.
 */
export type AgentJson =
  | null
  | string
  | number
  | boolean
  | AgentJson[]
  | { [key: string]: AgentJson };

/**
 * Closed enum of error codes returned from agent action dispatches.
 * Consumers must use these exact strings — ad-hoc error code strings break
 * cross-layer recovery logic.
 */
export type AgentActionErrorCode =
  | 'invalid_payload'
  | 'invalid_target'
  | 'not_found'
  | 'unsupported_action'
  | 'stale_ui_state'
  | 'surface_unavailable'
  | 'execution_failed'
  | 'timeout'
  | 'read_only_source'
  | 'missing_capability'
  | 'authentication_failed'
  | 'authorization_conflict'
  | 'validation_failed'
  | 'quota_exceeded'
  | 'in_progress'
  | 'idempotency_conflict'
  | 'stale_content_hash'
  | 'navigation_failed'
  | 'advisor_access_disabled'
  | 'owner_context_unavailable'
  | 'cursor_expired'
  | 'cursor_context_changed'
  | 'unsupported_filter'
  | 'scan_budget_exceeded'
  | 'unknown_bot';

/** Detailed error returned from a failed agent action dispatch. */
export interface AgentActionError<TCode extends string = AgentActionErrorCode> {
  code: TCode;
  message: string;
  /**
   * When `true`, the caller may retry the same action without changing the
   * payload (e.g. transient `surface_unavailable` while a panel is still
   * mounting). When omitted or `false`, the caller must update the action
   * or surface the error to the user.
   */
  retryable?: boolean;
}

export interface AgentActionResponse<
  TCode extends string = AgentActionErrorCode,
> {
  requestId: string;
  ok: boolean;
  result?: AgentJson;
  error?: AgentActionError<TCode>;
  /** Internal agent-tool transport image; adapters must not serialize it as text. */
  toolImageDataUrl?: string;
}

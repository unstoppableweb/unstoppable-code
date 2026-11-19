// How a workflow step's last finished attempt was billed, derived when read
// from the reserved route output keys the step runner writes on every exit
// path (CAN-7256). Browser-safe: imports nothing, so the desktop renderer and
// the Portal projection can read it. Not persisted as its own field.

/**
 * Reserved step-output key the executor sets to `'true'` when a model-aware
 * agent action's LLM traffic was routed through the AI Credits gateway proxy.
 * Consumed by desktop observability (`syncPipelineStep`) so routed pipeline
 * turns are not mis-attributed to a native provider subscription account.
 */
export const AI_CREDITS_ROUTED_OUTPUT_KEY = 'canopy_ai_credits_routed';
/** Persisted proof that this exact step used an organization-owned gateway. */
export const MODEL_GATEWAY_ROUTED_OUTPUT_KEY = 'canopy_model_gateway_routed';
/**
 * Set when the step's agent went through the account proxy (CAN-4030), so
 * desktop observability credits no native account with it.
 */
export const ACCOUNT_PROXY_ROUTED_OUTPUT_KEY = 'canopy_account_proxy_routed';

/** The value the step runner writes to a route key the attempt used. */
const ROUTED_OUTPUT_VALUE = 'true';

/** The three route keys, for surfaces that hide them from raw outputs. */
export const STEP_BILLING_ROUTE_OUTPUT_KEYS: ReadonlySet<string> = new Set([
  AI_CREDITS_ROUTED_OUTPUT_KEY,
  MODEL_GATEWAY_ROUTED_OUTPUT_KEY,
  ACCOUNT_PROXY_ROUTED_OUTPUT_KEY,
]);

export type StepBillingRoute = 'ai_credits' | 'model_gateway' | 'account_proxy';

/**
 * The billing route of a step's last finished attempt, or `undefined` when it
 * ran natively, is still running, or the outputs are unknown. A key counts
 * only when it holds the routed value. A gateway step also sets the AI
 * Credits key, so the gateway wins; AI Credits and the account proxy never
 * appear together.
 */
export function stepBillingRoute(
  outputs: Readonly<Record<string, string>> | undefined,
): StepBillingRoute | undefined {
  if (!outputs) return undefined;
  if (outputs[MODEL_GATEWAY_ROUTED_OUTPUT_KEY] === ROUTED_OUTPUT_VALUE) {
    return 'model_gateway';
  }
  if (outputs[ACCOUNT_PROXY_ROUTED_OUTPUT_KEY] === ROUTED_OUTPUT_VALUE) {
    return 'account_proxy';
  }
  if (outputs[AI_CREDITS_ROUTED_OUTPUT_KEY] === ROUTED_OUTPUT_VALUE) {
    return 'ai_credits';
  }
  return undefined;
}

export type StepBillingOwnerKind = 'personal' | 'organization';

/**
 * The owner kind of a run's persisted `execution_context` (`personal` /
 * `org:<uuid>`). Older runs omit it, which every consumer treats as Personal.
 * Only the kind leaves this function, never the organization id.
 */
export function executionOwnerKind(
  executionContext: string | undefined,
): StepBillingOwnerKind {
  return executionContext === undefined || executionContext === 'personal'
    ? 'personal'
    : 'organization';
}

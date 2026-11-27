/**
 * Billing readiness: can this user start a chat at all? Hosts reduce their
 * own facts (native sign-ins, AI Credits, gateways, local and CLI providers)
 * to one tri-state per source; this module folds them into a single answer
 * and holds the billing setup gate's latch.
 *
 * `unknown` never gates. A source that is off or absent in the build is
 * `unavailable` (or omitted), never `unknown`, and a local probe that errors
 * settles to `unavailable`, so a stuck fact cannot silently disable the gate.
 * A network read that fails stays `unknown`, which keeps the gate away
 * offline; the main-process send refusal is the backstop for that window.
 */

/**
 * Sources that can make a chat runnable, in the fixed order ready ids are
 * reported (for analytics). Kept separate from `ProviderSourceId` so
 * readiness never grows the provider-choice row union.
 */
export const BILLING_READINESS_SOURCE_ORDER = [
  'claude',
  'codex',
  'credits',
  'gateway',
  'org-gateway',
  'ollama',
  'cursor',
  'copilot',
  'opencode',
  'antigravity',
  'provider-key',
] as const;

export type BillingReadinessSourceId =
  (typeof BILLING_READINESS_SOURCE_ORDER)[number];

export type BillingReadinessFactState = 'ready' | 'unavailable' | 'unknown';

export interface BillingReadinessFact {
  id: BillingReadinessSourceId;
  state: BillingReadinessFactState;
}

export type BillingReadinessState = 'ready' | 'none' | 'unknown';

export interface BillingReadiness {
  state: BillingReadinessState;
  /** Ready sources in {@link BILLING_READINESS_SOURCE_ORDER}, deduplicated. */
  readyIds: readonly BillingReadinessSourceId[];
}

/**
 * Any ready fact → `ready`; every fact unavailable → `none`; otherwise
 * `unknown`. An empty fact list is `unknown`: a host that supplies nothing has
 * not proved the user has no source.
 */
export function resolveBillingReadiness(
  facts: readonly BillingReadinessFact[],
): BillingReadiness {
  const ready = new Set<BillingReadinessSourceId>();
  let anyUnknown = false;
  for (const fact of facts) {
    if (fact.state === 'ready') ready.add(fact.id);
    else if (fact.state === 'unknown') anyUnknown = true;
  }
  const readyIds = BILLING_READINESS_SOURCE_ORDER.filter((id) => ready.has(id));
  if (readyIds.length > 0) return { state: 'ready', readyIds };
  if (facts.length === 0 || anyUnknown) return { state: 'unknown', readyIds };
  return { state: 'none', readyIds };
}

/**
 * The billing setup gate's latched state. `scopeKey` is the scope the latch
 * answers for: the signed-in account on desktop, the account plus target
 * owner on web. `null` is a scope with no identity yet.
 */
export interface BillingGateState {
  shown: boolean;
  scopeKey: string | null;
}

export const INITIAL_BILLING_GATE_STATE: BillingGateState = {
  shown: false,
  scopeKey: null,
};

export type BillingGateTransition =
  | 'none'
  /** Hidden → shown on a confirmed `none`. */
  | 'shown'
  /** Shown → hidden because a source became ready. */
  | 'ended'
  /** Shown → hidden because the scope changed (no "end" event). */
  | 'scope-reset';

export interface BillingGateResult {
  state: BillingGateState;
  transition: BillingGateTransition;
}

/**
 * Pure latch for the billing setup gate. Hidden → shown only on `none`;
 * shown → hidden only on `ready`; `unknown` keeps the current state, so a
 * probe refresh mid sign-in never unmounts the panel. A scope key change
 * resets to hidden before the new readiness is applied, so a `none` for one
 * account or owner never gates another whose facts are still unknown.
 * Returns the same state object when nothing changes, for cheap equality.
 */
export function resolveBillingGate(
  previous: BillingGateState,
  readiness: BillingReadinessState,
  scopeKey: string | null,
): BillingGateResult {
  const scopeChanged = previous.scopeKey !== scopeKey;
  const wasShown = scopeChanged ? false : previous.shown;
  const shown =
    readiness === 'none' ? true : readiness === 'ready' ? false : wasShown;
  // A new scope that confirms `none` straight away starts a fresh episode
  // (`wasShown` is already reset), so it reports `shown`.
  const transition: BillingGateTransition =
    previous.shown && !shown
      ? scopeChanged
        ? 'scope-reset'
        : 'ended'
      : !wasShown && shown
        ? 'shown'
        : 'none';
  if (!scopeChanged && shown === previous.shown) {
    return { state: previous, transition };
  }
  return { state: { shown, scopeKey }, transition };
}

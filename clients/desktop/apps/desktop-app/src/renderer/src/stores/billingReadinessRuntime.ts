import {
  INITIAL_BILLING_GATE_STATE,
  resolveBillingGate,
  resolveBillingReadiness,
  type BillingGateState,
  type BillingGateTransition,
  type BillingReadiness,
  type BillingReadinessFact,
} from '@canopy/app-state/provider-choice';

/**
 * Billing readiness and the billing setup gate's latch for this renderer,
 * held outside React so every new-chat surface reads one answer.
 *
 * Facts are computed once, at the window root (`useDesktopBillingReadinessSync`),
 * and published here only when a field changes. Mount points subscribe with
 * `useSyncExternalStore`, so a window with many chats adds no probes. A window
 * that never mounts the sync stays `unknown` and shows no gate: `unknown`
 * never gates, and main's send refusal is the backstop.
 *
 * In-memory only. Persisting the gate across launches would show a false gate
 * to a user who fixed billing outside the app.
 */
export interface DesktopBillingGateSnapshot {
  readonly readiness: BillingReadiness;
  readonly gate: BillingGateState;
}

const UNKNOWN_SNAPSHOT: DesktopBillingGateSnapshot = {
  readiness: { state: 'unknown', readyIds: [] },
  gate: INITIAL_BILLING_GATE_STATE,
};

let snapshot: DesktopBillingGateSnapshot = UNKNOWN_SNAPSHOT;
let factsKey = '';
const listeners = new Set<() => void>();
const transitionListeners = new Set<
  (transition: BillingGateTransition, readiness: BillingReadiness) => void
>();

function factsSignature(
  facts: readonly BillingReadinessFact[],
  scopeKey: string | null,
): string {
  return `${scopeKey ?? ''}#${facts
    .map((fact) => `${fact.id}:${fact.state}`)
    .join(',')}`;
}

/**
 * Publish the window's readiness facts under `scopeKey` (the signed-in
 * account; `null` before an account read settles). A no-op when neither the
 * facts nor the scope changed, so an unrelated root render wakes nothing.
 */
export function publishDesktopBillingReadiness(
  facts: readonly BillingReadinessFact[],
  scopeKey: string | null,
): void {
  const key = factsSignature(facts, scopeKey);
  if (key === factsKey) return;
  factsKey = key;
  const readiness = resolveBillingReadiness(facts);
  const { state: gate, transition } = resolveBillingGate(
    snapshot.gate,
    readiness.state,
    scopeKey,
  );
  snapshot = { readiness, gate };
  listeners.forEach((listener) => listener());
  if (transition !== 'none') {
    transitionListeners.forEach((listener) => listener(transition, readiness));
  }
}

export function getDesktopBillingGateSnapshot(): DesktopBillingGateSnapshot {
  return snapshot;
}

export function subscribeDesktopBillingGate(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** Latch edges (`shown`, `ended`, `scope-reset`), for analytics. */
export function subscribeDesktopBillingGateTransitions(
  listener: (
    transition: BillingGateTransition,
    readiness: BillingReadiness,
  ) => void,
): () => void {
  transitionListeners.add(listener);
  return (): void => {
    transitionListeners.delete(listener);
  };
}

/** Test seam: back to the launch state. */
export function resetDesktopBillingReadinessForTests(): void {
  snapshot = UNKNOWN_SNAPSHOT;
  factsKey = '';
  listeners.forEach((listener) => listener());
}

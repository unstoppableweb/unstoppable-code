import type {
  BillingLane,
  BillingLaneAvailability,
} from '@canopy/desktop-shared/lib/default-model-lane';

/**
 * Last known billing-lane facts, held outside the Zustand store graph.
 *
 * A direct mirror of `modelPolicyRuntime`, and for the same reason: lane facts
 * arrive asynchronously (auth probes, the credits read) but `resolveTabDefaults`
 * is a synchronous pure function reached from `chatStore`. Routing them through
 * `modelCatalogStore` — which already imports `chatStore` — would close an
 * import cycle at startup.
 *
 * Every slot is tri-state. `undefined` means UNKNOWN, never "false": the three
 * upstream auth predicates disagree by design about a failed probe, and
 * collapsing an inconclusive read into a negative is exactly how a paying
 * subscriber gets diverted onto another lane.
 */
const UNKNOWN_AVAILABILITY: BillingLaneAvailability = {
  claudeNativeAuth: undefined,
  codexNativeAuth: undefined,
  creditsEligible: undefined,
};

let currentAvailability: BillingLaneAvailability = UNKNOWN_AVAILABILITY;
let currentLastResolvedLane: BillingLane | undefined;
let currentGuestPrincipal: boolean | undefined;
let currentCodexAccountModels: ReadonlySet<string> | null = null;
let currentCodexAccountModelsKey = '';
let laneFactsVersion = 0;
const laneFactsListeners = new Set<() => void>();

/**
 * Monotonic version of the lane facts held in this module.
 *
 * These are written from an effect at the app root, which runs AFTER every
 * child has rendered — so a component that derives from them during render
 * (the composer's dead-end banner) reads the previous values on the very render
 * the facts changed and would otherwise never re-derive. Subscribing to this
 * version is what closes that gap.
 */
export function getRendererBillingLaneFactsVersion(): number {
  return laneFactsVersion;
}

export function subscribeRendererBillingLaneFacts(
  listener: () => void,
): () => void {
  laneFactsListeners.add(listener);
  return (): void => {
    laneFactsListeners.delete(listener);
  };
}

function bumpLaneFactsVersion(): void {
  laneFactsVersion += 1;
  laneFactsListeners.forEach((listener) => listener());
}

export function setRendererBillingLaneAvailability(
  availability: BillingLaneAvailability,
): void {
  // Field-compare before bumping. The caller writes a freshly built object on
  // every effect run, so an identity check is useless and an unconditional bump
  // wakes every `useSyncExternalStore` subscriber — each of which then re-runs a
  // full `resolveLaneForTarget` pass (`repairLaneDefaults` across CLAUDE_MODELS
  // / CODEX_MODELS / AI_GATEWAY_MODELS) for facts that did not change.
  if (
    currentAvailability.claudeNativeAuth === availability.claudeNativeAuth &&
    currentAvailability.claudeNativeAuthInconclusive ===
      availability.claudeNativeAuthInconclusive &&
    currentAvailability.codexNativeAuth === availability.codexNativeAuth &&
    currentAvailability.creditsEligible === availability.creditsEligible
  ) {
    return;
  }
  currentAvailability = availability;
  bumpLaneFactsVersion();
}

export function getRendererBillingLaneAvailability(): BillingLaneAvailability {
  return currentAvailability;
}

/**
 * The lane the main process last resolved without any provisional facts, read
 * back from preferences. Used to hold a stable answer while a lane's
 * availability is UNKNOWN, instead of flip-flopping the user's default.
 */
export function setRendererLastResolvedLane(
  lane: BillingLane | undefined,
): void {
  if (currentLastResolvedLane === lane) return;
  currentLastResolvedLane = lane;
  bumpLaneFactsVersion();
}

export function getRendererLastResolvedLane(): BillingLane | undefined {
  return currentLastResolvedLane;
}

/**
 * Whether the principal is held to the guest allowlist: a guest credential, or
 * a signed-in account whose Personal work still needs a purchase (CAN-4028).
 * The AI Credits lane then defaults only to allowlisted models, matching what
 * the LLM proxy accepts. The name predates the second case.
 */
export function setRendererGuestPrincipal(guest: boolean | undefined): void {
  if (currentGuestPrincipal === guest) return;
  currentGuestPrincipal = guest;
  bumpLaneFactsVersion();
}

export function getRendererGuestPrincipal(): boolean {
  return currentGuestPrincipal === true;
}

/** A credits default cannot assume signed-in while the account read is pending. */
export function isRendererGuestPrincipalHydrated(): boolean {
  return currentGuestPrincipal !== undefined;
}

/**
 * The signed-in ChatGPT account's own Codex model ids (`id` and `model` of
 * every non-hidden `model/list` entry), mirrored from main's catalog. `null`
 * is UNKNOWN and never filters anything; see `isCodexModelAvailableToAccount`
 * (CAN-4716). Compared by content, so an unchanged list never bumps the
 * version.
 */
export function setRendererCodexAccountModels(
  models: ReadonlySet<string> | null,
): void {
  const next = models && models.size > 0 ? models : null;
  const key = next ? Array.from(next).sort().join('\n') : '';
  if (key === currentCodexAccountModelsKey) return;
  currentCodexAccountModels = next;
  currentCodexAccountModelsKey = key;
  bumpLaneFactsVersion();
}

export function getRendererCodexAccountModels(): ReadonlySet<string> | null {
  return currentCodexAccountModels;
}

/** Content key of the account model ids; empty while the list is unknown. */
export function getRendererCodexAccountModelsKey(): string {
  return currentCodexAccountModelsKey;
}

let currentOllamaReadyModels: readonly string[] | undefined;
let currentOllamaReadyModelsKey: string | undefined;

/**
 * The installed Ollama models this app can select, in the shared order
 * (`selectableOllamaModels`). `undefined` is UNKNOWN (no answer yet, or a
 * window that never reads Ollama) and leaves the lane resolver as it was;
 * `[]` is a settled "Ollama cannot run anything". Feeds both billing
 * readiness and the Ollama-only default, so the two always agree. Compared by
 * content, so an unchanged list never bumps the version.
 */
export function setRendererOllamaReadyModels(
  models: readonly string[] | undefined,
): void {
  const key = models === undefined ? undefined : models.join('\n');
  if (key === currentOllamaReadyModelsKey) return;
  currentOllamaReadyModels = models;
  currentOllamaReadyModelsKey = key;
  bumpLaneFactsVersion();
}

export function getRendererOllamaReadyModels(): readonly string[] | undefined {
  return currentOllamaReadyModels;
}

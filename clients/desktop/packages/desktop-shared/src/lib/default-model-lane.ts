import {
  DEFAULT_CREDITS_CODEX_MODEL,
  getExecutionHarnessForModel,
  isSelectableOllamaModel,
  type AgentProviderType,
  type ChatModel,
  type ProviderModelSelection,
} from '../types';
import {
  GUEST_ALLOWED_MODELS,
  isGuestAllowedModelId,
} from '@canopy/protocol/models';
import {
  isGatewayRoutableModel,
  resolveGatewayModelEntry,
  resolveModelIdForGatewayId,
} from '@canopy/execution-engine/lib/gateway-model-availability';

export type BillingLane =
  | 'claude-native'
  | 'codex-native'
  | 'ai-credits'
  | 'ollama';

export const BILLING_LANES = [
  'claude-native',
  'codex-native',
  'ai-credits',
  'ollama',
] as const satisfies readonly BillingLane[];

export function isBillingLane(value: unknown): value is BillingLane {
  return BILLING_LANES.some((lane) => lane === value);
}

export interface BillingLaneAvailability {
  claudeNativeAuth: boolean | undefined;
  codexNativeAuth: boolean | undefined;
  creditsEligible: boolean | undefined;
  /**
   * The Claude probe settled without an answer and this process has no
   * confirmed sign-in. Only meaningful while `claudeNativeAuth` is
   * `undefined`; it never makes Claude count as unavailable. See
   * {@link resolveDefaultModelLane}.
   */
  claudeNativeAuthInconclusive?: boolean;
}

/**
 * Whether every turn this account can run bills to AI Credits: credits are
 * eligible and neither Claude nor Codex has native access (subscription,
 * Environments credential or ready account proxy). Unknown facts never count
 * as credits-only, so a subscriber keeps cost while a probe is in flight.
 */
export function isAiCreditsOnlyBilling(a: BillingLaneAvailability): boolean {
  return (
    a.creditsEligible === true &&
    a.claudeNativeAuth === false &&
    a.codexNativeAuth === false
  );
}

export interface LaneModelDefaults {
  claude: ProviderModelSelection;
  codex: ProviderModelSelection;
  ollama: ProviderModelSelection | null;
  aiCredits?: ProviderModelSelection | null;
}

export const CREDITS_LANE_DEFAULT_CANDIDATES = [
  'deepseek-v4-pro',
  DEFAULT_CREDITS_CODEX_MODEL,
] as const;

/**
 * May a guest run this model on the AI Credits lane, where Canopy pays?
 *
 * Tests the model id and its gateway id, the same two spellings the picker's
 * guest gate tests, so the default and the picker agree. The LLM proxy stays
 * authoritative and re-judges the gateway id.
 */
export function isGuestAllowedCreditsModel(model: ChatModel): boolean {
  return (
    isGuestAllowedModelId(model) ||
    isGuestAllowedModelId(resolveGatewayModelEntry(model)?.gatewayId)
  );
}

/**
 * The org has clamped every model to its own gateway (`Make this the only
 * route`).
 *
 * Two things follow, and both belong here rather than in each host:
 *
 * 1. The credits lane's availability stops being about AI Credits. An org
 *    gateway is paid for with the member's OWN gateway key, so gating it on
 *    `creditsEligible` reports a dead end for every member of an enforcing org
 *    who never bought credits.
 * 2. The AUTO sentinel has to expand to the org's models.
 *    `CREDITS_LANE_DEFAULT_CANDIDATES` are hosted routes, so under enforcement
 *    every AUTO candidate is excluded and the lane contributes nothing while
 *    the org's own models sit in the catalog.
 *
 * Exclusion of everything else is NOT expressed here — it rides the existing
 * `isModelAllowed` / `isPolicyBlocked` hooks, which both hosts already wire to
 * the owner-scoped gateway requirement. That keeps one rule in one place.
 */
export interface EnforcedOrgGatewayLane {
  enforced: boolean;
  /** Org-gateway models from the credits lane catalog, in catalog order. */
  models: readonly ChatModel[];
}

/**
 * The user's own Personal AI gateway, saved but NOT made the only route
 * (CAN-6444).
 *
 * Like an enforced org gateway ({@link EnforcedOrgGatewayLane} §1), these
 * models run on the user's own gateway key rather than AI Credits, so they ride
 * the credits lane. Unlike enforcement they only fill in when AI Credits are
 * not confirmed eligible: with credits available, the credits lane keeps its
 * own candidates and today's default. Without this, a user whose only working
 * route is their own gateway got `no-dispatchable-model`, and the composer fell
 * back to a built-in model the account cannot bill.
 */
export interface PersonalGatewayLane {
  /**
   * Gateway models this device can dispatch (its key is saved here), already
   * in default order: see `orderGatewayModelsForDefault`. A model the user
   * turned off is not in the saved list, so it is never here.
   */
  models: readonly ChatModel[];
}

/**
 * The personal gateway supplies the credits lane only once AI Credits are
 * CONFIRMED unavailable. While eligibility is unknown (the startup read, or a
 * degraded one such as a keychain lock) it stays out: standing in on a guess
 * would report the credits lane as confirmed, outranking an inconclusive
 * Claude probe and moving a funded credits user onto their own key.
 */
function personalGatewayFillsCreditsLane(
  availability: BillingLaneAvailability,
  personalGateway: PersonalGatewayLane | undefined,
): personalGateway is PersonalGatewayLane {
  return (
    availability.creditsEligible === false &&
    (personalGateway?.models.length ?? 0) > 0
  );
}

export type DefaultModelLaneResolution =
  | {
      outcome: 'resolved';
      lane: BillingLane;
      selection: ProviderModelSelection;
      provisional: boolean;
      reason:
        | 'pinned'
        | 'claude-native'
        | 'codex-native'
        | 'ai-credits'
        | 'last-known-lane'
        | 'policy-fallback';
    }
  | {
      outcome: 'no-dispatchable-model';
      missing: 'billing-lane' | 'policy-allowance' | 'both';
      lanesNeeded: readonly BillingLane[];
      /**
       * Whether at least one lane still has a runnable, policy-allowed default
       * candidate. `missing: 'both'` is reachable in two states that need
       * different remedies: an allowed lane exists but nothing confirms it as
       * available (a billing problem), and NO lane has an allowed runnable
       * candidate at all (an allowlist problem). `lanesNeeded` is empty in
       * both, so consumers cannot tell them apart without this (CAN-2436).
       */
      hasPolicyAllowedLane: boolean;
    };

/**
 * Whether the signed-in ChatGPT account can run `model` on the Codex lane.
 *
 * `accountModels` is the account's own `model/list` ids (both `id` and `model`
 * of every non-hidden entry). `null`, `undefined` and an EMPTY set all mean
 * UNKNOWN and answer `true`: like the UNKNOWN policy rule on
 * {@link LaneDefaultRepairHooks.isPolicyBlocked}, an unknown list must never
 * trigger a repair or hide every Codex model (CAN-4716).
 *
 * Both hosts wrap their `isRunnableOnLane` hook with this for `codex-native`,
 * and Auto routing applies the same match, so there is one rule.
 */
export function isCodexModelAvailableToAccount(
  model: string,
  accountModels: ReadonlySet<string> | null | undefined,
): boolean {
  if (!accountModels || accountModels.size === 0) return true;
  return accountModels.has(model);
}

/**
 * Host-supplied primitives for {@link repairLaneDefaults}.
 *
 * The repair itself is identical on both sides; only the sources of truth
 * differ (the renderer reads its cached policy snapshot and model registries,
 * main reads the stored account policy and its own registries). Injecting them
 * is what keeps the two from drifting into different answers for the same user.
 */
export interface LaneDefaultRepairHooks {
  /** Models to walk when a lane's configured default cannot be used. */
  laneCatalog: (lane: BillingLane) => readonly ChatModel[];
  /**
   * CONFIRMED policy block only.
   *
   * UNKNOWN must answer `false`. Repair rewrites the user's configured default,
   * so an unresolved policy read must never trigger it — that would silently
   * replace everyone's default during the startup window.
   */
  isPolicyBlocked: (model: ChatModel) => boolean;
  isModelInRegistry: (model: ChatModel) => boolean;
  /**
   * Whether the catalog backing `lane` has hydrated.
   *
   * Distinguishes "we do not know this model YET" from "this model is gone".
   * A gateway-only id that disappears from a refreshed catalog is removed from
   * the registry, so without this an absent id reads as UNKNOWN forever, the
   * configured credits default is preserved as the lane's only candidate, and
   * the resolver reports a dead end while usable alternatives sit in the
   * catalog. Cold registry ⇒ still UNKNOWN, so nothing is rewritten during
   * startup.
   */
  isLaneCatalogHydrated: (lane: BillingLane) => boolean;
  isRunnableOnLane: (lane: BillingLane, model: ChatModel) => boolean;
  clampThinkingLevel: (
    level: ProviderModelSelection['thinkingLevel'],
    model: ChatModel,
  ) => ProviderModelSelection['thinkingLevel'];
}

function isDefinitelyUnusableOnLane(
  lane: BillingLane,
  model: ChatModel,
  hooks: LaneDefaultRepairHooks,
): boolean {
  if (hooks.isPolicyBlocked(model)) return true;
  if (!hooks.isModelInRegistry(model)) {
    // Absent from a COLD catalog ⇒ UNKNOWN, so leave the user's choice alone.
    // Absent from a HYDRATED one ⇒ it is gone, not merely unseen, and keeping
    // it would strand the lane on a model that can never run again.
    return hooks.isLaneCatalogHydrated(lane);
  }
  return !hooks.isRunnableOnLane(lane, model);
}

function repairOneLaneDefault(
  lane: BillingLane,
  selection: ProviderModelSelection | null,
  hooks: LaneDefaultRepairHooks,
): ProviderModelSelection | null {
  if (!selection) return selection;
  if (!isDefinitelyUnusableOnLane(lane, selection.model, hooks)) {
    return selection;
  }
  let repaired: ChatModel | undefined;
  for (const candidate of hooks.laneCatalog(lane)) {
    if (hooks.isPolicyBlocked(candidate)) continue;
    if (!hooks.isRunnableOnLane(lane, candidate)) continue;
    repaired = candidate;
    break;
  }
  return repaired
    ? {
        ...selection,
        model: repaired,
        thinkingLevel: hooks.clampThinkingLevel(
          selection.thinkingLevel,
          repaired,
        ),
      }
    : selection;
}

/**
 * Repair each lane's configured default before precedence is applied.
 *
 * This is the "build the dispatchable set FIRST, then pick by lane precedence
 * over that set" rule, and skipping it inverts the answer. {@link
 * resolveDefaultModelLane} only ever considers ONE candidate per native lane —
 * the configured default — so a Claude subscriber whose configured Claude model
 * happens to be org-blocked would see `claude-native` contribute nothing and
 * fall through to `ai-credits`. They have a perfectly good subscription and a
 * dozen other allowed Claude models; the lane was never the problem.
 *
 * Both the renderer seed and the main-process dispatch resolver call this, and
 * they must keep doing so together. When only one side repaired, the composer
 * showed a repaired Claude model while `requireLaneAwareDefaultSelection`
 * picked a different lane — or threw — for that same user in that same state.
 *
 * Returns a lane's original selection when the lane has no usable model at all,
 * so the resolver still sees it as undispatchable and moves on.
 */
export function repairLaneDefaults(
  defaults: LaneModelDefaults,
  hooks: LaneDefaultRepairHooks,
): LaneModelDefaults {
  const claude = repairOneLaneDefault('claude-native', defaults.claude, hooks);
  const codex = repairOneLaneDefault('codex-native', defaults.codex, hooks);
  return {
    // `repairOneLaneDefault` only returns null for a null input, and these two
    // are non-nullable on `LaneModelDefaults`.
    claude: claude ?? defaults.claude,
    codex: codex ?? defaults.codex,
    ollama: repairOneLaneDefault('ollama', defaults.ollama ?? null, hooks),
    // `null` is the credits AUTO sentinel and stays untouched — the resolver
    // expands it into the credits candidate list itself. A CONFIGURED credits
    // model is repaired like any other lane, though: without that, one whose
    // gateway route disappeared or which an org later blocked left the credits
    // lane contributing only an unusable model, so the resolver reported
    // `no-dispatchable-model` while allowed, routable alternatives sat in the
    // catalog — stranding a user who has a perfectly good billing lane.
    aiCredits: defaults.aiCredits
      ? repairOneLaneDefault('ai-credits', defaults.aiCredits, hooks)
      : null,
  };
}

function laneAvailability(
  lane: BillingLane,
  availability: BillingLaneAvailability,
  ollamaPinned: boolean,
  orgGateway?: EnforcedOrgGatewayLane,
  personalGateway?: PersonalGatewayLane,
): boolean | undefined {
  switch (lane) {
    case 'claude-native':
      return availability.claudeNativeAuth;
    case 'codex-native':
      return availability.codexNativeAuth;
    case 'ai-credits':
      // See {@link EnforcedOrgGatewayLane} §1: under enforcement this lane
      // carries the org's gateway, funded by the member's own key. A Personal
      // gateway does the same when credits can't (see PersonalGatewayLane).
      return orgGateway?.enforced === true ||
        personalGatewayFillsCreditsLane(availability, personalGateway)
        ? true
        : availability.creditsEligible;
    case 'ollama':
      return ollamaPinned;
  }
}

function providerLane(provider: AgentProviderType): BillingLane {
  if (provider === 'codex') return 'codex-native';
  if (provider === 'ollama') return 'ollama';
  return 'claude-native';
}

function defaultCandidates(
  lane: BillingLane,
  defaults: LaneModelDefaults,
  creditsCandidates: readonly ChatModel[],
  clampThinkingLevel?: (
    level: ProviderModelSelection['thinkingLevel'],
    model: ChatModel,
  ) => ProviderModelSelection['thinkingLevel'],
  orgGateway?: EnforcedOrgGatewayLane,
  personalGateway?: PersonalGatewayLane,
): ProviderModelSelection[] {
  if (lane === 'claude-native') return [defaults.claude];
  if (lane === 'codex-native') return [defaults.codex];
  if (lane === 'ollama') return defaults.ollama ? [defaults.ollama] : [];
  // See {@link EnforcedOrgGatewayLane} §2. Ahead of the configured credits
  // default too: a remembered hosted model is excluded under enforcement, and
  // it is the lane's ONLY candidate, so honoring it would strand the lane.
  if (orgGateway?.enforced === true) {
    return orgGateway.models.map((model) => ({
      model,
      thinkingLevel: clampThinkingLevel
        ? clampThinkingLevel('high', model)
        : 'high',
    }));
  }
  // The same reasoning for a Personal gateway standing in for credits: a
  // configured hosted credits default would bill credits the account lacks.
  // Like enforcement, this also replaces a caller's cheap `creditsCandidates`
  // (branch names, summaries): hosted helpers can't run without credits, so
  // helper work runs on the user's own gateway model and key.
  if (personalGateway) {
    return personalGateway.models.map((model) => ({
      model,
      thinkingLevel: clampThinkingLevel
        ? clampThinkingLevel('high', model)
        : 'high',
    }));
  }
  if (defaults.aiCredits) return [defaults.aiCredits];
  // The synthesized AUTO candidates carry a nominal `'high'`, which is NOT
  // universally supported: a gateway entry can declare
  // `supportedThinkingLevels: []`, and main callers pass this selection's
  // `thinkingLevel` straight into the dispatched turn
  // (`requireLaneAwareDefaultSelection` -> `laneDefault?.thinkingLevel`). Clamp
  // it against the model the same way `repairLaneDefaults` clamps a configured
  // lane default, so a synthesized candidate can never carry a level the model
  // rejects.
  return creditsCandidates.map((model) => ({
    model,
    thinkingLevel: clampThinkingLevel
      ? clampThinkingLevel('high', model)
      : 'high',
  }));
}

/**
 * A guest may only default to allowlisted models on the AI Credits lane, where
 * Canopy pays. Disallowed candidates (including a configured default) are
 * dropped, then every `GUEST_ALLOWED_MODELS` entry is appended in table order,
 * resolved to the registry model that carries its gateway id, so an unroutable
 * primary candidate never hands a guest a model the proxy refuses. An entry no
 * route carries falls back to its bare id: while the gateway catalog is cold
 * there are no routes at all, and a package model must still be offered.
 * `runnableOnLane` still decides routability and registry membership, so an
 * appended model that cannot route is skipped, not dispatched. Native lanes
 * run on the guest's own subscription and are left alone, and so does a
 * Personal gateway: the guest pays for it with their own key.
 */
function laneCandidates(
  lane: BillingLane,
  defaults: LaneModelDefaults,
  creditsCandidates: readonly ChatModel[],
  guestPrincipal: boolean,
  clampThinkingLevel?: (
    level: ProviderModelSelection['thinkingLevel'],
    model: ChatModel,
  ) => ProviderModelSelection['thinkingLevel'],
  orgGateway?: EnforcedOrgGatewayLane,
  personalGateway?: PersonalGatewayLane,
): ProviderModelSelection[] {
  const candidates = defaultCandidates(
    lane,
    defaults,
    creditsCandidates,
    clampThinkingLevel,
    orgGateway,
    personalGateway,
  );
  if (lane !== 'ai-credits' || !guestPrincipal || personalGateway) {
    return candidates;
  }
  const allowed = candidates.filter((selection) =>
    isGuestAllowedCreditsModel(selection.model),
  );
  for (const entry of GUEST_ALLOWED_MODELS) {
    const model = resolveModelIdForGatewayId(entry.gatewayId) ?? entry.id;
    if (allowed.some((selection) => selection.model === model)) continue;
    allowed.push({
      model,
      thinkingLevel: clampThinkingLevel
        ? clampThinkingLevel('high', model)
        : 'high',
    });
  }
  return allowed;
}

function runnableOnLane(
  lane: BillingLane,
  model: ChatModel,
  gatewayRoutesHydrated: boolean,
  isModelInRegistry: (model: ChatModel) => boolean,
  codexAccountModels: ReadonlySet<string> | null | undefined,
): { runnable: boolean; provisional: boolean } {
  if (lane === 'claude-native' || lane === 'codex-native') {
    return {
      runnable:
        isModelInRegistry(model) &&
        getExecutionHarnessForModel(model) ===
          (lane === 'claude-native' ? 'claude' : 'codex') &&
        (lane === 'claude-native' ||
          isCodexModelAvailableToAccount(model, codexAccountModels)),
      provisional: false,
    };
  }
  if (lane === 'ollama') {
    return {
      runnable: isModelInRegistry(model) && isSelectableOllamaModel(model),
      provisional: false,
    };
  }
  if (!gatewayRoutesHydrated) {
    // Fail OPEN on routability only — a cold gateway catalog cannot say whether
    // a model has a route yet. The REGISTRY check still applies: an id nobody
    // has ever heard of is not "unproven", it is unusable, and returning it
    // handed callers a model absent from the shipped registry instead of the
    // documented fallback. Both host-side `isRunnableOnLane` hooks
    // (`default-model-lane-resolver.ts`, renderer `defaults.ts`) already gate
    // on the registry first; this keeps the resolver's own answer aligned.
    return { runnable: isModelInRegistry(model), provisional: true };
  }
  return {
    runnable: isModelInRegistry(model) && isGatewayRoutableModel(model),
    provisional: false,
  };
}

export function resolveDefaultModelLane(input: {
  availability: BillingLaneAvailability;
  defaults: LaneModelDefaults;
  preferredProvider: AgentProviderType;
  lastResolvedLane: BillingLane | undefined;
  isModelAllowed: (model: ChatModel) => boolean | undefined;
  isModelInRegistry: (model: ChatModel) => boolean;
  gatewayRoutesHydrated: boolean;
  ollamaPinned: boolean;
  creditsCandidates?: readonly ChatModel[];
  /** Present only when an org has made its gateway the only route. */
  orgGateway?: EnforcedOrgGatewayLane;
  /**
   * The user's Personal gateway when it is saved, usable on this device, and
   * not enforced. Used only while AI Credits are not confirmed eligible; see
   * {@link PersonalGatewayLane}.
   */
  personalGateway?: PersonalGatewayLane;
  /**
   * The signed-in ChatGPT account's `model/list` ids. A `codex-native`
   * candidate the account cannot run falls through to the next lane instead
   * of being returned. Unknown (`null`/absent/empty) changes nothing; see
   * {@link isCodexModelAvailableToAccount}.
   */
  codexAccountModels?: ReadonlySet<string> | null;
  /**
   * The saved credential is a guest. The AI Credits lane then defaults only
   * to guest-allowlisted models; see {@link laneCandidates}.
   */
  guestPrincipal?: boolean;
  /**
   * Clamp for the thinking level attached to a SYNTHESIZED credits candidate.
   * Optional so the pure resolver stays usable without a model registry, but
   * every host caller should supply it — see {@link defaultCandidates}.
   */
  clampThinkingLevel?: (
    level: ProviderModelSelection['thinkingLevel'],
    model: ChatModel,
  ) => ProviderModelSelection['thinkingLevel'];
}): DefaultModelLaneResolution {
  const creditsCandidates =
    input.creditsCandidates ?? CREDITS_LANE_DEFAULT_CANDIDATES;
  // Decided once so availability and candidates can't disagree about whether
  // the Personal gateway is standing in for credits.
  const personalGateway = personalGatewayFillsCreditsLane(
    input.availability,
    input.personalGateway,
  )
    ? input.personalGateway
    : undefined;
  const preferredLane = providerLane(input.preferredProvider);
  const baseOrder: BillingLane[] = [
    'claude-native',
    'codex-native',
    'ai-credits',
  ];
  const order: BillingLane[] = input.ollamaPinned
    ? ['ollama', ...baseOrder]
    : [
        ...(preferredLane === 'ollama' ? [] : [preferredLane]),
        ...baseOrder.filter((lane) => lane !== preferredLane),
      ];
  const isConfirmed = (lane: BillingLane): boolean =>
    laneAvailability(
      lane,
      input.availability,
      input.ollamaPinned,
      input.orgGateway,
      personalGateway,
    ) === true;
  // The index just past the last confirmed-available lane in `order`.
  const afterLastConfirmed = (): number => {
    let insertAt = 0;
    order.forEach((lane, index) => {
      if (isConfirmed(lane)) insertAt = index + 1;
    });
    return insertAt;
  };
  // A Claude check that settled without an answer (the `claude auth status`
  // probe timing out, common on Windows) leaves Claude unknown forever. Never
  // let that unknown lane outrank confirmed AI Credits unless this scope's
  // last resolved lane (else the most recent one) is Claude; a later confirmed
  // sign-in wins again
  // because confirmed lanes keep their rank. Only Claude moves: an unknown
  // Codex lane still resolves provisionally ahead of credits, because Codex's
  // probe failure also marks a stable custom provider answer.
  if (
    input.availability.claudeNativeAuth === undefined &&
    input.availability.claudeNativeAuthInconclusive === true &&
    input.lastResolvedLane !== 'claude-native' &&
    isConfirmed('ai-credits')
  ) {
    const claudeIndex = order.indexOf('claude-native');
    if (claudeIndex !== -1) {
      order.splice(claudeIndex, 1);
      order.splice(afterLastConfirmed(), 0, 'claude-native');
    }
  }
  if (
    input.lastResolvedLane &&
    laneAvailability(
      input.lastResolvedLane,
      input.availability,
      input.ollamaPinned,
      input.orgGateway,
      personalGateway,
    ) === undefined
  ) {
    // Hold the last-known lane through a loading window so the composer does
    // not flap between defaults while probes settle — but NEVER ahead of a lane
    // we already KNOW is available. An UNKNOWN lane outranking a CONFIRMED one
    // is how a Claude subscriber whose credits read is still in flight gets
    // seeded onto — and billed for — AI Credits, inverting the
    // native-subscription-first guarantee this resolver exists to provide.
    //
    // So: splice it in after the LAST confirmed-available lane. Every confirmed
    // lane keeps its precedence; among everything still unknown, the lane we
    // used last time wins.
    //
    // "After the last confirmed" rather than "before the first unconfirmed",
    // deliberately: `order` is NOT sorted by availability — the preferred lane
    // is hoisted to the front regardless of whether it is confirmed — so
    // confirmed lanes do not form a prefix. With `{claude: false, codex: true,
    // credits: undefined}` and a Claude-preferred user, the first unconfirmed
    // index is 0 (Claude is `false`), which would splice credits ahead of the
    // CONFIRMED Codex lane and bill credits against a working subscription.
    order.splice(afterLastConfirmed(), 0, input.lastResolvedLane);
  }

  let preferredHadNoDispatchableModel = false;
  const seen = new Set<BillingLane>();
  for (const lane of order) {
    if (seen.has(lane)) continue;
    seen.add(lane);
    const available = laneAvailability(
      lane,
      input.availability,
      input.ollamaPinned,
      input.orgGateway,
      personalGateway,
    );
    if (available === false) continue;
    for (const selection of laneCandidates(
      lane,
      input.defaults,
      creditsCandidates,
      input.guestPrincipal === true,
      input.clampThinkingLevel,
      input.orgGateway,
      personalGateway,
    )) {
      const allowed = input.isModelAllowed(selection.model);
      if (allowed === false) continue;
      const runtime = runnableOnLane(
        lane,
        selection.model,
        input.gatewayRoutesHydrated,
        input.isModelInRegistry,
        input.codexAccountModels,
      );
      if (!runtime.runnable) continue;
      const lastKnown =
        lane === input.lastResolvedLane && available === undefined;
      const policyFallback =
        preferredHadNoDispatchableModel && lane !== preferredLane;
      return {
        outcome: 'resolved',
        lane,
        selection,
        provisional:
          available === undefined ||
          allowed === undefined ||
          runtime.provisional,
        reason:
          lane === 'ollama'
            ? 'pinned'
            : lastKnown
              ? 'last-known-lane'
              : policyFallback
                ? 'policy-fallback'
                : lane,
      };
    }
    if (lane === preferredLane) preferredHadNoDispatchableModel = true;
  }

  // Describe the actual repair, not just which independent axis has any
  // values. A Claude subscriber whose policy permits only a gateway model has
  // both "some billing" and "some allowance", but they do not intersect; the
  // actionable gap is specifically the unavailable AI Credits lane.
  const policyAllowedLanes = baseOrder.filter((lane) =>
    laneCandidates(
      lane,
      input.defaults,
      creditsCandidates,
      input.guestPrincipal === true,
      input.clampThinkingLevel,
      input.orgGateway,
      personalGateway,
    ).some((selection) => {
      if (input.isModelAllowed(selection.model) === false) return false;
      return runnableOnLane(
        lane,
        selection.model,
        input.gatewayRoutesHydrated,
        input.isModelInRegistry,
        input.codexAccountModels,
      ).runnable;
    }),
  );
  const lanesNeeded = policyAllowedLanes.filter(
    (lane) =>
      laneAvailability(
        lane,
        input.availability,
        input.ollamaPinned,
        input.orgGateway,
        personalGateway,
      ) === false,
  );
  const hasConfirmedAvailableLane = baseOrder.some(
    (lane) =>
      laneAvailability(
        lane,
        input.availability,
        input.ollamaPinned,
        input.orgGateway,
        personalGateway,
      ) === true,
  );
  const missing =
    policyAllowedLanes.length === 0
      ? hasConfirmedAvailableLane
        ? 'policy-allowance'
        : 'both'
      : lanesNeeded.length > 0
        ? 'billing-lane'
        : hasConfirmedAvailableLane
          ? 'policy-allowance'
          : 'both';
  return {
    outcome: 'no-dispatchable-model',
    missing,
    lanesNeeded,
    hasPolicyAllowedLane: policyAllowedLanes.length > 0,
  };
}

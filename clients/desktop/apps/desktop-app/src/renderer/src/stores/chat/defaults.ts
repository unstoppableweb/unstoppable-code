// Provider/model/interface-mode defaults resolution against chat state.
import {
  AI_GATEWAY_MODELS,
  APP_ADVISOR_PROJECT_ID,
  CLAUDE_MODELS,
  CODEX_ACCOUNT_MODELS,
  CODEX_MODELS,
  DEFAULT_APP_ADVISOR_MODEL,
  DEFAULT_MODEL,
  PIPELINE_EDITOR_PROJECT_ID,
  OLLAMA_MODELS,
  clampThinkingLevelForModel,
  getExecutionHarnessForModel,
  getProviderForModel,
  hasHydratedGatewayCatalog,
  hasHydratedModelRegistry,
  isSelectableOllamaModel,
  resolveKnownModel,
  resolveDefaultChatModel,
  resolveOverallDefault,
  type AgentModelConfig,
  type AgentProviderType,
  type ChatBillingFramework,
  type ChatInterfaceMode,
  type ChatModel,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  isModelBlocked,
  isModelBlockedTriState,
} from '@canopy/desktop-shared/lib/model-policy';
import {
  isCodexModelAvailableToAccount,
  isGuestAllowedCreditsModel,
  repairLaneDefaults,
  resolveDefaultModelLane,
  type BillingLane,
  type DefaultModelLaneResolution,
  type EnforcedOrgGatewayLane,
  type LaneModelDefaults,
  type PersonalGatewayLane,
} from '@canopy/desktop-shared/lib/default-model-lane';
import { listPersonalGatewayDefaultModels } from '@canopy/desktop-shared/lib/org-model-gateway';
import { isGatewayRoutableModel } from '@canopy/execution-engine/lib/gateway-model-availability';
import {
  DEFAULT_CODEX_SPEED,
  readCodexSpeedRecord,
} from '@canopy/execution-engine/lib/codex-speed';
import { isCoworkChatTarget } from '@/lib/cowork';
import { codexSpeedFields, withoutCodexSpeed } from './codex-speed';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '../featureFlagsStore';
import { getEffectiveClaudeChatInterfaceMode } from '@/lib/claude-tui-chats';
import {
  getRendererModelGatewayEnforced,
  getRendererModelGatewayIndex,
  getRendererModelPolicy,
  isRendererModelExcludedByGateway,
  isRendererModelPolicyHydrated,
  listRendererEnforcedGatewayModels,
} from '../modelPolicyRuntime';
import {
  getRendererBillingLaneAvailability,
  getRendererCodexAccountModels,
  getRendererGuestPrincipal,
  getRendererLastResolvedLane,
} from '../billingLaneRuntime';
import type { ChatState } from './state';
import { isPipelineEditorChatTarget } from './surface';

/**
 * Tri-state policy predicate over the renderer's cached policy snapshot.
 *
 * Before the first account read the snapshot is an empty set, which is
 * indistinguishable from "no policy at all" — so everything is UNKNOWN until
 * hydration, not silently allowed.
 */
function isModelAllowedTriState(model: ChatModel): boolean | undefined {
  // Enforcement is a CONFIRMED exclusion the moment it is known, and it does
  // not depend on the policy snapshot, so it answers ahead of the hydration
  // gate below.
  if (isOrgGatewayExcluded(model)) return false;
  if (!isRendererModelPolicyHydrated()) return undefined;
  const blocked = isModelBlockedTriState(
    model,
    getRendererModelPolicy(),
    hasHydratedGatewayCatalog(),
  );
  return blocked === undefined ? undefined : !blocked;
}

function isModelInRegistry(model: ChatModel): boolean {
  return resolveKnownModel(model) !== undefined;
}

/**
 * Whether a model can actually run on a lane.
 *
 * Gateway routability, not harness identity, is the credits-lane contract:
 * `getExecutionHarnessForModel('deepseek-v4-pro')` is `'codex'`, so a harness
 * check would happily accept a gateway-only model into the native Codex lane.
 */
function isModelRunnableOnLane(lane: BillingLane, model: ChatModel): boolean {
  if (!isModelInRegistry(model)) return false;
  if (lane === 'claude-native') {
    return getExecutionHarnessForModel(model) === 'claude';
  }
  if (lane === 'codex-native') {
    return getExecutionHarnessForModel(model) === 'codex';
  }
  if (lane === 'ollama') return isSelectableOllamaModel(model);
  // Fail OPEN only while the gateway catalog is genuinely COLD.
  //
  // `hasGatewayModelRoutes()` cannot express that: it also reads false for a
  // policy-filtered account that legitimately holds zero gateway routes
  // forever, and treating that settled state as "still loading" is what let an
  // org-disallowed gateway model stay provisionally runnable. The hydration
  // flag separates the two, so a filtered-empty catalog now answers an honest
  // `false` here instead of an indefinite fail-open.
  if (!hasHydratedGatewayCatalog()) return true;
  return isGatewayRoutableModel(model);
}

/**
 * {@link isModelRunnableOnLane}, also excluding a Codex model the signed-in
 * ChatGPT account cannot run (CAN-4716). Feeds the default repair and the
 * dispatchable walk only, never an explicit pick: an explicit pick still
 * sends, and the account model notice is its recovery. An unknown account
 * list filters nothing.
 */
function isModelRunnableForAccountOnLane(
  lane: BillingLane,
  model: ChatModel,
): boolean {
  return (
    isModelRunnableOnLane(lane, model) &&
    (lane !== 'codex-native' ||
      isCodexModelAvailableToAccount(model, getRendererCodexAccountModels()))
  );
}

/**
 * Lane precedence order used when walking the catalog for a fallback.
 * Ollama is included ONLY when explicitly pinned — reaching a local model
 * through an implicit fallback contradicts the never-auto-select rule and
 * silently substitutes local inference for a policy-restricted user.
 */
function laneWalkOrder(
  resolvedLane: BillingLane | undefined,
  ollamaPinned: boolean,
): BillingLane[] {
  const availability = getRendererBillingLaneAvailability();
  const base: BillingLane[] = ['claude-native', 'codex-native', 'ai-credits'];
  const lanes = ollamaPinned ? ['ollama' as BillingLane, ...base] : base;
  const ordered = resolvedLane
    ? [resolvedLane, ...lanes.filter((lane) => lane !== resolvedLane)]
    : lanes;
  return ordered.filter((lane) => {
    if (lane === 'ollama') return ollamaPinned;
    if (lane === 'claude-native')
      return availability.claudeNativeAuth !== false;
    if (lane === 'codex-native') return availability.codexNativeAuth !== false;
    return (
      availability.creditsEligible !== false ||
      personalGatewayCreditsLane() !== undefined
    );
  });
}

/**
 * Excluded because the active owner's org routes everything through its own
 * gateway, or because the row is another organization's gateway model.
 *
 * Folded into the policy predicates rather than added as a branch beside them:
 * they are the hooks `repairLaneDefaults` / `resolveDefaultModelLane` already
 * consult, so one wiring here covers the composer seed, the fallback seed, and
 * the dead-end banner at once.
 */
function isOrgGatewayExcluded(model: ChatModel): boolean {
  return isRendererModelExcludedByGateway(model);
}

/** The enforced-gateway lane descriptor, or `undefined` when unenforced. */
function orgGatewayLane(): EnforcedOrgGatewayLane | undefined {
  if (!getRendererModelGatewayEnforced()) return undefined;
  return {
    enforced: true,
    models: listRendererEnforcedGatewayModels(laneCatalog('ai-credits')),
  };
}

/**
 * The Personal gateway standing in for AI Credits (CAN-6444), or `undefined`
 * when credits are confirmed eligible or no usable Personal gateway is saved.
 * Mirrors the shared resolver's own rule so the fallback walk below agrees
 * with it; see `PersonalGatewayLane`.
 */
function personalGatewayCreditsLane(): PersonalGatewayLane | undefined {
  // Only once AI Credits are confirmed unavailable, as in the shared resolver.
  if (getRendererBillingLaneAvailability().creditsEligible !== false) {
    return undefined;
  }
  // Organization work can't use Personal models; the owner-scoped exclusion
  // removes them there, exactly as main's resolver does.
  const models = listPersonalGatewayDefaultModels(
    getRendererModelGatewayIndex(),
    laneCatalog('ai-credits'),
  ).filter((model) => !isOrgGatewayExcluded(model));
  return models.length > 0 ? { models } : undefined;
}

/**
 * The Personal gateway model a new chat would default to while it stands in
 * for AI Credits, for the composer's one-click switch away from a model this
 * account can't bill (CAN-6444).
 */
export function firstPersonalGatewayDefaultModel(): ChatModel | undefined {
  // The same filters the fallback walk applies, so the switch never offers a
  // model the next send would refuse.
  const policy = getRendererModelPolicy();
  return personalGatewayCreditsLane()?.models.find(
    (model) =>
      !isModelBlocked(model, policy) &&
      isModelRunnableForAccountOnLane('ai-credits', model),
  );
}

/**
 * The catalog the fallback walk uses for a lane. While a Personal gateway
 * stands in for credits, the credits lane walks only its models: a hosted
 * credits model would bill credits the account doesn't have.
 */
function walkCatalog(lane: BillingLane): readonly ChatModel[] {
  if (lane !== 'ai-credits') return laneCatalog(lane);
  return personalGatewayCreditsLane()?.models ?? laneCatalog(lane);
}

function laneCatalog(lane: BillingLane): readonly ChatModel[] {
  if (lane === 'claude-native') return CLAUDE_MODELS;
  // Catalog order first, then the account's own models (its default first),
  // matching main's resolver.
  if (lane === 'codex-native')
    return [...CODEX_MODELS, ...CODEX_ACCOUNT_MODELS];
  if (lane === 'ollama') return OLLAMA_MODELS;
  return AI_GATEWAY_MODELS;
}

/**
 * First model in the DISPATCHABLE set — allowed by policy AND runnable on a
 * lane the user can actually pay for.
 *
 * Replaces the old `firstSelectableModel`, which walked
 * `[...CLAUDE_MODELS, ...CODEX_MODELS, ...OLLAMA_MODELS]` with no notion of
 * billing at all: it had no gateway entry for the credits lane, and it could
 * hand back an Ollama model nobody asked for.
 */
function firstDispatchableModel(
  resolvedLane: BillingLane | undefined,
  ollamaPinned: boolean,
): ChatModel | undefined {
  const policy = getRendererModelPolicy();
  for (const lane of laneWalkOrder(resolvedLane, ollamaPinned)) {
    for (const candidate of walkCatalog(lane)) {
      if (isModelBlocked(candidate, policy)) continue;
      if (isOrgGatewayExcluded(candidate)) continue;
      if (!isModelRunnableForAccountOnLane(lane, candidate)) continue;
      return candidate;
    }
  }
  return undefined;
}

/**
 * Best lane-aware guess with no `modelDefaults` available yet.
 *
 * Only for the startup window before preferences load. Returns `undefined`
 * when nothing is dispatchable, so callers keep their own last-resort constant
 * rather than being handed a model that cannot run.
 */
export function resolveFallbackDefaultModel(): ChatModel | undefined {
  const lastLane = getRendererLastResolvedLane();
  // Substitute only on a DEFINITIVE exclusion, never on a merely-unproven one.
  //
  // This runs in the startup window before the model registries hydrate, so
  // `DEFAULT_MODEL` (an alias form, `opus[1m]`) is not yet registry-resolvable
  // and a "prove it is runnable" test would reject it for everyone — quietly
  // downgrading every Claude subscriber to whatever model happens to sort
  // first. The only facts trustworthy this early are the negative ones: a
  // confirmed-signed-out Claude lane, or an explicit policy block.
  const claudeLaneExcluded =
    getRendererBillingLaneAvailability().claudeNativeAuth === false;
  const policyBlocked = isModelBlocked(DEFAULT_MODEL, getRendererModelPolicy());
  // An enforced org gateway is exactly such a definitive exclusion, and it is
  // knowable this early (it comes from the same account read as the policy).
  // Without it the startup window stamped the shipped Claude default for every
  // member of an enforcing org, which is the state the picker then refused.
  const gatewayExcluded = isOrgGatewayExcluded(DEFAULT_MODEL);
  if (!claudeLaneExcluded && !policyBlocked && !gatewayExcluded) {
    return DEFAULT_MODEL;
  }
  return firstDispatchableModel(lastLane, false);
}

export interface SelectableDefaultResult {
  model: ChatModel;
  thinkingLevel: ThinkingLevel;
  /** True when nothing in the catalog is both payable and policy-allowed. */
  emptyDispatchableSet: boolean;
}

function selectableDefault(
  model: ChatModel,
  thinkingLevel: ThinkingLevel,
  resolvedLane: BillingLane | undefined,
  ollamaPinned: boolean,
): SelectableDefaultResult {
  const policy = getRendererModelPolicy();
  const blocked = isModelBlocked(model, policy);
  const fallback = blocked
    ? firstDispatchableModel(resolvedLane, ollamaPinned)
    : model;
  // Returning the blocked model it was handed is what this used to do, and it
  // is the one thing that must not happen: the caller cannot tell a real
  // answer from a dead end, so a blocked model gets seeded and dies at dispatch.
  if (!fallback) {
    return { model, thinkingLevel, emptyDispatchableSet: true };
  }
  return {
    model: fallback,
    thinkingLevel: clampThinkingLevelForModel(thinkingLevel, fallback),
    emptyDispatchableSet: false,
  };
}

function laneDefaultsFor(
  byProvider: NonNullable<ChatState['modelDefaults']>['chatModelByProvider'],
): LaneModelDefaults {
  // Delegates to the shared repair so the renderer seed and the main-process
  // dispatch resolver cannot disagree about which lane a user lands on.
  return repairLaneDefaults(
    {
      claude: byProvider.claude,
      codex: byProvider.codex,
      ollama: byProvider.ollama ?? null,
      aiCredits: byProvider.aiCredits ?? null,
    },
    {
      laneCatalog,
      isPolicyBlocked: (model) =>
        isModelBlocked(model, getRendererModelPolicy()) ||
        isOrgGatewayExcluded(model),
      isModelInRegistry,
      isLaneCatalogHydrated: (lane) =>
        // The credits lane is backed by the gateway route catalog; every other
        // lane by the model registry. They hydrate independently.
        lane === 'ai-credits'
          ? hasHydratedGatewayCatalog()
          : hasHydratedModelRegistry(),
      isRunnableOnLane: isModelRunnableForAccountOnLane,
      clampThinkingLevel: clampThinkingLevelForModel,
    },
  );
}

/**
 * Resolve the billing lane a fresh tab on this surface would be seeded onto.
 *
 * Exported so the composer's billing seed and the dead-end banner read exactly
 * the same decision the model stamp came from, rather than re-deriving it.
 */
export function resolveLaneForTarget(
  projectId: string,
  modelDefaults: ChatState['modelDefaults'],
): DefaultModelLaneResolution | undefined {
  if (!modelDefaults) return undefined;
  // No catalog, no opinion.
  //
  // Every judgement the resolver makes — which harness runs a model, whether an
  // id is real, which lane it belongs to — is answered out of the model
  // registries. Before they hydrate, `getExecutionHarnessForModel` cannot
  // confirm even a plain Claude model as Claude-runnable, so EVERY native lane
  // looks undispatchable and the walk falls through to the credits lane, whose
  // cold-catalog fail-open then accepts anything. The result is a
  // gateway-only model seeded for a user who may have no credits at all.
  //
  // `hasHydratedModelRegistry()` is the LOADING gate and is the right one here
  // (types.ts documents it as NOT interchangeable with the routability gate
  // `hasHydratedGatewayCatalog()`, which is what the credits lane uses once we
  // do have a catalog). Until it flips, defer to the user's persisted default —
  // today's behavior — instead of guessing.
  if (!hasHydratedModelRegistry()) return undefined;
  const isStandalone = isCoworkChatTarget(projectId);
  const byProvider = isStandalone
    ? modelDefaults.chatModelByProvider
    : modelDefaults.worktreeModelByProvider;
  const preferredProvider = isStandalone
    ? modelDefaults.chatProvider
    : modelDefaults.worktreeProvider;
  // See the note in `resolveTabDefaults`: a partial preferences file can leave
  // this map missing despite its type.
  if (!byProvider?.claude || !byProvider.codex) return undefined;
  // The preferred lane's own configured default is unclassifiable — the
  // catalog is hydrated but has no harness assignment for it (a stale
  // preference, a custom id, or a registry the snapshot never covered).
  //
  // We cannot place it on a lane, and the resolver's one candidate per native
  // lane means that alone would make BOTH native lanes look undispatchable and
  // drop the user onto credits. Not knowing what a model is has nothing to do
  // with how the user pays, so it must not decide how they pay: keep the
  // persisted default and offer no lane opinion.
  //
  // INTENTIONAL DIVERGENCE from main (CAN-1929 round-5). Main's
  // `resolveDefaultModelLaneForPreferences` runs `repairLaneDefaults`
  // unconditionally and would SUBSTITUTE a catalog model for this one. The
  // asymmetry is deliberate and runs in the safe direction: this side declines
  // to rewrite a model it cannot identify, which is what preserves a user's
  // custom or not-yet-known id in the composer instead of silently replacing
  // it. Making the renderer repair too was tried and rejected — it silently
  // rewrote exactly those ids, which is a worse outcome than the narrow
  // disagreement below.
  //
  // The residual disagreement is bounded: dispatch only consults the lane
  // default when the turn carries NO concrete model
  // (`worktree-chat-turn.ts`, `options.model === undefined`), so for every tab
  // the composer has stamped, the stamped model is what runs and the two sides
  // cannot disagree. It is reachable only for a model-less tab whose preferred
  // provider default is also unclassifiable, where main repairs and this side
  // holds — and there main's repaired answer is the one that actually runs.
  const preferredSelection =
    preferredProvider === 'codex'
      ? byProvider.codex
      : preferredProvider === 'ollama'
        ? byProvider.ollama
        : byProvider.claude;
  if (
    preferredSelection &&
    getExecutionHarnessForModel(preferredSelection.model) === undefined &&
    !isSelectableOllamaModel(preferredSelection.model)
  ) {
    return undefined;
  }
  const orgGateway = orgGatewayLane();
  const personalGateway = personalGatewayCreditsLane();
  return resolveDefaultModelLane({
    availability: getRendererBillingLaneAvailability(),
    defaults: laneDefaultsFor(byProvider),
    preferredProvider,
    lastResolvedLane:
      modelDefaults.lastResolvedLaneByScope?.[
        isStandalone ? 'chat' : 'worktree'
      ] ?? getRendererLastResolvedLane(),
    isModelAllowed: isModelAllowedTriState,
    isModelInRegistry,
    gatewayRoutesHydrated: hasHydratedGatewayCatalog(),
    ollamaPinned: preferredProvider === 'ollama',
    codexAccountModels: getRendererCodexAccountModels(),
    ...(orgGateway ? { orgGateway } : {}),
    ...(personalGateway ? { personalGateway } : {}),
    guestPrincipal: getRendererGuestPrincipal(),
    // Synthesized credits candidates carry a nominal `'high'`; clamp it against
    // the model exactly as the lane-default repair above does, so a gateway
    // entry with no supported thinking levels cannot hand the composer (or the
    // main resolver, which uses the same hook) a level it rejects.
    clampThinkingLevel: clampThinkingLevelForModel,
  });
}

export function resolveTabDefaults(
  projectId: string,
  modelDefaults: ChatState['modelDefaults'],
): {
  model?: ChatModel;
  providerType?: AgentProviderType;
  thinkingLevel?: ThinkingLevel;
  modelConfig?: AgentModelConfig;
} {
  if (!modelDefaults) return {};
  // App Advisor tabs default to the dedicated appAdvisor* preferences (the
  // same defaults quick prompts, automations, and watchers consume), not the
  // generic cowork chat defaults its cowork classification would select.
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    const advisorLane = resolveLaneForTarget(projectId, modelDefaults);
    const advisorResolved =
      advisorLane?.outcome === 'resolved' ? advisorLane : undefined;
    const advisorResolvedLane = advisorResolved?.lane;
    const configured =
      modelDefaults.appAdvisorModel ?? DEFAULT_APP_ADVISOR_MODEL;
    // Migrate the untouched shipped seed onto the resolved lane's selection
    // when it cannot be dispatched there. Two independent reasons:
    //
    //  - Lane runnability: `DEFAULT_APP_ADVISOR_MODEL` is a Codex model, so a
    //    Claude-only user would otherwise be handed a model they cannot run.
    //  - Guest eligibility (CAN-3637): on AI Credits a guest may run only the
    //    guest allowlist. The seed has a gateway route, so runnability alone
    //    kept it and a fresh guest's first Advisor turn was refused. The
    //    lane resolver already filtered its selection through the same policy.
    //
    // Native lanes run on the user's own subscription and keep the seed. An
    // explicitly configured value that differs from the shipped constant is
    // kept as-is; equality with the constant is the "untouched" signal.
    const seedUndispatchable = (lane: BillingLane): boolean =>
      !isModelRunnableOnLane(lane, configured) ||
      (lane === 'ai-credits' &&
        getRendererGuestPrincipal() &&
        !isGuestAllowedCreditsModel(configured));
    const model =
      advisorResolved &&
      advisorResolvedLane &&
      configured === DEFAULT_APP_ADVISOR_MODEL &&
      seedUndispatchable(advisorResolvedLane)
        ? advisorResolved.selection.model
        : configured;
    const thinkingLevel = modelDefaults.appAdvisorThinkingLevel ?? 'high';
    const selected = selectableDefault(
      model,
      thinkingLevel,
      advisorResolvedLane,
      // `chatProvider`, not `worktreeProvider`: `isCoworkChatTarget` is true for
      // `APP_ADVISOR_PROJECT_ID`, so `resolveLaneForTarget` above derived this
      // same `ollamaPinned` from the CHAT provider. Reading the worktree one
      // here made the two halves disagree whenever the user's chat and worktree
      // defaults name different providers.
      modelDefaults.chatProvider === 'ollama',
    );
    const provider = getProviderForModel(selected.model) ?? 'codex';
    return {
      model: selected.model,
      providerType: provider,
      thinkingLevel: selected.thinkingLevel,
      modelConfig: {
        thinkingLevel: selected.thinkingLevel,
        ...providerDefaultSpeedFields(modelDefaults, provider),
      },
    };
  }
  const isStandalone = isCoworkChatTarget(projectId);
  const preferredProvider = isStandalone
    ? modelDefaults.chatProvider
    : modelDefaults.worktreeProvider;
  // `modelDefaults` is hydrated from a preferences file, and a partial or
  // corrupt one leaves the per-provider map missing even though the type says
  // otherwise. `resolveOverallDefault` dereferences `.claude` unguarded, so
  // this used to be a crash waiting for a caller that reached it early — which
  // lane resolution now is, since it re-runs whenever an auth probe settles.
  // Falling back to no opinion matches the persistence rule elsewhere: silent
  // defaults over throwing.
  const byProviderForSurface = isStandalone
    ? modelDefaults.chatModelByProvider
    : modelDefaults.worktreeModelByProvider;
  // Guard exactly what `resolveOverallDefault` will dereference, and no more.
  // Demanding every provider entry would bail on the legitimate shape where a
  // provider the user does not use is absent.
  const overallEntry =
    preferredProvider === 'codex'
      ? byProviderForSurface?.codex
      : preferredProvider === 'ollama'
        ? (byProviderForSurface?.ollama ?? byProviderForSurface?.claude)
        : byProviderForSurface?.claude;
  if (!overallEntry) return {};
  const persisted = isStandalone
    ? resolveOverallDefault(
        modelDefaults.chatModelByProvider,
        modelDefaults.chatProvider,
      )
    : resolveOverallDefault(
        modelDefaults.worktreeModelByProvider,
        modelDefaults.worktreeProvider,
      );
  // Lane resolution replaces `resolveOverallDefault` as the source of the seed:
  // the persisted per-provider default only describes WHAT the user prefers,
  // never whether they can pay for it. Its thinking level is still carried
  // through when the lane lands on that same model.
  const lane = resolveLaneForTarget(projectId, modelDefaults);
  const resolvedLane = lane?.outcome === 'resolved' ? lane.lane : undefined;
  const resolved =
    lane?.outcome === 'resolved'
      ? {
          model: lane.selection.model,
          thinkingLevel:
            lane.selection.model === persisted.model
              ? persisted.thinkingLevel
              : lane.selection.thinkingLevel,
          modelConfig:
            lane.selection.model === persisted.model
              ? persisted.modelConfig
              : undefined,
        }
      : persisted;
  const selected = selectableDefault(
    resolved.model,
    resolved.thinkingLevel,
    resolvedLane,
    preferredProvider === 'ollama',
  );
  const model =
    !getRendererModelGatewayEnforced() &&
    useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key)
      ? resolveDefaultChatModel(selected.model)
      : selected.model;
  const provider = getProviderForModel(model) ?? preferredProvider;
  return {
    model,
    providerType: provider,
    thinkingLevel: selected.thinkingLevel,
    modelConfig: {
      ...withoutCodexSpeed(resolved.modelConfig),
      thinkingLevel:
        selected.model === resolved.model
          ? (resolved.modelConfig?.thinkingLevel ?? selected.thinkingLevel)
          : selected.thinkingLevel,
      ...providerDefaultSpeedFields(modelDefaults, provider),
    },
  };
}

/**
 * The provider default record's speed, read speed-first (its `speed`, then
 * its legacy `fastMode`), as the canonical pair. As before, the provider
 * default record — not the per-model default selection — decides the speed a
 * new tab starts with.
 */
function providerDefaultSpeedFields(
  modelDefaults: NonNullable<ChatState['modelDefaults']>,
  provider: AgentProviderType,
): ReturnType<typeof codexSpeedFields> {
  return codexSpeedFields(
    readCodexSpeedRecord(
      (modelDefaults.modelConfigDefaultsByProvider ?? {})[provider],
    ) ?? DEFAULT_CODEX_SPEED,
  );
}

export function resolveDefaultChatInterfaceMode(
  projectId: string,
  modelDefaults: ChatState['modelDefaults'],
): ChatInterfaceMode | undefined {
  return getEffectiveClaudeChatInterfaceMode(
    resolvePersistedDefaultChatInterfaceMode(projectId, modelDefaults),
  );
}

/**
 * Resolve the remembered billing framework used to seed a fresh chat tab.
 *
 * Mirrors the user's last explicit "Use AI Credits" picker choice, cached into
 * `modelDefaults.billingFramework` from `PreferencesData.lastChatBillingFramework`.
 * Returns `undefined` when the user has never touched the toggle, so new chats
 * preserve today's behavior (the `aiCreditsRoutingMode` safety net) rather than
 * being force-seeded onto either framework.
 *
 * ONE EXCEPTION to that "never force-seed either framework" contract: when the
 * resolved lane IS `ai-credits`, the tab is force-seeded onto credits. The seed
 * is no longer a remembered preference in that case, it is a statement about
 * how the turn will actually be paid for, and two things read it that way —
 * `resolveGatewayToolSchemaProfile` picks the tool schema from it (a wrong
 * framework ships the wrong schema), and `NoBillingSourceBanner` scopes its
 * runtime trigger on `effectiveBillingFramework !== 'subscription'`, which
 * misfires if a credits-lane chat reports no framework at all.
 */
export function resolveBillingSeed(
  modelDefaults: ChatState['modelDefaults'],
  projectId?: string,
): ChatBillingFramework | undefined {
  if (projectId !== undefined) {
    const lane = resolveLaneForTarget(projectId, modelDefaults);
    // `!provisional` matches the gate main puts on its own durable lane write.
    // A PROVISIONAL credits resolution is a guess made while availability is
    // still UNKNOWN — at launch with `lastResolvedDefaultLane: 'ai-credits'`
    // the splice puts credits first and returns provisional — and seeding on it
    // wrote `aiCreditsRouting { active: true, scope: 'persistent' }`, the same
    // shape a deliberate user toggle writes, which `toPersistedTab` then
    // persisted. It self-corrected only while the tab stayed active and
    // pristine; switching worktrees or quitting first made the guess durable.
    if (
      lane?.outcome === 'resolved' &&
      !lane.provisional &&
      lane.lane === 'ai-credits'
    ) {
      return 'ai-credits';
    }
  }
  return modelDefaults?.billingFramework;
}

/** Resolve the deferred-tools permission used only when a fresh tab is made. */
export function resolveDeferredToolsAllowedDefault(
  projectId: string,
  worktreeId: string | undefined,
  defaults: ChatState['deferredToolsDefaults'],
): boolean {
  if (!defaults) return true;
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    return defaults.deferredToolsAppAdvisorEnabled ?? true;
  }
  if (
    worktreeId !== undefined &&
    isPipelineEditorChatTarget(projectId, worktreeId)
  ) {
    return defaults.deferredToolsPipelineAssistantEnabled ?? true;
  }
  return isCoworkChatTarget(projectId)
    ? (defaults.deferredToolsStandaloneChatsEnabled ?? true)
    : (defaults.deferredToolsWorktreeChatsEnabled ?? true);
}

export function resolvePersistedDefaultChatInterfaceMode(
  projectId: string,
  modelDefaults: ChatState['modelDefaults'],
): ChatInterfaceMode | undefined {
  // The pipeline-editor assistant must always use the Canopy-native runtime;
  // the managed Claude Code terminal can't host its MCP tools. Force canopy
  // regardless of the user's default chat interface mode.
  if (projectId === PIPELINE_EDITOR_PROJECT_ID) {
    return 'canopy';
  }
  if (!modelDefaults) return undefined;
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    return modelDefaults.defaultAppAdvisorInterfaceMode;
  }
  return isCoworkChatTarget(projectId)
    ? modelDefaults.defaultStandaloneChatInterfaceMode
    : modelDefaults.defaultChatInterfaceMode;
}

/**
 * Resolve the per-provider default selection for the given projectId's chat
 * kind (standalone vs worktree). Returns undefined if the provider has no
 * configured default (e.g. Ollama with no installed models).
 */
export function resolveProviderDefaults(
  projectId: string,
  modelDefaults: ChatState['modelDefaults'],
  provider: AgentProviderType,
): { model?: ChatModel; thinkingLevel?: ThinkingLevel } {
  if (!modelDefaults) return {};
  const byProvider = isCoworkChatTarget(projectId)
    ? modelDefaults.chatModelByProvider
    : modelDefaults.worktreeModelByProvider;
  if (provider === 'ollama') {
    if (!byProvider.ollama) return {};
    return {
      model: byProvider.ollama.model,
      thinkingLevel: byProvider.ollama.thinkingLevel,
    };
  }
  const selection = provider === 'codex' ? byProvider.codex : byProvider.claude;
  return { model: selection.model, thinkingLevel: selection.thinkingLevel };
}

export function resolveFallbackModelForDeletedOllama(
  projectId: string,
  modelDefaults: ChatState['modelDefaults'],
  availableOllamaModels: readonly ChatModel[],
): ChatModel {
  const nextOllamaModel = availableOllamaModels[0];
  if (nextOllamaModel) {
    return nextOllamaModel;
  }

  return resolveTabDefaults(projectId, modelDefaults).model ?? DEFAULT_MODEL;
}

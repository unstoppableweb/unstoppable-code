import {
  CREDITS_LANE_DEFAULT_CANDIDATES,
  isCodexModelAvailableToAccount,
  repairLaneDefaults,
  resolveDefaultModelLane,
  type BillingLane,
  type DefaultModelLaneResolution,
  type EnforcedOrgGatewayLane,
} from '@canopy/desktop-shared/lib/default-model-lane';
import {
  AI_GATEWAY_MODELS,
  APP_ADVISOR_PROJECT_ID,
  CLAUDE_MODELS,
  CODEX_ACCOUNT_MODELS,
  CODEX_MODELS,
  DEFAULT_APP_ADVISOR_MODEL,
  OLLAMA_MODELS,
  clampThinkingLevelForModel,
  hasHydratedGatewayCatalog,
  hasHydratedModelRegistry,
  getExecutionHarnessForModel,
  isAgentModel,
  isInheritingAgentModel,
  isSelectableOllamaModel,
  resolveKnownModel,
  type AgentProviderType,
  type ChatModel,
  type ModelDefaultsByProvider,
  type PreferencesData,
  type ProviderModelSelection,
} from '@canopy/desktop-shared/types';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { loadCanopyCloudAccount } from './canopy-cloud-account-store';
import {
  modelLibraryAccountKey,
  readRetainedModelLibraryAccess,
} from '../canopy-cloud/model-library-access';
import {
  isGatewayOnlyModel,
  isGatewayRoutableModel,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import {
  isModelExcludedByGatewayRequirement,
  listOrgGatewayModelsForOrganization,
} from '@canopy/desktop-shared/lib/org-model-gateway';
import {
  isProviderNativelyAuthenticatedForRouting,
  peekFreshProviderNativeAuthAvailability,
  peekClaudeAuthInconclusiveWithoutSignIn,
  peekProviderNativeAuthAvailability,
} from '../auth/provider-auth-state';
import {
  getAiCreditsRoutingContextWithStatus,
  hasUserSuppliedProviderCredential,
} from '../agents/ai-credits-routing';
import {
  resolveInvocationWorkOwner,
  resolveNavigationWorkOwner,
  resolveSessionWorkOwner,
  type WorkOwnerSession,
} from '../agents/work-owner';
import {
  isModelBlockedByCurrentPolicy,
  isModelBlockedByStoredPolicy,
  isOrgModelPolicyActiveForStoredAccount,
  isStoredModelPolicyReadDegraded,
} from './model-policy-state';
import { getModelGatewayRequirementForOwner } from './model-gateway-state';
import { previewAccountProxySessionRoute } from '../account-proxy/routing';
import { updatePreferencesFile } from './preferences-store';
import {
  peekCodexAccountModelIds,
  readCodexSpeedCatalog,
} from '../model-routing/codex-account-models';

/**
 * Thrown when no billing lane can dispatch a model.
 *
 * A named type rather than a bare `Error` so callers can distinguish a billing
 * dead end from resolver or preference-store failures.
 */
export class NoDispatchableModelError extends Error {
  readonly missing: string;

  constructor(missing: string) {
    super(`No dispatchable model is available (${missing}).`);
    this.name = 'NoDispatchableModelError';
    this.missing = missing;
  }
}

export interface ResolveDefaultModelLaneForPreferencesInput {
  defaults: ModelDefaultsByProvider;
  preferredProvider: AgentProviderType;
  lastResolvedLane: BillingLane | undefined;
  ollamaPinned: boolean;
  /**
   * Overrides the credits lane's AUTO candidate list. Background helpers pass
   * their (already policy-filtered) cheap candidates so the credits lane's
   * DISPATCHABILITY is judged against the models the helper will actually use.
   * Filtering afterwards was not enough: an org that blocks the chat-default
   * credits models but allows the cheap helper model made this resolver report
   * `no-dispatchable-model` before the helper set was ever examined.
   */
  creditsCandidates?: readonly ChatModel[];
  /**
   * Whether this resolution should update `lastProjectedDefaultModel`.
   *
   * That value is the sole source of `isDefault: true` in
   * `buildProjectedModelCatalog()` (Portal `availableModels`), so only a
   * resolution that really is answering "what is this user's default model?"
   * may write it. Helper resolutions and send-preflights that FORCE a
   * `preferredProvider` are answering a narrower question and must not, or the
   * Portal picker ends up flagging whichever model the last send happened to
   * use. Defaults to `true`; an explicit flag rather than an inference, because
   * `!creditsCandidates` alone silently missed the forced-provider callers.
   */
  stampProjection?: boolean;
  /**
   * The default scope this resolution ANSWERS FOR, when it genuinely answers
   * "what is the user's default?".
   *
   * Only set for a resolution that is asking that question for real, and it is
   * the sole trigger for persisting `lastResolvedDefaultLaneByScope`. Two kinds
   * of caller must leave it unset: background helpers (which pass their own
   * cheap `creditsCandidates`, so their lane is not the user's default lane),
   * and send preflights that FORCE a provider the scope does not default to —
   * a Codex chat send by a Claude-defaulting user is not evidence about that
   * user's default lane, and persisting it seeded the wrong provisional model
   * on the next loading window.
   *
   * It is a SCOPE rather than a boolean because the chat and worktree defaults
   * can prefer different providers and therefore resolve to different lanes.
   */
  persistScope?: 'chat' | 'worktree';
  /**
   * Lanes the PREFERENCES file currently records as last-resolved, across every
   * scope plus the legacy scalar.
   *
   * Only used to decide whether a lane this resolution CONFIRMED unavailable is
   * worth erasing. Without it the resolver would schedule a preferences write
   * after every turn for any user with a signed-out native provider — the
   * common case — to discover there was nothing to erase.
   */
  storedLanes?: readonly BillingLane[];
  /**
   * Workspace whose Canopy Environments assignments apply to the credential
   * check below, matching what the session spawn will actually resolve.
   *
   * `EnvironmentRuntimeAssignments` has a global slot per runtime AND a
   * per-workspace override, so omitting this is not merely "less precise": a
   * workspace-only credential is missed, and a global credential is credited
   * even in a workspace whose override selects an environment WITHOUT it.
   * Either way selection disagrees with the spawn — which DOES pass a workspace
   * (`claude-session.ts` / `codex-session.ts` pass `opts.projectId`) — and the
   * false-positive direction picks a native model that later falls through to
   * AI Credits.
   *
   * The rule is PARITY WITH THE SPAWN, not "pass whatever id is in scope": a
   * caller must pass exactly the id its eventual spawn passes. Chat dispatch
   * paths do (`opts.projectId`), and so do the background helpers — they spawn
   * through `resolveAgentEnvironment(options?.workspaceId)`
   * (`agents/utils.ts`), whose sibling comment states the same rule. So EVERY
   * caller names its spawn's workspace; `null` is reserved for a spawn that
   * genuinely uses the bare global runtime slot, not used as a shorthand for
   * "this is a helper".
   */
  workspaceId?: string;
  /** Captured chat owner, used when this resolution belongs to a session. */
  workOwnerSession?: WorkOwnerSession;
}

/**
 * Workspace/runtime scope for the user-supplied-credential check.
 *
 * Carried as an object rather than more positional parameters because every
 * wrapper below already takes three or four of them.
 *
 * `workspaceId` is REQUIRED, and `null` is the explicit "global runtime slot"
 * opt-out rather than an omission. Four consecutive review rounds found the
 * same defect — a fix applied at one call site and not its siblings — and an
 * optional field is exactly what makes that omission invisible: a caller that
 * simply forgets the scope compiles, runs, and silently disagrees with its own
 * spawn. Requiring the field turns the omission into a compile error and forces
 * every new dispatch-model call site to state which environment its spawn
 * resolves. `null` is used rather than a magic string because workspace ids are
 * lowercase slugs and a sentinel like `'global'` is a legal one.
 *
 * The rule for choosing a value is PARITY WITH THE SPAWN, not "pass whatever id
 * is in scope" — see
 * {@link ResolveDefaultModelLaneForPreferencesInput.workspaceId}.
 *
 * There is deliberately NO `credentialRuntime` field. Every lane-resolving
 * caller in the app spawns on the Environments AGENT slot — including the
 * pipeline advisor, whose `runPipelineAdvisorSdkTurn` resolves
 * `{ runtime: 'agent', workspaceId }` (`pipeline-advisor-sdk.ts:84-86`), and
 * the three `runtime: 'pipeline'` sites (`execution-runtime.ts`,
 * `pipeline-handlers.ts`, `pipeline-resume-service.ts`) resolve no lane model
 * at all. A field with no production caller cannot be kept honest, so it is
 * absent until a spawn on the pipeline slot actually needs a lane default.
 */
export interface LaneCredentialScope {
  /** Workspace the eventual spawn passes, or `null` for the global slot. */
  workspaceId: string | null;
  /** Captured chat owner when the lane check belongs to an existing session. */
  workOwnerSession?: WorkOwnerSession;
}

/** Explicit global-slot scope, for callers whose spawn passes no workspace. */
export const GLOBAL_LANE_CREDENTIAL_SCOPE: LaneCredentialScope = {
  workspaceId: null,
};

function credentialScopeFields(scope: LaneCredentialScope): {
  workspaceId?: string;
  workOwnerSession?: WorkOwnerSession;
} {
  return {
    ...(scope.workspaceId !== null ? { workspaceId: scope.workspaceId } : {}),
    ...(scope.workOwnerSession
      ? { workOwnerSession: scope.workOwnerSession }
      : {}),
  };
}

async function resolveLaneWorkOwner(
  input: Pick<
    ResolveDefaultModelLaneForPreferencesInput,
    'workspaceId' | 'workOwnerSession'
  >,
): Promise<WorkOwner | undefined> {
  if (input.workOwnerSession) {
    const sessionOwner = await resolveSessionWorkOwner(input.workOwnerSession);
    if (sessionOwner) return sessionOwner;
  }
  if (input.workspaceId !== undefined) {
    const workspaceOwner = await resolveInvocationWorkOwner({
      projectId: input.workspaceId,
    });
    if (workspaceOwner) return workspaceOwner;
  }
  return resolveNavigationWorkOwner();
}

let lastProjectedDefaultModel: ChatModel | undefined;
const pendingResolvedLanes = new Map<'chat' | 'worktree', BillingLane>();
/**
 * Lanes this process has CONFIRMED unavailable, to be erased from every stored
 * scope on the next flush.
 *
 * Nothing else ever clears a scope: a scope's record is only rewritten by a
 * resolution FOR THAT SCOPE, so a user who cancels Codex and then works only in
 * cowork chats keeps `byScope.worktree === 'codex-native'` forever — which
 * latches {@link shouldPrewarmCodexNativeAuthAtStartup} on permanently and
 * spawns an app-server at every launch for a provider they no longer have.
 * A confirmed `false` for the lane is evidence about the lane itself, not about
 * one scope, so it invalidates the record everywhere it appears.
 */
const pendingClearedLanes = new Set<BillingLane>();
let pendingMostRecentLane: BillingLane | undefined;
let resolvedLanePersistenceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingLanePersistenceSinceMs: number | undefined;

const RESOLVED_LANE_PERSIST_DEBOUNCE_MS = 500;
/**
 * Upper bound on how long the debounce may defer a write. Without it a busy
 * period (every chat send resolves a lane) restarts the 500ms timer forever and
 * the record is never written at all.
 */
const RESOLVED_LANE_PERSIST_MAX_WAIT_MS = 3_000;

function flushResolvedLanePersistence(): void {
  resolvedLanePersistenceTimer = undefined;
  pendingLanePersistenceSinceMs = undefined;
  const lanes = new Map(pendingResolvedLanes);
  const cleared = new Set(pendingClearedLanes);
  // The scope-agnostic field stays the MOST RECENT answer, for the startup
  // prewarm and the renderer's pre-preferences fallback seed.
  const mostRecent = pendingMostRecentLane;
  pendingResolvedLanes.clear();
  pendingClearedLanes.clear();
  pendingMostRecentLane = undefined;
  if (lanes.size === 0 && cleared.size === 0) return;
  void updatePreferencesFile((preferences) => {
    const current = preferences.lastResolvedDefaultLaneByScope ?? {};
    const keep = (lane: BillingLane | undefined): BillingLane | undefined =>
      lane && cleared.has(lane) ? undefined : lane;
    const chat = lanes.get('chat') ?? keep(current.chat);
    const worktree = lanes.get('worktree') ?? keep(current.worktree);
    const next = {
      ...(chat ? { chat } : {}),
      ...(worktree ? { worktree } : {}),
    };
    const scalar = mostRecent ?? keep(preferences.lastResolvedDefaultLane);
    if (
      next.chat === current.chat &&
      next.worktree === current.worktree &&
      preferences.lastResolvedDefaultLane === scalar
    ) {
      return {};
    }
    return {
      lastResolvedDefaultLaneByScope: next,
      // `undefined` is a real value here: it erases a stale scalar whose lane
      // this process has confirmed unavailable.
      lastResolvedDefaultLane: scalar,
    };
  }).catch(() => undefined);
}

function scheduleResolvedLanePersistence(): void {
  const now = Date.now();
  pendingLanePersistenceSinceMs ??= now;
  if (resolvedLanePersistenceTimer) {
    if (
      now - pendingLanePersistenceSinceMs >=
      RESOLVED_LANE_PERSIST_MAX_WAIT_MS
    ) {
      // Max wait reached: let the in-flight timer fire rather than pushing it
      // out again.
      return;
    }
    clearTimeout(resolvedLanePersistenceTimer);
  }
  resolvedLanePersistenceTimer = setTimeout(
    flushResolvedLanePersistence,
    RESOLVED_LANE_PERSIST_DEBOUNCE_MS,
  );
}

function persistResolvedLaneDebounced(
  scope: 'chat' | 'worktree',
  lane: BillingLane,
): void {
  pendingResolvedLanes.set(scope, lane);
  pendingClearedLanes.delete(lane);
  pendingMostRecentLane = lane;
  scheduleResolvedLanePersistence();
}

function clearStoredLaneDebounced(lane: BillingLane): void {
  if (pendingMostRecentLane === lane) return;
  let pendingWritesLane = false;
  pendingResolvedLanes.forEach((pending) => {
    if (pending === lane) pendingWritesLane = true;
  });
  if (pendingWritesLane) return;
  pendingClearedLanes.add(lane);
  scheduleResolvedLanePersistence();
}

export function getLastProjectedDefaultModel(): ChatModel | undefined {
  return lastProjectedDefaultModel;
}

/**
 * Whether `model` can actually run on `lane` — the ONE copy of this rule.
 *
 * There were three, and they had already drifted: the helper-preference variant
 * omitted the registry check entirely and gated credits on
 * `isGatewayRoutableModel(model) || provisional` instead of the cold-catalog
 * check, so an unregistered id could be judged runnable on a native lane. Three
 * copies of one predicate is exactly how the renderer and main diverged in
 * earlier rounds of this change.
 *
 * Policy is deliberately NOT folded in here: the repair path and the helper
 * path apply different policy rules on top (see their call sites), and burying
 * one of them in the shared predicate would silently impose it on the other.
 */
function isModelRunnableOnLane(lane: BillingLane, model: ChatModel): boolean {
  if (resolveKnownModel(model) === undefined) return false;
  if (lane === 'claude-native') {
    return getExecutionHarnessForModel(model) === 'claude';
  }
  if (lane === 'codex-native') {
    return getExecutionHarnessForModel(model) === 'codex';
  }
  if (lane === 'ollama') return isSelectableOllamaModel(model);
  // Fail open only while the gateway catalog is genuinely cold.
  if (!hasHydratedGatewayCatalog()) return true;
  return isGatewayRoutableModel(model);
}

/** Resolve a default using authoritative main-process billing and policy facts. */
export async function resolveDefaultModelLaneForPreferences(
  input: ResolveDefaultModelLaneForPreferencesInput,
): Promise<DefaultModelLaneResolution> {
  // The degraded status is captured HERE, with the value, not re-read later.
  // Everything between this line and the availability fold below awaits (the
  // policy read, then the native auth probes), and any concurrent credits read
  // in that window would move a module-level flag out from under us.
  const ownerPromise = resolveLaneWorkOwner(input);
  const [
    owner,
    credits,
    policyActive,
    gatewayRequirement,
    account,
    claudeAccountProxyReady,
    codexAccountProxyReady,
  ] = await Promise.all([
    ownerPromise,
    ownerPromise.then((owner) =>
      getAiCreditsRoutingContextWithStatus({ owner }),
    ),
    ownerPromise.then((owner) => isOrgModelPolicyActiveForStoredAccount(owner)),
    ownerPromise.then((owner) =>
      getModelGatewayRequirementForOwner(
        owner,
        'resolveDefaultModelLaneForPreferences',
      ),
    ),
    // An unreadable account is not a guest, and holds no retained access.
    loadCanopyCloudAccount().catch(() => null),
    // A ready account proxy bills the harness's own models, so it keeps that
    // harness's native lane live without a native login (CAN-4020).
    previewAccountProxySessionRoute({
      harness: 'claude',
      model: undefined,
      resolveWorkOwner: () => ownerPromise,
    }),
    previewAccountProxySessionRoute({
      harness: 'codex',
      model: undefined,
      resolveWorkOwner: () => ownerPromise,
    }),
  ]);
  // A guest's AI Credits lane defaults only to allowlisted models, the same
  // rule the renderer seed applies. A signed-in account that has not purchased
  // yet is held to the same allowlist (CAN-4028), using the selected owner's
  // scoped access for organization work and personal access otherwise. Read from the
  // retained answer only — this path must not add a cloud round trip, and an
  // absent answer leaves the default alone because the proxy still enforces.
  const guestPrincipal =
    isGuestAccount(account) ||
    (owner !== undefined &&
      readRetainedModelLibraryAccess(
        modelLibraryAccountKey(account),
        owner.kind === 'organization' ? owner : undefined,
      ) === 'needs_purchase');
  const creditsContext = credits.context;
  const creditsReadDegraded = credits.degraded;
  /**
   * Excluded because this org routes everything through its own gateway.
   *
   * Same shared rule the renderer seed and the picker's row gate use, folded
   * into the policy predicates rather than added beside them, so every
   * non-interactive caller downstream of this resolver — helpers, hooks,
   * automations, pipeline steps, the portal adapter — inherits it without its
   * own branch.
   */
  const orgGatewayExcluded = (model: ChatModel): boolean =>
    isModelExcludedByGatewayRequirement(model, gatewayRequirement, owner);
  const orgGateway: EnforcedOrgGatewayLane | undefined =
    gatewayRequirement.kind === 'enforced' && owner?.kind === 'organization'
      ? {
          enforced: true,
          models: listOrgGatewayModelsForOrganization(
            AI_GATEWAY_MODELS,
            owner.organizationId,
          ),
        }
      : undefined;

  const candidateModels = new Set<ChatModel>([
    input.defaults.claude.model,
    input.defaults.codex.model,
    ...(input.defaults.ollama ? [input.defaults.ollama.model] : []),
    ...(input.defaults.aiCredits ? [input.defaults.aiCredits.model] : []),
    ...(input.creditsCandidates ?? CREDITS_LANE_DEFAULT_CANDIDATES),
  ]);
  const policyByModel = new Map<ChatModel, boolean | undefined>();
  if (!policyActive) {
    candidateModels.forEach((model) => policyByModel.set(model, true));
  } else if (isStoredModelPolicyReadDegraded()) {
    candidateModels.forEach((model) => policyByModel.set(model, undefined));
  } else {
    await Promise.all(
      Array.from(candidateModels, async (model) => {
        const blocked = await isModelBlockedByStoredPolicy(model, owner);
        policyByModel.set(
          model,
          isStoredModelPolicyReadDegraded() ? undefined : !blocked,
        );
      }),
    );
  }
  // A CONFIRMED exclusion outranks every answer above, including the degraded
  // UNKNOWN: enforcement is read from the same stored account (with its own
  // durable marker), so it is known even when the policy read is not.
  candidateModels.forEach((model) => {
    if (orgGatewayExcluded(model)) policyByModel.set(model, false);
  });

  // Repair each lane's configured default BEFORE precedence is applied, with
  // exactly the shared helper the renderer seed uses. Without this, main and
  // the renderer answer differently for the same user in the same state: the
  // resolver considers only one candidate per native lane, so a Claude
  // subscriber whose configured Claude model is org-blocked makes
  // `claude-native` contribute nothing here and falls through to credits (or
  // throws), while the composer shows a repaired Claude model.
  //
  // Runs AFTER the policy awaits above so `isModelBlockedByCurrentPolicy`
  // answers from a refreshed `currentPolicy` rather than the empty startup set.
  const policyDegraded = isStoredModelPolicyReadDegraded();
  const isPolicyBlockedForRepair = (model: ChatModel): boolean =>
    // UNKNOWN (no active policy, or a degraded read) must answer `false`:
    // repair rewrites the user's configured default, and doing that on an
    // unresolved read would silently replace it during the startup window.
    // Degraded reads still fail closed at the enforcement guards on dispatch.
    //
    // An enforced org gateway is never UNKNOWN in that sense, so it repairs.
    orgGatewayExcluded(model) ||
    (policyActive &&
      !policyDegraded &&
      isModelBlockedByCurrentPolicy(model, owner));
  // The signed-in ChatGPT account's own model list, from cache only: the send
  // path never waits for `model/list`. A model the account cannot run is
  // unusable on the Codex lane, so the repair walks to the first one it can
  // (CAN-4716). Unknown (`null`) changes nothing. The stored default itself is
  // never rewritten; only this resolution sees the repaired model.
  const codexAccountModels = peekCodexAccountModelIds();
  const isRunnableOnLane = (lane: BillingLane, model: ChatModel): boolean =>
    isModelRunnableOnLane(lane, model) &&
    (lane !== 'codex-native' ||
      isCodexModelAvailableToAccount(model, codexAccountModels));
  const repairedDefaults = repairLaneDefaults(
    {
      claude: input.defaults.claude,
      codex: input.defaults.codex,
      ollama: input.defaults.ollama ?? null,
      aiCredits: input.defaults.aiCredits ?? null,
    },
    {
      laneCatalog: (lane) =>
        lane === 'claude-native'
          ? CLAUDE_MODELS
          : lane === 'codex-native'
            ? // Catalog order first, then the account's own models (its
              // default first), so the repair picks the first catalog model
              // the account can run and only then an account-only one.
              [...CODEX_MODELS, ...CODEX_ACCOUNT_MODELS]
            : lane === 'ollama'
              ? OLLAMA_MODELS
              : AI_GATEWAY_MODELS,
      isPolicyBlocked: isPolicyBlockedForRepair,
      isModelInRegistry: (model) => resolveKnownModel(model) !== undefined,
      isLaneCatalogHydrated: (lane) =>
        // The credits lane is backed by the gateway route catalog; every other
        // lane by the model registry. They hydrate independently.
        lane === 'ai-credits'
          ? hasHydratedGatewayCatalog()
          : hasHydratedModelRegistry(),
      isRunnableOnLane,
      clampThinkingLevel: clampThinkingLevelForModel,
    },
  );
  // A repair can introduce a model the policy pass above never scored. Score it
  // now from the same refreshed policy, so `isModelAllowed` cannot answer
  // `undefined` for a model this resolver just chose.
  for (const selection of [
    repairedDefaults.claude,
    repairedDefaults.codex,
    repairedDefaults.ollama,
    repairedDefaults.aiCredits,
  ]) {
    if (!selection || policyByModel.has(selection.model)) continue;
    policyByModel.set(
      selection.model,
      orgGatewayExcluded(selection.model)
        ? false
        : !policyActive
          ? true
          : policyDegraded
            ? undefined
            : !isModelBlockedByCurrentPolicy(selection.model, owner),
    );
  }

  // Probe the native lanes LAZILY, in the precedence order the resolver will
  // apply. Awaiting both unconditionally made every resolution pay for a Codex
  // `account/read` — which spawns an app-server for a user who has never used
  // Codex — so probing both can move the spawn from `whenReady` to the
  // first message even when the earlier lane is available.
  //
  // A lane can only be skipped when a lane that STRICTLY PRECEDES it is
  // confirmed available and has a dispatchable default, because then the
  // resolver returns at that earlier lane. `resolveDefaultModelLane` builds its
  // order as `[preferredLane, ...['claude-native','codex-native','ai-credits']]`
  // (with `ollama` hoisted to the front when pinned), and its last-known-lane
  // splice inserts AFTER the last confirmed-available lane — so a confirmed,
  // dispatchable lane at index 0 always wins.
  const laneHasDispatchableDefault = (lane: BillingLane): boolean => {
    const selection =
      lane === 'claude-native'
        ? repairedDefaults.claude
        : lane === 'codex-native'
          ? repairedDefaults.codex
          : lane === 'ollama'
            ? repairedDefaults.ollama
            : repairedDefaults.aiCredits;
    if (!selection) return false;
    if (policyByModel.get(selection.model) === false) return false;
    return isRunnableOnLane(lane, selection.model);
  };
  // The auth probe runs `getEnhancedEnv({ environment: false })`, so it cannot
  // see a provider credential injected through Canopy Environments. Treating
  // that user as signed out is the same mistake the routing gate fixed at
  // `claude-session.ts` / `codex-session.ts`: a user with `ANTHROPIC_API_KEY`
  // (or a Bedrock/Vertex redirect, or the Codex equivalent) in an Environment
  // and no Canopy cloud account otherwise resolves to `no-dispatchable-model`,
  // which throws in branch naming, commit/PR generation, summaries, hook chat,
  // automations and the advisors, and shows a false "no billing source" banner.
  //
  // `hasUserSuppliedProviderCredential` fails closed (returns `false` on any
  // error), matching the routing gate. The workspace/runtime scope is threaded
  // through so this answers for the SAME effective environment the spawn will
  // resolve — see `ResolveDefaultModelLaneForPreferencesInput.workspaceId`.
  //
  // MEMOIZED per resolution. `hasUserSuppliedProviderCredential` runs
  // `getEnhancedEnv`, which spreads all of `process.env` and then runs the
  // user-environment and secrets injectors; this used to be evaluated up to 4×
  // per resolution (twice inside the probe loop, twice again at the fold
  // below). Lane resolution is now on the interactive send path, so that is
  // synchronous main-thread work per turn. At most one call per provider per
  // scope survives.
  const credentialCache = new Map<string, boolean>();
  const hasSuppliedCredential = (
    provider: 'claude' | 'codex',
    // `'scoped'` resolves this resolution's project override; `'global'`
    // deliberately ignores it. They are the same read when no workspace was
    // passed, and the cache key collapses accordingly.
    reach: 'scoped' | 'global',
  ): boolean => {
    const workspaceId = reach === 'scoped' ? input.workspaceId : undefined;
    const key = `${provider}:${workspaceId ?? ''}`;
    const cached = credentialCache.get(key);
    if (cached !== undefined) return cached;
    const value = hasUserSuppliedProviderCredential(provider, workspaceId);
    credentialCache.set(key, value);
    return value;
  };
  const withUserSuppliedCredential = (
    provider: 'claude' | 'codex',
    probed: boolean | undefined,
  ): boolean | undefined =>
    probed === true ||
    hasSuppliedCredential(provider, 'scoped') ||
    (provider === 'claude' ? claudeAccountProxyReady : codexAccountProxyReady)
      ? true
      : probed;
  // Walk the ACTUAL precedence order rather than a fixed Claude-then-Codex
  // sequence. Probing Claude first for a Codex-preferred user meant a signed-in
  // Codex subscriber still paid for an irrelevant Claude probe — which, when it
  // fails, can burn the full timeout/retry budget before the lane that was
  // always going to win is even looked at.
  const preferredLane: BillingLane =
    input.preferredProvider === 'codex'
      ? 'codex-native'
      : input.preferredProvider === 'ollama'
        ? 'ollama'
        : 'claude-native';
  const baseLaneOrder: readonly BillingLane[] = [
    'claude-native',
    'codex-native',
    'ai-credits',
  ];
  // Mirrors `resolveDefaultModelLane`'s own order construction exactly.
  const laneOrder: readonly BillingLane[] = input.ollamaPinned
    ? ['ollama', ...baseLaneOrder]
    : [
        ...(preferredLane === 'ollama' ? [] : [preferredLane]),
        ...baseLaneOrder.filter((lane) => lane !== preferredLane),
      ];
  // Which native lanes THIS call actually confirmed. `peekProviderNativeAuth-
  // Availability()` is a cache read with no TTL check, so a lane we skipped can
  // report an arbitrarily old answer; erasing a stored lane on that would
  // contradict `pendingClearedLanes` ("CONFIRMED unavailable").
  const probedLanes = new Set<BillingLane>();
  for (const lane of laneOrder) {
    if (lane === 'ollama') {
      // Availability is the pin itself — nothing to probe. A dispatchable
      // pinned Ollama lane wins outright and no native probe is needed.
      if (input.ollamaPinned && laneHasDispatchableDefault('ollama')) break;
      continue;
    }
    if (lane === 'ai-credits') {
      // Always last, and its availability came from the credits read above.
      // Reaching it means no earlier lane won, so there is nothing left to skip.
      break;
    }
    const provider = lane === 'claude-native' ? 'claude' : 'codex';
    probedLanes.add(lane);
    await isProviderNativelyAuthenticatedForRouting(
      provider,
      'default-model-lane',
    );
    const auth = withUserSuppliedCredential(
      provider,
      peekProviderNativeAuthAvailability()[provider],
    );
    // Only a CONFIRMED available lane with a dispatchable default returns at
    // this index; an UNKNOWN one may still resolve provisionally further down,
    // so the remaining lanes still need real facts.
    if (auth === true && laneHasDispatchableDefault(lane)) break;
  }
  const claudeNativeAuth = withUserSuppliedCredential(
    'claude',
    peekProviderNativeAuthAvailability().claude,
  );
  const codexNativeAuth = withUserSuppliedCredential(
    'codex',
    peekProviderNativeAuthAvailability().codex,
  );
  // Warm the account list for the NEXT resolution once THIS call confirmed the
  // Codex lane (never when an earlier lane won and Codex was not probed). The
  // catalog read honours its failure backoff, unlike Auto's reader, so a
  // failing account does not re-spawn a lookup on every send.
  if (
    probedLanes.has('codex-native') &&
    codexNativeAuth === true &&
    codexAccountModels === null
  ) {
    void readCodexSpeedCatalog();
  }

  // An Environments credential or ready account proxy already folds Claude to
  // `true` above, so the inconclusive flag never applies to them. The
  // renderer's `useBillingLaneRuntimeSync` pairs this with its
  // `claudeProxyReady` and `userSuppliedCredential` exclusions.
  const claudeNativeAuthInconclusive =
    claudeNativeAuth === undefined && peekClaudeAuthInconclusiveWithoutSignIn();
  const resolution = resolveDefaultModelLane({
    availability: {
      claudeNativeAuth,
      ...(claudeNativeAuthInconclusive
        ? { claudeNativeAuthInconclusive: true }
        : {}),
      codexNativeAuth,
      creditsEligible:
        creditsContext === null
          ? // `null` has TWO causes and they are not the same fact. A real
            // sign-out (no account, no CSK, no cloud base URL) is a confirmed
            // `false`. But `loadCanopyCloudAccount` also collapses `unavailable`
            // and `error` reads into `null` — a keychain lock or a decrypt
            // blip — and reporting that as CONFIRMED-dead told a credits-only
            // user with a funded balance to "Add a billing source". Every other
            // axis here preserves UNKNOWN, so this one does too.
            creditsReadDegraded
            ? undefined
            : false
          : creditsContext.creditsEligibilityKnown
            ? creditsContext.creditsEligible
            : undefined,
    },
    defaults: repairedDefaults,
    preferredProvider: input.preferredProvider,
    lastResolvedLane: input.lastResolvedLane,
    isModelAllowed: (model) => policyByModel.get(model),
    isModelInRegistry: (model) => resolveKnownModel(model) !== undefined,
    gatewayRoutesHydrated: hasHydratedGatewayCatalog(),
    ollamaPinned: input.ollamaPinned,
    codexAccountModels,
    ...(orgGateway ? { orgGateway } : {}),
    guestPrincipal,
    // Synthesized credits candidates carry a nominal `'high'`, which callers
    // forward straight into the dispatched turn. Clamp it with exactly the hook
    // the lane-default repair above uses.
    clampThinkingLevel: clampThinkingLevelForModel,
    ...(input.creditsCandidates
      ? { creditsCandidates: input.creditsCandidates }
      : {}),
  });
  if (resolution.outcome === 'resolved') {
    // Only a genuine DEFAULT-model resolution updates the projection.
    // `lastProjectedDefaultModel` is the sole source of `isDefault: true` in
    // `buildProjectedModelCatalog()` (Portal `availableModels`), and helper
    // resolutions pass their own cheap `creditsCandidates` — so without this
    // guard every background branch name, summary and commit message would
    // stamp the cheap helper model as the user's default.
    if (input.stampProjection !== false && !input.creditsCandidates) {
      lastProjectedDefaultModel = resolution.selection.model;
    }
    // Persist only a genuine, non-provisional DEFAULT resolution for a known
    // scope. See `persistScope` for why forced-provider preflights and helper
    // resolutions are excluded.
    if (!resolution.provisional && input.persistScope) {
      persistResolvedLaneDebounced(input.persistScope, resolution.lane);
    }
  } else if (input.stampProjection !== false && !input.creditsCandidates) {
    // A genuine DEFAULT resolution that came up empty must not leave the last
    // successful answer standing: `lastProjectedDefaultModel` is process-memory
    // only, so the Portal picker would keep flagging a model this user can no
    // longer dispatch as their default.
    lastProjectedDefaultModel = undefined;
  }
  // A CONFIRMED unavailable native lane invalidates the stored record for that
  // lane in EVERY scope, not just the one this resolution answers for. See
  // `pendingClearedLanes`.
  //
  // The negative must be BACKED BY A LIVE CONFIRMATION, not by whatever
  // `peekProviderNativeAuthAvailability()` still holds — that is a cache read
  // with NO TTL check, so with lazy probing a lane this call skipped can report
  // an arbitrarily old answer, and erasing a stored record on it is exactly
  // what `pendingClearedLanes` promises not to do.
  //
  // "Live" is either: probed in THIS call, or a cache entry still inside its
  // TTL (`peekFreshProviderNativeAuthAvailability`). The second arm matters —
  // it is what still clears the round-2 case of a user who cancelled Codex and
  // then works only in cowork chats, whose Claude lane now short-circuits the
  // Codex probe entirely.
  //
  // The negative must ALSO be GLOBALLY true, not merely true for this
  // resolution's workspace. `claudeNativeAuth`/`codexNativeAuth` fold in this
  // workspace's Environments override, and an override can REPLACE the global
  // slot rather than extend it — so a single workspace that selects an
  // environment without the credential would otherwise "confirm" the lane dead
  // for itself and then delete the process-wide record every other workspace,
  // helper and startup prewarm reads. Re-asking with the workspace dropped is
  // the same memoized read when the caller passed no workspace at all.
  const storedLanes = input.storedLanes;
  if (storedLanes) {
    const freshAuth = peekFreshProviderNativeAuthAvailability();
    const laneConfirmedDead = (
      lane: 'claude-native' | 'codex-native',
      provider: 'claude' | 'codex',
      resolvedAuth: boolean | undefined,
    ): boolean => {
      if (resolvedAuth !== false) return false;
      if (hasSuppliedCredential(provider, 'global')) return false;
      return probedLanes.has(lane) || freshAuth[provider] === false;
    };
    if (
      laneConfirmedDead('claude-native', 'claude', claudeNativeAuth) &&
      storedLanes.includes('claude-native')
    ) {
      clearStoredLaneDebounced('claude-native');
    }
    if (
      laneConfirmedDead('codex-native', 'codex', codexNativeAuth) &&
      storedLanes.includes('codex-native')
    ) {
      clearStoredLaneDebounced('codex-native');
    }
  }
  return resolution;
}

/**
 * Whether a CONCRETE, already-chosen model has a live lane that can run it.
 *
 * {@link resolveLaneAwareDefaultSelection} answers a DIFFERENT question — "is
 * the user's DEFAULT lane dispatchable?" — and judging an explicit model with
 * it fails in both directions:
 *
 * - FALSE REFUSAL. An Ollama user's `preferredProvider` is `'ollama'`, so
 *   `ollamaPinned` is set, but the ollama lane's only candidate is
 *   `defaultChatModelByProvider.ollama`, which `createDefaultModelDefaults-
 *   ByProvider()` seeds as `null` — the picker writes `tab.model`, not that
 *   preference. The lane contributes nothing, every cloud lane is legitimately
 *   `false`, and the send is refused with "Add a billing source" for a model
 *   that runs locally and costs nothing.
 * - FALSE PASS. An unavailable explicit Claude model passes merely because some
 *   OTHER default lane (Codex, credits) is up; dispatch then runs the Claude
 *   model and fails after the Work Entry and user message are already durable —
 *   the exact partial state the preflight exists to prevent.
 *
 * So this judges the lanes THIS model can actually run on, and fails OPEN on
 * anything unknown: an unrecognised model, an unsettled probe, or an
 * unresolved credits read all answer `'dispatchable'`. A preflight only exists
 * to avoid durably recording a prompt that provably cannot run; when it is not
 * sure, dispatch gives the real, specific error.
 */
export async function resolveConcreteModelDispatchability(
  model: ChatModel,
  credentialScope: LaneCredentialScope,
): Promise<'dispatchable' | 'no-billing-lane'> {
  // Not in the registry: dispatch owns that diagnosis ("Unsupported model …"),
  // and refusing it here as a BILLING dead end is the wrong error entirely.
  if (resolveKnownModel(model) === undefined) return 'dispatchable';
  // An Agent on the default model runs on the destination default it is
  // pinned to at send time, so that model is the one judged.
  if (isInheritingAgentModel(model)) {
    const { resolveAgentDestinationDefaultModel } =
      await import('../agents/agent-default-model');
    let pinned: ChatModel;
    try {
      pinned = await resolveAgentDestinationDefaultModel(
        credentialScope.workspaceId ?? undefined,
      );
    } catch (error) {
      return error instanceof NoDispatchableModelError
        ? 'no-billing-lane'
        : 'dispatchable';
    }
    return isAgentModel(pinned)
      ? 'dispatchable'
      : resolveConcreteModelDispatchability(pinned, credentialScope);
  }
  // Local, free, and never billed. This is the false refusal above.
  if (isSelectableOllamaModel(model)) return 'dispatchable';
  // Cursor bills to the Cursor account. None of the Claude, Codex, or AI
  // Credits probes below can say anything about it, and the Claude probe a
  // Cursor model would otherwise fall to refuses a Codex-only or credits-only
  // user as a Claude billing dead end. The managed-runtime preflight gates
  // Cursor separately at every entry point.
  if (
    getExecutionHarnessForModel(model) === 'cursor' ||
    getExecutionHarnessForModel(model) === 'copilot' ||
    getExecutionHarnessForModel(model) === 'opencode'
  )
    return 'dispatchable';
  // A GATEWAY-ONLY model skips the native shortcut entirely.
  //
  // It still reports a Claude or Codex execution harness — that is which
  // harness RUNS it, not who PAYS for it — so a natively authenticated user
  // took the `nativeAuth !== false` early return below and passed the
  // preflight. But session routing requires AI Credits for these models, so a
  // user with exhausted or absent credits then had the chat and user message
  // persisted before startup aborted: the exact partial state this preflight
  // exists to prevent, for the one model class that cannot use native billing.
  if (!isGatewayOnlyModel(model)) {
    const provider =
      getExecutionHarnessForModel(model) === 'codex' ? 'codex' : 'claude';
    await isProviderNativelyAuthenticatedForRouting(
      provider,
      'default-model-lane',
    );
    const probed = peekProviderNativeAuthAvailability()[provider];
    const nativeAuth =
      probed === true ||
      hasUserSuppliedProviderCredential(
        provider,
        credentialScope.workspaceId ?? undefined,
      )
        ? true
        : probed;
    // `undefined` is UNKNOWN, never a confirmed logout — fail open.
    if (nativeAuth !== false) return 'dispatchable';
    // A ready account proxy runs the harness's own models (CAN-4020).
    if (
      await previewAccountProxySessionRoute({
        harness: provider,
        model,
        resolveWorkOwner: () =>
          resolveLaneWorkOwner({
            ...(credentialScope.workspaceId !== null
              ? { workspaceId: credentialScope.workspaceId }
              : {}),
            ...(credentialScope.workOwnerSession
              ? { workOwnerSession: credentialScope.workOwnerSession }
              : {}),
          }),
      })
    )
      return 'dispatchable';
  }
  // The native lane is confirmed dead (or the model is gateway-only and never
  // had one), so AI Credits are the only remaining
  // route. Fail open while the gateway catalog is genuinely cold, exactly as
  // `isRunnableOnLane` does for the credits lane.
  if (hasHydratedGatewayCatalog() && !isGatewayRoutableModel(model)) {
    return 'no-billing-lane';
  }
  const owner = await resolveLaneWorkOwner({
    ...(credentialScope.workspaceId !== null
      ? { workspaceId: credentialScope.workspaceId }
      : {}),
    ...(credentialScope.workOwnerSession
      ? { workOwnerSession: credentialScope.workOwnerSession }
      : {}),
  });
  const credits = await getAiCreditsRoutingContextWithStatus({ owner });
  const creditsContext = credits.context;
  if (creditsContext === null) {
    // Same rule as the default-lane resolution above, and the same reason this
    // function fails open everywhere else: `null` ALSO means the account read
    // failed (`loadCanopyCloudAccount` folds `unavailable`/`error` into it), and
    // refusing on that told a credits-only user with a funded balance to add a
    // billing source after a keychain lock or decrypt blip.
    return credits.degraded ? 'dispatchable' : 'no-billing-lane';
  }
  if (!creditsContext.creditsEligibilityKnown) return 'dispatchable';
  return creditsContext.creditsEligible ? 'dispatchable' : 'no-billing-lane';
}

/** Resolve the configured standalone/worktree default against live lanes. */
export async function resolveLaneAwareDefaultSelection(
  preferences: PreferencesData,
  scope: 'chat' | 'worktree',
  // REQUIRED and third so it cannot be silently omitted; see
  // {@link LaneCredentialScope}.
  credentialScope: LaneCredentialScope,
  preferredProvider?: AgentProviderType,
  creditsCandidates?: readonly ChatModel[],
  stampProjection?: boolean,
): Promise<DefaultModelLaneResolution> {
  const defaults =
    scope === 'chat'
      ? preferences.defaultChatModelByProvider
      : preferences.defaultWorktreeModelByProvider;
  const scopeProvider =
    scope === 'chat'
      ? preferences.defaultChatProvider
      : preferences.defaultWorktreeProvider;
  const preferred = preferredProvider ?? scopeProvider;
  // This resolution answers "what is the user's default?" only when it is
  // judging the scope's OWN preferred provider with the scope's own candidates.
  // A forced provider that differs, or a helper's cheap candidate list, answers
  // a narrower question and must not become the remembered lane.
  const answersScopeDefault = preferred === scopeProvider && !creditsCandidates;
  const storedLanes = [
    preferences.lastResolvedDefaultLaneByScope?.chat,
    preferences.lastResolvedDefaultLaneByScope?.worktree,
    preferences.lastResolvedDefaultLane,
  ].filter((lane): lane is BillingLane => lane !== undefined);
  return resolveDefaultModelLaneForPreferences({
    defaults,
    preferredProvider: preferred,
    ...(storedLanes.length > 0 ? { storedLanes } : {}),
    lastResolvedLane:
      preferences.lastResolvedDefaultLaneByScope?.[scope] ??
      preferences.lastResolvedDefaultLane,
    ollamaPinned: preferred === 'ollama',
    ...credentialScopeFields(credentialScope),
    ...(creditsCandidates ? { creditsCandidates } : {}),
    ...(stampProjection === false ? { stampProjection: false } : {}),
    ...(answersScopeDefault ? { persistScope: scope } : {}),
  });
}

/** Return a concrete default or fail before an implicit provider model can run. */
export async function requireLaneAwareDefaultSelection(
  preferences: PreferencesData,
  scope: 'chat' | 'worktree',
  credentialScope: LaneCredentialScope,
  preferredProvider?: AgentProviderType,
  stampProjection?: boolean,
): Promise<ProviderModelSelection> {
  const resolution = await resolveLaneAwareDefaultSelection(
    preferences,
    scope,
    credentialScope,
    preferredProvider,
    undefined,
    stampProjection,
  );
  if (resolution.outcome === 'no-dispatchable-model') {
    throw new NoDispatchableModelError(resolution.missing);
  }
  return resolution.selection;
}

/**
 * The model a new App Advisor chat starts on. An untouched seed that cannot
 * run on the chat lane follows that lane's default, as the composer's new
 * App Advisor tabs do; an explicitly chosen model is kept.
 */
export async function resolveAppAdvisorDefaultModel(
  preferences: PreferencesData,
): Promise<ChatModel> {
  const configured = preferences.appAdvisorModel ?? DEFAULT_APP_ADVISOR_MODEL;
  if (configured !== DEFAULT_APP_ADVISOR_MODEL) return configured;
  const resolution = await resolveLaneAwareDefaultSelection(
    preferences,
    'chat',
    { workspaceId: APP_ADVISOR_PROJECT_ID },
    undefined,
    undefined,
    false,
  );
  return resolution.outcome === 'resolved' &&
    !isModelRunnableOnLane(resolution.lane, configured)
    ? resolution.selection.model
    : configured;
}

/**
 * Lane default for callers that might not need one.
 *
 * {@link requireLaneAwareDefaultSelection} throws when no lane is dispatchable,
 * which is right when the default IS the model. But hooks and automations await
 * it BEFORE deciding whether an explicitly configured `action.model` supersedes
 * it, so a user with no billing lane saw
 * `No dispatchable model is available (billing-lane).` for a flow that never
 * needed a default at all.
 *
 * `selection` is `undefined` rather than throwing; `requireModel()` raises the
 * same error `requireLaneAwareDefaultSelection` would, but only on the branch
 * that actually consumes the default. Callers should reach for it lazily —
 * `action.model?.trim() || laneDefault.requireModel().model` — so the throw is
 * never evaluated when an explicit model is present.
 */
export async function resolveOptionalLaneAwareDefaultSelection(
  preferences: PreferencesData,
  scope: 'chat' | 'worktree',
  credentialScope: LaneCredentialScope,
  preferredProvider?: AgentProviderType,
): Promise<{
  selection: ProviderModelSelection | undefined;
  requireModel: () => ProviderModelSelection;
}> {
  const resolution = await resolveLaneAwareDefaultSelection(
    preferences,
    scope,
    credentialScope,
    preferredProvider,
  );
  const selection =
    resolution.outcome === 'resolved' ? resolution.selection : undefined;
  return {
    selection,
    requireModel: (): ProviderModelSelection => {
      if (!selection) {
        throw new NoDispatchableModelError(
          resolution.outcome === 'no-dispatchable-model'
            ? resolution.missing
            : 'unknown',
        );
      }
      return selection;
    },
  };
}

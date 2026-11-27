import {
  AI_GATEWAY_MODELS,
  getExecutionHarnessForModel,
  getProviderForModel,
  isAgentModel,
  type AgentProviderType,
  type ChatModel,
} from '@canopy/desktop-shared/types';
import {
  isOrgGatewayRouteUsableByOwner,
  listPersonalGatewayDefaultModels,
  pickPersonalGatewayHelperModel,
} from '@canopy/desktop-shared/lib/org-model-gateway';
import { personalGatewayEquivalentModel } from '@canopy/desktop-shared/lib/default-model-lane';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  isGatewayOnlyModel,
  resolveGatewayModelEntry,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { accountProxySettingsSignature } from '../account-proxy/service';
import {
  getCurrentModelGatewayIndex,
  getCurrentModelGatewayRequirementForOwner,
} from '../lib/model-gateway-state';
// NOTE: `../auth/provider-auth-state` statically imports the session manager,
// which imports this module. The same cycle already exists through
// `./ai-credits-routing`; only function declarations are read across it.
import {
  isProviderNativelyAuthenticatedForRouting,
  peekProviderNativeAuthAvailability,
} from '../auth/provider-auth-state';
import {
  getAiCreditsRoutingContextWithStatus,
  hasUserSuppliedProviderCredential,
  resolveAiCreditsRoutingActivation,
  signedOutRoutesToAiCredits,
} from './ai-credits-routing';
import {
  billedProviderFor,
  effectiveTabAiCreditsRouting,
} from './effective-ai-credits-routing';
import type { AgentSessionOptions } from './types';

/**
 * Cache-only outcome of a confirmed native sign-out for a provider with no
 * other routing decision (CAN-7062): `'routes'` in any routing mode except
 * `off`, `'no-billing-source'` in `off`, and `'native'` when the provider is
 * signed in, or its auth cache is cold or probe-failed, or the mode was never
 * loaded. Shared by the session routing signature and
 * {@link isNoBillingSourceRefusalCached} so the two can't drift.
 */
export function peekSignedOutBillingRoute(
  providerType: 'claude' | 'codex',
): 'native' | 'routes' | 'no-billing-source' {
  if (peekProviderNativeAuthAvailability()[providerType] !== false) {
    return 'native';
  }
  const routes = signedOutRoutesToAiCredits();
  if (routes === null) return 'native';
  return routes ? 'routes' : 'no-billing-source';
}

/**
 * Whether provider work for these options is known, from caches alone, to be
 * refused for `no_billing_source` (CAN-7062): the provider is confirmed signed
 * out, AI Credits routing is `off`, and the work made no credits or
 * subscription choice. The session refuses such a turn; helpers throw
 * `HelperNoBillingSourceError`. Send paths use it to skip scheduling chat
 * naming and branch naming for a send that will be refused, without delaying
 * those helpers for everyone else, and periodic helpers use it to skip a run
 * before opening an audit entry.
 *
 * Mirrors the session routing signature's early exits (a gateway-only or
 * organization gateway model, an explicit subscription choice, active
 * per-chat routing, a mode activation) and the session's treatment of the
 * account proxy and of an Environment credential, which the auth probe can't
 * see but the spawn uses. It also stays `false` while an organization
 * enforces its gateway, because a helper's model may then be replaced by a
 * gateway model that routes. A cold cache or an unknown mode returns `false`;
 * `resolveHelperInvocation` still refuses such a helper before any spawn.
 *
 * The auth and mode caches are read first, so a signed-in provider answers
 * without touching the other routing state.
 */
export function isNoBillingSourceRefusalCached(
  opts: Pick<
    AgentSessionOptions,
    'model' | 'aiCreditsRouting' | 'subscriptionBillingOverride'
  > & {
    /** Workspace whose Environment credential applies; omitted reads global. */
    projectId?: string;
  },
  providerType: AgentProviderType,
): boolean {
  if (providerType !== 'claude' && providerType !== 'codex') return false;
  if (peekSignedOutBillingRoute(providerType) !== 'no-billing-source') {
    return false;
  }
  // A gateway-only model has no native path, and an organization gateway
  // model may be an enforced route; both route instead of refusing.
  if (
    isGatewayOnlyModel(opts.model) ||
    resolveGatewayModelEntry(opts.model)?.origin === 'org-gateway'
  ) {
    return false;
  }
  // An organization that enforces its gateway can have a helper's model
  // replaced by one of its gateway models, which routes instead of refusing
  // (`resolveHelperModelForEnforcedGateway`). The caches don't know which
  // owner the work runs for, so any enforced or blocked requirement means
  // don't predict.
  if (
    getCurrentModelGatewayRequirementForOwner(undefined).kind !==
      'unrestricted' ||
    getCurrentModelGatewayRequirementForOwner({ kind: 'personal' }).kind !==
      'unrestricted'
  ) {
    return false;
  }
  if (opts.subscriptionBillingOverride) return false;
  const aiCreditsRouting = effectiveTabAiCreditsRouting(
    opts.aiCreditsRouting,
    billedProviderFor(providerType),
  );
  if (aiCreditsRouting?.active) return false;
  if (resolveAiCreditsRoutingActivation(aiCreditsRouting, providerType)) {
    return false;
  }
  // The session asks the account proxy before AI Credits routing, so a
  // configured proxy may carry the turn: don't predict a refusal.
  if (accountProxySettingsSignature(providerType) !== '') return false;
  return !hasUserSuppliedProviderCredential(providerType, opts.projectId);
}

/**
 * The built-in provider `model` needs when nothing else can carry it: its
 * sign-in is confirmed missing and no account proxy or user-supplied
 * credential stands in. `undefined` for a gateway route, a non-Claude/Codex
 * model, or any unknown.
 */
function signedOutBuiltInProvider(
  model: ChatModel,
  projectId: string | undefined,
): 'claude' | 'codex' | undefined {
  if (
    isGatewayOnlyModel(model) ||
    resolveGatewayModelEntry(model)?.origin === 'org-gateway'
  ) {
    return undefined;
  }
  const provider = getProviderForModel(model);
  if (provider !== 'claude' && provider !== 'codex') return undefined;
  return providerSignedOut(provider, projectId) ? provider : undefined;
}

/**
 * The provider's sign-in is confirmed missing and no account proxy or
 * user-supplied credential stands in for it.
 */
function providerSignedOut(
  provider: 'claude' | 'codex',
  projectId: string | undefined,
): boolean {
  return (
    peekProviderNativeAuthAvailability()[provider] === false &&
    accountProxySettingsSignature(provider) === '' &&
    !hasUserSuppliedProviderCredential(provider, projectId)
  );
}

/**
 * The Personal gateway's models `owner`'s work may run on, in default order.
 * Empty under an enforced or unavailable gateway requirement (left to
 * `resolveHelperModelForEnforcedGateway`); organization work can't use
 * Personal models.
 */
function personalGatewayCandidates(
  owner: WorkOwner | undefined,
): readonly ChatModel[] {
  if (
    getCurrentModelGatewayRequirementForOwner(owner).kind !== 'unrestricted'
  ) {
    return [];
  }
  const index = getCurrentModelGatewayIndex();
  return listPersonalGatewayDefaultModels(index, AI_GATEWAY_MODELS).filter(
    (candidate) =>
      isOrgGatewayRouteUsableByOwner(
        candidate,
        owner,
        index.personalOrganizationId,
      ),
  );
}

/**
 * Whether a Personal gateway has any model this computer can run, before any
 * owner is resolved. Synchronous and cheap, so send paths can skip the swap
 * (and its owner, auth and credits reads) for everyone without one.
 */
export function hasPersonalGatewayModels(): boolean {
  return (
    listPersonalGatewayDefaultModels(
      getCurrentModelGatewayIndex(),
      AI_GATEWAY_MODELS,
    ).length > 0
  );
}

/** The Personal gateway model a helper runs on in place of `model`. */
function personalGatewayHelperModel(
  model: ChatModel,
  owner: WorkOwner | undefined,
): ChatModel | undefined {
  return pickPersonalGatewayHelperModel(
    model,
    personalGatewayCandidates(owner),
  );
}

/**
 * The Personal gateway model that runs in place of `model` when `model` has no
 * way to pay: its Claude or Codex sign-in is confirmed missing (probed first
 * when `probe` is set) and AI Credits can't pay. Confirmed spendable credits,
 * in a routing mode that uses them, keep `model`. A failed or unknown credits
 * read swaps only when both sign-ins are missing, as `personalGatewayStandsIn`
 * treats it.
 *
 * `'same-model'` returns only the gateway's copy of `model`: a chat's or
 * automation's explicit pick never silently becomes another model.
 * `'closest'` is for background helpers; see `pickPersonalGatewayHelperModel`.
 */
export async function resolvePersonalGatewayRoute(
  model: ChatModel,
  input: {
    owner: WorkOwner | undefined;
    projectId?: string;
    match: 'same-model' | 'closest';
    probe?: boolean;
  },
): Promise<ChatModel | undefined> {
  // Cheap and synchronous first: a model already on a gateway route needs no
  // swap, and most accounts have no Personal gateway, so neither pays for the
  // probe or the credits read below.
  if (
    isGatewayOnlyModel(model) ||
    resolveGatewayModelEntry(model)?.origin === 'org-gateway'
  ) {
    return undefined;
  }
  const candidates = personalGatewayCandidates(input.owner);
  if (candidates.length === 0) return undefined;
  if (input.probe) {
    const provider = getProviderForModel(model);
    if (provider === 'claude' || provider === 'codex') {
      await isProviderNativelyAuthenticatedForRouting(
        provider,
        'personal-gateway-route',
      );
    }
  }
  if (!signedOutBuiltInProvider(model, input.projectId)) return undefined;
  if (signedOutRoutesToAiCredits() !== false) {
    const credits = await getAiCreditsRoutingContextWithStatus({
      owner: input.owner,
    });
    const context = credits.context;
    if (context?.creditsEligibilityKnown === true && context.creditsEligible) {
      return undefined;
    }
    // An unknown or failed credits read moves work to the gateway only when
    // Claude and Codex are both signed out, the shared stand-in rule
    // (`personalGatewayStandsIn`): a funded credits user whose read blipped
    // is never moved onto their own key on a guess.
    const creditsConfirmedUnavailable =
      context === null
        ? !credits.degraded
        : context.creditsEligibilityKnown && !context.creditsEligible;
    if (
      !creditsConfirmedUnavailable &&
      !(
        providerSignedOut('claude', input.projectId) &&
        providerSignedOut('codex', input.projectId)
      )
    ) {
      return undefined;
    }
  }
  return input.match === 'same-model'
    ? // Persisted on the tab, so never a context-window variant: a `[1m]`
      // chat must not quietly move to a smaller window.
      personalGatewayEquivalentModel(
        model,
        { models: candidates },
        { allowVariantFallback: false },
      )
    : pickPersonalGatewayHelperModel(model, candidates);
}

/**
 * The send-time swap shared by the worktree and standalone send services: the
 * fields to replace on the request when a built-in model this account can't
 * pay for runs as the same model on the user's Personal gateway, or
 * `undefined` to send unchanged. Callers apply it before their policy and
 * billing gates, so those judge the model that runs, and the tab is stamped
 * with it.
 */
export async function resolvePersonalGatewaySendRoute(
  model: ChatModel | undefined,
  input: { owner: () => Promise<WorkOwner | undefined>; projectId: string },
): Promise<
  | {
      model: ChatModel;
      providerType: AgentProviderType | undefined;
      executionHarness: ReturnType<typeof getExecutionHarnessForModel>;
    }
  | undefined
> {
  if (!model || isAgentModel(model) || !hasPersonalGatewayModels()) {
    return undefined;
  }
  const gatewayModel = await resolvePersonalGatewayRoute(model, {
    owner: await input.owner(),
    projectId: input.projectId,
    match: 'same-model',
    probe: true,
  });
  if (!gatewayModel || gatewayModel === model) return undefined;
  return {
    model: gatewayModel,
    providerType: getProviderForModel(gatewayModel),
    executionHarness: getExecutionHarnessForModel(gatewayModel),
  };
}

/**
 * A background helper whose model's provider is signed out, and which AI
 * Credits can't pay for, runs on the user's own Personal AI gateway instead:
 * the same model there when it has one, otherwise the closest (see
 * `pickPersonalGatewayHelperModel`). A gateway-only user's chat titles,
 * summaries and the rest then work without a subscription or credits.
 */
export async function resolveHelperModelForPersonalGateway(
  model: ChatModel | undefined,
  owner: WorkOwner | undefined,
  projectId?: string,
): Promise<ChatModel | undefined> {
  if (!model) return model;
  return (
    (await resolvePersonalGatewayRoute(model, {
      owner,
      ...(projectId !== undefined ? { projectId } : {}),
      match: 'closest',
    })) ?? model
  );
}

/**
 * {@link isNoBillingSourceRefusalCached} for a background helper, which
 * `resolveHelperModelForPersonalGateway` moves onto the Personal gateway
 * instead of refusing. Owner-free like the caches it reads: a gateway that
 * could take the helper means don't predict a refusal.
 */
export function isHelperNoBillingSourceRefusalCached(
  opts: Parameters<typeof isNoBillingSourceRefusalCached>[0],
  providerType: AgentProviderType,
): boolean {
  if (!isNoBillingSourceRefusalCached(opts, providerType)) return false;
  return !(
    opts.model !== undefined &&
    signedOutBuiltInProvider(opts.model, opts.projectId) !== undefined &&
    // With no owner, an enforcing organization empties the candidates;
    // Personal work can still use the Personal gateway, so ask for it too.
    (personalGatewayHelperModel(opts.model, undefined) ??
      personalGatewayHelperModel(opts.model, { kind: 'personal' })) !==
      undefined
  );
}

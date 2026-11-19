import type { AgentProviderType } from '@canopy/desktop-shared/types';
import {
  isGatewayOnlyModel,
  resolveGatewayModelEntry,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { accountProxySettingsSignature } from '../account-proxy/service';
import { getCurrentModelGatewayRequirementForOwner } from '../lib/model-gateway-state';
// NOTE: `../auth/provider-auth-state` statically imports the session manager,
// which imports this module. The same cycle already exists through
// `./ai-credits-routing`; only function declarations are read across it.
import { peekProviderNativeAuthAvailability } from '../auth/provider-auth-state';
import {
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

import { PROVIDER_ROW_DESCRIPTIONS as SHARED_PROVIDER_ROW_DESCRIPTIONS } from '@canopy/ui-shared/components';

/**
 * Copy for the agent connections on the first-run "Let's get started" page
 * and the web first-visit card: the intro above the provider rows, and each
 * provider row's signed-out description. The host passes its brand's app
 * name. `sources` names what the host's rows connect: subscriptions
 * (desktop, the default) or API keys and a gateway (the web card).
 */
export function agentConnectionsIntro({
  appName,
  sources = 'subscriptions',
}: {
  readonly appName: string;
  readonly sources?: 'subscriptions' | 'api-keys';
}): string {
  return sources === 'api-keys'
    ? `Use your own API key, AI gateway, or ${appName} account.`
    : `Bring your own subscription or use your ${appName} account.`;
}

/**
 * A signed-out provider row's description. It says what connecting gets the
 * user, since the row's status dot already shows that it is not connected.
 * The provider-choice list shares the same words.
 */
export const PROVIDER_ROW_DESCRIPTIONS = SHARED_PROVIDER_ROW_DESCRIPTIONS;

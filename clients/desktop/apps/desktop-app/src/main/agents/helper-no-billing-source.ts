import { getModelCatalogProviderLabel } from '@canopy/protocol/models';

/** Providers whose helper calls can hit a `no-billing-source` decision. */
export type HelperNoBillingSourceProvider = 'claude' | 'codex';

/**
 * The user-readable reason a helper was not started because its provider is
 * confirmed signed out, AI Credits routing is `off`, and nothing chose credits
 * for the work (CAN-7062).
 *
 * It names the same way out as the composer's No billing source banner
 * (`NO_PROVIDER_COPY` in `@canopy/ui-shared/components`): use another
 * provider. It does not offer credits, because a guest can't buy them and
 * some users can't turn routing on. It does not reuse the banner's "This chat
 * needs a provider", because a commit message or a scheduled summary is not
 * a chat.
 */
export function helperNoBillingSourceMessage(
  provider: HelperNoBillingSourceProvider,
): string {
  const providerLabel = getModelCatalogProviderLabel(provider);
  return `You're signed out of ${providerLabel}. Reconnect it, or choose another provider.`;
}

/**
 * Thrown by `resolveAiCreditsRoutingOverride` (and so by
 * `resolveHelperInvocation`) before any spawn when a helper would only fail on
 * sign-in: the provider is confirmed signed out, routing mode is `off`, the
 * work made no credits choice, and no Environment credential would let the
 * spawn work.
 *
 * Background callers treat it as a skip (the work item stays eligible, and an
 * open audit entry is finalized as `cancelled`); user-started helpers show
 * {@link Error.message}. The check runs on every call and is never cached, so
 * signing in or turning on AI Credits restores helpers on the next attempt.
 */
export class HelperNoBillingSourceError extends Error {
  readonly provider: HelperNoBillingSourceProvider;

  constructor(provider: HelperNoBillingSourceProvider) {
    super(helperNoBillingSourceMessage(provider));
    this.name = 'HelperNoBillingSourceError';
    this.provider = provider;
  }
}

export function isHelperNoBillingSourceError(
  error: unknown,
): error is HelperNoBillingSourceError {
  return error instanceof HelperNoBillingSourceError;
}

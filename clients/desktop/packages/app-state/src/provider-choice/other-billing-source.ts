import type { AnyProviderSourceFacts, ProviderChoiceModel } from './types';

/**
 * Whether a source other than AI Credits can bill a turn right now: the host
 * supports it, nothing blocks it, and it is connected (`ready`: not limited,
 * signed out or still being checked). A source still being checked counts as
 * not ready, so a surface that hides credits behind this never hides it and
 * then brings it back. Model fit is not read: the answer is about the
 * account, not one chat's model.
 */
export function isOtherBillingSourceReady<
  TModel extends ProviderChoiceModel = ProviderChoiceModel,
>(sources: readonly AnyProviderSourceFacts<TModel>[]): boolean {
  return sources.some(
    (facts) =>
      facts.source !== 'credits' &&
      facts.unsupported === undefined &&
      facts.blockedReason === undefined &&
      facts.connection.kind === 'ready',
  );
}

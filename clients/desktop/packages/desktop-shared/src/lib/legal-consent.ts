import type { PreferencesData } from '../types';

/**
 * Whether the first-run legal consent is recorded: a non-empty
 * `legalConsentAcceptedAt` after trim. Normalization keeps the field under
 * the same rule, so this agrees with the renderer's Welcome gate check on any
 * normalized preferences. Until it holds, main treats every usage-data flow
 * as consent-pending.
 */
export function hasAcceptedLegalConsent(
  preferences: Pick<PreferencesData, 'legalConsentAcceptedAt'>,
): boolean {
  const acceptedAt = preferences.legalConsentAcceptedAt;
  return typeof acceptedAt === 'string' && acceptedAt.trim().length > 0;
}

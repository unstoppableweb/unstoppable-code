import type { PreferencesData } from '../../types';
import {
  normalizeDomainPreferences,
  type ModelSelectionValidation,
} from '@canopy/core-runtime/node/preferences/domain';
import { normalizeClientLocalPreferences } from './client-local-preferences';

/** Compatibility path: the domain normalizers live in `@canopy/core-runtime/node/preferences/domain`. */
export {
  normalizeOrgSharingNoticesSeen,
  normalizeDomainPreferences,
} from '@canopy/core-runtime/node/preferences/domain';

// Stays here: it composes the client-local normalizer, which desktop-shared owns (CAN-4472).
/** The whole preferences value: the domain document plus the client-local one. */
export function normalizePreferences(
  data: Partial<PreferencesData> | Record<string, unknown> | undefined,
  modelSelectionValidation: ModelSelectionValidation = 'runtime',
): PreferencesData {
  return {
    ...normalizeDomainPreferences(data, modelSelectionValidation),
    ...normalizeClientLocalPreferences(data),
  };
}

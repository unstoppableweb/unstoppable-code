import type { PreferencesData } from '@canopy/protocol/preferences';
import {
  CLIENT_LOCAL_PREFERENCE_KEYS,
  type ClientLocalPreferenceKey,
} from './client-local-keys';
import { pickStoredKeys, type WithStoredKeys } from './preserve-stored-keys';

const CHECKED_CLIENT_LOCAL_KEYS =
  CLIENT_LOCAL_PREFERENCE_KEYS satisfies readonly (keyof PreferencesData)[];

/** Window geometry, appearance and pure view state: this client's own document (CAN-4472). */
export type ClientLocalPreferences = Pick<
  PreferencesData,
  ClientLocalPreferenceKey
>;

/** Everything but the client-local keys: the domain preferences document. */
export type DomainPreferencesData = Omit<
  PreferencesData,
  ClientLocalPreferenceKey
>;
/** The domain document as stored, with its frozen copy of client-local keys. */
export type StoredDomainPreferences = WithStoredKeys<
  DomainPreferencesData,
  ClientLocalPreferenceKey
>;

/** The client-local values a stored domain document still holds, as stored. */
export function storedClientLocalValues(
  domain: StoredDomainPreferences,
): Record<string, unknown> {
  return pickStoredKeys(domain, CHECKED_CLIENT_LOCAL_KEYS);
}

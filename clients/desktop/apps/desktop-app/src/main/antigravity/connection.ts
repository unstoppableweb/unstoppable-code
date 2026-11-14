import { isAntigravityHarnessEnabled } from './feature-flag';
import { readPreferencesFileDetailed } from '../lib/preferences-store';

/** App-local consent only. Google's credential store is never changed here. */
export async function isAntigravityConnectionEnabled(): Promise<boolean> {
  if (!isAntigravityHarnessEnabled()) return false;
  const { authority, preferences } = await readPreferencesFileDetailed();
  return (
    isAntigravityHarnessEnabled() &&
    authority !== 'unreadable' &&
    preferences.googleSubscriptionDisconnected !== true
  );
}

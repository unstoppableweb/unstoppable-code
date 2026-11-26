/**
 * Production selection (CAN-6997). Mike accepted the split design in q-43;
 * Keep off until managed macOS/Linux survival qualifies and generation fences
 * become required for provision/disconnect (including version-skewed clients).
 */
export const CLOUD_ACCOUNT_AUTHORITY_ACTIVATION_SELECTED: boolean = false;

/** E2E qualification never selects production or a runtime writer reclaim. */
declare const __CANOPY_E2E__: boolean | undefined;

export const CLOUD_ACCOUNT_AUTHORITY_COMPOSITION_SELECTED: boolean =
  CLOUD_ACCOUNT_AUTHORITY_ACTIVATION_SELECTED ||
  (typeof __CANOPY_E2E__ !== 'undefined' &&
    __CANOPY_E2E__ &&
    process.env.CANOPY_E2E_DAEMON_CLOUD_ACCOUNT === '1');

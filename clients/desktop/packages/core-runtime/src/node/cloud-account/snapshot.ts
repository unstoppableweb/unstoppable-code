import {
  CANOPY_ACCOUNT_REFRESH_REPLACED_FIELDS,
  canopyAccountRefreshFields,
  parseCanopyAccountSnapshot,
} from '@canopy/protocol/canopy-server/account-snapshot';
import type { CloudAccountSnapshotBuilder } from './refresh';
import {
  cloudAccountIdOf,
  cloudModelPolicySnapshotUnavailable,
} from './record';

/**
 * The daemon's refresh entry, built with the same normalizers and
 * replace-not-merge rules as the desktop store's re-probe (CAN-6997). Unknown
 * stored fields survive. A response without an account custody can identify
 * builds nothing, so the refresher withdraws verification and keeps the held
 * account instead of replacing it.
 *
 * The app's organization snapshot transition (purging replicas of removed
 * organizations) is app-local and is not run here. Client and daemon records
 * are independent: only the client's own refresh drives its replica cleanup.
 * A daemon loss checkpoint does not propagate back to a client.
 */
export const buildCloudAccountSnapshot: CloudAccountSnapshotBuilder = ({
  current,
  capabilities,
  payload,
  updatedAt,
}) => {
  const account: unknown =
    typeof payload === 'object' && payload !== null
      ? Reflect.get(payload, 'account')
      : undefined;
  if (!cloudAccountIdOf(account)) return null;
  const snapshot = parseCanopyAccountSnapshot(payload, capabilities);
  const base: Record<string, unknown> = { ...current.entry };
  for (const field of CANOPY_ACCOUNT_REFRESH_REPLACED_FIELDS)
    delete base[field];
  // Read from the raw payload: the tolerant normalizer drops malformed rows.
  const modelPolicyEnforcementUnavailable = cloudModelPolicySnapshotUnavailable(
    Reflect.get(Object(payload), 'enforcedSettings'),
  );
  return {
    entry: {
      ...base,
      ...canopyAccountRefreshFields(snapshot),
      // Set here, as key sign-in does, so the shared refresh fields and the
      // desktop record stay unchanged until desktop provisioning lands.
      organizationsVerified: snapshot.organizationsRefreshed,
      modelPolicyVerified: !modelPolicyEnforcementUnavailable,
      modelPolicyEnforcementUnavailable,
      account,
      updatedAt,
    },
    organizationsRefreshed: snapshot.organizationsRefreshed,
    billingStatesRefreshed: snapshot.orgBillingStates !== undefined,
  };
};

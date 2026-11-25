import { useEffect, useState } from 'react';
import type { AiGatewayDeviceKeyStatus } from '@canopy/ui-app/settings/host';
import {
  MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT,
  subscribeToConnectionChange,
} from '@/lib/integrationConnectionEvents';
import { useCanopyCloudAccountState } from './useCanopyCloudAccountState';

/**
 * This computer's key for an organization's AI gateway at `baseUrl`, read
 * again whenever a key changes. `loading` while there is no gateway to read.
 */
export function useGatewayKeyStatus(
  organizationId: string | null,
  baseUrl: string | null,
  revision = 0,
): AiGatewayDeviceKeyStatus {
  const [status, setStatus] = useState<AiGatewayDeviceKeyStatus>('loading');
  const [changes, setChanges] = useState(0);
  // A routing change, such as "Use only my AI gateway", can clear this
  // computer's opt-out without touching a key.
  const { account } = useCanopyCloudAccountState();
  useEffect(() => {
    if (organizationId === null) return undefined;
    const bump = (): void => setChanges((count) => count + 1);
    const unsubscribe = subscribeToConnectionChange(
      MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT,
      bump,
    );
    const unsubscribeMain =
      window.api.onModelGatewayCredentialChanged?.((changed) => {
        if (changed === organizationId) bump();
      }) ?? ((): void => undefined);
    const unsubscribeDeviceUse =
      window.api.modelGatewayDeviceUse.onChanged(bump);
    return (): void => {
      unsubscribe();
      unsubscribeMain();
      unsubscribeDeviceUse();
    };
  }, [organizationId]);
  useEffect(() => {
    if (organizationId === null || baseUrl === null) {
      setStatus('loading');
      return undefined;
    }
    let cancelled = false;
    void window.api.loadModelGatewayCredential(organizationId, baseUrl).then(
      (stored) => {
        if (cancelled) return;
        setStatus(
          stored.secureStorageFailure || !stored.storageAvailable
            ? 'unavailable'
            : stored.notUsedOnThisComputer
              ? 'not-used'
              : stored.apiKey.trim()
                ? stored.lastError
                  ? 'rejected'
                  : 'saved'
                : stored.keyForOtherUrl
                  ? 'old-url'
                  : 'missing',
        );
      },
      () => {
        if (!cancelled) setStatus('unavailable');
      },
    );
    return (): void => {
      cancelled = true;
    };
  }, [organizationId, baseUrl, revision, changes, account]);
  return status;
}

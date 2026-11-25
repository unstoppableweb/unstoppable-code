import { useMemo } from 'react';
import type { AiGatewayDeviceUse } from '@canopy/ui-app/settings/host';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import { useCanopyCloudAccountState } from '@/hooks/useCanopyCloudAccountState';
import { useModelGatewayDeviceOptOuts } from '@/hooks/useModelGatewayDeviceOptOuts';

/**
 * "Use on this computer" for the signed-in account's Personal gateway. The
 * device gateway used while signed out is this computer's alone, so it has
 * no such choice.
 */
export function useDesktopAiGatewayDeviceUse(
  organizationId: string,
): AiGatewayDeviceUse | null {
  const { account } = useCanopyCloudAccountState();
  const optOuts = useModelGatewayDeviceOptOuts();
  const id = normalizeUuid(organizationId);
  const personal =
    id !== null && normalizeUuid(account?.personalOrganizationId) === id;
  return useMemo(
    () =>
      personal && id !== null
        ? {
            used: optOuts === null ? null : !optOuts.has(id),
            setUsed: (used) =>
              window.api.modelGatewayDeviceUse.set({
                organizationId: id,
                used,
              }),
          }
        : null,
    [personal, id, optOuts],
  );
}

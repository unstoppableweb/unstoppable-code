import type {
  AiGatewayDeviceKeyInput,
  AiGatewayDeviceKeyStatus,
} from '@canopy/ui-app/settings/host';
import { useGatewayKeyStatus } from '@/hooks/useGatewayKeyStatus';

/** The settings host port: this computer's key for an AI gateway. */
export function useDesktopAiGatewayDeviceKey({
  organizationId,
  baseUrl,
  revision,
}: AiGatewayDeviceKeyInput): AiGatewayDeviceKeyStatus {
  return useGatewayKeyStatus(organizationId, baseUrl, revision);
}

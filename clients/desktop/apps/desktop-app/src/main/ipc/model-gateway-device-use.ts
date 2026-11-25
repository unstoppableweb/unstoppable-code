import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import {
  readModelGatewayDeviceOptOuts,
  setModelGatewayUsedOnThisComputer,
} from '../lib/model-gateway-device-use';
import { refreshLocalModelGatewayPolicy } from '../services/org-enforced-settings';
import { registerIpcHandler } from './register';

function parseSetInput(
  input: unknown,
): { organizationId: string; used: boolean } | null {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('organizationId' in input) ||
    !('used' in input) ||
    typeof input.used !== 'boolean'
  )
    return null;
  const organizationId = normalizeUuid(input.organizationId);
  return organizationId ? { organizationId, used: input.used } : null;
}

/** "Use on this computer" for the Personal AI gateway (CAN-7644). */
export function registerModelGatewayDeviceUseHandlers(): void {
  registerIpcHandler(
    IPC_CHANNELS.modelGatewayDeviceUseRead,
    async (): Promise<string[]> => [...(await readModelGatewayDeviceOptOuts())],
  );

  registerIpcHandler(
    IPC_CHANNELS.modelGatewayDeviceUseSet,
    async (_event, input: unknown): Promise<void> => {
      const parsed = parseSetInput(input);
      if (!parsed) throw new Error('Invalid AI gateway choice');
      if (
        await setModelGatewayUsedOnThisComputer(
          parsed.organizationId,
          parsed.used,
        )
      )
        await refreshLocalModelGatewayPolicy();
    },
  );
}

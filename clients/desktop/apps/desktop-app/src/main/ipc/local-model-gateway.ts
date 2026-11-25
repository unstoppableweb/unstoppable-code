import { z } from 'zod';
import {
  IPC_CHANNELS,
  type LocalModelGatewayMigrationChoice,
  type LocalModelGatewayResult,
  type LocalModelGatewayState,
} from '@canopy/desktop-shared/types';
import type { PersonalAiGatewayConfig } from '@canopy/protocol/model-gateway';
import type { AiGatewayConnectionResult } from '@canopy/protocol/model-gateway/discovery';
import {
  SettingsOperationError,
  type SettingsErrorPayload,
} from '@canopy/protocol/settings';
import {
  getLocalModelGatewayOrganizationId,
  LocalModelGatewayError,
  readLocalModelGateway,
  updateLocalModelGateway,
} from '../lib/local-model-gateway-store';
import {
  connectDeviceGateway,
  requireDeviceAiGatewaySettings,
  requireDeviceGatewayScope,
} from '../services/ai-gateway-settings';
import {
  chooseLocalModelGatewayMigration,
  readLocalModelGatewayMigrationChoice,
} from '../services/local-model-gateway-migration';
import { sendToAllWindows } from '../lib/window-send';
import { registerIpcHandler } from './register';

/** Same shapes as the hosted settings failures, so shared copy applies. */
function errorPayload(error: unknown): SettingsErrorPayload {
  if (error instanceof SettingsOperationError) return error.toPayload();
  if (error instanceof LocalModelGatewayError)
    return error.code === 'invalid'
      ? { code: 'failed', status: 400 }
      : { code: 'failed', status: 409, serverCode: error.code };
  return { code: 'failed' };
}

async function settle<T>(
  operation: () => Promise<T>,
): Promise<LocalModelGatewayResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: errorPayload(error) };
  }
}

export function registerLocalModelGatewayHandlers(): void {
  registerIpcHandler(
    IPC_CHANNELS.localModelGatewayRead,
    async (): Promise<LocalModelGatewayState> => ({
      organizationId: await getLocalModelGatewayOrganizationId(),
      gateway: await readLocalModelGateway(),
    }),
  );

  registerIpcHandler(
    IPC_CHANNELS.localModelGatewayUpdate,
    async (
      _event,
      input: unknown,
    ): Promise<LocalModelGatewayResult<PersonalAiGatewayConfig>> =>
      settle(async () => {
        await requireDeviceAiGatewaySettings();
        await requireDeviceGatewayScope();
        const gateway = await updateLocalModelGateway(input);
        // A removal deleted the device key: key rows and banners re-read.
        if (gateway.baseUrl === null)
          sendToAllWindows(
            IPC_CHANNELS.modelGatewayCredentialChanged,
            gateway.organizationId,
          );
        return gateway;
      }),
  );

  registerIpcHandler(
    IPC_CHANNELS.localModelGatewayConnect,
    async (
      _event,
      input: unknown,
    ): Promise<LocalModelGatewayResult<AiGatewayConnectionResult>> =>
      settle(() => connectDeviceGateway(input)),
  );

  registerIpcHandler(
    IPC_CHANNELS.localModelGatewayMigrationChoiceRead,
    (): Promise<
      LocalModelGatewayResult<LocalModelGatewayMigrationChoice | null>
    > => settle(readLocalModelGatewayMigrationChoice),
  );

  registerIpcHandler(
    IPC_CHANNELS.localModelGatewayMigrationChoose,
    (
      _event,
      decision: unknown,
      accountRevision: unknown,
    ): Promise<LocalModelGatewayResult<null>> =>
      settle(async () => {
        const parsed = z
          .tuple([z.enum(['device', 'account']), z.string().min(1).max(128)])
          .safeParse([decision, accountRevision]);
        if (!parsed.success)
          throw new SettingsOperationError({ code: 'failed', status: 400 });
        await chooseLocalModelGatewayMigration(...parsed.data);
        return null;
      }),
  );
}

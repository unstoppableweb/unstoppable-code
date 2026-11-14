import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import {
  SettingsOperationError,
  validateSettingsOperationInput,
  validateSettingsOperationResult,
  type SettingsOperationName,
  type SettingsReadMap,
  type SettingsReadName,
  type SettingsWriteMap,
  type SettingsWriteName,
} from '@canopy/protocol/settings';
import { z } from 'zod';
import {
  aiGatewayConnectSchema,
  personalAiGatewayUpdateSchema,
} from '@canopy/protocol/model-gateway';
import type { LocalModelGatewayResult } from '@canopy/desktop-shared/types';

const deviceConnectSchema = aiGatewayConnectSchema.extend({
  expectedOrganizationId: z.uuid(),
});

/**
 * The device AI gateway behind the settings client contract, so the shared
 * gateway editor and setup run unchanged while the account names no Personal
 * organization. Only the Personal gateway operations answer. Cloud chat keys
 * answer 404, the documented "cloud keys off" signal, so that section stays
 * hidden. Everything else is unauthenticated, as it is signed out.
 */
export function createDeviceAiGatewaySettingsClient(): AccountOrganizationSettingsClient {
  const api = window.api.localModelGateway;

  async function settle<T>(
    result: Promise<LocalModelGatewayResult<T>>,
  ): Promise<T> {
    let response: LocalModelGatewayResult<T>;
    try {
      response = await result;
    } catch {
      throw new SettingsOperationError({ code: 'failed' });
    }
    if (!response.ok) throw new SettingsOperationError(response.error);
    return response.value;
  }

  async function call(
    operation: SettingsOperationName,
    input: unknown,
  ): Promise<unknown> {
    if (!validateSettingsOperationInput(operation, input).ok)
      throw new SettingsOperationError({
        code: 'failed',
        message: 'Invalid input',
      });
    switch (operation) {
      case 'account.settings.ai-gateway.read':
        return { gateway: (await api.read()).gateway };
      case 'account.settings.ai-gateway.update': {
        const parsed = personalAiGatewayUpdateSchema.safeParse(input);
        if (!parsed.success)
          throw new SettingsOperationError({ code: 'failed' });
        return { gateway: await settle(api.update(parsed.data)) };
      }
      case 'account.settings.ai-gateway.connect': {
        const parsed = deviceConnectSchema.safeParse(input);
        if (!parsed.success)
          throw new SettingsOperationError({ code: 'failed' });
        return settle(api.connect(parsed.data));
      }
      case 'organization.settings.ai-gateway.cloud-key.read':
        throw new SettingsOperationError({ code: 'not_found', status: 404 });
      default:
        throw new SettingsOperationError({ code: 'unauthenticated' });
    }
  }

  return {
    async read<K extends SettingsReadName>(
      operation: K,
      input: SettingsReadMap[K]['input'],
    ): Promise<SettingsReadMap[K]['result']> {
      const result = await call(operation, input);
      if (!isReadResult(operation, result))
        throw new SettingsOperationError({ code: 'invalid_response' });
      return result;
    },
    async write<K extends SettingsWriteName>(
      operation: K,
      input: SettingsWriteMap[K]['input'],
    ): Promise<SettingsWriteMap[K]['result']> {
      const result = await call(operation, input);
      if (!isWriteResult(operation, result))
        throw new SettingsOperationError({ code: 'invalid_response' });
      return result;
    },
    subscribe(): () => void {
      // The device gateway has no hosted feed.
      return () => undefined;
    },
  };
}

function isReadResult<K extends SettingsReadName>(
  operation: K,
  value: unknown,
): value is SettingsReadMap[K]['result'] {
  return validateSettingsOperationResult(operation, value).ok;
}

function isWriteResult<K extends SettingsWriteName>(
  operation: K,
  value: unknown,
): value is SettingsWriteMap[K]['result'] {
  return validateSettingsOperationResult(operation, value).ok;
}

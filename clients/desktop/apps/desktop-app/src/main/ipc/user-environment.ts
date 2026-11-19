import {
  IPC_CHANNELS,
  type EnvironmentConfigView,
  type LoadEnvironmentConfigResponse,
  type SaveEnvironmentConfigResponse,
  type SaveEnvironmentConfigSuccessResponse,
} from '@canopy/desktop-shared/types';
import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';
import {
  EnvironmentConfigValidationError,
  readEnvironmentConfigView,
  writeEnvironmentConfig,
} from '../lib/user-environment-store';
import { isStoredSecretError } from '../lib/stored-secrets';
import {
  initializeUserEnvironmentRuntime,
  invalidateUserEnvironmentInjectionCache,
} from '../lib/user-environment-runtime';
import { destroySessionsByProvider } from '../agents/session-manager';
import {
  hasDelegationLifecycle,
  revokeDelegationLifecycle,
} from '../agents/delegation/lifecycle';
import { getOllamaService } from '../ollama';
import { getSecureStorageFailure } from '../lib/secure-storage-policy';
import { registerIpcHandler } from './register';
import { logMainProcessWarn } from '../lib/main-process-logging';

async function revokeDelegationsAfterEnvironmentChange(): Promise<void> {
  if (!hasDelegationLifecycle()) return;
  try {
    await revokeDelegationLifecycle();
  } catch (error) {
    logMainProcessWarn(
      '[user-environment] Delegation revocation failed; continuing environment refresh',
      error,
    );
  }
}

export function registerUserEnvironmentHandlers(): void {
  initializeUserEnvironmentRuntime();

  registerIpcHandler(
    IPC_CHANNELS.environmentConfigLoad,
    async (): Promise<LoadEnvironmentConfigResponse> => {
      try {
        return await readEnvironmentConfigView();
      } catch (error) {
        reportMainAppError(error, { source: 'environment_config.load' });
        const secureStorageFailure = getSecureStorageFailure(error);
        return {
          ok: false,
          error: "Couldn't read saved environment values.",
          ...(secureStorageFailure ? { secureStorageFailure } : {}),
        };
      }
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.environmentConfigSave,
    async (
      _event,
      data: EnvironmentConfigView,
    ): Promise<SaveEnvironmentConfigResponse> => {
      try {
        const result: SaveEnvironmentConfigSuccessResponse =
          await writeEnvironmentConfig(data);
        // The write is already durable. Refresh failures must not report that
        // this credential operation was discarded or invite a duplicate save.
        try {
          invalidateUserEnvironmentInjectionCache();
          await revokeDelegationsAfterEnvironmentChange();
          await destroySessionsByProvider('ollama');
          await getOllamaService().handleUserEnvironmentChanged();
        } catch (error) {
          logMainProcessWarn(
            '[user-environment] Saved config; runtime refresh failed',
            error,
          );
        }
        return result;
      } catch (error) {
        if (isStoredSecretError(error)) {
          return {
            ok: false,
            error: error.message,
            storedSecretError: error.code,
          };
        }
        // Stored-secret and validation failures are fixable input, not defects.
        if (!(error instanceof EnvironmentConfigValidationError)) {
          reportMainAppError(error, { source: 'environment_config.save' });
        }
        const secureStorageFailure = getSecureStorageFailure(error);
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(secureStorageFailure ? { secureStorageFailure } : {}),
        };
      }
    },
  );
}

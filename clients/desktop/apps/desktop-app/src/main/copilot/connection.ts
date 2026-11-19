import * as legacy from './legacy-connection';
import { readCopilotSelectionPreferences } from './selection-receipt';
import { assertCopilotHarnessEnabled } from './feature-flag';
import {
  createCopilotConnectionProxy,
  CopilotVaultUnavailableError,
  type CopilotConnectionBackend,
} from './connection-proxy';
export {
  COPILOT_INSTALL_TIMEOUT_MS,
  COPILOT_SETUP_TIMEOUT_MS,
} from './legacy-connection';
export type { ManagedCopilotRuntimeOptions } from './legacy-connection';

let vault: CopilotConnectionBackend | undefined;
/** Trusted P9 channel composition only. Presence never selects the vault path. */
export function bindCopilotVaultConnection(
  backend: CopilotConnectionBackend,
): void {
  if (vault) throw new Error('Copilot authority is already composed.');
  vault = backend;
}
const proxy = createCopilotConnectionProxy({
  legacy,
  selected: async () =>
    (await readCopilotSelectionPreferences()).copilotVaultSelection !==
    undefined,
  vault: () => {
    if (!vault) throw new CopilotVaultUnavailableError();
    return vault;
  },
  shutdownVault: () => vault?.shutdownCopilotRuntimes() ?? Promise.resolve(),
  assertEnabled: assertCopilotHarnessEnabled,
});
export const {
  copilotConnectionStatus,
  openManagedCopilotRuntime,
  connectCopilot,
  disconnectCopilot,
  readCopilotAccount,
  listCopilotModels,
  assertCopilotModelAvailable,
  readCopilotAccountUsage,
  getCopilotAccountGeneration,
  assertCopilotConnectionGeneration,
  revokeCopilotRuntimes,
  recoverCopilotAtStartup,
  shutdownCopilotRuntimes,
} = proxy;
export function resetCopilotShutdownForTests(): void {
  legacy.resetCopilotShutdownForTests();
  proxy.resetCopilotShutdownForTests();
}

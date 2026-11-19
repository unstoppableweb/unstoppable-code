import {
  COPILOT_VAULT_PENDING_IMPORT_PATHS as COPILOT_VAULT_IMPORT_PATHS,
  COPILOT_VAULT_IMPORT_CANCEL_PATHS,
} from './vault-connection';
import {
  CopilotVaultUnavailableError,
  createCopilotConnectionProxy,
  type CopilotConnectionBackend,
} from './connection-proxy';
import type { CopilotQualificationHandoff } from './qualification-handoff';

/** Qualification facade only; production connection.ts keeps its P6 selector. */
export function createCopilotQualificationConnection(options: {
  handoff: CopilotQualificationHandoff;
  legacy: CopilotConnectionBackend;
  vault: CopilotConnectionBackend;
  agreed(): boolean;
  closeAdmission(): void;
}): CopilotConnectionBackend {
  async function vaultSelected(): Promise<boolean> {
    const custody = await options.handoff.custody();
    if (custody === 'unused') return false;
    if (await options.handoff.ordinarySetup()) return true;
    const phase = await options.handoff.phase();
    if (
      COPILOT_VAULT_IMPORT_PATHS[phase].open !== 'vault' ||
      custody !== 'selected' ||
      !options.agreed()
    )
      throw new CopilotVaultUnavailableError();
    return true;
  }
  let vaultRouted = false;
  // The P6 proxy owns handle acquisition, generation fencing and pending-open cleanup.
  const routed = createCopilotConnectionProxy({
    legacy: options.legacy,
    selected: async () => {
      const selected = await vaultSelected();
      vaultRouted ||= selected;
      return vaultRouted;
    },
    vault: () => options.vault,
    shutdownVault: () => options.vault.shutdownCopilotRuntimes(),
    assertEnabled: () => {
      if (vaultRouted && !options.agreed())
        throw new CopilotVaultUnavailableError();
    },
  });
  async function participate<T>(
    work: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = (): void =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Connect caller aborted.'),
        );
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([work(), cancelled]);
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  }
  return {
    copilotConnectionStatus: routed.copilotConnectionStatus,
    openManagedCopilotRuntime: routed.openManagedCopilotRuntime,
    listCopilotModels: routed.listCopilotModels,
    readCopilotAccountUsage: routed.readCopilotAccountUsage,
    async connectCopilot(signal, progress, changeAccount = false) {
      signal.throwIfAborted();
      const custody = await options.handoff.custody();
      signal.throwIfAborted();
      if (custody === 'unused')
        return options.legacy.connectCopilot(signal, progress, changeAccount);
      if (await options.handoff.ordinarySetup()) {
        return options.vault.connectCopilot(
          signal,
          progress,
          changeAccount,
          async (): Promise<void> => {
            // Release only the exactly retired receipt before P4 prepares its successor.
            if (!(await options.handoff.ordinarySetup()))
              throw new CopilotVaultUnavailableError();
          },
        );
      }
      if (custody === 'selected' && options.agreed() && !changeAccount)
        return options.vault.connectCopilot(signal, progress, changeAccount);
      const phase = await options.handoff.phase();
      const entry = changeAccount ? 'change-account' : 'connect';
      const path = COPILOT_VAULT_IMPORT_PATHS[phase][entry];
      if (path === 'unavailable') throw new CopilotVaultUnavailableError();
      options.closeAdmission();
      try {
        await participate(
          () => options.handoff.connect(changeAccount || path === 'cancel'),
          signal,
        );
      } catch {
        signal.throwIfAborted();
        throw new CopilotVaultUnavailableError();
      }
      signal.throwIfAborted();
      if (await options.handoff.ordinarySetup())
        return options.vault.connectCopilot(signal, progress);
      if (!options.agreed()) throw new CopilotVaultUnavailableError();
      const status = await options.vault.copilotConnectionStatus();
      progress(status);
      return status;
    },
    async disconnectCopilot() {
      options.closeAdmission();
      const custody = await options.handoff.custody();
      if (custody === 'unused') return options.legacy.disconnectCopilot();
      if (await options.handoff.ordinarySetup())
        return options.vault.disconnectCopilot();
      const phase = await options.handoff.phase();
      if (COPILOT_VAULT_IMPORT_CANCEL_PATHS[phase].disconnect !== 'cancel')
        throw new CopilotVaultUnavailableError();
      await options.handoff.connect(true);
    },
    async recoverCopilotAtStartup() {
      // Startup may reap process receipts, never present grants or clean credentials.
      const custody = await options.handoff.custody();
      if (custody === 'unused') await options.legacy.recoverCopilotAtStartup();
      else await options.vault.recoverCopilotAtStartup();
    },
    async revokeCopilotRuntimes() {
      options.closeAdmission();
      const unusedVault = !vaultRouted;
      await Promise.all([
        routed.revokeCopilotRuntimes(),
        ...(unusedVault ? [options.vault.revokeCopilotRuntimes()] : []),
      ]);
    },
    async shutdownCopilotRuntimes() {
      options.closeAdmission();
      await Promise.all([
        options.handoff.close(),
        routed.shutdownCopilotRuntimes(),
      ]);
    },
  };
}

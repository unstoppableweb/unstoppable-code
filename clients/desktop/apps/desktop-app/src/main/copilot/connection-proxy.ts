import type { CopilotModelEntry } from '@canopy/execution-engine/types/copilot-models';
import type { CopilotRecipientHandle } from '@canopy/desktop-shared/node/copilot/recipient-handle';
import type {
  CopilotAccount,
  CopilotAccountUsage,
  CopilotConnectionStatus,
} from '@canopy/desktop-shared/types/copilot-connection';
import type { ManagedCopilotRuntimeOptions } from './legacy-connection';
import {
  COPILOT_VAULT_TURN_FIELDS,
  copilotVaultFieldsCovered,
  type CopilotVaultFieldCoverage,
} from '@canopy/desktop-shared/node/copilot/consumer-transport';
import { handleCopilotTurnCleanupError } from '@canopy/copilot-recipient/turn-cleanup';
import { invalidateCopilotRuntimeAvailability } from './runtime-availability';

export const COPILOT_VAULT_OPEN_FIELDS = {
  owner: { importAdmission: 'published', disposition: 'parity' },
  signal: {
    importAdmission: 'published',
    disposition: 'parity',
    renewalCases: ['slow-open'],
  },
  cwd: { importAdmission: 'published', disposition: 'parity' },
  workspaceId: { importAdmission: 'published', disposition: 'parity' },
  executionKind: { importAdmission: 'published', disposition: 'parity' },
  restrictedEnvironment: {
    importAdmission: 'published',
    disposition: 'parity',
  },
  environment: { importAdmission: 'published', disposition: 'parity' },
  purpose: {
    importAdmission: 'published',
    disposition: 'bounded',
    accepts: (value: unknown): boolean =>
      value === 'session' || value === 'models' || value === 'quota',
  },
  requireAccount: {
    importAdmission: 'published',
    disposition: 'bounded',
    accepts: (value: unknown): boolean => value === true,
  },
} satisfies Record<
  keyof Parameters<CopilotConnectionBackend['openManagedCopilotRuntime']>[0],
  CopilotVaultFieldCoverage
>;

export class CopilotVaultUnavailableError extends Error {
  readonly code = 'unavailable';
  constructor() {
    super('Copilot runtime is unavailable.');
    this.name = 'CopilotVaultUnavailableError';
  }
}
export interface CopilotConnectionBackend {
  copilotConnectionStatus(this: void): Promise<CopilotConnectionStatus>;
  openManagedCopilotRuntime(
    this: void,
    options: ManagedCopilotRuntimeOptions,
  ): Promise<CopilotRecipientHandle>;
  connectCopilot(
    this: void,
    signal: AbortSignal,
    progress: (status: CopilotConnectionStatus) => void,
    changeAccount?: boolean,
    /** Trusted qualification revalidation, after removal and before successor setup. */
    afterAccountRemoval?: () => Promise<void>,
  ): Promise<CopilotConnectionStatus>;
  disconnectCopilot(this: void): Promise<void>;
  listCopilotModels(
    this: void,
    signal: AbortSignal,
  ): Promise<CopilotModelEntry[]>;
  readCopilotAccountUsage(
    this: void,
    signal: AbortSignal,
  ): Promise<CopilotAccountUsage>;
  revokeCopilotRuntimes(this: void): Promise<void>;
  shutdownCopilotRuntimes(this: void): Promise<void>;
  recoverCopilotAtStartup(this: void): Promise<void>;
}

export interface CopilotConnectionProxy extends CopilotConnectionBackend {
  getCopilotAccountGeneration(this: void): number;
  assertCopilotConnectionGeneration(this: void, expected: number): void;
  readCopilotAccount(this: void): Promise<CopilotAccount | null>;
  assertCopilotModelAvailable(
    this: void,
    model: string | undefined,
    signal?: AbortSignal,
  ): Promise<CopilotModelEntry>;
  resetCopilotShutdownForTests(this: void): void;
}

/** Durable selection chooses custody. Transport availability can only refuse, never select legacy. */
export function createCopilotConnectionProxy(options: {
  legacy: CopilotConnectionBackend;
  selected(): Promise<boolean>;
  vault(): CopilotConnectionBackend;
  /** Stop an already-bound owner even when custody has never been queried. */
  shutdownVault?(): Promise<void>;
  assertEnabled(): void;
}): CopilotConnectionProxy {
  let selected = false;
  let generation = 0;
  let shutdown = false;
  let stopping: Promise<void> | undefined;
  let transitioning: Promise<void> | undefined;
  const handles = new Set<() => Promise<void>>();
  function assert(expected: number): void {
    options.assertEnabled();
    if (shutdown || expected !== generation)
      throw new Error('Copilot connection was revoked.');
  }
  async function revoke(): Promise<void> {
    generation++;
    await Promise.allSettled([...handles].map((close) => close()));
    await options.legacy.revokeCopilotRuntimes();
    if (selected) await options.vault().revokeCopilotRuntimes();
  }
  async function backend(): Promise<CopilotConnectionBackend> {
    if (shutdown) throw new CopilotVaultUnavailableError();
    // A failed read is not evidence of pre-handoff custody.
    let durable: boolean;
    try {
      durable = await options.selected();
    } catch {
      invalidateCopilotRuntimeAvailability();
      throw new CopilotVaultUnavailableError();
    }
    if (durable && !selected) {
      selected = true;
      generation++;
      transitioning = Promise.allSettled(
        [...handles].map((close) => close()),
      ).then(() => options.legacy.revokeCopilotRuntimes());
    }
    await transitioning;
    if (shutdown) throw new CopilotVaultUnavailableError();
    return selected ? options.vault() : options.legacy;
  }
  return {
    getCopilotAccountGeneration: (): number => generation,
    assertCopilotConnectionGeneration: assert,
    async copilotConnectionStatus() {
      return (await backend()).copilotConnectionStatus();
    },
    async readCopilotAccount(): Promise<CopilotAccount | null> {
      return (
        (await (await backend()).copilotConnectionStatus()).account ?? null
      );
    },
    async openManagedCopilotRuntime(
      input: ManagedCopilotRuntimeOptions,
    ): Promise<CopilotRecipientHandle> {
      const entryGeneration = generation;
      const alreadySelected = selected;
      const source = await backend();
      // Initial selection advances once; revocation during routing must not admit a new open.
      const epoch = entryGeneration + (!alreadySelected && selected ? 1 : 0);
      assert(epoch);
      const vaultSelected = selected;
      if (
        vaultSelected &&
        !copilotVaultFieldsCovered(input, COPILOT_VAULT_OPEN_FIELDS)
      )
        throw new CopilotVaultUnavailableError();
      const abort = new AbortController();
      const signal = AbortSignal.any([input.signal, abort.signal]);
      let runtime: CopilotRecipientHandle | undefined;
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        abort.abort();
        const owned = runtime;
        // A revoked pending acquisition must still close the handle it returns.
        if (!owned) return Promise.resolve();
        closing ??= Promise.resolve()
          .then(() => owned.close())
          .finally(() => handles.delete(close));
        return closing;
      };
      handles.add(close);
      try {
        runtime = await source.openManagedCopilotRuntime({ ...input, signal });
        assert(epoch);
        signal.throwIfAborted();
        const owned = runtime;
        async function admitted<T>(operation: () => Promise<T>): Promise<T> {
          assert(epoch);
          signal.throwIfAborted();
          const result = await operation();
          assert(epoch);
          signal.throwIfAborted();
          return result;
        }
        const handle: CopilotRecipientHandle = {
          account: owned.account,
          generation: epoch,
          close,
          runTurn: async (request) => {
            let failed = true;
            try {
              const result = await admitted(() => {
                if (
                  vaultSelected &&
                  !copilotVaultFieldsCovered(request, COPILOT_VAULT_TURN_FIELDS)
                )
                  throw new CopilotVaultUnavailableError();
                return owned.runTurn({
                  ...request,
                  signal: AbortSignal.any([signal, request.signal]),
                });
              });
              failed = false;
              return result;
            } finally {
              try {
                await close();
              } catch (error) {
                handleCopilotTurnCleanupError(error, failed);
              }
            }
          },
          listModels: (requestSignal) =>
            admitted(() =>
              owned.listModels(AbortSignal.any([signal, requestSignal])),
            ),
          getQuota: (requestSignal) =>
            admitted(() =>
              owned.getQuota(AbortSignal.any([signal, requestSignal])),
            ),
        };
        return Object.freeze(handle);
      } catch (error) {
        try {
          await close();
        } catch (cleanupError) {
          handleCopilotTurnCleanupError(cleanupError, true);
        } finally {
          handles.delete(close);
        }
        throw error;
      }
    },
    async connectCopilot(
      signal: AbortSignal,
      progress: (status: CopilotConnectionStatus) => void,
      changeAccount = false,
    ) {
      const source = await backend();
      await revoke();
      const result = await source.connectCopilot(
        signal,
        progress,
        changeAccount,
      );
      generation++;
      return result;
    },
    async disconnectCopilot() {
      const source = await backend();
      await revoke();
      await source.disconnectCopilot();
    },
    async listCopilotModels(signal: AbortSignal) {
      return (await backend()).listCopilotModels(signal);
    },
    async assertCopilotModelAvailable(
      model: string | undefined,
      signal: AbortSignal = AbortSignal.timeout(45_000),
    ): Promise<CopilotModelEntry> {
      const source = await backend();
      const epoch = generation;
      const models = await source.listCopilotModels(signal);
      assert(epoch);
      const found = models.find((entry) => entry.id === model);
      if (!found)
        throw new Error(
          'This Copilot model is unavailable. Choose another Copilot model and try again.',
        );
      return found;
    },
    async readCopilotAccountUsage(signal: AbortSignal) {
      return (await backend()).readCopilotAccountUsage(signal);
    },
    revokeCopilotRuntimes: revoke,
    async recoverCopilotAtStartup() {
      return (await backend()).recoverCopilotAtStartup();
    },
    shutdownCopilotRuntimes() {
      if (stopping) return stopping;
      shutdown = true;
      generation++;
      stopping = Promise.allSettled([
        options.legacy.shutdownCopilotRuntimes(),
        ...(options.shutdownVault
          ? [options.shutdownVault()]
          : selected
            ? [options.vault().shutdownCopilotRuntimes()]
            : []),
        ...[...handles].map((close) => close()),
      ]).then(() => undefined);
      return stopping;
    },
    resetCopilotShutdownForTests(): void {
      shutdown = false;
      stopping = undefined;
    },
  };
}

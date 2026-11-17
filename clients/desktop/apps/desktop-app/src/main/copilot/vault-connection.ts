import { COPILOT_VAULT_IMPORT_PATHS } from '@canopy/protocol/copilot-handoff';
import type { CopilotRecipientHandle } from '@canopy/desktop-shared/node/copilot/recipient-handle';
import type {
  CopilotGrantResult,
  CopilotVaultGrant,
} from '@canopy/core-runtime/node/vault';
import {
  createCopilotConsumerHandle,
  copilotVaultFieldsCovered,
  type CopilotConsumerPort,
} from '@canopy/desktop-shared/node/copilot/consumer-transport';
import type { CopilotConnectionBackend } from './connection-proxy';
import {
  COPILOT_VAULT_OPEN_FIELDS,
  CopilotVaultUnavailableError,
} from './connection-proxy';
import {
  authorizeCopilotDevice,
  copilotInstallationStatus,
} from './legacy-connection';
import { readCopilotSelectionPreferences } from './selection-receipt';
import { assertCopilotHarnessEnabled } from './feature-flag';
import { CopilotPolicyError } from './service-errors';
import { CopilotSignInExpiredError } from './credential-broker';
import { initCopilotModels } from '@canopy/desktop-shared/types';
import { notifyCopilotUsageChanged } from './usage-events';
import {
  beginCopilotAvailabilityProbe,
  invalidateCopilotRuntimeAvailability,
} from './runtime-availability';
import type { CopilotConnectionStatus } from '@canopy/desktop-shared/types/copilot-connection';

type PendingOperation = Extract<
  CopilotGrantResult,
  { kind: 'pending' }
>['operation'];
type PendingEntry =
  | 'connect'
  | 'disconnect'
  | 'change-account'
  | 'setup-cancel'
  | 'status'
  | 'startup'
  | 'open';
type PendingPath = 'resume' | 'cancel' | 'read' | 'unavailable';
/** P7's authenticated import dimension composes with, never impersonates, P6 setup state. */
export const COPILOT_VAULT_PENDING_IMPORT_PATHS = COPILOT_VAULT_IMPORT_PATHS;
export const COPILOT_VAULT_IMPORT_CANCEL_PATHS = COPILOT_VAULT_IMPORT_PATHS;
export const COPILOT_VAULT_PENDING_PATHS = {
  create: {
    connect: 'resume',
    disconnect: 'cancel',
    'change-account': 'cancel',
    'setup-cancel': 'cancel',
    status: 'read',
    startup: 'read',
    open: 'unavailable',
  },
  refresh: {
    connect: 'resume',
    disconnect: 'resume',
    'change-account': 'resume',
    'setup-cancel': 'unavailable',
    status: 'read',
    startup: 'read',
    open: 'unavailable',
  },
  replace: {
    connect: 'resume',
    disconnect: 'resume',
    'change-account': 'resume',
    'setup-cancel': 'unavailable',
    status: 'read',
    startup: 'read',
    open: 'unavailable',
  },
  delete: {
    connect: 'resume',
    disconnect: 'resume',
    'change-account': 'resume',
    'setup-cancel': 'unavailable',
    status: 'read',
    startup: 'read',
    open: 'unavailable',
  },
  remove: {
    connect: 'resume',
    disconnect: 'resume',
    'change-account': 'resume',
    'setup-cancel': 'unavailable',
    status: 'read',
    startup: 'read',
    open: 'unavailable',
  },
} satisfies Record<PendingOperation['kind'], Record<PendingEntry, PendingPath>>;

function pendingPath(
  operation: PendingOperation,
  entry: PendingEntry,
): PendingPath {
  const row = COPILOT_VAULT_PENDING_PATHS[operation.kind];
  if (
    !Object.prototype.hasOwnProperty.call(
      COPILOT_VAULT_PENDING_PATHS,
      operation.kind,
    ) ||
    !row ||
    (operation.origin !== 'setup' && operation.origin !== 'import')
  )
    throw new CopilotVaultUnavailableError();
  return row[entry];
}

/** P9 binds this results-only control port to the authenticated daemon channel. */
export interface CopilotVaultConnectionPort extends CopilotConsumerPort {
  status(): Promise<CopilotGrantResult>;
  setup(
    grant: CopilotVaultGrant,
    expectedGeneration: string | null,
    signal: AbortSignal,
  ): Promise<
    (
      | CopilotGrantResult
      | { kind: 'probe-failed'; reason: 'policy' | 'network' | 'no-access' }
    ) & { readonly setupOperationId?: string }
  >;
  resume(operationId: string): Promise<CopilotGrantResult>;
  cancel(operationId: string): Promise<CopilotGrantResult>;
  remove(epoch: string): Promise<CopilotGrantResult>;
  revoke(): void;
  reopen(): void;
  close(): void;
}
type SetupOutcome = Awaited<ReturnType<CopilotVaultConnectionPort['setup']>>;
type SetupCancelPath = 'remove' | 'pending' | 'cancel-owned' | 'settled';
export const COPILOT_VAULT_SETUP_CANCEL_PATHS = {
  ready: 'remove',
  pending: 'pending',
  blocked: 'cancel-owned',
  'probe-failed': 'cancel-owned',
  delivered: 'cancel-owned',
  removed: 'settled',
} satisfies Record<SetupOutcome['kind'], SetupCancelPath>;

export function createCopilotVaultConnection(options: {
  port: CopilotVaultConnectionPort;
  authorize?: typeof authorizeCopilotDevice;
  installation?: typeof copilotInstallationStatus;
  preferences?: typeof readCopilotSelectionPreferences;
}): CopilotConnectionBackend {
  const { port } = options;
  let generation = 0;
  let closed = false;
  let settingUp = false;
  const handles = new Set<ReturnType<typeof createCopilotConsumerHandle>>();
  function admit(): void {
    assertCopilotHarnessEnabled();
    if (closed) throw new CopilotVaultUnavailableError();
  }
  async function status(): Promise<CopilotConnectionStatus> {
    const publish = beginCopilotAvailabilityProbe();
    const epoch = generation;
    try {
      admit();
      const base = await (options.installation ?? copilotInstallationStatus)();
      const state = await port.status();
      if (state.kind === 'pending') pendingPath(state.operation, 'status');
      if (
        state.kind === 'blocked' &&
        state.reason !== 'absent' &&
        state.reason !== 'expired'
      )
        throw new CopilotVaultUnavailableError();
      const account =
        state.kind === 'ready'
          ? { host: state.head.account.host, login: state.head.account.login }
          : null;
      const enabled =
        !!account && !settingUp && !closed && epoch === generation;
      publish(base.supported && base.installed && enabled);
      return {
        ...base,
        enabled,
        phase: enabled ? 'connected' : 'idle',
        account: enabled ? account : null,
      };
    } catch (error) {
      publish(false);
      throw error;
    }
  }

  async function revoke(): Promise<void> {
    generation++;
    invalidateCopilotRuntimeAvailability();
    port.revoke();
    initCopilotModels([]);
    notifyCopilotUsageChanged(false);
    await Promise.allSettled([...handles].map((handle) => handle.close()));
    handles.clear();
  }
  async function open(
    input: Parameters<CopilotConnectionBackend['openManagedCopilotRuntime']>[0],
  ): Promise<CopilotRecipientHandle> {
    admit();
    input.signal.throwIfAborted();
    if (settingUp)
      throw new Error(
        'Copilot account setup is in progress. Try again when it finishes.',
      );
    const epoch = generation;
    const state = await port.status();
    if (state.kind === 'pending') pendingPath(state.operation, 'open');
    if (
      state.kind === 'blocked' &&
      (state.reason === 'absent' || state.reason === 'expired')
    )
      throw new CopilotSignInExpiredError();
    if (state.kind !== 'ready' || epoch !== generation)
      throw new CopilotVaultUnavailableError();
    if (!copilotVaultFieldsCovered(input, COPILOT_VAULT_OPEN_FIELDS))
      throw new CopilotVaultUnavailableError();
    port.reopen();
    const handle = createCopilotConsumerHandle({
      port,
      account: {
        host: state.head.account.host,
        login: state.head.account.login,
      },
      generation: epoch,
      purpose:
        input.purpose === 'models'
          ? 'models'
          : input.purpose === 'quota'
            ? 'quota'
            : 'session',
      launch: {
        owner: { ...input.owner },
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.workspaceId === undefined
          ? {}
          : { workspaceId: input.workspaceId }),
        ...(input.executionKind === undefined
          ? {}
          : { executionKind: input.executionKind }),
        ...(input.restrictedEnvironment === undefined
          ? {}
          : { restrictedEnvironment: input.restrictedEnvironment }),
        ...(input.environment === undefined
          ? {}
          : { environment: { ...input.environment } }),
      },
      signal: input.signal,
      current: () => !closed && !settingUp && epoch === generation,
    });
    handles.add(handle);
    return {
      ...handle,
      runTurn: async (request) => {
        try {
          return await handle.runTurn(request);
        } finally {
          handles.delete(handle);
        }
      },
      close: async (): Promise<void> => {
        handles.delete(handle);
        await handle.close();
      },
    };
  }
  async function cancelSetup(state: SetupOutcome): Promise<void> {
    const path: SetupCancelPath = COPILOT_VAULT_SETUP_CANCEL_PATHS[state.kind];
    if (
      !Object.prototype.hasOwnProperty.call(
        COPILOT_VAULT_SETUP_CANCEL_PATHS,
        state.kind,
      )
    )
      throw new CopilotVaultUnavailableError();
    if (path === 'remove' && state.kind === 'ready')
      await port.remove(state.head.epoch);
    else if (path === 'pending' && state.kind === 'pending') {
      if (pendingPath(state.operation, 'setup-cancel') !== 'cancel')
        throw new CopilotVaultUnavailableError();
      await port.cancel(state.operationId);
    } else if (path === 'cancel-owned' && state.setupOperationId)
      await port.cancel(state.setupOperationId);
  }
  async function disconnect(
    entry: 'disconnect' | 'change-account' = 'disconnect',
  ): Promise<void> {
    admit();
    await revoke();
    const state = await port.status();
    let result =
      state.kind === 'ready'
        ? await port.remove(state.head.epoch)
        : state.kind === 'pending'
          ? pendingPath(state.operation, entry) === 'cancel'
            ? await port.cancel(state.operationId)
            : await port.resume(state.operationId)
          : state;
    if (result.kind === 'ready') result = await port.remove(result.head.epoch);
    if (
      result.kind !== 'removed' &&
      !(result.kind === 'blocked' && result.reason === 'absent')
    )
      throw new CopilotVaultUnavailableError();
  }
  return {
    copilotConnectionStatus: status,
    openManagedCopilotRuntime: open,
    async connectCopilot(signal, progress, changeAccount = false) {
      admit();
      signal.throwIfAborted();
      if (settingUp)
        throw new Error('Copilot account setup is already in progress.');
      if (changeAccount) await disconnect('change-account');
      settingUp = true;
      await revoke();
      let ownedSetup: SetupOutcome | undefined;
      try {
        let state = await port.status();
        // Unknown local outcomes reconcile the same operation before any new device flow.
        if (state.kind === 'pending') {
          pendingPath(state.operation, 'connect');
          state = await port.resume(state.operationId);
          if (state.kind === 'removed') state = await port.status();
        }
        if (state.kind !== 'ready') {
          if (state.kind !== 'blocked' || state.reason !== 'absent')
            throw new CopilotVaultUnavailableError();
          const preferences = await (
            options.preferences ?? readCopilotSelectionPreferences
          )();
          const grant = await (options.authorize ?? authorizeCopilotDevice)(
            signal,
            progress,
          );
          signal.throwIfAborted();
          const result = await port.setup(
            grant,
            preferences.copilotVaultSelection?.pinGeneration ?? null,
            signal,
          );
          ownedSetup = result;
          signal.throwIfAborted();
          if (result.kind === 'probe-failed') {
            if (result.reason === 'policy') throw new CopilotPolicyError();
            throw new Error(
              result.reason === 'network'
                ? "Couldn't check Copilot access. Check your connection and try again."
                : "This GitHub account doesn't have Copilot access.",
            );
          }
          state = result;
        }
        signal.throwIfAborted();
        if (state.kind !== 'ready') throw new CopilotVaultUnavailableError();
        settingUp = false;
        generation++;
        port.reopen();
        const connected = await status();
        signal.throwIfAborted();
        progress(connected);
        return connected;
      } catch (error) {
        if (signal.aborted) {
          if (ownedSetup) {
            await revoke();
            await cancelSetup(ownedSetup);
          }
          signal.throwIfAborted();
        }
        throw error;
      } finally {
        settingUp = false;
        notifyCopilotUsageChanged(true);
      }
    },
    disconnectCopilot: disconnect,
    async listCopilotModels(signal) {
      const runtime = await open({
        signal,
        purpose: 'models',
        owner: { kind: 'discovery', id: 'copilot-models' },
      });
      try {
        const models = await runtime.listModels(signal);
        initCopilotModels(models);
        return models;
      } finally {
        await runtime.close();
      }
    },
    async readCopilotAccountUsage(signal) {
      const runtime = await open({
        signal,
        purpose: 'quota',
        owner: { kind: 'discovery', id: 'copilot-quota' },
      });
      try {
        if (!runtime.account)
          throw new Error('Connect Copilot to see account usage.');
        const response = await runtime.getQuota(signal);
        return {
          account: runtime.account,
          limits: Object.entries(response.quotaSnapshots)
            .slice(0, 16)
            .flatMap(([id, quota]) =>
              !quota || !/^[a-z_]{1,64}$/.test(id)
                ? []
                : [
                    {
                      id,
                      label:
                        id === 'premium_interactions'
                          ? 'Premium requests'
                          : id === 'chat'
                            ? 'Chat'
                            : id === 'completions'
                              ? 'Completions'
                              : id.replace(/_/g, ' '),
                      unlimited: quota.isUnlimitedEntitlement === true,
                      ...(Number.isFinite(quota.remainingPercentage) &&
                      quota.remainingPercentage >= 0 &&
                      quota.remainingPercentage <= 100
                        ? { usedPercent: 100 - quota.remainingPercentage }
                        : {}),
                      ...(quota.resetDate &&
                      Number.isFinite(Date.parse(quota.resetDate))
                        ? { resetsAt: new Date(quota.resetDate).toISOString() }
                        : {}),
                    },
                  ],
            ),
        };
      } finally {
        await runtime.close();
      }
    },
    revokeCopilotRuntimes: revoke,
    recoverCopilotAtStartup: async () => {
      admit();
      const state = await port.status();
      if (state.kind === 'pending') pendingPath(state.operation, 'startup');
    },
    shutdownCopilotRuntimes: async () => {
      closed = true;
      await revoke();
      port.close();
    },
  };
}

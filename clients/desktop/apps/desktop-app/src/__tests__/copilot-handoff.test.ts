import type * as FsPromises from 'node:fs/promises';
import type { CopilotHostSelection } from '@canopy/protocol/copilot-selection';
import { CopilotAuthorityRecordSchema } from '@canopy/core-runtime/node/vault';
import { createCopilotSetupLineage } from '../main/copilot/setup-lineage';
import type * as AtomicFile from '../main/lib/atomic-file';
import type * as CanopyCoreProtocol from '@canopy/protocol/canopy-core';
import { createCopilotVaultPilot } from '../../../core-daemon/src/copilot-pilot';
import { createCopilotSelectionReceipt } from '../main/copilot/selection-receipt';
import { CopilotLocalFrameSchema } from '@canopy/protocol/copilot-recipient';
import { createCopilotQualificationConnection } from '../main/copilot/qualification-connection';
import { readCopilotCredential as initialReadCredential } from '../main/copilot/grant-authority';
import type { CopilotConnectionBackend } from '../main/copilot/connection-proxy';
import type { CopilotRecipientHandle } from '@canopy/desktop-shared/node/copilot/recipient-handle';
import type { CopilotConnectionStatus } from '@canopy/desktop-shared/types/copilot-connection';
/** CAN-6836 migration golden: real files/holder/preferences, synthetic native admission and cipher. */
import { encodedCopilotEndpoint } from './helpers/copilot-handoff-endpoint';
import type * as PathsModule from '../main/lib/paths';
import { CopilotHandoffActionSchema } from '@canopy/protocol/copilot-handoff';
import {
  readFile,
  writeFile,
  rename,
  unlink,
  lstat,
  mkdir,
  link,
  symlink,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createCopilotHandoffCore,
  createCopilotMigrationUse,
  createCopilotHandoffPump,
  encodeCopilotHandoffFrame,
  encodeMigrationFrame,
  parseMigrationCoreFrame,
  observeCopilotLegacyCiphertext,
  parseCopilotHandoffFrame,
  COPILOT_HANDOFF_PROTOCOL,
  type CopilotUseCompletion,
  type CopilotVaultGrant,
  type MigrationChannelFacts,
  type MigrationHostFacts,
  type MigrationWireFrame,
} from '@canopy/core-runtime/node/vault';
import { createFakeSecretProtection } from '@canopy/core-runtime/platform/testing/fake-secret-protection';
import {
  openVaultReadRepository,
  type VaultReadRepository,
} from '../../../../packages/core-runtime/src/node/vault/repository/read-repository';
import type { VaultPutOutcome } from '@canopy/core-runtime/vault';
import type { VaultStore } from '../../../../packages/core-runtime/src/node/vault/repository/store';
import {
  storeFolder,
  type StoreFolder,
} from '../../../../packages/core-runtime/src/node/vault/repository/__tests__/store-fixtures';
import {
  createCopilotQualificationHandoff,
  createCopilotHandoffFile,
} from '../main/copilot/qualification-handoff';
import { readCopilotSelectionPreferences as initialReadSelection } from '../main/copilot/selection-receipt';
import {
  readPreferencesFile as initialReadPreferences,
  updatePreferencesFile as initialUpdatePreferences,
  flushPreferencesWrites as initialFlushPreferences,
  observeCopilotSelectionAuthority as initialObserveSelection,
} from '../main/lib/preferences-store';
import { getDataDir } from '../main/lib/paths';

// Loaded composition rows measured 4.5 s; allow 2x headroom without faking durable I/O.
const COPILOT_COMPOSITION_ROW_TIMEOUT_MS = 10_000;
jest.setTimeout(COPILOT_COMPOSITION_ROW_TIMEOUT_MS);

let readCopilotCredential = initialReadCredential;
let readPreferencesFile = initialReadPreferences;
let readCopilotSelectionPreferences = initialReadSelection;
let updatePreferencesFile = initialUpdatePreferences;
let flushPreferencesWrites = initialFlushPreferences;
let observeCopilotSelectionAuthority = initialObserveSelection;
let previousHostOwner: object | undefined;
let mockSource: string;
let mockDecryptFails = false;
let mockPreferenceWriteFails = false;
let mockPreferenceAckLost = false;
let onSetupPrepare: (() => Promise<void>) | undefined;
let onSetupConfirm: (() => Promise<void>) | undefined;
let onSetupPredecessor: (() => Promise<void>) | undefined;
let onOrdinaryAuthorityRead: (() => Promise<void>) | undefined;
let mockOnControlRead: (() => Promise<void>) | undefined;
let mockCleanupFault: string | undefined;
let mockOnClaimDirectorySync: (() => Promise<void>) | undefined;
function mockFault(edge: string): void {
  if (mockCleanupFault !== edge) return;
  mockCleanupFault = undefined;
  throw new Error(`injected cleanup ${edge}`);
}
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    async readFile(
      ...args: Parameters<typeof actual.readFile>
    ): ReturnType<typeof actual.readFile> {
      const bytes = await actual.readFile(...args);
      if (
        typeof args[0] === 'string' &&
        args[0].endsWith('/handoff-control.v1.json')
      )
        await mockOnControlRead?.();
      return bytes;
    },
    async link(...args: Parameters<typeof actual.link>): Promise<void> {
      if (String(args[1]).includes('/claims/')) mockFault('link-before');
      await actual.link(...args);
      if (String(args[1]).includes('/claims/')) mockFault('link-after');
    },
    async unlink(...args: Parameters<typeof actual.unlink>): Promise<void> {
      const step = String(args[0]).includes('/claims/')
        ? 'claim-unlink'
        : 'source-unlink';
      mockFault(`${step}-before`);
      await actual.unlink(...args);
      mockFault(`${step}-after`);
    },
    async open(
      ...args: Parameters<typeof actual.open>
    ): ReturnType<typeof actual.open> {
      const file = await actual.open(...args);
      if (String(args[0]).includes('/claims/')) {
        const sync = file.sync.bind(file);
        file.sync = async (): Promise<void> => {
          mockFault('file-sync-before');
          await sync();
          mockFault('file-sync-after');
        };
      }
      return file;
    },
  };
});
jest.mock('../main/lib/atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFile>(
    '../main/lib/atomic-file',
  );
  return {
    ...actual,
    async writeFileAtomically(
      ...args: Parameters<typeof actual.writeFileAtomically>
    ): Promise<void> {
      if (mockPreferenceWriteFails && args[0].endsWith('/preferences.json'))
        throw new Error('P8 definite preference failure');
      await actual.writeFileAtomically(...args);
      if (mockPreferenceAckLost && args[0].endsWith('/preferences.json')) {
        mockPreferenceAckLost = false;
        throw new Error('P8 lost preference acknowledgement');
      }
    },
    async syncDirectory(
      ...args: Parameters<typeof actual.syncDirectory>
    ): Promise<void> {
      const step = args[0].endsWith('/claims')
        ? 'claim-directory-sync'
        : 'source-directory-sync';
      mockFault(`${step}-before`);
      await actual.syncDirectory(...args);
      if (args[0].endsWith('/claims')) await mockOnClaimDirectorySync?.();
      mockFault(`${step}-after`);
    },
    async createDirectoryDurably(
      ...args: Parameters<typeof actual.createDirectoryDurably>
    ): Promise<void> {
      if (args[0].endsWith('/claims'))
        mockFault('claim-directory-durable-before');
      await actual.createDirectoryDurably(...args);
      if (args[0].endsWith('/claims'))
        mockFault('claim-directory-durable-after');
    },
  };
});
declare global {
  var mockCanopyCoreProtocol: typeof CanopyCoreProtocol | undefined;
}
// compose()'s restarts share one copy of this catalog: it holds only readonly
// schemas, and rebuilding it per restart doubled each case's time under load.
// Reload it per restart if it ever gains module state.
jest.mock('@canopy/protocol/canopy-core', () => {
  globalThis.mockCanopyCoreProtocol ??= jest.requireActual<
    typeof CanopyCoreProtocol
  >('@canopy/protocol/canopy-core');
  return globalThis.mockCanopyCoreProtocol;
});
jest.mock('../main/lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../main/lib/paths'),
  getCopilotCredentialFilePath: (): string => mockSource,
}));
jest.mock('../main/lib/secure-storage-policy', () => ({
  getSecretStoragePolicy: (): object => ({
    decrypt: (bytes: Buffer): string => {
      if (mockDecryptFails) throw new Error('Synthetic decrypt failure');
      return bytes.toString('utf8').slice('synthetic:'.length);
    },
    encrypt: (text: string): Buffer => Buffer.from(`synthetic:${text}`),
    assertCanWrite: (): void => undefined,
    isWriteAvailable: (): boolean => true,
  }),
  getSecureStorageFailure: (): undefined => undefined,
}));
const grant = {
  version: 1,
  clientId: 'client',
  host: 'github.com',
  login: 'pilot',
  id: '1',
  accessToken: 'synthetic-access',
  refreshToken: 'synthetic-refresh',
  accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
  refreshTokenExpiresAt: '2099-02-01T00:00:00.000Z',
} satisfies CopilotVaultGrant;
const source = { flavorId: 'canopy-internal', secureMode: 'development' };
const hostFacts: MigrationHostFacts = {
  authorityId: 'authority',
  coreAuthority: 'core',
  coreIncarnation: 'incarnation',
  coreDigest: 'digest',
  buildId: 'internal',
  packageDigest: 'package',
  updateEpoch: 'update',
};
let folder: StoreFolder;
let store: VaultStore;
let vault: VaultReadRepository;
let slots: ReturnType<typeof createFakeSecretProtection>;
let main: ReturnType<typeof createCopilotQualificationHandoff> | undefined;
let core: ReturnType<typeof createCopilotHandoffCore> | undefined;
let endpoint: Awaited<ReturnType<typeof encodedCopilotEndpoint>> | undefined;
let interruptAt: string | undefined;
let useCommitFault: 'before' | 'after' | undefined;
let armedCommitFault: 'before' | 'after' | undefined;
let frames: MigrationWireFrame[];
let dataRoot: string;
let holdPut: (() => Promise<void>) | undefined;
let onPut: (() => void) | undefined;
let onPutSettled: (() => void) | undefined;
let onHostAction: ((kind: string) => Promise<void>) | undefined;
let migrationEpoch = 1;
let useFault:
  | 'provider'
  | 'provisional'
  | 'stale'
  | 'post-provider'
  | 'replay'
  | undefined;
let replayCompletion: CopilotUseCompletion | undefined;
let onChannelRead: (() => void) | undefined;
let refreshForUse = false;
let refreshCalls = 0;
let discoveryCalls = 0;
let modelPilot: ReturnType<typeof createCopilotVaultPilot> | undefined;
let coreProcessLifetime = {};
let pilotForSetup: () => ReturnType<typeof createCopilotVaultPilot>;
let completeDiscovery: ((evidence: CopilotUseCompletion) => void) | undefined;
async function closeEndpoint(): Promise<void> {
  modelPilot?.close();
  modelPilot = undefined;
  completeDiscovery = undefined;
  replayCompletion = undefined;
  await endpoint?.close();
  endpoint = undefined;
}
async function reopen(): Promise<void> {
  vault?.dispose();
  store?.close();
  store = await folder.opened({
    sync(commit): void {
      const fault = armedCommitFault;
      armedCommitFault = undefined;
      if (fault !== 'before') commit();
      if (fault) throw new Error('injected actual use COMMIT uncertainty');
    },
  });
  coreProcessLifetime = {}; // Reacquired exclusive store models a fresh core process in this fixture.
  const opened = await openVaultReadRepository({
    store,
    slots: slots.port,
    signal: new AbortController().signal,
    holdPut: () => holdPut?.() ?? Promise.resolve(),
  });
  if (opened.kind !== 'opened') throw new Error('Vault unavailable.');
  vault = opened.vault;
}
function coreHost(): ReturnType<typeof createCopilotHandoffCore> {
  if (!core) throw new Error('Core missing');
  return core;
}
function mainHost(): ReturnType<typeof createCopilotQualificationHandoff> {
  if (!main) throw new Error('Host missing');
  return main;
}
async function compose(): Promise<void> {
  await flushPreferencesWrites();
  let createHost = createCopilotQualificationHandoff;
  let createSelection = createCopilotSelectionReceipt;
  // Reconstruct main's actual queue, gate, preferences owner and all source module state.
  // Only filesystem bytes and the synthetic OS key-slot provider survive a restart.
  await jest.isolateModulesAsync(async () => {
    const authority = await import('../main/copilot/grant-authority');
    expect(authority).not.toBe(previousHostOwner);
    previousHostOwner = authority;
    const preferences = await import('../main/lib/preferences-store');
    const selection = await import('../main/copilot/selection-receipt');
    const handoff = await import('../main/copilot/qualification-handoff');
    readCopilotCredential = authority.readCopilotCredential;
    readPreferencesFile = preferences.readPreferencesFile;
    readCopilotSelectionPreferences = selection.readCopilotSelectionPreferences;
    updatePreferencesFile = preferences.updatePreferencesFile;
    flushPreferencesWrites = preferences.flushPreferencesWrites;
    observeCopilotSelectionAuthority =
      preferences.observeCopilotSelectionAuthority;
    createHost = handoff.createCopilotQualificationHandoff;
    createSelection = selection.createCopilotSelectionReceipt;
  });
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  const setupLineage = createCopilotSetupLineage();
  const ordinarySelection = createSelection(undefined, setupLineage);
  const realCompare = state.compareExchange.bind(state);
  const realPut = state.writer.put.bind(state.writer);
  const qualifiedState = {
    ...state,
    compareExchange(
      ...args: Parameters<typeof state.compareExchange>
    ): boolean {
      if (
        interruptAt === 'p1-prepare' &&
        args[1].binding?.phase === 'pre_ingress'
      ) {
        interruptAt = undefined;
        throw new Error('injected P1 prepare loss');
      }
      const written = realCompare(...args);
      const phase = args[1].binding?.phase;
      const control = args[1].controls.at(-1)?.phase;
      if (
        written &&
        (interruptAt === `binding:${phase}` ||
          interruptAt === `control:${control}`)
      ) {
        interruptAt = undefined;
        throw new Error('injected control commit acknowledgement loss');
      }
      return written;
    },
    migration: {
      ...state.migration,
      recordUse(...args: Parameters<typeof state.migration.recordUse>): void {
        armedCommitFault = useCommitFault;
        useCommitFault = undefined;
        state.migration.recordUse(...args);
      },
      retiredDeletionReceipt(
        ...args: Parameters<typeof state.migration.retiredDeletionReceipt>
      ): void {
        state.migration.retiredDeletionReceipt(...args);
        if (interruptAt === 'retired-deletion-receipt') {
          interruptAt = undefined;
          throw new Error(
            'injected retired cleanup receipt acknowledgement loss',
          );
        }
      },
      supersede(...args: Parameters<typeof state.migration.supersede>): void {
        state.migration.supersede(...args);
        if (interruptAt === 'epoch') {
          interruptAt = undefined;
          throw new Error('injected epoch acknowledgement loss');
        }
      },
    },
    writer: {
      ...state.writer,
      async delete(
        ...args: Parameters<typeof state.writer.delete>
      ): ReturnType<typeof state.writer.delete> {
        const outcome = await state.writer.delete(...args);
        if (interruptAt === 'destination-delete') {
          interruptAt = undefined;
          throw new Error('injected destination deletion acknowledgement loss');
        }
        return outcome;
      },
      async put(
        ...args: Parameters<typeof state.writer.put>
      ): Promise<VaultPutOutcome> {
        const submitted = realPut(...args);
        onPut?.();
        const outcome = await submitted;
        onPutSettled?.();
        if (interruptAt === 'commit') {
          interruptAt = undefined;
          throw new Error('injected commit response loss');
        }
        return outcome;
      },
    },
  };
  const channel = {};
  const facts: MigrationChannelFacts = {
    transport: 'launcher-channel',
    channelId: 'synthetic-channel',
    launcher: { os: 'darwin', pid: 42, pidversion: 7 },
    launcherDigest: 'synthetic-launcher',
    source,
    admittedHost: hostFacts,
  };
  function getPilot(): ReturnType<typeof createCopilotVaultPilot> {
    return (modelPilot ??= createCopilotVaultPilot({
      journal: qualifiedState.journal,
      processLifetime: coreProcessLifetime,
      repository: () => Promise.resolve(vault.repository),
      writer: () => Promise.resolve(qualifiedState.writer),
      probeKeyIfDue: () => vault.probeKeyIfDue(),
      now: () =>
        refreshForUse
          ? Date.parse(grant.accessTokenExpiresAt) - 1000
          : Date.now(),
      refresh: () => {
        refreshCalls++;
        return Promise.resolve({
          kind: 'success',
          grant: {
            ...grant,
            accessToken: 'synthetic-successor-access',
            accessTokenExpiresAt: '2100-01-01T00:00:00.000Z',
          },
        });
      },
      selection: {
        ...ordinarySelection,
        async confirm(request) {
          await onSetupConfirm?.();
          return ordinarySelection.confirm(request);
        },
        async setupPredecessor(): Promise<CopilotHostSelection | undefined> {
          await onSetupPredecessor?.();
          return ordinarySelection.setupPredecessor?.();
        },
        async prepare(identity, generation): Promise<boolean> {
          await onSetupPrepare?.();
          return ordinarySelection.prepare(identity, generation);
        },
      },
      platform: 'darwin',
      capable: () => true,
      qualificationAdmission: () =>
        coreHost().current() || coreHost().retiredBinding() !== null,
      classifyProbeFailure: () => 'network',
      completed: (evidence) => {
        replayCompletion = structuredClone(evidence);
        completeDiscovery?.(
          useFault === 'provisional'
            ? {
                ...evidence,
                presentations: evidence.presentations.map((p) => ({
                  ...p,
                  committedPin: null,
                })),
              }
            : useFault === 'stale'
              ? {
                  ...evidence,
                  presentations: evidence.presentations.map((p) => ({
                    ...p,
                    binding: {
                      ...p.binding,
                      publicationGeneration:
                        p.binding.publicationGeneration + 1,
                    },
                  })),
                }
              : evidence,
        );
      },
      start: () =>
        Promise.resolve({
          identity: {
            runtimeId: 'synthetic-model-provider',
            pid: 123,
            started: 1,
          },
          isClosed: () => false,
          exited: new Promise<void>(() => undefined),
          close: () => Promise.resolve(),
          async execute(purpose, context) {
            context.admit();
            expect([grant.accessToken, 'synthetic-successor-access']).toContain(
              await context.token(),
            );
            context.admit();
            if (useFault === 'provider')
              throw new Error('Synthetic provider failure');
            if (purpose === 'setup-probe')
              return { kind: 'setup-probe', available: true };
            if (purpose !== 'models')
              throw new Error('Only model discovery supported by fixture');
            return { kind: 'models', models: [] };
          },
        }),
    }));
  }
  pilotForSetup = getPilot;
  core = createCopilotHandoffCore({
    state: qualifiedState,
    removePublished: (epoch) => getPilot().authority.remove(epoch),
    recoverPublished: () => getPilot().authority.demand(),
    channel,
    migration: {
      admission: {
        channel: (h) => {
          onChannelRead?.();
          return h === channel ? facts : null;
        },
        host: () => hostFacts,
      },
      brand: 'canopy',
      build: 'internal',
      source,
      os: 'darwin',
      epoch: () => migrationEpoch,
    },
    use: createCopilotMigrationUse({
      state: qualifiedState,
      current: () => coreHost().current(),
      async discoverModels(operationId, completed): Promise<void> {
        discoveryCalls++;
        if (useFault === 'replay') {
          if (!replayCompletion) throw new Error('Missing prior completion');
          completed(replayCompletion);
          return;
        }
        completeDiscovery = completed;
        const pilot = getPilot();
        try {
          const messages: unknown[] = [];
          const audience = {
            kind: 'create' as const,
            operationId,
          };
          const channel = await pilot.open(
            'models',
            audience,
            undefined,
            (encoded) => {
              messages.push(JSON.parse(encoded));
              return Promise.resolve();
            },
          );
          if (channel.opened.kind !== 'opened')
            throw new Error('Models open unavailable');
          await channel.receive(
            JSON.stringify({
              requestId: 1,
              command: {
                version: 1,
                kind: 'run',
                handle: channel.opened.handle,
                generation: channel.opened.generation,
                purpose: 'models',
                audience,
              },
            }),
          );
          const result = messages
            .map((m) => CopilotLocalFrameSchema.parse(m))
            .find((m) => m.kind === 'response');
          if (
            result?.kind !== 'response' ||
            result.outcome.kind !== 'completed'
          )
            throw new Error(
              'Models completion unavailable ' + JSON.stringify(messages),
            );
          channel.disconnect();
          if (useFault === 'post-provider')
            throw new Error('Synthetic discovery settlement failure');
        } finally {
          completeDiscovery = undefined;
        }
      },
    }),
    observeClaim: (id) =>
      observeCopilotLegacyCiphertext({
        read: async () => {
          try {
            return {
              kind: 'present',
              bytes: await readFile(
                join(dataRoot, 'copilot-qualification', 'claims', `${id}.enc`),
              ),
            };
          } catch {
            return { kind: 'outcome_unknown' };
          }
        },
      }),
    observe: () =>
      observeCopilotLegacyCiphertext({
        read: async () => ({
          kind: 'present',
          bytes: await readFile(mockSource),
        }),
      }),
    closeAdmission: (): void => undefined,
    published: (): void => undefined,
  });
  const handler = core;
  endpoint = await encodedCopilotEndpoint((raw, signal) =>
    handler.exchange(raw, signal),
  );
  const wire = endpoint;
  let lastAction: string | undefined;
  main = createHost({
    setupLineage,
    dataRoot,
    source,
    retireChannel: (): void => handler.close(),
    cancelAdmission: (): void => handler.cancelAdmission(),
    corePhase: () => Promise.resolve(handler.phase()),
    retiredBinding: () => Promise.resolve(handler.retiredBinding()),
    ordinaryAuthority: async () => {
      await onOrdinaryAuthorityRead?.();
      return handler.ordinaryAuthority();
    },
    proveUnused: (): Promise<boolean> => Promise.resolve(handler.unused()),
    async exchange(frame, metadata) {
      expect(metadata.deadlineMs).toBeGreaterThan(Date.now());
      expect(metadata.signal.aborted).toBe(false);
      // Serialize both directions as separately hosted endpoints do; no function ports cross.
      if (
        frame.protocol === COPILOT_HANDOFF_PROTOCOL &&
        frame.type === 'reply' &&
        `${lastAction}-reply` === interruptAt
      ) {
        interruptAt = undefined;
        throw new Error('injected host acknowledgement loss');
      }
      const result = await wire.exchange(frame, metadata);
      expect(result.frames.length).toBeLessThanOrEqual(7);
      for (const f of result.frames) {
        expect(
          Object.values(f).every(
            (v) => typeof v === 'string' || typeof v === 'number',
          ),
        ).toBe(true);
        frames.push(f);
        if (f.protocol === COPILOT_HANDOFF_PROTOCOL) {
          const parsed = parseCopilotHandoffFrame(f);
          const event =
            parsed.type === 'terminal'
              ? 'pre-ingress'
              : CopilotHandoffActionSchema.parse(JSON.parse(parsed.payload))
                  .kind;
          const cleanupAction =
            parsed.type === 'action'
              ? CopilotHandoffActionSchema.parse(JSON.parse(parsed.payload))
              : undefined;
          const edge =
            cleanupAction?.kind === 'cleanup'
              ? `cleanup-${cleanupAction.step}`
              : event;
          if (parsed.type === 'action') {
            lastAction = edge;
            await onHostAction?.(edge);
          }
          if (edge === interruptAt) {
            interruptAt = undefined;
            throw new Error('injected lost response');
          }
        }
      }
      return result;
    },
  });
}
beforeEach(async () => {
  readCopilotCredential = initialReadCredential;
  readPreferencesFile = initialReadPreferences;
  readCopilotSelectionPreferences = initialReadSelection;
  updatePreferencesFile = initialUpdatePreferences;
  flushPreferencesWrites = initialFlushPreferences;
  observeCopilotSelectionAuthority = initialObserveSelection;
  previousHostOwner = undefined;
  migrationEpoch = 1;
  mockCleanupFault = undefined;
  mockOnClaimDirectorySync = undefined;
  useFault = undefined;
  replayCompletion = undefined;
  refreshForUse = false;
  refreshCalls = 0;
  discoveryCalls = 0;
  onChannelRead = undefined;
  mockDecryptFails = false;
  mockPreferenceWriteFails = false;
  onSetupPrepare = undefined;
  onSetupPredecessor = undefined;
  onOrdinaryAuthorityRead = undefined;
  mockOnControlRead = undefined;
  holdPut = undefined;
  onHostAction = undefined;
  onPut = undefined;
  onPutSettled = undefined;
  folder = storeFolder();
  slots = createFakeSecretProtection({ backend: 'macos_keychain' });
  dataRoot = join(getDataDir(), `p7-${folder.root.split('/').at(-1)}`);
  mockSource = join(folder.root, 'copilot-account.enc');
  await writeFile(mockSource, `synthetic:${JSON.stringify(grant)}`);
  await updatePreferencesFile(() => ({
    copilotVaultSelection: undefined,
    copilotAccount: undefined,
    copilotEnabled: false,
  }));
  await flushPreferencesWrites();
  interruptAt = undefined;
  useCommitFault = undefined;
  armedCommitFault = undefined;
  frames = [];
  await reopen();
  vault.openCopilotPilotState({
    kind: 'initialize-unused',
    hostFence: 'absent',
  });
});
afterEach(async () => {
  mockPreferenceWriteFails = false;
  mockPreferenceAckLost = false;
  core?.close();
  await main?.close();
  await closeEndpoint();
  endpoint = undefined;
  core = undefined;
  main = undefined;
  await flushPreferencesWrites();
  vault.dispose();
  store.close();
  folder.remove();
});
it('P8 round 2 retires a published import after rejected refresh deletes under the removal fence', async () => {
  await compose();
  await mainHost().connect();
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  const before = state.read();
  const head = before.authority.head;
  if (!head) throw new Error('Missing published account');
  let entered = (): void => undefined;
  const deleting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { createCopilotVaultGrantAuthority } =
    await import('@canopy/core-runtime/node/vault');
  const a = createCopilotVaultGrantAuthority({
    repository: () => Promise.resolve(vault.repository),
    writer: () =>
      Promise.resolve({
        ...state.writer,
        delete: async (request) => {
          entered();
          await held;
          return state.writer.delete(request);
        },
      }),
    journal: state.journal,
    probeKeyIfDue: () => vault.probeKeyIfDue(),
    probe: () => Promise.resolve(),
    now: () => Date.parse(grant.accessTokenExpiresAt) - 1000,
    refresh: () => Promise.resolve({ kind: 'rejected' }),
    selection: createCopilotSelectionReceipt(),
    recipient: {
      admitted: () => true,
      deliver: () => undefined,
      revoke: () => undefined,
    },
  });
  let retained = false;
  const cas = state.journal.compareExchange.bind(state.journal);
  jest
    .spyOn(state.journal, 'compareExchange')
    .mockImplementation(async (sequence, next) => {
      const result = await cas(sequence, next);
      if (result && next.removal) release();
      if (
        result &&
        next.head &&
        next.removal &&
        !next.mutation &&
        next.completed?.kind === 'delete'
      )
        retained = true;
      return result;
    });
  const presenting = a.present('round-2-recipient', head.epoch);
  await deleting;
  const removed = await a.remove(head.epoch);
  await presenting;
  expect(retained).toBe(true);
  expect(store.readEntry(head.pin.ref.entryId)).toBeNull();
  expect(removed).toEqual({ kind: 'removed' });
  expect(state.read().authority).toMatchObject({
    head: null,
    mutation: null,
    removal: null,
    completed: { kind: 'delete', epoch: head.epoch },
  });
  expect(state.read().binding?.phase).toBe('retired');
  expect(state.read().controls).toContainEqual(
    expect.objectContaining({
      kind: 'retirement',
      phase: 'retired',
      destination: head.pin,
    }),
  );
  expect(store.listIntents().filter((i) => i.kind === 'delete')).toHaveLength(
    1,
  );
  expect(await a.remove(head.epoch)).toEqual({ kind: 'removed' });
});

it.each(['success', 'failed-disable', 'abort', 'busy', 'busy-removal'])(
  'P8 round 2 Change account revalidates retirement before preparing its successor (%s)',
  async (admission) => {
    const generation = await retireForOrdinarySetup();
    const first = await pilotForSetup().setup(grant, generation);
    if (first.kind !== 'ready') throw new Error('Missing first setup');
    const { createCopilotVaultConnection } =
      await import('../main/copilot/vault-connection');
    const flag = await import('../main/copilot/feature-flag');
    const enabled = jest
      .spyOn(flag, 'assertCopilotHarnessEnabled')
      .mockImplementation(() => undefined);
    let authorized = 0;
    let holdStatus = false;
    let holdRemoval = false;
    let entered = (): void => undefined;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    function backend(): CopilotConnectionBackend {
      const pilot = pilotForSetup();
      return createCopilotVaultConnection({
        port: {
          status: async () => {
            if (holdStatus) {
              holdStatus = false;
              entered();
              await held;
            }
            return pilot.authority.status();
          },
          demand: () => pilot.demand(),
          recoverRuntimeReceipts: () => pilot.recoverRuntimeReceipts(),
          setup: (...args) => pilot.setup(...args),
          resume: (id) => pilot.authority.resume(id),
          cancel: (id) => pilot.authority.cancel(id),
          remove: async (epoch) => {
            if (holdRemoval) {
              holdRemoval = false;
              entered();
              await held;
            }
            return pilot.authority.remove(epoch);
          },
          removePending: (id) => pilot.removePending(id),
          revoke: () => pilot.revoke(),
          reopen: () => pilot.reopen(),
          close: () => pilot.close(),
          quiesce: () => pilot.quiesce(),
          projectPolicy: () => Promise.resolve('test-policy'),
          releasePolicy: () => undefined,
          open: (...args) => pilot.open(...args),
        },
        preferences: readCopilotSelectionPreferences,
        authorize: () => {
          authorized++;
          return Promise.resolve(grant);
        },
        installation: () =>
          Promise.resolve({
            supported: true,
            installed: true,
            version: 'test',
            enabled: false,
            phase: 'idle',
            account: null,
          }),
      });
    }
    let routed = connection(undefined, undefined, backend());
    try {
      if (admission === 'abort') {
        const controller = new AbortController();
        onOrdinaryAuthorityRead = (): Promise<void> => {
          onOrdinaryAuthorityRead = undefined;
          controller.abort(new Error('Abort during ordinary admission'));
          return Promise.resolve();
        };
        await expect(
          routed.facade.connectCopilot(
            controller.signal,
            () => undefined,
            true,
          ),
        ).rejects.toThrow('Abort during ordinary admission');
        expect(
          vault.openCopilotPilotState({ kind: 'existing' }).read().authority
            .head,
        ).toEqual(first.head);
        expect(store.readEntry(first.head.pin.ref.entryId)).not.toBeNull();
        expect(authorized).toBe(0);
        return;
      }
      if (admission === 'busy' || admission === 'busy-removal') {
        holdStatus = admission === 'busy';
        holdRemoval = admission === 'busy-removal';
        const connecting = routed.facade.connectCopilot(
          new AbortController().signal,
          () => undefined,
          holdRemoval,
        );
        await entering;
        try {
          await expect(
            routed.facade.connectCopilot(
              new AbortController().signal,
              () => undefined,
              true,
            ),
          ).rejects.toThrow('already in progress');
          expect(
            vault.openCopilotPilotState({ kind: 'existing' }).read().authority
              .head,
          ).toEqual(first.head);
          expect(store.readEntry(first.head.pin.ref.entryId)).not.toBeNull();
          expect(authorized).toBe(0);
        } finally {
          release();
          await connecting;
        }
        expect(await mainHost().ordinarySetup()).toBe(true);
        return;
      }
      if (admission === 'failed-disable') {
        mockPreferenceWriteFails = true;
        try {
          await expect(
            routed.facade.connectCopilot(
              new AbortController().signal,
              () => undefined,
              true,
            ),
          ).rejects.toThrow();
        } finally {
          mockPreferenceWriteFails = false;
        }
        expect(authorized).toBe(0);
        const state = vault.openCopilotPilotState({ kind: 'existing' }).read();
        expect(state.authority.head).toEqual(first.head);
        expect(state.authority.removal).toBeNull();
        expect(store.readEntry(first.head.pin.ref.entryId)).not.toBeNull();
        expect(await mainHost().ordinarySetup()).toBe(false);
        await expect(mainHost().custody()).rejects.toThrow(
          'Host receipt changed.',
        );
        await expect(mainHost().custody()).rejects.toThrow('unavailable');
        expect(
          vault.openCopilotPilotState({ kind: 'existing' }).read(),
        ).toEqual(state);
        coreHost().close();
        await mainHost().close();
        await closeEndpoint();
        await reopen();
        await compose();
        expect(await mainHost().ordinarySetup()).toBe(true);
        routed = connection(undefined, undefined, backend());
      }
      await expect(
        routed.facade.connectCopilot(
          new AbortController().signal,
          () => undefined,
          true,
        ),
      ).resolves.toMatchObject({ phase: 'connected' });
      expect(authorized).toBe(1);
      expect(routed.legacyCalls()).toBe(0);
      await expect(mainHost().custody()).resolves.toBe('pending');
      expect(await mainHost().ordinarySetup()).toBe(true);
      const selected = (await readCopilotSelectionPreferences())
        .copilotVaultSelection;
      expect(selected?.state).toBe('selected');
      expect(selected?.identity.epoch).not.toBe(first.head.epoch);
      expect(selected?.identity.operationId).not.toBe(first.head.operationId);
    } finally {
      enabled.mockRestore();
    }
  },
);

it('P8 published clear with definite preference failure preserves the destination and reversible published history', async () => {
  await compose();
  await mainHost().connect();
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  const before = state.read();
  if (!before.authority.head) throw new Error('Missing published account');
  mockPreferenceWriteFails = true;
  await expect(mainHost().connect(true)).rejects.toThrow();
  expect(store.readEntry(before.authority.head.pin.ref.entryId)).not.toBeNull();
  expect(state.read().binding?.phase).toBe('published');
  expect(state.read().authority.removal).toBeNull();
});

async function retireForOrdinarySetup(): Promise<string> {
  await compose();
  await mainHost().connect();
  await mainHost().verify();
  await mainHost().cleanup();
  await mainHost().connect(true);
  const disabled = (await readCopilotSelectionPreferences())
    .copilotVaultSelection;
  if (!disabled) throw new Error('Missing retired import receipt');
  expect(await mainHost().ordinarySetup()).toBe(true);
  return disabled.pinGeneration;
}
it.each(
  (['disconnect', 'change-account'] as const).flatMap((removal) =>
    [
      { scenario: 'definite failure then retry', faults: ['definite', 'none'] },
      {
        scenario: 'acknowledgement-loss successor',
        faults: ['acknowledgement'],
      },
      { scenario: 'repeated successful B to C', faults: ['none', 'none'] },
    ].map((scenario) => ({ removal, ...scenario })),
  ),
)(
  'P8 routed lineage oracle: $removal with prepare polling and $scenario',
  async ({ removal, faults }) => {
    const generation = await retireForOrdinarySetup();
    const a = await pilotForSetup().setup(grant, generation);
    if (a.kind !== 'ready') throw new Error('Missing A');
    expect(await mainHost().ordinarySetup()).toBe(true);
    await writeFile(mockSource, 'unrelated-new-legacy-file');
    const { createCopilotVaultConnection } =
      await import('../main/copilot/vault-connection');
    const flag = await import('../main/copilot/feature-flag');
    const enabled = jest
      .spyOn(flag, 'assertCopilotHarnessEnabled')
      .mockImplementation(() => undefined);
    const pilot = pilotForSetup();
    const backend = createCopilotVaultConnection({
      port: {
        ...pilot,
        status: () => pilot.authority.status(),
        resume: (id) => pilot.authority.resume(id),
        cancel: (id) => pilot.authority.cancel(id),
        remove: (epoch) => pilot.authority.remove(epoch),
        projectPolicy: () => Promise.resolve('test-policy'),
        releasePolicy: () => undefined,
      },
      preferences: readCopilotSelectionPreferences,
      authorize: () => Promise.resolve(grant),
      installation: (): Promise<CopilotConnectionStatus> =>
        Promise.resolve({
          supported: true,
          installed: true,
          enabled: false,
          phase: 'idle',
          version: 'fixture',
        }),
    });
    const routed = connection(undefined, undefined, backend);
    try {
      let prior = a.head;
      for (const fault of faults) {
        if (removal === 'disconnect') await routed.facade.disconnectCopilot();
        let polledStatus: CopilotConnectionStatus | undefined;
        onSetupPrepare = async (): Promise<void> => {
          onSetupPrepare = undefined;
          polledStatus = await routed.facade.copilotConnectionStatus();
          mockPreferenceWriteFails = fault === 'definite';
          mockPreferenceAckLost = fault === 'acknowledgement';
        };
        const connect = (): Promise<CopilotConnectionStatus> =>
          routed.facade.connectCopilot(
            new AbortController().signal,
            () => undefined,
            removal === 'change-account',
          );
        if (fault === 'definite') {
          await expect(connect()).rejects.toThrow();
          expect(polledStatus).toMatchObject({ supported: true });
          mockPreferenceWriteFails = false;
          expect(await mainHost().ordinarySetup()).toBe(true);
          continue;
        }
        await expect(connect()).resolves.toMatchObject({ phase: 'connected' });
        expect(polledStatus).toMatchObject({ supported: true });
        const selected = (await readCopilotSelectionPreferences())
          .copilotVaultSelection;
        const head = vault.openCopilotPilotState({ kind: 'existing' }).read()
          .authority.head;
        if (!head) throw new Error('Missing successor');
        expect(head.epoch).not.toBe(prior.epoch);
        expect(head.operationId).not.toBe(prior.operationId);
        expect(selected?.pinGeneration).not.toBe(prior.pinGeneration);
        prior = head;
        expect(await mainHost().ordinarySetup()).toBe(true);
      }
      expect(await readFile(mockSource, 'utf8')).toBe(
        'unrelated-new-legacy-file',
      );
    } finally {
      enabled.mockRestore();
    }
  },
);
async function retiredSetupPredecessor(): Promise<
  NonNullable<
    Awaited<
      ReturnType<typeof readCopilotSelectionPreferences>
    >['copilotVaultSelection']
  >
> {
  const generation = await retireForOrdinarySetup();
  const created = await pilotForSetup().setup(grant, generation);
  if (created.kind !== 'ready') throw new Error('Missing setup predecessor');
  expect(await mainHost().ordinarySetup()).toBe(true);
  expect(await pilotForSetup().authority.remove(created.head.epoch)).toEqual({
    kind: 'removed',
  });
  expect(await mainHost().ordinarySetup()).toBe(true);
  const predecessor = (await readCopilotSelectionPreferences())
    .copilotVaultSelection;
  if (
    !predecessor ||
    predecessor.identity.origin !== 'setup' ||
    predecessor.state !== 'disabled'
  )
    throw new Error('Missing disabled setup predecessor');
  return predecessor;
}

it('P8 lineage oracle: v2 retains predecessor facts after an unprepared successor cancellation overwrites completion', async () => {
  const predecessor = await retiredSetupPredecessor();
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  expect(state.read().authority.completed?.epoch).toBe(
    predecessor.identity.epoch,
  );
  let successor: { operationId: string; epoch: string } | undefined;
  onSetupPrepare = (): Promise<void> => {
    onSetupPrepare = undefined;
    const mutation = state.read().authority.mutation;
    if (!mutation) throw new Error('Missing successor intent');
    successor = { operationId: mutation.operationId, epoch: mutation.epoch };
    return Promise.resolve();
  };
  mockPreferenceWriteFails = true;
  const failed = await pilotForSetup().setup(grant, predecessor.pinGeneration);
  mockPreferenceWriteFails = false;
  expect(failed.kind).toBe('blocked');
  if (!successor) throw new Error('Successor did not reach prepare');
  const bundle = state.read();
  expect(bundle.authority).toMatchObject({
    head: null,
    mutation: null,
    removal: null,
    completed: {
      operationId: `${successor.operationId}:cancel`,
      epoch: successor.epoch,
      kind: 'delete',
    },
  });
  expect(
    (await readCopilotSelectionPreferences()).copilotVaultSelection,
  ).toEqual(predecessor);
  expect(bundle.authority).toMatchObject({
    version: 2,
    setupLineage: { predecessor, successor, phase: 'cancelled' },
  });
  expect(JSON.stringify(bundle)).toContain(predecessor.identity.epoch);
  expect(JSON.stringify(bundle)).toContain(predecessor.pinGeneration);
  expect(JSON.stringify(state.migration.read())).not.toContain(
    predecessor.identity.epoch,
  );
  expect(JSON.stringify(store.listIntents())).not.toContain(
    predecessor.identity.epoch,
  );
  const successorId = successor.operationId;
  expect(
    store.listIntents().some((i) => i.idempotencyKey === successorId),
  ).toBe(false);
});

it.each(['valid', 'foreign-epoch'])(
  'P8 lineage oracle: reconstruct after unprepared successor cancellation (%s)',
  async (damage) => {
    const predecessor = await retiredSetupPredecessor();
    mockPreferenceWriteFails = true;
    const failed = await pilotForSetup().setup(
      grant,
      predecessor.pinGeneration,
    );
    mockPreferenceWriteFails = false;
    expect(failed.kind).toBe('blocked');
    const retained = vault.openCopilotPilotState({ kind: 'existing' }).read();
    expect(retained.authority.completed?.operationId).toMatch(/:cancel$/);
    expect(retained.authority.completed?.epoch).not.toBe(
      predecessor.identity.epoch,
    );
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    if (damage === 'foreign-epoch') {
      await updatePreferencesFile(() => ({
        copilotVaultSelection: {
          ...predecessor,
          identity: {
            ...predecessor.identity,
            epoch: 'foreign-predecessor-epoch',
          },
        },
      }));
    }
    await compose();
    expect(vault.openCopilotPilotState({ kind: 'existing' }).read()).toEqual(
      retained,
    );
    expect(await mainHost().ordinarySetup()).toBe(damage === 'valid');
    if (damage === 'valid') {
      expect(
        (await pilotForSetup().setup(grant, predecessor.pinGeneration)).kind,
      ).toBe('ready');
      expect(await mainHost().ordinarySetup()).toBe(true);
    } else {
      await updatePreferencesFile(() => ({
        copilotVaultSelection: predecessor,
      }));
      expect(await mainHost().ordinarySetup()).toBe(false);
      await expect(mainHost().custody()).rejects.toThrow('unavailable');
    }
  },
);

it('P8 lineage oracle: crash before successor prepare recovers the exact predecessor and retries', async () => {
  const predecessor = await retiredSetupPredecessor();
  let admittedBefore: boolean | undefined;
  let resumed: unknown;
  let admittedAfter: boolean | undefined;
  onSetupPrepare = async (): Promise<void> => {
    onSetupPrepare = undefined;
    const pending = vault.openCopilotPilotState({ kind: 'existing' }).read()
      .authority.mutation;
    if (!pending) throw new Error('Missing successor');
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    admittedBefore = await mainHost().ordinarySetup();
    resumed = await pilotForSetup().authority.resume(pending.operationId);
    admittedAfter = await mainHost().ordinarySetup();
    throw new Error('Synthetic previous process ended');
  };
  expect(
    (await pilotForSetup().setup(grant, predecessor.pinGeneration)).kind,
  ).not.toBe('ready');
  expect(admittedBefore).toBe(true);
  expect(resumed).toEqual({ kind: 'removed' });
  expect(admittedAfter).toBe(true);
  expect(
    (await pilotForSetup().setup(grant, predecessor.pinGeneration)).kind,
  ).toBe('ready');
  expect(await mainHost().ordinarySetup()).toBe(true);
});

it('P8 witness oracle: cancellation keeps an authenticated versioned predecessor and rejects tampering and v1 relabelling', async () => {
  const predecessor = await retiredSetupPredecessor();
  mockPreferenceWriteFails = true;
  expect(
    (await pilotForSetup().setup(grant, predecessor.pinGeneration)).kind,
  ).toBe('blocked');
  mockPreferenceWriteFails = false;
  const retained = vault.openCopilotPilotState({ kind: 'existing' }).read();
  expect(retained).toMatchObject({
    version: 2,
    authority: {
      version: 2,
      setupLineage: {
        version: 1,
        predecessor,
        phase: 'cancelled',
      },
    },
  });
  expect(
    CopilotAuthorityRecordSchema.safeParse({
      ...retained.authority,
      version: 1,
    }).success,
  ).toBe(false);
  const stored = store.readCopilotAuthority();
  if (!stored) throw new Error('Missing authenticated authority');
  // Change authenticated bytes, not a trusted journal projection.
  const damaged = stored.replace(
    predecessor.identity.epoch,
    'tampered-predecessor',
  );
  expect(damaged).not.toBe(stored);
  expect(
    store.writeCopilotAuthority({ expected: stored, next: damaged }).kind,
  ).toBe('written');
  expect(() =>
    vault.openCopilotPilotState({ kind: 'existing' }).read(),
  ).toThrow();
});

it('P8 improver stale-authority oracle: an unprepared cancellation cannot let an older admission interrupt its successor', async () => {
  const predecessor = await retiredSetupPredecessor();
  let releasePrepare = (): void => undefined;
  const paused = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });
  let enterPrepare = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    enterPrepare = resolve;
  });
  onSetupPrepare = async (): Promise<void> => {
    onSetupPrepare = undefined;
    enterPrepare();
    await paused;
  };
  const pilot = pilotForSetup();
  const setup = pilot.setup(grant, predecessor.pinGeneration);
  await entered;
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  const mutation = state.read().authority.mutation;
  if (!mutation) throw new Error('Missing unprepared successor');
  try {
    expect(await mainHost().ordinarySetup()).toBe(true);
    let reads = 0;
    let cancellation:
      | Awaited<ReturnType<typeof pilot.authority.cancel>>
      | undefined;
    let newerAdmission: boolean | undefined;
    mockOnControlRead = async (): Promise<void> => {
      if (++reads !== 2) return;
      mockOnControlRead = undefined;
      cancellation = await pilot.authority.cancel(mutation.operationId);
      newerAdmission = await mainHost().ordinarySetup();
    };
    const staleAdmission = await mainHost().ordinarySetup();
    expect(cancellation).toEqual({ kind: 'removed' });
    expect(newerAdmission).toBe(true);
    expect(
      (await readCopilotSelectionPreferences()).copilotVaultSelection,
    ).toEqual(predecessor);
    expect(staleAdmission).toBe(false);
    expect(await mainHost().ordinarySetup()).toBe(true);
  } finally {
    mockOnControlRead = undefined;
    await mainHost().close();
    releasePrepare();
    await setup;
  }
});

it('P8 improver witness oracle: interrupted predecessor cannot be authenticated by an already-entered create', async () => {
  const predecessor = await retiredSetupPredecessor();
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  const original = state.read();
  const foreign = {
    ...predecessor,
    pinGeneration: 'foreign-predecessor-nonce',
  };
  let entered = false;
  onSetupPredecessor = async (): Promise<void> => {
    onSetupPredecessor = undefined;
    entered = true;
    await updatePreferencesFile(() => ({ copilotVaultSelection: foreign }));
  };
  const result = await pilotForSetup().setup(grant, predecessor.pinGeneration);
  expect(entered).toBe(true);
  expect(result.kind).not.toBe('ready');
  expect(state.read()).toEqual(original);
  expect(await mainHost().ordinarySetup()).toBe(false);
});

it.each(['account', 'nonce', 'pin'] as const)(
  'P8 improver oracle: reconstructed pending import predecessor matches its witness (%s)',
  async (damage) => {
    await retireForOrdinarySetup();
    const predecessor = (await readCopilotSelectionPreferences())
      .copilotVaultSelection;
    if (!predecessor?.pin) throw new Error('Missing import predecessor');
    const foreign = {
      account: {
        ...predecessor,
        identity: {
          ...predecessor.identity,
          account: {
            ...predecessor.identity.account,
            login: 'foreign-predecessor',
          },
        },
      },
      nonce: { ...predecessor, pinGeneration: 'foreign-predecessor' },
      pin: {
        ...predecessor,
        pin: { ...predecessor.pin, revision: predecessor.pin.revision + 1 },
      },
    }[damage];
    let admitted: boolean | undefined;
    let restored: boolean | undefined;
    let observedPredecessor: unknown;
    let selectedAtAdmission: unknown;
    onSetupPrepare = async (): Promise<void> => {
      onSetupPrepare = undefined;
      const authority = vault
        .openCopilotPilotState({ kind: 'existing' })
        .read().authority;
      observedPredecessor = authority.setupLineage?.predecessor;
      coreHost().close();
      await mainHost().close();
      await closeEndpoint();
      await reopen();
      await updatePreferencesFile(() => ({ copilotVaultSelection: foreign }));
      await compose();
      selectedAtAdmission = (await readCopilotSelectionPreferences())
        .copilotVaultSelection;
      admitted = await mainHost().ordinarySetup();
      await updatePreferencesFile(() => ({
        copilotVaultSelection: predecessor,
      }));
      restored = await mainHost().ordinarySetup();
      throw new Error('Synthetic previous process ended');
    };
    expect(
      (await pilotForSetup().setup(grant, predecessor.pinGeneration)).kind,
    ).not.toBe('ready');
    expect(observedPredecessor).toEqual(predecessor);
    expect(selectedAtAdmission).toEqual(foreign);
    expect(admitted).toBe(false);
    expect(restored).toBe(false);
  },
);

it('P8 lineage oracle: disabled predecessor loss fences a successor already awaiting prepare', async () => {
  const predecessor = await retiredSetupPredecessor();
  let admitted: boolean | undefined;
  onSetupPrepare = async (): Promise<void> => {
    onSetupPrepare = undefined;
    await updatePreferencesFile(() => ({
      copilotVaultSelection: {
        ...predecessor,
        identity: {
          ...predecessor.identity,
          account: {
            ...predecessor.identity.account,
            login: 'foreign-predecessor',
          },
        },
      },
    }));
    admitted = await mainHost().ordinarySetup();
    await updatePreferencesFile(() => ({ copilotVaultSelection: predecessor }));
  };
  expect(
    (await pilotForSetup().setup(grant, predecessor.pinGeneration)).kind,
  ).not.toBe('ready');
  expect(admitted).toBe(false);
  expect(await mainHost().ordinarySetup()).toBe(false);
});

it('P8 lineage oracle: committed cancellation retains routing while its exact delete is pending', async () => {
  const predecessor = await retiredSetupPredecessor();
  onPutSettled = (): void => {
    onPutSettled = undefined;
    mockPreferenceWriteFails = true;
  };
  const pending = await pilotForSetup().setup(grant, predecessor.pinGeneration);
  mockPreferenceWriteFails = false;
  expect(pending).toMatchObject({ kind: 'blocked', reason: 'unconfirmed' });
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  const owned = state.read().authority.mutation;
  if (!owned?.committed) throw new Error('Missing committed setup');
  expect(state.read().authority.mutation?.committed).not.toBeNull();
  const compare = state.journal.compareExchange.bind(state.journal);
  let polled = false;
  jest
    .spyOn(state.journal, 'compareExchange')
    .mockImplementation(async (sequence, next) => {
      const saved = await compare(sequence, next);
      if (
        saved &&
        next.mutation?.kind === 'delete' &&
        next.mutation.operationId === `${owned.operationId}:cancel`
      ) {
        expect(
          (await readCopilotSelectionPreferences()).copilotVaultSelection
            ?.state,
        ).toBe('disabled');
        expect(await mainHost().ordinarySetup()).toBe(true);
        polled = true;
      }
      return saved;
    });
  expect(await pilotForSetup().authority.cancel(owned.operationId)).toEqual({
    kind: 'removed',
  });
  expect(polled).toBe(true);
  expect(await mainHost().ordinarySetup()).toBe(true);
});

it.each(['operation', 'epoch', 'account', 'nonce', 'pin', 'absent'] as const)(
  'P8 lineage oracle: disabled predecessor L01 is permanent (%s)',
  async (damage) => {
    const predecessor = await retiredSetupPredecessor();
    if (!predecessor.pin) throw new Error('Missing retired setup pin');
    const foreign = {
      operation: {
        ...predecessor,
        identity: {
          ...predecessor.identity,
          operationId: 'foreign-predecessor',
        },
      },
      epoch: {
        ...predecessor,
        identity: { ...predecessor.identity, epoch: 'foreign-epoch' },
      },
      account: {
        ...predecessor,
        identity: {
          ...predecessor.identity,
          account: { ...predecessor.identity.account, login: 'foreign-login' },
        },
      },
      nonce: { ...predecessor, pinGeneration: 'foreign-predecessor-nonce' },
      pin: {
        ...predecessor,
        pin: {
          ...predecessor.pin,
          ref: { ...predecessor.pin.ref, entryId: 'foreign-predecessor-entry' },
        },
      },
      absent: undefined,
    }[damage];
    const retained = vault.openCopilotPilotState({ kind: 'existing' }).read();
    await updatePreferencesFile(() => ({
      copilotVaultSelection: foreign,
      copilotEnabled: false,
    }));
    expect(await mainHost().ordinarySetup()).toBe(false);
    await updatePreferencesFile(() => ({ copilotVaultSelection: predecessor }));
    expect(await mainHost().ordinarySetup()).toBe(false);
    await expect(mainHost().custody()).rejects.toThrow('unavailable');
    expect(vault.openCopilotPilotState({ kind: 'existing' }).read()).toEqual(
      retained,
    );
  },
);

it.each([
  ...(
    ['valid', 'operation', 'account', 'nonce', 'pin', 'revision'] as const
  ).map((damage) => ({ origin: 'setup' as const, damage })),
  // The handoff binding already pins an import's operation and epoch.
  ...(['valid', 'account', 'nonce', 'pin'] as const).map((damage) => ({
    origin: 'import' as const,
    damage,
  })),
])(
  'P8 lineage oracle: restart after a completed $origin delete admits only the exact retired receipt ($damage)',
  async ({ origin, damage }) => {
    let predecessor: Awaited<ReturnType<typeof retiredSetupPredecessor>>;
    if (origin === 'setup') predecessor = await retiredSetupPredecessor();
    else {
      await retireForOrdinarySetup();
      const retiredImport = (await readCopilotSelectionPreferences())
        .copilotVaultSelection;
      if (!retiredImport) throw new Error('Missing retired import receipt');
      predecessor = retiredImport;
    }
    const pin = predecessor.pin;
    if (!pin) throw new Error('Missing retired pin');
    expect(predecessor).toMatchObject({
      state: 'disabled',
      identity: { origin },
    });
    const retained = vault.openCopilotPilotState({ kind: 'existing' }).read();
    // Every row keeps the retired epoch: only exact identity may bind it.
    const foreign = {
      valid: predecessor,
      operation: {
        ...predecessor,
        identity: { ...predecessor.identity, operationId: 'foreign-operation' },
      },
      account: {
        ...predecessor,
        identity: {
          ...predecessor.identity,
          account: { ...predecessor.identity.account, login: 'foreign-login' },
        },
      },
      nonce: { ...predecessor, pinGeneration: 'foreign-nonce' },
      pin: {
        ...predecessor,
        pin: { ...pin, ref: { ...pin.ref, entryId: 'foreign-entry' } },
      },
      revision: { ...predecessor, pin: { ...pin, revision: pin.revision + 1 } },
    }[damage];
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await updatePreferencesFile(() => ({
      copilotVaultSelection: foreign,
      copilotEnabled: false,
    }));
    await compose();
    const observed = {
      retained: vault.openCopilotPilotState({ kind: 'existing' }).read(),
      admitted: await mainHost().ordinarySetup(),
      setup: (await pilotForSetup().setup(grant, foreign.pinGeneration)).kind,
    };
    expect(observed).toEqual({
      retained,
      admitted: damage === 'valid',
      setup: damage === 'valid' ? 'ready' : 'blocked',
    });
    expect(retained.authority).toMatchObject({
      version: 2,
      head: null,
      mutation: null,
      removal: null,
      completed: { kind: 'delete', epoch: predecessor.identity.epoch },
      setupLineage: {
        version: 1,
        phase: 'retired',
        predecessor,
        successor: {
          operationId: retained.authority.completed?.operationId,
          epoch: predecessor.identity.epoch,
        },
      },
    });
    if (damage === 'valid') {
      expect(await mainHost().ordinarySetup()).toBe(true);
      return;
    }
    expect(vault.openCopilotPilotState({ kind: 'existing' }).read()).toEqual(
      retained,
    );
    // L01: a refused reconstruction stays refused for this lineage instance.
    await updatePreferencesFile(() => ({ copilotVaultSelection: predecessor }));
    expect(await mainHost().ordinarySetup()).toBe(false);
  },
);

it.each([
  'valid',
  'operation',
  'epoch',
  'account',
  'nonce',
  'pin',
  'origin',
  'enabled',
] as const)(
  'P8 lineage oracle: restart after a cancelled successor admits only its exact surviving receipt (%s)',
  async (damage) => {
    const predecessor = await retiredSetupPredecessor();
    const pin = predecessor.pin;
    if (!pin) throw new Error('Missing retired pin');
    useFault = 'provider';
    const cancelled = (
      await pilotForSetup().setup(grant, predecessor.pinGeneration)
    ).kind;
    useFault = undefined;
    const survivor = (await readCopilotSelectionPreferences())
      .copilotVaultSelection;
    if (!survivor) throw new Error('Missing surviving receipt');
    const retained = vault.openCopilotPilotState({ kind: 'existing' }).read();
    // Each damaged row changes one field of the successor's own receipt.
    const foreign = {
      valid: survivor,
      operation: {
        ...survivor,
        identity: { ...survivor.identity, operationId: 'foreign-operation' },
      },
      epoch: {
        ...survivor,
        identity: { ...survivor.identity, epoch: 'foreign-epoch' },
      },
      account: {
        ...survivor,
        identity: {
          ...survivor.identity,
          account: { ...survivor.identity.account, login: 'foreign-login' },
        },
      },
      nonce: { ...survivor, pinGeneration: 'foreign-nonce' },
      pin: { ...survivor, pin },
      origin: {
        ...survivor,
        identity: { ...survivor.identity, origin: 'import' as const },
      },
      enabled: survivor,
    }[damage];
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await updatePreferencesFile(() => ({
      copilotVaultSelection: foreign,
      copilotEnabled: damage === 'enabled',
    }));
    await compose();
    const observed = {
      cancelled: cancelled !== 'ready',
      survivor: {
        state: survivor.state,
        isSuccessor:
          survivor.identity.operationId !== predecessor.identity.operationId,
        pin: survivor.pin,
      },
      phase: retained.authority.setupLineage?.phase,
      witnessPredecessor: retained.authority.setupLineage?.predecessor,
      retained: vault.openCopilotPilotState({ kind: 'existing' }).read(),
      admitted: await mainHost().ordinarySetup(),
      setup: (await pilotForSetup().setup(grant, foreign.pinGeneration)).kind,
    };
    expect(observed).toEqual({
      cancelled: true,
      survivor: { state: 'disabled', isSuccessor: true, pin: null },
      phase: 'cancelled',
      witnessPredecessor: survivor,
      retained,
      admitted: damage === 'valid',
      setup: damage === 'valid' ? 'ready' : 'blocked',
    });
    if (damage === 'valid') {
      expect(await mainHost().ordinarySetup()).toBe(true);
      return;
    }
    expect(vault.openCopilotPilotState({ kind: 'existing' }).read()).toEqual(
      retained,
    );
    // L01: a refused reconstruction stays refused for this lineage instance.
    await updatePreferencesFile(() => ({
      copilotVaultSelection: survivor,
      copilotEnabled: false,
    }));
    expect(await mainHost().ordinarySetup()).toBe(false);
  },
);

it.each(['poll', 'save-failure', 'cancel-intermediate'])(
  'P8 live lineage oracle: repeated setup remains owned through %s',
  async (edge) => {
    const predecessor = await retiredSetupPredecessor();
    const state = vault.openCopilotPilotState({ kind: 'existing' });
    let observed = false;
    if (edge === 'poll') {
      onSetupPrepare = async (): Promise<void> => {
        onSetupPrepare = undefined;
        expect(await mainHost().ordinarySetup()).toBe(true);
        observed = true;
      };
    } else if (edge === 'save-failure') {
      mockPreferenceWriteFails = true;
    } else {
      useFault = 'provider';
      const compare = state.journal.compareExchange.bind(state.journal);
      jest
        .spyOn(state.journal, 'compareExchange')
        .mockImplementation(async (sequence, next) => {
          if (
            !observed &&
            !next.head &&
            !next.mutation &&
            next.completed?.operationId.endsWith(':cancel')
          ) {
            const current = state.read().authority.mutation;
            expect(current).toMatchObject({ kind: 'create', cancelling: true });
            expect(
              (await readCopilotSelectionPreferences()).copilotVaultSelection
                ?.state,
            ).toBe('disabled');
            expect(await mainHost().ordinarySetup()).toBe(true);
            observed = true;
          }
          return compare(sequence, next);
        });
    }
    const result = await pilotForSetup().setup(
      grant,
      predecessor.pinGeneration,
    );
    mockPreferenceWriteFails = false;
    useFault = undefined;
    if (edge === 'poll') {
      expect(result.kind).toBe('ready');
      if (result.kind !== 'ready') throw new Error('Missing successor');
      expect(await mainHost().ordinarySetup()).toBe(true);
      expect(await pilotForSetup().authority.remove(result.head.epoch)).toEqual(
        { kind: 'removed' },
      );
    } else expect(result.kind).not.toBe('ready');
    expect(edge === 'save-failure' || observed).toBe(true);
    expect(await mainHost().ordinarySetup()).toBe(true);
    const disabled = (await readCopilotSelectionPreferences())
      .copilotVaultSelection;
    if (!disabled) throw new Error('Missing surviving receipt');
    expect(
      (await pilotForSetup().setup(grant, disabled.pinGeneration)).kind,
    ).toBe('ready');
    expect(await mainHost().ordinarySetup()).toBe(true);
  },
);

it('P8 review admits a status poll before ordinary setup prepares its receipt', async () => {
  const generation = await retireForOrdinarySetup();
  let polled = false;
  onSetupPrepare = async (): Promise<void> => {
    onSetupPrepare = undefined;
    const mutation = vault.openCopilotPilotState({ kind: 'existing' }).read()
      .authority.mutation;
    expect(mutation).toMatchObject({ kind: 'create', origin: 'setup' });
    expect(await mainHost().ordinarySetup()).toBe(true);
    polled = true;
  };
  expect((await pilotForSetup().setup(grant, generation)).kind).toBe('ready');
  expect(polled).toBe(true);
  expect(await mainHost().ordinarySetup()).toBe(true);
});
it('P8 lifetime oracle: submitted selection settlement stays unusable after real-store restart and P4 cleans it', async () => {
  const generation = await retireForOrdinarySetup();
  let entered = (): void => undefined;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  onSetupConfirm = async (): Promise<void> => {
    onSetupConfirm = undefined;
    entered();
    await held;
  };
  const pilot = pilotForSetup();
  const setup = pilot.setup(grant, generation);
  try {
    await entering;
    await pilot.quiesce();
    release();
    expect((await setup).kind).not.toBe('ready');
    expect((await readCopilotSelectionPreferences()).copilotEnabled).toBe(true);
    const before = vault.openCopilotPilotState({ kind: 'existing' }).read();
    const mutation = before.authority.mutation;
    if (!mutation?.committed) throw new Error('Missing committed setup intent');
    expect(before.authority.head).toBeNull();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    const admission = await mainHost().ordinarySetup();
    const custody = await mainHost()
      .custody()
      .catch(() => 'unavailable');
    const next = pilotForSetup();
    const demand = await next.authority.demand();
    const open = await next
      .open(
        'models',
        { kind: 'create', operationId: mutation.operationId },
        undefined,
        () => Promise.resolve(),
      )
      .then(
        (channel) => {
          channel.disconnect();
          return channel.opened.kind;
        },
        () => 'unavailable',
      );
    const cancelled = await next.authority.cancel(mutation.operationId);
    const after = vault.openCopilotPilotState({ kind: 'existing' }).read();
    expect({ admission, custody, demand, open, cancelled }).toEqual({
      admission: true,
      custody: 'pending',
      demand: { kind: 'blocked', reason: 'absent' },
      open: 'unavailable',
      cancelled: { kind: 'removed' },
    });
    expect(after.authority.head).toBeNull();
    expect(after.authority.mutation).toBeNull();
    expect(store.readEntry(mutation.committed.ref.entryId)).toBeNull();
    expect((await readCopilotSelectionPreferences()).copilotEnabled).toBe(
      false,
    );
    expect(
      store
        .listIntents()
        .filter(
          (intent) =>
            intent.kind === 'delete' &&
            intent.entryId === mutation.committed?.ref.entryId,
        ),
    ).toHaveLength(1);
  } finally {
    release();
    await setup;
    onSetupConfirm = undefined;
  }
});

it('P8 review reconstructs a crash before ordinary setup prepares its receipt', async () => {
  const generation = await retireForOrdinarySetup();
  let admitted: boolean | undefined;
  onSetupPrepare = async (): Promise<void> => {
    onSetupPrepare = undefined;
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    admitted = await mainHost().ordinarySetup();
    throw new Error('Synthetic setup process ended');
  };
  await pilotForSetup().setup(grant, generation);
  expect(admitted).toBe(true);
  expect(await mainHost().ordinarySetup()).toBe(true);
});
it('P8 review retries ordinary setup after definite preference failure and restart', async () => {
  const generation = await retireForOrdinarySetup();
  mockPreferenceWriteFails = true;
  const failed = await pilotForSetup().setup(grant, generation);
  mockPreferenceWriteFails = false;
  expect(failed.kind).toBe('blocked');
  const state = vault.openCopilotPilotState({ kind: 'existing' }).read();
  expect(state.authority.mutation).toBeNull();
  expect(state.authority.completed).toMatchObject({ kind: 'delete' });
  expect(await mainHost().ordinarySetup()).toBe(true);
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  await reopen();
  await compose();
  expect(await mainHost().ordinarySetup()).toBe(true);
  expect((await pilotForSetup().setup(grant, generation)).kind).toBe('ready');
  expect(await mainHost().ordinarySetup()).toBe(true);
});
it('P8 review observes setup selection loss without waiting for another admission', async () => {
  const generation = await retireForOrdinarySetup();
  expect((await pilotForSetup().setup(grant, generation)).kind).toBe('ready');
  expect(await mainHost().ordinarySetup()).toBe(true);
  const selected = (await readCopilotSelectionPreferences())
    .copilotVaultSelection;
  await updatePreferencesFile(() => ({ copilotVaultSelection: undefined }));
  await updatePreferencesFile(() => ({ copilotVaultSelection: selected }));
  expect(await mainHost().ordinarySetup()).toBe(false);
  await expect(mainHost().custody()).rejects.toThrow('unavailable');
});
it('P8 review refuses Connect when authority is lost during final control read', async () => {
  await retireForOrdinarySetup();
  const { getPreferencesFilePath } = await import('../main/lib/paths');
  const path = getPreferencesFilePath();
  const saved = await readFile(path);
  let reads = 0;
  let lost = false;
  const stop = observeCopilotSelectionAuthority((change) => {
    if (change.kind === 'unavailable') lost = true;
  });
  mockOnControlRead = async (): Promise<void> => {
    if (++reads !== 3) return; // custody, initial admission, final revalidation
    mockOnControlRead = undefined;
    await writeFile(path, '{');
    mockPreferenceWriteFails = true;
    try {
      await expect(readCopilotSelectionPreferences()).rejects.toThrow();
      await readPreferencesFile(); // Failed served-read recovery notifies authority loss.
      expect(lost).toBe(true);
    } finally {
      mockPreferenceWriteFails = false;
      await writeFile(path, saved);
    }
  };
  const setup = jest.fn(() => Promise.reject(new Error('Stale Connect ran')));
  const routed = connection(undefined, setup);
  try {
    await expect(
      routed.facade.connectCopilot(
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.not.toThrow('Stale Connect ran');
  } finally {
    stop();
  }
  expect(lost).toBe(true);
  expect(setup).not.toHaveBeenCalled();
});
it('P8 improver refuses stale prepared admission without retiring an owned publication', async () => {
  const generation = await retireForOrdinarySetup();
  let releasePut = (): void => undefined;
  const paused = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  let enteredPut = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    enteredPut = resolve;
  });
  holdPut = async (): Promise<void> => {
    holdPut = undefined;
    enteredPut();
    await paused;
  };
  const setup = pilotForSetup().setup(grant, generation);
  await entered;
  expect(await mainHost().ordinarySetup()).toBe(true);
  onOrdinaryAuthorityRead = async (): Promise<void> => {
    onOrdinaryAuthorityRead = undefined;
    releasePut();
    expect((await setup).kind).toBe('ready');
  };
  expect(await mainHost().ordinarySetup()).toBe(false);
  expect(await mainHost().ordinarySetup()).toBe(true);
});
it('P8 improver retains newer confirmation when stale completed-removal admission finishes', async () => {
  const generation = await retireForOrdinarySetup();
  const first = await pilotForSetup().setup(grant, generation);
  if (first.kind !== 'ready') throw new Error('Missing first setup');
  expect(await mainHost().ordinarySetup()).toBe(true);
  expect((await pilotForSetup().authority.remove(first.head.epoch)).kind).toBe(
    'removed',
  );
  let reads = 0;
  let overlapped = false;
  mockOnControlRead = async (): Promise<void> => {
    if (++reads !== 2) return;
    mockOnControlRead = undefined;
    // The older call has already validated the deleted authority snapshot.
    expect(await mainHost().ordinarySetup()).toBe(true);
    const disabled = (await readCopilotSelectionPreferences())
      .copilotVaultSelection;
    if (!disabled) throw new Error('Missing disabled setup');
    expect(
      (await pilotForSetup().setup(grant, disabled.pinGeneration)).kind,
    ).toBe('ready');
    expect(await mainHost().ordinarySetup()).toBe(true);
    overlapped = true;
  };
  await mainHost().ordinarySetup();
  expect(overlapped).toBe(true);
  const selected = (await readCopilotSelectionPreferences())
    .copilotVaultSelection;
  await updatePreferencesFile(() => ({ copilotVaultSelection: undefined }));
  await updatePreferencesFile(() => ({ copilotVaultSelection: selected }));
  expect(await mainHost().ordinarySetup()).toBe(false);
  await expect(mainHost().custody()).rejects.toThrow('unavailable');
});
it('P8 P4 completion against published binding retires head and binding together', async () => {
  await compose();
  await mainHost().connect();
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  const before = state.read();
  if (!before.authority.head) throw new Error('Missing published account');
  const { createCopilotVaultGrantAuthority } =
    await import('@canopy/core-runtime/node/vault');
  const a = createCopilotVaultGrantAuthority({
    repository: () => Promise.resolve(vault.repository),
    writer: () => Promise.resolve(state.writer),
    journal: state.journal,
    probeKeyIfDue: () => vault.probeKeyIfDue(),
    probe: () => Promise.resolve(),
    refresh: () => Promise.resolve({ kind: 'rejected' }),
    selection: createCopilotSelectionReceipt(),
    recipient: {
      admitted: () => true,
      deliver: () => undefined,
      revoke: () => undefined,
    },
  });
  expect(await a.remove(before.authority.head.epoch)).toEqual({
    kind: 'removed',
  });
  expect(state.read().authority.head).toBeNull();
  expect(state.read().binding?.phase).toBe('retired');
  expect(store.listIntents().filter((i) => i.kind === 'delete')).toHaveLength(
    1,
  );
});
it.each(['operation', 'epoch', 'nonce', 'entry', 'absent'] as const)(
  'P8 retired import uses a fresh ordinary setup after source cleanup without touching a replacement legacy file (%s receipt)',
  async (damage) => {
    await compose();
    await mainHost().connect();
    const original = (await readCopilotSelectionPreferences())
      .copilotVaultSelection;
    if (!original) throw new Error('Missing import receipt');
    await mainHost().verify();
    await mainHost().cleanup();
    await expect(readFile(mockSource)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    let partial = false;
    onHostAction = async (edge): Promise<void> => {
      if (edge !== 'freeze') return;
      expect(coreHost().retiredBinding()).not.toBeNull();
      expect(await mainHost().ordinarySetup()).toBe(false);
      partial = true;
    };
    await mainHost().connect(true);
    expect(partial).toBe(true);
    onHostAction = undefined;
    expect(await mainHost().ordinarySetup()).toBe(true);
    await writeFile(mockSource, 'new legacy bytes must not be read or deleted');
    const setup = jest.fn(async () => {
      const disabled = (await readCopilotSelectionPreferences())
        .copilotVaultSelection;
      if (!disabled) throw new Error('Missing disabled receipt');
      const created = await pilotForSetup().setup(
        grant,
        disabled.pinGeneration,
      );
      if (created.kind !== 'ready')
        throw new Error('Ordinary setup failed: ' + JSON.stringify(created));
      return {
        supported: true,
        installed: true,
        enabled: true,
        version: '1',
        phase: 'connected' as const,
        account: created.head.account,
      };
    });
    const routed = connection(undefined, setup);
    await expect(
      routed.facade.connectCopilot(
        new AbortController().signal,
        () => undefined,
      ),
    ).resolves.toMatchObject({ phase: 'connected' });
    expect(setup).toHaveBeenCalledTimes(1);
    expect(routed.legacyCalls()).toBe(0);
    const selected = (await readCopilotSelectionPreferences())
      .copilotVaultSelection;
    expect(selected?.state).toBe('selected');
    expect(selected?.identity.origin).toBe('setup');
    expect(selected?.identity.epoch).not.toBe(original.identity.epoch);
    expect(selected?.identity.operationId).not.toBe(
      original.identity.operationId,
    );
    expect(selected?.pinGeneration).not.toBe(original.pinGeneration);
    expect(await readFile(mockSource, 'utf8')).toBe(
      'new legacy bytes must not be read or deleted',
    );
    if (!selected?.pin) throw new Error('Missing setup pin');
    const retainedAuthority = vault
      .openCopilotPilotState({ kind: 'existing' })
      .read();
    const foreign = {
      operation: {
        ...selected,
        identity: { ...selected.identity, operationId: 'foreign-setup' },
      },
      epoch: {
        ...selected,
        identity: { ...selected.identity, epoch: original.identity.epoch },
      },
      nonce: { ...selected, pinGeneration: 'foreign-nonce' },
      entry: {
        ...selected,
        pin: {
          ...selected.pin,
          ref: { ...selected.pin.ref, entryId: 'foreign-entry' },
        },
      },
      absent: undefined,
    }[damage];
    await updatePreferencesFile(() => ({
      copilotVaultSelection: foreign,
      copilotEnabled: true,
    }));
    expect(await mainHost().ordinarySetup()).toBe(false);
    const refused = connection();
    await expect(refused.facade.copilotConnectionStatus()).rejects.toThrow(
      'unavailable',
    );
    expect(refused.legacyCalls()).toBe(0);
    expect(vault.openCopilotPilotState({ kind: 'existing' }).read()).toEqual(
      retainedAuthority,
    );
    await updatePreferencesFile(() => ({
      copilotVaultSelection: selected,
      copilotEnabled: true,
    }));
    expect(await mainHost().ordinarySetup()).toBe(false); // A revoked channel never reopens.
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    expect(await mainHost().ordinarySetup()).toBe(true);
    expect(
      (await readCopilotSelectionPreferences()).copilotVaultSelection,
    ).toEqual(selected);
    expect(vault.openCopilotPilotState({ kind: 'existing' }).read()).toEqual(
      retainedAuthority,
    );
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    expect(coreHost().current()).toBe(false);
    expect(await mainHost().ordinarySetup()).toBe(true);
    expect((await pilotForSetup().authority.status()).kind).toBe('ready');
    const messages: unknown[] = [];
    const audience = { kind: 'create' as const, operationId: 'post-import' };
    const channel = await pilotForSetup().open(
      'models',
      audience,
      undefined,
      (encoded) => {
        messages.push(JSON.parse(encoded));
        return Promise.resolve();
      },
    );
    if (channel.opened.kind !== 'opened')
      throw new Error('Reconstructed setup runtime unavailable');
    await channel.receive(
      JSON.stringify({
        requestId: 1,
        command: {
          version: 1,
          kind: 'run',
          handle: channel.opened.handle,
          generation: channel.opened.generation,
          purpose: 'models',
          audience,
        },
      }),
    );
    expect(
      messages
        .map((message) => CopilotLocalFrameSchema.parse(message))
        .find((frame) => frame.kind === 'response'),
    ).toMatchObject({ outcome: { kind: 'completed' } });
    channel.disconnect();
    expect(
      await pilotForSetup().authority.remove(selected.identity.epoch),
    ).toEqual({
      kind: 'removed',
    });
    expect(await mainHost().ordinarySetup()).toBe(true);
    expect(
      vault.openCopilotPilotState({ kind: 'existing' }).read().binding,
    ).toEqual(retainedAuthority.binding);
    expect(await readFile(mockSource, 'utf8')).toBe(
      'new legacy bytes must not be read or deleted',
    );
  },
);
it.each(['refresh', 'replace'] as const)(
  'P8 imported restart resolves %s before rebuilding publication without source recapture',
  async (kind) => {
    await compose();
    await mainHost().connect();
    await mainHost().verify();
    await mainHost().cleanup();
    const state = vault.openCopilotPilotState({ kind: 'existing' });
    const old = state.read().authority;
    const head = old.head;
    if (!head) throw new Error('Missing head');
    const operationId = 'P8-imported-local-' + kind;
    expect(
      await state.journal.compareExchange(old.sequence, {
        ...old,
        sequence: old.sequence + 1,
        mutation: {
          operationId,
          epoch: head.epoch,
          origin: head.origin,
          account: head.account,
          kind,
          from: head.pin,
          committed: null,
          probeConfirmed: true,
          cancelling: false,
        },
      }),
    ).toBe(true);
    if (kind === 'replace') {
      const result = await state.writer.put({
        ref: head.pin.ref,
        expectedRevision: head.pin.revision,
        idempotencyKey: operationId,
        label: 'Copilot',
        material: Buffer.from(
          JSON.stringify({
            ...grant,
            accessToken: 'synthetic-successor-access',
          }),
        ),
        expiresAt: null,
      });
      expect(result.kind).toBe('committed');
    }
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    const before = vault.openCopilotPilotState({ kind: 'existing' }).read();
    expect(coreHost().current()).toBe(false);
    expect(before.authority.mutation?.operationId).toBe(operationId);
    const providerCount = refreshCalls;
    await expect(mainHost().connect()).resolves.toBeDefined();
    const recovered = vault.openCopilotPilotState({ kind: 'existing' }).read();
    expect(recovered.authority.mutation).toBeNull();
    expect(recovered.authority.head?.pin.revision).toBe(
      head.pin.revision + (kind === 'replace' ? 1 : 0),
    );
    expect(coreHost().current()).toBe(true);
    expect(refreshCalls).toBe(providerCount);
    expect(store.listIntents().filter((i) => i.kind === 'delete')).toHaveLength(
      0,
    );
    await expect(readFile(mockSource)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);
function connection(
  open?: CopilotConnectionBackend['openManagedCopilotRuntime'],
  setup?: CopilotConnectionBackend['connectCopilot'],
  vaultBackend?: CopilotConnectionBackend,
): {
  facade: CopilotConnectionBackend;
  legacyCalls(): number;
} {
  let calls = 0;
  const status: CopilotConnectionStatus = {
    supported: true,
    installed: true,
    enabled: true,
    version: 'qualification',
    phase: 'connected',
    account: { host: grant.host, login: grant.login },
  };
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error('Not a recipient-use fixture.'));
  const selected: CopilotConnectionBackend = {
    copilotConnectionStatus: () => Promise.resolve(status),
    openManagedCopilotRuntime: open ?? unavailable,
    connectCopilot: setup ?? (() => Promise.resolve(status)),
    disconnectCopilot: () => Promise.resolve(),
    listCopilotModels: unavailable,
    readCopilotAccountUsage: unavailable,
    revokeCopilotRuntimes: () => Promise.resolve(),
    shutdownCopilotRuntimes: () => Promise.resolve(),
    recoverCopilotAtStartup: () => Promise.resolve(),
  };
  const legacy: CopilotConnectionBackend = {
    ...selected,
    revokeCopilotRuntimes: (): Promise<void> => {
      calls++;
      return Promise.resolve();
    },
    shutdownCopilotRuntimes: (): Promise<void> => {
      calls++;
      return Promise.resolve();
    },
    connectCopilot: (): Promise<never> => {
      calls++;
      return Promise.reject(new Error('Device flow forbidden.'));
    },
    recoverCopilotAtStartup: (): Promise<void> => {
      calls++;
      return Promise.resolve();
    },
  };
  return {
    facade: createCopilotQualificationConnection({
      handoff: mainHost(),
      legacy,
      vault: vaultBackend ?? selected,
      agreed: () =>
        coreHost().current() || coreHost().retiredBinding() !== null,
      closeAdmission: (): void => undefined,
    }),
    legacyCalls: (): number => calls,
  };
}
it('Bridge/Pre-ingress/Routing/Handoff: reconstructs without a host receipt and Connect completes the original operation without device flow or duplicate create', async () => {
  await compose();
  const original = await readFile(mockSource);
  interruptAt = 'pre-ingress';
  await expect(mainHost().connect()).rejects.toThrow('injected');
  const before = vault.openCopilotPilotState({ kind: 'existing' }).read();
  expect(before.binding?.phase).toBe('pre_ingress');
  expect(before.authority.mutation).toMatchObject({
    kind: 'create',
    origin: 'import',
    from: null,
    committed: null,
    probeConfirmed: false,
    cancelling: false,
  });
  expect(
    (await readCopilotSelectionPreferences()).copilotVaultSelection,
  ).toBeUndefined();
  expect((await createCopilotHandoffFile(dataRoot).read())?.disposition).toBe(
    'pending',
  );
  core?.close();
  await main?.close();
  await closeEndpoint();
  endpoint = undefined;
  core = undefined;
  main = undefined;
  expect(() => readCopilotCredential()).toThrow(); // detached ownership must not reopen legacy
  await reopen(); // no journal, key holder, pending grant, mirrors, queue or bridge survives
  await compose();
  expect(await mainHost().custody()).toBe('pending');
  expect(coreHost().current()).toBe(false);
  const routed = connection();
  await expect(routed.facade.copilotConnectionStatus()).rejects.toThrow(
    'unavailable',
  );
  await expect(
    routed.facade.listCopilotModels(new AbortController().signal),
  ).rejects.toThrow('unavailable');
  await routed.facade.recoverCopilotAtStartup();
  expect(
    vault.openCopilotPilotState({ kind: 'existing' }).read().binding?.phase,
  ).toBe('pre_ingress');
  expect(
    await routed.facade.connectCopilot(
      new AbortController().signal,
      (): void => undefined,
    ),
  ).toMatchObject({ phase: 'connected' });
  expect(routed.legacyCalls()).toBe(0);
  const after = vault.openCopilotPilotState({ kind: 'existing' }).read();
  expect(after.binding?.operationId).toBe(before.binding?.operationId);
  expect(after.binding?.accountEpoch).toBe(before.binding?.accountEpoch);
  expect(after.binding?.phase).toBe('published');
  expect(after.authority.mutation).toBeNull();
  expect(coreHost().current()).toBe(true);
  expect(await mainHost().custody()).toBe('selected');
  expect(
    (await readCopilotSelectionPreferences()).copilotVaultSelection?.identity
      .operationId,
  ).toBe(before.binding?.operationId);
  expect(
    store
      .listIntents()
      .filter((i) => i.family === 'copilot-account' && i.kind === 'put'),
  ).toHaveLength(1);
  expect(await readFile(mockSource)).toEqual(original);
  const control = JSON.stringify(
    await createCopilotHandoffFile(dataRoot).read(),
  );
  expect(control).not.toContain('synthetic-access');
  expect(control).not.toContain('synthetic-refresh');
  expect(frames.some((f) => f.type === 'action')).toBe(true);
});
it('Inertness: ordinary production connection and startup have no qualification factory edge', () => {
  const connection = readFileSync(
    join(__dirname, '../main/copilot/connection.ts'),
    'utf8',
  );
  const startup = readFileSync(
    join(__dirname, '../../../core-daemon/src/main.ts'),
    'utf8',
  );
  expect(connection).not.toContain('qualification-handoff');
  expect(connection).not.toContain('createCopilotHandoff');
  expect(startup).not.toContain('createCopilotHandoff');
  expect(store.readCopilotAuthority()).not.toBeNull(); // only this fixture explicitly initialized it
});

it.each([
  'freeze-reply',
  'p1-prepare',
  'prepare-reply',
  'commit',
  'confirm',
  'confirm-reply',
  'release',
])(
  'Handoff/Resupply reconstructs after %s, retaining one reserved operation and never falling back',
  async (edge) => {
    await compose();
    interruptAt = edge;
    await expect(mainHost().connect()).rejects.toThrow();
    const before = vault.openCopilotPilotState({ kind: 'existing' });
    if (edge !== 'release') expect(before.read().authority.head).toBeNull();
    expect(coreHost().current()).toBe(false);
    const oldAttempt = before.migration.read().attempts[0]?.id;
    const oldOperation = before.read().binding?.operationId;
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    endpoint = undefined;
    core = undefined;
    main = undefined;
    await reopen();
    await compose();
    expect(await mainHost().custody()).toBe('pending');
    await mainHost().connect();
    expect(coreHost().current()).toBe(true);
    const after = vault.openCopilotPilotState({ kind: 'existing' });
    if (oldAttempt) expect(after.read().binding?.attemptId).toBe(oldAttempt);
    if (oldOperation)
      expect(after.read().binding?.operationId).toBe(oldOperation);
    expect(after.migration.read().attempts).toHaveLength(1);
    expect(
      store
        .listIntents()
        .filter((i) => i.family === 'copilot-account' && i.kind === 'put'),
    ).toHaveLength(1);
  },
);
it('explicit Disconnect retires a pre-ingress import without creating or generically confirming it', async () => {
  await compose();
  interruptAt = 'pre-ingress';
  await expect(mainHost().connect()).rejects.toThrow();
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  endpoint = undefined;
  core = undefined;
  main = undefined;
  await reopen();
  await compose();
  await mainHost().connect(true);
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  expect(state.read().binding?.phase).toBe('retired');
  expect(state.migration.read().head.authority).toBe('cleared');
  expect(
    (await readCopilotSelectionPreferences()).copilotVaultSelection,
  ).toBeUndefined();
  expect(store.listIntents()).toHaveLength(0);
});

it.each(['changed', 'absent', 'unreadable'] as const)(
  'Cancellation retires an unbound P1 preparation without requiring the old source to be %s-readable',
  async (fault) => {
    await compose();
    interruptAt = 'p1-prepare';
    await expect(mainHost().connect()).rejects.toThrow();
    const prepared = vault.openCopilotPilotState({ kind: 'existing' });
    expect(prepared.read().binding).toBeNull();
    const attempt = prepared.migration.read().attempts[0];
    if (!attempt) throw new Error('Missing exact preparation');
    expect(prepared.migration.resolveExact(attempt.id).kind).toBe(
      'not_accepted',
    );
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    if (fault === 'absent') await unlink(mockSource);
    if (fault === 'changed')
      await writeFile(mockSource, 'preserve replacement');
    mockDecryptFails = true; // retirement must never decrypt even an unchanged source
    await reopen();
    await compose();
    await mainHost().connect(true);
    const retired = vault.openCopilotPilotState({ kind: 'existing' });
    expect(retired.read().binding).toBeNull();
    expect(retired.migration.resolveExact(attempt.id).kind).toBe(
      'not_accepted',
    );
    expect(retired.migration.read().attempts[0]?.disposition).toBe('cancelled');
    expect((await createCopilotHandoffFile(dataRoot).read())?.disposition).toBe(
      'retired',
    );
    expect(store.listIntents()).toHaveLength(0);
    expect(
      (await readCopilotSelectionPreferences()).copilotVaultSelection,
    ).toBeUndefined();
    if (fault === 'changed')
      expect(await readFile(mockSource, 'utf8')).toBe('preserve replacement');
    if (fault === 'absent')
      await expect(readFile(mockSource)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    await mainHost().connect(); // terminal retirement also recovers with no fresh source offer
    expect((await createCopilotHandoffFile(dataRoot).read())?.disposition).toBe(
      'retired',
    );
    expect(store.listIntents()).toHaveLength(0);
  },
);

it.each(['epoch', 'freeze-reply', 'read-reply', 'release-reply'])(
  'Unbound cancellation reconstructs after %s without a new source offer or grant ingress',
  async (edge) => {
    await compose();
    interruptAt = 'p1-prepare';
    await expect(mainHost().connect()).rejects.toThrow();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await unlink(mockSource);
    await reopen();
    await compose();
    interruptAt = edge;
    await expect(mainHost().connect(true)).rejects.toThrow();
    expect(interruptAt).toBeUndefined();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    await mainHost().connect();
    const retired = vault.openCopilotPilotState({ kind: 'existing' });
    expect(retired.read().binding).toBeNull();
    expect(retired.migration.read().attempts[0]?.disposition).toBe('cancelled');
    expect(retired.migration.read().head).toMatchObject({
      epoch: 2,
      authority: 'cleared',
    });
    expect((await createCopilotHandoffFile(dataRoot).read())?.disposition).toBe(
      'retired',
    );
    expect(store.listIntents()).toHaveLength(0);
  },
);

it.each([
  'requestId',
  'incarnation',
  'runId',
  'operation',
  'freezeId',
  'binding',
])(
  'Bridge fences a malformed/stale/cross-operation %s reply',
  async (field) => {
    let lost = 0;
    const pump = createCopilotHandoffPump({
      sourceFlavor: source.flavorId,
      sourceMode: source.secureMode,
      binding: () => null,
      freezeId: () => null,
      lost: (): void => {
        lost++;
      },
    });
    const result = await pump.start('begin', async (host) => {
      await host.action('test');
      return pump.terminal('done');
    });
    const frame = parseCopilotHandoffFrame(result.frames[0]);
    const correlation = {
      ...frame.correlation,
      [field]:
        field === 'requestId'
          ? 99
          : field === 'binding'
            ? {
                attemptId: 'other',
                migrationEpoch: 1,
                operationId: 'other',
                accountEpoch: 'other',
              }
            : 'other',
    };
    await expect(
      pump.reply({
        ...encodeCopilotHandoffFrame({ ...frame, type: 'reply' }),
        payload: JSON.stringify({ correlation, payload: 'true' }),
      }),
    ).rejects.toThrow();
    expect(lost).toBe(1);
  },
);
it('Bridge setTimeout rejects duplicates, nested/oversized outer controls and interrupts at its absolute bound', async () => {
  let lost = 0;
  const pump = createCopilotHandoffPump({
    sourceFlavor: source.flavorId,
    sourceMode: source.secureMode,
    binding: () => null,
    freezeId: () => null,
    lost: (): void => {
      lost++;
    },
  });
  const first = await pump.start('begin', async (host) => {
    await host.action('test');
    return pump.terminal('done');
  });
  const action = parseCopilotHandoffFrame(first.frames[0]);
  const reply = encodeCopilotHandoffFrame({
    ...action,
    type: 'reply',
    payload: 'true',
  });
  expect((await pump.reply(reply)).frames).toHaveLength(1);
  await expect(pump.reply(reply)).rejects.toThrow();
  expect(lost).toBe(1);
  expect(() => parseCopilotHandoffFrame({ ...reply, payload: {} })).toThrow();
  expect(() =>
    parseCopilotHandoffFrame({ ...reply, payload: 'x'.repeat(16_385) }),
  ).toThrow();
  jest.useFakeTimers();
  try {
    const bounded = createCopilotHandoffPump({
      sourceFlavor: source.flavorId,
      sourceMode: source.secureMode,
      binding: () => null,
      freezeId: () => null,
      lost: (): void => {
        lost++;
      },
    });
    await bounded.start('begin', async (host) => {
      await host.action('freeze');
      return bounded.terminal('done');
    });
    jest.advanceTimersByTime(30_000);
    expect(lost).toBe(2);
    const completed = createCopilotHandoffPump({
      sourceFlavor: source.flavorId,
      sourceMode: source.secureMode,
      binding: () => null,
      freezeId: () => null,
      lost: (): void => {
        lost++;
      },
    });
    await completed.start('begin', () =>
      Promise.resolve(completed.terminal('published')),
    );
    completed.complete();
    jest.advanceTimersByTime(30_000);
    expect(lost).toBe(2); // successful release must not revoke published recipients later
    completed.close();
  } finally {
    jest.useRealTimers();
  }
});

it('Resupply keeps an uncertain running submission fenced; after actual settlement a fresh admitted channel finalizes without another import', async () => {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = (): void => undefined;
  const submitting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let settled = (): void => undefined;
  const submitted = new Promise<void>((resolve) => {
    settled = resolve;
  });
  holdPut = (): Promise<void> => held;
  onPut = started;
  onPutSettled = settled;
  await compose();
  const connecting = mainHost().connect();
  void connecting.catch(() => undefined);
  await submitting;
  const original = vault
    .openCopilotPilotState({ kind: 'existing' })
    .read().binding;
  if (!original) throw new Error('Missing binding');
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  endpoint = undefined;
  core = undefined;
  main = undefined;
  await expect(connecting).rejects.toThrow();
  await compose();
  await expect(mainHost().connect()).rejects.toThrow();
  expect(store.listIntents().filter((i) => i.kind === 'put')).toHaveLength(1);
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  endpoint = undefined;
  core = undefined;
  main = undefined;
  release();
  await submitted;
  holdPut = undefined;
  await reopen();
  await compose();
  await mainHost().connect();
  expect(coreHost().current()).toBe(true);
  expect(
    vault.openCopilotPilotState({ kind: 'existing' }).read().binding
      ?.operationId,
  ).toBe(original.operationId);
  expect(store.listIntents().filter((i) => i.kind === 'put')).toHaveLength(1);
});

it('Routing refuses changed source or corrupt local fence without falling back or overwriting the replacement', async () => {
  await compose();
  interruptAt = 'pre-ingress';
  await expect(mainHost().connect()).rejects.toThrow();
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  endpoint = undefined;
  core = undefined;
  main = undefined;
  const replacement = `synthetic:${JSON.stringify({ ...grant, accessToken: 'replacement-access' })}`;
  await writeFile(mockSource, replacement);
  await reopen();
  await compose();
  await expect(mainHost().connect()).rejects.toThrow();
  expect(await readFile(mockSource, 'utf8')).toBe(replacement);
  expect(store.listIntents()).toHaveLength(0);
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  endpoint = undefined;
  core = undefined;
  main = undefined;
  await writeFile(
    join(dataRoot, 'copilot-qualification/handoff-control.v1.json'),
    '{bad',
  );
  await compose();
  await expect(mainHost().custody()).rejects.toThrow('unavailable');
  expect(store.listIntents()).toHaveLength(0);
});
it.each(['prepare-reply', 'commit', 'confirm-reply', 'release'])(
  'explicit cancellation after %s retires only the owned unpublished destination without confirming it',
  async (edge) => {
    await compose();
    interruptAt = edge;
    await expect(mainHost().connect()).rejects.toThrow();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    endpoint = undefined;
    core = undefined;
    main = undefined;
    await reopen();
    await compose();
    const first = frames.length;
    await mainHost().connect(true);
    expect(
      vault.openCopilotPilotState({ kind: 'existing' }).read().binding?.phase,
    ).toBe('retired');
    expect(
      (await readCopilotSelectionPreferences()).copilotVaultSelection?.state,
    ).toBe('disabled');
    expect(
      store.listEntries().filter((e) => e.family === 'copilot-account'),
    ).toHaveLength(0);
    const actions = frames
      .slice(first)
      .filter(
        (f) => f.protocol === COPILOT_HANDOFF_PROTOCOL && f.type === 'action',
      )
      .map(
        (f) =>
          CopilotHandoffActionSchema.parse(
            JSON.parse(parseCopilotHandoffFrame(f).payload),
          ).kind,
      );
    expect(actions).not.toContain('confirm');
  },
);

it('Routing admits legacy only for authenticated unused custody, then fences again for explicit qualification handoff', async () => {
  await compose();
  expect(coreHost().unused()).toBe(true);
  expect(await mainHost().custody()).toBe('unused');
  const routed = connection();
  await routed.facade.recoverCopilotAtStartup();
  expect(routed.legacyCalls()).toBe(1);
  expect(await createCopilotHandoffFile(dataRoot).read()).toBeNull();
  await mainHost().connect();
  expect(coreHost().unused()).toBe(false);
  expect(coreHost().current()).toBe(true);
  expect(await mainHost().custody()).toBe('selected');
});

it('Routing does not start handoff after caller abort during phase lookup', async () => {
  await compose();
  interruptAt = 'pre-ingress';
  await expect(mainHost().connect()).rejects.toThrow('injected');
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  await reopen();
  await compose();
  expect(await mainHost().custody()).toBe('pending');
  expect(await mainHost().phase()).toBe('bound_pre_ingress');
  const controller = new AbortController();
  const reason = new Error('Caller stopped participating.');
  const phase = mainHost().phase.bind(mainHost());
  jest.spyOn(mainHost(), 'phase').mockImplementationOnce(async () => {
    const current = await phase();
    controller.abort(reason);
    return current;
  });
  const connect = jest.spyOn(mainHost(), 'connect').mockResolvedValueOnce([]);
  await expect(
    connection().facade.connectCopilot(
      controller.signal,
      (): void => undefined,
    ),
  ).rejects.toBe(reason);
  expect(connect).not.toHaveBeenCalled();
  expect(await mainHost().custody()).toBe('pending');
});

it('Routing observes late handoff rejection after caller abort without cancelling shared work', async () => {
  await compose();
  interruptAt = 'pre-ingress';
  await expect(mainHost().connect()).rejects.toThrow('injected');
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  await reopen();
  await compose();
  expect(await mainHost().custody()).toBe('pending');
  expect(await mainHost().phase()).toBe('bound_pre_ingress');
  const controller = new AbortController();
  const reason = new Error('Caller stopped participating.');
  let fail: ((error: Error) => void) | undefined;
  const work = new Promise<readonly MigrationWireFrame[]>(
    (_resolve, reject) => {
      fail = reject;
    },
  );
  let enter: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const connect = jest
    .spyOn(mainHost(), 'connect')
    .mockImplementationOnce(() => {
      enter?.();
      return work;
    });
  const close = jest.spyOn(mainHost(), 'close');
  const unhandled = jest.fn((): void => undefined);
  process.on('unhandledRejection', unhandled);
  try {
    const pending = connection().facade.connectCopilot(
      controller.signal,
      (): void => undefined,
    );
    void pending.catch(() => undefined);
    await Promise.race([entered, pending]);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    fail?.(new Error('Handoff failed after caller left.'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(false);
    expect(close).not.toHaveBeenCalled();
    expect(await mainHost().custody()).toBe('pending');
  } finally {
    process.removeListener('unhandledRejection', unhandled);
  }
});

it.each(['revoke', 'shutdown'] as const)(
  'Routing closes a late acquired handle when qualification %s interrupts open',
  async (interruption) => {
    await compose();
    await mainHost().connect();
    let complete: ((handle: CopilotRecipientHandle) => void) | undefined;
    const acquired = new Promise<CopilotRecipientHandle>((resolve) => {
      complete = resolve;
    });
    let enter: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let recipientSignal: AbortSignal | undefined;
    const routed = connection((input) => {
      recipientSignal = input.signal;
      enter?.();
      return acquired;
    });
    const pending = routed.facade.openManagedCopilotRuntime({
      owner: { kind: 'discovery', id: 'p7-qualified-models' },
      purpose: 'models',
      requireAccount: true,
      signal: new AbortController().signal,
    });
    await entered;
    if (interruption === 'revoke') await routed.facade.revokeCopilotRuntimes();
    else await routed.facade.shutdownCopilotRuntimes();
    expect(recipientSignal?.aborted).toBe(true);
    const close = jest.fn((): Promise<void> => Promise.resolve());
    const unavailable = (): Promise<never> =>
      Promise.reject(new Error('Not a turn fixture.'));
    complete?.({
      account: { host: grant.host, login: grant.login },
      generation: 0,
      close,
      runTurn: unavailable,
      listModels: unavailable,
      getQuota: unavailable,
    });
    await expect(pending).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  },
);

it.each(['unused', 'selected'] as const)(
  'Routing refuses an acquisition revoked while %s custody is unresolved',
  async (custody) => {
    await compose();
    if (custody === 'selected') await mainHost().connect();
    let complete: (() => void) | undefined;
    const admission = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let enter: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    jest.spyOn(mainHost(), 'custody').mockImplementation(async () => {
      enter?.();
      await admission;
      return custody;
    });
    const open = jest.fn(
      (): Promise<never> =>
        Promise.reject(
          new Error('A revoked acquisition must not reach a backend.'),
        ),
    );
    const routed = connection(open);
    const pending = routed.facade.openManagedCopilotRuntime({
      owner: { kind: 'discovery', id: 'p7-unresolved-custody' },
      purpose: 'models',
      requireAccount: true,
      signal: new AbortController().signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    await entered;
    await routed.facade.revokeCopilotRuntimes();
    complete?.();
    await rejected;
    expect(open).not.toHaveBeenCalled();
  },
);

it.each(['symlink', 'hard-link', 'oversized'] as const)(
  'Handoff refuses a %s control file before projecting selected custody',
  async (layout) => {
    await compose();
    await mainHost().connect();
    const path = join(
      dataRoot,
      'copilot-qualification/handoff-control.v1.json',
    );
    const neighbor = join(folder.root, 'preserved-control.json');
    const before = await readFile(path);
    if (layout === 'symlink') {
      await rename(path, neighbor);
      await symlink(neighbor, path);
    } else if (layout === 'hard-link') await link(path, neighbor);
    else await writeFile(path, Buffer.alloc(16_385, ' '));
    await expect(mainHost().custody()).rejects.toThrow();
    expect(coreHost().current()).toBe(false);
    if (layout !== 'oversized')
      expect(await readFile(neighbor)).toEqual(before);
  },
);

it.each([false, true])(
  'Handoff preserves a durable local cancellation across restart before core observed it (freeze reply lost: %s)',
  async (loseFreezeReply) => {
    await compose();
    interruptAt = 'pre-ingress';
    await expect(mainHost().connect()).rejects.toThrow();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    const file = createCopilotHandoffFile(dataRoot);
    const before = await file.read();
    if (!before) throw new Error('Missing local fence');
    await file.write({
      ...before,
      generation: before.generation + 1,
      disposition: 'cancelling',
    });
    await reopen();
    await compose();
    if (loseFreezeReply) {
      interruptAt = 'freeze-reply';
      await expect(mainHost().connect()).rejects.toThrow();
      coreHost().close();
      await mainHost().close();
      await closeEndpoint();
      await reopen();
      await compose();
    }
    await mainHost().connect();
    expect(
      vault.openCopilotPilotState({ kind: 'existing' }).read().binding?.phase,
    ).toBe('retired');
    expect(store.listIntents()).toHaveLength(0);
    expect(
      (await readCopilotSelectionPreferences()).copilotVaultSelection,
    ).toBeUndefined();
  },
);

it('Handoff closes live admission synchronously before a host receipt change can await its durable write', async () => {
  await compose();
  await mainHost().connect();
  expect(coreHost().current()).toBe(true);
  await updatePreferencesFile((preferences) => {
    const selection = preferences.copilotVaultSelection;
    if (!selection) throw new Error('Missing selection');
    return {
      copilotVaultSelection: { ...selection, state: 'disabled' },
      copilotEnabled: false,
    };
  });
  expect(coreHost().current()).toBe(false);
  await expect(
    connection().facade.listCopilotModels(new AbortController().signal),
  ).rejects.toThrow();
});

it('Handoff invalidates live admission when the durable host fence becomes unreadable', async () => {
  await compose();
  await mainHost().connect();
  expect(coreHost().current()).toBe(true);
  await writeFile(
    join(dataRoot, 'copilot-qualification/handoff-control.v1.json'),
    '{bad',
  );
  await expect(mainHost().custody()).rejects.toThrow();
  expect(coreHost().current()).toBe(false);
});

it('Handoff refuses a changed migration epoch during live admission and committed recovery', async () => {
  await compose();
  interruptAt = 'commit';
  await expect(mainHost().connect()).rejects.toThrow();
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  await reopen();
  migrationEpoch++;
  await compose();
  await expect(mainHost().connect()).rejects.toThrow();
  expect(coreHost().current()).toBe(false);
  expect(
    vault.openCopilotPilotState({ kind: 'existing' }).read().authority.head,
  ).toBeNull();

  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  migrationEpoch--;
  await reopen();
  await compose();
  await mainHost().connect();
  expect(coreHost().current()).toBe(true);
  let reads = 0;
  onChannelRead = (): void => {
    if (++reads === 2) migrationEpoch++;
  };
  expect(coreHost().current()).toBe(false);
});

it('Routing cannot treat a closed core channel as authenticated unused custody', async () => {
  await compose();
  coreHost().close();
  expect(coreHost().unused()).toBe(false);
  expect(await mainHost().custody()).toBe('pending');
});

it.each(['unused', 'pending', 'selected'])(
  'Routing preserves legacy runtime teardown ownership in %s custody',
  async (custody) => {
    await compose();
    if (custody === 'selected') await mainHost().connect();
    if (custody === 'pending') {
      interruptAt = 'pre-ingress';
      await expect(mainHost().connect()).rejects.toThrow();
    }
    const routed = connection();
    await routed.facade.revokeCopilotRuntimes();
    expect(routed.legacyCalls()).toBe(1);
    await routed.facade.shutdownCopilotRuntimes();
    expect(routed.legacyCalls()).toBe(2);
  },
);

it('Handoff permits unrelated preference updates while the real source queue is held, without recursively acquiring it', async () => {
  let saves = 0;
  onHostAction = async (kind): Promise<void> => {
    if (kind !== 'prepare' && kind !== 'confirm') return;
    await updatePreferencesFile(() => ({ copilotEnabled: false }));
    saves++;
  };
  await compose();
  await mainHost().connect();
  expect(saves).toBe(2);
  expect(coreHost().current()).toBe(true);
  await updatePreferencesFile(() => ({ copilotEnabled: true }));
  expect(coreHost().current()).toBe(true);
});

it('Handoff invalidates before preference persistence, not from an awaited queue observer', async () => {
  await compose();
  await mainHost().connect();
  let beforeWrite = false;
  const stop = observeCopilotSelectionAuthority((change) => {
    if (change.kind === 'changing') {
      beforeWrite = true;
      expect(coreHost().current()).toBe(false);
    }
  });
  try {
    await updatePreferencesFile((preferences) => {
      const selection = preferences.copilotVaultSelection;
      if (!selection) throw new Error('Missing selection');
      return {
        copilotVaultSelection: { ...selection, pinGeneration: 'changed' },
      };
    });
    expect(beforeWrite).toBe(true);
  } finally {
    stop();
  }
});

it('Inertness executes ordinary production startup/Connect without initializing qualification or changing source/selection', async () => {
  const original = await readFile(mockSource);
  const authority = store.readCopilotAuthority();
  const connect = jest.fn(
    (): Promise<never> =>
      Promise.reject(new Error('Synthetic legacy device flow reached.')),
  );
  const recover = jest.fn((): Promise<void> => Promise.resolve());
  const shutdown = jest.fn((): Promise<void> => Promise.resolve());
  // Exercise connection.ts itself, with only its external legacy provider/feature ports synthetic.
  jest.doMock('../main/copilot/legacy-connection', () => ({
    connectCopilot: connect,
    recoverCopilotAtStartup: recover,
    shutdownCopilotRuntimes: shutdown,
    revokeCopilotRuntimes: (): Promise<void> => Promise.resolve(),
  }));
  jest.doMock('../main/copilot/feature-flag', () => ({
    assertCopilotHarnessEnabled: (): void => undefined,
  }));
  try {
    await jest.isolateModulesAsync(async () => {
      const production = await import('../main/copilot/connection');
      await production.recoverCopilotAtStartup();
      await expect(
        production.connectCopilot(
          new AbortController().signal,
          (): void => undefined,
        ),
      ).rejects.toThrow('Synthetic legacy device flow');
      await production.shutdownCopilotRuntimes();
      await production.shutdownCopilotRuntimes();
    });
  } finally {
    jest.dontMock('../main/copilot/legacy-connection');
    jest.dontMock('../main/copilot/feature-flag');
  }
  expect(connect).toHaveBeenCalledTimes(1);
  expect(recover).toHaveBeenCalledTimes(1);
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(await createCopilotHandoffFile(dataRoot).read()).toBeNull();
  expect(
    (await readCopilotSelectionPreferences()).copilotVaultSelection,
  ).toBeUndefined();
  expect(store.readCopilotAuthority()).toBe(authority);
  expect(store.listIntents()).toHaveLength(0);
  expect(await readFile(mockSource)).toEqual(original);
});

it('Handoff reconstructs a durable local preparing fence written before capture or P1 preparation', async () => {
  await compose();
  mockDecryptFails = true;
  await expect(mainHost().connect()).rejects.toThrow();
  const before = await createCopilotHandoffFile(dataRoot).read();
  expect(before).toMatchObject({
    disposition: 'preparing',
    ciphertextGeneration: null,
    binding: null,
  });
  expect(
    vault.openCopilotPilotState({ kind: 'existing' }).migration.read().attempts,
  ).toHaveLength(0);
  expect(
    (await readCopilotSelectionPreferences()).copilotVaultSelection,
  ).toBeUndefined();
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  await reopen();
  mockDecryptFails = false;
  mockPreferenceWriteFails = false;
  await compose();
  const routed = connection();
  expect(await mainHost().custody()).toBe('pending');
  await expect(
    routed.facade.listCopilotModels(new AbortController().signal),
  ).rejects.toThrow();
  await routed.facade.connectCopilot(
    new AbortController().signal,
    (): void => undefined,
  );
  expect(routed.legacyCalls()).toBe(0);
  expect(coreHost().current()).toBe(true);
  expect((await createCopilotHandoffFile(dataRoot).read())?.handoffId).toBe(
    before?.handoffId,
  );
});

it('Bridge refuses a command carrying a foreign established P1/P4 binding before requesting a host freeze', async () => {
  await compose();
  if (!endpoint) throw new Error('Endpoint missing');
  const metadata = {
    deadlineMs: Date.now() + 30_000,
    signal: new AbortController().signal,
  };
  const hello = await endpoint.exchange(
    encodeMigrationFrame({ type: 'hello' }),
    metadata,
  );
  const offered = parseMigrationCoreFrame(hello.frames[1]);
  if (!offered.ok || offered.frame.type !== 'offer')
    throw new Error('Offer missing');
  const offer = offered.frame;
  await expect(
    endpoint.exchange(
      encodeCopilotHandoffFrame({
        protocol: COPILOT_HANDOFF_PROTOCOL,
        version: 1,
        type: 'command',
        correlation: {
          incarnation: 'command',
          runId: 'new',
          requestId: 1,
          operation: 'begin',
          sourceFlavor: source.flavorId,
          sourceMode: source.secureMode,
          slot: 'copilot-account',
          freezeId: null,
          binding: {
            attemptId: 'foreign',
            migrationEpoch: 1,
            operationId: 'foreign',
            accountEpoch: 'foreign',
          },
        },
        payload: JSON.stringify({
          kind: 'begin',
          sessionId: offer.sessionId,
          challenge: offer.challenge,
          operation: offer.operation,
          purpose: offer.purpose,
        }),
      }),
      metadata,
    ),
  ).rejects.toThrow();
  expect(await createCopilotHandoffFile(dataRoot).read()).toBeNull();
  expect(
    vault.openCopilotPilotState({ kind: 'existing' }).migration.read().attempts,
  ).toHaveLength(0);
});

it.each(['pre-ingress', 'prepare-reply', 'commit', 'confirm-reply', 'release'])(
  'Cancellation reconstructs after %s and retires only its exact destination, even when the source changes',
  async (edge) => {
    await compose();
    interruptAt = edge;
    await expect(mainHost().connect()).rejects.toThrow();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    const replacement = Buffer.from('replacement is not decryptable');
    await writeFile(mockSource, replacement);
    await compose();
    await mainHost().connect(true);
    const state = vault.openCopilotPilotState({ kind: 'existing' });
    expect(state.read().binding?.phase).toBe('retired');
    expect(state.migration.read().head.epoch).toBeGreaterThan(1);
    expect(
      state.migration.resolve(
        state.migration.read().attempts[0]?.id ?? 'missing',
      ).kind,
    ).toBe('retired');
    expect(
      store.listEntries().filter((e) => e.family === 'copilot-account'),
    ).toHaveLength(0);
    expect(await readFile(mockSource)).toEqual(replacement);
    expect(
      (await readCopilotSelectionPreferences()).copilotVaultSelection?.state,
    ).not.toBe('selected');
  },
);

it.each(['before', 'after'] as const)(
  'P8 actual use receipt reconciles %s-COMMIT uncertainty before any source deletion',
  async (where) => {
    await compose();
    await mainHost().connect();
    const original = await readFile(mockSource);
    useCommitFault = where;
    // Migration's exclusive owner reports storage uncertainty as a typed terminal,
    // not a transport exception. Neither outcome is successful verification.
    const failed = parseCopilotHandoffFrame((await mainHost().verify())[0]);
    expect(failed.type).toBe('terminal');
    expect(JSON.parse(failed.payload)).toEqual({ kind: 'unavailable' });
    expect(useCommitFault).toBeUndefined();
    expect(armedCommitFault).toBeUndefined();
    expect(discoveryCalls).toBe(1);
    expect(await readFile(mockSource)).toEqual(original);
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    await mainHost().connect();
    const state = vault.openCopilotPilotState({ kind: 'existing' });
    const attempt = state.migration.read().attempts[0];
    expect(attempt?.deletion).toBeNull();
    expect(state.read().controls.filter((c) => c.kind === 'deletion')).toEqual(
      [],
    );
    expect(attempt?.state).toBe(
      where === 'after' ? 'verified' : 'imported_unverified',
    );
    if (where === 'before') {
      expect(attempt?.use).toBeNull();
      await mainHost().cleanup();
      expect(await readFile(mockSource)).toEqual(original);
      expect(state.migration.read().attempts[0]?.deletion).toBeNull();
      expect(discoveryCalls).toBe(1);
    } else {
      expect(attempt?.use?.provenance).toContain('admittedCompletion');
      expect(attempt?.use?.pin).toEqual(state.read().authority.head?.pin);
    }
    await mainHost().verify();
    expect(discoveryCalls).toBe(where === 'before' ? 2 : 1);
    expect(state.migration.read().attempts[0]?.state).toBe('verified');
    if (where === 'after')
      expect(state.migration.read().attempts[0]?.use).toEqual(attempt?.use);
    await mainHost().cleanup();
    expect(state.migration.read().attempts[0]?.state).toBe('legacy_deleted');
    await expect(readFile(mockSource)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(store.listIntents().filter((i) => i.kind === 'delete')).toEqual([]);
    expect(refreshCalls).toBe(0);
  },
);

it('Actual use/Cleanup: admitted model discovery records exact presentation provenance, then deletes the source using its exclusive durable claim', async () => {
  await compose();
  await mainHost().connect();
  await mainHost().verify();
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  const used = state.migration.read().attempts[0];
  expect(used?.state).toBe('verified');
  expect(used?.use?.provenance).toContain('admittedCompletion');
  expect(used?.use?.provenance).not.toContain(grant.accessToken);
  await mainHost().cleanup();
  expect(state.migration.read().attempts[0]?.state).toBe('legacy_deleted');
  expect(state.read().controls.find((c) => c.kind === 'deletion')?.phase).toBe(
    'completed',
  );
  await expect(readFile(mockSource)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(
    store.listEntries().filter((e) => e.family === 'copilot-account'),
  ).toHaveLength(1);
  expect(coreHost().current()).toBe(true);
});

it.each([
  'binding:cancelling',
  'epoch',
  'control:cancelling',
  'destination-delete',
  'abandon-reply',
  'binding:retired',
  'release-reply',
])(
  'Cancellation finishes exact retirement after durable %s acknowledgement loss',
  async (edge) => {
    await compose();
    interruptAt = 'confirm-reply';
    await expect(mainHost().connect()).rejects.toThrow();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    interruptAt = edge;
    await expect(mainHost().connect(true)).rejects.toThrow();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    await mainHost().connect(); // durable cancellation wins over resume
    const state = vault.openCopilotPilotState({ kind: 'existing' });
    expect(state.read().binding?.phase).toBe('retired');
    expect(state.read().controls[0]?.phase).toBe('retired');
    expect(
      store.listEntries().filter((e) => e.family === 'copilot-account'),
    ).toHaveLength(0);
    expect(
      (await readCopilotSelectionPreferences()).copilotVaultSelection?.state,
    ).toBe('disabled');
  },
);
it.each(['provider', 'provisional', 'stale'] as const)(
  'Actual use refuses %s evidence without authorizing source deletion',
  async (fault) => {
    await compose();
    await mainHost().connect();
    useFault = fault;
    await mainHost().verify();
    const state = vault.openCopilotPilotState({ kind: 'existing' });
    expect(state.migration.read().attempts[0]?.state).toBe(
      'imported_unverified',
    );
    expect(state.migration.read().attempts[0]?.use).toBeNull();
    await mainHost().cleanup();
    expect(await readFile(mockSource, 'utf8')).toContain('synthetic:');
    expect(state.migration.read().attempts[0]?.deletion).toBeNull();
  },
);

it('Actual use rejects a late prior model completion on a fresh verification even when committed lineage is unchanged', async () => {
  await compose();
  await mainHost().connect();
  useFault = 'post-provider';
  await mainHost().verify();
  expect(replayCompletion).toBeDefined();
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  expect(state.migration.read().attempts[0]?.use).toBeNull();
  useFault = 'replay';
  await mainHost().verify();
  expect(discoveryCalls).toBe(2);
  expect(state.migration.read().attempts[0]?.use).toBeNull();
  useFault = undefined;
  await mainHost().verify();
  expect(discoveryCalls).toBe(3);
  expect(state.migration.read().attempts[0]?.use).not.toBeNull();
});
it.each([
  'control:authorized',
  'cleanup-claim-reply',
  'control:claim_ready',
  'cleanup-detach-reply',
  'control:source_detached',
  'control:remove_authorized',
  'cleanup-remove-reply',
  'control:completed',
])(
  'Cleanup reconstructs after %s without losing its owned claim or inferring success from absence',
  async (edge) => {
    await compose();
    await mainHost().connect();
    await mainHost().verify();
    interruptAt = edge;
    if (edge.startsWith('control:')) {
      const result = await mainHost().cleanup();
      expect(parseCopilotHandoffFrame(result[0]).payload).toBe(
        JSON.stringify({ kind: 'unresolved' }),
      );
    } else await expect(mainHost().cleanup()).rejects.toThrow();
    expect(interruptAt).toBeUndefined();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    await mainHost().cleanup();
    const state = vault.openCopilotPilotState({ kind: 'existing' });
    expect(state.migration.read().attempts[0]?.state).toBe('legacy_deleted');
    expect(
      state.read().controls.find((c) => c.kind === 'deletion')?.phase,
    ).toBe('completed');
    await expect(readFile(mockSource)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

it('Cancellation supersedes a newer numeric epoch without re-adopting or publishing its old import', async () => {
  await compose();
  interruptAt = 'pre-ingress';
  await expect(mainHost().connect()).rejects.toThrow();
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  await reopen();
  migrationEpoch = 2;
  await compose();
  await mainHost().connect(true);
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  expect(state.read().binding?.phase).toBe('retired');
  expect(state.migration.read().head.epoch).toBe(3);
});
it.each(['before-detach', 'after-detach'])(
  'Cleanup preserves an atomic source replacement %s and every neighboring file',
  async (when) => {
    await compose();
    await mainHost().connect();
    await mainHost().verify();
    const neighbor = join(folder.root, 'github-token.enc');
    await writeFile(neighbor, 'neighbor');
    const replacement = 'unrelated replacement';
    if (when === 'before-detach') {
      onHostAction = async (edge): Promise<void> => {
        if (edge === 'cleanup-detach') {
          const tmp = join(folder.root, 'replacement.enc');
          await writeFile(tmp, replacement);
          await rename(tmp, mockSource);
        }
      };
      await mainHost().cleanup();
      expect(
        vault.openCopilotPilotState({ kind: 'existing' }).migration.read()
          .attempts[0]?.state,
      ).toBe('verified');
    } else {
      interruptAt = 'control:source_detached';
      await mainHost().cleanup();
      coreHost().close();
      await mainHost().close();
      await closeEndpoint();
      await writeFile(mockSource, replacement);
      await reopen();
      await compose();
      await mainHost().cleanup();
      expect(
        vault.openCopilotPilotState({ kind: 'existing' }).migration.read()
          .attempts[0]?.state,
      ).toBe('legacy_deleted');
    }
    expect(await readFile(mockSource, 'utf8')).toBe(replacement);
    expect(await readFile(neighbor, 'utf8')).toBe('neighbor');
  },
);
it('Cleanup refuses an unrelated EEXIST claim without overwriting it or unlinking the source', async () => {
  await compose();
  await mainHost().connect();
  await mainHost().verify();
  const original = await readFile(mockSource);
  let claim = '';
  onHostAction = async (edge): Promise<void> => {
    if (edge !== 'cleanup-claim') return;
    const state = vault.openCopilotPilotState({ kind: 'existing' });
    const operation = state.migration.read().attempts[0]?.deletion?.id;
    if (!operation) throw new Error('Missing deletion identity');
    const directory = join(dataRoot, 'copilot-qualification', 'claims');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    claim = join(directory, `${operation}.enc`);
    await writeFile(claim, 'unrelated claim');
  };
  await mainHost().cleanup();
  expect(await readFile(claim, 'utf8')).toBe('unrelated claim');
  expect(await readFile(mockSource)).toEqual(original);
  expect((await lstat(mockSource)).nlink).toBe(1);
});
it('Cleanup never records source absence as completion without a durable claim', async () => {
  await compose();
  await mainHost().connect();
  await mainHost().verify();
  await unlink(mockSource);
  const result = await mainHost().cleanup();
  expect(parseCopilotHandoffFrame(result[0]).payload).toBe(
    JSON.stringify({ kind: 'unavailable' }),
  );
  const attempt = vault
    .openCopilotPilotState({ kind: 'existing' })
    .migration.read().attempts[0];
  expect(attempt?.state).toBe('verified');
  expect(attempt?.deletion?.completionId).toBeNull();
});

it.each(
  [
    'link',
    'file-sync',
    'claim-directory-durable',
    'claim-directory-sync',
    'source-unlink',
    'source-directory-sync',
    'claim-unlink',
  ].flatMap((step) => [`${step}-before`, `${step}-after`]),
)(
  'Cleanup retries exact filesystem durability failure %s after full reconstruction',
  async (edge) => {
    await compose();
    await mainHost().connect();
    await mainHost().verify();
    mockCleanupFault = edge;
    const result = await mainHost().cleanup();
    expect(mockCleanupFault).toBeUndefined();
    expect(parseCopilotHandoffFrame(result[0]).payload).toBe(
      JSON.stringify({ kind: 'unavailable' }),
    );
    const state = vault.openCopilotPilotState({ kind: 'existing' });
    expect(state.migration.read().attempts[0]?.state).toBe('verified');
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    await mainHost().cleanup();
    const after = vault.openCopilotPilotState({ kind: 'existing' });
    expect(after.migration.read().attempts[0]?.state).toBe('legacy_deleted');
    expect(
      after.read().controls.find((c) => c.kind === 'deletion')?.phase,
    ).toBe('completed');
  },
);

it.each([
  'cleanup-claim-reply',
  'cleanup-detach-reply',
  'cleanup-remove-reply',
])(
  'Cancellation first completes the accepted exact encrypted claim after %s loss',
  async (edge) => {
    await compose();
    await mainHost().connect();
    await mainHost().verify();
    interruptAt = edge;
    await expect(mainHost().cleanup()).rejects.toThrow();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    await mainHost().connect(true);
    const state = vault.openCopilotPilotState({ kind: 'existing' });
    expect(state.read().binding?.phase).toBe('retired');
    expect(
      state.read().controls.find((c) => c.kind === 'deletion')?.phase,
    ).toBe('completed');
    expect(
      state.read().controls.find((c) => c.kind === 'retirement')?.phase,
    ).toBe('retired');
  },
);

it('Cancellation closes admission synchronously before the first durable main fence await', async () => {
  await compose();
  await mainHost().connect();
  expect(coreHost().current()).toBe(true);
  const cancelling = mainHost().connect(true);
  expect(coreHost().current()).toBe(false);
  await cancelling;
});

it('Cancellation during submitted work durably fences the active continuation and waits for actual settlement before exact retirement', async () => {
  let release = (): void => undefined;
  let started = (): void => undefined;
  let settled = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const submitting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const submitted = new Promise<void>((resolve) => {
    settled = resolve;
  });
  holdPut = (): Promise<void> => held;
  onPut = started;
  onPutSettled = settled;
  await compose();
  const connecting = mainHost().connect();
  void connecting.catch(() => undefined);
  await submitting;
  const cancelling = mainHost().connect(true);
  expect(coreHost().current()).toBe(false);
  await expect(cancelling).rejects.toThrow('busy');
  await expect(connecting).rejects.toThrow();
  expect((await createCopilotHandoffFile(dataRoot).read())?.disposition).toBe(
    'cancelling',
  );
  await mainHost().close();
  await closeEndpoint();
  release();
  await submitted;
  holdPut = undefined;
  await reopen();
  await compose();
  await mainHost().connect();
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  expect(state.read().binding?.phase).toBe('retired');
  expect(
    store.listEntries().filter((e) => e.family === 'copilot-account'),
  ).toHaveLength(0);
});

it.each([false, true])(
  'Actual use reconciles a normal committed P4 refresh and verifies only a fresh discovery with original successor provenance (reconstruct: %s)',
  async (reconstruct) => {
    await compose();
    await mainHost().connect();
    const state = vault.openCopilotPilotState({ kind: 'existing' });
    const original = state.read().authority.head;
    if (!original) throw new Error('Missing published head');
    refreshForUse = true;
    await mainHost().verify();
    expect(refreshCalls).toBe(1);
    expect(state.migration.read().attempts[0]?.use).toBeNull();
    const resolved = state.migration.resolve(
      state.read().binding?.attemptId ?? 'missing',
    );
    expect(resolved).toMatchObject({
      kind: 'committed',
      pin: { revision: original.pin.revision + 1 },
    });
    expect(coreHost().current()).toBe(false);
    if (reconstruct) {
      coreHost().close();
      await mainHost().close();
      await closeEndpoint();
      await reopen();
      await compose();
    }
    await mainHost().verify();
    const current = vault.openCopilotPilotState({ kind: 'existing' });
    const used = current.migration.read().attempts[0]?.use;
    expect(discoveryCalls).toBe(2);
    expect(refreshCalls).toBe(1);
    expect(used?.pin.revision).toBe(original.pin.revision + 1);
    expect(used?.successorKeys).toHaveLength(1);
    expect(used?.provenance).toContain('admittedCompletion');
    expect(coreHost().current()).toBe(true);
    await mainHost().cleanup();
    expect(current.migration.read().attempts[0]?.state).toBe('legacy_deleted');
  },
);

it('Cancellation of a committed successor retires its exact newer lineage and the original selected receipt without confirming again', async () => {
  await compose();
  await mainHost().connect();
  refreshForUse = true;
  await mainHost().verify();
  expect(refreshCalls).toBe(1);
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  const pin = state.read().authority.head?.pin;
  expect(pin?.revision).toBe(1);
  await mainHost().connect(true);
  expect(state.read().binding?.phase).toBe('retired');
  expect(
    state.read().controls.find((c) => c.kind === 'retirement')?.destination,
  ).toEqual(pin);
  expect(
    store.listEntries().filter((e) => e.family === 'copilot-account'),
  ).toHaveLength(0);
  expect(
    (await readCopilotSelectionPreferences()).copilotVaultSelection?.state,
  ).toBe('disabled');
});

it.each(['missing', 'foreign-disabled', 'enabled-disabled'] as const)(
  'Cancellation retains its fence until the exact published host receipt is retired: %s',
  async (fault) => {
    await compose();
    await mainHost().connect();
    const original = (await readCopilotSelectionPreferences())
      .copilotVaultSelection;
    if (!original?.pin) throw new Error('Missing selected receipt');
    const pin = original.pin;
    // Restart reconciliation must not rely on the previous host's live observer.
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await updatePreferencesFile(() => ({
      copilotVaultSelection:
        fault === 'missing'
          ? undefined
          : {
              ...original,
              state: 'disabled',
              pin:
                fault === 'foreign-disabled'
                  ? { ...pin, ref: { ...pin.ref, entryId: 'foreign-entry' } }
                  : pin,
            },
      copilotEnabled: fault === 'enabled-disabled',
    }));
    await reopen();
    await compose();
    await expect(mainHost().connect(true)).rejects.toThrow();
    const state = vault.openCopilotPilotState({ kind: 'existing' });
    const pending = state.read();
    const removal = pending.authority.removal;
    if (!removal) throw new Error('Missing exact removal fence');
    expect(pending.binding?.phase).toBe('published');
    expect(removal.epoch).toBe(original.identity.epoch);
    expect(pending.authority.head?.pin).toEqual(pin);
    expect(pending.authority.mutation).toBeNull();
    expect(state.migration.read().head).toMatchObject({
      epoch: 1,
      authority: 'vault',
    });
    expect(store.readEntry(pin.ref.entryId)).not.toBeNull();
    expect(store.listIntents().filter((i) => i.kind === 'delete')).toHaveLength(
      0,
    );
    expect((await createCopilotHandoffFile(dataRoot).read())?.disposition).toBe(
      'selected',
    );
    expect(await readFile(mockSource, 'utf8')).toContain('synthetic:');
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await updatePreferencesFile(() => ({
      copilotVaultSelection: original,
      copilotEnabled: true,
    }));
    await reopen();
    await compose();
    await mainHost().connect();
    expect(
      store
        .listIntents()
        .filter((i) => i.kind === 'delete')
        .map((i) => i.idempotencyKey),
    ).toEqual([`${removal.operationId}:${pin.revision}`]);
    expect(
      vault.openCopilotPilotState({ kind: 'existing' }).read().binding?.phase,
    ).toBe('retired');
    const retired = await readCopilotSelectionPreferences();
    expect(retired.copilotVaultSelection).toEqual({
      ...original,
      state: 'disabled',
    });
    expect(retired.copilotEnabled).toBe(false);
  },
);

it('Cancellation durably fences P4 and supersedes P1 before recovering an accepted cleanup claim', async () => {
  await compose();
  await mainHost().connect();
  await mainHost().verify();
  interruptAt = 'cleanup-claim-reply';
  await expect(mainHost().cleanup()).rejects.toThrow();
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  await reopen();
  await compose();
  let observed = false;
  onHostAction = (edge): Promise<void> => {
    if (!edge.startsWith('cleanup-')) return Promise.resolve();
    const state = vault.openCopilotPilotState({ kind: 'existing' });
    const retired = state.read();
    expect(retired.binding?.phase).toBe('retired');
    expect(retired.authority.head).toBeNull();
    expect(retired.authority.mutation).toBeNull();
    expect(retired.authority.removal).toBeNull();
    expect(retired.controls.find((c) => c.kind === 'retirement')?.phase).toBe(
      'retired',
    );
    expect(
      store.listEntries().filter((e) => e.family === 'copilot-account'),
    ).toHaveLength(0);
    expect(coreHost().current()).toBe(false);
    expect(state.migration.read().head.epoch).toBeGreaterThan(1);
    const attempt = state.migration.read().attempts[0];
    if (!attempt?.deletion) throw new Error('Missing submitted cleanup');
    expect(() =>
      state.migration.retiredDeletionReceipt(
        attempt.id,
        attempt.epoch,
        attempt.deletion?.id ?? 'missing',
        attempt.identity.generation,
        'forged',
      ),
    ).toThrow();
    observed = true;
    return Promise.resolve();
  };
  await mainHost().connect(true);
  expect(observed).toBe(true);
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  expect(state.read().binding?.phase).toBe('retired');
  expect(state.migration.read().attempts[0]?.deletion?.phase).toBe('completed');
});

it('Cleanup rechecks source identity after awaited claim-directory durability before detaching', async () => {
  await compose();
  await mainHost().connect();
  await mainHost().verify();
  onHostAction = (edge): Promise<void> => {
    if (edge !== 'cleanup-detach') return Promise.resolve();
    mockOnClaimDirectorySync = async (): Promise<void> => {
      mockOnClaimDirectorySync = undefined;
      const replacement = join(folder.root, 'replacement.enc');
      await writeFile(replacement, 'preserve late replacement');
      await rename(replacement, mockSource);
    };
    return Promise.resolve();
  };
  await mainHost().cleanup();
  expect(await readFile(mockSource, 'utf8')).toBe('preserve late replacement');
  expect(
    vault.openCopilotPilotState({ kind: 'existing' }).migration.read()
      .attempts[0]?.state,
  ).toBe('verified');
});

it('Cancellation reconstructs a lost retired-cleanup P1 receipt without admitting its old epoch', async () => {
  await compose();
  await mainHost().connect();
  await mainHost().verify();
  interruptAt = 'cleanup-claim-reply';
  await expect(mainHost().cleanup()).rejects.toThrow();
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  await reopen();
  await compose();
  interruptAt = 'retired-deletion-receipt';
  await expect(mainHost().connect(true)).rejects.toThrow();
  expect(interruptAt).toBeUndefined();
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  await reopen();
  await compose();
  await mainHost().connect();
  const state = vault.openCopilotPilotState({ kind: 'existing' });
  expect(state.read().binding?.phase).toBe('retired');
  expect(state.migration.read().attempts[0]?.deletion?.phase).toBe('completed');
  expect(state.migration.read().head).toMatchObject({
    epoch: 2,
    authority: 'cleared',
  });
});

it.each([
  'source-symlink',
  'source-extra-link',
  'claim-symlink',
  'claim-extra-link',
] as const)(
  'Cleanup preserves source and neighbors on unexpected filesystem layout: %s',
  async (layout) => {
    await compose();
    await mainHost().connect();
    await mainHost().verify();
    const original = await readFile(mockSource);
    const neighbor = join(folder.root, 'preserved-neighbor.enc');
    if (layout === 'source-symlink') {
      await writeFile(neighbor, original);
      await unlink(mockSource);
      await symlink(neighbor, mockSource);
    } else if (layout === 'source-extra-link') await link(mockSource, neighbor);
    else {
      onHostAction = async (edge): Promise<void> => {
        if (layout === 'claim-extra-link' && edge === 'cleanup-detach') {
          await link(mockSource, neighbor);
        } else if (layout === 'claim-symlink' && edge === 'cleanup-claim') {
          const operation = vault
            .openCopilotPilotState({ kind: 'existing' })
            .migration.read().attempts[0]?.deletion?.id;
          if (!operation) throw new Error('Missing deletion');
          const directory = join(dataRoot, 'copilot-qualification', 'claims');
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await symlink(mockSource, join(directory, `${operation}.enc`));
        }
      };
    }
    await mainHost().cleanup();
    expect(await readFile(mockSource)).toEqual(original);
    if (layout !== 'claim-symlink')
      expect(await readFile(neighbor)).toEqual(original);
    expect(
      vault.openCopilotPilotState({ kind: 'existing' }).migration.read()
        .attempts[0]?.state,
    ).toBe('verified');
  },
);

it.each([
  'missing',
  'account',
  'operation',
  'epoch',
  'origin',
  'pin',
  'revision',
  'disabled',
] as const)(
  'Resume rejects a disagreeing %s receipt after source cleanup',
  async (fault) => {
    await compose();
    await mainHost().connect();
    await mainHost().verify();
    await mainHost().cleanup();
    const before = vault.openCopilotPilotState({ kind: 'existing' }).read();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await updatePreferencesFile((preferences) => {
      const selected = preferences.copilotVaultSelection;
      if (!selected?.pin) throw new Error('Missing selected pin');
      return {
        copilotVaultSelection:
          fault === 'missing'
            ? undefined
            : {
                ...selected,
                state: fault === 'disabled' ? 'disabled' : selected.state,
                identity: {
                  ...selected.identity,
                  account:
                    fault === 'account'
                      ? { ...selected.identity.account, id: '2' }
                      : selected.identity.account,
                  operationId:
                    fault === 'operation'
                      ? 'foreign'
                      : selected.identity.operationId,
                  epoch:
                    fault === 'epoch' ? 'foreign' : selected.identity.epoch,
                  origin:
                    fault === 'origin' ? 'setup' : selected.identity.origin,
                },
                pin: {
                  ref:
                    fault === 'pin'
                      ? { ...selected.pin.ref, entryId: 'foreign' }
                      : selected.pin.ref,
                  revision:
                    selected.pin.revision + (fault === 'revision' ? 1 : 0),
                },
              },
      };
    });
    await reopen();
    await compose();
    const routed = connection();
    await expect(
      routed.facade.connectCopilot(
        new AbortController().signal,
        (): void => undefined,
      ),
    ).rejects.toThrow();
    expect(routed.legacyCalls()).toBe(0);
    expect(coreHost().current()).toBe(false);
    expect(vault.openCopilotPilotState({ kind: 'existing' }).read()).toEqual(
      before,
    );
  },
);

it.each(['epoch', 'cancel'] as const)(
  'Resume preserves %s fencing during source-free committed confirmation',
  async (fault) => {
    await compose();
    interruptAt = 'commit';
    await expect(mainHost().connect()).rejects.toThrow();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await unlink(mockSource);
    await reopen();
    await compose();
    let reached = false;
    onHostAction = async (kind): Promise<void> => {
      if (kind !== 'confirm') return;
      reached = true;
      if (fault === 'epoch') migrationEpoch++;
      else await expect(mainHost().connect(true)).rejects.toThrow('busy');
    };
    await expect(mainHost().connect()).rejects.toThrow();
    expect(reached).toBe(true);
    expect(coreHost().current()).toBe(false);
    expect(
      vault.openCopilotPilotState({ kind: 'existing' }).read().authority.head,
    ).toBeNull();
    if (fault === 'cancel') {
      onHostAction = undefined;
      coreHost().close();
      await mainHost().close();
      await closeEndpoint();
      await reopen();
      await compose();
      await mainHost().connect();
      expect(
        vault.openCopilotPilotState({ kind: 'existing' }).read().binding?.phase,
      ).toBe('retired');
      expect(
        store.listEntries().filter((e) => e.family === 'copilot-account'),
      ).toHaveLength(0);
    }
  },
);

it('Resume cannot bypass the source-generation check before writer submission', async () => {
  const replacement = `synthetic:${JSON.stringify({ ...grant, accessToken: 'replacement' })}`;
  onHostAction = async (kind): Promise<void> => {
    if (kind === 'prepare') await writeFile(mockSource, replacement);
  };
  await compose();
  await expect(mainHost().connect()).rejects.toThrow();
  expect(store.listIntents()).toHaveLength(0);
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  onHostAction = undefined;
  await reopen();
  await compose();
  await expect(mainHost().connect()).rejects.toThrow();
  expect(coreHost().current()).toBe(false);
  expect(store.listIntents()).toHaveLength(0);
  expect(await readFile(mockSource, 'utf8')).toBe(replacement);
});

it.each(['ciphertextGeneration', 'predecessorGeneration'] as const)(
  'Resume refuses disagreeing durable %s without legacy capture',
  async (field) => {
    await compose();
    await mainHost().connect();
    await mainHost().verify();
    await mainHost().cleanup();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    const file = createCopilotHandoffFile(dataRoot);
    const before = await file.read();
    if (!before) throw new Error('Missing handoff control');
    await file.write({
      ...before,
      generation: before.generation + 1,
      [field]: 'disagrees-with-authenticated-binding',
    });
    await reopen();
    await compose();
    await expect(mainHost().connect()).rejects.toThrow();
    expect(coreHost().current()).toBe(false);
    expect(store.listIntents().filter((i) => i.kind === 'put')).toHaveLength(1);
  },
);

it('Resume refuses a selected receipt nonce that disagrees with the published P4 head', async () => {
  await compose();
  await mainHost().connect();
  await mainHost().verify();
  await mainHost().cleanup();
  const before = vault.openCopilotPilotState({ kind: 'existing' }).read();
  coreHost().close();
  await mainHost().close();
  await closeEndpoint();
  await updatePreferencesFile((preferences) => {
    const selected = preferences.copilotVaultSelection;
    if (!selected) throw new Error('Missing selection');
    return {
      copilotVaultSelection: {
        ...selected,
        pinGeneration: 'disagreeing-nonce',
      },
    };
  });
  await reopen();
  await compose();
  await expect(mainHost().connect()).rejects.toThrow();
  expect(coreHost().current()).toBe(false);
  expect(vault.openCopilotPilotState({ kind: 'existing' }).read()).toEqual(
    before,
  );
});

it.each(['completed', 'control:source_detached', 'cleanup-remove-reply'])(
  'Resume restores published custody after cleanup %s without the legacy source',
  async (edge) => {
    await compose();
    await mainHost().connect();
    await mainHost().verify();
    const before = vault.openCopilotPilotState({ kind: 'existing' }).read();
    if (edge === 'completed') await mainHost().cleanup();
    else {
      interruptAt = edge;
      if (edge.startsWith('control:')) await mainHost().cleanup();
      else await expect(mainHost().cleanup()).rejects.toThrow();
      expect(interruptAt).toBeUndefined();
    }
    await expect(readFile(mockSource)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await reopen();
    await compose();
    mockDecryptFails = true;
    expect(coreHost().current()).toBe(false);
    const routed = connection();
    await routed.facade.connectCopilot(
      new AbortController().signal,
      (): void => undefined,
    );
    expect(routed.legacyCalls()).toBe(0);
    expect(coreHost().current()).toBe(true);
    expect(await mainHost().custody()).toBe('selected');
    const after = vault.openCopilotPilotState({ kind: 'existing' }).read();
    expect(after.binding).toEqual(before.binding);
    expect(after.authority.head).toEqual(before.authority.head);
    expect(store.listIntents().filter((i) => i.kind === 'put')).toHaveLength(1);
    await mainHost().cleanup();
    expect(
      vault.openCopilotPilotState({ kind: 'existing' }).migration.read()
        .attempts[0]?.state,
    ).toBe('legacy_deleted');
    await expect(readFile(mockSource)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

it.each(['absent', 'unreadable'])(
  'Resume still requires an exact source freeze for resupply when the source is %s',
  async (fault) => {
    await compose();
    interruptAt = 'pre-ingress';
    await expect(mainHost().connect()).rejects.toThrow();
    const before = vault.openCopilotPilotState({ kind: 'existing' }).read();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    if (fault === 'absent') await unlink(mockSource);
    else mockDecryptFails = true;
    await reopen();
    await compose();
    const routed = connection();
    await expect(
      routed.facade.connectCopilot(
        new AbortController().signal,
        (): void => undefined,
      ),
    ).rejects.toThrow();
    expect(routed.legacyCalls()).toBe(0);
    expect(coreHost().current()).toBe(false);
    expect(vault.openCopilotPilotState({ kind: 'existing' }).read()).toEqual(
      before,
    );
    expect(store.listIntents()).toHaveLength(0);
  },
);

it.each(['commit', 'confirm', 'confirm-reply'])(
  'Resume completes exact committed custody after %s without recapturing legacy',
  async (edge) => {
    await compose();
    interruptAt = edge;
    await expect(mainHost().connect()).rejects.toThrow();
    const before = vault.openCopilotPilotState({ kind: 'existing' }).read();
    coreHost().close();
    await mainHost().close();
    await closeEndpoint();
    await unlink(mockSource);
    await reopen();
    await compose();
    await mainHost().connect();
    expect(coreHost().current()).toBe(true);
    expect(await mainHost().custody()).toBe('selected');
    const after = vault.openCopilotPilotState({ kind: 'existing' }).read();
    expect(after.binding?.operationId).toBe(before.binding?.operationId);
    expect(after.binding?.phase).toBe('published');
    expect(after.authority.head?.operationId).toBe(before.binding?.operationId);
    expect(store.listIntents().filter((i) => i.kind === 'put')).toHaveLength(1);
    await expect(readFile(mockSource)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

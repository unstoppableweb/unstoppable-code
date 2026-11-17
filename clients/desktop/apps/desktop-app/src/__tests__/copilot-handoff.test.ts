import type * as FsPromises from 'node:fs/promises';
import type * as AtomicFile from '../main/lib/atomic-file';
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
  updatePreferencesFile as initialUpdatePreferences,
  flushPreferencesWrites as initialFlushPreferences,
  observeCopilotSelectionAuthority as initialObserveSelection,
} from '../main/lib/preferences-store';
import { getDataDir } from '../main/lib/paths';

let readCopilotCredential = initialReadCredential;
let readCopilotSelectionPreferences = initialReadSelection;
let updatePreferencesFile = initialUpdatePreferences;
let flushPreferencesWrites = initialFlushPreferences;
let observeCopilotSelectionAuthority = initialObserveSelection;
let previousHostOwner: object | undefined;
let mockSource: string;
let mockDecryptFails = false;
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
  store = await folder.opened();
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
    readCopilotSelectionPreferences = selection.readCopilotSelectionPreferences;
    updatePreferencesFile = preferences.updatePreferencesFile;
    flushPreferencesWrites = preferences.flushPreferencesWrites;
    observeCopilotSelectionAuthority =
      preferences.observeCopilotSelectionAuthority;
    createHost = handoff.createCopilotQualificationHandoff;
  });
  const state = vault.openCopilotPilotState({ kind: 'existing' });
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
  core = createCopilotHandoffCore({
    state: qualifiedState,
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
        const pilot = (modelPilot ??= createCopilotVaultPilot({
          journal: qualifiedState.journal,
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
          selection: createCopilotSelectionReceipt(),
          platform: 'darwin',
          capable: () => true,
          qualificationAdmission: () => coreHost().current(),
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
                expect([
                  grant.accessToken,
                  'synthetic-successor-access',
                ]).toContain(await context.token());
                context.admit();
                if (useFault === 'provider')
                  throw new Error('Synthetic provider failure');
                if (purpose !== 'models')
                  throw new Error('Only model discovery supported by fixture');
                return { kind: 'models', models: [] };
              },
            }),
        }));
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
    dataRoot,
    source,
    retireChannel: (): void => handler.close(),
    cancelAdmission: (): void => handler.cancelAdmission(),
    corePhase: () => Promise.resolve(handler.phase()),
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
  interruptAt = undefined;
  frames = [];
  await reopen();
  vault.openCopilotPilotState({
    kind: 'initialize-unused',
    hostFence: 'absent',
  });
});
afterEach(async () => {
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
function connection(
  open?: CopilotConnectionBackend['openManagedCopilotRuntime'],
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
    connectCopilot: () => Promise.resolve(status),
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
      vault: selected,
      agreed: () => coreHost().current(),
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
  // Exercise connection.ts itself, with only its external legacy provider/feature ports synthetic.
  jest.doMock('../main/copilot/legacy-connection', () => ({
    connectCopilot: connect,
    recoverCopilotAtStartup: recover,
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
    });
  } finally {
    jest.dontMock('../main/copilot/legacy-connection');
    jest.dontMock('../main/copilot/feature-flag');
  }
  expect(connect).toHaveBeenCalledTimes(1);
  expect(recover).toHaveBeenCalledTimes(1);
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
    expect(state.read().binding?.phase).toBe('cancelling');
    expect(state.migration.read().head.epoch).toBeGreaterThan(1);
    expect((await createCopilotHandoffFile(dataRoot).read())?.disposition).toBe(
      'cancelling',
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
    expect(state.read().binding?.phase).toBe('cancelling');
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

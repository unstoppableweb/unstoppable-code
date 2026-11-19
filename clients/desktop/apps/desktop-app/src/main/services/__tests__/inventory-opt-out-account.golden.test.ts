/**
 * Inventory sync opt-out across sign-in (CAN-5986), through the real Remote
 * Control service, its settings store, the inventory sync service and the
 * wiring main uses between them; only the cloud client and the inventory
 * readers are fakes. Turning sync off while signed out must still delete the
 * last signed-in account's lists, at that account's next sign-in, whichever
 * of its key forms (server ID or credential digest) either side knows then.
 * A break leaves lists on the web that the person asked to delete.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMOTE_PROTOCOL_VERSION } from '@canopy/protocol/remote-control';

const mockDeletes: string[] = [];
const mockSignedIn: { keys: string[] } = { keys: [] };
const mockAccountListeners: Array<() => void> = [];
/** While set, every DELETE waits for it: a delete held in flight. */
const mockDeleteHold: { until: Promise<void> | null } = { until: null };
/** While set, every DELETE fails as a network error would. */
const mockDeleteFails: { on: boolean } = { on: false };

jest.mock('../../canopy-cloud/client', () => {
  class CanopyCloudClientError extends Error {}
  return {
    CanopyCloudClientError,
    requestCanopyCloudJson: (
      path: string,
      init?: { method?: string },
    ): Promise<unknown> => {
      if (init?.method === 'DELETE') {
        mockDeletes.push(path);
        if (mockDeleteFails.on) {
          return Promise.reject(new Error('The network is down.'));
        }
        return (mockDeleteHold.until ?? Promise.resolve()).then(() => ({
          deleted: 1,
        }));
      }
      return Promise.resolve(
        init?.method === 'PUT'
          ? { accepted: [], removed: 0 }
          : { clientDeviceId: 'device-1', documents: [] },
      );
    },
  };
});
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: (): Promise<unknown> =>
    mockSignedIn.keys.length === 0
      ? Promise.reject(new Error('Signed out.'))
      : Promise.resolve({ baseUrl: 'https://cloud.test', apiKey: 'key' }),
  subscribeCanopyCloudAccountChanges: (listener: () => void): (() => void) => {
    mockAccountListeners.push(listener);
    return (): void => undefined;
  },
}));
jest.mock('../../lib/install-identity', () => ({
  getInstallId: (): Promise<string> => Promise.resolve('device-1'),
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: (): void => undefined,
}));
jest.mock('../../installed-items/installed-item-service', () => ({
  installedItemService: {
    listStatus: (): Promise<unknown> => Promise.resolve({ items: [] }),
  },
}));
jest.mock('../../plugins/invocable-inventory-service', () => ({
  subscribeInvocableInventoryChanges: (): (() => void) => (): void => undefined,
}));
jest.mock('../desktop-inventory-sync-signals', () => ({
  subscribeDesktopInventoryChanges: (): (() => void) => (): void => undefined,
}));
jest.mock('../plugin-catalog-service', () => ({
  listRemoteControlMarketplaces: (): Promise<unknown> =>
    Promise.resolve({ marketplaces: [] }),
  listRemoteControlMcpServers: (): Promise<unknown> =>
    Promise.resolve({ servers: [] }),
  listPersonalRemoteControlCollections: (): Promise<unknown> =>
    Promise.resolve({ collections: [] }),
  listPersonalRemoteControlSkills: (): Promise<unknown> =>
    Promise.resolve({ skills: [] }),
}));
jest.mock('../desktop-inventory-pipeline-documents', () => ({
  listWorktreePipelineInventoryDocuments: (): Promise<unknown> =>
    Promise.resolve({ documents: [], complete: true }),
}));

import type { LegacyPortalOptInRead } from '../../remote-control/legacy-portal-opt-in';
import type * as UploadsModule from '../../remote-control/host/uploads';
import type * as StoreModule from '../../remote-control/remote-access-store';
import type {
  RemoteAccessStore,
  RemoteControlFile,
} from '../../remote-control/remote-access-store';
import type * as ServiceModule from '../../remote-control/remote-control-service';
import type * as InventoryModule from '../desktop-inventory-sync-service';
import type * as WiringModule from '../inventory-sync-gate';
import type {
  RemoteControlService,
  RemoteInventorySyncChange,
} from '../../remote-control/remote-control-service';

const SERVER_ID = 'account:7';
const DIGEST = 'key:digest-7';

interface Harness {
  service: RemoteControlService;
  store: RemoteAccessStore;
  signIn: (keys: string[]) => Promise<void>;
  signOut: () => Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  // Reset the fakes first, so a failing cleanup can't leak this case's
  // sign-in into the next one.
  mockDeletes.length = 0;
  mockSignedIn.keys = [];
  mockAccountListeners.length = 0;
  mockDeleteHold.until = null;
  mockDeleteFails.on = false;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Lets the settings writes and the delete request settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

let modules: {
  store: typeof StoreModule;
  service: typeof ServiceModule;
  uploads: typeof UploadsModule;
  inventory: typeof InventoryModule;
  wiring: typeof WiringModule;
} | null = null;

// Loaded once here, not at the top: main modules subscribe to account
// changes as they load, and the mocks' state above must exist by then. The
// graph is large, so loading it gets its own budget instead of the first
// case's.
beforeAll(async () => {
  modules = {
    store: await import('../../remote-control/remote-access-store'),
    service: await import('../../remote-control/remote-control-service'),
    uploads: await import('../../remote-control/host/uploads'),
    inventory: await import('../desktop-inventory-sync-service'),
    wiring: await import('../inventory-sync-gate'),
  };
}, 120_000);

/**
 * Waits, within a bound, for work that follows real settings writes, and
 * fails the case with `label` when the bound passes.
 */
async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * `settings` seeds `remote-control.json` before Remote Control first reads
 * it, as an earlier session or build left it.
 */
async function createHarness(
  settings?: Partial<RemoteControlFile>,
): Promise<Harness> {
  if (modules === null) throw new Error('The modules did not load.');
  const { RemoteAccessStore } = modules.store;
  const { RemoteControlService } = modules.service;
  const { RemoteUploadStore } = modules.uploads;
  const { DesktopInventorySyncService } = modules.inventory;
  const {
    applyInventorySyncGate,
    applyInventorySyncSettingChange,
    inventorySyncDeleteHooks,
  } = modules.wiring;
  const dir = await mkdtemp(join(tmpdir(), 'inventory-opt-out-'));
  cleanups.push(async (): Promise<void> => {
    // A settings write the last step started may still be landing.
    await settle();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  if (settings !== undefined) {
    const file: RemoteControlFile = {
      version: 1,
      allowIncoming: false,
      pairedHosts: [],
      pairedControllers: [],
      ...settings,
    };
    await writeFile(join(dir, 'remote-control.json'), JSON.stringify(file));
  }
  const unavailable = (): never => {
    throw new Error('Not used: no relay starts here.');
  };
  const store = new RemoteAccessStore({
    settingsPath: join(dir, 'remote-control.json'),
    identityPath: join(dir, 'remote-control-identity.key'),
    secretStorage: {
      getStatus: unavailable,
      isWriteAvailable: (): boolean => false,
      nativeEncryptionAvailable: (): boolean => false,
      assertCanRead: unavailable,
      assertCanWrite: unavailable,
      encrypt: unavailable,
      decrypt: unavailable,
    },
  });
  const inventory = new DesktopInventorySyncService({
    clientName: (): string => 'Studio Mac',
  });
  cleanups.push((): void => inventory.dispose());
  const uploads = new RemoteUploadStore(join(dir, 'uploads'));
  const service = new RemoteControlService({
    store,
    createRelay: unavailable,
    fetchToken: (): Promise<never> =>
      Promise.reject(new Error('Not used: no relay starts here.')),
    signedInAccount: (): string | null => mockSignedIn.keys[0] ?? null,
    signedInAccountKeys: (): string[] => mockSignedIn.keys,
    deviceName: (): string => 'Studio Mac',
    platform: 'darwin',
    version: { protocolVersion: REMOTE_PROTOCOL_VERSION, appVersion: '1.0.0' },
    createBridge: (): Promise<never> =>
      Promise.reject(new Error('Not used: no controller connects here.')),
    mainWindowPushes: {
      subscribe: (): (() => void) => (): void => undefined,
    },
    uploads,
    readHostFile: (): Promise<never> => Promise.reject(new Error('Not used.')),
    openedFiles: uploads,
    markDownloaded: (): Promise<void> => Promise.resolve(),
    openLocalFile: (): Promise<void> => Promise.resolve(),
    windows: {
      open: (): void => undefined,
      close: (): void => undefined,
      focusLocal: (): void => undefined,
      deliverPush: (): void => undefined,
      reload: (): void => undefined,
      appAdvisorWindow: (): Promise<{ open: boolean; focused: boolean }> =>
        Promise.resolve({ open: false, focused: false }),
      showDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
        Promise.resolve({ canceled: true, filePaths: [] }),
    },
    // Main's wiring: the gate from every state broadcast, the opt-out and
    // restore from the setting changes.
    broadcastState: (state): void => {
      applyInventorySyncGate(
        {
          allowIncoming: state.allowIncoming,
          inventorySyncEnabled: state.inventorySyncEnabled ?? true,
        },
        inventory,
      );
    },
    onInventorySyncSettingChanged: (
      change: RemoteInventorySyncChange,
    ): void => {
      applyInventorySyncSettingChange(change, inventory, (): void => undefined);
    },
    readLegacyPortalOptIn: (): Promise<LegacyPortalOptInRead> =>
      Promise.resolve({ reliable: true, active: false }),
    webOrigin: (): string => 'https://app.example.test',
  });
  cleanups.push((): void => service.dispose());
  inventory.setDeleteHooks(inventorySyncDeleteHooks(() => service));
  inventory.start();
  await service.initialize();
  await settle();

  // Main's account subscription: Remote Control reconciles, and the
  // inventory service kicks a pending delete for the new identity.
  const accountChanged = async (): Promise<void> => {
    await service.reconcile();
    for (const listener of mockAccountListeners) listener();
    await settle();
  };
  return {
    service,
    store,
    signIn: async (keys): Promise<void> => {
      mockSignedIn.keys = keys;
      await accountChanged();
    },
    signOut: async (): Promise<void> => {
      mockSignedIn.keys = [];
      await accountChanged();
    },
  };
}

// Each case also runs under a loaded machine's full test run.
jest.setTimeout(30_000);

describe('turning inventory sync off while signed out', () => {
  it.each([
    {
      label: 'known by both forms, back under the digest only',
      before: [SERVER_ID, DIGEST],
      after: [DIGEST],
    },
    {
      label: 'known by the digest only, back under both forms',
      before: [DIGEST],
      after: [SERVER_ID, DIGEST],
    },
  ])(
    "deletes the last account's lists at its next sign-in ($label)",
    async ({ before, after }) => {
      const { service, store, signIn, signOut } = await createHarness();
      await signIn(before);
      await signOut();

      const state = await service.setInventorySyncEnabled(false);
      await settle();
      expect(state.inventorySyncEnabled).toBe(false);
      expect(state.inventoryDeleteStatus).toBe('pending');
      // Signed out, nothing can be deleted yet, and no key reaches the state.
      expect(mockDeletes).toEqual([]);
      expect(JSON.stringify(state)).not.toMatch(/account:|key:/);
      // Queued under every form the account was known by.
      expect((await store.read()).inventoryDeletePendingForUserIds).toEqual(
        before,
      );

      // Another account signing in does not delete this account's lists.
      await signIn(['key:someone-else']);
      expect(mockDeletes).toEqual([]);

      await signIn(after);
      expect(mockDeletes).toEqual([
        expect.stringContaining('clientDeviceId=device-1'),
      ]);
      expect(
        (await store.read()).inventoryDeletePendingForUserIds,
      ).toBeUndefined();
      expect((await service.getState()).inventoryDeleteStatus).toBe('idle');
    },
  );

  it('deletes nothing when no account ever signed in on this install', async () => {
    const { service, store, signIn } = await createHarness();
    const state = await service.setInventorySyncEnabled(false);
    expect(state.inventoryDeleteStatus).toBe('idle');
    expect(
      (await store.read()).inventoryDeletePendingForUserIds,
    ).toBeUndefined();
    await signIn([SERVER_ID, DIGEST]);
    expect(mockDeletes).toEqual([]);
  });

  it('turning it back on while signed out leaves nothing to delete', async () => {
    const { service, store, signIn, signOut } = await createHarness();
    await signIn([SERVER_ID, DIGEST]);
    await signOut();
    await service.setInventorySyncEnabled(false);
    const state = await service.setInventorySyncEnabled(true);
    expect(state.inventoryDeleteStatus).toBe('idle');
    expect(
      (await store.read()).inventoryDeletePendingForUserIds,
    ).toBeUndefined();
    await signIn([DIGEST]);
    expect(mockDeletes).toEqual([]);
  });

  it('reads the single remembered account an earlier build saved', async () => {
    const { service, store, signIn } = await createHarness({
      inventoryLastSignedInAccount: SERVER_ID,
    });
    await service.setInventorySyncEnabled(false);
    const file = await store.read();
    expect(file.inventoryDeletePendingForUserIds).toEqual([SERVER_ID]);
    expect(file.inventoryLastSignedInAccount).toBeUndefined();
    await signIn([SERVER_ID, DIGEST]);
    expect(mockDeletes).toHaveLength(1);
    expect(
      (await store.read()).inventoryDeletePendingForUserIds,
    ).toBeUndefined();
  });
});

describe('a delete in flight across an account change', () => {
  const OTHER_ID = 'account:8';
  const OTHER_DIGEST = 'key:digest-8';

  function holdDeletes(): () => void {
    let release: () => void = (): void => undefined;
    mockDeleteHold.until = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (): void => {
      mockDeleteHold.until = null;
      release();
    };
  }

  it("clears only its own account's forms, and the next account's delete still runs", async () => {
    const { store, signIn } = await createHarness({
      inventoryDeletePendingForUserIds: [
        SERVER_ID,
        DIGEST,
        OTHER_ID,
        OTHER_DIGEST,
      ],
      inventoryAccountKeyForms: [
        [SERVER_ID, DIGEST],
        [OTHER_ID, OTHER_DIGEST],
      ],
    });
    const release = holdDeletes();
    await signIn([SERVER_ID, DIGEST]);
    expect(mockDeletes).toHaveLength(1);

    // The first account signs out and another signs in while its delete is
    // still in flight.
    await signIn([OTHER_ID, OTHER_DIGEST]);
    release();
    // Hold the next delete too, to see the marker while it runs.
    const releaseOther = holdDeletes();

    // The second account's delete was not cleared with the first: it runs
    // once the first finishes, under the account now signed in, and its
    // marker is still saved while it does.
    await until(
      () => mockDeletes.length >= 2,
      "the second account's delete to start",
    );
    expect((await store.read()).inventoryDeletePendingForUserIds).toEqual([
      OTHER_ID,
      OTHER_DIGEST,
    ]);
    releaseOther();
    await settle();
    expect(mockDeletes).toHaveLength(2);
    expect(
      (await store.read()).inventoryDeletePendingForUserIds,
    ).toBeUndefined();
  });

  it('clears every form of its account even when nobody is signed in as it finishes', async () => {
    const { store, signIn, signOut } = await createHarness({
      inventoryDeletePendingForUserIds: [SERVER_ID, DIGEST],
      inventoryAccountKeyForms: [[SERVER_ID, DIGEST]],
    });
    const release = holdDeletes();
    await signIn([SERVER_ID, DIGEST]);
    expect(mockDeletes).toHaveLength(1);
    await signOut();
    release();
    await settle();

    expect(
      (await store.read()).inventoryDeletePendingForUserIds,
    ).toBeUndefined();
    await signIn([DIGEST]);
    expect(mockDeletes).toHaveLength(1);
  });

  it("a failed delete for one account doesn't hold up the next account's", async () => {
    const { store, signIn } = await createHarness({
      inventoryDeletePendingForUserIds: [
        SERVER_ID,
        DIGEST,
        OTHER_ID,
        OTHER_DIGEST,
      ],
      inventoryAccountKeyForms: [
        [SERVER_ID, DIGEST],
        [OTHER_ID, OTHER_DIGEST],
      ],
    });
    mockDeleteFails.on = true;
    await signIn([SERVER_ID, DIGEST]);
    expect(mockDeletes).toHaveLength(1);

    mockDeleteFails.on = false;
    await signIn([OTHER_ID, OTHER_DIGEST]);
    await until(() => mockDeletes.length >= 2, "the next account's delete");
    await settle();
    // The failed account's delete stays queued; the other one's is done.
    expect((await store.read()).inventoryDeletePendingForUserIds).toEqual([
      SERVER_ID,
      DIGEST,
    ]);
  });
});

describe('credential changes while a delete waits', () => {
  /**
   * Opts out under the first credential, with every delete failing, then
   * signs the same account in under three newer credentials: more than the
   * digests remembered per account.
   */
  async function optOutThenRotate(): Promise<Harness> {
    const harness = await createHarness();
    mockDeleteFails.on = true;
    await harness.signIn([SERVER_ID, 'key:a']);
    await harness.service.setInventorySyncEnabled(false);
    await settle();
    expect(
      (await harness.store.read()).inventoryDeletePendingForUserIds,
    ).toEqual([SERVER_ID, 'key:a']);
    for (const digest of ['key:b', 'key:c']) {
      await harness.signIn([SERVER_ID, digest]);
    }
    return harness;
  }

  it('a delete that finally succeeds leaves no marker behind', async () => {
    const { service, store, signIn } = await optOutThenRotate();
    mockDeleteFails.on = false;
    await signIn([SERVER_ID, 'key:d']);
    await until(
      () => mockDeletes.length >= 4,
      'the delete under the newest credential',
    );
    await settle();
    expect(
      (await store.read()).inventoryDeletePendingForUserIds,
    ).toBeUndefined();
    expect((await service.getState()).inventoryDeleteStatus).toBe('idle');
    // The oldest credential deletes nothing more.
    await signIn(['key:a']);
    expect(mockDeletes).toHaveLength(4);
  });

  it('opting back in leaves no marker behind', async () => {
    const { service, store, signIn } = await optOutThenRotate();
    await signIn([SERVER_ID, 'key:d']);
    mockDeleteFails.on = false;
    const deletes = mockDeletes.length;
    const state = await service.setInventorySyncEnabled(true);
    expect(state.inventoryDeleteStatus).toBe('idle');
    expect(
      (await store.read()).inventoryDeletePendingForUserIds,
    ).toBeUndefined();
    await signIn(['key:a']);
    expect(mockDeletes).toHaveLength(deletes);
  });

  it('keeps an account the marker names past the remembered-account limit', async () => {
    const { store, signIn } = await optOutThenRotate();
    for (let n = 0; n < 10; n += 1) {
      await signIn([`account:other-${String(n)}`, `key:other-${String(n)}`]);
    }
    mockDeleteFails.on = false;
    const deletes = mockDeletes.length;
    await signIn([SERVER_ID, 'key:z']);
    await until(
      () => mockDeletes.length > deletes,
      'the delete under a new credential',
    );
    await settle();
    expect(
      (await store.read()).inventoryDeletePendingForUserIds,
    ).toBeUndefined();
  });
});

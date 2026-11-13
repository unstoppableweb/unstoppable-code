jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp', on: jest.fn() },
  BrowserWindow: {
    getAllWindows: (): [] => [],
    fromWebContents: (): null => null,
  },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
  shell: { openPath: jest.fn() },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const mockHandlers = new Map<string, Handler>();
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    mockHandlers.set(channel, handler);
  },
}));

/** Every store, service and client call the owners make, in order. */
const mockCalls: string[] = [];
function mockRecord(
  name: string,
  result: unknown = { success: true, data: [] },
): (...args: unknown[]) => Promise<unknown> {
  return (...args) => {
    mockCalls.push(
      `${name} ${JSON.stringify(
        // A progress callback is the window's alone: compare the rest.
        args.filter((arg) => typeof arg !== 'function' && arg !== undefined),
      )}`,
    );
    return Promise.resolve(result);
  };
}

jest.mock('../../canopy-cloud/client', () => ({
  ...jest.requireActual<object>('../../canopy-cloud/client'),
  assertCanopyCloudCapability: mockRecord('assertCanopyCloudCapability'),
}));
jest.mock('../../skills/skill-service', () => ({
  ...jest.requireActual<object>('../../skills/skill-service'),
  loadSkills: (): object => {
    mockCalls.push('skillService.loadSkills');
    return { success: true, data: [] };
  },
  writeRawSkillForContext: mockRecord('skillService.writeRawSkillForContext', {
    skillId: 'custom:app/tone',
    skillName: 'tone',
  }),
}));
jest.mock('../../skills/skill-install-context', () => ({
  ...jest.requireActual<object>('../../skills/skill-install-context'),
  filterStoredSkillContexts: mockRecord('filterStoredSkillContexts', []),
  annotateSharedSkillInstalls: mockRecord('annotateSharedSkillInstalls', []),
  getSharedSkillWithInstallState: mockRecord('getSharedSkillWithInstallState', {
    id: 's1',
  }),
}));
jest.mock('../../skills/skill-package-install', () => ({
  ...jest.requireActual<object>('../../skills/skill-package-install'),
  installSkillCapabilityPackage: mockRecord(
    'installSkillCapabilityPackage',
    {},
  ),
}));
jest.mock('../../pipelines/pipeline-package-install-store', () => ({
  ...jest.requireActual<object>(
    '../../pipelines/pipeline-package-install-store',
  ),
  insertCapabilityPackageInstallIfAbsent: mockRecord(
    'insertCapabilityPackageInstallIfAbsent',
    undefined,
  ),
}));
jest.mock('../../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: (reason: string): void => {
    mockCalls.push(`refreshInvocableInventory ${reason}`);
  },
}));
jest.mock('../../plugins/plugin-service', () => ({
  ...jest.requireActual<object>('../../plugins/plugin-service'),
  addMarketplace: mockRecord('pluginService.addMarketplace', {
    success: false,
  }),
  installBuiltInPlugin: mockRecord('pluginService.installBuiltInPlugin', {
    success: false,
  }),
  installPlugin: mockRecord('pluginService.installPlugin', { success: false }),
  refreshMarketplaces: mockRecord('pluginService.refreshMarketplaces', {
    success: false,
  }),
}));
let mockRemoteSender = false;
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (): object | null =>
    mockRemoteSender ? {} : null,
}));
jest.mock('../../plugins/remote-install-source-gate', () => ({
  installPluginForPrincipal: (
    request: object,
    install: () => unknown,
  ): Promise<unknown> => {
    mockCalls.push(
      `installPluginForPrincipal ${JSON.stringify(request, Object.keys(request).sort())}`,
    );
    return Promise.resolve(install());
  },
}));
jest.mock('../../collections/canopy-server-client', () => ({
  listSharedCollections: mockRecord('listSharedCollections', {
    collections: [],
  }),
  getSharedCollection: mockRecord('getSharedCollection', { id: 'c1' }),
  deleteSharedCollection: mockRecord('deleteSharedCollection', undefined),
  updateSharedCollection: mockRecord('updateSharedCollection', {
    id: 'c1',
    contentHash: 'h',
    shareScope: 'team',
    updatedAt: 't',
    createdBy: { id: 'u1' },
  }),
}));
jest.mock('../../collections/collection-store', () => ({
  saveCollectionConfig: mockRecord('saveCollectionConfig', { id: 'local-1' }),
  clearCollectionRemoteMetadataByRemoteId: mockRecord(
    'clearCollectionRemoteMetadataByRemoteId',
    undefined,
  ),
  writeCollectionRemoteMetadata: mockRecord(
    'writeCollectionRemoteMetadata',
    true,
  ),
}));

import { COLLECTIONS_CHANNELS } from '@canopy/desktop-shared/constants/collection-channels';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import * as collections from '../../collections/collection-handlers';
import * as plugins from '../../plugins/plugin-handlers';
import * as skills from '../../skills/skill-handlers';

const EVENT = { sender: { id: 1, send: jest.fn() } };

function handler(channel: string): Handler {
  const found = mockHandlers.get(channel);
  if (!found) throw new Error(`no handler for ${channel}`);
  return found;
}

/** What one call does: its result and the store calls behind it. */
async function effects(
  run: () => Promise<unknown>,
): Promise<{ result: unknown; calls: string[] }> {
  mockCalls.length = 0;
  const result = await run();
  return { result, calls: [...mockCalls] };
}

beforeAll(() => {
  skills.registerSkillHandlers();
  plugins.registerPluginHandlers();
  collections.registerCollectionHandlers();
});
beforeEach(() => {
  mockRemoteSender = false;
});

describe("the window's skill, plugin and collection handlers as shared owners (CAN-6003 part B)", () => {
  it('each skill handler answers and acts exactly as its owner', async () => {
    const cases: Array<[string, unknown[], () => Promise<unknown>]> = [
      [
        SKILLS_CHANNELS.LOAD,
        [],
        (): Promise<unknown> => skills.loadSkillsForCaller(),
      ],
      [
        SKILLS_CHANNELS.WRITE_RAW,
        [{ skillName: 'tone', rawSkill: 'x' }],
        (): Promise<unknown> =>
          skills.writeRawSkillForCaller({ skillName: 'tone', rawSkill: 'x' }),
      ],
      [
        SKILLS_CHANNELS.SHARED_GET,
        ['s1'],
        (): Promise<unknown> => skills.getSharedSkillForCaller('s1'),
      ],
      [
        SKILLS_CHANNELS.PACKAGE_INSTALL,
        [{ skillId: 's1', publicShare: true }],
        (): Promise<unknown> =>
          skills.installSkillPackageForCaller({
            skillId: 's1',
            publicShare: true,
          } as never),
      ],
      [
        SKILLS_CHANNELS.RECORD_SHARE_ORIGIN,
        [{ localId: 'tone', originExternalId: 'e1', contentHash: 'h' }],
        (): Promise<unknown> =>
          skills.recordSkillShareOriginForCaller({
            localId: 'tone',
            originExternalId: 'e1',
            contentHash: 'h',
          }),
      ],
    ];
    for (const [channel, args, owner] of cases) {
      const fromWindow = await effects(() => handler(channel)(EVENT, ...args));
      const fromOwner = await effects(owner);
      // The origin's install time is the only value that differs between calls.
      const stable = (value: { calls: string[] }): string[] =>
        value.calls.map((call) => call.replace(/"installedAt":"[^"]*"/, ''));
      expect({ ...fromOwner, calls: stable(fromOwner) }).toEqual({
        ...fromWindow,
        calls: stable(fromWindow),
      });
      expect(fromWindow.calls.length).toBeGreaterThan(0);
    }
  });

  it('each plugin handler acts as its owner, passing the window sender as a remote bridge or not', async () => {
    for (const [channel, args, owner] of [
      [
        PLUGINS_CHANNELS.ADD,
        ['octo/plugins'],
        (): Promise<unknown> => plugins.addMarketplaceForCaller('octo/plugins'),
      ],
      [
        PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN,
        [{ marketplaceId: 'm1', pluginName: 'p1' }],
        (): Promise<unknown> =>
          plugins.installBuiltInPluginForCaller({
            marketplaceId: 'm1',
            pluginName: 'p1',
          } as never),
      ],
      [
        PLUGINS_CHANNELS.REFRESH,
        ['always'],
        (): Promise<unknown> => plugins.refreshMarketplacesForCaller('always'),
      ],
    ] as const) {
      const fromWindow = await effects(() => handler(channel)(EVENT, ...args));
      expect(await effects(owner)).toEqual(fromWindow);
    }
    for (const remote of [false, true]) {
      mockRemoteSender = remote;
      const fromWindow = await effects(() =>
        handler(PLUGINS_CHANNELS.INSTALL_PLUGIN)(
          EVENT,
          'm1',
          'p1',
          'https://x',
        ),
      );
      expect(
        await effects(() =>
          plugins.installPluginForCaller({
            marketplaceId: 'm1',
            pluginName: 'p1',
            sourceUrl: 'https://x',
            remote,
          }),
        ),
      ).toEqual(fromWindow);
      expect(fromWindow.calls[0]).toContain(`"remote":${remote}`);
    }
  });

  it('each collection handler answers and acts exactly as its owner', async () => {
    for (const [channel, args, owner] of [
      [
        COLLECTIONS_CHANNELS.SHARED_LIST,
        [{ query: 'kit' }],
        (): Promise<unknown> =>
          collections.listSharedCollectionsForCaller({ query: 'kit' }),
      ],
      [
        COLLECTIONS_CHANNELS.SHARED_GET,
        ['c1'],
        (): Promise<unknown> => collections.getSharedCollectionForCaller('c1'),
      ],
      [
        COLLECTIONS_CHANNELS.SHARED_UPDATE,
        [
          {
            collectionId: 'c1',
            rawCollection: 'r',
            sourceCollectionId: 'local-1',
          },
        ],
        (): Promise<unknown> =>
          collections.updateSharedCollectionForCaller({
            collectionId: 'c1',
            rawCollection: 'r',
            sourceCollectionId: 'local-1',
          }),
      ],
      [
        COLLECTIONS_CHANNELS.SHARED_DELETE,
        [{ collectionId: 'c1' }],
        (): Promise<unknown> =>
          collections.deleteSharedCollectionForCaller({ collectionId: 'c1' }),
      ],
      [
        COLLECTIONS_CHANNELS.SAVE_COLLECTION,
        [{ name: 'Kit', id: 'local-1' }],
        (): Promise<unknown> =>
          collections.saveCollectionForCaller({ name: 'Kit', id: 'local-1' }),
      ],
    ] as const) {
      const fromWindow = await effects(() => handler(channel)(EVENT, ...args));
      expect(await effects(owner)).toEqual(fromWindow);
      expect(fromWindow.calls.length).toBeGreaterThan(0);
    }
  });
});

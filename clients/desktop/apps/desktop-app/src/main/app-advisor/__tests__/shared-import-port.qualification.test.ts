jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

/**
 * One recording backend behind both the window's preload APIs and Electron
 * main's owners, so the same import through either port can be compared.
 */
const mockCalls: string[] = [];
const mockBackend = {
  loadSkills: (): Promise<object> => {
    mockCalls.push('skills.loadSkills');
    return Promise.resolve({ success: true, data: [] });
  },
  readRawSkill: (skillId: string): Promise<string> => {
    mockCalls.push(`skills.readRawSkill ${skillId}`);
    return Promise.resolve('');
  },
  writeRawSkill: (input: { skillName: string }): Promise<object> => {
    mockCalls.push(`skills.writeRawSkill ${JSON.stringify(input)}`);
    return Promise.resolve({
      skillId: `custom:app/${input.skillName}`,
      skillName: input.skillName,
    });
  },
  installSkills: (source: string, names: string[]): Promise<object> => {
    mockCalls.push(`skills.installSkills ${source} ${names.join(',')}`);
    return Promise.resolve(
      source === 'octo/broken'
        ? { success: false, error: 'Repository not found.' }
        : { success: true },
    );
  },
  getShared: (id: string): Promise<object> => {
    mockCalls.push(`skills.getShared ${id}`);
    return Promise.resolve({ installedCopyIds: [] });
  },
  installCapabilityPackage: (request: object): Promise<object> => {
    mockCalls.push(
      `skills.installCapabilityPackage ${JSON.stringify(request)}`,
    );
    return Promise.resolve({});
  },
  recordShareOrigin: (request: object): Promise<void> => {
    mockCalls.push(`skills.recordShareOrigin ${JSON.stringify(request)}`);
    return Promise.resolve();
  },
  loadMarketplaces: (cacheOnly?: boolean): Promise<object> => {
    mockCalls.push(`plugins.loadMarketplaces${cacheOnly ? ' cache' : ''}`);
    return Promise.resolve({ success: true, data: { marketplaces: [] } });
  },
  refreshMarketplaces: (providerUpdates?: string): Promise<object> => {
    mockCalls.push(`plugins.refreshMarketplaces ${providerUpdates ?? ''}`);
    return Promise.resolve({ success: true, data: { marketplaces: [] } });
  },
  addMarketplace: (repo: string): Promise<object> => {
    mockCalls.push(`plugins.addMarketplace ${repo}`);
    return Promise.resolve({ success: false, error: 'Not a marketplace.' });
  },
  installPlugin: (request: object): Promise<object> => {
    mockCalls.push(`plugins.installPlugin ${JSON.stringify(request)}`);
    return Promise.resolve({ success: false, error: 'Not installed.' });
  },
  installBuiltInPlugin: (request: object): Promise<object> => {
    mockCalls.push(`plugins.installBuiltInPlugin ${JSON.stringify(request)}`);
    return Promise.resolve({ success: false, error: 'Not installed.' });
  },
};

let mockOrgProjects = false;
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): object => ({
    isEnabled: (): boolean => mockOrgProjects,
  }),
}));
jest.mock('../../skills/skill-handlers', () => ({
  loadSkillsForCaller: (): Promise<object> => mockBackend.loadSkills(),
  writeRawSkillForCaller: (input: { skillName: string }): Promise<object> =>
    mockBackend.writeRawSkill(input),
  getSharedSkillForCaller: (id: string): Promise<object> =>
    mockBackend.getShared(id),
  installSkillPackageForCaller: (request: object): Promise<object> =>
    mockBackend.installCapabilityPackage(request),
  recordSkillShareOriginForCaller: (request: object): Promise<void> =>
    mockBackend.recordShareOrigin(request),
}));
jest.mock('../../skills/skill-service', () => ({
  readRawSkill: (id: string): Promise<string> => mockBackend.readRawSkill(id),
}));
jest.mock('../../canopy-runtime/skill-catalog-dispatch', () => ({
  installSkillsThroughCore: (
    source: string,
    names: string[],
  ): Promise<object> => mockBackend.installSkills(source, names),
}));
jest.mock('../../plugins/plugin-service', () => ({
  loadMarketplacesForPresentation: (
    _progress?: unknown,
    cacheOnly?: boolean,
  ): Promise<object> => mockBackend.loadMarketplaces(cacheOnly),
}));
const mockInstallRequests: object[] = [];
jest.mock('../../plugins/plugin-handlers', () => ({
  addMarketplaceForCaller: (repo: string): Promise<object> =>
    mockBackend.addMarketplace(repo),
  refreshMarketplacesForCaller: (providerUpdates?: string): Promise<object> =>
    mockBackend.refreshMarketplaces(providerUpdates),
  installPluginForCaller: (request: object): Promise<object> => {
    mockInstallRequests.push(request);
    return mockBackend.installPlugin(request);
  },
  installBuiltInPluginForCaller: (request: object): Promise<object> =>
    mockBackend.installBuiltInPlugin(request),
}));

import type { SharedImportPort } from '@canopy/desktop-shared/lib/shared-import/port';
import {
  resolveSharedCollectionImport,
  type SharedCollectionImportSource,
} from '@canopy/desktop-shared/lib/shared-import/shared-collection-import';
import { mainSharedImportPort } from '../shared-import-port';

/** The window's preload APIs over the same backend. */
const windowPort: SharedImportPort = {
  skills: {
    loadSkills: () => mockBackend.loadSkills(),
    readRawSkill: (id: string) => mockBackend.readRawSkill(id),
    writeRawSkill: (input: { skillName: string }) =>
      mockBackend.writeRawSkill(input),
    installSkills: (source: string, names: string[]) =>
      mockBackend.installSkills(source, names),
    getShared: (id: string) => mockBackend.getShared(id),
    installCapabilityPackage: (request: object) =>
      mockBackend.installCapabilityPackage(request),
    recordShareOrigin: (request: object) =>
      mockBackend.recordShareOrigin(request),
  },
  plugins: {
    loadMarketplaces: () => mockBackend.loadMarketplaces(),
    loadMarketplacesCacheOnly: () => mockBackend.loadMarketplaces(true),
    refreshMarketplaces: (providerUpdates?: string) =>
      mockBackend.refreshMarketplaces(providerUpdates),
    addMarketplace: (repo: string) => mockBackend.addMarketplace(repo),
    installPlugin: (
      marketplaceId: string,
      pluginName: string,
      sourceUrl: string,
    ) => mockBackend.installPlugin({ marketplaceId, pluginName, sourceUrl }),
    installBuiltInPlugin: (request: object) =>
      mockBackend.installBuiltInPlugin(request),
  },
  receiptsEnforced: () => mockOrgProjects,
} as never;

const SOURCE: SharedCollectionImportSource = {
  collection: {
    name: 'Release kit',
    items: [
      {
        type: 'skill',
        source: { type: 'builtin', id: 'anthropic' },
        skill_name: 'pdf',
      },
      {
        type: 'skill',
        source: { type: 'github', repo: 'octo/skills' },
        skill_name: 'changelog',
      },
      {
        type: 'skill',
        source: { type: 'github', repo: 'octo/broken' },
        skill_name: 'gone',
        required: true,
      },
      {
        type: 'custom_skill',
        skillId: 'skill-9',
        skill_name: 'tone',
        contentHash: 'h9',
      },
    ],
  },
  customSkills: [
    {
      id: 'skill-9',
      name: 'tone',
      rawSkill: '---\nname: tone\n---\nBe brief.\n',
      contentHash: 'h9',
    },
  ],
} as never;

async function importWith(
  port: SharedImportPort,
): Promise<{ calls: string[]; result: unknown }> {
  mockCalls.length = 0;
  const result = await resolveSharedCollectionImport(port, SOURCE);
  return { calls: [...mockCalls], result };
}

beforeEach(() => {
  mockOrgProjects = false;
  mockInstallRequests.length = 0;
});

describe('shared imports through the window and through Electron main (CAN-6003 part B)', () => {
  it('make the same calls and answer the same result from either port, installing a GitHub skill through core.catalog.skill.install', async () => {
    const fromWindow = await importWith(windowPort);
    const fromMain = await importWith(mainSharedImportPort({ remote: false }));
    expect(fromMain).toEqual(fromWindow);
    expect(fromWindow.result).toEqual({
      skills: [
        { sourceId: 'builtin:anthropic', skillName: 'pdf' },
        { sourceId: 'github:octo:skills', skillName: 'changelog' },
        { sourceId: 'custom:app', skillName: 'tone' },
      ],
      plugins: [],
      failures: [
        { label: 'gone', required: true, message: 'Repository not found.' },
      ],
    });
    expect(fromWindow.calls).toContain(
      'skills.installSkills octo/skills changelog',
    );
  });

  it('follows the organization-projects flag for receipts, and installs a plugin as a remote principal only for a chat a controlling computer drives', async () => {
    mockOrgProjects = true;
    const fromWindow = await importWith(windowPort);
    const fromMain = await importWith(mainSharedImportPort({ remote: false }));
    expect(fromMain).toEqual(fromWindow);
    // A chat this computer drives installs as its own window would; one a
    // controlling computer drives keeps the remote principal's source checks.
    await mainSharedImportPort({ remote: false }).plugins.installPlugin(
      'm1',
      'p1',
      'https://x',
    );
    await mainSharedImportPort({ remote: true }).plugins.installPlugin(
      'm1',
      'p1',
      'https://x',
    );
    expect(mockInstallRequests).toEqual([
      {
        marketplaceId: 'm1',
        pluginName: 'p1',
        sourceUrl: 'https://x',
        remote: false,
      },
      {
        marketplaceId: 'm1',
        pluginName: 'p1',
        sourceUrl: 'https://x',
        remote: true,
      },
    ]);
  });
});

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import { buildPluginMemberInventory } from '@canopy/plugin-interop';
import {
  parsePluginManifestPreviewResult,
  PLUGIN_MANIFEST_PREVIEW_README_MAX_LENGTH,
  type ItemHarnessInstalls,
  type MarketplaceInfo,
  type PluginInfo,
  type PluginManifestPreview,
} from '@canopy/protocol/plugins';
import { forgetHarnessCopyFingerprints } from '../../lib/harness-copy-fingerprint';
import { parseCatalogFrontmatterAndBody } from '../../lib/frontmatter';
import type * as StandInRuntime from '../stand-in-runtime';
import type * as PluginService from '../plugin-service';
import type * as PluginCatalogStore from '../plugin-catalog-store';
import { getPluginHarnessInstallsFilePath } from '../../lib/paths';

// One Add for every harness, for plugins (CAN-6816). The registered plugin
// handlers, the record store, the session member listing and the harness
// compatibility rules run as production code over on-disk plugin fixtures.
// Only the plugin catalog cache (served here as a fixture) and unrelated
// hosts are replaced; no harness runtime is installed, so main confirms none
// itself and the renderer's list decides the targets.
// Runs once on the next catalog read: work landing while an Add looks up
// the copy it is about to install.
let duringCatalogRead: (() => Promise<void>) | undefined;
let cache: {
  version: 2;
  lastRefreshed: string;
  marketplaces: MarketplaceInfo[];
};
jest.mock('../plugin-service', () => ({
  // A marketplace update as the service reports it (CAN-6817); the fixture
  // plugin folders are changed on disk by the test itself.
  updateMarketplace: (): Promise<unknown> =>
    Promise.resolve({ success: true, data: {} }),
  loadMarketplacesCacheOnly: async (): Promise<unknown> => {
    const during = duringCatalogRead;
    duringCatalogRead = undefined;
    await during?.();
    return { success: true, data: structuredClone(cache) };
  },
  loadMarketplacesForPresentation: (): Promise<unknown> =>
    Promise.resolve({ success: true, data: structuredClone(cache) }),
  readComponentContent: (
    ...args: Parameters<typeof PluginService.readComponentContent>
  ): ReturnType<typeof PluginService.readComponentContent> =>
    jest
      .requireActual<typeof PluginService>('../plugin-service')
      .readComponentContent(...args),
  installPlugin: (marketplaceId: string, pluginName: string): unknown => {
    clonedPlugins.push(`${marketplaceId}/${pluginName}`);
    return Promise.resolve({
      success: true,
      data: structuredClone(
        cache.marketplaces
          .find((marketplace) => marketplace.id === marketplaceId)
          ?.plugins.find((plugin) => plugin.name === pluginName),
      ),
    });
  },
  // Handlers that answer with one plugin row, as the service returns it.
  prepareCodexCompatibilityPlugin: (
    marketplaceId: string,
    pluginName: string,
  ): Promise<unknown> =>
    Promise.resolve({
      success: true,
      data: structuredClone(
        cache.marketplaces
          .find((marketplace) => marketplace.id === marketplaceId)
          ?.plugins.find((plugin) => plugin.name === pluginName),
      ),
    }),
}));
jest.mock('../plugin-catalog-store', () => ({
  ...jest.requireActual<typeof PluginCatalogStore>('../plugin-catalog-store'),
  readPluginCatalogHealth: (): unknown => ({
    state: 'present',
    data: structuredClone(cache),
  }),
}));
jest.mock('../shareable-plugin-resolution', () => ({}));
jest.mock('../curated-plugin-events', () => ({}));
jest.mock('../invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: jest.fn(),
}));
// A plugin install as the service reports it, through the same source gate
// as any install. No native copy here comes from an external source, so an
// Add never clones one.
const clonedPlugins: string[] = [];
jest.mock('../remote-install-source-gate', () => ({
  installPluginForPrincipal: (
    request: { marketplaceId: string; pluginName: string },
    install: (marketplaceId: string, pluginName: string) => Promise<unknown>,
  ): Promise<unknown> => install(request.marketplaceId, request.pluginName),
}));
// The installed-item service: the plugins installed on their own, which an
// Add leaves alone, and the uninstall that removes the copies an item
// brought along.
let installedTargets: unknown[] = [];
const uninstalledTargets: unknown[] = [];
const mutationOrder: string[] = [];
// Runs once while an Add reads the installed list: an uninstall landing
// while the item's copies are about to install.
let duringInstalledRead: (() => Promise<void>) | undefined;
jest.mock('../../installed-items/installed-item-service', () => ({
  installedItemService: {
    listStatus: async (): Promise<unknown> => {
      const during = duringInstalledRead;
      duringInstalledRead = undefined;
      await during?.();
      return {
        items: installedTargets.map((target) => ({
          target,
          status: 'active',
          removable: true,
          notices: [],
        })),
      };
    },
    uninstall: (request: { target: unknown }): Promise<void> => {
      uninstalledTargets.push(request.target);
      mutationOrder.push('companion removed');
      return Promise.resolve();
    },
  },
}));
// A window of this desktop, not a remote bridge (CAN-6817 retry restore).
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (): null => null,
}));
jest.mock('../canopy-server-client', () => ({}));
jest.mock('../../lib/web-contents-send', () => ({}));
jest.mock('../../pipelines/pipeline-package-service', () => ({}));
jest.mock('../../sharing/share-operation-result', () => ({}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
  logMainProcessError: jest.fn(),
}));
jest.mock('../../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: (): boolean => false,
}));
jest.mock('../../copilot/feature-flag', () => ({
  isCopilotHarnessEnabled: (): boolean => false,
}));
jest.mock('../../opencode/feature-flag', () => ({
  isOpenCodeHarnessEnabled: (): boolean => false,
}));
jest.mock('../../auth/provider-auth-state', () => ({
  getCachedClaudeAuthStatusObserved: (): Promise<{ authenticated: boolean }> =>
    Promise.resolve({ authenticated: false }),
  getCachedCodexAuthStatusObserved: (): Promise<{ authenticated: boolean }> =>
    Promise.resolve({ authenticated: false }),
}));
jest.mock('../../agents/user-supplied-credential', () => ({
  hasUserSuppliedProviderCredential: (): boolean => false,
}));
jest.mock('../../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
// New Customize on, as main evaluates it (CAN-6817), unless a case turns
// it off.
let discoveryEnabledInMain = true;
jest.mock('../../lib/customize-discovery-enabled', () => ({
  isCustomizeDiscoveryEnabledInMain: (): Promise<boolean> =>
    Promise.resolve(discoveryEnabledInMain),
}));
// The real stand-in runtime, with a hook for work landing while an
// uninstall forgets the item's stand-in.
let duringStandInForget: (() => Promise<void>) | undefined;
jest.mock('../stand-in-runtime', () => {
  const actual: typeof StandInRuntime = jest.requireActual(
    '../stand-in-runtime',
  );
  return {
    ...actual,
    forgetPluginStandIn: async (key: string): Promise<void> => {
      const during = duringStandInForget;
      duringStandInForget = undefined;
      await during?.();
      await actual.forgetPluginStandIn(key);
    },
  };
});

import { registerIpcHandler } from '../../ipc/register';
import {
  forgetItemHarnessInstalls,
  itemHarnessInstallStore,
} from '../harness-install-runtime';
import { runSerializedPluginMutation } from '../plugin-mutation-queue';
import { registerPluginHandlers } from '../plugin-handlers';
import { resetPluginManifestPreviewCache } from '../plugin-manifest-preview';

const HARNESSES = ['claude', 'codex', 'cursor', 'copilot', 'opencode'];

// Waits for every queued plugin mutation, companion removals included.
const drainPluginMutations = (): Promise<void> =>
  runSerializedPluginMutation(() => Promise.resolve());
let root = '';

function handler(channel: string): (...args: unknown[]) => unknown {
  const found = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([name]) => name === channel)?.[1];
  if (!found) throw new Error(`Missing ${channel} handler`);
  return (...args): unknown => {
    const result: unknown = Reflect.apply(found, undefined, [
      { sender: {} },
      ...args,
    ]);
    return result;
  };
}

async function writePlugin(
  dir: string,
  manifestPath: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, text] of Object.entries({
    [manifestPath]: JSON.stringify(manifest),
    ...files,
  })) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

function facet(
  provider: 'claude' | 'codex',
  name: string,
  dir: string,
  details: Partial<NonNullable<PluginInfo['details']>>,
): NonNullable<PluginInfo['facets']['claude']> {
  return {
    provider,
    mode: 'native',
    name,
    description: '',
    version: '1.0.0',
    author: '',
    category: '',
    homepage: '',
    installLocation: dir,
    sourcePath: dir,
    details: {
      skills: [],
      agents: [],
      commands: [],
      hooks: [],
      mcpServers: [],
      lspServers: [],
      hasReadme: false,
      ...details,
    },
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'plugin-every-harness-'));
  const codexDir = join(root, 'codex-only');
  await writePlugin(
    codexDir,
    '.codex-plugin/plugin.json',
    { name: 'codex-only' },
    {
      'skills/review/SKILL.md':
        '---\nname: review\ndescription: Review\n---\nBody\n',
    },
  );
  const claudeDir = join(root, 'claude-hooks');
  await writePlugin(
    claudeDir,
    '.claude-plugin/plugin.json',
    { name: 'claude-hooks' },
    {
      'skills/lint/SKILL.md': '---\nname: lint\ndescription: Lint\n---\nBody\n',
      'agents/helper.md': '---\nname: helper\ndescription: Helper\n---\n',
    },
  );
  // The same integration in two providers' official marketplaces: a Codex
  // plugin whose commands a Claude Code session can't load, and its Claude
  // plugin listing.
  const slackCodexDir = join(root, 'slack-codex');
  await writePlugin(
    slackCodexDir,
    '.codex-plugin/plugin.json',
    { name: 'slack' },
    { 'commands/post.md': '---\ndescription: Post\n---\nPost\n' },
  );
  const slackClaudeDir = join(root, 'slack-claude');
  await writePlugin(
    slackClaudeDir,
    '.claude-plugin/plugin.json',
    { name: 'slack' },
    {
      'skills/post/SKILL.md': '---\nname: post\ndescription: Post\n---\nBody\n',
    },
  );
  const skill = {
    name: 'review',
    description: 'Review',
    path: 'skills/review',
  };
  const plugins: PluginInfo[] = [
    {
      name: 'codex-only',
      marketplaceId: 'fixture',
      sourcePath: codexDir,
      providerSupport: { claude: 'none', codex: 'native' },
      facets: {
        codex: facet('codex', 'codex-only', codexDir, { skills: [skill] }),
      },
    },
    {
      name: 'claude-hooks',
      marketplaceId: 'fixture',
      sourcePath: claudeDir,
      providerSupport: { claude: 'native', codex: 'compat' },
      facets: {
        claude: facet('claude', 'claude-hooks', claudeDir, {
          skills: [{ name: 'lint', description: 'Lint', path: 'skills/lint' }],
          agents: [
            {
              name: 'helper',
              description: 'Helper',
              filePath: 'agents/helper.md',
            },
          ],
          hooks: [{ event: 'Stop', hookType: 'command', command: 'echo done' }],
        }),
      },
    },
  ];
  cache = {
    version: 2,
    lastRefreshed: '2026-11-15T00:00:00.000Z',
    marketplaces: [
      {
        id: 'fixture',
        name: 'Fixture',
        installLocation: root,
        plugins,
      } as unknown as MarketplaceInfo,
      {
        id: 'openai-curated',
        name: 'OpenAI curated',
        installLocation: root,
        plugins: [
          {
            name: 'notion',
            marketplaceId: 'openai-curated',
            sourcePath: slackCodexDir,
            providerSupport: { claude: 'none', codex: 'native' },
            facets: {
              codex: facet('codex', 'notion', slackCodexDir, {
                commands: [
                  {
                    name: 'post',
                    description: 'Post',
                    filePath: 'commands/post.md',
                  },
                ],
              }),
            },
          },
          {
            name: 'linear',
            marketplaceId: 'openai-curated',
            sourcePath: slackCodexDir,
            providerSupport: { claude: 'none', codex: 'native' },
            facets: {
              codex: facet('codex', 'linear', slackCodexDir, {
                commands: [
                  {
                    name: 'post',
                    description: 'Post',
                    filePath: 'commands/post.md',
                  },
                ],
              }),
            },
          },
          {
            name: 'slack',
            marketplaceId: 'openai-curated',
            sourcePath: slackCodexDir,
            providerSupport: { claude: 'none', codex: 'native' },
            facets: {
              codex: facet('codex', 'slack', slackCodexDir, {
                commands: [
                  {
                    name: 'post',
                    description: 'Post',
                    filePath: 'commands/post.md',
                  },
                ],
              }),
            },
          },
        ],
      } as unknown as MarketplaceInfo,
      {
        // The same Codex plugin listed again, from the remote catalog.
        id: 'openai-curated-remote',
        name: 'OpenAI curated (remote)',
        installLocation: root,
        plugins: [
          {
            name: 'slack',
            marketplaceId: 'openai-curated-remote',
            sourcePath: slackCodexDir,
            providerSupport: { claude: 'none', codex: 'native' },
            facets: {
              codex: facet('codex', 'slack', slackCodexDir, {
                commands: [
                  {
                    name: 'post',
                    description: 'Post',
                    filePath: 'commands/post.md',
                  },
                ],
              }),
            },
          },
        ],
      } as unknown as MarketplaceInfo,
      {
        // A third-party listing that only shares the name: never a copy.
        id: 'acme',
        name: 'Acme',
        installLocation: root,
        plugins: [
          {
            name: 'linear',
            marketplaceId: 'acme',
            author: 'Acme',
            sourcePath: slackClaudeDir,
            providerSupport: { claude: 'native', codex: 'compat' },
            facets: {
              claude: facet('claude', 'linear', slackClaudeDir, {
                skills: [
                  { name: 'post', description: 'Post', path: 'skills/post' },
                ],
              }),
            },
          },
          {
            name: 'slack',
            marketplaceId: 'acme',
            author: 'Acme',
            sourcePath: slackClaudeDir,
            providerSupport: { claude: 'native', codex: 'compat' },
            facets: {
              claude: facet('claude', 'slack', slackClaudeDir, {
                skills: [
                  { name: 'post', description: 'Post', path: 'skills/post' },
                ],
              }),
            },
          },
        ],
      } as unknown as MarketplaceInfo,
      {
        id: 'claude-plugins-official',
        name: 'Claude official',
        installLocation: root,
        plugins: [
          {
            // Listed for Claude Code, but nothing in it loads there.
            name: 'notion',
            marketplaceId: 'claude-plugins-official',
            sourcePath: slackCodexDir,
            providerSupport: { claude: 'native', codex: 'native' },
            facets: {
              codex: facet('codex', 'notion', slackCodexDir, {
                commands: [
                  {
                    name: 'post',
                    description: 'Post',
                    filePath: 'commands/post.md',
                  },
                ],
              }),
            },
          },
          {
            name: 'slack',
            marketplaceId: 'claude-plugins-official',
            sourcePath: slackClaudeDir,
            providerSupport: { claude: 'native', codex: 'compat' },
            facets: {
              claude: facet('claude', 'slack', slackClaudeDir, {
                skills: [
                  { name: 'post', description: 'Post', path: 'skills/post' },
                ],
              }),
            },
          },
        ],
      } as unknown as MarketplaceInfo,
    ],
  };
  registerPluginHandlers();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(getPluginHarnessInstallsFilePath(), { force: true });
});

test('one Add records every set-up harness, native first, with what each leaves out, and Try again checks one harness', async () => {
  const install = handler(PLUGINS_CHANNELS.INSTALL_FOR_HARNESSES);
  const retry = handler(PLUGINS_CHANNELS.RETRY_HARNESS_INSTALL);
  const load = handler(PLUGINS_CHANNELS.LOAD);
  const cacheBefore = JSON.stringify(cache);

  // A Codex-only plugin: native for Codex, its skills converted for Claude
  // Code and the Cursor family.
  const codexOnly = (await install({
    item: {
      kind: 'plugin',
      marketplaceId: 'fixture',
      pluginName: 'codex-only',
    },
    harnesses: HARNESSES,
  })) as ItemHarnessInstalls;
  const expected: Record<string, unknown> = {};
  for (const harness of HARNESSES)
    expected[harness] = expect.objectContaining({
      status: 'installed',
      via: harness === 'codex' ? 'native' : 'converted',
    });
  expect(codexOnly.harnesses).toEqual(expected);

  // A Claude plugin with agents and hooks: native for Claude Code; the
  // Cursor family loads its skill and leaves the rest out.
  const partial = (await install({
    item: {
      kind: 'plugin',
      marketplaceId: 'fixture',
      pluginName: 'claude-hooks',
    },
    harnesses: ['claude', 'cursor'],
  })) as ItemHarnessInstalls;
  expect(partial.harnesses.claude).toEqual(
    expect.objectContaining({ status: 'installed', via: 'native' }),
  );
  expect(partial.harnesses.cursor).toEqual(
    expect.objectContaining({
      status: 'installed',
      leftOut: ['agents', 'hooks'],
    }),
  );

  // The rows the window loads carry both records; the cache is not changed.
  const loaded = (await load()) as {
    data: { marketplaces: MarketplaceInfo[] };
  };
  const served = loaded.data.marketplaces[0].plugins;
  expect(served.map((plugin) => plugin.harnessInstalls)).toEqual([
    codexOnly,
    partial,
  ]);
  expect(JSON.stringify(cache)).toBe(cacheBefore);

  // A handler that answers with one plugin row carries its record too, so
  // the page that replaces its plugin with that row keeps the per-harness
  // notes.
  const prepared = (await handler(PLUGINS_CHANNELS.PREPARE_CODEX_COMPATIBILITY)(
    'fixture',
    'claude-hooks',
  )) as { data: PluginInfo };
  expect(prepared.data.harnessInstalls).toEqual(partial);

  // Try again checks one recorded harness and keeps the others.
  const retried = (await retry({
    item: {
      kind: 'plugin',
      marketplaceId: 'fixture',
      pluginName: 'claude-hooks',
    },
    harness: 'cursor',
  })) as ItemHarnessInstalls;
  expect(retried.harnesses.claude).toEqual(partial.harnesses.claude);
  await expect(
    retry({
      item: {
        kind: 'plugin',
        marketplaceId: 'fixture',
        pluginName: 'claude-hooks',
      },
      harness: 'codex',
    }),
  ).rejects.toThrow('not installed for Codex');
  await expect(
    install({
      item: {
        kind: 'plugin',
        marketplaceId: 'fixture',
        pluginName: 'codex-only',
      },
      harnesses: ['vim'],
    }),
  ).rejects.toThrow('Unknown harness');

  // The record file holds only the records, keyed by item.
  const file = JSON.parse(
    await readFile(getPluginHarnessInstallsFilePath(), 'utf8'),
  ) as { version: number; items: Record<string, unknown> };
  expect(file.version).toBe(1);
  expect(Object.keys(file.items).sort()).toEqual([
    'plugin:fixture/claude-hooks',
    'plugin:fixture/codex-only',
  ]);
  expect(existsSync(join(root, 'codex-only', '.claude-plugin'))).toBe(false);
});

test('an update rebuilds every harness from the new version; a copy changed outside the app warns until Try again repairs it', async () => {
  const install = handler(PLUGINS_CHANNELS.INSTALL_FOR_HARNESSES);
  const update = handler(PLUGINS_CHANNELS.UPDATE);
  const retry = handler(PLUGINS_CHANNELS.RETRY_HARNESS_INSTALL);
  const load = handler(PLUGINS_CHANNELS.LOAD);
  const item = {
    kind: 'plugin',
    marketplaceId: 'fixture',
    pluginName: 'codex-only',
  } as const;
  const served = async (): Promise<ItemHarnessInstalls | undefined> =>
    (
      (await load()) as { data: { marketplaces: MarketplaceInfo[] } }
    ).data.marketplaces[0].plugins.find(
      (plugin) => plugin.name === 'codex-only',
    )?.harnessInstalls;
  const dir = join(root, 'codex-only');
  await writePlugin(
    dir,
    '.codex-plugin/plugin.json',
    { name: 'codex-only', version: '1.0.0' },
    {},
  );
  await install({ item, harnesses: HARNESSES });

  // The publisher ships 2.0.0: every harness is checked against it.
  await writePlugin(
    dir,
    '.codex-plugin/plugin.json',
    { name: 'codex-only', version: '2.0.0' },
    {
      'skills/review/SKILL.md':
        '---\nname: review\ndescription: Review v2\n---\nBody\n',
    },
  );
  await update('fixture');
  const updated = await served();
  for (const harness of HARNESSES)
    expect(updated?.harnesses[harness as 'claude']).toEqual(
      expect.objectContaining({ status: 'installed', version: '2.0.0' }),
    );

  // Edited by hand: every harness reading that copy warns; the saved record
  // is unchanged, and Try again records the copy as it is now.
  await writeFile(join(dir, 'skills/review/SKILL.md'), 'edited\n');
  forgetHarnessCopyFingerprints();
  expect((await served())?.harnesses.cursor).toEqual(
    expect.objectContaining({ status: 'failed', outsideChange: 'changed' }),
  );
  await retry({ item, harness: 'cursor' });
  expect((await served())?.harnesses.cursor).toEqual(
    expect.objectContaining({ status: 'installed' }),
  );
});

test("one Add brings the native copy for a harness the item can't serve, and removing the item removes it", async () => {
  const install = handler(PLUGINS_CHANNELS.INSTALL_FOR_HARNESSES);
  const item = {
    kind: 'plugin',
    marketplaceId: 'openai-curated',
    pluginName: 'slack',
  } as const;

  const companion = {
    kind: 'plugin',
    marketplaceId: 'claude-plugins-official',
    pluginName: 'slack',
  } as const;

  const readRecords = async (): Promise<
    Record<string, ItemHarnessInstalls | undefined>
  > =>
    (
      JSON.parse(
        await readFile(getPluginHarnessInstallsFilePath(), 'utf8'),
      ) as {
        items: Record<string, ItemHarnessInstalls>;
      }
    ).items;

  // Uninstalled while its copies are about to install: no copy is left
  // behind without the item that brought it.
  duringInstalledRead = (): Promise<void> => forgetItemHarnessInstalls(item);
  await install({ item, harnesses: ['claude', 'codex'] });
  await drainPluginMutations();
  const leftBehind =
    (await readRecords())['plugin:claude-plugins-official/slack'] !==
      undefined && uninstalledTargets.length === 0;
  expect(leftBehind).toBe(false);
  uninstalledTargets.length = 0;

  // A copy that serves none of its harnesses goes again rather than stay
  // behind unowned, so a later Add can retry it.
  const notion = {
    kind: 'plugin',
    marketplaceId: 'claude-plugins-official',
    pluginName: 'notion',
  } as const;
  const unserved = (await install({
    item: { ...item, pluginName: 'notion' },
    harnesses: ['claude', 'codex'],
  })) as ItemHarnessInstalls;
  expect(unserved.companions).toBeUndefined();
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([notion]);
  uninstalledTargets.length = 0;

  // An official item alone vouches for nothing: a third-party plugin that
  // only shares its name never comes along.
  const unrelated = (await install({
    item: { ...item, pluginName: 'linear' },
    harnesses: ['claude', 'codex'],
  })) as ItemHarnessInstalls;
  expect(unrelated.companions).toBeUndefined();

  // A copy the user installed on their own is left alone: not linked, so
  // removing the item never removes it.
  installedTargets = [companion];
  const alone = (await install({
    item,
    harnesses: ['claude', 'codex'],
  })) as ItemHarnessInstalls;
  expect(alone.companions).toBeUndefined();
  installedTargets = [];

  // Claude Code can't load the Codex plugin's commands, so the official
  // Claude listing of the same integration (not the third-party one that
  // shares its name) is installed for it and linked on the item's record.
  // Its content is already local, so nothing is cloned.
  const record = (await install({
    item,
    harnesses: ['claude', 'codex'],
  })) as ItemHarnessInstalls;
  expect(record.harnesses.codex).toEqual(
    expect.objectContaining({ status: 'installed', via: 'native' }),
  );
  expect(record.harnesses.claude).toEqual(
    expect.objectContaining({ status: 'skipped' }),
  );
  expect(record.companions).toEqual([
    { item: companion, harnesses: ['claude'] },
  ]);
  expect(clonedPlugins).toEqual([]);
  const file = JSON.parse(
    await readFile(getPluginHarnessInstallsFilePath(), 'utf8'),
  ) as { items: Record<string, ItemHarnessInstalls> };
  const copyRecord = file.items['plugin:claude-plugins-official/slack'];
  expect(Object.keys(copyRecord?.harnesses ?? {})).toEqual(['claude']);
  expect(copyRecord?.harnesses.claude).toEqual(
    expect.objectContaining({ status: 'installed', via: 'native' }),
  );

  // A second Add reuses the linked copy instead of adding another.
  await install({ item, harnesses: ['claude', 'codex'] });
  expect(
    (
      JSON.parse(
        await readFile(getPluginHarnessInstallsFilePath(), 'utf8'),
      ) as { items: Record<string, ItemHarnessInstalls> }
    ).items['plugin:openai-curated/slack']?.companions,
  ).toEqual([{ item: companion, harnesses: ['claude'] }]);

  // Uninstalling the item removes the copy it brought along, once the
  // item's own uninstall has finished.
  await forgetItemHarnessInstalls(item);
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([companion]);
  expect(
    (
      JSON.parse(
        await readFile(getPluginHarnessInstallsFilePath(), 'utf8'),
      ) as { items: Record<string, unknown> }
    ).items['plugin:openai-curated/slack'],
  ).toBeUndefined();

  // A copy the user then adds on its own is theirs: the item lets go of it,
  // and removing the item no longer removes it.
  await forgetItemHarnessInstalls(companion);
  await install({ item, harnesses: ['claude', 'codex'] });
  expect(
    (await readRecords())['plugin:openai-curated/slack']?.companions,
  ).toEqual([{ item: companion, harnesses: ['claude'] }]);
  await install({ item: companion, harnesses: ['claude'] });
  expect(
    (await readRecords())['plugin:openai-curated/slack']?.companions,
  ).toBeUndefined();
  await forgetItemHarnessInstalls(item);
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([companion]);

  // Added on its own while the item's Add is installing it: still the
  // user's, never linked to the item.
  await forgetItemHarnessInstalls(companion);
  duringInstalledRead = (): Promise<void> => {
    duringCatalogRead = async (): Promise<void> => {
      await install({ item: companion, harnesses: ['claude'] });
    };
    return Promise.resolve();
  };
  const raced = (await install({
    item,
    harnesses: ['claude', 'codex'],
  })) as ItemHarnessInstalls;
  expect(raced.companions).toBeUndefined();
  await forgetItemHarnessInstalls(item);
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([companion]);

  // The item's uninstall runs in a plugin mutation slot: its copies are
  // removed after that slot is released, not inside it.
  await forgetItemHarnessInstalls(companion);
  await install({ item, harnesses: ['claude', 'codex'] });
  uninstalledTargets.length = 0;
  mutationOrder.length = 0;
  await runSerializedPluginMutation(async () => {
    await forgetItemHarnessInstalls(item);
    await new Promise((resolve) => setTimeout(resolve, 5));
    mutationOrder.push('item uninstalled');
  });
  await drainPluginMutations();
  expect(mutationOrder).toEqual(['item uninstalled', 'companion removed']);

  // Added on its own after the item's uninstall but before its copies are
  // removed: the queued removal leaves it as it is.
  await forgetItemHarnessInstalls(companion);
  await install({ item, harnesses: ['claude', 'codex'] });
  uninstalledTargets.length = 0;
  let releaseSlot: () => void = () => undefined;
  const busy = runSerializedPluginMutation(
    () =>
      new Promise<void>((resolve) => {
        releaseSlot = resolve;
      }),
  );
  await forgetItemHarnessInstalls(item);
  await install({ item: companion, harnesses: ['claude'] });
  releaseSlot();
  await busy;
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([]);

  // Added on its own while the item's uninstall is still running: it keeps
  // its install.
  await forgetItemHarnessInstalls(companion);
  await install({ item, harnesses: ['claude', 'codex'] });
  uninstalledTargets.length = 0;
  duringStandInForget = async (): Promise<void> => {
    await install({ item: companion, harnesses: ['claude'] });
  };
  await forgetItemHarnessInstalls(item);
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([]);

  // With New Customize off in main, an Add from a window still showing it
  // brings no copies.
  await forgetItemHarnessInstalls(companion);
  discoveryEnabledInMain = false;
  const flagOff = (await install({
    item,
    harnesses: ['claude', 'codex'],
  })) as ItemHarnessInstalls | null;
  discoveryEnabledInMain = true;
  expect(flagOff?.companions).toBeUndefined();
  expect(
    (await readRecords())['plugin:claude-plugins-official/slack'],
  ).toBeUndefined();

  // Linked with New Customize on, then installed on its own with it off:
  // still the user's, so removing the item leaves it.
  await install({ item, harnesses: ['claude', 'codex'] });
  expect(
    (await readRecords())['plugin:openai-curated/slack']?.companions,
  ).toEqual([{ item: companion, harnesses: ['claude'] }]);
  uninstalledTargets.length = 0;
  discoveryEnabledInMain = false;
  await handler(PLUGINS_CHANNELS.INSTALL_PLUGIN)(
    'claude-plugins-official',
    'slack',
    'https://example.com/slack.git',
  );
  discoveryEnabledInMain = true;
  expect(
    (await readRecords())['plugin:openai-curated/slack']?.companions,
  ).toBeUndefined();
  await forgetItemHarnessInstalls(item);
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([]);

  // Added again while the removal of its copies is still queued: the new
  // Add claims the copy, and the queued removal leaves it.
  await forgetItemHarnessInstalls(companion);
  await install({ item, harnesses: ['claude', 'codex'] });
  uninstalledTargets.length = 0;
  let releaseQueue: () => void = () => undefined;
  const held = runSerializedPluginMutation(
    () =>
      new Promise<void>((resolve) => {
        releaseQueue = resolve;
      }),
  );
  await forgetItemHarnessInstalls(item);
  const readded = (await install({
    item,
    harnesses: ['claude', 'codex'],
  })) as ItemHarnessInstalls;
  expect(readded.companions).toEqual([
    { item: companion, harnesses: ['claude'] },
  ]);
  releaseQueue();
  await held;
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([]);

  // Two items whose Adds ran together both brought the same copy along:
  // removing one leaves it for the other.
  await forgetItemHarnessInstalls(item);
  await drainPluginMutations();
  await forgetItemHarnessInstalls(companion);
  uninstalledTargets.length = 0;
  const remote = { ...item, marketplaceId: 'openai-curated-remote' };
  duringInstalledRead = (): Promise<void> => {
    duringCatalogRead = async (): Promise<void> => {
      await install({ item: remote, harnesses: ['claude', 'codex'] });
    };
    return Promise.resolve();
  };
  await install({ item, harnesses: ['claude', 'codex'] });
  const both = await readRecords();
  expect(both['plugin:openai-curated/slack']?.companions).toEqual([
    { item: companion, harnesses: ['claude'] },
  ]);
  expect(both['plugin:openai-curated-remote/slack']?.companions).toEqual([
    { item: companion, harnesses: ['claude'] },
  ]);
  await forgetItemHarnessInstalls(remote);
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([]);

  // Added one after the other, two items share the copy the first brought
  // along: removing either leaves it for the other, and removing both
  // removes it.
  await forgetItemHarnessInstalls(item);
  await drainPluginMutations();
  await forgetItemHarnessInstalls(companion);
  await install({ item, harnesses: ['claude', 'codex'] });
  const second = (await install({
    item: remote,
    harnesses: ['claude', 'codex'],
  })) as ItemHarnessInstalls;
  expect(second.companions).toEqual([
    { item: companion, harnesses: ['claude'] },
  ]);
  uninstalledTargets.length = 0;
  await forgetItemHarnessInstalls(item);
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([]);
  await forgetItemHarnessInstalls(remote);
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([companion]);

  // Another item's Add that reads while this Add's copy is recorded but not
  // yet linked still counts it as an item's copy and links it too.
  await forgetItemHarnessInstalls(item);
  await forgetItemHarnessInstalls(remote);
  await drainPluginMutations();
  await forgetItemHarnessInstalls(companion);
  uninstalledTargets.length = 0;
  const realUpdate = itemHarnessInstallStore.update.bind(
    itemHarnessInstallStore,
  );
  let itemUpdates = 0;
  const paused = jest
    .spyOn(itemHarnessInstallStore, 'update')
    .mockImplementation(async (key, apply) => {
      // The item's second update is its link to the copy.
      if (key === 'plugin:openai-curated/slack' && ++itemUpdates === 2)
        await install({ item: remote, harnesses: ['claude', 'codex'] });
      return realUpdate(key, apply);
    });
  await install({ item, harnesses: ['claude', 'codex'] });
  paused.mockRestore();
  const between = await readRecords();
  expect(between['plugin:openai-curated-remote/slack']?.companions).toEqual([
    { item: companion, harnesses: ['claude'] },
  ]);
  await forgetItemHarnessInstalls(item);
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([]);

  // A link the disk refuses removes the copy this Add brought, and a retry
  // links it again.
  await forgetItemHarnessInstalls(item);
  await forgetItemHarnessInstalls(remote);
  await drainPluginMutations();
  await forgetItemHarnessInstalls(companion);
  uninstalledTargets.length = 0;
  let linkWrites = 0;
  const refused = jest
    .spyOn(itemHarnessInstallStore, 'update')
    .mockImplementation((key, apply) =>
      key === 'plugin:openai-curated/slack' && ++linkWrites === 2
        ? Promise.reject(new Error('disk full'))
        : realUpdate(key, apply),
    );
  await install({ item, harnesses: ['claude', 'codex'] });
  refused.mockRestore();
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([companion]);
  await forgetItemHarnessInstalls(companion);
  const retried = (await install({
    item,
    harnesses: ['claude', 'codex'],
  })) as ItemHarnessInstalls;
  expect(retried.companions).toEqual([
    { item: companion, harnesses: ['claude'] },
  ]);

  // The first item is removed while a second item's Add is still adopting
  // the same copy: the removal leaves it, and the second Add links it.
  uninstalledTargets.length = 0;
  let remoteUpdates = 0;
  const adopting = jest
    .spyOn(itemHarnessInstallStore, 'update')
    .mockImplementation(async (key, apply) => {
      // The second item's second update is its link to the copy.
      if (
        key === 'plugin:openai-curated-remote/slack' &&
        ++remoteUpdates === 2
      ) {
        await forgetItemHarnessInstalls(item);
        await drainPluginMutations();
      }
      return realUpdate(key, apply);
    });
  const adopted = (await install({
    item: remote,
    harnesses: ['claude', 'codex'],
  })) as ItemHarnessInstalls;
  adopting.mockRestore();
  await drainPluginMutations();
  expect(uninstalledTargets).toEqual([]);
  expect(adopted.companions).toEqual([
    { item: companion, harnesses: ['claude'] },
  ]);
});

// Before Add (CAN-6817): the plugin handlers
// preview a catalog plugin from its repository, over a stubbed network.
function catalogPlugin(
  name: string,
  url: string,
  sha?: string,
  /** Other keys of the marketplace entry's source, such as `path` or `ref`. */
  listing: Record<string, unknown> = {},
): PluginInfo {
  return {
    name,
    marketplaceId: 'acme',
    description: '',
    version: '1.0.0',
    author: 'Acme',
    category: '',
    homepage: '',
    installLocation: '',
    sourcePath: '',
    marketplacePath: '',
    externalSource: { source: 'url', url, ...(sha ? { sha } : {}), ...listing },
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
  } as PluginInfo;
}

/** The network as GitHub would answer, by URL; anything else is a 404. */
let routes: Record<
  string,
  (init?: RequestInit) => Response | Promise<Response>
> = {};
const fetchMock = jest.fn(
  (url: string, init?: RequestInit): Promise<Response> => {
    const route = routes[url];
    return Promise.resolve(
      route ? route(init) : new Response('not found', { status: 404 }),
    );
  },
);

/** A host that never answers, until the request is cancelled. */
function hanging(
  started: () => void,
): (init?: RequestInit) => Promise<Response> {
  return (init) =>
    new Promise<Response>((_, reject) => {
      started();
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('Cancelled', 'AbortError')),
        { once: true },
      );
    });
}

function tree(
  paths: readonly string[],
  metadata: Readonly<Record<string, { mode?: string; size?: number }>> = {},
  /** Whether GitHub cut the listing short. */
  truncated = false,
): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        tree: paths.map((path) => ({ type: 'blob', path, ...metadata[path] })),
        truncated,
      }),
      { status: 200 },
    );
}

function json(value: unknown): () => Response {
  return () => new Response(JSON.stringify(value), { status: 200 });
}

/**
 * Member files with no front matter, so the installed scanner names each by
 * its file or skill folder; a member whose file the preview cannot read has
 * no known name and is left out of Contents.
 */
function plainMembers(raw: string, paths: readonly string[]): void {
  for (const path of paths)
    routes[`${raw}/${path}`] = (): Response =>
      new Response('Body', { status: 200 });
}

/** The preview a handler answered, read as the page reads it. */
function previewOf(result: unknown): PluginManifestPreview {
  const parsed = parsePluginManifestPreviewResult(
    (result as { data?: unknown }).data,
  );
  if (!parsed?.ok) throw new Error('No preview');
  return parsed.preview;
}

const SHA = 'a'.repeat(40);
/** The commit an unpinned listing's default branch resolves to. */
const HEAD_SHA = 'b'.repeat(40);

/** GitHub's answer to which commit a repository's default branch is at. */
function headCommit(sha: string): () => Response {
  return () => new Response(sha, { status: 200 });
}

describe('plugin manifest preview (spec 3b)', () => {
  let catalogBefore: typeof cache;
  const fetchBefore = global.fetch;
  beforeAll(() => {
    catalogBefore = cache;
  });
  afterAll(() => {
    cache = catalogBefore;
    global.fetch = fetchBefore;
  });
  beforeEach(() => {
    resetPluginManifestPreviewCache();
    fetchMock.mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
    routes = {
      'https://api.github.com/repos/acme/hooked/commits/HEAD':
        headCommit(HEAD_SHA),
      'https://api.github.com/repos/acme/plain/commits/HEAD':
        headCommit(HEAD_SHA),
    };
    cache = {
      version: 2,
      lastRefreshed: '2026-11-17T00:00:00.000Z',
      marketplaces: [
        {
          id: 'acme',
          name: 'Acme',
          source: 'acme/marketplace',
          plugins: [
            catalogPlugin('review', 'https://github.com/acme/review.git', SHA),
            catalogPlugin('hooked', 'https://github.com/acme/hooked'),
            catalogPlugin('elsewhere', 'https://gitlab.com/acme/elsewhere.git'),
            catalogPlugin('gone', 'https://github.com/acme/gone'),
          ],
        } as unknown as MarketplaceInfo,
      ],
    };
  });
  it('reads a Claude plugin natively and derives the other harnesses', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      'skills/review/SKILL.md',
      'skills/summarize/SKILL.md',
      'commands/check.md',
      'README.md',
    ]);
    // Empty declarations name nothing.
    routes[
      `https://raw.githubusercontent.com/acme/review/${SHA}/.claude-plugin/plugin.json`
    ] = json({ name: 'review', hooks: [], mcpServers: {} });
    plainMembers(`https://raw.githubusercontent.com/acme/review/${SHA}`, [
      'skills/review/SKILL.md',
      'skills/summarize/SKILL.md',
      'commands/check.md',
    ]);
    const result = await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)(
      'acme',
      'review',
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        ok: true,
        preview: {
          skills: ['review', 'summarize'],
          commands: ['check'],
          agents: [],
          hooks: false,
          mcpServers: false,
          mcpServerNames: [],
          compatibility: {
            harnesses: {
              claude: { level: 'native' },
              codex: { level: 'full' },
            },
          },
        },
      },
    });
    // A second read is served from memory: no new request.
    const calls = fetchMock.mock.calls.length;
    await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review');
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('keeps derived harnesses unknown when hooks and MCP servers are listed', async () => {
    routes[
      `https://api.github.com/repos/acme/hooked/git/trees/${HEAD_SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'config/hooks.json',
      'skills/a/SKILL.md',
    ]);
    // Hooks the manifest declares outside the usual folder still count.
    routes[
      `https://raw.githubusercontent.com/acme/hooked/${HEAD_SHA}/.claude-plugin/plugin.json`
    ] = json({ name: 'hooked', hooks: './config/hooks.json' });
    routes[
      `https://raw.githubusercontent.com/acme/hooked/${HEAD_SHA}/config/hooks.json`
    ] = json({ Stop: [{ hooks: [{ type: 'command', command: 'done' }] }] });
    routes[
      `https://raw.githubusercontent.com/acme/hooked/${HEAD_SHA}/.mcp.json`
    ] = json({ mcpServers: { github: { command: 'gh-mcp' }, broken: 'x' } });
    const result = await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)(
      'acme',
      'hooked',
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        ok: true,
        preview: { hooks: true, mcpServers: true, mcpServerNames: ['github'] },
      },
    });
    const harnesses = (
      result as {
        data: {
          preview: { compatibility: { harnesses: Record<string, unknown> } };
        };
      }
    ).data.preview.compatibility.harnesses;
    expect(harnesses.claude).toEqual({ level: 'native' });
    expect(harnesses.codex).toBeUndefined();
  });

  it('settles every harness from well-formed hook and MCP files (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'config/hooks.json',
      'skills/review/SKILL.md',
    ]);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    // Hooks the manifest moves elsewhere are read from there.
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      hooks: './config/hooks.json',
    });
    routes[`${raw}/config/hooks.json`] = json({
      hooks: {
        PostToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt' }] },
        ],
      },
    });
    routes[`${raw}/.mcp.json`] = json({
      mcpServers: {
        github: { command: 'gh-mcp', args: ['serve'] },
        docs: { type: 'http', url: 'https://docs.example.com/mcp' },
        // Shown by name only: its command line is too long to display.
        huge: { command: `run ${'x'.repeat(4096)}` },
      },
    });
    const result = await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)(
      'acme',
      'review',
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        ok: true,
        preview: {
          hooks: true,
          mcpServers: true,
          mcpServerNames: ['docs', 'github', 'huge'],
        },
      },
    });
    // Each server's URL or command line, bounded, for its Contents row.
    expect(previewOf(result).mcpServerEndpoints).toEqual([
      { name: 'docs', type: 'http', url: 'https://docs.example.com/mcp' },
      { name: 'github', type: 'command', command: 'gh-mcp', args: ['serve'] },
    ]);
    const harnesses = previewOf(result).compatibility?.harnesses;
    expect(harnesses?.claude).toEqual({ level: 'native' });
    expect(harnesses?.codex).toMatchObject({
      level: 'partial',
      missing: ['hooks'],
    });
    expect(harnesses?.cursor).toMatchObject({
      level: 'partial',
      missing: ['hooks'],
    });
    expect(harnesses?.opencode).toEqual({ level: 'full' });
  });

  it('does not settle Cursor on a symlinked or blank-command member (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    plainMembers(raw, ['skills/review/SKILL.md']);
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    routes[`${raw}/.mcp.json`] = json({});
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const base = ['.claude-plugin/plugin.json', '.mcp.json'];

    // A real skill beside an empty server file settles Full.
    routes[treeUrl] = tree([...base, 'skills/review/SKILL.md']);
    expect(
      previewOf(await preview('acme', 'review')).compatibility?.harnesses
        .cursor,
    ).toEqual({ level: 'full' });

    // A symlink the preview cannot resolve may dangle: it is no member and
    // leaves Cursor unknown, whether the file, its folder or its root is one.
    // A symlinked folder is listed as one entry, with no files beneath it.
    for (const link of [
      'skills/review/SKILL.md',
      'skills/review',
      'skills',
      'commands/run.md',
      'agents/helper.md',
    ]) {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree([...base, link], { [link]: { mode: '120000' } });
      const linked = previewOf(await preview('acme', 'review'));
      expect(linked.skills).toEqual([]);
      expect(linked.commands).toEqual([]);
      expect(linked.agents).toEqual([]);
      expect(linked.compatibility?.harnesses.cursor).toBeUndefined();
    }

    // A symlink elsewhere in a skill folder is not a member.
    resetPluginManifestPreviewCache();
    routes[treeUrl] = tree(
      [...base, 'skills/review/SKILL.md', 'skills/review/notes.md'],
      { 'skills/review/notes.md': { mode: '120000' } },
    );
    const sibling = previewOf(await preview('acme', 'review'));
    expect(sibling.skills).toEqual(['review']);
    expect(sibling.compatibility?.harnesses.cursor).toEqual({ level: 'full' });

    // A language server whose command is blank cannot start: Cursor stays
    // unknown instead of settling Partial, as web ingestion treats it.
    for (const command of [' ', '\t\n', '']) {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree([...base, 'skills/review/SKILL.md']);
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        lspServers: { typescript: { command } },
      });
      expect(
        previewOf(await preview('acme', 'review')).compatibility?.harnesses
          .cursor,
      ).toBeUndefined();
    }
    resetPluginManifestPreviewCache();
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      lspServers: { typescript: { command: 'tsserver' } },
    });
    expect(
      previewOf(await preview('acme', 'review')).compatibility?.harnesses
        .cursor,
    ).toEqual({ level: 'partial', missing: ['lspServers'] });
  });

  it('reads a plain description line in linear time, whatever surrounds it (CAN-7545)', () => {
    const wrap = (source: string): string => `---\n${source}\n---\nBody`;
    const read = (source: string): unknown =>
      parseCatalogFrontmatterAndBody(wrap(source)).frontmatter.description;
    // Any `&` together with any `*` skips the document: the check does not
    // try to tell an anchor from text, so it cannot disagree with the parser.
    expect(read('description: Plain a*b and a&b')).toBeUndefined();
    expect(read('description: 9 lives & *more*   \n \n')).toBeUndefined();
    expect(read('description: a&*')).toBeUndefined();
    expect(read('description: &x *x')).toBeUndefined();
    expect(read('description: Safe a&*\nother: 1')).toBeUndefined();
    expect(read('description: & *')).toBeUndefined();
    // One of the two alone is read.
    expect(read('description: R&D changes')).toBe('R&D changes');
    expect(read('description: Use *this* skill')).toBe('Use *this* skill');

    // A near-limit line with a long whitespace run, then another line.
    const space = ' '.repeat(31 * 1024);
    const nearLimit: [string, string | undefined][] = [
      [`description: a&*${space}\nother: 1`, undefined],
      [`description: a&${space}\nother: 1`, 'a&'],
      [`description: a&*${'  '.repeat(15 * 1024)}\nx`, undefined],
    ];
    for (const [source, description] of nearLimit) {
      expect(source.length).toBeLessThanOrEqual(32 * 1024);
      const started = Date.now();
      expect(read(source)).toBe(description);
      expect(Date.now() - started).toBeLessThan(100);
    }
    // The same run with nothing after it is just trailing whitespace.
    expect(read(`description: a&${space}`)).toBe('a&');
    expect(read(`description:${space}a&*`)).toBeUndefined();
  });

  it('keeps a harness unknown when a hook or server file is malformed', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', 'hooks/hooks.json']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    // A command hook with no command: no harness can run it.
    routes[`${raw}/hooks/hooks.json`] = json({
      hooks: { Stop: [{ hooks: [{ type: 'command' }] }] },
    });
    const result = await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)(
      'acme',
      'review',
    );
    expect(result).toMatchObject({
      success: true,
      data: { ok: true, preview: { hooks: true } },
    });
    const harnesses = (
      result as {
        data: {
          preview: { compatibility: { harnesses: Record<string, unknown> } };
        };
      }
    ).data.preview.compatibility.harnesses;
    expect(harnesses.claude).toEqual({ level: 'native' });
    expect(harnesses.codex).toBeUndefined();
  });

  it.each([
    {
      name: 'only Mods',
      paths: ['hooks/hooks.json'],
      manifest: { name: 'review' },
      // Mods alone leave these harnesses nothing to load.
      expected: { level: 'unsupported', reason: 'nothing_loadable' },
    },
    {
      name: 'a skill and Mods',
      paths: ['hooks/hooks.json', 'skills/review/SKILL.md'],
      manifest: { name: 'review' },
      expected: { level: 'partial', missing: ['mods'] },
    },
    {
      name: 'a skill, moved hooks, and Mods in the usual hooks file',
      paths: [
        'hooks/hooks.json',
        'config/hooks.json',
        'skills/review/SKILL.md',
      ],
      manifest: { name: 'review', hooks: './config/hooks.json' },
      expected: { level: 'partial', missing: ['mods'] },
    },
    {
      name: 'a skill, inline hooks, and Mods in the usual hooks file',
      paths: ['hooks/hooks.json', 'skills/review/SKILL.md'],
      manifest: { name: 'review', hooks: {} },
      expected: { level: 'partial', missing: ['mods'] },
    },
  ])(
    'counts Mods from the hooks file as the installed plugin does: $name (CAN-7545)',
    async ({ paths, manifest, expected }) => {
      routes[
        `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
      ] = tree(['.claude-plugin/plugin.json', ...paths]);
      const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
      routes[`${raw}/.claude-plugin/plugin.json`] = json(manifest);
      // The installed scanner also accepts a UTF-8 BOM on hook files.
      routes[`${raw}/hooks/hooks.json`] = (): Response =>
        new Response('\uFEFF{"modules":["m"]}');
      routes[`${raw}/config/hooks.json`] = json({ hooks: {} });
      const harnesses = previewOf(
        await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
      ).compatibility?.harnesses;
      expect(harnesses?.claude).toEqual({ level: 'native' });
      for (const harness of ['cursor', 'opencode', 'codex'] as const)
        expect(harnesses?.[harness]).toEqual(expected);
    },
  );

  it('reads the README, capped, and descriptions from the first 40 files (CAN-7545)', async () => {
    const skills = Array.from(
      { length: 45 },
      (_, index) => `s${String(index).padStart(2, '0')}`,
    );
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      'README.md',
      'agents/helper.md',
      'commands/tools/check.md',
      ...skills.map((name) => `skills/${name}/SKILL.md`),
    ]);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/README.md`] = (): Response =>
      new Response(`# Review\n${'x'.repeat(70 * 1024)}`, { status: 200 });
    for (const name of skills)
      routes[`${raw}/skills/${name}/SKILL.md`] = (): Response =>
        new Response(
          `---\nname: ${name}\ndescription: |\n  Reviews ${name}\n  in one line.\n---\n${name === 's00' ? 'x'.repeat(40 * 1024) : 'Body'}`,
          { status: 200 },
        );
    // A file whose read fails is left out; the preview still succeeds.
    routes[`${raw}/skills/s01/SKILL.md`] = (): Response =>
      new Response('busy', { status: 500 });
    const { readme, descriptions } = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(readme?.truncated).toBe(true);
    expect(readme?.body).toHaveLength(64 * 1024);
    expect(readme?.body.startsWith('# Review\n')).toBe(true);
    // Skills first, in name order; 40 files at most, so s40 and on are unread.
    expect(descriptions?.['skill:s00']).toBe('Reviews s00 in one line.');
    expect(descriptions?.['skill:s01']).toBeUndefined();
    expect(descriptions?.['skill:s39']).toBe('Reviews s39 in one line.');
    expect(descriptions?.['skill:s40']).toBeUndefined();
    // Each file is asked for once (a failed one retried once): 40 in all.
    const read = new Set(
      fetchMock.mock.calls.flatMap(([url]) =>
        /\/(skills|agents|commands)\//.test(url) ? [url] : [],
      ),
    );
    expect(read.size).toBe(40);
  });

  it('keeps a bounded README prefix even when its total size is large', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['README.md']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const prefix = 'x'.repeat(64 * 1024 - 1);
    const body = `${prefix}😀${'y'.repeat(600 * 1024)}`;
    routes[`${raw}/README.md`] = (): Response =>
      new Response(body, {
        headers: { 'content-length': String(Buffer.byteLength(body)) },
      });
    const result = await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)(
      'acme',
      'review',
    );
    expect(previewOf(result).readme).toEqual({ body: prefix, truncated: true });
  });

  it('never reads a symlinked README, preferring a regular one (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    routes[`${raw}/README.md`] = (): Response =>
      new Response('../../README.md');
    routes[`${raw}/readme.md`] = (): Response => new Response('# Regular');

    // An exact-case symlink does not hide a regular README spelled otherwise.
    routes[treeUrl] = tree(['README.md', 'readme.md'], {
      'README.md': { mode: '120000' },
    });
    expect(previewOf(await preview('acme', 'review')).readme).toEqual({
      body: '# Regular',
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(
      `${raw}/README.md`,
    );
  });

  it('returns no README when the only README is a symlink (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['README.md'], { 'README.md': { mode: '120000' } });
    routes[`${raw}/README.md`] = (): Response =>
      new Response('../../README.md');
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    expect(previewOf(await preview('acme', 'review')).readme).toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(
      `${raw}/README.md`,
    );
  });

  it('keeps exact member names and matches their descriptions after IPC parsing (CAN-7545)', async () => {
    // Names that differ only by case, from files whose paths do not: two
    // paths that differ only by case are unread (see the two-spellings test).
    const members: Record<string, { description: string; name?: string }> = {
      'skills/Review/SKILL.md': { description: 'Upper skill' },
      'skills/second/SKILL.md': { description: 'Lower skill', name: 'review' },
      'commands/ Build.md': { description: 'Spaced command' },
      'commands/Build.md': { description: 'Upper command' },
      'commands/second.md': { description: 'Lower command', name: 'build' },
      'agents/Reviewer.md': { description: 'Upper agent' },
      'agents/second.md': { description: 'Lower agent', name: 'reviewer' },
    };
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(Object.keys(members));
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    for (const [path, { description, name }] of Object.entries(members))
      routes[`${raw}/${path.replace(' ', '%20')}`] = (): Response =>
        new Response(
          `---\n${name ? `name: ${name}\n` : ''}description: ${description}\n---`,
        );

    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(new Set(preview.skills)).toEqual(new Set(['Review', 'review']));
    expect(new Set(preview.commands)).toEqual(
      new Set([' Build', 'Build', 'build']),
    );
    expect(new Set(preview.agents)).toEqual(new Set(['Reviewer', 'reviewer']));
    expect(preview.descriptions).toEqual({
      'skill:Review': 'Upper skill',
      'skill:review': 'Lower skill',
      'command: Build': 'Spaced command',
      'command:Build': 'Upper command',
      'command:build': 'Lower command',
      'agent:Reviewer': 'Upper agent',
      'agent:reviewer': 'Lower agent',
    });
  });

  it('counts members of every configured folder against a shown name (CAN-7545)', async () => {
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const members: Record<string, string> = {
      'skills/review/SKILL.md': 'Reviews',
      'skills/plan/SKILL.md': 'Plans',
      'more-skills/review/SKILL.md': 'Reviews elsewhere',
      'commands/deploy.md': 'Deploys',
      'commands/check.md': 'Checks',
      'extra/deploy.md': 'Deploys elsewhere',
      'agents/helper.md': 'Helps',
      'agents/other.md': 'Others',
      'solo/helper.md': 'Helps elsewhere',
    };
    for (const [path, description] of Object.entries(members))
      routes[`${raw}/${path}`] = (): Response =>
        new Response(`---\ndescription: ${description}\n---\nBody`);
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const read = async (
      manifest: Record<string, unknown>,
      metadata: Readonly<Record<string, { mode?: string }>> = {},
    ): Promise<PluginManifestPreview> => {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree(
        ['.claude-plugin/plugin.json', ...Object.keys(members), 'linked'],
        metadata,
      );
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        ...manifest,
      });
      return previewOf(await preview('acme', 'review'));
    };

    // Only the usual folders: every read member keeps its description.
    expect((await read({})).descriptions).toEqual({
      'skill:plan': 'Plans',
      'skill:review': 'Reviews',
      'command:check': 'Checks',
      'command:deploy': 'Deploys',
      'agent:helper': 'Helps',
      'agent:other': 'Others',
    });

    // A configured folder, or a configured file, the installed scanner also
    // lists holds its members' names: the shown row with that name may be
    // either file, so it gets no description.
    const listed = await read({
      skills: ['./skills', './more-skills'],
      commands: ['./commands', './extra'],
      agents: ['./agents', './solo/helper.md'],
    });
    expect(listed.skills).toEqual(['plan', 'review']);
    expect(listed.commands).toEqual(['check', 'deploy']);
    expect(listed.agents).toEqual(['helper', 'other']);
    expect(listed.descriptions).toEqual({
      'skill:plan': 'Plans',
      'command:check': 'Checks',
      'agent:other': 'Others',
    });

    // A configured folder the preview cannot see into, or resolve, may hold
    // a member of any name: that kind shows no description.
    for (const commands of [
      ['./commands', './linked'],
      ['./commands', 'C:\\extra'],
    ]) {
      const hidden = await read({ commands }, { linked: { mode: '120000' } });
      expect(hidden.commands).toEqual(['check', 'deploy']);
      expect(hidden.descriptions).toEqual({
        'skill:plan': 'Plans',
        'skill:review': 'Reviews',
        'agent:helper': 'Helps',
        'agent:other': 'Others',
      });
    }
  });

  it('keeps native facet evidence separate and reads shared paths only once', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
      'config/shared.json',
      'config/codex.json',
    ]);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      hooks: { Stop: [{ type: 'command', command: 'review' }] },
      mcpServers: ['./config/shared.json', 'config/shared.json'],
    });
    routes[`${raw}/.codex-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: ['./config/shared.json', './config/codex.json'],
    });
    routes[`${raw}/config/shared.json`] = json({
      docs: { url: 'https://example.com/mcp' },
    });
    routes[`${raw}/config/codex.json`] = json({ repo: { command: 'review' } });
    const result = await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)(
      'acme',
      'review',
    );
    const { compatibility, mcpServerNames } = previewOf(result);
    expect(mcpServerNames).toEqual(['docs', 'repo']);
    expect(compatibility?.harnesses.cursor).toMatchObject({ level: 'partial' });
    expect(compatibility?.harnesses.opencode).toBeDefined();
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => url === `${raw}/config/shared.json`,
      ),
    ).toHaveLength(1);
  });

  it('counts only command files the installed scan and Cursor load (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    // Nested commands and a wrong-case extension are not loaded by the stager.
    // (A wrong-case folder may load on a case-insensitive checkout, so it
    // leaves compatibility unknown: see the `Commands/` golden.)
    routes[treeUrl] = tree([
      '.claude-plugin/plugin.json',
      'commands/tools/check.md',
      'commands/upper-ext.MD',
    ]);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const nested = previewOf(await preview('acme', 'review'));
    expect(nested.commands).toEqual([]);
    expect(nested.compatibility?.harnesses.claude).toEqual({ level: 'native' });
    for (const harness of ['cursor', 'opencode', 'codex'] as const)
      expect(nested.compatibility?.harnesses[harness]).toEqual({
        level: 'unsupported',
        reason: 'no_content',
      });

    // A command directly in the folder is loaded; the nested one still isn't.
    resetPluginManifestPreviewCache();
    routes[treeUrl] = tree([
      '.claude-plugin/plugin.json',
      'commands/run.md',
      'commands/tools/check.md',
    ]);
    routes[`${raw}/commands/run.md`] = (): Response =>
      new Response('---\ndescription: Checks the branch.\n---\nRun checks.');
    const direct = previewOf(await preview('acme', 'review'));
    expect(direct.commands).toEqual(['run']);
    expect(direct.compatibility?.harnesses.cursor).toEqual({ level: 'full' });

    // A zero-byte command, skill or agent is skipped by the installed scan and
    // by Cursor, so it is neither listed nor evidence of support.
    for (const [path, key] of [
      ['commands/run.md', 'commands'],
      ['skills/lint/SKILL.md', 'skills'],
      ['agents/helper.md', 'agents'],
    ] as const) {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree(['.claude-plugin/plugin.json', path], {
        [path]: { size: 0 },
      });
      const empty = previewOf(await preview('acme', 'review'));
      expect(empty[key]).toEqual([]);
      expect(empty.descriptions).toBeUndefined();
      expect(empty.compatibility?.harnesses.claude).toEqual({
        level: 'native',
      });
      for (const harness of ['cursor', 'opencode', 'codex'] as const)
        expect(empty.compatibility?.harnesses[harness]).toEqual({
          level: 'unsupported',
          reason: 'no_content',
        });
    }

    // An empty command beside a real one leaves only the real one.
    resetPluginManifestPreviewCache();
    routes[treeUrl] = tree(
      ['.claude-plugin/plugin.json', 'commands/run.md', 'commands/blank.md'],
      { 'commands/blank.md': { size: 0 } },
    );
    expect(previewOf(await preview('acme', 'review')).commands).toEqual([
      'run',
    ]);
  });

  it('returns what has arrived when optional reads pass their shared deadline (CAN-7545)', async () => {
    const timers = jest.spyOn(global, 'setTimeout');
    const clock = jest.spyOn(Date, 'now');
    const start = Date.now();
    try {
      const configs = Array.from(
        { length: 12 },
        (_, index) => `config/mcp-${index}.json`,
      );
      routes[
        `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
      ] = tree(['.claude-plugin/plugin.json', 'README.md', ...configs]);
      const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        mcpServers: configs.map((path) => `./${path}`),
      });
      routes[`${raw}/README.md`] = (): Response => new Response('# Review');
      // The raw host never answers for the config files.
      let inFlight = 0;
      let mostInFlight = 0;
      const readsStarted = Promise.withResolvers<void>();
      for (const path of configs)
        routes[`${raw}/${path}`] = hanging(() => {
          inFlight += 1;
          mostInFlight = Math.max(mostInFlight, inFlight);
          if (inFlight === 6) readsStarted.resolve();
        });
      const pending = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)(
        'acme',
        'review',
      );
      await readsStarted.promise;
      const deadline = timers.mock.calls.find(([, ms]) => ms === 15_000)?.[0];
      if (typeof deadline !== 'function')
        throw new Error('No optional read deadline');
      deadline();
      const result = previewOf(await pending);
      // A few reads at a time, not one after another, and none after the
      // deadline; the README that arrived is kept.
      expect(mostInFlight).toBe(6);
      expect(
        fetchMock.mock.calls.filter(([url]) => url.includes('/config/')),
      ).toHaveLength(6);
      expect(result.readme).toEqual({ body: '# Review' });
      expect(result.compatibility?.harnesses.claude).toEqual({
        level: 'native',
      });
      expect(result.compatibility?.harnesses.cursor).toBeUndefined();
      // A partial preview is kept briefly, like a failure: ten minutes, not
      // six hours.
      for (const path of configs) routes[`${raw}/${path}`] = json({});
      const reads = fetchMock.mock.calls.length;
      clock.mockReturnValue(start + 10 * 60 * 1000 - 1000);
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review');
      expect(fetchMock.mock.calls.length).toBe(reads);
      clock.mockReturnValue(start + 10 * 60 * 1000 + 1000);
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review');
      expect(fetchMock.mock.calls.length).toBeGreaterThan(reads);
    } finally {
      timers.mockRestore();
      clock.mockRestore();
    }
  });

  it('keeps every optional read of one preview within six requests in flight (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const skills = Array.from({ length: 8 }, (_, index) => `skill-${index}`);
    const configs = Array.from(
      { length: 8 },
      (_, index) => `config/mcp-${index}.json`,
    );
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      'README.md',
      ...skills.map((name) => `skills/${name}/SKILL.md`),
      ...configs,
    ]);
    // The manifest, which is no optional read, answers once the README and
    // the descriptions are out, so its configs queue behind them.
    const manifestGate = Promise.withResolvers<Response>();
    routes[`${raw}/.claude-plugin/plugin.json`] = (): Promise<Response> =>
      manifestGate.promise;
    let inFlight = 0;
    let mostInFlight = 0;
    let started = 0;
    const held: { release: () => void }[] = [];
    const sixStarted = Promise.withResolvers<void>();
    const hold = (body: string) => (): Promise<Response> => {
      inFlight += 1;
      started += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      if (started >= 6) sixStarted.resolve();
      const gate = Promise.withResolvers<Response>();
      held.push({
        release: () => {
          inFlight -= 1;
          gate.resolve(new Response(body));
        },
      });
      return gate.promise;
    };
    routes[`${raw}/README.md`] = hold('# Review');
    for (const name of skills)
      routes[`${raw}/skills/${name}/SKILL.md`] = hold(
        '---\ndescription: Reviews.\n---',
      );
    for (const path of configs) routes[`${raw}/${path}`] = hold('{}');

    let settled = false;
    const pending = (async (): Promise<unknown> => {
      try {
        return await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)(
          'acme',
          'review',
        );
      } finally {
        settled = true;
      }
    })();
    await sixStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    manifestGate.resolve(
      new Response(
        JSON.stringify({
          name: 'review',
          mcpServers: configs.map((path) => `./${path}`),
        }),
      ),
    );
    // Answer the held reads one at a time, oldest first, until all are done.
    while (!settled) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      held.shift()?.release();
    }
    const result = previewOf(await pending);
    expect(started).toBe(1 + skills.length + configs.length);
    expect(mostInFlight).toBeLessThanOrEqual(6);
    expect(result.readme).toEqual({ body: '# Review' });
    expect(result.descriptions).toMatchObject({ 'skill:skill-0': 'Reviews.' });
  });

  it('starts a config the manifest names before queued descriptions drain (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const skills = Array.from(
      { length: 40 },
      (_, index) => `skill-${String(index).padStart(2, '0')}`,
    );
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      ...skills.map((name) => `skills/${name}/SKILL.md`),
    ]);
    // The manifest answers once every description is queued; each
    // description is held until the test answers it, slowest first.
    const manifestGate = Promise.withResolvers<Response>();
    routes[`${raw}/.claude-plugin/plugin.json`] = (): Promise<Response> =>
      manifestGate.promise;
    const held: (() => void)[] = [];
    let descriptionsStarted = 0;
    const sixStarted = Promise.withResolvers<void>();
    for (const name of skills)
      routes[`${raw}/skills/${name}/SKILL.md`] = (): Promise<Response> => {
        descriptionsStarted += 1;
        if (descriptionsStarted === 6) sixStarted.resolve();
        const gate = Promise.withResolvers<Response>();
        held.push(() =>
          gate.resolve(new Response('---\ndescription: Reviews.\n---')),
        );
        return gate.promise;
      };
    let startedBeforeConfig: number | undefined;
    routes[`${raw}/.mcp.json`] = (): Response => {
      startedBeforeConfig = descriptionsStarted;
      return new Response(
        JSON.stringify({
          mcpServers: { docs: { command: 'npx', args: ['docs-server'] } },
        }),
      );
    };

    let settled = false;
    const pending = (async (): Promise<unknown> => {
      try {
        return await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)(
          'acme',
          'review',
        );
      } finally {
        settled = true;
      }
    })();
    await sixStarted.promise;
    manifestGate.resolve(new Response(JSON.stringify({ name: 'review' })));
    // The config is now waiting behind six held descriptions and 34 queued.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(startedBeforeConfig).toBeUndefined();
    // Answer one description: its slot goes to the config, not the queue.
    held.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(startedBeforeConfig).toBe(6);
    while (!settled) {
      held.shift()?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(descriptionsStarted).toBe(40);
    const preview = previewOf(await pending);
    expect(preview.mcpServerEndpoints).toEqual([
      { name: 'docs', type: 'command', command: 'npx', args: ['docs-server'] },
    ]);
    expect(preview.compatibility?.harnesses.cursor).toEqual({ level: 'full' });
    expect(preview.descriptions?.['skill:skill-39']).toBe('Reviews.');
  });

  it('cancels every failed response body it does not read (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    // What happened, in order: each request, and each body cancelled.
    const events: string[] = [];
    /** A failed response whose body keeps streaming until it is cancelled. */
    const streaming =
      (
        label: string,
        status: number,
        headers: Record<string, string> = {},
      ): (() => Response) =>
      () => {
        events.push(`fetch ${label}`);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(new TextEncoder().encode('partial'));
            },
            cancel(): void {
              events.push(`cancel ${label}`);
            },
          }),
          { status, headers },
        );
      };
    routes[treeUrl] = tree([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'README.md',
      'skills/review/SKILL.md',
    ]);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    // An optional README that is gone, a config that fails twice, and a
    // description that fails once and then answers.
    routes[`${raw}/README.md`] = streaming('readme', 404);
    routes[`${raw}/.mcp.json`] = streaming('config', 500);
    const description = streaming('description', 503);
    let descriptionReads = 0;
    routes[`${raw}/skills/review/SKILL.md`] = (): Response => {
      descriptionReads += 1;
      if (descriptionReads === 1) return description();
      events.push('fetch description retry');
      return new Response('---\ndescription: Reviews.\n---');
    };
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const read = previewOf(await preview('acme', 'review'));
    expect(read.readme).toBeUndefined();
    expect(read.descriptions).toEqual({ 'skill:review': 'Reviews.' });
    expect(events.filter((event) => event === 'cancel config')).toHaveLength(2);
    expect(events).toContain('cancel readme');
    // The first body is cancelled before the retry goes out.
    expect(events.indexOf('cancel description')).toBeGreaterThan(-1);
    expect(events.indexOf('cancel description')).toBeLessThan(
      events.indexOf('fetch description retry'),
    );

    // A rate limit keeps its reason, and its body is cancelled too.
    resetPluginManifestPreviewCache();
    events.length = 0;
    routes[`${raw}/README.md`] = streaming('limited', 429, {
      'retry-after': '60',
    });
    await expect(preview('acme', 'review')).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'rate_limited' },
    });
    expect(events).toContain('cancel limited');

    // So is a required read's: a tree that is gone.
    resetPluginManifestPreviewCache();
    events.length = 0;
    routes[treeUrl] = streaming('tree', 404);
    await expect(preview('acme', 'review')).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'not_found' },
    });
    expect(events).toEqual(['fetch tree', 'cancel tree']);
  });

  it('reads a blank member path as the installed readers do, moving the folder (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    for (const [key, member] of [
      ['skills', 'skills/review/SKILL.md'],
      ['commands', 'commands/check.md'],
      ['agents', 'agents/helper.md'],
    ] as const) {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree([
        '.claude-plugin/plugin.json',
        '.mcp.json',
        member,
      ]);
      routes[`${raw}/.mcp.json`] = json({});
      // The usual folder holds the member; the manifest moves it to ' '.
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        [key]: ' ',
      });
      const moved = previewOf(await preview('acme', 'review'));
      expect(moved.compatibility?.harnesses.claude).toEqual({
        level: 'native',
      });
      // Cursor would not load the usual folder, so its support is unknown.
      expect(moved.compatibility?.harnesses.cursor).toBeUndefined();

      // An empty path leaves the usual folder in place.
      resetPluginManifestPreviewCache();
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        [key]: '',
      });
      const kept = previewOf(await preview('acme', 'review'));
      expect(kept.compatibility?.harnesses.cursor).toBeDefined();
    }
  });

  it('lists no usual-folder members a manifest moves its readers away from (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const files = [
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'skills/review/SKILL.md',
      'commands/check.md',
      'agents/helper.md',
    ];
    routes[`${raw}/.mcp.json`] = json({});
    routes[`${raw}/skills/review/SKILL.md`] = (): Response =>
      new Response('---\ndescription: Reviews.\n---');
    routes[`${raw}/commands/check.md`] = (): Response =>
      new Response('---\ndescription: Checks.\n---');
    routes[`${raw}/agents/helper.md`] = (): Response =>
      new Response('---\ndescription: Helps.\n---');
    const all = {
      skills: ['review'],
      commands: ['check'],
      agents: ['helper'],
      descriptions: {
        'skill:review': 'Reviews.',
        'command:check': 'Checks.',
        'agent:helper': 'Helps.',
      },
    };
    const read = async (
      manifest: Record<string, unknown>,
      extra: Record<string, Record<string, unknown>> = {},
      metadata: Record<string, { mode?: string }> = {},
    ): Promise<ReturnType<typeof previewOf>> => {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree([...files, ...Object.keys(extra)], metadata);
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        ...manifest,
      });
      for (const [path, value] of Object.entries(extra))
        routes[`${raw}/${path}`] = json(value);
      return previewOf(await preview('acme', 'review'));
    };

    for (const [key, type] of [
      ['skills', 'skill'],
      ['commands', 'command'],
      ['agents', 'agent'],
    ] as const)
      for (const value of [' ', [' '], ['./elsewhere'], ['./elsewhere', 42]]) {
        // The installed scan reads the declared folder, not the usual one,
        // so the usual folder's files are no members of this kind.
        const moved = await read({ [key]: value });
        expect(moved[key]).toEqual([]);
        expect(
          Object.keys(moved.descriptions ?? {}).filter((name) =>
            name.startsWith(`${type}:`),
          ),
        ).toEqual([]);
        // The other kinds are still listed, with their descriptions.
        expect(moved).toMatchObject(
          Object.fromEntries(
            (['skills', 'commands', 'agents'] as const)
              .filter((other) => other !== key)
              .map((other) => [other, all[other]]),
          ),
        );
        // Compatibility stays unknown, as before.
        expect(moved.compatibility?.harnesses.cursor).toBeUndefined();
      }

    // Naming the usual folder itself leaves it where the readers look.
    const usual = await read({ commands: './commands/' });
    expect(usual).toMatchObject(all);

    // The scanner's `normalizePaths` takes a string or a list's strings.
    // With none (a record, a list of no strings) it reads the usual folder;
    // a list naming the usual folder among others still includes it. That
    // settles only the usual folder: another folder's members are never
    // listed, and compatibility stays unknown.
    for (const key of ['skills', 'commands', 'agents'] as const)
      for (const value of [
        { other: 'x' },
        [42],
        [`./${key}`, './extras'],
        [42, `${key}/`],
      ]) {
        const kept = await read(
          { [key]: value },
          { 'extras/more.md': {}, 'extras/more/SKILL.md': {} },
        );
        expect(kept).toMatchObject(all);
        expect(kept.compatibility?.harnesses.cursor).toBeUndefined();
      }
    // A path that climbs out of the plugin may come back to the usual folder
    // from an install folder of the right name, but that is not known.
    const climbing = await read({ commands: ['../review/commands'] });
    expect(climbing.commands).toEqual([]);

    // Another native manifest whose readers keep the usual folder lists it.
    const cursor = await read(
      { commands: [' '] },
      { '.cursor-plugin/plugin.json': { name: 'review' } },
    );
    expect(cursor.commands).toEqual(['check']);

    // A Claude manifest that went unread may move any folder: the usual
    // folders' files are not listed from the provider's defaults.
    const unread = await read(
      {},
      {},
      { '.claude-plugin/plugin.json': { mode: '120000' } },
    );
    expect(unread).toMatchObject({ skills: [], commands: [], agents: [] });
    expect(unread.descriptions).toBeUndefined();
  });

  it('reads every config a list names on its own, as the installed readers do (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    routes[treeUrl] = tree([
      '.claude-plugin/plugin.json',
      'servers.json',
      'config/hooks.json',
      'config/lsp.json',
    ]);
    routes[`${raw}/servers.json`] = json({
      mcpServers: { docs: { command: 'docs-mcp' } },
    });
    routes[`${raw}/config/hooks.json`] = json({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'done' }] }] },
    });
    routes[`${raw}/config/lsp.json`] = json({ ts: { command: 'tsserver' } });
    const read = async (
      manifest: Record<string, unknown>,
    ): Promise<ReturnType<typeof previewOf>> => {
      resetPluginManifestPreviewCache();
      fetchMock.mockClear();
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        ...manifest,
      });
      return previewOf(await preview('acme', 'review'));
    };
    const requested = (path: string): boolean =>
      fetchMock.mock.calls.some(([url]) => url === `${raw}/${path}`);

    // The runtime skips an empty, non-string or plugin-folder entry and
    // still loads the listed file after it, merging in manifest order.
    const skipped = await read({
      mcpServers: ['', './servers.json'],
      hooks: [42, './config/hooks.json'],
      lspServers: ['.', './config/lsp.json'],
    });
    expect(skipped.mcpServerNames).toEqual(['docs']);
    expect(skipped.mcpServerEndpoints).toEqual([
      { name: 'docs', type: 'command', command: 'docs-mcp' },
    ]);
    expect(skipped.hooks).toBe(true);
    for (const path of ['servers.json', 'config/hooks.json', 'config/lsp.json'])
      expect(requested(path)).toBe(true);
    // An entry the preview cannot resolve still settles nothing.
    expect(skipped.compatibility?.harnesses.cursor).toBeUndefined();

    // An absolute entry may name a file on the installing host, after the
    // readable one: the name stays, its endpoint may be replaced.
    const absolute = await read({
      mcpServers: ['./servers.json', '/etc/servers.json'],
    });
    expect(absolute.mcpServerNames).toEqual(['docs']);
    expect(absolute.mcpServerEndpoints).toBeUndefined();
  });

  it('classifies manifest paths as the installed containment check does (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    routes[treeUrl] = tree([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'a.json',
      'b.json',
      '..servers.json',
      '..hooks.json',
      '..notes.md',
    ]);
    routes[`${raw}/.mcp.json`] = json({});
    routes[`${raw}/a.json`] = json({
      mcpServers: { docs: { command: 'a-docs' } },
    });
    routes[`${raw}/b.json`] = json({
      mcpServers: { docs: { command: 'b-docs' } },
    });
    routes[`${raw}/..servers.json`] = json({
      mcpServers: { docs: { command: 'dots-docs' } },
    });
    routes[`${raw}/..hooks.json`] = json({
      Stop: [{ hooks: [{ type: 'command', command: 'done' }] }],
    });
    const read = async (
      manifest: Record<string, unknown>,
    ): Promise<ReturnType<typeof previewOf>> => {
      resetPluginManifestPreviewCache();
      fetchMock.mockClear();
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        ...manifest,
      });
      return previewOf(await preview('acme', 'review'));
    };
    const requested = (path: string): boolean =>
      fetchMock.mock.calls.some(([url]) => url === `${raw}/${path}`);

    // `../review/b.json` climbs out of the plugin folder and, from an install
    // folder named `review`, lands on b.json, whose `docs` wins the merge.
    // Where it lands is unknown, so a.json's endpoint is not published.
    const climbing = await read({
      mcpServers: ['./a.json', '../review/b.json'],
    });
    expect(climbing.mcpServerNames).toEqual(['docs']);
    expect(climbing.mcpServerEndpoints).toBeUndefined();
    expect(climbing.compatibility?.harnesses.codex).toBeUndefined();

    // `isPathInside` refuses any relative path that starts with `..`, a file
    // named `..servers.json` included: the readers load nothing from it.
    const dotted = await read({ mcpServers: './..servers.json' });
    expect(dotted.mcpServerNames).toEqual([]);
    expect(dotted.mcpServers).toBe(false);
    expect(requested('..servers.json')).toBe(false);
    expect(dotted.compatibility?.harnesses.codex).toBeUndefined();
    const dottedHooks = await read({ hooks: './..hooks.json' });
    expect(dottedHooks.hooks).toBe(false);
    expect(requested('..hooks.json')).toBe(false);

    // The scanner loads no app from such a file either: the server alone
    // settles Cursor as it does with no app declared.
    routes[`${raw}/.mcp.json`] = json({
      mcpServers: { local: { command: 'local-mcp' } },
    });
    const noApps = await read({});
    const dottedApp = await read({ apps: './..notes.md' });
    expect(dottedApp.compatibility?.harnesses.cursor).toEqual(
      noApps.compatibility?.harnesses.cursor,
    );
    expect(noApps.compatibility?.harnesses.cursor).toEqual({ level: 'full' });
  });

  it('lists no default MCP server an unread Claude manifest may override (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    routes[`${raw}/.mcp.json`] = json({
      mcpServers: { docs: { command: 'docs-mcp' } },
    });
    // A valid manifest past the preview's read limit: the installed reader
    // parses it and takes its empty list as the override.
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: [],
      padding: 'x'.repeat(70 * 1024),
    });
    routes[`${raw}/.cursor-plugin/plugin.json`] = json({ name: 'review' });
    routes[treeUrl] = tree(['.claude-plugin/plugin.json', '.mcp.json']);
    const unread = previewOf(await preview('acme', 'review'));
    expect(unread.mcpServerNames).toEqual([]);
    expect(unread.mcpServers).toBe(false);
    expect(unread.mcpServerEndpoints).toBeUndefined();

    // A lower manifest that was read and uses the usual file lists it, with
    // no endpoint the unread manifest above it may replace.
    resetPluginManifestPreviewCache();
    routes[treeUrl] = tree([
      '.claude-plugin/plugin.json',
      '.cursor-plugin/plugin.json',
      '.mcp.json',
    ]);
    const lower = previewOf(await preview('acme', 'review'));
    expect(lower.mcpServerNames).toEqual(['docs']);
    expect(lower.mcpServers).toBe(true);
    expect(lower.mcpServerEndpoints).toBeUndefined();
  });

  it('shows Hook and MCP rows only for configs read to hold one (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    routes[treeUrl] = tree([
      '.claude-plugin/plugin.json',
      'hooks/hooks.json',
      '.mcp.json',
      'config/hooks.json',
    ]);
    const read = async (
      files: Record<string, unknown>,
      manifest: Record<string, unknown> = {},
    ): Promise<ReturnType<typeof previewOf>> => {
      resetPluginManifestPreviewCache();
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        ...manifest,
      });
      for (const path of ['hooks/hooks.json', '.mcp.json', 'config/hooks.json'])
        routes[`${raw}/${path}`] =
          path in files
            ? json(files[path])
            : (): Response => new Response('busy', { status: 500 });
      return previewOf(await preview('acme', 'review'));
    };
    const rows = (
      result: ReturnType<typeof previewOf>,
    ): { hooks: boolean; mcpServers: boolean } => ({
      hooks: result.hooks,
      mcpServers: result.mcpServers,
    });

    // Empty usual files: the installed scan finds no hook and no server.
    expect(
      rows(await read({ 'hooks/hooks.json': {}, '.mcp.json': {} })),
    ).toEqual({ hooks: false, mcpServers: false });
    // A hooks file of Mods alone declares no hook.
    expect(
      rows(
        await read({
          'hooks/hooks.json': { modules: ['guard'] },
          '.mcp.json': {},
        }),
      ).hooks,
    ).toBe(false);
    // Files that could not be read settle nothing: no row.
    expect(rows(await read({}))).toEqual({ hooks: false, mcpServers: false });
    // A declaration alone is no hook: a non-string entry and an absent file.
    expect(
      rows(
        await read(
          { 'hooks/hooks.json': {}, '.mcp.json': {} },
          { hooks: [42, './missing.json'] },
        ),
      ).hooks,
    ).toBe(false);
    // A config read to hold one shows its row.
    expect(
      rows(
        await read({
          'hooks/hooks.json': {
            Stop: [{ hooks: [{ type: 'command', command: 'done' }] }],
          },
          '.mcp.json': { mcpServers: { docs: { command: 'docs-mcp' } } },
        }),
      ),
    ).toEqual({ hooks: true, mcpServers: true });
  });

  it('names members as the installed scanner does, from their front matter (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      'commands/check.md',
      'commands/first.md',
      'commands/second.md',
      'commands/busy.md',
      'commands/marked.md',
      'commands/dated.md',
      'commands/merged.md',
      'skills/folder/SKILL.md',
      'agents/helper.md',
    ]);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    const file = (path: string, text: string): void => {
      routes[`${raw}/${path}`] = (): Response => new Response(text);
    };
    file(
      'commands/check.md',
      '---\nname: Verify\ndescription: Checks the project\n---\nBody',
    );
    // Two files the scanner names alike: one name, and no description.
    file('commands/first.md', '---\nname: Same\ndescription: One\n---');
    file('commands/second.md', '---\nname: Same\ndescription: Two\n---');
    // Its head cannot be read, so its installed name is unknown.
    routes[`${raw}/commands/busy.md`] = (): Response =>
      new Response('busy', { status: 500 });
    // The scanner parses the raw text: a byte order mark hides the block.
    file('commands/marked.md', '\uFEFF---\nname: Hidden\ndescription: No\n---');
    // Under the scanner's default schema a date is no string name, and a
    // merge key supplies one.
    file('commands/dated.md', '---\nname: 2024-01-01\n---');
    file('commands/merged.md', '---\n<<: {name: Merged}\n---');
    file('skills/folder/SKILL.md', '---\nname: Skillful\n---');
    file('agents/helper.md', '---\nname: Aide\ndescription: Helps\n---');
    const read = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(read.commands).toEqual([
      'dated',
      'marked',
      'Merged',
      'Same',
      'Verify',
    ]);
    expect(read.skills).toEqual(['Skillful']);
    expect(read.agents).toEqual(['Aide']);
    expect(read.descriptions).toEqual({
      'command:Verify': 'Checks the project',
      'agent:Aide': 'Helps',
    });
    // Compatibility still counts every member file.
    expect(read.compatibility?.harnesses.claude).toEqual({ level: 'native' });
  });

  it('gives no description to a name two member files share (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      'commands/.md',
      'commands/.md.md',
      'commands/check.md',
      'agents/.md',
      'agents/.md.md',
    ]);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    for (const [path, text] of [
      ['commands/.md', 'First command.'],
      ['commands/.md.md', 'Second command.'],
      ['commands/check.md', 'Checks.'],
      ['agents/.md', 'First agent.'],
      ['agents/.md.md', 'Second agent.'],
    ] as const)
      routes[`${raw}/${path}`] = (): Response =>
        new Response(`---\ndescription: ${text}\n---`);
    // `.md` and `.md.md` both name `.md`: the installed scan loads two
    // members, and which one a row means is ambiguous.
    const read = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(read.commands).toEqual(['.md', 'check']);
    expect(read.agents).toEqual(['.md']);
    expect(read.descriptions).toEqual({ 'command:check': 'Checks.' });
  });

  it('counts a member file named only .md, as the installed readers do (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    routes[`${raw}/.mcp.json`] = json({
      mcpServers: { docs: { command: 'npx', args: ['docs-server'] } },
    });
    // An agent named `.md` is one Cursor cannot load: Partial, not Full.
    routes[treeUrl] = tree([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'agents/.md',
    ]);
    plainMembers(raw, ['agents/.md']);
    const agent = previewOf(await preview('acme', 'review'));
    expect(agent.agents).toEqual(['.md']);
    expect(agent.compatibility?.harnesses.cursor).toEqual({
      level: 'partial',
      missing: ['agents'],
    });

    // A command named `.md` is content Cursor loads, with its description.
    resetPluginManifestPreviewCache();
    routes[treeUrl] = tree(['.claude-plugin/plugin.json', 'commands/.md']);
    routes[`${raw}/commands/.md`] = (): Response =>
      new Response('---\ndescription: Checks the branch.\n---');
    const command = previewOf(await preview('acme', 'review'));
    expect(command.commands).toEqual(['.md']);
    expect(command.descriptions).toEqual({
      'command:.md': 'Checks the branch.',
    });
    expect(command.compatibility?.harnesses.cursor).toEqual({ level: 'full' });
  });

  it('answers only names the page shows, still counting every member (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'skills/line\nbreak/SKILL.md',
      'skills/ /SKILL.md',
      'commands/tab\tname.md',
      'agents/sep\u2028arator.md',
    ]);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    routes[`${raw}/.mcp.json`] = json({
      mcpServers: {
        'bad\nname': { command: 'npx', args: ['bad'] },
        ' ': { url: 'https://example.com/blank' },
        docs: { command: 'npx', args: ['docs-server'] },
      },
    });
    const result = await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)(
      'acme',
      'review',
    );
    // The reply as the desktop page receives it, before any parsing.
    expect(result).toMatchObject({
      success: true,
      data: {
        ok: true,
        preview: {
          skills: [],
          commands: [],
          agents: [],
          mcpServers: true,
          mcpServerNames: ['docs'],
          mcpServerEndpoints: [
            {
              name: 'docs',
              type: 'command',
              command: 'npx',
              args: ['docs-server'],
            },
          ],
        },
      },
    });
    const data = (result as { data: unknown }).data;
    expect(parsePluginManifestPreviewResult(data)).toEqual(data);
    // Hidden names are still members: every harness reads them.
    const preview = previewOf(result);
    expect(preview.compatibility?.harnesses.cursor).toEqual({
      level: 'partial',
      missing: ['agents'],
    });
  });

  it('fails at once on a rate limit while another optional read is still out (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', 'README.md', '.mcp.json']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    let cancelled = false;
    const configStarted = Promise.withResolvers<void>();
    routes[`${raw}/.mcp.json`] = (init?: RequestInit): Promise<Response> => {
      init?.signal?.addEventListener('abort', () => {
        cancelled = true;
      });
      return hanging(configStarted.resolve)(init);
    };
    routes[`${raw}/README.md`] = async (): Promise<Response> => {
      await configStarted.promise;
      return new Response('limited', {
        status: 429,
        headers: { 'retry-after': '60' },
      });
    };
    // Resolves without the 15-second deadline: the hanging read is cancelled.
    await expect(
      handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    ).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'rate_limited' },
    });
    expect(cancelled).toBe(true);
  });

  it('keeps the longest rate-limit window when concurrent reads see different ones (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['README.md', 'skills/review/SKILL.md']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const longServed = Promise.withResolvers<void>();
    // The 600-second window arrives first, the 60-second one right after it.
    routes[`${raw}/README.md`] = (): Response => {
      longServed.resolve();
      return new Response('limited', {
        status: 429,
        headers: { 'retry-after': '600' },
      });
    };
    routes[`${raw}/skills/review/SKILL.md`] = async (): Promise<Response> => {
      await longServed.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return new Response('limited', {
        status: 429,
        headers: { 'retry-after': '60' },
      });
    };
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    await expect(preview('acme', 'review')).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'rate_limited' },
    });
    // Both responses must have been handled before the clock moves on.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const clock = jest.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(Date.now() + 120_000);
      const calls = fetchMock.mock.calls.length;
      await expect(preview('acme', 'hooked')).resolves.toEqual({
        success: true,
        data: { ok: false, reason: 'rate_limited' },
      });
      expect(fetchMock.mock.calls.length).toBe(calls);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps the README when a native manifest stalls (CAN-7545)', async () => {
    const timers = jest.spyOn(global, 'setTimeout');
    const clock = jest.spyOn(Date, 'now');
    const start = Date.now();
    try {
      const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
      routes[
        `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
      ] = tree(['.claude-plugin/plugin.json', 'README.md']);
      const readmeStarted = Promise.withResolvers<void>();
      const manifestStarted = Promise.withResolvers<void>();
      routes[`${raw}/README.md`] = (): Response => {
        readmeStarted.resolve();
        return new Response('# Review');
      };
      routes[`${raw}/.claude-plugin/plugin.json`] = hanging(
        manifestStarted.resolve,
      );
      const pending = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)(
        'acme',
        'review',
      );
      await Promise.all([readmeStarted.promise, manifestStarted.promise]);
      const deadline = timers.mock.calls.find(([, ms]) => ms === 15_000)?.[0];
      if (typeof deadline !== 'function')
        throw new Error('No optional read deadline');
      deadline();
      const result = previewOf(await pending);
      expect(result.readme).toEqual({ body: '# Review' });
      expect(result.compatibility?.harnesses.cursor).toBeUndefined();
      // The partial preview is kept for ten minutes.
      routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
      const reads = fetchMock.mock.calls.length;
      clock.mockReturnValue(start + 10 * 60 * 1000 - 1000);
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review');
      expect(fetchMock.mock.calls.length).toBe(reads);
      clock.mockReturnValue(start + 10 * 60 * 1000 + 1000);
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review');
      expect(fetchMock.mock.calls.length).toBeGreaterThan(reads);
    } finally {
      timers.mockRestore();
      clock.mockRestore();
    }
  });

  it('does not hide a description rate limit racing the deadline (CAN-7545)', async () => {
    const timers = jest.spyOn(global, 'setTimeout');
    try {
      const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
      routes[
        `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
      ] = tree(['skills/review/SKILL.md']);
      const started = Promise.withResolvers<void>();
      routes[`${raw}/skills/review/SKILL.md`] = (init): Promise<Response> =>
        new Promise((resolve) => {
          init?.signal?.addEventListener('abort', () => {
            // The HTTP response was received, but its promise runs at the
            // same time as the deadline cancellation.
            resolve(new Response(null, { status: 429 }));
          });
          started.resolve();
        });
      const pending = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)(
        'acme',
        'review',
      );
      await started.promise;
      const deadline = timers.mock.calls.find(([, ms]) => ms === 15_000)?.[0];
      if (typeof deadline !== 'function')
        throw new Error('No optional read deadline');
      deadline();
      await expect(pending).resolves.toEqual({
        success: true,
        data: { ok: false, reason: 'rate_limited' },
      });
    } finally {
      timers.mockRestore();
    }
  });

  it('reads no description from front matter with YAML aliases, and does so at once (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      'skills/merge/SKILL.md',
      'skills/inherited/SKILL.md',
      'skills/keys/SKILL.md',
      'skills/truncated/SKILL.md',
      'skills/plain/SKILL.md',
      'skills/emphasis/SKILL.md',
      'skills/reference/SKILL.md',
    ]);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    // Merge keys: the file merges one wide map thousands of times.
    const keys = Array.from({ length: 2000 }, (_, index) => `k${index}: 1`);
    const merges: string[] = [];
    const head = `---\ndescription: Safe\nbase: &b {${keys.join(', ')}}\nm: {<<: [`;
    while (head.length + merges.length * 4 < 31 * 1024) merges.push('*b');
    routes[`${raw}/skills/merge/SKILL.md`] = (): Response =>
      new Response(`${head}${merges.join(', ')}]}\n---\nBody`);
    routes[`${raw}/skills/inherited/SKILL.md`] = (): Response =>
      new Response('---\nbase: &b {description: Inherited}\n<<: *b\n---');
    // Aliases repeated as the parts of a key expand into one huge string. The
    // whole front matter, closing delimiter included, fits the 32 KiB read, so
    // the YAML guard (not truncation) is what keeps the description out.
    const aliases = Array.from({ length: 3000 }, () => '*a').join(', ');
    const keysFile = `---\ndescription: Safe\na: &a ${'x'.repeat(2000)}\n? [${aliases}]\n: 1\n---\nBody`;
    expect(keysFile.length).toBeLessThan(32 * 1024);
    routes[`${raw}/skills/keys/SKILL.md`] = (): Response =>
      new Response(keysFile);
    // The same shape cut off by the read limit never reaches its delimiter.
    const longAliases = Array.from({ length: 9000 }, () => '*a').join(', ');
    routes[`${raw}/skills/truncated/SKILL.md`] = (): Response =>
      new Response(
        `---\ndescription: Safe\na: &a ${'x'.repeat(20000)}\n? [${longAliases}]\n: 1\n---\nBody`,
      );
    routes[`${raw}/skills/plain/SKILL.md`] = (): Response =>
      new Response('---\ndescription: Plain a*b and a&b\n---');
    // A file with both characters, even as plain text, is skipped; text with
    // no `&` cannot hold an anchor, so its description stays.
    routes[`${raw}/skills/emphasis/SKILL.md`] = (): Response =>
      new Response('---\ndescription: Use *this* skill\n---');
    routes[`${raw}/skills/reference/SKILL.md`] = (): Response =>
      new Response('---\ndescription: &copy Review code\nsummary: *copy\n---');
    const started = Date.now();
    const { descriptions } = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(descriptions).toEqual({
      'skill:emphasis': 'Use *this* skill',
    });
  });

  it('shows the command the desktop launches when a server also has a URL (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', '.mcp.json']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    routes[`${raw}/.mcp.json`] = json({
      mcpServers: {
        both: {
          type: 'http',
          url: 'https://both.example.com/mcp',
          command: 'both-mcp',
          args: ['serve'],
        },
        web: { type: 'http', url: 'https://web.example.com/mcp' },
        disabled: {
          enabled: false,
          url: 'https://disabled.example.com/mcp',
          command: 'not-launched',
        },
        blank: {
          type: 'http',
          url: 'https://blank.example.com/mcp',
          command: '',
        },
        legacy: {
          type: 'sse',
          url: 'https://legacy.example.com/mcp',
          command: 'stdio-mcp',
        },
      },
    });
    const { mcpServerEndpoints, mcpServerNames, compatibility } = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(mcpServerEndpoints).toEqual([
      { name: 'both', type: 'command', command: 'both-mcp', args: ['serve'] },
      {
        name: 'disabled',
        type: 'http',
        url: 'https://disabled.example.com/mcp',
      },
      { name: 'legacy', type: 'command', command: 'stdio-mcp' },
      { name: 'web', type: 'http', url: 'https://web.example.com/mcp' },
    ]);
    expect(mcpServerNames).toContain('blank');
    expect(compatibility?.harnesses.cursor).toBeUndefined();
  });

  it('counts app members, so Cursor reads Partial for a server and an app file (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    routes[`${raw}/.mcp.json`] = json({
      mcpServers: { local: { command: 'local-mcp' } },
    });
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    routes[treeUrl] = tree([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'apps/notes.md',
    ]);
    const withApp = previewOf(await preview('acme', 'review'));
    expect(withApp.compatibility?.harnesses.cursor).toEqual({
      level: 'partial',
      missing: ['apps'],
    });

    // A nested file is not an app member: the server alone is Full.
    resetPluginManifestPreviewCache();
    routes[treeUrl] = tree([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'apps/nested/notes.md',
    ]);
    const nested = previewOf(await preview('acme', 'review'));
    expect(nested.compatibility?.harnesses.cursor).toEqual({ level: 'full' });

    resetPluginManifestPreviewCache();
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      apps: ['./apps/custom/notes.md'],
    });
    const files = [
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'apps/custom/notes.md',
    ];
    routes[treeUrl] = tree(files);
    expect(
      previewOf(await preview('acme', 'review')).compatibility?.harnesses
        .cursor,
    ).toEqual({ level: 'partial', missing: ['apps'] });

    resetPluginManifestPreviewCache();
    routes[treeUrl] = tree(files, { 'apps/custom/notes.md': { size: 0 } });
    expect(
      previewOf(await preview('acme', 'review')).compatibility?.harnesses
        .cursor,
    ).toEqual({ level: 'full' });

    resetPluginManifestPreviewCache();
    routes[treeUrl] = tree(files, {
      'apps/custom/notes.md': { mode: '120000' },
    });
    expect(
      previewOf(await preview('acme', 'review')).compatibility?.harnesses
        .cursor,
    ).toBeUndefined();

    // A declaration the light read cannot assess leaves Cursor unknown.
    resetPluginManifestPreviewCache();
    routes[treeUrl] = tree(['.claude-plugin/plugin.json', '.mcp.json']);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      apps: { notes: 1 },
    });
    const malformed = previewOf(await preview('acme', 'review'));
    expect(malformed.compatibility?.harnesses.cursor).toBeUndefined();
  });

  it('bounds each MCP endpoint a preview carries (CAN-7545)', () => {
    const parsed = parsePluginManifestPreviewResult({
      ok: true,
      preview: {
        skills: [],
        commands: [],
        agents: [],
        hooks: false,
        mcpServers: true,
        mcpServerNames: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        mcpServerEndpoints: [
          { name: 'a', type: 'http', url: 'https://a.example.com/mcp' },
          { name: 'b', type: 'http', url: `https://${'b'.repeat(4096)}` },
          { name: 'c', type: 'command', command: 'run\nnext' },
          {
            name: 'd',
            type: 'command',
            command: 'node',
            args: Array.from({ length: 33 }, () => 'x'),
          },
          { name: 'e', type: 'command', command: 'node', args: ['serve', ''] },
          { name: 'f', type: 'command', command: '  ' },
          { name: 'g', type: 'http', url: '  ' },
          {
            name: 'h',
            type: 'command',
            command: 'node',
            args: ['serve\u2028next'],
          },
        ],
      },
    });
    expect(parsed?.ok && parsed.preview.mcpServerEndpoints).toEqual([
      { name: 'a', type: 'http', url: 'https://a.example.com/mcp' },
      { name: 'e', type: 'command', command: 'node', args: ['serve', ''] },
    ]);
  });

  it('leaves the README and descriptions out when they fail, but a rate limit fails the preview', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['README.md', 'skills/review/SKILL.md']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/skills/review/SKILL.md`] = (): Response =>
      new Response('no front matter', { status: 200 });
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    // README missing (404): the preview has no README, and no descriptions.
    const plain = await preview('acme', 'review');
    expect(plain).toMatchObject({
      success: true,
      data: { ok: true, preview: { skills: ['review'] } },
    });
    expect(previewOf(plain).readme).toBeUndefined();
    expect(previewOf(plain).descriptions).toBeUndefined();

    resetPluginManifestPreviewCache();
    routes[`${raw}/README.md`] = (): Response =>
      new Response('limited', {
        status: 429,
        headers: { 'retry-after': '60' },
      });
    await expect(preview('acme', 'review')).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'rate_limited' },
    });
  });

  it('previews a plugin README from the marketplace checkout without fetching (CAN-7545)', async () => {
    const marketplaceDir = join(root, 'local-preview-marketplace');
    const sourcePath = './plugins/local-preview';
    const pluginDir = join(marketplaceDir, sourcePath);
    await mkdir(pluginDir, { recursive: true });
    const prefix = 'a'.repeat(PLUGIN_MANIFEST_PREVIEW_README_MAX_LENGTH - 1);
    await writeFile(join(pluginDir, 'README.md'), `${prefix}é beyond the cap`);
    const marketplace = cache.marketplaces[0];
    if (!marketplace) throw new Error('No marketplace in preview fixture');
    cache.marketplaces = [
      {
        ...marketplace,
        installLocation: marketplaceDir,
        plugins: [
          {
            ...catalogPlugin('local-preview', ''),
            sourcePath,
            externalSource: undefined,
          },
        ],
      },
    ];

    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    expect(previewOf(await preview('acme', 'local-preview')).readme).toEqual({
      body: prefix,
      truncated: true,
    });
    const catalogPluginRow = cache.marketplaces[0]?.plugins[0];
    if (!catalogPluginRow) throw new Error('No plugin in preview fixture');
    const siblingDir = join(root, 'sibling-preview-fixture');
    await mkdir(siblingDir);
    await writeFile(join(siblingDir, 'README.md'), 'Different checkout');
    catalogPluginRow.sourcePath = '../sibling-preview-fixture';
    await expect(preview('acme', 'local-preview')).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'unsupported_source' },
    });
    catalogPluginRow.sourcePath = siblingDir;
    await expect(preview('acme', 'local-preview')).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'unsupported_source' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens a catalog member through the checkout boundary without changing legacy reads (CAN-7545)', async (): Promise<void> => {
    const marketplaceDir = join(root, 'catalog-member-marketplace');
    const sourcePath = './plugins/local';
    const pluginDir = join(marketplaceDir, sourcePath);
    await mkdir(join(pluginDir, 'commands'), { recursive: true });
    await writeFile(
      join(pluginDir, 'commands/check.md'),
      '---\nname: check\n---\nCheck the branch.',
    );
    await symlink('check.md', join(pluginDir, 'commands/link.md'));
    const marketplace = cache.marketplaces[0];
    if (!marketplace) throw new Error('No marketplace in preview fixture');
    cache.marketplaces = [
      {
        ...marketplace,
        installLocation: marketplaceDir,
        validProviders: ['claude'],
        providerStatus: {
          claude: {
            provider: 'claude',
            state: 'valid',
            accepted: true,
            pluginCount: 1,
            lastCheckedAt: '2026-01-01T00:00:00.000Z',
            installLocation: marketplaceDir,
          },
          codex: {
            provider: 'codex',
            state: 'invalid',
            accepted: false,
            pluginCount: 0,
            lastCheckedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        plugins: [
          {
            ...catalogPlugin('local', ''),
            sourcePath,
            externalSource: undefined,
          },
        ],
      },
    ];
    const read = handler(PLUGINS_CHANNELS.READ_COMPONENT);
    const component = {
      success: true,
      data: { frontmatter: { name: 'check' }, body: 'Check the branch.' },
    };
    await expect(
      read(marketplaceDir, sourcePath, 'commands/check.md', 'catalog-checkout'),
    ).resolves.toEqual(component);
    await expect(
      read(marketplaceDir, sourcePath, 'commands/link.md', 'catalog-checkout'),
    ).resolves.toEqual({ success: false, error: 'Invalid component path.' });
    await expect(
      read(marketplaceDir, sourcePath, 'commands/link.md'),
    ).resolves.toEqual(component);

    // A location below the registered checkout is walked from the checkout:
    // a linked folder between them is refused, wherever the caller starts.
    const outsideDir = join(root, 'catalog-member-outside');
    await mkdir(join(outsideDir, 'plugin/commands'), { recursive: true });
    await writeFile(
      join(outsideDir, 'plugin/commands/secret.md'),
      '---\nname: secret\n---\nOutside the checkout.',
    );
    await symlink(outsideDir, join(marketplaceDir, 'linked'), 'dir');
    // Even a plugin folder the catalog trusts below the link is no anchor.
    cache.marketplaces[0]?.plugins.push({
      ...catalogPlugin('linked', ''),
      externalSource: undefined,
      facets: {
        claude: facet(
          'claude',
          'linked',
          join(marketplaceDir, 'linked/plugin'),
          {},
        ),
      },
    });
    for (const [location, plugin] of [
      [join(marketplaceDir, 'linked/plugin'), '.'],
      [join(marketplaceDir, 'linked'), './plugin'],
      [marketplaceDir, './linked/plugin'],
    ] as const)
      await expect(
        read(location, plugin, 'commands/secret.md', 'catalog-checkout'),
      ).resolves.toEqual({ success: false, error: 'Invalid component path.' });
    // A real folder below the checkout still reads.
    await expect(
      read(pluginDir, '.', 'commands/check.md', 'catalog-checkout'),
    ).resolves.toEqual(component);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'a plugin folder', listing: { path: './plugins/a/' } },
    { name: 'a branch or tag', listing: { ref: 'release/v2.0' } },
    {
      name: 'a folder and a ref',
      listing: { source: 'git-subdir', path: 'plugins/a', ref: 'main' },
    },
    { name: 'a folder that is not text', listing: { path: 7 } },
    { name: 'a ref that is not text', listing: { ref: ['main'] } },
    { name: 'a parent folder', listing: { path: '../elsewhere' } },
  ])(
    'does not preview a listing with $name: Add installs the default branch root (CAN-7545)',
    async ({ listing }) => {
      const marketplace = cache.marketplaces[0];
      if (!marketplace) throw new Error('No marketplace in preview fixture');
      // Even a pinned sha does not make a folder or ref the installed one.
      marketplace.plugins.push(
        catalogPlugin('odd', 'https://github.com/acme/odd', undefined, listing),
        catalogPlugin(
          'odd-pinned',
          'https://github.com/acme/odd',
          SHA,
          listing,
        ),
      );
      for (const name of ['odd', 'odd-pinned'])
        await expect(
          handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', name),
        ).resolves.toEqual({
          success: true,
          data: { ok: false, reason: 'unsupported_source' },
        });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('still previews a listing whose folder and ref are empty, from the repository root (CAN-7545)', async () => {
    const marketplace = cache.marketplaces[0];
    if (!marketplace) throw new Error('No marketplace in preview fixture');
    marketplace.plugins.push(
      catalogPlugin('plain', 'https://github.com/acme/plain', undefined, {
        path: '',
        ref: null,
      }),
    );
    routes[
      `https://api.github.com/repos/acme/plain/git/trees/${HEAD_SHA}?recursive=1`
    ] = tree(['README.md', 'skills/root/SKILL.md', '.mcp.json']);
    routes[
      `https://raw.githubusercontent.com/acme/plain/${HEAD_SHA}/README.md`
    ] = (): Response => new Response('# The repository root');
    routes[
      `https://raw.githubusercontent.com/acme/plain/${HEAD_SHA}/.mcp.json`
    ] = json({ mcpServers: { root: { command: 'root-mcp' } } });
    plainMembers(`https://raw.githubusercontent.com/acme/plain/${HEAD_SHA}`, [
      'skills/root/SKILL.md',
    ]);
    const plain = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'plain'),
    );
    expect(plain.readme?.body).toBe('# The repository root');
    expect(plain.skills).toEqual(['root']);
    expect(plain.mcpServerEndpoints).toEqual([
      { name: 'root', type: 'command', command: 'root-mcp' },
    ]);
  });

  it('lists an MCP server only a secondary native manifest declares (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      '.cursor-plugin/plugin.json',
      '.github/plugin/plugin.json',
      'config/copilot.json',
    ]);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: {
        docs: { url: 'https://example.com/mcp' },
        hidden: { command: 'x'.repeat(4096) },
      },
    });
    routes[`${raw}/.cursor-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: {
        docs: { url: 'https://cursor.example.com/ignored' },
        hidden: { command: 'not-the-winning-definition' },
        'cursor-only': { command: 'cursor-mcp', args: ['serve'] },
      },
    });
    routes[`${raw}/.github/plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: './config/copilot.json',
    });
    routes[`${raw}/config/copilot.json`] = json({
      mcpServers: { 'copilot-only': { command: 'copilot-mcp' } },
    });
    const { mcpServerNames, mcpServerEndpoints, compatibility } = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(mcpServerNames).toEqual([
      'copilot-only',
      'cursor-only',
      'docs',
      'hidden',
    ]);
    // The first definition wins, even if its endpoint is too long to show.
    expect(mcpServerEndpoints).toEqual([
      { name: 'copilot-only', type: 'command', command: 'copilot-mcp' },
      {
        name: 'cursor-only',
        type: 'command',
        command: 'cursor-mcp',
        args: ['serve'],
      },
      { name: 'docs', type: 'http', url: 'https://example.com/mcp' },
    ]);
    // The classifier still reads Claude's own evidence.
    expect(compatibility?.harnesses.claude).toEqual({ level: 'native' });
  });

  it('does not count a Cursor-only manifest and its custom MCP config as support elsewhere (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.cursor-plugin/plugin.json', 'config/cursor-mcp.json']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.cursor-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: './config/cursor-mcp.json',
    });
    routes[`${raw}/config/cursor-mcp.json`] = json({
      mcpServers: { 'cursor-http': { url: 'https://cursor.example.com/mcp' } },
    });
    const { mcpServerNames, mcpServerEndpoints, compatibility } = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    // Contents still list the Cursor manifest's server.
    expect(mcpServerNames).toEqual(['cursor-http']);
    expect(mcpServerEndpoints).toEqual([
      {
        name: 'cursor-http',
        type: 'http',
        url: 'https://cursor.example.com/mcp',
      },
    ]);
    // Claude and Codex never read that manifest, so it is no evidence for them.
    for (const harness of ['claude', 'codex', 'opencode'] as const)
      expect(compatibility?.harnesses[harness]?.level).not.toBe('full');
    expect(compatibility?.harnesses.claude).not.toEqual({ level: 'native' });
  });

  it('reserves root config reads for the fallback even when Cursor declares many files (CAN-7545)', async () => {
    const cursorConfigs = Array.from(
      { length: 40 },
      (_, index) => `config/cursor-${index}.json`,
    );
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.cursor-plugin/plugin.json', '.mcp.json', ...cursorConfigs]);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.cursor-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: cursorConfigs,
    });
    routes[`${raw}/.mcp.json`] = json({
      shared: { url: 'https://default.example.com/mcp' },
      default: { url: 'https://default.example.com/another' },
    });
    for (const path of cursorConfigs) routes[`${raw}/${path}`] = json({});
    routes[`${raw}/${cursorConfigs[0]}`] = json({
      shared: { command: 'cursor-mcp' },
    });
    const { compatibility, mcpServerEndpoints } = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(compatibility?.harnesses.cursor).toEqual({ level: 'native' });
    expect(compatibility?.harnesses.opencode).toEqual({ level: 'full' });
    // The last Cursor file is past the read budget and may define any server,
    // `shared` or `default`; Cursor's definitions come before the root
    // defaults in Contents, so both keep their names but show no endpoint.
    expect(mcpServerEndpoints).toBeUndefined();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === `${raw}/${cursorConfigs[39]}`,
      ),
    ).toBe(false);
  });

  it('merges MCP config files as the runtime does: a later definition wins (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', 'a.json', 'b.json']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const manifestUrl = `${raw}/.claude-plugin/plugin.json`;
    routes[manifestUrl] = json({
      name: 'review',
      mcpServers: ['./a.json', './b.json'],
    });
    // A legacy SSE definition leaves derived support unknown unless replaced.
    const firstUrl = `${raw}/a.json`;
    routes[firstUrl] = json({
      mcpServers: { s: { type: 'sse', url: 'https://old.example.com/sse' } },
    });
    routes[`${raw}/b.json`] = json({
      mcpServers: { s: { command: 'second-mcp' } },
    });
    const open = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const preview = previewOf(await open('acme', 'review'));
    expect(preview.mcpServerNames).toEqual(['s']);
    expect(preview.mcpServerEndpoints).toEqual([
      { name: 's', type: 'command', command: 'second-mcp' },
    ]);
    for (const harness of ['codex', 'cursor', 'copilot', 'opencode'] as const)
      expect(preview.compatibility?.harnesses[harness]).toEqual({
        level: 'full',
      });

    resetPluginManifestPreviewCache();
    fetchMock.mockClear();
    routes[manifestUrl] = json({
      name: 'review',
      mcpServers: ['./a.json', './b.json', './a.json'],
    });
    const repeated = previewOf(await open('acme', 'review'));
    expect(repeated.mcpServerNames).toEqual(['s']);
    // The winning SSE definition keeps its row, but the runtime starts no
    // server from it, so it shows no endpoint.
    expect(repeated.mcpServerEndpoints).toBeUndefined();
    for (const harness of ['codex', 'cursor', 'copilot', 'opencode'] as const)
      expect(repeated.compatibility?.harnesses[harness]).toBeUndefined();
    expect(
      fetchMock.mock.calls.filter(([url]) => url === firstUrl),
    ).toHaveLength(1);
  });

  it('shows no endpoint a later unread MCP config may replace (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', 'a.json', 'b.json', 'c.json']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: ['./a.json', './b.json', './c.json'],
    });
    routes[`${raw}/a.json`] = json({
      mcpServers: {
        early: { command: 'early-mcp' },
        late: { command: 'replaced-mcp' },
      },
    });
    // b.json is listed but cannot be read, so it may redefine either server.
    // c.json comes after it and settles the one it redefines.
    routes[`${raw}/c.json`] = json({ late: { command: 'late-mcp' } });
    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(preview.mcpServerNames).toEqual(['early', 'late']);
    expect(preview.mcpServerEndpoints).toEqual([
      { name: 'late', type: 'command', command: 'late-mcp' },
    ]);
  });

  it('settles MCP endpoints behind thousands of unread configs in linear time (CAN-7545)', async () => {
    // Publisher-supplied and read on Electron main: 40 read configs define
    // 80,000 servers, then 4,000 listed configs past the read budget follow.
    const read = Array.from({ length: 40 }, (_, index) => `r${index}.json`);
    const unread = Array.from({ length: 4000 }, (_, index) => `${index}.json`);
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', ...read, ...unread]);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: [...read, ...unread],
    });
    read.forEach((path, file) => {
      const servers: Record<string, { command: string }> = {};
      for (let index = 0; index < 2000; index += 1)
        servers[`s${file}_${index}`] = { command: 'x' };
      routes[`${raw}/${path}`] = json(servers);
    });
    const started = performance.now();
    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(performance.now() - started).toBeLessThan(2_000);
    // Every server keeps its name; an unread later config may replace each.
    expect(preview.mcpServerNames.length).toBeGreaterThan(0);
    expect(preview.mcpServerEndpoints).toBeUndefined();
  });

  it('scans each MCP config once, however often the manifest names it (CAN-7545)', async () => {
    // Publisher-supplied and read on Electron main: a manifest may name one
    // config thousands of times. Each scan of its servers is counted where
    // their names are listed.
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', 'a.json', 'b.json', 'c.json']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/a.json`] = json({
      mcpServers: {
        alpha: { command: 'alpha-mcp' },
        beta: { url: 'https://beta.example.com/mcp' },
      },
    });
    // b.json is listed but cannot be read, so it may redefine either server.
    routes[`${raw}/c.json`] = json({ gamma: { command: 'gamma-mcp' } });
    const parse = JSON.parse;
    let scans = 0;
    const counted = (value: unknown): unknown => {
      if (typeof value !== 'object' || value === null) return value;
      const servers: unknown = Reflect.get(value, 'mcpServers');
      if (typeof servers !== 'object' || servers === null) return value;
      return {
        ...value,
        mcpServers: new Proxy(servers, {
          ownKeys(target): (string | symbol)[] {
            scans += 1;
            return Reflect.ownKeys(target);
          },
        }),
      };
    };
    const spy = jest
      .spyOn(JSON, 'parse')
      .mockImplementation((text: string, reviver) => {
        const value: unknown = parse(text, reviver);
        return text.includes('alpha-mcp') ? counted(value) : value;
      });
    const run = async (
      configs: readonly string[],
    ): Promise<{ preview: PluginManifestPreview; scans: number }> => {
      resetPluginManifestPreviewCache();
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        mcpServers: configs,
      });
      scans = 0;
      const preview = previewOf(
        await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
      );
      return { preview, scans };
    };
    const many = (path: string): string[] =>
      Array.from({ length: 2000 }, () => path);
    try {
      const alpha = { name: 'alpha', type: 'command', command: 'alpha-mcp' };
      const beta = {
        name: 'beta',
        type: 'http',
        url: 'https://beta.example.com/mcp',
      };
      const gamma = { name: 'gamma', type: 'command', command: 'gamma-mcp' };
      const once = await run(['a.json', 'c.json']);
      expect(once.scans).toBeGreaterThan(0);
      expect(once.preview.mcpServerEndpoints).toEqual([alpha, beta, gamma]);

      const repeated = await run([...many('./a.json'), 'c.json']);
      expect(repeated.scans).toBe(once.scans);
      expect(repeated.preview).toEqual(once.preview);

      // An unread config after a config's last position still withholds its
      // endpoints, however often it was named before.
      const withheld = await run([...many('a.json'), 'b.json', 'c.json']);
      expect(withheld.scans).toBe(once.scans);
      expect(withheld.preview.mcpServerNames).toEqual([
        'alpha',
        'beta',
        'gamma',
      ]);
      expect(withheld.preview.mcpServerEndpoints).toEqual([gamma]);

      // Named again after the unread config, its definitions win again.
      const relisted = await run([
        'a.json',
        'b.json',
        ...many('a.json'),
        'c.json',
      ]);
      expect(relisted.scans).toBe(once.scans);
      expect(relisted.preview.mcpServerEndpoints).toEqual([alpha, beta, gamma]);
    } finally {
      spy.mockRestore();
    }
  });

  it('records each folder of a deep listing once when checking its spellings (CAN-7545)', async () => {
    // A publisher's repository may hold many files deep in one folder chain;
    // checking spellings must not walk the whole chain again for each file.
    const depth = 200;
    const files = 200;
    const folder = Array.from({ length: depth }, () => 'd').join('/');
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      'skills/review/SKILL.md',
      ...Array.from({ length: files }, (_, index) => `${folder}/${index}.txt`),
    ]);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    plainMembers(raw, ['skills/review/SKILL.md']);
    const spy = jest.spyOn(String.prototype, 'toLowerCase');
    try {
      const preview = previewOf(
        await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
      );
      expect(preview.skills).toEqual(['review']);
      // Each file and each folder once, with room to spare; walking the chain
      // for every file would take depth × files.
      expect(spy.mock.calls.length).toBeLessThan((depth + files) * 4);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps every lookup of a deep publisher path linear in its length (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    // Deep folder chains in the listing, and manifest paths through one.
    const deep = Array.from(
      { length: 3 },
      (_, index) => `d${index}/${'a/'.repeat(3000)}x.txt`,
    );
    const listedChain = `${'b/'.repeat(1500)}other.json`;
    const withinCap = `${'b/'.repeat(1500)}mcp.json`;
    // Longer than any path the preview resolves: unread, so it may replace
    // the servers `.mcp.json` defines before it.
    const overCap = `${'A/'.repeat(2100)}mcp.json`;
    const listing = [
      '.claude-plugin/plugin.json',
      '.mcp.json',
      listedChain,
      ...deep,
    ];
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(listing);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: ['./.mcp.json', withinCap, overCap],
    });
    routes[`${raw}/.mcp.json`] = json({
      mcpServers: { github: { command: 'gh-mcp' } },
    });
    // Each call's string, as the spy records it, measures the work done.
    const spy = jest.spyOn(String.prototype, 'toLowerCase');
    let lowered = 0;
    let result: unknown;
    try {
      result = await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)(
        'acme',
        'review',
      );
    } finally {
      for (const text of spy.mock.contexts) lowered += String(text).length;
      spy.mockRestore();
    }
    const preview = previewOf(result);
    expect(preview.mcpServerNames).toEqual(['github']);
    expect(preview.mcpServerEndpoints).toBeUndefined();
    // Every path is lowercased a bounded number of times, never once for
    // each folder on its way (which would take its length × its depth).
    const total = [...listing, withinCap, overCap].join('').length;
    expect(lowered).toBeLessThan(total * 20);
  });

  it('leaves a facet unknown when a symlinked folder may hide its config or manifest (CAN-7545)', async () => {
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    routes[`${raw}/.mcp.json`] = json({
      mcpServers: { docs: { command: 'docs-mcp' } },
    });
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const base = ['.claude-plugin/plugin.json', '.mcp.json'];

    // With no hooks at all, one command server settles Cursor Full.
    routes[treeUrl] = tree(base);
    expect(
      previewOf(await preview('acme', 'review')).compatibility?.harnesses
        .cursor,
    ).toEqual({ level: 'full' });

    // A symlinked hooks folder is listed as one entry. The installed scan
    // follows it and may find command hooks Cursor cannot load, so the
    // missing hooks/hooks.json is no proof of no hooks.
    for (const link of ['hooks', 'hooks/hooks.json']) {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree([...base, link], { [link]: { mode: '120000' } });
      routes[`${raw}/hooks/hooks.json`] = (): Response =>
        new Response('../shared/hooks.json');
      const linked = previewOf(await preview('acme', 'review'));
      expect(linked.compatibility?.harnesses.cursor).toBeUndefined();
      expect(linked.compatibility?.harnesses.opencode).toBeUndefined();
    }

    // A symlinked root server, language or app file is not followed either,
    // even when the host answers with what looks like its content.
    routes[`${raw}/.lsp.json`] = json({});
    for (const link of ['.mcp.json', '.lsp.json', '.app.json']) {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree([...new Set([...base, link])], {
        [link]: { mode: '120000' },
      });
      expect(
        previewOf(await preview('acme', 'review')).compatibility?.harnesses
          .cursor,
      ).toBeUndefined();
    }

    // A manifest behind a symlinked folder is unread, not absent.
    resetPluginManifestPreviewCache();
    routes[treeUrl] = tree(['.claude-plugin', '.mcp.json'], {
      '.claude-plugin': { mode: '120000' },
    });
    const hidden = previewOf(await preview('acme', 'review'));
    expect(hidden.compatibility?.harnesses.claude).toBeUndefined();
    expect(hidden.compatibility?.harnesses.cursor).toBeUndefined();

    // A declared config behind a symlinked folder may replace earlier servers.
    resetPluginManifestPreviewCache();
    routes[treeUrl] = tree([...base, 'a.json', 'linked'], {
      linked: { mode: '120000' },
    });
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: ['./a.json', './linked/b.json'],
    });
    routes[`${raw}/a.json`] = json({ early: { command: 'early-mcp' } });
    const behind = previewOf(await preview('acme', 'review'));
    expect(behind.mcpServerNames).toEqual(['early']);
    expect(behind.mcpServerEndpoints).toBeUndefined();
  });

  it('takes no MCP endpoint from a later manifest when the winning definition has none (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', '.cursor-plugin/plugin.json']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    // Claude's definition wins the name but has no command or URL.
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: { shared: {}, docs: { url: 'https://docs.example.com' } },
    });
    routes[`${raw}/.cursor-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: {
        shared: { command: 'cursor-mcp' },
        docs: { url: 'https://cursor.example.com/ignored' },
      },
    });
    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(preview.mcpServerNames).toEqual(['docs', 'shared']);
    expect(preview.mcpServerEndpoints).toEqual([
      { name: 'docs', type: 'http', url: 'https://docs.example.com' },
    ]);
  });

  it('shows no endpoint a higher-priority unread manifest may define (CAN-7545)', async () => {
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    routes[treeUrl] = tree([
      '.claude-plugin/plugin.json',
      '.cursor-plugin/plugin.json',
    ]);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    // The Claude manifest is listed but cannot be read: it may define `shared`
    // and win the name, so Cursor's definition is not the endpoint.
    routes[`${raw}/.cursor-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: { shared: { command: 'cursor-mcp' } },
    });
    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(preview.mcpServerNames).toEqual(['shared']);
    expect(preview.mcpServerEndpoints).toBeUndefined();

    // With the Claude manifest read, its definition wins as before, and an
    // unread manifest below it changes nothing.
    resetPluginManifestPreviewCache();
    routes[treeUrl] = tree([
      '.claude-plugin/plugin.json',
      '.cursor-plugin/plugin.json',
      '.github/plugin/plugin.json',
    ]);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: { shared: { command: 'claude-mcp' } },
    });
    const settled = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(settled.mcpServerEndpoints).toEqual([
      { name: 'shared', type: 'command', command: 'claude-mcp' },
    ]);
  });

  it('leaves compatibility unknown for a default member folder spelled with other case (CAN-7545)', async () => {
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    routes[`${raw}/.mcp.json`] = json({});
    plainMembers(raw, ['skills/review/SKILL.md']);
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const base = ['.claude-plugin/plugin.json', '.mcp.json'];

    // A case-insensitive checkout loads `Commands/run.md` as a command, which
    // the preview does not count. It cannot call Cursor unsupported.
    for (const path of [
      'Commands/run.md',
      'SKILLS/review/SKILL.md',
      'Agents/helper.md',
    ]) {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree([...base, path]);
      const variant = previewOf(await preview('acme', 'review'));
      expect(variant.skills).toEqual([]);
      expect(variant.commands).toEqual([]);
      expect(variant.agents).toEqual([]);
      expect(variant.compatibility?.harnesses.cursor).toBeUndefined();
    }

    // The lowercase folder settles as before; a nested folder is no default.
    resetPluginManifestPreviewCache();
    routes[treeUrl] = tree([
      ...base,
      'skills/review/SKILL.md',
      'docs/Commands/run.md',
    ]);
    const lower = previewOf(await preview('acme', 'review'));
    expect(lower.skills).toEqual(['review']);
    expect(lower.compatibility?.harnesses.cursor).toEqual({ level: 'full' });
  });

  it('leaves compatibility unknown for a file the readers look up, spelled with other case (CAN-7545)', async () => {
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    plainMembers(raw, ['commands/run.md']);
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const read = async (
      files: readonly string[],
      manifest: Record<string, unknown> = {},
    ): Promise<ReturnType<typeof previewOf>> => {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree(['.claude-plugin/plugin.json', ...files]);
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        ...manifest,
      });
      return previewOf(await preview('acme', 'review'));
    };

    // A skill folder's only file, spelled `skill.md`: a case-insensitive
    // checkout loads it as SKILL.md, so it is neither a skill nor nothing.
    const skill = await read(['skills/review/skill.md']);
    expect(skill.skills).toEqual([]);
    expect(skill.compatibility?.harnesses.cursor).toBeUndefined();

    // Each of these is where an installed reader looks up the usual name; the
    // preview reads none of them, so it cannot call Cursor full.
    for (const [file, manifest] of [
      ['skills/review/SKILL.MD', {}],
      ['.MCP.json', {}],
      ['hooks/Hooks.json', {}],
      ['Hooks/hooks.json', {}],
      ['.LSP.json', {}],
      ['.App.json', {}],
      ['.Cursor-plugin/plugin.json', {}],
      ['Views/notes.md', { apps: './views' }],
    ] as const) {
      const variant = await read(['commands/run.md', file], manifest);
      expect(variant.commands).toEqual(['run']);
      expect(variant.compatibility?.harnesses.cursor).toBeUndefined();
    }

    // The usual spellings settle as before.
    expect(
      (await read(['commands/run.md', 'skills/review/SKILL.md'])).compatibility
        ?.harnesses.cursor,
    ).toEqual({ level: 'full' });
  });

  it('shows no endpoint a lower manifest defines when a higher one has an unread MCP config (CAN-7545)', async () => {
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    routes[`${raw}/.cursor-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: { shared: { command: 'cursor-mcp' } },
    });
    const read = async (
      claudeMcp: unknown,
    ): Promise<ReturnType<typeof previewOf>> => {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree([
        '.claude-plugin/plugin.json',
        '.cursor-plugin/plugin.json',
        '.mcp-claude.json',
      ]);
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        mcpServers: claudeMcp,
      });
      return previewOf(await preview('acme', 'review'));
    };

    // Claude's listed config cannot be read: it may define `shared` and win
    // the name, so Cursor's definition is not the endpoint.
    const unread = await read('./.mcp-claude.json');
    expect(unread.mcpServerNames).toEqual(['shared']);
    expect(unread.mcpServerEndpoints).toBeUndefined();

    // A path another host reads differently may define it there too.
    const backslash = await read('.\\.mcp-claude.json');
    expect(backslash.mcpServerNames).toEqual(['shared']);
    expect(backslash.mcpServerEndpoints).toBeUndefined();

    // Read, it defines only `other`, so Cursor's `shared` shows.
    routes[`${raw}/.mcp-claude.json`] = json({
      mcpServers: { other: { command: 'claude-mcp' } },
    });
    const settled = await read('./.mcp-claude.json');
    expect(settled.mcpServerEndpoints).toEqual([
      { name: 'other', type: 'command', command: 'claude-mcp' },
      { name: 'shared', type: 'command', command: 'cursor-mcp' },
    ]);
  });

  it('reads no MCP server from a config the desktop resolver cannot parse for its byte order mark (CAN-7545)', async () => {
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const read = async (
      mcpText: string,
    ): Promise<ReturnType<typeof previewOf>> => {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree([
        '.claude-plugin/plugin.json',
        '.cursor-plugin/plugin.json',
        '.mcp-claude.json',
        'skills/review/SKILL.md',
      ]);
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        mcpServers: './.mcp-claude.json',
      });
      routes[`${raw}/.cursor-plugin/plugin.json`] = json({
        name: 'review',
        mcpServers: { shared: { command: 'cursor-mcp' } },
      });
      routes[`${raw}/.mcp-claude.json`] = (): Response => new Response(mcpText);
      return previewOf(await preview('acme', 'review'));
    };
    const config = JSON.stringify({
      mcpServers: { github: { command: 'gh-mcp' } },
    });

    // Without a byte order mark the config settles OpenCode and shows its
    // server. (Cursor reads its own manifest natively.)
    const plain = await read(config);
    expect(plain.compatibility?.harnesses.opencode).toEqual({ level: 'full' });
    expect(plain.mcpServerEndpoints).toEqual([
      { name: 'github', type: 'command', command: 'gh-mcp' },
      { name: 'shared', type: 'command', command: 'cursor-mcp' },
    ]);

    // With one, the installed resolver loads no server from it: its facets
    // stay unknown, it shows no endpoint, and it may still win `shared`.
    const marked = await read(`\uFEFF${config}`);
    for (const harness of ['opencode', 'codex'] as const)
      expect(marked.compatibility?.harnesses[harness]).toBeUndefined();
    expect(marked.mcpServerNames).toEqual(['shared']);
    expect(marked.mcpServerEndpoints).toBeUndefined();
  });

  it('reads the tree and every file of an unpinned listing at one resolved commit (CAN-7545)', async () => {
    const NEXT_SHA = 'c'.repeat(40);
    const api = 'https://api.github.com/repos/acme/hooked';
    let lookups = 0;
    // The default branch moves right after the first lookup.
    routes[`${api}/commits/HEAD`] = (): Response => {
      lookups += 1;
      return new Response(lookups === 1 ? HEAD_SHA : NEXT_SHA);
    };
    const revision = (ref: string, newer: boolean): void => {
      const raw = `https://raw.githubusercontent.com/acme/hooked/${ref}`;
      routes[`${api}/git/trees/${ref}?recursive=1`] = tree([
        '.claude-plugin/plugin.json',
        '.mcp.json',
        'README.md',
        'skills/a/SKILL.md',
        ...(newer ? ['hooks/hooks.json'] : []),
      ]);
      routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'hooked' });
      routes[`${raw}/.mcp.json`] = json({
        mcpServers: { github: { command: newer ? 'gh-next' : 'gh-mcp' } },
      });
      routes[`${raw}/README.md`] = (): Response =>
        new Response(newer ? '# Next' : '# First');
      routes[`${raw}/skills/a/SKILL.md`] = (): Response =>
        new Response(`---\ndescription: ${newer ? 'Next' : 'First'}\n---\n`);
      routes[`${raw}/hooks/hooks.json`] = json({
        PreToolUse: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }],
      });
    };
    revision(HEAD_SHA, false);
    revision(NEXT_SHA, true);
    revision('HEAD', true);

    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'hooked'),
    );
    expect(lookups).toBe(1);
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toContain(`${api}/git/trees/${HEAD_SHA}?recursive=1`);
    const reads = urls.filter((url) =>
      url.startsWith('https://raw.githubusercontent.com/'),
    );
    expect(reads.length).toBeGreaterThan(3);
    for (const url of reads)
      expect(url).toMatch(
        `https://raw.githubusercontent.com/acme/hooked/${HEAD_SHA}/`,
      );
    expect(preview.readme?.body).toBe('# First');
    expect(preview.descriptions).toEqual({ 'skill:a': 'First' });
    expect(preview.hooks).toBe(false);
    expect(preview.mcpServerEndpoints).toEqual([
      { name: 'github', type: 'command', command: 'gh-mcp' },
    ]);
    expect(preview.compatibility?.harnesses.cursor).toEqual({ level: 'full' });

    // A commit that cannot be resolved fails the preview like the tree.
    resetPluginManifestPreviewCache();
    routes[`${api}/commits/HEAD`] = (): Response => new Response('main');
    await expect(
      handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'hooked'),
    ).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'unavailable' },
    });
  });

  it('reads no endpoint from a symlinked MCP config, and lets it withhold lower ones (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(
      [
        '.claude-plugin/plugin.json',
        '.cursor-plugin/plugin.json',
        '.mcp-claude.json',
        'skills/review/SKILL.md',
      ],
      { '.mcp-claude.json': { mode: '120000' } },
    );
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: './.mcp-claude.json',
    });
    routes[`${raw}/.cursor-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: { shared: { command: 'cursor-mcp' } },
    });
    // The host answers the link's path with JSON, as it may for a target.
    routes[`${raw}/.mcp-claude.json`] = json({
      mcpServers: { linked: { url: 'https://linked.example/mcp' } },
    });
    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(
      fetchMock.mock.calls.some(([url]) => url === `${raw}/.mcp-claude.json`),
    ).toBe(false);
    expect(preview.mcpServerNames).toEqual(['shared']);
    expect(preview.mcpServerEndpoints).toBeUndefined();
    for (const harness of ['opencode', 'codex'] as const)
      expect(preview.compatibility?.harnesses[harness]).toBeUndefined();
  });

  it('reads no hook from a hooks file with a byte order mark, so OpenCode stays unknown (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      'hooks/hooks.json',
      'skills/review/SKILL.md',
    ]);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    const read = async (
      hooksText: string,
    ): Promise<ReturnType<typeof previewOf>> => {
      resetPluginManifestPreviewCache();
      routes[`${raw}/hooks/hooks.json`] = (): Response =>
        new Response(hooksText);
      return previewOf(
        await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
      );
    };
    const hooks = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] },
        ],
      },
    });

    // One synchronous command hook settles OpenCode.
    const plain = await read(hooks);
    expect(plain.compatibility?.harnesses.opencode).toEqual({ level: 'full' });

    // The desktop hook reader parses the raw text and loads no hook from it,
    // so the hook is not proof of what any derived harness loads.
    // The installed scan lists no hook from it either, so Contents shows no
    // Hook row.
    const marked = await read(`\uFEFF${hooks}`);
    expect(marked.hooks).toBe(false);
    expect(marked.compatibility?.harnesses.claude).toEqual({ level: 'native' });
    for (const harness of ['opencode', 'cursor', 'codex', 'copilot'] as const)
      expect(marked.compatibility?.harnesses[harness]).toBeUndefined();
  });

  it('reads no language server from a config with a byte order mark (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      '.lsp.json',
      'skills/review/SKILL.md',
    ]);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    const read = async (
      lspText: string,
    ): Promise<ReturnType<typeof previewOf>> => {
      resetPluginManifestPreviewCache();
      routes[`${raw}/.lsp.json`] = (): Response => new Response(lspText);
      return previewOf(
        await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
      );
    };
    const lsp = JSON.stringify({ typescript: { command: 'tsserver' } });

    const plain = await read(lsp);
    expect(plain.compatibility?.harnesses.cursor).toEqual({
      level: 'partial',
      missing: ['lspServers'],
    });

    const marked = await read(`\uFEFF${lsp}`);
    expect(marked.compatibility?.harnesses.claude).toEqual({ level: 'native' });
    for (const harness of ['opencode', 'cursor', 'codex', 'copilot'] as const)
      expect(marked.compatibility?.harnesses[harness]).toBeUndefined();
  });

  it('shows no endpoint a manifest cut from a truncated listing may define (CAN-7545)', async () => {
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.cursor-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: { shared: { command: 'cursor-mcp' } },
    });
    // The Claude manifest takes precedence and may define `shared`.
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: { shared: { command: 'claude-mcp' } },
    });
    const read = async (
      truncated: boolean,
    ): Promise<ReturnType<typeof previewOf>> => {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree(['.cursor-plugin/plugin.json'], {}, truncated);
      return previewOf(
        await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
      );
    };

    // A complete listing without it proves it absent.
    const complete = await read(false);
    expect(complete.mcpServerEndpoints).toEqual([
      { name: 'shared', type: 'command', command: 'cursor-mcp' },
    ]);

    // A truncated listing may have cut it: it is unread, not absent.
    const cut = await read(true);
    expect(cut.mcpServerNames).toEqual(['shared']);
    expect(cut.mcpServerEndpoints).toBeUndefined();
    expect(cut.compatibility?.harnesses.claude).toBeUndefined();
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === `${raw}/.claude-plugin/plugin.json`,
      ),
    ).toBe(false);
  });

  it('reads no symlinked native manifest, which stays unread (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(
      [
        '.claude-plugin/plugin.json',
        '.cursor-plugin/plugin.json',
        'skills/review/SKILL.md',
      ],
      { '.claude-plugin/plugin.json': { mode: '120000' } },
    );
    // The host answers the link's path with JSON, as it may for a target.
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: { shared: { command: 'claude-mcp' } },
    });
    routes[`${raw}/.cursor-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: { shared: { command: 'cursor-mcp' } },
    });
    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url]) => url === `${raw}/.claude-plugin/plugin.json`,
      ),
    ).toBe(false);
    expect(preview.compatibility?.harnesses.claude).toBeUndefined();
    expect(preview.mcpServerNames).toEqual(['shared']);
    expect(preview.mcpServerEndpoints).toBeUndefined();
  });

  it('leaves compatibility unknown for a member listed in two spellings (CAN-7545)', async () => {
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    routes[`${raw}/.mcp.json`] = json({});
    const read = async (
      files: readonly string[],
    ): Promise<ReturnType<typeof previewOf>> => {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree([
        '.claude-plugin/plugin.json',
        '.mcp.json',
        ...files,
      ]);
      return previewOf(
        await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
      );
    };

    // A case-insensitive checkout keeps one of the two, so which loads is
    // unknown.
    for (const files of [
      ['skills/Review/SKILL.md', 'skills/review/SKILL.md'],
      ['skills/review/SKILL.md', 'commands/Run.md', 'commands/run.md'],
      ['skills/review/SKILL.md', 'agents/Helper.md', 'agents/helper.md'],
    ]) {
      const twice = await read(files);
      expect(twice.compatibility?.harnesses.claude).toEqual({
        level: 'native',
      });
      expect(twice.compatibility?.harnesses.cursor).toBeUndefined();
    }

    // One spelling settles as before.
    expect(
      (await read(['skills/review/SKILL.md', 'commands/run.md'])).compatibility
        ?.harnesses.cursor,
    ).toEqual({ level: 'full' });
  });

  it('reads and lists no member whose file or skill folder has two spellings (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      // A case-insensitive checkout keeps one file of each pair.
      'commands/Deploy.md',
      'commands/deploy.md',
      'agents/Helper.md',
      'agents/helper.md',
      'skills/Review/SKILL.md',
      'skills/review/SKILL.md',
      // One SKILL.md, but its folder is also spelled `Tool`: the skill's
      // name is whichever spelling the checkout keeps.
      'skills/tool/SKILL.md',
      'skills/Tool/notes.md',
      // Settled members, one named like an unread colliding file.
      'commands/ship.md',
      'skills/plan/SKILL.md',
    ]);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    routes[`${raw}/.mcp.json`] = json({});
    const head = (description: string, name?: string): (() => Response) => {
      const named = name ? `name: ${name}\n` : '';
      return (): Response =>
        new Response(`---\n${named}description: ${description}\n---\n`);
    };
    const ambiguous = [
      'commands/Deploy.md',
      'commands/deploy.md',
      'agents/Helper.md',
      'agents/helper.md',
      'skills/Review/SKILL.md',
      'skills/review/SKILL.md',
      'skills/tool/SKILL.md',
    ];
    for (const path of ambiguous) routes[`${raw}/${path}`] = head('Colliding');
    routes[`${raw}/commands/ship.md`] = head('Ships it', 'deploy');
    routes[`${raw}/skills/plan/SKILL.md`] = head('Plans it');
    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    const urls = fetchMock.mock.calls.map(([url]) => url);
    for (const path of ambiguous) expect(urls).not.toContain(`${raw}/${path}`);
    expect(preview.skills).toEqual(['plan']);
    expect(preview.agents).toEqual([]);
    // `ship.md` is the command `deploy`; an unread `deploy.md` may be too,
    // so the row shows no description.
    expect(preview.commands).toEqual(['deploy']);
    expect(preview.descriptions).toEqual({ 'skill:plan': 'Plans it' });
    expect(preview.compatibility?.harnesses.claude).toEqual({
      level: 'native',
    });
    expect(preview.compatibility?.harnesses.cursor).toBeUndefined();
  });

  it('gives no description to a name a member the preview cannot read may hold (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(
      [
        '.claude-plugin/plugin.json',
        // Named `review` by its front matter; a symlinked SKILL.md the
        // scanner follows is the skill `review` too.
        'skills/alpha/SKILL.md',
        'skills/review/SKILL.md',
        // Named `tool`; a case-insensitive checkout reads `skill.md` as the
        // skill `tool`.
        'skills/beta/SKILL.md',
        'skills/tool/skill.md',
        'skills/plan/SKILL.md',
        // Named `deploy`, beside a symlinked `deploy.md`.
        'commands/check.md',
        'commands/deploy.md',
        // Named `Helper`; of the pair a case-insensitive checkout keeps one
        // name and one content, so `Helper.md`, empty here, may be a member.
        'agents/plan.md',
        'agents/Helper.md',
        'agents/helper.md',
        'agents/scout.md',
      ],
      {
        'skills/review/SKILL.md': { mode: '120000', size: 12 },
        'commands/deploy.md': { mode: '120000', size: 12 },
        'agents/Helper.md': { size: 0 },
      },
    );
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    const head = (description: string, name?: string): (() => Response) => {
      const named = name ? `name: ${name}\n` : '';
      return (): Response =>
        new Response(`---\n${named}description: ${description}\n---\n`);
    };
    routes[`${raw}/skills/alpha/SKILL.md`] = head('From alpha', 'review');
    routes[`${raw}/skills/beta/SKILL.md`] = head('From beta', 'tool');
    routes[`${raw}/skills/plan/SKILL.md`] = head('Plans it');
    routes[`${raw}/commands/check.md`] = head('Checks', 'deploy');
    routes[`${raw}/agents/plan.md`] = head('Plans', 'Helper');
    routes[`${raw}/agents/scout.md`] = head('Scouts');
    const unread = [
      'skills/review/SKILL.md',
      'skills/tool/skill.md',
      'commands/deploy.md',
      'agents/Helper.md',
      'agents/helper.md',
    ];
    for (const path of unread)
      routes[`${raw}/${path}`] = (): Response => new Response('Body');
    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    const urls = fetchMock.mock.calls.map(([url]) => url);
    for (const path of unread) expect(urls).not.toContain(`${raw}/${path}`);
    // The unread files claim no row of their own.
    expect(preview.skills).toEqual(['plan', 'review', 'tool']);
    expect(preview.commands).toEqual(['deploy']);
    expect(preview.agents).toEqual(['Helper', 'scout']);
    expect(preview.descriptions).toEqual({
      'skill:plan': 'Plans it',
      'agent:scout': 'Scouts',
    });
  });

  it('lists no skill when the installed skill scan may fail as a whole (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const manifestUrl = `${raw}/.claude-plugin/plugin.json`;
    const base = [
      '.claude-plugin/plugin.json',
      'skills/review/SKILL.md',
      'commands/ship.md',
    ];
    plainMembers(raw, ['skills/review/SKILL.md', 'commands/ship.md']);
    const read = async (
      paths: readonly string[],
      links: readonly string[],
      manifest: Record<string, unknown> = { name: 'review' },
    ): Promise<PluginManifestPreview> => {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree(
        [...base, ...paths],
        Object.fromEntries(
          links.map((link) => [link, { mode: '120000', size: 12 }]),
        ),
      );
      routes[manifestUrl] = json(manifest);
      return previewOf(
        await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
      );
    };
    // A link inside a skill folder fails no stat of the skill scan.
    const settled = await read(['skills/review/refs'], ['skills/review/refs']);
    expect(settled.skills).toEqual(['review']);
    // A child of the skill folder that may dangle fails the whole scan,
    // whatever order the folder lists its children in.
    for (const link of ['skills/old', 'skills/zzz', 'Skills/old']) {
      const dangling = await read([link], [link]);
      expect(dangling.skills).toEqual([]);
      expect(dangling.commands).toEqual(['ship']);
      expect(dangling.compatibility?.harnesses.cursor).toBeUndefined();
    }
    // So does one in another folder the manifest reads skills from.
    const extra = await read(['extra/old'], ['extra/old'], {
      name: 'review',
      skills: ['./skills', './extra'],
    });
    expect(extra.skills).toEqual([]);
    expect(extra.commands).toEqual(['ship']);
  });

  it('reads no member, manifest or config below a folder spelled more than one way (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
      // A case-insensitive checkout cannot hold both a file and a folder of
      // one name, or a folder in two spellings.
      'Commands',
      'commands/run.md',
      'AGENTS/notes.txt',
      'agents/helper.md',
      'Skills',
      'skills/plan/SKILL.md',
      '.Codex-plugin/notes.txt',
      'Config',
      'config/mcp.json',
    ]);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: './config/mcp.json',
    });
    routes[`${raw}/.codex-plugin/plugin.json`] = json({ name: 'review' });
    routes[`${raw}/config/mcp.json`] = json({
      mcpServers: { docs: { command: 'docs-mcp' } },
    });
    const unread = [
      'commands/run.md',
      'agents/helper.md',
      'skills/plan/SKILL.md',
      '.codex-plugin/plugin.json',
      'config/mcp.json',
    ];
    plainMembers(raw, unread.slice(0, 3));
    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    const urls = fetchMock.mock.calls.map(([url]) => url);
    for (const path of unread) expect(urls).not.toContain(`${raw}/${path}`);
    expect(preview.commands).toEqual([]);
    expect(preview.agents).toEqual([]);
    expect(preview.skills).toEqual([]);
    expect(preview.mcpServerNames).toEqual([]);
    expect(preview.compatibility?.harnesses.codex).toBeUndefined();
    expect(preview.compatibility?.harnesses.cursor).toBeUndefined();
  });

  it('counts members past the Contents limits for compatibility (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const longName = 'a'.repeat(129);
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      `agents/${longName}.md`,
    ]);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    routes[`${raw}/.mcp.json`] = json({
      mcpServers: { local: { command: 'local-mcp' } },
    });
    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    // Too long a name to show, but the installed scan loads the agent, which
    // Cursor does not.
    expect(preview.agents).toEqual([]);
    expect(preview.compatibility?.harnesses.cursor).toEqual({
      level: 'partial',
      missing: ['agents'],
    });
  });

  it('leaves a facet unknown for a config path the hosts read differently (CAN-7545)', async () => {
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/config/mcp.json`] = json({
      mcpServers: { docs: { command: 'docs-mcp' } },
    });
    routes[`${raw}/config/hooks.json`] = json({});
    routes[`${raw}/config/lsp.json`] = json({});
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const files = [
      '.claude-plugin/plugin.json',
      'config/mcp.json',
      'config/hooks.json',
      'config/lsp.json',
    ];
    const read = async (
      manifest: Record<string, unknown>,
    ): Promise<ReturnType<typeof previewOf>> => {
      resetPluginManifestPreviewCache();
      routes[treeUrl] = tree(files);
      routes[`${raw}/.claude-plugin/plugin.json`] = json({
        name: 'review',
        ...manifest,
      });
      return previewOf(await preview('acme', 'review'));
    };

    // The same path with a slash settles Cursor.
    const slash = await read({ mcpServers: './config/mcp.json' });
    expect(slash.mcpServerNames).toEqual(['docs']);
    expect(slash.compatibility?.harnesses.cursor).toEqual({ level: 'full' });

    // POSIX path.resolve keeps a backslash as a filename character, so the
    // installed plugin loads no server from it; the preview shows none either.
    for (const manifest of [
      { mcpServers: '.\\config\\mcp.json' },
      { hooks: '.\\config\\hooks.json' },
      { lspServers: ['config\\lsp.json'] },
    ]) {
      const unread = await read(manifest);
      expect(unread.mcpServerNames).toEqual([]);
      expect(unread.mcpServerEndpoints).toBeUndefined();
      expect(unread.compatibility?.harnesses.cursor).toBeUndefined();
      expect(unread.compatibility?.harnesses.opencode).toBeUndefined();
    }

    // Each listed entry is read on its own: the slash path still supplies
    // its server, but the backslash path after it, which Windows reads as
    // the same or another file, may replace its endpoint.
    const mixed = await read({
      mcpServers: ['./config/mcp.json', 'config\\mcp.json'],
    });
    expect(mixed.mcpServerNames).toEqual(['docs']);
    expect(mixed.mcpServerEndpoints).toBeUndefined();
    expect(mixed.compatibility?.harnesses.cursor).toBeUndefined();
    expect(mixed.compatibility?.harnesses.opencode).toBeUndefined();
  });

  it('lists a named MCP server that shows no URL or command (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', '.mcp.json']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: {
        bare: {},
        docs: { url: 'https://docs.example.com' },
        // Not an object, so not a runtime server.
        text: 'docs-mcp',
        nothing: null,
      },
    });
    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(preview.mcpServerNames).toEqual(['bare', 'docs']);
    expect(preview.mcpServerEndpoints).toEqual([
      { name: 'docs', type: 'http', url: 'https://docs.example.com' },
    ]);
  });

  it('shows only the endpoint the runtime starts from the declared definition (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      mcpServers: {
        // The runtime starts neither: a stdio or SSE type with no command.
        stdio: { type: 'stdio', url: 'https://example.test/mcp' },
        sse: { type: 'sse', url: 'https://example.test/sse' },
        // The runtime drops every argument, the scanner only the number.
        mixed: { command: 'node', args: ['serve', 7] },
        malformed: { command: 'node', args: 'serve' },
        plain: { command: 'node', args: ['serve'] },
      },
    });
    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    // Each declaration keeps its row; only the settled one shows an endpoint.
    expect(preview.mcpServerNames).toEqual([
      'malformed',
      'mixed',
      'plain',
      'sse',
      'stdio',
    ]);
    expect(preview.mcpServerEndpoints).toEqual([
      { name: 'plain', type: 'command', command: 'node', args: ['serve'] },
    ]);
  });

  it('skips front matter holding both an & and a *, whatever the YAML grammar makes of them (CAN-7545)', () => {
    const read = (source: string): Record<string, unknown> =>
      parseCatalogFrontmatterAndBody(`---\n${source}\n---\nBody`).frontmatter;
    // Either character alone cannot form an anchor with an alias.
    expect(read('name: x\ndescription: Review R&D changes')).toEqual({
      name: 'x',
      description: 'Review R&D changes',
    });
    expect(read('name: x\ndescription: Use *this* skill')).toEqual({
      name: 'x',
      description: 'Use *this* skill',
    });
    expect(read('description: &d Review\nname: x')).toEqual({
      description: 'Review',
      name: 'x',
    });
    // Plain text with both is over-skipped: it costs the file its description.
    expect(read('name: x\ndescription: Review R&D *changes*')).toEqual({});
    expect(read('description: Use a*b, c&d & e * f\nname: x')).toEqual({});
    // Anchors and aliases anywhere, including where a scanner of YAML's node
    // grammar loses its place: after a verbatim tag, and with U+FEFF in or
    // beside the names. None reaches YAML evaluation, so none stalls.
    const big = 'x'.repeat(2000);
    const refs = Array.from({ length: 3000 }, () => '*a').join(', ');
    const bomRefs = refs.replaceAll('*a', '*\uFEFFa');
    for (const source of [
      'description: Safe\na: &a [x, x]\nb: [*a, *a]',
      'description: Safe\na: &a x\nb: {k: *a}',
      'description: Safe\nl:\n- &a x\n-\t*a',
      'description: Safe\na: !!str &a x\n? *a\n: 1',
      'description: Safe\na:\n  &a x\nb:\n  *a',
      'description: Safe\na: {"k":&a x}\nb: [x,*a]',
      'description: Safe\na: !<tag:yaml.org,2002:str> &a x\nb: *a',
      `description: Safe\na: !<tag:yaml.org,2002:str> &a ${big}\n? [${refs}]\n: 1`,
      'description: Safe\na: &\uFEFFa x\nb: *\uFEFFa',
      `description: Safe\na: &\uFEFFa ${big}\n? [${bomRefs}]\n: 1`,
      'description: Safe\na: \uFEFF&a x\nb: \uFEFF*a',
    ]) {
      const started = performance.now();
      expect(read(source)).toEqual({});
      expect(performance.now() - started).toBeLessThan(500);
    }

    // Adversarial 32 KiB inputs finish at once, evaluated or skipped.
    const fill = (unit: string): string =>
      unit.repeat(Math.floor((32 * 1024 - 20) / unit.length));
    for (const source of [
      `description: ${fill('R&D *x* ')}`,
      `description: ${fill('& * ')}`,
      `description: ${fill('&*')}`,
      fill('- &a x\n'),
      fill('*a &b '),
      `description:${fill(' ')}a&*`,
    ]) {
      expect(source.length).toBeLessThanOrEqual(32 * 1024);
      const started = performance.now();
      read(source);
      expect(performance.now() - started).toBeLessThan(100);
    }
  });

  it('reads the usual config files when the manifest names them empty (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', '.mcp.json', 'skills/a/SKILL.md']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    // The installed scanner and the runtime resolver fall back to the root
    // files for an empty path, as for a missing one.
    routes[`${raw}/.claude-plugin/plugin.json`] = json({
      name: 'review',
      hooks: '',
      mcpServers: '',
      lspServers: '',
    });
    routes[`${raw}/.mcp.json`] = json({
      mcpServers: { docs: { type: 'http', url: 'https://docs.example.com' } },
    });
    const preview = previewOf(
      await handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST)('acme', 'review'),
    );
    expect(preview.mcpServerNames).toEqual(['docs']);
    expect(preview.mcpServerEndpoints).toEqual([
      { name: 'docs', type: 'http', url: 'https://docs.example.com' },
    ]);
    for (const harness of ['codex', 'cursor', 'copilot', 'opencode'] as const)
      expect(preview.compatibility?.harnesses[harness]).toEqual({
        level: 'full',
      });
  });

  it('lists many distinct language server languages in linear time (CAN-7545)', () => {
    // Publisher-supplied and read on Electron main, so it must not be quadratic.
    const count = 100_000;
    const extensionToLanguage: Record<string, string> = {};
    for (let index = 0; index < count; index += 1)
      extensionToLanguage[`.e${index}`] = `l${index}`;
    extensionToLanguage['.again'] = 'l0';
    const started = performance.now();
    const { lspServers } = buildPluginMemberInventory({
      files: new Map([
        [
          '.lsp.json',
          JSON.stringify({ big: { command: 'lsp', extensionToLanguage } }),
        ],
      ]),
      manifest: {},
    });
    const elapsed = performance.now() - started;
    const languages = lspServers[0]?.languages ?? [];
    expect(languages).toHaveLength(count);
    expect(languages.slice(0, 3)).toEqual(['l0', 'l1', 'l2']);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('lists a publisher-disabled MCP server but counts it for no harness that skips it (CAN-7545)', async () => {
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', '.mcp.json']);
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    const off = {
      type: 'http',
      url: 'https://off.example.com/mcp',
      enabled: false,
    };
    routes[`${raw}/.mcp.json`] = json({ mcpServers: { off } });
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const only = previewOf(await preview('acme', 'review'));
    expect(only.mcpServerNames).toEqual(['off']);
    expect(only.mcpServerEndpoints).toEqual([
      { name: 'off', type: 'http', url: 'https://off.example.com/mcp' },
    ]);
    for (const harness of ['codex', 'cursor', 'copilot', 'opencode'] as const)
      expect(only.compatibility?.harnesses[harness]).toEqual({
        level: 'unsupported',
        reason: 'nothing_loadable',
      });

    resetPluginManifestPreviewCache();
    routes[`${raw}/.mcp.json`] = json({
      mcpServers: { off, live: { command: 'live-mcp' } },
    });
    const mixed = previewOf(await preview('acme', 'review'));
    expect(mixed.mcpServerNames).toEqual(['live', 'off']);
    for (const harness of ['codex', 'cursor', 'copilot', 'opencode'] as const)
      expect(mixed.compatibility?.harnesses[harness]).toEqual({
        level: 'partial',
        missing: ['mcpServers'],
      });
  });

  it('says why when there is nothing to read', async () => {
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    await expect(preview('acme', 'elsewhere')).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'unsupported_source' },
    });
    await expect(preview('acme', 'gone')).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'not_found' },
    });
    await expect(preview('acme', 'missing')).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'not_found' },
    });
    await expect(preview('', 'review')).resolves.toMatchObject({
      success: false,
    });
  });

  it('honors a rate limit until its reset', async () => {
    routes['https://api.github.com/repos/acme/hooked/commits/HEAD'] =
      (): Response =>
        new Response('limited', {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 3600),
          },
        });
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    await expect(preview('acme', 'hooked')).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'rate_limited' },
    });
    const calls = fetchMock.mock.calls.length;
    await expect(preview('acme', 'review')).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'rate_limited' },
    });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('honors a secondary rate limit that leaves requests remaining (CAN-7545)', async () => {
    const lookup = 'https://api.github.com/repos/acme/hooked/commits/HEAD';
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      // A Retry-After in seconds, or as an HTTP date.
      for (const retryAfter of ['60', new Date(start + 60_000).toUTCString()]) {
        resetPluginManifestPreviewCache();
        clock.mockReturnValue(start);
        routes[lookup] = (): Response =>
          new Response('secondary', {
            status: 403,
            headers: {
              'retry-after': retryAfter,
              'x-ratelimit-remaining': '55',
            },
          });
        await expect(preview('acme', 'hooked')).resolves.toEqual({
          success: true,
          data: { ok: false, reason: 'rate_limited' },
        });
        // No other listing's read goes out until the window ends.
        const calls = fetchMock.mock.calls.length;
        clock.mockReturnValue(start + 30_000);
        await expect(preview('acme', 'review')).resolves.toEqual({
          success: true,
          data: { ok: false, reason: 'rate_limited' },
        });
        expect(fetchMock.mock.calls.length).toBe(calls);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it('honors a secondary rate limit that says so only in its message (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', 'README.md']);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    routes[
      `https://api.github.com/repos/acme/hooked/git/trees/${HEAD_SHA}?recursive=1`
    ] = tree(['README.md']);
    routes[
      `https://raw.githubusercontent.com/acme/hooked/${HEAD_SHA}/README.md`
    ] = (): Response => new Response('# Hooked');
    const refusal = (message: string): (() => Response) => {
      return (): Response =>
        new Response(JSON.stringify({ message }), {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '55',
            'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 3600),
          },
        });
    };
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    // A plain refusal, or one whose message is past the bounded read, is no
    // rate limit: the README is left out.
    for (const message of [
      'Resource not accessible by integration',
      `${'x'.repeat(8192)} secondary rate limit`,
    ]) {
      resetPluginManifestPreviewCache();
      routes[`${raw}/README.md`] = refusal(message);
      const plain = previewOf(await preview('acme', 'review'));
      expect(plain.readme).toBeUndefined();
    }

    resetPluginManifestPreviewCache();
    routes[`${raw}/README.md`] = refusal(
      'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
    );
    const limited = {
      success: true,
      data: { ok: false, reason: 'rate_limited' },
    };
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      // The failed README fails the preview rather than leaving a partial one.
      await expect(preview('acme', 'review')).resolves.toEqual(limited);
      // Another listing sends nothing until the default wait is over, which
      // the primary limit's later reset does not stretch.
      const calls = fetchMock.mock.calls.length;
      clock.mockReturnValue(start + 60_000);
      await expect(preview('acme', 'hooked')).resolves.toEqual(limited);
      await expect(preview('acme', 'review')).resolves.toEqual(limited);
      expect(fetchMock.mock.calls.length).toBe(calls);
      clock.mockReturnValue(start + 10 * 60_000 + 1);
      expect(previewOf(await preview('acme', 'hooked')).readme).toEqual({
        body: '# Hooked',
      });
      expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps a secondary rate limit whose refusal body fails after saying so (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    const treeUrl = `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`;
    const lookup = 'https://api.github.com/repos/acme/hooked/commits/HEAD';
    // A 403 with requests remaining and no Retry-After, whose body says it is
    // a secondary limit, then fails before it ends.
    const refusal = (): Response => {
      let pulls = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller): void {
            pulls += 1;
            if (pulls === 1)
              controller.enqueue(
                new TextEncoder().encode(
                  '{"message":"You have exceeded a secondary rate limit.',
                ),
              );
            else controller.error(new Error('Connection reset'));
          },
        }),
        { status: 403, headers: { 'x-ratelimit-remaining': '55' } },
      );
    };
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const limited = {
      success: true,
      data: { ok: false, reason: 'rate_limited' },
    };
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      // Every read that may be refused: the default branch, the listing, a
      // native manifest, a config, a member head and the README.
      for (const [listing, url] of [
        ['hooked', lookup],
        ['review', treeUrl],
        ['review', `${raw}/.claude-plugin/plugin.json`],
        ['review', `${raw}/hooks/hooks.json`],
        ['review', `${raw}/skills/review/SKILL.md`],
        ['review', `${raw}/README.md`],
      ] as const) {
        resetPluginManifestPreviewCache();
        clock.mockReturnValue(start);
        routes[lookup] = headCommit(HEAD_SHA);
        routes[treeUrl] = tree([
          '.claude-plugin/plugin.json',
          'hooks/hooks.json',
          'skills/review/SKILL.md',
          'README.md',
        ]);
        routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
        routes[`${raw}/hooks/hooks.json`] = json({});
        plainMembers(raw, ['skills/review/SKILL.md']);
        routes[`${raw}/README.md`] = (): Response => new Response('# Review');
        routes[url] = refusal;
        await expect(preview('acme', listing)).resolves.toEqual(limited);
        // The default wait holds: another listing sends nothing a minute on.
        const calls = fetchMock.mock.calls.length;
        clock.mockReturnValue(start + 60_000);
        await expect(
          preview('acme', listing === 'review' ? 'hooked' : 'review'),
        ).resolves.toEqual(limited);
        expect(fetchMock.mock.calls.length).toBe(calls);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it('closes the gate on a throttled answer whose deadlines have passed (CAN-7545)', async () => {
    const lookup = 'https://api.github.com/repos/acme/hooked/commits/HEAD';
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      for (const [headers, open] of [
        // An elapsed reset falls back to the failure lifetime.
        [
          {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(start / 1000) - 60),
          },
          10 * 60_000,
        ],
        // An elapsed Retry-After date, then an elapsed reset, likewise.
        [
          {
            'retry-after': new Date(start - 60_000).toUTCString(),
            'x-ratelimit-reset': String(Math.floor(start / 1000) - 60),
          },
          10 * 60_000,
        ],
        // A zero Retry-After passes to a reset still to come.
        [
          {
            'retry-after': '0',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(start / 1000) + 120),
          },
          120_000 - (start % 1000),
        ],
        // A reset within the current second still holds for a second.
        [
          {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.ceil((start + 1) / 1000)),
          },
          1000,
        ],
      ] as const) {
        resetPluginManifestPreviewCache();
        clock.mockReturnValue(start);
        routes[lookup] = (): Response =>
          new Response('limited', { status: 403, headers });
        await expect(preview('acme', 'hooked')).resolves.toEqual({
          success: true,
          data: { ok: false, reason: 'rate_limited' },
        });
        // Nothing goes out, for this listing or another, until it opens.
        const calls = fetchMock.mock.calls.length;
        clock.mockReturnValue(start + open - 1);
        await expect(preview('acme', 'review')).resolves.toEqual({
          success: true,
          data: { ok: false, reason: 'rate_limited' },
        });
        await expect(preview('acme', 'hooked')).resolves.toEqual({
          success: true,
          data: { ok: false, reason: 'rate_limited' },
        });
        expect(fetchMock.mock.calls.length).toBe(calls);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it('asks again once a rate limit is over, for the throttled listing and any other (CAN-7545)', async () => {
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', 'README.md']);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    let throttled = true;
    routes[`${raw}/README.md`] = (): Response =>
      throttled
        ? new Response('limited', {
            status: 429,
            headers: { 'retry-after': '60' },
          })
        : new Response('# Review');
    routes[
      `https://api.github.com/repos/acme/hooked/git/trees/${HEAD_SHA}?recursive=1`
    ] = tree(['README.md']);
    routes[
      `https://raw.githubusercontent.com/acme/hooked/${HEAD_SHA}/README.md`
    ] = (): Response => new Response('# Hooked');
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const limited = {
      success: true,
      data: { ok: false, reason: 'rate_limited' },
    };
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      await expect(preview('acme', 'review')).resolves.toEqual(limited);
      // Another listing opened meanwhile sends nothing and fails too.
      const calls = fetchMock.mock.calls.length;
      await expect(preview('acme', 'hooked')).resolves.toEqual(limited);
      expect(fetchMock.mock.calls.length).toBe(calls);
      // Until the reset, neither asks again.
      clock.mockReturnValue(start + 59_000);
      await expect(preview('acme', 'review')).resolves.toEqual(limited);
      await expect(preview('acme', 'hooked')).resolves.toEqual(limited);
      expect(fetchMock.mock.calls.length).toBe(calls);
      // Past it, the host has recovered and both are read again.
      throttled = false;
      clock.mockReturnValue(start + 61_000);
      expect(previewOf(await preview('acme', 'review')).readme).toEqual({
        body: '# Review',
      });
      expect(previewOf(await preview('acme', 'hooked')).readme).toEqual({
        body: '# Hooked',
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('retries a transient failure once, then forgets the failure after its lifetime', async () => {
    const timers = jest.spyOn(global, 'setTimeout');
    const clock = jest.spyOn(Date, 'now');
    const start = Date.now();
    let attempts = 0;
    routes['https://api.github.com/repos/acme/gone/commits/HEAD'] =
      (): Response => {
        attempts += 1;
        return new Response('busy', { status: 503 });
      };
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    await expect(preview('acme', 'gone')).resolves.toEqual({
      success: true,
      data: { ok: false, reason: 'unavailable' },
    });
    // One polite retry, after a short wait.
    expect(attempts).toBe(2);
    expect(timers).toHaveBeenCalledWith(expect.any(Function), 750);
    // The failure is kept briefly: a second read sends nothing.
    clock.mockReturnValue(start + 10 * 60 * 1000 - 1000);
    await preview('acme', 'gone');
    expect(attempts).toBe(2);
    // Its 10-minute lifetime ends, and the next read asks again.
    clock.mockReturnValue(start + 10 * 60 * 1000 + 1000);
    await preview('acme', 'gone');
    expect(attempts).toBe(4);
    timers.mockRestore();
    clock.mockRestore();
  });

  it('keeps no timer for a cached preview, so a reset drops its payload (CAN-7545)', async () => {
    const timers = jest.spyOn(global, 'setTimeout');
    const clock = jest.spyOn(Date, 'now');
    const start = Date.now();
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', 'README.md']);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    routes[`${raw}/README.md`] = (): Response => new Response('# Review');
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const lifetimes = [10 * 60 * 1000, 6 * 60 * 60 * 1000];
    const lifetimeTimers = (): number =>
      timers.mock.calls.filter(([, ms]) => lifetimes.includes(Number(ms)))
        .length;

    expect(previewOf(await preview('acme', 'review')).readme).toBeDefined();
    // A failed read is cached too.
    await preview('acme', 'gone');
    // Nothing is scheduled to hold the entries until their expiry.
    expect(lifetimeTimers()).toBe(0);
    resetPluginManifestPreviewCache();
    expect(lifetimeTimers()).toBe(0);

    // A complete read is kept for six hours, and refetched after.
    await preview('acme', 'review');
    const calls = fetchMock.mock.calls.length;
    clock.mockReturnValue(start + 6 * 60 * 60 * 1000 - 1000);
    await preview('acme', 'review');
    expect(fetchMock.mock.calls.length).toBe(calls);
    clock.mockReturnValue(start + 6 * 60 * 60 * 1000 + 1000);
    await preview('acme', 'review');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    expect(lifetimeTimers()).toBe(0);
    timers.mockRestore();
    clock.mockRestore();
  });

  it('drops expired previews when another is cached, without a timer (CAN-7545)', async () => {
    const timers = jest.spyOn(global, 'setTimeout');
    const clock = jest.spyOn(Date, 'now');
    const start = Date.now();
    const raw = `https://raw.githubusercontent.com/acme/review/${SHA}`;
    routes[
      `https://api.github.com/repos/acme/review/git/trees/${SHA}?recursive=1`
    ] = tree(['.claude-plugin/plugin.json', 'README.md']);
    routes[`${raw}/.claude-plugin/plugin.json`] = json({ name: 'review' });
    routes[`${raw}/README.md`] = (): Response => new Response('# Review');
    // Enough other listings to fill the cache once the expired entry is gone.
    const others = Array.from({ length: 255 }, (_, index) => `p${index}`);
    cache.marketplaces[0]?.plugins.push(
      ...others.map((name) =>
        catalogPlugin(name, `https://github.com/acme/${name}`, SHA),
      ),
    );
    const preview = handler(PLUGINS_CHANNELS.PREVIEW_MANIFEST);
    const goneLookup = 'https://api.github.com/repos/acme/gone/commits/HEAD';
    const lookups = (): number =>
      fetchMock.mock.calls.filter(([url]) => url === goneLookup).length;

    // A complete read, kept for hours, then a failure, kept for minutes.
    await preview('acme', 'review');
    await preview('acme', 'gone');
    expect(lookups()).toBe(1);
    const settled = fetchMock.mock.calls.length;

    // Past the failure's lifetime, the other listings fill the cache. The
    // expired failure, never asked for again, is dropped on the first of
    // them; were it kept, the oldest entry (the complete read) would make
    // room for the last.
    clock.mockReturnValue(start + 10 * 60 * 1000 + 1000);
    for (const name of others) await preview('acme', name);
    expect(lookups()).toBe(1);
    const filled = fetchMock.mock.calls.length;
    expect(filled - settled).toBe(others.length);
    await preview('acme', 'review');
    expect(fetchMock.mock.calls.length).toBe(filled);
    expect(
      timers.mock.calls.filter(([, ms]) => Number(ms) >= 10 * 60 * 1000),
    ).toHaveLength(0);
    timers.mockRestore();
    clock.mockRestore();
  });
});

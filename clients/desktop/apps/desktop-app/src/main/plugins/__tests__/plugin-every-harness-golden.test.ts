import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import type {
  ItemHarnessInstalls,
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/protocol/plugins';
import { forgetHarnessCopyFingerprints } from '../../lib/harness-copy-fingerprint';
import type * as StandInRuntime from '../stand-in-runtime';
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
function catalogPlugin(name: string, url: string, sha?: string): PluginInfo {
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
    externalSource: { source: 'url', url, ...(sha ? { sha } : {}) },
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
  } as PluginInfo;
}

/** The network as GitHub would answer, by URL; anything else is a 404. */
let routes: Record<string, () => Response> = {};
const fetchMock = jest.fn((url: string): Promise<Response> => {
  const route = routes[url];
  return Promise.resolve(
    route ? route() : new Response('not found', { status: 404 }),
  );
});

function tree(paths: readonly string[]): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        tree: paths.map((path) => ({ type: 'blob', path })),
        truncated: false,
      }),
      { status: 200 },
    );
}

function json(value: unknown): () => Response {
  return () => new Response(JSON.stringify(value), { status: 200 });
}

const SHA = 'a'.repeat(40);

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
    routes = {};
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
      'https://api.github.com/repos/acme/hooked/git/trees/HEAD?recursive=1'
    ] = tree([
      '.claude-plugin/plugin.json',
      '.mcp.json',
      'config/hooks.json',
      'skills/a/SKILL.md',
    ]);
    // Hooks the manifest declares outside the usual folder still count.
    routes[
      'https://raw.githubusercontent.com/acme/hooked/HEAD/.claude-plugin/plugin.json'
    ] = json({ name: 'hooked', hooks: './config/hooks.json' });
    routes['https://raw.githubusercontent.com/acme/hooked/HEAD/.mcp.json'] =
      json({ mcpServers: { github: { command: 'gh-mcp' }, broken: 'x' } });
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
    routes[
      'https://api.github.com/repos/acme/hooked/git/trees/HEAD?recursive=1'
    ] = (): Response =>
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

  it('retries a transient failure once, then forgets the failure after its lifetime', async () => {
    const timers = jest.spyOn(global, 'setTimeout');
    let attempts = 0;
    routes[
      'https://api.github.com/repos/acme/gone/git/trees/HEAD?recursive=1'
    ] = (): Response => {
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
    await preview('acme', 'gone');
    expect(attempts).toBe(2);
    // Its 10-minute lifetime ends, and the next read asks again.
    const expire = timers.mock.calls.find(
      ([, ms]) => ms === 10 * 60 * 1000,
    )?.[0];
    expect(typeof expire).toBe('function');
    if (typeof expire === 'function') expire();
    await preview('acme', 'gone');
    expect(attempts).toBe(4);
    timers.mockRestore();
  });
});

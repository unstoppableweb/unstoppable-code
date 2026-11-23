/** @jest-environment jsdom */
/**
 * A plugin's page before Add in New Customize (CAN-7545), through the real
 * `PluginEntryDetail` over the desktop bridge: with the flag on every plugin
 * not added yet opens the catalog summary, filled from the preview IPC and
 * the marketplace's scan of the listing; its members open from the checkout
 * through `readComponentContent(..., 'catalog-checkout')`. With the flag off
 * the page is today's. A preview or an open member belongs to the source it
 * was read from, and Back returns to the row that opened a member even when
 * the rows changed meanwhile.
 *
 * A jsdom suite registered in scripts/golden-suites.mjs (CAN-7545) because no
 * Electron golden opens a plugin's page before Add.
 */
import '../../../cloud-chats/__tests__/jsdom-globals';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  MarketplaceInfo,
  PluginDetails,
  PluginInfo,
} from '@canopy/protocol/plugins';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { CustomizeDiscoveryProvider } from '@canopy/ui-app/capability/CustomizeDiscoveryProvider';
import {
  PluginEntryDetail,
  type PluginEntryDetailProps,
} from '../PluginEntryDetail';
import {
  buildUnifiedPluginEntries,
  curatedCatalogFromMarketplaces,
} from '../../../lib/unifiedPluginEntries';
import { projectDesktopMarketplaceInventory } from '../../../lib/pluginInstallStatus';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const readComponentContent = jest.fn();
const previewManifest = jest.fn();
const installBuiltInPlugin = jest.fn();

/** A bridge whose other calls never settle; subscriptions unsubscribe. */
function quiet(overrides: Record<string, unknown> = {}): object {
  return new Proxy(overrides, {
    get: (target, key) =>
      typeof key === 'string' && key in target
        ? target[key]
        : typeof key === 'string' && key.startsWith('on')
          ? () => () => undefined
          : () => new Promise(() => undefined),
  });
}

function previewAnswer(preview: Record<string, unknown>): unknown {
  return {
    success: true,
    data: {
      ok: true,
      preview: {
        skills: [],
        commands: [],
        agents: [],
        hooks: false,
        mcpServers: false,
        mcpServerNames: [],
        ...preview,
      },
    },
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  readComponentContent.mockReset();
  previewManifest.mockReset();
  previewManifest.mockResolvedValue(previewAnswer({}));
  installBuiltInPlugin.mockReset();
  // An install settles, so it never holds the marketplace for the next test.
  installBuiltInPlugin.mockResolvedValue({ success: false, error: 'No.' });
  Object.assign(window, {
    mcpServers: quiet(),
    plugins: quiet({
      readComponentContent,
      previewManifest,
      installBuiltInPlugin,
    }),
    api: quiet({ accountProxy: quiet() }),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function emptyDetails(): PluginDetails {
  return {
    skills: [],
    agents: [],
    commands: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
    hasReadme: false,
  };
}

/** A plugin the marketplace lists by path, with its scan's details. */
function plugin(
  details: PluginDetails | null = null,
  overrides: Partial<PluginInfo> = {},
): PluginInfo {
  return {
    name: 'review',
    marketplaceId: 'acme',
    description: 'Reviews code',
    version: '1.0.0',
    author: 'Acme',
    category: '',
    homepage: '',
    installLocation: '',
    sourcePath: './plugins/review',
    marketplacePath: '',
    providerSupport: { claude: 'native', codex: 'none' },
    facets: details
      ? {
          claude: {
            provider: 'claude',
            mode: 'native',
            name: 'review',
            installLocation: '/tmp/acme-marketplace/plugins/review',
            sourcePath: './plugins/review',
            details,
          },
        }
      : {},
    ...(details ? { details } : {}),
    ...overrides,
  } as PluginInfo;
}

function marketplace(
  p: PluginInfo,
  overrides: Partial<MarketplaceInfo> = {},
): MarketplaceInfo {
  return {
    id: 'acme',
    name: 'Acme Market',
    sourceType: 'github',
    sourceUrl: 'https://github.com/acme/marketplace',
    installLocation: '/tmp/acme-marketplace',
    plugins: [p],
    ...overrides,
  } as unknown as MarketplaceInfo;
}

const ENTRY = {
  id: 'review',
  kind: 'plugin',
  state: 'available',
  origin: 'marketplace',
  name: 'review',
  description: 'Reviews code',
  categories: [],
  components: { skills: 0, mcpServers: 0, commands: 0, agents: 0 },
  providerSupport: { claude: true, codex: false },
  ref: {
    type: 'marketplace-plugin',
    marketplaceId: 'acme',
    pluginName: 'review',
  },
} as unknown as UnifiedPluginEntry;

function props(
  market: MarketplaceInfo,
  entry: UnifiedPluginEntry = ENTRY,
): PluginEntryDetailProps {
  return {
    entry,
    marketplaces: [market],
    mcpServers: [],
    curatedMcpServers: [],
    localCollections: [],
    sharedCollections: [],
    sharedSkills: [],
    pipelines: [],
    automationActivities: [],
    curatedAutomations: {
      selectedKey: null,
      detail: null,
      detailLoading: false,
      detailError: null,
      onSelectKey: () => undefined,
    },
    onOpenAutomation: () => undefined,
    onClose: () => undefined,
  } as unknown as PluginEntryDetailProps;
}

function page(
  market: MarketplaceInfo,
  {
    enabled = true,
    entry = ENTRY,
    preferCatalogDetail = false,
  }: {
    enabled?: boolean;
    entry?: UnifiedPluginEntry;
    preferCatalogDetail?: boolean;
  } = {},
): ReactNode {
  return (
    <CustomizeDiscoveryProvider enabled={enabled}>
      <PluginEntryDetail
        {...props(market, entry)}
        preferCatalogDetail={preferCatalogDetail}
      />
    </CustomizeDiscoveryProvider>
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

async function render(node: ReactNode): Promise<void> {
  act(() => {
    root.render(node);
  });
  await settle();
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error('Nothing to click');
  act(() => {
    element.click();
  });
  await settle();
}

function openers(): HTMLButtonElement[] {
  return Array.from(
    byTestId('plugin-detail-contents')?.querySelectorAll<HTMLButtonElement>(
      '[data-component-opener] button',
    ) ?? [],
  );
}

function rowTexts(): string[] {
  return Array.from(
    byTestId('plugin-detail-contents')?.querySelectorAll('li') ?? [],
    (row) => row.textContent ?? '',
  );
}

function worksWithRows(): string[] {
  const table = Array.from(document.body.querySelectorAll('table')).find(
    (candidate) =>
      candidate.querySelector('caption')?.textContent ===
      'Installation by harness',
  );
  return Array.from(
    table?.querySelectorAll('tbody tr') ?? [],
    (row) => row.textContent ?? '',
  );
}

const commands = (
  ...members: readonly [name: string, file: string][]
): PluginDetails => ({
  ...emptyDetails(),
  commands: members.map(([name, filePath]) => ({
    name,
    description: '',
    filePath,
  })),
});

describe('which page a plugin not added yet opens', () => {
  it('opens the catalog summary in New Customize, without the host asking', async () => {
    await render(page(marketplace(plugin())));
    expect(byTestId('plugin-catalog-detail')).not.toBeNull();
    expect(byTestId('plugin-detail-chrome')).toBeNull();
    expect(previewManifest).toHaveBeenCalledWith('acme', 'review');
  });

  it("keeps today's full page with New Customize off, and reads no preview", async () => {
    await render(page(marketplace(plugin()), { enabled: false }));
    expect(byTestId('plugin-catalog-detail')).toBeNull();
    expect(byTestId('plugin-detail-chrome')).not.toBeNull();
    expect(previewManifest).not.toHaveBeenCalled();
  });
});

describe('the catalog summary before Add', () => {
  it('shows the preview README as a tab, its images never loaded', async () => {
    previewManifest.mockResolvedValue(
      previewAnswer({
        commands: ['check'],
        readme: { body: '# Repo README ![pix](https://evil.example/p.png)' },
      }),
    );
    await render(page(marketplace(plugin())));
    expect(byTestId('plugin-detail-readme')).toBeNull();
    await click(byTestId('plugin-detail-tab-readme'));
    expect(byTestId('plugin-detail-readme')?.textContent).toContain(
      'Repo README',
    );
    expect(document.body.innerHTML).not.toContain('evil.example');
  });

  it('shows no Marketplace fact, though the plugin has a marketplace', async () => {
    await render(page(marketplace(plugin())));
    expect(byTestId('plugin-catalog-detail-layout')).not.toBeNull();
    expect(byTestId('plugin-detail-provider')).toBeNull();
    expect(byTestId('plugin-catalog-detail')?.textContent).not.toContain(
      'Acme Market',
    );
  });

  it('leaves out the count-only note in New Customize; the note shows with it off', async () => {
    // The listing counts members and names none.
    const counted = {
      ...ENTRY,
      components: { skills: 2, mcpServers: 0, commands: 1, agents: 0 },
    };
    await render(page(marketplace(plugin()), { entry: counted }));
    expect(byTestId('plugin-detail-contents')).toBeNull();
    expect(byTestId('plugin-catalog-detail-contents')?.textContent).toContain(
      'Skills',
    );
    expect(document.body.textContent).not.toContain('available after adding');

    await render(
      page(marketplace(plugin()), {
        entry: counted,
        enabled: false,
        preferCatalogDetail: true,
      }),
    );
    expect(byTestId('plugin-catalog-detail')).not.toBeNull();
    expect(document.body.textContent).toContain(
      '3 plugin components available after adding.',
    );
    expect(previewManifest).toHaveBeenCalledTimes(1);
  });

  it("opens a member's file from the marketplace checkout", async () => {
    readComponentContent.mockResolvedValue({
      success: true,
      data: { frontmatter: {}, body: 'Check the branch.' },
    });
    await render(
      page(marketplace(plugin(commands(['check', 'commands/check.md'])))),
    );
    await click(openers().find((button) => button.textContent === 'check'));
    expect(readComponentContent).toHaveBeenCalledWith(
      '/tmp/acme-marketplace',
      './plugins/review',
      'commands/check.md',
      'catalog-checkout',
    );
    expect(document.body.textContent).toContain('Check the branch.');
  });

  it('lists two files that share a name as two members, each opening its own file', async () => {
    readComponentContent.mockResolvedValue({
      success: true,
      data: { frontmatter: {}, body: 'Body.' },
    });
    previewManifest.mockResolvedValue(
      previewAnswer({
        commands: ['Build'],
        agents: ['helper'],
        descriptions: {
          'command:Build': 'Which build?',
          'agent:helper': 'Helps.',
        },
      }),
    );
    await render(
      page(
        marketplace(
          plugin({
            ...commands(
              ['Build', 'commands/build.md'],
              ['Build', 'tools/build.md'],
            ),
            agents: [{ name: 'helper', description: '', filePath: 'a/h.md' }],
          }),
        ),
      ),
    );
    const text = rowTexts();
    expect(text.filter((row) => row.startsWith('Build'))).toHaveLength(2);
    // A name two files share describes neither; a unique one is described.
    expect(text.join('\n')).not.toContain('Which build?');
    expect(text.filter((row) => row.startsWith('helper'))).toEqual([
      expect.stringContaining('Helps.'),
    ]);
    const builds = (): HTMLButtonElement[] =>
      openers().filter((button) => button.textContent === 'Build');
    expect(builds()).toHaveLength(2);
    await click(builds()[0]);
    await click(byTestId('plugin-catalog-detail-component-back'));
    await click(builds()[1]);
    expect(
      readComponentContent.mock.calls.map((call: unknown[]) => call[2]).sort(),
    ).toEqual(['commands/build.md', 'tools/build.md']);
  });

  it("keeps a listing's MCP server names private in session replay", async () => {
    await render(
      page(marketplace(plugin()), {
        entry: {
          ...ENTRY,
          bundledServers: [{ key: 'secret-mcp', name: 'secret-mcp' }],
        },
      }),
    );
    const name = Array.from(
      byTestId('plugin-detail-contents')?.querySelectorAll('span') ?? [],
    )
      .filter((node) => node.textContent === 'secret-mcp')
      .at(-1);
    expect(name).toBeDefined();
    expect(name?.closest(`.${REPLAY_BLOCK_CLASS}`)).not.toBeNull();
  });
});

describe('a member open while the rows change', () => {
  it('returns Back to the member that opened, after an earlier row was added', async () => {
    readComponentContent.mockResolvedValue({
      success: true,
      data: { frontmatter: {}, body: 'Board body.' },
    });
    await render(
      page(
        marketplace(
          plugin(
            commands(['Build', 'commands/build.md'], ['Board', 'c/board.md']),
          ),
        ),
      ),
    );
    await click(openers().find((button) => button.textContent === 'Board'));
    expect(document.body.textContent).toContain('Board body.');
    // A refresh lists another member that sorts first.
    await render(
      page(
        marketplace(
          plugin(
            commands(
              ['Alpha', 'c/alpha.md'],
              ['Build', 'commands/build.md'],
              ['Board', 'c/board.md'],
            ),
          ),
        ),
      ),
    );
    expect(document.body.textContent).toContain('Board body.');
    await click(byTestId('plugin-catalog-detail-component-back'));
    expect(document.activeElement?.textContent).toBe('Board');
  });

  it('focuses the Contents list when the member that opened is gone', async () => {
    readComponentContent.mockResolvedValue({
      success: true,
      data: { frontmatter: {}, body: 'Board body.' },
    });
    await render(
      page(
        marketplace(
          plugin(
            commands(['Build', 'commands/build.md'], ['Board', 'c/board.md']),
          ),
        ),
      ),
    );
    await click(openers().find((button) => button.textContent === 'Board'));
    await render(
      page(marketplace(plugin(commands(['Build', 'commands/build.md'])))),
    );
    await click(byTestId('plugin-catalog-detail-component-back'));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Contents');
  });
});

describe("a plugin's source changing under the same page", () => {
  it('drops a preview read for the old source, even when it settles last', async () => {
    let settleOld: (value: unknown) => void = () => undefined;
    previewManifest
      .mockReturnValueOnce(
        new Promise((resolve) => {
          settleOld = resolve;
        }),
      )
      .mockResolvedValueOnce(
        previewAnswer({ readme: { body: '# New source README' } }),
      );
    const first = plugin();
    await render(page(marketplace(first)));
    // The marketplace now lists the plugin from another repository.
    await render(
      page(
        marketplace(first, {
          sourceUrl: 'https://github.com/other/marketplace',
        }),
      ),
    );
    act(() => {
      settleOld(previewAnswer({ readme: { body: '# Old source README' } }));
    });
    await settle();
    expect(previewManifest).toHaveBeenCalledTimes(2);
    // With no members named, the README is the page's only Contents.
    const readme = byTestId('plugin-detail-readme')?.textContent ?? '';
    expect(readme).toContain('New source README');
    expect(readme).not.toContain('Old source README');
  });

  it('closes a member opened from the old checkout', async () => {
    readComponentContent.mockResolvedValue({
      success: true,
      data: { frontmatter: {}, body: 'Old checkout body.' },
    });
    const details = commands(['check', 'commands/check.md']);
    await render(page(marketplace(plugin(details))));
    await click(openers().find((button) => button.textContent === 'check'));
    expect(document.body.textContent).toContain('Old checkout body.');
    await render(
      page(
        marketplace(plugin(details), {
          installLocation: '/tmp/moved-checkout',
        }),
      ),
    );
    expect(byTestId('plugin-catalog-detail-component-back')).toBeNull();
    expect(document.body.textContent).not.toContain('Old checkout body.');
    expect(byTestId('plugin-detail-contents')).not.toBeNull();
    expect(readComponentContent).toHaveBeenCalledTimes(1);
  });

  it("focuses the Contents list, not the new source's row with the same key", async () => {
    readComponentContent.mockResolvedValue({
      success: true,
      data: { frontmatter: {}, body: 'Board body.' },
    });
    const details = commands(
      ['Build', 'commands/build.md'],
      ['Board', 'c/board.md'],
    );
    await render(page(marketplace(plugin(details))));
    await click(openers().find((button) => button.textContent === 'Board'));
    expect(document.body.textContent).toContain('Board body.');
    // The same members, read from another checkout.
    await render(
      page(
        marketplace(plugin(details), {
          installLocation: '/tmp/moved-checkout',
        }),
      ),
    );
    expect(document.body.textContent).not.toContain('Board body.');
    expect(document.activeElement?.textContent).not.toBe('Board');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Contents');
  });
});

describe("the catalog summary's publisher", () => {
  it("keeps a listing author's name private in session replay", async () => {
    await render(
      page(marketplace(plugin()), {
        entry: { ...ENTRY, authorName: 'Jane Doe' },
      }),
    );
    const publisher = byTestId('plugin-catalog-detail-layout-publisher');
    expect(publisher?.textContent).toBe('Jane Doe');
    expect(publisher?.closest(`.${REPLAY_BLOCK_CLASS}`)).not.toBeNull();
    // The title and the header's controls stay recorded.
    expect(
      byTestId('plugin-catalog-detail-layout-title')?.closest(
        `.${REPLAY_BLOCK_CLASS}`,
      ),
    ).toBeNull();
  });
});

/**
 * A plugin listed for Claude and Codex, each version scanned from its own
 * checkout: Claude's under `/tmp/claude-checkout`, Codex's under
 * `/tmp/codex-checkout` at another path.
 */
function twoVersions(
  claude: PluginDetails,
  codex: PluginDetails,
  codexCheckout = '/tmp/codex-checkout',
): MarketplaceInfo {
  const versioned = plugin(claude, {
    providerSupport: { claude: 'native', codex: 'native' },
    facets: {
      claude: {
        provider: 'claude',
        mode: 'native',
        name: 'review',
        installLocation: '/tmp/claude-checkout/plugins/review',
        sourcePath: './plugins/review',
        details: claude,
      },
      codex: {
        provider: 'codex',
        mode: 'native',
        name: 'review',
        installLocation: `${codexCheckout}/codex/review`,
        sourcePath: './codex/review',
        details: codex,
      },
    },
  });
  const status = (provider: string, installLocation: string): object => ({
    provider,
    state: 'valid',
    accepted: true,
    pluginCount: 1,
    lastCheckedAt: '',
    installLocation,
  });
  return marketplace(versioned, {
    providerStatus: {
      claude: status('claude', '/tmp/claude-checkout'),
      codex: status('codex', codexCheckout),
    },
  } as unknown as Partial<MarketplaceInfo>);
}

describe("a plugin's Claude and Codex versions before Add", () => {
  const body = {
    success: true,
    data: { frontmatter: {}, body: 'Body.' },
  };

  it('lists what only the Codex version has: its command, app and MCP server', async () => {
    await render(
      page(
        twoVersions(commands(['check', 'commands/check.md']), {
          ...commands(['deploy', 'commands/deploy.md']),
          apps: [{ name: 'Board', description: '', filePath: 'apps/board.md' }],
          mcpServers: [
            { name: 'tracker', type: 'http', url: 'https://t.example/mcp' },
          ],
        }),
      ),
    );
    const text = rowTexts().join('\n');
    expect(text).toContain('check');
    expect(text).toContain('deploy');
    expect(text).toContain('Board');
    expect(text).toContain('tracker');
    expect(text).toContain('https://t.example/mcp');
  });

  it("opens a Codex-only member from the Codex version's checkout, and Claude's from Claude's", async () => {
    readComponentContent.mockResolvedValue(body);
    await render(
      page(
        twoVersions(
          commands(['check', 'commands/check.md']),
          commands(['deploy', 'commands/deploy.md']),
        ),
      ),
    );
    await click(openers().find((button) => button.textContent === 'deploy'));
    expect(readComponentContent).toHaveBeenLastCalledWith(
      '/tmp/codex-checkout',
      './codex/review',
      'commands/deploy.md',
      'catalog-checkout',
    );
    await click(byTestId('plugin-catalog-detail-component-back'));
    await click(openers().find((button) => button.textContent === 'check'));
    expect(readComponentContent).toHaveBeenLastCalledWith(
      '/tmp/claude-checkout',
      './plugins/review',
      'commands/check.md',
      'catalog-checkout',
    );
  });

  it("lists a member both versions have once, opening Claude's file", async () => {
    readComponentContent.mockResolvedValue(body);
    await render(
      page(
        twoVersions(
          commands(['check', 'commands/check.md']),
          commands(['check', 'commands/check.md']),
        ),
      ),
    );
    expect(rowTexts().filter((row) => row.startsWith('check'))).toHaveLength(1);
    await click(openers().find((button) => button.textContent === 'check'));
    expect(readComponentContent).toHaveBeenCalledTimes(1);
    expect(readComponentContent).toHaveBeenCalledWith(
      '/tmp/claude-checkout',
      './plugins/review',
      'commands/check.md',
      'catalog-checkout',
    );
  });

  it('keeps a name each version lists at another file as two rows', async () => {
    await render(
      page(
        twoVersions(
          commands(['check', 'commands/check.md']),
          commands(['check', 'prompts/check.md']),
        ),
      ),
    );
    expect(rowTexts().filter((row) => row.startsWith('check'))).toHaveLength(2);
  });

  it("opens a Codex-only plugin's member from the Codex checkout", async () => {
    readComponentContent.mockResolvedValue(body);
    const details = commands(['deploy', 'commands/deploy.md']);
    const codexOnly = plugin(null, {
      providerSupport: { claude: 'none', codex: 'native' },
      facets: {
        codex: {
          provider: 'codex',
          mode: 'native',
          name: 'review',
          installLocation: '/tmp/codex-checkout/codex/review',
          sourcePath: './codex/review',
          details,
        },
      },
      details,
    });
    await render(
      page(
        marketplace(codexOnly, {
          providerStatus: {
            codex: {
              provider: 'codex',
              state: 'valid',
              accepted: true,
              pluginCount: 1,
              lastCheckedAt: '',
              installLocation: '/tmp/codex-checkout',
            },
          },
        } as unknown as Partial<MarketplaceInfo>),
      ),
    );
    expect(rowTexts()).toEqual([expect.stringContaining('deploy')]);
    await click(openers().find((button) => button.textContent === 'deploy'));
    expect(readComponentContent).toHaveBeenCalledWith(
      '/tmp/codex-checkout',
      './codex/review',
      'commands/deploy.md',
      'catalog-checkout',
    );
  });

  it("closes a Codex member when the Codex version's checkout moves", async () => {
    readComponentContent.mockResolvedValue({
      success: true,
      data: { frontmatter: {}, body: 'Codex body.' },
    });
    const claude = commands(['check', 'commands/check.md']);
    const codex = commands(['deploy', 'commands/deploy.md']);
    await render(page(twoVersions(claude, codex)));
    await click(openers().find((button) => button.textContent === 'deploy'));
    expect(document.body.textContent).toContain('Codex body.');
    await render(page(twoVersions(claude, codex, '/tmp/moved-codex')));
    expect(byTestId('plugin-catalog-detail-component-back')).toBeNull();
    expect(document.body.textContent).not.toContain('Codex body.');
    expect(readComponentContent).toHaveBeenCalledTimes(1);
  });
});

/** A curated plugin for Claude and Codex, with each copy's install status. */
function curatedMarketplace(installed: {
  readonly claude: boolean;
  readonly codex: boolean;
}): MarketplaceInfo {
  const details = commands(['check', 'commands/check.md']);
  const version = (provider: 'claude' | 'codex'): object => ({
    provider,
    mode: 'native',
    name: 'review',
    installLocation: `/tmp/curated/${provider}/review`,
    sourcePath: './review',
    details,
  });
  return marketplace(
    plugin(details, {
      marketplaceId: 'curated/cloud',
      curated: true,
      providerSupport: { claude: 'native', codex: 'native' },
      facets: { claude: version('claude'), codex: version('codex') },
      globalInstallStatus: {
        claude: { available: true, installed: installed.claude },
        codex: { available: true, installed: installed.codex },
      },
    } as unknown as Partial<PluginInfo>),
    { id: 'curated/cloud', curated: true, sourceType: 'curated' },
  );
}

/** The plugin's entry as the Customize page derives it from its inventory. */
function derivedEntry(market: MarketplaceInfo): UnifiedPluginEntry {
  const entry = buildUnifiedPluginEntries({
    retainProviderListings: true,
    curatedPlugins: curatedCatalogFromMarketplaces([market]),
    marketplaces: projectDesktopMarketplaceInventory(
      [market],
      { kind: 'loading' },
      ['claude', 'codex'],
    ),
    installedSkills: [],
    mcpServers: [],
    mcpStatuses: [],
    curatedMcpServers: [],
    providerConnectors: [],
  }).find((candidate) => candidate.kind === 'plugin');
  if (!entry) throw new Error('No plugin entry');
  return entry;
}

describe('a curated plugin and the catalog summary', () => {
  it('opens a partly installed curated plugin on its full page, not the summary', async () => {
    const market = curatedMarketplace({ claude: true, codex: false });
    const entry = derivedEntry(market);
    expect(entry.state).toBe('installed');
    await render(page(market, { entry }));
    expect(byTestId('plugin-catalog-detail')).toBeNull();
    expect(byTestId('plugin-detail-chrome')).not.toBeNull();
    expect(previewManifest).not.toHaveBeenCalled();
    // The copy not installed yet keeps its own Add.
    const installCodex = Array.from(
      document.body.querySelectorAll('button'),
    ).find((button) =>
      (button.getAttribute('aria-label') ?? button.textContent ?? '').includes(
        'Install to Codex',
      ),
    );
    expect(installCodex).toBeDefined();
    await click(installCodex);
    expect(installBuiltInPlugin).toHaveBeenCalledWith({
      marketplaceId: 'curated/cloud',
      pluginName: 'review',
      providers: ['codex'],
    });
  });

  it('opens the summary of a curated plugin on disk that no harness has added, derived as the page derives it', async () => {
    const market = curatedMarketplace({ claude: false, codex: false });
    // Its content is on disk, so the projection reports it installed.
    const entry = derivedEntry(market);
    expect(entry.state).toBe('installed');
    await render(page(market, { entry }));
    expect(byTestId('plugin-catalog-detail')).not.toBeNull();
    expect(byTestId('plugin-detail-chrome')).toBeNull();
    expect(previewManifest).toHaveBeenCalledWith('curated/cloud', 'review');

    // Its members open from the checkout, as for any plugin not added.
    readComponentContent.mockResolvedValue({
      success: true,
      data: { frontmatter: {}, body: 'Check body.' },
    });
    await click(openers()[0]);
    expect(document.body.textContent).toContain('Check body.');
    expect(installBuiltInPlugin).not.toHaveBeenCalled();
  });

  it('reads a curated plugin on disk that no harness has added as not added in Works with', async () => {
    const market = curatedMarketplace({ claude: false, codex: false });
    const entry = derivedEntry(market);
    expect(entry.state).toBe('installed');
    await render(page(market, { entry }));
    expect(byTestId('plugin-catalog-detail')).not.toBeNull();
    // The projection calls it installed; Works with does not: the harnesses
    // it reaches are Not installed, and the rest compatibility cannot verify
    // are unknown rather than unsupported.
    expect(worksWithRows()).toEqual([
      'ClaudeNot installed',
      'CodexNot installed',
      'CursorUnknown until added',
      'CopilotUnknown until added',
      'OpenCodeUnknown until added',
    ]);
    expect(
      worksWithRows().some((row) => /Installed|Not supported/.test(row)),
    ).toBe(false);
  });

  it("adds every harness's copy from the summary's own Add", async () => {
    const market = curatedMarketplace({ claude: false, codex: false });
    await render(
      page(market, {
        entry: {
          ...ENTRY,
          id: 'curated:review',
          origin: 'curated',
          providerSupport: { claude: true, codex: true },
          ref: { type: 'curated-plugin', key: 'review' },
        } as unknown as UnifiedPluginEntry,
      }),
    );
    expect(byTestId('plugin-catalog-detail')).not.toBeNull();
    expect(rowTexts()).toEqual([expect.stringContaining('check')]);
    await click(byTestId('plugin-catalog-detail-add'));
    expect(installBuiltInPlugin).toHaveBeenCalledTimes(1);
    expect(installBuiltInPlugin).toHaveBeenCalledWith({
      marketplaceId: 'curated/cloud',
      pluginName: 'review',
      providers: ['claude', 'codex'],
    });
  });

  it('keeps a failed Add on the summary the user returns to, until the next attempt replaces it', async () => {
    const market = curatedMarketplace({ claude: false, codex: false });
    const entry = derivedEntry(market);
    // Main reports a failed install as `{ success: false, error }`.
    installBuiltInPlugin.mockResolvedValue({
      success: false,
      error: 'Disk is full.',
    });
    await render(page(market, { entry }));
    expect(byTestId('built-in-install-message')).toBeNull();
    await click(byTestId('plugin-catalog-detail-add'));
    expect(installBuiltInPlugin).toHaveBeenCalledTimes(1);

    // Add opens the full page; Back returns to the summary, which says why.
    await click(byTestId('plugin-detail-back'));
    expect(byTestId('plugin-catalog-detail')).not.toBeNull();
    expect(byTestId('built-in-install-message')?.textContent).toBe(
      'Could not install plugin: Disk is full.',
    );

    // An opened member and Back keep it.
    readComponentContent.mockResolvedValue({
      success: true,
      data: { frontmatter: {}, body: 'Check body.' },
    });
    await click(openers()[0]);
    expect(document.body.textContent).toContain('Check body.');
    await click(byTestId('plugin-catalog-detail-component-back'));
    expect(byTestId('plugin-catalog-detail')).not.toBeNull();
    expect(byTestId('built-in-install-message')?.textContent).toBe(
      'Could not install plugin: Disk is full.',
    );

    // A new attempt replaces it, and a successful one clears it.
    installBuiltInPlugin.mockResolvedValue({
      success: false,
      error: 'Still no.',
    });
    await click(byTestId('plugin-catalog-detail-add'));
    await click(byTestId('plugin-detail-back'));
    expect(byTestId('built-in-install-message')?.textContent).toBe(
      'Could not install plugin: Still no.',
    );
    installBuiltInPlugin.mockResolvedValue({
      success: true,
      data: {
        plugin: {
          ...market.plugins[0],
          globalInstallStatus: {
            claude: { available: true, installed: true },
            codex: { available: true, installed: true },
          },
        },
        providerOutcomes: {
          claude: { installed: true },
          codex: { installed: true },
        },
      },
    });
    await click(byTestId('plugin-catalog-detail-add'));
    expect(document.body.textContent).not.toContain('Could not install plugin');
    expect(document.body.textContent).not.toContain('Still no.');
  });
});

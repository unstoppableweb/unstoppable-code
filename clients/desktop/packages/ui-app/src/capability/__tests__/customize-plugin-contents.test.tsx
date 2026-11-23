/** @jest-environment jsdom */
/**
 * A plugin's page in New Customize (CAN-7545). An added plugin lists its
 * Contents as rows and, with a README, shows both as tabs whose README is
 * read the first time its tab opens. A plugin not added yet opens the catalog
 * summary, filled the way the desktop host fills it: the light preview's wire
 * answer through the protocol parser and `CustomizeManifestPreview`, then
 * `customizeCatalogContents` with the marketplace's scan of the listing.
 * Which page opens, and the desktop host's reads, are covered through the real
 * `PluginEntryDetail` in the desktop suite registered beside this one.
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  parsePluginManifestPreviewResult,
  type PluginDetails,
  type PluginManifestPreviewResult,
} from '@canopy/protocol/plugins';
import {
  PluginDetailContent,
  type PluginDetailContentPlugin,
  type PluginDetailFacetSlot,
  type PluginDetailReadComponent,
} from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { PluginCatalogDetail } from '../PluginCatalogDetail';
import {
  PluginDetailHost,
  type PluginDetailMcpConnection,
} from '../PluginDetailHost';
import { customizeCatalogContents } from '../customizeCatalogContents';
import { CustomizeDiscoveryProvider } from '../CustomizeDiscoveryProvider';
import { CustomizeManifestPreview } from '../CustomizeManifestPreview';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactNode): void {
  act(() => root.render(node));
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function click(element: Element | null | undefined): void {
  if (!(element instanceof HTMLElement)) throw new Error('Nothing to click');
  act(() => element.click());
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function rowTexts(): string[] {
  return Array.from(
    byTestId('plugin-detail-contents')?.querySelectorAll('li') ?? [],
    (row) => row.textContent ?? '',
  );
}

/**
 * Whether the text `name` shows is private in session replay, and no button
 * is: the innermost element showing exactly that text, inside a block.
 */
function namePrivate(root: Element | null, name: string): boolean {
  const shown = Array.from(root?.querySelectorAll('span') ?? []).filter(
    (node) => node.textContent === name,
  );
  const innermost = shown.at(-1);
  const blocked = `.${REPLAY_BLOCK_CLASS}`;
  return (
    Boolean(innermost?.closest(blocked)) &&
    shown.every((node) => !node.closest('button')?.closest(blocked))
  );
}

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

// ---------------------------------------------------------------------------
// An added plugin
// ---------------------------------------------------------------------------

const ADDED: PluginDetailContentPlugin = {
  name: 'review',
  marketplaceId: 'acme',
  providerSupport: { claude: 'native', codex: 'none' },
  details: {
    ...emptyDetails(),
    hasReadme: true,
    skills: [
      { name: 'summarize', description: 'Sums a diff up.', path: 'skills/sum' },
    ],
    commands: [
      { name: 'check', description: 'Checks it.', filePath: 'commands/c.md' },
    ],
    hooks: [{ event: 'PostToolUse', matcher: 'Edit', hookType: 'command' }],
    mcpServers: [
      { name: 'docs', type: 'http', url: 'https://docs.example.com/mcp' },
      { name: 'github', type: 'command', command: 'gh-mcp', args: ['serve'] },
    ],
  },
};

function addedPage(
  enabled: boolean,
  read: PluginDetailReadComponent,
): JSX.Element {
  return (
    <CustomizeDiscoveryProvider enabled={enabled}>
      <PluginDetailContent
        plugin={ADDED}
        onReadComponent={read}
        mcpServerVia={[
          {
            harness: 'codex',
            via: { name: 'Review for Codex', source: 'OpenAI' },
            installed: true,
          },
        ]}
      />
    </CustomizeDiscoveryProvider>
  );
}

describe('an added plugin page (CAN-7545)', () => {
  it('shows Contents and README as two tabs and reads the README once, on first open', async () => {
    const reads: string[] = [];
    const read: PluginDetailReadComponent = (type, file) => {
      reads.push(`${type}:${file}`);
      return Promise.resolve({ frontmatter: {}, body: '# Hello from README' });
    };
    render(addedPage(true, read));
    expect(byTestId('plugin-detail-tabs')?.getAttribute('role')).toBe(
      'tablist',
    );
    expect(byTestId('plugin-detail-contents')).not.toBeNull();
    expect(byTestId('plugin-detail-readme')).toBeNull();
    expect(reads).toEqual([]);

    click(byTestId('plugin-detail-tab-readme'));
    await settle();
    expect(reads).toEqual(['readme:README.md']);
    expect(byTestId('plugin-detail-readme')?.textContent).toContain(
      'Hello from README',
    );
    // Back and forth: the README stays mounted and is not read again.
    click(byTestId('plugin-detail-tab-contents'));
    click(byTestId('plugin-detail-tab-readme'));
    await settle();
    expect(reads).toEqual(['readme:README.md']);
  });

  it('lists Contents as rows: kinds in order, openers, endpoints and the other copy', () => {
    render(addedPage(true, () => Promise.resolve(null)));
    const list = byTestId('plugin-detail-contents');
    expect(list?.querySelector('table')).toBeNull();
    const text = rowTexts();
    expect(text.map((line) => line.slice(0, 12))).toEqual([
      expect.stringContaining('summarize'),
      expect.stringContaining('check'),
      expect.stringContaining('docs'),
      expect.stringContaining('github'),
      expect.stringContaining('Another copy'),
      expect.stringContaining('PostToolUse'),
    ]);
    expect(text[0]).toContain('Sums a diff up.');
    // A command opens from its name.
    const command = Array.from(
      list?.querySelectorAll('[data-component-opener] button') ?? [],
    ).find((opener) => opener.textContent === 'check');
    expect(command).toBeDefined();
    // Each MCP server keeps its member row, showing what it runs; the
    // endpoint is private in session replay.
    const github = Array.from(list?.querySelectorAll('li') ?? []).find((row) =>
      row.textContent?.startsWith('github'),
    );
    expect(github?.textContent).toContain('gh-mcp serve');
    expect(namePrivate(github ?? null, 'gh-mcp serve')).toBe(true);
    expect(byTestId('plugin-detail-mcp-via-codex')?.textContent).toContain(
      'Installed',
    );
  });

  it('is unchanged with New Customize off: one README section and the tables', () => {
    render(addedPage(false, () => Promise.resolve(null)));
    expect(byTestId('plugin-detail-tabs')).toBeNull();
    expect(byTestId('plugin-detail-contents')).toBeNull();
    expect(byTestId('plugin-detail-readme')).not.toBeNull();
    expect(
      container.querySelector('tr[data-mcp-member="docs"]'),
    ).not.toBeNull();
  });
});

function addedWith(details: PluginDetails): JSX.Element {
  return (
    <CustomizeDiscoveryProvider enabled>
      <PluginDetailContent
        plugin={{ ...ADDED, details }}
        onReadComponent={() =>
          Promise.resolve({ frontmatter: {}, body: 'Opened body.' })
        }
      />
    </CustomizeDiscoveryProvider>
  );
}

function commandsDetails(...names: readonly string[]): PluginDetails {
  return {
    ...emptyDetails(),
    hasReadme: true,
    commands: names.map((name) => ({
      name,
      description: '',
      filePath: `commands/${name}.md`,
    })),
  };
}

function opener(name: string): HTMLButtonElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      '[data-component-opener] button',
    ),
  ).find((button) => button.textContent === name);
}

describe('the members of an added plugin (CAN-7545)', () => {
  it('focuses the member that opened, after the rows changed while it was open', async () => {
    render(addedWith(commandsDetails('Build', 'Board')));
    // Opened from the keyboard: the name has focus.
    act(() => opener('Board')?.focus());
    click(opener('Board'));
    await settle();
    expect(container.textContent).toContain('Opened body.');
    // A refresh lists another member that sorts first.
    render(addedWith(commandsDetails('Alpha', 'Build', 'Board')));
    click(byTestId('plugin-detail-back'));
    expect(document.activeElement?.textContent).toBe('Board');
  });

  it('focuses the Contents tab when the member that opened is gone', async () => {
    render(addedWith(commandsDetails('Build', 'Board')));
    // Opened from the keyboard: the name has focus.
    act(() => opener('Board')?.focus());
    click(opener('Board'));
    await settle();
    render(addedWith(commandsDetails('Build')));
    click(byTestId('plugin-detail-back'));
    expect(document.activeElement).toBe(byTestId('plugin-detail-tab-contents'));
  });

  it('lists two command files that share a name as two members, each opening its own file', async () => {
    const reads: string[] = [];
    const details: PluginDetails = {
      ...emptyDetails(),
      commands: [
        { name: 'Build', description: '', filePath: 'commands/build.md' },
        { name: 'Build', description: '', filePath: 'tools/build.md' },
      ],
    };
    render(
      <CustomizeDiscoveryProvider enabled>
        <PluginDetailContent
          plugin={{
            ...ADDED,
            details,
            facets: {
              claude: {
                provider: 'claude',
                mode: 'native',
                name: 'review',
                installLocation: '/plugins/review',
                sourcePath: './review',
                details,
              },
            },
          }}
          onReadComponent={(type, file) => {
            reads.push(`${type}:${file}`);
            return Promise.resolve({ frontmatter: {}, body: 'Body.' });
          }}
        />
      </CustomizeDiscoveryProvider>,
    );
    const builds = (): HTMLButtonElement[] =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-component-opener] button',
        ),
      ).filter((button) => button.textContent === 'Build');
    expect(builds()).toHaveLength(2);
    click(builds()[0]);
    await settle();
    click(byTestId('plugin-detail-back'));
    click(builds()[1]);
    await settle();
    expect(reads.sort()).toEqual([
      'command:commands/build.md',
      'command:tools/build.md',
    ]);
  });

  it("keeps the names read from the plugin's files private in session replay", async () => {
    render(addedPage(true, () => Promise.resolve(null)));
    const list = byTestId('plugin-detail-contents');
    for (const name of [
      'summarize',
      'check',
      'docs',
      'github',
      'PostToolUse',
    ]) {
      expect(namePrivate(list, name)).toBe(true);
    }
    click(opener('check'));
    await settle();
    expect(
      container
        .querySelector('#plugin-detail-title')
        ?.classList.contains(REPLAY_BLOCK_CLASS),
    ).toBe(true);
  });
});

/** A Claude version and a native Codex version, each with its own members. */
function twoVersions(
  claude: Partial<PluginDetails>,
  codex: Partial<PluginDetails>,
): PluginDetailContentPlugin {
  const facet = (
    provider: 'claude' | 'codex',
    details: Partial<PluginDetails>,
  ): NonNullable<
    NonNullable<PluginDetailContentPlugin['facets']>['claude']
  > => ({
    provider,
    mode: 'native',
    name: 'review',
    installLocation: `/plugins/${provider}/review`,
    sourcePath: './review',
    details: { ...emptyDetails(), hasReadme: true, ...details },
  });
  return {
    ...ADDED,
    providerSupport: { claude: 'native', codex: 'native' },
    details: { ...emptyDetails(), hasReadme: true, ...claude },
    facets: { claude: facet('claude', claude), codex: facet('codex', codex) },
  };
}

function versionsPage(
  plugin: PluginDetailContentPlugin,
  reads: string[] = [],
): JSX.Element {
  return (
    <CustomizeDiscoveryProvider enabled>
      <PluginDetailContent
        plugin={plugin}
        onReadComponent={(type, file, facet) => {
          reads.push(`${facet?.kind ?? ''}:${type}:${file}`);
          return Promise.resolve({ frontmatter: {}, body: 'Body.' });
        }}
      />
    </CustomizeDiscoveryProvider>
  );
}

describe('the hooks of an added plugin that differ only in async (CAN-7591)', () => {
  const hook = {
    event: 'PostToolUse',
    matcher: 'Edit',
    hookType: 'command',
    command: 'lint',
  };
  // Claude lists the sync hook and its async twin; Codex lists the same two,
  // the sync one with async spelled out as false.
  const plugin = twoVersions(
    { hooks: [hook, { ...hook, async: true }] },
    {
      hooks: [
        { ...hook, async: false },
        { ...hook, async: true },
      ],
    },
  );

  function renderHooks(enabled: boolean): void {
    render(
      <CustomizeDiscoveryProvider enabled={enabled}>
        <PluginDetailContent
          plugin={plugin}
          onReadComponent={() => Promise.resolve(null)}
        />
      </CustomizeDiscoveryProvider>,
    );
  }

  it('lists the sync hook and the async hook as two rows, the async one described as such', () => {
    renderHooks(true);
    expect(rowTexts()).toEqual([
      expect.stringMatching(/^PostToolUse.*Edit · command$/),
      expect.stringMatching(/^PostToolUse.*Edit · command · async$/),
    ]);
  });

  it('is unchanged with New Customize off: the Hooks table merges them, with no async text', () => {
    renderHooks(false);
    expect(container.textContent).not.toContain('async');
    expect(byTestId('plugin-detail-contents')).toBeNull();
    expect(container.querySelectorAll('table tbody tr')).toHaveLength(1);
  });
});

const cmd = (
  name: string,
  filePath: string,
): { name: string; description: string; filePath: string } => ({
  name,
  description: '',
  filePath,
});

/** Each Contents row: the file its opener reads and the harnesses it names. */
async function openedRows(
  reads: string[],
): Promise<{ file: string; harnesses: string[] }[]> {
  const rows = (): HTMLLIElement[] =>
    Array.from(
      byTestId('plugin-detail-contents')?.querySelectorAll('li') ?? [],
    );
  const found: { file: string; harnesses: string[] }[] = [];
  for (let index = 0; index < rows().length; index += 1) {
    const row = rows()[index];
    const harnesses = Array.from(
      row?.querySelectorAll('[role="img"][aria-label]') ?? [],
      (logo) => logo.getAttribute('aria-label') ?? '',
    );
    reads.length = 0;
    click(row?.querySelector('[data-component-opener] button'));
    await settle();
    found.push({ file: reads[0] ?? '', harnesses });
    click(byTestId('plugin-detail-back'));
  }
  return found;
}

function openerIds(): string[] {
  return Array.from(
    container.querySelectorAll('[data-component-opener]'),
    (opener) => opener.getAttribute('data-component-opener') ?? '',
  );
}

describe("an added plugin's members across its versions (CAN-7545)", () => {
  it('keeps two Claude files named Build apart, the Codex badge only on the file Codex has', async () => {
    const reads: string[] = [];
    render(
      versionsPage(
        twoVersions(
          {
            commands: [
              cmd('Build', 'commands/a.md'),
              cmd('Build', 'commands/b.md'),
            ],
          },
          { commands: [cmd('Build', 'commands/b.md')] },
        ),
        reads,
      ),
    );
    const rows = await openedRows(reads);
    expect(rows.map(({ file }) => file).sort()).toEqual([
      'claude:command:commands/a.md',
      'claude:command:commands/b.md',
    ]);
    const codex = (file: string): boolean =>
      rows
        .find((row) => row.file === `claude:command:${file}`)
        ?.harnesses.some((name) => /codex/i.test(name)) ?? false;
    expect(codex('commands/a.md')).toBe(false);
    expect(codex('commands/b.md')).toBe(true);
    expect(new Set(openerIds()).size).toBe(openerIds().length);
  });

  it("gives each version's file its own row when only one version repeats the name", async () => {
    const reads: string[] = [];
    render(
      versionsPage(
        twoVersions(
          { commands: [cmd('Build', 'commands/a.md')] },
          {
            commands: [
              cmd('Build', 'commands/c.md'),
              cmd('Build', 'commands/d.md'),
            ],
          },
        ),
        reads,
      ),
    );
    const rows = await openedRows(reads);
    expect(rows.map(({ file }) => file).sort()).toEqual([
      'claude:command:commands/a.md',
      'codex:command:commands/c.md',
      'codex:command:commands/d.md',
    ]);
    // Each row names only the version that has its file.
    for (const row of rows)
      expect(row.harnesses.some((name) => /codex/i.test(name))).toBe(
        row.file.startsWith('codex:'),
      );
    expect(new Set(openerIds()).size).toBe(3);
  });

  it('still merges a name each version lists once', async () => {
    const reads: string[] = [];
    render(
      versionsPage(
        twoVersions(
          { commands: [cmd('Build', 'commands/a.md')] },
          { commands: [cmd('Build', 'commands/b.md')] },
        ),
        reads,
      ),
    );
    const rows = await openedRows(reads);
    expect(rows.map(({ file }) => file)).toEqual([
      'claude:command:commands/a.md',
    ]);
    expect(rows[0]?.harnesses.some((name) => /codex/i.test(name))).toBe(true);
  });

  it("never lets a member name spell another member's key", () => {
    render(
      versionsPage(
        twoVersions(
          {
            commands: [
              cmd('Build', 'commands/x.md'),
              cmd('Build', 'commands/y.md'),
              cmd('["Build",1]', 'commands/z.md'),
              cmd('["file","Build","commands/x.md"]', 'commands/w.md'),
            ],
          },
          {},
        ),
      ),
    );
    expect(rowTexts().map((text) => text.split('Command')[0])).toEqual(
      expect.arrayContaining([
        'Build',
        'Build',
        '["Build",1]',
        '["file","Build","commands/x.md"]',
      ]),
    );
    expect(rowTexts()).toHaveLength(4);
    expect(new Set(openerIds()).size).toBe(4);
  });

  it('lists a file the manifest names twice once', async () => {
    const reads: string[] = [];
    render(
      versionsPage(
        twoVersions(
          {
            // `commands/` and `commands/build.md` both listed: one file.
            commands: [
              cmd('build', 'commands/build.md'),
              cmd('build', 'commands/build.md'),
            ],
            skills: [
              { name: 'sum', description: '', path: 'skills/sum' },
              { name: 'sum', description: '', path: 'skills/sum' },
            ],
          },
          {},
        ),
        reads,
      ),
    );
    expect(rowTexts()).toHaveLength(2);
    expect(new Set(openerIds()).size).toBe(2);
    const rows = await openedRows(reads);
    expect(rows.map(({ file }) => file).sort()).toEqual([
      'claude:command:commands/build.md',
      'claude:skill:skills/sum/SKILL.md',
    ]);
  });

  it("focuses the Contents tab, not another plugin's row with the same key, when the plugin changes", async () => {
    render(addedWith(commandsDetails('Build', 'Board')));
    act(() => opener('Board')?.focus());
    click(opener('Board'));
    await settle();
    // Another plugin with the same members replaces it under the page.
    render(
      <CustomizeDiscoveryProvider enabled>
        <PluginDetailContent
          plugin={{
            ...ADDED,
            name: 'other',
            details: commandsDetails('Build', 'Board'),
          }}
          onReadComponent={() =>
            Promise.resolve({ frontmatter: {}, body: 'Opened body.' })
          }
        />
      </CustomizeDiscoveryProvider>,
    );
    expect(container.textContent).not.toContain('Opened body.');
    expect(document.activeElement).toBe(byTestId('plugin-detail-tab-contents'));
  });
});

// ---------------------------------------------------------------------------
// Session replay: no name from the plugin's files in any attribute
// ---------------------------------------------------------------------------

/**
 * Every attribute of every element outside a replay block that carries one
 * of `names`: session replay records attributes as it records text.
 */
function namesInRecordedAttributes(
  root: Element,
  names: readonly string[],
): string[] {
  const found: string[] = [];
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (element.closest(`.${REPLAY_BLOCK_CLASS}`)) continue;
    for (const attribute of Array.from(element.attributes))
      for (const name of names)
        if (attribute.value.includes(name))
          found.push(
            `<${element.tagName.toLowerCase()} ${attribute.name}="${attribute.value}">`,
          );
  }
  return found;
}

/** Names and paths the plugin's own files supply, each easy to spot. */
const PRIVATE_DETAILS: PluginDetails = {
  ...emptyDetails(),
  hasReadme: true,
  skills: [{ name: 'sk-orchid', description: 'd', path: 'skills/sk-dir' }],
  agents: [cmd('ag-falcon', 'agents/ag-file.md')],
  commands: [cmd('cmd-quartz', 'commands/cmd-file.md')],
  apps: [cmd('app-lynx', 'apps/app-file.md')],
  hooks: [
    {
      event: 'EvtTopaz',
      matcher: 'MatchJade',
      hookType: 'command',
      command: 'run-amber',
    },
  ],
  mods: [{ module: 'mod-wren', hooksFile: 'mods/wren-hooks.json' }],
  lspServers: [
    {
      name: 'lsp-otter',
      command: 'otter-ls',
      args: ['--stdio'],
      languages: ['ottlang'],
    },
  ],
  mcpServers: [
    { name: 'mcp-heron', type: 'http', url: 'https://heron.example/mcp' },
    { name: 'mcp-ibis', type: 'command', command: 'ibis-mcp', args: ['go'] },
    { name: 'mcp-kite', type: 'command', command: 'kite-mcp' },
    { name: 'mcp-loon', type: 'command', command: 'loon-mcp' },
  ],
};

const PRIVATE_NAMES = [
  'sk-orchid',
  'sk-dir',
  'ag-falcon',
  'ag-file',
  'cmd-quartz',
  'cmd-file',
  'app-lynx',
  'app-file',
  'EvtTopaz',
  'MatchJade',
  'run-amber',
  'mod-wren',
  'wren-hooks',
  'lsp-otter',
  'otter-ls',
  'ottlang',
  'mcp-heron',
  'heron.example',
  'mcp-ibis',
  'ibis-mcp',
  'mcp-kite',
  'kite-mcp',
  'mcp-loon',
  'loon-mcp',
];

describe('names from the plugin in session replay (CAN-7545)', () => {
  it('puts no member, server or path name in a recorded attribute of an added plugin', async () => {
    const plugin = { ...ADDED, details: PRIVATE_DETAILS };
    render(
      <CustomizeDiscoveryProvider enabled>
        <PluginDetailHost
          plugin={plugin}
          loadDetail={() => Promise.resolve(plugin)}
          readComponent={() => Promise.resolve(null)}
          onOpenEntryId={() => undefined}
          bundledServerRows={[
            {
              serverName: 'mcp-ibis',
              endpoint: 'command',
              entryId: 'entry-1',
              serverId: 'server-1',
            },
          ]}
          mcpServerHealth={{
            resolve: (server) => {
              const connection: PluginDetailMcpConnection = {
                label: 'Connect',
                kind: 'connect',
                action: { available: true, run: (): void => undefined },
              };
              switch (server.name) {
                case 'mcp-heron':
                  return {
                    kind: 'target',
                    target: {
                      targetKey: 'heron',
                      accountConnectionStatus: 'CONNECTED',
                      configs: [],
                    },
                    connection: {
                      ...connection,
                      authorizationUrl: 'https://auth.example/sign-in',
                      onCancel: (): void => undefined,
                    },
                  };
                case 'mcp-ibis':
                  return { kind: 'loading' };
                case 'mcp-kite':
                  return {
                    kind: 'unavailable',
                    reason: 'Signed in',
                    connected: true,
                    connection: {
                      ...connection,
                      phase: 'connecting',
                      onCancel: (): void => undefined,
                    },
                  };
                default:
                  return {
                    kind: 'unavailable',
                    reason: 'Sign in to use it',
                    connection,
                  };
              }
            },
          }}
        />
      </CustomizeDiscoveryProvider>,
    );
    await settle();
    expect(byTestId('plugin-detail-contents')).not.toBeNull();
    // Every health state renders: checked, a waiting sign-in, loading, a
    // connected server mid-connect, and one to sign in to.
    for (const id of [
      'plugin-detail-mcp-server-settings',
      'mcp-health-section',
      'plugin-detail-mcp-sign-in',
      'plugin-detail-mcp-status-connected',
      'plugin-detail-mcp-connect-cancel',
      'plugin-detail-mcp-connect',
    ])
      expect(container.querySelector(`[data-testid^="${id}"]`)).not.toBeNull();
    expect(container.textContent).toContain('Sign in to use it');
    expect(namesInRecordedAttributes(container, PRIVATE_NAMES)).toEqual([]);
    // The text itself stays private too.
    const list = byTestId('plugin-detail-contents');
    for (const name of ['sk-orchid', 'mcp-heron', 'mcp-ibis', 'lsp-otter'])
      expect(namePrivate(list, name)).toBe(true);
  });

  it('puts none in a recorded attribute of the catalog summary', async () => {
    render(
      catalogPage({
        wire: wirePreview({
          skills: ['sk-orchid'],
          commands: ['cmd-quartz'],
          agents: ['ag-falcon'],
          hooks: true,
          mcpServers: true,
          mcpServerNames: ['mcp-heron', 'mcp-loon'],
        }),
        readComponent: () => Promise.resolve(null),
        scanned: PRIVATE_DETAILS,
      }),
    );
    await settle();
    expect(byTestId('plugin-detail-contents')).not.toBeNull();
    expect(namesInRecordedAttributes(container, PRIVATE_NAMES)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A plugin not added yet: the catalog summary
// ---------------------------------------------------------------------------

const LISTING: UnifiedPluginEntry = {
  id: 'acme/review',
  kind: 'plugin',
  state: 'available',
  origin: 'marketplace',
  name: 'Review',
  description: 'Reviews code.',
  categories: [],
  components: { skills: 0, mcpServers: 0, commands: 0, agents: 0 },
  providerSupport: { claude: true, codex: true },
  recommended: false,
  ref: {
    type: 'marketplace-plugin',
    marketplaceId: 'acme',
    pluginName: 'review',
  },
};

/** The preview IPC's answer, as the wire carries it. */
function wirePreview(preview: Record<string, unknown>): unknown {
  return {
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
  };
}

function parsed(wire: unknown): PluginManifestPreviewResult {
  const result = parsePluginManifestPreviewResult(wire);
  if (!result) throw new Error('The preview did not parse');
  return result;
}

/** The desktop host's catalog summary (`PluginEntryDetail`), off the shell. */
function catalogPage({
  wire,
  scanned,
  readComponent,
  enabled = true,
  entry = LISTING,
}: {
  wire: unknown;
  scanned?: PluginDetails | readonly PluginDetailFacetSlot[];
  readComponent?: PluginDetailReadComponent;
  enabled?: boolean;
  entry?: UnifiedPluginEntry;
}): JSX.Element {
  return (
    <CustomizeDiscoveryProvider enabled={enabled}>
      <CustomizeManifestPreview
        entry={entry}
        enabled={enabled}
        load={() => Promise.resolve(parsed(wire))}
      >
        {(_shown, _checking, preview) => (
          <PluginCatalogDetail
            entry={{
              name: entry.name,
              description: entry.description,
              categories: entry.categories,
              components: entry.components,
              ...(enabled
                ? {
                    items: customizeCatalogContents(entry, preview, scanned),
                    ...(preview?.readme ? { readme: preview.readme } : {}),
                  }
                : {}),
            }}
            {...(enabled
              ? {
                  layout: true,
                  ...(readComponent ? { readComponent } : {}),
                }
              : {})}
          />
        )}
      </CustomizeManifestPreview>
    </CustomizeDiscoveryProvider>
  );
}

const README_WITH_IMAGES = [
  '# Preview README',
  '![Tracker](https://evil.example/pixel.png)',
  '[![Build badge](https://badges.example/b.svg)](https://ci.example)',
  '<picture><source srcset="https://example.com/p.webp"><img src="https://example.com/p.png"></picture>',
].join('\n\n');

describe('the catalog summary of a plugin not added yet (CAN-7545)', () => {
  it("shows the preview's README as a tab, its images never loaded", async () => {
    render(
      catalogPage({
        wire: wirePreview({
          commands: ['check'],
          readme: { body: README_WITH_IMAGES, truncated: true },
        }),
        entry: {
          ...LISTING,
          components: { skills: 0, mcpServers: 0, commands: 1, agents: 0 },
        },
      }),
    );
    await settle();
    expect(byTestId('plugin-detail-readme')).toBeNull();
    click(byTestId('plugin-detail-tab-readme'));
    const readme = byTestId('plugin-detail-readme');
    expect(readme?.textContent).toContain('Preview README');
    // Before Add a publisher's README loads nothing: images read as their
    // alt text, and a badge's link stays a link.
    expect(
      container.querySelector('img, picture, source, [srcset]'),
    ).toBeNull();
    expect(container.innerHTML).not.toContain('evil.example');
    expect(container.innerHTML).not.toContain('badges.example');
    expect(readme?.textContent).toContain('Tracker');
    expect(
      readme?.querySelector('a[href="https://ci.example"]'),
    ).not.toBeNull();
  });

  it('names what the listing scan found, apps, Mods and LSP servers included, with MCP endpoints', async () => {
    render(
      catalogPage({
        wire: wirePreview({
          mcpServers: true,
          mcpServerNames: ['docs'],
          mcpServerEndpoints: [
            { name: 'docs', type: 'http', url: 'https://docs.example.com/u/t' },
          ],
          descriptions: { 'agent:helper': 'Helps.' },
        }),
        scanned: {
          ...emptyDetails(),
          agents: [{ name: 'helper', description: '', filePath: 'a/h.md' }],
          apps: [
            { name: 'Board', description: 'A board.', filePath: 'apps/b.md' },
          ],
          mods: [{ module: 'lint_mod', hooksFile: 'mods/hooks.json' }],
          lspServers: [
            { name: 'pyright', command: 'pyright', args: ['--stdio'] },
          ],
          mcpServers: [
            { name: 'github', type: 'command', command: 'gh-mcp', args: ['x'] },
          ],
        },
      }),
    );
    await settle();
    const text = rowTexts();
    // Every kind the scan found has its row, in the list's kind order; with
    // no listing counts, nothing falls back to "available after adding".
    expect(text).toEqual([
      expect.stringMatching(/^helper/),
      expect.stringMatching(/^Board/),
      expect.stringMatching(/^docs/),
      expect.stringMatching(/^github/),
      expect.stringMatching(/^lint_mod/),
      expect.stringMatching(/^pyright/),
    ]);
    expect(container.textContent).not.toContain('available after adding');
    expect(text[0]).toContain('Helps.');
    expect(text[1]).toContain('A board.');
    expect(text[4]).toContain('mods/hooks.json');
    expect(text[5]).toContain('pyright --stdio');
    // Endpoints and the names read from the plugin's files are private in
    // session replay.
    const contents = byTestId('plugin-detail-contents');
    for (const value of ['https://docs.example.com/u/t', 'gh-mcp x'])
      expect(namePrivate(contents, value)).toBe(true);
    for (const name of ['helper', 'Board', 'lint_mod', 'pyright'])
      expect(namePrivate(contents, name)).toBe(true);
  });

  it('lists each scanned hook as the installed Contents does, not one generic row', async () => {
    render(
      catalogPage({
        // The preview also reports hooks; the scan's rows say more.
        wire: wirePreview({ hooks: true }),
        scanned: {
          ...emptyDetails(),
          hooks: [
            { event: 'PostToolUse', matcher: 'Edit', hookType: 'command' },
            { event: 'PostToolUse', matcher: 'Write', hookType: 'command' },
            { event: 'SessionStart', hookType: 'prompt' },
          ],
        },
      }),
    );
    await settle();
    expect(rowTexts()).toEqual([
      expect.stringMatching(/^PostToolUse.*Edit · command$/),
      expect.stringMatching(/^PostToolUse.*Write · command$/),
      expect.stringMatching(/^SessionStart.*prompt$/),
    ]);
    expect(container.textContent).not.toContain('Hooks');
    const contents = byTestId('plugin-detail-contents');
    for (const name of ['PostToolUse', 'SessionStart'])
      expect(namePrivate(contents, name)).toBe(true);
  });

  it('lists a hook two versions list identically once, and one they list differently twice', async () => {
    const hook = {
      event: 'PostToolUse',
      matcher: 'Edit',
      hookType: 'command',
      command: 'lint',
    };
    render(
      catalogPage({
        wire: wirePreview({}),
        scanned: [
          version('claude', { hooks: [hook] }),
          version('codex', { hooks: [hook, { ...hook, command: 'format' }] }),
        ],
      }),
    );
    await settle();
    expect(rowTexts()).toEqual([
      expect.stringMatching(/^PostToolUse/),
      expect.stringMatching(/^PostToolUse/),
    ]);
  });

  it('lists two hooks that differ only in async as two rows, and merges an async hook two versions list alike', async () => {
    const hook = {
      event: 'PostToolUse',
      matcher: 'Edit',
      hookType: 'command',
      command: 'lint',
    };
    render(
      catalogPage({
        wire: wirePreview({}),
        scanned: [
          version('claude', {
            hooks: [hook, { ...hook, async: true }],
          }),
          // The same two hooks, one with async spelled out as false.
          version('codex', {
            hooks: [
              { ...hook, async: false },
              { ...hook, async: true },
            ],
          }),
        ],
      }),
    );
    await settle();
    expect(rowTexts()).toEqual([
      expect.stringMatching(/^PostToolUse.*Edit · command$/),
      expect.stringMatching(/^PostToolUse.*Edit · command · async$/),
    ]);
  });

  it('keeps the generic Hooks row for a preview that only says hooks exist', async () => {
    render(
      catalogPage({
        wire: wirePreview({ hooks: true }),
        scanned: emptyDetails(),
      }),
    );
    await settle();
    expect(rowTexts()).toEqual([expect.stringMatching(/^Hooks/)]);
  });

  it('opens an app or command file from the checkout, marks its opener opaquely, and Back returns to it', async () => {
    const reads: string[] = [];
    const readComponent: PluginDetailReadComponent = (type, file) => {
      reads.push(`${type}:${file}`);
      return Promise.resolve({ frontmatter: {}, body: 'Opened body.' });
    };
    render(
      catalogPage({
        wire: wirePreview({}),
        readComponent,
        scanned: {
          ...emptyDetails(),
          commands: [
            {
              name: 'check',
              description: '',
              filePath: 'commands/secret-path.md',
            },
          ],
          apps: [{ name: 'Board', description: '', filePath: 'apps/b.md' }],
        },
      }),
    );
    await settle();
    const openers = Array.from(
      container.querySelectorAll('[data-component-opener]'),
    );
    expect(openers.map((opener) => opener.textContent)).toEqual([
      'check',
      'Board',
    ]);
    // The attribute carries no publisher name or path.
    for (const opener of openers) {
      const id = opener.getAttribute('data-component-opener') ?? '';
      expect(id).not.toContain('check');
      expect(id).not.toContain('Board');
      expect(id).not.toContain('/');
      // A clickable name read from the plugin's files is replay-blocked too;
      // its button is not.
      expect(namePrivate(opener, opener.textContent ?? '')).toBe(true);
    }
    // A click need not focus the name; Back still returns to it.
    click(openers[1]?.querySelector('button'));
    await settle();
    expect(reads).toEqual(['app:apps/b.md']);
    expect(container.textContent).toContain('Opened body.');
    click(byTestId('plugin-catalog-detail-component-back'));
    expect(byTestId('plugin-detail-contents')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('Board');

    const check = container
      .querySelectorAll('[data-component-opener]')[0]
      ?.querySelector('button');
    click(check);
    await settle();
    expect(reads).toEqual(['app:apps/b.md', 'command:commands/secret-path.md']);
  });

  it('keeps commands named Build and build as two rows with their own descriptions', async () => {
    render(
      catalogPage({
        wire: wirePreview({
          commands: ['Build', 'build'],
          agents: ['Reviewer', 'reviewer'],
          descriptions: {
            'command:Build': 'Upper build.',
            'command:build': 'Lower build.',
            'agent:Reviewer': 'Upper reviewer.',
            'agent:reviewer': 'Lower reviewer.',
          },
        }),
        entry: {
          ...LISTING,
          components: { skills: 0, mcpServers: 0, commands: 2, agents: 2 },
        },
      }),
    );
    await settle();
    const text = rowTexts();
    expect(text).toHaveLength(4);
    expect(text).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Reviewer.*Upper reviewer\.$/),
        expect.stringMatching(/^reviewer.*Lower reviewer\.$/),
        expect.stringMatching(/^Build.*Upper build\.$/),
        expect.stringMatching(/^build.*Lower build\.$/),
      ]),
    );
    // Every name the listing counts is named, so nothing is left to Add.
    expect(container.textContent).not.toContain('named once');
  });

  it("keeps a member whose name spells a scanned file's key", async () => {
    render(
      catalogPage({
        wire: wirePreview({ commands: ['Build', 'file:commands/x.md'] }),
        scanned: {
          ...emptyDetails(),
          commands: [cmd('Build', 'commands/x.md')],
        },
      }),
    );
    await settle();
    expect(rowTexts().map((text) => text.split('Command')[0])).toEqual([
      'Build',
      'file:commands/x.md',
    ]);
  });
});

/** One version of a plugin not added yet, as its marketplace scan read it. */
function version(
  kind: 'claude' | 'codex',
  details: Partial<PluginDetails>,
): PluginDetailFacetSlot {
  return {
    kind,
    facet: {
      provider: kind,
      mode: 'native',
      name: 'review',
      installLocation: `/checkout/${kind}`,
      sourcePath: `./${kind}`,
      details: { ...emptyDetails(), ...details },
    },
  };
}

describe("the catalog summary of a plugin's Claude and Codex versions (CAN-7545)", () => {
  it('lists every version, a member both list once, each opening from the version that lists it', async () => {
    const reads: string[] = [];
    const readComponent: PluginDetailReadComponent = (type, file, facet) => {
      reads.push(`${facet?.kind ?? 'none'}:${type}:${file}`);
      return Promise.resolve({ frontmatter: {}, body: 'Opened body.' });
    };
    render(
      catalogPage({
        wire: wirePreview({ descriptions: { 'command:deploy': 'Deploys.' } }),
        readComponent,
        scanned: [
          version('claude', { commands: [cmd('check', 'commands/check.md')] }),
          version('codex', {
            commands: [
              cmd('check', 'commands/check.md'),
              cmd('deploy', 'commands/deploy.md'),
            ],
            apps: [{ name: 'Board', description: '', filePath: 'apps/b.md' }],
            mcpServers: [{ name: 'tracker', type: 'command', command: 'trk' }],
          }),
        ],
      }),
    );
    await settle();
    const text = rowTexts();
    expect(text).toEqual([
      expect.stringMatching(/^check/),
      expect.stringMatching(/^deploy.*Deploys\.$/),
      expect.stringMatching(/^Board/),
      expect.stringMatching(/^tracker.*trk/),
    ]);
    const opener = (name: string): Element | null | undefined =>
      Array.from(container.querySelectorAll('[data-component-opener]'))
        .find((candidate) => candidate.textContent === name)
        ?.querySelector('button');
    for (const name of ['deploy', 'Board', 'check']) {
      click(opener(name));
      await settle();
      click(byTestId('plugin-catalog-detail-component-back'));
    }
    expect(reads).toEqual([
      'codex:command:commands/deploy.md',
      'codex:app:apps/b.md',
      'claude:command:commands/check.md',
    ]);
  });

  it("gives another version's file or name its own row, and keeps one scan's rows as they were", async () => {
    render(
      catalogPage({
        wire: wirePreview({}),
        scanned: [
          version('claude', {
            commands: [cmd('check', 'commands/x.md')],
            agents: [cmd('helper', ''), cmd('helper', '')],
          }),
          version('codex', {
            // The same file under another name, and the same name elsewhere.
            commands: [
              cmd('verify', 'commands/x.md'),
              cmd('check', 'prompts/check.md'),
            ],
            agents: [cmd('helper', '')],
          }),
        ],
      }),
    );
    await settle();
    const names = rowTexts().map((text) => text.split(/Command|Agent/)[0]);
    // Two fileless helpers in one scan stay two; Codex's joins the first.
    expect(names).toEqual(['helper', 'helper', 'check', 'check', 'verify']);
  });

  it("shows an MCP server's endpoint from the first version that defines it", async () => {
    render(
      catalogPage({
        wire: wirePreview({}),
        scanned: [
          version('claude', {
            mcpServers: [{ name: 'tracker', type: 'command', command: 'one' }],
          }),
          version('codex', {
            mcpServers: [{ name: 'tracker', type: 'command', command: 'two' }],
          }),
        ],
      }),
    );
    await settle();
    expect(rowTexts()).toEqual([expect.stringMatching(/^tracker.*one$/)]);
  });
});

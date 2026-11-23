/** @jest-environment jsdom */
/**
 * The classic installed and shared agent pages (CAN-4686): a shared agent's
 * page reads the share's full definition through `window.agents.getShared`
 * (the list only carries a 200-character preview), shows a spinner while it
 * loads and the error with Try again when it fails, and both pages list the
 * same Details rows with any the record lacks left out, never shown as "-".
 *
 * A jsdom suite registered in scripts/golden-suites.mjs (CAN-4686) because no
 * Electron golden opens these pages: it mounts the real pages over the desktop bridge.
 */
import '../../../cloud-chats/__tests__/jsdom-globals';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentModelDefinition } from '@canopy/execution-engine/types/agent-models';
import type {
  SharedAgentDetail,
  SharedAgentSummary,
} from '@canopy/protocol/agents';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  AgentDetailsSection,
  LocalAgentMarketplaceDetail,
} from '../LocalAgentMarketplaceDetail';
import { SharedAgentMarketplaceDetail } from '../SharedResourceMarketplaceDetail';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib/unified-plugin-entry';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/protocol/plugins';
import type { DesktopPublisherSkill } from '@canopy/desktop-shared/types/skills';
import { agentSelectionEntries } from '@/lib/marketplaceAgents';
import { formatDateOrEmpty } from '@/lib/format';
import { CanopyClientProvider } from '@canopy/app-state/CanopyClientProvider';
import { CustomizeDiscoveryProvider } from '@canopy/ui-app/capability';
import {
  createDesktopCanopyClient,
  createDesktopCapabilities,
} from '@/client/ipc-canopy-client';
import {
  initNavigationHistoryTracking,
  useNavigationHistoryStore,
} from '@/stores/navigationHistoryStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { PluginsPage } from '../../pages/PluginsPage';
import { openInAppAgentInstall } from '../../share/usePublicShareLanding';

// The page hands its Install to the review with the revision it shows; the
// review's own behavior is covered by share-install-agent.test.tsx.
jest.mock('../../share/usePublicShareLanding', () => ({
  openInAppAgentInstall: jest.fn(),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const FULL_INSTRUCTIONS = `${'Check the whole diff. '.repeat(20)}FULL-INSTRUCTIONS-END`;
const PREVIEW = FULL_INSTRUCTIONS.slice(0, 200);

function summary(overrides: Partial<SharedAgentSummary>): SharedAgentSummary {
  return {
    id: '3f0d3d7e-8a52-4f4c-9e57-6a1b2c3d4e5f',
    name: 'Release agent',
    modelId: 'agent_model_release',
    baseModel: 'default',
    instructionsPreview: PREVIEW,
    contentHash: 'h',
    shareScope: 'organization',
    owner: { type: 'user', id: 'u', name: 'Me' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-03T00:00:00.000Z',
    createdBy: { id: 'u', name: 'Me', email: null },
    canUpdate: true,
    canDelete: true,
    publicShare: null,
    ...overrides,
  };
}

function detailOf(shared: SharedAgentSummary): SharedAgentDetail {
  return {
    ...shared,
    agent: {
      version: 1,
      id: shared.modelId,
      name: shared.name,
      baseModel: shared.baseModel,
      instructions: FULL_INSTRUCTIONS,
      plugins: [],
    },
  };
}

let getShared: jest.Mock<Promise<SharedAgentDetail>, [string]>;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  getShared = jest.fn<Promise<SharedAgentDetail>, [string]>();
  Object.assign(window, { agents: { getShared } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function byTestId(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

/** The Details rows the page shows, by their labels, in page order. */
function detailLabels(): string[] {
  const text = container.textContent ?? '';
  return ['Base model', 'Model ID', 'Updated'].filter((label) =>
    text.includes(label),
  );
}

describe('A shared agent page', () => {
  it('reads the full instructions through getShared, not the list preview', async () => {
    const shared = summary({});
    getShared.mockResolvedValue(detailOf(shared));
    act(() => root.render(<SharedAgentMarketplaceDetail agent={shared} />));
    await settle();
    expect(getShared).toHaveBeenCalledTimes(1);
    expect(getShared).toHaveBeenCalledWith(shared.id);
    const text = byTestId('agent-definition-instructions')?.textContent ?? '';
    expect(text).toContain('FULL-INSTRUCTIONS-END');
    expect(text.length).toBeGreaterThan(PREVIEW.length);
  });

  it('shows the spinner until the share is read', async () => {
    getShared.mockReturnValue(new Promise(() => undefined));
    act(() =>
      root.render(<SharedAgentMarketplaceDetail agent={summary({})} />),
    );
    await settle();
    expect(byTestId('agent-definition-instructions')).toBeNull();
    expect(
      container.querySelector('[role="status"], [aria-busy="true"]'),
    ).not.toBeNull();
  });

  it('says what failed and reads again on Try again', async () => {
    const shared = summary({});
    getShared.mockRejectedValueOnce(new Error('offline'));
    getShared.mockResolvedValueOnce(detailOf(shared));
    act(() => root.render(<SharedAgentMarketplaceDetail agent={shared} />));
    await settle();
    expect(byTestId('shared-agent-detail-error')).not.toBeNull();
    expect(byTestId('agent-definition-instructions')).toBeNull();

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    expect(retry).toBeDefined();
    act(() => retry?.click());
    await settle();
    expect(getShared).toHaveBeenCalledTimes(2);
    expect(byTestId('shared-agent-detail-error')).toBeNull();
    expect(byTestId('agent-definition-instructions')?.textContent).toContain(
      'FULL-INSTRUCTIONS-END',
    );
  });

  it('installs the revision it shows: the summary until read, then the share', async () => {
    const open = jest.mocked(openInAppAgentInstall);
    open.mockClear();
    const shared = summary({ contentHash: 'listed' });
    let read: (detail: SharedAgentDetail) => void = () => undefined;
    getShared.mockReturnValue(
      new Promise((resolve) => {
        read = resolve;
      }),
    );
    act(() => root.render(<SharedAgentMarketplaceDetail agent={shared} />));
    act(() => byTestId('shared-agent-detail-add')?.click());
    expect(open).toHaveBeenLastCalledWith(
      expect.objectContaining({ entity: 'agent', externalId: shared.id }),
      { contentHash: 'listed' },
    );

    await act(async () => {
      read({ ...detailOf(shared), contentHash: 'read' });
      await Promise.resolve();
    });
    act(() => byTestId('shared-agent-detail-add')?.click());
    expect(open).toHaveBeenLastCalledWith(
      expect.objectContaining({ entity: 'agent', externalId: shared.id }),
      { contentHash: 'read', packageDigest: null },
    );
  });

  it('lists its Details and leaves out a missing model ID or date', async () => {
    const shared = summary({});
    getShared.mockResolvedValue(detailOf(shared));
    act(() => root.render(<SharedAgentMarketplaceDetail agent={shared} />));
    await settle();
    expect(detailLabels()).toEqual(['Base model', 'Model ID', 'Updated']);

    // The Details follow the revision read, which now has neither.
    const bare = summary({
      id: '7a1c2d3e-0000-4000-8000-000000000001',
      modelId: '',
      updatedAt: '',
    });
    getShared.mockResolvedValue(detailOf(bare));
    act(() => root.render(<SharedAgentMarketplaceDetail agent={bare} />));
    await settle();
    expect(detailLabels()).toEqual(['Base model']);
  });

  it('shows the Details of the revision it installs when the share changed since the list', async () => {
    const listed = summary({
      modelId: 'agent_model_listed',
      updatedAt: '2026-02-03T00:00:00.000Z',
    });
    const republished = detailOf(
      summary({
        modelId: 'agent_model_republished',
        updatedAt: '2026-04-05T00:00:00.000Z',
        contentHash: 'republished',
      }),
    );
    getShared.mockResolvedValue(republished);
    act(() => root.render(<SharedAgentMarketplaceDetail agent={listed} />));
    // Until the read lands, the list's summary fills the rows.
    expect(container.textContent).toContain('agent_model_listed');

    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('agent_model_republished');
    expect(text).not.toContain('agent_model_listed');
    expect(text).toContain(formatDateOrEmpty(republished.updatedAt));
    expect(text).not.toContain(formatDateOrEmpty(listed.updatedAt));
  });
});

describe('The Details of an agent page', () => {
  it('omit Model ID and Updated when absent or not a date', () => {
    act(() => root.render(<AgentDetailsSection baseModel="Claude Opus" />));
    expect(detailLabels()).toEqual(['Base model']);

    act(() =>
      root.render(
        <AgentDetailsSection
          baseModel="Claude Opus"
          modelId="agent_model_x"
          updatedAt="not a date"
        />,
      ),
    );
    expect(detailLabels()).toEqual(['Base model', 'Model ID']);
    expect(container.textContent).not.toContain('Updated');
    expect(container.textContent).not.toContain('—');
  });

  it('mask the model ID, which comes from the agent’s own name', () => {
    act(() =>
      root.render(
        <AgentDetailsSection baseModel="Claude Opus" modelId="agent_model_x" />,
      ),
    );
    const id = Array.from(container.querySelectorAll('span')).findLast(
      (span) => span.textContent === 'agent_model_x',
    );
    expect(id?.classList.contains(POSTHOG_REPLAY_MASK_CLASS)).toBe(true);
  });

  it('are the same rows on the installed page, with no placeholder', () => {
    const agent: AgentModelDefinition = {
      id: 'agent_model_pirate',
      name: 'Pirate',
      baseModel: 'default',
      instructions: '# Arr\nTalk like a pirate.',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '',
    };
    act(() =>
      root.render(
        <LocalAgentMarketplaceDetail
          agent={agent}
          onEdit={() => undefined}
          onDelete={() => undefined}
        />,
      ),
    );
    expect(detailLabels()).toEqual(['Base model', 'Model ID']);
    expect(container.textContent).not.toContain('—');
    expect(
      byTestId('agent-definition-instructions')?.querySelector(
        '[data-description-heading]',
      )?.textContent,
    ).toBe('Arr');
  });
});

function entryFor(
  id: string,
  kind: UnifiedPluginEntry['kind'],
  ref: UnifiedPluginEntry['ref'],
): UnifiedPluginEntry {
  return {
    id,
    kind,
    origin: 'installed-standalone',
    name: id,
    description: '',
    categories: [],
    typeLabel: kind,
    components: { skills: 0, mcpServers: 0, commands: 0, agents: 0 },
    providerSupport: { claude: true, codex: true },
    state: 'installed',
    recommended: false,
    ref,
  };
}

function agentSelecting(
  pluginSelections: AgentModelDefinition['pluginSelections'],
): AgentModelDefinition {
  return {
    id: 'agent_model_reviewer',
    name: 'Reviewer',
    baseModel: 'default',
    instructions: '',
    pluginSelections,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe("An agent's plugins and skills as Customize tiles", () => {
  const skill = entryFor('skill-review', 'skill', {
    type: 'skill',
    sourceId: 'local',
    skillName: 'review',
  });
  const otherSourceSkill = entryFor('skill-review-team', 'skill', {
    type: 'skill',
    sourceId: 'team',
    skillName: 'review',
  });
  const plugin = entryFor('plugin-github', 'plugin', {
    type: 'marketplace-plugin',
    marketplaceId: 'official',
    pluginName: 'github',
  });
  const accountServer = entryFor('mcp-linear-work', 'app', {
    type: 'mcp-server',
    serverId: 'linear',
    configId: 'work',
  });
  const personalServer = entryFor('mcp-linear-personal', 'app', {
    type: 'local-mcp',
    serverId: 'linear',
    configId: 'personal',
  });
  const deviceServer = entryFor('mcp-files', 'app', {
    type: 'local-mcp',
    serverId: 'files',
  });
  const collection = entryFor('collection-release', 'collection', {
    type: 'local-collection',
    collectionId: 'col-release',
  });
  const entries = [
    otherSourceSkill,
    skill,
    plugin,
    personalServer,
    accountServer,
    deviceServer,
    collection,
  ];

  it('match each kind of selection to its own tile', () => {
    const result = agentSelectionEntries(
      agentSelecting({
        collectionIds: ['col-release'],
        skillRefs: [{ sourceId: 'local', skillName: 'review' }],
        pluginRefs: [{ marketplaceId: 'official', pluginName: 'github' }],
        mcpServerRefs: [
          { serverId: 'linear', configId: 'work' },
          { serverId: 'files', configId: 'device' },
        ],
      }),
      entries,
    );
    expect(result.entries.map((entry) => entry.id)).toEqual([
      'skill-review',
      'plugin-github',
      'mcp-linear-work',
      'mcp-files',
      'collection-release',
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it('name each selection no tile stands for, once per selection', () => {
    const result = agentSelectionEntries(
      agentSelecting({
        collectionIds: ['col-gone'],
        skillRefs: [
          { sourceId: 'local', skillName: 'review' },
          { sourceId: 'local', skillName: 'review' },
          { sourceId: 'elsewhere', skillName: 'gone-skill' },
        ],
        pluginRefs: [{ marketplaceId: 'other', pluginName: 'github' }],
        mcpServerRefs: [{ serverId: 'linear', configId: 'school' }],
      }),
      entries,
    );
    // A skill selected twice is one tile.
    expect(result.entries.map((entry) => entry.id)).toEqual(['skill-review']);
    expect(result.unresolved).toEqual([
      'gone-skill',
      'github',
      'linear',
      'col-gone',
    ]);
  });

  it('match curated plugins, folded plugins and curated connections', () => {
    const curatedPlugin = entryFor('curated:deep-research', 'plugin', {
      type: 'curated-plugin',
      key: 'deep-research',
    });
    // A curated plugin that needs one server folds into that server's card,
    // which also lists every connection of the key.
    const integrationCard: UnifiedPluginEntry = {
      ...entryFor('mcp-catalog:linear', 'app', {
        type: 'curated-mcp',
        key: 'linear',
      }),
      integration: {
        curatedKey: 'linear',
        plugin: {
          key: 'linear-tools',
          name: 'Linear tools',
          skills: 2,
          installed: true,
        },
        connections: [
          {
            serverId: 'linear-server',
            configId: 'work',
            name: 'Linear',
            binding: 'account',
            state: 'installed',
          },
        ],
      },
    };
    const result = agentSelectionEntries(
      agentSelecting({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [
          {
            marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
            pluginName: 'deep-research',
          },
          {
            marketplaceId: CURATED_PLUGIN_MARKETPLACE_ID,
            pluginName: 'linear-tools',
          },
        ],
        mcpServerRefs: [{ serverId: 'linear-server', configId: 'work' }],
      }),
      [curatedPlugin, integrationCard],
    );
    // The folded plugin and the connection are one card, listed once.
    expect(result.entries.map((entry) => entry.id)).toEqual([
      'curated:deep-research',
      'mcp-catalog:linear',
    ]);
    expect(result.unresolved).toEqual([]);

    // A saved secondary configuration of the card's server (the card lists
    // only the first one) resolves to that card, not to "missing".
    const secondary = agentSelectionEntries(
      agentSelecting({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'linear-server', configId: 'school' }],
      }),
      [curatedPlugin, integrationCard],
    );
    expect(secondary.entries.map((entry) => entry.id)).toEqual([
      'mcp-catalog:linear',
    ]);
    expect(secondary.unresolved).toEqual([]);

    // A server no card lists, and a plugin from another marketplace that only
    // shares the curated plugin's name, stay unresolved.
    const other = agentSelectionEntries(
      agentSelecting({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'other', pluginName: 'deep-research' }],
        mcpServerRefs: [{ serverId: 'notion-server', configId: 'work' }],
      }),
      [curatedPlugin, integrationCard],
    );
    expect(other.entries).toEqual([]);
    expect(other.unresolved).toEqual(['deep-research', 'notion-server']);
  });

  it('match an installed publisher skill to its publisher entry', () => {
    // The list folds the installed copy (custom:app) into the publisher's
    // entry, so the saved selection has no `skill` tile of its own.
    const publisherEntry = entryFor('public-share:skill:share-1', 'skill', {
      type: 'public-share',
      shareKind: 'skill',
      externalId: 'share-1',
      sharePath: '/s/share-1',
    });
    const publisherSkill: DesktopPublisherSkill = {
      externalId: 'share-1',
      name: 'review',
      description: '',
      publisher: 'Acme',
      installedSkillName: 'acme-review',
    };
    const selecting = agentSelecting({
      collectionIds: [],
      skillRefs: [{ sourceId: 'custom:app', skillName: 'acme-review' }],
      pluginRefs: [],
    });
    const result = agentSelectionEntries(
      selecting,
      [skill, publisherEntry],
      [publisherSkill],
    );
    expect(result.entries.map((entry) => entry.id)).toEqual([
      'public-share:skill:share-1',
    ]);
    expect(result.unresolved).toEqual([]);

    // Not installed through a publisher: the selection stays unresolved.
    expect(
      agentSelectionEntries(selecting, [skill, publisherEntry]).unresolved,
    ).toEqual(['acme-review']);
  });

  it('match nothing when the agent selects nothing', () => {
    expect(
      agentSelectionEntries(
        agentSelecting({ collectionIds: [], skillRefs: [], pluginRefs: [] }),
        entries,
      ),
    ).toEqual({ entries: [], unresolved: [] });
  });
});

/**
 * A stand-in for a preload bridge the page only touches in passing: any call
 * resolves to an empty result, and a subscription returns its unsubscribe.
 */
function passiveBridge(name: string): unknown {
  return new Proxy(() => undefined, {
    get: (_target, property) =>
      typeof property === 'symbol' || property === 'then'
        ? undefined
        : passiveBridge(`${name}.${property}`),
    apply: () =>
      /\.(on[A-Z]\w*|subscribe\w*)$/.test(name)
        ? () => undefined
        : Promise.resolve(
            Object.assign([], {
              servers: [],
              marketplaces: [],
              plugins: [],
              entries: [],
              skills: [],
              items: [],
              agents: [],
              sources: [],
              activities: [],
              recentRuns: [],
              pipelines: [],
            }),
          ),
  });
}

/** `bridge` with the given members replaced. */
function withMembers(
  bridge: unknown,
  members: Record<string, unknown>,
): unknown {
  return new Proxy(Object(bridge), {
    get: (target, property): unknown =>
      typeof property === 'string' && property in members
        ? members[property]
        : Reflect.get(target, property),
  });
}

describe("An agent page's tab on the Customize page", () => {
  const reviewer: AgentModelDefinition = {
    id: 'agent_model_reviewer',
    name: 'Reviewer',
    baseModel: 'default',
    instructions: 'Review it.',
    pluginSelections: {
      collectionIds: [],
      skillRefs: [{ sourceId: 'local', skillName: 'review' }],
      pluginRefs: [],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const PLUGINS_TAB = 'Plugins & skills';
  const PASSIVE_BRIDGES = [
    'mcpServers',
    'plugins',
    'marketplaces',
    'pipelines',
    'preferences',
    'api',
  ];
  let stopTracking: () => void;
  let realBridges: Record<string, unknown>;

  beforeEach(() => {
    realBridges = Object.fromEntries(
      [...PASSIVE_BRIDGES, 'skills'].map((name) => [
        name,
        Reflect.get(window, name),
      ]),
    );
    for (const name of PASSIVE_BRIDGES) {
      Object.assign(window, { [name]: passiveBridge(name) });
    }
    Object.assign(window, {
      agents: withMembers(passiveBridge('agents'), {
        list: () => Promise.resolve({ agents: [reviewer] }),
        onChanged: (): (() => void) => () => undefined,
      }),
      skills: withMembers(passiveBridge('skills'), {
        loadSkills: () =>
          Promise.resolve({
            success: true,
            data: [
              {
                name: 'review',
                sourceId: 'local',
                description: 'Reviews',
                source: 'local',
                installedAt: '',
                updatedAt: '',
                updateAvailable: false,
              },
            ],
          }),
      }),
    });
    stopTracking = initNavigationHistoryTracking();
    act(() =>
      root.render(
        <CanopyClientProvider
          client={createDesktopCanopyClient(
            createDesktopCapabilities('darwin', {}, {}),
          )}
        >
          <CustomizeDiscoveryProvider enabled>
            <PluginsPage onOpenAccountSettings={() => undefined} />
          </CustomizeDiscoveryProvider>
        </CanopyClientProvider>,
      ),
    );
  });
  afterEach(() => {
    stopTracking();
    useNavigationHistoryStore.getState().reset();
    // The page unmounts on its own bridges, which then go back for the next
    // test in this file.
    act(() => root.unmount());
    Object.assign(window, realBridges);
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  function tab(label: string): HTMLElement | undefined {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[role="tab"]'),
    ).find((item) => item.textContent?.startsWith(label));
  }
  function openReviewer(): void {
    act(() =>
      useNavigationStore
        .getState()
        .openAgentReveal({ agentId: reviewer.id, mode: 'highlight' }),
    );
  }
  /** Opens the agent, then its skill from the plugins and skills tab. */
  async function openAgentThenItsSkill(): Promise<void> {
    await flush();
    openReviewer();
    await flush();
    act(() => tab(PLUGINS_TAB)?.click());
    await flush();
    const row = container.querySelector<HTMLElement>(
      '[data-testid="agent-detail-items"] button',
    );
    expect(row).not.toBeNull();
    act(() => row?.click());
    await flush();
    expect(tab('Instructions')).toBeUndefined();
  }

  it('comes back on the plugins and skills tab with the app’s Back from one of its skills', async () => {
    await openAgentThenItsSkill();
    act(() => {
      expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    });
    await flush();
    expect(tab(PLUGINS_TAB)?.getAttribute('aria-selected')).toBe('true');
    expect(tab('Instructions')?.getAttribute('aria-selected')).toBe('false');
  });

  it('starts on Instructions when the same agent is opened again as a fresh visit', async () => {
    await openAgentThenItsSkill();
    // The command palette's route: a new intent for an agent that was open.
    openReviewer();
    await flush();
    expect(tab('Instructions')?.getAttribute('aria-selected')).toBe('true');
    expect(tab(PLUGINS_TAB)?.getAttribute('aria-selected')).toBe('false');
  });

  it('starts on Instructions when the agent already on screen is opened again', async () => {
    // No drill-in and no Back: the detail never unmounts, so only a new
    // navigation key resets its tab.
    await flush();
    openReviewer();
    await flush();
    act(() => tab(PLUGINS_TAB)?.click());
    await flush();
    expect(tab(PLUGINS_TAB)?.getAttribute('aria-selected')).toBe('true');
    openReviewer();
    await flush();
    expect(tab('Instructions')?.getAttribute('aria-selected')).toBe('true');
    expect(tab(PLUGINS_TAB)?.getAttribute('aria-selected')).toBe('false');
  });
});

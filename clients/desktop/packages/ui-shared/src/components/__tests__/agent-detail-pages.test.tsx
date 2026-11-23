/** @jest-environment jsdom */
/**
 * An agent's instructions and its page, shared by desktop and the web
 * (CAN-4686): the instructions read as sanitized Markdown (a `#` is never raw
 * text, raw HTML never becomes markup, long text scrolls in place), and the
 * Customize agent page lists its plugins and skills as typed tiles on a tab
 * the back arrow returns to, while a fresh visit opens Instructions.
 *
 * A jsdom suite registered in scripts/golden-suites.mjs (CAN-4686) because no
 * Electron golden opens these pages: it mounts the real shared summary and agent page.
 */
import type { JSX } from 'react';
import { AgentDefinitionSummary } from '../AgentDefinitionSummary';
import {
  AgentReadDetail,
  clearAgentDetailTabRestore,
} from '../AgentReadDetail';
import type { UnifiedPluginEntry } from '../../lib/unified-plugin-entry';
import { createDomHarness, type DomHarness } from './domHarness';

let dom: DomHarness;
beforeEach(() => {
  dom = createDomHarness();
});
afterEach(() => {
  dom.cleanup();
});

function renderSummary(instructions: string): HTMLElement {
  dom.render(
    <AgentDefinitionSummary instructions={instructions} plugins={[]} />,
  );
  return dom.byTestId('agent-definition-instructions');
}

describe('Agent instructions', () => {
  it('render as Markdown, not as the raw source', () => {
    const box = renderSummary(
      [
        '# Arr',
        'Talk like a pirate.',
        '',
        '- first',
        '- second',
        '',
        'Run `ls` or [the docs](https://example.com/docs).',
        '',
        '```',
        'const x = 1;',
        '```',
      ].join('\n'),
    );
    expect(box.textContent).not.toContain('#');
    expect(box.textContent).not.toContain('```');
    expect(box.querySelector('h1')).toBeNull();
    expect(box.querySelector('[data-description-heading]')?.textContent).toBe(
      'Arr',
    );
    expect(
      Array.from(box.querySelectorAll('li'), (li) => li.textContent),
    ).toEqual(['first', 'second']);
    expect(box.querySelector('pre code')?.textContent).toContain(
      'const x = 1;',
    );
    const link = box.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/docs');
    expect(link?.textContent).toBe('the docs');
  });

  it('show raw HTML as text and never inject it', () => {
    const box = renderSummary(
      'Before <script>window.hacked = 1</script> after',
    );
    expect(box.querySelector('script')).toBeNull();
    expect(box.textContent).toContain('<script>');
  });

  it('say so when there are none', () => {
    const box = renderSummary('   \n  ');
    expect(box.textContent).toBe('No additional instructions.');
  });

  it('scroll in a box when long, and not where the page reads them in full', () => {
    const long = Array.from({ length: 80 }, (_, i) => `Line ${i}`).join('\n\n');
    // The shared overlay scroll region, capped in height (never a raw
    // overflow-y-auto of the box's own).
    const scrolling = renderSummary(long);
    const area = scrolling.closest('[data-overlay-scroll-area]');
    expect(area).not.toBeNull();
    expect(area?.className).toContain('max-h-96');

    dom.render(
      <AgentReadDetail
        name="Pirate"
        description="Talks like one."
        items={[]}
        instructions={long}
        logo={null}
        publisher={null}
      />,
    );
    const full = dom.byTestId('agent-detail-instructions');
    expect(full.className).not.toContain('overflow-y-auto');
    expect(full.closest('[data-overlay-scroll-area]')).toBeNull();
  });
});

function skillEntry(name: string): UnifiedPluginEntry {
  return {
    id: `skill:${name}`,
    kind: 'skill',
    origin: 'installed-standalone',
    name,
    description: `${name} description`,
    categories: [],
    typeLabel: 'Skill',
    components: { skills: 1, mcpServers: 0, commands: 0, agents: 0 },
    providerSupport: { claude: true, codex: true },
    state: 'installed',
    recommended: false,
    ref: { type: 'skill', sourceId: 'local', skillName: name },
  };
}

/** Leaves the page, as the back arrow's navigation unmounts it. */
function leave(): void {
  dom.render(<div />);
}

function agentPage(
  onOpenItem: (entry: UnifiedPluginEntry) => void,
  identity: { name?: string; entityId?: string } = {},
): JSX.Element {
  return (
    <AgentReadDetail
      name={identity.name ?? 'Reviewer'}
      entityId={identity.entityId ?? 'agent:local:reviewer'}
      description="Reviews diffs."
      logo={null}
      publisher={null}
      source="Local"
      baseModel="Claude Opus"
      items={[{ key: 'skill', label: 'Skill: review' }]}
      itemEntries={[skillEntry('review')]}
      unresolvedItems={[]}
      onOpenItem={onOpenItem}
      instructions="Read the whole diff."
    />
  );
}

/** Opens the agent's first tile from its Plugins & skills tab. */
function openFirstTile(): void {
  dom.click(dom.byTestId('agent-detail-tab-items'));
  dom.click(dom.select('[data-marketplace-entry="true"]'));
}

describe('The Customize agent page', () => {
  it('opens on Instructions and shows each plugin and skill with its type', () => {
    dom.render(agentPage(() => undefined));
    expect(dom.byTestId('agent-detail-instructions').textContent).toBe(
      'Read the whole diff.',
    );
    expect(dom.queryTestId('agent-detail-items')).toBeNull();

    dom.click(dom.byTestId('agent-detail-tab-items'));
    const tiles = dom.byTestId('agent-detail-items');
    expect(tiles.textContent).toContain('review');
    expect(dom.byTestId('customize-row-type-skill:review').textContent).toBe(
      'Skill',
    );
  });

  it('lands back on Plugins & skills after a tile was opened, once', () => {
    const opened: string[] = [];
    dom.render(agentPage((entry) => opened.push(entry.id)));
    openFirstTile();
    expect(opened).toEqual(['skill:review']);

    // The back arrow mounts the same agent's page again.
    leave();
    dom.render(agentPage((entry) => opened.push(entry.id)));
    expect(dom.queryTestId('agent-detail-items')).not.toBeNull();
    expect(dom.queryTestId('agent-detail-instructions')).toBeNull();

    // A fresh visit afterwards opens Instructions again.
    leave();
    dom.render(agentPage((entry) => opened.push(entry.id)));
    expect(dom.queryTestId('agent-detail-instructions')).not.toBeNull();
  });

  it('starts a fresh visit on Instructions once the host cleared the restore', () => {
    // The tile was opened, but the person left through a breadcrumb rather
    // than the back arrow: the host clears what the back arrow would restore.
    dom.render(agentPage(() => undefined));
    openFirstTile();
    leave();
    clearAgentDetailTabRestore();
    dom.render(agentPage(() => undefined));
    expect(dom.queryTestId('agent-detail-instructions')).not.toBeNull();
    expect(dom.queryTestId('agent-detail-items')).toBeNull();
  });

  it('counts the tiles it shows, not the selections behind them', () => {
    // A plugin selected twice is one tile.
    dom.render(
      <AgentReadDetail
        name="Reviewer"
        entityId="agent:local:count"
        description=""
        logo={null}
        publisher={null}
        items={[
          { key: 'a', label: 'Skill: review' },
          { key: 'b', label: 'Skill: review' },
        ]}
        itemEntries={[skillEntry('review')]}
        instructions="Read."
      />,
    );
    expect(dom.byTestId('agent-detail-tab-items').textContent).toMatch(
      /Plugins & skills\s*1$/,
    );
  });

  it('counts a selection no tile stands for, as the tab lists it', () => {
    dom.render(
      <AgentReadDetail
        name="Reviewer"
        entityId="agent:local:count-unresolved"
        description=""
        logo={null}
        publisher={null}
        items={[
          { key: 'a', label: 'Skill: review' },
          { key: 'b', label: 'Plugin: gone' },
        ]}
        itemEntries={[skillEntry('review')]}
        unresolvedItems={['gone']}
        instructions="Read."
      />,
    );
    expect(dom.byTestId('agent-detail-tab-items').textContent).toMatch(
      /Plugins & skills\s*2$/,
    );
  });

  it('keeps the restore for its own agent only', () => {
    dom.render(agentPage(() => undefined));
    openFirstTile();
    leave();
    dom.render(
      <AgentReadDetail
        name="Another"
        entityId="agent:local:another"
        description=""
        logo={null}
        publisher={null}
        items={[]}
        instructions="Other."
      />,
    );
    expect(dom.byTestId('agent-detail-instructions').textContent).toBe(
      'Other.',
    );
    leave();
    dom.render(agentPage(() => undefined));
    expect(dom.queryTestId('agent-detail-items')).not.toBeNull();
  });

  it('never restores onto another agent with the same name', () => {
    // A local agent and a share can carry the same name.
    dom.render(agentPage(() => undefined, { entityId: 'agent:local:x' }));
    openFirstTile();
    leave();
    dom.render(agentPage(() => undefined, { entityId: 'agent:shared:x' }));
    expect(dom.queryTestId('agent-detail-instructions')).not.toBeNull();

    // The local agent's own restore is still waiting for it.
    leave();
    dom.render(agentPage(() => undefined, { entityId: 'agent:local:x' }));
    expect(dom.queryTestId('agent-detail-items')).not.toBeNull();
  });

  it('starts on Instructions when another agent replaces it in place', () => {
    dom.render(agentPage(() => undefined));
    dom.click(dom.byTestId('agent-detail-tab-items'));
    expect(dom.queryTestId('agent-detail-items')).not.toBeNull();

    // The same mounted page, another agent: no remount in between.
    dom.render(
      agentPage(() => undefined, {
        name: 'Writer',
        entityId: 'agent:local:writer',
      }),
    );
    expect(dom.queryTestId('agent-detail-items')).toBeNull();
    expect(dom.queryTestId('agent-detail-instructions')).not.toBeNull();
  });

  it('restores nothing without an entry id', () => {
    const page = (): JSX.Element => (
      <AgentReadDetail
        name="Reviewer"
        description=""
        logo={null}
        publisher={null}
        items={[{ key: 'skill', label: 'Skill: review' }]}
        itemEntries={[skillEntry('review')]}
        onOpenItem={() => undefined}
        instructions="Read the whole diff."
      />
    );
    dom.render(page());
    openFirstTile();
    leave();
    dom.render(page());
    expect(dom.queryTestId('agent-detail-instructions')).not.toBeNull();
  });
});

describe("The agent page's plugins and skills", () => {
  function itemsTab(props: {
    entries?: UnifiedPluginEntry[];
    unresolved?: string[];
    items?: { key: string; label: string }[];
  }): HTMLElement {
    dom.render(
      <AgentReadDetail
        name="Reviewer"
        description=""
        logo={null}
        publisher={null}
        items={props.items ?? []}
        {...(props.entries ? { itemEntries: props.entries } : {})}
        {...(props.unresolved ? { unresolvedItems: props.unresolved } : {})}
        instructions=""
      />,
    );
    dom.click(dom.byTestId('agent-detail-tab-items'));
    return dom.byTestId('agent-detail-items');
  }

  it('say none are required when the agent selects nothing', () => {
    const tab = itemsTab({ entries: [], unresolved: [] });
    expect(tab.textContent).toBe('No plugins or skills required');
    expect(dom.queryTestId('agent-detail-items-unresolved')).toBeNull();
  });

  it('name the selections no tile stands for, with no tiles', () => {
    const tab = itemsTab({
      entries: [],
      unresolved: ['gone-skill', 'old-plugin'],
    });
    expect(tab.textContent).not.toContain('No plugins or skills required');
    expect(dom.byTestId('agent-detail-items-unresolved').textContent).toBe(
      'Not in Customize any more: gone-skill, old-plugin',
    );
  });

  it('show tiles and the unresolved note together', () => {
    itemsTab({ entries: [skillEntry('review')], unresolved: ['gone-skill'] });
    expect(dom.queryTestId('customize-row-type-skill:review')).not.toBeNull();
    expect(dom.byTestId('agent-detail-items-unresolved').textContent).toBe(
      'Not in Customize any more: gone-skill',
    );
  });

  it('fall back to Type and Name rows when the host resolved no tiles', () => {
    const tab = itemsTab({
      items: [
        { key: 'skill', label: 'Skill: review' },
        { key: 'plugin', label: 'Plugin: github' },
      ],
    });
    const cells = Array.from(tab.querySelectorAll('td'), (cell) =>
      cell.textContent?.trim(),
    );
    expect(cells).toEqual(['Skill', 'review', 'Plugin', 'github']);
    expect(dom.queryTestId('customize-row-type-skill:review')).toBeNull();
  });
});

describe("The agent page's fact hints", () => {
  it('can be reached with the keyboard and name what they explain', () => {
    dom.render(agentPage(() => undefined));
    for (const testId of [
      'agent-detail-source-hint',
      'agent-detail-base-model-hint',
    ]) {
      const hint = dom.byTestId(testId);
      expect(hint.tabIndex).toBe(0);
      hint.focus();
      expect(document.activeElement).toBe(hint);
    }
    expect(
      dom.byTestId('agent-detail-source-hint').getAttribute('aria-label'),
    ).toBe(
      'About Source: Saved on this computer. Only you can use it until you share it.',
    );
  });
});

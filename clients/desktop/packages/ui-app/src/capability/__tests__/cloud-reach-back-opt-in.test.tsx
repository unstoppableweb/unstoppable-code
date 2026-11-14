/** @jest-environment jsdom */
/**
 * The reach-back opt-in (CAN-6176 PR 7c, D26): "Run without asking" is per
 * tool, chosen at opt-in and off by default, so every tool not marked
 * read-only is asked about until the person ticks that tool's box. The
 * person's choices survive the page rendering again while the dialog is
 * open.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CloudReachBackSection,
  type CloudReachBackSectionProps,
  type CloudReachBackTool,
} from '../CloudReachBackSection';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TOOLS: readonly CloudReachBackTool[] = [
  { name: 'list_issues' },
  { name: 'create_issue' },
];

describe('reach-back opt-in (CAN-6176 D26)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let allowed: Parameters<CloudReachBackSectionProps['onAllow']>[0][];
  let loads: number;

  const render = (): void => {
    act(() => {
      root.render(
        <CloudReachBackSection
          serverName="Tracker"
          // A new object and loader each render, as a host may pass.
          state={null}
          loadTools={(): Promise<readonly CloudReachBackTool[]> => {
            loads += 1;
            return Promise.resolve(TOOLS);
          }}
          onAllow={(selection): Promise<void> => {
            allowed.push(selection);
            return Promise.resolve();
          }}
          onTurnOff={(): Promise<void> => Promise.resolve()}
          calls={[]}
        />,
      );
    });
  };

  const byTestId = (id: string): HTMLElement => {
    const element = document.body.querySelector<HTMLElement>(
      `[data-testid="${id}"]`,
    );
    if (element === null) throw new Error(`No ${id}.`);
    return element;
  };

  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    allowed = [];
    loads = 0;
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('chooses every tool, and none to run without asking, by default', async () => {
    act(() => byTestId('cloud-reach-back-open').click());
    await flush();
    expect(
      byTestId('cloud-reach-back-use-create_issue').getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    expect(
      byTestId('cloud-reach-back-unasked-create_issue').getAttribute(
        'aria-checked',
      ),
    ).toBe('false');
    act(() => byTestId('cloud-reach-back-allow').click());
    await flush();
    expect(allowed).toEqual([
      {
        enabledTools: ['list_issues', 'create_issue'],
        allowWithoutAsking: [],
      },
    ]);
  });

  it('runs without asking only the tools whose own box is ticked, and keeps choices across renders', async () => {
    act(() => byTestId('cloud-reach-back-open').click());
    await flush();
    act(() => byTestId('cloud-reach-back-unasked-list_issues').click());
    // The page renders again while the dialog is open.
    render();
    await flush();
    expect(loads).toBe(1);
    expect(
      byTestId('cloud-reach-back-unasked-list_issues').getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    act(() => byTestId('cloud-reach-back-allow').click());
    await flush();
    expect(allowed).toEqual([
      {
        enabledTools: ['list_issues', 'create_issue'],
        allowWithoutAsking: ['list_issues'],
      },
    ]);
  });

  it('says an allowed server is unreachable, and why, rather than just On', () => {
    act(() => {
      root.render(
        <CloudReachBackSection
          serverName="Tracker"
          state={{
            enabledTools: ['list_issues'],
            allowWithoutAsking: [],
            unreachable:
              'MCP proxy port 37645 is already in use. Choose another port.',
          }}
          loadTools={(): Promise<readonly CloudReachBackTool[]> =>
            Promise.resolve(TOOLS)
          }
          onAllow={(): Promise<void> => Promise.resolve()}
          onTurnOff={(): Promise<void> => Promise.resolve()}
          calls={[]}
        />,
      );
    });
    expect(byTestId('cloud-reach-back-state').textContent).toBe(
      'On, unreachable',
    );
    expect(byTestId('cloud-reach-back-unreachable').textContent).toContain(
      'MCP proxy port 37645 is already in use. Choose another port.',
    );
    // Reached again: the row reads as it did.
    act(() => {
      root.render(
        <CloudReachBackSection
          serverName="Tracker"
          state={{
            enabledTools: ['list_issues'],
            allowWithoutAsking: [],
            unreachable: null,
          }}
          loadTools={(): Promise<readonly CloudReachBackTool[]> =>
            Promise.resolve(TOOLS)
          }
          onAllow={(): Promise<void> => Promise.resolve()}
          onTurnOff={(): Promise<void> => Promise.resolve()}
          calls={[]}
        />,
      );
    });
    expect(byTestId('cloud-reach-back-state').textContent).toBe('On, 1 tool');
    expect(
      document.body.querySelector(
        '[data-testid="cloud-reach-back-unreachable"]',
      ),
    ).toBeNull();
  });
});

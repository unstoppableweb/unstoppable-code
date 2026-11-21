/** @jest-environment jsdom */
/**
 * The plugin picker's catalog load can fail (CAN-7473). A failed first load
 * shows the failure with Try again in place of the list, never the empty
 * state; a failed later load keeps the list the picker had under a banner
 * with Try again; and a retry that lands shows the list. An active search
 * never hides a failed first load. Each failure the open picker shows is
 * recorded once, and a retry still running records nothing. A load for a
 * scope the host has left never replaces the current scope's failure, and
 * only the latest load for a scope decides whether its failure shows and
 * when its Try again stops running.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SurfacedErrorInput } from '@canopy/protocol/app-errors';
import type {
  RemoteControlChatTabPluginSelections,
  RemoteControlPluginCatalog,
} from '@canopy/protocol/remote-control/shell';
import { setSurfacedErrorRecorder } from '@canopy/ui-shared/lib';
import { RemoteControlPluginsPicker } from '../RemoteControlPluginsPicker';
import {
  pluginCatalogFailureAfterLoad,
  pluginCatalogLoadingAfterLoad,
  type PluginCatalogLoadScope,
} from '../plugin-catalog-load-scope';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CATALOG: RemoteControlPluginCatalog = {
  collections: [],
  skills: [
    {
      sourceId: 'user',
      skillName: 'notes',
      name: 'notes',
      description: 'Take notes.',
      source: 'My skills',
    },
  ],
  plugins: [],
  mcpServers: [],
};

const NONE: RemoteControlChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
};

let container: HTMLDivElement;
let root: Root;
let recorded: SurfacedErrorInput[];
let uninstall: () => void;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  recorded = [];
  uninstall = setSurfacedErrorRecorder((input) => {
    recorded.push(input);
    return undefined;
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  uninstall();
});

function render(props: {
  catalog: RemoteControlPluginCatalog | null;
  loading?: boolean;
  loadError?: boolean;
  onRetryLoad?: () => void;
  loadFailureRecorded?: boolean;
}): void {
  act(() => {
    root.render(
      <RemoteControlPluginsPicker
        open
        hideTrigger
        catalog={props.catalog}
        selections={NONE}
        brandDisplayName="Canopy"
        onChange={(): Promise<void> => Promise.resolve()}
        loading={props.loading ?? false}
        loadError={props.loadError ?? false}
        {...(props.onRetryLoad === undefined
          ? {}
          : { onRetryLoad: props.onRetryLoad })}
        loadFailureRecorded={props.loadFailureRecorded ?? false}
      />,
    );
  });
}

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (): string => document.body.textContent ?? '';
const rowNames = (): string[] =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="unified-table"] tbody tr',
    ),
  ).map((row) => (row.textContent?.includes('notes') ? 'notes' : '?'));

describe('the plugin picker when its catalog load fails (CAN-7473)', () => {
  it('shows a failed first load with Try again in place of the list, never the empty state', () => {
    const retry = jest.fn();
    render({ catalog: null, loadError: true, onRetryLoad: retry });
    const state = byTestId('remote-control-plugins-load-error');
    expect({
      shown: state !== null,
      message: state?.textContent?.includes("Couldn't load plugins."),
      emptyCopy: text().includes('No plugins are available'),
      tableEmptyCopy: text().includes('No items available.'),
    }).toEqual({
      shown: true,
      message: true,
      emptyCopy: false,
      tableEmptyCopy: false,
    });
    act(() => byTestId('remote-control-plugins-load-retry')?.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('keeps the failure on screen while Try again runs, then shows the list once it lands', () => {
    render({ catalog: null, loadError: true, onRetryLoad: jest.fn() });
    render({
      catalog: null,
      loading: true,
      loadError: true,
      onRetryLoad: jest.fn(),
    });
    expect({
      stillShown: byTestId('remote-control-plugins-load-error') !== null,
      busy: byTestId('remote-control-plugins-load-retry')?.getAttribute(
        'aria-busy',
      ),
    }).toEqual({ stillShown: true, busy: 'true' });
    render({ catalog: CATALOG, onRetryLoad: jest.fn() });
    expect({
      error: byTestId('remote-control-plugins-load-error'),
      banner: byTestId('remote-control-plugins-reload-error'),
      rows: rowNames(),
    }).toEqual({ error: null, banner: null, rows: ['notes'] });
  });

  it('keeps the list it had under a banner with Try again when a later load fails', () => {
    const retry = jest.fn();
    render({ catalog: CATALOG, loadError: true, onRetryLoad: retry });
    const banner = byTestId('remote-control-plugins-reload-error');
    expect({
      banner: banner?.textContent?.includes(
        "Couldn't load the latest plugins.",
      ),
      firstLoadState: byTestId('remote-control-plugins-load-error'),
      rows: rowNames(),
    }).toEqual({ banner: true, firstLoadState: null, rows: ['notes'] });
    const tryAgain = Array.from(
      banner?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    ).find((button) => button.textContent?.includes('Try again'));
    act(() => tryAgain?.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('still says nothing is available for a load that worked and found nothing', () => {
    render({ catalog: null });
    expect({
      emptyCopy: text().includes('No plugins are available from Canopy.'),
      error: byTestId('remote-control-plugins-load-error'),
    }).toEqual({ emptyCopy: true, error: null });
  });

  it('records each failure it shows once, and nothing while a retry runs', () => {
    render({ catalog: null, loadError: true, onRetryLoad: jest.fn() });
    render({ catalog: null, loadError: true, onRetryLoad: jest.fn() });
    expect(recorded.map((input) => input.identifier)).toEqual([
      'remote-control-plugins-load',
    ]);
    render({
      catalog: null,
      loading: true,
      loadError: true,
      onRetryLoad: jest.fn(),
    });
    expect(recorded).toHaveLength(1);
    render({ catalog: null, loadError: true, onRetryLoad: jest.fn() });
    render({ catalog: CATALOG, loadError: true, onRetryLoad: jest.fn() });
    expect(
      recorded.map((input) => [
        input.identifier,
        input.chokePoint,
        input.text,
        input.textIsSensitive,
      ]),
    ).toEqual([
      [
        'remote-control-plugins-load',
        'notice',
        "Couldn't load plugins.",
        false,
      ],
      [
        'remote-control-plugins-load',
        'notice',
        "Couldn't load plugins.",
        false,
      ],
    ]);
  });

  it('offers no Save while nothing was read, and Save once a list is shown', () => {
    const save = (): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>(
        '[data-testid="remote-control-plugins-save"]',
      );
    render({ catalog: null, loadError: true, onRetryLoad: jest.fn() });
    const unread = save()?.disabled;
    render({ catalog: CATALOG, loadError: true, onRetryLoad: jest.fn() });
    expect({ unread, kept: save()?.disabled }).toEqual({
      unread: true,
      kept: false,
    });
  });

  it('shows the failed first load under an active search, and the filter message only for a list filtered to nothing', () => {
    render({ catalog: null, loadError: true, onRetryLoad: jest.fn() });
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search by name"]',
    );
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(search, 'zzz');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const unread = {
      error: byTestId('remote-control-plugins-load-error') !== null,
      retry: byTestId('remote-control-plugins-load-retry') !== null,
      filtered: byTestId('unified-table-filtered-empty') !== null,
    };
    render({ catalog: CATALOG, onRetryLoad: jest.fn() });
    expect({
      unread,
      read: {
        error: byTestId('remote-control-plugins-load-error') !== null,
        filtered: byTestId('unified-table-filtered-empty') !== null,
        search: search?.value,
      },
    }).toEqual({
      unread: { error: true, retry: true, filtered: false },
      read: { error: false, filtered: true, search: 'zzz' },
    });
  });

  it('records nothing itself when the host records the failed load', () => {
    render({
      catalog: null,
      loadError: true,
      onRetryLoad: jest.fn(),
      loadFailureRecorded: true,
    });
    expect({
      shown: byTestId('remote-control-plugins-load-error') !== null,
      recorded,
    }).toEqual({ shown: true, recorded: [] });
  });
});

describe("the host's catalog load outcome (CAN-7473)", () => {
  const scope = (worktreeLocalId: string): PluginCatalogLoadScope => ({
    client: 'computer',
    sessionId: 'chat',
    workspaceLocalId: 'workspace',
    worktreeLocalId,
  });

  it("never lets a scope the composer left replace the current scope's failure", () => {
    const left = scope('left');
    const current = scope('current');
    const failed = (
      of: PluginCatalogLoadScope,
    ): { scope: PluginCatalogLoadScope; failed: boolean } => ({
      scope: of,
      failed: true,
    });
    expect({
      stale: pluginCatalogFailureAfterLoad(
        current,
        failed(left),
        current,
        true,
      ),
      staleOverNothing: pluginCatalogFailureAfterLoad(
        null,
        failed(left),
        current,
        true,
      ),
      live: pluginCatalogFailureAfterLoad(null, failed(current), current, true),
    }).toEqual({ stale: current, staleOverNothing: null, live: current });
  });

  it('shows no failure when an older load fails after a newer one landed', () => {
    const current = scope('current');
    const shown = pluginCatalogFailureAfterLoad(
      null,
      { scope: current, failed: true },
      current,
      false,
    );
    render({
      catalog: CATALOG,
      loadError: shown !== null,
      onRetryLoad: jest.fn(),
    });
    expect({
      shown,
      banner: byTestId('remote-control-plugins-reload-error'),
      rows: rowNames(),
    }).toEqual({ shown: null, banner: null, rows: ['notes'] });
  });

  it('keeps the failure with Try again when an older load lands after a newer one failed', () => {
    const current = scope('current');
    const shown = pluginCatalogFailureAfterLoad(
      current,
      { scope: current, failed: false },
      current,
      false,
    );
    render({
      catalog: null,
      loadError: shown !== null,
      onRetryLoad: jest.fn(),
    });
    expect({
      shown,
      error: byTestId('remote-control-plugins-load-error') !== null,
      retry: byTestId('remote-control-plugins-load-retry') !== null,
      cleared: pluginCatalogFailureAfterLoad(
        current,
        { scope: current, failed: false },
        current,
        true,
      ),
    }).toEqual({ shown: current, error: true, retry: true, cleared: null });
  });

  it('keeps Trying again on when an older load settles while a newer one runs', () => {
    const loading = pluginCatalogLoadingAfterLoad(true, false);
    render({
      catalog: null,
      loading,
      loadError: true,
      onRetryLoad: jest.fn(),
    });
    expect({
      loading,
      busy: byTestId('remote-control-plugins-load-retry')?.getAttribute(
        'aria-busy',
      ),
      settled: pluginCatalogLoadingAfterLoad(true, true),
    }).toEqual({ loading: true, busy: 'true', settled: false });
  });
});

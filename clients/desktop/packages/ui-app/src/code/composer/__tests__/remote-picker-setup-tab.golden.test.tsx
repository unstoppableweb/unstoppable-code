/** @jest-environment jsdom */
/**
 * Harness setup from a remote controller (CAN-6718): a managed provider the
 * controlled computer reports with a setup reason but no model rows keeps
 * its picker tab, with the reason and Check again, even when no row
 * advertises harness choices.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelCatalog } from '@canopy/protocol/models';
import { RemoteControlModelPicker } from '../RemoteControlModelPicker';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** One Claude row and no `harnessChoices`, as a host with one runtime sends. */
const CATALOG: ModelCatalog = [
  {
    id: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    provider: 'claude',
    source: 'claude',
    kind: 'model',
    available: true,
  },
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('shows a setup-only provider’s tab without harness choices', async () => {
  const onRefreshModels = jest.fn();
  // The menu opens when `openSignal` changes, as a host shortcut does.
  const render = (openSignal: number): void =>
    root.render(
      <RemoteControlModelPicker
        catalog={CATALOG}
        currentModel="claude-sonnet-4-5"
        providerAvailability={{
          claude: true,
          cursor: false,
          setup: { cursor: 'unsupported_host' },
        }}
        openSignal={openSignal}
        onSelect={jest.fn()}
        onRefreshModels={onRefreshModels}
      />,
    );
  await act(async () => {
    render(0);
    await Promise.resolve();
  });
  await act(async () => {
    render(1);
    await Promise.resolve();
  });
  const tab = document.querySelector<HTMLElement>(
    '[data-testid="remote-control-chat-model-harness-tab-cursor"]',
  );
  expect(tab).not.toBeNull();
  act(() => tab?.click());
  expect(document.body.textContent).toContain(
    "Cursor isn't available for the paired computer's operating system yet.",
  );
  expect(
    document.querySelector(
      '[data-testid="remote-control-chat-model-harness-tab-claude"]',
    ),
  ).not.toBeNull();
});

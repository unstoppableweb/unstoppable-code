/** @jest-environment jsdom */
/**
 * The Antigravity Settings card shows whether the managed Antigravity CLI,
 * the user's own copy or none is installed, installs the managed runtime with
 * progress and cancel, and refreshes Google models once it is installed.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AntigravityRuntimeStatus } from '@canopy/desktop-shared/types/antigravity-runtime';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOT_INSTALLED: AntigravityRuntimeStatus = {
  supported: true,
  installed: false,
  managed: false,
  version: '1.5.1',
  phase: 'idle',
};
const MANAGED: AntigravityRuntimeStatus = {
  supported: true,
  installed: true,
  managed: true,
  version: '1.5.1',
  executable: '/data/antigravity-runtime/1.5.1/antigravity',
  phase: 'installed',
};

function snapshot(antigravity: Array<{ id: string }>): unknown {
  return { claude: [], codex: [], ollama: [], aliases: {}, antigravity };
}

interface Deferred {
  resolve: (status: AntigravityRuntimeStatus) => void;
}

let root: Root;
let container: HTMLDivElement;
let progress: (status: AntigravityRuntimeStatus) => void = () => undefined;
let pending: Deferred | undefined;
let install: jest.Mock<Promise<AntigravityRuntimeStatus>, [string]>;
let cancel: jest.Mock<Promise<void>, [string]>;
let getModelRegistry: jest.Mock<Promise<unknown>, [unknown]>;
let savePreferences: jest.Mock<Promise<unknown>, [unknown]>;

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (element) => element.textContent?.trim() === text,
  );
}

function button(text: string): HTMLButtonElement {
  const match = buttonWithText(text);
  if (!match) throw new Error(`Missing button ${text}`);
  return match;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function renderCard(status: AntigravityRuntimeStatus): Promise<void> {
  install = jest.fn<Promise<AntigravityRuntimeStatus>, [string]>(
    () =>
      new Promise<AntigravityRuntimeStatus>((resolve) => {
        pending = { resolve };
      }),
  );
  cancel = jest.fn<Promise<void>, [string]>(() => {
    pending?.resolve(NOT_INSTALLED);
    return Promise.resolve();
  });
  getModelRegistry = jest.fn<Promise<unknown>, [unknown]>(() =>
    Promise.resolve(snapshot([])),
  );
  savePreferences = jest.fn<Promise<unknown>, [unknown]>(() =>
    Promise.resolve({ googleSubscriptionDisconnected: true }),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: (): Promise<unknown> => Promise.resolve({}),
      onPreferencesSynced: (): (() => void) => () => undefined,
      getModelRegistry,
      savePreferences,
      antigravityRuntime: {
        status: (): Promise<AntigravityRuntimeStatus> =>
          Promise.resolve(status),
        install,
        cancel,
        onProgress: (callback: (value: AntigravityRuntimeStatus) => void) => {
          progress = callback;
          return (): void => undefined;
        },
      },
    },
  });
  const { GoogleSubscriptionConnection } =
    await import('../GoogleSubscriptionConnection');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<GoogleSubscriptionConnection />);
  });
  await flush();
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  pending = undefined;
});

it('shows not installed with an Install button', async () => {
  await renderCard(NOT_INSTALLED);
  expect(container.textContent).toContain(
    'Antigravity CLI 1.5.1: not installed',
  );
  expect(buttonWithText('Install managed 1.5.1')).toBeDefined();
});

it('shows installed managed after a successful install and refreshes models', async () => {
  await renderCard(NOT_INSTALLED);
  act(() => button('Install managed 1.5.1').click());
  await flush();
  expect(install).toHaveBeenCalledTimes(1);
  expect(buttonWithText('Install managed 1.5.1')).toBeUndefined();
  expect(container.textContent).toContain('Downloading…');
  expect(buttonWithText('Cancel')).toBeDefined();
  act(() => progress({ ...NOT_INSTALLED, phase: 'verifying' }));
  expect(container.textContent).toContain('Verifying…');
  expect(getModelRegistry).not.toHaveBeenCalled();

  act(() => pending?.resolve(MANAGED));
  await flush();
  expect(container.textContent).toContain(
    'Antigravity CLI 1.5.1: installed (managed)',
  );
  expect(buttonWithText('Install managed 1.5.1')).toBeUndefined();
  expect(buttonWithText('Cancel')).toBeUndefined();
  expect(getModelRegistry).toHaveBeenCalledWith({ probe: true });
});

it('shows your own copy with the path and still offers Install', async () => {
  await renderCard({
    ...NOT_INSTALLED,
    installed: true,
    executable: '/opt/homebrew/bin/agy',
    phase: 'installed',
  });
  expect(container.textContent).toContain(
    'Antigravity CLI: your own copy at /opt/homebrew/bin/agy (version checked at launch)',
  );
  expect(buttonWithText('Install managed 1.5.1')).toBeDefined();
});

it('cancel returns the card to not installed', async () => {
  await renderCard(NOT_INSTALLED);
  act(() => button('Install managed 1.5.1').click());
  await flush();
  const operationId = install.mock.calls[0]?.[0];
  act(() => button('Cancel').click());
  await flush();
  expect(cancel).toHaveBeenCalledWith(operationId);
  expect(container.textContent).toContain(
    'Antigravity CLI 1.5.1: not installed',
  );
  expect(container.textContent).not.toContain('Downloading…');
  expect(buttonWithText('Cancel')).toBeUndefined();
  expect(buttonWithText('Install managed 1.5.1')).toBeDefined();
  expect(getModelRegistry).not.toHaveBeenCalled();

  // Install again after a cancel starts a fresh operation.
  act(() => button('Install managed 1.5.1').click());
  await flush();
  expect(install).toHaveBeenCalledTimes(2);
  expect(install.mock.calls[1]?.[0]).not.toBe(operationId);
});

it('shows the error and the Install button after a failed install', async () => {
  await renderCard(NOT_INSTALLED);
  act(() => button('Install managed 1.5.1').click());
  await flush();
  act(() =>
    pending?.resolve({
      ...NOT_INSTALLED,
      phase: 'failed',
      error: 'Antigravity download was truncated. Try again.',
    }),
  );
  await flush();
  expect(container.textContent).toContain(
    'Antigravity download was truncated. Try again.',
  );
  expect(buttonWithText('Install managed 1.5.1')).toBeDefined();
  expect(getModelRegistry).not.toHaveBeenCalled();
});

it('hides Install when unsupported', async () => {
  await renderCard({ ...NOT_INSTALLED, supported: false });
  expect(buttonWithText('Install managed 1.5.1')).toBeUndefined();
});

it('keeps the refresh and disconnect controls', async () => {
  const { useModelCatalogStore } = await import('@/stores/modelCatalogStore');
  const models = snapshot([{ id: 'gemini-3-pro' }]);
  act(() => {
    useModelCatalogStore.getState().hydrate(models as never);
  });
  await renderCard(MANAGED);
  getModelRegistry.mockResolvedValue(models);
  act(() => button('Refresh models').click());
  await flush();
  expect(getModelRegistry).toHaveBeenCalledWith({ probe: true });
  const disconnect = Array.from(container.querySelectorAll('button')).find(
    (element) => element.textContent?.startsWith('Disconnect from'),
  );
  act(() => disconnect?.click());
  await flush();
  expect(savePreferences).toHaveBeenCalledWith({
    googleSubscriptionDisconnected: true,
  });
});

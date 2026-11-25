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

it('a window showing another computer never installs on this one', async () => {
  const { useRemoteControlStore } = await import('@/stores/remoteControlStore');
  useRemoteControlStore.setState({
    context: {
      mode: 'remote',
      deviceId: 'linux-host',
      name: 'Linux workstation',
      platform: 'linux',
    },
  });
  try {
    await renderCard(NOT_INSTALLED);
    expect(buttonWithText('Install managed 1.5.1')).toBeUndefined();
    expect(
      container.querySelector(
        '[data-testid="antigravity-runtime-remote-install"]',
      )?.textContent,
    ).toMatch(/Install it from Settings on the computer you.re controlling/);
    expect(install).not.toHaveBeenCalled();
  } finally {
    useRemoteControlStore.setState({ context: { mode: 'local' } });
  }
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
  act(() => button('Disconnect Antigravity').click());
  await flush();
  expect(savePreferences).toHaveBeenCalledWith({
    googleSubscriptionDisconnected: true,
  });
});

// Google chats show only where main pins a CLI for the host. The picker and
// the Settings rows ask main a manifest-only question (host support), only
// once Google chats are switched on, and never the runtime status, which can
// resolve and hash the executable. The setup card alone reads the status.
const ANTIGRAVITY_FLAGS = {
  harness: 'canopy-desktop-antigravity-harness',
  released: 'canopy-desktop-antigravity-harness-released',
} as const;

/** Every window.api path a mount calls, in order. */
let apiCalls: string[] = [];

/**
 * A window.api that records every call. Paths in `answers` get real results;
 * any other method returns a promise that never settles (subscriptions return
 * an unsubscribe), so unrelated sections stay loading instead of failing.
 */
function recordingApi(
  answers: Record<string, (...args: unknown[]) => unknown>,
  path = 'api',
): unknown {
  const call = (...args: unknown[]): unknown => {
    apiCalls.push(path);
    const answer = answers[path];
    if (answer) return answer(...args);
    const name = path.split('.').at(-1) ?? '';
    return /^on[A-Z]/.test(name)
      ? (): void => undefined
      : new Promise<never>(() => undefined);
  };
  return new Proxy(call, {
    get: (_target, key): unknown =>
      key === 'then'
        ? undefined
        : recordingApi(answers, `${path}.${String(key)}`),
  });
}

async function mountWithApi(
  platform: NodeJS.Platform,
  flags: { harness: boolean; released: boolean },
  answers: Record<string, (...args: unknown[]) => unknown>,
  render: () => Promise<React.JSX.Element>,
): Promise<void> {
  apiCalls = [];
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: platform,
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: recordingApi(answers),
  });
  const { useFeatureFlagsStore } = await import('@/stores/featureFlagsStore');
  useFeatureFlagsStore.setState({
    isEnabled: (key) =>
      (key === ANTIGRAVITY_FLAGS.harness && flags.harness) ||
      (key === ANTIGRAVITY_FLAGS.released && flags.released),
  });
  const element = await render();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(element);
  });
  await flush();
}

const runtimeCalls = (): string[] =>
  apiCalls.filter((path) => path.startsWith('api.antigravityRuntime.'));

async function picker(): Promise<React.JSX.Element> {
  const { ModelPicker } = await import('../../chat/ModelPicker');
  return (
    <ModelPicker
      currentModel="claude-opus-4-1"
      onModelChange={(): void => undefined}
      allowAntigravity
    />
  );
}

async function labs(): Promise<React.JSX.Element> {
  const { ExperimentsTab } = await import('../ExperimentsTab');
  return <ExperimentsTab />;
}

beforeAll(() => {
  // The composer mounts a terminal surface jsdom can't paint.
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

it('a picker mount with Google chats off asks main nothing about Antigravity', async () => {
  await mountWithApi(
    'linux',
    { harness: false, released: false },
    { 'api.antigravityRuntime.hostSupported': () => Promise.resolve(true) },
    picker,
  );
  expect(runtimeCalls()).toEqual([]);
});

it('a picker mount with Google chats on reads host support, never the runtime status', async () => {
  await mountWithApi(
    'linux',
    { harness: true, released: true },
    {
      'api.antigravityRuntime.hostSupported': () => Promise.resolve(true),
      'api.antigravityRuntime.status': () => Promise.resolve(NOT_INSTALLED),
    },
    picker,
  );
  expect(runtimeCalls()).toEqual(['api.antigravityRuntime.hostSupported']);
});

it.each([
  ['linux', true, true],
  ['linux', false, false],
  ['darwin', true, true],
] as const)(
  'Settings › Labs on %s with host support %p shows the Google card: %p',
  async (platform, supported, shown) => {
    await mountWithApi(
      platform,
      { harness: true, released: false },
      {
        'api.antigravityRuntime.hostSupported': () =>
          Promise.resolve(supported),
        'api.antigravityRuntime.status': () =>
          Promise.resolve({ ...NOT_INSTALLED, supported }),
        'api.antigravityRuntime.onProgress': () => (): void => undefined,
        'api.onPreferencesSynced': () => (): void => undefined,
        'api.loadPreferences': () => Promise.resolve({}),
      },
      labs,
    );
    expect(
      container.querySelector('[data-testid="antigravity-runtime"]') !== null,
    ).toBe(shown);
    // Only the card itself reads the full status, and only when it shows.
    expect(runtimeCalls().includes('api.antigravityRuntime.status')).toBe(
      shown,
    );
  },
);

it('Settings › Labs on Windows shows no Google card and never asks main', async () => {
  await mountWithApi(
    'win32',
    { harness: true, released: false },
    { 'api.antigravityRuntime.hostSupported': () => Promise.resolve(true) },
    labs,
  );
  expect(container.querySelector('[data-testid="antigravity-runtime"]')).toBe(
    null,
  );
  expect(runtimeCalls()).toEqual([]);
});

// A host older than the host-support channel refuses it. Such a host
// predates Linux support: a macOS one reports supported, a Linux one doesn't.
it.each([
  ['darwin', true],
  ['linux', false],
] as const)(
  'controlling an older %s host follows its status: supported %p',
  async (platform, supported) => {
    await mountWithApi(
      platform,
      { harness: true, released: false },
      {
        // The text an older host sends, as a desktop remote window gets it.
        'api.antigravityRuntime.hostSupported': () =>
          Promise.reject(
            new Error(
              'Error invoking remote method \'antigravity-runtime:host-support\': Error: "antigravity-runtime:host-support" is not available while controlling another computer.',
            ),
          ),
        'api.antigravityRuntime.status': () =>
          Promise.resolve({ ...NOT_INSTALLED, supported }),
        'api.antigravityRuntime.onProgress': () => (): void => undefined,
        'api.onPreferencesSynced': () => (): void => undefined,
        'api.loadPreferences': () => Promise.resolve({}),
      },
      labs,
    );
    expect(
      container.querySelector('[data-testid="antigravity-runtime"]') !== null,
    ).toBe(supported);
    // The fallback reads status right after the refusal; a shown card reads
    // it once more for itself.
    expect(runtimeCalls().slice(0, 2)).toEqual([
      'api.antigravityRuntime.hostSupported',
      'api.antigravityRuntime.status',
    ]);
    expect(
      runtimeCalls().filter((call) => call === 'api.antigravityRuntime.status'),
    ).toHaveLength(supported ? 2 : 1);
  },
);

it('any other host-support failure hides the Google card without a status read', async () => {
  await mountWithApi(
    'linux',
    { harness: true, released: false },
    {
      'api.antigravityRuntime.hostSupported': () =>
        Promise.reject(new Error('Antigravity setup window is unavailable.')),
      'api.antigravityRuntime.status': () => Promise.resolve(NOT_INSTALLED),
    },
    labs,
  );
  expect(container.querySelector('[data-testid="antigravity-runtime"]')).toBe(
    null,
  );
  expect(runtimeCalls()).toEqual(['api.antigravityRuntime.hostSupported']);
});

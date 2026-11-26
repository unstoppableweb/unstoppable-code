/** @jest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  TerminalPreset,
  TerminalSettings,
} from '@canopy/desktop-shared/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const presetA: TerminalPreset = {
  id: 'a',
  name: 'Preset A',
  terminalProfileId: 'zsh',
  command: 'echo a',
  enabled: true,
};
const presetB: TerminalPreset = { ...presetA, id: 'b', name: 'Preset B' };
const settings: TerminalSettings = {
  revision: 4,
  disabledTerminalShellProfileIds: [],
  terminalPresets: [presetA],
};
let root: Root;
let container: HTMLDivElement;

function button(testId: string): HTMLButtonElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLButtonElement))
    throw new Error(`Missing button ${testId}`);
  return element;
}

async function mount(
  getSettings: jest.Mock,
  updateSettings: jest.Mock,
  beforeRender?: () => void,
): Promise<{ savePreferences: jest.Mock }> {
  const savePreferences = jest.fn();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      terminal: {
        listProfiles: jest
          .fn()
          .mockResolvedValue([{ id: 'zsh', label: 'zsh', isDefault: true }]),
        getSettings,
        updateSettings,
      },
      loadPreferences: jest.fn().mockRejectedValue(new Error('unavailable')),
      savePreferences,
    },
  });
  beforeRender?.();
  const { TerminalTab } = await import('../TerminalTab');
  await act(async () => {
    root.render(<TerminalTab />);
    await Promise.resolve();
  });
  return { savePreferences };
}

describe('Terminal settings in every window (CAN-4148)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('react', () => React);
    jest.doMock('@/hooks/useTerminalPresetColorMode', () => ({
      useTerminalPresetColorMode: (): string => 'light',
    }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it('never saves when Terminal settings could not be loaded', async () => {
    const updateSettings = jest.fn();
    const { savePreferences } = await mount(
      jest.fn().mockRejectedValue(new Error('unavailable')),
      updateSettings,
    );
    expect(container.textContent).toContain("Couldn't load Terminal settings.");
    const shell = button('terminal-shell-toggle-zsh');
    expect(shell.disabled).toBe(true);
    expect(button('terminal-preset-add').disabled).toBe(true);
    await act(async () => {
      shell.click();
      await Promise.resolve();
    });
    expect(updateSettings).not.toHaveBeenCalled();
    expect(savePreferences).not.toHaveBeenCalled();
  });

  it('saves at the loaded revision and shows newer settings after a conflict', async () => {
    const message =
      'Terminal settings changed in another window. Review them and try again.';
    const updateSettings = jest.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'conflict',
        message,
        settings: { ...settings, revision: 5, terminalPresets: [presetB] },
      },
    });
    await mount(jest.fn().mockResolvedValue(settings), updateSettings);
    await act(async () => {
      button('terminal-shell-toggle-zsh').click();
      await Promise.resolve();
    });
    expect(updateSettings).toHaveBeenCalledWith({
      expectedRevision: 4,
      disabledTerminalShellProfileIds: ['zsh'],
      terminalPresets: [presetA],
      idempotencyKey: expect.any(String) as unknown,
    });
    expect(
      container.querySelector('[data-testid="terminal-preset-b"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="terminal-preset-a"]'),
    ).toBeNull();
    expect(container.textContent).toContain(message);
  });
  it('keeps saved settings cached when older independent reads resolve late', async () => {
    const cache = await import('@/lib/terminalShellProfiles');
    let releasePrefetch: (value: TerminalSettings) => void = () => {
      throw new Error('Prefetch not started');
    };
    let releaseFetch: (value: TerminalSettings) => void = () => {
      throw new Error('Fetch not started');
    };
    const prefetch = new Promise<TerminalSettings>((resolve) => {
      releasePrefetch = resolve;
    });
    const fetch = new Promise<TerminalSettings>((resolve) => {
      releaseFetch = resolve;
    });
    const saved = {
      ...settings,
      revision: 5,
      disabledTerminalShellProfileIds: ['zsh' as const],
      terminalPresets: [presetB],
    };
    const getSettings = jest
      .fn()
      .mockReturnValueOnce(prefetch)
      .mockReturnValueOnce(fetch)
      .mockResolvedValue(settings);
    let pendingPrefetch: Promise<unknown> | undefined;
    let pendingFetch: Promise<unknown> | undefined;
    await mount(
      getSettings,
      jest.fn().mockResolvedValue({ ok: true, settings: saved }),
      () => {
        pendingPrefetch = cache.loadTerminalPanelPreferences();
        pendingFetch = cache.fetchTerminalPanelPreferences();
      },
    );
    await act(async () => {
      button('terminal-shell-toggle-zsh').click();
      await Promise.resolve();
    });
    expect(cache.getCachedTerminalPanelPreferences()).toEqual(saved);
    releasePrefetch(settings);
    releaseFetch(settings);
    await Promise.all([pendingPrefetch, pendingFetch]);
    expect(cache.getCachedTerminalPanelPreferences()).toEqual(saved);
  });
});

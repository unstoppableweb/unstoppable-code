/** @jest-environment jsdom */
import '../../../cloud-chats/__tests__/jsdom-globals';
import { act } from 'react';
import { createAppError } from '@canopy/protocol/app-errors';
import { createRoot, type Root } from 'react-dom/client';
import { AppAdvisorSettingsModal } from '../AppAdvisorSettingsModal';

// CAN-5117: a failed Orchestrator settings save shows the shared error banner
// above Save, never the raw IPC text. A full disk tells the person to free
// space; any other failure leads with our own sentence, the raw reason behind
// Copy details.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const saveClaudeMd = jest.fn<Promise<void>, [string]>();

function ipcRejection(message: string): Error {
  return new Error(
    `Error invoking remote method 'app-advisor:save-claude-md': Error: ${message}`,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('AppAdvisorSettingsModal save failure (CAN-5117)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    saveClaudeMd.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: () => Promise.reject(new Error('not needed')),
        appAdvisor: {
          loadClaudeMd: () => Promise.resolve('Be brief.'),
          saveClaudeMd,
          settingsLoad: () => Promise.resolve({}),
          settingsSave: jest.fn(),
        },
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function saveEditedInstructions(): Promise<HTMLElement> {
    act(() =>
      root.render(<AppAdvisorSettingsModal onClose={() => undefined} />),
    );
    await flush();
    const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(
      (element) => element.textContent === 'Instructions',
    );
    if (!(tab instanceof HTMLElement)) throw new Error('no Instructions tab');
    act(() => tab.click());
    await flush();
    const editor = document.querySelector(
      '[data-testid="app-advisor-settings-claude-md"]',
    );
    if (!(editor instanceof HTMLTextAreaElement)) throw new Error('no editor');
    // React tracks the native value setter; call it with the editor as
    // receiver, then fire the input event React listens to.
    act(() => {
      Reflect.set(
        HTMLTextAreaElement.prototype,
        'value',
        'Be brief. Keep replies short.',
        editor,
      );
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = document.querySelector(
      '[data-testid="app-advisor-settings-save"]',
    );
    if (!(save instanceof HTMLElement)) throw new Error('no Save button');
    act(() => save.click());
    await flush();
    const banner = document.querySelector(
      '[data-testid="app-advisor-settings-save-error"]',
    );
    if (!(banner instanceof HTMLElement)) throw new Error('no error banner');
    return banner;
  }

  it('tells the person to free disk space when the disk is full', async () => {
    saveClaudeMd.mockRejectedValue(
      ipcRejection("ENOSPC: no space left on device, write '/data/CLAUDE.md'"),
    );
    const banner = await saveEditedInstructions();
    expect(saveClaudeMd).toHaveBeenCalledWith('Be brief. Keep replies short.');
    expect(banner.textContent).toContain("There isn't enough disk space.");
    expect(banner.textContent).not.toContain('Error invoking remote method');
  });

  it('keeps a failure main already recorded, with its reference', async () => {
    // What preload restores for a main-side failure: the structured error
    // main recorded, not a string.
    const recorded = {
      ...createAppError('app.unexpected', {
        detail: { name: 'Error', message: 'write failed' },
      }),
      recordedBy: 'main',
    };
    saveClaudeMd.mockRejectedValue(recorded);
    const banner = await saveEditedInstructions();
    expect(banner.textContent).toContain(recorded.copy.title);
    expect(banner.textContent).toContain(recorded.referenceId);
    expect(banner.textContent).not.toContain("Couldn't save the settings.");
  });

  it('leads with our sentence for any other failure', async () => {
    saveClaudeMd.mockRejectedValue(
      ipcRejection("EACCES: permission denied, open '/data/CLAUDE.md'"),
    );
    const banner = await saveEditedInstructions();
    expect(banner.textContent).toContain(
      "Couldn't save the settings. Try again.",
    );
    expect(banner.textContent).not.toContain('EACCES');
    expect(banner.textContent).toContain('Copy details');
  });
});

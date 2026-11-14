import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerAppWindowHandlers } from '../app-window';

type Handler = (event: { sender: Contents }) => void;
const mockHandlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    mockHandlers.set(channel, handler);
  },
}));

let mockFocused: Contents | null = null;
jest.mock('electron', () => ({
  app: {},
  webContents: { getFocusedWebContents: (): Contents | null => mockFocused },
}));
jest.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
jest.mock('@canopy/execution-engine/pipelines/config-paths', () => ({
  restoreStartupEnvironmentForRelaunch: jest.fn(),
}));

interface Contents {
  isDestroyed: () => boolean;
  showDefinitionForSelection: jest.Mock;
  mainFrame: { frameToken: string };
  opener: { frameToken: string; top: { frameToken: string } | null } | null;
}

function contents(token: string, openedBy: string | null = null): Contents {
  return {
    isDestroyed: (): boolean => false,
    showDefinitionForSelection: jest.fn(),
    mainFrame: { frameToken: token },
    opener:
      openedBy === null
        ? null
        : { frameToken: openedBy, top: { frameToken: openedBy } },
  };
}

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

describe('app-window:look-up-selection native presentation boundary', () => {
  const main = contents('main');
  const pullOut = contents('pull-out', 'main');
  const otherWindow = contents('other');

  beforeEach(() => {
    mockHandlers.clear();
    mockFocused = null;
    for (const target of [main, pullOut, otherWindow]) {
      target.showDefinitionForSelection.mockClear();
    }
    registerAppWindowHandlers(() => undefined);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  function lookUp(sender: Contents): void {
    const handler = mockHandlers.get(IPC_CHANNELS.appWindowLookUpSelection);
    if (!handler) throw new Error('Missing look-up-selection handler');
    handler({ sender });
  }

  it('shows the macOS dictionary in the sender, or the pull-out it opened that has focus', () => {
    setPlatform('darwin');
    lookUp(main);
    expect(main.showDefinitionForSelection).toHaveBeenCalledTimes(1);

    mockFocused = pullOut;
    lookUp(main);
    expect(pullOut.showDefinitionForSelection).toHaveBeenCalledTimes(1);
    expect(main.showDefinitionForSelection).toHaveBeenCalledTimes(1);
  });

  it('never looks up in a focused window the sender did not open', () => {
    setPlatform('darwin');
    mockFocused = otherWindow;
    lookUp(main);
    expect(otherWindow.showDefinitionForSelection).not.toHaveBeenCalled();
    expect(main.showDefinitionForSelection).toHaveBeenCalledTimes(1);
  });

  it.each<NodeJS.Platform>(['win32', 'linux'])(
    'does nothing on %s, which has no system lookup',
    (platform) => {
      setPlatform(platform);
      mockFocused = pullOut;
      lookUp(main);
      expect(main.showDefinitionForSelection).not.toHaveBeenCalled();
      expect(pullOut.showDefinitionForSelection).not.toHaveBeenCalled();
    },
  );
});

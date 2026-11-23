import type * as AccountStoreModule from '../../lib/canopy-cloud-account-store';

jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
  safeStorage: {
    isEncryptionAvailable: (): boolean => true,
    getSelectedStorageBackend: (): string => 'keychain',
  },
}));

const mockCalls: unknown[] = [];
function mockRecord(name: string): (...args: unknown[]) => Promise<object> {
  return (...args) => {
    mockCalls.push([name, ...args]);
    return Promise.resolve({ from: name });
  };
}
jest.mock('../../ipc/settings', () => ({
  validateCanopyCloudApiKeyForWindow: mockRecord('validate'),
  saveCanopyCloudApiKeyForWindow: mockRecord('save'),
  disconnectCanopyCloudAccount: mockRecord('disconnect'),
  startCanopyCloudOAuthLoginForWindow: mockRecord('startOAuth'),
  cancelCanopyCloudOAuthLoginForWindow: mockRecord('cancelOAuth'),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  ...jest.requireActual<typeof AccountStoreModule>(
    '../../lib/canopy-cloud-account-store',
  ),
  loadCanopyCloudAccountPublicState: mockRecord('load'),
}));
const mockRemote = {
  allowIncoming: false,
  refusal: null as Error | null,
};
function mockRemoteState(): object {
  return {
    available: true,
    signedIn: true,
    allowIncoming: mockRemote.allowIncoming,
  };
}
jest.mock('../../remote-control/electron-remote-control', () => ({
  getRemoteControlRuntime: (): object => ({
    service: {
      getState: (...args: unknown[]): Promise<object> => {
        mockCalls.push(['remoteGetState', ...args]);
        return Promise.resolve(mockRemoteState());
      },
      setAllowIncoming: (allow: boolean): Promise<object> => {
        mockCalls.push(['remoteSetAllowIncoming', allow]);
        if (mockRemote.refusal) return Promise.reject(mockRemote.refusal);
        mockRemote.allowIncoming = allow;
        return Promise.resolve(mockRemoteState());
      },
    },
  }),
}));
jest.mock('../../ipc/opencode-connection', () => ({
  runOpenCodeConnectionForWindow: mockRecord('openCode'),
}));
jest.mock('../../ipc/ollama', () => ({
  installOllamaForWindow: mockRecord('installOllama'),
}));

import { toPublicCanopyCloudAccountState } from '../../lib/canopy-cloud-account-store';
import { dispatchAdvisorCredentialAction } from '../advisor-credential-actions';
import { mainAdvisorCredentialActionHost } from '../advisor-credential-actions-host';

const SECRET = 'sk-live-0123456789abcdefSECRET';
const mainWindow = { isDestroyed: (): boolean => false };
const getMainWindow = jest.fn(() => mainWindow as never);

function host(): ReturnType<typeof mainAdvisorCredentialActionHost> {
  return mainAdvisorCredentialActionHost({
    getMainWindow,
    revealOllamaSettings: () => Promise.resolve(),
  });
}

beforeEach(() => {
  mockCalls.length = 0;
  mockRemote.allowIncoming = false;
  mockRemote.refusal = null;
});

describe('App Advisor credential action host (CAN-6008)', () => {
  it("calls the owners the window's Settings handlers call", async () => {
    const h = host();
    const signal = new AbortController().signal;
    await h.loadCloudAccount();
    await h.validateCloudApiKey({ apiKey: SECRET });
    await h.saveCloudApiKey({ apiKey: SECRET });
    await h.clearCloudApiKey();
    await h.startCloudOAuthLogin();
    await h.cancelCloudOAuthLogin();
    await h.disconnectCloudAccount();
    await h.remoteControl()?.getState();
    await h.remoteControl()?.setAllowIncoming(true);
    await h.openCode('connect', signal);
    await h.installOllama();

    expect(mockCalls).toEqual([
      ['load'],
      ['validate', { apiKey: SECRET }],
      ['save', { apiKey: SECRET }],
      ['disconnect'],
      ['startOAuth'],
      ['cancelOAuth'],
      ['disconnect'],
      ['remoteGetState', { discover: false }],
      ['remoteSetAllowIncoming', true],
      ['openCode', mainWindow, 'connect', signal],
      ['installOllama', getMainWindow],
    ]);
  });

  it('turns Allow incoming on and off with remote_control.set_allow_incoming (CAN-5986)', async () => {
    const h = host();
    await expect(
      dispatchAdvisorCredentialAction(
        { type: 'remote_control.set_allow_incoming', enabled: true },
        h,
      ),
    ).resolves.toEqual({ ok: true, result: { allowIncoming: true } });
    await expect(
      dispatchAdvisorCredentialAction(
        { type: 'remote_control.set_allow_incoming', enabled: false },
        h,
      ),
    ).resolves.toEqual({ ok: true, result: { allowIncoming: false } });
    expect(mockCalls).toEqual([
      ['remoteGetState', { discover: false }],
      ['remoteSetAllowIncoming', true],
      ['remoteGetState', { discover: false }],
      ['remoteSetAllowIncoming', false],
    ]);
  });

  it("answers a Remote Control refusal as the action's error", async () => {
    mockRemote.refusal = new Error('Sign in before allowing incoming control.');
    await expect(
      dispatchAdvisorCredentialAction(
        { type: 'remote_control.set_allow_incoming', enabled: true },
        host(),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Sign in before allowing incoming control.',
      },
    });
    expect(mockRemote.allowIncoming).toBe(false);
  });

  it('refuses OpenCode without a live main window', async () => {
    getMainWindow.mockReturnValueOnce(null as never);
    await expect(host().openCode('status')).rejects.toThrow(
      'OpenCode connection is unavailable on this surface.',
    );
    expect(mockCalls).toEqual([]);
  });

  it('the account state the Canopy Cloud actions answer never carries the stored key', () => {
    const state = toPublicCanopyCloudAccountState({
      apiKey: SECRET,
      authMode: 'api_key',
      credentialSource: 'manual',
      capabilities: [],
      organizations: [],
      teams: [],
      createdAt: '2026-11-09T00:00:00.000Z',
      updatedAt: '2026-11-09T00:00:00.000Z',
    } as unknown as Parameters<typeof toPublicCanopyCloudAccountState>[0]);
    expect(state.hasApiKey).toBe(true);
    expect(JSON.stringify(state)).not.toContain(SECRET);
  });
});

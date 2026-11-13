jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockCalls: Array<{
  kind: 'query' | 'instruction';
  name: string;
  params: unknown;
  options: {
    caller: { principalId: string; clientInstanceId: string; grants: string[] };
    metadata?: { idempotencyKey: string };
  };
}> = [];
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({
    query: (name: string, params: unknown, options: never): Promise<object> => {
      mockCalls.push({ kind: 'query', name, params, options });
      return Promise.resolve({ namespace: 'agent', revision: 3, value: {} });
    },
    instruction: (
      name: string,
      params: unknown,
      options: never,
    ): Promise<object> => {
      mockCalls.push({ kind: 'instruction', name, params, options });
      return Promise.resolve({ namespace: 'agent', revision: 4, value: {} });
    },
  }),
}));
const mockLaunch: boolean[] = [];
jest.mock('../../ipc/launch-at-login', () => ({
  handleSetLaunchAtLoginEnabled: (enabled: boolean): Promise<object> => {
    mockLaunch.push(enabled);
    return Promise.resolve({ ok: true, status: { enabled } });
  },
}));
jest.mock('../../account-proxy/service', () => ({
  getAccountProxyStatus: (options: object): Promise<object> =>
    Promise.resolve({ available: true, options, missing: undefined }),
}));

import { mainAdvisorSettingsActionHost } from '../advisor-settings-actions-host';

type Answers = Array<{
  selectedOptions: string[];
  answeredBy?: 'person' | 'agent';
}>;

function host(
  answers: () => Promise<Answers>,
): ReturnType<typeof mainAdvisorSettingsActionHost> {
  return mainAdvisorSettingsActionHost({
    chatId: 'advisor-chat',
    callKey: 'advisor-chat:req-1',
    requestUserAnswers: answers,
  });
}

beforeEach(() => {
  mockCalls.length = 0;
  mockLaunch.length = 0;
});

describe('App Advisor settings host (CAN-6004)', () => {
  it('reads with only core.config.read and writes with only core.config.write, keyed by the tool call', async () => {
    const h = host(() => Promise.resolve([]));
    await h.read('agent');
    await h.update({
      namespace: 'agent',
      expectedRevision: 3,
      patch: { claudeMaxTurns: 9 },
    });
    expect(mockCalls).toEqual([
      {
        kind: 'query',
        name: 'core.config.get',
        params: { namespace: 'agent' },
        options: {
          caller: expect.objectContaining({
            clientInstanceId: 'agent-action:advisor-chat',
            grants: ['core.config.read'],
          }) as unknown,
        },
      },
      {
        kind: 'instruction',
        name: 'core.config.update',
        params: {
          namespace: 'agent',
          expectedRevision: 3,
          patch: { claudeMaxTurns: 9 },
          _meta: {
            idempotencyKey:
              'app-advisor-action:advisor-chat:req-1:config:agent',
          },
        },
        options: {
          caller: expect.objectContaining({
            grants: ['core.config.write'],
          }) as unknown,
          metadata: {
            idempotencyKey:
              'app-advisor-action:advisor-chat:req-1:config:agent',
          },
        },
      },
    ]);
  });

  it("uses main's launch at sign-in service and the proxy's status owner", async () => {
    const h = host(() => Promise.resolve([]));
    await h.setLaunchAtLogin(true);
    expect(mockLaunch).toEqual([true]);
    await expect(h.accountProxyStatus(true)).resolves.toEqual({
      available: true,
      options: { refresh: true, refreshUsage: false },
    });
  });

  it("confirms only on a person's answer; an agent's, a dismissal or a failure never does", async () => {
    const labels = { confirm: 'Allow', decline: 'Cancel' };
    await expect(
      host(() =>
        Promise.resolve([{ selectedOptions: ['Allow'], answeredBy: 'person' }]),
      ).confirm('Q?', labels),
    ).resolves.toBe('confirmed');
    await expect(
      host(() =>
        Promise.resolve([
          { selectedOptions: ['Cancel'], answeredBy: 'person' },
        ]),
      ).confirm('Q?', labels),
    ).resolves.toBe('declined');
    await expect(
      host(() =>
        Promise.resolve([{ selectedOptions: ['Allow'], answeredBy: 'agent' }]),
      ).confirm('Q?', labels),
    ).resolves.toBe('no_person');
    await expect(
      host(() => Promise.resolve([{ selectedOptions: ['Allow'] }])).confirm(
        'Q?',
        labels,
      ),
    ).resolves.toBe('no_person');
    await expect(
      host(() => Promise.reject(new Error('No one can answer.'))).confirm(
        'Q?',
        labels,
      ),
    ).resolves.toBe('no_person');
  });
});

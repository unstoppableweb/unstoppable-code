jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

interface MockInstruction {
  name: string;
  params: { commandId: string; _meta: { idempotencyKey: string } };
  options: { metadata: { idempotencyKey: string } };
}
const mockInstructions: MockInstruction[] = [];
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({
    instruction: (
      name: string,
      params: MockInstruction['params'],
      options: MockInstruction['options'],
    ): object => {
      mockInstructions.push({ name, params, options });
      return Promise.resolve({
        commandId: 'k',
        revision: 4,
        outcome: 'applied',
      });
    },
  }),
}));

let mockRestartFails = false;
const mockRestarts: unknown[] = [];
jest.mock('../../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): object => ({
    restartForSettingsChange: (target: unknown): Promise<void> => {
      mockRestarts.push(target);
      return mockRestartFails
        ? Promise.reject(new Error('terminal gone'))
        : Promise.resolve();
    },
  }),
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: (): void => undefined,
}));
jest.mock('../advisor-chat-read-host', () => ({
  mainAdvisorChatReadHost: (): object => ({
    readUiState: (): Promise<null> => Promise.resolve(null),
    readTabs: (): Promise<null> => Promise.resolve(null),
    locateCoworkChat: (): Promise<object> =>
      Promise.resolve({ entryId: null, archivedInEntryId: null }),
  }),
}));

let mockLiveFails = false;
const mockLiveUpdates: unknown[] = [];
jest.mock('../../ipc/chat', () => ({
  applyChatPluginSelectionsUpdate: (
    request: unknown,
    options: unknown,
  ): Promise<object> => {
    mockLiveUpdates.push({ request, options });
    return mockLiveFails
      ? Promise.reject(new Error('Wait for queued Codex messages'))
      : Promise.resolve({});
  },
}));

import { validateId } from '../../lib/validation';
import { mainAdvisorChatSettingsHost } from '../advisor-chat-settings-host';

const SETTINGS_KEY = 'app-advisor-action:advisor-chat:toolu_1:settings';
const PLAN_ACTION = {
  type: 'chat.patch_tab_settings',
  tabId: 'chat-1',
  patch: { planMode: true },
};

/** The command id of each core.chat.update sent, with its keys. */
function sentCommandIds(): Array<{
  commandId: string;
  meta: string;
  metadata: string;
}> {
  return mockInstructions.map(({ params, options }) => ({
    commandId: params.commandId,
    meta: params._meta.idempotencyKey,
    metadata: options.metadata.idempotencyKey,
  }));
}

function host(): ReturnType<typeof mainAdvisorChatSettingsHost> {
  return mainAdvisorChatSettingsHost({
    chatId: 'advisor-chat',
    readUiState: () => Promise.resolve(null),
    getMainWindow: () => null,
    hasPresentationLease: () => Promise.resolve(false),
    presentInMainWindow: () =>
      Promise.resolve({ requestId: 'r', ok: true, result: {} }),
  });
}

beforeEach(() => {
  mockInstructions.length = 0;
  mockRestarts.length = 0;
  mockRestartFails = false;
  mockLiveFails = false;
  mockLiveUpdates.length = 0;
});

describe('App Advisor chat settings host (CAN-5999 part 2)', () => {
  it('sends one keyed core.chat.update as the Advisor chat with only core.chat.write', async () => {
    const result = await host().updateChat({
      projectId: 'proj',
      worktreeId: 'wt',
      action: PLAN_ACTION,
      idempotencyKey: SETTINGS_KEY,
    });

    expect(result).toEqual({ outcome: 'applied' });
    const commandId: unknown = expect.stringMatching(
      /^app-advisor-action-[0-9a-f]{40}$/,
    );
    expect(mockInstructions).toEqual([
      {
        name: 'core.chat.update',
        params: {
          projectId: 'proj',
          worktreeId: 'wt',
          commandId,
          origin: 'desktop',
          action: PLAN_ACTION,
          _meta: { idempotencyKey: commandId },
        },
        options: {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'agent-action:advisor-chat',
            authorityId: 'local-desktop',
            interfaceKind: 'mcp',
            grants: ['core.chat.write'],
          },
          metadata: { idempotencyKey: commandId },
        },
      },
    ]);
    // The adapter requires the command id and both keys to match.
    const [sent] = sentCommandIds();
    expect(sent?.meta).toBe(sent?.commandId);
    expect(sent?.metadata).toBe(sent?.commandId);
  });

  it("derives a command id core's chat command validation accepts, stable per key and distinct across keys (CAN-7221)", async () => {
    const send = (
      idempotencyKey: string,
    ): ReturnType<ReturnType<typeof host>['updateChat']> =>
      host().updateChat({
        projectId: 'proj',
        worktreeId: 'wt',
        action: PLAN_ACTION,
        idempotencyKey,
      });
    await send(SETTINGS_KEY);
    await send(SETTINGS_KEY);
    await send('app-advisor-action:advisor-chat:toolu_2:settings');
    await send('app-advisor-action:advisor-chat-2:toolu_1:settings');

    const ids = sentCommandIds().map(({ commandId }) => commandId);
    // The raw key, with its colons and the provider's tool-use id, is not
    // a safe id; the command id sent instead passes the same validator.
    expect(() => validateId(SETTINGS_KEY, 'commandId')).toThrow();
    for (const id of ids)
      expect(() => validateId(id, 'commandId')).not.toThrow();
    expect(ids[1]).toBe(ids[0]);
    expect(new Set(ids).size).toBe(3);
  });

  it('restarts the Claude terminal after a change, and a failed restart never fails the change', async () => {
    const target = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat-1' };
    await host().restartTerminal(target);
    mockRestartFails = true;
    await expect(host().restartTerminal(target)).resolves.toBeUndefined();

    expect(mockRestarts).toEqual([target, target]);
  });

  it('reports whether the main window is open', () => {
    expect(host().isMainWindowOpen()).toBe(false);
  });

  it('applies plugin selections to the live session through applyChatPluginSelectionsUpdate, and reports when it cannot', async () => {
    const request = {
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    };
    await expect(host().applyLivePluginSelections(request)).resolves.toBe(true);
    mockLiveFails = true;
    await expect(host().applyLivePluginSelections(request)).resolves.toBe(
      false,
    );

    // Already committed through core.chat.update: the live update never writes.
    expect(mockLiveUpdates).toEqual([
      { request, options: { committed: true } },
      { request, options: { committed: true } },
    ]);
  });
});

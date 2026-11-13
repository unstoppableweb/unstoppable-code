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
    caller: { principalId: string; grants: string[] };
    metadata?: unknown;
  };
}> = [];
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({
    query: (name: string, params: unknown, options: never): object => {
      mockCalls.push({ kind: 'query', name, params, options });
      return Promise.resolve({});
    },
    instruction: (name: string, params: unknown, options: never): object => {
      mockCalls.push({ kind: 'instruction', name, params, options });
      return Promise.resolve({});
    },
  }),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: (): Promise<object> =>
    Promise.resolve({ items: [{ id: 'ws', name: 'Canopy' }] }),
}));

import { mainAdvisorMemoryActionHost } from '../advisor-memory-actions-host';

const PROJECT = { scope: 'workspace' as const, workspaceId: 'ws' };

beforeEach(() => {
  mockCalls.length = 0;
});

describe('the App Advisor memory host (CAN-6005)', () => {
  it('calls the core.memory maintenance operations as the advisor chat, one grant per call, keyed by the tool call', async () => {
    const host = mainAdvisorMemoryActionHost({
      chatId: 'advisor-chat',
      callKey: 'advisor-chat:toolu_1',
      requestUserAnswers: () => Promise.reject(new Error('unused')),
    });
    await host.consolidate({ scope: 'user' });
    await host.listSnapshots(PROJECT);
    await host.rebuild(PROJECT, 'rev-1');
    await host.restoreSnapshot(PROJECT, 'snap-1', 'rev-1');
    await host.importSources('ws');
    await host.importExternal(undefined, 'digest-1');
    await expect(host.projectName('ws')).resolves.toBe('Canopy');
    await expect(host.projectName('other')).resolves.toBeNull();
    const key = (step: string): string =>
      `app-advisor-action:advisor-chat:toolu_1:${step}`;
    expect(
      mockCalls.map(({ kind, name, params, options }) => ({
        kind,
        name,
        params,
        principalId: options.caller.principalId,
        grants: options.caller.grants,
        metadata: options.metadata,
      })),
    ).toEqual([
      {
        kind: 'instruction',
        name: 'core.memory.consolidation.run',
        params: {
          target: { scope: 'user' },
          _meta: { idempotencyKey: key('consolidate:user') },
        },
        principalId: 'local-desktop-user',
        grants: ['core.memory.write'],
        metadata: { idempotencyKey: key('consolidate:user') },
      },
      {
        kind: 'query',
        name: 'core.memory.snapshot.list',
        params: { target: PROJECT },
        principalId: 'local-desktop-user',
        grants: ['core.memory.read'],
        metadata: undefined,
      },
      {
        kind: 'instruction',
        name: 'core.memory.consolidation.rebuild',
        params: {
          target: PROJECT,
          expectedRevision: 'rev-1',
          _meta: { idempotencyKey: key('rebuild') },
        },
        principalId: 'local-desktop-user',
        grants: ['core.memory.write'],
        metadata: { idempotencyKey: key('rebuild') },
      },
      {
        kind: 'instruction',
        name: 'core.memory.snapshot.restore',
        params: {
          target: PROJECT,
          snapshotId: 'snap-1',
          expectedRevision: 'rev-1',
          _meta: { idempotencyKey: key('restore') },
        },
        principalId: 'local-desktop-user',
        grants: ['core.memory.write'],
        metadata: { idempotencyKey: key('restore') },
      },
      {
        kind: 'query',
        name: 'core.memory.import.sources.list',
        params: { workspaceId: 'ws' },
        principalId: 'local-desktop-user',
        grants: ['core.memory.read'],
        metadata: undefined,
      },
      {
        kind: 'instruction',
        name: 'core.memory.import.external',
        params: {
          expectedSourcesDigest: 'digest-1',
          _meta: { idempotencyKey: key('import') },
        },
        principalId: 'local-desktop-user',
        grants: ['core.memory.write'],
        metadata: { idempotencyKey: key('import') },
      },
    ]);
  });
});

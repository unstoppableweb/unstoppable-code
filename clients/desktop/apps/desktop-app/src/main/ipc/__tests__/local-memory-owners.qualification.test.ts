const mockHandlers = new Map<string, (...args: unknown[]) => unknown>();
jest.mock('../register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

const mockStoreCalls: string[] = [];
jest.mock('../../memory/local/memory-store', () => ({
  localMemoryStore: {
    consolidateNow: (scope: { scope: string }): Promise<object> => {
      mockStoreCalls.push(`consolidate:${scope.scope}`);
      return Promise.resolve({
        recorded: true,
        finishedAt: '2026-11-10T00:00:00.000Z',
        outcome: { result: 'success' },
      });
    },
    consolidationStatus: (scope: { scope: string }): Promise<object> => {
      mockStoreCalls.push(`status:${scope.scope}`);
      return Promise.resolve({
        pendingNotes: 0,
        running: false,
        rebuilding: false,
        lastRunAt: null,
        lastResult: null,
        lastReason: null,
        lastConsolidatedAt: null,
      });
    },
    rebuild: (scope: { scope: string }): Promise<object> => {
      mockStoreCalls.push(`rebuild:${scope.scope}`);
      return Promise.resolve({
        status: 'completed',
        snapshotId: 'snap-1',
        restoredInboxNotes: 1,
        restoredImports: 0,
        runs: 1,
      });
    },
  },
}));
jest.mock('../../memory/local/change-events', () => ({
  broadcastLocalMemoryChanged: jest.fn(),
  unwatchLocalMemoryScope: jest.fn(),
  watchLocalMemoryScope: jest.fn(),
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  consolidateLocalMemoryNow,
  rebuildLocalMemory,
  registerLocalMemoryHandlers,
} from '../local-memory';

beforeAll(() => {
  registerLocalMemoryHandlers();
});
beforeEach(() => {
  mockStoreCalls.length = 0;
});

function handler(channel: string): (...args: unknown[]) => unknown {
  const registered = mockHandlers.get(channel);
  if (!registered) throw new Error(`No handler for ${channel}`);
  return registered;
}

describe("the window's local memory handlers share App Advisor's owners (CAN-6005)", () => {
  it('IPC_CHANNELS.localMemoryConsolidate answers as consolidateLocalMemoryNow does', async () => {
    const viaWindow = await handler(IPC_CHANNELS.localMemoryConsolidate)(
      {},
      { scope: 'user' },
    );
    const windowCalls = [...mockStoreCalls];
    mockStoreCalls.length = 0;
    const shared = await consolidateLocalMemoryNow({ scope: 'user' });
    expect(viaWindow).toEqual(shared);
    expect(viaWindow).toMatchObject({
      lastRunAt: '2026-11-10T00:00:00.000Z',
      lastResult: 'success',
      lastConsolidatedAt: '2026-11-10T00:00:00.000Z',
    });
    expect(windowCalls).toEqual(mockStoreCalls);
    expect(windowCalls).toEqual(['consolidate:user', 'status:user']);
  });

  it('IPC_CHANNELS.localMemoryRebuild answers as rebuildLocalMemory does', async () => {
    const viaWindow = await handler(IPC_CHANNELS.localMemoryRebuild)(
      {},
      { scope: 'user' },
    );
    const windowCalls = [...mockStoreCalls];
    mockStoreCalls.length = 0;
    expect(viaWindow).toEqual(await rebuildLocalMemory({ scope: 'user' }));
    expect(windowCalls).toEqual(mockStoreCalls);
    expect(windowCalls).toEqual(['rebuild:user', 'status:user']);
  });
});

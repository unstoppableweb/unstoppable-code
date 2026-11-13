import {
  acquireCodexWorkerRuntime,
  onCodexWorkerRuntimeReplaced,
  resetCodexWorkerRuntimeForTests,
  shutdownCodexWorkerRuntime,
} from '../codex-worker-runtime';
import { getCodexRuntimeService } from '../../codex/runtime-service';

// The runtime's shared pool owns every Codex app-server spawn; the factory is faked here.
interface FakeRuntime {
  readonly id: number;
  readonly shutdown: jest.Mock<Promise<void>, []>;
}

const mockCapabilityStore = { kind: 'capability-store' };
const mockLauncher = { command: '/opt/brand/bin/canopyd', args: [] };
const mockRuntimes: FakeRuntime[] = [];
const mockCreateCodexRuntimeService = jest.fn<FakeRuntime, [unknown]>(() => {
  const runtime: FakeRuntime = {
    id: mockRuntimes.length + 1,
    shutdown: jest.fn<Promise<void>, []>(() => Promise.resolve()),
  };
  mockRuntimes.push(runtime);
  return runtime;
});

jest.mock(
  '@canopy/execution-engine/node/codex-runtime',
  (): Record<string, unknown> => ({
    createCodexRuntimeService: (options: unknown): FakeRuntime =>
      mockCreateCodexRuntimeService(options),
    resetCanonicalCodexHomeForTests: (): void => undefined,
  }),
);
jest.mock(
  '../../codex/runtime-host-adapter',
  (): Record<string, never> => ({}),
);
jest.mock(
  '../../codex/capability-store',
  (): { getDesktopCodexCapabilityStore: () => typeof mockCapabilityStore } => ({
    getDesktopCodexCapabilityStore: (): typeof mockCapabilityStore =>
      mockCapabilityStore,
  }),
);
jest.mock(
  '../../codex/mcp-launcher-command',
  (): { resolveDesktopCodexMcpLauncher: () => typeof mockLauncher } => ({
    resolveDesktopCodexMcpLauncher: (): typeof mockLauncher => mockLauncher,
  }),
);

afterEach(async () => {
  await resetCodexWorkerRuntimeForTests();
  mockRuntimes.length = 0;
  mockCreateCodexRuntimeService.mockClear();
});

it('creates one runtime and replaces it only after shutdown', async () => {
  const replaced = jest.fn();
  const stop = onCodexWorkerRuntimeReplaced(replaced);

  const first = acquireCodexWorkerRuntime();
  expect(acquireCodexWorkerRuntime()).toBe(first);
  expect(mockCreateCodexRuntimeService).toHaveBeenCalledTimes(1);
  expect(mockCreateCodexRuntimeService).toHaveBeenCalledWith({
    capabilityStore: mockCapabilityStore,
    mcpLauncher: mockLauncher,
  });

  await shutdownCodexWorkerRuntime();
  expect(mockRuntimes[0]?.shutdown).toHaveBeenCalledTimes(1);
  expect(replaced).toHaveBeenCalledTimes(1);
  expect(acquireCodexWorkerRuntime()).not.toBe(first);
  stop();
});

it('a second shutdown returns the first promise', async () => {
  acquireCodexWorkerRuntime();
  const first = shutdownCodexWorkerRuntime();
  const second = shutdownCodexWorkerRuntime();
  expect(second).toBe(first);
  await first;
  expect(mockRuntimes[0]?.shutdown).toHaveBeenCalledTimes(1);
});

it('a throwing replacement listener does not block shutdown', async () => {
  const stopThrowing = onCodexWorkerRuntimeReplaced(() => {
    throw new Error('listener failed');
  });
  const after = jest.fn();
  const stopAfter = onCodexWorkerRuntimeReplaced(after);
  acquireCodexWorkerRuntime();

  await expect(shutdownCodexWorkerRuntime()).resolves.toBeUndefined();
  expect(mockRuntimes[0]?.shutdown).toHaveBeenCalledTimes(1);
  expect(after).toHaveBeenCalledTimes(1);
  stopThrowing();
  stopAfter();
});

it('the compatibility module names the same runtime', () => {
  expect(getCodexRuntimeService()).toBe(acquireCodexWorkerRuntime());
});

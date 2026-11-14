import type { BrowserWindow } from 'electron';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import type { AgentProvider, AgentSessionOptions } from '../agents/types';

/*
 * Worker-owned provider runtimes (CAN-4116, CAN-4117): the only code that
 * constructs a provider for its harness. Each is loaded lazily, so provider
 * modules stay out of Electron main's startup graph, and is reached only from
 * inside an agent worker run.
 */
export type WorkerProviderHarness = NonNullable<
  AgentSessionOptions['executionHarness']
>;

export interface WorkerProviderRuntime {
  readonly harness: WorkerProviderHarness;
  /** Asserts an agent worker context; resolves the provider for `providerType`. */
  providerFor(
    providerType: AgentProviderType,
    getWindow: () => BrowserWindow | null,
  ): Promise<AgentProvider>;
}

const LOADERS: Partial<
  Record<WorkerProviderHarness, () => Promise<WorkerProviderRuntime>>
> = {
  antigravity: async () =>
    (
      await import('./antigravity-worker-runtime')
    ).getAntigravityWorkerRuntime(),
  claude: async () =>
    (await import('./claude-worker-runtime')).getClaudeWorkerRuntime(),
  codex: async () =>
    (await import('./codex-worker-runtime')).getCodexWorkerRuntime(),
  copilot: async () =>
    (await import('./copilot-worker-runtime')).getCopilotWorkerRuntime(),
  cursor: async () =>
    (await import('./cursor-worker-runtime')).getCursorWorkerRuntime(),
  opencode: async () =>
    (await import('./opencode-worker-runtime')).getOpenCodeWorkerRuntime(),
};

const loaded = new Map<WorkerProviderHarness, Promise<WorkerProviderRuntime>>();
const testOverrides = new Map<WorkerProviderHarness, WorkerProviderRuntime>();

/** The runtime that constructs providers for `harness`, or undefined when none is registered. */
export async function workerProviderRuntimeFor(
  harness: WorkerProviderHarness,
): Promise<WorkerProviderRuntime | undefined> {
  const override = testOverrides.get(harness);
  if (override) return override;
  const load = LOADERS[harness];
  if (!load) return undefined;
  let runtime = loaded.get(harness);
  if (!runtime) {
    runtime = load();
    loaded.set(harness, runtime);
  }
  return runtime;
}

/** Test seam: replace (or with `undefined`, restore) one harness's runtime. */
export function setWorkerProviderRuntimeForTests(
  harness: WorkerProviderHarness,
  runtime: WorkerProviderRuntime | undefined,
): void {
  if (runtime) testOverrides.set(harness, runtime);
  else testOverrides.delete(harness);
}

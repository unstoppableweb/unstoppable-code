import type { AgentProvider } from '../agents/types';
import { assertAgentWorkerContext } from './agent-worker-context';
import type { WorkerProviderRuntime } from './worker-provider-runtimes';

const runtime: WorkerProviderRuntime = {
  harness: 'antigravity',
  async providerFor(): Promise<AgentProvider> {
    assertAgentWorkerContext('AntigravityWorkerRuntime.providerFor');
    const { AntigravityProvider } =
      await import('../agents/antigravity-session');
    return new AntigravityProvider();
  },
};

export function getAntigravityWorkerRuntime(): WorkerProviderRuntime {
  return runtime;
}

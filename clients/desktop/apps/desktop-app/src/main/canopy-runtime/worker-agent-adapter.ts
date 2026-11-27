import {
  type HelperExecutionWorker,
  type WorkerAgentHelperHandlers,
} from '@canopy/core-runtime/node/agent/helpers';
import {
  type SignInExecutionWorker,
  type WorkerAgentSignInHandlers,
} from '@canopy/core-runtime/node/agent/sign-in';
import {
  createWorkerAgentProviderHandlers,
  createWorkerAgentUsageLimitsHandlers,
  type WorkerAgentProviderHandlers,
  type WorkerAgentProviderHost,
  type WorkerAgentUsageLimitsHandlers,
  type WorkerAgentUsageLimitsHost,
} from '@canopy/core-runtime/node/agent/providers';
import {
  type SubagentExecutionWorker,
  type TurnEventSink,
  type TurnExecutionWorker,
  type WorkerAgentRunHandlers,
} from '@canopy/core-runtime/node/agent/turns';
import { createWorkerAgentHandlers } from '@canopy/core-runtime/node/agent/worker-handlers';
import { createDesktopProviderHost } from '../agent-providers/desktop-provider-host';
import { createDesktopUsageLimitsHost } from '../agent-providers/desktop-usage-limits-host';

export type WorkerAgentAdapter = {
  queries: WorkerAgentProviderHandlers['queries'] &
    WorkerAgentUsageLimitsHandlers['queries'];
  instructions: WorkerAgentHelperHandlers['instructions'] &
    WorkerAgentRunHandlers['instructions'] &
    WorkerAgentSignInHandlers['instructions'];
};

// The helper and agent-run hosts import back into this runtime, so load them
// at dispatch.
export function createWorkerAgentAdapter(options: {
  loadHelpers?: () => Promise<HelperExecutionWorker>;
  loadSignInWorker?: () => Promise<SignInExecutionWorker>;
  loadRuns?: () => Promise<{
    turns: TurnExecutionWorker;
    subagents: SubagentExecutionWorker;
  }>;
  sinkFor: (turnRunId: string) => TurnEventSink | null;
  /** The provider list host (CAN-4121); defaults to the desktop host. */
  providerHost?: WorkerAgentProviderHost;
  /** Cached passive usage source; defaults to the current desktop worker host. */
  usageHost?: WorkerAgentUsageLimitsHost;
}): WorkerAgentAdapter {
  const loadHelpers =
    options.loadHelpers ??
    (async (): Promise<HelperExecutionWorker> =>
      (await import('../helper-runs/helper-worker-host')).desktopHelperWorker);
  const loadSignInWorker =
    options.loadSignInWorker ??
    (async (): Promise<SignInExecutionWorker> =>
      (await import('../sign-in-runs/sign-in-worker-host'))
        .desktopSignInWorker);
  const loadRuns =
    options.loadRuns ??
    (async (): Promise<{
      turns: TurnExecutionWorker;
      subagents: SubagentExecutionWorker;
    }> => {
      const host = await import('../agent-runs/turn-worker-host');
      return {
        turns: host.desktopTurnWorker,
        subagents: host.desktopSubagentWorker,
      };
    });
  return {
    queries: {
      ...createWorkerAgentProviderHandlers(
        options.providerHost ?? createDesktopProviderHost(),
      ).queries,
      ...createWorkerAgentUsageLimitsHandlers(
        options.usageHost ?? createDesktopUsageLimitsHost(),
      ).queries,
    },
    instructions: createWorkerAgentHandlers({
      loadHelpers,
      loadSignInWorker,
      loadRuns,
      sinkFor: options.sinkFor,
    }).instructions,
  };
}

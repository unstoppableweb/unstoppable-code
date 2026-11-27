import {
  createWorkerAgentHelperHandlers,
  type HelperExecutionWorker,
  type WorkerAgentHelperHandlers,
} from './helpers/worker-helpers';
import {
  createWorkerAgentSignInHandlers,
  type SignInExecutionWorker,
  type WorkerAgentSignInHandlers,
} from './sign-in/worker-sign-in';
import type { TurnEventSink } from './turns/core-chat-turn-runs';
import {
  createWorkerAgentRunHandlers,
  type SubagentExecutionWorker,
  type TurnExecutionWorker,
  type WorkerAgentRunHandlers,
} from './turns/worker-agent-runs';

export type WorkerAgentHandlers = {
  instructions: WorkerAgentHelperHandlers['instructions'] &
    WorkerAgentRunHandlers['instructions'] &
    WorkerAgentSignInHandlers['instructions'];
};

export function createWorkerAgentHandlers(options: {
  loadHelpers: () => Promise<HelperExecutionWorker>;
  loadSignInWorker: () => Promise<SignInExecutionWorker>;
  loadRuns: () => Promise<{
    turns: TurnExecutionWorker;
    subagents: SubagentExecutionWorker;
  }>;
  sinkFor: (turnRunId: string) => TurnEventSink | null;
}): WorkerAgentHandlers {
  let loadingHelpers: Promise<WorkerAgentHelperHandlers> | undefined;
  let loadingSignIn: Promise<WorkerAgentSignInHandlers> | undefined;
  let loadingRuns: Promise<WorkerAgentRunHandlers> | undefined;
  const helpers = (): Promise<WorkerAgentHelperHandlers> =>
    (loadingHelpers ??= options
      .loadHelpers()
      .then(createWorkerAgentHelperHandlers));
  const signIn = (): Promise<WorkerAgentSignInHandlers> =>
    (loadingSignIn ??= options
      .loadSignInWorker()
      .then(createWorkerAgentSignInHandlers));
  const runs = (): Promise<WorkerAgentRunHandlers> =>
    (loadingRuns ??= options.loadRuns().then(({ turns, subagents }) =>
      createWorkerAgentRunHandlers({
        turns,
        subagents,
        sinkFor: options.sinkFor,
      }),
    ));
  return {
    instructions: {
      'worker.agent.helper.run': async (params, context) =>
        (await helpers()).instructions['worker.agent.helper.run'](
          params,
          context,
        ),
      'worker.agent.signIn.run': async (params, context) =>
        (await signIn()).instructions['worker.agent.signIn.run'](
          params,
          context,
        ),
      'worker.agent.turn.run': async (params, context) =>
        (await runs()).instructions['worker.agent.turn.run'](params, context),
      'worker.agent.subagent.run': async (params, context) =>
        (await runs()).instructions['worker.agent.subagent.run'](
          params,
          context,
        ),
    },
  };
}

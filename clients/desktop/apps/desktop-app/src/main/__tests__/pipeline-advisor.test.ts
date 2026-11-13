import type * as InlineHelperRuns from './helpers/inline-helper-runs';
import type {
  ExecutionRuntime,
  ExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import type {
  PipelineAdvisorSdkTurnInput,
  PipelineAdvisorSdkTurnResult,
} from '../pipelines/pipeline-advisor-sdk';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import type {
  resolveHelperInvocation,
  resolveHelperWorkOwner,
} from '../ollama/helper-invocation';
import { initCodexModels } from '@canopy/desktop-shared/types';

jest.mock('../helper-runs/helper-runs', () => {
  const { inlineHelperRunsModule } = jest.requireActual<
    typeof InlineHelperRuns
  >('./helpers/inline-helper-runs');
  return inlineHelperRunsModule();
});
jest.mock('../lib/window-send', () => ({ sendToWindow: jest.fn() }));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<
    Pick<
      PreferencesData,
      | 'pipelineAdvisorEnabled'
      | 'pipelineAdvisorModel'
      | 'pipelineAdvisorThinkingLevel'
    >
  > =>
    Promise.resolve({
      pipelineAdvisorEnabled: true,
      pipelineAdvisorModel: 'gpt-5.5',
      pipelineAdvisorThinkingLevel: 'high',
    }),
}));
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): Promise<boolean> => Promise.resolve(false),
}));
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperWorkOwner: (): ReturnType<typeof resolveHelperWorkOwner> =>
    Promise.resolve({ kind: 'personal' }),
  resolveHelperInvocation: (): ReturnType<typeof resolveHelperInvocation> =>
    Promise.resolve({
      providerType: 'codex',
      source: 'codex-managed',
      harness: 'codex',
      sdkModel: 'gpt-5.5',
      aiCreditsRouted: false,
      dispose: (): void => undefined,
    }),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): unknown => ({
    startObservedTask: jest.fn(),
    updateObservedTask: jest.fn(),
    finalizeObservedTask: jest.fn(),
    seedTranscript: jest.fn(),
  }),
}));
const state: ExecutionState = {
  version: 10,
  id: 'execution-1',
  pipeline_id: 'pipeline-1',
  pipeline_snapshot: { name: 'Pipeline', scope: ['directory'], jobs: {} },
  status: 'running',
  jobs: {},
  job_definitions: {},
  job_groups: {},
  pending_pauses: [],
  status_reasons: [],
  started_at: '2026-11-04T00:00:00.000Z',
  cwd: '/workspace',
  env: {},
  inputs: {},
  project_id: 'project-1',
  worktree_id: 'worktree-1',
};
jest.mock('@canopy/execution-engine/node/pipelines/executor', () => ({
  loadExecutionState: (): Promise<ExecutionState> => Promise.resolve(state),
}));
jest.mock('../pipelines/pipeline-advisor-store', () => ({
  getPipelineExecutionDataDir: (root: string, id: string): string =>
    `${root}/${id}`,
  readPipelineAdvisorSnapshot: (): Promise<null> => Promise.resolve(null),
  writePipelineAdvisorSnapshot: (): Promise<void> => Promise.resolve(),
  normalizePipelineAdvisorReports: (reports: unknown[]): unknown[] => reports,
}));
const mockTurn = jest.fn<
  Promise<PipelineAdvisorSdkTurnResult>,
  [PipelineAdvisorSdkTurnInput]
>();
jest.mock('../pipelines/pipeline-advisor-sdk', () => ({
  PIPELINE_ADVISOR_SYSTEM_PROMPT: 'advisor system prompt',
  runPipelineAdvisorSdkTurn: (
    input: PipelineAdvisorSdkTurnInput,
  ): Promise<PipelineAdvisorSdkTurnResult> => mockTurn(input),
}));
import { PipelineAdvisorService } from '../pipelines/pipeline-advisor';
const helpers = jest.requireMock<
  ReturnType<typeof InlineHelperRuns.inlineHelperRunsModule>
>('../helper-runs/helper-runs');
const runtime: ExecutionRuntime = {
  executionsDir: '/executions',
  tempRootDir: '/temporary',
  bundledActionsDir: '/actions',
  getProjectActionsDir: () => '/actions',
  getProjectPipelinesDir: () => '/pipelines',
  isModelBlockedByOrgPolicy: () => Promise.resolve(false),
  isOrgModelPolicyActive: () => Promise.resolve(false),
};
let service: PipelineAdvisorService;
let started: Promise<void>;
let markStarted: () => void;
beforeEach(() => {
  initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
  helpers.runs.length = 0;
  service = new PipelineAdvisorService();
  started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  mockTurn.mockImplementation(
    ({ abortController }) =>
      new Promise((_resolve, reject) => {
        if (!abortController)
          throw new Error('Missing advisor abort controller');
        abortController.signal.addEventListener(
          'abort',
          () => reject(new Error('stopped')),
          { once: true },
        );
        markStarted();
      }),
  );
});
afterEach(async () => {
  service.shutdown();
  await Promise.resolve();
  await Promise.resolve();
});
it('runs each advisor turn as one pipeline_advisor helper run scoped to its execution', async () => {
  await service.runForExistingExecution({
    executionId: state.id,
    runtime,
    getWindow: () => null,
  });
  await started;
  expect(helpers.runs).toHaveLength(1);
  expect(helpers.runs[0]).toMatchObject({
    kind: 'pipeline_advisor',
    scope: { executionId: state.id },
    origin: 'system',
  });
});
it('cancels the in-flight helper run when the advisor shuts down', async () => {
  await service.runForExistingExecution({
    executionId: state.id,
    runtime,
    getWindow: () => null,
  });
  await started;
  expect(helpers.runs).toHaveLength(1);
  const signal = helpers.runs[0]?.signal;
  expect(signal?.aborted).toBe(false);
  service.shutdown();
  expect(signal?.aborted).toBe(true);
});

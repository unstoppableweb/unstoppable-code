import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as CliRuntimeModule from '../cli-runtime';
import type { CodexPromptRunnerRequest } from '@canopy/execution-engine/node/pipelines/executor/types';

const mockCreateCodexRuntimeService = jest.fn<unknown, [unknown]>(() => {
  throw new Error('The fixture stops at runtime creation.');
});

jest.mock(
  '@canopy/execution-engine/node/codex-runtime',
  (): Record<string, unknown> => ({
    ...jest.requireActual<Record<string, unknown>>(
      '@canopy/execution-engine/node/codex-runtime',
    ),
    createCodexRuntimeService: (options: unknown): unknown =>
      mockCreateCodexRuntimeService(options),
  }),
);

let cwd = '';

beforeEach(async () => {
  jest.resetModules();
  mockCreateCodexRuntimeService.mockClear();
  cwd = await fs.mkdtemp(path.join(tmpdir(), 'cli-codex-launcher-'));
});

afterEach(() => fs.rm(cwd, { recursive: true, force: true }));

function promptRequest(): CodexPromptRunnerRequest {
  return {
    cwd,
    prompt: 'hello',
    environment: {},
    fastMode: false,
    totalTimeoutMs: 1_000,
    permissionPreset: 'read_only',
    executionId: 'execution-1',
    jobId: 'job-1',
    stepId: 'step-1',
    attempt: 1,
    stepLabel: 'Step',
  };
}

async function loadCliRuntime(): Promise<typeof CliRuntimeModule> {
  return import('../cli-runtime');
}

it('the CLI runtime refuses to start without a configured launcher', async () => {
  const cliRuntime = await loadCliRuntime();
  const runtime = cliRuntime.createCliExecutionRuntime({ cwd });

  await expect(
    runtime.codexPromptRunner?.runCodexPrompt(promptRequest()),
  ).rejects.toBeInstanceOf(cliRuntime.CodexMcpLauncherUnavailableError);
  expect(mockCreateCodexRuntimeService).not.toHaveBeenCalled();
});

it('configuration reaches the runtime', async () => {
  const cliRuntime = await loadCliRuntime();
  cliRuntime.configureCliCodexRuntime({
    mcpLauncher: { command: '/x/canopyd', args: [] },
  });
  const runtime = cliRuntime.createCliExecutionRuntime({ cwd });

  await runtime.codexPromptRunner
    ?.runCodexPrompt(promptRequest())
    .catch(() => undefined);

  expect(mockCreateCodexRuntimeService).toHaveBeenCalledWith(
    expect.objectContaining({
      mcpLauncher: { command: '/x/canopyd', args: [] },
    }),
  );
});

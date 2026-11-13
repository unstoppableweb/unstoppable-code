import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import type * as ExecutionStateModule from '@canopy/execution-engine/node/pipelines/executor/execution-state';

jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

let mockExecutionsDir = '';
jest.mock('../../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: (): object => ({
    executionsDir: mockExecutionsDir,
  }),
}));

const mockLoads: string[] = [];
jest.mock(
  '@canopy/execution-engine/node/pipelines/executor/execution-state',
  (): object => ({
    ...jest.requireActual<typeof ExecutionStateModule>(
      '@canopy/execution-engine/node/pipelines/executor/execution-state',
    ),
    loadExecutionState: (executionId: string, dir: string): object | null => {
      mockLoads.push(`${executionId}@${dir}`);
      return Promise.resolve(
        executionId === 'exec-1' ? { id: 'exec-1' } : null,
      );
    },
  }),
);

const mockReruns: unknown[] = [];
jest.mock('../../pipelines/pipeline-handlers', () => ({
  rerunPipelineExecutionFromMain: (args: { executionId: string }): object => {
    mockReruns.push(args);
    return Promise.resolve({ success: true, data: { id: 'exec-2' } });
  },
}));

jest.mock('../../services/pipelines-service', () => ({
  getPipelineFailureDebugContext: (executionId: string): object =>
    Promise.resolve({
      prompt: `debug ${executionId}`,
      failedStepCount: 1,
      includedReportKinds: ['text'],
    }),
}));

import { mainAdvisorPipelineActionHost } from '../advisor-pipeline-actions-host';

let root: string;
let cwd: string;

function state(overrides: Partial<ExecutionState>): ExecutionState {
  return { id: 'exec-1', cwd, ...overrides } as ExecutionState;
}

function host(): ReturnType<typeof mainAdvisorPipelineActionHost> {
  return mainAdvisorPipelineActionHost({
    getWindow: () => null,
    readTabs: () => Promise.resolve(null),
    sendToChat: () => Promise.resolve(),
    revealChat: () => Promise.resolve(),
    createAdvisorChat: () =>
      Promise.resolve({ workEntryId: 'entry', chatId: 'chat' }),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-6001-host-'));
  mockExecutionsDir = join(root, 'executions');
  cwd = join(root, 'worktree');
  mkdirSync(join(mockExecutionsDir, 'exec-1'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(mockExecutionsDir, 'exec-1', 'report.md'), 'report');
  writeFileSync(join(mockExecutionsDir, 'exec-1', 'report.json'), '{}');
  writeFileSync(join(cwd, 'plan.md'), 'plan');
  writeFileSync(join(root, 'outside.md'), 'secret');
  mockLoads.length = 0;
  mockReruns.length = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor pipeline action host (CAN-6001)', () => {
  it('reads a report only inside the executions directory, choosing the text or JSON report', async () => {
    const reports = state({
      report_outputs: {
        report_file: join(mockExecutionsDir, 'exec-1', 'report.md'),
        report_json_file: join(mockExecutionsDir, 'exec-1', 'report.json'),
      },
    });

    await expect(
      host().readArtifact(reports, { kind: 'report', format: 'text' }),
    ).resolves.toEqual({
      filePath: join(mockExecutionsDir, 'exec-1', 'report.md'),
      content: 'report',
    });
    await expect(
      host().readArtifact(reports, { kind: 'report', format: 'json' }),
    ).resolves.toMatchObject({ content: '{}' });
    await expect(
      host().readArtifact(
        state({ report_outputs: { report_file: join(root, 'outside.md') } }),
        { kind: 'report' },
      ),
    ).resolves.toBeNull();
  });

  it("reads a plan only inside the run's directory or the executions directory", async () => {
    await expect(
      host().readArtifact(
        state({ event_data: { plan_ready: { plan_path: 'plan.md' } } }),
        { kind: 'plan' },
      ),
    ).resolves.toEqual({ filePath: join(cwd, 'plan.md'), content: 'plan' });
    for (const planPath of [join(root, 'outside.md'), '../outside.md'])
      await expect(
        host().readArtifact(
          state({ event_data: { plan_ready: { plan_path: planPath } } }),
          { kind: 'plan' },
        ),
      ).resolves.toBeNull();
  });

  it('accepts a canonical plan path under a symlinked executions root, and still refuses one outside', async () => {
    const realRoot = join(root, 'real-executions');
    mkdirSync(join(realRoot, 'exec-1'), { recursive: true });
    writeFileSync(join(realRoot, 'exec-1', 'plan.md'), 'canonical plan');
    const linkedRoot = join(root, 'linked-executions');
    symlinkSync(realRoot, linkedRoot);
    mockExecutionsDir = linkedRoot;
    const canonicalPlan = join(realpathSync(realRoot), 'exec-1', 'plan.md');

    await expect(
      host().readArtifact(
        state({ event_data: { plan_ready: { plan_path: canonicalPlan } } }),
        { kind: 'plan' },
      ),
    ).resolves.toEqual({ filePath: canonicalPlan, content: 'canonical plan' });
    await expect(
      host().readArtifact(
        state({
          event_data: { plan_ready: { plan_path: join(root, 'outside.md') } },
        }),
        { kind: 'plan' },
      ),
    ).resolves.toBeNull();
  });

  it('loads an execution from the executions directory and reruns it through main (worker.pipeline.execution.retry from the start)', async () => {
    await expect(host().loadExecution('exec-1')).resolves.toEqual({
      id: 'exec-1',
    });
    await expect(host().loadExecution('missing')).resolves.toBeNull();
    expect(mockLoads).toEqual([
      `exec-1@${mockExecutionsDir}`,
      `missing@${mockExecutionsDir}`,
    ]);

    await expect(host().rerun('exec-1')).resolves.toEqual({
      success: true,
      data: { id: 'exec-2' },
    });
    expect(mockReruns).toHaveLength(1);
    expect(mockReruns[0]).toMatchObject({ executionId: 'exec-1' });
    expect(Object.keys(mockReruns[0] ?? {}).sort()).toEqual([
      'executionId',
      'getWindow',
    ]);
  });

  it("builds the debug prompt with main's failure debug context", async () => {
    await expect(host().debugPrompt('exec-1')).resolves.toBe('debug exec-1');
  });
});

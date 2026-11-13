jest.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}));

import * as fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createInitialState,
  findResumePoint,
  listExecutionSummaries,
  listExecutionSummariesWithStates,
  loadExecutionState,
  normalizePipeline,
  prepareRetryState,
  recoverInterruptedState,
  resumePipeline,
  saveExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor';
import { normalizeUsageInitiationSource } from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import type {
  ExecutionState,
  StepResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';

function listStateDirectory(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name !== '.locks');
}

describe('execution-state', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-execution-state-'));
  });

  it('preserves the automation initiation source', () => {
    expect(normalizeUsageInitiationSource('automation')).toBe('automation');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeState(jobOverrides?: {
    continue_on_error?: boolean;
    max_retries?: number;
  }): ExecutionState {
    const normalized = normalizePipeline({
      name: 'State Test',
      on: 'dispatch',
      jobs: {
        build: {
          continue_on_error: jobOverrides?.continue_on_error,
          max_retries: jobOverrides?.max_retries,
          steps: [
            { id: 'first', run: 'echo first' },
            { id: 'second', run: 'echo second' },
          ],
        },
      },
    });

    return createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'state-test',
        runtime: {
          // Pipeline fixtures do not enforce an org model policy.
          isModelBlockedByOrgPolicy: (): Promise<boolean> =>
            Promise.resolve(false),
          isOrgModelPolicyActive: (): Promise<boolean> =>
            Promise.resolve(false),
          executionsDir: tempDir,
          tempRootDir: tempDir,
          bundledActionsDir: tempDir,
          getProjectActionsDir: (repoPath: string): string => repoPath,
          getProjectPipelinesDir: (repoPath: string): string => repoPath,
        },
      },
      'execution-1',
    );
  }

  function markInterruptedHardFailure(
    state: ExecutionState,
    retryCount: number,
  ): void {
    state.status = 'running';
    state.jobs.build.status = 'failure';
    state.jobs.build.conclusion = 'failure';
    state.jobs.build.outcome = 'failure';
    state.jobs.build.retry_count = retryCount;
    state.jobs.build.steps.first = {
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      outputs: {},
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };
  }

  function cloneSteps(
    steps: Record<string, StepResult>,
  ): Record<string, StepResult> {
    return Object.fromEntries(
      Object.entries(steps).map(([stepId, step]) => [stepId, { ...step }]),
    );
  }

  function cloneSerializedRecord(value: unknown): Record<string, unknown> {
    const parsed: unknown = JSON.parse(JSON.stringify(value));
    return assertRecord(parsed);
  }

  function parseJsonRecord(raw: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(raw);
    return assertRecord(parsed);
  }

  function assertRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Expected serialized value to be an object');
    }

    const record: Record<string, unknown> = {};
    Object.assign(record, value);
    return record;
  }

  describe('snapshot installation', () => {
    const targetName = 'execution-1.json';

    function namedSnapshot(
      state: ExecutionState,
      name: string,
    ): ExecutionState {
      return {
        ...state,
        pipeline_snapshot: { ...state.pipeline_snapshot, name },
      };
    }

    function gate(): { reached: Promise<void>; release: () => void } {
      let release = (): void => {};
      const reached = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { reached, release };
    }

    it('serializes overlapping saves of one execution so the later snapshot installs last', async () => {
      const initial = makeState();
      await saveExecutionState(initial, tempDir);
      const target = path.join(tempDir, targetName);
      const initialBytes = fs.readFileSync(target, 'utf8');
      const first = namedSnapshot(initial, 'first snapshot');
      const second = namedSnapshot(initial, 'second, longer snapshot');
      const staged = gate();
      const proceed = gate();
      const rename = fsPromises.rename;
      const sources: string[] = [];
      const stagedBytes: string[] = [];
      jest
        .spyOn(fsPromises, 'rename')
        .mockImplementation(async (source, dest) => {
          sources.push(String(source));
          stagedBytes.push(fs.readFileSync(source, 'utf8'));
          if (sources.length === 1) {
            staged.release();
            await proceed.reached;
          }
          await rename(source, dest);
        });

      const firstSave = saveExecutionState(first, tempDir);
      const firstResult = Promise.allSettled([firstSave]);
      let secondSave: Promise<void> | undefined;
      try {
        await Promise.race([staged.reached, firstSave]);
        secondSave = saveExecutionState(second, tempDir);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(sources).toHaveLength(1);
        expect(fs.readFileSync(target, 'utf8')).toBe(initialBytes);
      } finally {
        proceed.release();
        await firstResult;
        await secondSave;
      }
      await expect(firstSave).resolves.toBeUndefined();
      expect(new Set(sources).size).toBe(2);
      expect(fs.readFileSync(target, 'utf8')).toBe(stagedBytes[1]);
      expect(await loadExecutionState(initial.id, tempDir)).toMatchObject({
        pipeline_snapshot: { name: second.pipeline_snapshot.name },
      });
      expect(listStateDirectory(tempDir)).toEqual([targetName]);
    });

    it('installs a queued newer snapshot after a held writer fails replacement', async () => {
      const initial = makeState();
      await saveExecutionState(initial, tempDir);
      const target = path.join(tempDir, targetName);
      const staged = gate();
      const proceed = gate();
      const rename = fsPromises.rename;
      const failure = Object.assign(new Error('replacement failed'), {
        code: 'EEXIST',
      });
      const renameSpy = jest
        .spyOn(fsPromises, 'rename')
        .mockImplementationOnce(async () => {
          staged.release();
          await proceed.reached;
          throw failure;
        })
        .mockImplementation(rename);
      const unlink = jest.spyOn(fsPromises, 'unlink');

      const firstSave = saveExecutionState(
        namedSnapshot(initial, 'stale'),
        tempDir,
      );
      const firstResult = Promise.allSettled([firstSave]);
      let secondSave: Promise<void> | undefined;
      try {
        await Promise.race([staged.reached, firstSave]);
        secondSave = saveExecutionState(
          namedSnapshot(initial, 'newer'),
          tempDir,
        );
      } finally {
        proceed.release();
        await firstResult;
        await secondSave;
      }

      await expect(firstSave).rejects.toBe(failure);
      expect(renameSpy).toHaveBeenCalledTimes(2);
      expect(unlink).not.toHaveBeenCalledWith(target);
      expect(await loadExecutionState(initial.id, tempDir)).toMatchObject({
        pipeline_snapshot: { name: 'newer' },
      });
      expect(listStateDirectory(tempDir)).toEqual([targetName]);
    });

    it('cleans only its own staging when a queued save fails after a held writer succeeds', async () => {
      const initial = makeState();
      await saveExecutionState(initial, tempDir);
      const target = path.join(tempDir, targetName);
      const initialBytes = fs.readFileSync(target, 'utf8');
      const staged = gate();
      const proceed = gate();
      const rename = fsPromises.rename;
      const failure = Object.assign(new Error('replacement failed'), {
        code: 'EIO',
      });
      let attempts = 0;
      jest
        .spyOn(fsPromises, 'rename')
        .mockImplementation(async (source, dest) => {
          attempts += 1;
          if (attempts !== 1) throw failure;
          staged.release();
          await proceed.reached;
          await rename(source, dest);
        });

      const firstSave = saveExecutionState(
        namedSnapshot(initial, 'survivor'),
        tempDir,
      );
      const firstResult = Promise.allSettled([firstSave]);
      let secondResult: Promise<PromiseSettledResult<void>[]> | undefined;
      try {
        await Promise.race([staged.reached, firstSave]);
        secondResult = Promise.allSettled([
          saveExecutionState(namedSnapshot(initial, 'failed'), tempDir),
        ]);
        expect(fs.readFileSync(target, 'utf8')).toBe(initialBytes);
      } finally {
        proceed.release();
        await firstResult;
      }
      await expect(firstSave).resolves.toBeUndefined();
      expect(await secondResult).toEqual([
        { status: 'rejected', reason: failure },
      ]);
      expect(await loadExecutionState(initial.id, tempDir)).toMatchObject({
        pipeline_snapshot: { name: 'survivor' },
      });
      expect(listStateDirectory(tempDir)).toEqual([targetName]);
    });

    it.each(['EEXIST', 'EIO', 'EPERM', 'EACCES', 'EBUSY'])(
      'preserves the last checkpoint when replacement persistently fails with %s',
      async (code) => {
        const initial = makeState();
        await saveExecutionState(initial, tempDir);
        const target = path.join(tempDir, targetName);
        const initialBytes = fs.readFileSync(target, 'utf8');
        const failure = Object.assign(new Error('replacement failed'), {
          code,
        });
        const rename = jest
          .spyOn(fsPromises, 'rename')
          .mockRejectedValue(failure);
        const unlink = jest.spyOn(fsPromises, 'unlink');

        await expect(
          saveExecutionState(namedSnapshot(initial, 'replacement'), tempDir),
        ).rejects.toBe(failure);

        expect(unlink).not.toHaveBeenCalledWith(target);
        expect(fs.readFileSync(target, 'utf8')).toBe(initialBytes);
        expect(listStateDirectory(tempDir)).toEqual([targetName]);
        expect(rename).toHaveBeenCalledTimes(
          ['EPERM', 'EACCES', 'EBUSY'].includes(code) ? 6 : 1,
        );
      },
    );

    it.each(['EPERM', 'EACCES', 'EBUSY'])(
      'retries transient %s without removing the existing checkpoint',
      async (code) => {
        const initial = makeState();
        await saveExecutionState(initial, tempDir);
        const target = path.join(tempDir, targetName);
        const initialBytes = fs.readFileSync(target, 'utf8');
        const rename = fsPromises.rename;
        const renameSpy = jest
          .spyOn(fsPromises, 'rename')
          .mockImplementationOnce(() => {
            expect(fs.readFileSync(target, 'utf8')).toBe(initialBytes);
            return Promise.reject(
              Object.assign(new Error('temporarily locked'), { code }),
            );
          })
          .mockImplementation(async (source, dest) => {
            expect(fs.readFileSync(target, 'utf8')).toBe(initialBytes);
            await rename(source, dest);
          });
        const unlink = jest.spyOn(fsPromises, 'unlink');

        await saveExecutionState(
          namedSnapshot(initial, 'replacement'),
          tempDir,
        );

        expect(renameSpy).toHaveBeenCalledTimes(2);
        expect(unlink).not.toHaveBeenCalledWith(target);
        expect(await loadExecutionState(initial.id, tempDir)).toMatchObject({
          pipeline_snapshot: { name: 'replacement' },
        });
        expect(listStateDirectory(tempDir)).toEqual([targetName]);
      },
    );

    it.each(['writeFile', 'close'] as const)(
      'preserves the checkpoint and removes staging when %s fails',
      async (method) => {
        const initial = makeState();
        await saveExecutionState(initial, tempDir);
        const target = path.join(tempDir, targetName);
        const initialBytes = fs.readFileSync(target, 'utf8');
        const failure = new Error('staging failed');
        const open = fsPromises.open;
        jest.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (method === 'writeFile') {
            const writeFile = handle.writeFile.bind(handle);
            jest.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
              await writeFile('{"incomplete":', 'utf8');
              throw failure;
            });
          } else {
            jest.spyOn(handle, 'close').mockRejectedValueOnce(failure);
          }
          return handle;
        });
        const rename = jest.spyOn(fsPromises, 'rename');

        await expect(
          saveExecutionState(namedSnapshot(initial, 'replacement'), tempDir),
        ).rejects.toBe(failure);

        expect(rename).not.toHaveBeenCalled();
        expect(fs.readFileSync(target, 'utf8')).toBe(initialBytes);
        expect(listStateDirectory(tempDir)).toEqual([targetName]);
      },
    );

    it('syncs the snapshot before installing it (CAN-5736)', async () => {
      const open = fsPromises.open;
      const sync = jest.fn(() => Promise.resolve());
      const openSpy = jest
        .spyOn(fsPromises, 'open')
        .mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (/\.execution-1\.json\..+\.tmp$/.test(String(args[0])))
            jest.spyOn(handle, 'sync').mockImplementation(sync);
          return handle;
        });

      await saveExecutionState(makeState(), tempDir);

      expect(
        openSpy.mock.calls.filter(([filePath]) =>
          /\.execution-1\.json\..+\.tmp$/.test(String(filePath)),
        ),
      ).toHaveLength(1);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(listStateDirectory(tempDir)).toEqual([targetName]);
    });

    it('preserves the checkpoint when staging cannot be opened', async () => {
      const initial = makeState();
      await saveExecutionState(initial, tempDir);
      const target = path.join(tempDir, targetName);
      const initialBytes = fs.readFileSync(target, 'utf8');
      const failure = Object.assign(new Error('cannot create staging'), {
        code: 'EACCES',
      });
      jest.spyOn(fsPromises, 'open').mockRejectedValue(failure);
      const rename = jest.spyOn(fsPromises, 'rename');

      await expect(
        saveExecutionState(namedSnapshot(initial, 'replacement'), tempDir),
      ).rejects.toBe(failure);

      expect(rename).not.toHaveBeenCalled();
      expect(fs.readFileSync(target, 'utf8')).toBe(initialBytes);
      expect(listStateDirectory(tempDir)).toEqual([targetName]);
    });

    it('retains the install error when staging cleanup also fails, then allows a fresh save', async () => {
      const initial = makeState();
      await saveExecutionState(initial, tempDir);
      const target = path.join(tempDir, targetName);
      const initialBytes = fs.readFileSync(target, 'utf8');
      const failure = Object.assign(new Error('replacement failed'), {
        code: 'EIO',
      });
      jest.spyOn(fsPromises, 'rename').mockRejectedValueOnce(failure);
      jest
        .spyOn(fsPromises, 'unlink')
        .mockRejectedValueOnce(new Error('cleanup failed'));

      await expect(
        saveExecutionState(namedSnapshot(initial, 'failed'), tempDir),
      ).rejects.toBe(failure);
      expect(fs.readFileSync(target, 'utf8')).toBe(initialBytes);
      const stagedFiles = fs
        .readdirSync(tempDir)
        .filter((name) => name.endsWith('.tmp'));
      expect(stagedFiles).toHaveLength(1);
      const orphan = path.join(tempDir, stagedFiles[0]);
      const orphanBytes = fs.readFileSync(orphan, 'utf8');

      await saveExecutionState(namedSnapshot(initial, 'recovered'), tempDir);

      expect(fs.readFileSync(orphan, 'utf8')).toBe(orphanBytes);
      expect(await loadExecutionState(initial.id, tempDir)).toMatchObject({
        pipeline_snapshot: { name: 'recovered' },
      });
      expect(await listExecutionSummaries(tempDir)).toMatchObject([
        { id: initial.id, pipeline_name: 'recovered' },
      ]);
      expect(listStateDirectory(tempDir).sort()).toEqual(
        [...stagedFiles, targetName].sort(),
      );
    });

    it('does not overwrite or clean up a stale legacy temporary file', async () => {
      const stalePath = path.join(tempDir, targetName + '.tmp');
      fs.writeFileSync(stalePath, 'unclaimed staging data');

      await saveExecutionState(makeState(), tempDir);

      expect(fs.readFileSync(stalePath, 'utf8')).toBe('unclaimed staging data');
      expect(await loadExecutionState('execution-1', tempDir)).toMatchObject({
        id: 'execution-1',
      });
      expect(listStateDirectory(tempDir).sort()).toEqual([
        targetName,
        targetName + '.tmp',
      ]);
    });

    it('leaves no snapshot or temporary file when the first installation fails', async () => {
      const failure = Object.assign(new Error('replacement failed'), {
        code: 'EIO',
      });
      jest.spyOn(fsPromises, 'rename').mockRejectedValue(failure);
      await expect(saveExecutionState(makeState(), tempDir)).rejects.toBe(
        failure,
      );
      expect(listStateDirectory(tempDir)).toEqual([]);
    });
  });

  it('round-trips execution state and lists summaries', async () => {
    const state = makeState();
    await saveExecutionState(state, tempDir);

    const loaded = await loadExecutionState('execution-1', tempDir);
    expect(loaded).toMatchObject({
      id: state.id,
      version: 10,
      inputs_persisted: true,
    });
    expect(loaded?.env).toMatchObject({
      CANOPY_MODEL_CONFIG: '{"fastMode":false}',
      CANOPY_FAST_MODE_ENABLED: 'false',
    });
    await expect(listExecutionSummaries(tempDir)).resolves.toMatchObject([
      {
        id: 'execution-1',
        pipeline_id: 'state-test',
        pipeline_name: 'State Test',
        status: 'pending',
        started_at: state.started_at,
        completed_at: undefined,
        cwd: tempDir,
        event_name: 'dispatch',
        project_id: undefined,
        worktree_id: undefined,
        plan_modified: undefined,
        has_plan: undefined,
        has_report: undefined,
        status_reasons: [],
      },
    ]);
  });

  it('retains parsed states only for callers that explicitly request them', async () => {
    const state = makeState();
    await saveExecutionState(state, tempDir);

    const entries = await listExecutionSummariesWithStates(tempDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.summary.id).toBe(state.id);
    expect(entries[0]?.state).toMatchObject({ id: state.id, version: 10 });
  });

  it('includes has_report in execution summaries when report outputs exist', async () => {
    const state = makeState();
    state.report_outputs = {
      report_file: path.join(tempDir, 'report.md'),
    };
    await saveExecutionState(state, tempDir);

    await expect(listExecutionSummaries(tempDir)).resolves.toMatchObject([
      {
        id: 'execution-1',
        pipeline_id: 'state-test',
        pipeline_name: 'State Test',
        status: 'pending',
        started_at: state.started_at,
        completed_at: undefined,
        cwd: tempDir,
        event_name: 'dispatch',
        project_id: undefined,
        worktree_id: undefined,
        plan_modified: undefined,
        has_plan: undefined,
        has_report: true,
        status_reasons: [],
      },
    ]);
  });

  it('includes has_plan in execution summaries when a plan artifact exists', async () => {
    const state = makeState();
    state.plan_hash_after = 'plan-hash';
    await saveExecutionState(state, tempDir);

    await expect(listExecutionSummaries(tempDir)).resolves.toMatchObject([
      {
        id: 'execution-1',
        pipeline_id: 'state-test',
        pipeline_name: 'State Test',
        status: 'pending',
        started_at: state.started_at,
        completed_at: undefined,
        cwd: tempDir,
        event_name: 'dispatch',
        project_id: undefined,
        worktree_id: undefined,
        plan_modified: undefined,
        has_plan: true,
        has_report: undefined,
        status_reasons: [],
      },
    ]);
  });

  it('persists worktree association in execution summaries', async () => {
    const state = makeState();
    state.project_id = 'project-1';
    state.worktree_id = 'wt-1';
    await saveExecutionState(state, tempDir);

    await expect(listExecutionSummaries(tempDir)).resolves.toEqual([
      expect.objectContaining({
        id: 'execution-1',
        project_id: 'project-1',
        worktree_id: 'wt-1',
      }),
    ]);
  });

  it('includes parent lineage fields in summaries', async () => {
    const state = makeState();
    state.parent_execution_id = 'parent-exec-1';
    state.parent_step_id = 'deploy-step';
    state.parent_attempt = 2;
    state.parent_iteration = 1;
    await saveExecutionState(state, tempDir);

    const summaries = await listExecutionSummaries(tempDir);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].parent_execution_id).toBe('parent-exec-1');
    expect(summaries[0].parent_step_id).toBe('deploy-step');
    expect(summaries[0].parent_attempt).toBe(2);
    expect(summaries[0].parent_iteration).toBe(1);
  });

  it('computes child_count in listExecutionSummaries', async () => {
    const parent = makeState();
    parent.id = 'parent-1';
    await saveExecutionState(parent, tempDir);

    const child1 = makeState();
    child1.id = 'child-1';
    child1.parent_execution_id = 'parent-1';
    child1.parent_step_id = 'step-a';
    await saveExecutionState(child1, tempDir);

    const child2 = makeState();
    child2.id = 'child-2';
    child2.parent_execution_id = 'parent-1';
    child2.parent_step_id = 'step-b';
    await saveExecutionState(child2, tempDir);

    const grandchild = makeState();
    grandchild.id = 'grandchild-1';
    grandchild.parent_execution_id = 'child-1';
    grandchild.parent_step_id = 'step-c';
    await saveExecutionState(grandchild, tempDir);

    const summaries = await listExecutionSummaries(tempDir);
    const byId = Object.fromEntries(summaries.map((s) => [s.id, s]));

    expect(byId['parent-1'].child_count).toBe(2);
    expect(byId['child-1'].child_count).toBe(1);
    expect(byId['child-2'].child_count).toBeUndefined();
    expect(byId['grandchild-1'].child_count).toBeUndefined();
  });

  it('bounds concurrent state reads while listing summaries', async () => {
    for (let index = 0; index < 40; index += 1) {
      const state = makeState();
      state.id = `execution-${index}`;
      await saveExecutionState(state, tempDir);
    }

    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    let activeReads = 0;
    let maxActiveReads = 0;
    const readSpy = jest
      .spyOn(fs.promises, 'readFile')
      .mockImplementation(async (file, options) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          return await originalReadFile(file, options);
        } finally {
          activeReads -= 1;
        }
      });

    try {
      await expect(listExecutionSummaries(tempDir)).resolves.toHaveLength(40);
      expect(maxActiveReads).toBeGreaterThan(1);
      expect(maxActiveReads).toBeLessThanOrEqual(32);
    } finally {
      readSpy.mockRestore();
    }
  });

  describe('summary reuse across listings', () => {
    function stateReads(readSpy: jest.SpyInstance): string[] {
      return readSpy.mock.calls
        .map(([file]): string => String(file))
        .filter((file) => file.startsWith(tempDir) && file.endsWith('.json'))
        .map((file) => path.basename(file));
    }

    async function saveExecution(
      id: string,
      overrides: Partial<ExecutionState> = {},
    ): Promise<ExecutionState> {
      const state = { ...makeState(), id, ...overrides };
      await saveExecutionState(state, tempDir);
      return state;
    }

    it('does not re-read unchanged state files on repeated listings', async () => {
      for (let index = 0; index < 5; index += 1) {
        await saveExecution(`execution-${index}`);
      }
      const readSpy = jest.spyOn(fs.promises, 'readFile');
      try {
        await expect(listExecutionSummaries(tempDir)).resolves.toHaveLength(5);
        expect(stateReads(readSpy)).toHaveLength(5);

        readSpy.mockClear();
        await expect(listExecutionSummaries(tempDir)).resolves.toHaveLength(5);
        expect(stateReads(readSpy)).toEqual([]);
      } finally {
        readSpy.mockRestore();
      }
    });

    it('re-reads only a rewritten state file and reports its new contents', async () => {
      await saveExecution('execution-a');
      const changed = await saveExecution('execution-b');
      await saveExecution('execution-c');
      await listExecutionSummaries(tempDir);

      await saveExecutionState({ ...changed, status: 'success' }, tempDir);
      const readSpy = jest.spyOn(fs.promises, 'readFile');
      try {
        const summaries = await listExecutionSummaries(tempDir);
        expect(stateReads(readSpy)).toEqual(['execution-b.json']);
        expect(
          summaries.find((summary) => summary.id === 'execution-b')?.status,
        ).toBe('success');
      } finally {
        readSpy.mockRestore();
      }
    });

    it('drops deleted executions and recomputes child counts', async () => {
      await saveExecution('parent-1');
      await saveExecution('child-1', { parent_execution_id: 'parent-1' });
      await saveExecution('child-2', { parent_execution_id: 'parent-1' });
      const parentChildCount = async (): Promise<number | undefined> =>
        (await listExecutionSummaries(tempDir)).find(
          (summary) => summary.id === 'parent-1',
        )?.child_count;

      expect(await parentChildCount()).toBe(2);
      fs.rmSync(path.join(tempDir, 'child-2.json'));
      expect(await parentChildCount()).toBe(1);
      fs.rmSync(path.join(tempDir, 'child-1.json'));
      expect(await parentChildCount()).toBeUndefined();
      await expect(listExecutionSummaries(tempDir)).resolves.toMatchObject([
        { id: 'parent-1' },
      ]);
    });

    it('returns summaries that callers can change without affecting later listings', async () => {
      await saveExecution('execution-1');
      const [first] = await listExecutionSummaries(tempDir);
      if (!first) throw new Error('expected one summary');
      first.status = 'failure';
      first.status_reasons.push({
        id: 'caller-added',
        kind: 'app_shutdown',
        code: 'app_shutdown',
        detected_at: '2026-10-06T00:00:00.000Z',
        source: { job_id: 'build', step_id: 'first', attempt: 1, iteration: 0 },
      });

      await expect(listExecutionSummaries(tempDir)).resolves.toMatchObject([
        { id: 'execution-1', status: 'pending', status_reasons: [] },
      ]);
    });

    it('shares state reads between overlapping listings', async () => {
      for (let index = 0; index < 5; index += 1) {
        await saveExecution(`execution-${index}`);
      }
      const readSpy = jest.spyOn(fs.promises, 'readFile');
      try {
        const listings = await Promise.all([
          listExecutionSummaries(tempDir),
          listExecutionSummaries(tempDir),
          listExecutionSummaries(tempDir),
        ]);
        expect(listings.map((summaries) => summaries.length)).toEqual([
          5, 5, 5,
        ]);
        expect(stateReads(readSpy).sort()).toEqual([
          'execution-0.json',
          'execution-1.json',
          'execution-2.json',
          'execution-3.json',
          'execution-4.json',
        ]);
      } finally {
        readSpy.mockRestore();
      }
    });
  });

  it('lists execution summaries in descending creation order', async () => {
    const first = makeState();
    first.id = 'execution-first';
    first.started_at = '2026-03-10T10:00:00.000Z';

    const second = makeState();
    second.id = 'execution-second';
    second.started_at = '2026-03-10T10:05:00.000Z';

    const third = makeState();
    third.id = 'execution-third';
    third.started_at = '2026-03-10T10:03:00.000Z';

    await saveExecutionState(first, tempDir);
    await saveExecutionState(second, tempDir);
    await saveExecutionState(third, tempDir);

    await expect(listExecutionSummaries(tempDir)).resolves.toMatchObject([
      { id: 'execution-second' },
      { id: 'execution-third' },
      { id: 'execution-first' },
    ]);
  });

  it('rejects corrupted and unknown-version state files', async () => {
    fs.writeFileSync(path.join(tempDir, 'broken.json'), '{', 'utf8');
    fs.writeFileSync(
      path.join(tempDir, 'unknown.json'),
      JSON.stringify({ version: 999 }),
      'utf8',
    );

    await expect(loadExecutionState('broken', tempDir)).rejects.toThrow();
    await expect(loadExecutionState('unknown', tempDir)).rejects.toThrow(
      /Unsupported execution state version/,
    );
  });

  it('rejects unsafe execution ids before resolving state paths', async () => {
    await expect(loadExecutionState('../outside', tempDir)).rejects.toThrow(
      'Invalid executionId: must be lowercase alphanumeric with hyphens',
    );
  });

  it('rejects state whose persisted identity does not match its filename', async () => {
    const state = makeState();
    await saveExecutionState(state, tempDir);
    fs.copyFileSync(
      path.join(tempDir, `${state.id}.json`),
      path.join(tempDir, 'different-execution.json'),
    );

    await expect(
      loadExecutionState('different-execution', tempDir),
    ).rejects.toThrow(
      'Execution state identity mismatch: expected "different-execution"',
    );
  });

  it('migrates v1 execution state iteration fields and plugin fields to the current version on load', async () => {
    const state = makeState();
    state.id = 'execution-v1';
    state.version = 1;
    state.parent_iteration = 0;
    state.jobs.build.status = 'success';
    state.jobs.build.started_at = '2026-03-26T15:00:00.000Z';
    state.jobs.build.iteration_count = 0;
    state.jobs.build.iteration_history = [
      {
        iteration: 0,
        status: 'success',
        steps: cloneSteps(state.jobs.build.steps),
        started_at: '2026-03-26T15:00:00.000Z',
        completed_at: '2026-03-26T15:00:01.000Z',
      },
    ];
    state.jobs.build.retry_history = [
      {
        attempt: 0,
        status: 'failure',
        steps: cloneSteps(state.jobs.build.steps),
        iteration_history: [
          {
            iteration: 0,
            status: 'failure',
            steps: cloneSteps(state.jobs.build.steps),
            started_at: '2026-03-26T14:00:00.000Z',
            completed_at: '2026-03-26T14:00:01.000Z',
          },
        ],
      },
    ];

    fs.writeFileSync(
      path.join(tempDir, 'execution-v1.json'),
      JSON.stringify(state, null, 2),
      'utf8',
    );

    const migrated = await loadExecutionState('execution-v1', tempDir);

    expect(migrated?.version).toBe(10);
    expect(migrated?.parent_iteration).toBe(1);
    expect(migrated?.jobs.build.iteration_count).toBe(1);
    expect(migrated?.jobs.build.iteration_history?.[0].iteration).toBe(1);
    expect(
      migrated?.jobs.build.retry_history?.[0].iteration_history?.[0].iteration,
    ).toBe(1);
    expect(migrated?.pipeline_preference_locator).toBeUndefined();
    expect(migrated?.plugin_collection_preferences).toBeUndefined();
    expect(migrated?.resolved_plugin_collections).toBeUndefined();

    if (!migrated) {
      throw new Error('Expected migrated execution state');
    }
    await saveExecutionState(migrated, tempDir);
    const saved = parseJsonRecord(
      fs.readFileSync(path.join(tempDir, `${migrated.id}.json`), 'utf8'),
    );
    expect(saved.version).toBe(10);
  });

  it('migrates v2 execution states to the current version on load', async () => {
    const state = makeState();
    state.id = 'execution-v2';
    state.version = 2;
    fs.writeFileSync(
      path.join(tempDir, 'execution-v2.json'),
      JSON.stringify(state, null, 2),
      'utf8',
    );

    const migrated = await loadExecutionState('execution-v2', tempDir);

    expect(migrated?.version).toBe(10);
    expect(migrated?.pipeline_preference_locator).toBeUndefined();
    expect(migrated?.plugin_collection_preferences).toBeUndefined();
    expect(migrated?.resolved_plugin_collections).toBeUndefined();
  });

  it('migrates a newly parsed legacy state without cloning the full state', async () => {
    const state = makeState();
    const serialized = cloneSerializedRecord(state);
    serialized.id = 'execution-v2-large';
    serialized.version = 2;
    serialized.performance_payload = 'x'.repeat(1_000_000);
    fs.writeFileSync(
      path.join(tempDir, 'execution-v2-large.json'),
      JSON.stringify(serialized),
      'utf8',
    );
    const cloneSpy = jest.spyOn(global, 'structuredClone');
    try {
      await expect(
        loadExecutionState('execution-v2-large', tempDir),
      ).resolves.toMatchObject({ id: 'execution-v2-large', version: 10 });
      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it('backfills missing inputs when loading older state files', async () => {
    const state = makeState();
    const serialized = cloneSerializedRecord(state);
    serialized.id = 'execution-legacy';
    delete serialized.inputs;
    fs.writeFileSync(
      path.join(tempDir, 'execution-legacy.json'),
      JSON.stringify(serialized, null, 2),
      'utf8',
    );

    await expect(
      loadExecutionState('execution-legacy', tempDir),
    ).resolves.toMatchObject({
      id: 'execution-legacy',
      inputs: {},
    });
  });

  it('round-trips execution snapshots containing trigger_inputs', async () => {
    const normalized = normalizePipeline({
      name: 'Trigger snapshot',
      on: {
        dispatch: {
          inputs: {
            greeting: {
              type: 'string',
              required: true,
            },
          },
        },
        plan_ready: {
          inputs: {
            max_iterations: {
              type: 'number',
              default: 2,
              min: 1,
              max: 10,
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [{ id: 'first', run: 'echo first' }],
        },
      },
    });
    const state = createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'trigger-snapshot',
        runtime: {
          // Pipeline fixtures do not enforce an org model policy.
          isModelBlockedByOrgPolicy: (): Promise<boolean> =>
            Promise.resolve(false),
          isOrgModelPolicyActive: (): Promise<boolean> =>
            Promise.resolve(false),
          executionsDir: tempDir,
          tempRootDir: tempDir,
          bundledActionsDir: tempDir,
          getProjectActionsDir: (repoPath: string) => repoPath,
          getProjectPipelinesDir: (repoPath: string) => repoPath,
        },
        eventName: 'plan_ready',
      },
      'trigger-snapshot-exec',
      { max_iterations: 2 },
    );

    await saveExecutionState(state, tempDir);

    const loaded = await loadExecutionState('trigger-snapshot-exec', tempDir);

    expect(loaded?.pipeline_snapshot.trigger_inputs).toEqual({
      dispatch: {
        greeting: {
          type: 'string',
          required: true,
        },
      },
      plan_ready: {
        max_iterations: {
          type: 'number',
          default: 2,
          min: 1,
          max: 10,
        },
      },
    });
    expect(loaded?.pipeline_snapshot.inputs).toEqual({
      greeting: {
        type: 'string',
        required: true,
      },
    });
  });

  it('loads and resumes legacy snapshots that only persist pipeline_snapshot.inputs', async () => {
    const resultFile = path.join(tempDir, 'legacy-resume-result.txt');
    const normalized = normalizePipeline({
      name: 'Legacy snapshot resume',
      on: {
        dispatch: {
          inputs: {
            greeting: {
              type: 'string',
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [
            {
              id: 'write',
              run: `printf '%s' "$INPUT_GREETING" > "${resultFile}"`,
            },
          ],
        },
      },
    });
    const state = createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'legacy-snapshot-resume',
        runtime: {
          // Pipeline fixtures do not enforce an org model policy.
          isModelBlockedByOrgPolicy: (): Promise<boolean> =>
            Promise.resolve(false),
          isOrgModelPolicyActive: (): Promise<boolean> =>
            Promise.resolve(false),
          executionsDir: tempDir,
          tempRootDir: tempDir,
          bundledActionsDir: tempDir,
          getProjectActionsDir: (repoPath: string) => repoPath,
          getProjectPipelinesDir: (repoPath: string) => repoPath,
        },
      },
      'legacy-snapshot-resume-exec',
    );
    state.status = 'running';
    state.jobs.build.status = 'running';
    delete state.pipeline_snapshot.trigger_inputs;

    await saveExecutionState(state, tempDir);

    const loaded = await loadExecutionState(
      'legacy-snapshot-resume-exec',
      tempDir,
    );

    expect(loaded?.pipeline_snapshot.trigger_inputs).toBeUndefined();
    expect(loaded?.pipeline_snapshot.inputs).toEqual({
      greeting: {
        type: 'string',
      },
    });

    const resumed = await resumePipeline('legacy-snapshot-resume-exec', {
      cwd: tempDir,
      runtime: {
        // Pipeline fixtures do not enforce an org model policy.
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: tempDir,
        tempRootDir: tempDir,
        bundledActionsDir: tempDir,
        getProjectActionsDir: (repoPath: string) => repoPath,
        getProjectPipelinesDir: (repoPath: string) => repoPath,
      },
      inputs: {
        greeting: 'hello',
      },
    });
    const resumedState = await resumed.waitForCompletion();

    expect(resumedState.status).toBe('success');
    expect(resumedState.inputs).toEqual({ greeting: 'hello' });
    expect(fs.readFileSync(resultFile, 'utf8')).toBe('hello');
  });

  it('normalizes preserved rerun context when loading state files', async () => {
    const state = makeState();
    const serialized = cloneSerializedRecord(state);
    serialized.id = 'execution-rerun-context';
    serialized.rerun_context = {
      event_data: {
        plan_ready: {
          plan_text: 'Implement the approved plan',
          ignored: true,
        },
      },
    };
    fs.writeFileSync(
      path.join(tempDir, 'execution-rerun-context.json'),
      JSON.stringify(serialized, null, 2),
      'utf8',
    );

    await expect(
      loadExecutionState('execution-rerun-context', tempDir),
    ).resolves.toMatchObject({
      id: 'execution-rerun-context',
      rerun_context: {
        event_data: {
          plan_ready: {
            plan_text: 'Implement the approved plan',
          },
        },
      },
    });
  });

  it('recovers interrupted running work and finds resume points deterministically', () => {
    const state = makeState();
    state.status = 'running';
    state.jobs.build.status = 'running';
    state.jobs.build.steps.first = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: { version: '1.0.0' },
      dynamic_env: { VERSION: '1.0.0' },
    };
    state.jobs.build.steps.second = {
      status: 'running',
      outputs: { partial: 'maybe' },
      dynamic_env: { TMP: '1' },
      started_at: new Date().toISOString(),
      error: 'partial',
      exit_code: 1,
      log_file: '/tmp/log',
    };

    const recovered = recoverInterruptedState(state);

    expect(recovered.status).toBe('pending');
    expect(recovered.jobs.build.status).toBe('queued');
    expect(recovered.jobs.build.steps.second).toEqual({
      status: 'pending',
      outputs: {},
      dynamic_env: {},
    });
    expect(findResumePoint(recovered)).toEqual({
      jobId: 'build',
      stepId: 'second',
      stepIndex: 1,
    });
  });

  it('recovers restarting jobs by queueing them again', () => {
    const state = makeState();
    state.status = 'running';
    state.jobs.build.status = 'restarting';
    state.jobs.build.iteration_count = 2;
    state.jobs.build.iteration_history = [
      {
        iteration: 1,
        status: 'running',
        steps: cloneSteps(state.jobs.build.steps),
        started_at: '2026-03-26T13:00:00.000Z',
        completed_at: '2026-03-26T13:00:01.000Z',
      },
    ];
    state.jobs.build.report_outputs = {
      report_file: '/tmp/stale-report.md',
    };

    const recovered = recoverInterruptedState(state);

    expect(recovered.status).toBe('pending');
    expect(recovered.jobs.build.status).toBe('queued');
    expect(recovered.jobs.build.iteration_count).toBe(2);
    expect(recovered.jobs.build.iteration_history).toEqual(
      state.jobs.build.iteration_history,
    );
    expect(recovered.jobs.build.steps.first).toEqual({
      status: 'pending',
      outputs: {},
      dynamic_env: {},
    });
    expect(recovered.jobs.build.report_outputs).toBeUndefined();
  });

  it('recovery-created retries clear live iteration state', () => {
    const state = makeState({
      max_retries: 1,
    });
    markInterruptedHardFailure(state, 0);
    state.jobs.build.iteration_count = 1;
    state.jobs.build.iteration_history = [
      {
        iteration: 1,
        status: 'running',
        steps: cloneSteps(state.jobs.build.steps),
        started_at: '2026-03-26T14:00:00.000Z',
        completed_at: '2026-03-26T14:00:01.000Z',
      },
    ];

    const recovered = recoverInterruptedState(state);

    expect(recovered.jobs.build.retry_count).toBe(1);
    expect(recovered.jobs.build.iteration_count).toBe(1);
    expect(recovered.jobs.build.iteration_history).toBeUndefined();
    expect(recovered.jobs.build.retry_history?.[0].iteration_history).toEqual(
      state.jobs.build.iteration_history,
    );
  });

  it('retries before continue_on_error during recovery', () => {
    const state = makeState({
      continue_on_error: true,
      max_retries: 2,
    });
    markInterruptedHardFailure(state, 0);

    const recovered = recoverInterruptedState(state);

    expect(recovered.jobs.build.status).toBe('pending');
    expect(recovered.jobs.build.retry_count).toBe(1);
    expect(recovered.jobs.build.conclusion).toBeUndefined();
    expect(recovered.jobs.build.outcome).toBeUndefined();
    expect(recovered.jobs.build.steps.first).toEqual({
      status: 'pending',
      outputs: {},
      dynamic_env: {},
    });
    expect(recovered.jobs.build.retry_history).toHaveLength(1);
    expect(recovered.jobs.build.retry_history?.[0]).toMatchObject({
      attempt: 0,
      conclusion: 'failure',
      outcome: 'failure',
    });
  });

  it('applies continue_on_error after retries exhausted during recovery', () => {
    const state = makeState({
      continue_on_error: true,
      max_retries: 2,
    });
    markInterruptedHardFailure(state, 2);
    state.jobs.build.retry_history = [
      {
        attempt: 0,
        status: 'failure',
        conclusion: 'failure',
        outcome: 'failure',
        steps: cloneSteps(state.jobs.build.steps),
      },
      {
        attempt: 1,
        status: 'failure',
        conclusion: 'failure',
        outcome: 'failure',
        steps: cloneSteps(state.jobs.build.steps),
      },
    ];

    const recovered = recoverInterruptedState(state);

    expect(recovered.jobs.build.status).toBe('failure');
    expect(recovered.jobs.build.conclusion).toBe('success');
    expect(recovered.jobs.build.outcome).toBe('failure');
    expect(recovered.jobs.build.retry_count).toBe(2);
    expect(recovered.jobs.build.retry_history).toHaveLength(2);
  });

  it('recovers persisted failure with step-level continue_on_error for retry', () => {
    const state = makeState({ max_retries: 1 });
    state.status = 'running';
    state.jobs.build.status = 'failure';
    state.jobs.build.conclusion = 'failure';
    state.jobs.build.outcome = 'failure';
    state.jobs.build.retry_count = 0;
    // Step-level continue_on_error absorbed the failure: conclusion is 'success'
    state.jobs.build.steps.first = {
      status: 'success',
      conclusion: 'success',
      outcome: 'failure',
      outputs: {},
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };

    const recovered = recoverInterruptedState(state);

    expect(recovered.jobs.build.status).toBe('pending');
    expect(recovered.jobs.build.retry_count).toBe(1);
    expect(recovered.jobs.build.retry_history).toHaveLength(1);
    expect(recovered.jobs.build.retry_history?.[0]).toMatchObject({
      attempt: 0,
    });
  });

  it('reopens an action-less paused job without losing completed steps', () => {
    const state = makeState();
    state.status = 'paused';
    state.jobs.build.status = 'paused';
    state.jobs.build.steps.first = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: { artifact: 'dist/app.js' },
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };

    const recovered = recoverInterruptedState(state);

    expect(recovered.status).toBe('pending');
    expect(recovered.jobs.build.status).toBe('queued');
    expect(recovered.jobs.build.steps.first).toMatchObject({
      status: 'success',
      outputs: { artifact: 'dist/app.js' },
    });
  });

  it('keeps a job blocked by top-level pending input without status reasons', () => {
    const state = makeState();
    state.status = 'paused';
    state.jobs.build.status = 'paused';
    const request = {
      fields: [{ key: 'answer', label: 'Answer', type: 'string' as const }],
    };
    state.pending_input = {
      job_id: 'build',
      step_id: 'second',
      request,
    };

    const recovered = recoverInterruptedState(state);

    expect(recovered.status).toBe('pending');
    expect(recovered.jobs.build.status).toBe('paused');
    expect(recovered.pending_input).toEqual(state.pending_input);
  });

  it('keeps paused executions incomplete until resumed', () => {
    const state = makeState();
    state.status = 'paused';
    state.completed_at = new Date().toISOString();
    state.jobs.build.status = 'paused';

    const recovered = recoverInterruptedState(state);

    expect(recovered.status).toBe('pending');
    expect(recovered.completed_at).toBeUndefined();
    expect(findResumePoint(recovered)).toEqual({
      jobId: 'build',
      stepId: 'first',
      stepIndex: 0,
    });
  });

  it('prepares retry state by reopening only the failed dependency cone in place', () => {
    const normalized = normalizePipeline({
      name: 'Retry Cone',
      on: 'dispatch',
      jobs: {
        setup: {
          steps: [{ id: 'setup', run: 'echo setup' }],
        },
        build: {
          steps: [
            { id: 'first', run: 'echo first' },
            {
              id: 'soft_fail',
              run: 'echo soft fail',
              continue_on_error: true,
            },
            { id: 'after_failure', run: 'echo after failure' },
          ],
        },
        notify: {
          needs: 'build',
          if: 'failure()',
          steps: [{ id: 'notify', run: 'echo notify' }],
        },
      },
    });

    const state = createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'retry-cone',
        runtime: {
          // Pipeline fixtures do not enforce an org model policy.
          isModelBlockedByOrgPolicy: (): Promise<boolean> =>
            Promise.resolve(false),
          isOrgModelPolicyActive: (): Promise<boolean> =>
            Promise.resolve(false),
          executionsDir: tempDir,
          tempRootDir: tempDir,
          bundledActionsDir: tempDir,
          getProjectActionsDir: (repoPath: string) => repoPath,
          getProjectPipelinesDir: (repoPath: string) =>
            `${repoPath}/.canopy/pipelines`,
        },
      },
      'retry-cone-exec',
    );
    state.status = 'failure';
    state.completed_at = new Date().toISOString();
    state.error = 'build failed';
    state.plan_hash_before = 'before';
    state.plan_hash_after = 'after';
    state.report_outputs = {
      report_file: path.join(tempDir, 'report.md'),
    };

    state.jobs.setup.status = 'success';
    state.jobs.setup.conclusion = 'success';
    state.jobs.setup.outcome = 'success';
    state.jobs.setup.started_at = new Date().toISOString();
    state.jobs.setup.completed_at = new Date().toISOString();
    state.jobs.setup.steps.setup = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: { setup: 'done' },
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };

    state.jobs.build.status = 'failure';
    state.jobs.build.conclusion = 'failure';
    state.jobs.build.outcome = 'failure';
    state.jobs.build.started_at = new Date().toISOString();
    state.jobs.build.completed_at = new Date().toISOString();
    state.jobs.build.retry_count = 0;
    state.jobs.build.retry_history = [];
    state.jobs.build.steps.first = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: { first: 'done' },
      dynamic_env: { FIRST: 'done' },
      completed_at: new Date().toISOString(),
      report_outputs: {
        report_file: path.join(tempDir, 'first-report.md'),
      },
    };
    state.jobs.build.steps.soft_fail = {
      status: 'success',
      conclusion: 'success',
      outcome: 'failure',
      outputs: { soft_fail: '1' },
      dynamic_env: { SOFT_FAIL: '1' },
      completed_at: new Date().toISOString(),
    };
    state.jobs.build.steps.after_failure = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: { after_failure: 'done' },
      dynamic_env: {},
      completed_at: new Date().toISOString(),
      report_outputs: {
        report_json_file: path.join(tempDir, 'after-failure-report.json'),
      },
    };
    state.jobs.build.report_outputs = {
      report_file: path.join(tempDir, 'first-report.md'),
      report_json_file: path.join(tempDir, 'after-failure-report.json'),
    };

    state.jobs.notify.status = 'success';
    state.jobs.notify.conclusion = 'success';
    state.jobs.notify.outcome = 'success';
    state.jobs.notify.started_at = new Date().toISOString();
    state.jobs.notify.completed_at = new Date().toISOString();
    state.jobs.notify.retry_count = 2;
    state.jobs.notify.retry_history = [
      {
        attempt: 0,
        status: 'failure',
        conclusion: 'failure',
        outcome: 'failure',
        steps: {},
      },
      {
        attempt: 1,
        status: 'failure',
        conclusion: 'failure',
        outcome: 'failure',
        steps: {},
      },
    ];
    state.jobs.notify.steps.notify = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: { notified: 'true' },
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };

    const retried = prepareRetryState(state);

    expect(retried.status).toBe('pending');
    expect(retried.completed_at).toBeUndefined();
    expect(retried.error).toBeUndefined();
    expect(retried.report_outputs).toBeUndefined();
    expect(retried.plan_hash_before).toBeUndefined();
    expect(retried.plan_hash_after).toBeUndefined();

    expect(retried.jobs.setup.status).toBe('success');
    expect(retried.jobs.setup.steps.setup.status).toBe('success');

    expect(retried.jobs.build.status).toBe('pending');
    expect(retried.jobs.build.started_at).toBeUndefined();
    expect(retried.jobs.build.completed_at).toBeUndefined();
    expect(retried.jobs.build.retry_count).toBe(0);
    expect(retried.jobs.build.retry_history).toEqual([]);
    expect(retried.jobs.build.steps.first).toMatchObject({
      status: 'success',
      outputs: { first: 'done' },
    });
    expect(retried.jobs.build.report_outputs).toEqual({
      report_file: path.join(tempDir, 'first-report.md'),
    });
    expect(retried.jobs.build.steps.soft_fail).toEqual({
      status: 'pending',
      outputs: {},
      dynamic_env: {},
    });
    expect(retried.jobs.build.steps.after_failure).toEqual({
      status: 'pending',
      outputs: {},
      dynamic_env: {},
    });

    expect(retried.jobs.notify.status).toBe('pending');
    expect(retried.jobs.notify.retry_count).toBe(0);
    expect(retried.jobs.notify.retry_history).toEqual([]);
    expect(retried.jobs.notify.steps.notify).toEqual({
      status: 'pending',
      outputs: {},
      dynamic_env: {},
    });
  });

  it('prepares retry state by reopening cancelled jobs and downstream jobs', () => {
    const normalized = normalizePipeline({
      name: 'Cancelled Retry Cone',
      on: 'dispatch',
      jobs: {
        setup: {
          steps: [{ id: 'setup', run: 'echo setup' }],
        },
        build: {
          needs: 'setup',
          steps: [
            { id: 'first', run: 'echo first' },
            { id: 'cancelled_step', run: 'echo cancelled' },
            { id: 'after_cancel', run: 'echo after cancel' },
          ],
        },
        notify: {
          needs: 'build',
          steps: [{ id: 'notify', run: 'echo notify' }],
        },
      },
    });

    const state = createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'cancelled-retry-cone',
        runtime: {
          // Pipeline fixtures do not enforce an org model policy.
          isModelBlockedByOrgPolicy: (): Promise<boolean> =>
            Promise.resolve(false),
          isOrgModelPolicyActive: (): Promise<boolean> =>
            Promise.resolve(false),
          executionsDir: tempDir,
          tempRootDir: tempDir,
          bundledActionsDir: tempDir,
          getProjectActionsDir: (repoPath: string) => repoPath,
          getProjectPipelinesDir: (repoPath: string) =>
            `${repoPath}/.canopy/pipelines`,
        },
      },
      'cancelled-retry-cone-exec',
    );

    state.status = 'cancelled';
    state.completed_at = new Date().toISOString();
    state.error = 'cancelled by user';
    state.report_outputs = {
      report_file: path.join(tempDir, 'report.md'),
    };

    state.jobs.setup.status = 'success';
    state.jobs.setup.conclusion = 'success';
    state.jobs.setup.outcome = 'success';
    state.jobs.setup.started_at = new Date().toISOString();
    state.jobs.setup.completed_at = new Date().toISOString();
    state.jobs.setup.steps.setup = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: { setup: 'done' },
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };

    state.jobs.build.status = 'cancelled';
    state.jobs.build.conclusion = 'cancelled';
    state.jobs.build.outcome = 'cancelled';
    state.jobs.build.started_at = new Date().toISOString();
    state.jobs.build.completed_at = new Date().toISOString();
    state.jobs.build.steps.first = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: { first: 'done' },
      dynamic_env: { FIRST: 'done' },
      completed_at: new Date().toISOString(),
    };
    state.jobs.build.steps.cancelled_step = {
      status: 'cancelled',
      conclusion: 'cancelled',
      outcome: 'cancelled',
      outputs: {},
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };
    state.jobs.build.steps.after_cancel = {
      status: 'cancelled',
      conclusion: 'cancelled',
      outcome: 'cancelled',
      outputs: {},
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };

    state.jobs.notify.status = 'cancelled';
    state.jobs.notify.conclusion = 'cancelled';
    state.jobs.notify.outcome = 'cancelled';
    state.jobs.notify.completed_at = new Date().toISOString();
    state.jobs.notify.steps.notify = {
      status: 'cancelled',
      conclusion: 'cancelled',
      outcome: 'cancelled',
      outputs: {},
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };

    const retried = prepareRetryState(state);

    expect(retried.status).toBe('pending');
    expect(retried.completed_at).toBeUndefined();
    expect(retried.error).toBeUndefined();
    expect(retried.report_outputs).toBeUndefined();

    expect(retried.jobs.setup.status).toBe('success');
    expect(retried.jobs.setup.steps.setup).toMatchObject({
      status: 'success',
      outputs: { setup: 'done' },
    });

    expect(retried.jobs.build.status).toBe('pending');
    expect(retried.jobs.build.conclusion).toBeUndefined();
    expect(retried.jobs.build.outcome).toBeUndefined();
    expect(retried.jobs.build.steps.first).toMatchObject({
      status: 'success',
      outputs: { first: 'done' },
    });
    expect(retried.jobs.build.steps.cancelled_step).toEqual({
      status: 'pending',
      outputs: {},
      dynamic_env: {},
    });
    expect(retried.jobs.build.steps.after_cancel).toEqual({
      status: 'pending',
      outputs: {},
      dynamic_env: {},
    });

    expect(retried.jobs.notify.status).toBe('pending');
    expect(retried.jobs.notify.steps.notify).toEqual({
      status: 'pending',
      outputs: {},
      dynamic_env: {},
    });
  });

  it.each(['failure', 'cancelled'] as const)(
    'reopens both failed and cancelled jobs when retrying a %s execution',
    (executionStatus) => {
      const normalized = normalizePipeline({
        name: 'Mixed Failure Retry',
        on: 'dispatch',
        jobs: {
          failed: {
            continue_on_error: true,
            steps: [
              { id: 'completed', run: 'echo completed' },
              { id: 'failed', run: 'exit 1' },
            ],
          },
          cancelled: {
            steps: [{ id: 'cancelled', run: 'echo cancelled' }],
          },
        },
      });
      const state = createInitialState(
        normalized,
        {
          cwd: tempDir,
          pipelineId: 'mixed-failure-retry',
          runtime: {
            // Pipeline fixtures do not enforce an org model policy.
            isModelBlockedByOrgPolicy: (): Promise<boolean> =>
              Promise.resolve(false),
            isOrgModelPolicyActive: (): Promise<boolean> =>
              Promise.resolve(false),
            executionsDir: tempDir,
            tempRootDir: tempDir,
            bundledActionsDir: tempDir,
            getProjectActionsDir: (repoPath: string) => repoPath,
            getProjectPipelinesDir: (repoPath: string) => repoPath,
          },
        },
        `mixed-failure-retry-${executionStatus}`,
      );

      state.status = executionStatus;
      state.completed_at = new Date().toISOString();
      state.jobs.failed.status = 'failure';
      state.jobs.failed.outcome = 'failure';
      state.jobs.failed.conclusion = 'success';
      state.jobs.failed.completed_at = new Date().toISOString();
      state.jobs.failed.steps.completed = {
        status: 'success',
        outcome: 'success',
        conclusion: 'success',
        outputs: { completed: 'true' },
        dynamic_env: {},
        completed_at: new Date().toISOString(),
      };
      state.jobs.failed.steps.failed = {
        status: 'failure',
        outcome: 'failure',
        conclusion: 'failure',
        outputs: {},
        dynamic_env: {},
        completed_at: new Date().toISOString(),
      };
      state.jobs.cancelled.status = 'cancelled';
      state.jobs.cancelled.outcome = 'cancelled';
      state.jobs.cancelled.conclusion = 'cancelled';
      state.jobs.cancelled.completed_at = new Date().toISOString();
      state.jobs.cancelled.steps.cancelled = {
        status: 'cancelled',
        outcome: 'cancelled',
        conclusion: 'cancelled',
        outputs: {},
        dynamic_env: {},
        completed_at: new Date().toISOString(),
      };

      const retried = prepareRetryState(state);

      expect(retried.jobs.failed.status).toBe('pending');
      expect(retried.jobs.failed.conclusion).toBeUndefined();
      expect(retried.jobs.failed.steps.completed).toMatchObject({
        status: 'success',
        outputs: { completed: 'true' },
      });
      expect(retried.jobs.failed.steps.failed).toEqual({
        status: 'pending',
        outputs: {},
        dynamic_env: {},
      });
      expect(retried.jobs.cancelled.status).toBe('pending');
      expect(retried.jobs.cancelled.steps.cancelled).toEqual({
        status: 'pending',
        outputs: {},
        dynamic_env: {},
      });
    },
  );

  it('prepares retry state for executor failures without failed jobs', () => {
    const normalized = normalizePipeline({
      name: 'Executor Failure Retry',
      on: 'dispatch',
      jobs: {
        setup: {
          steps: [{ id: 'setup', run: 'echo setup' }],
        },
        build: {
          needs: 'setup',
          steps: [{ id: 'build', run: 'echo build' }],
        },
      },
    });

    const state = createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'executor-failure-retry',
        runtime: {
          // Pipeline fixtures do not enforce an org model policy.
          isModelBlockedByOrgPolicy: (): Promise<boolean> =>
            Promise.resolve(false),
          isOrgModelPolicyActive: (): Promise<boolean> =>
            Promise.resolve(false),
          executionsDir: tempDir,
          tempRootDir: tempDir,
          bundledActionsDir: tempDir,
          getProjectActionsDir: (repoPath: string) => repoPath,
          getProjectPipelinesDir: (repoPath: string) =>
            `${repoPath}/.canopy/pipelines`,
        },
      },
      'executor-failure-retry-exec',
    );

    state.status = 'failure';
    state.completed_at = new Date().toISOString();
    state.error = 'invalid max_iterations';

    state.jobs.setup.status = 'success';
    state.jobs.setup.conclusion = 'success';
    state.jobs.setup.outcome = 'success';
    state.jobs.setup.started_at = new Date().toISOString();
    state.jobs.setup.completed_at = new Date().toISOString();
    state.jobs.setup.steps.setup = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: { setup: 'done' },
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };

    state.jobs.build.status = 'queued';

    const retried = prepareRetryState(state);

    expect(retried.status).toBe('pending');
    expect(retried.completed_at).toBeUndefined();
    expect(retried.error).toBeUndefined();
    expect(retried.jobs.setup.status).toBe('success');
    expect(retried.jobs.setup.steps.setup).toMatchObject({
      status: 'success',
      outputs: { setup: 'done' },
    });
    expect(retried.jobs.build.status).toBe('pending');
    expect(retried.jobs.build.conclusion).toBeUndefined();
    expect(retried.jobs.build.outcome).toBeUndefined();
    expect(retried.jobs.build.retry_count).toBe(0);
    expect(retried.jobs.build.retry_history).toEqual([]);
    expect(retried.jobs.build.steps.build).toEqual({
      status: 'pending',
      outputs: {},
      dynamic_env: {},
    });
  });

  it('reopens the current failed attempt in place after automatic retries were exhausted', () => {
    const normalized = normalizePipeline({
      name: 'Preserve retry metadata',
      on: 'dispatch',
      jobs: {
        build: {
          max_retries: 1,
          steps: [
            { id: 'first', run: 'echo first' },
            { id: 'second', run: 'echo second' },
          ],
        },
      },
    });

    const state = createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'preserve-retry-metadata',
        runtime: {
          // Pipeline fixtures do not enforce an org model policy.
          isModelBlockedByOrgPolicy: (): Promise<boolean> =>
            Promise.resolve(false),
          isOrgModelPolicyActive: (): Promise<boolean> =>
            Promise.resolve(false),
          executionsDir: tempDir,
          tempRootDir: tempDir,
          bundledActionsDir: tempDir,
          getProjectActionsDir: (repoPath: string) => repoPath,
          getProjectPipelinesDir: (repoPath: string) =>
            `${repoPath}/.canopy/pipelines`,
        },
      },
      'preserve-retry-metadata-exec',
    );

    state.status = 'failure';
    state.jobs.build.status = 'failure';
    state.jobs.build.conclusion = 'failure';
    state.jobs.build.outcome = 'failure';
    state.jobs.build.retry_count = 1;
    state.jobs.build.retry_history = [
      {
        attempt: 0,
        status: 'failure',
        conclusion: 'failure',
        outcome: 'failure',
        steps: {
          first: {
            status: 'failure',
            conclusion: 'failure',
            outcome: 'failure',
            outputs: {},
            dynamic_env: {},
          },
          second: {
            status: 'pending',
            outputs: {},
            dynamic_env: {},
          },
        },
      },
    ];
    state.jobs.build.steps.first = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: { first: 'done' },
      dynamic_env: { FIRST: 'done' },
      completed_at: new Date().toISOString(),
    };
    state.jobs.build.steps.second = {
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      outputs: {},
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };

    const retried = prepareRetryState(state);

    expect(retried.jobs.build.retry_count).toBe(1);
    expect(retried.jobs.build.retry_history).toEqual([
      {
        attempt: 0,
        status: 'failure',
        conclusion: 'failure',
        outcome: 'failure',
        steps: {
          first: {
            status: 'failure',
            conclusion: 'failure',
            outcome: 'failure',
            outputs: {},
            dynamic_env: {},
          },
          second: {
            status: 'pending',
            outputs: {},
            dynamic_env: {},
          },
        },
      },
    ]);
    expect(retried.jobs.build.steps.first).toMatchObject({
      status: 'success',
      outputs: { first: 'done' },
    });
    expect(retried.jobs.build.steps.second).toEqual({
      status: 'pending',
      outputs: {},
      dynamic_env: {},
    });
  });

  it('rejects retry preparation for child or non-failed executions', () => {
    const pending = makeState();
    expect(() => prepareRetryState(pending)).toThrow(/cannot be retried/);

    const child = makeState();
    child.status = 'failure';
    child.parent_execution_id = 'parent-exec';
    child.jobs.build.status = 'failure';
    child.jobs.build.conclusion = 'failure';
    child.jobs.build.outcome = 'failure';
    child.jobs.build.steps.first = {
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      outputs: {},
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };

    expect(() => prepareRetryState(child)).toThrow(
      /Only root executions can be retried/,
    );
  });
});

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInitialState,
  normalizePipeline,
  saveExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor';
import type { ExecutionRuntime } from '@canopy/execution-engine/node/pipelines/executor/types';
import { cleanupWorktreePipelines } from '../pipelines/worktree-cleanup';

it('installs the archived copy durably before deleting the live execution', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'execution-relocation-'));
  try {
    const archive = join(dir, 'archive');
    const runtime: ExecutionRuntime = {
      isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
      isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
      executionsDir: dir,
      tempRootDir: dir,
      bundledActionsDir: dir,
      getProjectActionsDir: (repoPath: string): string => repoPath,
      getProjectPipelinesDir: (repoPath: string): string => repoPath,
    };
    const state = createInitialState(
      normalizePipeline({
        name: 'Archive relocation',
        on: 'dispatch',
        jobs: { main: { steps: [{ id: 'work', run: 'echo ok' }] } },
      }),
      {
        cwd: dir,
        pipelineId: 'relocation',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        runtime,
      },
      'relocation',
    );
    state.status = 'success';
    state.jobs.main.status = 'success';
    state.jobs.main.steps.work.status = 'success';
    await saveExecutionState(state, dir);
    let synced = false;
    let syncedBeforeDelete = false;
    let archiveExistedBeforeDelete = false;
    const open = fs.open;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (
        String(args[0]).startsWith(archive) &&
        String(args[0]).endsWith('.tmp')
      ) {
        const sync = handle.sync.bind(handle);
        jest.spyOn(handle, 'sync').mockImplementation(async () => {
          await sync();
          synced = true;
        });
      }
      return handle;
    });
    const unlink = fs.unlink;
    jest.spyOn(fs, 'unlink').mockImplementation(async (filePath) => {
      if (String(filePath) === join(dir, 'relocation.json')) {
        await fs.access(join(archive, 'relocation.json'));
        archiveExistedBeforeDelete = true;
        syncedBeforeDelete = synced;
      }
      await unlink(filePath);
    });

    const result = await cleanupWorktreePipelines(
      'workspace-1',
      'worktree-1',
      runtime,
      { relocateArtifactsTo: archive },
    );

    expect(result).toEqual({
      warnings: [],
      relocatedCount: 1,
      failedRelocationIds: [],
    });
    expect(archiveExistedBeforeDelete).toBe(true);
    expect(syncedBeforeDelete).toBe(true);
  } finally {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'syncs the copied artifacts before deleting the live ones (sync fails: %s)',
  async (syncFails) => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'execution-artifacts-'));
    try {
      const archive = join(dir, 'archive');
      const runtime: ExecutionRuntime = {
        isModelBlockedByOrgPolicy: (): Promise<boolean> =>
          Promise.resolve(false),
        isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
        executionsDir: dir,
        tempRootDir: dir,
        bundledActionsDir: dir,
        getProjectActionsDir: (repoPath: string): string => repoPath,
        getProjectPipelinesDir: (repoPath: string): string => repoPath,
      };
      const state = createInitialState(
        normalizePipeline({
          name: 'Artifact relocation',
          on: 'dispatch',
          jobs: { main: { steps: [{ id: 'work', run: 'echo ok' }] } },
        }),
        {
          cwd: dir,
          pipelineId: 'relocation',
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          runtime,
        },
        'relocation',
      );
      state.status = 'success';
      state.jobs.main.status = 'success';
      state.jobs.main.steps.work.status = 'success';
      await saveExecutionState(state, dir);
      const liveLog = join(dir, 'relocation', 'logs', 'work.log');
      const copiedLog = join(archive, 'relocation', 'logs', 'work.log');
      await fs.mkdir(join(dir, 'relocation', 'logs'), { recursive: true });
      await fs.writeFile(liveLog, 'step output');
      const synced: string[] = [];
      const open = fs.open;
      jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]) === copiedLog) {
          jest.spyOn(handle, 'sync').mockImplementation(() => {
            if (syncFails) return Promise.reject(new Error('sync failed'));
            synced.push(copiedLog);
            return Promise.resolve();
          });
        }
        return handle;
      });

      const result = await cleanupWorktreePipelines(
        'workspace-1',
        'worktree-1',
        runtime,
        { relocateArtifactsTo: archive },
      );

      if (syncFails) {
        expect(result.failedRelocationIds).toEqual(['relocation']);
        expect(await fs.readFile(liveLog, 'utf8')).toBe('step output');
      } else {
        expect(result.relocatedCount).toBe(1);
        expect(synced).toEqual([copiedLog]);
        expect(await fs.readFile(copiedLog, 'utf8')).toBe('step output');
        await expect(fs.access(liveLog)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    } finally {
      jest.restoreAllMocks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

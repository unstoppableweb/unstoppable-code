import {
  authorizePipelineContextResources,
  pipelineContextResources,
} from '@canopy/desktop-shared/node/background-execution-context';
import type { ChildPipelineAuthorization } from '@canopy/execution-engine/node/pipelines/executor/child-pipeline-resolver';
jest.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}));

const wakeLockAcquireMock = jest.fn();
const wakeLockReleaseMock = jest.fn();

jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: jest.fn(() => ({
    acquire: wakeLockAcquireMock,
    release: wakeLockReleaseMock,
  })),
}));

jest.mock('../plugins/shareable-plugin-resolution', () => ({
  loadShareablePluginCatalog: jest.fn(() =>
    Promise.resolve({
      skills: [],
      plugins: [],
    }),
  ),
  matchShareablePluginRef: jest.fn((ref: unknown) => ({
    ref,
    matchState: 'unmatched',
  })),
}));

import { recoverOrphanedPipelineExecutions } from '@canopy/execution-engine/node/pipelines/executor/crash-recovery';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cancelPipelineExecution,
  createInitialState,
  executePipeline,
  groupJobsByTier,
  isKnownOrphanedExecution,
  listExecutionSummaries,
  loadExecutionState,
  normalizePipeline,
  rerunPipelineExecution,
  resumePipeline,
  retryPipelineExecution,
  retryMatrixJobExecution,
  saveExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor';
import type {
  ExecutionRuntime,
  ExecutionState,
  ResolvePipelineTargetResult,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import type {
  Pipeline,
  PipelinePreferenceLocator,
} from '@canopy/execution-engine/types/pipeline';
import {
  createTrackedPlan,
  listTrackedPlans,
  updateTrackedPlan,
} from '../lib/plan-persistence';
import { savePipelinePluginCollectionPreferences } from '@canopy/execution-engine/node/pipelines/plugin-collection-store';
import {
  computePipelinePackageDigestSync,
  hashPipelinePackageYaml,
  installPipelinePackageAtomically,
} from '@canopy/desktop-shared/node';
import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let deferredResolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    deferredResolve = resolve;
  });
  if (!deferredResolve) {
    throw new Error('Expected the deferred resolver to be initialized');
  }
  return { promise, resolve: deferredResolve };
}

function createRuntime(rootDir: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(rootDir, 'executions'),
    tempRootDir: path.join(rootDir, 'tmp'),
    bundledActionsDir: path.join(rootDir, 'actions'),
    getProjectActionsDir: (repoPath: string) =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath: string) =>
      path.join(repoPath, '.canopy', 'pipelines'),
    resolvePipelineTarget: (request): Promise<ResolvePipelineTargetResult> => {
      if (request.requested.scope !== 'worktree') {
        throw new Error('Unexpected non-worktree target in test resolver');
      }
      const worktreeId =
        'id' in request.requested.worktree
          ? request.requested.worktree.id
          : 'new-worktree';
      const targetPath =
        request.parent.target?.scope === 'worktree' &&
        request.parent.target.worktree_id === worktreeId
          ? request.parent.target.path
          : request.parent.cwd;
      return Promise.resolve({
        cwd: targetPath,
        scope: 'worktree',
        target: {
          scope: 'worktree',
          workspace_id: request.requested.workspace_id,
          worktree_id: worktreeId,
          path: targetPath,
          created: !('id' in request.requested.worktree),
        },
        projectId: request.requested.workspace_id,
        worktreeId,
        repoPath: targetPath,
      });
    },
    planPersistence: {
      createTrackedPlan,
      updateTrackedPlan,
    },
  };
}

async function waitForPathToDisappear(
  targetPath: string,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (fs.existsSync(targetPath)) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for ${targetPath} to be removed`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function expectValidTimestamp(value: string | undefined): number {
  expect(value).toBeDefined();
  const timestamp = Date.parse(value ?? '');
  expect(Number.isNaN(timestamp)).toBe(false);
  return timestamp;
}

function expectTimestampRange(
  startedAt: string | undefined,
  completedAt: string | undefined,
): void {
  const startedAtMs = expectValidTimestamp(startedAt);
  const completedAtMs = expectValidTimestamp(completedAt);
  expect(completedAtMs).toBeGreaterThanOrEqual(startedAtMs);
}

function expectTimestampOverlap(
  firstStartedAt: string | undefined,
  firstCompletedAt: string | undefined,
  secondStartedAt: string | undefined,
  secondCompletedAt: string | undefined,
): void {
  const firstStartedAtMs = expectValidTimestamp(firstStartedAt);
  const firstCompletedAtMs = expectValidTimestamp(firstCompletedAt);
  const secondStartedAtMs = expectValidTimestamp(secondStartedAt);
  const secondCompletedAtMs = expectValidTimestamp(secondCompletedAt);
  const overlapStartedAtMs = Math.max(firstStartedAtMs, secondStartedAtMs);
  const overlapCompletedAtMs = Math.min(
    firstCompletedAtMs,
    secondCompletedAtMs,
  );

  expect(overlapCompletedAtMs - overlapStartedAtMs).toBeGreaterThan(0);
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('pipeline-executor', () => {
  it('keeps a rerun shared snapshot independent of the source execution directory', async () => {
    const raw =
      'name: Saved\non: dispatch\njobs:\n  build:\n    steps:\n      - run: exit 1\n';
    const cachedPipelinePath = path.join(
      runtime.executionsDir,
      'shared-source',
      'shared-pipeline.yaml',
    );
    fs.mkdirSync(path.dirname(cachedPipelinePath), { recursive: true });
    fs.writeFileSync(cachedPipelinePath, raw);
    const original = await executePipeline(
      {
        name: 'Saved',
        on: 'dispatch',
        jobs: { build: { steps: [{ run: 'exit 1' }] } },
      },
      {
        cwd: tempDir,
        pipelineId: 'shared:canopy-cloud:remote-1',
        executionId: 'shared-source',
        runtime,
        sharedPipelineSource: {
          type: 'shared',
          serverId: 'canopy-cloud',
          serverName: 'Cloud',
          remoteId: 'remote-1',
          cachedPipelinePath,
          fetchedAt: '2026-01-01T00:00:00Z',
        },
      },
    );
    const source = await original.waitForCompletion();
    const rerun = await rerunPipelineExecution(source.id, {
      cwd: tempDir,
      runtime,
    });
    const rerunState = await rerun.waitForCompletion();
    const copied = rerunState.shared_pipeline_source?.cachedPipelinePath;
    expect(copied).toBeDefined();
    expect(copied).not.toBe(cachedPipelinePath);
    expect(fs.readFileSync(copied ?? '', 'utf8')).toBe(raw);
    fs.rmSync(cachedPipelinePath);
    await expect(
      rerunPipelineExecution(source.id, {
        cwd: tempDir,
        runtime,
        executionId: 'missing-shared-cache',
      }),
    ).rejects.toThrow('shared workflow snapshot is unavailable');
    await expect(
      loadExecutionState('missing-shared-cache', runtime.executionsDir),
    ).resolves.toBeNull();
    expect(
      fs.existsSync(path.join(runtime.executionsDir, 'missing-shared-cache')),
    ).toBe(false);
    const existingOutputDir = path.join(
      runtime.executionsDir,
      'existing-shared-cache',
    );
    fs.mkdirSync(existingOutputDir, { recursive: true });
    fs.writeFileSync(path.join(existingOutputDir, 'keep.txt'), 'keep');
    await expect(
      rerunPipelineExecution(source.id, {
        cwd: tempDir,
        runtime,
        executionId: 'existing-shared-cache',
      }),
    ).rejects.toThrow('shared workflow snapshot is unavailable');
    expect(
      fs.readFileSync(path.join(existingOutputDir, 'keep.txt'), 'utf8'),
    ).toBe('keep');
    const explicitPath = path.join(tempDir, 'explicit-shared.yaml');
    fs.writeFileSync(explicitPath, raw);
    if (!source.shared_pipeline_source)
      throw new Error('Expected shared source');
    const explicit = await rerunPipelineExecution(source.id, {
      cwd: tempDir,
      runtime,
      sharedPipelineSource: {
        ...source.shared_pipeline_source,
        cachedPipelinePath: explicitPath,
      },
    });
    expect(
      (await explicit.waitForCompletion()).shared_pipeline_source
        ?.cachedPipelinePath,
    ).toBe(explicitPath);
    fs.rmSync(path.dirname(cachedPipelinePath), { recursive: true });
    const retry = await retryPipelineExecution(rerunState.id, {
      cwd: tempDir,
      runtime,
    });
    expect((await retry.waitForCompletion()).status).toBe('failure');
  });
  let tempDir: string;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-pipeline-executor-'),
    );
    runtime = createRuntime(tempDir);
    fs.mkdirSync(runtime.bundledActionsDir, { recursive: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stops the run clock while the execution is paused and resumes it on resume', async () => {
    const pipeline: Pipeline = {
      name: 'Pause clock',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
            { id: 'finish', run: 'echo done' },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'pause-clock',
      executionId: 'pause-clock-exec',
      runtime,
    });
    const paused = await handle.waitForCompletion();
    expect(paused.status).toBe('paused');

    // The pause instant is recorded, and no pause window has closed yet.
    const pausedAtMs = expectValidTimestamp(paused.paused_at);
    expect(pausedAtMs).toBeGreaterThanOrEqual(
      expectValidTimestamp(paused.started_at),
    );
    expect(paused.paused_ms ?? 0).toBe(0);

    const pauseWindowMs = 250;
    await new Promise((resolve) => setTimeout(resolve, pauseWindowMs));

    const resumed = await resumePipeline('pause-clock-exec', {
      cwd: tempDir,
      runtime,
    });
    const finished = await resumed.waitForCompletion();
    expect(finished.status).toBe('success');

    // The whole time spent paused is banked and excluded from run time.
    expect(finished.paused_at).toBeUndefined();
    expect(finished.paused_ms ?? 0).toBeGreaterThanOrEqual(pauseWindowMs);

    const wallClockMs =
      expectValidTimestamp(finished.completed_at) -
      expectValidTimestamp(finished.started_at);
    const runMs = wallClockMs - (finished.paused_ms ?? 0);
    expect(runMs).toBeGreaterThanOrEqual(0);
    expect(runMs).toBeLessThan(wallClockMs - pauseWindowMs + 1);
  });

  it('preserves curated revision provenance and resumes its original snapshot after a catalog update', async () => {
    const source = {
      key: 'review',
      contentHash: 'a'.repeat(64),
      revision: 1,
      cachedPipelinePath: path.join(
        tempDir,
        'managed',
        'old-hash',
        'pipeline.yaml',
      ),
    };
    const pipeline: Pipeline = {
      name: 'Curated v1',
      on: 'dispatch',
      jobs: {
        check: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
            { id: 'mark', run: 'echo v1 > revision.txt' },
          ],
        },
      },
    };
    const first = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'curated:review',
      runtime,
      curatedPipelineSource: source,
      pipelinePreferenceLocator: {
        type: 'stored',
        source: 'curated',
        value: 'curated:review',
      },
    });
    const paused = await first.waitForCompletion();
    expect(paused.status).toBe('paused');
    expect(paused.curated_pipeline_source).toEqual(source);
    const latest: Pipeline = {
      name: 'Curated v2',
      on: 'dispatch',
      jobs: {
        check: { steps: [{ id: 'mark', run: 'echo v2 > revision.txt' }] },
      },
    };
    const second = await executePipeline(latest, {
      cwd: tempDir,
      pipelineId: 'curated:review',
      runtime,
      curatedPipelineSource: {
        ...source,
        contentHash: 'b'.repeat(64),
        revision: 2,
      },
    });
    expect((await second.waitForCompletion()).status).toBe('success');
    expect(
      fs.readFileSync(path.join(tempDir, 'revision.txt'), 'utf8').trim(),
    ).toBe('v2');
    const resumed = await resumePipeline(first.id, { cwd: tempDir, runtime });
    const finished = await resumed.waitForCompletion();
    expect(finished.status).toBe('success');
    expect(finished.pipeline_snapshot.name).toBe('Curated v1');
    expect(finished.curated_pipeline_source).toEqual(source);
    expect(
      fs.readFileSync(path.join(tempDir, 'revision.txt'), 'utf8').trim(),
    ).toBe('v1');
  });

  it('groups jobs by independent tiers', () => {
    const normalized = normalizePipeline({
      name: 'tiers',
      on: 'dispatch',
      jobs: {
        setup: { steps: [] },
        build: { needs: 'setup', steps: [] },
        test: { needs: 'setup', steps: [] },
        deploy: { needs: ['build', 'test'], steps: [] },
      },
    });

    expect(groupJobsByTier(normalized)).toEqual([
      ['setup'],
      ['build', 'test'],
      ['deploy'],
    ]);
  });

  it('executes a single-job pipeline successfully', async () => {
    const pipeline: Pipeline = {
      name: 'single',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'first',
              run: 'echo "done" > result.txt',
            },
            {
              id: 'second',
              run: 'echo "again" >> result.txt',
            },
          ],
        },
      },
    };

    const started: string[] = [];
    const settled: string[] = [];
    runtime.lifecycle = {
      onExecutionStart: (state): void => {
        started.push(state.id);
      },
      onExecutionSettled: (state): void => {
        settled.push(`${state.id}:${state.status}`);
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'single',
      runtime,
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('success');
    expect(started).toEqual([state.id]);
    expect(settled).toEqual([`${state.id}:success`]);
    expectTimestampRange(state.started_at, state.completed_at);
    expectTimestampRange(
      state.jobs.build.started_at,
      state.jobs.build.completed_at,
    );
    expectTimestampRange(
      state.jobs.build.steps.first.started_at,
      state.jobs.build.steps.first.completed_at,
    );
    expectTimestampRange(
      state.jobs.build.steps.second.started_at,
      state.jobs.build.steps.second.completed_at,
    );
    expect(fs.readFileSync(path.join(tempDir, 'result.txt'), 'utf8')).toContain(
      'done',
    );
  });

  it('snapshots an installed package into the execution and preserves it on rerun', async () => {
    const pipeline: Pipeline = {
      name: 'packaged',
      on: 'dispatch',
      jobs: { build: { steps: [{ id: 'first', run: 'echo packaged' }] } },
    };
    const rawPipeline = 'name: packaged\non: dispatch\njobs: {}\n';
    const manifest: PipelinePackageManifestV1 = {
      version: 1,
      pipelineContentHash: hashPipelinePackageYaml(rawPipeline),
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    };
    const digest = computePipelinePackageDigestSync(manifest);
    const cachedPackagePath = await installPipelinePackageAtomically({
      packagesRoot: path.join(tempDir, 'package-cache'),
      digest,
      manifest,
      fetchBlob: () => Promise.reject(new Error('Unexpected package blob')),
    });
    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'packaged',
      runtime,
      pipelinePackage: { digest, rawPipeline, manifest, cachedPackagePath },
    });
    const source = await handle.waitForCompletion();

    expect(source.pipeline_package_snapshot).toMatchObject({
      digest,
      pipelineContentHash: manifest.pipelineContentHash,
    });
    expect(source.pipeline_package_snapshot?.cachedPackagePath).not.toBe(
      cachedPackagePath,
    );
    expect(
      fs.existsSync(
        path.join(
          source.pipeline_package_snapshot?.cachedPackagePath ?? '',
          'manifest.json',
        ),
      ),
    ).toBe(true);

    const rerun = await rerunPipelineExecution(source.id, {
      cwd: tempDir,
      env: {},
      runtime,
    });
    const rerunState = await rerun.waitForCompletion();
    expect(rerunState.pipeline_package_snapshot).toMatchObject({ digest });
    expect(rerunState.pipeline_package_snapshot?.cachedPackagePath).not.toBe(
      source.pipeline_package_snapshot?.cachedPackagePath,
    );
  });

  it('does not persist a rerun receipt before copied package validation', async () => {
    const pipeline: Pipeline = {
      name: 'packaged failure',
      on: 'dispatch',
      jobs: { build: { steps: [{ id: 'first', run: 'echo packaged' }] } },
    };
    const rawPipeline = 'name: packaged failure\non: dispatch\njobs: {}\n';
    const manifest: PipelinePackageManifestV1 = {
      version: 1,
      pipelineContentHash: hashPipelinePackageYaml(rawPipeline),
      resources: [],
      bindings: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    };
    const digest = computePipelinePackageDigestSync(manifest);
    const cachedPackagePath = await installPipelinePackageAtomically({
      packagesRoot: path.join(tempDir, 'package-cache-failure'),
      digest,
      manifest,
      fetchBlob: () => Promise.reject(new Error('Unexpected package blob')),
    });
    const sourceHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'packaged-failure',
      runtime,
      pipelinePackage: { digest, rawPipeline, manifest, cachedPackagePath },
    });
    const source = await sourceHandle.waitForCompletion();
    const originalCp = fs.promises.cp.bind(fs.promises);
    const cpSpy = jest
      .spyOn(fs.promises, 'cp')
      .mockImplementation(
        async (...args: Parameters<typeof fs.promises.cp>): Promise<void> => {
          await originalCp(...args);
          const destination = String(args[1]);
          if (destination.includes('command-rerun')) {
            await fs.promises.writeFile(
              path.join(destination, 'manifest.json'),
              '{}',
              'utf8',
            );
          }
        },
      );

    try {
      await expect(
        rerunPipelineExecution(source.id, {
          cwd: tempDir,
          env: {},
          executionId: 'command-rerun',
          runtime,
        }),
      ).rejects.toThrow('Pipeline package execution snapshot is invalid');
      await expect(
        loadExecutionState('command-rerun', runtime.executionsDir),
      ).resolves.toBeNull();
      expect(
        fs.existsSync(path.join(runtime.executionsDir, 'command-rerun')),
      ).toBe(false);
    } finally {
      cpSpy.mockRestore();
    }
  });

  it('overlays draft plugin preferences on saved defaults for execution', async () => {
    const previousDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = path.join(tempDir, 'canopy-data');
    try {
      const locator: PipelinePreferenceLocator = {
        type: 'stored',
        source: 'user',
        value: 'plugin-merge-test',
      };
      await savePipelinePluginCollectionPreferences(
        locator,
        {
          saved_collection: {
            disabledDefaultKeys: [],
            extraSelections: {
              collectionIds: [],
              skillRefs: [
                { sourceId: 'saved-source', skillName: 'saved-skill' },
              ],
              pluginRefs: [],
              mcpServerRefs: [],
            },
          },
        },
        'electron_main',
      );
      const runtimeWithResolver: ExecutionRuntime = {
        ...runtime,
        resolvePipelinePluginCollections: (_collections, preferences) =>
          Promise.resolve({
            snapshots: {
              saved_collection: {
                selections: preferences.saved_collection?.extraSelections ?? {
                  collectionIds: [],
                  skillRefs: [],
                  pluginRefs: [],
                  mcpServerRefs: [],
                },
                missingOptionalDefaults: [],
                unresolvedRequiredDefaults: [],
              },
              draft_collection: {
                selections: preferences.draft_collection?.extraSelections ?? {
                  collectionIds: [],
                  skillRefs: [],
                  pluginRefs: [],
                  mcpServerRefs: [],
                },
                missingOptionalDefaults: [],
                unresolvedRequiredDefaults: [],
              },
            },
          }),
      };

      const handle = await executePipeline(
        {
          name: 'Plugin preference merge',
          on: 'dispatch',
          plugin_collections: [
            { id: 'saved_collection', name: 'Saved', defaults: [] },
            { id: 'draft_collection', name: 'Draft', defaults: [] },
          ],
          jobs: {
            build: {
              steps: [{ id: 'ok', run: 'echo ok' }],
            },
          },
        },
        {
          cwd: tempDir,
          pipelineId: 'plugin-merge-test',
          runtime: runtimeWithResolver,
          pipelinePreferenceLocator: locator,
          pluginCollectionPreferences: {
            draft_collection: {
              disabledDefaultKeys: [],
              extraSelections: {
                collectionIds: [],
                skillRefs: [
                  { sourceId: 'draft-source', skillName: 'draft-skill' },
                ],
                pluginRefs: [],
                mcpServerRefs: [],
              },
            },
          },
        },
      );

      const state = await handle.waitForCompletion();

      expect(state.plugin_collection_preferences).toMatchObject({
        saved_collection: {
          extraSelections: {
            skillRefs: [{ sourceId: 'saved-source', skillName: 'saved-skill' }],
          },
        },
        draft_collection: {
          extraSelections: {
            skillRefs: [{ sourceId: 'draft-source', skillName: 'draft-skill' }],
          },
        },
      });
      expect(
        state.resolved_plugin_collections?.saved_collection.selections
          .skillRefs,
      ).toEqual([{ sourceId: 'saved-source', skillName: 'saved-skill' }]);
      expect(
        state.resolved_plugin_collections?.draft_collection.selections
          .skillRefs,
      ).toEqual([{ sourceId: 'draft-source', skillName: 'draft-skill' }]);
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.CANOPY_DATA_DIR;
      } else {
        process.env.CANOPY_DATA_DIR = previousDataDir;
      }
    }
  });

  it('resolves typed pipeline inputs in expressions and step env', async () => {
    const resultFile = path.join(tempDir, 'inputs.txt');
    const envFile = path.join(tempDir, 'input-env.txt');
    const pipeline: Pipeline = {
      name: 'inputs',
      on: {
        dispatch: {
          inputs: {
            greeting: {
              type: 'string',
              required: true,
            },
            count: {
              type: 'number',
              default: 1,
              min: 1,
              max: 5,
            },
            excited: {
              type: 'boolean',
              default: false,
            },
          },
        },
      },
      jobs: {
        build: {
          if: 'inputs.count > 0',
          outputs: {
            enabled: '${{ inputs.excited }}',
          },
          steps: [
            {
              id: 'first',
              if: 'inputs.excited',
              run: [
                `echo "${'${{ inputs.greeting }}'}:${'${{ inputs.count }}'}:${'${{ inputs.excited }}'}" > "${resultFile}"`,
                `echo "$INPUT_GREETING:$INPUT_COUNT:$INPUT_EXCITED" > "${envFile}"`,
              ].join('\n'),
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'inputs',
      runtime,
      inputs: {
        greeting: 'hello',
        count: '3',
        excited: 'true',
      },
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('success');
    expect(state.inputs).toEqual({
      greeting: 'hello',
      count: 3,
      excited: true,
    });
    expect(state.jobs.build.outputs).toEqual({ enabled: 'true' });
    expect(fs.readFileSync(resultFile, 'utf8').trim()).toBe('hello:3:true');
    expect(fs.readFileSync(envFile, 'utf8').trim()).toBe('hello:3:true');
  });

  it('resolves plan_ready inputs in expressions, INPUT_* env, and job max_iterations', async () => {
    const resultFile = path.join(tempDir, 'plan-ready-inputs.txt');
    const pipeline: Pipeline = {
      name: 'plan-ready-inputs',
      on: {
        plan_ready: {
          inputs: {
            reviewer: {
              type: 'string',
              required: true,
            },
            max_iterations: {
              type: 'number',
              default: 2,
              min: 1,
              max: 5,
            },
          },
        },
      },
      jobs: {
        refine: {
          max_iterations: '${{ inputs.max_iterations }}',
          steps: [
            {
              id: 'loop',
              run: [
                `echo "${'${{ inputs.reviewer }}'}:${'${{ inputs.max_iterations }}'}:$INPUT_REVIEWER:$INPUT_MAX_ITERATIONS" >> "${resultFile}"`,
                'echo "CANOPY_JOB_RESTART=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'plan-ready-inputs',
      runtime,
      eventName: 'plan_ready',
      eventData: {
        plan_ready: {
          plan_text: 'Initial plan\n',
        },
      },
      inputs: {
        reviewer: 'opus',
        max_iterations: '3',
      },
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('success');
    expect(state.inputs).toEqual({
      reviewer: 'opus',
      max_iterations: 3,
    });
    expect(state.job_definitions.refine.max_iterations).toBe(3);
    expect(state.jobs.refine.iteration_count).toBe(3);
    expect(fs.readFileSync(resultFile, 'utf8').trim().split('\n')).toEqual([
      'opus:3:opus:3',
      'opus:3:opus:3',
      'opus:3:opus:3',
    ]);
  });

  it('resolves job max_iterations from expressions before running the job', async () => {
    const attemptsFile = path.join(tempDir, 'attempts.txt');
    const pipeline: Pipeline = {
      name: 'dynamic-max-iterations',
      on: 'dispatch',
      jobs: {
        complexity: {
          outputs: {
            iterations: '${{ steps.emit.outputs.iterations }}',
          },
          steps: [
            {
              id: 'emit',
              run: 'echo "iterations=2" >> "$CANOPY_OUTPUT"',
            },
          ],
        },
        loop: {
          needs: 'complexity',
          max_iterations: '${{ needs.complexity.outputs.iterations }}',
          steps: [
            {
              id: 'restart',
              run: [
                `echo "attempt" >> "${attemptsFile}"`,
                'echo "CANOPY_JOB_RESTART=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'dynamic-max-iterations',
      runtime,
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('success');
    expect(state.job_definitions.loop.max_iterations).toBe(2);
    expect(state.jobs.loop.iteration_count).toBe(2);
    expect(state.jobs.loop.iteration_history).toHaveLength(1);
    expect(state.jobs.loop.steps.restart.error).toBeUndefined();
    expect(state.jobs.loop.steps.restart.outputs).toEqual({});
    expect(
      fs.readFileSync(attemptsFile, 'utf8').trim().split('\n'),
    ).toHaveLength(2);
  });

  it('skips jobs when max_iterations is explicitly 0', async () => {
    const attemptsFile = path.join(tempDir, 'skipped-attempts.txt');
    const pipeline: Pipeline = {
      name: 'skip-iterations',
      on: 'dispatch',
      jobs: {
        build: {
          max_iterations: 0,
          steps: [
            {
              id: 'should_not_run',
              run: `echo "attempt" >> "${attemptsFile}"`,
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'skip-iterations',
      runtime,
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('success');
    expect(state.jobs.build.status).toBe('skipped');
    expect(fs.existsSync(attemptsFile)).toBe(false);
  });

  it('runs omitted max_iterations as a normal single-pass job', async () => {
    const attemptsFile = path.join(tempDir, 'single-pass-attempts.txt');
    const pipeline: Pipeline = {
      name: 'default-single-pass',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'write_once',
              run: `echo "attempt" >> "${attemptsFile}"`,
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'default-single-pass',
      runtime,
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('success');
    expect(state.pipeline_snapshot.jobs.build.max_iterations).toBeUndefined();
    expect(state.jobs.build.iteration_count).toBe(1);
    expect(
      fs.readFileSync(attemptsFile, 'utf8').trim().split('\n'),
    ).toHaveLength(1);
  });

  it('fails before execution when a required pipeline input is missing', async () => {
    const pipeline: Pipeline = {
      name: 'missing-input',
      on: {
        dispatch: {
          inputs: {
            greeting: {
              type: 'string',
              required: true,
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [{ id: 'first', run: 'echo hello' }],
        },
      },
    };

    await expect(
      executePipeline(pipeline, {
        cwd: tempDir,
        pipelineId: 'missing-input',
        runtime,
      }),
    ).rejects.toThrow(/Workflow input "greeting" is required/);
  });

  it('validates dispatch and plan_ready runs against different input definitions', async () => {
    const dispatchFile = path.join(tempDir, 'mixed-trigger-dispatch.txt');
    const planReadyFile = path.join(tempDir, 'mixed-trigger-plan-ready.txt');
    const pipeline: Pipeline = {
      name: 'mixed-trigger-inputs',
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
              max: 5,
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [
            {
              id: 'write_dispatch',
              if: "canopy.event_name == 'dispatch'",
              run: `printf '%s' "$INPUT_GREETING" > "${dispatchFile}"`,
            },
            {
              id: 'write_plan_ready',
              if: "canopy.event_name == 'plan_ready'",
              run: `printf '%s' "$INPUT_MAX_ITERATIONS" > "${planReadyFile}"`,
            },
          ],
        },
      },
    };

    const dispatchHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'mixed-trigger-inputs',
      runtime,
      executionId: 'mixed-trigger-dispatch',
      inputs: {
        greeting: 'hello',
      },
    });
    const dispatchState = await dispatchHandle.waitForCompletion();

    const planReadyHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'mixed-trigger-inputs',
      runtime,
      executionId: 'mixed-trigger-plan-ready',
      eventName: 'plan_ready',
      eventData: {
        plan_ready: {
          plan_text: 'Initial plan\n',
        },
      },
      inputs: {
        max_iterations: '4',
      },
    });
    const planReadyState = await planReadyHandle.waitForCompletion();

    expect(dispatchState.status).toBe('success');
    expect(dispatchState.inputs).toEqual({ greeting: 'hello' });
    expect(fs.readFileSync(dispatchFile, 'utf8')).toBe('hello');
    expect(planReadyState.status).toBe('success');
    expect(planReadyState.inputs).toEqual({ max_iterations: 4 });
    expect(fs.readFileSync(planReadyFile, 'utf8')).toBe('4');

    await expect(
      executePipeline(pipeline, {
        cwd: tempDir,
        pipelineId: 'mixed-trigger-inputs-invalid-dispatch',
        runtime,
        executionId: 'mixed-trigger-invalid-dispatch',
        inputs: {
          max_iterations: '4',
        },
      }),
    ).rejects.toThrow(/Workflow input "max_iterations" is not declared/);

    await expect(
      executePipeline(pipeline, {
        cwd: tempDir,
        pipelineId: 'mixed-trigger-inputs-invalid-plan-ready',
        runtime,
        executionId: 'mixed-trigger-invalid-plan-ready',
        eventName: 'plan_ready',
        eventData: {
          plan_ready: {
            plan_text: 'Initial plan\n',
          },
        },
        inputs: {
          greeting: 'hello',
        },
      }),
    ).rejects.toThrow(/Workflow input "greeting" is not declared/);
  });

  it.each([
    'round-trip',
    'resume-changed',
    'resume-missing',
    'retry-changed',
    'rerun-changed',
    'rerun-fresh',
    'retry-fresh',
    'personal',
    'unbound',
  ])(
    'preserves child authorization across execution replay: %s',
    async (mode): Promise<void> => {
      const file = path.join(tempDir, 'replay-child.yaml');
      const output = path.join(tempDir, 'replay-ran.txt');
      const child =
        'name: Child\non: dispatch\njobs:\n  child:\n    steps:\n      - run: echo authorized > replay-ran.txt\n';
      fs.writeFileSync(file, child);
      const pipeline: Pipeline = {
        name: 'Replay',
        on: 'dispatch',
        jobs: {
          parent: {
            steps: [
              ...(mode.startsWith('resume') || mode === 'round-trip'
                ? [
                    {
                      id: 'pause',
                      run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
                    },
                  ]
                : []),
              ...(mode.startsWith('retry-')
                ? [{ id: 'gate', run: 'test -f allow-retry' }]
                : []),
              {
                id: 'child',
                uses: 'builtin/run-pipeline',
                with: { pipeline: 'replay-child.yaml' },
              },
            ],
          },
        },
      };
      const authorizations: ChildPipelineAuthorization[] = [];
      await authorizePipelineContextResources(
        pipelineContextResources(
          pipeline,
          { type: 'system' },
          { cwd: tempDir },
        ),
        (): Promise<{ allow: true }> => Promise.resolve({ allow: true }),
        new Set(),
        authorizations,
      );
      const replayRuntime: ExecutionRuntime = {
        ...runtime,
        bundledActionsDir: path.resolve(
          'packages/desktop-shared/resources/actions',
        ),
      };
      const bound = mode !== 'personal' && mode !== 'unbound';
      const handle = await executePipeline(pipeline, {
        cwd: tempDir,
        pipelineId: 'replay',
        runtime: replayRuntime,
        ...(mode === 'unbound'
          ? {}
          : {
              executionContext: bound
                ? 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
                : 'personal',
            }),
        ...(bound && mode !== 'resume-missing'
          ? { childPipelineAuthorizations: authorizations }
          : {}),
      });
      const initial = await handle.waitForCompletion();
      if (mode === 'personal' || mode === 'unbound') {
        expect(initial.status).toBe('success');
        return;
      }
      if (mode === 'round-trip') {
        expect(
          await loadExecutionState(initial.id, runtime.executionsDir),
        ).toMatchObject({
          execution_context: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          child_pipeline_authorizations: authorizations,
        });
        return;
      }
      fs.rmSync(output, { force: true });
      if (mode.endsWith('changed') || mode.endsWith('fresh'))
        fs.writeFileSync(file, child.replace('authorized', 'changed'));
      fs.writeFileSync(path.join(tempDir, 'allow-retry'), '');
      const fresh: ChildPipelineAuthorization[] = [];
      if (mode.endsWith('fresh'))
        await authorizePipelineContextResources(
          pipelineContextResources(
            pipeline,
            { type: 'system' },
            { cwd: tempDir },
          ),
          (): Promise<{ allow: true }> => Promise.resolve({ allow: true }),
          new Set(),
          fresh,
        );
      const options = {
        cwd: tempDir,
        runtime: replayRuntime,
        ...(mode.endsWith('fresh')
          ? { childPipelineAuthorizations: fresh }
          : {}),
      };
      const replay = mode.startsWith('retry-')
        ? await retryPipelineExecution(initial.id, options)
        : mode.startsWith('rerun-')
          ? await rerunPipelineExecution(initial.id, options)
          : await resumePipeline(initial.id, options);
      const state = await replay.waitForCompletion();
      if (mode.endsWith('fresh')) {
        expect(state.status).toBe('success');
        expect(fs.existsSync(output)).toBe(true);
        return;
      }
      expect(state.status).toBe('failure');
      expect(fs.existsSync(output)).toBe(false);
      expect(JSON.stringify(state.jobs)).toContain(
        "Couldn't confirm where this runs",
      );
    },
  );

  it.each(['retry', 'matrix', 'rerun'])(
    'persists fresh child authorization before replay and restart: %s',
    async (mode): Promise<void> => {
      const file = path.join(tempDir, 'retry-child.yaml');
      const child =
        'name: Child\non: dispatch\njobs:\n  child:\n    steps:\n      - run: echo old > retry-child-output\n';
      fs.writeFileSync(file, child);
      const pipeline: Pipeline = {
        name: 'Reauthorized replay',
        on: 'dispatch',
        jobs: {
          parent: {
            ...(mode === 'matrix'
              ? { strategy: { matrix: { value: ['one'] } } }
              : {}),
            steps: [
              { id: 'gate', run: 'test -f allow-retry' },
              {
                id: 'pause',
                run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              },
              {
                id: 'child',
                uses: 'builtin/run-pipeline',
                with: { pipeline: 'retry-child.yaml' },
              },
            ],
          },
        },
      };
      const authorizations: ChildPipelineAuthorization[] = [];
      await authorizePipelineContextResources(
        pipelineContextResources(
          pipeline,
          { type: 'system' },
          { cwd: tempDir },
        ),
        (): Promise<{ allow: true }> => Promise.resolve({ allow: true }),
        new Set(),
        authorizations,
      );
      const replayRuntime: ExecutionRuntime = {
        ...runtime,
        bundledActionsDir: path.resolve(
          'packages/desktop-shared/resources/actions',
        ),
      };
      const initialHandle = await executePipeline(pipeline, {
        cwd: tempDir,
        pipelineId: 'reauthorized-replay',
        runtime: replayRuntime,
        executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        childPipelineAuthorizations: authorizations,
      });
      const initial = await initialHandle.waitForCompletion();
      expect(initial.status).toBe('failure');
      fs.writeFileSync(file, child.replace('echo old', 'echo fresh'));
      fs.writeFileSync(path.join(tempDir, 'allow-retry'), '');
      const fresh: ChildPipelineAuthorization[] = [];
      await authorizePipelineContextResources(
        pipelineContextResources(
          pipeline,
          { type: 'system' },
          { cwd: tempDir },
        ),
        (): Promise<{ allow: true }> => Promise.resolve({ allow: true }),
        new Set(),
        fresh,
      );
      expect(fresh).not.toEqual(authorizations);
      const options = {
        cwd: tempDir,
        runtime: replayRuntime,
        childPipelineAuthorizations: fresh,
      };
      const replay =
        mode === 'matrix'
          ? await retryMatrixJobExecution(
              { executionId: initial.id, jobId: 'parent', mode: 'all' },
              options,
            )
          : mode === 'rerun'
            ? await rerunPipelineExecution(initial.id, options)
            : await retryPipelineExecution(initial.id, options);
      const paused = await replay.waitForCompletion();
      expect(paused.status).toBe('paused');
      expect(
        await loadExecutionState(paused.id, runtime.executionsDir),
      ).toMatchObject({ child_pipeline_authorizations: fresh });
      // Resume from disk without passing the replacement authorizations again.
      const resumed = await resumePipeline(paused.id, {
        cwd: tempDir,
        runtime: replayRuntime,
      });
      expect((await resumed.waitForCompletion()).status).toBe('success');
      expect(
        fs.readFileSync(path.join(tempDir, 'retry-child-output'), 'utf8'),
      ).toBe('fresh\n');
    },
  );

  it.each([false, true])(
    'executes only the authorized relative child (changed=%s)',
    async (changed): Promise<void> => {
      const file = path.join(tempDir, 'authorized-child.yaml');
      const output = path.join(tempDir, 'child-executed.txt');
      fs.writeFileSync(
        file,
        'name: Child\non: dispatch\njobs:\n  child:\n    steps:\n      - run: echo authorized > child-executed.txt\n',
      );
      const pipeline: Pipeline = {
        name: 'Parent',
        on: 'dispatch',
        jobs: {
          parent: {
            steps: [
              {
                id: 'child',
                uses: 'builtin/run-pipeline',
                with: { pipeline: 'authorized-child.yaml' },
              },
            ],
          },
        },
      };
      const authorizations: ChildPipelineAuthorization[] = [];
      expect(
        await authorizePipelineContextResources(
          pipelineContextResources(
            pipeline,
            { type: 'system' },
            { cwd: tempDir },
          ),
          () => Promise.resolve({ allow: true }),
          new Set(),
          authorizations,
        ),
      ).toEqual({ allow: true });
      if (changed)
        fs.writeFileSync(
          file,
          'name: Child\non: dispatch\njobs:\n  child:\n    steps:\n      - run: echo replaced > child-executed.txt\n',
        );
      const handle = await executePipeline(pipeline, {
        cwd: tempDir,
        pipelineId: 'stored-parent',
        executionContext: 'personal',
        childPipelineAuthorizations: authorizations,
        runtime: {
          ...runtime,
          bundledActionsDir: path.resolve(
            process.cwd(),
            'packages/desktop-shared/resources/actions',
          ),
        },
      });
      const state = await handle.waitForCompletion();
      expect(state.status).toBe(changed ? 'failure' : 'success');
      expect(fs.existsSync(output)).toBe(!changed);
      if (!changed)
        expect(fs.readFileSync(output, 'utf8').trim()).toBe('authorized');
    },
  );

  it('runs dispatch-only child pipelines with dispatch inputs during plan_ready parent runs', async () => {
    const childOutputFile = path.join(tempDir, 'nested-plan-ready-child.txt');
    const pipeline: Pipeline = {
      name: 'nested-plan-ready-child-inputs',
      on: 'plan_ready',
      jobs: {
        refine: {
          steps: [
            {
              id: 'run_child',
              uses: 'builtin/run-pipeline',
              with: {
                pipeline_yaml: [
                  'name: Child Dispatch Inputs',
                  'on:',
                  '  dispatch:',
                  '    inputs:',
                  '      target:',
                  '        required: true',
                  'jobs:',
                  '  child:',
                  '    steps:',
                  '      - id: capture',
                  '        run: |',
                  `          printf '%s' "$INPUT_TARGET" > "${childOutputFile}"`,
                ].join('\n'),
                inputs: '{"target":"world"}',
              },
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'nested-plan-ready-child-inputs',
      runtime: {
        ...runtime,
        bundledActionsDir: path.resolve(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
      },
      executionId: 'nested-plan-ready-child-inputs',
      eventName: 'plan_ready',
      eventData: {
        plan_ready: {
          plan_text: 'Initial plan\n',
        },
      },
    });

    const state = await handle.waitForCompletion();
    expect(state.status).toBe('success');
    expect(state.jobs.refine.steps.run_child.status).toBe('success');
    expect(fs.readFileSync(childOutputFile, 'utf8')).toBe('world');
  });

  it('inherits the parent plan_ready trigger when the child pipeline declares plan_ready', async () => {
    const childOutputFile = path.join(
      tempDir,
      'nested-plan-ready-child-trigger.txt',
    );
    const pipeline: Pipeline = {
      name: 'nested-plan-ready-child-trigger',
      on: 'plan_ready',
      jobs: {
        refine: {
          steps: [
            {
              id: 'run_child',
              uses: 'builtin/run-pipeline',
              with: {
                pipeline_yaml: [
                  'name: Child Plan Ready Inputs',
                  'on:',
                  '  plan_ready:',
                  '    inputs:',
                  '      target:',
                  '        required: true',
                  'jobs:',
                  '  child:',
                  '    steps:',
                  '      - id: capture',
                  '        run: |',
                  `          printf '%s:%s' "$INPUT_TARGET" "${'${{ canopy.event_name }}'}" > "${childOutputFile}"`,
                ].join('\n'),
                inputs: '{"target":"world"}',
              },
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'nested-plan-ready-child-trigger',
      runtime: {
        ...runtime,
        bundledActionsDir: path.resolve(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
      },
      executionId: 'nested-plan-ready-child-trigger',
      eventName: 'plan_ready',
      eventData: {
        plan_ready: {
          plan_text: 'Initial plan\n',
        },
      },
    });

    const state = await handle.waitForCompletion();
    expect(state.status).toBe('success');
    expect(state.jobs.refine.steps.run_child.status).toBe('success');
    expect(fs.readFileSync(childOutputFile, 'utf8')).toBe('world:plan_ready');
  });

  it('preserves worktree scope when legacy run-pipeline cwd narrows child cwd', async () => {
    const childDir = path.join(tempDir, 'legacy-child-cwd');
    fs.mkdirSync(childDir);
    const childOutputFile = path.join(tempDir, 'legacy-worktree-child-cwd.txt');
    const pipeline: Pipeline = {
      name: 'legacy-worktree-child-cwd',
      scope: 'worktree',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'run_child',
              uses: 'builtin/run-pipeline',
              with: {
                cwd: 'legacy-child-cwd',
                pipeline_yaml: [
                  'name: Child Worktree Pipeline',
                  'scope: worktree',
                  'on: dispatch',
                  'jobs:',
                  '  child:',
                  '    steps:',
                  '      - id: capture',
                  '        run: |',
                  `          printf '%s' "$PWD" > "${childOutputFile}"`,
                ].join('\n'),
              },
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'legacy-worktree-child-cwd',
      runtime: {
        ...runtime,
        bundledActionsDir: path.resolve(
          process.cwd(),
          'packages',
          'desktop-shared',
          'resources',
          'actions',
        ),
      },
      executionId: 'legacy-worktree-child-cwd',
      scope: 'worktree',
      target: {
        scope: 'worktree',
        workspace_id: 'workspace-a',
        worktree_id: 'feature',
        path: tempDir,
        created: false,
      },
      projectId: 'workspace-a',
      worktreeId: 'feature',
      repoPath: tempDir,
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('success');
    expect(state.jobs.build.steps.run_child.status).toBe('success');
    expect(fs.readFileSync(childOutputFile, 'utf8')).toBe(
      fs.realpathSync(childDir),
    );
  });

  it('materializes plan_ready event data and tracks plan edits', async () => {
    const pipeline: Pipeline = {
      name: 'plan-ready',
      on: 'plan_ready',
      jobs: {
        refine: {
          steps: [
            {
              id: 'rewrite_plan',
              run: `printf '%s\n' 'Updated plan' > "${'${{ canopy.event.plan_ready.plan_path }}'}"`,
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'plan-ready',
      runtime,
      executionId: 'plan-ready-exec',
      eventName: 'plan_ready',
      eventData: {
        plan_ready: {
          plan_text: 'Initial plan\n',
        },
      },
    });
    const state = await handle.waitForCompletion();

    const planPath = state.event_data?.plan_ready?.plan_path;
    expect(state.status).toBe('success');
    expect(state.event_name).toBe('plan_ready');
    expect(planPath).toBe(
      path.join(runtime.executionsDir, state.id, 'plan.md'),
    );
    expect(fs.readFileSync(planPath as string, 'utf8')).toBe('Updated plan\n');
    await waitForPathToDisappear(path.join(runtime.tempRootDir, state.id));
    expect(state.plan_hash_before).toBeDefined();
    expect(state.plan_hash_after).toBeDefined();
    expect(state.plan_hash_before).not.toBe(state.plan_hash_after);
  });

  it('materializes task_ready event data with an allocated plan path', async () => {
    const pipeline: Pipeline = {
      name: 'task-ready',
      on: 'task_ready',
      jobs: {
        plan: {
          steps: [
            {
              id: 'write_plan',
              run: [
                `test ! -e "${'${{ canopy.event.task_ready.plan_path }}'}"`,
                `cat "${'${{ canopy.event.task_ready.task_path }}'}" > "${'${{ canopy.event.task_ready.plan_path }}'}"`,
              ].join('\n'),
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'task-ready',
      runtime,
      executionId: 'task-ready-exec',
      eventName: 'task_ready',
      eventData: {
        task_ready: {
          task_text: 'Implement feature X\n',
        },
      },
    });
    const state = await handle.waitForCompletion();

    const taskPath = state.event_data?.task_ready?.task_path;
    const planPath = state.event_data?.task_ready?.plan_path;
    expect(state.status).toBe('success');
    expect(state.event_name).toBe('task_ready');
    expect(taskPath).toBe(
      path.join(runtime.executionsDir, state.id, 'task.md'),
    );
    expect(planPath).toBe(
      path.join(runtime.executionsDir, state.id, 'plan.md'),
    );
    expect(fs.readFileSync(taskPath ?? '', 'utf8')).toBe(
      'Implement feature X\n',
    );
    expect(fs.readFileSync(planPath ?? '', 'utf8')).toBe(
      'Implement feature X\n',
    );
    expect(state.plan_hash_before).toBeUndefined();
    expect(state.plan_hash_after).toBeDefined();
    // Directory-scope contract (Home surface cowork runs): a task_ready
    // execution launched with no projectId/worktreeId resolves to the
    // `directory` scope and still materializes task/plan paths from
    // `task_text`.
    expect(state.scope).toBe('directory');
    expect(state.project_id).toBeUndefined();
    expect(state.worktree_id).toBeUndefined();
  });

  it('rejects task_ready runs without task_text or task_path', async () => {
    const pipeline: Pipeline = {
      name: 'task-ready-invalid',
      on: 'task_ready',
      jobs: {
        plan: {
          steps: [{ id: 'noop', run: `printf '%s\n' 'noop'` }],
        },
      },
    };

    await expect(
      executePipeline(pipeline, {
        cwd: tempDir,
        pipelineId: 'task-ready-invalid',
        runtime,
        executionId: 'task-ready-invalid-exec',
        eventName: 'task_ready',
        eventData: {
          task_ready: {},
        },
      }),
    ).rejects.toThrow(
      /task_ready event requires either task_text or task_path/,
    );
  });

  it('does not expose plan follow-ups or tracked plans for task_ready runs that never write the allocated plan file', async () => {
    const previousDataDir = process.env.CANOPY_DATA_DIR;
    const canopyDataDir = path.join(tempDir, '.canopy-data');
    process.env.CANOPY_DATA_DIR = canopyDataDir;

    const pipeline: Pipeline = {
      name: 'task-ready-without-plan',
      on: 'task_ready',
      jobs: {
        plan: {
          steps: [{ id: 'noop', run: `printf '%s\n' 'Skipped plan write'` }],
        },
      },
    };

    try {
      const handle = await executePipeline(pipeline, {
        cwd: tempDir,
        pipelineId: 'task-ready-without-plan',
        runtime,
        executionId: 'task-ready-without-plan-exec',
        eventName: 'task_ready',
        projectId: 'project',
        worktreeId: 'worktree',
        eventData: {
          task_ready: {
            task_text: 'Implement feature Y\n',
          },
        },
      });
      const state = await handle.waitForCompletion();
      const summaries = await listExecutionSummaries(runtime.executionsDir);
      const trackedPlans = await listTrackedPlans('project', 'worktree');

      expect(state.status).toBe('success');
      expect(state.plan_hash_before).toBeUndefined();
      expect(state.plan_hash_after).toBeUndefined();
      expect(state.planId).toBeUndefined();
      expect(summaries).toEqual([
        expect.objectContaining({
          id: state.id,
          has_plan: undefined,
          planId: undefined,
        }),
      ]);
      expect(trackedPlans).toEqual([]);
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.CANOPY_DATA_DIR;
      } else {
        process.env.CANOPY_DATA_DIR = previousDataDir;
      }
    }
  });

  it('tracks written task_ready plans and surfaces them through execution summaries', async () => {
    const previousDataDir = process.env.CANOPY_DATA_DIR;
    const canopyDataDir = path.join(tempDir, '.canopy-data');
    process.env.CANOPY_DATA_DIR = canopyDataDir;

    const pipeline: Pipeline = {
      name: 'task-ready-tracked-plan',
      on: 'task_ready',
      jobs: {
        plan: {
          steps: [
            {
              id: 'write_plan',
              run: `printf '%s\n' '# Implementation Plan' '1. Ship it' > "${'${{ canopy.event.task_ready.plan_path }}'}"`,
            },
          ],
        },
      },
    };

    try {
      const handle = await executePipeline(pipeline, {
        cwd: tempDir,
        pipelineId: 'task-ready-tracked-plan',
        runtime,
        executionId: 'task-ready-tracked-plan-exec',
        eventName: 'task_ready',
        projectId: 'project',
        worktreeId: 'worktree',
        eventData: {
          task_ready: {
            task_text: 'Implement feature Z\n',
          },
        },
      });
      const state = await handle.waitForCompletion();
      const summaries = await listExecutionSummaries(runtime.executionsDir);
      const trackedPlans = await listTrackedPlans('project', 'worktree');

      expect(state.status).toBe('success');
      expect(state.plan_hash_before).toBeUndefined();
      expect(state.plan_hash_after).toBeDefined();
      expect(state.planId).toBeDefined();
      expect(summaries).toEqual([
        expect.objectContaining({
          id: state.id,
          has_plan: true,
          planId: state.planId,
        }),
      ]);
      expect(trackedPlans).toEqual([
        expect.objectContaining({
          id: state.planId,
          source: 'pipeline',
          content: '# Implementation Plan\n1. Ship it\n',
          linkedExecutionIds: [state.id],
          reviewStatus: 'approved',
        }),
      ]);
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.CANOPY_DATA_DIR;
      } else {
        process.env.CANOPY_DATA_DIR = previousDataDir;
      }
    }
  });

  it('reuses the inherited tracked plan id for nested plan_ready executions', async () => {
    const previousDataDir = process.env.CANOPY_DATA_DIR;
    const canopyDataDir = path.join(tempDir, '.canopy-data');
    process.env.CANOPY_DATA_DIR = canopyDataDir;

    const pipeline: Pipeline = {
      name: 'nested-plan-ready',
      on: 'plan_ready',
      jobs: {
        refine: {
          steps: [{ id: 'noop', run: 'echo ready' }],
        },
      },
    };

    const inheritedPlanPath = path.join(tempDir, 'parent-plan.md');
    fs.writeFileSync(inheritedPlanPath, 'Parent plan\n');

    try {
      const handle = await executePipeline(pipeline, {
        cwd: tempDir,
        pipelineId: 'nested-plan-ready',
        runtime,
        executionId: 'nested-plan-ready-exec',
        eventName: 'plan_ready',
        projectId: 'project',
        worktreeId: 'worktree',
        eventData: {
          plan_ready: {
            plan_path: inheritedPlanPath,
            planId: 'parent-plan-id',
          },
        },
      });
      const state = await handle.waitForCompletion();

      expect(state.status).toBe('success');
      expect(state.planId).toBe('parent-plan-id');
      expect(
        fs.existsSync(
          path.join(
            canopyDataDir,
            'workspaces',
            'project',
            'plans',
            'worktree.json',
          ),
        ),
      ).toBe(false);
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.CANOPY_DATA_DIR;
      } else {
        process.env.CANOPY_DATA_DIR = previousDataDir;
      }
    }
  });

  it('captures execution-level report outputs and exposes CANOPY_OUTPUT_DIR', async () => {
    const pipeline: Pipeline = {
      name: 'report-output-dir',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'write_report',
              run: [
                'mkdir -p "$CANOPY_OUTPUT_DIR"',
                'echo "$CANOPY_OUTPUT_DIR" > output-dir.txt',
                'echo "# Report" > "$CANOPY_OUTPUT_DIR/report.md"',
                'echo "CANOPY_OUTPUT_REPORT=$CANOPY_OUTPUT_DIR/report.md" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'report-output-dir',
      runtime,
      executionId: 'report-output-dir-exec',
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('success');
    expect(state.env.CANOPY_OUTPUT_DIR).toBe(
      path.join(runtime.executionsDir, state.id),
    );
    expect(
      fs.readFileSync(path.join(tempDir, 'output-dir.txt'), 'utf8').trim(),
    ).toBe(path.join(runtime.executionsDir, state.id));
    expect(state.report_outputs).toEqual({
      report_file: path.join(runtime.executionsDir, state.id, 'report.md'),
    });
    expect(
      fs.readFileSync(state.report_outputs?.report_file ?? '', 'utf8'),
    ).toBe('# Report\n');
  });

  it('keeps the plan file durable across pause and resume for plan_ready runs', async () => {
    const pipeline: Pipeline = {
      name: 'paused plan-ready',
      on: 'plan_ready',
      jobs: {
        refine: {
          steps: [
            {
              id: 'pause',
              run: [
                'step_dir="$(dirname "$CANOPY_OUTPUT")"',
                "printf '%s\\n' 'Preserved artifact' > \"$step_dir/pre-pause.txt\"",
                'echo "artifact_file=$step_dir/pre-pause.txt" >> "$CANOPY_OUTPUT"',
                `printf '%s\n' 'During pause' > "${'${{ canopy.event.plan_ready.plan_path }}'}"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
            {
              id: 'after_resume',
              run: [
                `cat "${'${{ steps.pause.outputs.artifact_file }}'}" > "${'${{ canopy.event.plan_ready.plan_path }}'}"`,
                `printf '%s\n' 'After resume' >> "${'${{ canopy.event.plan_ready.plan_path }}'}"`,
              ].join('\n'),
            },
          ],
        },
      },
    };

    const pausedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'paused-plan-ready',
      runtime,
      executionId: 'paused-plan-ready-exec',
      eventName: 'plan_ready',
      eventData: {
        plan_ready: {
          plan_text: 'Initial plan\n',
        },
      },
    });
    const pausedState = await pausedHandle.waitForCompletion();

    const pausedPlanPath = pausedState.event_data?.plan_ready?.plan_path;
    expect(pausedState.status).toBe('paused');
    expect(pausedPlanPath).toBe(
      path.join(runtime.executionsDir, pausedState.id, 'plan.md'),
    );
    expect(fs.readFileSync(pausedPlanPath as string, 'utf8')).toBe(
      'During pause\n',
    );
    const pausedTempDir = path.join(runtime.tempRootDir, pausedState.id);
    expect(fs.existsSync(pausedTempDir)).toBe(true);

    const resumedHandle = await resumePipeline('paused-plan-ready-exec', {
      cwd: tempDir,
      runtime,
      portalCommandId: 'portal-resume-cold',
    });
    const resumedState = await resumedHandle.waitForCompletion();

    expect(resumedState.status).toBe('success');
    expect(resumedState.portal_command_ids).toContain('portal-resume-cold');
    expect(resumedState.event_data?.plan_ready?.plan_path).toBe(pausedPlanPath);
    expect(fs.readFileSync(pausedPlanPath as string, 'utf8')).toBe(
      'Preserved artifact\nAfter resume\n',
    );
    await waitForPathToDisappear(pausedTempDir);
  });

  it('does not persist a cold resume receipt when its package overlay is invalid', async () => {
    const pipeline: Pipeline = {
      name: 'invalid package resume',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
            { id: 'finish', run: 'echo resumed' },
          ],
        },
      },
    };
    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'invalid-package-resume',
      runtime,
      executionId: 'invalid-package-resume-exec',
    });
    const pausedState = await handle.waitForCompletion();
    pausedState.pipeline_package_snapshot = {
      digest: 'a'.repeat(64),
      pipelineContentHash: 'b'.repeat(64),
      cachedPackagePath: path.join(tempDir, 'missing-resume-package'),
      bindings: [],
      capturedAt: '2026-09-11T00:00:00.000Z',
    };
    await saveExecutionState(pausedState, runtime.executionsDir);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        resumePipeline(pausedState.id, {
          cwd: tempDir,
          runtime,
          portalCommandId: 'portal-invalid-resume',
        }),
      ).rejects.toThrow('Pipeline package execution snapshot is invalid');
    }

    const persisted = await loadExecutionState(
      pausedState.id,
      runtime.executionsDir,
    );
    expect(persisted?.status).toBe('paused');
    expect(persisted?.portal_command_ids ?? []).not.toContain(
      'portal-invalid-resume',
    );
  });

  it('backfills CANOPY_OUTPUT_DIR when resuming legacy paused executions', async () => {
    const normalized = normalizePipeline({
      name: 'legacy-output-dir',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'write_dir',
              run: 'echo "$CANOPY_OUTPUT_DIR" > legacy-output-dir.txt',
            },
          ],
        },
      },
    });
    const state = createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'legacy-output-dir',
        runtime,
      },
      'legacy-output-dir-exec',
    );
    delete state.env.CANOPY_OUTPUT_DIR;
    state.status = 'paused';
    state.jobs.build.status = 'paused';
    await saveExecutionState(state, runtime.executionsDir);

    const handle = await resumePipeline('legacy-output-dir-exec', {
      cwd: tempDir,
      runtime,
    });
    const resumedState = await handle.waitForCompletion();

    expect(resumedState.status).toBe('success');
    expect(resumedState.env.CANOPY_OUTPUT_DIR).toBe(
      path.join(runtime.executionsDir, resumedState.id),
    );
    expect(
      fs
        .readFileSync(path.join(tempDir, 'legacy-output-dir.txt'), 'utf8')
        .trim(),
    ).toBe(path.join(runtime.executionsDir, resumedState.id));
  });

  it('defaults missing legacy pipeline snapshot scope to directory on resume', async () => {
    const resultFile = path.join(tempDir, 'legacy-scope-resume.txt');
    const pipeline: Pipeline = {
      name: 'legacy-scope-resume',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
            {
              id: 'after_resume',
              run: `echo resumed > "${resultFile}"`,
            },
          ],
        },
      },
    };

    const pausedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'legacy-scope-resume',
      runtime,
      executionId: 'legacy-scope-resume-exec',
    });
    const pausedState = await pausedHandle.waitForCompletion();
    expect(pausedState.status).toBe('paused');

    Reflect.deleteProperty(pausedState.pipeline_snapshot, 'scope');
    await saveExecutionState(pausedState, runtime.executionsDir);

    const handle = await resumePipeline('legacy-scope-resume-exec', {
      cwd: tempDir,
      runtime,
    });
    const resumedState = await handle.waitForCompletion();

    expect(resumedState.status).toBe('success');
    expect(fs.readFileSync(resultFile, 'utf8')).toBe('resumed\n');
  });

  it('preserves the repo root when resuming a narrowed worktree execution', async () => {
    const repoPath = path.join(tempDir, 'repo-root-resume');
    const narrowedCwd = path.join(repoPath, 'packages', 'app');
    fs.mkdirSync(narrowedCwd, { recursive: true });
    const pipeline: Pipeline = {
      name: 'resume narrowed worktree',
      scope: 'worktree',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
            {
              id: 'after_resume',
              run: 'echo ok',
            },
          ],
        },
      },
    };

    const pausedHandle = await executePipeline(pipeline, {
      cwd: narrowedCwd,
      pipelineId: 'resume-narrowed-worktree',
      runtime,
      executionId: 'resume-narrowed-worktree-exec',
      scope: 'worktree',
      target: {
        scope: 'worktree',
        workspace_id: 'workspace-a',
        worktree_id: 'feature',
        path: narrowedCwd,
        created: false,
      },
      projectId: 'workspace-a',
      worktreeId: 'feature',
      repoPath,
    });
    const pausedState = await pausedHandle.waitForCompletion();

    const resumedHandle = await resumePipeline(
      'resume-narrowed-worktree-exec',
      {
        cwd: tempDir,
        runtime,
      },
    );
    const resumedState = await resumedHandle.waitForCompletion();

    expect(pausedState.status).toBe('paused');
    expect(resumedState.status).toBe('success');
    expect(resumedState.cwd).toBe(narrowedCwd);
    expect(resumedState.target).toMatchObject({ path: narrowedCwd });
    expect(resumedState.repo_path).toBe(repoPath);
  });

  it('reports all pipeline input validation errors together', async () => {
    const pipeline: Pipeline = {
      name: 'invalid-inputs',
      on: {
        dispatch: {
          inputs: {
            greeting: {
              type: 'string',
              required: true,
            },
            retries: {
              type: 'number',
              min: 1,
              max: 3,
            },
            enabled: {
              type: 'boolean',
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [{ id: 'first', run: 'echo hello' }],
        },
      },
    };

    await expect(
      executePipeline(pipeline, {
        cwd: tempDir,
        pipelineId: 'invalid-inputs',
        runtime,
        inputs: {
          retries: '9',
          enabled: 'not-bool',
          extra: 'oops',
        },
      }),
    ).rejects.toThrow(
      /Workflow input validation failed:[\s\S]*extra[\s\S]*greeting[\s\S]*retries[\s\S]*enabled/,
    );
  });

  it('retries failed jobs, archives failed attempts, and exposes retry context', async () => {
    const retryMarker = path.join(tempDir, 'retry-marker.txt');
    const retryOnlyFile = path.join(tempDir, 'retry-only.txt');
    const pipeline: Pipeline = {
      name: 'retry',
      on: 'dispatch',
      jobs: {
        build: {
          max_retries: 1,
          outputs: {
            retry_count: '${{ job.retry_count }}',
            retried: '${{ job.is_retry }}',
          },
          steps: [
            {
              id: 'flaky',
              run: [
                'echo "$CANOPY_JOB_RETRY_COUNT:$CANOPY_JOB_IS_RETRY" >> "' +
                  retryMarker +
                  '"',
                'if [ "$CANOPY_JOB_RETRY_COUNT" = "0" ]; then exit 1; fi',
                'echo "status=ok" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
            {
              id: 'retry_only',
              if: 'job.is_retry',
              run: `echo "retried" > "${retryOnlyFile}"`,
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'retry',
      runtime,
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('success');
    expect(state.jobs.build.retry_count).toBe(1);
    expect(state.jobs.build.retry_history).toHaveLength(1);
    expect(state.jobs.build.retry_history?.[0]).toMatchObject({
      attempt: 0,
      conclusion: 'failure',
      outcome: 'failure',
    });
    expectTimestampRange(
      state.jobs.build.retry_history?.[0].started_at,
      state.jobs.build.retry_history?.[0].completed_at,
    );
    expect(state.jobs.build.outputs).toEqual({
      retry_count: '1',
      retried: 'true',
    });
    expect(fs.readFileSync(retryMarker, 'utf8')).toBe('0:false\n1:true\n');
    expect(fs.readFileSync(retryOnlyFile, 'utf8')).toContain('retried');
    expect(state.jobs.build.retry_history?.[0].steps.flaky.log_file).toMatch(
      /flaky\.log$/,
    );
    expect(state.jobs.build.steps.flaky.log_file).toMatch(
      /flaky--attempt1\.log$/,
    );
  });

  it('retries a failed execution by reusing only unaffected work and reevaluating the downstream cone', async () => {
    const setupFile = path.join(tempDir, 'setup.txt');
    const buildFile = path.join(tempDir, 'build.txt');
    const notifyFile = path.join(tempDir, 'notify.txt');
    const alwaysFile = path.join(tempDir, 'always.txt');
    const deployFile = path.join(tempDir, 'deploy.txt');
    const pipeline: Pipeline = {
      name: 'manual retry cone',
      on: 'dispatch',
      jobs: {
        setup: {
          steps: [{ id: 'setup', run: `echo setup >> "${setupFile}"` }],
        },
        build: {
          steps: [
            {
              id: 'build',
              run: [
                `echo "${'${RETRY_ALLOW_BUILD:-0}'}" >> "${buildFile}"`,
                'if [ "${RETRY_ALLOW_BUILD:-0}" != "1" ]; then exit 1; fi',
              ].join('\n'),
            },
          ],
        },
        notify: {
          needs: 'build',
          if: 'failure()',
          steps: [{ id: 'notify', run: `echo notify >> "${notifyFile}"` }],
        },
        always_after: {
          needs: 'build',
          if: 'always()',
          steps: [{ id: 'always', run: `echo always >> "${alwaysFile}"` }],
        },
        deploy: {
          needs: ['setup', 'build'],
          steps: [{ id: 'deploy', run: `echo deploy >> "${deployFile}"` }],
        },
      },
    };

    const initialHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'manual-retry-cone',
      runtime,
      executionId: 'manual-retry-cone-exec',
    });
    const failedState = await initialHandle.waitForCompletion();

    expect(failedState.status).toBe('failure');
    expect(fs.readFileSync(setupFile, 'utf8')).toBe('setup\n');
    expect(fs.readFileSync(buildFile, 'utf8')).toBe('0\n');
    expect(fs.readFileSync(notifyFile, 'utf8')).toBe('notify\n');
    expect(fs.readFileSync(alwaysFile, 'utf8')).toBe('always\n');
    expect(fs.existsSync(deployFile)).toBe(false);
    expect(failedState.jobs.notify.status).toBe('success');
    expect(failedState.jobs.always_after.status).toBe('success');
    expect(failedState.jobs.deploy.status).toBe('skipped');

    const retriedHandle = await retryPipelineExecution(
      'manual-retry-cone-exec',
      {
        cwd: tempDir,
        runtime,
        env: {
          RETRY_ALLOW_BUILD: '1',
        },
        portalCommandId: 'portal-retry',
      },
    );
    const retriedState = await retriedHandle.waitForCompletion();

    expect(retriedState.status).toBe('success');
    expect(retriedState.portal_command_ids).toContain('portal-retry');
    expect(retriedState.jobs.setup.status).toBe('success');
    expect(retriedState.jobs.build.retry_count).toBe(0);
    expect(retriedState.jobs.build.retry_history).toEqual([]);
    expect(retriedState.jobs.notify.status).toBe('skipped');
    expect(retriedState.jobs.always_after.status).toBe('success');
    expect(retriedState.jobs.deploy.status).toBe('success');
    expect(fs.readFileSync(setupFile, 'utf8')).toBe('setup\n');
    expect(fs.readFileSync(buildFile, 'utf8')).toBe('0\n1\n');
    expect(fs.readFileSync(notifyFile, 'utf8')).toBe('notify\n');
    expect(fs.readFileSync(alwaysFile, 'utf8')).toBe('always\nalways\n');
    expect(fs.readFileSync(deployFile, 'utf8')).toBe('deploy\n');
  });

  it('does not persist a retry receipt when its package overlay is invalid', async () => {
    const pipeline: Pipeline = {
      name: 'invalid package retry',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'fail', run: 'exit 1' }],
        },
      },
    };
    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'invalid-package-retry',
      runtime,
      executionId: 'invalid-package-retry-exec',
    });
    const failedState = await handle.waitForCompletion();
    failedState.pipeline_package_snapshot = {
      digest: 'a'.repeat(64),
      pipelineContentHash: 'b'.repeat(64),
      cachedPackagePath: path.join(tempDir, 'missing-retry-package'),
      bindings: [],
      capturedAt: '2026-09-11T00:00:00.000Z',
    };
    await saveExecutionState(failedState, runtime.executionsDir);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        retryPipelineExecution(failedState.id, {
          cwd: tempDir,
          runtime,
          portalCommandId: 'portal-invalid-retry',
        }),
      ).rejects.toThrow('Pipeline package execution snapshot is invalid');
    }

    const persisted = await loadExecutionState(
      failedState.id,
      runtime.executionsDir,
    );
    expect(persisted?.status).toBe('failure');
    expect(persisted?.portal_command_ids ?? []).not.toContain(
      'portal-invalid-retry',
    );
  });

  it('resets iteration history when retrying a failed job', async () => {
    const iterationsFile = path.join(tempDir, 'retry-iterations.txt');
    const pipeline: Pipeline = {
      name: 'manual retry iterations',
      on: 'dispatch',
      jobs: {
        build: {
          max_iterations: 2,
          steps: [
            {
              id: 'loop',
              run: [
                `echo "$CANOPY_JOB_ITERATION:${'${ALLOW_RETRY_SUCCESS:-0}'}" >> "${iterationsFile}"`,
                'if [ "$CANOPY_JOB_ITERATION" = "1" ]; then',
                '  echo "CANOPY_JOB_RESTART=true" >> "$CANOPY_OUTPUT"',
                '  exit 0',
                'fi',
                'if [ "${ALLOW_RETRY_SUCCESS:-0}" != "1" ]; then exit 1; fi',
              ].join('\n'),
            },
          ],
        },
      },
    };

    const failedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'manual-retry-iterations',
      runtime,
      executionId: 'manual-retry-iterations-exec',
    });
    const failedState = await failedHandle.waitForCompletion();

    expect(failedState.status).toBe('failure');
    expect(failedState.jobs.build.iteration_count).toBe(2);
    expect(failedState.jobs.build.iteration_history).toHaveLength(1);
    expect(fs.readFileSync(iterationsFile, 'utf8')).toBe('1:0\n2:0\n');

    const retriedHandle = await retryPipelineExecution(
      'manual-retry-iterations-exec',
      {
        cwd: tempDir,
        runtime,
        env: {
          ALLOW_RETRY_SUCCESS: '1',
        },
      },
    );
    const retriedState = await retriedHandle.waitForCompletion();

    expect(retriedState.status).toBe('success');
    expect(retriedState.jobs.build.iteration_count).toBe(2);
    expect(retriedState.jobs.build.iteration_history).toHaveLength(1);
    expect(fs.readFileSync(iterationsFile, 'utf8')).toBe(
      '1:0\n2:0\n1:1\n2:1\n',
    );
  });

  it('reruns prior restart steps when retrying a failed max-iteration job', async () => {
    const attemptsFile = path.join(tempDir, 'retry-max-iterations.txt');
    const pipeline: Pipeline = {
      name: 'manual retry max iterations',
      on: 'dispatch',
      jobs: {
        build: {
          max_iterations: 2,
          steps: [
            {
              id: 'restart',
              run: [
                `echo "restart:$CANOPY_JOB_ITERATION:${'${ALLOW_MAX_ITERATION_RETRY:-0}'}" >> "${attemptsFile}"`,
                'echo "CANOPY_JOB_RESTART=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
            {
              id: 'verify',
              run: [
                `echo "verify:$CANOPY_JOB_ITERATION:${'${ALLOW_MAX_ITERATION_RETRY:-0}'}" >> "${attemptsFile}"`,
                'if [ "${ALLOW_MAX_ITERATION_RETRY:-0}" != "1" ]; then exit 1; fi',
              ].join('\n'),
            },
          ],
        },
      },
    };

    const failedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'manual-retry-max-iterations',
      runtime,
      executionId: 'manual-retry-max-iterations-exec',
    });
    const failedState = await failedHandle.waitForCompletion();

    expect(failedState.status).toBe('failure');
    expect(failedState.jobs.build.iteration_count).toBe(2);
    expect(failedState.jobs.build.iteration_history).toHaveLength(1);
    expect(fs.readFileSync(attemptsFile, 'utf8')).toBe(
      'restart:1:0\nrestart:2:0\nverify:2:0\n',
    );

    const retriedHandle = await retryPipelineExecution(
      'manual-retry-max-iterations-exec',
      {
        cwd: tempDir,
        runtime,
        env: {
          ALLOW_MAX_ITERATION_RETRY: '1',
        },
      },
    );
    const retriedState = await retriedHandle.waitForCompletion();

    expect(retriedState.status).toBe('success');
    expect(retriedState.jobs.build.iteration_count).toBe(2);
    expect(retriedState.jobs.build.iteration_history).toHaveLength(1);
    expect(fs.readFileSync(attemptsFile, 'utf8')).toBe(
      [
        'restart:1:0',
        'restart:2:0',
        'verify:2:0',
        'restart:1:1',
        'restart:2:1',
        'verify:2:1',
        '',
      ].join('\n'),
    );
  });

  it('resets automatic retry history when manually retrying a failed job', async () => {
    const attemptsFile = path.join(tempDir, 'manual-retry-attempts.txt');
    const pipeline: Pipeline = {
      name: 'manual retry attempts',
      on: 'dispatch',
      jobs: {
        build: {
          max_retries: 1,
          steps: [
            {
              id: 'flaky',
              run: [
                `echo "$CANOPY_JOB_RETRY_COUNT:${'${ALLOW_MANUAL_RETRY_SUCCESS:-0}'}" >> "${attemptsFile}"`,
                'if [ "${ALLOW_MANUAL_RETRY_SUCCESS:-0}" != "1" ]; then exit 1; fi',
              ].join('\n'),
            },
          ],
        },
      },
    };

    const failedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'manual-retry-attempts',
      runtime,
      executionId: 'manual-retry-attempts-exec',
    });
    const failedState = await failedHandle.waitForCompletion();

    expect(failedState.status).toBe('failure');
    expect(failedState.jobs.build.retry_count).toBe(1);
    expect(failedState.jobs.build.retry_history).toHaveLength(1);
    expect(fs.readFileSync(attemptsFile, 'utf8')).toBe('0:0\n1:0\n');

    const retriedHandle = await retryPipelineExecution(
      'manual-retry-attempts-exec',
      {
        cwd: tempDir,
        runtime,
        env: {
          ALLOW_MANUAL_RETRY_SUCCESS: '1',
        },
      },
    );
    const retriedState = await retriedHandle.waitForCompletion();

    expect(retriedState.status).toBe('success');
    expect(retriedState.jobs.build.retry_count).toBe(0);
    expect(retriedState.jobs.build.retry_history).toEqual([]);
    expect(fs.readFileSync(attemptsFile, 'utf8')).toBe('0:0\n1:0\n0:1\n');
  });

  it('retries a soft-failed job from the first failing step onward', async () => {
    const firstFile = path.join(tempDir, 'soft-first.txt');
    const flakyFile = path.join(tempDir, 'soft-flaky.txt');
    const afterFile = path.join(tempDir, 'soft-after.txt');
    const pipeline: Pipeline = {
      name: 'soft retry boundary',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'first',
              run: `echo first >> "${firstFile}"`,
            },
            {
              id: 'flaky',
              continue_on_error: true,
              run: [
                `echo "${'${ALLOW_FLAKY_SUCCESS:-0}'}" >> "${flakyFile}"`,
                'if [ "${ALLOW_FLAKY_SUCCESS:-0}" != "1" ]; then exit 1; fi',
              ].join('\n'),
            },
            {
              id: 'after',
              run: `echo after >> "${afterFile}"`,
            },
          ],
        },
      },
    };

    const failedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'soft-retry-boundary',
      runtime,
      executionId: 'soft-retry-boundary-exec',
    });
    const failedState = await failedHandle.waitForCompletion();

    expect(failedState.status).toBe('failure');
    expect(fs.readFileSync(firstFile, 'utf8')).toBe('first\n');
    expect(fs.readFileSync(flakyFile, 'utf8')).toBe('0\n');
    expect(fs.readFileSync(afterFile, 'utf8')).toBe('after\n');

    const retriedHandle = await retryPipelineExecution(
      'soft-retry-boundary-exec',
      {
        cwd: tempDir,
        runtime,
        env: {
          ALLOW_FLAKY_SUCCESS: '1',
        },
      },
    );
    const retriedState = await retriedHandle.waitForCompletion();

    expect(retriedState.status).toBe('success');
    expect(fs.readFileSync(firstFile, 'utf8')).toBe('first\n');
    expect(fs.readFileSync(flakyFile, 'utf8')).toBe('0\n1\n');
    expect(fs.readFileSync(afterFile, 'utf8')).toBe('after\nafter\n');
  });

  it('retries executor-level failures that happen before any job concludes', async () => {
    const setupFile = path.join(tempDir, 'executor-retry-setup.txt');
    const buildFile = path.join(tempDir, 'executor-retry-build.txt');
    const pipeline: Pipeline = {
      name: 'executor failure retry',
      on: 'dispatch',
      jobs: {
        setup: {
          steps: [
            {
              id: 'setup',
              run: `echo setup >> "${setupFile}"`,
            },
          ],
        },
        build: {
          needs: 'setup',
          max_iterations: '${{ env.RETRY_LIMIT }}',
          steps: [
            {
              id: 'build',
              run: `echo build >> "${buildFile}"`,
            },
          ],
        },
      },
    };

    const failedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'executor-failure-retry',
      runtime,
      executionId: 'executor-failure-retry-exec',
      env: {
        RETRY_LIMIT: 'invalid',
      },
    });
    await expect(failedHandle.waitForCompletion()).rejects.toThrow(
      /resolved invalid max_iterations/,
    );

    const failedState = await loadExecutionState(
      'executor-failure-retry-exec',
      runtime.executionsDir,
    );
    if (!failedState) {
      throw new Error('Expected failed execution state to be persisted');
    }

    expect(failedState.status).toBe('failure');
    expect(failedState.error).toMatch(/resolved invalid max_iterations/);
    expect(failedState.jobs.setup.status).toBe('success');
    expect(failedState.jobs.build.conclusion).toBeUndefined();
    expect(fs.readFileSync(setupFile, 'utf8')).toBe('setup\n');
    expect(fs.existsSync(buildFile)).toBe(false);

    const retriedHandle = await retryPipelineExecution(
      'executor-failure-retry-exec',
      {
        cwd: tempDir,
        runtime,
        env: {
          RETRY_LIMIT: '1',
        },
      },
    );
    const retriedState = await retriedHandle.waitForCompletion();

    expect(retriedState.status).toBe('success');
    expect(fs.readFileSync(setupFile, 'utf8')).toBe('setup\n');
    expect(fs.readFileSync(buildFile, 'utf8')).toBe('build\n');
  });

  it('rejects retry for child executions and non-failure states', async () => {
    const pipeline: Pipeline = {
      name: 'retry rejects',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'build', run: 'echo ok' }],
        },
      },
    };

    const successHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'retry-rejects',
      runtime,
      executionId: 'retry-rejects-success',
    });
    await successHandle.waitForCompletion();

    await expect(
      retryPipelineExecution('retry-rejects-success', {
        cwd: tempDir,
        runtime,
      }),
    ).rejects.toThrow(/cannot be retried because it is success/);

    const childState = createInitialState(
      normalizePipeline(pipeline),
      {
        cwd: tempDir,
        pipelineId: 'retry-rejects-child',
        runtime,
        parentExecutionId: 'parent-exec',
        parentStepId: 'child-step',
      },
      'retry-rejects-child',
    );
    childState.status = 'failure';
    childState.jobs.build.status = 'failure';
    childState.jobs.build.conclusion = 'failure';
    childState.jobs.build.outcome = 'failure';
    childState.jobs.build.steps.build = {
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      outputs: {},
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };
    await saveExecutionState(childState, runtime.executionsDir);

    await expect(
      retryPipelineExecution('retry-rejects-child', {
        cwd: tempDir,
        runtime,
      }),
    ).rejects.toThrow(/Only root executions can be retried/);
  });

  it('reruns a terminal execution with a new id and preserved replay inputs', async () => {
    const pipeline: Pipeline = {
      name: 'rerun dispatch',
      on: {
        dispatch: {
          inputs: {
            greeting: {
              type: 'string',
              required: true,
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [
            {
              id: 'build',
              run: 'printf "%s:%s" "$INPUT_GREETING" "$HELLO" > rerun-dispatch.txt',
            },
          ],
        },
      },
    };

    const initialHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'rerun-dispatch',
      runtime,
      executionId: 'rerun-dispatch-source',
      inputs: {
        greeting: 'hello',
      },
      env: {
        HELLO: 'world',
      },
      repoPath: path.join(tempDir, 'repo'),
      initiationSource: 'automation',
    });
    const sourceState = await initialHandle.waitForCompletion();

    const rerunHandle = await rerunPipelineExecution('rerun-dispatch-source', {
      cwd: tempDir,
      runtime,
      initiationSource: 'portal',
    });
    const rerunState = await rerunHandle.waitForCompletion();

    expect(rerunState.id).not.toBe(sourceState.id);
    expect(rerunState.status).toBe('success');
    expect(rerunState.pipeline_id).toBe(sourceState.pipeline_id);
    expect(rerunState.inputs).toEqual(sourceState.inputs);
    expect(rerunState.env.HELLO).toBe('world');
    expect(rerunState.env.CANOPY_OUTPUT_DIR).toBe(
      path.join(runtime.executionsDir, rerunState.id),
    );
    expect(rerunState.env.CANOPY_OUTPUT_DIR).not.toBe(
      sourceState.env.CANOPY_OUTPUT_DIR,
    );
    expect(rerunState.repo_path).toBe(path.join(tempDir, 'repo'));
    expect(rerunState.rerun_source_id).toBe(sourceState.id);
    expect(rerunState.initiation_source).toBe('portal');
    expect(
      fs.readFileSync(path.join(tempDir, 'rerun-dispatch.txt'), 'utf8'),
    ).toBe('hello:world');
  });

  it('preserves the repo root when rerunning a narrowed worktree execution', async () => {
    const repoPath = path.join(tempDir, 'repo-root-rerun');
    const narrowedCwd = path.join(repoPath, 'packages', 'app');
    fs.mkdirSync(narrowedCwd, { recursive: true });
    const pipeline: Pipeline = {
      name: 'rerun narrowed worktree',
      scope: 'worktree',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'build', run: 'echo ok' }],
        },
      },
    };

    const initialHandle = await executePipeline(pipeline, {
      cwd: narrowedCwd,
      pipelineId: 'rerun-narrowed-worktree',
      runtime,
      executionId: 'rerun-narrowed-worktree-source',
      scope: 'worktree',
      target: {
        scope: 'worktree',
        workspace_id: 'workspace-a',
        worktree_id: 'feature',
        path: narrowedCwd,
        created: false,
      },
      projectId: 'workspace-a',
      worktreeId: 'feature',
      repoPath,
    });
    const sourceState = await initialHandle.waitForCompletion();

    const rerunHandle = await rerunPipelineExecution(
      'rerun-narrowed-worktree-source',
      {
        cwd: tempDir,
        runtime,
      },
    );
    const rerunState = await rerunHandle.waitForCompletion();

    expect(sourceState.status).toBe('success');
    expect(rerunState.status).toBe('success');
    expect(rerunState.cwd).toBe(narrowedCwd);
    expect(rerunState.target).toMatchObject({ path: narrowedCwd });
    expect(rerunState.repo_path).toBe(repoPath);
  });

  it('rejects rerun for non-terminal and child executions', async () => {
    const pipeline: Pipeline = {
      name: 'rerun rejects',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'build', run: 'echo ok' }],
        },
      },
    };

    const pendingState = createInitialState(
      normalizePipeline(pipeline),
      {
        cwd: tempDir,
        pipelineId: 'rerun-rejects-pending',
        runtime,
      },
      'rerun-rejects-pending',
    );
    pendingState.status = 'running';
    await saveExecutionState(pendingState, runtime.executionsDir);

    await expect(
      rerunPipelineExecution('rerun-rejects-pending', {
        cwd: tempDir,
        runtime,
      }),
    ).rejects.toThrow(/cannot be rerun because it is running/);

    const childState = createInitialState(
      normalizePipeline(pipeline),
      {
        cwd: tempDir,
        pipelineId: 'rerun-rejects-child',
        runtime,
        parentExecutionId: 'parent',
        parentStepId: 'step',
      },
      'rerun-rejects-child',
    );
    childState.status = 'success';
    childState.jobs.build.status = 'success';
    childState.jobs.build.conclusion = 'success';
    childState.jobs.build.outcome = 'success';
    childState.jobs.build.steps.build = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: {},
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };
    await saveExecutionState(childState, runtime.executionsDir);

    await expect(
      rerunPipelineExecution('rerun-rejects-child', {
        cwd: tempDir,
        runtime,
      }),
    ).rejects.toThrow(/Only root executions can be rerun/);
  });

  it('reruns plan_ready executions from the immutable original plan snapshot', async () => {
    const observedFile = path.join(tempDir, 'rerun-plan-observed.txt');
    const pipeline: Pipeline = {
      name: 'rerun plan ready',
      on: 'plan_ready',
      jobs: {
        build: {
          steps: [
            {
              id: 'capture',
              run: [
                `cat "${'${{ canopy.event.plan_ready.plan_path }}'}" > "${observedFile}"`,
                `printf '%s\n' 'Updated plan' > "${'${{ canopy.event.plan_ready.plan_path }}'}"`,
              ].join('\n'),
            },
          ],
        },
      },
    };

    const initialHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'rerun-plan-ready',
      runtime,
      executionId: 'rerun-plan-ready-source',
      eventName: 'plan_ready',
      eventData: {
        plan_ready: {
          plan_text: 'Original plan\n',
        },
      },
    });
    const sourceState = await initialHandle.waitForCompletion();
    const sourcePlanPath = sourceState.event_data?.plan_ready?.plan_path;

    expect(sourceState.status).toBe('success');
    expect(fs.readFileSync(observedFile, 'utf8')).toBe('Original plan\n');
    fs.writeFileSync(sourcePlanPath ?? '', 'Mutated after run\n', 'utf8');

    const rerunHandle = await rerunPipelineExecution(
      'rerun-plan-ready-source',
      {
        cwd: tempDir,
        runtime,
      },
    );
    const rerunState = await rerunHandle.waitForCompletion();

    expect(rerunState.status).toBe('success');
    expect(rerunState.event_data?.plan_ready?.plan_path).not.toBe(
      sourcePlanPath,
    );
    expect(fs.readFileSync(observedFile, 'utf8')).toBe('Original plan\n');
  });

  it('reruns task_ready executions from the immutable original task snapshot', async () => {
    const observedFile = path.join(tempDir, 'rerun-task-observed.txt');
    const pipeline: Pipeline = {
      name: 'rerun task ready',
      on: 'task_ready',
      jobs: {
        build: {
          steps: [
            {
              id: 'capture',
              run: [
                `cat "${'${{ canopy.event.task_ready.task_path }}'}" > "${observedFile}"`,
                `printf '%s\n' 'Generated plan' > "${'${{ canopy.event.task_ready.plan_path }}'}"`,
              ].join('\n'),
            },
          ],
        },
      },
    };

    const initialHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'rerun-task-ready',
      runtime,
      executionId: 'rerun-task-ready-source',
      eventName: 'task_ready',
      eventData: {
        task_ready: {
          task_text: 'Original task\n',
        },
      },
    });
    const sourceState = await initialHandle.waitForCompletion();
    const sourceTaskPath = sourceState.event_data?.task_ready?.task_path;

    expect(sourceState.status).toBe('success');
    expect(fs.readFileSync(observedFile, 'utf8')).toBe('Original task\n');
    fs.writeFileSync(sourceTaskPath ?? '', 'Mutated after run\n', 'utf8');

    const rerunHandle = await rerunPipelineExecution(
      'rerun-task-ready-source',
      {
        cwd: tempDir,
        runtime,
      },
    );
    const rerunState = await rerunHandle.waitForCompletion();

    expect(rerunState.status).toBe('success');
    expect(rerunState.event_data?.task_ready?.task_path).not.toBe(
      sourceTaskPath,
    );
    expect(fs.readFileSync(observedFile, 'utf8')).toBe('Original task\n');
  });

  it('refreshes base-branch env and removes stale managed keys when rerunning', async () => {
    const branchFile = path.join(tempDir, 'rerun-base-branch.txt');
    const branchMapFile = path.join(tempDir, 'rerun-base-branch-map.txt');
    const pipeline: Pipeline = {
      name: 'rerun base branch env',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'capture',
              run: [
                `printf '%s' "$CANOPY_BASE_BRANCH" > "${branchFile}"`,
                `printf '%s' "${'${CANOPY_BASE_BRANCH_BY_REPO:-}'}" > "${branchMapFile}"`,
              ].join('\n'),
            },
          ],
        },
      },
    };

    const sourceHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'rerun-base-branch-env',
      runtime,
      executionId: 'rerun-base-branch-env-source',
      env: {
        FOO: 'bar',
        CANOPY_BASE_BRANCH: 'stale-base',
        CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'false',
        CANOPY_BASE_BRANCH_BY_REPO: '{"repo":"stale-base"}',
        CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO: '{"repo":"false"}',
      },
    });
    const sourceState = await sourceHandle.waitForCompletion();

    expect(sourceState.status).toBe('success');

    const rerunHandle = await rerunPipelineExecution(
      'rerun-base-branch-env-source',
      {
        cwd: tempDir,
        runtime,
        env: {
          CANOPY_BASE_BRANCH: 'fresh-base',
          CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'true',
        },
      },
    );
    const rerunState = await rerunHandle.waitForCompletion();

    expect(rerunState.status).toBe('success');
    expect(rerunState.env.FOO).toBe('bar');
    expect(rerunState.env.CANOPY_BASE_BRANCH).toBe('fresh-base');
    expect(rerunState.env.CANOPY_BASE_BRANCH_BY_REPO).toBeUndefined();
    expect(rerunState.env.CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO).toBe(
      undefined,
    );
    expect(fs.readFileSync(branchFile, 'utf8')).toBe('fresh-base');
    expect(fs.readFileSync(branchMapFile, 'utf8')).toBe('');
  });

  it('retries shared executions from the cached shared snapshot', async () => {
    const stalePipeline: Pipeline = {
      name: 'Stale Shared Snapshot',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'build', run: 'echo stale > shared-retry.txt' }],
        },
      },
    };
    const cachedPipelineRaw = [
      'name: Cached Shared Snapshot',
      'on: dispatch',
      'jobs:',
      '  build:',
      '    steps:',
      '      - id: build',
      '        run: echo cached > shared-retry.txt',
    ].join('\n');
    const sourceState = createInitialState(
      normalizePipeline(stalePipeline),
      {
        cwd: tempDir,
        pipelineId: 'shared-retry',
        runtime,
      },
      'shared-retry-source',
    );
    sourceState.status = 'failure';
    sourceState.jobs.build.status = 'failure';
    sourceState.jobs.build.conclusion = 'failure';
    sourceState.jobs.build.outcome = 'failure';
    sourceState.jobs.build.steps.build = {
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      outputs: {},
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };
    sourceState.shared_pipeline_source = {
      type: 'shared',
      serverId: 'server-1',
      serverName: 'Primary',
      remoteId: 'remote-1',
      cachedPipelinePath: path.join(
        runtime.executionsDir,
        'shared-retry-source',
        'shared-pipeline.yaml',
      ),
      fetchedAt: '2026-04-26T12:00:00.000Z',
    };
    fs.mkdirSync(
      path.dirname(sourceState.shared_pipeline_source.cachedPipelinePath),
      {
        recursive: true,
      },
    );
    fs.writeFileSync(
      sourceState.shared_pipeline_source.cachedPipelinePath,
      cachedPipelineRaw,
      'utf8',
    );
    await saveExecutionState(sourceState, runtime.executionsDir);

    const retryHandle = await retryPipelineExecution('shared-retry-source', {
      cwd: tempDir,
      runtime,
    });
    const retryState = await retryHandle.waitForCompletion();

    expect(retryState.status).toBe('success');
    expect(retryState.pipeline_snapshot.name).toBe('Cached Shared Snapshot');
    expect(
      fs.readFileSync(path.join(tempDir, 'shared-retry.txt'), 'utf8'),
    ).toBe('cached\n');
  });

  it('reruns shared executions from a fresh override snapshot and metadata', async () => {
    const sourcePipeline: Pipeline = {
      name: 'Original Shared Snapshot',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'build', run: 'echo original > shared-rerun.txt' }],
        },
      },
    };
    const rerunPipeline: Pipeline = {
      name: 'Fresh Shared Snapshot',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'build', run: 'echo fresh > shared-rerun.txt' }],
        },
      },
    };
    const sourceState = createInitialState(
      normalizePipeline(sourcePipeline),
      {
        cwd: tempDir,
        pipelineId: 'shared-rerun',
        runtime,
      },
      'shared-rerun-source',
    );
    sourceState.status = 'success';
    sourceState.jobs.build.status = 'success';
    sourceState.jobs.build.conclusion = 'success';
    sourceState.jobs.build.outcome = 'success';
    sourceState.jobs.build.steps.build = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: {},
      dynamic_env: {},
      completed_at: new Date().toISOString(),
    };
    sourceState.shared_pipeline_source = {
      type: 'shared',
      serverId: 'server-1',
      serverName: 'Primary',
      remoteId: 'remote-old',
      cachedPipelinePath: path.join(
        runtime.executionsDir,
        'shared-rerun-source',
        'shared-pipeline.yaml',
      ),
      fetchedAt: '2026-04-26T12:00:00.000Z',
    };
    await saveExecutionState(sourceState, runtime.executionsDir);

    const freshSharedSource = {
      type: 'shared' as const,
      serverId: 'server-1',
      serverName: 'Primary',
      remoteId: 'remote-fresh',
      cachedPipelinePath: path.join(
        runtime.executionsDir,
        'shared-rerun-fresh',
        'shared-pipeline.yaml',
      ),
      fetchedAt: '2026-04-26T12:05:00.000Z',
    };

    const rerunHandle = await rerunPipelineExecution('shared-rerun-source', {
      cwd: tempDir,
      runtime,
      pipelineOverride: rerunPipeline,
      sharedPipelineSource: freshSharedSource,
    });
    const rerunState = await rerunHandle.waitForCompletion();

    expect(rerunState.status).toBe('success');
    expect(rerunState.pipeline_snapshot.name).toBe('Fresh Shared Snapshot');
    expect(rerunState.shared_pipeline_source).toEqual(freshSharedSource);
    expect(rerunState.rerun_source_id).toBe('shared-rerun-source');
    expect(
      fs.readFileSync(path.join(tempDir, 'shared-rerun.txt'), 'utf8'),
    ).toBe('fresh\n');
  });

  it('fails rerun cleanly for legacy plan_ready executions without replay metadata', async () => {
    const pipeline: Pipeline = {
      name: 'legacy rerun plan',
      on: 'plan_ready',
      jobs: {
        build: {
          steps: [{ id: 'build', run: 'echo ok' }],
        },
      },
    };

    const initialHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'legacy-rerun-plan',
      runtime,
      executionId: 'legacy-rerun-plan-source',
      eventName: 'plan_ready',
      eventData: {
        plan_ready: {
          plan_text: 'Legacy plan\n',
        },
      },
    });
    const sourceState = await initialHandle.waitForCompletion();
    const legacyState = {
      ...sourceState,
      rerun_context: undefined,
    };
    await saveExecutionState(legacyState, runtime.executionsDir);

    await expect(
      rerunPipelineExecution('legacy-rerun-plan-source', {
        cwd: tempDir,
        runtime,
      }),
    ).rejects.toThrow(/original plan input was not preserved/);
  });

  it('clears stale cancellation markers before retrying', async () => {
    const pipeline: Pipeline = {
      name: 'retry clears cancel marker',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'build',
              run: [
                'if [ "${ALLOW_RETRY_CLEAR_CANCEL:-0}" != "1" ]; then exit 1; fi',
                'echo "ok" > retry-clear-cancel.txt',
              ].join('\n'),
            },
          ],
        },
      },
    };

    const failedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'retry-clear-cancel',
      runtime,
      executionId: 'retry-clear-cancel-exec',
    });
    const failedState = await failedHandle.waitForCompletion();

    expect(failedState.status).toBe('failure');
    const cancelMarker = path.join(
      runtime.executionsDir,
      'retry-clear-cancel-exec.cancel',
    );
    fs.writeFileSync(cancelMarker, 'cancel', 'utf8');

    const retriedHandle = await retryPipelineExecution(
      'retry-clear-cancel-exec',
      {
        cwd: tempDir,
        runtime,
        env: {
          ALLOW_RETRY_CLEAR_CANCEL: '1',
        },
      },
    );
    const retriedState = await retriedHandle.waitForCompletion();

    expect(retriedState.status).toBe('success');
    expect(fs.existsSync(cancelMarker)).toBe(false);
    expect(
      fs.readFileSync(path.join(tempDir, 'retry-clear-cancel.txt'), 'utf8'),
    ).toBe('ok\n');
  });

  it('preserves the repo root when retrying a narrowed worktree execution', async () => {
    const repoPath = path.join(tempDir, 'repo-root-retry');
    const narrowedCwd = path.join(repoPath, 'packages', 'app');
    fs.mkdirSync(narrowedCwd, { recursive: true });
    const pipeline: Pipeline = {
      name: 'retry narrowed worktree',
      scope: 'worktree',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'build',
              run: 'if [ "${ALLOW_NARROWED_RETRY:-0}" != "1" ]; then exit 1; fi',
            },
          ],
        },
      },
    };

    const failedHandle = await executePipeline(pipeline, {
      cwd: narrowedCwd,
      pipelineId: 'retry-narrowed-worktree',
      runtime,
      executionId: 'retry-narrowed-worktree-exec',
      scope: 'worktree',
      target: {
        scope: 'worktree',
        workspace_id: 'workspace-a',
        worktree_id: 'feature',
        path: narrowedCwd,
        created: false,
      },
      projectId: 'workspace-a',
      worktreeId: 'feature',
      repoPath,
    });
    const failedState = await failedHandle.waitForCompletion();

    const retriedHandle = await retryPipelineExecution(
      'retry-narrowed-worktree-exec',
      {
        cwd: tempDir,
        runtime,
        env: {
          ALLOW_NARROWED_RETRY: '1',
        },
      },
    );
    const retriedState = await retriedHandle.waitForCompletion();

    expect(failedState.status).toBe('failure');
    expect(retriedState.status).toBe('success');
    expect(retriedState.cwd).toBe(narrowedCwd);
    expect(retriedState.target).toMatchObject({ path: narrowedCwd });
    expect(retriedState.repo_path).toBe(repoPath);
  });

  it('refreshes base-branch env and removes stale managed keys when retrying', async () => {
    const branchFile = path.join(tempDir, 'retry-base-branch.txt');
    const branchMapFile = path.join(tempDir, 'retry-base-branch-map.txt');
    const pipeline: Pipeline = {
      name: 'retry base branch env',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'capture',
              run: [
                `printf '%s' "$CANOPY_BASE_BRANCH" > "${branchFile}"`,
                `printf '%s' "${'${CANOPY_BASE_BRANCH_BY_REPO:-}'}" > "${branchMapFile}"`,
                'if [ "${ALLOW_RETRY_BASE_BRANCH_SUCCESS:-0}" != "1" ]; then exit 1; fi',
              ].join('\n'),
            },
          ],
        },
      },
    };

    const failedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'retry-base-branch-env',
      runtime,
      executionId: 'retry-base-branch-env-exec',
      env: {
        FOO: 'bar',
        CANOPY_BASE_BRANCH: 'stale-base',
        CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'false',
        CANOPY_BASE_BRANCH_BY_REPO: '{"repo":"stale-base"}',
        CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO: '{"repo":"false"}',
      },
    });
    const failedState = await failedHandle.waitForCompletion();

    expect(failedState.status).toBe('failure');

    const retriedHandle = await retryPipelineExecution(
      'retry-base-branch-env-exec',
      {
        cwd: tempDir,
        runtime,
        env: {
          ALLOW_RETRY_BASE_BRANCH_SUCCESS: '1',
          CANOPY_BASE_BRANCH: 'fresh-base',
          CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'true',
        },
      },
    );
    const retriedState = await retriedHandle.waitForCompletion();

    expect(retriedState.status).toBe('success');
    expect(retriedState.env.FOO).toBe('bar');
    expect(retriedState.env.CANOPY_BASE_BRANCH).toBe('fresh-base');
    expect(retriedState.env.CANOPY_BASE_BRANCH_BY_REPO).toBeUndefined();
    expect(retriedState.env.CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO).toBe(
      undefined,
    );
    expect(fs.readFileSync(branchFile, 'utf8')).toBe('fresh-base');
    expect(fs.readFileSync(branchMapFile, 'utf8')).toBe('');
  });

  it('runs independent jobs in parallel and skips downstream jobs on dependency failure', async () => {
    const parallelPipeline: Pipeline = {
      name: 'parallel',
      on: 'dispatch',
      jobs: {
        first: {
          steps: [{ id: 'first', run: 'sleep 0.3' }],
        },
        second: {
          steps: [{ id: 'second', run: 'sleep 0.3' }],
        },
      },
    };
    const parallelHandle = await executePipeline(parallelPipeline, {
      cwd: tempDir,
      pipelineId: 'parallel',
      runtime,
    });
    const parallelState = await parallelHandle.waitForCompletion();

    expect(parallelState.status).toBe('success');
    expectTimestampRange(
      parallelState.jobs.first.started_at,
      parallelState.jobs.first.completed_at,
    );
    expectTimestampRange(
      parallelState.jobs.second.started_at,
      parallelState.jobs.second.completed_at,
    );
    expectTimestampOverlap(
      parallelState.jobs.first.started_at,
      parallelState.jobs.first.completed_at,
      parallelState.jobs.second.started_at,
      parallelState.jobs.second.completed_at,
    );

    const failurePipeline: Pipeline = {
      name: 'failure',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'fail', run: 'exit 1' }],
        },
        deploy: {
          needs: 'build',
          steps: [{ id: 'deploy', run: 'echo deploy' }],
        },
      },
    };
    const failureHandle = await executePipeline(failurePipeline, {
      cwd: tempDir,
      pipelineId: 'failure',
      runtime,
    });
    const failureState = await failureHandle.waitForCompletion();

    expect(failureState.status).toBe('failure');
    expect(failureState.jobs.deploy.status).toBe('skipped');
    expect(failureState.job_groups.deploy.status).toBe('skipped');
  });

  it('treats continue_on_error jobs as satisfied dependencies and supports cancellation', async () => {
    const continuePipeline: Pipeline = {
      name: 'continue',
      on: 'dispatch',
      jobs: {
        lint: {
          continue_on_error: true,
          steps: [{ id: 'lint', run: 'exit 1' }],
        },
        deploy: {
          needs: 'lint',
          if: "needs.lint.result == 'success'",
          steps: [{ id: 'deploy', run: 'echo deployed > deployed.txt' }],
        },
      },
    };
    const continueHandle = await executePipeline(continuePipeline, {
      cwd: tempDir,
      pipelineId: 'continue',
      runtime,
    });
    const continueState = await continueHandle.waitForCompletion();

    expect(continueState.status).toBe('success');
    expect(continueState.jobs.lint.status).toBe('failure');
    expect(continueState.jobs.lint.outcome).toBe('failure');
    expect(continueState.jobs.lint.conclusion).toBe('success');
    expect(continueState.jobs.deploy.status).toBe('success');
    // Tolerating the failure must not erase it: bundled presets (for example
    // the `summary` job of `create-task-implementation-plan.yaml`) rely on a
    // tolerated job still reporting its failing step and error text so the run
    // stays diagnosable while concluding successfully.
    expect(continueState.jobs.lint.steps.lint.status).toBe('failure');
    expect(continueState.jobs.lint.steps.lint.conclusion).toBe('failure');
    expect(continueState.jobs.lint.steps.lint.error).toBe(
      'Process exited with code 1',
    );
    expect(continueState.job_groups.lint.conclusion).toBe('success');

    const cancelPipeline: Pipeline = {
      name: 'cancel',
      on: 'dispatch',
      jobs: {
        wait: {
          steps: [{ id: 'wait', run: 'sleep 5' }],
        },
      },
    };
    const cancelHandle = await executePipeline(cancelPipeline, {
      cwd: tempDir,
      pipelineId: 'cancel',
      runtime,
    });
    setTimeout(() => {
      void cancelHandle.cancel();
    }, 100);
    const cancelled = await cancelHandle.waitForCompletion();

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.jobs.wait.status).toBe('cancelled');
    expect(cancelled.job_groups.wait.status).toBe('cancelled');
  });

  it('cancels a running execution through persisted state', async () => {
    const pipeline: Pipeline = {
      name: 'external cancel',
      on: 'dispatch',
      jobs: {
        wait: {
          steps: [{ id: 'wait', run: 'sleep 5' }],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'external-cancel',
      runtime,
      executionId: 'external-cancel-exec',
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const cancelledState = await cancelPipelineExecution(
      'external-cancel-exec',
      runtime,
    );
    const finalState = await handle.waitForCompletion();

    expect(cancelledState.status).toBe('cancelled');
    expect(finalState.status).toBe('cancelled');
    expect(finalState.jobs.wait.status).toBe('cancelled');
  });

  it('stops notifying a disposed active execution observer', async () => {
    const started = createDeferred<void>();
    const observer = jest.fn();
    const handle = await executePipeline(
      {
        name: 'disposable observer',
        on: 'dispatch',
        jobs: {
          wait: {
            steps: [{ id: 'wait', run: 'sleep 30' }],
          },
        },
      },
      {
        cwd: tempDir,
        pipelineId: 'disposable-observer',
        runtime,
        executionId: 'disposable-observer-exec',
        onEvent: (event) => {
          if (event.state.jobs.wait?.status === 'running') started.resolve();
        },
      },
    );
    await started.promise;

    if (!handle.addObservers) {
      throw new Error('Missing active observer registration');
    }
    const removeObserver = handle.addObservers({ onEvent: observer });
    removeObserver();
    await handle.cancel();

    expect(observer).not.toHaveBeenCalled();
  });

  it.each(['shutdown', 'authentication'])(
    'pauses for %s, retains completed steps, and resumes only unfinished work',
    async (reason) => {
      const started = createDeferred<void>();
      const pipeline: Pipeline = {
        name: 'shutdown pause',
        on: 'dispatch',
        jobs: {
          work: {
            steps: [
              { id: 'done', run: 'echo once >> completed.txt' },
              { id: 'wait', run: 'if [ ! -f release ]; then sleep 30; fi' },
              { id: 'last', run: 'echo resumed > result.txt' },
            ],
          },
        },
      };
      const handle = await executePipeline(pipeline, {
        cwd: tempDir,
        pipelineId: 'shutdown-pause',
        runtime,
        executionId: 'shutdown-pause-exec',
        onEvent: (event) => {
          if (event.state.jobs.work.steps.wait?.status === 'running')
            started.resolve();
        },
      });
      await started.promise;
      try {
        expect(handle).toHaveProperty('pauseForShutdown');
        if (!handle.pauseForShutdown) throw new Error('Missing shutdown pause');
        if (!handle.pauseForAuthentication)
          throw new Error('Missing authentication pause');
        const paused =
          reason === 'shutdown'
            ? await handle.pauseForShutdown()
            : await handle.pauseForAuthentication('attempt-1');
        if (reason === 'authentication')
          expect(paused.authentication_pause).toEqual({
            attempt_id: 'attempt-1',
            reason_ids: paused.status_reasons.map((item) => item.id),
          });
        expect(paused.status).toBe('paused');
        expect(paused.jobs.work.steps.done.status).toBe('success');
        expect(paused.status_reasons).toEqual([
          expect.objectContaining({
            kind: reason === 'shutdown' ? 'app_shutdown' : 'provider_sign_in',
          }),
        ]);
        fs.writeFileSync(path.join(tempDir, 'release'), '');
        const resumed = await resumePipeline(handle.id, {
          cwd: tempDir,
          runtime,
        });
        expect((await resumed.waitForCompletion()).status).toBe('success');
        expect(
          fs.readFileSync(path.join(tempDir, 'completed.txt'), 'utf8'),
        ).toBe('once\n');
        expect(fs.readFileSync(path.join(tempDir, 'result.txt'), 'utf8')).toBe(
          'resumed\n',
        );
      } finally {
        await handle.cancel();
      }
    },
  );

  it('finishes successfully when shutdown arrives after the last job completes', async () => {
    const pipeline: Pipeline = {
      name: 'shutdown after completion',
      on: 'dispatch',
      jobs: {
        work: {
          steps: [{ id: 'last', run: 'sleep 0.1; echo done' }],
        },
      },
    };
    let shutdown: Promise<ExecutionState> | undefined;
    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'shutdown-after-completion',
      runtime,
      executionId: 'shutdown-after-completion-exec',
      onEvent: (event) => {
        if (
          handle.pauseForShutdown &&
          event.state.jobs.work?.status === 'success' &&
          !shutdown
        ) {
          shutdown = handle.pauseForShutdown();
        }
      },
    });

    const result = await handle.waitForCompletion();
    await shutdown;
    expect(result.status).toBe('success');
    expect(result.shutdown_checkpoint).toBeUndefined();
    expect(result.completed_at).toBeTruthy();
  });

  it.each([
    'shell',
    'agent',
    'removed-model',
    'missing-log',
    'live-owner',
    'existing-pause',
  ])(
    'recovers abandoned %s work without replaying completed steps',
    async (kind) => {
      const pipeline: Pipeline = {
        name: 'crash recovery',
        on: 'dispatch',
        jobs: {
          build: {
            steps: [
              { id: 'done', run: 'echo done' },
              kind === 'agent' ||
              kind === 'removed-model' ||
              kind === 'missing-log'
                ? {
                    id: 'work',
                    uses: 'builtin/agent-prompt',
                    with: { prompt: 'Continue work', model: 'gpt-6-sol' },
                  }
                : { id: 'work', run: 'echo resumed' },
            ],
          },
        },
      };
      const id = `crash-${kind}`;
      const state = createInitialState(
        normalizePipeline(pipeline),
        { cwd: tempDir, pipelineId: id, runtime, executionId: id },
        id,
      );
      state.status = kind === 'existing-pause' ? 'paused' : 'running';
      state.owner_pid = kind === 'live-owner' ? process.pid : 2_000_000_000;
      state.jobs.build.status =
        kind === 'existing-pause' ? 'paused' : 'running';
      const done = {
        status: 'success' as const,
        outputs: { value: 'keep me' },
        dynamic_env: {},
        completed_at: '2026-09-08T12:00:00.000Z',
      };
      state.jobs.build.steps.done = done;
      const work = state.jobs.build.steps.work;
      work.status = kind === 'existing-pause' ? 'paused' : 'running';
      if (
        kind === 'agent' ||
        kind === 'removed-model' ||
        kind === 'missing-log'
      ) {
        const dir = path.join(runtime.executionsDir, id);
        fs.mkdirSync(dir, { recursive: true });
        work.log_file = path.join(dir, 'agent.jsonl');
        work.log_format_hint = 'agent';
        work.agent_model =
          kind === 'removed-model' ? 'old-model-id' : 'gpt-6-sol';
        work.agent_provider = 'codex';
        work.agent_harness = 'codex';
        if (kind === 'agent' || kind === 'removed-model')
          fs.writeFileSync(
            work.log_file,
            JSON.stringify({
              type: 'thread.started',
              thread_id: 'crashed-thread',
            }) + '\n',
          );
      }
      if (kind === 'existing-pause')
        state.status_reasons.push({
          id: 'a917c47e-26f6-4f7a-a905-1b8d0e9d655a',
          kind: 'provider_usage_limit',
          code: 'usage_limit_exceeded',
          provider: 'codex',
          detected_at: '2026-09-08T12:00:00.000Z',
          source: {
            job_id: 'build',
            step_id: 'work',
            attempt: 0,
            iteration: 1,
          },
        });
      await saveExecutionState(state, runtime.executionsDir);
      expect(
        await recoverOrphanedPipelineExecutions([id], runtime.executionsDir),
      ).toEqual([]);
      const restored = await loadExecutionState(id, runtime.executionsDir);
      if (!restored) throw new Error('Missing restored execution');
      expect(restored?.jobs.build.steps.done).toEqual(done);
      if (kind === 'live-owner' || kind === 'existing-pause') {
        expect(restored?.status).toBe(state.status);
        expect(restored?.status_reasons).toEqual(state.status_reasons);
        return;
      }
      expect(restored?.status).toBe('paused');
      expect(restored?.jobs.build.steps.work.status).toBe('paused');
      expect(restored?.status_reasons).toEqual([
        expect.objectContaining({ kind: 'app_shutdown' }),
      ]);
      if (kind === 'agent' || kind === 'removed-model')
        expect(restored?.jobs.build.steps.work.agent_recovery).toEqual(
          expect.objectContaining({
            session_id: 'crashed-thread',
            provider: 'codex',
            harness: 'codex',
            strategy: 'continue_session',
            had_agent_activity: true,
          }),
        );
      if (kind === 'missing-log') {
        await expect(
          resumePipeline(id, {
            cwd: tempDir,
            pipelineId: id,
            runtime,
            statusReasonIds: restored.status_reasons.map((reason) => reason.id),
          }),
        ).rejects.toThrow(/manually/i);
      }
      const once = JSON.stringify(restored);
      await recoverOrphanedPipelineExecutions([id], runtime.executionsDir);
      expect(
        JSON.stringify(await loadExecutionState(id, runtime.executionsDir)),
      ).toBe(once);
    },
  );

  it.each(['shell', 'agent'])(
    'resumes %s job finalization after its last step was already persisted',
    async (kind) => {
      const id = 'crash-finalization';
      const pipeline: Pipeline = {
        name: id,
        on: 'dispatch',
        jobs: { build: { steps: [{ id: 'done', run: 'exit 93' }] } },
      };
      const state = createInitialState(
        normalizePipeline(pipeline),
        { cwd: tempDir, pipelineId: id, runtime, executionId: id },
        id,
      );
      state.status = 'running';
      state.owner_pid = 2_000_000_000;
      state.jobs.build.status = 'running';
      state.jobs.build.steps.done = {
        status: 'success',
        outputs: { keep: 'output' },
        dynamic_env: {},
        conclusion: 'success',
        outcome: 'success',
      };
      if (kind === 'agent')
        state.jobs.build.steps.done.log_format_hint = 'agent';
      await saveExecutionState(state, runtime.executionsDir);
      expect(
        await recoverOrphanedPipelineExecutions([id], runtime.executionsDir),
      ).toEqual([]);
      const recovered = await loadExecutionState(id, runtime.executionsDir);
      if (!recovered) throw new Error('Missing recovered execution');
      expect(recovered?.status).toBe('paused');
      expect(recovered?.jobs.build.steps.done.status).toBe('success');
      const handle = await resumePipeline(id, {
        cwd: tempDir,
        pipelineId: id,
        runtime,
        statusReasonIds: recovered.status_reasons.map((reason) => reason.id),
      });
      expect((await handle.waitForCompletion()).status).toBe('success');
    },
  );

  it('pauses a dynamic matrix before any physical jobs have been created', async () => {
    const id = 'crash-unexpanded-matrix';
    const pipeline: Pipeline = {
      name: id,
      on: 'dispatch',
      jobs: {
        build: {
          strategy: { matrix: '${{ parseJson(\'{"version":[1,2]}\') }}' },
          steps: [{ id: 'work', run: 'echo matrix' }],
        },
      },
    };
    const state = createInitialState(
      normalizePipeline(pipeline),
      { cwd: tempDir, pipelineId: id, runtime, executionId: id },
      id,
    );
    state.owner_pid = 2_000_000_000;
    await saveExecutionState(state, runtime.executionsDir);
    expect(
      await recoverOrphanedPipelineExecutions([id], runtime.executionsDir),
    ).toEqual([]);
    const recovered = await loadExecutionState(id, runtime.executionsDir);
    if (!recovered) throw new Error('Missing recovered execution');
    expect(recovered?.status).toBe('paused');
    const checkpoint = recovered.shutdown_checkpoint;
    if (!checkpoint) throw new Error('Missing execution checkpoint');
    expect(checkpoint.id).toBeTruthy();
    const handle = await resumePipeline(id, {
      cwd: tempDir,
      pipelineId: id,
      runtime,
      statusReasonIds: [checkpoint.id],
    });
    const result = await handle.waitForCompletion();
    if (result.status !== 'success')
      throw new Error(JSON.stringify(result.job_groups));
    expect(result.status).toBe('success');
    expect(Object.keys(result.jobs)).toHaveLength(2);
  });

  it.each(['running', 'success', 'failure', 'cancelled', 'live'] as const)(
    'recovers a nested %s child before the parent',
    async (status) => {
      const childId = `crash-child-${status}`;
      const parentId = `crash-parent-${status}`;
      const pipeline: Pipeline = {
        name: childId,
        on: 'dispatch',
        jobs: { build: { steps: [{ id: 'work', run: 'echo child' }] } },
      };
      const child = createInitialState(
        normalizePipeline(pipeline),
        { cwd: tempDir, pipelineId: childId, runtime, executionId: childId },
        childId,
      );
      child.status =
        status === 'success' || status === 'failure' || status === 'cancelled'
          ? status
          : 'running';
      child.owner_pid = status === 'live' ? process.pid : 2_000_000_000;
      child.jobs.build.status = child.status;
      child.jobs.build.steps.work.status = child.status;
      await saveExecutionState(child, runtime.executionsDir);
      const parent = createInitialState(
        normalizePipeline(pipeline),
        { cwd: tempDir, pipelineId: parentId, runtime, executionId: parentId },
        parentId,
      );
      parent.status = 'running';
      parent.owner_pid = 2_000_000_000;
      parent.jobs.build.status = 'running';
      parent.jobs.build.steps.work.status = 'running';
      parent.jobs.build.steps.work.child_execution_id = childId;
      await saveExecutionState(parent, runtime.executionsDir);
      const errors = await recoverOrphanedPipelineExecutions(
        [parentId],
        runtime.executionsDir,
      );
      const result = await loadExecutionState(parentId, runtime.executionsDir);
      if (status === 'live') {
        expect(errors).toEqual([
          expect.stringContaining('live or unknown owner'),
        ]);
        expect(result?.status).toBe('running');
      } else if (status === 'cancelled' || status === 'failure') {
        expect(errors).toEqual([]);
        expect(result?.status).toBe(status);
        expect(result?.jobs.build.steps.work.status).toBe(status);
      } else {
        expect(errors).toEqual([]);
        expect(result?.status).toBe('paused');
        if (status === 'running')
          expect(result?.status_reasons[0]?.source).toEqual(
            expect.objectContaining({ child_execution_id: childId }),
          );
        else expect(result?.jobs.build.steps.work.status).toBe('success');
      }
    },
  );

  it('force-cancels an orphaned running execution from persisted state', async () => {
    const pipeline: Pipeline = {
      name: 'orphaned cancel',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'build', run: 'sleep 5' }],
        },
      },
    };

    const normalized = normalizePipeline(pipeline);
    const interruptedState: ExecutionState = createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'orphaned-cancel',
        runtime,
        executionId: 'orphaned-cancel-exec',
      },
      'orphaned-cancel-exec',
    );
    interruptedState.status = 'running';
    interruptedState.owner_pid = 41_424;
    interruptedState.jobs.build.status = 'paused';
    interruptedState.jobs.build.started_at = '2026-04-13T20:11:37.266Z';
    interruptedState.jobs.build.steps.build = {
      status: 'success',
      outputs: {},
      dynamic_env: {},
      started_at: '2026-04-13T20:11:37.274Z',
      completed_at: '2026-04-13T20:11:38.274Z',
      pause_requested: true,
    };
    interruptedState.pending_pauses = [
      {
        id: 'orphaned-pause',
        kind: 'action',
        job_id: 'build',
        logical_job_id: 'build',
        step_id: 'build',
        attempt: 0,
        iteration: 1,
        detected_at: '2026-04-13T20:11:38.274Z',
      },
    ];
    await saveExecutionState(interruptedState, runtime.executionsDir);

    const started: string[] = [];
    const settled: string[] = [];
    runtime.lifecycle = {
      onExecutionStart: (state): void => {
        started.push(`${state.id}:${state.status}`);
      },
      onExecutionSettled: (state): void => {
        settled.push(`${state.id}:${state.status}`);
      },
    };

    const cancelledState = await cancelPipelineExecution(
      'orphaned-cancel-exec',
      runtime,
    );
    const persistedState = await loadExecutionState(
      'orphaned-cancel-exec',
      runtime.executionsDir,
    );

    expect(cancelledState.status).toBe('cancelled');
    expect(started).toEqual(['orphaned-cancel-exec:running']);
    expect(settled).toEqual(['orphaned-cancel-exec:cancelled']);
    expect(cancelledState.jobs.build.status).toBe('cancelled');
    expect(cancelledState.job_groups.build.status).toBe('cancelled');
    expect(cancelledState.pending_pauses).toEqual([]);
    expect(cancelledState.completed_at).toBeDefined();
    expect(persistedState?.status).toBe('cancelled');
    expect(persistedState?.pending_pauses).toEqual([]);
  }, 20_000);

  it('does not report verified cancellation when a running executor never settles', async () => {
    const pipeline: Pipeline = {
      name: 'unresponsive live owner cancel',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'build', run: 'sleep 5' }],
        },
      },
    };

    const normalized = normalizePipeline(pipeline);
    const interruptedState: ExecutionState = createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'unresponsive-live-owner-cancel',
        runtime,
        executionId: 'unresponsive-live-owner-cancel-exec',
      },
      'unresponsive-live-owner-cancel-exec',
    );
    interruptedState.status = 'running';
    interruptedState.owner_pid = process.pid;
    interruptedState.jobs.build.status = 'running';
    interruptedState.jobs.build.started_at = '2026-08-20T14:21:30.074Z';
    interruptedState.jobs.build.steps.build = {
      status: 'running',
      outputs: {},
      dynamic_env: {},
      started_at: '2026-08-20T14:21:30.093Z',
    };
    await saveExecutionState(interruptedState, runtime.executionsDir);

    await expect(
      cancelPipelineExecution(interruptedState.id, runtime, {
        allowRecoveredFallback: false,
      }),
    ).rejects.toThrow('did not settle after cancellation');
    const persistedState = await loadExecutionState(
      interruptedState.id,
      runtime.executionsDir,
    );

    expect(persistedState?.status).toBe('running');
    expect(
      fs.existsSync(
        path.join(runtime.executionsDir, `${interruptedState.id}.cancel`),
      ),
    ).toBe(true);
  }, 20_000);

  it('preserves a cancellation request when a foreign resume is refused', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    try {
      const state = createInitialState(
        normalizePipeline({
          name: 'Foreign resume',
          on: 'dispatch',
          jobs: { build: { steps: [{ id: 'build', run: 'echo ok' }] } },
        }),
        { cwd: tempDir, pipelineId: 'foreign-resume', runtime },
        'foreign-resume',
      );
      state.status = 'running';
      state.owner_pid = child.pid;
      await saveExecutionState(state, runtime.executionsDir);
      const target = path.join(runtime.executionsDir, state.id + '.json');
      const marker = path.join(runtime.executionsDir, state.id + '.cancel');
      fs.writeFileSync(marker, 'cancel');
      const bytes = fs.readFileSync(target, 'utf8');
      await expect(
        resumePipeline(state.id, { cwd: tempDir, runtime }),
      ).rejects.toMatchObject({ reason: 'owned_by_other_process' });
      expect(fs.readFileSync(target, 'utf8')).toBe(bytes);
      expect(fs.readFileSync(marker, 'utf8')).toBe('cancel');
    } finally {
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill();
      await exited;
    }
  });

  it('keeps the cancellation request when another live process leaves a run pending', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    try {
      const state = createInitialState(
        normalizePipeline({
          name: 'Foreign pending cancellation',
          on: 'dispatch',
          jobs: { build: { steps: [{ id: 'build', run: 'echo ok' }] } },
        }),
        { cwd: tempDir, pipelineId: 'foreign-pending', runtime },
        'foreign-pending',
      );
      state.owner_pid = child.pid;
      await saveExecutionState(state, runtime.executionsDir);
      const target = path.join(runtime.executionsDir, state.id + '.json');
      const bytes = fs.readFileSync(target, 'utf8');
      const result = await cancelPipelineExecution(state.id, runtime);
      expect(result.status).toBe('pending');
      expect(fs.readFileSync(target, 'utf8')).toBe(bytes);
      expect(
        fs.readFileSync(
          path.join(runtime.executionsDir, state.id + '.cancel'),
          'utf8',
        ),
      ).toBe('cancel');
    } finally {
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill();
      await exited;
    }
  }, 30_000);

  it('leaves a run owned by another live process running when it does not settle after cancellation', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    try {
      const state = createInitialState(
        normalizePipeline({
          name: 'Foreign owner cancellation',
          on: 'dispatch',
          jobs: { build: { steps: [{ id: 'build', run: 'echo ok' }] } },
        }),
        { cwd: tempDir, pipelineId: 'foreign-owner', runtime },
        'foreign-owner',
      );
      state.status = 'running';
      state.owner_pid = child.pid;
      await saveExecutionState(state, runtime.executionsDir);
      const target = path.join(runtime.executionsDir, state.id + '.json');
      const bytes = fs.readFileSync(target, 'utf8');
      const result = await cancelPipelineExecution(state.id, runtime);
      expect(result.status).toBe('running');
      expect(fs.readFileSync(target, 'utf8')).toBe(bytes);
      expect(
        fs.existsSync(path.join(runtime.executionsDir, state.id + '.cancel')),
      ).toBe(true);
    } finally {
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill();
      await exited;
    }
  }, 30_000);

  it('does not treat a running execution as orphaned while its owner process is alive', async () => {
    const pipeline: Pipeline = {
      name: 'live owner cancel',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'build', run: 'sleep 5' }],
        },
      },
    };

    const normalized = normalizePipeline(pipeline);
    const runningState: ExecutionState = createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'live-owner-cancel',
        runtime,
        executionId: 'live-owner-cancel-exec',
      },
      'live-owner-cancel-exec',
    );
    runningState.status = 'running';
    runningState.owner_pid = 52_525;

    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);

    try {
      await expect(isKnownOrphanedExecution(runningState)).resolves.toBe(false);
      expect(killSpy).toHaveBeenCalledWith(52_525, 0);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('resumes true interrupted state without rerunning completed work', async () => {
    const countFile = path.join(tempDir, 'count.txt');
    fs.writeFileSync(countFile, '1\n', 'utf8');

    const pipeline: Pipeline = {
      name: 'resume',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'first',
              run: `echo "1" >> "${countFile}"\necho "GREETING=hello" >> "$CANOPY_ENV"`,
            },
            {
              id: 'second',
              run: `test "$GREETING" = hello\necho "2" >> "${countFile}"`,
            },
          ],
        },
      },
    };
    const normalized = normalizePipeline(pipeline);
    const interruptedState: ExecutionState = createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'resume',
        runtime,
        executionId: 'resume-exec',
      },
      'resume-exec',
    );
    interruptedState.status = 'running';
    interruptedState.jobs.build.status = 'running';
    interruptedState.jobs.build.steps.first = {
      status: 'success',
      conclusion: 'success',
      outcome: 'success',
      outputs: {},
      dynamic_env: { GREETING: 'hello' },
    };
    interruptedState.jobs.build.steps.second = {
      status: 'running',
      outputs: {},
      dynamic_env: {},
      started_at: new Date().toISOString(),
    };
    await saveExecutionState(interruptedState, runtime.executionsDir);

    const resumeAuthorization = {
      executionContext: 'personal',
      childPipelineAuthorizations: [
        { request: 'child', identity: 'local', contentHash: 'a'.repeat(64) },
      ],
    };
    const resumed = await resumePipeline('resume-exec', {
      cwd: tempDir,
      runtime,
      ...resumeAuthorization,
    });
    const resumedSnapshot = resumed.getState();
    const resumedState = await resumed.waitForCompletion();
    expect(resumedSnapshot.execution_context).toBe('personal');
    expect(resumedSnapshot.child_pipeline_authorizations).toEqual(
      resumeAuthorization.childPipelineAuthorizations,
    );

    expect(resumedState.status).toBe('success');
    expect(fs.readFileSync(countFile, 'utf8')).toBe('1\n2\n');
  });

  it('applies input overrides to pending work when resuming', async () => {
    const resultFile = path.join(tempDir, 'resume-inputs.txt');
    const countFile = path.join(tempDir, 'resume-input-count.txt');
    const pipeline: Pipeline = {
      name: 'resume input override',
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
              id: 'pause',
              run: [
                `echo "1" >> "${countFile}"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
            {
              id: 'after_resume',
              run: `printf '%s' "$INPUT_GREETING" > "${resultFile}"`,
            },
          ],
        },
      },
    };

    const pausedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'resume-input-override',
      runtime,
      executionId: 'resume-input-override-exec',
    });
    const pausedState = await pausedHandle.waitForCompletion();

    expect(pausedState.status).toBe('paused');
    expect(pausedState.inputs).toEqual({});
    expect(fs.readFileSync(countFile, 'utf8')).toBe('1\n');

    const resumed = await resumePipeline('resume-input-override-exec', {
      cwd: tempDir,
      runtime,
      inputs: {
        greeting: 'hello',
      },
    });
    const resumedState = await resumed.waitForCompletion();

    expect(resumedState.status).toBe('success');
    expect(resumedState.inputs).toEqual({ greeting: 'hello' });
    expect(fs.readFileSync(countFile, 'utf8')).toBe('1\n');
    expect(fs.readFileSync(resultFile, 'utf8')).toBe('hello');
  });

  it('refreshes base-branch env and removes stale managed keys when resuming', async () => {
    const branchFile = path.join(tempDir, 'resume-base-branch.txt');
    const branchMapFile = path.join(tempDir, 'resume-base-branch-map.txt');
    const pipeline: Pipeline = {
      name: 'resume base branch env',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
            {
              id: 'capture',
              run: [
                `printf '%s' "$CANOPY_BASE_BRANCH" > "${branchFile}"`,
                `printf '%s' "${'${CANOPY_BASE_BRANCH_BY_REPO:-}'}" > "${branchMapFile}"`,
              ].join('\n'),
            },
          ],
        },
      },
    };

    const pausedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'resume-base-branch-env',
      runtime,
      executionId: 'resume-base-branch-env-exec',
      env: {
        FOO: 'bar',
        CANOPY_BASE_BRANCH: 'stale-base',
        CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'false',
        CANOPY_BASE_BRANCH_BY_REPO: '{"repo":"stale-base"}',
        CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO: '{"repo":"false"}',
      },
    });
    const pausedState = await pausedHandle.waitForCompletion();

    expect(pausedState.status).toBe('paused');

    const resumedHandle = await resumePipeline('resume-base-branch-env-exec', {
      cwd: tempDir,
      runtime,
      env: {
        CANOPY_BASE_BRANCH: 'fresh-base',
        CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE: 'true',
      },
    });
    const resumedState = await resumedHandle.waitForCompletion();

    expect(resumedState.status).toBe('success');
    expect(resumedState.env.FOO).toBe('bar');
    expect(resumedState.env.CANOPY_BASE_BRANCH).toBe('fresh-base');
    expect(resumedState.env.CANOPY_BASE_BRANCH_BY_REPO).toBeUndefined();
    expect(resumedState.env.CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO).toBe(
      undefined,
    );
    expect(fs.readFileSync(branchFile, 'utf8')).toBe('fresh-base');
    expect(fs.readFileSync(branchMapFile, 'utf8')).toBe('');
  });

  it('applies plan_ready input overrides to pending work when resuming', async () => {
    const resultFile = path.join(tempDir, 'resume-plan-ready-inputs.txt');
    const countFile = path.join(tempDir, 'resume-plan-ready-count.txt');
    const pipeline: Pipeline = {
      name: 'resume plan_ready input override',
      on: {
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
          steps: [
            {
              id: 'pause',
              run: [
                `echo "1" >> "${countFile}"`,
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
            {
              id: 'after_resume',
              run: `printf '%s' "$INPUT_MAX_ITERATIONS" > "${resultFile}"`,
            },
          ],
        },
      },
    };

    const pausedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'resume-plan-ready-input-override',
      runtime,
      executionId: 'resume-plan-ready-input-override-exec',
      eventName: 'plan_ready',
      eventData: {
        plan_ready: {
          plan_text: 'Initial plan\n',
        },
      },
    });
    const pausedState = await pausedHandle.waitForCompletion();

    expect(pausedState.status).toBe('paused');
    expect(pausedState.inputs).toEqual({ max_iterations: 2 });
    expect(fs.readFileSync(countFile, 'utf8')).toBe('1\n');

    const resumed = await resumePipeline(
      'resume-plan-ready-input-override-exec',
      {
        cwd: tempDir,
        runtime,
        inputs: {
          max_iterations: '4',
        },
      },
    );
    const resumedState = await resumed.waitForCompletion();

    expect(resumedState.status).toBe('success');
    expect(resumedState.inputs).toEqual({ max_iterations: 4 });
    expect(fs.readFileSync(countFile, 'utf8')).toBe('1\n');
    expect(fs.readFileSync(resultFile, 'utf8')).toBe('4');
  });

  it('preserves persisted plan_ready inputs when resuming legacy snapshots', async () => {
    const resultFile = path.join(
      tempDir,
      'legacy-resume-plan-ready-inputs.txt',
    );
    const pipeline: Pipeline = {
      name: 'legacy resume plan_ready inputs',
      on: {
        plan_ready: {
          inputs: {
            reviewer: {
              type: 'string',
              required: true,
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
            {
              id: 'after_resume',
              run: `printf '%s' "$INPUT_REVIEWER" > "${resultFile}"`,
            },
          ],
        },
      },
    };

    const pausedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'legacy-resume-plan-ready-inputs',
      runtime,
      executionId: 'legacy-resume-plan-ready-inputs-exec',
      eventName: 'plan_ready',
      eventData: {
        plan_ready: {
          plan_text: 'Initial plan\n',
        },
      },
      inputs: {
        reviewer: 'opus',
      },
    });
    const pausedState = await pausedHandle.waitForCompletion();

    expect(pausedState.status).toBe('paused');
    expect(pausedState.inputs).toEqual({ reviewer: 'opus' });

    const legacyState: ExecutionState = {
      ...pausedState,
      pipeline_snapshot: {
        ...pausedState.pipeline_snapshot,
      },
    };
    delete legacyState.pipeline_snapshot.trigger_inputs;
    await saveExecutionState(legacyState, runtime.executionsDir);

    const resumed = await resumePipeline(
      'legacy-resume-plan-ready-inputs-exec',
      {
        cwd: tempDir,
        runtime,
      },
    );
    const resumedState = await resumed.waitForCompletion();

    expect(resumedState.status).toBe('success');
    expect(resumedState.inputs).toEqual({ reviewer: 'opus' });
    expect(fs.readFileSync(resultFile, 'utf8')).toBe('opus');
  });

  it('persists pipeline_file_dir so resumed executions can resolve nested project pipelines', async () => {
    const repoPath = path.join(tempDir, 'repo');
    const parentPipelineDir = path.join(
      repoPath,
      '.canopy',
      'pipelines',
      'workflows',
    );
    const childMarker = path.join(repoPath, 'child-ran.txt');
    fs.mkdirSync(parentPipelineDir, { recursive: true });
    fs.writeFileSync(
      path.join(parentPipelineDir, 'child.yaml'),
      [
        'name: Child Pipeline',
        'on: dispatch',
        'jobs:',
        '  child:',
        '    steps:',
        `      - id: mark`,
        `        run: echo "child" > "${childMarker}"`,
      ].join('\n'),
      'utf8',
    );

    const runtimeWithActions: ExecutionRuntime = {
      ...runtime,
      bundledActionsDir: path.resolve(
        process.cwd(),
        'packages',
        'desktop-shared',
        'resources',
        'actions',
      ),
    };
    const pipeline: Pipeline = {
      name: 'resume nested project pipeline',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
            {
              id: 'child',
              uses: 'builtin/run-pipeline',
              with: {
                pipeline: 'child',
              },
            },
          ],
        },
      },
    };

    const pausedHandle = await executePipeline(pipeline, {
      cwd: repoPath,
      pipelineId: 'resume-nested-project',
      pipelineFileDir: parentPipelineDir,
      runtime: runtimeWithActions,
      executionId: 'resume-nested-project-exec',
    });
    const pausedState = await pausedHandle.waitForCompletion();

    expect(pausedState.status).toBe('paused');
    expect(pausedState.pipeline_file_dir).toBe(parentPipelineDir);

    const resumedHandle = await resumePipeline('resume-nested-project-exec', {
      cwd: repoPath,
      runtime: runtimeWithActions,
    });
    const resumedState = await resumedHandle.waitForCompletion();

    expect(resumedState.status).toBe('success');
    expect(fs.readFileSync(childMarker, 'utf8')).toBe('child\n');
  });

  it('resumes from a persisted failed attempt by advancing to the next retry', async () => {
    const retryMarker = path.join(tempDir, 'retry-resume.txt');
    const pipeline: Pipeline = {
      name: 'resume retry',
      on: 'dispatch',
      jobs: {
        build: {
          max_retries: 1,
          steps: [
            {
              id: 'flaky',
              run: [
                `echo "$CANOPY_JOB_RETRY_COUNT" >> "${retryMarker}"`,
                'if [ "$CANOPY_JOB_RETRY_COUNT" = "0" ]; then exit 1; fi',
                'echo "status=ok" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
          ],
        },
      },
    };
    const normalized = normalizePipeline(pipeline);
    const interruptedState: ExecutionState = createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'resume-retry',
        runtime,
        executionId: 'resume-retry-exec',
      },
      'resume-retry-exec',
    );
    interruptedState.status = 'running';
    interruptedState.jobs.build.status = 'failure';
    interruptedState.jobs.build.conclusion = 'failure';
    interruptedState.jobs.build.outcome = 'failure';
    interruptedState.jobs.build.retry_count = 0;
    interruptedState.jobs.build.retry_history = [];
    interruptedState.jobs.build.steps.flaky = {
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      outputs: {},
      dynamic_env: {},
      error: 'first attempt failed',
    };
    await saveExecutionState(interruptedState, runtime.executionsDir);

    const resumed = await resumePipeline('resume-retry-exec', {
      cwd: tempDir,
      runtime,
    });
    const resumedState = await resumed.waitForCompletion();

    expect(resumedState.status).toBe('success');
    expect(resumedState.jobs.build.retry_count).toBe(1);
    expect(resumedState.jobs.build.retry_history).toHaveLength(1);
    expect(resumedState.jobs.build.retry_history?.[0]).toMatchObject({
      attempt: 0,
      conclusion: 'failure',
      outcome: 'failure',
    });
    expect(fs.readFileSync(retryMarker, 'utf8')).toBe('1\n');
  });

  it('does not continue past a persisted hard-failed step on resume', async () => {
    const shouldNotRunFile = path.join(tempDir, 'should-not-run.txt');
    const pipeline: Pipeline = {
      name: 'resume hard failure',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'first',
              run: 'exit 1',
            },
            {
              id: 'second',
              run: `echo "ran" > "${shouldNotRunFile}"`,
            },
          ],
        },
      },
    };
    const normalized = normalizePipeline(pipeline);
    const interruptedState: ExecutionState = createInitialState(
      normalized,
      {
        cwd: tempDir,
        pipelineId: 'resume-hard-failure',
        runtime,
        executionId: 'resume-hard-failure-exec',
      },
      'resume-hard-failure-exec',
    );
    interruptedState.status = 'running';
    interruptedState.jobs.build.status = 'running';
    interruptedState.jobs.build.steps.first = {
      status: 'failure',
      conclusion: 'failure',
      outcome: 'failure',
      outputs: {},
      dynamic_env: {},
      error: 'step failed',
    };
    await saveExecutionState(interruptedState, runtime.executionsDir);

    const resumed = await resumePipeline('resume-hard-failure-exec', {
      cwd: tempDir,
      runtime,
    });
    const resumedState = await resumed.waitForCompletion();

    expect(resumedState.status).toBe('failure');
    expect(resumedState.jobs.build.status).toBe('failure');
    expect(fs.existsSync(shouldNotRunFile)).toBe(false);
  });

  it('pauses after the current tier finishes and resumes from the next top-level step', async () => {
    const peerFile = path.join(tempDir, 'peer.txt');
    const downstreamFile = path.join(tempDir, 'downstream.txt');
    const pipeline: Pipeline = {
      name: 'pause and resume',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
          ],
        },
        peer: {
          steps: [
            {
              id: 'peer',
              run: `sleep 0.1\necho "peer" > "${peerFile}"`,
            },
          ],
        },
        downstream: {
          needs: ['gate', 'peer'],
          steps: [
            {
              id: 'deploy',
              run: `echo "deploy" > "${downstreamFile}"`,
            },
          ],
        },
      },
    };

    const pausedHandle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'pause-resume',
      runtime,
      executionId: 'pause-resume-exec',
    });
    const pausedState = await pausedHandle.waitForCompletion();

    expect(pausedState.status).toBe('paused');
    expectValidTimestamp(pausedState.started_at);
    expect(pausedState.completed_at).toBeUndefined();
    expectValidTimestamp(pausedState.jobs.gate.started_at);
    expect(pausedState.jobs.gate.completed_at).toBeUndefined();
    expect(pausedState.jobs.gate.status).toBe('paused');
    expect(pausedState.jobs.peer.status).toBe('success');
    expectTimestampRange(
      pausedState.jobs.peer.started_at,
      pausedState.jobs.peer.completed_at,
    );
    expect(pausedState.jobs.downstream.status).toBe('pending');
    expect(fs.readFileSync(peerFile, 'utf8')).toBe('peer\n');
    expect(fs.existsSync(downstreamFile)).toBe(false);
    expect(pausedState.jobs.gate.steps.pause.outputs).toEqual({});

    const resumedHandle = await resumePipeline('pause-resume-exec', {
      cwd: tempDir,
      runtime,
    });
    const resumedState = await resumedHandle.waitForCompletion();

    expect(resumedState.status).toBe('success');
    expect(resumedState.jobs.gate.status).toBe('success');
    expect(resumedState.jobs.downstream.status).toBe('success');
    expect(fs.readFileSync(downstreamFile, 'utf8')).toBe('deploy\n');
  });

  it('resumes a paused job while its parallel sibling is still running', async () => {
    const downstreamFile = path.join(tempDir, 'live-resume-downstream.txt');
    const partialPause = createDeferred<ExecutionState>();
    const pipeline: Pipeline = {
      name: 'live partial resume',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
          ],
        },
        peer_setup: {
          steps: [{ id: 'setup', run: 'echo ready' }],
        },
        peer: {
          needs: 'peer_setup',
          steps: [{ id: 'peer', run: 'sleep 0.5' }],
        },
        downstream: {
          needs: 'gate',
          steps: [
            {
              id: 'deploy',
              run: `echo "deploy" > "${downstreamFile}"`,
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'live-partial-resume',
      runtime,
      executionId: 'live-partial-resume-exec',
      onEvent: (event) => {
        if (
          event.state.status === 'running' &&
          event.state.status_reasons.length > 0 &&
          event.state.jobs.peer.status === 'running'
        ) {
          partialPause.resolve(event.state);
        }
      },
    });
    const partiallyPausedState = await partialPause.promise;
    expect(partiallyPausedState.jobs.gate.status).toBe('paused');
    expect(partiallyPausedState.jobs.peer.status).toBe('running');

    const reasonId = partiallyPausedState.status_reasons[0]?.id;
    if (!reasonId || !handle.resumePaused) {
      throw new Error('Expected a live paused-step recovery handle');
    }
    const resumedSnapshot = await handle.resumePaused(
      [reasonId],
      undefined,
      undefined,
      'portal-resume-live',
      { executionContext: 'personal', childPipelineAuthorizations: [] },
    );
    expect(resumedSnapshot.status).toBe('running');
    expect(resumedSnapshot.status_reasons).toEqual([]);
    expect(resumedSnapshot.portal_command_ids).toContain('portal-resume-live');

    const completedState = await handle.waitForCompletion();
    expect(completedState.status).toBe('success');
    expect(completedState.jobs.gate.status).toBe('success');
    expect(completedState.jobs.peer.status).toBe('success');
    expect(completedState.jobs.downstream.status).toBe('success');
    expect(resumedSnapshot.execution_context).toBe('personal');
    expect(resumedSnapshot.child_pipeline_authorizations).toEqual([]);
    expect(completedState.execution_context).toBe('personal');
    expect(completedState.child_pipeline_authorizations).toEqual([]);
    expect(completedState.portal_command_ids).toContain('portal-resume-live');
    expect(fs.readFileSync(downstreamFile, 'utf8')).toBe('deploy\n');
  });

  it('awaits a live resume requested as the final tier settles', async () => {
    const completedMarker = path.join(tempDir, 'late-resume-completed.txt');
    const execution: {
      handle?: Awaited<ReturnType<typeof executePipeline>>;
    } = {};
    let resumeRequest: Promise<ExecutionState> | undefined;
    const pipeline: Pipeline = {
      name: 'late live resume',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
            {
              id: 'finish',
              run: `echo "done" > "${completedMarker}"`,
            },
          ],
        },
        peer: {
          steps: [{ id: 'peer', run: 'sleep 0.3' }],
        },
      },
    };

    execution.handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'late-live-resume',
      runtime,
      executionId: 'late-live-resume-exec',
      onEvent: (event) => {
        const reasonId = event.state.status_reasons[0]?.id;
        const activeHandle = execution.handle;
        if (
          !resumeRequest &&
          reasonId &&
          activeHandle?.resumePaused &&
          event.state.jobs.peer.status === 'success'
        ) {
          resumeRequest = activeHandle.resumePaused([reasonId]);
        }
      },
    });

    const handle = execution.handle;
    const completedState = await handle.waitForCompletion();
    if (!resumeRequest) {
      throw new Error('Expected a late live-resume request');
    }
    await expect(resumeRequest).resolves.toBeDefined();
    expect(completedState.status).toBe('success');
    expect(completedState.jobs.gate.status).toBe('success');
    expect(fs.readFileSync(completedMarker, 'utf8')).toBe('done\n');
  });

  it('starts a new recovery run when a resumed job pauses again', async () => {
    const completedMarker = path.join(tempDir, 'repeated-resume-done.txt');
    const pausedStates: ExecutionState[] = [];
    const pauseWaiters: Array<(state: ExecutionState) => void> = [];
    const seenReasonIds = new Set<string>();
    const waitForNextPause = (): Promise<ExecutionState> => {
      const existing = pausedStates.shift();
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => pauseWaiters.push(resolve));
    };
    const pipeline: Pipeline = {
      name: 'repeated live resume',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'pause_one',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
            {
              id: 'pause_two',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
            {
              id: 'finish',
              run: `echo "done" > "${completedMarker}"`,
            },
          ],
        },
        peer: {
          steps: [{ id: 'peer', run: 'sleep 1' }],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'repeated-live-resume',
      runtime,
      executionId: 'repeated-live-resume-exec',
      onEvent: (event) => {
        const reasonId = event.state.status_reasons[0]?.id;
        if (!reasonId || seenReasonIds.has(reasonId)) return;
        seenReasonIds.add(reasonId);
        const waiter = pauseWaiters.shift();
        if (waiter) {
          waiter(event.state);
        } else {
          pausedStates.push(event.state);
        }
      },
    });

    const firstPause = await waitForNextPause();
    const firstReasonId = firstPause.status_reasons[0]?.id;
    if (!firstReasonId || !handle.resumePaused) {
      throw new Error('Expected the first live pause');
    }
    await handle.resumePaused([firstReasonId]);

    const secondPause = await waitForNextPause();
    const secondReasonId = secondPause.status_reasons[0]?.id;
    if (!secondReasonId || !handle.resumePaused) {
      throw new Error('Expected the second live pause');
    }
    await handle.resumePaused([secondReasonId]);

    const completedState = await handle.waitForCompletion();
    expect(completedState.status).toBe('success');
    expect(completedState.jobs.gate.status).toBe('success');
    expect(fs.readFileSync(completedMarker, 'utf8')).toBe('done\n');
  }, 10_000);

  it('waits for a live resumed job to settle before cancellation finalizes', async () => {
    const paused = createDeferred<ExecutionState>();
    const recoveryStarted = createDeferred<void>();
    let sawRecoveryCancellationUpdate = false;
    const pipeline: Pipeline = {
      name: 'cancel live resume',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
            { id: 'recover', run: 'sleep 5' },
          ],
        },
        peer: {
          steps: [{ id: 'peer', run: 'sleep 5' }],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'cancel-live-resume',
      runtime,
      executionId: 'cancel-live-resume-exec',
      onEvent: (event) => {
        if (event.state.status_reasons.length > 0) {
          paused.resolve(event.state);
        }
        const recovery = event.state.jobs.gate.steps.recover;
        if (recovery.status === 'running') {
          recoveryStarted.resolve();
        }
        if (
          event.type === 'execution.updated' &&
          recovery.status === 'cancelled'
        ) {
          sawRecoveryCancellationUpdate = true;
        }
      },
    });

    const pausedState = await paused.promise;
    const reasonId = pausedState.status_reasons[0]?.id;
    if (!reasonId || !handle.resumePaused) {
      throw new Error('Expected a live paused-step recovery handle');
    }
    await handle.resumePaused([reasonId]);
    await recoveryStarted.promise;

    const cancelledState = await handle.cancel();
    expect(cancelledState.status).toBe('cancelled');
    expect(cancelledState.jobs.gate.steps.recover.status).toBe('cancelled');
    expect(sawRecoveryCancellationUpdate).toBe(true);
  }, 10_000);

  it('rejects resuming a cancelled execution', async () => {
    const pipeline: Pipeline = {
      name: 'cancel-resume',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'step', run: 'sleep 5' }],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'cancel-resume',
      runtime,
      executionId: 'cancel-resume-exec',
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    await cancelPipelineExecution('cancel-resume-exec', runtime);
    await handle.waitForCompletion();

    await expect(
      resumePipeline('cancel-resume-exec', {
        cwd: tempDir,
        runtime,
      }),
    ).rejects.toThrow('cannot be resumed because it is cancelled');
  });

  it('cleans preserved temp artifacts when a paused execution is cancelled', async () => {
    const pipeline: Pipeline = {
      name: 'cancel-paused-temp',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'pause',
              run: [
                'touch "$(dirname "$CANOPY_OUTPUT")/pre-pause.txt"',
                'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
              ].join('\n'),
            },
          ],
        },
      },
    };
    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'cancel-paused-temp',
      runtime,
      executionId: 'cancel-paused-temp-exec',
    });
    const pausedState = await handle.waitForCompletion();
    const executionTempDir = path.join(runtime.tempRootDir, pausedState.id);

    expect(pausedState.status).toBe('paused');
    expect(fs.existsSync(executionTempDir)).toBe(true);

    const cancelledState = await cancelPipelineExecution(
      pausedState.id,
      runtime,
    );

    expect(cancelledState.status).toBe('cancelled');
    await waitForPathToDisappear(executionTempDir);
  });

  it('reports pause when a same-tier job fails while another has an active blocker', async () => {
    const pipeline: Pipeline = {
      name: 'pause-and-fail',
      on: 'dispatch',
      jobs: {
        gate: {
          steps: [
            {
              id: 'pause',
              run: 'echo "CANOPY_PAUSE=true" >> "$CANOPY_OUTPUT"',
            },
          ],
        },
        broken: {
          steps: [
            {
              id: 'fail',
              run: 'exit 1',
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'pause-and-fail',
      runtime,
      executionId: 'pause-and-fail-exec',
    });
    const state = await handle.waitForCompletion();

    expect(state.status).toBe('paused');
  });
});

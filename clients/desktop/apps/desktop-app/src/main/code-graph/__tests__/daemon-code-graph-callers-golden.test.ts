/**
 * CAN-5625 migration seam: Electron main's agent build tool and scheduler
 * builds through their real clients, the real dispatcher and adapters, over
 * an injected daemon connection. Real daemon hosts are covered by
 * code-graph-conformance.
 */
const mockGet = jest.fn<Promise<{ client: unknown }>, [unknown, unknown]>();
jest.mock('../../canopy-runtime/electron-daemon-access', () => ({
  getElectronDaemonConnections: (): unknown => ({
    get: (caller: unknown, signal: unknown) => mockGet(caller, signal),
  }),
  getElectronDaemonFilesContext: (): Promise<unknown> =>
    Promise.resolve({ authorityId: 'local' }),
}));
jest.mock('../../canopy-runtime/electron-daemon-health', () => ({
  getElectronDaemonHealth: (): unknown => ({
    setConsumerEnabled: (): void => undefined,
    isLatched: (): boolean => mockLatched(),
    noteFallback: (): void => undefined,
  }),
}));
const mockPlatform = jest.fn<string, []>(() => 'darwin');
const mockLatched = jest.fn(() => false);
jest.mock('@canopy/core-platform', () => ({
  hostPlatformOperatingSystem: (): string => mockPlatform(),
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: (): void => undefined,
}));
jest.mock('../../lib/code-graph-feature-flag', () => ({
  isCodeGraphFeatureEnabled: (): boolean => true,
}));
// The scheduler and agent clients read the active runtime; the test's is the
// real dispatcher over the real adapter and a real initiated-work engine.
let mockRuntime: unknown = null;
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntimeIfAccepting: (): unknown => mockRuntime,
}));

// The scheduler's host reads: a worktree whose fingerprint changed.
const mockE2e = jest.fn(() => false);
jest.mock('../../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockE2e(),
}));
jest.mock('../../lib/workspace-registry', () => ({
  isCoworkWorkspace: (): boolean => false,
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (): string => '/worktree',
}));
jest.mock('../../lib/worktree-repo-entries', () => ({
  resolveWorktreeCodeGraphRepositories: (): Promise<unknown[]> =>
    Promise.resolve([]),
}));
jest.mock('../fingerprint-runner', () => ({
  runCodeGraphWorkerFingerprint: (): Promise<unknown> =>
    Promise.resolve({ ok: true, fingerprint: 'fp-new' }),
  cancelCodeGraphFingerprint: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../lib/code-graph-worktree-fingerprint', () => ({
  readPersistedCodeGraphWorktreeFingerprintSnapshot: (): Promise<unknown> =>
    Promise.resolve({
      fingerprint: 'fp-old',
      completed: true,
      readFailed: false,
      cacheHit: false,
      derivedPending: false,
      schemaVersion: null,
      extractorVersion: null,
      durationMs: 1,
    }),
  clearCodeGraphWorktreeFingerprintCache: (): void => undefined,
}));
jest.mock('../build-runner', () => ({
  cancelBuild: (): Promise<void> => Promise.resolve(),
  isCodeGraphBuildPending: (): boolean => false,
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanopyDispatcher } from '@canopy/core-runtime';
import { CanopyClientError } from '@canopy/core-client';
import { codeGraphUnavailableError } from '@canopy/core-runtime/node/code-graph';
import {
  WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
  WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_WRITE_INSTRUCTION_DEFINITIONS,
  type WorkerCodeGraphBuildParams,
  type WorkerCodeGraphBuildResult,
  type WorkerCodeGraphLanguagesValidateResult,
  type WorkerCodeGraphStatusGetResult,
} from '@canopy/protocol/canopy-core';
import {
  createWorkerCodeGraphAdapter,
  type DesktopCodeGraphBuildQueue,
} from '../../canopy-runtime/worker-code-graph-adapter';
import { markUnreachable } from '../../canopy-runtime/electron-daemon-connection';
import { setCodeGraphPreferences } from '../../lib/code-graph-availability';
import { createTestInitiatedWork } from '../../__tests__/helpers/initiated-work-runtime';
import { buildWorktreeCodeGraphForAgent } from '../graph-builds';
import {
  startScheduledCodeGraphBuild,
  type ScheduledCodeGraphBuild,
} from '../scheduled-builds';
import {
  DAEMON_AGENT_CODE_GRAPH_READ_PLATFORMS,
  drainDaemonCodeGraphWorktree,
} from '../daemon-code-graph-route';
import { scheduleCodeGraphBuild } from '../../lib/code-graph-scheduler';
import { PLAN_EXPLORE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import * as routeTelemetry from '../../canopy-runtime/daemon-route-telemetry';
import { createWorkerCodeGraphReadAdapter } from '../../canopy-runtime/worker-code-graph-read-adapter';
import {
  readWorktreeCodeGraphStatus,
  setCodeGraphReadDispatcherForTests,
  validateWorktreeCodeGraphLanguages,
} from '../graph-reads';

const LOCAL_RESULT: WorkerCodeGraphBuildResult = {
  kind: 'worktree',
  filesScanned: 1,
  filesParsed: 1,
  filesUnchanged: 0,
  filesSkipped: 0,
  filesRemoved: 0,
  parseFailures: 0,
  symbolCount: 1,
  edgeCount: 0,
  durationMs: 1,
  lastBuildAt: null,
  derivedPending: false,
  customLanguageDiagnostics: null,
  derivedWarnings: null,
};
const DAEMON_RESULT: WorkerCodeGraphBuildResult = {
  ...LOCAL_RESULT,
  filesParsed: 7,
  symbolCount: 9,
};

const localBuild = jest.fn<
  Promise<WorkerCodeGraphBuildResult>,
  [WorkerCodeGraphBuildParams['graphScope']]
>(() => Promise.resolve(LOCAL_RESULT));
/** Any non-empty idempotency key. */
const ANY_KEY: unknown = expect.stringMatching(/.+/);

interface DaemonCall {
  name: string;
  params: unknown;
  idempotencyKey: unknown;
}

/** The daemon session: records each instruction and answers with `answer`. */
function daemon(
  answer: (name: string) => Promise<unknown> = (name) =>
    Promise.resolve(
      name === 'worker.codeGraph.build' ? DAEMON_RESULT : { canceled: 0 },
    ),
): DaemonCall[] {
  const calls: DaemonCall[] = [];
  mockGet.mockResolvedValue({
    client: {
      signal: new AbortController().signal,
      instruction: (
        name: string,
        params: unknown,
        options: { metadata?: { idempotencyKey?: unknown } },
      ): Promise<unknown> => {
        calls.push({
          name,
          params,
          idempotencyKey: options.metadata?.idempotencyKey,
        });
        return answer(name);
      },
    },
  });
  return calls;
}

function refusal(code: `worker.${string}.${string}`): CanopyClientError {
  return new CanopyClientError({
    kind: 'failed_precondition',
    code,
    message: code,
    retry: { kind: 'never' },
  });
}

function scheduled(
  overrides: Partial<ScheduledCodeGraphBuild> = {},
): ScheduledCodeGraphBuild {
  return {
    projectId: 'project',
    worktreeId: 'task',
    trigger: 'refresh',
    refreshSource: 'diff-stats',
    observedFingerprint: 'fp-1',
    observedFingerprintMs: 12,
    available: () => true,
    canceled: () => false,
    ...overrides,
  };
}

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-callers-'));
  mockGet.mockReset();
  mockPlatform.mockReturnValue('darwin');
  mockLatched.mockReturnValue(false);
  mockE2e.mockReturnValue(false);
  delete process.env.CANOPY_PERFORMANCE_CODE_GRAPH_SCHEDULER;
  localBuild.mockClear();
  setCodeGraphPreferences({
    mode: 'enabled',
    selectedWorkspaceIds: [],
    generationTimeoutMinutes: 30,
  });
  const builds = createWorkerCodeGraphAdapter(
    (): Promise<DesktopCodeGraphBuildQueue> =>
      Promise.resolve({
        build: localBuild,
        queueStatus: () => ({ revision: 0, entries: [] }),
        reorderQueue: () => ({ revision: 0, entries: [] }),
        cancelQueueItem: () => Promise.resolve(null),
        cancelWorktree: () => Promise.resolve(0),
      }),
  );
  const dispatcher = createCanopyDispatcher({
    profile: 'worker',
    definitions: {
      queries: WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
      instructions: WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: builds.queries,
      instructions: builds.instructions,
      streams: {},
    },
  });
  mockRuntime = {
    state: 'accepting',
    instruction: dispatcher.instruction.bind(dispatcher),
    initiatedWork: createTestInitiatedWork(dir).engine,
  };
});

afterEach(() => {
  mockRuntime = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('agent and scheduler builds on the daemon route (CAN-5625)', () => {
  it('routes an agent tool build to the daemon', async () => {
    const calls = daemon();
    await expect(
      buildWorktreeCodeGraphForAgent({
        projectId: 'project',
        worktreeId: 'task',
      }),
    ).resolves.toEqual(DAEMON_RESULT);
    expect(calls).toEqual([
      {
        name: 'worker.codeGraph.build',
        params: {
          graphScope: {
            kind: 'worktree',
            workspaceId: 'project',
            worktreeId: 'task',
            mode: 'verified',
            requestedBy: 'agent',
          },
        },
        idempotencyKey: ANY_KEY,
      },
    ]);
    expect(localBuild).not.toHaveBeenCalled();
  });

  it('keeps a reached refusal for an agent build', async () => {
    daemon(() =>
      Promise.reject(refusal('worker.codeGraph.graphScopeNotFound')),
    );
    await expect(
      buildWorktreeCodeGraphForAgent({
        projectId: 'project',
        worktreeId: 'task',
      }),
    ).rejects.toMatchObject({
      name: 'CanopyOperationError',
      payload: { code: 'worker.codeGraph.graphScopeNotFound' },
    });
    expect(localBuild).not.toHaveBeenCalled();
  });

  it('routes a scheduled background build to the daemon with its fingerprint', async () => {
    const calls = daemon();
    await expect(startScheduledCodeGraphBuild(scheduled())).resolves.toBe(
      'succeeded',
    );
    expect(calls).toEqual([
      {
        name: 'worker.codeGraph.build',
        params: {
          graphScope: {
            kind: 'worktree',
            workspaceId: 'project',
            worktreeId: 'task',
            mode: 'incremental',
            background: {
              trigger: 'refresh',
              observedFingerprint: { value: 'fp-1', observedMs: 12 },
            },
          },
        },
        idempotencyKey: ANY_KEY,
      },
    ]);
    expect(localBuild).not.toHaveBeenCalled();
  });

  it('records a scheduled build the daemon refused as the in-process build would', async () => {
    daemon(() => Promise.reject(refusal('worker.codeGraph.buildTimedOut')));
    await expect(startScheduledCodeGraphBuild(scheduled())).resolves.toBe(
      'timedOut',
    );
    daemon(() => Promise.reject(refusal('worker.codeGraph.unavailable')));
    await expect(startScheduledCodeGraphBuild(scheduled())).resolves.toBe(
      'stopped',
    );
    expect(localBuild).not.toHaveBeenCalled();
  });

  it('keeps performance builds in process', async () => {
    const calls = daemon();
    await expect(
      startScheduledCodeGraphBuild(scheduled({ placement: 'in-process' })),
    ).resolves.toBe('succeeded');
    expect(calls).toEqual([]);
    expect(localBuild).toHaveBeenCalledTimes(1);
  });

  it('falls back in process for each caller when the daemon is unreachable', async () => {
    mockGet.mockRejectedValue(
      markUnreachable(new Error('down'), 'start_failed'),
    );
    await expect(
      buildWorktreeCodeGraphForAgent({
        projectId: 'project',
        worktreeId: 'task',
      }),
    ).resolves.toEqual(LOCAL_RESULT);
    await expect(startScheduledCodeGraphBuild(scheduled())).resolves.toBe(
      'succeeded',
    );
    expect(localBuild).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'on an unsupported host',
      (): void => void mockPlatform.mockReturnValue('freebsd'),
    ],
    ['when latched', (): void => void mockLatched.mockReturnValue(true)],
    [
      'when Code Graph is unavailable',
      (): void =>
        setCodeGraphPreferences({
          mode: 'disabled',
          selectedWorkspaceIds: [],
          generationTimeoutMinutes: 30,
        }),
    ],
  ])('stays in process %s', async (name, arrange) => {
    const calls = daemon();
    arrange();
    const unavailable = name === 'when Code Graph is unavailable';
    if (unavailable) {
      localBuild.mockRejectedValueOnce(codeGraphUnavailableError());
      await expect(
        buildWorktreeCodeGraphForAgent({
          projectId: 'project',
          worktreeId: 'task',
        }),
      ).rejects.toMatchObject({
        payload: { code: 'worker.codeGraph.unavailable' },
      });
      await expect(
        startScheduledCodeGraphBuild(scheduled({ available: () => false })),
      ).resolves.toBe('skipped');
      expect(localBuild).toHaveBeenCalledTimes(1);
    } else {
      await expect(
        buildWorktreeCodeGraphForAgent({
          projectId: 'project',
          worktreeId: 'task',
        }),
      ).resolves.toEqual(LOCAL_RESULT);
      await expect(startScheduledCodeGraphBuild(scheduled())).resolves.toBe(
        'succeeded',
      );
      expect(localBuild).toHaveBeenCalledTimes(2);
    }
    expect(calls).toEqual([]);
  });

  it.each(['plan-explore-chat', 'code-review-chat'])(
    'keeps a %s scope build in process, which the daemon cannot resolve',
    async (projectId) => {
      const calls = daemon();
      await expect(
        buildWorktreeCodeGraphForAgent({ projectId, worktreeId: 'scope' }),
      ).resolves.toEqual(LOCAL_RESULT);
      await expect(
        startScheduledCodeGraphBuild(
          scheduled({ projectId, worktreeId: 'scope' }),
        ),
      ).resolves.toBe('succeeded');
      expect(calls).toEqual([]);
      expect(localBuild).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['an ordinary run', false, 1, 0],
    ['a performance run', true, 0, 1],
  ] as const)(
    'places a timer-driven scheduler build for %s',
    async (_run, performance, daemonBuilds, localBuilds) => {
      const calls = daemon();
      mockE2e.mockReturnValue(performance);
      if (performance)
        process.env.CANOPY_PERFORMANCE_CODE_GRAPH_SCHEDULER = '1';
      scheduleCodeGraphBuild({
        projectId: 'project',
        worktreeId: `timer-${String(performance)}`,
        reason: 'worktree-created',
        debounceMs: 0,
      });
      for (
        let attempt = 0;
        attempt < 200 && calls.length + localBuild.mock.calls.length === 0;
        attempt += 1
      )
        await new Promise((settle) => setTimeout(settle, 10));
      expect(
        calls.filter((call) => call.name === 'worker.codeGraph.build'),
      ).toHaveLength(daemonBuilds);
      expect(localBuild).toHaveBeenCalledTimes(localBuilds);
    },
  );

  it('remembers a daemon-routed scheduler build for cleanup', async () => {
    const calls = daemon();
    await startScheduledCodeGraphBuild(scheduled({ worktreeId: 'remembered' }));
    mockPlatform.mockReturnValue('freebsd');
    await drainDaemonCodeGraphWorktree('project', 'remembered');
    expect(calls.map((call) => call.name)).toEqual([
      'worker.codeGraph.build',
      'worker.codeGraph.builds.cancel',
    ]);
    expect(calls[1]?.params).toEqual({
      workspaceId: 'project',
      worktreeId: 'remembered',
    });
  });
});

describe('agent status reads and steering language checks on the daemon route (CAN-5093)', () => {
  const LOCAL_STATUS: WorkerCodeGraphStatusGetResult = {
    presence: 'absent',
    buildState: 'idle',
  };
  const DAEMON_STATUS: WorkerCodeGraphStatusGetResult = {
    presence: 'present',
    buildState: 'running',
  };
  const LOCAL_LANGUAGES: WorkerCodeGraphLanguagesValidateResult = {
    config: 'absent',
    languages: [],
    diagnostics: [],
  };
  const DAEMON_LANGUAGES: WorkerCodeGraphLanguagesValidateResult = {
    config: 'present',
    languages: [{ id: 'lua', extensions: ['.lua'] }],
    diagnostics: [],
  };
  const localStatus = jest.fn(() =>
    Promise.resolve({ ok: true as const, value: LOCAL_STATUS }),
  );
  const localLanguages = jest.fn(() =>
    Promise.resolve({ ok: true as const, value: LOCAL_LANGUAGES }),
  );
  const SCOPE = { projectId: 'project', worktreeId: 'task' };
  const WIRE_SCOPE = { scope: { workspaceId: 'project', worktreeId: 'task' } };

  /** The daemon session's reads: records each query and answers it. */
  function daemonReads(
    answer: (name: string) => Promise<unknown> = (name) =>
      Promise.resolve(
        name === 'worker.codeGraph.status.get'
          ? DAEMON_STATUS
          : DAEMON_LANGUAGES,
      ),
  ): { name: string; params: unknown }[] {
    const calls: { name: string; params: unknown }[] = [];
    mockGet.mockResolvedValue({
      client: {
        signal: new AbortController().signal,
        query: (name: string, params: unknown): Promise<unknown> => {
          calls.push({ name, params });
          return answer(name);
        },
      },
    });
    return calls;
  }

  beforeEach(() => {
    localStatus.mockClear();
    localLanguages.mockClear();
    const reads = createWorkerCodeGraphReadAdapter(() =>
      Promise.resolve({
        status: localStatus,
        query: () => Promise.reject(new Error('Unexpected query')),
        exportSnapshot: () => Promise.reject(new Error('Unexpected snapshot')),
        importSnapshot: () => Promise.reject(new Error('Unexpected import')),
        validateLanguages: localLanguages,
      }),
    );
    setCodeGraphReadDispatcherForTests(
      createCanopyDispatcher({
        profile: 'worker',
        definitions: {
          queries: WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
          instructions: WORKER_CODE_GRAPH_WRITE_INSTRUCTION_DEFINITIONS,
          streams: {},
        },
        handlers: {
          queries: reads.queries,
          instructions: reads.instructions,
          streams: {},
        },
      }),
    );
  });

  afterEach(() => {
    setCodeGraphReadDispatcherForTests(null);
  });

  it.each(['darwin', 'linux'])(
    'reads an agent status and a steering language check from the daemon on %s',
    async (platform) => {
      mockPlatform.mockReturnValue(platform);
      const calls = daemonReads();
      await expect(readWorktreeCodeGraphStatus(SCOPE)).resolves.toEqual(
        DAEMON_STATUS,
      );
      await expect(validateWorktreeCodeGraphLanguages(SCOPE)).resolves.toEqual(
        DAEMON_LANGUAGES,
      );
      expect(calls).toEqual([
        { name: 'worker.codeGraph.status.get', params: WIRE_SCOPE },
        { name: 'worker.codeGraph.languages.validate', params: WIRE_SCOPE },
      ]);
      expect(localStatus).not.toHaveBeenCalled();
      expect(localLanguages).not.toHaveBeenCalled();
    },
  );

  it('reads in process when the daemon cannot be reached', async () => {
    mockGet.mockRejectedValue(
      markUnreachable(new Error('down'), 'start_failed'),
    );
    await expect(readWorktreeCodeGraphStatus(SCOPE)).resolves.toEqual(
      LOCAL_STATUS,
    );
    await expect(validateWorktreeCodeGraphLanguages(SCOPE)).resolves.toEqual(
      LOCAL_LANGUAGES,
    );
    expect(localStatus).toHaveBeenCalledTimes(1);
    expect(localLanguages).toHaveBeenCalledTimes(1);
  });

  it('keeps a reached refusal as the answer', async () => {
    daemonReads(() =>
      Promise.reject(refusal('worker.codeGraph.graphScopeNotFound')),
    );
    await expect(readWorktreeCodeGraphStatus(SCOPE)).rejects.toBeDefined();
    await expect(
      validateWorktreeCodeGraphLanguages(SCOPE),
    ).rejects.toBeDefined();
    expect(localStatus).not.toHaveBeenCalled();
    expect(localLanguages).not.toHaveBeenCalled();
  });

  it('routes only on the hosts its census constant selects: macOS and Linux', () => {
    expect(DAEMON_AGENT_CODE_GRAPH_READ_PLATFORMS).toEqual({
      darwin: true,
      linux: true,
      win32: false,
    });
  });

  describe('where each read ran', () => {
    let recorded: jest.SpyInstance;

    beforeEach(() => {
      resetWorkCounters();
      recorded = jest
        .spyOn(routeTelemetry, 'recordDaemonRoute')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      recorded.mockRestore();
    });

    /** Both reads' route counters, the ones a perf sample's `work.route` carries. */
    function readRoutes(): Record<string, number> {
      return Object.fromEntries(
        Object.entries(snapshotWorkCounters().route).filter(([key]) =>
          key.startsWith('codeGraph.'),
        ),
      );
    }

    async function readBoth(): Promise<void> {
      await readWorktreeCodeGraphStatus(SCOPE);
      await validateWorktreeCodeGraphLanguages(SCOPE);
    }

    it.each(['darwin', 'linux'])(
      'records both reads as served by the daemon on %s',
      async (platform) => {
        mockPlatform.mockReturnValue(platform);
        daemonReads();
        await readBoth();
        expect(readRoutes()).toEqual({
          'codeGraph.status.daemon.served': 1,
          'codeGraph.languages.daemon.served': 1,
        });
        expect(recorded.mock.calls).toEqual([
          ['code_graph', 'served'],
          ['code_graph', 'served'],
        ]);
      },
    );

    it('records both reads as in process on Windows', async () => {
      mockPlatform.mockReturnValue('win32');
      const calls = daemonReads();
      await readBoth();
      expect(calls).toEqual([]);
      expect(readRoutes()).toEqual({
        'codeGraph.status.in_process.platform': 1,
        'codeGraph.languages.in_process.platform': 1,
      });
      expect(recorded.mock.calls).toEqual([
        ['code_graph', 'platform'],
        ['code_graph', 'platform'],
      ]);
    });

    it('records the in-process fallback when the daemon cannot be reached', async () => {
      mockGet.mockRejectedValue(
        markUnreachable(new Error('down'), 'start_failed'),
      );
      await readBoth();
      expect(readRoutes()).toEqual({
        'codeGraph.status.daemon.fallback': 1,
        'codeGraph.languages.daemon.fallback': 1,
      });
      expect(recorded.mock.calls).toEqual([
        ['code_graph', 'unreachable'],
        ['code_graph', 'unreachable'],
      ]);
    });
  });

  it.each([
    [
      'a latched daemon',
      (): void => {
        mockLatched.mockReturnValue(true);
      },
      SCOPE,
    ],
    [
      'a plan-explore placeholder workspace',
      (): void => undefined,
      { projectId: PLAN_EXPLORE_CHAT_PROJECT_ID, worktreeId: 'task' },
    ],
    [
      'an ineligible platform',
      (): void => {
        mockPlatform.mockReturnValue('freebsd');
      },
      SCOPE,
    ],
    [
      'Windows',
      (): void => {
        mockPlatform.mockReturnValue('win32');
      },
      SCOPE,
    ],
  ])('stays in process for %s', async (_case, arrange, scope) => {
    arrange();
    const calls = daemonReads();
    await expect(readWorktreeCodeGraphStatus(scope)).resolves.toEqual(
      LOCAL_STATUS,
    );
    await expect(validateWorktreeCodeGraphLanguages(scope)).resolves.toEqual(
      LOCAL_LANGUAGES,
    );
    expect(calls).toEqual([]);
  });
});

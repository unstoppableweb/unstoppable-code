// CAN-4165 golden: the tracked plan lifecycle as desktop serves it, captured
// before core.plan took ownership. It drives the real `tracked-plans:*` IPC
// handlers, which since PR 3b-2 dispatch `core.plan.*` on a real desktop
// dispatcher and plan persistence on a temporary data root; only IPC
// registration and window sends are replaced. A change here is a behaviour
// change: re-record deliberately with
// `pnpm test <this file> -u` and review the snapshot diff.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdir, rename, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  type TrackedPlanData,
  type TrackedPlansUpdatedEvent,
} from '@canopy/desktop-shared/types';
import {
  detectedPlanScanParams,
  detectedPlanUpdateParams,
  trackedPlanCreateParams,
  trackedPlanImportParams,
  trackedPlanUpdateParams,
} from '@canopy/desktop-shared/lib/tracked-plan-params';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import type {
  CanopyCallerDescriptor,
  WorkerPipelineHostRequest,
} from '@canopy/protocol/canopy-core';
import type { ExecutionPlanPersistenceHooks } from '@canopy/execution-engine/node/pipelines/executor/types';
import type * as PlanPersistence from '../lib/plan-persistence';
import type * as OwnerRequests from '../pipelines/pipeline-owner-requests';
import type * as ExecutionRuntime from '../pipelines/execution-runtime';
import type * as PlanMode from '../agents/plan-mode-tracked-plan';
import type * as PlanExit from '../services/chat-state-plan-exit';
import type * as InterfacePort from '../agents/agent-interface-port';
import type * as HostWriters from '../canopy-runtime/plan-host-writers';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { controllerMayInvoke } from '../remote-control/host/controller-profile';
import { relayAllows } from '../canopy-runtime/renderer-relay/surface-allowlist';
import { RENDERER_RELAY_GRANTS } from '../ipc/canopy-core-relay';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { createInterimInMemoryBindingProvider } from '../canopy-runtime/renderer-relay/interim-in-memory-binding';
import {
  createRendererRelay,
  type RendererRelayEvent,
} from '../canopy-runtime/renderer-relay/relay';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type * as MainProcessLogging from '../lib/main-process-logging';

// A loaded machine runs the restart case's fresh module graph slowly.
jest.setTimeout(60_000);

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
// Pass-through, so one case can fail a save partway (CAN-4165 PR 7c).
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    rename: jest.fn(actual.rename),
    writeFile: jest.fn(actual.writeFile),
  };
});
const windowSends: { channel: string; payload: unknown }[] = [];
jest.mock('../lib/main-process-logging', () => ({
  ...jest.requireActual<typeof MainProcessLogging>(
    '../lib/main-process-logging',
  ),
  logMainProcessWarn: jest.fn(),
}));
const broadcasts: { channel: string; payload: unknown }[] = [];
/** Every push to a window, in the order sent. */
const pushes: { channel: string; payload: unknown }[] = [];
jest.mock('../lib/window-send', () => ({
  sendToWindow: (_window: unknown, channel: string, payload: unknown): void => {
    windowSends.push({ channel, payload });
    pushes.push({ channel, payload });
  },
  sendToAllWindows: (channel: string, payload: unknown): void => {
    broadcasts.push({ channel, payload });
    pushes.push({ channel, payload });
  },
}));

// The proposal-mode writer reads its chat through chat state; one plan-mode
// tab stands in for it.
const mockProposalTabs: Record<string, unknown>[] = [];
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): unknown => ({
    getState: (): Promise<unknown> =>
      Promise.resolve({ tabsFile: { tabs: mockProposalTabs } }),
    getCompatibilityTabs: (): Promise<unknown> =>
      Promise.resolve({ tabs: mockProposalTabs }),
    retirePlanReview: (): Promise<boolean> => Promise.resolve(true),
    commitPlanExit: (): Promise<boolean> => Promise.resolve(true),
  }),
}));

function isPlansUpdatedEvent(
  value: unknown,
): value is TrackedPlansUpdatedEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'change' in value &&
    'projectId' in value &&
    'worktreeId' in value
  );
}

const WORKSPACE_ID = 'golden-plans';
const COWORK_ID = 'golden-cowork';
const WORKTREE_ID = 'golden-wt';

let root: string;
let dataDir: string;
let worktreePath: string;
// One persistence module for every case, captured before any restart case
// loads an isolated copy.
let persistence: typeof PlanPersistence;
let dispatcher: DesktopCanopyDispatcher;
// The dispatcher's calls since the case began, without their spies' types.
let dispatcherCalls: { calls(): unknown[][]; clear(): void };
// Every state root this run could reach, so it never writes outside its temp root.
const STATE_DIR_VARS = [
  'CANOPY_DATA_DIR',
  'CANOPY_SECURE_DATA_DIR',
  'CANOPY_OUTPUT_DIR',
] as const;
const originalStateDirs = STATE_DIR_VARS.map(
  (name) => [name, process.env[name]] as const,
);

const RENDERER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'desktop-local',
  interfaceKind: 'desktop',
  grants: [],
};
// The caller the IPC handlers resolve for the next call: the renderer, or a
// paired controller's bridge.
let ipcCaller: CanopyCallerDescriptor = RENDERER;

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-lifecycle-golden-')));
  dataDir = join(root, 'data');
  process.env.CANOPY_DATA_DIR = dataDir;
  process.env.CANOPY_SECURE_DATA_DIR = join(root, 'secure');
  process.env.CANOPY_OUTPUT_DIR = join(root, 'output');
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  worktreePath = join(
    dataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktrees',
    WORKTREE_ID,
  );
  mkdirSync(worktreePath, { recursive: true });
  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: 'Plans',
        type: 'single-repo',
        color: '#38BDF8',
        collapsed: false,
        order: 0,
      },
      {
        id: COWORK_ID,
        name: 'Cowork',
        type: 'cowork',
        color: '#38BDF8',
        collapsed: false,
        order: 1,
      },
    ],
  });
  writeJson(join(dataDir, 'workspaces', WORKSPACE_ID, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath: repo,
    repos: [],
  });
  writeJson(join(dataDir, 'workspaces', WORKSPACE_ID, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: WORKTREE_ID,
        branchName: 'golden',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  });
  // Production fills the registry from the sidebar's index read; the
  // handlers' cowork and single-repo branches read only the registry.
  const registry = await import('../lib/workspace-registry');
  registry.registerWorkspaceTypes(
    new Map([
      [WORKSPACE_ID, 'single-repo'],
      [COWORK_ID, 'cowork'],
    ]),
  );
  expect(registry.isCoworkWorkspace(COWORK_ID)).toBe(true);
  expect(registry.getWorkspaceType(WORKSPACE_ID)).toBe('single-repo');
  const { createDesktopRuntime } =
    await import('../canopy-runtime/desktop-runtime');
  dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
  const querySpy = jest.spyOn(dispatcher, 'query');
  const instructionSpy = jest.spyOn(dispatcher, 'instruction');
  dispatcherCalls = {
    calls: (): unknown[][] =>
      [...querySpy.mock.calls, ...instructionSpy.mock.calls].map(
        (call): unknown[] => [...call],
      ),
    clear: (): void => {
      querySpy.mockClear();
      instructionSpy.mockClear();
    },
  };
  const { registerPlansHandlers } = await import('../ipc/plans');
  registerPlansHandlers(
    () => null,
    dispatcher,
    () => ipcCaller,
  );
  const { registerDetectedPlansHandlers } =
    await import('../ipc/detected-plans');
  registerDetectedPlansHandlers(
    () => null,
    dispatcher,
    () => ipcCaller,
  );
  persistence = await import('../lib/plan-persistence');
});

afterAll(async () => {
  await dispatcher.shutdown();
  for (const [name, value] of originalStateDirs)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  windowSends.length = 0;
  broadcasts.length = 0;
  dispatcherCalls.clear();
  ipcCaller = RENDERER;
});

/** The core.plan operations dispatched since the case began, with their callers. */
function dispatched(): { name: string; caller: unknown }[] {
  return dispatcherCalls
    .calls()
    .map((call) => {
      const [name, , options] = call;
      const caller =
        options && typeof options === 'object' && 'caller' in options
          ? options.caller
          : undefined;
      return { name: String(name), caller };
    })
    .filter(({ name }) => name.startsWith('core.plan.'));
}

function invoke<T>(channel: string, request: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return Promise.resolve(handler({ sender: { id: 1 } }, request)) as Promise<T>;
}

const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };

// Ids and clock values differ per run; the snapshot keeps their shape, and
// ids keep their relations through numbered placeholders.
function stable(value: unknown): unknown {
  const ids = new Map<string, string>();
  const id = (raw: string): string => {
    const placeholder = ids.get(raw) ?? `<id ${ids.size + 1}>`;
    ids.set(raw, placeholder);
    return placeholder;
  };
  // One placeholder for every time: writes inside one millisecond would
  // otherwise number differently from run to run. Order is asserted directly.
  const TIME = '<time>';
  const walk = (node: unknown, key?: string): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item));
    if (node && typeof node === 'object')
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) => [k, walk(v, k)]),
      );
    if (typeof node !== 'string') return node;
    if (/^\d{4}-\d{2}-\d{2}T/.test(node)) return TIME;
    if (
      key &&
      /(^id$|Id$)/.test(key) &&
      ![WORKSPACE_ID, WORKTREE_ID, COWORK_ID].includes(node) &&
      // Sentinels such as __workspace_root__ are behaviour, not ids.
      !/^__\w+__$/.test(node)
    )
      return id(node);
    // A path under the temporary root reads the same on every platform;
    // other strings (plan content) are left as they are.
    return node.includes(root)
      ? node.split(root).join('<root>').replaceAll('\\', '/')
      : node;
  };
  return walk(value);
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('expected a value');
  return value;
}

const plansFile = (): string =>
  join(dataDir, 'workspaces', WORKSPACE_ID, 'plans', `${WORKTREE_ID}.json`);

describe('tracked plan lifecycle (CAN-4165 golden)', () => {
  let planId: string;

  it('creates, reads, lists, updates and deletes through IPC', async () => {
    const created = await invoke<TrackedPlanData>(
      IPC_CHANNELS.trackedPlansCreate,
      {
        ...scope,
        source: 'claude',
        content: '# Ship the golden\n\nFirst draft.',
      },
    );
    planId = created.id;
    const got = await invoke<TrackedPlanData | null>(
      IPC_CHANNELS.trackedPlansGet,
      { ...scope, planId },
    );
    const listed = await invoke<TrackedPlanData[]>(
      IPC_CHANNELS.trackedPlansList,
      scope,
    );
    const updated = await invoke<TrackedPlanData | null>(
      IPC_CHANNELS.trackedPlansUpdate,
      {
        ...scope,
        planId,
        content: '# Ship the golden\n\nSecond draft.',
      },
    );
    const retitled = await invoke<TrackedPlanData | null>(
      IPC_CHANNELS.trackedPlansUpdate,
      {
        ...scope,
        planId,
        title: 'Renamed',
      },
    );
    expect(got).toEqual(created);
    expect(listed.map((plan) => plan.id)).toEqual([planId]);
    expect(must(updated).latestRevisionNumber).toBe(
      created.latestRevisionNumber + 1,
    );
    expect(Date.parse(must(updated).updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(created.updatedAt),
    );
    expect(
      stable({ created, updated, retitled, windowSends }),
    ).toMatchSnapshot();
    expect(
      stable(JSON.parse(readFileSync(plansFile(), 'utf8'))),
    ).toMatchSnapshot('plans file on disk');
  });

  it('keeps plan identity and order across a restart', async () => {
    const second = await invoke<TrackedPlanData>(
      IPC_CHANNELS.trackedPlansCreate,
      {
        ...scope,
        source: 'claude',
        content: '# Second plan',
      },
    );
    const before = await invoke<TrackedPlanData[]>(
      IPC_CHANNELS.trackedPlansList,
      scope,
    );
    let after: TrackedPlanData[] = [];
    await jest.isolateModulesAsync(async () => {
      const isolated = await import('../lib/plan-persistence');
      after = await isolated.listTrackedPlans(WORKSPACE_ID, WORKTREE_ID);
    });
    expect(after.map((plan) => plan.id)).toEqual(before.map((plan) => plan.id));
    expect(after).toEqual(before);
    expect(before.map((plan) => plan.id)).toContain(second.id);
  });

  it('sends no renderer event for a direct persistence write', async () => {
    await persistence.createTrackedPlan({
      ...scope,
      source: 'claude',
      content: '# Agent plan\n\nWritten by ExitPlanMode.',
    });
    expect(windowSends).toEqual([]);
  });

  it('imports a plan file from the worktree, without deduplication', async () => {
    writeFileSync(
      join(worktreePath, 'PLAN.md'),
      '# Imported plan\n\nFrom a file.',
    );
    const first = await invoke<{
      plan: TrackedPlanData | null;
      trackedPlanFilePath: string;
    }>(IPC_CHANNELS.trackedPlansImport, {
      ...scope,
      filePath: 'PLAN.md',
      repoId: WORKSPACE_ID,
    });
    const second = await invoke<{ plan: TrackedPlanData | null }>(
      IPC_CHANNELS.trackedPlansImport,
      {
        ...scope,
        filePath: 'PLAN.md',
        repoId: WORKSPACE_ID,
      },
    );
    expect(must(first.plan).id).not.toBe(must(second.plan).id);
    expect(
      stable({ first, windowSends: windowSends.map((s) => s.channel) }),
    ).toMatchSnapshot();
    await expect(
      invoke(IPC_CHANNELS.trackedPlansImport, {
        ...scope,
        filePath: '../outside.md',
        repoId: WORKSPACE_ID,
      }),
    ).rejects.toThrow('Plan import path must stay inside the worktree.');
    await expect(
      invoke(IPC_CHANNELS.trackedPlansImport, {
        ...scope,
        filePath: 'PLAN.md',
      }),
    ).rejects.toThrow();
  });

  it('refuses writes in a shared-container recipient scope', async () => {
    const viewer = {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: WORKTREE_ID,
    };
    for (const [channel, request] of [
      [
        IPC_CHANNELS.trackedPlansCreate,
        { ...viewer, source: 'claude', content: 'x' },
      ],
      [IPC_CHANNELS.trackedPlansUpdate, { ...viewer, planId, content: 'x' }],
      [IPC_CHANNELS.trackedPlansDelete, { ...viewer, planId }],
    ] as const)
      await expect(invoke(channel, request)).rejects.toThrow(
        'Shared-container recipient workspaces are read-only',
      );
  });

  it('lists no plans for a cowork workspace', async () => {
    await expect(
      invoke(IPC_CHANNELS.trackedPlansList, {
        projectId: COWORK_ID,
        worktreeId: WORKTREE_ID,
      }),
    ).resolves.toEqual([]);
  });

  it('records what a stale concurrent update does today', async () => {
    const [a, b] = await Promise.all([
      invoke<TrackedPlanData | null>(IPC_CHANNELS.trackedPlansUpdate, {
        ...scope,
        planId,
        content: 'Edit A',
      }),
      invoke<TrackedPlanData | null>(IPC_CHANNELS.trackedPlansUpdate, {
        ...scope,
        planId,
        content: 'Edit B',
      }),
    ]);
    const final = await invoke<TrackedPlanData | null>(
      IPC_CHANNELS.trackedPlansGet,
      { ...scope, planId },
    );
    // Both writes land as revisions under the file lock; the later one wins.
    expect(must(final).content).toBe(must(b).content);
    expect(must(b).latestRevisionNumber).toBe(must(a).latestRevisionNumber + 1);
  });

  it("removes a worktree's plans and reinstalls them on restore", async () => {
    const before = await persistence.listTrackedPlans(
      WORKSPACE_ID,
      WORKTREE_ID,
    );
    const archived = JSON.parse(readFileSync(plansFile(), 'utf8')) as {
      plans: TrackedPlanData[];
    };
    await persistence.deleteTrackedPlansForWorktree(WORKSPACE_ID, WORKTREE_ID);
    expect(
      await persistence.listTrackedPlans(WORKSPACE_ID, WORKTREE_ID),
    ).toEqual([]);
    await persistence.installRestoredTrackedPlans(
      WORKSPACE_ID,
      WORKTREE_ID,
      archived.plans,
    );
    expect(
      (await persistence.listTrackedPlans(WORKSPACE_ID, WORKTREE_ID)).map(
        (p) => p.id,
      ),
    ).toEqual(before.map((p) => p.id));
  });

  // CAN-4165 PR 4b-2 pins what the worktree lifecycle writers announce, as
  // they always have: removing a worktree's plans announces nothing, and
  // installing restored plans fires one tracked-plans write and nothing else.
  // Install has always replaced the destination file without reading it, so
  // it also replaces a file that can't be read.
  it("clears a worktree's plans silently and installs restored plans with one write event", async () => {
    const other = { projectId: WORKSPACE_ID, worktreeId: 'golden-wt-restore' };
    const file = join(
      dataDir,
      'workspaces',
      WORKSPACE_ID,
      'plans',
      `${other.worktreeId}.json`,
    );
    await invoke(IPC_CHANNELS.trackedPlansCreate, {
      ...other,
      source: 'claude',
      content: '# Before the split',
    });
    const archived = JSON.parse(readFileSync(plansFile(), 'utf8')) as {
      plans: TrackedPlanData[];
    };
    const { getExecutionObservabilityIngest } =
      await import('../observability/ingest');
    const usage = jest
      .spyOn(getExecutionObservabilityIngest(), 'recordUsageMetricEvent')
      .mockImplementation(() => undefined);
    const writes: { projectId: string; worktreeId: string; file: unknown }[] =
      [];
    const onWrite = (
      projectId: string,
      worktreeId: string,
      written: unknown,
    ): void => {
      writes.push({ projectId, worktreeId, file: written });
    };
    const contentChanges: unknown[] = [];
    const onContent = (plan: TrackedPlanData): void => {
      contentChanges.push(plan.id);
    };
    const shareChanges: unknown[] = [];
    const onShare = (plan: TrackedPlanData): void => {
      shareChanges.push(plan.id);
    };
    persistence.addTrackedPlansWriteListener(onWrite);
    persistence.addPlanContentChangeListener(onContent);
    persistence.addPlanShareChangeListener(onShare);
    windowSends.length = 0;
    broadcasts.length = 0;
    try {
      await persistence.deleteTrackedPlansForWorktree(
        other.projectId,
        other.worktreeId,
      );
      expect(() => readFileSync(file, 'utf8')).toThrow();
      expect(writes).toEqual([]);

      await persistence.installRestoredTrackedPlans(
        other.projectId,
        other.worktreeId,
        [],
      );
      expect(() => readFileSync(file, 'utf8')).toThrow();
      expect(writes).toEqual([]);

      await persistence.installRestoredTrackedPlans(
        other.projectId,
        other.worktreeId,
        archived.plans,
      );
      const installed = archived.plans.map((plan) => ({
        ...plan,
        projectId: other.projectId,
        worktreeId: other.worktreeId,
      }));
      expect(readFileSync(file, 'utf8')).toBe(
        JSON.stringify({ version: 1, plans: installed }, null, 2),
      );
      expect(writes).toEqual([
        { ...other, file: { version: 1, plans: installed } },
      ]);

      const damaged = '{"version":1,"plans":[{"id":"cut-off';
      writeFileSync(file, damaged);
      await persistence.installRestoredTrackedPlans(
        other.projectId,
        other.worktreeId,
        archived.plans,
      );
      expect(readFileSync(file, 'utf8')).toBe(
        JSON.stringify({ version: 1, plans: installed }, null, 2),
      );
      expect(writes).toHaveLength(2);

      expect(usage).not.toHaveBeenCalled();
      expect(contentChanges).toEqual([]);
      expect(shareChanges).toEqual([]);
      expect(windowSends).toEqual([]);
      expect(broadcasts).toEqual([]);
    } finally {
      persistence.removeTrackedPlansWriteListener(onWrite);
      persistence.removePlanContentChangeListener(onContent);
      persistence.removePlanShareChangeListener(onShare);
      usage.mockRestore();
    }
  });

  // Changed on purpose in CAN-4165 PR 3b. Desktop used to store a plan with
  // a source its reader rejects, and the reader then treated the whole
  // worktree's plans file as empty. The core.plan engine refuses the write.
  it("refuses a plan with an unknown source and keeps the worktree's plans", async () => {
    const other = {
      projectId: WORKSPACE_ID,
      worktreeId: 'golden-wt-unknown-source',
    };
    await invoke(IPC_CHANNELS.trackedPlansCreate, {
      ...other,
      source: 'claude',
      content: '# Kept',
    });
    await expect(
      invoke(IPC_CHANNELS.trackedPlansCreate, {
        ...other,
        source: 'manual',
        content: '# Unknown source',
      }),
    ).rejects.toThrow('Unknown plan source: manual');
    const plans = await invoke<TrackedPlanData[]>(
      IPC_CHANNELS.trackedPlansList,
      other,
    );
    expect(plans.map((plan) => plan.content)).toEqual(['# Kept']);
  });

  // Changed on purpose in CAN-4165 PR 3b. A write over a plans file that
  // could not be read used to replace it with only the new plan, losing the
  // others for good. Reads still show nothing; writes now leave it alone.
  it('refuses to write over an unreadable plans file and leaves it as it is', async () => {
    const other = { projectId: WORKSPACE_ID, worktreeId: 'golden-wt-damaged' };
    const file = join(
      dataDir,
      'workspaces',
      WORKSPACE_ID,
      'plans',
      `${other.worktreeId}.json`,
    );
    mkdirSync(join(file, '..'), { recursive: true });
    const damaged = '{"version":1,"plans":[{"id":"cut-off';
    writeFileSync(file, damaged);
    await expect(
      invoke(IPC_CHANNELS.trackedPlansCreate, {
        ...other,
        source: 'claude',
        content: '# New',
      }),
    ).rejects.toThrow(
      "This worktree's plans could not be read, so they were left unchanged.",
    );
    expect(readFileSync(file, 'utf8')).toBe(damaged);
    await expect(invoke(IPC_CHANNELS.trackedPlansList, other)).resolves.toEqual(
      [],
    );
  });

  // CAN-6666: one record the reader rejects used to hide every plan in its
  // worktree. Reads now skip and report it; writes still refuse the file.
  it('lists the readable plans beside a malformed record, tells the person, and still refuses writes (CAN-6666)', async () => {
    const other = {
      projectId: WORKSPACE_ID,
      worktreeId: 'golden-wt-malformed-record',
    };
    await invoke(IPC_CHANNELS.trackedPlansCreate, {
      ...other,
      source: 'claude',
      content: '# Readable',
    });
    const file = join(
      dataDir,
      'workspaces',
      WORKSPACE_ID,
      'plans',
      `${other.worktreeId}.json`,
    );
    const state = JSON.parse(readFileSync(file, 'utf8')) as {
      plans: unknown[];
    };
    state.plans.push({ id: 'plan-malformed', source: 'claude' });
    writeJson(file, state);
    const written = readFileSync(file, 'utf8');
    jest.mocked(logMainProcessWarn).mockClear();

    const plans = await invoke<TrackedPlanData[]>(
      IPC_CHANNELS.trackedPlansList,
      other,
    );
    expect(plans.map((plan) => plan.content)).toEqual(['# Readable']);
    expect(jest.mocked(logMainProcessWarn)).toHaveBeenCalledWith(
      expect.stringContaining('skipped 1 unreadable plan record'),
      expect.objectContaining({ worktreeId: other.worktreeId, skipped: 1 }),
    );
    // The Plans view's read carries the count, so the person is told.
    await expect(
      invoke(IPC_CHANNELS.trackedPlansListWithSkipped, other),
    ).resolves.toEqual({
      plans: [expect.objectContaining({ content: '# Readable' })],
      skipped: 1,
    });
    await expect(
      invoke(IPC_CHANNELS.trackedPlansListWithSkipped, scope),
    ).resolves.not.toHaveProperty('skipped');
    await expect(
      invoke(IPC_CHANNELS.trackedPlansCreate, {
        ...other,
        source: 'claude',
        content: '# New',
      }),
    ).rejects.toThrow(
      "This worktree's plans could not be read, so they were left unchanged.",
    );
    expect(readFileSync(file, 'utf8')).toBe(written);
  });

  // A Copilot plan used to hide every plan in its worktree from reads: the
  // reader did not know the `copilot` source the writers use.
  it('lists a Copilot plan beside the others', async () => {
    const other = {
      projectId: WORKSPACE_ID,
      worktreeId: 'golden-wt-copilot',
    };
    for (const source of ['claude', 'copilot'] as const)
      await invoke(IPC_CHANNELS.trackedPlansCreate, {
        ...other,
        source,
        content: `# From ${source}`,
      });
    const plans = await invoke<TrackedPlanData[]>(
      IPC_CHANNELS.trackedPlansList,
      other,
    );
    expect(plans.map((plan) => plan.source).sort()).toEqual([
      'claude',
      'copilot',
    ]);
  });

  // An Antigravity (Google) plan could not be saved: core.plan refused the
  // `antigravity` source its chats write with.
  it('creates an Antigravity plan and reads it back', async () => {
    const other = {
      projectId: WORKSPACE_ID,
      worktreeId: 'golden-wt-antigravity',
    };
    const created = await invoke<TrackedPlanData>(
      IPC_CHANNELS.trackedPlansCreate,
      { ...other, source: 'antigravity', content: '# From antigravity' },
    );
    expect(created.source).toBe('antigravity');
    const plans = await invoke<TrackedPlanData[]>(
      IPC_CHANNELS.trackedPlansList,
      other,
    );
    expect(plans.map((plan) => [plan.id, plan.source])).toEqual([
      [created.id, 'antigravity'],
    ]);
  });

  it('detects plan files once, then updates and lists them', async () => {
    const request = {
      ...scope,
      chatId: 'golden-chat',
      // Built-in rules: `**/plan.md` and `docs/superpowers/specs/*.md`,
      // minus `*-design.md`. Uppercase PLAN.md is not a plan file.
      candidatePaths: [
        'plan.md',
        'docs/superpowers/specs/rollout.md',
        'docs/superpowers/specs/rollout-design.md',
        'PLAN.md',
        'src/index.ts',
        '../escape/plan.md',
      ],
    };
    const first = await invoke<{
      entries: unknown[];
      newlyDetected: { id: string }[];
    }>(IPC_CHANNELS.detectedPlansScan, request);
    const again = await invoke<{ newlyDetected: unknown[] }>(
      IPC_CHANNELS.detectedPlansScan,
      request,
    );
    expect(first.newlyDetected.length).toBeGreaterThan(0);
    expect(again.newlyDetected).toEqual([]);
    const detectedSends = windowSends.filter(
      (s) => s.channel === IPC_CHANNELS.detectedPlansUpdated,
    ).length;
    const updated = first.newlyDetected.length
      ? await invoke(IPC_CHANNELS.detectedPlansUpdate, {
          ...scope,
          entryId: first.newlyDetected[0].id,
          status: 'dismissed',
        })
      : [];
    const listed = await invoke(IPC_CHANNELS.detectedPlansList, scope);
    const cowork = await invoke(IPC_CHANNELS.detectedPlansList, {
      projectId: COWORK_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(
      stable({ first, updated, listed, cowork, detectedSends }),
    ).toMatchSnapshot();
  });

  it('deletes through IPC', async () => {
    await invoke(IPC_CHANNELS.trackedPlansDelete, { ...scope, planId });
    await expect(
      invoke(IPC_CHANNELS.trackedPlansGet, { ...scope, planId }),
    ).resolves.toBeNull();
  });
});

// CAN-4165 PR 3b-2: the tracked-plans channels dispatch core.plan.* on the
// desktop dispatcher. These cases pin what the move keeps and what it adds.
describe('tracked plans on core.plan (CAN-4165 equivalence)', () => {
  const other = { projectId: WORKSPACE_ID, worktreeId: 'golden-wt-dispatch' };
  // The main window's relay over the desktop dispatcher, as the window gets it.
  function mainWindowRelay(): {
    event: RendererRelayEvent;
    relay: ReturnType<typeof createRendererRelay>;
  } {
    const frame = {
      url: 'canopy://app',
      detached: false,
      isDestroyed: (): boolean => false,
    };
    const event: RendererRelayEvent = {
      sender: {
        id: 9,
        mainFrame: frame,
        getURL: (): string => frame.url,
        isDestroyed: (): boolean => false,
        on: () => undefined,
        removeListener: () => undefined,
      },
      senderFrame: frame,
    };
    const relay = createRendererRelay({
      bindingProvider: createInterimInMemoryBindingProvider(dispatcher),
      resolveSurface: () => ({
        surface: 'main',
        caller: {
          principalId: 'local-desktop-renderer:main',
          clientInstanceId: 'electron-web-contents:9',
          authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
          interfaceKind: 'desktop',
          grants: [...RENDERER_RELAY_GRANTS],
        },
      }),
    });
    return { event, relay };
  }
  const writer = (
    key: string,
  ): {
    caller: CanopyCallerDescriptor;
    metadata: { idempotencyKey: string };
  } => ({
    caller: { ...RENDERER, grants: ['core.plan.write'] },
    metadata: { idempotencyKey: key },
  });

  it('serves each lifecycle channel through core.plan with only the grant it needs', async () => {
    const created = await invoke<TrackedPlanData>(
      IPC_CHANNELS.trackedPlansCreate,
      { ...other, source: 'claude', content: '# One' },
    );
    await invoke(IPC_CHANNELS.trackedPlansGet, {
      ...other,
      planId: created.id,
    });
    await invoke(IPC_CHANNELS.trackedPlansList, other);
    await invoke(IPC_CHANNELS.trackedPlansListWithSkipped, other);
    await invoke(IPC_CHANNELS.trackedPlansUpdate, {
      ...other,
      planId: created.id,
      content: '# Two',
    });
    await invoke(IPC_CHANNELS.trackedPlansDelete, {
      ...other,
      planId: created.id,
    });
    expect(
      dispatched()
        .map(({ name, caller }) => ({ name, caller }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual(
      [
        ['core.plan.create', 'core.plan.write'],
        ['core.plan.delete', 'core.plan.write'],
        ['core.plan.get', 'core.plan.read'],
        ['core.plan.list', 'core.plan.read'],
        ['core.plan.list', 'core.plan.read'],
        ['core.plan.update', 'core.plan.write'],
      ].map(([name, grant]) => ({
        name,
        caller: { ...RENDERER, grants: [grant] },
      })),
    );
    // The renderer that asked applies each answer itself, as before.
    expect(broadcasts).toEqual([]);
  });

  it("dispatches a paired controller's calls as its own device, which keeps every lifecycle channel", async () => {
    ipcCaller = {
      principalId: 'remote-device:golden-device',
      clientInstanceId: 'remote-bridge:7',
      authorityId: 'desktop-local',
      interfaceKind: 'desktop',
      grants: ['core.workspace.read', 'core.chat.write'],
    };
    const created = await invoke<TrackedPlanData>(
      IPC_CHANNELS.trackedPlansCreate,
      { ...other, source: 'claude', content: '# Remote' },
    );
    const updated = await invoke<TrackedPlanData | null>(
      IPC_CHANNELS.trackedPlansUpdate,
      { ...other, planId: created.id, content: '# Remote, edited' },
    );
    const listed = await invoke<TrackedPlanData[]>(
      IPC_CHANNELS.trackedPlansList,
      other,
    );
    await invoke(IPC_CHANNELS.trackedPlansDelete, {
      ...other,
      planId: created.id,
    });
    expect(must(updated).content).toBe('# Remote, edited');
    expect(listed.map((plan) => plan.id)).toContain(created.id);
    await expect(
      invoke(IPC_CHANNELS.trackedPlansGet, { ...other, planId: created.id }),
    ).resolves.toBeNull();
    const callers = dispatched().map(({ caller }) => caller);
    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers)
      expect(caller).toEqual(
        expect.objectContaining({
          principalId: 'remote-device:golden-device',
          clientInstanceId: 'remote-bridge:7',
        }),
      );
  });

  it('announces a write from another binding to every window', async () => {
    const created = await invoke<TrackedPlanData>(
      IPC_CHANNELS.trackedPlansCreate,
      { ...other, source: 'claude', content: '# Before relay' },
    );
    expect(broadcasts).toEqual([]);
    await dispatcher.instruction(
      'core.plan.update',
      { scope: other, planId: created.id, content: '# From the relay' },
      writer('relay-update-1'),
    );
    await dispatcher.instruction(
      'core.plan.delete',
      { scope: other, planId: created.id },
      writer('relay-delete-1'),
    );
    expect(broadcasts.map(({ channel }) => channel)).toEqual([
      IPC_CHANNELS.trackedPlansUpdated,
      IPC_CHANNELS.trackedPlansUpdated,
    ]);
    expect(stable(broadcasts)).toMatchSnapshot();
  });

  it('replays a keyed write once and refuses its key with other parameters', async () => {
    const created = await invoke<TrackedPlanData>(
      IPC_CHANNELS.trackedPlansCreate,
      { ...other, source: 'claude', content: '# Keyed' },
    );
    const params = { scope: other, planId: created.id, content: '# Keyed, v2' };
    const first = await dispatcher.instruction(
      'core.plan.update',
      params,
      writer('keyed-1'),
    );
    const repeat = await dispatcher.instruction(
      'core.plan.update',
      params,
      writer('keyed-1'),
    );
    expect(repeat).toEqual(first);
    const stored = await invoke<TrackedPlanData | null>(
      IPC_CHANNELS.trackedPlansGet,
      { ...other, planId: created.id },
    );
    expect(must(stored).latestRevisionNumber).toBe(
      created.latestRevisionNumber + 1,
    );
    await expect(
      dispatcher.instruction(
        'core.plan.update',
        { ...params, content: '# Keyed, other' },
        writer('keyed-1'),
      ),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
  });

  it('refuses a stale expected revision', async () => {
    const created = await invoke<TrackedPlanData>(
      IPC_CHANNELS.trackedPlansCreate,
      { ...other, source: 'claude', content: '# Revisioned' },
    );
    await expect(
      dispatcher.instruction(
        'core.plan.update',
        {
          scope: other,
          planId: created.id,
          expectedRevision: created.latestRevisionNumber + 1,
          content: '# Stale',
        },
        writer('stale-1'),
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'core.plan.revisionConflict',
        details: { currentRevision: created.latestRevisionNumber },
      },
    });
  });

  it('serves only plan reads to a read-only relay, and nothing to App Advisor', () => {
    const lifecycle = {
      // The main window's reads (CAN-4165 PR 7a) include the detected list.
      query: ['core.plan.list', 'core.plan.get', 'core.plan.detected.list'],
      instruction: ['core.plan.create', 'core.plan.update', 'core.plan.delete'],
    } as const;
    for (const method of lifecycle.query) {
      expect(relayAllows('main', 'query', method, 'authority')).toBe(true);
      expect(relayAllows('main', 'query', method, 'read-only')).toBe(true);
      expect(relayAllows('app-advisor', 'query', method)).toBe(false);
    }
    for (const method of lifecycle.instruction) {
      expect(relayAllows('main', 'instruction', method, 'authority')).toBe(
        true,
      );
      expect(relayAllows('main', 'instruction', method, 'read-only')).toBe(
        false,
      );
      expect(relayAllows('app-advisor', 'instruction', method)).toBe(false);
    }
  });

  // The main window reads plans through the local relay (CAN-4165 PR 7a), whose
  // replies are capped; the channels are not. Its plan client re-reads such a
  // scope over the channel, so this pins the refusal it keys on.
  it('refuses a plan list or plan over the relay cap for its size, which the channels still answer', async () => {
    const big = { projectId: WORKSPACE_ID, worktreeId: 'golden-wt-big' };
    // A plan stores its body twice (content and first revision): over 1 MiB.
    const created = await invoke<TrackedPlanData>(
      IPC_CHANNELS.trackedPlansCreate,
      { ...big, source: 'claude', content: `# Big\n\n${'x'.repeat(600_000)}` },
    );
    const { event, relay } = mainWindowRelay();
    const sizeRefusal = {
      ok: false,
      error: {
        kind: 'resource_exhausted',
        retry: { kind: 'after_refresh', resource: 'reply' },
      },
    };
    try {
      await expect(
        relay.invoke(event, {
          kind: 'request',
          method: 'core.plan.list',
          params: { scope: big },
        }),
      ).resolves.toMatchObject(sizeRefusal);
      await expect(
        relay.invoke(event, {
          kind: 'request',
          method: 'core.plan.get',
          params: { scope: big, planId: created.id },
        }),
      ).resolves.toMatchObject(sizeRefusal);
    } finally {
      relay.dispose();
    }
    const listed = await invoke<{ plans: TrackedPlanData[] }>(
      IPC_CHANNELS.trackedPlansListWithSkipped,
      big,
    );
    expect(listed.plans.map(({ id }) => id)).toEqual([created.id]);
  });

  // The main window writes plans through the relay (CAN-4165 PR 7b): keyed, so
  // a lost reply replays, and announced to every window, the writer included,
  // because no IPC projection wraps the write.
  // The renderer builds its relay params with the shared builders, and the
  // relay refuses a param it cannot carry as JSON, such as an undefined value.
  it('takes the params the renderer builds for a create, update and import through the relay', async () => {
    const built = { projectId: WORKSPACE_ID, worktreeId: 'golden-wt-built' };
    const { resolveWorktreeCwd } = await import('../lib/resolve-worktree');
    const builtRoot = resolveWorktreeCwd(built.projectId, built.worktreeId);
    mkdirSync(builtRoot, { recursive: true });
    writeFileSync(join(builtRoot, 'BUILT.md'), '# Built import');
    const { event, relay } = mainWindowRelay();
    // Cloned as IPC delivers it: a structured clone keeps undefined values.
    const write = (
      method: string,
      params: Record<string, unknown>,
      key: string,
    ): Promise<unknown> =>
      relay.invoke(
        event,
        structuredClone({
          kind: 'request' as const,
          method,
          params: { ...params, _meta: { idempotencyKey: key } },
        }),
      );
    try {
      const created = await write(
        'core.plan.create',
        trackedPlanCreateParams(built, {
          ...built,
          id: 'built-plan',
          source: 'claude',
          content: '# Built',
        }),
        'built-c-1',
      );
      expect(created).toMatchObject({ ok: true, value: { plan: built } });
      await expect(
        write(
          'core.plan.update',
          trackedPlanUpdateParams(built, {
            ...built,
            planId: 'built-plan',
            hidden: true,
            approvedAt: null,
          }),
          'built-u-1',
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { plan: { id: 'built-plan', hidden: true } },
      });
      await expect(
        write(
          'core.plan.import',
          trackedPlanImportParams(built, {
            ...built,
            filePath: 'BUILT.md',
            repoId: WORKSPACE_ROOT_REPO_ID,
          }),
          'built-i-1',
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { plan: { sourceFilePath: 'BUILT.md' } },
      });
    } finally {
      relay.dispose();
    }
  });

  // The main window's detected-plan writes go through the relay too (CAN-4165
  // PR 7c), with params from the shared builders, so the publisher announces
  // each stored change to every window.
  it('takes the detected-plan params the renderer builds through the relay, keyed and announced once each to every window', async () => {
    const scope = {
      projectId: WORKSPACE_ID,
      worktreeId: 'golden-wt-relay-detected',
    };
    const { event, relay } = mainWindowRelay();
    // Cloned as IPC delivers it: a structured clone keeps undefined values.
    const write = (
      method: string,
      params: Record<string, unknown>,
      key: string,
    ): Promise<unknown> =>
      relay.invoke(
        event,
        structuredClone({
          kind: 'request' as const,
          method,
          params: { ...params, _meta: { idempotencyKey: key } },
        }),
      );
    try {
      const scan = detectedPlanScanParams(scope, {
        ...scope,
        chatId: 'golden-chat-7c',
        candidatePaths: ['plan.md', '', 'x'.repeat(4_097)],
      });
      const scanned = (await write(
        'core.plan.detected.scan',
        scan,
        'relay-ds-1',
      )) as { value: { detected: { id: string }[] } };
      expect(scanned).toMatchObject({
        ok: true,
        value: { newlyDetected: [{ sourceFilePath: 'plan.md' }] },
      });
      // A lost reply re-sent under its key answers the first outcome.
      await expect(
        write('core.plan.detected.scan', scan, 'relay-ds-1'),
      ).resolves.toEqual(scanned);
      // A scan that stores nothing new announces nothing.
      await expect(
        write('core.plan.detected.scan', scan, 'relay-ds-2'),
      ).resolves.toMatchObject({ ok: true, value: { newlyDetected: [] } });
      const entryId = must(scanned.value.detected[0]).id;
      const updated = (await write(
        'core.plan.detected.update',
        detectedPlanUpdateParams(scope, {
          ...scope,
          entryId,
          status: undefined,
          bannerSeen: true,
          importedPlanId: undefined,
        }),
        'relay-du-1',
      )) as { value: { detected: unknown[] } };
      expect(updated).toMatchObject({
        ok: true,
        value: {
          detected: [{ id: entryId, status: 'detected', bannerSeen: true }],
        },
      });
      // A recipient scope stays read-only on this path too.
      const viewer = {
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: WORKTREE_ID,
      };
      await expect(
        write(
          'core.plan.detected.update',
          detectedPlanUpdateParams(viewer, {
            ...viewer,
            entryId,
            bannerSeen: true,
          }),
          'relay-du-2',
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { kind: 'permission_denied' },
      });
      expect(broadcasts).toEqual([
        {
          channel: IPC_CHANNELS.detectedPlansUpdated,
          payload: { ...scope, entries: scanned.value.detected },
        },
        {
          channel: IPC_CHANNELS.detectedPlansUpdated,
          payload: { ...scope, entries: updated.value.detected },
        },
      ]);
      expect(windowSends).toEqual([]);
    } finally {
      relay.dispose();
    }
  });

  // A scan over the relay's 1 MiB request cap is refused before dispatch, so
  // nothing is stored or announced, and the plan client scans it over the
  // channel instead (CAN-4165 PR 7c, R2).
  it('refuses a scan over the request cap before dispatch, storing and announcing nothing', async () => {
    const scope = {
      projectId: WORKSPACE_ID,
      worktreeId: 'golden-wt-relay-oversize',
    };
    const { event, relay } = mainWindowRelay();
    try {
      const candidatePaths = [
        'plan.md',
        ...Array.from(
          { length: 1_550 },
          (_, index) => `docs/${'p'.repeat(720)}-${index}.md`,
        ),
      ];
      await expect(
        relay.invoke(event, {
          kind: 'request',
          method: 'core.plan.detected.scan',
          params: {
            ...detectedPlanScanParams(scope, {
              ...scope,
              chatId: 'golden-chat-7c',
              candidatePaths,
            }),
            _meta: { idempotencyKey: 'relay-oversize-1' },
          },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          kind: 'resource_exhausted',
          retry: { kind: 'after_refresh', resource: 'request' },
        },
      });
      expect(dispatched()).toEqual([]);
      expect(broadcasts).toEqual([]);
      await expect(
        dispatcher.query(
          'core.plan.detected.list',
          { scope },
          { caller: { ...RENDERER, grants: ['core.plan.read'] } },
        ),
      ).resolves.toEqual({ detected: [] });
    } finally {
      relay.dispose();
    }
  });

  it("serves the main window's plan writes through the relay, keyed and announced once each to every window", async () => {
    const writes = { projectId: WORKSPACE_ID, worktreeId: 'golden-wt-relay' };
    const { resolveWorktreeCwd } = await import('../lib/resolve-worktree');
    const writesRoot = resolveWorktreeCwd(writes.projectId, writes.worktreeId);
    mkdirSync(writesRoot, { recursive: true });
    writeFileSync(join(writesRoot, 'PLAN.md'), '# Relay import');
    const { event, relay } = mainWindowRelay();
    const write = (
      method: string,
      params: Record<string, unknown>,
      key: string,
    ): Promise<unknown> =>
      relay.invoke(event, {
        kind: 'request',
        method,
        params: { ...params, _meta: { idempotencyKey: key } },
      });
    try {
      const create = {
        scope: writes,
        source: 'claude',
        content: '# Relay',
      };
      const created = await write('core.plan.create', create, 'relay-c-1');
      // A lost reply re-sent under its key answers the first outcome.
      await expect(
        write('core.plan.create', create, 'relay-c-1'),
      ).resolves.toEqual(created);
      expect(created).toMatchObject({ ok: true, value: { plan: writes } });
      const planId = must(
        (created as { value?: { plan?: TrackedPlanData } }).value?.plan,
      ).id;
      await expect(
        write(
          'core.plan.create',
          { ...create, content: '# Other' },
          'relay-c-1',
        ),
      ).resolves.toMatchObject({ ok: false, error: { kind: 'conflict' } });
      await expect(
        write(
          'core.plan.update',
          { scope: writes, planId, content: '# Relay, v2' },
          'relay-u-1',
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { plan: { id: planId, content: '# Relay, v2' } },
      });
      await expect(
        write(
          'core.plan.import',
          { scope: writes, repoId: WORKSPACE_ROOT_REPO_ID, path: 'PLAN.md' },
          'relay-i-1',
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { plan: { source: 'imported', sourceFilePath: 'PLAN.md' } },
      });
      await expect(
        write('core.plan.delete', { scope: writes, planId }, 'relay-d-1'),
      ).resolves.toEqual({ ok: true, value: { deleted: true } });
      // A recipient scope stays read-only on this path too.
      await expect(
        write(
          'core.plan.create',
          {
            scope: {
              projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
              worktreeId: WORKTREE_ID,
            },
            source: 'claude',
            content: 'x',
          },
          'relay-viewer-1',
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          kind: 'permission_denied',
          code: 'core.plan.readOnlyScope',
          message: 'Shared-container recipient workspaces are read-only',
        },
      });
    } finally {
      relay.dispose();
    }
    const announced = broadcasts.map(({ payload }) =>
      isPlansUpdatedEvent(payload) ? payload.change : payload,
    );
    expect(announced).toEqual(['upsert', 'upsert', 'upsert', 'remove']);
    expect(
      broadcasts.every(
        ({ channel }) => channel === IPC_CHANNELS.trackedPlansUpdated,
      ),
    ).toBe(true);
    expect(windowSends).toEqual([]);
    const importing = ['instruction', 'core.plan.import'] as const;
    expect(relayAllows('main', ...importing, 'authority')).toBe(true);
    expect(relayAllows('main', ...importing, 'read-only')).toBe(false);
    expect(relayAllows('app-advisor', ...importing)).toBe(false);
  });

  it('refuses a recipient scope and a scope with no plans as typed errors', async () => {
    await expect(
      dispatcher.instruction(
        'core.plan.create',
        {
          scope: {
            projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
            worktreeId: WORKTREE_ID,
          },
          source: 'claude',
          content: 'x',
        },
        writer('viewer-1'),
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'permission_denied',
        code: 'core.plan.readOnlyScope',
        message: 'Shared-container recipient workspaces are read-only',
      },
    });
    await expect(
      dispatcher.instruction(
        'core.plan.create',
        {
          scope: { projectId: COWORK_ID, worktreeId: WORKTREE_ID },
          source: 'claude',
          content: 'x',
        },
        writer('cowork-1'),
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.plan.unsupportedScope',
      },
    });
    // Through IPC the cowork refusal keeps the message it always had.
    await expect(
      invoke(IPC_CHANNELS.trackedPlansGet, {
        projectId: COWORK_ID,
        worktreeId: WORKTREE_ID,
        planId: 'plan-1',
      }),
    ).rejects.toThrow(
      `Tracked plans are not available for cowork project ${COWORK_ID}`,
    );
  });
});

// CAN-4165 PR 4 (CAN-7295): the plan-mode agent and the pipeline writers
// dispatch core.plan.* as their own principals, so each committed write is
// announced like any other binding's.
describe('plan-mode agent and pipeline plan writes on core.plan (CAN-7295)', () => {
  const writers = { projectId: WORKSPACE_ID, worktreeId: 'golden-wt-writers' };
  const PLAN_MODE: CanopyCallerDescriptor = {
    principalId: 'desktop-agent-plan-mode',
    clientInstanceId: 'electron-main-plan-mode',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['core.plan.write'],
  };
  const PIPELINE_RUNTIME: CanopyCallerDescriptor = {
    principalId: 'desktop-pipeline-plans',
    clientInstanceId: 'electron-main-pipeline-runtime',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['core.plan.write'],
  };
  const pipelineOwner = (executionId: string): CanopyCallerDescriptor => ({
    ...PIPELINE_RUNTIME,
    clientInstanceId: `pipeline-owner:${executionId}`,
  });
  const relayWriter: { caller: CanopyCallerDescriptor } = {
    caller: { ...RENDERER, grants: ['core.plan.write'] },
  };
  let owner: typeof OwnerRequests;
  let planMode: typeof PlanMode;
  let planExit: typeof PlanExit;
  let interfaces: typeof InterfacePort;
  let executionRuntime: typeof ExecutionRuntime;

  function ownerRun(
    executionId: string,
    target: { projectId: string; worktreeId: string } = writers,
  ): OwnerRequests.PipelineOwnerRun {
    return {
      executionId,
      scope: () => ({ ...target, folder: root }),
      secretValues: [],
    };
  }

  function ownerRequest(
    executionId: string,
    request: WorkerPipelineHostRequest['request'],
  ): WorkerPipelineHostRequest {
    return {
      requestId: `owner-${executionId}-${Math.random()}`,
      executionId,
      jobId: 'job',
      stepId: 'step',
      childExecutionId: null,
      attempt: 0,
      iteration: 0,
      owner: null,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      request,
    };
  }

  function ownerPlanId(settlement: { result: unknown }): string {
    const { result } = settlement;
    if (
      typeof result === 'object' &&
      result !== null &&
      'value' in result &&
      typeof result.value === 'object' &&
      result.value !== null &&
      'planId' in result.value &&
      typeof result.value.planId === 'string'
    )
      return result.value.planId;
    throw new Error(`no plan id in ${JSON.stringify(result)}`);
  }

  function planModeUpsert(
    sessions: PlanMode.PlanModeSessionPlans,
    plan: string,
  ): Promise<TrackedPlanData> {
    return planMode.upsertPlanModeTrackedPlan(
      sessions,
      'golden-session',
      writers.projectId,
      writers.worktreeId,
      'golden-plan-mode-chat',
      'claude',
      { plan },
    );
  }

  function proposePlan(plan: string): Promise<void> {
    return planExit.publishOpenCodePlanProposal({
      ...writers,
      chatId: 'golden-proposal-chat',
      plan,
      isCurrent: () => true,
      presentPlanExit: (event): void =>
        interfaces.windowAgentInterfacePort(() => null).presentPlanExit(event),
    });
  }

  function inProcessHooks(): ExecutionPlanPersistenceHooks {
    return must(
      executionRuntime.createElectronExecutionRuntime().planPersistence,
    );
  }

  /** The `tracked-plans:updated` events broadcast since the case began. */
  function announced(): TrackedPlansUpdatedEvent[] {
    return broadcasts
      .filter(({ channel }) => channel === IPC_CHANNELS.trackedPlansUpdated)
      .flatMap(({ payload }) =>
        isPlansUpdatedEvent(payload) ? [payload] : [],
      );
  }

  beforeAll(async () => {
    owner = await import('../pipelines/pipeline-owner-requests');
    planMode = await import('../agents/plan-mode-tracked-plan');
    planExit = await import('../services/chat-state-plan-exit');
    interfaces = await import('../agents/agent-interface-port');
    executionRuntime = await import('../pipelines/execution-runtime');
    const access = await import('../canopy-runtime/desktop-runtime-access');
    access.setDesktopCanopyRuntime(dispatcher);
  });

  afterAll(async () => {
    const access = await import('../canopy-runtime/desktop-runtime-access');
    access.setDesktopCanopyRuntime(null);
  });

  beforeEach(() => {
    mockProposalTabs.length = 0;
    mockProposalTabs.push({
      id: 'golden-proposal-chat',
      planMode: true,
      title: 'Proposal',
    });
  });

  it("dispatches a plan-mode agent's plan as its own principal with only core.plan.write", async () => {
    const sessions: PlanMode.PlanModeSessionPlans = new Map();
    const created = await planModeUpsert(sessions, '# Plan mode\n\nFirst.');
    const revised = await planModeUpsert(sessions, '# Plan mode\n\nSecond.');
    expect(revised.id).toBe(created.id);
    expect(revised.latestRevisionNumber).toBe(created.latestRevisionNumber + 1);
    expect(revised).toMatchObject({
      source: 'claude',
      reviewStatus: 'pending',
    });
    expect(dispatched()).toEqual([
      { name: 'core.plan.create', caller: PLAN_MODE },
      { name: 'core.plan.update', caller: PLAN_MODE },
    ]);
  });

  it('dispatches pipeline plan writes as the pipeline principal, in process and for a daemon run', async () => {
    const hooks = inProcessHooks();
    const started = await hooks.createTrackedPlan({
      ...writers,
      source: 'pipeline',
      content: '# In process',
      reviewStatus: 'approved',
      linkedExecutionId: 'execution-in-process',
    });
    await hooks.updateTrackedPlan({
      ...writers,
      planId: started.id,
      linkedExecutionId: 'execution-in-process-2',
    });
    await hooks.updateTrackedPlan({
      ...writers,
      planId: started.id,
      source: 'pipeline',
      reviewStatus: 'approved',
      approvedAt: new Date().toISOString(),
      dismissedAt: null,
      linkedExecutionId: 'execution-in-process-2',
    });
    const context = new owner.PipelineOwnerRunContext(
      ownerRun('execution-owner'),
    );
    const kept = ownerPlanId(
      await context.apply(
        ownerRequest('execution-owner', {
          action: 'owner.plan.create',
          content: '# Daemon run',
        }),
        new AbortController().signal,
      ),
    );
    const approved = await context.apply(
      ownerRequest('execution-owner', {
        action: 'owner.plan.update',
        planId: kept,
        content: '# Daemon run, refined',
        approve: true,
      }),
      new AbortController().signal,
    );
    expect(approved.result).toMatchObject({ status: 'owner' });
    await context.close(null);
    expect(dispatched()).toEqual([
      { name: 'core.plan.create', caller: PIPELINE_RUNTIME },
      { name: 'core.plan.update', caller: PIPELINE_RUNTIME },
      { name: 'core.plan.update', caller: PIPELINE_RUNTIME },
      { name: 'core.plan.create', caller: pipelineOwner('execution-owner') },
      { name: 'core.plan.update', caller: pipelineOwner('execution-owner') },
    ]);
    const stored = await invoke<TrackedPlanData | null>(
      IPC_CHANNELS.trackedPlansGet,
      { ...writers, planId: kept },
    );
    expect(must(stored)).toMatchObject({
      source: 'pipeline',
      reviewStatus: 'approved',
      content: '# Daemon run, refined',
    });
  });

  it("announces each writer's committed write exactly once, and an IPC write not at all", async () => {
    const relayShape = async (): Promise<TrackedPlansUpdatedEvent> => {
      const plan = await invoke<TrackedPlanData>(
        IPC_CHANNELS.trackedPlansCreate,
        { ...writers, source: 'claude', content: '# Relay shape' },
      );
      broadcasts.length = 0;
      await dispatcher.instruction(
        'core.plan.update',
        { scope: writers, planId: plan.id, content: '# Relay shape, edited' },
        { ...relayWriter, metadata: { idempotencyKey: 'writers-relay-shape' } },
      );
      const [event] = announced();
      broadcasts.length = 0;
      return must(event);
    };
    const relayEvent = await relayShape();
    const steps: { step: string; pushes: number; planId: string }[] = [];
    /** Runs one write and records what it announced, checked against the store. */
    const step = async (
      name: string,
      write: () => Promise<string>,
    ): Promise<string> => {
      const before = announced().length;
      const planId = await write();
      const events = announced().slice(before);
      steps.push({ step: name, pushes: events.length, planId });
      for (const event of events) {
        // No more than a relay write's push carries: the stored plan, as a
        // controller can already read it, and nothing else.
        expect(Object.keys(event).sort()).toEqual(
          Object.keys(relayEvent).sort(),
        );
        expect(event).toMatchObject({ ...writers, change: 'upsert' });
        const stored = await invoke<TrackedPlanData | null>(
          IPC_CHANNELS.trackedPlansGet,
          { ...writers, planId },
        );
        expect(event.change === 'upsert' ? event.plan : null).toEqual(
          must(stored),
        );
      }
      return planId;
    };

    const ipc = await step('IPC create', async () => {
      const plan = await invoke<TrackedPlanData>(
        IPC_CHANNELS.trackedPlansCreate,
        { ...writers, source: 'claude', content: '# From IPC' },
      );
      return plan.id;
    });
    const sessions: PlanMode.PlanModeSessionPlans = new Map();
    const planMode = await step(
      'plan-mode create',
      async () => (await planModeUpsert(sessions, '# Plan mode')).id,
    );
    await step(
      'plan-mode revise',
      async () => (await planModeUpsert(sessions, '# Plan mode, revised')).id,
    );
    const proposal = await step('proposal-mode create', async () => {
      await proposePlan('# Proposal');
      const proposed = await invoke<TrackedPlanData[]>(
        IPC_CHANNELS.trackedPlansList,
        writers,
      );
      return must(proposed.find((plan) => plan.source === 'opencode')).id;
    });
    const hooks = inProcessHooks();
    const inProcess = await step(
      'in-process create',
      async () =>
        (
          await hooks.createTrackedPlan({
            ...writers,
            source: 'pipeline',
            content: '# In process',
            reviewStatus: 'approved',
            linkedExecutionId: 'execution-writers',
          })
        ).id,
    );
    await step('in-process link', async () => {
      await hooks.updateTrackedPlan({
        ...writers,
        planId: inProcess,
        linkedExecutionId: 'execution-writers-2',
      });
      return inProcess;
    });
    await step('in-process approval', async () => {
      await hooks.updateTrackedPlan({
        ...writers,
        planId: inProcess,
        source: 'pipeline',
        reviewStatus: 'approved',
        approvedAt: new Date().toISOString(),
        dismissedAt: null,
        linkedExecutionId: 'execution-writers-2',
      });
      return inProcess;
    });
    const context = new owner.PipelineOwnerRunContext(
      ownerRun('execution-daemon'),
    );
    const ownerPlan = await step('owner create', async () =>
      ownerPlanId(
        await context.apply(
          ownerRequest('execution-daemon', {
            action: 'owner.plan.create',
            content: '# Daemon',
          }),
          new AbortController().signal,
        ),
      ),
    );
    await step('owner update', async () => {
      await context.apply(
        ownerRequest('execution-daemon', {
          action: 'owner.plan.update',
          planId: ownerPlan,
          approve: true,
        }),
        new AbortController().signal,
      );
      return ownerPlan;
    });
    await context.close(null);
    await step('relay update', async () => {
      await dispatcher.instruction(
        'core.plan.update',
        { scope: writers, planId: ipc, content: '# From the relay' },
        { ...relayWriter, metadata: { idempotencyKey: 'writers-relay-1' } },
      );
      return ipc;
    });
    await step('IPC delete', async () => {
      await invoke(IPC_CHANNELS.trackedPlansDelete, {
        ...writers,
        planId: ipc,
      });
      return ipc;
    });

    expect(steps.map(({ step: name, pushes }) => [name, pushes])).toEqual([
      ['IPC create', 0],
      ['plan-mode create', 1],
      ['plan-mode revise', 1],
      ['proposal-mode create', 1],
      ['in-process create', 1],
      ['in-process link', 1],
      ['in-process approval', 1],
      ['owner create', 1],
      ['owner update', 1],
      ['relay update', 1],
      ['IPC delete', 0],
    ]);
    const perPlan = (planId: string): number =>
      announced().filter(
        (event) => event.change === 'upsert' && event.plan.id === planId,
      ).length;
    expect({
      ipc: perPlan(ipc),
      planMode: perPlan(planMode),
      proposal: perPlan(proposal),
      inProcess: perPlan(inProcess),
      owner: perPlan(ownerPlan),
    }).toEqual({ ipc: 1, planMode: 2, proposal: 1, inProcess: 3, owner: 2 });
    expect(announced()).toHaveLength(9);
  });

  it('refuses a renderer or a paired controller that names a host writer, and attributes its call to itself', async () => {
    const sessions: PlanMode.PlanModeSessionPlans = new Map();
    await planModeUpsert(sessions, '# Host writer');
    const { deriveDesktopIpcCaller: deriveCaller } =
      await import('../canopy-runtime/desktop-ipc-caller');
    const { createRemoteCoreAccess } =
      await import('../remote-control/host/remote-core-access');
    const forged = {
      ...writers,
      source: 'pipeline',
      content: '# Forged',
      principalId: 'desktop-pipeline-plans',
      clientInstanceId: 'electron-main-pipeline-runtime',
      authorityId: 'local-desktop',
      caller: PIPELINE_RUNTIME,
    };
    const appContents = {
      id: 41,
      mainFrame: {
        url: 'file:///app/index.html',
        detached: false,
        isDestroyed: (): boolean => false,
      },
      getURL: (): string => 'file:///app/index.html',
      isDestroyed: (): boolean => false,
    };
    const bridgeContents = {
      ...appContents,
      id: 42,
      mainFrame: { ...appContents.mainFrame },
    };
    const callerOptions = {
      getAppWindows: (): Array<{
        isDestroyed(): boolean;
        webContents: typeof appContents;
      }> => [{ isDestroyed: (): boolean => false, webContents: appContents }],
      packagedRendererUrls: ['file:///app/index.html'],
      resolveRemoteBridgeSender: (sender: { id: number }): string | null =>
        sender.id === bridgeContents.id ? 'desktop-pipeline-plans' : null,
    };
    // The renderer: its caller comes from the sending frame, never the request.
    ipcCaller = deriveCaller(
      { sender: appContents, senderFrame: appContents.mainFrame },
      callerOptions,
    );
    await invoke(IPC_CHANNELS.trackedPlansCreate, forged);
    // A paired controller whose device id is a host writer's principal.
    ipcCaller = deriveCaller(
      { sender: bridgeContents, senderFrame: bridgeContents.mainFrame },
      callerOptions,
    );
    await invoke(IPC_CHANNELS.trackedPlansCreate, forged);
    // A frame that is no app window is refused before any dispatch.
    const stray = {
      ...appContents,
      id: 43,
      mainFrame: { ...appContents.mainFrame },
    };
    expect(() =>
      deriveCaller(
        { sender: stray, senderFrame: stray.mainFrame },
        callerOptions,
      ),
    ).toThrow('Untrusted desktop IPC sender.');
    // Remote Control's core access serves no plan write, whatever it names.
    const remoteCore = createRemoteCoreAccess(() => dispatcher);
    await expect(
      remoteCore.call('golden-device', 'core.plan.create', 1, {
        scope: writers,
        source: 'pipeline',
        content: '# Forged',
        caller: PIPELINE_RUNTIME,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'capability_unavailable' },
    });
    expect(dispatched()).toEqual([
      { name: 'core.plan.create', caller: PLAN_MODE },
      {
        name: 'core.plan.create',
        caller: {
          principalId: 'local-desktop-user',
          clientInstanceId: 'electron-web-contents:41',
          authorityId: 'local-desktop',
          interfaceKind: 'desktop',
          grants: ['core.plan.write'],
        },
      },
      {
        name: 'core.plan.create',
        caller: {
          principalId: 'remote-device:desktop-pipeline-plans',
          clientInstanceId: 'remote-bridge:42',
          authorityId: 'local-desktop',
          interfaceKind: 'desktop',
          grants: ['core.plan.write'],
        },
      },
    ]);
    // Nothing the host writer module exports is a caller anyone could pass.
    const exported: unknown[] = Object.values(
      await import('../canopy-runtime/plan-host-writers'),
    );
    for (const value of exported)
      expect(JSON.stringify(value) ?? '').not.toMatch(
        /desktop-agent-plan-mode|desktop-pipeline-plans/,
      );
  });

  it('keeps refusing agent and pipeline plan writes where plans are refused, with the errors they always had', async () => {
    const cowork = { projectId: COWORK_ID, worktreeId: WORKTREE_ID };
    const context = new owner.PipelineOwnerRunContext(
      ownerRun('execution-cowork', cowork),
    );
    const refused = await context.apply(
      ownerRequest('execution-cowork', {
        action: 'owner.plan.create',
        content: '# Cowork',
      }),
      new AbortController().signal,
    );
    expect(refused.result).toMatchObject({
      status: 'failure',
      message: 'The app could not answer this workflow step.',
    });
    await context.close(null);
    await expect(
      inProcessHooks().createTrackedPlan({
        ...cowork,
        source: 'pipeline',
        content: '# Cowork',
      }),
    ).rejects.toThrow(
      `Tracked plans are not available for cowork project ${COWORK_ID}`,
    );
    // A store that cannot be written keeps its errno code for the run's
    // plan_persist_failure_code (CAN-7118).
    const plansDir = join(dataDir, 'workspaces', WORKSPACE_ID, 'plans');
    chmodSync(plansDir, 0o500);
    try {
      await expect(
        inProcessHooks().createTrackedPlan({
          projectId: WORKSPACE_ID,
          worktreeId: 'golden-wt-read-only',
          source: 'pipeline',
          content: '# Read-only',
        }),
      ).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(plansDir, 0o700);
    }
    expect(broadcasts).toEqual([]);
  });
});

// CAN-4165 PR 4b-1: proposal-mode approval and a pipeline run's implicit
// approval write through core.plan.update as host writers. The approval's
// revision and source check is expectedRevision plus expectedSource, which
// core checks under the plan file's lock.
describe('plan approvals on core.plan (CAN-4165 PR 4b-1)', () => {
  const approvals = {
    projectId: WORKSPACE_ID,
    worktreeId: 'golden-wt-approvals',
  };
  const PLAN_REVIEW: CanopyCallerDescriptor = {
    principalId: 'desktop-agent-plan-mode',
    clientInstanceId: 'electron-main-plan-review',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['core.plan.write'],
  };
  const PIPELINE_RUNTIME: CanopyCallerDescriptor = {
    principalId: 'desktop-pipeline-plans',
    clientInstanceId: 'electron-main-pipeline-runtime',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['core.plan.write'],
  };
  const relay = (
    key: string,
  ): {
    caller: CanopyCallerDescriptor;
    metadata: { idempotencyKey: string };
  } => ({
    caller: { ...RENDERER, grants: ['core.plan.write'] },
    metadata: { idempotencyKey: `${key}-${Math.random()}` },
  });
  let hostWriters: typeof HostWriters;

  async function stored(
    source: 'opencode' | 'claude' | 'pipeline',
    content: string,
  ): Promise<TrackedPlanData> {
    const { plan } = await dispatcher.instruction(
      'core.plan.create',
      { scope: approvals, source, content },
      relay('create'),
    );
    return must(
      await persistence.getTrackedPlan(
        approvals.projectId,
        approvals.worktreeId,
        must(plan).id,
      ),
    );
  }

  async function read(planId: string): Promise<TrackedPlanData> {
    return must(
      await persistence.getTrackedPlan(
        approvals.projectId,
        approvals.worktreeId,
        planId,
      ),
    );
  }

  function approve(
    planId: string,
    revisionNumber: number,
    scope: { projectId: string; worktreeId: string } = approvals,
  ): Promise<boolean> {
    return hostWriters.approveProposalPlanReview({
      ...scope,
      chatId: 'golden-approval-chat',
      planId,
      revisionNumber,
      approvedAt: '2026-11-19T12:00:00.000Z',
    });
  }

  function announced(): number {
    return broadcasts.filter(
      ({ channel }) => channel === IPC_CHANNELS.trackedPlansUpdated,
    ).length;
  }

  beforeAll(async () => {
    hostWriters = await import('../canopy-runtime/plan-host-writers');
    const access = await import('../canopy-runtime/desktop-runtime-access');
    access.setDesktopCanopyRuntime(dispatcher);
  });

  afterAll(async () => {
    const access = await import('../canopy-runtime/desktop-runtime-access');
    access.setDesktopCanopyRuntime(null);
  });

  it('approves a proposal plan at its revision as the plan review client, and announces it once', async () => {
    const created = await stored('opencode', '# Proposal');
    await dispatcher.instruction(
      'core.plan.update',
      { scope: approvals, planId: created.id, content: '# Proposal, revised' },
      relay('revise'),
    );
    dispatcherCalls.clear();
    broadcasts.length = 0;
    await expect(approve(created.id, 2)).resolves.toBe(true);
    expect(await read(created.id)).toMatchObject({
      reviewStatus: 'approved',
      approvedAt: '2026-11-19T12:00:00.000Z',
      latestRevisionNumber: 2,
      content: '# Proposal, revised',
    });
    expect(dispatched()).toEqual([
      { name: 'core.plan.update', caller: PLAN_REVIEW },
    ]);
    expect(announced()).toBe(1);
  });

  it('answers false and writes nothing for another revision, another source or a missing plan', async () => {
    const proposal = await stored('opencode', '# Proposal at one');
    const agent = await stored('claude', '# Agent plan');
    broadcasts.length = 0;
    await expect(approve(proposal.id, 2)).resolves.toBe(false);
    await expect(approve(agent.id, 1)).resolves.toBe(false);
    await expect(approve('golden-missing-plan', 1)).resolves.toBe(false);
    expect(await read(proposal.id)).toEqual(proposal);
    expect(await read(agent.id)).toEqual(agent);
    expect(announced()).toBe(0);
  });

  it('only narrows a write with expectedSource: a mismatch is a revision conflict, a retry with it still refuses, and a stale revision stays refused', async () => {
    const plan = await stored('claude', '# Sourced');
    const conflict = {
      payload: {
        kind: 'conflict',
        code: 'core.plan.revisionConflict',
        details: { currentRevision: 1 },
      },
    };
    const mismatch = {
      scope: approvals,
      planId: plan.id,
      expectedRevision: 1,
      expectedSource: 'opencode' as const,
      content: '# Wrong source',
    };
    await expect(
      dispatcher.instruction('core.plan.update', mismatch, relay('mismatch')),
    ).rejects.toMatchObject(conflict);
    await expect(
      dispatcher.instruction('core.plan.update', mismatch, relay('retry')),
    ).rejects.toMatchObject(conflict);
    await expect(
      dispatcher.instruction(
        'core.plan.update',
        {
          scope: approvals,
          planId: plan.id,
          expectedRevision: 2,
          expectedSource: 'claude',
          content: '# Stale revision',
        },
        relay('stale'),
      ),
    ).rejects.toMatchObject(conflict);
    expect(await read(plan.id)).toEqual(plan);
    await expect(
      dispatcher.instruction(
        'core.plan.update',
        {
          scope: approvals,
          planId: plan.id,
          expectedRevision: 1,
          expectedSource: 'claude',
          content: '# Matching source',
        },
        relay('match'),
      ),
    ).resolves.toMatchObject({
      plan: { content: '# Matching source', latestRevisionNumber: 2 },
    });
    await expect(
      dispatcher.instruction(
        'core.plan.update',
        { scope: approvals, planId: plan.id, content: '# Without either' },
        relay('without'),
      ),
    ).resolves.toMatchObject({
      plan: { content: '# Without either', latestRevisionNumber: 3 },
    });
  });

  it('keeps refusing an approval where plans are refused, with the errors they always had', async () => {
    await expect(
      approve('golden-plan', 1, {
        projectId: COWORK_ID,
        worktreeId: WORKTREE_ID,
      }),
    ).rejects.toThrow(
      `Tracked plans are not available for cowork project ${COWORK_ID}`,
    );
    await expect(approve('not a valid id', 1)).rejects.toThrow();
    await expect(
      hostWriters.approvePlanForPipelineRun({
        projectId: COWORK_ID,
        worktreeId: WORKTREE_ID,
        planId: 'golden-plan',
        executionId: 'execution-cowork',
        approvedAt: '2026-11-19T12:00:00.000Z',
      }),
    ).rejects.toThrow(
      `Tracked plans are not available for cowork project ${COWORK_ID}`,
    );
  });

  it("approves a pipeline run's plan as the pipeline principal, linking the run, and announces it once", async () => {
    const plan = await stored('pipeline', '# Run this');
    dispatcherCalls.clear();
    broadcasts.length = 0;
    const approved = await hostWriters.approvePlanForPipelineRun({
      ...approvals,
      planId: plan.id,
      executionId: 'execution-implicit',
      approvedAt: '2026-11-19T12:00:00.000Z',
      initiationSource: 'user',
    });
    expect(approved).toMatchObject({
      id: plan.id,
      reviewStatus: 'approved',
      linkedExecutionIds: ['execution-implicit'],
    });
    await expect(
      hostWriters.approvePlanForPipelineRun({
        ...approvals,
        planId: 'golden-missing-plan',
        executionId: 'execution-missing',
        approvedAt: '2026-11-19T12:00:00.000Z',
      }),
    ).resolves.toBeNull();
    expect(dispatched()).toEqual([
      { name: 'core.plan.update', caller: PIPELINE_RUNTIME },
      { name: 'core.plan.update', caller: PIPELINE_RUNTIME },
    ]);
    expect(announced()).toBe(1);
  });

  it('dispatches a renderer that names the plan review client as itself, and exports no such caller', async () => {
    const plan = await stored('opencode', '# Forged review');
    dispatcherCalls.clear();
    await invoke(IPC_CHANNELS.trackedPlansUpdate, {
      ...approvals,
      planId: plan.id,
      reviewStatus: 'approved',
      expectedRevision: 1,
      expectedSource: 'opencode',
      principalId: 'desktop-agent-plan-mode',
      clientInstanceId: 'electron-main-plan-review',
      caller: PLAN_REVIEW,
    });
    expect(dispatched()).toEqual([
      {
        name: 'core.plan.update',
        caller: { ...RENDERER, grants: ['core.plan.write'] },
      },
    ]);
    const exported: unknown[] = Object.values(
      await import('../canopy-runtime/plan-host-writers'),
    );
    for (const value of exported)
      expect(JSON.stringify(value) ?? '').not.toMatch(
        /desktop-agent-plan-mode|desktop-pipeline-plans|electron-main-plan-review/,
      );
  });
});

// Remote Control reaches tracked plans through these channels. Pinned before
// CAN-4165 PR 3b-2 moves them onto core.plan, so the move cannot widen or
// narrow what a paired controller may do: a full desktop controller keeps
// every lifecycle channel, and the read-only profiles stay read-only.
describe('Remote Control access to tracked plans (CAN-4165 equivalence)', () => {
  const channels = [
    IPC_CHANNELS.trackedPlansList,
    IPC_CHANNELS.trackedPlansListWithSkipped,
    IPC_CHANNELS.trackedPlansGet,
    IPC_CHANNELS.trackedPlansCreate,
    IPC_CHANNELS.trackedPlansUpdate,
    IPC_CHANNELS.trackedPlansDelete,
  ];
  const request = {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    planId: 'plan-1',
    source: 'claude',
    content: 'x',
  };
  const allowed = (
    kind: 'desktop' | 'mobile' | 'browser' | 'hosted',
  ): string[] =>
    channels.filter((channel) =>
      controllerMayInvoke(
        kind,
        channel,
        [request],
        getRemoteChannelDisposition,
      ),
    );

  it('lets a desktop controller use every tracked-plan lifecycle channel', () => {
    expect(allowed('desktop')).toEqual(channels);
  });

  it('keeps mobile, browser and hosted controllers to their plan channels', () => {
    expect({
      mobile: allowed('mobile'),
      browser: allowed('browser'),
      hosted: allowed('hosted'),
    }).toMatchSnapshot();
    // The read-only profiles never create, update or delete a plan.
    for (const kind of ['mobile', 'hosted'] as const)
      for (const channel of [
        IPC_CHANNELS.trackedPlansCreate,
        IPC_CHANNELS.trackedPlansUpdate,
        IPC_CHANNELS.trackedPlansDelete,
      ])
        expect(allowed(kind)).not.toContain(channel);
  });
});

// CAN-4165 PR 5a: the import channel's worktree-file branch projects
// core.plan.import, which the desktop dispatcher serves over plan-import.
// The import case above pins the channel's answers; these pin the operation
// it dispatches, the operation's grant, its typed refusals, and that the
// scope is checked before the file is read.
describe('plan import on core.plan (CAN-4165 PR 5a)', () => {
  const imports = { projectId: WORKSPACE_ID, worktreeId: 'golden-wt-import' };
  const params = {
    scope: imports,
    repoId: WORKSPACE_ROOT_REPO_ID,
    path: 'docs/CORE.md',
  };
  const caller = (
    key: string,
    grants: CanopyCallerDescriptor['grants'] = ['core.plan.write'],
  ): {
    caller: CanopyCallerDescriptor;
    metadata: { idempotencyKey: string };
  } => ({
    caller: { ...RENDERER, grants },
    metadata: { idempotencyKey: key },
  });
  let importRoot: string;

  async function storedIds(): Promise<string[]> {
    return (
      await persistence.listTrackedPlans(imports.projectId, imports.worktreeId)
    ).map((plan) => plan.id);
  }

  beforeAll(async () => {
    const { resolveWorktreeCwd } = await import('../lib/resolve-worktree');
    importRoot = resolveWorktreeCwd(imports.projectId, imports.worktreeId);
    mkdirSync(join(importRoot, 'docs'), { recursive: true });
    writeFileSync(
      join(importRoot, 'docs', 'CORE.md'),
      '# Core import\n\nFrom the dispatcher.',
    );
    writeFileSync(join(importRoot, 'notes.json'), '{}');
  });

  it('serves the import channel through core.plan.import with only core.plan.write, and answers as before', async () => {
    const response = await invoke<{
      plan: TrackedPlanData | null;
      trackedPlanFilePath: string;
    }>(IPC_CHANNELS.trackedPlansImport, {
      ...imports,
      filePath: 'docs/CORE.md',
      repoId: WORKSPACE_ID,
    });
    expect(dispatched()).toEqual([
      {
        name: 'core.plan.import',
        caller: { ...RENDERER, grants: ['core.plan.write'] },
      },
    ]);
    const plan = must(response.plan);
    expect(plan).toMatchObject({
      ...imports,
      source: 'imported',
      title: 'Core import',
      content: '# Core import\n\nFrom the dispatcher.',
      sourceFilePath: 'docs/CORE.md',
      sourceRepoId: WORKSPACE_ROOT_REPO_ID,
      latestRevisionNumber: 1,
    });
    await expect(
      persistence.getTrackedPlan(
        imports.projectId,
        imports.worktreeId,
        plan.id,
      ),
    ).resolves.toEqual(plan);
    expect(response.trackedPlanFilePath).toBe(
      join(
        dataDir,
        'workspaces',
        WORKSPACE_ID,
        'plans',
        'golden-wt-import.json',
      ),
    );
    // The window that asked hears of it as it always did; no other does.
    expect(windowSends).toEqual([
      {
        channel: IPC_CHANNELS.trackedPlansUpdated,
        payload: { ...imports, plan },
      },
    ]);
    expect(broadcasts).toEqual([]);
    // Refusals keep the messages the channel always gave.
    for (const [filePath, message] of [
      [
        'notes.json',
        'Only Markdown (.md) and plain text (.txt) plan documents can be imported.',
      ],
      ['missing.md', 'Could not read the selected file'],
      [
        join(importRoot, 'docs', 'CORE.md'),
        'Plan import paths must be relative to the worktree.',
      ],
    ])
      await expect(
        invoke(IPC_CHANNELS.trackedPlansImport, {
          ...imports,
          filePath,
          repoId: WORKSPACE_ID,
        }),
      ).rejects.toThrow(message);
  });

  it('imports a worktree file through core.plan.import once per key, and announces each import to every window', async () => {
    const before = await storedIds();
    const first = await dispatcher.instruction(
      'core.plan.import',
      params,
      caller('import-1'),
    );
    const repeat = await dispatcher.instruction(
      'core.plan.import',
      params,
      caller('import-1'),
    );
    expect(repeat).toEqual(first);
    expect(first.plan).toMatchObject({
      ...imports,
      source: 'imported',
      title: 'Core import',
      content: '# Core import\n\nFrom the dispatcher.',
      sourceFilePath: 'docs/CORE.md',
      sourceRepoId: WORKSPACE_ROOT_REPO_ID,
      latestRevisionNumber: 1,
    });
    await expect(
      dispatcher.instruction(
        'core.plan.import',
        { ...params, path: 'docs/OTHER.md' },
        caller('import-1'),
      ),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
    // Another key imports the same file again, as the channel always has.
    const again = await dispatcher.instruction(
      'core.plan.import',
      params,
      caller('import-2'),
    );
    expect(again.plan.id).not.toBe(first.plan.id);
    expect((await storedIds()).sort()).toEqual(
      [...before, first.plan.id, again.plan.id].sort(),
    );
    const stored = must(
      await persistence.getTrackedPlan(
        imports.projectId,
        imports.worktreeId,
        first.plan.id,
      ),
    );
    expect(broadcasts.map(({ channel }) => channel)).toEqual([
      IPC_CHANNELS.trackedPlansUpdated,
      IPC_CHANNELS.trackedPlansUpdated,
    ]);
    expect(broadcasts[0].payload).toEqual({
      ...imports,
      plan: stored,
      change: 'upsert',
    });
  });

  it('keeps only the 16 most recent import outcomes for replay', async () => {
    const oldest = await dispatcher.instruction(
      'core.plan.import',
      params,
      caller('evict-0'),
    );
    let newest = oldest;
    for (let index = 1; index <= 16; index += 1)
      newest = await dispatcher.instruction(
        'core.plan.import',
        params,
        caller(`evict-${index}`),
      );
    // The newest key still replays; the oldest, now 17th, runs again.
    expect(
      await dispatcher.instruction(
        'core.plan.import',
        params,
        caller('evict-16'),
      ),
    ).toEqual(newest);
    const rerun = await dispatcher.instruction(
      'core.plan.import',
      params,
      caller('evict-0'),
    );
    expect(rerun.plan.id).not.toBe(oldest.plan.id);
  });

  it('refuses core.plan.import without core.plan.write and writes nothing', async () => {
    const before = await storedIds();
    const ungranted: CanopyCallerDescriptor['grants'][] = [
      [],
      ['core.plan.read'],
    ];
    for (const grants of ungranted)
      await expect(
        dispatcher.instruction(
          'core.plan.import',
          params,
          caller(`ungranted-${grants.length}`, grants),
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(await storedIds()).toEqual(before);
    expect(broadcasts).toEqual([]);
  });

  it('refuses a path that is not a plan document in the worktree as typed errors, with no host path', async () => {
    const before = await storedIds();
    for (const [repoId, path] of [
      [WORKSPACE_ROOT_REPO_ID, 'notes.json'],
      [WORKSPACE_ROOT_REPO_ID, 'missing.md'],
      ['no-such-repo', 'docs/CORE.md'],
    ]) {
      const refusal: unknown = await dispatcher
        .instruction(
          'core.plan.import',
          { scope: imports, repoId, path },
          caller(`import-path-${repoId}-${path}`),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refusal).toMatchObject({
        payload: {
          kind: 'invalid_argument',
          code: 'core.plan.importPath',
          details: { reason: 'IMPORT_PATH' },
        },
      });
      expect(
        JSON.stringify(
          refusal && typeof refusal === 'object' && 'payload' in refusal
            ? refusal.payload
            : null,
        ),
      ).not.toContain(root);
    }
    // A path that leaves the worktree never reaches the handler.
    await expect(
      dispatcher.instruction(
        'core.plan.import',
        { ...params, path: '../outside.md' },
        caller('import-path-escape'),
      ),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(await storedIds()).toEqual(before);
    expect(broadcasts).toEqual([]);
  });

  it('checks the scope before it reads the import file', async () => {
    const { resolveWorktreeCwd } = await import('../lib/resolve-worktree');
    const viewer = {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: WORKTREE_ID,
    };
    const cowork = { projectId: COWORK_ID, worktreeId: WORKTREE_ID };
    // A directory where the file would be: reading it fails as importPath,
    // so only a scope check that runs first answers the scope's refusal.
    for (const scoped of [viewer, cowork])
      mkdirSync(
        join(
          resolveWorktreeCwd(scoped.projectId, scoped.worktreeId),
          'SCOPE-FIRST.md',
        ),
        { recursive: true },
      );
    await expect(
      dispatcher.instruction(
        'core.plan.import',
        {
          scope: viewer,
          repoId: WORKSPACE_ROOT_REPO_ID,
          path: 'SCOPE-FIRST.md',
        },
        caller('import-viewer'),
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'permission_denied',
        code: 'core.plan.readOnlyScope',
      },
    });
    await expect(
      dispatcher.instruction(
        'core.plan.import',
        {
          scope: cowork,
          repoId: WORKSPACE_ROOT_REPO_ID,
          path: 'SCOPE-FIRST.md',
        },
        caller('import-cowork'),
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'core.plan.unsupportedScope',
      },
    });
    expect(broadcasts).toEqual([]);
  });

  // Behaviour changes of PR 5a on the import channel, pinned deliberately.
  it('refuses an import path that leaves the worktree and comes back (PR 5a change)', async () => {
    const before = await storedIds();
    await expect(
      invoke(IPC_CHANNELS.trackedPlansImport, {
        ...imports,
        filePath: `../${imports.worktreeId}/docs/CORE.md`,
        repoId: WORKSPACE_ID,
      }),
    ).rejects.toThrow('Plan import path must stay inside the worktree.');
    expect(await storedIds()).toEqual(before);
  });

  it('refuses an import file name with a backslash before dispatch (PR 5a change)', async () => {
    const before = await storedIds();
    await expect(
      invoke(IPC_CHANNELS.trackedPlansImport, {
        ...imports,
        filePath: 'docs/Q1\\Review.md',
        repoId: WORKSPACE_ID,
      }),
    ).rejects.toThrow("Plan import paths can't contain a backslash.");
    expect(dispatched()).toEqual([]);
    expect(await storedIds()).toEqual(before);
  });

  it('refuses an import file name with a drive-like prefix before dispatch (PR 5a change)', async () => {
    const before = await storedIds();
    await expect(
      invoke(IPC_CHANNELS.trackedPlansImport, {
        ...imports,
        filePath: 'A: Plan.md',
        repoId: WORKSPACE_ID,
      }),
    ).rejects.toThrow(
      'Plan import paths must be plain relative paths inside the worktree.',
    );
    expect(dispatched()).toEqual([]);
    expect(await storedIds()).toEqual(before);
  });

  it('still imports a nested file name with spaces, which the portable path allows', async () => {
    mkdirSync(join(importRoot, 'docs', 'My Plans'), { recursive: true });
    writeFileSync(
      join(importRoot, 'docs', 'My Plans', 'Q1 review.md'),
      '# Q1 review',
    );
    const before = await storedIds();
    const response = await invoke<{ plan: TrackedPlanData | null }>(
      IPC_CHANNELS.trackedPlansImport,
      {
        ...imports,
        filePath: 'docs/My Plans/Q1 review.md',
        repoId: WORKSPACE_ID,
      },
    );
    expect(dispatched().map(({ name }) => name)).toEqual(['core.plan.import']);
    const plan = must(response.plan);
    expect(plan).toMatchObject({
      title: 'Q1 review',
      sourceFilePath: 'docs/My Plans/Q1 review.md',
    });
    expect((await storedIds()).sort()).toEqual([...before, plan.id].sort());
  });

  it('answers a missing import file in a recipient or cowork scope with the scope refusal (PR 5a change)', async () => {
    for (const [projectId, message] of [
      [
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
        'Shared-container recipient workspaces are read-only',
      ],
      [
        COWORK_ID,
        `Tracked plans are not available for cowork project ${COWORK_ID}`,
      ],
    ])
      await expect(
        invoke(IPC_CHANNELS.trackedPlansImport, {
          projectId,
          worktreeId: WORKTREE_ID,
          filePath: 'MISSING-SCOPE.md',
          repoId: WORKSPACE_ROOT_REPO_ID,
        }),
      ).rejects.toThrow(message);
  });
});

// CAN-4165 PR 5b: the detected-plans channels project core.plan.detected.*,
// which the desktop dispatcher serves over the existing detected-plans
// writer. The detection case above pins the channels' answers; these pin the
// operations they dispatch, their grants, typed refusals, replay, that the
// scope is checked before anything is read, and the channel changes the move
// makes on purpose.
describe('detected plans on core.plan (CAN-4165 PR 5b)', () => {
  type DetectedEntry = { id: string; sourceFilePath: string; status: string };
  const VIEWER = {
    projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
    worktreeId: WORKTREE_ID,
  };
  const COWORK = { projectId: COWORK_ID, worktreeId: WORKTREE_ID };
  const at = (
    worktreeId: string,
  ): { projectId: string; worktreeId: string } => ({
    projectId: WORKSPACE_ID,
    worktreeId,
  });
  const caller = (
    key: string,
    grants: CanopyCallerDescriptor['grants'] = ['core.plan.write'],
  ): {
    caller: CanopyCallerDescriptor;
    metadata: { idempotencyKey: string };
  } => ({
    caller: { ...RENDERER, grants },
    metadata: { idempotencyKey: key },
  });
  const reader = (
    grants: CanopyCallerDescriptor['grants'] = ['core.plan.read'],
  ): { caller: CanopyCallerDescriptor } => ({
    caller: { ...RENDERER, grants },
  });
  // Parses, but no reader supports it: every mutation refuses it.
  const DAMAGED = '{"version":99,"entries":[]}';
  let detectedFile: (scoped: {
    projectId: string;
    worktreeId: string;
  }) => string;

  function writeDetected(
    scoped: { projectId: string; worktreeId: string },
    raw: string,
  ): string {
    const file = detectedFile(scoped);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, raw);
    return file;
  }

  function refusal(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => null,
      (error: unknown) => error,
    );
  }

  beforeAll(async () => {
    const { resolveDetectedPlansFilePath } =
      await import('../lib/resolve-worktree');
    detectedFile = (scoped): string =>
      resolveDetectedPlansFilePath(scoped.projectId, scoped.worktreeId);
  });

  it('serves each detected-plans channel through core.plan.detected with only the grant it needs, and answers as before', async () => {
    const scoped = at('golden-wt-detected-ipc');
    const scanned = await invoke<{
      entries: DetectedEntry[];
      newlyDetected: DetectedEntry[];
    }>(IPC_CHANNELS.detectedPlansScan, {
      ...scoped,
      chatId: 'golden-chat-5b',
      candidatePaths: ['plan.md', 'src/index.ts'],
    });
    const entryId = must(scanned.newlyDetected[0]).id;
    const listed = await invoke<DetectedEntry[]>(
      IPC_CHANNELS.detectedPlansList,
      scoped,
    );
    const updated = await invoke<DetectedEntry[]>(
      IPC_CHANNELS.detectedPlansUpdate,
      { ...scoped, entryId, status: 'dismissed' },
    );
    expect(dispatched().sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      [
        ['core.plan.detected.list', 'core.plan.read'],
        ['core.plan.detected.scan', 'core.plan.write'],
        ['core.plan.detected.update', 'core.plan.write'],
      ].map(([name, grant]) => ({
        name,
        caller: { ...RENDERER, grants: [grant] },
      })),
    );
    expect(scanned.newlyDetected.map((entry) => entry.sourceFilePath)).toEqual([
      'plan.md',
    ]);
    expect(scanned.entries).toEqual(scanned.newlyDetected);
    expect(listed).toEqual(scanned.entries);
    expect(updated.map((entry) => entry.status)).toEqual(['dismissed']);
    // The main window hears of the scan's additions and of the update, as it
    // always did; no other window does.
    expect(windowSends).toEqual([
      {
        channel: IPC_CHANNELS.detectedPlansUpdated,
        payload: { ...scoped, entries: scanned.entries },
      },
      {
        channel: IPC_CHANNELS.detectedPlansUpdated,
        payload: { ...scoped, entries: updated },
      },
    ]);
    expect(broadcasts).toEqual([]);
  });

  it('scans and updates once per key, refuses a reused key with other parameters, and finds nothing new under another key', async () => {
    const scope = at('golden-wt-detected-keyed');
    const params = {
      scope,
      chatId: 'golden-chat-5b',
      candidatePaths: ['docs/plan.md'],
    };
    const first = await dispatcher.instruction(
      'core.plan.detected.scan',
      params,
      caller('detected-scan-1'),
    );
    const repeat = await dispatcher.instruction(
      'core.plan.detected.scan',
      params,
      caller('detected-scan-1'),
    );
    expect(repeat).toEqual(first);
    expect(first.newlyDetected.map((entry) => entry.sourceFilePath)).toEqual([
      'docs/plan.md',
    ]);
    await expect(
      dispatcher.instruction(
        'core.plan.detected.scan',
        { ...params, candidatePaths: ['other/plan.md'] },
        caller('detected-scan-1'),
      ),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
    const again = await dispatcher.instruction(
      'core.plan.detected.scan',
      params,
      caller('detected-scan-2'),
    );
    expect(again).toEqual({ detected: first.detected, newlyDetected: [] });
    const update = {
      scope,
      entryId: must(first.newlyDetected[0]).id,
      bannerSeen: true,
    };
    const updated = await dispatcher.instruction(
      'core.plan.detected.update',
      update,
      caller('detected-update-1'),
    );
    await expect(
      dispatcher.instruction(
        'core.plan.detected.update',
        update,
        caller('detected-update-1'),
      ),
    ).resolves.toEqual(updated);
    await expect(
      dispatcher.instruction(
        'core.plan.detected.update',
        { ...update, bannerSeen: false },
        caller('detected-update-1'),
      ),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
    await expect(
      dispatcher.query('core.plan.detected.list', { scope }, reader()),
    ).resolves.toEqual(updated);
    // A write from another binding reaches every window (CAN-4165 PR 7c):
    // the scan that stored an entry and the first update, never a replay or
    // a scan that stored nothing.
    expect(broadcasts).toEqual([
      {
        channel: IPC_CHANNELS.detectedPlansUpdated,
        payload: { ...scope, entries: first.detected },
      },
      {
        channel: IPC_CHANNELS.detectedPlansUpdated,
        payload: { ...scope, entries: updated.detected },
      },
    ]);
  });

  it("replays a detected update's lost reply after 40 other updates landed, without re-applying it over a newer status (PR 7c)", async () => {
    // The relay admits 32 calls, so a same-key retry can follow many other
    // committed writes; its stored outcome must still be there.
    const scope = at('golden-wt-detected-replay-window');
    const scanned = await dispatcher.instruction(
      'core.plan.detected.scan',
      { scope, chatId: 'golden-chat-5b', candidatePaths: ['docs/plan.md'] },
      caller('detected-window-scan'),
    );
    const entryId = must(scanned.newlyDetected[0]).id;
    const lost = { scope, entryId, status: 'dismissed' as const };
    const first = await dispatcher.instruction(
      'core.plan.detected.update',
      lost,
      caller('detected-window-lost'),
    );
    for (let index = 0; index < 39; index += 1)
      await dispatcher.instruction(
        'core.plan.detected.update',
        { scope, entryId, bannerSeen: index % 2 === 0 },
        caller(`detected-window-other-${index}`),
      );
    await dispatcher.instruction(
      'core.plan.detected.update',
      { scope, entryId, status: 'imported', importedPlanId: 'plan-imported' },
      caller('detected-window-import'),
    );
    await expect(
      dispatcher.instruction(
        'core.plan.detected.update',
        lost,
        caller('detected-window-lost'),
      ),
    ).resolves.toEqual(first);
    const saved = await dispatcher.query(
      'core.plan.detected.list',
      { scope },
      reader(),
    );
    expect(saved.detected.map((entry) => entry.status)).toEqual(['imported']);
  });

  it('keeps only the 256 most recent scan and update outcomes for replay (16 before PR 7c)', async () => {
    const scope = at('golden-wt-detected-evict');
    const scan = {
      scope,
      chatId: 'golden-chat-5b',
      candidatePaths: ['docs/plan.md'],
    };
    const first = await dispatcher.instruction(
      'core.plan.detected.scan',
      scan,
      caller('detected-evict-scan-0'),
    );
    const update = {
      scope,
      entryId: must(first.newlyDetected[0]).id,
      bannerSeen: true,
    };
    for (let index = 0; index <= 256; index += 1) {
      if (index > 0)
        await dispatcher.instruction(
          'core.plan.detected.scan',
          scan,
          caller(`detected-evict-scan-${index}`),
        );
      await dispatcher.instruction(
        'core.plan.detected.update',
        update,
        caller(`detected-evict-update-${index}`),
      );
    }
    // The newest keys still refuse other parameters; the oldest, now 257th,
    // are forgotten and run again.
    await expect(
      dispatcher.instruction(
        'core.plan.detected.scan',
        { ...scan, candidatePaths: ['other/plan.md'] },
        caller('detected-evict-scan-256'),
      ),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
    await expect(
      dispatcher.instruction(
        'core.plan.detected.scan',
        { ...scan, candidatePaths: ['other/plan.md'] },
        caller('detected-evict-scan-0'),
      ),
    ).resolves.toHaveProperty('newlyDetected');
    await expect(
      dispatcher.instruction(
        'core.plan.detected.update',
        { ...update, bannerSeen: false },
        caller('detected-evict-update-0'),
      ),
    ).resolves.toHaveProperty('detected');
  });

  it('does not detect a file the portable path cannot name, and still detects one beside it (PR 5b change)', async () => {
    const scope = at('golden-wt-detected-unportable');
    const scanned = await dispatcher.instruction(
      'core.plan.detected.scan',
      {
        scope,
        chatId: 'golden-chat-5b',
        candidatePaths: [
          'docs/superpowers/specs/Q1\\Review.md',
          'C:notes/plan.md',
        ],
      },
      caller('detected-unportable-1'),
    );
    expect(scanned).toEqual({ detected: [], newlyDetected: [] });
    expect(existsSync(detectedFile(scope))).toBe(false);
    const beside = await dispatcher.instruction(
      'core.plan.detected.scan',
      {
        scope,
        chatId: 'golden-chat-5b',
        candidatePaths: [
          'docs/superpowers/specs/Q1 Review.md',
          'notes/plan.md',
        ],
      },
      caller('detected-unportable-2'),
    );
    expect(
      beside.newlyDetected.map((entry) => entry.sourceFilePath).sort(),
    ).toEqual(['docs/superpowers/specs/Q1 Review.md', 'notes/plan.md']);
  });

  it('refuses a detected-plans file it cannot read as damaged state, and leaves it as it is', async () => {
    const scope = at('golden-wt-detected-unreadable');
    // A missing file is still an empty list, not damaged.
    await expect(
      dispatcher.instruction(
        'core.plan.detected.update',
        { scope, entryId: 'entry-1', status: 'dismissed' },
        caller('detected-unreadable-missing'),
      ),
    ).resolves.toEqual({ detected: [] });
    const scanned = await dispatcher.instruction(
      'core.plan.detected.scan',
      { scope, chatId: 'golden-chat-5b', candidatePaths: ['docs/plan.md'] },
      caller('detected-unreadable-scan-1'),
    );
    const entryId = must(scanned.newlyDetected[0]).id;
    const file = detectedFile(scope);
    const before = readFileSync(file, 'utf8');
    chmodSync(file, 0o000);
    try {
      for (const call of [
        dispatcher.instruction(
          'core.plan.detected.scan',
          { scope, chatId: 'golden-chat-5b', candidatePaths: ['x/plan.md'] },
          caller('detected-unreadable-scan-2'),
        ),
        dispatcher.instruction(
          'core.plan.detected.update',
          { scope, entryId, status: 'dismissed' },
          caller('detected-unreadable-update'),
        ),
      ])
        await expect(call).rejects.toMatchObject({
          payload: {
            kind: 'failed_precondition',
            code: 'core.plan.damagedState',
          },
        });
      // The channel keeps the writer's own error, as before.
      await expect(
        invoke(IPC_CHANNELS.detectedPlansUpdate, {
          ...scope,
          entryId,
          status: 'dismissed',
        }),
      ).rejects.toThrow('EACCES');
    } finally {
      chmodSync(file, 0o600);
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('answers a save the writer cannot make as internal, not damaged state, and leaves the file as it is', async () => {
    const scope = at('golden-wt-detected-unwritable');
    const scanned = await dispatcher.instruction(
      'core.plan.detected.scan',
      { scope, chatId: 'golden-chat-5b', candidatePaths: ['docs/plan.md'] },
      caller('detected-unwritable-scan'),
    );
    const entryId = must(scanned.newlyDetected[0]).id;
    const file = detectedFile(scope);
    const before = readFileSync(file, 'utf8');
    // Readable but not writable: the save fails, which is not damaged state.
    // The directory is read-only, since a save installs a sibling (PR 7c).
    chmodSync(dirname(file), 0o555);
    try {
      await expect(
        dispatcher.instruction(
          'core.plan.detected.update',
          { scope, entryId, status: 'dismissed' },
          caller('detected-unwritable-update'),
        ),
      ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    } finally {
      chmodSync(dirname(file), 0o755);
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it("announces two writers' detected-plan changes in commit order, so the last push is the saved list (PR 7c)", async () => {
    // The main window applies pushes only, so they must arrive in the order
    // the writes committed: two relay writes, and a channel write beside a
    // relay write.
    const scope = at('golden-wt-detected-order');
    const scanned = await dispatcher.instruction(
      'core.plan.detected.scan',
      {
        scope,
        chatId: 'golden-chat-5b',
        candidatePaths: ['a/plan.md', 'b/plan.md', 'c/plan.md'],
      },
      caller('detected-order-scan'),
    );
    const [first, second, third] = scanned.newlyDetected.map((entry) =>
      must(entry),
    );
    const announced = (): unknown[] =>
      pushes
        .filter(
          (push) =>
            push.channel === IPC_CHANNELS.detectedPlansUpdated &&
            JSON.stringify(push.payload).includes(scope.worktreeId),
        )
        .map((push) => push.payload);
    const saved = async (): Promise<unknown> => ({
      ...scope,
      entries: (
        await dispatcher.query('core.plan.detected.list', { scope }, reader())
      ).detected,
    });
    pushes.length = 0;
    await Promise.all([
      dispatcher.instruction(
        'core.plan.detected.update',
        { scope, entryId: must(first).id, status: 'dismissed' },
        caller('detected-order-update-1'),
      ),
      dispatcher.instruction(
        'core.plan.detected.update',
        { scope, entryId: must(second).id, bannerSeen: true },
        caller('detected-order-update-2'),
      ),
    ]);
    expect(announced()).toHaveLength(2);
    expect(announced().at(-1)).toEqual(await saved());
    pushes.length = 0;
    await Promise.all([
      invoke(IPC_CHANNELS.detectedPlansUpdate, {
        ...scope,
        entryId: must(third).id,
        status: 'dismissed',
      }),
      dispatcher.instruction(
        'core.plan.detected.update',
        { scope, entryId: must(first).id, bannerSeen: true },
        caller('detected-order-update-3'),
      ),
    ]);
    expect(announced()).toHaveLength(2);
    expect(announced().at(-1)).toEqual(await saved());
  });

  it('keeps the last saved detected plans when a save fails partway, and leaves no temporary file (PR 7c)', async () => {
    const scope = at('golden-wt-detected-torn');
    const scanned = await dispatcher.instruction(
      'core.plan.detected.scan',
      { scope, chatId: 'golden-chat-5b', candidatePaths: ['docs/plan.md'] },
      caller('detected-torn-scan'),
    );
    const entryId = must(scanned.newlyDetected[0]).id;
    const file = detectedFile(scope);
    const before = readFileSync(file, 'utf8');
    const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
    const failure = Object.assign(new Error('EIO: i/o error, write'), {
      code: 'EIO',
    });
    // The disk fails mid-save: a write in place leaves half the file behind,
    // and a write to a sibling never gets renamed over it.
    jest.mocked(writeFile).mockImplementation(async (path, data) => {
      if (path !== file) return actual.writeFile(path, data);
      await actual.writeFile(
        file,
        typeof data === 'string' ? data.slice(0, 10) : '',
      );
      throw failure;
    });
    jest.mocked(rename).mockImplementation(async (from, to) => {
      if (to !== file) return actual.rename(from, to);
      throw failure;
    });
    try {
      await expect(
        dispatcher.instruction(
          'core.plan.detected.update',
          { scope, entryId, status: 'dismissed' },
          caller('detected-torn-update'),
        ),
      ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    } finally {
      jest.mocked(writeFile).mockImplementation(actual.writeFile);
      jest.mocked(rename).mockImplementation(actual.rename);
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
    // Each save installs a new file, owner-only like the rest of the data root.
    if (process.platform !== 'win32')
      expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(
      dispatcher.query('core.plan.detected.list', { scope }, reader()),
    ).resolves.toEqual({ detected: scanned.detected });
    const siblings = await readdir(dirname(file));
    expect(siblings.filter((name) => name.includes(basename(file)))).toEqual([
      basename(file),
    ]);
  });

  it('refuses a directory where the detected-plans file belongs as damaged state', async () => {
    const blocked = at('golden-wt-detected-directory');
    mkdirSync(detectedFile(blocked), { recursive: true });
    await expect(
      dispatcher.instruction(
        'core.plan.detected.scan',
        {
          scope: blocked,
          chatId: 'golden-chat-5b',
          candidatePaths: ['docs/plan.md'],
        },
        caller('detected-directory-scan'),
      ),
    ).rejects.toMatchObject({
      payload: { kind: 'failed_precondition', code: 'core.plan.damagedState' },
    });
  });

  it('answers a detection rule the matcher cannot compile as internal, not damaged state', async () => {
    const scope = at('golden-wt-detected-bad-rule');
    await dispatcher.instruction(
      'core.plan.detected.scan',
      { scope, chatId: 'golden-chat-5b', candidatePaths: ['docs/plan.md'] },
      caller('detected-bad-rule-1'),
    );
    const file = detectedFile(scope);
    const before = readFileSync(file, 'utf8');
    const { resolveWorktreeCwd } = await import('../lib/resolve-worktree');
    const { getPrimaryProjectConfigFilePath } =
      await import('../lib/canopy-json');
    const config = getPrimaryProjectConfigFilePath(
      resolveWorktreeCwd(scope.projectId, scope.worktreeId),
    );
    mkdirSync(join(config, '..'), { recursive: true });
    // Longer than the matcher compiles, which it refuses with a SyntaxError.
    writeFileSync(
      config,
      JSON.stringify({
        version: 1,
        planDetection: {
          rules: [
            {
              id: 'too-long',
              kind: 'include',
              pattern: `docs/${'x'.repeat(70_000)}.md`,
            },
          ],
        },
      }),
    );
    try {
      await expect(
        dispatcher.instruction(
          'core.plan.detected.scan',
          { scope, chatId: 'golden-chat-5b', candidatePaths: ['x/plan.md'] },
          caller('detected-bad-rule-2'),
        ),
      ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    } finally {
      rmSync(config, { force: true });
    }
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('answers only the detections it stored when two scans race', async () => {
    const scope = at('golden-wt-detected-race');
    const scan = {
      scope,
      chatId: 'golden-chat-5b',
      candidatePaths: ['docs/plan.md'],
    };
    const scans = await Promise.all([
      dispatcher.instruction(
        'core.plan.detected.scan',
        scan,
        caller('detected-race-1'),
      ),
      dispatcher.instruction(
        'core.plan.detected.scan',
        scan,
        caller('detected-race-2'),
      ),
    ]);
    const stored = (
      await dispatcher.query('core.plan.detected.list', { scope }, reader())
    ).detected.map((entry) => entry.id);
    expect(stored).toHaveLength(1);
    expect(
      scans.flatMap((answer) => answer.newlyDetected.map((entry) => entry.id)),
    ).toEqual(stored);
  });

  it('refuses the detected-plan operations without their grants and writes nothing', async () => {
    const scope = at('golden-wt-detected-grants');
    const { newlyDetected } = await dispatcher.instruction(
      'core.plan.detected.scan',
      { scope, chatId: 'golden-chat-5b', candidatePaths: ['plan.md'] },
      caller('detected-grants-seed'),
    );
    const before = readFileSync(detectedFile(scope), 'utf8');
    await expect(
      dispatcher.query('core.plan.detected.list', { scope }, reader([])),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    for (const grants of [
      [],
      ['core.plan.read'],
    ] satisfies CanopyCallerDescriptor['grants'][]) {
      await expect(
        dispatcher.instruction(
          'core.plan.detected.scan',
          { scope, chatId: 'golden-chat-5b', candidatePaths: ['docs/plan.md'] },
          caller(`detected-grants-scan-${grants.length}`, grants),
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
      await expect(
        dispatcher.instruction(
          'core.plan.detected.update',
          { scope, entryId: must(newlyDetected[0]).id, status: 'dismissed' },
          caller(`detected-grants-update-${grants.length}`, grants),
        ),
      ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    }
    expect(readFileSync(detectedFile(scope), 'utf8')).toBe(before);
  });

  it('refuses a recipient scope, a cowork scope and a damaged file as typed errors, and lists none for them', async () => {
    const damaged = at('golden-wt-detected-damaged');
    const file = writeDetected(damaged, DAMAGED);
    const scan = (scope: {
      projectId: string;
      worktreeId: string;
    }): Promise<unknown> =>
      refusal(
        dispatcher.instruction(
          'core.plan.detected.scan',
          { scope, chatId: 'golden-chat-5b', candidatePaths: ['plan.md'] },
          caller(`detected-typed-scan-${scope.projectId}-${scope.worktreeId}`),
        ),
      );
    const update = (scope: {
      projectId: string;
      worktreeId: string;
    }): Promise<unknown> =>
      refusal(
        dispatcher.instruction(
          'core.plan.detected.update',
          { scope, entryId: 'entry-1', status: 'dismissed' },
          caller(
            `detected-typed-update-${scope.projectId}-${scope.worktreeId}`,
          ),
        ),
      );
    for (const call of [scan, update]) {
      await expect(call(VIEWER)).resolves.toMatchObject({
        payload: {
          kind: 'permission_denied',
          code: 'core.plan.readOnlyScope',
        },
      });
      await expect(call(COWORK)).resolves.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.plan.unsupportedScope',
        },
      });
      await expect(call(damaged)).resolves.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.plan.damagedState',
          details: { reason: 'DAMAGED_STATE' },
        },
      });
    }
    expect(readFileSync(file, 'utf8')).toBe(DAMAGED);
    for (const scope of [COWORK, damaged])
      await expect(
        dispatcher.query('core.plan.detected.list', { scope }, reader()),
      ).resolves.toEqual({ detected: [] });
    // Through the channel a damaged scan keeps the refusal it always had.
    await expect(
      invoke(IPC_CHANNELS.detectedPlansScan, {
        ...damaged,
        chatId: 'golden-chat-5b',
        candidatePaths: ['plan.md'],
      }),
    ).rejects.toThrow('Invalid or unsupported detected-plan state');
    expect(readFileSync(file, 'utf8')).toBe(DAMAGED);
    expect(windowSends).toEqual([]);
  });

  it('checks the scope before it reads the rules or the detected plans', async () => {
    // A damaged file where the recipient's detected plans would be: reading
    // it first answers damagedState, so only a scope check that runs first
    // answers the recipient's refusal.
    const file = writeDetected(VIEWER, DAMAGED);
    // The rules and the display read swallow failures, so only a spy shows
    // they never run for a refused scope.
    const rules = jest.spyOn(
      await import('../lib/plan-detection-config'),
      'resolveWorktreePlanDetectionRules',
    );
    const persistence = await import('../lib/detected-plan-persistence');
    const reads = jest.spyOn(persistence, 'readDetectedPlans');
    const updates = jest.spyOn(persistence, 'updateDetectedPlan');
    try {
      await expect(
        dispatcher.instruction(
          'core.plan.detected.scan',
          {
            scope: VIEWER,
            chatId: 'golden-chat-5b',
            candidatePaths: ['plan.md'],
          },
          caller('detected-scope-first-scan'),
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'permission_denied',
          code: 'core.plan.readOnlyScope',
        },
      });
      await expect(
        dispatcher.instruction(
          'core.plan.detected.update',
          { scope: VIEWER, entryId: 'entry-1', status: 'dismissed' },
          caller('detected-scope-first-update'),
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'permission_denied',
          code: 'core.plan.readOnlyScope',
        },
      });
      expect(rules).not.toHaveBeenCalled();
      expect(reads).not.toHaveBeenCalled();
      expect(updates).not.toHaveBeenCalled();
    } finally {
      rules.mockRestore();
      reads.mockRestore();
      updates.mockRestore();
    }
    expect(readFileSync(file, 'utf8')).toBe(DAMAGED);
    rmSync(file, { force: true });
  });

  it('answers an update for an entry the scope does not have with its unchanged list', async () => {
    const scope = at('golden-wt-detected-absent');
    const { detected } = await dispatcher.instruction(
      'core.plan.detected.scan',
      { scope, chatId: 'golden-chat-5b', candidatePaths: ['plan.md'] },
      caller('detected-absent-seed'),
    );
    await expect(
      dispatcher.instruction(
        'core.plan.detected.update',
        { scope, entryId: 'no-such-entry', status: 'dismissed' },
        caller('detected-absent-update'),
      ),
    ).resolves.toEqual({ detected });
  });

  // Channel changes of PR 5b, pinned deliberately.
  it('refuses a recipient scan, and the banner update of a recipient entry, with the read-only message (PR 5b change)', async () => {
    const entry = {
      id: 'recipient-entry',
      sourceRepoId: WORKSPACE_ROOT_REPO_ID,
      sourceFilePath: 'plan.md',
      status: 'detected',
      bannerSeen: false,
      detectedInChatId: 'golden-chat-5b',
      detectedAt: '2026-11-23T00:00:00.000Z',
    };
    const raw = JSON.stringify({ version: 1, entries: [entry] }, null, 2);
    const file = writeDetected(VIEWER, raw);
    // The banner's import and dismiss both update the entry's status.
    for (const status of ['imported', 'dismissed'])
      await expect(
        invoke(IPC_CHANNELS.detectedPlansUpdate, {
          ...VIEWER,
          entryId: entry.id,
          status,
          ...(status === 'imported' ? { importedPlanId: 'plan-1' } : {}),
        }),
      ).rejects.toThrow('Shared-container recipient workspaces are read-only');
    await expect(
      invoke(IPC_CHANNELS.detectedPlansScan, {
        ...VIEWER,
        chatId: 'golden-chat-5b',
        candidatePaths: ['docs/plan.md'],
      }),
    ).rejects.toThrow('Shared-container recipient workspaces are read-only');
    expect(readFileSync(file, 'utf8')).toBe(raw);
    expect(windowSends).toEqual([]);
    rmSync(file, { force: true });
  });

  it('answers a cowork scan with nothing before dispatching it (PR 5b change)', async () => {
    await expect(
      invoke(IPC_CHANNELS.detectedPlansScan, {
        ...COWORK,
        chatId: 'golden-chat-5b',
        candidatePaths: ['plan.md'],
      }),
    ).resolves.toEqual({ entries: [], newlyDetected: [] });
    expect(dispatched()).toEqual([]);
    expect(windowSends).toEqual([]);
  });

  it('drops candidate paths that cannot match before dispatch, and lets the operation refuse too many (PR 5b change)', async () => {
    const scoped = at('golden-wt-detected-paths');
    const scanned = await invoke<{ newlyDetected: DetectedEntry[] }>(
      IPC_CHANNELS.detectedPlansScan,
      {
        ...scoped,
        chatId: 'golden-chat-5b',
        candidatePaths: ['', `${'x'.repeat(4_090)}/plan.md`, 'plan.md'],
      },
    );
    expect(scanned.newlyDetected.map((entry) => entry.sourceFilePath)).toEqual([
      'plan.md',
    ]);
    const scans = dispatcherCalls
      .calls()
      .filter(([name]) => name === 'core.plan.detected.scan');
    expect(scans).toHaveLength(1);
    expect(must(scans[0])[1]).toMatchObject({ candidatePaths: ['plan.md'] });
    await expect(
      invoke(IPC_CHANNELS.detectedPlansScan, {
        ...scoped,
        chatId: 'golden-chat-5b',
        candidatePaths: Array.from({ length: 10_001 }, () => 'src/index.ts'),
      }),
    ).rejects.toThrow('Invalid operation parameters.');
  });
});

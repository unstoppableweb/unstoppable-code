// CAN-4165 golden: the tracked plan lifecycle as desktop serves it, captured
// before core.plan took ownership. It drives the real `tracked-plans:*` IPC
// handlers, which since PR 3b-2 dispatch `core.plan.*` on a real desktop
// dispatcher and plan persistence on a temporary data root; only IPC
// registration and window sends are replaced. A change here is a behaviour
// change: re-record deliberately with
// `pnpm test <this file> -u` and review the snapshot diff.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type TrackedPlanData,
  type TrackedPlansUpdatedEvent,
} from '@canopy/desktop-shared/types';
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
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { controllerMayInvoke } from '../remote-control/host/controller-profile';
import { relayAllows } from '../canopy-runtime/renderer-relay/surface-allowlist';
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
const windowSends: { channel: string; payload: unknown }[] = [];
jest.mock('../lib/main-process-logging', () => ({
  ...jest.requireActual<typeof MainProcessLogging>(
    '../lib/main-process-logging',
  ),
  logMainProcessWarn: jest.fn(),
}));
const broadcasts: { channel: string; payload: unknown }[] = [];
jest.mock('../lib/window-send', () => ({
  sendToWindow: (_window: unknown, channel: string, payload: unknown): void => {
    windowSends.push({ channel, payload });
  },
  sendToAllWindows: (channel: string, payload: unknown): void => {
    broadcasts.push({ channel, payload });
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
const originalDataDir = process.env.CANOPY_DATA_DIR;

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
  registerDetectedPlansHandlers(() => null);
  persistence = await import('../lib/plan-persistence');
});

afterAll(async () => {
  await dispatcher.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
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
      query: ['core.plan.list', 'core.plan.get'],
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

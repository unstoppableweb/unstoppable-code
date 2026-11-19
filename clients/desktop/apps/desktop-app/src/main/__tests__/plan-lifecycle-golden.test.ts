// CAN-4165 golden: the tracked plan lifecycle as desktop serves it, captured
// before core.plan took ownership. It drives the real `tracked-plans:*` IPC
// handlers, which since PR 3b-2 dispatch `core.plan.*` on a real desktop
// dispatcher and plan persistence on a temporary data root; only IPC
// registration and window sends are replaced. A change here is a behaviour
// change: re-record deliberately with
// `pnpm test <this file> -u` and review the snapshot diff.
import {
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
} from '@canopy/desktop-shared/types';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type * as PlanPersistence from '../lib/plan-persistence';
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

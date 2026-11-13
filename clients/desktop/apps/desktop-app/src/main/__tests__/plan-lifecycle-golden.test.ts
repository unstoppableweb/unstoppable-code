// CAN-4165 golden: the tracked plan lifecycle as desktop serves it today,
// captured before core.plan takes ownership. It drives the real
// `tracked-plans:*` IPC handlers, plan persistence and the Portal publisher
// on a temporary data root; only IPC registration, window sends and the
// Portal emitter are replaced. A change here is a behaviour change: re-record
// deliberately with `pnpm test <this file> -u` and review the snapshot diff.
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
import type * as PlanPersistence from '../lib/plan-persistence';

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
jest.mock('../lib/window-send', () => ({
  sendToWindow: (_window: unknown, channel: string, payload: unknown): void => {
    windowSends.push({ channel, payload });
  },
}));
const portalEvents: { kind: 'upsert' | 'remove'; event: unknown }[] = [];
jest.mock('../services/portal-feature-event-service', () => ({
  emitPortalFeatureUpsert: (event: unknown): void => {
    portalEvents.push({ kind: 'upsert', event });
  },
  emitPortalFeatureRemove: (event: unknown): void => {
    portalEvents.push({ kind: 'remove', event });
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
const originalDataDir = process.env.CANOPY_DATA_DIR;

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
  const { registerPlansHandlers } = await import('../ipc/plans');
  registerPlansHandlers(() => null);
  const { registerDetectedPlansHandlers } =
    await import('../ipc/detected-plans');
  registerDetectedPlansHandlers(() => null);
  persistence = await import('../lib/plan-persistence');
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  windowSends.length = 0;
  portalEvents.length = 0;
});

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
      stable({ created, updated, retitled, portalEvents, windowSends }),
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

  it('publishes a direct persistence write to the Portal through the write hook', async () => {
    const plan = await persistence.createTrackedPlan({
      ...scope,
      source: 'claude',
      content: '# Agent plan\n\nWritten by ExitPlanMode.',
    });
    expect(windowSends).toEqual([]);
    expect(
      portalEvents.filter((e) => JSON.stringify(e).includes(plan.id)),
    ).toHaveLength(1);
    expect(stable(portalEvents)).toMatchSnapshot();
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

  // Pinned so CAN-4165 PR 3 changes it on purpose: create accepts a source
  // the reader does not, and the reader then treats the whole worktree's
  // plans file as empty. Core should refuse the write instead.
  it('loses every plan in the worktree when one is created with an unknown source', async () => {
    const other = {
      projectId: WORKSPACE_ID,
      worktreeId: 'golden-wt-unknown-source',
    };
    await invoke(IPC_CHANNELS.trackedPlansCreate, {
      ...other,
      source: 'claude',
      content: '# Kept?',
    });
    expect(
      await invoke<TrackedPlanData[]>(IPC_CHANNELS.trackedPlansList, other),
    ).toHaveLength(1);
    const unknown = await invoke<TrackedPlanData>(
      IPC_CHANNELS.trackedPlansCreate,
      {
        ...other,
        source: 'manual',
        content: '# Unknown source',
      },
    );
    expect(unknown.source).toBe('manual');
    expect(
      await invoke<TrackedPlanData[]>(IPC_CHANNELS.trackedPlansList, other),
    ).toEqual([]);
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

  it('deletes through IPC and publishes the removal', async () => {
    await invoke(IPC_CHANNELS.trackedPlansDelete, { ...scope, planId });
    await expect(
      invoke(IPC_CHANNELS.trackedPlansGet, { ...scope, planId }),
    ).resolves.toBeNull();
    expect(stable(portalEvents)).toMatchSnapshot();
  });
});

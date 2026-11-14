// CAN-4167 golden: plan diagram scheduling as desktop runs it today, captured
// before core.plan.diagram.generate takes it over. The scheduler and tracked
// plan persistence are real, on a temporary data root; the three diagram
// generators, helper-task bookkeeping and window sends are replaced, so each
// case controls when a generation settles. A change here is a behaviour
// change: re-record deliberately with `pnpm test <this file> -u` and review
// the snapshot diff.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLAN_DIAGRAM_SCHEMA_VERSION,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import type * as Scheduler from '../lib/plan-diagram-scheduler';
import type * as PlanPersistence from '../lib/plan-persistence';

jest.setTimeout(60_000);

const updates: string[] = [];
jest.mock('../lib/window-send', () => ({
  sendToWindow: (_window: unknown, channel: string): void => {
    updates.push(channel);
  },
  sendToAllWindows: (channel: string): void => {
    updates.push(channel);
  },
}));
interface Gate {
  release: () => void;
  promise: Promise<void>;
}
const gate = (): Gate => {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
};
let hold: Gate | null = null;
const calls: string[] = [];
const graph = {
  schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
  nodes: [],
  edges: [],
};
const logic = {
  schemaVersion: PLAN_DIAGRAM_SCHEMA_VERSION,
  current: { nodes: [], edges: [] },
  planned: { nodes: [], edges: [] },
  changes: [],
};
jest.mock('../lib/plan-diagram-generator', () => ({
  generateSequenceDiagram: async (): Promise<unknown> => {
    calls.push('sequence');
    if (hold) await hold.promise;
    return { value: graph, usage: undefined };
  },
  generateLogicDiffDiagram: async (): Promise<unknown> => {
    calls.push('logicDiff');
    if (hold) await hold.promise;
    return { value: logic, usage: undefined };
  },
  generateDataModelDiffDiagram: async (): Promise<unknown> => {
    calls.push('dataModelDiff');
    if (hold) await hold.promise;
    return { value: { applicable: false }, usage: undefined };
  },
}));
const helperTasks: string[] = [];
jest.mock('../lib/helper-observed-task', () => ({
  startObservedHelperTask: (task: { taskKey: string }): void => {
    helperTasks.push(`start ${task.taskKey}`);
  },
  finalizeObservedHelperTask: (taskKey: string, outcome: string): void => {
    helperTasks.push(`${outcome} ${taskKey}`);
  },
}));
jest.mock('../lib/helper-transcript-observer', () => ({
  createHelperTranscriptObserver: (): unknown => ({}),
}));

const WORKSPACE_ID = 'golden-diagrams';
const WORKTREE_ID = 'golden-wt';
const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };
const getWindow = (): null => null;

let root: string;
let scheduler: typeof Scheduler;
let persistence: typeof PlanPersistence;
let plan: TrackedPlanData;
const originalDataDir = process.env.CANOPY_DATA_DIR;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-diagram-golden-')));
  const dataDir = join(root, 'data');
  process.env.CANOPY_DATA_DIR = dataDir;
  mkdirSync(
    join(dataDir, 'workspaces', WORKSPACE_ID, 'worktrees', WORKTREE_ID),
    { recursive: true },
  );
  writeFileSync(
    join(dataDir, 'workspaces', WORKSPACE_ID, 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repoPath: join(root, 'repo'),
      repos: [],
    }),
  );
  // The app hydrates the model catalog at startup; the default diagram model
  // (haiku) resolves to the Claude harness once it is.
  const { initClaudeModels } = await import('@canopy/desktop-shared/types');
  initClaudeModels([{ id: 'haiku', label: 'Haiku' }]);
  const registry = await import('../lib/workspace-registry');
  registry.registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
  scheduler = await import('../lib/plan-diagram-scheduler');
  persistence = await import('../lib/plan-persistence');
  plan = await persistence.createTrackedPlan({
    ...scope,
    source: 'claude',
    content: '# Diagram golden\n\nCall the API, then render.',
  });
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  updates.length = 0;
  calls.length = 0;
  helperTasks.length = 0;
  hold = null;
});

// The real clock, captured before any case installs fake timers. Scheduler
// work finishes on the thread pool, so waits are measured in real time, not
// event-loop turns, which a slow runner can exhaust first.
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });
// Lets fire-and-forget scheduler work settle.
async function settle(): Promise<void> {
  await sleep(100);
}
// Waits until a fire-and-forget run has produced what a case expects, then
// lets its remaining writes and update event follow.
async function waitFor(done: () => boolean, what: string): Promise<void> {
  // Counted, not timed: fake timers also fake Date. 1,500 x 10 ms is 15 s.
  for (let i = 0; i < 1_500 && !done(); i += 1) await sleep(10);
  if (!done()) throw new Error(`Timed out waiting for ${what}`);
  await settle();
}
const finished = (count: number) => (): boolean =>
  helperTasks.filter((t) => t.startsWith('success ')).length >= count;

interface ArtifactSummary {
  status: string;
  derivedFromRevision: number;
  data: unknown;
}

async function diagrams(): Promise<unknown> {
  const current = await persistence.getTrackedPlan(
    WORKSPACE_ID,
    WORKTREE_ID,
    plan.id,
  );
  return Object.fromEntries(
    Object.entries(current?.diagrams ?? {}).map(
      ([kind, artifact]: [string, ArtifactSummary | undefined]) => [
        kind,
        artifact
          ? {
              status: artifact.status,
              derivedFromRevision: artifact.derivedFromRevision,
              hasData: artifact.data !== null,
            }
          : null,
      ],
    ),
  );
}

describe('plan diagram scheduling (CAN-4167 golden)', () => {
  it('coalesces content changes inside the debounce into one generation per kind', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    try {
      scheduler.schedulePlanDiagramGeneration(plan, getWindow);
      await jest.advanceTimersByTimeAsync(1_000);
      scheduler.schedulePlanDiagramGeneration(plan, getWindow);
      await jest.advanceTimersByTimeAsync(2_499);
      await settle();
      const beforeDebounce = [...calls];
      await jest.advanceTimersByTimeAsync(1);
      await waitFor(finished(2), 'the debounced generation');
      expect(beforeDebounce).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
    expect({
      calls: [...calls].sort(),
      helperTasks: helperTasks.map((t) => t.replace(plan.id, '<plan>')).sort(),
      diagrams: await diagrams(),
      updates: updates.length,
    }).toMatchSnapshot();
  });

  it('generates at once for a manual request, bypassing the debounce', async () => {
    scheduler.schedulePlanDiagramGeneration(plan, getWindow, {
      immediate: true,
    });
    await waitFor(finished(2), 'the manual generation');
    expect([...calls].sort()).toEqual(['logicDiff', 'sequence']);
  });

  it('queues one rerun for requests made while a generation is in flight', async () => {
    hold = gate();
    scheduler.schedulePlanDiagramGeneration(plan, getWindow, {
      immediate: true,
    });
    await settle();
    scheduler.schedulePlanDiagramGeneration(plan, getWindow, {
      immediate: true,
    });
    scheduler.schedulePlanDiagramGeneration(plan, getWindow, {
      immediate: true,
    });
    await settle();
    const midFlight = { calls: [...calls].sort(), diagrams: await diagrams() };
    hold.release();
    hold = null;
    await waitFor(finished(4), 'the run and its one rerun');
    expect({ midFlight, calls: [...calls].sort() }).toMatchSnapshot();
  });

  it('adds the data model diagram only for a plan that mentions data models', async () => {
    const updated = await persistence.updateTrackedPlan({
      ...scope,
      planId: plan.id,
      content: '# Diagram golden\n\nAdd a column with ALTER TABLE users.',
    });
    plan = updated ?? plan;
    scheduler.schedulePlanDiagramGeneration(plan, getWindow, {
      immediate: true,
    });
    await waitFor(finished(3), 'the three generations');
    expect({
      calls: [...calls].sort(),
      diagrams: await diagrams(),
    }).toMatchSnapshot();
  });

  it('keeps a generating artifact as it is after a restart', async () => {
    const current = await persistence.getTrackedPlan(
      WORKSPACE_ID,
      WORKTREE_ID,
      plan.id,
    );
    const sequence = current?.diagrams?.sequence;
    if (!sequence) throw new Error('expected a sequence diagram');
    await persistence.setPlanDiagramArtifact(
      WORKSPACE_ID,
      WORKTREE_ID,
      plan.id,
      'sequence',
      {
        ...sequence,
        status: 'generating',
      },
    );
    let status: string | undefined;
    await jest.isolateModulesAsync(async () => {
      const isolated = await import('../lib/plan-persistence');
      const reread = await isolated.getTrackedPlan(
        WORKSPACE_ID,
        WORKTREE_ID,
        plan.id,
      );
      status = reread?.diagrams?.sequence?.status;
    });
    // R1 (CAN-4167): nothing reconciles it today, so it stays generating.
    expect(status).toBe('generating');
  });
});

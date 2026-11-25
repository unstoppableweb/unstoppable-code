// CAN-4167 PR 3b golden: core.plan.diagram.generate on the real desktop
// dispatcher, over the core plan diagram scheduler and tracked plan
// persistence on a temporary data root. The three diagram generators,
// helper-task bookkeeping and window sends are replaced, so each case sees
// who asked for a generation and whether it may fall back to AI Credits for
// lack of a native login.
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
  PLAN_DIAGRAM_SCHEMA_VERSION,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type PlanDiagramArtifact,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import type * as Host from '../canopy-runtime/plan-diagram-host';
import type * as PlanPersistence from '../lib/plan-persistence';
import type * as Preferences from '../lib/preferences-store';
import { RENDERER_RELAY_GRANTS } from '../ipc/canopy-core-relay';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { createInterimInMemoryBindingProvider } from '../canopy-runtime/renderer-relay/interim-in-memory-binding';
import {
  createRendererRelay,
  type RendererRelayEvent,
} from '../canopy-runtime/renderer-relay/relay';

jest.setTimeout(60_000);

type Handler = (event: unknown, request: unknown) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: (): void => undefined,
  sendToAllWindows: (): void => undefined,
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
const calls: Array<{ kind: string; userInitiated: boolean }> = [];
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
const generated =
  (kind: string, value: unknown) =>
  async (options: { userInitiated?: boolean }): Promise<unknown> => {
    calls.push({ kind, userInitiated: options.userInitiated === true });
    if (hold) await hold.promise;
    return { value, usage: undefined };
  };
jest.mock('../lib/plan-diagram-generator', () => ({
  generateSequenceDiagram: generated('sequence', graph),
  generateLogicDiffDiagram: generated('logicDiff', logic),
  generateDataModelDiffDiagram: generated('dataModelDiff', {
    applicable: false,
  }),
}));
const finishedTasks: string[] = [];
jest.mock('../lib/helper-observed-task', () => ({
  startObservedHelperTask: (): void => undefined,
  finalizeObservedHelperTask: (taskKey: string): void => {
    finishedTasks.push(taskKey);
  },
}));
jest.mock('../lib/helper-transcript-observer', () => ({
  createHelperTranscriptObserver: (): unknown => ({}),
}));
// The diagram model a case configures; null keeps the stored preference.
let diagramModel: string | null = null;
// Holds the preference read, and with it the request's model lookup.
let lookupHold: Gate | null = null;
jest.mock('../lib/preferences-store', () => {
  const actual: typeof Preferences = jest.requireActual(
    '../lib/preferences-store',
  );
  return {
    ...actual,
    readPreferencesFile: async (): ReturnType<
      typeof Preferences.readPreferencesFile
    > => {
      if (lookupHold) await lookupHold.promise;
      const preferences = await actual.readPreferencesFile();
      return diagramModel === null
        ? preferences
        : { ...preferences, planDiagramModel: diagramModel };
    },
  };
});

const WORKSPACE_ID = 'golden-diagram-core';
const WORKTREE_ID = 'golden-wt';
const scope = { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID };

let root: string;
let dataDir: string;
let dispatcher: DesktopCanopyDispatcher;
let host: typeof Host;
let persistence: typeof PlanPersistence;
let plan: TrackedPlanData;
const originalDataDir = process.env.CANOPY_DATA_DIR;

function as(
  principalId: string,
  grants: CanopyCallerDescriptor['grants'] = ['core.plan.write'],
): CanopyCallerDescriptor {
  return {
    principalId,
    clientInstanceId: 'diagram-core-golden',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants,
  };
}

// The caller the IPC handlers resolve: the window user, or a paired controller.
let ipcCaller: CanopyCallerDescriptor = as('local-desktop-user', []);

function generateDiagramsChannel(request: unknown): Promise<unknown> {
  const handler = handlers.get(IPC_CHANNELS.trackedPlansGenerateDiagrams);
  if (!handler) throw new Error('no tracked-plans:generate-diagrams handler');
  return Promise.resolve(handler({ sender: { id: 1 } }, request));
}

let keyCount = 0;
function generate(
  caller: CanopyCallerDescriptor,
  params: Record<string, unknown> = {},
  idempotencyKey = `diagram-key-${(keyCount += 1)}`,
): Promise<unknown> {
  return dispatcher.instruction(
    'core.plan.diagram.generate',
    { scope, planId: plan.id, ...params },
    { caller, metadata: { idempotencyKey } },
  );
}

async function refusal(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof CanopyOperationError)) throw error;
    const { kind, code, details } = error.payload;
    return { kind, code, details };
  }
  throw new Error('expected a refusal');
}

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });
async function waitFor(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1_500 && !done(); i += 1) await sleep(10);
  if (!done()) throw new Error(`Timed out waiting for ${what}`);
  await sleep(100);
}
const finished = (count: number) => (): boolean =>
  finishedTasks.length >= count;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-diagram-core-')));
  dataDir = join(root, 'data');
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
  const { initClaudeModels } = await import('@canopy/desktop-shared/types');
  initClaudeModels([{ id: 'haiku', label: 'Haiku' }]);
  const registry = await import('../lib/workspace-registry');
  registry.registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
  const { createDesktopRuntime } =
    await import('../canopy-runtime/desktop-runtime');
  dispatcher = createDesktopRuntime({ shutdownTimeoutMs: 25 });
  host = await import('../canopy-runtime/plan-diagram-host');
  const { registerPlansHandlers } = await import('../ipc/plans');
  registerPlansHandlers(
    () => null,
    dispatcher,
    () => ipcCaller,
  );
  persistence = await import('../lib/plan-persistence');
  plan = await persistence.createTrackedPlan({
    ...scope,
    source: 'claude',
    content: '# Diagram core golden\n\nCall the API, then render.',
  });
});

afterAll(async () => {
  await dispatcher.shutdown();
  // Plan writes record usage through the real observability service; settle
  // its flush timer before this file's data root goes (CAN-6501 pattern).
  await (await import('../observability'))
    .peekObservabilityService()
    ?.dispose();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
  finishedTasks.length = 0;
  hold = null;
  diagramModel = null;
  lookupHold = null;
});

describe('core.plan.diagram.generate on the desktop dispatcher (CAN-4167 PR 3b)', () => {
  it("lets a person's request use the no-native-login AI Credits fallback: the window user and a paired controller", async () => {
    const results: Record<string, unknown> = {};
    for (const principalId of ['local-desktop-user', 'remote-device:phone-1']) {
      calls.length = 0;
      finishedTasks.length = 0;
      results[principalId] = await generate(as(principalId));
      await waitFor(finished(2), `${principalId}'s generation`);
      expect(calls).toEqual([
        { kind: 'sequence', userInitiated: true },
        { kind: 'logicDiff', userInitiated: true },
      ]);
    }
    expect(results).toEqual({
      'local-desktop-user': { status: 'started', revision: 1 },
      'remote-device:phone-1': { status: 'started', revision: 1 },
    });
  });

  it('the tracked-plans:generate-diagrams channel dispatches it as the window user or a paired controller', async () => {
    const answers: unknown[] = [];
    for (const principalId of [
      'local-desktop-user',
      'remote-device:laptop-1',
    ]) {
      calls.length = 0;
      finishedTasks.length = 0;
      ipcCaller = as(principalId, []);
      answers.push(
        await generateDiagramsChannel({ ...scope, planId: plan.id }),
      );
      await waitFor(finished(2), `the generation ${principalId} asked for`);
      expect(calls).toEqual([
        { kind: 'sequence', userInitiated: true },
        { kind: 'logicDiff', userInitiated: true },
      ]);
    }
    ipcCaller = as('local-desktop-user', []);
    calls.length = 0;
    answers.push(
      await generateDiagramsChannel({ ...scope, planId: 'no-such-plan' }),
    );
    await sleep(200);
    expect({ answers, calls }).toEqual({
      answers: [undefined, undefined, undefined],
      calls: [],
    });
  });

  it('refuses the channel for a shared-container recipient scope before it dispatches', async () => {
    const { READ_ONLY_SCOPE_ERROR } = await import('../lib/read-only-scope');
    ipcCaller = as('local-desktop-user', []);
    const instruction = jest.spyOn(dispatcher, 'instruction');
    try {
      await expect(
        generateDiagramsChannel({
          projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: WORKTREE_ID,
          planId: plan.id,
        }),
      ).rejects.toThrow(READ_ONLY_SCOPE_ERROR);
      expect(instruction).not.toHaveBeenCalled();
    } finally {
      instruction.mockRestore();
    }
    await sleep(200);
    expect(calls).toEqual([]);
  });

  // SWAN 02:18: params never decide spending, so `initiationSource: 'user'`
  // from a non-person caller buys nothing. Red if attendedness is read from
  // initiationSource instead of the caller's principal.
  it("requests a background caller's generation with userInitiated false, turning off the no-native-login AI Credits fallback, whatever initiationSource says", async () => {
    for (const principalId of [
      'desktop-agent-plan-mode',
      'desktop-pipeline-plans',
      'local-desktop-renderer:main',
    ]) {
      calls.length = 0;
      finishedTasks.length = 0;
      await expect(
        generate(as(principalId), { initiationSource: 'user' }),
      ).resolves.toEqual({ status: 'started', revision: 1 });
      await waitFor(finished(2), `${principalId}'s generation`);
      expect({ principalId, calls }).toEqual({
        principalId,
        calls: [
          { kind: 'sequence', userInitiated: false },
          { kind: 'logicDiff', userInitiated: false },
        ],
      });
    }
  });

  it('debounces a content change into one background generation', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    try {
      host.schedulePlanDiagramGeneration(plan, () => null);
      host.schedulePlanDiagramGeneration(plan, () => null);
      await jest.advanceTimersByTimeAsync(2_499);
      expect(calls).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
    } finally {
      jest.useRealTimers();
    }
    await waitFor(finished(2), 'the debounced generation');
    expect(calls).toEqual([
      { kind: 'sequence', userInitiated: false },
      { kind: 'logicDiff', userInitiated: false },
    ]);
  });

  // SWAN 05:08: only requestPlanDiagramGeneration may be attended. The extra
  // argument goes through Reflect.apply because the signature has no options:
  // red if the content path ever takes one that runs at once or attended.
  it('never runs a content change at once or as a person, whatever a caller passes', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    try {
      Reflect.apply(host.schedulePlanDiagramGeneration, undefined, [
        plan,
        (): null => null,
        { immediate: true, attended: true },
      ]);
      await jest.advanceTimersByTimeAsync(2_499);
      expect(calls).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
    } finally {
      jest.useRealTimers();
    }
    await waitFor(finished(2), 'the debounced generation');
    expect(calls).toEqual([
      { kind: 'sequence', userInitiated: false },
      { kind: 'logicDiff', userInitiated: false },
    ]);
  });

  it('answers a replayed request from its first outcome and starts nothing', async () => {
    const first = await generate(as('local-desktop-user'), {}, 'replayed-key');
    await waitFor(finished(2), 'the first generation');
    const again = await generate(as('local-desktop-user'), {}, 'replayed-key');
    await sleep(200);
    expect({ first, again, calls: calls.length }).toEqual({
      first: { status: 'started', revision: 1 },
      again: { status: 'started', revision: 1 },
      calls: 2,
    });
  });

  it("queues one rerun during a run, which keeps the queued caller's attendedness", async () => {
    hold = gate();
    const background = await generate(as('desktop-agent-plan-mode'));
    await sleep(100);
    const person = await generate(as('local-desktop-user'));
    const later = await generate(as('desktop-agent-plan-mode'));
    await sleep(100);
    hold.release();
    hold = null;
    await waitFor(finished(4), 'the run and its one rerun');
    expect({ background, person, later, calls }).toEqual({
      background: { status: 'started', revision: 1 },
      person: { status: 'queued', revision: 1 },
      later: { status: 'queued', revision: 1 },
      calls: [
        { kind: 'sequence', userInitiated: false },
        { kind: 'logicDiff', userInitiated: false },
        { kind: 'sequence', userInitiated: true },
        { kind: 'logicDiff', userInitiated: true },
      ],
    });
  });

  it('refuses what the contract refuses, before anything runs', async () => {
    diagramModel = 'no-such-diagram-model';
    const unavailable = await refusal(generate(as('local-desktop-user')));
    diagramModel = null;
    expect({
      missing: await generate(as('local-desktop-user'), {
        planId: 'no-such-plan',
      }),
      staleRevision: await refusal(
        generate(as('local-desktop-user'), { expectedRevision: 7 }),
      ),
      kindsSubset: await refusal(
        generate(as('local-desktop-user'), { kinds: ['sequence'] }),
      ),
      readOnlyScope: await refusal(
        dispatcher.instruction(
          'core.plan.diagram.generate',
          {
            scope: {
              projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
              worktreeId: WORKTREE_ID,
            },
            planId: plan.id,
          },
          {
            caller: as('local-desktop-user'),
            metadata: { idempotencyKey: 'read-only-scope' },
          },
        ),
      ),
      withoutWriteGrant: await refusal(
        generate(as('local-desktop-user', ['core.plan.read'])),
      ),
      unavailable,
    }).toEqual({
      missing: { status: 'missing' },
      staleRevision: {
        kind: 'conflict',
        code: 'core.plan.revisionConflict',
        details: { reason: 'REVISION_CONFLICT', currentRevision: 1 },
      },
      kindsSubset: {
        kind: 'invalid_argument',
        code: undefined,
        details: undefined,
      },
      readOnlyScope: {
        kind: 'permission_denied',
        code: 'core.plan.readOnlyScope',
        details: undefined,
      },
      withoutWriteGrant: {
        kind: 'permission_denied',
        code: undefined,
        details: undefined,
      },
      unavailable: {
        kind: 'failed_precondition',
        code: 'core.plan.diagramModelUnavailable',
        details: { reason: 'DIAGRAM_MODEL_UNAVAILABLE' },
      },
    });
    await sleep(200);
    expect(calls).toEqual([]);
  });

  it('keeps the stored-revision rules on diagram writes through the plan engine', async () => {
    const updated = await persistence.updateTrackedPlan({
      ...scope,
      planId: plan.id,
      content: '# Diagram core golden\n\nAdd a column with ALTER TABLE users.',
    });
    plan = updated ?? plan;
    const at = (
      revision: number,
      status: 'ready' | 'error',
    ): PlanDiagramArtifact<null> => ({
      data: null,
      derivedFromRevision: revision,
      status,
      generatedAt: '2026-11-20T00:00:00.000Z',
    });
    const stale = await persistence.setPlanDiagramArtifact(
      WORKSPACE_ID,
      WORKTREE_ID,
      plan.id,
      'sequence',
      at(1, 'ready'),
    );
    await persistence.setPlanDiagramArtifact(
      WORKSPACE_ID,
      WORKTREE_ID,
      plan.id,
      'dataModelDiff',
      at(2, 'ready'),
    );
    const older = await persistence.setPlanDiagramArtifact(
      WORKSPACE_ID,
      WORKTREE_ID,
      plan.id,
      'dataModelDiff',
      at(1, 'ready'),
    );
    const kept = await persistence.removePlanDiagramArtifact(
      WORKSPACE_ID,
      WORKTREE_ID,
      plan.id,
      1,
    );
    expect({
      sequence: stale?.diagrams?.sequence?.status,
      dataModelAfterOlder: older?.diagrams?.dataModelDiff?.derivedFromRevision,
      dataModelAfterStaleRemoval: kept?.diagrams?.dataModelDiff?.status,
    }).toEqual({
      sequence: 'stale',
      dataModelAfterOlder: 2,
      dataModelAfterStaleRemoval: 'ready',
    });
  });

  it('tells the share sync and the search index about a diagram write, never the content listeners', async () => {
    const heard = { diagram: 0, write: 0, content: 0 };
    const onDiagram = (): void => {
      heard.diagram += 1;
    };
    const onWrite = (): void => {
      heard.write += 1;
    };
    const onContent = (): void => {
      heard.content += 1;
    };
    persistence.addPlanDiagramArtifactChangeListener(onDiagram);
    persistence.addTrackedPlansWriteListener(onWrite);
    persistence.addPlanContentChangeListener(onContent);
    try {
      await persistence.setPlanDiagramArtifact(
        WORKSPACE_ID,
        WORKTREE_ID,
        plan.id,
        'logicDiff',
        {
          data: logic,
          derivedFromRevision: plan.latestRevisionNumber,
          status: 'ready',
        },
      );
    } finally {
      persistence.removePlanDiagramArtifactChangeListener(onDiagram);
      persistence.removeTrackedPlansWriteListener(onWrite);
      persistence.removePlanContentChangeListener(onContent);
    }
    expect(heard).toEqual({ diagram: 1, write: 1, content: 0 });
  });

  // SWAN 03:03: the store never checks a diagram's error or generatedAt, so a
  // reader gets either a string or nothing, never another value to render.
  it('never hands a reader a diagram error or generatedAt that is not a string', async () => {
    const { resolveTrackedPlansFilePath } =
      await import('../lib/resolve-worktree');
    const file = resolveTrackedPlansFilePath(WORKSPACE_ID, WORKTREE_ID);
    const stored: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (
      typeof stored !== 'object' ||
      stored === null ||
      !('plans' in stored) ||
      !Array.isArray(stored.plans)
    )
      throw new Error('expected a plans file');
    const plans: unknown[] = stored.plans;
    const rewritten = plans.map((entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      entry.id === plan.id
        ? {
            ...entry,
            diagrams: {
              sequence: {
                data: null,
                derivedFromRevision: 2,
                status: 'error',
                error: { message: '<b>Generation failed</b>' },
                generatedAt: 1763600000000,
              },
            },
          }
        : entry,
    );
    writeFileSync(
      file,
      JSON.stringify({ version: 1, plans: rewritten }, null, 2),
    );
    const read = await persistence.getTrackedPlan(
      WORKSPACE_ID,
      WORKTREE_ID,
      plan.id,
    );
    const viaCore = await dispatcher.query(
      'core.plan.get',
      { scope, planId: plan.id },
      { caller: as('local-desktop-user', ['core.plan.read']) },
    );
    const expected = {
      sequence: { data: null, derivedFromRevision: 2, status: 'error' },
    };
    expect({
      read: read?.diagrams,
      viaCore: viaCore.plan?.diagrams,
    }).toEqual({ read: expected, viaCore: expected });
  });

  // The trigger stays on every plan content change, not only on core.plan
  // writes: an external edit of the plan file reaches the plans store through
  // plan-file-sync, beside the dispatcher.
  it('schedules a background generation after an external edit of the plan file', async () => {
    const { PlanFileSyncService } = await import('../lib/plan-file-sync');
    const sync = new PlanFileSyncService();
    const ref = { ...scope, planId: plan.id };
    const materialized = await sync.materializePlanFile(ref, { flush: false });
    if (!materialized) throw new Error('expected the plan file');
    const stopFollowing = host.followPlanContentChanges(() => null);
    try {
      writeFileSync(
        materialized.filePath,
        '# Diagram core golden\n\nCall the API, then render, then cache.',
      );
      await sync.materializePlanFile(ref, { flush: true });
      await waitFor(finished(2), 'the generation the file edit scheduled');
    } finally {
      stopFollowing();
    }
    const edited = await persistence.getTrackedPlan(
      WORKSPACE_ID,
      WORKTREE_ID,
      plan.id,
    );
    plan = edited ?? plan;
    expect({
      revision: edited?.latestRevisionNumber,
      calls,
    }).toEqual({
      revision: materialized.latestRevisionNumber + 1,
      calls: [
        { kind: 'sequence', userInitiated: false },
        { kind: 'logicDiff', userInitiated: false },
      ],
    });
  });

  // Develop listed core.plan.diagram.generate for the renderer relay but
  // never served it; the relay stays shut, so the callers that can start a
  // generation are develop's: the window user over the IPC channel, a paired
  // controller through its tunnel, and plan content changes.
  it.each(['main', 'app-advisor'] as const)(
    'refuses the %s renderer relay surface, starting nothing',
    async (surface) => {
      const frame = {
        url: 'canopy://app',
        detached: false,
        isDestroyed: (): boolean => false,
      };
      const event: RendererRelayEvent = {
        sender: {
          id: 7,
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
          surface,
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'electron-web-contents:7',
            authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
            interfaceKind: 'desktop',
            grants: [...RENDERER_RELAY_GRANTS],
          },
        }),
      });
      try {
        const reply = await relay.invoke(event, {
          kind: 'request',
          method: 'core.plan.diagram.generate',
          params: {
            scope,
            planId: plan.id,
            _meta: { idempotencyKey: `relay-diagram-${surface}` },
          },
        });
        expect(reply).toMatchObject({ ok: false });
      } finally {
        relay.dispose();
      }
      await sleep(200);
      expect(calls).toEqual([]);
    },
  );

  // The result's revision is the one the request was accepted at; a queued
  // run reads the plan when it starts, and each diagram says what it came from.
  it('generates a queued run from the plan as stored when it starts, and each diagram records that revision', async () => {
    const current = await persistence.getTrackedPlan(
      WORKSPACE_ID,
      WORKTREE_ID,
      plan.id,
    );
    if (!current) throw new Error('expected the plan');
    const accepted = current.latestRevisionNumber;
    hold = gate();
    const running = await generate(as('local-desktop-user'));
    await sleep(100);
    const queued = await generate(as('local-desktop-user'));
    const edited = await persistence.updateTrackedPlan({
      ...scope,
      planId: plan.id,
      content: '# Diagram core golden\n\nCall the API twice, then render.',
    });
    plan = edited ?? plan;
    hold.release();
    hold = null;
    await waitFor(finished(4), 'the run and its queued rerun');
    const after = await persistence.getTrackedPlan(
      WORKSPACE_ID,
      WORKTREE_ID,
      plan.id,
    );
    const source = (kind: 'sequence' | 'logicDiff'): unknown => ({
      from: after?.diagrams?.[kind]?.derivedFromRevision,
      status: after?.diagrams?.[kind]?.status,
    });
    expect({
      running,
      queued,
      editedRevision: edited?.latestRevisionNumber,
      sequence: source('sequence'),
      logicDiff: source('logicDiff'),
    }).toEqual({
      running: { status: 'started', revision: accepted },
      queued: { status: 'queued', revision: accepted },
      editedRevision: accepted + 1,
      sequence: { from: accepted + 1, status: 'ready' },
      logicDiff: { from: accepted + 1, status: 'ready' },
    });
  });

  it('schedules nothing for a request cancelled, or past its deadline, while its lookups are pending', async () => {
    lookupHold = gate();
    const controller = new AbortController();
    const cancelled = refusal(
      dispatcher.instruction(
        'core.plan.diagram.generate',
        { scope, planId: plan.id },
        {
          caller: as('local-desktop-user'),
          metadata: { idempotencyKey: `diagram-key-${(keyCount += 1)}` },
          signal: controller.signal,
        },
      ),
    );
    const late = refusal(
      dispatcher.instruction(
        'core.plan.diagram.generate',
        { scope, planId: plan.id },
        {
          caller: as('local-desktop-user'),
          metadata: {
            idempotencyKey: `diagram-key-${(keyCount += 1)}`,
            deadlineAt: new Date(Date.now() + 150).toISOString(),
          },
        },
      ),
    );
    await sleep(50);
    controller.abort();
    const answered = { cancelled: await cancelled, late: await late };
    lookupHold.release();
    lookupHold = null;
    await sleep(500);
    expect({ answered, calls, finished: finishedTasks }).toMatchObject({
      answered: {
        cancelled: { kind: 'cancelled' },
        late: { kind: 'deadline_exceeded' },
      },
      calls: [],
      finished: [],
    });
  });
});

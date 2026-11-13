import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import { createCoreCoworkStore } from '../create-core-cowork-store';
import {
  CoreCoworkRequestError,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from '../invoker';

// A fake web core shaped like the CAN-4185 contract: `core.workspace.list`,
// `core.chat.task.list` per cowork project, and one `core.chat.task.events`
// stream whose frames the test pushes.

const PROJECT = '11111111-1111-4111-8111-111111111111';
const REPO = '22222222-2222-4222-8222-222222222222';
const EPOCH = 'feed';

interface FakeTask {
  worktreeId: string;
  title: string;
  updatedAt: string;
}

class FakeStream implements CoreCoworkStream {
  private readonly frames: unknown[] = [];
  private waiter: ((frame: unknown) => void) | null = null;
  closed = false;

  push(frame: unknown): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(frame);
    } else this.frames.push(frame);
  }

  item(sequence: number, item: unknown): void {
    this.push({
      kind: 'item',
      cursor: { daemonEpoch: EPOCH, sequence },
      item,
    });
  }

  next(): Promise<{ done: true } | { done: false; value: unknown }> {
    if (this.closed) return Promise.resolve({ done: true });
    const queued = this.frames.shift();
    if (queued !== undefined)
      return Promise.resolve({ done: false, value: queued });
    return new Promise((resolve) => {
      this.waiter = (value): void => resolve({ done: false, value });
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeWebCore implements CoreCoworkInvoker {
  tasks: FakeTask[] = [
    { worktreeId: 'task-1', title: 'First', updatedAt: '2026-11-07T10:00:00Z' },
  ];
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly streams: FakeStream[] = [];
  readonly streamParams: Record<string, unknown>[] = [];
  hold: Promise<void> | null = null;
  /** Each held `core.chat.task.list` answers with the tasks as of its call. */
  readonly taskListHolds: Promise<void>[] = [];
  /** Refusals for the next opens that resume from a cursor. */
  readonly resumeRefusals: CanopyErrorPayload[] = [];
  projectName = 'Research';
  projectRevision = 3;
  /** Refusals for the next project updates, as a stale revision answers. */
  readonly updateRefusals: CanopyErrorPayload[] = [];
  /** `undefined` leaves the field off, as an authority that doesn't scope by organization does. */
  repoOwner: string | null | undefined = null;
  /** Holds each `core.chat.create` until released, in call order. */
  readonly createHolds: Promise<void>[] = [];
  /** Creates that apply but lose their reply, as a slow first create can. */
  lostCreateReplies = 0;
  /** Refusals for the next creates, as the web core's handler throws them. */
  readonly createRefusals: CanopyErrorPayload[] = [];
  /** Failures for the next task listings, as a web core that is briefly down. */
  readonly taskListFailures: CanopyErrorPayload[] = [];

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<CanopyCoreRelayLikeReply> {
    this.calls.push({ method, params });
    if (this.hold) await this.hold;
    if (method === 'core.workspace.list')
      return {
        ok: true,
        value: {
          items: [
            {
              workspaceId: PROJECT,
              name: this.projectName,
              kind: 'cowork',
              ownerOrganizationId: null,
              revision: this.projectRevision,
              repositorySources: [],
              settings: {},
            },
            {
              workspaceId: REPO,
              name: 'Repo',
              kind: 'git',
              ...(this.repoOwner === undefined
                ? {}
                : { ownerOrganizationId: this.repoOwner }),
              repositorySources: [],
              settings: {},
            },
          ],
          nextCursor: null,
        },
      };
    if (method === 'core.workspace.reorder')
      return { ok: true, value: { acknowledged: true } };
    const refusal =
      method === 'core.workspace.update'
        ? this.updateRefusals.shift()
        : undefined;
    if (refusal) return { ok: false, error: refusal };
    if (method === 'core.workspace.update')
      return {
        ok: true,
        value: {
          workspaceId: PROJECT,
          name: 'Renamed',
          kind: 'cowork',
          repositorySources: [],
          settings: {},
        },
      };
    if (method === 'core.workspace.delete')
      return {
        ok: true,
        value: {
          operationId: 'op-1',
          kind: 'core.workspace.delete',
          status: 'completed',
        },
      };
    if (method === 'core.chat.create') {
      const held = this.createHolds.shift();
      if (held) await held;
      const refused = this.createRefusals.shift();
      if (refused) return { ok: false, error: refused };
      // As the web core does: the tab id is the chat's external id, so a
      // create repeated under it replays the chat instead of adding one.
      const tabId = String(Reflect.get(Object(params.action), 'tabId'));
      const replay = this.tasks.some((task) => task.worktreeId === tabId);
      if (!replay)
        this.tasks = [
          {
            worktreeId: tabId,
            title: '',
            updatedAt: '2026-11-07T12:00:00Z',
          },
          ...this.tasks,
        ];
      if (!replay && this.lostCreateReplies > 0) {
        this.lostCreateReplies -= 1;
        return {
          ok: false,
          error: {
            kind: 'unavailable',
            message: 'The reply was lost.',
            retry: { kind: 'same_idempotency_key' },
          },
        };
      }
      return {
        ok: true,
        value: {
          commandId: params.commandId,
          revision: 0,
          outcome: replay ? 'already_applied' : 'applied',
          entityId: tabId,
        },
      };
    }
    if (method === 'core.chat.task.list') {
      const failure = this.taskListFailures.shift();
      if (failure) return { ok: false, error: failure };
      // As the web core does: only a cowork project lists tasks.
      const scope = params.scope;
      if (
        typeof scope === 'object' &&
        scope !== null &&
        Reflect.get(scope, 'workspaceId') === REPO
      )
        return {
          ok: false,
          error: {
            kind: 'invalid_argument',
            message: 'Only a cowork project lists tasks.',
            retry: { kind: 'never' },
          },
        };
      const tasks = this.tasks;
      const held = this.taskListHolds.shift();
      if (held) await held;
      return {
        ok: true,
        value: {
          items: tasks.map((task) => ({
            workspaceId: PROJECT,
            worktreeId: task.worktreeId,
            title: task.title,
            state: 'idle',
            updatedAt: task.updatedAt,
            revision: 1,
          })),
          nextCursor: null,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: 'capability_unavailable',
        message: method,
        retry: { kind: 'never' },
      },
    };
  }

  openStream(
    _method: string,
    params: Record<string, unknown>,
  ): Promise<CoreCoworkStream> {
    const refusal = params.cursor ? this.resumeRefusals.shift() : undefined;
    if (refusal) return Promise.reject(new CoreCoworkRequestError(refusal));
    const stream = new FakeStream();
    this.streams.push(stream);
    this.streamParams.push(params);
    return Promise.resolve(stream);
  }

  get stream(): FakeStream {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error('No stream is open.');
    return stream;
  }

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }
}

const taskTitles = (
  store: ReturnType<typeof createCoreCoworkStore>,
): string[] =>
  (store.getState().tasksByProject[`web-core:${PROJECT}`] ?? []).map(
    (task) => task.title,
  );

/** The idempotency key a recorded call carried, when it carried one. */
function idempotencyKeyOf(
  params: Record<string, unknown> | undefined,
): unknown {
  const meta = params?._meta;
  return typeof meta === 'object' && meta !== null
    ? Reflect.get(meta, 'idempotencyKey')
    : undefined;
}

async function connected(
  core: FakeWebCore,
): Promise<ReturnType<typeof createCoreCoworkStore>> {
  const store = createCoreCoworkStore();
  await store.getState().connect(core);
  expect(store.getState().status).toBe('online');
  return store;
}

describe('core cowork store', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const hold = (core: FakeWebCore): (() => void) => {
    let release = (): void => undefined;
    core.createHolds.push(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => release();
  };
  const tasksOf = (
    store: ReturnType<typeof createCoreCoworkStore>,
  ): { worktreeId: string; creation: string | undefined }[] =>
    (store.getState().tasksByProject[`web-core:${PROJECT}`] ?? []).map(
      (task) => ({ worktreeId: task.worktreeId, creation: task.creation }),
    );

  it('starts a task at once, as a pending row, and lists it once the web core creates it (CAN-6098)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    const release = hold(core);
    const { task, created } = store.getState().beginTask(PROJECT);
    // Shown before any reply: the new task leads its project, pending.
    expect(tasksOf(store)[0]).toEqual({
      worktreeId: task.worktreeId,
      creation: 'pending',
    });
    expect(store.getState().taskCreation(PROJECT, task.worktreeId)).toBe(
      created,
    );
    // A re-read while the create is in flight keeps the pending row.
    core.stream.item(1, { kind: 'resync' });
    await jest.advanceTimersByTimeAsync(0);
    const reads = core.count('core.chat.task.list');
    core.stream.item(2, {
      kind: 'task',
      workspaceId: PROJECT,
      worktreeId: 'task-1',
      batchId: '2',
    });
    await jest.advanceTimersByTimeAsync(250);
    expect(core.count('core.chat.task.list')).toBe(reads + 1);
    expect(tasksOf(store)[0]).toEqual({
      worktreeId: task.worktreeId,
      creation: 'pending',
    });
    release();
    await expect(created).resolves.toMatchObject({
      worktreeId: task.worktreeId,
    });
    expect(tasksOf(store)).toEqual([
      { worktreeId: task.worktreeId, creation: undefined },
      { worktreeId: 'task-1', creation: undefined },
    ]);
    expect(
      store.getState().taskCreation(PROJECT, task.worktreeId),
    ).toBeUndefined();
  });

  it('retries a task whose first create landed unanswered under the same id, so the web core keeps one task (CAN-6098)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    core.lostCreateReplies = 1;
    const release = hold(core);
    const { task, created } = store.getState().beginTask(PROJECT);
    release();
    await expect(created).rejects.toThrow('The reply was lost.');
    expect(tasksOf(store)[0]).toEqual({
      worktreeId: task.worktreeId,
      creation: 'failed',
    });
    expect(
      store.getState().tasksByProject[`web-core:${PROJECT}`]?.[0]
        ?.creationError,
    ).toBe('The reply was lost.');

    await expect(
      store.getState().retryTask(PROJECT, task.worktreeId),
    ).resolves.toMatchObject({ worktreeId: task.worktreeId });
    // Both attempts name the task's own id; the web core replayed the one
    // it had created, so it holds that task once.
    const creates = core.calls.filter(
      (call) => call.method === 'core.chat.create',
    );
    expect(creates).toHaveLength(2);
    for (const call of creates) {
      expect(call.params.worktreeId).toBe(task.worktreeId);
      expect(call.params.action).toMatchObject({ tabId: task.worktreeId });
    }
    expect(idempotencyKeyOf(creates[0]?.params)).not.toBe(
      idempotencyKeyOf(creates[1]?.params),
    );
    expect(
      core.tasks.filter((each) => each.worktreeId === task.worktreeId),
    ).toHaveLength(1);
    expect(tasksOf(store)).toEqual([
      { worktreeId: task.worktreeId, creation: undefined },
      { worktreeId: 'task-1', creation: undefined },
    ]);
  });

  it('a created task whose project re-read fails stays created and is listed by the next re-read (CAN-6098)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    core.taskListFailures.push({
      kind: 'unavailable',
      message: 'The web core is briefly unavailable.',
      retry: { kind: 'same_idempotency_key' },
    });
    const { task, created } = store.getState().beginTask(PROJECT);
    // The create landed, so a send waiting on it goes ahead.
    await expect(created).resolves.toMatchObject({
      worktreeId: task.worktreeId,
    });
    expect(tasksOf(store)[0]).toEqual({
      worktreeId: task.worktreeId,
      creation: undefined,
    });
    const reads = core.count('core.chat.task.list');
    await jest.advanceTimersByTimeAsync(250);
    expect(core.count('core.chat.task.list')).toBe(reads + 1);
    expect(store.getState().status).toBe('online');
    expect(tasksOf(store)).toEqual([
      { worktreeId: task.worktreeId, creation: undefined },
      { worktreeId: 'task-1', creation: undefined },
    ]);
  });

  it('a task re-read the web core answers unavailable is read again, and the section stays online (CAN-6394)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    // As the transport answers a request a gateway lost mid-flight.
    core.taskListFailures.push({
      kind: 'unavailable',
      message: 'The web core answered HTTP 503.',
      retry: { kind: 'same_request' },
    });
    core.tasks = [
      {
        worktreeId: 'task-2',
        title: 'Later',
        updatedAt: '2026-11-07T12:00:00Z',
      },
      ...core.tasks,
    ];
    core.stream.item(1, {
      kind: 'task',
      workspaceId: PROJECT,
      worktreeId: 'task-2',
      batchId: '1',
    });
    const reads = core.count('core.chat.task.list');
    await jest.advanceTimersByTimeAsync(250);
    expect(core.count('core.chat.task.list')).toBe(reads + 1);
    expect(store.getState().status).toBe('online');
    expect(taskTitles(store)).toEqual(['First']);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(core.count('core.chat.task.list')).toBe(reads + 2);
    expect(store.getState().status).toBe('online');
    expect(taskTitles(store)).toEqual(['Later', 'First']);
  });

  it('a task created for the cloud chat page shows only once the web core created it, and a refused one leaves no row (CAN-6099, CAN-6098)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    const release = hold(core);
    const creating = store.getState().createTask(PROJECT);
    await jest.advanceTimersByTimeAsync(0);
    // Nothing shows while the create is in flight: that page opens a row as
    // soon as it shows, and holds a task it can't read as gone.
    expect(tasksOf(store)).toEqual([
      { worktreeId: 'task-1', creation: undefined },
    ]);
    release();
    const task = await creating;
    expect(tasksOf(store)).toEqual([
      { worktreeId: task.worktreeId, creation: undefined },
      { worktreeId: 'task-1', creation: undefined },
    ]);

    core.createRefusals.push({
      kind: 'not_found',
      message: 'The project was not found.',
      retry: { kind: 'never' },
    });
    await expect(store.getState().createTask(PROJECT)).rejects.toThrow(
      'The project was not found.',
    );
    expect(tasksOf(store)).toEqual([
      { worktreeId: task.worktreeId, creation: undefined },
      { worktreeId: 'task-1', creation: undefined },
    ]);
  });

  it('going offline clears every project, task and thread', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    expect(store.getState().projects.map((p) => p.key)).toEqual([
      `web-core:${PROJECT}`,
      `web-core:${REPO}`,
    ]);
    expect(taskTitles(store)).toEqual(['First']);

    core.stream.push({
      kind: 'end',
      cursor: { daemonEpoch: EPOCH, sequence: 0 },
      outcome: 'error',
      error: { kind: 'unavailable', message: 'gone', retry: { kind: 'never' } },
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(store.getState()).toMatchObject({
      status: 'offline',
      projects: [],
      tasksByProject: {},
    });
    expect(core.stream.closed).toBe(true);
  });

  it('a reply from an earlier generation is dropped', async () => {
    const earlier = new FakeWebCore();
    let release = (): void => undefined;
    earlier.hold = new Promise((resolve) => {
      release = resolve;
    });
    earlier.projectName = 'Old account project';
    earlier.tasks = [
      {
        worktreeId: 'old',
        title: 'Old account',
        updatedAt: '2026-11-07T09:00:00Z',
      },
    ];
    const store = createCoreCoworkStore();
    const first = store.getState().connect(earlier);
    await jest.advanceTimersByTimeAsync(0);

    const current = new FakeWebCore();
    await store.getState().connect(current);
    release();
    await first;
    await jest.advanceTimersByTimeAsync(0);

    expect(store.getState().status).toBe('online');
    expect(store.getState().projects.map((p) => p.name)).toEqual([
      'Research',
      'Repo',
    ]);
    expect(taskTitles(store)).toEqual(['First']);
    expect(earlier.stream.closed).toBe(true);
  });

  it('snapshotRequired re-lists the scope', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    core.stream.item(3, { kind: 'resync' });
    core.tasks = [
      ...core.tasks,
      {
        worktreeId: 'task-2',
        title: 'Second',
        updatedAt: '2026-11-07T11:00:00Z',
      },
    ];

    core.stream.push({
      kind: 'end',
      cursor: { daemonEpoch: EPOCH, sequence: 3 },
      outcome: 'error',
      error: {
        kind: 'failed_precondition',
        code: 'core.chat.snapshotRequired',
        message: 'stale cursor',
        retry: { kind: 'after_refresh', resource: 'core.chat.task.list' },
      },
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(core.count('core.workspace.list')).toBe(2);
    expect(core.streamParams.at(-1)).toEqual({ scope: 'all', cursor: null });
    expect(taskTitles(store)).toEqual(['Second', 'First']);
    expect(store.getState().status).toBe('online');
  });

  it('a task item for a new task adds its sidebar row without a reload', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    core.stream.item(1, { kind: 'resync' });
    await jest.advanceTimersByTimeAsync(0);

    core.tasks = [
      {
        worktreeId: 'task-2',
        title: 'From the web',
        updatedAt: '2026-11-07T12:00:00Z',
      },
      ...core.tasks,
    ];
    core.stream.item(2, {
      kind: 'task',
      workspaceId: PROJECT,
      worktreeId: 'task-2',
      batchId: '2',
    });
    await jest.advanceTimersByTimeAsync(250);

    expect(taskTitles(store)).toEqual(['From the web', 'First']);
    expect(core.count('core.workspace.list')).toBe(1);
    expect(core.streams).toHaveLength(1);
  });

  it('an item at or below the applied cursor is ignored', async () => {
    const core = new FakeWebCore();
    await connected(core);
    const item = {
      kind: 'task',
      workspaceId: PROJECT,
      worktreeId: 'task-1',
      batchId: '5',
    };
    core.stream.item(5, item);
    await jest.advanceTimersByTimeAsync(250);
    const reads = core.count('core.chat.task.list');

    core.stream.item(5, item);
    core.stream.item(4, { ...item, batchId: '4' });
    await jest.advanceTimersByTimeAsync(250);

    expect(core.count('core.chat.task.list')).toBe(reads);
  });
  it('an older task re-read never overwrites a newer one', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    core.stream.item(1, { kind: 'resync' });
    const item = { kind: 'task', workspaceId: PROJECT, worktreeId: 'task-1' };

    let releaseOlder = (): void => undefined;
    core.taskListHolds.push(
      new Promise((resolve) => {
        releaseOlder = resolve;
      }),
    );
    core.tasks = [
      {
        worktreeId: 'task-1',
        title: 'Older',
        updatedAt: '2026-11-07T10:01:00Z',
      },
    ];
    core.stream.item(2, { ...item, batchId: '2' });
    await jest.advanceTimersByTimeAsync(250);

    core.tasks = [
      {
        worktreeId: 'task-1',
        title: 'Newer',
        updatedAt: '2026-11-07T10:02:00Z',
      },
    ];
    core.stream.item(3, { ...item, batchId: '3' });
    await jest.advanceTimersByTimeAsync(250);
    releaseOlder();
    await jest.advanceTimersByTimeAsync(0);

    expect(taskTitles(store)).toEqual(['Newer']);
  });

  it('a store whose connection was lost reconnects by itself, waiting longer each time (CAN-6442)', async () => {
    const lost: CanopyErrorPayload = {
      kind: 'unavailable',
      message: 'The web core is unreachable.',
      retry: { kind: 'same_request' },
    };
    const down: CoreCoworkInvoker = {
      request: () => Promise.resolve({ ok: false, error: lost }),
      openStream: () => Promise.reject(new CoreCoworkRequestError(lost)),
    };
    const first = new FakeWebCore();
    const later = new FakeWebCore();
    const opens: CoreCoworkInvoker[] = [down, later];
    let reconnects = 0;
    const store = createCoreCoworkStore({
      reconnect: () => {
        reconnects += 1;
        return opens.shift() ?? null;
      },
    });
    await store.getState().connect(first);
    expect(store.getState().status).toBe('online');

    first.stream.push({
      kind: 'end',
      cursor: { daemonEpoch: EPOCH, sequence: 0 },
      outcome: 'error',
      error: lost,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(store.getState().status).toBe('offline');
    await jest.advanceTimersByTimeAsync(999);
    expect(reconnects).toBe(0);
    // The first try finds the web core still down: offline, and it waits longer.
    await jest.advanceTimersByTimeAsync(1);
    expect(reconnects).toBe(1);
    expect(store.getState().status).toBe('offline');
    await jest.advanceTimersByTimeAsync(1_999);
    expect(reconnects).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(reconnects).toBe(2);
    expect(store.getState().status).toBe('online');
    expect(taskTitles(store)).toEqual(['First']);

    // Turned off, it stays off: nothing reconnects it.
    store.getState().disconnect('disabled');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(reconnects).toBe(2);
  });

  it('a snapshotRequired reopen after a clean end re-lists instead of going offline', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    core.stream.item(1, { kind: 'resync' });
    await jest.advanceTimersByTimeAsync(0);
    core.resumeRefusals.push({
      kind: 'failed_precondition',
      code: 'core.chat.snapshotRequired',
      message: 'stale cursor',
      retry: { kind: 'after_refresh', resource: 'core.chat.task.list' },
    });
    core.tasks = [
      ...core.tasks,
      {
        worktreeId: 'task-2',
        title: 'Second',
        updatedAt: '2026-11-07T11:00:00Z',
      },
    ];

    core.stream.push({
      kind: 'end',
      cursor: { daemonEpoch: EPOCH, sequence: 1 },
      outcome: 'completed',
      error: null,
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(store.getState().status).toBe('online');
    expect(core.streamParams.at(-1)).toEqual({ scope: 'all', cursor: null });
    expect(taskTitles(store)).toEqual(['Second', 'First']);
  });

  it('a disconnect during the first listing keeps the store offline', async () => {
    const core = new FakeWebCore();
    const store = createCoreCoworkStore();
    // A listener that leaves as soon as the first listing lands.
    const unsubscribe = store.subscribe((state) => {
      if (state.projects.length > 0) store.getState().disconnect('offline');
    });
    await store.getState().connect(core);
    unsubscribe();

    expect(store.getState()).toMatchObject({
      status: 'offline',
      projects: [],
      tasksByProject: {},
    });
  });

  it('a repository project is listed and never task-listed (CAN-6100)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);

    expect(store.getState().projects).toEqual([
      expect.objectContaining({ workspaceId: PROJECT, kind: 'cowork' }),
      expect.objectContaining({ workspaceId: REPO, kind: 'git', name: 'Repo' }),
    ]);
    expect(store.getState().tasksByProject[`web-core:${REPO}`]).toEqual([]);
    const taskListScopes = core.calls
      .filter((call) => call.method === 'core.chat.task.list')
      .map((call) => call.params.scope);
    expect(taskListScopes).toEqual([{ workspaceId: PROJECT }]);

    // A task event naming the repository project is not re-read.
    core.stream.item(1, {
      kind: 'task',
      workspaceId: REPO,
      worktreeId: 'wt-1',
      batchId: 'batch-1',
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(core.count('core.chat.task.list')).toBe(1);
    expect(core.count('core.workspace.list')).toBe(1);
    expect(store.getState().status).toBe('online');
  });

  it('a project with no recorded owner is kept as Personal (CAN-6100)', async () => {
    const core = new FakeWebCore();
    core.repoOwner = undefined;
    const store = await connected(core);

    expect(
      store.getState().projects.find((p) => p.workspaceId === REPO),
    ).toMatchObject({ ownerOrganizationId: null });
  });

  it('reordering moves the project at once and asks the web core once, keyed (CAN-6099)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);

    const done = store
      .getState()
      .reorderProjects(REPO, PROJECT, [PROJECT, REPO]);
    expect(store.getState().projects.map((p) => p.workspaceId)).toEqual([
      REPO,
      PROJECT,
    ]);
    await done;

    const reorders = core.calls.filter(
      (call) => call.method === 'core.workspace.reorder',
    );
    expect(reorders).toHaveLength(1);
    expect(reorders[0]?.params).toMatchObject({
      visibleWorkspaceIds: [PROJECT, REPO],
      activeWorkspaceId: REPO,
      overWorkspaceId: PROJECT,
    });
    expect(typeof idempotencyKeyOf(reorders[0]?.params)).toBe('string');
    // The web core's order is read back afterwards.
    expect(core.count('core.workspace.list')).toBe(2);
  });

  it('deleting a project names its listed revision and re-lists (CAN-6099)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);

    await store.getState().deleteProject(PROJECT);

    const deletes = core.calls.filter(
      (call) => call.method === 'core.workspace.delete',
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.params).toMatchObject({
      workspaceId: PROJECT,
      expectedRevision: 3,
    });
    expect(typeof idempotencyKeyOf(deletes[0]?.params)).toBe('string');
    expect(core.count('core.workspace.list')).toBe(2);

    // A project the listing gave no revision is never sent.
    await expect(store.getState().deleteProject(REPO)).rejects.toThrow();
    expect(core.count('core.workspace.delete')).toBe(1);
  });

  it('renaming a project sends a keyed patch at its listed revision (CAN-6099)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);

    await store.getState().updateProject(PROJECT, { name: 'Renamed' });

    const updates = core.calls.filter(
      (call) => call.method === 'core.workspace.update',
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.params).toMatchObject({
      workspaceId: PROJECT,
      expectedRevision: 3,
      patch: { name: 'Renamed' },
    });
    expect(typeof idempotencyKeyOf(updates[0]?.params)).toBe('string');
    expect(core.count('core.workspace.list')).toBe(2);
  });

  it('a refused update re-reads the project, so the next names the current revision (CAN-6099)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    // Another client changed the project: the web core is at revision 4.
    core.projectRevision = 4;
    core.updateRefusals.push({
      kind: 'conflict',
      message: 'The revision changed. Reread and retry.',
      retry: { kind: 'never' },
    });

    await expect(
      store.getState().updateProject(PROJECT, { name: 'Renamed' }),
    ).rejects.toThrow();
    expect(core.count('core.workspace.list')).toBe(2);

    await store.getState().updateProject(PROJECT, { name: 'Renamed' });
    const updates = core.calls.filter(
      (call) => call.method === 'core.workspace.update',
    );
    expect(updates.map((call) => call.params.expectedRevision)).toEqual([3, 4]);
  });
});

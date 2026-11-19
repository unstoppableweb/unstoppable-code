import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';
import { createCoreCoworkStore } from '../create-core-cowork-store';
import {
  CoreCoworkRequestError,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from '../invoker';
import { CoreCoworkOutcomeUnknownError } from '../unknown-outcome';
import {
  isUnknownKeyedWriteOutcome,
  KEYED_WRITE_OUTCOME_SHAPES,
} from '../keyed-write-outcome';

// A fake web core shaped like the CAN-4185 contract: `core.workspace.list`,
// `core.chat.task.list` per cowork project (and per git project, CAN-6106,
// when the test serves `repoTasks`), and one `core.chat.task.events` stream
// whose frames the test pushes.

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
  updateWarnings: string[] | undefined = undefined;
  /** As the web core: a write at another revision is refused; one that lands moves it. */
  enforceRevision = false;
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
  /** Tasks archived through `core.chat.archive`, kept as the web core keeps them. */
  archived: (FakeTask & { revision: number; locked: boolean })[] = [];
  /** Other containers the caller's archive lists: another project's, a worktree. */
  readonly foreignContainers: unknown[] = [];
  /** Refusals for the next restores. */
  readonly restoreRefusals: CanopyErrorPayload[] = [];
  /** Refusals for the next deletes. */
  readonly deleteRefusals: CanopyErrorPayload[] = [];
  /** Deletes that apply but lose their reply. */
  lostDeleteReplies = 0;
  /**
   * Archives that lose their reply (CAN-7196): applied, or, with
   * `lostArchivesApply` off, never reaching the task.
   */
  lostArchiveReplies = 0;
  lostArchivesApply = true;
  /**
   * How a lost reply reads: a same-key retry, as today, or S7c's unflagged
   * shape, unavailable and never retried (CAN-7196).
   */
  lostReplyRetry: 'same_idempotency_key' | 'never' = 'same_idempotency_key';
  /**
   * The git project's tasks (its worktree root chats), which the web core
   * serves since CAN-6106; null refuses the listing, as before it.
   */
  repoTasks: FakeTask[] | null = null;

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
    if (method === 'core.workspace.update' && this.enforceRevision) {
      if (params.expectedRevision !== this.projectRevision)
        return {
          ok: false,
          error: {
            kind: 'conflict',
            code: 'core.workspace.revisionConflict',
            message: 'The project changed.',
            retry: { kind: 'never' },
          },
        };
      this.projectRevision += 1;
    }
    if (method === 'core.workspace.update')
      return {
        ok: true,
        value: {
          workspaceId: PROJECT,
          name: 'Renamed',
          kind: 'cowork',
          repositorySources: [],
          settings: {},
          revision: this.projectRevision,
          ...(this.updateWarnings === undefined
            ? {}
            : { warnings: this.updateWarnings }),
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
            retry: { kind: this.lostReplyRetry },
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
    if (method === 'core.chat.archive') {
      // As the web core does: archiving a task's own chat archives the task.
      const tabId = String(Reflect.get(Object(params.action), 'tabId'));
      const known = this.tasks.some((task) => task.worktreeId === tabId);
      const lost = known && this.lostArchiveReplies > 0;
      if (lost) this.lostArchiveReplies -= 1;
      if (!lost || this.lostArchivesApply) {
        this.archived.push(
          ...this.tasks
            .filter((task) => task.worktreeId === tabId)
            .map((task) => ({ ...task, revision: 4, locked: true })),
        );
        this.tasks = this.tasks.filter((task) => task.worktreeId !== tabId);
      }
      if (lost)
        return {
          ok: false,
          error: {
            kind: 'unavailable',
            message: 'The reply was lost.',
            retry: { kind: this.lostReplyRetry },
          },
        };
      return {
        ok: true,
        value: {
          commandId: params.commandId,
          revision: 0,
          outcome: known ? 'applied' : 'already_applied',
          entityId: tabId,
        },
      };
    }
    if (method === 'core.chat.delete') {
      const refused = this.deleteRefusals.shift();
      if (refused) return { ok: false, error: refused };
      // As the web core does (chat.ts): a task's own chat in discard mode
      // moves the task to the Trash; one already there answers
      // already_applied whatever its command id.
      const tabId = String(Reflect.get(Object(params.action), 'tabId'));
      const known = this.tasks.some((task) => task.worktreeId === tabId);
      this.archived.push(
        ...this.tasks
          .filter((task) => task.worktreeId === tabId)
          .map((task) => ({ ...task, revision: 4, locked: false })),
      );
      this.tasks = this.tasks.filter((task) => task.worktreeId !== tabId);
      if (known && this.lostDeleteReplies > 0) {
        this.lostDeleteReplies -= 1;
        return {
          ok: false,
          error: {
            kind: 'unavailable',
            message: 'The reply was lost.',
            retry: { kind: this.lostReplyRetry },
          },
        };
      }
      return {
        ok: true,
        value: {
          commandId: params.commandId,
          revision: 0,
          outcome: known ? 'applied' : 'already_applied',
          entityId: tabId,
        },
      };
    }
    if (method === 'core.archive.container.list') {
      // As the web core does (archive.ts): a task is a work-entry container.
      return {
        ok: true,
        value: {
          workspaceId: params.workspaceId ?? null,
          containers: [
            ...this.archived.map((task) => ({
              archiveId: `work-entry:${task.worktreeId}`,
              kind: 'work-entry',
              workspaceId: PROJECT,
              workspaceName: this.projectName,
              revision: task.revision,
              name: task.title,
              branchName: null,
              archivedAt: task.updatedAt,
              expiresAt: task.locked ? null : '2026-12-07T10:00:00.000Z',
              locked: task.locked,
              lockedAt: task.locked ? task.updatedAt : null,
              chatCount: 0,
              archivedChatCount: 0,
              executionCount: 0,
              partiallyRestored: false,
              scope: { workspaceId: PROJECT, chatId: task.worktreeId },
            })),
            ...this.foreignContainers,
          ],
        },
      };
    }
    if (method === 'core.archive.container.restore') {
      const refused = this.restoreRefusals.shift();
      if (refused) return { ok: false, error: refused };
      const chatId = String(params.archiveId).replace(/^work-entry:/, '');
      const task = this.archived.find((each) => each.worktreeId === chatId);
      if (task === undefined || params.expectedRevision !== task.revision)
        return {
          ok: false,
          error: {
            kind: 'failed_precondition',
            message: 'The archived item changed.',
            code: 'core.archive.revisionConflict',
            retry: { kind: 'never' },
          },
        };
      this.archived = this.archived.filter((each) => each !== task);
      const { revision: _revision, locked: _locked, ...restored } = task;
      void _revision;
      void _locked;
      this.tasks = [restored, ...this.tasks];
      return {
        ok: true,
        value: {
          operation: {
            operationId: `op-${chatId}`,
            kind: 'core.archive.container.restore',
            status: 'completed',
          },
          restoredScope: { workspaceId: PROJECT, chatId },
        },
      };
    }
    if (method === 'core.chat.task.list') {
      const failure = this.taskListFailures.shift();
      if (failure) return { ok: false, error: failure };
      const scope = params.scope;
      const repo =
        typeof scope === 'object' &&
        scope !== null &&
        Reflect.get(scope, 'workspaceId') === REPO;
      if (repo && this.repoTasks === null)
        return {
          ok: false,
          error: {
            kind: 'invalid_argument',
            message: 'Only a cowork project lists tasks.',
            retry: { kind: 'never' },
          },
        };
      const tasks = (repo ? this.repoTasks : null) ?? this.tasks;
      const held = this.taskListHolds.shift();
      if (held) await held;
      return {
        ok: true,
        value: {
          items: tasks.map((task) => ({
            workspaceId: repo ? REPO : PROJECT,
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

  it.each(['never', 'same_idempotency_key'] as const)(
    'a create whose answer never came, with retry %s, reads unknown, is sent once, and the re-read that lists it settles it (CAN-7196)',
    async (lostRetry) => {
      const core = new FakeWebCore();
      const store = await connected(core);
      core.lostCreateReplies = 1;
      core.lostReplyRetry = lostRetry;
      const { task, created } = store.getState().beginTask(PROJECT);
      await expect(created).rejects.toThrow('The reply was lost.');
      expect(tasksOf(store)[0]).toEqual({
        worktreeId: task.worktreeId,
        creation: 'unknown',
      });
      // The project is read again, and the web core lists the task it
      // created: the row settles, created, and nothing created it twice.
      const reads = core.count('core.chat.task.list');
      await jest.advanceTimersByTimeAsync(250);
      expect(core.count('core.chat.task.list')).toBe(reads + 1);
      expect(tasksOf(store)).toEqual([
        { worktreeId: task.worktreeId, creation: undefined },
        { worktreeId: 'task-1', creation: undefined },
      ]);
      expect(core.count('core.chat.create')).toBe(1);
    },
  );

  // CAN-7196: an answered refusal is the core's own words, so a fresh
  // create it refuses fails. A retry of a create that ended unknown stays
  // unknown however it is answered, and the re-read settles it.
  it('fails a fresh create the web core refuses, but keeps a refused retry of an unknown create unknown until the re-read settles it (CAN-7196)', async () => {
    // An answered refusal that asks for nothing again.
    const rateLimited: CanopyErrorPayload = {
      kind: 'failed_precondition',
      message: 'Too many tasks at once.',
      retry: { kind: 'never' },
    };
    const core = new FakeWebCore();
    const store = await connected(core);
    core.createRefusals.push(rateLimited);
    const creationOf = (worktreeId: string): string | undefined =>
      tasksOf(store).find((each) => each.worktreeId === worktreeId)?.creation;
    const fresh = store.getState().beginTask(PROJECT);
    await expect(fresh.created).rejects.toThrow('Too many tasks at once.');
    expect(creationOf(fresh.task.worktreeId)).toBe('failed');

    core.lostCreateReplies = 1;
    const { task, created } = store.getState().beginTask(PROJECT);
    await expect(created).rejects.toThrow('The reply was lost.');
    core.createRefusals.push(rateLimited);
    await expect(
      store.getState().retryTask(PROJECT, task.worktreeId),
    ).rejects.toThrow('Too many tasks at once.');
    expect(creationOf(task.worktreeId)).toBe('unknown');
    // The project is read again, and the task the first create made settles.
    await jest.advanceTimersByTimeAsync(250);
    expect(creationOf(task.worktreeId)).toBeUndefined();
    expect(
      core.tasks.filter((each) => each.worktreeId === task.worktreeId),
    ).toHaveLength(1);
  });

  it('retries a task whose first create landed unanswered under the same id, so the web core keeps one task (CAN-6098)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    core.lostCreateReplies = 1;
    const release = hold(core);
    const { task, created } = store.getState().beginTask(PROJECT);
    release();
    await expect(created).rejects.toThrow('The reply was lost.');
    // It may exist, so it reads unknown, never refused (CAN-7196).
    expect(tasksOf(store)[0]).toEqual({
      worktreeId: task.worktreeId,
      creation: 'unknown',
    });
    expect(
      store.getState().tasksByProject[`web-core:${PROJECT}`]?.[0]
        ?.creationError,
    ).toBeUndefined();

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

  // The default, which desktop's cloud store runs with.
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

  // The web's background chats read a git worktree's working state and
  // badge from its task row once its REST binding is gone (CAN-6509).
  it("with repositoryTasks, lists a git project's tasks and re-reads them on its task events (CAN-6509)", async () => {
    const core = new FakeWebCore();
    core.repoTasks = [
      {
        worktreeId: 'root-1',
        title: 'Root',
        updatedAt: '2026-11-07T10:00:00Z',
      },
    ];
    const store = createCoreCoworkStore({ repositoryTasks: true });
    await store.getState().connect(core);
    expect(store.getState().status).toBe('online');
    const repoTaskIds = (): string[] =>
      (store.getState().tasksByProject[`web-core:${REPO}`] ?? []).map(
        (task) => task.worktreeId,
      );
    expect(repoTaskIds()).toEqual(['root-1']);
    expect(
      core.calls
        .filter((call) => call.method === 'core.chat.task.list')
        .map((call) => call.params.scope),
    ).toEqual([{ workspaceId: PROJECT }, { workspaceId: REPO }]);

    // Two task events, coalesced into one re-read as a cowork project's are.
    core.repoTasks = [
      ...core.repoTasks,
      {
        worktreeId: 'root-2',
        title: 'Next',
        updatedAt: '2026-11-07T11:00:00Z',
      },
    ];
    core.stream.item(1, {
      kind: 'task',
      workspaceId: REPO,
      worktreeId: 'root-1',
      batchId: 'batch-1',
    });
    core.stream.item(2, {
      kind: 'task',
      workspaceId: REPO,
      worktreeId: 'root-2',
      batchId: 'batch-2',
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(core.count('core.chat.task.list')).toBe(3);
    expect(core.count('core.workspace.list')).toBe(1);
    // Most recently updated first, as cowork tasks list.
    expect(repoTaskIds()).toEqual(['root-2', 'root-1']);
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

  it('archiving a task archives its own chat through core.chat.archive, keyed, and drops its row (CAN-6511)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    const { task, created } = store.getState().beginTask(PROJECT);
    await created;
    expect(tasksOf(store).map((row) => row.worktreeId)).toContain(
      task.worktreeId,
    );

    await store.getState().archiveTask(PROJECT, task.worktreeId);

    // The web's own Archive takes the same path: the task's own chat
    // archives the task with its tabs and stops its delegates.
    const archives = core.calls.filter(
      (call) => call.method === 'core.chat.archive',
    );
    expect(archives).toHaveLength(1);
    expect(archives[0]?.params).toMatchObject({
      projectId: PROJECT,
      worktreeId: task.worktreeId,
      action: { type: 'chat.archive_tab', tabId: task.worktreeId },
    });
    expect(typeof idempotencyKeyOf(archives[0]?.params)).toBe('string');
    expect(tasksOf(store).map((row) => row.worktreeId)).not.toContain(
      task.worktreeId,
    );
  });

  it('an archive the web core applied stands, and its row leaves, even when the re-read after it fails (CAN-6511)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    const { task, created } = store.getState().beginTask(PROJECT);
    await created;
    core.taskListFailures.push({
      kind: 'invalid_argument',
      message: 'The list read failed.',
      retry: { kind: 'never' },
    });

    await expect(
      store.getState().archiveTask(PROJECT, task.worktreeId),
    ).resolves.toBeUndefined();
    expect(tasksOf(store).map((row) => row.worktreeId)).not.toContain(
      task.worktreeId,
    );
  });

  it.each(['never', 'same_idempotency_key'] as const)(
    'an archive whose answer never came, with retry %s, is settled by the listing: gone is archived, still listed is not, and it is sent once (CAN-7196)',
    async (lostRetry) => {
      const core = new FakeWebCore();
      const store = await connected(core);
      core.lostReplyRetry = lostRetry;

      // It reached the task: the listing no longer holds it.
      core.lostArchiveReplies = 1;
      await expect(
        store.getState().archiveTask(PROJECT, 'task-1'),
      ).resolves.toBeUndefined();
      expect(core.count('core.chat.archive')).toBe(1);
      expect(tasksOf(store).map((row) => row.worktreeId)).not.toContain(
        'task-1',
      );

      // It never reached the task: still listed, so it wasn't archived.
      const { task, created } = store.getState().beginTask(PROJECT);
      await created;
      core.lostArchiveReplies = 1;
      core.lostArchivesApply = false;
      await expect(
        store.getState().archiveTask(PROJECT, task.worktreeId),
      ).rejects.toThrow('The cloud chat was not archived.');
      expect(core.count('core.chat.archive')).toBe(2);
      expect(tasksOf(store).map((row) => row.worktreeId)).toContain(
        task.worktreeId,
      );
    },
  );

  it("an archive whose answer never came, and whose listing could not be read, says it couldn't confirm it, never that it failed, and the next listing settles it (CAN-7196)", async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    core.lostReplyRetry = 'never';
    core.lostArchiveReplies = 1;
    core.taskListFailures.push({
      kind: 'unavailable',
      message: 'The web core is briefly unavailable.',
      retry: { kind: 'same_request' },
    });

    const archived = store.getState().archiveTask(PROJECT, 'task-1');
    await expect(archived).rejects.toBeInstanceOf(
      CoreCoworkOutcomeUnknownError,
    );
    await expect(archived).rejects.toThrow(
      "Couldn't confirm the task was archived. The list will show where it stands.",
    );
    expect(core.count('core.chat.archive')).toBe(1);
    // The project is read again on its own, and shows the task archived.
    await jest.advanceTimersByTimeAsync(250);
    expect(tasksOf(store).map((row) => row.worktreeId)).not.toContain('task-1');
    expect(core.count('core.chat.archive')).toBe(1);
    expect(store.getState().status).toBe('online');
  });

  it('deleting a task moves its own chat to the Trash through core.chat.delete, keyed, and drops its row (CAN-7052)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    const { task, created } = store.getState().beginTask(PROJECT);
    await created;

    await store.getState().deleteTask(PROJECT, task.worktreeId);

    // The web's own Delete takes the same path: discard mode on the task's
    // own chat, never an archive and never a batch.
    const deletes = core.calls.filter(
      (call) => call.method === 'core.chat.delete',
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.params).toMatchObject({
      projectId: PROJECT,
      worktreeId: task.worktreeId,
      action: {
        type: 'chat.close_tab',
        tabId: task.worktreeId,
        mode: 'discard',
      },
    });
    expect(idempotencyKeyOf(deletes[0]?.params)).toBe(
      deletes[0]?.params.commandId,
    );
    expect(core.count('core.chat.archive')).toBe(0);
    expect(tasksOf(store).map((row) => row.worktreeId)).not.toContain(
      task.worktreeId,
    );
    // It lists as deleted, restorable, not archived.
    await expect(
      store.getState().listArchivedTasks(PROJECT),
    ).resolves.toMatchObject([
      { worktreeId: task.worktreeId, state: 'deleted' },
    ]);
  });

  it('a refused delete rejects and leaves the task where it was (CAN-7052)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    core.deleteRefusals.push({
      kind: 'failed_precondition',
      message: 'A tab goes to the Trash with its task.',
      code: 'core.chat.invalidState',
      retry: { kind: 'never' },
    });

    await expect(
      store.getState().deleteTask(PROJECT, 'task-1'),
    ).rejects.toThrow();
    expect(tasksOf(store).map((row) => row.worktreeId)).toContain('task-1');
    expect(core.archived).toHaveLength(0);
  });

  it.each(['never', 'same_idempotency_key'] as const)(
    'a delete whose answer never came, with retry %s, is settled by the listing that no longer holds the task, sent once (CAN-7196)',
    async (lostRetry) => {
      const core = new FakeWebCore();
      const store = await connected(core);
      core.lostDeleteReplies = 1;
      core.lostReplyRetry = lostRetry;

      // The delete applied, but its answer never arrived: the project's
      // listing says it did, and nothing sends it again.
      await expect(
        store.getState().deleteTask(PROJECT, 'task-1'),
      ).resolves.toBeUndefined();
      expect(core.count('core.chat.delete')).toBe(1);
      expect(core.archived).toHaveLength(1);
      expect(tasksOf(store).map((row) => row.worktreeId)).not.toContain(
        'task-1',
      );
    },
  );

  it("lists a project's archived and deleted tasks from its work-entry containers, newest first, and nothing else (CAN-6511)", async () => {
    const core = new FakeWebCore();
    core.archived = [
      {
        worktreeId: 'old-task',
        title: 'Old',
        updatedAt: '2026-11-01T10:00:00Z',
        revision: 2,
        locked: false,
      },
      {
        worktreeId: 'new-task',
        title: 'New',
        updatedAt: '2026-11-09T10:00:00Z',
        revision: 5,
        locked: true,
      },
    ];
    const container = (overrides: Record<string, unknown>): unknown => ({
      archiveId: 'other',
      kind: 'work-entry',
      workspaceId: PROJECT,
      workspaceName: 'Research',
      revision: 1,
      name: 'Other',
      branchName: null,
      archivedAt: '2026-11-08T10:00:00Z',
      expiresAt: null,
      locked: true,
      lockedAt: null,
      chatCount: 0,
      archivedChatCount: 0,
      executionCount: 0,
      partiallyRestored: false,
      scope: { workspaceId: PROJECT, chatId: 'other-task' },
      ...overrides,
    });
    // Another project's task, a worktree, a whole project, and a container
    // with no revision or chat are not this project's tasks.
    core.foreignContainers.push(
      container({
        workspaceId: REPO,
        scope: { workspaceId: REPO, chatId: 'x' },
      }),
      container({
        kind: 'worktree',
        scope: { workspaceId: PROJECT, worktreeId: 'w' },
      }),
      container({ kind: 'workspace', scope: { workspaceId: PROJECT } }),
      container({ revision: null }),
      container({ scope: { workspaceId: PROJECT } }),
    );
    const store = await connected(core);

    const tasks = await store.getState().listArchivedTasks(PROJECT);

    expect(tasks).toEqual([
      {
        archiveId: 'work-entry:new-task',
        revision: 5,
        worktreeId: 'new-task',
        title: 'New',
        archivedAt: '2026-11-09T10:00:00Z',
        state: 'archived',
        expiresAt: null,
      },
      {
        archiveId: 'work-entry:old-task',
        revision: 2,
        worktreeId: 'old-task',
        title: 'Old',
        archivedAt: '2026-11-01T10:00:00Z',
        state: 'deleted',
        expiresAt: '2026-12-07T10:00:00.000Z',
      },
    ]);
    expect(
      core.calls.find((call) => call.method === 'core.archive.container.list')
        ?.params,
    ).toEqual({ workspaceId: PROJECT });
  });

  it('restoring a task restores its container in place at its listed revision, keyed, and lists it again (CAN-6511)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    await store.getState().archiveTask(PROJECT, 'task-1');
    expect(tasksOf(store).map((row) => row.worktreeId)).not.toContain('task-1');
    const [archived] = await store.getState().listArchivedTasks(PROJECT);
    expect(archived).toMatchObject({ worktreeId: 'task-1', revision: 4 });

    await store.getState().restoreTask(PROJECT, archived);

    const restores = core.calls.filter(
      (call) => call.method === 'core.archive.container.restore',
    );
    expect(restores).toHaveLength(1);
    expect(restores[0]?.params).toMatchObject({
      archiveId: 'work-entry:task-1',
      expectedRevision: 4,
      destinationScope: { workspaceId: PROJECT },
      conflictPolicy: 'fail',
    });
    expect(typeof idempotencyKeyOf(restores[0]?.params)).toBe('string');
    expect(tasksOf(store).map((row) => row.worktreeId)).toContain('task-1');
  });

  it('a restored task that this window kept as deleted comes back live, not deleted (CAN-6511, CAN-6614)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    await store.getState().archiveTask(PROJECT, 'task-1');
    // The window saw the task go and kept its row, marked deleted, for the
    // draft it held.
    store.getState().keepDeletedTask(PROJECT, 'task-1', 'Task 1');
    const rows = (): readonly { worktreeId: string; deleted?: true }[] =>
      store.getState().tasksByProject[`web-core:${PROJECT}`] ?? [];
    expect(rows().find((row) => row.worktreeId === 'task-1')?.deleted).toBe(
      true,
    );
    const [archived] = await store.getState().listArchivedTasks(PROJECT);

    await store.getState().restoreTask(PROJECT, archived);

    const restored = rows().filter((row) => row.worktreeId === 'task-1');
    expect(restored).toHaveLength(1);
    expect(restored[0]?.deleted).toBeUndefined();
  });

  it('a refused restore rejects and leaves the task archived (CAN-6511)', async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    await store.getState().archiveTask(PROJECT, 'task-1');
    const [archived] = await store.getState().listArchivedTasks(PROJECT);
    core.restoreRefusals.push({
      kind: 'failed_precondition',
      message: 'Restore the project first.',
      retry: { kind: 'never' },
    });

    await expect(
      store.getState().restoreTask(PROJECT, archived),
    ).rejects.toBeDefined();
    expect(tasksOf(store).map((row) => row.worktreeId)).not.toContain('task-1');
    await expect(
      store.getState().listArchivedTasks(PROJECT),
    ).resolves.toHaveLength(1);
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

  it("a project's egress hosts, host mode and ports go in the same keyed patch at its listed revision, and the save's warnings come back (CAN-7053)", async () => {
    const core = new FakeWebCore();
    const store = await connected(core);

    await expect(
      store.getState().updateProject(PROJECT, {
        egressAllowedHosts: ['api.example.com'],
        hostModeEnabled: true,
        hostPorts: [3000, 8080],
      }),
    ).resolves.toEqual({ warnings: [], revision: 3 });
    core.updateWarnings = ["The ports didn't reach the running sandbox."];
    await expect(
      store.getState().updateProject(PROJECT, { hostModeEnabled: false }),
    ).resolves.toEqual({
      warnings: ["The ports didn't reach the running sandbox."],
      revision: 3,
    });

    const updates = core.calls.filter(
      (call) => call.method === 'core.workspace.update',
    );
    expect(updates.map((call) => call.params.patch)).toEqual([
      {
        egressAllowedHosts: ['api.example.com'],
        hostModeEnabled: true,
        hostPorts: [3000, 8080],
      },
      { hostModeEnabled: false },
    ]);
    expect(updates[0]?.params).toMatchObject({
      workspaceId: PROJECT,
      expectedRevision: 3,
    });
    expect(typeof idempotencyKeyOf(updates[0]?.params)).toBe('string');
  });

  it("a settings dialog's own read revision guards its save, not the listing's (CAN-7053)", async () => {
    const core = new FakeWebCore();
    const store = await connected(core);
    // The listing says 3; the dialog read the project at 2.
    await store
      .getState()
      .updateProject(
        PROJECT,
        { egressAllowedHosts: ['api.example.com'] },
        { expectedRevision: 2 },
      );
    const [update] = core.calls.filter(
      (call) => call.method === 'core.workspace.update',
    );
    expect(update?.params.expectedRevision).toBe(2);
  });

  it('a rename at the listed revision after a sandbox edit elsewhere is refused once, re-lists, then lands (CAN-7053)', async () => {
    const core = new FakeWebCore();
    core.enforceRevision = true;
    const store = await connected(core);
    // Another client saved the project's egress hosts: the web core moved
    // the revision to 4, as it now does for sandbox settings.
    core.projectRevision = 4;

    await expect(
      store.getState().updateProject(PROJECT, { name: 'Renamed' }),
    ).rejects.toThrow();
    await expect(
      store.getState().updateProject(PROJECT, { name: 'Renamed' }),
    ).resolves.toEqual({ warnings: [], revision: 5 });
    const updates = core.calls.filter(
      (call) => call.method === 'core.workspace.update',
    );
    expect(updates.map((call) => call.params.expectedRevision)).toEqual([3, 4]);
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

// SWAN guardrail (CAN-7196, 12:16): a write reads as unknown, and says it
// couldn't confirm it, only when its answer never came: lost and never
// retried, or a same-key retry, which is also how the client's own deadline
// after dispatch arrives. Every error the core answered stays a refusal.
describe('which keyed write errors read as unknown (CAN-7196)', () => {
  it.each(KEYED_WRITE_OUTCOME_SHAPES.map((row) => [row.name, row] as const))(
    '%s',
    (_name, row) => {
      expect(isUnknownKeyedWriteOutcome(row.payload)).toBe(row.unknown);
    },
  );
});

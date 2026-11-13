import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  CanopyErrorPayloadSchema,
  CanopyStreamCursorSchema,
  CoreChatLifecycleResultSchema,
  CoreChatTaskEventsItemSchema,
  CoreChatTaskListResultSchema,
  CoreWorkspaceDeleteResultSchema,
  CoreWorkspaceListResultSchema,
  CoreWorkspaceReorderResultSchema,
  CoreWorkspaceUpdateResultSchema,
  isCanopySnapshotRequiredError,
  type CanopyErrorPayload,
  type CanopyStreamCursor,
  type CoreChatTask,
} from '@canopy/protocol/canopy-core';
import {
  CoreCoworkRequestError,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from './invoker';

export type CoreCoworkStatus = 'disabled' | 'offline' | 'online';

export interface CoreCoworkProject {
  key: string;
  workspaceId: string;
  name: string;
  /** A `git` (repository-backed) project is listed but has no task list. */
  kind: 'cowork' | 'git';
  color?: string;
  ownerOrganizationId: string | null;
  /** The listing's revision, which a delete must name. */
  revision?: number;
}

export interface CoreCoworkTask {
  key: string;
  workspaceId: string;
  worktreeId: string;
  title: string;
  state: string;
  updatedAt: string;
  /**
   * A task this window started creating and the web core has not listed
   * yet (CAN-6098): `pending` while its create runs, `failed` once it was
   * refused, with `creationError` saying why. Absent for a listed task.
   */
  creation?: 'pending' | 'failed';
  creationError?: string;
}

/** A task opened at once, and its creation settling behind it (CAN-6098). */
export interface CoreCoworkTaskStart {
  readonly task: CoreCoworkTask;
  /** The listed task once the web core created it; rejects with why not. */
  readonly created: Promise<CoreCoworkTask>;
}

export interface CoreCoworkState {
  status: CoreCoworkStatus;
  generation: number;
  projects: readonly CoreCoworkProject[];
  tasksByProject: Readonly<Record<string, readonly CoreCoworkTask[]>>;
  connect(invoker: CoreCoworkInvoker): Promise<void>;
  /** Clears every project and task; nothing is kept for later display. */
  disconnect(reason: 'disabled' | 'offline'): void;
  /**
   * `core.chat.create` with a new UUID tab id, which is the task's
   * `worktreeId`; the row shows once the web core created it.
   */
  createTask(workspaceId: string, title?: string): Promise<CoreCoworkTask>;
  /**
   * Starts a task and returns it at once, as a `pending` row, while
   * `core.chat.create` and the project's re-read settle behind it
   * (CAN-6098). A refused create leaves the row `failed`.
   */
  beginTask(workspaceId: string, title?: string): CoreCoworkTaskStart;
  /**
   * Creates a `failed` task again under the same id, so a create that did
   * land, slowly, is replayed and never doubled.
   */
  retryTask(workspaceId: string, worktreeId: string): Promise<CoreCoworkTask>;
  /** The create in flight for a task this window started, if any. */
  taskCreation(
    workspaceId: string,
    worktreeId: string,
  ): Promise<CoreCoworkTask> | undefined;
  archiveTask(workspaceId: string, worktreeId: string): Promise<void>;
  /**
   * `core.workspace.reorder`: moves `active` to `over`'s slot among the
   * projects the caller shows, then re-lists. The list moves at once.
   */
  reorderProjects(
    activeWorkspaceId: string,
    overWorkspaceId: string,
    visibleWorkspaceIds: readonly string[],
  ): Promise<void>;
  /** `core.workspace.update` of the name or colour, then re-lists. */
  updateProject(
    workspaceId: string,
    patch: { readonly name?: string; readonly color?: string },
  ): Promise<void>;
  /** `core.workspace.delete`: the project moves to the trash, then re-lists. */
  deleteProject(workspaceId: string): Promise<void>;
}

/** Every key this store hands out names its authority (CAN-4185 D6). */
const AUTHORITY = 'web-core';
const TASK_REREAD_COALESCE_MS = 250;
const PAGE_SIZE = 500;

const projectKey = (workspaceId: string): string =>
  `${AUTHORITY}:${workspaceId}`;
const taskKey = (workspaceId: string, worktreeId: string): string =>
  `${AUTHORITY}:${workspaceId}:${worktreeId}`;

/** Tries of a failing reread, and the pause before each, growing. */
const REREAD_RETRIES = 3;
const REREAD_RETRY_MS = 1_000;

/** The pause before each reconnect in a row; the last repeats. */
export const RECONNECT_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 5_000, 10_000, 30_000,
];

export interface CoreCoworkStoreOptions {
  /**
   * A fresh invoker for a store whose connection was lost, or null when
   * none can be had now (CAN-6442). With it, the store reconnects by itself
   * after each pause in {@link RECONNECT_DELAYS_MS} until it is online again
   * or disconnected; without it, only the host reconnects it.
   */
  readonly reconnect?: () => CoreCoworkInvoker | null;
}

/** A generation that moved on while a reply was in flight. */
class StaleGenerationError extends Error {}

/** A request the core refused only for now: the same read may land later. */
function isRetryableRead(error: unknown): boolean {
  return (
    error instanceof CoreCoworkRequestError &&
    error.payload.retry.kind !== 'never'
  );
}

/** The delay the core asked a retried read to wait, such as a gateway's Retry-After. */
function retryDelayMs(error: unknown): number {
  if (!(error instanceof CoreCoworkRequestError)) return 0;
  const { retry } = error.payload;
  return retry.kind === 'never' ? 0 : (retry.delayMs ?? 0);
}

type Frame =
  | { kind: 'item'; cursor: CanopyStreamCursor; item: unknown }
  | { kind: 'end'; error: CanopyErrorPayload | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function toFrame(value: unknown): Frame {
  if (isRecord(value) && value.kind === 'item') {
    const cursor = CanopyStreamCursorSchema.safeParse(value.cursor);
    if (cursor.success)
      return { kind: 'item', cursor: cursor.data, item: value.item };
  }
  if (isRecord(value) && value.kind === 'end') {
    const error = CanopyErrorPayloadSchema.safeParse(value.error);
    return { kind: 'end', error: error.success ? error.data : null };
  }
  return {
    kind: 'end',
    error: {
      kind: 'internal',
      message: 'The task stream sent an invalid frame.',
      retry: { kind: 'never' },
    },
  };
}

/** Only an item past the applied cursor of the same epoch is new. */
function isAfter(
  cursor: CanopyStreamCursor,
  applied: CanopyStreamCursor | null,
): boolean {
  return (
    applied === null ||
    cursor.daemonEpoch !== applied.daemonEpoch ||
    cursor.sequence > applied.sequence
  );
}

function toTask(task: CoreChatTask): CoreCoworkTask {
  return {
    key: taskKey(task.workspaceId, task.worktreeId),
    workspaceId: task.workspaceId,
    worktreeId: task.worktreeId,
    title: task.title,
    state: task.state,
    updatedAt: task.updatedAt,
  };
}

function newestFirst(tasks: readonly CoreCoworkTask[]): CoreCoworkTask[] {
  return [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The task as the web core lists it, without this window's creation state. */
function withoutCreation(task: CoreCoworkTask): CoreCoworkTask {
  return {
    key: task.key,
    workspaceId: task.workspaceId,
    worktreeId: task.worktreeId,
    title: task.title,
    state: task.state,
    updatedAt: task.updatedAt,
  };
}

/**
 * A project's listed tasks, with the ones this window is still creating, or
 * failed to create, kept at the top until the web core lists them.
 */
function withLocalTasks(
  listed: readonly CoreCoworkTask[],
  previous: readonly CoreCoworkTask[] | undefined,
): CoreCoworkTask[] {
  const local = (previous ?? []).filter(
    (task) =>
      task.creation !== undefined &&
      !listed.some((each) => each.key === task.key),
  );
  return [...local, ...listed];
}

const EMPTY = {
  projects: [],
  tasksByProject: {},
} satisfies Pick<CoreCoworkState, 'projects' | 'tasksByProject'>;

/**
 * Cloud cowork projects and their tasks from one core, read through
 * `core.workspace.list` and `core.chat.task.list` and kept live by one
 * `core.chat.task.events` stream (CAN-4185 D13). Transport-neutral: the host
 * passes a {@link CoreCoworkInvoker}. Leaving `online` drops everything, so
 * an offline core never shows a cached snapshot (D7).
 */
export function createCoreCoworkStore(
  options: CoreCoworkStoreOptions = {},
): StoreApi<CoreCoworkState> {
  let invoker: CoreCoworkInvoker | null = null;
  let stream: CoreCoworkStream | null = null;
  let appliedCursor: CanopyStreamCursor | null = null;
  let rereadTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingRereads = new Set<string>();
  let pendingResync = false;
  /** Rereads failed in a row with a retryable answer. */
  let failedRereads = 0;
  // Refreshes run one at a time, so an older read never lands after a newer one.
  let refreshQueue: Promise<void> = Promise.resolve();
  /** Each task's create in flight, by task key, for what waits on it. */
  const creations = new Map<string, Promise<CoreCoworkTask>>();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Reconnects tried since the store was last online. */
  let reconnects = 0;

  const store = createStore<CoreCoworkState>()((set, get) => {
    const assertCurrent = (generation: number): void => {
      if (get().generation !== generation) throw new StaleGenerationError();
    };

    const call = async (
      generation: number,
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      if (!invoker) throw new StaleGenerationError();
      const reply = await invoker.request(method, params);
      assertCurrent(generation);
      if (!reply.ok) throw new CoreCoworkRequestError(reply.error);
      return reply.value;
    };

    const serialized = (work: () => Promise<void>): Promise<void> => {
      const run = refreshQueue.then(work);
      refreshQueue = run.catch(() => undefined);
      return run;
    };

    const releaseConnection = (): void => {
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      refreshQueue = Promise.resolve();
      creations.clear();
      if (rereadTimer !== null) clearTimeout(rereadTimer);
      rereadTimer = null;
      pendingRereads.clear();
      pendingResync = false;
      failedRereads = 0;
      appliedCursor = null;
      const open = stream;
      stream = null;
      invoker = null;
      if (open) void open.close().catch(() => undefined);
    };

    const listTasks = async (
      generation: number,
      workspaceId: string,
    ): Promise<CoreCoworkTask[]> => {
      const tasks: CoreCoworkTask[] = [];
      let cursor: string | null = null;
      do {
        const value = await call(generation, 'core.chat.task.list', {
          scope: { workspaceId },
          pageSize: PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }),
        });
        const page = CoreChatTaskListResultSchema.parse(value);
        tasks.push(...page.items.map(toTask));
        cursor = page.nextCursor;
      } while (cursor !== null);
      return newestFirst(tasks);
    };

    const listProjects = async (
      generation: number,
    ): Promise<CoreCoworkProject[]> => {
      const projects: CoreCoworkProject[] = [];
      let cursor: string | null = null;
      do {
        const value = await call(generation, 'core.workspace.list', {
          pageSize: PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }),
        });
        const page = CoreWorkspaceListResultSchema.parse(value);
        for (const workspace of page.items) {
          projects.push({
            key: projectKey(workspace.workspaceId),
            workspaceId: workspace.workspaceId,
            name: workspace.name,
            kind: workspace.kind,
            ...(workspace.color === undefined
              ? {}
              : { color: workspace.color }),
            // An absent owner means the authority does not scope by
            // organization: the project is the user's own, so Personal, as
            // the shared sidebar places rows with no owner (CAN-6100).
            ownerOrganizationId: workspace.ownerOrganizationId ?? null,
            ...(workspace.revision === undefined
              ? {}
              : { revision: workspace.revision }),
          });
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      return projects;
    };

    const relistAll = async (generation: number): Promise<void> => {
      const projects = await listProjects(generation);
      // `core.chat.task.list` refuses a repository project.
      const lists = await Promise.all(
        projects.map((project) =>
          project.kind === 'cowork'
            ? listTasks(generation, project.workspaceId)
            : Promise.resolve<CoreCoworkTask[]>([]),
        ),
      );
      assertCurrent(generation);
      const tasksByProject: Record<string, readonly CoreCoworkTask[]> = {};
      projects.forEach((project, index) => {
        tasksByProject[project.key] = withLocalTasks(
          lists[index] ?? [],
          get().tasksByProject[project.key],
        );
      });
      set({ projects, tasksByProject });
    };

    const rereadProject = async (
      generation: number,
      workspaceId: string,
    ): Promise<void> => {
      const tasks = await listTasks(generation, workspaceId);
      const key = projectKey(workspaceId);
      if (!get().projects.some((project) => project.key === key)) return;
      set({
        tasksByProject: {
          ...get().tasksByProject,
          [key]: withLocalTasks(tasks, get().tasksByProject[key]),
        },
      });
    };

    /** Replaces a task row this window is creating, if it is still shown. */
    const patchTask = (
      task: CoreCoworkTask,
      patch: {
        readonly creation: CoreCoworkTask['creation'];
        readonly creationError: string | undefined;
      },
    ): void => {
      const key = projectKey(task.workspaceId);
      const tasks = get().tasksByProject[key];
      if (!tasks?.some((each) => each.key === task.key)) return;
      set({
        tasksByProject: {
          ...get().tasksByProject,
          [key]: tasks.map((each) => {
            if (each.key !== task.key) return each;
            return {
              ...withoutCreation(each),
              ...(patch.creation === undefined
                ? {}
                : { creation: patch.creation }),
              ...(patch.creationError === undefined
                ? {}
                : { creationError: patch.creationError }),
            };
          }),
        },
      });
    };

    /**
     * `core.chat.create` for a task. The tab id is the task's id and the
     * chat's external id, so a create repeated under it, after one that landed
     * without an answer, replays that chat rather than making another; each
     * attempt still carries its own command id.
     */
    const createChat = async (
      generation: number,
      task: CoreCoworkTask,
    ): Promise<void> => {
      const commandId = globalThis.crypto.randomUUID();
      const value = await call(generation, 'core.chat.create', {
        projectId: task.workspaceId,
        worktreeId: task.worktreeId,
        commandId,
        _meta: { idempotencyKey: commandId },
        action: {
          type: 'chat.create_tab',
          tabId: task.worktreeId,
          ...(task.title === '' ? {} : { title: task.title }),
        },
      });
      const result = CoreChatLifecycleResultSchema.parse(value);
      if (result.outcome !== 'applied' && result.outcome !== 'already_applied')
        throw new Error(result.reason ?? 'The cloud chat was not created.');
    };

    /** A task this window started, created, then its project re-read. */
    const settleCreation = (task: CoreCoworkTask): Promise<CoreCoworkTask> => {
      const generation = get().generation;
      patchTask(task, { creation: 'pending', creationError: undefined });
      const run = (async (): Promise<CoreCoworkTask> => {
        await createChat(generation, task);
        // The task exists from here: a failed re-read leaves it created, and
        // the project is re-read again as an event would have it.
        await serialized(() =>
          rereadProject(generation, task.workspaceId),
        ).catch((error: unknown) => {
          if (error instanceof StaleGenerationError) throw error;
          pendingRereads.add(task.workspaceId);
          scheduleReread(generation);
        });
        const listed = get().tasksByProject[projectKey(task.workspaceId)]?.find(
          (each) => each.key === task.key,
        );
        if (listed !== undefined && listed.creation === undefined)
          return listed;
        // Created, and not listed yet: the row stays, no longer pending.
        patchTask(task, { creation: undefined, creationError: undefined });
        return withoutCreation(task);
      })();
      creations.set(task.key, run);
      run.then(
        () => {
          if (creations.get(task.key) === run) creations.delete(task.key);
        },
        (error: unknown) => {
          if (creations.get(task.key) !== run) return;
          creations.delete(task.key);
          if (get().generation !== generation) return;
          // A listing that already holds the task outranks a late refusal,
          // such as a create whose reply was lost.
          const shown = get().tasksByProject[
            projectKey(task.workspaceId)
          ]?.find((each) => each.key === task.key);
          if (shown?.creation !== 'pending') return;
          patchTask(task, {
            creation: 'failed',
            creationError:
              error instanceof Error
                ? error.message
                : 'The cloud chat was not created.',
          });
        },
      );
      return run;
    };

    const goOffline = (generation: number): void => {
      if (get().generation !== generation) return;
      get().disconnect('offline');
      scheduleReconnect(get().generation);
    };

    /** Reconnects a store that went offline by itself, after a growing pause. */
    const scheduleReconnect = (generation: number): void => {
      const reconnect = options.reconnect;
      if (reconnect === undefined) return;
      const delayMs =
        RECONNECT_DELAYS_MS[
          Math.min(reconnects, RECONNECT_DELAYS_MS.length - 1)
        ] ?? 30_000;
      reconnects += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (get().generation !== generation) return;
        const next = reconnect();
        if (next === null) scheduleReconnect(generation);
        else void get().connect(next);
      }, delayMs);
    };

    const flushRereads = (generation: number): void => {
      rereadTimer = null;
      const resync = pendingResync;
      const workspaceIds = [...pendingRereads];
      pendingResync = false;
      pendingRereads.clear();
      const work = serialized(async () => {
        if (resync) await relistAll(generation);
        else
          for (const workspaceId of workspaceIds)
            await rereadProject(generation, workspaceId);
      });
      void work.then(
        () => {
          failedRereads = 0;
        },
        (error: unknown) => {
          if (error instanceof StaleGenerationError) return;
          // A read the core answered as worth retrying (a gateway that lost
          // the request, CAN-6394) is read again; the connection still
          // stands, so the section stays. Only a lasting failure is offline.
          if (
            isRetryableRead(error) &&
            failedRereads < REREAD_RETRIES &&
            get().generation === generation
          ) {
            failedRereads += 1;
            if (resync) pendingResync = true;
            for (const workspaceId of workspaceIds)
              pendingRereads.add(workspaceId);
            scheduleReread(
              generation,
              Math.max(REREAD_RETRY_MS * failedRereads, retryDelayMs(error)),
            );
            return;
          }
          goOffline(generation);
        },
      );
    };

    const scheduleReread = (
      generation: number,
      delayMs = TASK_REREAD_COALESCE_MS,
    ): void => {
      rereadTimer ??= setTimeout(() => flushRereads(generation), delayMs);
    };

    const openTaskStream = async (generation: number): Promise<void> => {
      if (!invoker) throw new StaleGenerationError();
      const opened = await invoker.openStream('core.chat.task.events', {
        scope: 'all',
        cursor: appliedCursor,
      });
      if (get().generation !== generation) {
        void opened.close().catch(() => undefined);
        throw new StaleGenerationError();
      }
      stream = opened;
    };

    /** Re-lists from a fresh, cursorless stream; the caller skips its leading `resync`. */
    const restartFromSnapshot = async (generation: number): Promise<void> => {
      appliedCursor = null;
      await openTaskStream(generation);
      await serialized(() => relistAll(generation));
    };

    /** A cursorless open always yields one leading `resync` first. */
    const pump = async (
      generation: number,
      skipLeadingResync: boolean,
    ): Promise<void> => {
      let leading = skipLeadingResync;
      let endedWithoutItems = 0;
      for (;;) {
        const current = stream;
        if (!current || get().generation !== generation) return;
        const result = await current.next();
        if (get().generation !== generation) return;
        const frame: Frame = result.done
          ? { kind: 'end', error: null }
          : toFrame(result.value);
        if (frame.kind === 'end') {
          stream = null;
          void current.close().catch(() => undefined);
          if (isCanopySnapshotRequiredError(frame.error)) {
            await restartFromSnapshot(generation);
            leading = true;
            continue;
          }
          if (frame.error !== null)
            throw new CoreCoworkRequestError(frame.error);
          // A stream the core ended cleanly resumes after the applied cursor,
          // unless it keeps ending with nothing delivered.
          endedWithoutItems += 1;
          if (endedWithoutItems > 1)
            throw new Error('The task stream keeps ending.');
          try {
            await openTaskStream(generation);
            leading = false;
          } catch (error) {
            // The applied cursor may have aged out while the stream was closed.
            if (
              !(error instanceof CoreCoworkRequestError) ||
              !isCanopySnapshotRequiredError(error.payload)
            )
              throw error;
            await restartFromSnapshot(generation);
            leading = true;
          }
          continue;
        }
        endedWithoutItems = 0;
        if (!isAfter(frame.cursor, appliedCursor)) continue;
        appliedCursor = frame.cursor;
        const item = CoreChatTaskEventsItemSchema.safeParse(frame.item);
        const wasLeading = leading;
        leading = false;
        if (!item.success) continue;
        if (item.data.kind === 'resync') {
          if (wasLeading) continue;
          pendingResync = true;
        } else {
          const { workspaceId } = item.data;
          const listed = get().projects.find(
            (p) => p.workspaceId === workspaceId,
          );
          // A task in a project this list does not hold yet: a new project.
          if (listed === undefined) pendingResync = true;
          else if (listed.kind === 'cowork') pendingRereads.add(workspaceId);
          else continue;
        }
        scheduleReread(generation);
      }
    };

    return {
      status: 'disabled',
      generation: 0,
      ...EMPTY,

      connect: async (next): Promise<void> => {
        releaseConnection();
        const generation = get().generation + 1;
        // A first connect stays `disabled` (nothing shown) until it settles.
        const status = get().status === 'online' ? 'offline' : get().status;
        set({ generation, status, ...EMPTY });
        invoker = next;
        try {
          // Opened before the first list, so nothing between the two is lost.
          await openTaskStream(generation);
          await relistAll(generation);
          assertCurrent(generation);
          reconnects = 0;
          set({ status: 'online' });
        } catch (error) {
          if (error instanceof StaleGenerationError) return;
          goOffline(generation);
          return;
        }
        void pump(generation, true).catch((error: unknown) => {
          if (!(error instanceof StaleGenerationError)) goOffline(generation);
        });
      },

      disconnect: (reason): void => {
        releaseConnection();
        if (reason === 'disabled') reconnects = 0;
        set({ generation: get().generation + 1, status: reason, ...EMPTY });
      },

      createTask: async (workspaceId, title): Promise<CoreCoworkTask> => {
        const generation = get().generation;
        if (get().status !== 'online')
          throw new Error('Cloud chats are offline.');
        const tabId = globalThis.crypto.randomUUID();
        const task: CoreCoworkTask = {
          key: taskKey(workspaceId, tabId),
          workspaceId,
          worktreeId: tabId,
          title: title ?? '',
          state: 'idle',
          updatedAt: new Date().toISOString(),
        };
        await createChat(generation, task);
        await serialized(() => rereadProject(generation, workspaceId));
        const listed = get().tasksByProject[projectKey(workspaceId)]?.find(
          (each) => each.key === task.key,
        );
        if (listed) return listed;
        const projectTasks =
          get().tasksByProject[projectKey(workspaceId)] ?? [];
        set({
          tasksByProject: {
            ...get().tasksByProject,
            [projectKey(workspaceId)]: [task, ...projectTasks],
          },
        });
        return task;
      },

      beginTask: (workspaceId, title): CoreCoworkTaskStart => {
        if (get().status !== 'online')
          throw new Error('Cloud chats are offline.');
        const tabId = globalThis.crypto.randomUUID();
        const task: CoreCoworkTask = {
          key: taskKey(workspaceId, tabId),
          workspaceId,
          worktreeId: tabId,
          title: title ?? '',
          state: 'idle',
          updatedAt: new Date().toISOString(),
          creation: 'pending',
        };
        const key = projectKey(workspaceId);
        set({
          tasksByProject: {
            ...get().tasksByProject,
            [key]: [task, ...(get().tasksByProject[key] ?? [])],
          },
        });
        return { task, created: settleCreation(task) };
      },

      retryTask: (workspaceId, worktreeId): Promise<CoreCoworkTask> => {
        const task = get().tasksByProject[projectKey(workspaceId)]?.find(
          (each) => each.key === taskKey(workspaceId, worktreeId),
        );
        if (task?.creation !== 'failed')
          return Promise.reject(
            new Error('This task is not waiting on a retry.'),
          );
        return settleCreation(task);
      },

      taskCreation: (
        workspaceId,
        worktreeId,
      ): Promise<CoreCoworkTask> | undefined =>
        creations.get(taskKey(workspaceId, worktreeId)),

      archiveTask: async (workspaceId, worktreeId): Promise<void> => {
        const generation = get().generation;
        if (get().status !== 'online')
          throw new Error('Cloud chats are offline.');
        const commandId = globalThis.crypto.randomUUID();
        const value = await call(generation, 'core.chat.archive', {
          projectId: workspaceId,
          worktreeId,
          commandId,
          _meta: { idempotencyKey: commandId },
          action: { type: 'chat.archive_tab', tabId: worktreeId },
        });
        const result = CoreChatLifecycleResultSchema.parse(value);
        if (
          result.outcome !== 'applied' &&
          result.outcome !== 'already_applied' &&
          result.outcome !== 'not_found'
        )
          throw new Error(result.reason ?? 'The cloud chat was not archived.');
        await serialized(() => rereadProject(generation, workspaceId));
      },

      reorderProjects: async (
        activeWorkspaceId,
        overWorkspaceId,
        visibleWorkspaceIds,
      ): Promise<void> => {
        const generation = get().generation;
        if (get().status !== 'online')
          throw new Error('Cloud chats are offline.');
        const projects = get().projects;
        const from = projects.findIndex(
          (project) => project.workspaceId === activeWorkspaceId,
        );
        const to = projects.findIndex(
          (project) => project.workspaceId === overWorkspaceId,
        );
        if (from < 0 || to < 0 || from === to) return;
        const moved = [...projects];
        const [active] = moved.splice(from, 1);
        if (active) moved.splice(to, 0, active);
        set({ projects: moved });
        const key = globalThis.crypto.randomUUID();
        try {
          CoreWorkspaceReorderResultSchema.parse(
            await call(generation, 'core.workspace.reorder', {
              visibleWorkspaceIds: [...visibleWorkspaceIds],
              activeWorkspaceId,
              overWorkspaceId,
              _meta: { idempotencyKey: key },
            }),
          );
        } finally {
          // The web core's order wins, whether the move landed or not.
          await serialized(() => relistAll(generation)).catch(() => undefined);
        }
      },

      updateProject: async (workspaceId, patch): Promise<void> => {
        const generation = get().generation;
        if (get().status !== 'online')
          throw new Error('Cloud chats are offline.');
        const project = get().projects.find(
          (item) => item.workspaceId === workspaceId,
        );
        if (!project) throw new Error('The cloud project is not listed.');
        const key = globalThis.crypto.randomUUID();
        try {
          CoreWorkspaceUpdateResultSchema.parse(
            await call(generation, 'core.workspace.update', {
              workspaceId,
              ...(project.revision === undefined
                ? {}
                : { expectedRevision: project.revision }),
              patch: {
                ...(patch.name === undefined ? {} : { name: patch.name }),
                ...(patch.color === undefined ? {} : { color: patch.color }),
              },
              _meta: { idempotencyKey: key },
            }),
          );
        } finally {
          // A refused write may mean a stale revision; the next one reads anew.
          await serialized(() => relistAll(generation)).catch(() => undefined);
        }
      },

      deleteProject: async (workspaceId): Promise<void> => {
        const generation = get().generation;
        if (get().status !== 'online')
          throw new Error('Cloud chats are offline.');
        const project = get().projects.find(
          (item) => item.workspaceId === workspaceId,
        );
        if (project?.revision === undefined)
          throw new Error('The cloud project could not be read. Try again.');
        const key = globalThis.crypto.randomUUID();
        try {
          CoreWorkspaceDeleteResultSchema.parse(
            await call(generation, 'core.workspace.delete', {
              workspaceId,
              expectedRevision: project.revision,
              _meta: { idempotencyKey: key },
            }),
          );
        } finally {
          await serialized(() => relistAll(generation)).catch(() => undefined);
        }
      },
    };
  });
  return store;
}

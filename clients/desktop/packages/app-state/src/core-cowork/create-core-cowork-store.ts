import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  ArchiveContainerListResultSchema,
  CanopyErrorPayloadSchema,
  CoreArchiveContainerRestoreResultSchema,
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
import { createKeyedWriteHistory } from './keyed-write-outcome';
import {
  CoreCoworkOutcomeUnknownError,
  isUnknownWriteError,
} from './unknown-outcome';

export type CoreCoworkStatus = 'disabled' | 'offline' | 'online';

/**
 * What a project save may change (CAN-6099, CAN-7053): its name and colour,
 * and its sandbox's egress hosts, host mode and declared ports.
 */
export interface CoreCoworkProjectPatch {
  readonly name?: string;
  readonly color?: string;
  readonly hostModeEnabled?: boolean;
  readonly hostPorts?: readonly number[];
  readonly egressAllowedHosts?: readonly string[];
}

/** A project save that landed: its warnings and the revision it left. */
export interface CoreCoworkProjectSaved {
  readonly warnings: readonly string[];
  /** The project's revision after the save, when the web core answers it. */
  readonly revision: number | undefined;
}

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
  /**
   * How many days a deleted task stays in the Trash, as the web's Delete
   * confirmation says it (CAN-7052). Absent when the listing doesn't carry it.
   */
  deletionRetentionDays?: number;
}

/**
 * A cloud task the web core kept when it was archived or deleted
 * (CAN-6511): its `work-entry` container, named by the task's chat.
 */
export interface CoreCoworkArchivedTask {
  /** The container's opaque id, as a restore names it. */
  archiveId: string;
  /** The container's revision, which a restore is fenced by. */
  revision: number;
  worktreeId: string;
  title: string;
  archivedAt: string;
  /** Archived is kept until restored; deleted waits in the trash. */
  state: 'archived' | 'deleted';
  expiresAt: string | null;
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
   * refused, with `creationError` saying why, and `unknown` once its answer
   * never came, so it may exist: the project is read again, and a listing
   * that holds it settles it (CAN-7196). Absent for a listed task.
   */
  creation?: 'pending' | 'failed' | 'unknown';
  creationError?: string;
  /**
   * A task deleted on another device whose draft this window keeps
   * (CAN-6614): its row stays, though the web core lists it no more, until
   * the host forgets it.
   */
  deleted?: true;
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
  /**
   * The error kind the core answered when the store went offline by itself,
   * such as `unauthenticated` for a revoked key; null otherwise (CAN-6374).
   */
  offlineReason: CanopyErrorPayload['kind'] | null;
  /**
   * What the last successful list reads returned, without this window's own
   * rows; cleared with the rest. Only the desktop sidebar reads it, to keep
   * it while offline (CAN-6374).
   */
  listed: {
    readonly projects: readonly CoreCoworkProject[];
    readonly tasksByProject: Readonly<
      Record<string, readonly CoreCoworkTask[]>
    >;
  };
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
   * (CAN-6098). A refused create leaves the row `failed`, and one whose
   * answer never came leaves it `unknown` (CAN-7196).
   */
  beginTask(workspaceId: string, title?: string): CoreCoworkTaskStart;
  /**
   * Creates a `failed` or `unknown` task again under the same id, so a
   * create that did land, slowly, is replayed and never doubled.
   */
  retryTask(workspaceId: string, worktreeId: string): Promise<CoreCoworkTask>;
  /**
   * Keeps a task deleted on another device as a row marked `deleted`, with
   * `title` when the row is gone already, until {@link forgetTask}.
   */
  keepDeletedTask(workspaceId: string, worktreeId: string, title: string): void;
  /** Drops a task's row this window kept, such as a deleted one. */
  forgetTask(workspaceId: string, worktreeId: string): void;
  /** The create in flight for a task this window started, if any. */
  taskCreation(
    workspaceId: string,
    worktreeId: string,
  ): Promise<CoreCoworkTask> | undefined;
  archiveTask(workspaceId: string, worktreeId: string): Promise<void>;
  /**
   * `core.chat.delete` of a task's own chat in discard mode: the task goes to
   * the Trash with its tabs, restorable until its retention ends (CAN-7052).
   */
  deleteTask(workspaceId: string, worktreeId: string): Promise<void>;
  /**
   * `core.archive.container.list` for the project: its archived and deleted
   * tasks, newest first (CAN-6511).
   */
  listArchivedTasks(
    workspaceId: string,
  ): Promise<readonly CoreCoworkArchivedTask[]>;
  /**
   * `core.archive.container.restore` of an archived task, in place and at
   * the revision it was listed at, then re-lists the project's tasks.
   */
  restoreTask(
    workspaceId: string,
    task: Pick<CoreCoworkArchivedTask, 'archiveId' | 'revision' | 'worktreeId'>,
  ): Promise<void>;
  /**
   * `core.workspace.reorder`: moves `active` to `over`'s slot among the
   * projects the caller shows, then re-lists. The list moves at once.
   */
  reorderProjects(
    activeWorkspaceId: string,
    overWorkspaceId: string,
    visibleWorkspaceIds: readonly string[],
  ): Promise<void>;
  /**
   * `core.workspace.update` of the name, colour or sandbox settings, guarded
   * by `expectedRevision` when the caller read one (a settings dialog pins
   * the revision of its own read), otherwise by the listed revision, then
   * re-lists. Answers the save's warnings, such as host ports that didn't
   * reach a live sandbox, and the revision the save left.
   */
  updateProject(
    workspaceId: string,
    patch: CoreCoworkProjectPatch,
    options?: { readonly expectedRevision?: number },
  ): Promise<CoreCoworkProjectSaved>;
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
  /**
   * Also list a git project's tasks (its worktree root chats, CAN-6106) and
   * re-read them on its task events. Off by default: only cowork projects'
   * tasks are held, as the desktop cloud sidebar reads them. The web's
   * background chats turn it on for their working marks (CAN-6509).
   */
  readonly repositoryTasks?: boolean;
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
 * failed to create, kept at the top until the web core lists them, and the
 * deleted ones it keeps, which no listing replaces.
 */
function withLocalTasks(
  listed: readonly CoreCoworkTask[],
  previous: readonly CoreCoworkTask[] | undefined,
): CoreCoworkTask[] {
  const local = (previous ?? []).filter(
    (task) =>
      task.deleted === true ||
      (task.creation !== undefined &&
        !listed.some((each) => each.key === task.key)),
  );
  return [
    ...local,
    ...listed.filter((task) => !local.some((each) => each.key === task.key)),
  ];
}

const EMPTY = {
  projects: [],
  tasksByProject: {},
  offlineReason: null,
  listed: { projects: [], tasksByProject: {} },
} satisfies Pick<
  CoreCoworkState,
  'projects' | 'tasksByProject' | 'offlineReason' | 'listed'
>;

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
  // Tasks whose create ended unknown: Try again goes under the same id, so a
  // refusal of the retry leaves it unknown too (CAN-7196).
  const unknownCreations = createKeyedWriteHistory();
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
            ...(workspace.deletionRetentionDays === undefined
              ? {}
              : { deletionRetentionDays: workspace.deletionRetentionDays }),
          });
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      return projects;
    };

    /** A cowork project's tasks; a git project's only with `repositoryTasks`. */
    const listsTasks = (kind: string): boolean =>
      kind === 'cowork' || options.repositoryTasks === true;

    const relistAll = async (generation: number): Promise<void> => {
      const projects = await listProjects(generation);
      const lists = await Promise.all(
        projects.map((project) =>
          listsTasks(project.kind)
            ? listTasks(generation, project.workspaceId)
            : Promise.resolve<CoreCoworkTask[]>([]),
        ),
      );
      assertCurrent(generation);
      const tasksByProject: Record<string, readonly CoreCoworkTask[]> = {};
      const listedTasks: Record<string, readonly CoreCoworkTask[]> = {};
      projects.forEach((project, index) => {
        listedTasks[project.key] = lists[index] ?? [];
        tasksByProject[project.key] = withLocalTasks(
          lists[index] ?? [],
          get().tasksByProject[project.key],
        );
      });
      set({
        projects,
        tasksByProject,
        listed: { projects, tasksByProject: listedTasks },
      });
    };

    const rereadProject = async (
      generation: number,
      workspaceId: string,
    ): Promise<void> => {
      const tasks = await listTasks(generation, workspaceId);
      const key = projectKey(workspaceId);
      if (!get().projects.some((project) => project.key === key)) return;
      const { listed } = get();
      set({
        tasksByProject: {
          ...get().tasksByProject,
          [key]: withLocalTasks(tasks, get().tasksByProject[key]),
        },
        listed: {
          ...listed,
          tasksByProject: { ...listed.tasksByProject, [key]: tasks },
        },
      });
    };

    /**
     * Archives or deletes a task through its own chat, keyed by one command
     * id. The change stands once the web core applied it: its row leaves now,
     * and a re-read that fails only waits for the next one.
     */
    const retireTask = async (
      workspaceId: string,
      worktreeId: string,
      change: {
        readonly method: 'core.chat.archive' | 'core.chat.delete';
        readonly action: Record<string, unknown>;
        readonly failure: string;
        /** What a change that may have landed, and no listing settled, says. */
        readonly unknown: string;
      },
    ): Promise<void> => {
      const generation = get().generation;
      if (get().status !== 'online')
        throw new Error('Cloud chats are offline.');
      const commandId = globalThis.crypto.randomUUID();
      const key = projectKey(workspaceId);
      let value: unknown;
      try {
        value = await call(generation, change.method, {
          projectId: workspaceId,
          worktreeId,
          commandId,
          _meta: { idempotencyKey: commandId },
          action: change.action,
        });
      } catch (error) {
        if (!isUnknownWriteError(error)) throw error;
        // Its answer never came, so it may have landed: the project's
        // listing says whether it did, and nothing sends it again
        // (CAN-7196). A task still listed wasn't removed.
        const read = await serialized(() =>
          rereadProject(generation, workspaceId),
        ).then(
          () => true,
          () => false,
        );
        if (!read) {
          // Read again later, as an event would have it.
          pendingRereads.add(workspaceId);
          scheduleReread(generation);
          throw new CoreCoworkOutcomeUnknownError(change.unknown);
        }
        if (
          get().tasksByProject[key]?.some(
            (task) => task.worktreeId === worktreeId,
          ) !== false
        )
          throw new Error(change.failure);
        return;
      }
      const result = CoreChatLifecycleResultSchema.parse(value);
      if (
        result.outcome !== 'applied' &&
        result.outcome !== 'already_applied' &&
        result.outcome !== 'not_found'
      )
        throw new Error(result.reason ?? change.failure);
      const tasks = get().tasksByProject[key];
      if (tasks !== undefined)
        set({
          tasksByProject: {
            ...get().tasksByProject,
            [key]: tasks.filter((task) => task.worktreeId !== worktreeId),
          },
        });
      await serialized(() => rereadProject(generation, workspaceId)).catch(
        () => undefined,
      );
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
        unknownCreations.settle(task.key);
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
          // Its answer never came, so it may exist: the project is read
          // again, and a listing that holds it settles the row (CAN-7196).
          if (
            isUnknownWriteError(error) ||
            unknownCreations.wasUnknown(task.key)
          ) {
            unknownCreations.markUnknown(task.key);
            patchTask(task, { creation: 'unknown', creationError: undefined });
            pendingRereads.add(task.workspaceId);
            scheduleReread(generation);
            return;
          }
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

    const goOffline = (generation: number, error: unknown): void => {
      if (get().generation !== generation) return;
      get().disconnect('offline');
      if (error instanceof CoreCoworkRequestError)
        set({ offlineReason: error.payload.kind });
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
          goOffline(generation, error);
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
          else if (listsTasks(listed.kind)) pendingRereads.add(workspaceId);
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
          goOffline(generation, error);
          return;
        }
        void pump(generation, true).catch((error: unknown) => {
          if (!(error instanceof StaleGenerationError))
            goOffline(generation, error);
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
        if (task?.creation !== 'failed' && task?.creation !== 'unknown')
          return Promise.reject(
            new Error('This task is not waiting on a retry.'),
          );
        return settleCreation(task);
      },

      keepDeletedTask: (workspaceId, worktreeId, title): void => {
        const key = projectKey(workspaceId);
        const tasks = get().tasksByProject[key] ?? [];
        const shown = tasks.find(
          (each) => each.key === taskKey(workspaceId, worktreeId),
        );
        const kept: CoreCoworkTask = {
          ...(shown === undefined
            ? {
                key: taskKey(workspaceId, worktreeId),
                workspaceId,
                worktreeId,
                title,
                updatedAt: new Date().toISOString(),
              }
            : withoutCreation(shown)),
          state: 'idle',
          deleted: true,
        };
        set({
          tasksByProject: {
            ...get().tasksByProject,
            [key]:
              shown === undefined
                ? [kept, ...tasks]
                : tasks.map((each) => (each === shown ? kept : each)),
          },
        });
      },

      forgetTask: (workspaceId, worktreeId): void => {
        const key = projectKey(workspaceId);
        const tasks = get().tasksByProject[key];
        if (
          !tasks?.some((each) => each.key === taskKey(workspaceId, worktreeId))
        )
          return;
        set({
          tasksByProject: {
            ...get().tasksByProject,
            [key]: tasks.filter(
              (each) => each.key !== taskKey(workspaceId, worktreeId),
            ),
          },
        });
      },

      taskCreation: (
        workspaceId,
        worktreeId,
      ): Promise<CoreCoworkTask> | undefined =>
        creations.get(taskKey(workspaceId, worktreeId)),

      archiveTask: (workspaceId, worktreeId): Promise<void> =>
        retireTask(workspaceId, worktreeId, {
          method: 'core.chat.archive',
          action: { type: 'chat.archive_tab', tabId: worktreeId },
          failure: 'The cloud chat was not archived.',
          unknown:
            "Couldn't confirm the task was archived. The list will show where it stands.",
        }),

      deleteTask: (workspaceId, worktreeId): Promise<void> =>
        retireTask(workspaceId, worktreeId, {
          method: 'core.chat.delete',
          action: {
            type: 'chat.close_tab',
            tabId: worktreeId,
            mode: 'discard',
          },
          failure: 'The cloud task was not deleted.',
          unknown:
            "Couldn't confirm the task was deleted. The list will show where it stands.",
        }),

      listArchivedTasks: async (
        workspaceId,
      ): Promise<readonly CoreCoworkArchivedTask[]> => {
        const generation = get().generation;
        if (get().status !== 'online')
          throw new Error('Cloud chats are offline.');
        const listed = ArchiveContainerListResultSchema.parse(
          await call(generation, 'core.archive.container.list', {
            workspaceId,
          }),
        );
        return listed.containers
          .flatMap((container): CoreCoworkArchivedTask[] => {
            const chatId = container.scope?.chatId;
            // A task is a work-entry container the web core names by its
            // chat; anything else, or one with no revision, is not ours.
            if (
              container.kind !== 'work-entry' ||
              container.workspaceId !== workspaceId ||
              chatId === undefined ||
              container.revision === null
            )
              return [];
            return [
              {
                archiveId: container.archiveId,
                revision: container.revision,
                worktreeId: chatId,
                title: container.name,
                archivedAt: container.archivedAt,
                state: container.locked ? 'archived' : 'deleted',
                expiresAt: container.expiresAt,
              },
            ];
          })
          .sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt));
      },

      restoreTask: async (workspaceId, task): Promise<void> => {
        const generation = get().generation;
        if (get().status !== 'online')
          throw new Error('Cloud chats are offline.');
        const idempotencyKey = globalThis.crypto.randomUUID();
        const result = CoreArchiveContainerRestoreResultSchema.parse(
          await call(generation, 'core.archive.container.restore', {
            archiveId: task.archiveId,
            expectedRevision: task.revision,
            destinationScope: { workspaceId },
            conflictPolicy: 'fail',
            _meta: { idempotencyKey },
          }),
        );
        if (result.operation.status !== 'completed')
          throw new Error('The cloud task was not restored.');
        // A row this window kept for the task as deleted (CAN-6614) would
        // hide the listing's live row: the restored task replaces it.
        get().forgetTask(workspaceId, task.worktreeId);
        // The restore stands once the web core completed it; a re-read that
        // fails only waits for the next one.
        await serialized(() => rereadProject(generation, workspaceId)).catch(
          () => undefined,
        );
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

      updateProject: async (
        workspaceId,
        patch,
        options,
      ): Promise<CoreCoworkProjectSaved> => {
        const generation = get().generation;
        if (get().status !== 'online')
          throw new Error('Cloud chats are offline.');
        const project = get().projects.find(
          (item) => item.workspaceId === workspaceId,
        );
        if (!project) throw new Error('The cloud project is not listed.');
        const key = globalThis.crypto.randomUUID();
        const expectedRevision = options?.expectedRevision ?? project.revision;
        try {
          const saved = CoreWorkspaceUpdateResultSchema.parse(
            await call(generation, 'core.workspace.update', {
              workspaceId,
              ...(expectedRevision === undefined ? {} : { expectedRevision }),
              patch: {
                ...(patch.name === undefined ? {} : { name: patch.name }),
                ...(patch.color === undefined ? {} : { color: patch.color }),
                ...(patch.hostModeEnabled === undefined
                  ? {}
                  : { hostModeEnabled: patch.hostModeEnabled }),
                ...(patch.hostPorts === undefined
                  ? {}
                  : { hostPorts: [...patch.hostPorts] }),
                ...(patch.egressAllowedHosts === undefined
                  ? {}
                  : { egressAllowedHosts: [...patch.egressAllowedHosts] }),
              },
              _meta: { idempotencyKey: key },
            }),
          );
          return { warnings: saved.warnings ?? [], revision: saved.revision };
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

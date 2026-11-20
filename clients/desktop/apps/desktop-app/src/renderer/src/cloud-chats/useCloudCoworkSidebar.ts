import { useCallback, useEffect, useMemo } from 'react';
import { create, useStore } from 'zustand';
import { useShallow } from 'zustand/shallow';
import {
  coreCoworkSidebarRows,
  type CoreCoworkProject,
  type CoreCoworkProjectPatch,
  type CoreCoworkProjectSaved,
  type CoreCoworkSidebarRows,
  type CoreCoworkState,
  type CoreCoworkTask,
} from '@canopy/app-state/core-cowork';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { snapshotWorkspaceMatchesContext } from '@canopy/ui-app';
import { useCanopyDesktopCloudChatsEnabled } from '@/hooks/useCanopyDesktopCloudChatsEnabled';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { WorktreeCreateResult } from '@canopy/app-core';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { webCoreLocalId, webCoreScopeId } from '@/lib/chat-authority';
import { openCoworkWorkEntryFromSidebar } from '@/lib/openCoworkWorkEntryFromSidebar';
import { cloudCoworkStore } from './cloud-cowork-store';
import { createRelayCoreCoworkInvoker } from './relay-invoker';
import { refreshChatScopeRevisioned } from '@/stores/chat/slices/revisioned';
import {
  readWebCoreServedOperationsOnline,
  useWebCoreServesTaskDelete,
} from '@/lib/web-core-served-operations';
import {
  isTaskBeingCreated,
  markTaskCreated,
  trackTaskCreation,
} from '@/stores/chat/web-core/task-creations';
import {
  markCloudTaskClick,
  markCloudTaskCreateSettled,
} from './task-creation-timing';

export { cloudCoworkStore };

const CLOUD_PROJECT_COLLAPSE_STORAGE_KEY =
  'canopy.cloudSidebar.collapsedProjects';
/** Enough for every project a person keeps; the oldest choices drop first. */
const CLOUD_PROJECT_COLLAPSE_LIMIT = 500;

type CollapsedProjects = Readonly<Record<string, true>>;

/**
 * Collapsed cloud projects, by project row id, kept across restarts in this
 * renderer's storage (CAN-6099 D5), as the web keeps them per browser. Cloud
 * project ids are unique, so one account never matches another's choices.
 */
function readCollapsedProjects(): CollapsedProjects {
  try {
    const raw = window.localStorage.getItem(CLOUD_PROJECT_COLLAPSE_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const collapsed: Record<string, true> = {};
    for (const id of parsed) {
      if (typeof id === 'string') collapsed[id] = true;
    }
    return collapsed;
  } catch (error) {
    reportClientAppError(error);
    return {};
  }
}

function writeCollapsedProjects(collapsed: CollapsedProjects): void {
  try {
    window.localStorage.setItem(
      CLOUD_PROJECT_COLLAPSE_STORAGE_KEY,
      JSON.stringify(
        Object.keys(collapsed).slice(-CLOUD_PROJECT_COLLAPSE_LIMIT),
      ),
    );
  } catch (error) {
    // Storage full or unavailable: the choice still holds for this session.
    reportClientAppError(error);
  }
}

export const useCloudProjectCollapse = create<{
  collapsed: CollapsedProjects;
  setCollapsed: (projectId: string, collapsed: boolean) => void;
}>()((set) => ({
  collapsed: readCollapsedProjects(),
  setCollapsed: (projectId, collapsed): void =>
    set(({ collapsed: current }) => {
      const rest: Record<string, true> = Object.fromEntries(
        Object.entries(current).filter(([id]) => id !== projectId),
      );
      const next = collapsed ? { ...rest, [projectId]: true as const } : rest;
      writeCollapsedProjects(next);
      return { collapsed: next };
    }),
}));

export interface CloudCoworkSidebarEntry {
  readonly key: string;
  readonly worktreeId: string;
  /** The task's root chat, as a cloud chat key. */
  readonly chatKey: string;
  readonly title: string;
  readonly working: boolean;
  readonly hasPendingQuestion: boolean;
  readonly updatedAt: string;
}

/** A cloud project row: the cowork row's shape, marked as cloud. */
export interface CloudCoworkSidebarProject {
  readonly key: string;
  readonly workspaceId: string;
  readonly name: string;
  /** A `git` project is listed but can't be opened on desktop yet (CAN-6177). */
  readonly kind: 'cowork' | 'git';
  readonly color?: string;
  readonly cloud: true;
  readonly collapsed: boolean;
  readonly entries: readonly CloudCoworkSidebarEntry[];
}

export type CloudCoworkSidebarModel =
  | { readonly status: 'disabled' }
  | {
      readonly status: 'offline';
      readonly reconnect: () => void;
      /**
       * The rows last listed online, kept under the offline row as the web
       * keeps them (CAN-6374); none before any listing on this account.
       */
      readonly rows: CoreCoworkSidebarRows;
      readonly setCollapsed: (projectId: string, collapsed: boolean) => void;
    }
  | {
      readonly status: 'online';
      /** Rows for the shared sidebar list, ids qualified by their authority. */
      readonly rows: CoreCoworkSidebarRows;
      readonly setCollapsed: (projectId: string, collapsed: boolean) => void;
      /**
       * Creates a task in the project and opens it as a sidebar row does.
       * Resolves with the new row for the shared list; rejects on failure so
       * the list clears its pending row and shows why.
       */
      readonly createTask: (projectId: string) => Promise<WorktreeCreateResult>;
      /** Moves `activeId` to `overId`'s slot among the shown cloud projects. */
      readonly reorder: (
        activeId: string,
        overId: string,
        visibleIds: readonly string[],
      ) => void;
      /**
       * Renames or recolours the project, or changes its sandbox's egress
       * hosts and host settings; answers the save's warnings and rejects so
       * a dialog can show why.
       */
      readonly updateProject: (
        projectId: string,
        patch: CoreCoworkProjectPatch,
        options?: { readonly expectedRevision?: number },
      ) => Promise<CoreCoworkProjectSaved>;
      /** Moves the project to the trash; rejects so a dialog can show why. */
      readonly deleteProject: (projectId: string) => Promise<void>;
      /**
       * The web core's manifest serves deleting a task to the Trash, so a
       * task row may offer Delete beside Archive (CAN-7052).
       */
      readonly taskDelete: boolean;
    };

/**
 * Cloud rows are scoped exactly as local rows (CAN-6100): no context (scoping
 * off or not hydrated) lists every project; otherwise the shared rule places
 * a project in its owner's context, and one with no owner in Personal.
 */
export function cloudProjectsForContext(
  projects: readonly CoreCoworkProject[],
  tasksByProject: Readonly<Record<string, readonly CoreCoworkTask[]>>,
  context: WorkspaceContext | undefined,
  collapsed: Readonly<Record<string, true>> = {},
): CloudCoworkSidebarProject[] {
  return projects
    .filter((project) =>
      snapshotWorkspaceMatchesContext(
        {
          owner:
            project.ownerOrganizationId === null
              ? undefined
              : {
                  type: 'cloud-organization',
                  organizationId: project.ownerOrganizationId.toLowerCase(),
                },
        },
        context,
      ),
    )
    .map((project) => ({
      key: project.key,
      workspaceId: project.workspaceId,
      name: project.name,
      kind: project.kind,
      ...(project.color === undefined ? {} : { color: project.color }),
      cloud: true,
      collapsed: collapsed[project.key] === true,
      entries: (tasksByProject[project.key] ?? [])
        .filter((task) => task.state !== 'archived')
        .map((task) => ({
          key: task.key,
          worktreeId: task.worktreeId,
          chatKey: webCoreScopeId(task.worktreeId),
          title: task.title,
          working: task.state === 'running' || task.state === 'queued',
          hasPendingQuestion: task.state === 'awaiting_user',
          updatedAt: task.updatedAt,
        })),
    }));
}

function connectCloudCowork(): void {
  if (typeof window === 'undefined' || !window.canopyCore) {
    cloudCoworkStore.getState().disconnect('offline');
    return;
  }
  void cloudCoworkStore
    .getState()
    .connect(createRelayCoreCoworkInvoker(window.canopyCore));
}

let mountedHosts = 0;
let connectedFor: string | null = null;

/** The connection a mount opens for its flag state and account. */
const connectionKey = (enabled: boolean, accountEpoch: number): string =>
  enabled ? `on:${accountEpoch}` : 'off';

/**
 * The web core's last successful listing, and the connection it was listed
 * on: offline, the sidebar shows exactly this, read-only. The shared store
 * drops it offline (the web's background chats rely on that); only this
 * sidebar keeps it, for that account only (CAN-6374).
 */
let lastListed: (CoreCoworkState['listed'] & { readonly key: string }) | null =
  null;
cloudCoworkStore.subscribe((state) => {
  if (state.status === 'online' && connectedFor !== null)
    lastListed = { key: connectedFor, ...state.listed };
  else if (
    state.status === 'disabled' ||
    // Lost authorization (a revoked or expired key) is a sign-out here.
    // shortcut: a 401 mid-stream arrives as `unavailable` (the relay ends the
    // session, and an expired connection token answers 401 just as a revoked
    // key does), so the rows clear only once a reconnect reaches the core and
    // is refused, and stay while it is unreachable; upgrade if the web core
    // tells the two apart.
    state.offlineReason === 'unauthenticated' ||
    state.offlineReason === 'permission_denied'
  )
    lastListed = null;
});
const NOT_LISTED: Pick<CoreCoworkState, 'projects' | 'tasksByProject'> = {
  projects: [],
  tasksByProject: {},
};

/** Mounts share one connection, opened per flag state and account. */
function syncConnection(enabled: boolean, accountEpoch: number): void {
  const key = connectionKey(enabled, accountEpoch);
  if (connectedFor === key) return;
  connectedFor = key;
  // Another account (or none, after a sign-out) never sees these rows.
  lastListed = null;
  if (enabled) connectCloudCowork();
  else cloudCoworkStore.getState().disconnect('disabled');
}

/**
 * Follows one create attempt of a task this window opened (CAN-6098): sends
 * and reads wait on it, and once the task exists the chat re-reads it from
 * the web core. A refused attempt leaves the task's row failed, with retry.
 */
function followTaskCreation(
  scope: { readonly projectId: string; readonly worktreeId: string },
  attempt: Promise<unknown>,
): void {
  trackTaskCreation(scope, attempt);
  followTaskListing(scope);
  const taskId = webCoreLocalId(scope.worktreeId) ?? scope.worktreeId;
  void attempt.then(
    () => {
      markCloudTaskCreateSettled(taskId, true);
      refreshChatScopeRevisioned(scope.projectId, scope.worktreeId);
    },
    () => {
      markCloudTaskCreateSettled(taskId, false);
    },
  );
}

/** Scopes whose task this window follows into the web core's listing. */
const followedListings = new Set<string>();

/**
 * Once the cloud cowork store lists a task this window is creating, the task
 * exists, whatever became of its create attempts: one may have landed without
 * an answer and left its row failed until a re-read listed it. Whatever waits
 * on it goes ahead, and the chat re-reads it from the web core.
 */
function followTaskListing(scope: {
  readonly projectId: string;
  readonly worktreeId: string;
}): void {
  const key = `${scope.projectId}/${scope.worktreeId}`;
  const workspaceId = webCoreLocalId(scope.projectId);
  const taskId = webCoreLocalId(scope.worktreeId);
  if (followedListings.has(key) || workspaceId === null || taskId === null)
    return;
  followedListings.add(key);
  const unsubscribe = cloudCoworkStore.subscribe((state) => {
    if (!isTaskBeingCreated(scope)) {
      followedListings.delete(key);
      unsubscribe();
      return;
    }
    const listed = state.tasksByProject[`web-core:${workspaceId}`]?.some(
      (task) => task.worktreeId === taskId && task.creation === undefined,
    );
    if (listed !== true) return;
    followedListings.delete(key);
    unsubscribe();
    markTaskCreated(scope);
    refreshChatScopeRevisioned(scope.projectId, scope.worktreeId);
  });
}

/**
 * A cloud project's "+". The new task opens at once on the cowork page,
 * through the work-entry seam, while the web core creates it (CAN-6098): its
 * row shows the create pending, then failed with a retry if the web core
 * refuses it.
 */
export function createCloudSidebarTask(
  projectId: string,
): Promise<WorktreeCreateResult> {
  try {
    const { worktreeId } = beginCloudTask(projectId);
    return Promise.resolve({ status: 'completed', worktreeId });
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error('Not a cloud project.'),
    );
  }
}

/**
 * Starts a cloud task and opens it, as a cloud project's "+" does.
 * `beforeOpen` runs once the task has its id, before its page opens, such
 * as to hand its composer a draft. Throws for a project that isn't a cloud
 * one, or while cloud chats are offline.
 */
export function beginCloudTask(
  projectId: string,
  beforeOpen?: (target: {
    readonly projectId: string;
    readonly worktreeId: string;
  }) => void,
): { readonly worktreeId: string; readonly created: Promise<unknown> } {
  const workspaceId = webCoreLocalId(projectId);
  if (workspaceId === null) throw new Error('Not a cloud project.');
  const { task, created } = cloudCoworkStore.getState().beginTask(workspaceId);
  markCloudTaskClick(task.worktreeId);
  const worktreeId = webCoreScopeId(task.worktreeId);
  followTaskCreation({ projectId, worktreeId }, created);
  beforeOpen?.({ projectId, worktreeId });
  openCoworkWorkEntryFromSidebar(projectId, worktreeId);
  return { worktreeId, created };
}

/** Creates a cloud task the web core refused again, under the same id. */
export function retryCloudTask(projectId: string, worktreeId: string): void {
  const workspaceId = webCoreLocalId(projectId);
  const taskId = webCoreLocalId(worktreeId);
  if (workspaceId === null || taskId === null) return;
  followTaskCreation(
    { projectId, worktreeId },
    cloudCoworkStore.getState().retryTask(workspaceId, taskId),
  );
}

export function useCloudCoworkSidebar(): CloudCoworkSidebarModel {
  const enabled = useCanopyDesktopCloudChatsEnabled();
  const accountEpoch = useWorkspaceContextStore((s) => s.accountEpoch);
  const context = useSidebarScopingContext();
  const collapsed = useCloudProjectCollapse((s) => s.collapsed);
  const setCollapsed = useCloudProjectCollapse((s) => s.setCollapsed);
  // `generation` and `offlineReason` re-render when `lastListed` is dropped.
  const { status, projects, tasksByProject } = useStore(
    cloudCoworkStore,
    useShallow((s) => ({
      status: s.status,
      generation: s.generation,
      offlineReason: s.offlineReason,
      projects: s.projects,
      tasksByProject: s.tasksByProject,
    })),
  );

  useEffect(() => {
    mountedHosts += 1;
    syncConnection(enabled, accountEpoch);
    return (): void => {
      mountedHosts -= 1;
      if (mountedHosts === 0) {
        connectedFor = null;
        cloudCoworkStore.getState().disconnect('disabled');
      }
    };
  }, [enabled, accountEpoch]);

  const reconnect = useCallback((): void => {
    // An expired web session remints only on this user action (in main).
    void window.api.cloudChats
      .reconnect()
      .then((result) => {
        if (result.ok) connectCloudCowork();
      })
      .catch((error: unknown) => {
        reportClientAppError(error);
      });
  }, []);
  const reorder = useCallback(
    (activeId: string, overId: string, visibleIds: readonly string[]): void => {
      const active = webCoreLocalId(activeId);
      const over = webCoreLocalId(overId);
      if (active === null || over === null) return;
      const visible = visibleIds.flatMap((id) => {
        const workspaceId = webCoreLocalId(id);
        return workspaceId === null ? [] : [workspaceId];
      });
      void cloudCoworkStore
        .getState()
        .reorderProjects(active, over, visible)
        .catch((error: unknown) => {
          reportClientAppError(error);
        });
    },
    [],
  );
  const updateProject = useCallback(
    async (
      projectId: string,
      patch: CoreCoworkProjectPatch,
      options?: { readonly expectedRevision?: number },
    ): Promise<CoreCoworkProjectSaved> => {
      const workspaceId = webCoreLocalId(projectId);
      if (workspaceId === null) throw new Error('Not a cloud project.');
      return cloudCoworkStore
        .getState()
        .updateProject(workspaceId, patch, options);
    },
    [],
  );
  const deleteProject = useCallback(
    async (projectId: string): Promise<void> => {
      const workspaceId = webCoreLocalId(projectId);
      if (workspaceId === null) throw new Error('Not a cloud project.');
      await cloudCoworkStore.getState().deleteProject(workspaceId);
    },
    [],
  );
  // Read once cloud chats are online; a task offers Delete only once the
  // manifest lists it (CAN-7052). Coming back online also reads a failed
  // manifest again (CAN-7464).
  const online = enabled && status === 'online';
  useEffect(() => {
    if (online) readWebCoreServedOperationsOnline();
  }, [online]);
  const taskDelete = useWebCoreServesTaskDelete();
  // Read in render, so another account's rows never show for a frame: none
  // until the store's connection is this account's, live or kept.
  const key = connectionKey(enabled, accountEpoch);
  const listed =
    connectedFor !== key
      ? NOT_LISTED
      : (status === 'offline' && lastListed?.key === key && lastListed) || {
          projects,
          tasksByProject,
        };
  const rows = useMemo(() => {
    // The shared list's scoping rule: a lost organization is never the
    // context, so its rows never show, whenever its listing landed.
    const shown = new Set(
      cloudProjectsForContext(listed.projects, {}, context).map((p) => p.key),
    );
    return coreCoworkSidebarRows(
      listed.projects.filter((project) => shown.has(project.key)),
      listed.tasksByProject,
      { scopeId: webCoreScopeId, collapsed },
    );
  }, [listed.projects, listed.tasksByProject, collapsed, context]);

  if (!enabled || status === 'disabled') return { status: 'disabled' };
  if (status === 'offline')
    return { status: 'offline', reconnect, rows, setCollapsed };
  return {
    status: 'online',
    rows,
    setCollapsed,
    createTask: createCloudSidebarTask,
    reorder,
    updateProject,
    deleteProject,
    taskDelete,
  };
}

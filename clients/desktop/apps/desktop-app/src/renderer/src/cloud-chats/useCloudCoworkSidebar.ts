import { useCallback, useEffect, useMemo } from 'react';
import { create, useStore } from 'zustand';
import { useShallow } from 'zustand/shallow';
import {
  coreCoworkSidebarRows,
  type CoreCoworkProject,
  type CoreCoworkSidebarRows,
  type CoreCoworkTask,
} from '@canopy/app-state/core-cowork';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { snapshotWorkspaceMatchesContext } from '@canopy/ui-app';
import { useCanopyDesktopCloudChatsEnabled } from '@/hooks/useCanopyDesktopCloudChatsEnabled';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { WorktreeCreateResult } from '@canopy/app-core';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { webCoreLocalId, webCoreScopeId } from '@/lib/chat-authority';
import { openCoworkWorkEntryFromSidebar } from '@/lib/openCoworkWorkEntryFromSidebar';
import { cloudCoworkStore } from './cloud-cowork-store';
import { createRelayCoreCoworkInvoker } from './relay-invoker';
import { refreshChatScopeRevisioned } from '@/stores/chat/slices/revisioned';
import {
  isTaskBeingCreated,
  markTaskCreated,
  trackTaskCreation,
} from '@/stores/chat/web-core/task-creations';
import { cloudChatsUseStandalonePage } from './cloud-chat-routing';
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
  | { readonly status: 'offline'; readonly reconnect: () => void }
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
      /** Renames or recolours the project; rejects so a dialog can show why. */
      readonly updateProject: (
        projectId: string,
        patch: { readonly name?: string; readonly color?: string },
      ) => Promise<void>;
      /** Moves the project to the trash; rejects so a dialog can show why. */
      readonly deleteProject: (projectId: string) => Promise<void>;
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

/** Mounts share one connection, opened per flag state and account. */
function syncConnection(enabled: boolean, accountEpoch: number): void {
  const key = enabled ? `on:${accountEpoch}` : 'off';
  if (connectedFor === key) return;
  connectedFor = key;
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
 * A cloud project's "+". On the cowork page the new task opens at once,
 * through the work-entry seam, while the web core creates it (CAN-6098): its
 * row shows the create pending, then failed with a retry if the web core
 * refuses it. CloudChatPage reads a task as soon as it opens and holds a
 * missing one as gone, and the list opens a row as soon as it shows, so
 * there the task's row shows once it exists, as before, and a refused create
 * rejects with no row left.
 */
export async function createCloudSidebarTask(
  projectId: string,
): Promise<WorktreeCreateResult> {
  const workspaceId = webCoreLocalId(projectId);
  if (workspaceId === null) throw new Error('Not a cloud project.');
  if (!cloudChatsUseStandalonePage) {
    const task = await cloudCoworkStore.getState().createTask(workspaceId);
    const worktreeId = webCoreScopeId(task.worktreeId);
    openCoworkWorkEntryFromSidebar(projectId, worktreeId);
    return { status: 'completed', worktreeId };
  }
  const { task, created } = cloudCoworkStore.getState().beginTask(workspaceId);
  markCloudTaskClick(task.worktreeId);
  const worktreeId = webCoreScopeId(task.worktreeId);
  followTaskCreation({ projectId, worktreeId }, created);
  openCoworkWorkEntryFromSidebar(projectId, worktreeId);
  return { status: 'completed', worktreeId };
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
  const collapsed = useCloudProjectCollapse((s) => s.collapsed);
  const setCollapsed = useCloudProjectCollapse((s) => s.setCollapsed);
  const { status, projects, tasksByProject } = useStore(
    cloudCoworkStore,
    useShallow((s) => ({
      status: s.status,
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
      patch: { readonly name?: string; readonly color?: string },
    ): Promise<void> => {
      const workspaceId = webCoreLocalId(projectId);
      if (workspaceId === null) throw new Error('Not a cloud project.');
      await cloudCoworkStore.getState().updateProject(workspaceId, patch);
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
  const rows = useMemo(
    () =>
      coreCoworkSidebarRows(projects, tasksByProject, {
        scopeId: webCoreScopeId,
        collapsed,
      }),
    [projects, tasksByProject, collapsed],
  );

  if (!enabled || status === 'disabled') return { status: 'disabled' };
  if (status === 'offline') return { status: 'offline', reconnect };
  return {
    status: 'online',
    rows,
    setCollapsed,
    createTask: createCloudSidebarTask,
    reorder,
    updateProject,
    deleteProject,
  };
}

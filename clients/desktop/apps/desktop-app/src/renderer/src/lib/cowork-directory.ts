import { useStore } from 'zustand';
import type {
  CoreCoworkState,
  CoreCoworkTask,
} from '@canopy/app-state/core-cowork';
import type { CoworkWorkEntryMeta } from '@canopy/desktop-shared/types';
import { cloudCoworkStore } from '@/cloud-chats/cloud-cowork-store';
import { isWebCoreScope, webCoreScopeId } from '@/lib/chat-authority';

/**
 * Where the cowork page reads a project and its tasks (CAN-6175 D2): local
 * projects from the standalone store's IPC, web core projects from the cloud
 * cowork store. A web core id is never sent to main for either.
 */
export interface WebCoreCoworkProject {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly entries: readonly CoworkWorkEntryMeta[];
}

function toWorkEntry(task: CoreCoworkTask): CoworkWorkEntryMeta {
  return {
    id: webCoreScopeId(task.worktreeId),
    title: task.title,
    // The web core projects neither a creation time nor a chat count. The
    // cloud sidebar draws its own rows, so these only satisfy the entry shape.
    createdAt: task.updatedAt,
    lastTouchedAt: task.updatedAt,
    chatCount: 1,
    hasActiveChat: task.state === 'running' || task.state === 'queued',
  };
}

function projectFrom(
  state: Pick<CoreCoworkState, 'status' | 'projects' | 'tasksByProject'>,
  projectId: string,
): WebCoreCoworkProject | null {
  if (state.status !== 'online') return null;
  const project = state.projects.find(
    (candidate) => candidate.key === projectId && candidate.kind === 'cowork',
  );
  if (!project) return null;
  return {
    id: project.key,
    name: project.name,
    ...(project.color === undefined ? {} : { color: project.color }),
    entries: (state.tasksByProject[project.key] ?? [])
      .filter((task) => task.state !== 'archived')
      .map(toWorkEntry),
  };
}

/** A web core cowork project while the cloud is online, or null. */
export function webCoreCoworkProject(
  projectId: string,
): WebCoreCoworkProject | null {
  return projectFrom(cloudCoworkStore.getState(), projectId);
}

/** Whether the cloud cowork store is connected and lists its projects. */
export function isWebCoreCoworkOnline(): boolean {
  return cloudCoworkStore.getState().status === 'online';
}

/** Calls `listener` whenever the cloud's projects, tasks or status change. */
export function subscribeWebCoreCoworkDirectory(
  listener: () => void,
): () => void {
  return cloudCoworkStore.subscribe((state, previous) => {
    if (
      state.status !== previous.status ||
      state.projects !== previous.projects ||
      state.tasksByProject !== previous.tasksByProject
    ) {
      listener();
    }
  });
}

/**
 * Whether the cowork page can show this project: a local one always, a cloud
 * one while the cloud lists it.
 */
export function useCoworkProjectReachable(projectId: string): boolean {
  return useStore(
    cloudCoworkStore,
    (state) =>
      !isWebCoreScope(projectId) || projectFrom(state, projectId) !== null,
  );
}

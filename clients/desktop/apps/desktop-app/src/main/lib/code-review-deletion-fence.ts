import { AsyncLocalStorage } from 'node:async_hooks';
import type { CodeReviewScopeRequest } from '@canopy/desktop-shared/types';
import { withCodeReviewStorageIdentity } from './paths';
import {
  noteCodeReviewNamespaceEffect,
  waitForCodeReviewNamespaceQualification,
} from './code-review-storage-admission';

const stoppedScopes = new Set<string>();
const activeTasks = new Map<string, Set<Promise<unknown>>>();
const activeScope = new AsyncLocalStorage<string>();

function scopeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

export function runCodeReviewTask<T>(
  scope: CodeReviewScopeRequest,
  run: () => Promise<T>,
  whenStopped: () => T | Promise<T>,
): Promise<T> {
  return withCodeReviewStorageIdentity(() => {
    const key = scopeKey(scope.projectId, scope.worktreeId);
    if (stoppedScopes.has(key)) return Promise.resolve(whenStopped());

    const admittedRun = async (): Promise<T> => {
      await waitForCodeReviewNamespaceQualification();
      noteCodeReviewNamespaceEffect('mutation');
      return run();
    };
    const task =
      activeScope.getStore() === key
        ? Promise.resolve().then(admittedRun)
        : activeScope.run(key, () => Promise.resolve().then(admittedRun));
    const tasks = activeTasks.get(key) ?? new Set<Promise<unknown>>();
    activeTasks.set(key, tasks);
    tasks.add(task);
    void task
      .finally(() => {
        tasks.delete(task);
        if (!tasks.size) activeTasks.delete(key);
      })
      .catch(() => undefined);
    return task;
  });
}

export async function drainCodeReviewTasks(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const key = scopeKey(projectId, worktreeId);
  stoppedScopes.add(key);
  while (activeTasks.get(key)?.size) {
    await Promise.allSettled(Array.from(activeTasks.get(key) ?? []));
  }
}

export function releaseCodeReviewTasks(
  projectId: string,
  worktreeId: string,
): void {
  stoppedScopes.delete(scopeKey(projectId, worktreeId));
}

export function isCodeReviewScopeStopped(
  projectId: string,
  worktreeId: string,
): boolean {
  return stoppedScopes.has(scopeKey(projectId, worktreeId));
}

export const __testing = {
  reset(): void {
    stoppedScopes.clear();
    activeTasks.clear();
  },
  async idle(projectId: string, worktreeId: string): Promise<void> {
    const key = scopeKey(projectId, worktreeId);
    while (activeTasks.get(key)?.size) {
      await Promise.allSettled(Array.from(activeTasks.get(key) ?? []));
    }
  },
};

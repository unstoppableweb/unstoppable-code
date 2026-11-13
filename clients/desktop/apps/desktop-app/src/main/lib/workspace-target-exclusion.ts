import { notifyScriptActionsTargetClosed } from '../services/script-actions-lifecycle';
import { AsyncLocalStorage } from 'node:async_hooks';

const teardownContext = new AsyncLocalStorage<string>();
const activeTeardowns = new Set<string>();

const autoArchiveLeases = new Set<string>();
const runtimeStartReservations = new Map<string, number>();
const runtimeStartDrainWaiters = new Map<string, Set<() => void>>();
const archiveDrains = new Map<string, number>();
const pendingRemovals = new Map<string, number>();
const removalListeners = new Set<
  (projectId: string, worktreeId: string) => void
>();

export function subscribeWorkspaceTargetRemoval(
  listener: (projectId: string, worktreeId: string) => void,
): () => void {
  removalListeners.add(listener);
  return () => {
    removalListeners.delete(listener);
  };
}

const removalSettledWaiters = new Map<string, Set<() => void>>();
const preparationTokens = new Map<string, { valid: boolean }>();
const preparationContext = new AsyncLocalStorage<{
  key: string;
  token: { valid: boolean };
}>();

export class WorkspaceTargetAutoArchiveExcludedError extends Error {
  constructor(
    message = 'Workspace target activity changed before Auto Delete',
  ) {
    super(message);
    this.name = 'WorkspaceTargetAutoArchiveExcludedError';
  }
}

function key(projectId: string, worktreeId: string): string {
  return `${projectId}\0${worktreeId}`;
}

const RUNTIME_START_DRAIN_TIMEOUT_MS = 30_000;

async function waitForWorkspaceTargetRuntimeStarts(
  targetKey: string,
): Promise<void> {
  if ((runtimeStartReservations.get(targetKey) ?? 0) === 0) return;
  let finishWait: () => void = () => undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      finishWait = resolve;
      let waiters = runtimeStartDrainWaiters.get(targetKey);
      if (!waiters) {
        waiters = new Set();
        runtimeStartDrainWaiters.set(targetKey, waiters);
      }
      waiters.add(finishWait);
      timeout = setTimeout(() => {
        reject(
          new Error(
            'This worktree still has a runtime start in progress. Retry archiving after it finishes.',
          ),
        );
      }, RUNTIME_START_DRAIN_TIMEOUT_MS);
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    const waiters = runtimeStartDrainWaiters.get(targetKey);
    waiters?.delete(finishWait);
    if (waiters?.size === 0) runtimeStartDrainWaiters.delete(targetKey);
  }
}

export function assertWorkspaceTargetRuntimeStartAllowed(
  projectId: string,
  worktreeId: string,
): void {
  const targetKey = key(projectId, worktreeId);
  const preparation = preparationContext.getStore();
  if (preparation?.key === targetKey && !preparation.token.valid) {
    throw new Error('This worktree setup was cancelled by archiving.');
  }
  if (archiveDrains.has(targetKey) && !isOwnedTeardown(targetKey)) {
    throw new Error(
      'This worktree is being archived. Retry after archiving finishes.',
    );
  }
  if (autoArchiveLeases.has(targetKey) && !isOwnedTeardown(targetKey)) {
    throw new Error(
      'This workspace target is being automatically deleted. Retry after deletion finishes.',
    );
  }
}

export function reserveWorkspaceTargetRuntimeStarts(
  targets: ReadonlyArray<{ projectId: string; worktreeId: string }>,
): () => void {
  const targetKeys = Array.from(
    new Set(targets.map((target) => key(target.projectId, target.worktreeId))),
  );
  for (const targetKey of targetKeys) {
    if (archiveDrains.has(targetKey) && !isOwnedTeardown(targetKey)) {
      throw new Error(
        'This worktree is being archived. Retry after archiving finishes.',
      );
    }
    if (autoArchiveLeases.has(targetKey) && !isOwnedTeardown(targetKey)) {
      throw new Error(
        'This workspace target is being automatically deleted. Retry after deletion finishes.',
      );
    }
  }
  for (const targetKey of targetKeys) {
    runtimeStartReservations.set(
      targetKey,
      (runtimeStartReservations.get(targetKey) ?? 0) + 1,
    );
  }
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    for (const targetKey of targetKeys) {
      const remaining = (runtimeStartReservations.get(targetKey) ?? 1) - 1;
      if (remaining === 0) {
        runtimeStartReservations.delete(targetKey);
        const waiters = runtimeStartDrainWaiters.get(targetKey);
        runtimeStartDrainWaiters.delete(targetKey);
        waiters?.forEach((finishWait) => finishWait());
      } else runtimeStartReservations.set(targetKey, remaining);
    }
  };
}

/**
 * Whether a runtime start is reserved for the target. A browser state save
 * holds one while it waits for the project's archive operation lock.
 */
export function isWorkspaceTargetRuntimeStartReserved(
  projectId: string,
  worktreeId: string,
): boolean {
  return (runtimeStartReservations.get(key(projectId, worktreeId)) ?? 0) > 0;
}

export function reserveWorkspaceTargetRuntimeStart(
  projectId: string,
  worktreeId: string,
): () => void {
  return reserveWorkspaceTargetRuntimeStarts([{ projectId, worktreeId }]);
}

export async function withWorkspaceTargetRuntimeStartReservation<T>(
  projectId: string,
  worktreeId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = reserveWorkspaceTargetRuntimeStart(projectId, worktreeId);
  try {
    return await operation();
  } finally {
    release();
  }
}

/**
 * Cancel the target's in-flight setup preparation: its remaining steps fail
 * their spawn checks instead of starting. A later preparation starts afresh.
 */
export function cancelWorkspaceTargetRuntimePreparation(
  projectId: string,
  worktreeId: string,
): void {
  notifyScriptActionsTargetClosed({ projectId, worktreeId });
  const targetKey = key(projectId, worktreeId);
  const token = preparationTokens.get(targetKey);
  if (token) token.valid = false;
  preparationTokens.delete(targetKey);
}

/** Fence late asynchronous preparation at the existing script/PTY spawn checks. */
export async function withWorkspaceTargetArchiveDrain<T>(
  projectId: string,
  worktreeId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const targetKey = key(projectId, worktreeId);
  cancelWorkspaceTargetRuntimePreparation(projectId, worktreeId);
  archiveDrains.set(targetKey, (archiveDrains.get(targetKey) ?? 0) + 1);
  try {
    await waitForWorkspaceTargetRuntimeStarts(targetKey);
    return await operation();
  } finally {
    const remaining = (archiveDrains.get(targetKey) ?? 1) - 1;
    if (remaining === 0) archiveDrains.delete(targetKey);
    else archiveDrains.set(targetKey, remaining);
  }
}

/**
 * Marks a worktree whose removal has started. Projections leave a marked row
 * out, so the portal and the desktop session snapshot agree with a renderer
 * that already hid it. Unlike the archive drain, the mark is set before the
 * archive waits on anything. It is memory-only: a restart clears it.
 */
export function markWorkspaceTargetRemovalPending(
  projectId: string,
  worktreeId: string,
): () => void {
  const targetKey = key(projectId, worktreeId);
  pendingRemovals.set(targetKey, (pendingRemovals.get(targetKey) ?? 0) + 1);
  for (const listener of removalListeners) {
    try {
      listener(projectId, worktreeId);
    } catch {
      /* Retirement must still proceed. */
    }
  }
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    const remaining = (pendingRemovals.get(targetKey) ?? 1) - 1;
    if (remaining > 0) {
      pendingRemovals.set(targetKey, remaining);
      return;
    }
    pendingRemovals.delete(targetKey);
    const waiters = removalSettledWaiters.get(targetKey);
    removalSettledWaiters.delete(targetKey);
    waiters?.forEach((finishWait) => finishWait());
  };
}

/**
 * Resolves once no removal of the target is in progress: at once when it is
 * not marked, otherwise after its last mark is released. A removal that starts
 * as the last one ends is waited out too.
 */
export async function whenWorkspaceTargetRemovalSettled(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const targetKey = key(projectId, worktreeId);
  while (pendingRemovals.has(targetKey)) {
    await new Promise<void>((resolve) => {
      let waiters = removalSettledWaiters.get(targetKey);
      if (!waiters) {
        waiters = new Set();
        removalSettledWaiters.set(targetKey, waiters);
      }
      waiters.add(resolve);
    });
  }
}

export function isWorkspaceTargetRemovalPending(
  projectId: string,
  worktreeId: string,
): boolean {
  return pendingRemovals.has(key(projectId, worktreeId));
}

/** Carries cancellation through asynchronous setup resolution and PTY imports. */
export async function withWorkspaceTargetRuntimePreparation<T>(
  projectId: string,
  worktreeId: string,
  operation: () => Promise<T>,
): Promise<T> {
  assertWorkspaceTargetRuntimeStartAllowed(projectId, worktreeId);
  const targetKey = key(projectId, worktreeId);
  let token = preparationTokens.get(targetKey);
  if (!token) {
    token = { valid: true };
    preparationTokens.set(targetKey, token);
  }
  return preparationContext.run({ key: targetKey, token }, operation);
}

export async function withWorkspaceTargetAutoArchiveLease<T>(
  projectId: string,
  worktreeId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const targetKey = key(projectId, worktreeId);
  if (
    autoArchiveLeases.has(targetKey) ||
    (runtimeStartReservations.get(targetKey) ?? 0) > 0
  ) {
    throw new WorkspaceTargetAutoArchiveExcludedError();
  }
  autoArchiveLeases.add(targetKey);
  try {
    return await operation();
  } finally {
    autoArchiveLeases.delete(targetKey);
  }
}

function isOwnedTeardown(targetKey: string): boolean {
  return (
    activeTeardowns.has(targetKey) && teardownContext.getStore() === targetKey
  );
}

/** Main-only scope for the teardown belonging to an already leased deletion. */
export async function withWorkspaceTargetAutoArchiveTeardown<T>(
  projectId: string,
  worktreeId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const targetKey = key(projectId, worktreeId);
  if (!autoArchiveLeases.has(targetKey) || activeTeardowns.has(targetKey)) {
    throw new Error(
      'Auto Delete teardown requires its exclusive deletion lease',
    );
  }
  activeTeardowns.add(targetKey);
  try {
    return await teardownContext.run(targetKey, operation);
  } finally {
    activeTeardowns.delete(targetKey);
  }
}

export function isWorkspaceTargetAutoArchiveTeardown(
  targetKey: string,
): boolean {
  return activeTeardowns.has(targetKey);
}

export function resetWorkspaceTargetExclusionsForTests(): void {
  activeTeardowns.clear();
  autoArchiveLeases.clear();
  runtimeStartReservations.clear();
  runtimeStartDrainWaiters.forEach((waiters) =>
    waiters.forEach((finishWait) => finishWait()),
  );
  runtimeStartDrainWaiters.clear();
  archiveDrains.clear();
  pendingRemovals.clear();
  removalSettledWaiters.forEach((waiters) =>
    waiters.forEach((finishWait) => finishWait()),
  );
  removalSettledWaiters.clear();
  preparationTokens.clear();
}

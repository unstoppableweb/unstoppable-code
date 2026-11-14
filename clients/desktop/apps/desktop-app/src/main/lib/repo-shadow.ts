import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureRepoShadowThroughWorker } from '../canopy-runtime/worker-git-local-mutations-dispatch';
import { codeGraphRepoShadowKey } from '@canopy/code-graph/host/base-seed';
import {
  addDetachedWorktree,
  checkoutDetachedRef,
  fetchOrigin,
  getRemoteDefaultBranch,
  pruneWorktrees,
  removeGitWorktree,
} from './git';
import { getRepoShadowsRootDir } from './paths';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';

const SHADOW_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * How long a failed ensure (most commonly "no remote default branch") is
 * remembered before the next non-bypassing caller re-probes the repo. Without
 * this, every baseline read against a repo that cannot host a shadow repeats
 * the full remote-default-branch probe (~several git commands) under the
 * per-repo lock, and frequent readers (sidebar loads, home discovery, file
 * index) pile up behind each other.
 */
const SHADOW_FAILURE_TTL_MS = 60 * 1000;

export interface RepoShadowInfo {
  repoPath: string;
  shadowPath: string;
  defaultBranch: string;
  lastSyncAt: string;
}

export interface EnsureRepoShadowOptions {
  maxAgeMs?: number;
  /**
   * Serve a stale-but-complete shadow immediately and refresh it in the
   * background instead of blocking on the network-bound refresh. Callers that
   * only need a best-effort baseline checkout (config/script/manifest reads)
   * should set this; callers that must observe a *synced* shadow (the
   * reference-repo health inspector) must not.
   */
  allowStale?: boolean;
  /**
   * Skip the recent-failure cache and always probe live. Set by
   * user-triggered/health flows so a just-fixed remote is picked up
   * immediately instead of after `SHADOW_FAILURE_TTL_MS`.
   */
  bypassFailureCache?: boolean;
  /**
   * Rechecked under the repository lock and before each network/filesystem
   * mutation. Code Graph supplies this so preference disablement stops shadow
   * maintenance that was queued or already preparing a checkout.
   */
  shouldContinue?: () => boolean;
  /** Aborts in-flight Git subprocesses immediately during reconciliation. */
  signal?: AbortSignal;
}

/** A completed best-effort lookup found no branch; not proof of remote health. */
export class RepoShadowNoDefaultBranchError extends Error {
  public constructor(repoRoot: string) {
    super(
      `Cannot maintain a default-branch shadow for "${repoRoot}": no remote default branch`,
    );
    // Keep legacy Error text; the internal marker is the prototype, not its name.
  }
}

export class RepoShadowEnsureCanceledError extends Error {
  public constructor() {
    super('Repository shadow preparation was canceled.');
    this.name = 'RepoShadowEnsureCanceledError';
  }
}

function assertEnsureContinues(shouldContinue?: () => boolean): void {
  if (shouldContinue?.() === false) {
    throw new RepoShadowEnsureCanceledError();
  }
}

async function runCancellableGitOperation<T>(
  shouldContinue: (() => boolean) | undefined,
  externalSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  assertEnsureContinues(shouldContinue);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (externalSignal?.aborted === true) {
    abort();
  } else {
    externalSignal?.addEventListener('abort', abort, { once: true });
  }
  const poll = setInterval(() => {
    if (shouldContinue?.() === false) {
      controller.abort();
    }
  }, 10);
  poll.unref?.();
  try {
    const result = await operation(controller.signal);
    if (controller.signal.aborted) {
      throw new RepoShadowEnsureCanceledError();
    }
    assertEnsureContinues(shouldContinue);
    return result;
  } catch (error) {
    if (controller.signal.aborted || shouldContinue?.() === false) {
      throw new RepoShadowEnsureCanceledError();
    }
    throw error;
  } finally {
    clearInterval(poll);
    externalSignal?.removeEventListener('abort', abort);
  }
}

type RepoShadowRetirementRelease = () => void;
type RepoShadowRetirementHandler = (
  repoRoot: string,
) => Promise<RepoShadowRetirementRelease | void>;
let repoShadowRetirementHandler: RepoShadowRetirementHandler | null = null;

/** Installs the code-graph/base consumer drain invoked before shadow removal. */
export function setRepoShadowRetirementHandler(
  handler: RepoShadowRetirementHandler | null,
): void {
  repoShadowRetirementHandler = handler;
}

interface RecordedEnsureFailure {
  failedAt: number;
  message: string;
  noDefaultBranch: boolean;
}

const recentEnsureFailures = new Map<string, RecordedEnsureFailure>();
const backgroundShadowRefreshes = new Set<string>();

/** Test-only: clears the module-level failure cache and refresh dedupe. */
export function clearRepoShadowRuntimeCaches(): void {
  recentEnsureFailures.clear();
  backgroundShadowRefreshes.clear();
}

function recordEnsureFailure(repoRoot: string, error: unknown): void {
  recentEnsureFailures.set(repoRoot, {
    failedAt: Date.now(),
    message: error instanceof Error ? error.message : String(error),
    noDefaultBranch: error instanceof RepoShadowNoDefaultBranchError,
  });
}

function getRecentEnsureFailure(
  repoRoot: string,
): RecordedEnsureFailure | null {
  const failure = recentEnsureFailures.get(repoRoot);
  if (!failure) {
    return null;
  }
  if (Date.now() - failure.failedAt >= SHADOW_FAILURE_TTL_MS) {
    recentEnsureFailures.delete(repoRoot);
    return null;
  }
  return failure;
}

interface RepoShadowMetaFile {
  version: 1;
  repoPath: string;
  defaultBranch: string;
  lastSyncAt: string;
}

export function getRepoShadowDir(repoRoot: string): string {
  return join(getRepoShadowsRootDir(), codeGraphRepoShadowKey(repoRoot));
}

function getShadowCheckoutPath(repoRoot: string): string {
  return join(getRepoShadowDir(repoRoot), 'checkout');
}

function getShadowMetaPath(repoRoot: string): string {
  return join(getRepoShadowDir(repoRoot), 'meta.json');
}

/**
 * Removes what this module writes in a shadow before recreating it: the
 * checkout and `meta.json`. The `code-graph/` subtree belongs to the code-graph
 * base manager (CAN-5084), whose readers may be copying a published generation
 * under its own lock, so a recreate leaves it alone. Only cleanup removes the
 * whole directory, after the base manager's retirement drain.
 */
async function removeShadowOwnState(repoRoot: string): Promise<void> {
  await rm(getShadowCheckoutPath(repoRoot), { recursive: true, force: true });
  await rm(getShadowMetaPath(repoRoot), { force: true });
}

function isRepoShadowMeta(value: unknown): value is RepoShadowMetaFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record: Record<string, unknown> = { ...value };
  return (
    record.version === 1 &&
    typeof record.repoPath === 'string' &&
    typeof record.defaultBranch === 'string' &&
    typeof record.lastSyncAt === 'string'
  );
}

function hasRepoPath(value: unknown): value is { repoPath: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record: Record<string, unknown> = { ...value };
  return typeof record.repoPath === 'string';
}

async function readShadowMeta(
  repoRoot: string,
): Promise<RepoShadowMetaFile | null> {
  try {
    const raw = await readFile(getShadowMetaPath(repoRoot), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isRepoShadowMeta(parsed)) {
      return parsed;
    }
  } catch {
    // Missing or corrupt meta — treat as no shadow.
  }
  return null;
}

async function writeShadowMeta(
  repoRoot: string,
  meta: RepoShadowMetaFile,
): Promise<void> {
  const metaPath = getShadowMetaPath(repoRoot);
  await mkdir(dirname(metaPath), { recursive: true });
  await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

// Per-repoRoot promise chain shared by ensureRepoShadow and
// cleanupUnreferencedRepoShadows so the two never run concurrently against
// the same shadow directory: cleanup awaits any in-flight ensure before
// removing a shadow, and a new ensure started mid-cleanup waits for cleanup
// to finish before it (re)creates the shadow from scratch.
const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(repoRoot) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  repoLocks.set(repoRoot, settled);
  void settled.finally(() => {
    if (repoLocks.get(repoRoot) === settled) {
      repoLocks.delete(repoRoot);
    }
  });
  return run;
}

function isCompletedSyncMeta(meta: RepoShadowMetaFile): boolean {
  // The provisional meta written mid-create carries an epoch lastSyncAt and
  // has no usable checkout yet — never serve it, even as "stale".
  const syncedAt = Date.parse(meta.lastSyncAt);
  return Number.isFinite(syncedAt) && syncedAt > 0;
}

function isFreshMeta(meta: RepoShadowMetaFile, maxAgeMs: number): boolean {
  const ageMs = Date.now() - Date.parse(meta.lastSyncAt);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < maxAgeMs;
}

/**
 * Fire-and-forget refresh behind the per-repo lock, deduplicated so a burst
 * of stale-serving reads schedules at most one refresh. A recent failure
 * suppresses re-kicks for `SHADOW_FAILURE_TTL_MS` so an offline remote does
 * not turn every stale read into a background fetch storm.
 */
function scheduleBackgroundShadowRefresh(
  repoRoot: string,
  maxAgeMs: number,
): void {
  if (backgroundShadowRefreshes.has(repoRoot)) {
    return;
  }
  if (getRecentEnsureFailure(repoRoot) !== null) {
    return;
  }
  backgroundShadowRefreshes.add(repoRoot);
  void withRepoLock(repoRoot, () =>
    ensureRepoShadowInternal(repoRoot, maxAgeMs),
  )
    .then(() => {
      recentEnsureFailures.delete(repoRoot);
    })
    .catch((error: unknown) => {
      recordEnsureFailure(repoRoot, error);
    })
    .finally(() => {
      backgroundShadowRefreshes.delete(repoRoot);
    });
}

export function ensureRepoShadow(
  repoPath: string,
  options?: EnsureRepoShadowOptions,
): Promise<RepoShadowInfo> {
  return ensureRepoShadowThroughWorker(repoPath, options);
}

export async function ensureRepoShadowEffect(
  repoPath: string,
  options?: EnsureRepoShadowOptions,
): Promise<RepoShadowInfo> {
  const repoRoot = await resolveWorkspaceReferenceRepoPath(repoPath);
  const maxAgeMs = options?.maxAgeMs ?? SHADOW_MAX_AGE_MS;

  if (options?.allowStale === true) {
    const meta = await readShadowMeta(repoRoot);
    if (meta && meta.repoPath === repoRoot && isCompletedSyncMeta(meta)) {
      if (!isFreshMeta(meta, maxAgeMs)) {
        scheduleBackgroundShadowRefresh(repoRoot, maxAgeMs);
      }
      return {
        repoPath: repoRoot,
        shadowPath: getShadowCheckoutPath(repoRoot),
        defaultBranch: meta.defaultBranch,
        lastSyncAt: meta.lastSyncAt,
      };
    }
    // No completed shadow exists yet — fall through to the blocking ensure
    // (first create), which is the only way to produce a servable checkout.
  }

  if (options?.bypassFailureCache !== true) {
    const failure = getRecentEnsureFailure(repoRoot);
    if (failure) {
      throw failure.noDefaultBranch
        ? new RepoShadowNoDefaultBranchError(repoRoot)
        : new Error(failure.message);
    }
  }

  return withRepoLock(repoRoot, async () => {
    try {
      const info = await ensureRepoShadowInternal(
        repoRoot,
        maxAgeMs,
        options?.shouldContinue,
        options?.signal,
      );
      recentEnsureFailures.delete(repoRoot);
      return info;
    } catch (error) {
      if (!(error instanceof RepoShadowEnsureCanceledError)) {
        recordEnsureFailure(repoRoot, error);
      }
      throw error;
    }
  });
}

/**
 * Ensures and leases a canonical shadow under the same per-repository lock for
 * the full callback. Long-running base scans use this so checkout advancement
 * and cleanup cannot mutate/remove the tree while it is being parsed.
 */
export async function withEnsuredRepoShadow<T>(
  repoPath: string,
  options: EnsureRepoShadowOptions,
  fn: (shadow: RepoShadowInfo) => Promise<T>,
): Promise<T> {
  const repoRoot = await resolveWorkspaceReferenceRepoPath(repoPath);
  const maxAgeMs = options.maxAgeMs ?? SHADOW_MAX_AGE_MS;
  if (options.bypassFailureCache !== true) {
    const failure = getRecentEnsureFailure(repoRoot);
    if (failure !== null) {
      throw failure.noDefaultBranch
        ? new RepoShadowNoDefaultBranchError(repoRoot)
        : new Error(failure.message);
    }
  }
  return withRepoLock(repoRoot, async () => {
    try {
      const shadow = await ensureRepoShadowInternal(
        repoRoot,
        maxAgeMs,
        options.shouldContinue,
        options.signal,
      );
      recentEnsureFailures.delete(repoRoot);
      assertEnsureContinues(options.shouldContinue);
      return await fn(shadow);
    } catch (error) {
      if (!(error instanceof RepoShadowEnsureCanceledError)) {
        recordEnsureFailure(repoRoot, error);
      }
      throw error;
    }
  });
}

async function ensureRepoShadowInternal(
  repoRoot: string,
  maxAgeMs: number,
  shouldContinue?: () => boolean,
  signal?: AbortSignal,
): Promise<RepoShadowInfo> {
  assertEnsureContinues(shouldContinue);
  const shadowPath = getShadowCheckoutPath(repoRoot);
  const meta = await readShadowMeta(repoRoot);
  assertEnsureContinues(shouldContinue);

  if (meta && meta.repoPath === repoRoot) {
    const ageMs = Date.now() - Date.parse(meta.lastSyncAt);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < maxAgeMs) {
      return {
        repoPath: repoRoot,
        shadowPath,
        defaultBranch: meta.defaultBranch,
        lastSyncAt: meta.lastSyncAt,
      };
    }
    try {
      if (shouldContinue === undefined) {
        await fetchOrigin(shadowPath);
        await checkoutDetachedRef(shadowPath, `origin/${meta.defaultBranch}`);
      } else {
        await runCancellableGitOperation(shouldContinue, signal, (gitSignal) =>
          fetchOrigin(shadowPath, { signal: gitSignal }),
        );
        await runCancellableGitOperation(shouldContinue, signal, (gitSignal) =>
          checkoutDetachedRef(shadowPath, `origin/${meta.defaultBranch}`, {
            signal: gitSignal,
          }),
        );
      }
      assertEnsureContinues(shouldContinue);
      const lastSyncAt = new Date().toISOString();
      await writeShadowMeta(repoRoot, { ...meta, lastSyncAt });
      return {
        repoPath: repoRoot,
        shadowPath,
        defaultBranch: meta.defaultBranch,
        lastSyncAt,
      };
    } catch (error) {
      if (error instanceof RepoShadowEnsureCanceledError) {
        throw error;
      }
      if (shouldContinue !== undefined) {
        // Code Graph opt-out may race this refresh. Preserve the existing
        // shadow instead of falling through to destructive reconstruction.
        throw error;
      }
      // Refresh failed (checkout deleted or corrupted) — fall through to
      // recreate from scratch.
    }
  }

  assertEnsureContinues(shouldContinue);
  const defaultBranch =
    shouldContinue === undefined
      ? await getRemoteDefaultBranch(repoRoot)
      : await runCancellableGitOperation(shouldContinue, signal, (gitSignal) =>
          getRemoteDefaultBranch(repoRoot, { signal: gitSignal }),
        );
  assertEnsureContinues(shouldContinue);
  if (!defaultBranch) {
    throw new RepoShadowNoDefaultBranchError(repoRoot);
  }

  const shadowDir = getRepoShadowDir(repoRoot);
  const shadowDirExists = await access(shadowDir).then(
    () => true,
    () => false,
  );
  if (shouldContinue !== undefined && shadowDirExists) {
    throw new Error('The existing repository shadow could not be refreshed.');
  }
  if (shouldContinue === undefined) {
    await removeShadowOwnState(repoRoot);
  }
  try {
    assertEnsureContinues(shouldContinue);
    if (shouldContinue === undefined) {
      await pruneWorktrees(repoRoot).catch(() => undefined);
    } else {
      await runCancellableGitOperation(shouldContinue, signal, (gitSignal) =>
        pruneWorktrees(repoRoot, { signal: gitSignal }),
      ).catch((error: unknown) => {
        if (error instanceof RepoShadowEnsureCanceledError) throw error;
      });
    }
    assertEnsureContinues(shouldContinue);
    await mkdir(shadowDir, { recursive: true });
    assertEnsureContinues(shouldContinue);
    // Write a provisional meta.json before the network-bound fetch/worktree-add
    // so a concurrent cleanupUnreferencedRepoShadows scan can always derive the
    // repoPath lock key for this directory and serialize through withRepoLock
    // instead of treating the half-built shadow as corrupt and removing it
    // unlocked. The epoch lastSyncAt guarantees the provisional meta is never
    // treated as fresh: a later ensure reads it, attempts a refresh, fails
    // (no checkout yet), and falls through to a full recreate.
    await writeShadowMeta(repoRoot, {
      version: 1,
      repoPath: repoRoot,
      defaultBranch,
      lastSyncAt: new Date(0).toISOString(),
    });
    assertEnsureContinues(shouldContinue);
    if (shouldContinue === undefined) {
      await fetchOrigin(repoRoot);
      await addDetachedWorktree(
        repoRoot,
        shadowPath,
        `origin/${defaultBranch}`,
      );
    } else {
      await runCancellableGitOperation(shouldContinue, signal, (gitSignal) =>
        fetchOrigin(repoRoot, { signal: gitSignal }),
      );
      await runCancellableGitOperation(shouldContinue, signal, (gitSignal) =>
        addDetachedWorktree(repoRoot, shadowPath, `origin/${defaultBranch}`, {
          signal: gitSignal,
        }),
      );
    }
    assertEnsureContinues(shouldContinue);

    const lastSyncAt = new Date().toISOString();
    await writeShadowMeta(repoRoot, {
      version: 1,
      repoPath: repoRoot,
      defaultBranch,
      lastSyncAt,
    });
    assertEnsureContinues(shouldContinue);
    return { repoPath: repoRoot, shadowPath, defaultBranch, lastSyncAt };
  } catch (error) {
    if (shouldContinue !== undefined && !shadowDirExists) {
      await removeGitWorktree(repoRoot, shadowPath).catch(() => undefined);
      await rm(shadowDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await pruneWorktrees(repoRoot).catch(() => undefined);
    }
    throw error;
  }
}

export async function getBaselineReadPath(
  sourceRepoPath: string,
): Promise<string> {
  // Baseline config reads only need a best-effort checkout, and frequent
  // readers (sidebar loads among them) must never wait on the network. Serve
  // a completed shadow, stale or not (refreshing in the background). With no
  // shadow yet, creating one asks the remote for its default branch and
  // fetches, which can wait on a credential helper for as long as the git
  // timeout allows; start it in the background and read the repo itself.
  const repoRoot = await resolveWorkspaceReferenceRepoPath(sourceRepoPath);
  const meta = await readShadowMeta(repoRoot);
  if (meta && meta.repoPath === repoRoot && isCompletedSyncMeta(meta)) {
    if (!isFreshMeta(meta, SHADOW_MAX_AGE_MS)) {
      scheduleBackgroundShadowRefresh(repoRoot, SHADOW_MAX_AGE_MS);
    }
    return getShadowCheckoutPath(repoRoot);
  }
  scheduleBackgroundShadowRefresh(repoRoot, SHADOW_MAX_AGE_MS);
  return repoRoot;
}

export async function cleanupUnreferencedRepoShadows(
  referencedRepoPaths: string[],
): Promise<void> {
  const roots = await Promise.all(
    referencedRepoPaths.map((path) => resolveWorkspaceReferenceRepoPath(path)),
  );
  const referenced = new Set(roots);

  let entryNames: string[] = [];
  try {
    const entries = await readdir(getRepoShadowsRootDir(), {
      withFileTypes: true,
    });
    entryNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return;
  }

  for (const name of entryNames) {
    const dir = join(getRepoShadowsRootDir(), name);
    let repoPath: string | null = null;
    try {
      const raw = await readFile(join(dir, 'meta.json'), 'utf8');
      const meta: unknown = JSON.parse(raw);
      if (hasRepoPath(meta)) {
        repoPath = meta.repoPath;
      }
    } catch {
      // Corrupt meta — remove the directory below.
    }
    if (repoPath && referenced.has(repoPath)) {
      continue;
    }

    // Drain consumers BEFORE taking the repo lock: a base build deliberately
    // holds that lock while its worker scans. Cancel-and-await lets its callback
    // unwind and release the lock; taking the lock first would deadlock cleanup.
    const releaseRetirement =
      repoPath && repoShadowRetirementHandler !== null
        ? await repoShadowRetirementHandler(repoPath).catch(() => undefined)
        : undefined;

    const removeShadow = async (): Promise<void> => {
      if (repoPath) {
        await removeGitWorktree(repoPath, join(dir, 'checkout')).catch(
          () => undefined,
        );
        await pruneWorktrees(repoPath).catch(() => undefined);
      }
      await rm(dir, { recursive: true, force: true });
    };

    // Route the removal through the same per-repoRoot lock ensureRepoShadow
    // uses, so this cleanup waits for any in-flight ensure to finish before
    // deleting the shadow, and a concurrent ensure started mid-cleanup waits
    // for cleanup to finish before it (re)creates the shadow.
    try {
      if (repoPath) {
        await withRepoLock(repoPath, removeShadow);
      } else {
        await removeShadow();
      }
    } finally {
      releaseRetirement?.();
    }
  }
}

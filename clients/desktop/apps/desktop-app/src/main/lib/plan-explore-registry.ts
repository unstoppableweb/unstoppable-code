import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { getPlanExploreRegistryFilePath } from './paths';
import { isRecord } from './type-guards';

/**
 * Legacy plan-explore sentinel compatibility adapter (phase 05 D8/D-F; writer
 * IPC retired in phase 06 D-I/S7).
 *
 * The plan-explore *takeover* chat scope is keyed
 * `(PLAN_EXPLORE_CHAT_PROJECT_ID, planId)`, so this registry maps that
 * sentinel `planId` back to the real `(projectId, worktreeId)` whose checkout
 * the takeover session ran in. There is no writer IPC left — the renderer
 * takeover surface that produced new rows via `chat:register-plan-explore`
 * was removed in phase 06 — so this module now only serves legacy rows
 * written before the cutover: reads (`getPlanExploreTarget`,
 * `getPlanExploreTargetSync`) and owner-validated cleanup
 * (`removePlanExploreTarget`, `listPlanExploreTargetIdsForScope`).
 * `registerPlanExploreTarget` has no remaining production caller and is kept
 * only for its existing tests pending the registry's full removal in a later
 * phase. Ordinary plan-file flows (turn ownership, materialization,
 * instructions, cleanup sweeps) key and scope by the real
 * `(projectId, worktreeId, planId)` directly and must never call it.
 */
export interface PlanExploreTargetRef {
  projectId: string;
  worktreeId: string;
}

interface PlanExploreRegistryFile {
  version: 1;
  targets: Record<string, PlanExploreTargetRef>;
}

function isPlanExploreTargetRef(value: unknown): value is PlanExploreTargetRef {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string'
  );
}

function isPlanExploreRegistryFile(
  value: unknown,
): value is PlanExploreRegistryFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.targets)) {
    return false;
  }
  return Object.values(value.targets).every(isPlanExploreTargetRef);
}

function emptyRegistry(): PlanExploreRegistryFile {
  return { version: 1, targets: {} };
}

function parseRegistry(raw: string): PlanExploreRegistryFile {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPlanExploreRegistryFile(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to empty registry on corrupt JSON.
  }
  return emptyRegistry();
}

/**
 * In-memory cache of the parsed registry keyed by the file's last-modified
 * time (ms). `resolveWorktreeCwd` is synchronous and may be called per turn, so
 * the synchronous read below avoids re-parsing the (tiny) registry file unless
 * it has actually changed on disk.
 */
let cachedRegistry: { mtimeMs: number; file: PlanExploreRegistryFile } | null =
  null;

async function readRegistry(): Promise<PlanExploreRegistryFile> {
  try {
    const raw = await readFile(getPlanExploreRegistryFilePath(), 'utf8');
    return parseRegistry(raw);
  } catch {
    return emptyRegistry();
  }
}

/**
 * Registry writes are read-modify-write over one small JSON file. Serialize
 * them in-process so a plan registration racing a worktree cleanup sweep
 * cannot clobber the other's row.
 */
let registryWriteQueue: Promise<unknown> = Promise.resolve();

function withRegistryWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = registryWriteQueue.then(operation, operation);
  registryWriteQueue = run.catch(() => undefined);
  return run;
}

async function writeRegistry(next: PlanExploreRegistryFile): Promise<void> {
  const filePath = getPlanExploreRegistryFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(next, null, 2), 'utf8');
  cachedRegistry = null;
}

/**
 * Two refs identify the same real worktree scope. Used to decide whether a
 * caller is authorized to mutate or is looking at a stale/foreign row.
 */
export function isSamePlanExploreScope(
  a: PlanExploreTargetRef,
  b: PlanExploreTargetRef,
): boolean {
  return a.projectId === b.projectId && a.worktreeId === b.worktreeId;
}

/**
 * Register `planId`'s takeover target, overwriting any existing row. This was
 * the compatibility write path for the plan-explore sentinel chat, written
 * only by the now-removed `chat:register-plan-explore` IPC handler; it has no
 * remaining production caller (phase 06 D-I/S7) and is kept only for its
 * existing tests pending the registry's full removal. Never call it for
 * ordinary plan-file flows.
 */
export async function registerPlanExploreTarget(
  planId: string,
  ref: PlanExploreTargetRef,
): Promise<void> {
  await withRegistryWriteLock(async () => {
    const current = await readRegistry();
    await writeRegistry({
      version: 1,
      targets: { ...current.targets, [planId]: ref },
    });
  });
}

/**
 * Look up `planId`'s registered takeover target. When `expected` is given,
 * returns `null` unless the registered row matches that scope, so a stale or
 * foreign registration cannot be mistaken for a live one.
 */
export async function getPlanExploreTarget(
  planId: string,
  expected?: PlanExploreTargetRef,
): Promise<PlanExploreTargetRef | null> {
  const file = await readRegistry();
  const target = file.targets[planId] ?? null;
  if (target && expected && !isSamePlanExploreScope(target, expected)) {
    return null;
  }
  return target;
}

/**
 * Synchronous registry read for `resolveWorktreeCwd`, which is synchronous.
 * Reads the tiny registry file via `readFileSync` and caches the parsed result
 * keyed by the file's mtime so repeated cwd resolutions avoid re-reading and
 * re-parsing unless the registry changed.
 */
export function getPlanExploreTargetSync(
  planId: string,
): PlanExploreTargetRef | null {
  const filePath = getPlanExploreRegistryFilePath();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    cachedRegistry = null;
    return null;
  }

  if (!cachedRegistry || cachedRegistry.mtimeMs !== mtimeMs) {
    try {
      const raw = readFileSync(filePath, 'utf8');
      cachedRegistry = { mtimeMs, file: parseRegistry(raw) };
    } catch {
      cachedRegistry = null;
      return null;
    }
  }

  return cachedRegistry.file.targets[planId] ?? null;
}

export type RemovePlanExploreTargetResult =
  | 'removed'
  | 'absent'
  | 'other-scope';

/**
 * Drop `planId` from the registry, but only when `owner` matches the
 * registered scope. Returns `'removed'` when the row was owned and removed,
 * `'other-scope'` when a different scope owns the row (no write), and
 * `'absent'` when the plan was never registered (no write) — so a cleanup
 * sweep for one worktree can never delete another worktree's same-id row.
 */
export async function removePlanExploreTarget(
  planId: string,
  owner: PlanExploreTargetRef,
): Promise<RemovePlanExploreTargetResult> {
  return withRegistryWriteLock(async () => {
    const current = await readRegistry();
    const existing = current.targets[planId];
    if (!existing) {
      return 'absent';
    }
    if (!isSamePlanExploreScope(existing, owner)) {
      return 'other-scope';
    }
    await writeRegistry({
      version: 1,
      targets: Object.fromEntries(
        Object.entries(current.targets).filter(([id]) => id !== planId),
      ),
    });
    return 'removed';
  });
}

/**
 * Every plan id currently registered to `owner`'s real worktree scope. Used
 * by the worktree cleanup sweep to catch takeover rows whose known plan ids
 * were not already supplied by the caller.
 */
export async function listPlanExploreTargetIdsForScope(
  owner: PlanExploreTargetRef,
): Promise<string[]> {
  const file = await readRegistry();
  return Object.entries(file.targets)
    .filter(([, ref]) => isSamePlanExploreScope(ref, owner))
    .map(([planId]) => planId);
}

/**
 * Move every row owned by `from` to `to`, leaving other scopes' rows alone.
 * Restoring an archived worktree gives it a new id, and the legacy plan chats
 * its archive kept must follow it so a later plan or worktree cleanup of the
 * restored worktree still reclaims them. Writes only when a row moves, so a
 * retried restore is a no-op. Returns the moved plan ids.
 */
export async function transferPlanExploreTargets(
  from: PlanExploreTargetRef,
  to: PlanExploreTargetRef,
): Promise<string[]> {
  return withRegistryWriteLock(async () => {
    const current = await readRegistry();
    const moved: string[] = [];
    const targets: Record<string, PlanExploreTargetRef> = {};
    for (const [planId, ref] of Object.entries(current.targets)) {
      if (isSamePlanExploreScope(ref, from)) {
        moved.push(planId);
        targets[planId] = {
          projectId: to.projectId,
          worktreeId: to.worktreeId,
        };
      } else {
        targets[planId] = ref;
      }
    }
    if (moved.length > 0) {
      await writeRegistry({ version: 1, targets });
    }
    return moved;
  });
}

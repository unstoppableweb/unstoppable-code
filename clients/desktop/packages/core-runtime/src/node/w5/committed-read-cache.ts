// Explicit commit-log modules only: the commit-log index loads node:sqlite.
import {
  isW5CaptureWorkspaceId,
  W5_CAPTURE_LIMITS,
  type W5CaptureFile,
  type W5CaptureRequest,
  type W5CaptureResult,
  type W5FileImage,
} from './commit-log/capture-contract';
import type { W5Resource } from './commit-log/commit-log';
import { isRecord } from './commit-log/is-record';
import { classifyW5CommitFile } from './commit-events';
import type { W5StoreDecision } from './commit-log-file-store';
import {
  createW5CommittedProjection,
  w5ProjectionFileKey,
  type W5CommittedProjection,
} from './committed-projection';
import { isW5CaptureLimitRefusal } from './record-port/batching-reader';

/*
 * The read cache's update paths over its projection (CAN-7155, W5 readers
 * S-9): the W5e cache step, broad refill and own-commit refill. Host-neutral
 * and timer-free; the host holds the instance, supplies its capture and
 * retries what is still owed. TRANSITIONAL compatibility path, replaced by
 * W10's core read model (CAN-7153). Until a reader is switched onto it
 * (CAN-7155 PRs 3-4) nothing consults it.
 *
 * Capture evidence carries no log identity. A capture shows a new log at
 * once only when its commit id or abandoned-commit count is below what one
 * requested earlier saw; neither falls within one log. Otherwise every broad
 * refill rebuilds into a fresh projection and swaps it in once complete: a
 * new log at any commit id is replaced by the next broad refill (the bridge
 * plans one on every snapshot, epoch change included), and log-wide state
 * (abandonment, unresolved counts) always comes from the current log. Until
 * it completes, the old projection keeps serving. Revisit when the capture
 * evidence carries a log identity.
 */

/** What one W5e event names; core-client's invalidation plan has this shape. */
export interface W5ReadCacheInvalidation {
  readonly broad: boolean;
  readonly index: boolean;
  readonly workspaces: readonly string[];
  readonly manifests: readonly string[];
  readonly worktreeLists: readonly string[];
  readonly commitId?: number;
}

export type W5ReadCacheCapture = (
  request: W5CaptureRequest,
) => Promise<W5CaptureResult>;

export type W5ReadCacheListener = (
  resources: readonly W5Resource[],
  commitId: number,
) => void;

export interface W5CommittedReadCache {
  /** The served projection; a completed broad refill or a new log replaces it. */
  projection(): W5CommittedProjection;
  /**
   * A broad refill settled the current projection and none failed since; a
   * failed one leaves every held file dirty until another completes.
   */
  warmed(): boolean;
  /**
   * A retry would capture something: a broad refill until the cache is
   * warmed, else files an own decision or a failed targeted capture left, or
   * unresolved commits, until `W5_READ_CACHE_IDLE_RETRIES`
   * marked refills in a row settled nothing. A file refused as too large
   * alone is owed again only once a plan, broad refill or own decision
   * names it.
   */
  owed(): boolean;
  /** The store's `onApplied` binding: synchronous, inside the decision. */
  noteOwnDecision(root: string, decision: W5StoreDecision): void;
  /** One capture of every marked file; coalesced. */
  refillMarked(): Promise<void>;
  /**
   * One discovery capture, split when the held files exceed one request or
   * on `limit-exceeded`; coalesced.
   */
  refillBroad(): Promise<void>;
  /** The W5e step: skips a plan the projection already holds, else captures. */
  apply(plan: W5ReadCacheInvalidation): Promise<void>;
  /** Cached bytes changed (CAN-6970's signal source); returns the removal. */
  onResourcesChanged(listener: W5ReadCacheListener): () => void;
}

/**
 * Marked refills in a row that settle nothing (unresolved commits, or an
 * entry no capture admits) before `owed()` stops asking for more; a W5e
 * plan, broad refill or own decision restarts the count.
 */
export const W5_READ_CACHE_IDLE_RETRIES = 5;

/** Runs `run` once at a time; calls during a run share one queued rerun. */
function coalesced(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  let queued: Promise<void> | undefined;
  const start = (): Promise<void> => {
    const pending: Promise<void> = Promise.resolve()
      .then(run)
      .finally(() => {
        if (inFlight === pending) inFlight = undefined;
      });
    inFlight = pending;
    return pending;
  };
  return () => {
    if (!inFlight) return start();
    queued ??= inFlight
      .catch(() => undefined)
      .then(() => {
        queued = undefined;
        return start();
      });
    return queued;
  };
}

/** The files a plan names, as the projection keys them. */
function plannedFiles(plan: W5ReadCacheInvalidation): W5CaptureFile[] {
  const files = new Map<string, W5CaptureFile>();
  const add = (file: W5CaptureFile): void => {
    files.set(w5ProjectionFileKey(file), file);
  };
  // A workspace row without its manifest is read from the index and manifest.
  if (plan.index || plan.workspaces.length) add({ kind: 'index' });
  for (const workspaceId of [...plan.workspaces, ...plan.manifests])
    add({ kind: 'manifest', workspaceId });
  for (const workspaceId of plan.worktreeLists)
    add({ kind: 'worktrees', workspaceId });
  return Array.from(files.values());
}

function resourceOf(file: W5CaptureFile): W5Resource | undefined {
  if (file.kind === 'index') return { kind: 'workspaces' };
  if (file.kind === 'manifest')
    return { kind: 'workspace', workspaceId: file.workspaceId };
  if (file.kind === 'worktrees')
    return { kind: 'worktrees', workspaceId: file.workspaceId };
  return undefined;
}

function imageKey(image: W5FileImage | undefined): string | undefined {
  if (!image) return undefined;
  if (image.state === 'present') return `present:${image.base64}`;
  return image.state === 'unreadable' ? `unreadable:${image.reason}` : 'absent';
}

/** The workspace ids a captured primary index lists, as discovery reads them. */
function indexedWorkspaces(image: W5FileImage | undefined): string[] {
  if (image?.state !== 'present') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(image.base64, 'base64').toString('utf8'));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.workspaces)) return [];
  return parsed.workspaces.flatMap((entry: unknown) =>
    isRecord(entry) && isW5CaptureWorkspaceId(entry.id) ? [entry.id] : [],
  );
}

export function createW5CommittedReadCache(options: {
  readonly capture: W5ReadCacheCapture;
}): W5CommittedReadCache {
  let projection = createW5CommittedProjection();
  // A broad refill's fresh projection: every capture, own decision and mark
  // reaches it as it reaches the served one, so the swap loses none.
  let building: W5CommittedProjection | undefined;
  let warm = false;
  // The highest commit id this log reached; commit ids never fall in one log.
  let highWater = 0;
  // The most abandoned commits a capture showed; only abandonment deletes
  // one, so in one log this never falls either.
  let abandonedHigh = 0;
  // Keys of files a capture refused as too large alone: left out of marked
  // refills, so an idle retry never re-reads them.
  const oversized = new Set<string>();
  // Marked refills in a row that settled nothing, and the restarts that
  // zero it, so a refill a restart overtook never counts.
  let idleRuns = 0;
  let restarts = 0;
  const listeners = new Set<W5ReadCacheListener>();

  const retryPlan = (): W5CaptureRequest | null =>
    projection.refillPlan(oversized);
  /** How the planned files stand; an equal one after a refill settled nothing. */
  const standing = (plan: W5CaptureRequest | null): string =>
    plan
      ? plan.files
          .map(
            (file) =>
              `${w5ProjectionFileKey(file)}=${projection.state(file)}@${projection.commitId(file)}`,
          )
          .join('|')
      : '';
  const resetIdle = (): void => {
    idleRuns = 0;
    restarts += 1;
  };
  /** A plan, broad refill or own decision names `files`: retry them again. */
  const restart = (files: readonly W5CaptureFile[]): void => {
    resetIdle();
    for (const file of files) oversized.delete(w5ProjectionFileKey(file));
  };

  /** Runs `change` on the projection, then reports files whose bytes moved. */
  const reporting = (
    files: readonly W5CaptureFile[],
    commitId: number,
    change: () => void,
  ): void => {
    const before = files.map((file) => imageKey(projection.image(file)));
    change();
    if (!listeners.size) return;
    const resources = files.flatMap((file, index) => {
      const after = imageKey(projection.image(file));
      const resource = resourceOf(file);
      return after !== undefined && after !== before[index] && resource
        ? [resource]
        : [];
    });
    if (!resources.length) return;
    for (const listener of Array.from(listeners)) {
      try {
        listener(resources, commitId);
      } catch {
        // A listener never breaks a refill.
      }
    }
  };

  /** Installs a capture as the projection's own refill; reports if served. */
  const install = (
    target: W5CommittedProjection,
    result: W5CaptureResult,
    ticket: number,
  ): void => {
    const run = (): void =>
      target.installCapture(result, { ticket, authoritative: true });
    if (target === projection)
      reporting(result.files, result.log.commitId, run);
    else run();
  };

  /** One capture the cache requested, installed as its own refill. */
  const captureInto = async (
    request: W5CaptureRequest,
  ): Promise<W5CaptureResult> => {
    const targets = [projection, building].flatMap((target) =>
      target ? [{ target, ticket: target.ticket() }] : [],
    );
    // A capture requested after the log reached `floor` sees at least it,
    // and at least `abandonedFloor` abandoned commits.
    const floor = highWater;
    const abandonedFloor = abandonedHigh;
    const result = await options.capture(request);
    const { commitId } = result.log;
    const abandonedCount = commitId - result.log.retainedCommits;
    // A projection replaced since the request is covered by its replacement's
    // own captures, all requested later: a swap's, or a new log's.
    const open = targets.filter(
      ({ target }) => target === projection || target === building,
    );
    if (!open.length) return result;
    if (commitId < floor || abandonedCount < abandonedFloor) {
      // Below a position or an abandonment this log already reached: a new
      // log epoch. A broad refill in flight was filling from the old log and
      // starts over.
      projection = createW5CommittedProjection();
      building = undefined;
      warm = false;
      highWater = commitId;
      abandonedHigh = abandonedCount;
      oversized.clear();
      resetIdle();
      // A projection started since the request has nothing it could undo.
      install(projection, result, projection.ticket());
      return result;
    }
    highWater = Math.max(highWater, commitId);
    abandonedHigh = Math.max(abandonedHigh, abandonedCount);
    for (const { target, ticket } of open) install(target, result, ticket);
    return result;
  };

  /**
   * Held even without an entry: a capture requested earlier (a rebuild's
   * discovery above all) never installs them.
   */
  const markDirty = (files: readonly W5CaptureFile[]): void => {
    projection.markDirty(files, { hold: true });
    building?.markDirty(files, { hold: true });
  };

  /** Captures `files`, halving past the limits; one file over them stays dirty. */
  const captureFiles = async (
    files: readonly W5CaptureFile[],
  ): Promise<void> => {
    if (!files.length) return;
    if (files.length <= W5_CAPTURE_LIMITS.files)
      try {
        await captureInto({ files, discoverWorkspaces: false });
        for (const file of files) oversized.delete(w5ProjectionFileKey(file));
        return;
      } catch (error) {
        if (!isW5CaptureLimitRefusal(error)) throw error;
        // Too large to capture at all: readers take today's path for it.
        if (files.length === 1) {
          for (const file of files) oversized.add(w5ProjectionFileKey(file));
          return markDirty(files);
        }
      }
    const middle = Math.ceil(files.length / 2);
    await captureFiles(files.slice(0, middle));
    await captureFiles(files.slice(middle));
  };

  const refillMarked = coalesced(async () => {
    const plan = retryPlan();
    if (!plan) return;
    const before = standing(plan);
    const since = restarts;
    await captureFiles(plan.files);
    if (since !== restarts) return;
    idleRuns = standing(retryPlan()) === before ? idleRuns + 1 : 0;
  });

  /**
   * One discovery capture of `held`; false when it must split instead. A
   * request over the file count fails the contract before it is sent, so it
   * is never sent; past that, the host's `limit-exceeded` refusal splits.
   */
  const discoverWithin = async (
    held: readonly W5CaptureFile[],
  ): Promise<boolean> => {
    // Discovery adds the index.
    const count =
      held.length + (held.some((file) => file.kind === 'index') ? 0 : 1);
    if (count > W5_CAPTURE_LIMITS.files) return false;
    try {
      await captureInto({ files: held, discoverWorkspaces: true });
      return true;
    } catch (error) {
      if (!isW5CaptureLimitRefusal(error)) throw error;
      return false;
    }
  };

  /** Fills `fresh`, which already holds every file to capture again. */
  const broadOnce = async (fresh: W5CommittedProjection): Promise<void> => {
    // Held files ride along, so a removed workspace's files read absent.
    const held = fresh.files();
    // A broad refill names every file again.
    resetIdle();
    oversized.clear();
    if (!(await discoverWithin(held))) {
      const index = await captureInto({
        files: [{ kind: 'index' }],
        discoverWorkspaces: false,
      });
      const files = new Map<string, W5CaptureFile>();
      for (const workspaceId of indexedWorkspaces(index.files[0]))
        for (const kind of ['manifest', 'worktrees'] as const)
          files.set(`${kind}:${workspaceId}`, { kind, workspaceId });
      for (const file of held)
        if (file.kind !== 'index') files.set(w5ProjectionFileKey(file), file);
      await captureFiles(Array.from(files.values()));
    }
    if (building !== fresh) return;
    // Own decisions during the capture marked files it predates.
    const plan = fresh.refillPlan(oversized);
    if (plan) await captureFiles(plan.files);
  };
  const refillBroad = coalesced(async () => {
    const held = new Map<string, W5CaptureFile>();
    try {
      // A new log seen mid-refill abandons the rebuild: build once more.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        for (const file of projection.files())
          held.set(w5ProjectionFileKey(file), file);
        const fresh = createW5CommittedProjection();
        // Held as dirty: no capture requested before the rebuild installs.
        fresh.markDirty(Array.from(held.values()), { hold: true });
        building = fresh;
        await broadOnce(fresh);
        if (building !== fresh) continue;
        building = undefined;
        const files = new Map(held);
        for (const file of fresh.files())
          files.set(w5ProjectionFileKey(file), file);
        reporting(Array.from(files.values()), highWater, () => {
          projection = fresh;
        });
        warm = true;
        return;
      }
    } catch (error) {
      building = undefined;
      // A broad refill means any commit may have been missed, so nothing held
      // is served, even files a split capture settled, until one completes.
      warm = false;
      projection.markDirty(projection.files());
      throw error;
    }
  });

  return {
    projection: () => projection,
    warmed: () => warm,
    owed(): boolean {
      if (!warm) return true;
      return idleRuns < W5_READ_CACHE_IDLE_RETRIES && retryPlan() !== null;
    },
    noteOwnDecision(root, decision): void {
      const { outcome } = decision;
      // Only a new commit allocates past every earlier capture's position.
      if (outcome.status === 'applied' || outcome.status === 'conflict')
        highWater = Math.max(highWater, outcome.commitId);
      const written = decision.files.flatMap(({ path }) => {
        const file = classifyW5CommitFile(root, path);
        return file ? [file] : [];
      });
      // The write may have brought an oversized file back under the limits.
      restart(written);
      const note = (target: W5CommittedProjection): void => {
        // An image newer than the decision is kept: a race with a later
        // commit, or a new log not yet seen. Only a capture tells them apart.
        const newer =
          'commitId' in outcome
            ? written.filter(
                (file) => (target.commitId(file) ?? 0) > outcome.commitId,
              )
            : [];
        target.noteOwnDecision(root, decision);
        if (newer.length) target.markDirty(newer);
      };
      reporting(written, 'commitId' in outcome ? outcome.commitId : 0, () =>
        note(projection),
      );
      if (building) note(building);
    },
    refillMarked,
    refillBroad,
    async apply(plan): Promise<void> {
      if (plan.broad) return refillBroad();
      const files = plannedFiles(plan);
      restart(files);
      const { commitId } = plan;
      // A refill that won the race already holds the commit, in the served
      // projection and in any rebuild that will replace it.
      if (
        commitId !== undefined &&
        [projection, building].every(
          (target) =>
            !target || files.every((file) => target.holds(file, commitId)),
        )
      )
        return;
      try {
        await captureFiles(files);
      } catch (error) {
        // Nothing stale is served while the bridge retries.
        markDirty(files);
        throw error;
      }
    },
    onResourcesChanged(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

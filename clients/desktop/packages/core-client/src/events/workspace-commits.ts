import {
  CORE_WORKSPACE_COMMITTED_EVENT,
  CORE_WORKSPACE_EVENT_FAMILY,
  CORE_WORKSPACE_INVALIDATED_EVENT,
  CoreWorkspaceCommittedPayloadSchema,
  type CanopyEvent,
} from '@canopy/protocol/canopy-core';
import { toCanopyClientError } from '../errors';
import { createCanopyEventSubscription } from './subscription';
import type { CanopyEventsConnection, CanopyEventSubscription } from './types';

/**
 * What a host re-reads for one workspace event (W5e, CAN-5497). Hosts map it
 * onto their own caches; it names resources, never paths.
 */
export interface CanopyWorkspaceInvalidationPlan {
  /** Re-read everything: an invalidation, a snapshot or a failed stream. */
  readonly broad: boolean;
  /** The workspace index changed: membership, order or index rows. */
  readonly index: boolean;
  /** Workspace rows that changed without a manifest file. */
  readonly workspaces: readonly string[];
  /** Workspaces whose manifest file changed. */
  readonly manifests: readonly string[];
  /** Workspaces whose worktree list changed. */
  readonly worktreeLists: readonly string[];
  /**
   * The commit's id, from a `w5:<id>` commit reference; absent on a broad
   * plan or another core's reference. A cache already holding every named
   * resource at or past it can skip its re-read.
   */
  readonly commitId?: number;
  /** Each advanced resource's new revision, by W5 resource key. */
  readonly revisions?: Readonly<Record<string, number>>;
}

export const CANOPY_WORKSPACE_BROAD_INVALIDATION: CanopyWorkspaceInvalidationPlan =
  Object.freeze({
    broad: true,
    index: true,
    workspaces: [],
    manifests: [],
    worktreeLists: [],
  });

/**
 * The plan for one event, or null when there is nothing to do: an unknown
 * event name, a commit this process published itself (`isOwnOrigin`), or a
 * commit that names no resource. An unreadable commit payload is broad.
 */
export function planCanopyWorkspaceInvalidation(
  event: CanopyEvent,
  isOwnOrigin: (clientInstanceId: string) => boolean,
): CanopyWorkspaceInvalidationPlan | null {
  if (event.name === CORE_WORKSPACE_INVALIDATED_EVENT)
    return CANOPY_WORKSPACE_BROAD_INVALIDATION;
  if (event.name !== CORE_WORKSPACE_COMMITTED_EVENT) return null;
  const parsed = CoreWorkspaceCommittedPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return CANOPY_WORKSPACE_BROAD_INVALIDATION;
  const { commit, changes, files = [], publishedBy } = parsed.data;
  if (publishedBy !== undefined && isOwnOrigin(publishedBy)) return null;
  const revisions: Record<string, number> = {};
  let index = false;
  const manifests = new Set<string>();
  const lists = new Set<string>();
  for (const file of files) {
    if (file.kind === 'index') index = true;
    else if (file.workspaceId === undefined) continue;
    else if (file.kind === 'manifest') manifests.add(file.workspaceId);
    else if (file.kind === 'worktrees') lists.add(file.workspaceId);
  }
  const workspaces = new Set<string>();
  for (const change of changes) {
    const key = resourceKey(change);
    if (key !== undefined) revisions[key] = change.revision;
    if (change.kind === 'index') index = true;
    else if (change.workspaceId === undefined) continue;
    else if (change.kind === 'workspace') {
      if (!manifests.has(change.workspaceId))
        workspaces.add(change.workspaceId);
    } else lists.add(change.workspaceId);
  }
  if (!index && workspaces.size + manifests.size + lists.size === 0)
    return null;
  const commitId = /^w5:(\d{1,15})$/.exec(commit)?.[1];
  return {
    broad: false,
    index,
    workspaces: Array.from(workspaces),
    manifests: Array.from(manifests),
    worktreeLists: Array.from(lists),
    ...(commitId !== undefined && { commitId: Number(commitId) }),
    revisions,
  };
}

/** The W5 resource key a change advanced (`w5ResourceKey`'s format). */
function resourceKey(change: {
  readonly kind: 'index' | 'workspace' | 'worktreeList' | 'worktree';
  readonly workspaceId?: string;
  readonly worktreeId?: string;
}): string | undefined {
  if (change.kind === 'index') return 'workspaces';
  const { workspaceId, worktreeId } = change;
  if (workspaceId === undefined) return undefined;
  if (change.kind === 'workspace') return `workspace:${workspaceId}`;
  if (change.kind === 'worktreeList') return `worktrees:${workspaceId}`;
  return worktreeId === undefined
    ? undefined
    : `worktree:${workspaceId}/${worktreeId}`;
}

export interface CanopyWorkspaceEventBridgeOptions {
  /** Whether this process published commits made under that client instance. */
  isOwnOrigin(clientInstanceId: string): boolean;
  /**
   * Applies one plan; plans apply one at a time, in event order. Rejects when
   * any re-read failed, so the bridge never acknowledges a stale host.
   */
  apply(plan: CanopyWorkspaceInvalidationPlan): Promise<void>;
  /** A failed plan or attachment; the bridge keeps going. */
  onError?(error: unknown): void;
  /** Each delivered event, own-origin included, before it is planned. */
  onDelivered?(event: CanopyEvent): void;
  /** Consecutive re-attaches after a failed stream, before waiting for the host. */
  maxReattachAttempts?: number;
  /** The first broad re-read retry delay; doubles per attempt. */
  retryDelayMs?: number;
}

/** The first broad re-read retry delay after a failed application. */
export const CANOPY_WORKSPACE_EVENT_RETRY_MS = 250;
/** Broad re-reads a delivery waits for before it is acknowledged anyway. */
const BROAD_ATTEMPTS = 3;
/** An owed recovery's first delay, then its ceiling, in first retry delays. */
const RECOVERY_FIRST = 8;
const RECOVERY_CEILING = 128;

export interface CanopyWorkspaceEventBridge {
  /**
   * Subscribes on a connection the host already holds; never opens one.
   * Idempotent while that connection's subscription is open. A connection
   * whose daemon lacks event acknowledgement is remembered and skipped.
   */
  attach(connection: CanopyEventsConnection): Promise<void>;
  state(authorityId: string): ReturnType<CanopyEventSubscription['state']>;
  close(): Promise<void>;
}

/**
 * The host-neutral workspace event subscriber. A snapshot (initial, epoch
 * change or `snapshotRequired`) resumes with a null cursor, which the core
 * answers with its latest entry only; the bridge therefore applies a broad
 * invalidation once the stream is open, so a commit landing between the
 * snapshot and the open is never missed. A stream that fails or detaches
 * while its connection lives is re-attached from its cursor, then
 * invalidated broadly.
 *
 * A delivery is acknowledged only once its plan applied or a broad re-read
 * covering it did. A failed plan holds its delivery, and every later one,
 * for up to three broad re-reads: at once, after `retryDelayMs`, then after
 * twice that. If all three fail the delivery is acknowledged so one broken
 * resource cannot hold back later commits, and a broad recovery is owed:
 * retried after `8 * retryDelayMs`, doubling per failure to a ceiling of
 * `128 * retryDelayMs`, until it applies. A file left corrupt costs one
 * broad re-read per ceiling, a fault that clears is re-read within one
 * ceiling, and a recovery owed again starts from the first delay. While the
 * recovery is owed, a delivery that needs a broad re-read (an invalidation
 * or a failed plan) is acknowledged at once; only a broad re-read queued
 * after it discharges the recovery, so a recovery already reading when one
 * arrives reads again as soon as it applies. The re-read on open follows the
 * same rule.
 */
export function createCanopyWorkspaceEventBridge(
  options: CanopyWorkspaceEventBridgeOptions,
): CanopyWorkspaceEventBridge {
  const maxAttempts = options.maxReattachAttempts ?? 3;
  const retryDelay = options.retryDelayMs ?? CANOPY_WORKSPACE_EVENT_RETRY_MS;
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Reporting never breaks delivery.
    }
  };
  let queue: Promise<void> = Promise.resolve();
  // Rejects with the plan's failure; the queue itself keeps draining.
  const enqueue = (plan: CanopyWorkspaceInvalidationPlan): Promise<void> => {
    const run = queue.then(() => options.apply(plan));
    queue = run.catch(() => undefined);
    return run;
  };
  let closed = false;
  let current: CanopyEventsConnection | null = null;
  let attempts = 0;
  // The open stream's session signal; the helper aborts it on stop.
  let streamSignal: AbortSignal | undefined;
  let recoveryOwed = false;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryDelay = retryDelay * RECOVERY_FIRST;
  // Bumped for each delivery acknowledged on the owed recovery; only a
  // re-read queued after the last bump may discharge it.
  let owedGeneration = 0;
  // Set by a snapshot or a failure; consumed once the next stream is open.
  let broadOnOpen = false;
  const unavailable = new WeakSet<CanopyEventsConnection>();
  const watched = new WeakSet<AbortSignal>();

  const broad = async (): Promise<void> => {
    const generation = owedGeneration;
    await enqueue(CANOPY_WORKSPACE_BROAD_INVALIDATION);
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    recoveryDelay = retryDelay * RECOVERY_FIRST;
    // Re-read at once, not after a backoff: the host just applied, and the
    // newer delivery is already acknowledged.
    if (generation !== owedGeneration) recover();
    else recoveryOwed = false;
  };
  const recover = (): void => {
    if (closed || !recoveryOwed) return;
    broad().catch((error: unknown) => {
      report(error);
      recoveryDelay = Math.min(
        recoveryDelay * 2,
        retryDelay * RECOVERY_CEILING,
      );
      scheduleRecovery();
    });
  };
  const scheduleRecovery = (): void => {
    if (closed || recoveryTimer !== undefined) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      recover();
    }, recoveryDelay);
  };
  /** Resolves after `ms`, or as soon as the session stops. */
  const pause = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });
  /**
   * A broad re-read that must apply before the stream moves on; never
   * rejects. Returns without one while a recovery is owed or the session
   * stopped (the helper then settles nothing).
   */
  const cover = async (signal: AbortSignal | undefined): Promise<void> => {
    for (let attempt = 0; attempt < BROAD_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await pause(retryDelay * 2 ** (attempt - 1), signal);
      if (closed || signal?.aborted) return;
      if (recoveryOwed) {
        owedGeneration += 1;
        return;
      }
      try {
        await broad();
        return;
      } catch (error) {
        report(error);
      }
    }
    owedGeneration += 1;
    recoveryOwed = true;
    scheduleRecovery();
  };

  const subscription = createCanopyEventSubscription({
    families: [CORE_WORKSPACE_EVENT_FAMILY],
    snapshot: () => {
      broadOnOpen = true;
      return Promise.resolve(null);
    },
    handle: async (delivery) => {
      if (delivery.kind !== 'gap') {
        attempts = 0;
        try {
          options.onDelivered?.(delivery.event);
        } catch {
          // Observing never breaks delivery.
        }
      }
      const plan =
        delivery.kind === 'gap'
          ? CANOPY_WORKSPACE_BROAD_INVALIDATION
          : planCanopyWorkspaceInvalidation(delivery.event, (id) =>
              options.isOwnOrigin(id),
            );
      if (!plan) return;
      if (plan.broad) return cover(streamSignal);
      try {
        await enqueue(plan);
      } catch (error) {
        report(error);
        await cover(streamSignal);
      }
    },
  });

  const reattach = (connection: CanopyEventsConnection): void => {
    const { authorityId } = connection.identity;
    if (
      closed ||
      current !== connection ||
      connection.signal.aborted ||
      authorityId === null ||
      attempts >= maxAttempts
    )
      return;
    const state = subscription.state(authorityId);
    if (state === 'open' || state === 'rehydrating') return;
    attempts += 1;
    broadOnOpen = true;
    void subscription.attach(wrap(connection)).catch(report);
  };

  const wrap = (
    connection: CanopyEventsConnection,
  ): CanopyEventsConnection => ({
    get identity() {
      return connection.identity;
    },
    get manifest() {
      return connection.manifest;
    },
    get signal() {
      return connection.signal;
    },
    openStream: async (name, params, streamOptions) => {
      const signal = streamOptions?.signal;
      // The helper aborts a session's signal whenever it stops that session.
      if (signal && !watched.has(signal)) {
        watched.add(signal);
        signal.addEventListener(
          'abort',
          () => void Promise.resolve().then(() => reattach(connection)),
          { once: true },
        );
      }
      const handle = await connection.openStream(name, params, streamOptions);
      streamSignal = signal;
      // Open: everything before this point is covered by one re-read, which
      // applies (or is owed) before the stream delivers.
      if (broadOnOpen) {
        broadOnOpen = false;
        await cover(signal);
      }
      return handle;
    },
    instruction: (name, params, instructionOptions) =>
      connection.instruction(name, params, instructionOptions),
  });

  return {
    async attach(connection): Promise<void> {
      if (closed || unavailable.has(connection)) return;
      const { authorityId } = connection.identity;
      if (current === connection && authorityId !== null) {
        const state = subscription.state(authorityId);
        if (state === 'open' || state === 'rehydrating') return;
        // Its stream failed on this live connection; something may be lost.
        broadOnOpen = true;
      }
      current = connection;
      attempts = 0;
      try {
        await subscription.attach(wrap(connection));
      } catch (error) {
        if (
          toCanopyClientError(error).payload.kind === 'capability_unavailable'
        )
          unavailable.add(connection);
        else report(error);
      }
    },
    state: (authorityId) => subscription.state(authorityId),
    async close(): Promise<void> {
      closed = true;
      current = null;
      clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
      await subscription.close();
      await queue;
    },
  };
}

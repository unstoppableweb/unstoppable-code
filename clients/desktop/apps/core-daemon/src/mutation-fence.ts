import {
  CanopyOperationError,
  defineRuntimeModule,
  type RuntimeInstructionGuard,
  type RuntimeModule,
} from '@canopy/core-runtime';
import {
  readFilesystemScope,
  worktreeFenceKey,
  type FilesystemScopeResolver,
  type WorktreeRootLookup,
} from '@canopy/core-runtime/node';
import {
  CORE_MUTATION_FENCE_INSTRUCTION_DEFINITIONS,
  CanopyWorkspaceScopeSchema,
  MUTATION_FENCE_RESERVED_WORKSPACE_IDS,
  type CanopyWorkspaceScope,
  type CoreMutationFencePublishParams,
  type CoreMutationFencePublishResult,
  type CoreMutationFenceTarget,
  type MutationFenceHold,
} from '@canopy/protocol/canopy-core';
import {
  COWORK_WORKSPACE_FILE_ROOT_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/protocol/ui-labels';
import { asWriteScopeError } from './filesystem-writes';

/** Resolves one owner-named worktree to its fence key. */
export type MutationFenceKeyResolver = (
  target: CoreMutationFenceTarget,
) => Promise<string>;

/**
 * Who published: the owner's client instance, and the client lease the
 * publish was admitted under. A set belongs to that lease; only its end
 * stops enforcing it.
 */
export interface MutationFenceOwner {
  readonly clientInstanceId: string;
  readonly leaseId: string;
}

interface OwnerFences {
  /** The lease that published this set. */
  lease: string;
  epoch: number;
  /**
   * The last applied payload, so a resent publish is acknowledged again; or a
   * refused one, marked, so its identical retry is resolved again.
   */
  digest: string;
  /** Each fenced key with the holds on it; a key is fenced while any remain. */
  keys: Map<string, Set<MutationFenceHold>>;
  /** A snapshot arrived, so this owner's fences are complete. */
  published: boolean;
  /** Its owner lease is held; an ended owner's fences wait for a live one. */
  live: boolean;
}

export interface MutationFenceRegistry {
  /**
   * Applies an owner's publish once its targets resolve, all or nothing, and
   * acknowledges it only once every write admitted to a key it fences has
   * settled: an ack means nothing admitted is still running there.
   */
  publish(
    owner: MutationFenceOwner,
    params: CoreMutationFencePublishParams,
  ): Promise<CoreMutationFencePublishResult>;
  /**
   * A client lease ended. Only the set that lease published stops being
   * live; its fences stay until a live owner publishes. Any other lease,
   * including one with the same client instance, changes nothing.
   */
  ownerLeaseEnded(leaseId: string): void;
  /**
   * Admits a write to `key`, or refuses it while the key is fenced or no
   * owner has published. Call the returned release once the write settles.
   */
  admit(key: string): () => void;
}

function refusal(
  fence: 'held' | 'awaitingOwner',
  message: string,
): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    message,
    details: { fence },
    retry: { kind: 'never' },
  });
}

// Code-free, as the control plane's own lease refusals are.
function leaseEndedRefusal(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    message: 'The owner lease ended before this fence publish applied.',
    retry: { kind: 'never' },
  });
}

function publishRefusal(
  code: 'core.mutationFence.staleEpoch' | 'core.mutationFence.unresolved',
  message: string,
  cause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'failed_precondition',
      code,
      message,
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** Marks a refused publish's digest; a digest itself starts with '['. */
const REFUSED = 'refused:';

function digestOf(params: CoreMutationFencePublishParams): string {
  const sorted = (targets: readonly CoreMutationFenceTarget[]): string[] =>
    targets
      .map((target) =>
        JSON.stringify([target.workspaceId, target.worktreeId, target.hold]),
      )
      .sort();
  return JSON.stringify([
    params.kind,
    sorted(params.fenced),
    params.kind === 'change' ? sorted(params.released) : [],
  ]);
}

/** How long writes may wait for a live owner's set before it is reported. */
export const MUTATION_FENCE_AWAITING_OWNER_BOUND_MS = 30_000;

/**
 * The daemon's log line when Files writes have waited past the bound for the
 * owner, or once they resume: a level, a fixed message and the time waited,
 * never a path, fence key, lease or session id.
 */
export function awaitingOwnerLogLine(
  state: 'overdue' | 'recovered',
  waitedMs: number,
): string {
  const line =
    state === 'overdue'
      ? {
          level: 'warn',
          message: 'Files writes still wait for the desktop owner',
          waitedMs,
        }
      : {
          level: 'info',
          message: 'Files writes resumed after the desktop owner reported',
          waitedMs,
        };
  return `${JSON.stringify(line)}\n`;
}

export interface MutationFenceRegistryOptions {
  readonly awaitingOwnerBoundMs?: number;
  readonly now?: () => number;
  /**
   * A refused write found writes waiting for a live owner's set longer than
   * the bound: reported once per waiting spell, so a lost owner is visible.
   */
  readonly onAwaitingOwnerOverdue?: (waitedMs: number) => void;
  /** A live owner's set ended a waiting spell reported as overdue. */
  readonly onAwaitingOwnerRecovered?: (waitedMs: number) => void;
}

/**
 * The daemon's mutation fence registry (CAN-4730 E2-G). The desktop owner
 * publishes the worktrees its Split PR service locked; this registry refuses
 * filesystem writes to them for every caller. It refuses every write until a
 * live owner has published a snapshot, so a daemon start or an owner loss
 * never opens a window before the locks are known again. Each set belongs to
 * the client lease that published it: a new lease starts a new set, and only
 * that lease's end stops enforcing it. Epochs rise per lease, and publishes
 * from one owner apply in order.
 */
export function createMutationFenceRegistry(
  resolveKey: MutationFenceKeyResolver,
  options: MutationFenceRegistryOptions = {},
): MutationFenceRegistry {
  const now = options.now ?? Date.now;
  const boundMs =
    options.awaitingOwnerBoundMs ?? MUTATION_FENCE_AWAITING_OWNER_BOUND_MS;
  /** By owner client instance; each set records the lease that published it. */
  const owners = new Map<string, OwnerFences>();
  const queues = new Map<string, Promise<unknown>>();
  /**
   * Publishes accepted and not yet settled, by lease, and the leases among
   * them that ended meanwhile: a set resolved for an ended lease is never
   * installed, so an owner is not revived after its end.
   */
  const publishing = new Map<string, number>();
  const endedWhilePublishing = new Set<string>();
  /** Admitted writes still running, by key, and who waits for them to end. */
  const inFlight = new Map<string, number>();
  const drainWaiters = new Map<string, Set<() => void>>();

  const drained = async (keys: readonly string[]): Promise<void> => {
    await Promise.all(
      keys
        .filter((key) => (inFlight.get(key) ?? 0) > 0)
        .map(
          (key) =>
            new Promise<void>((resolve) => {
              let waiters = drainWaiters.get(key);
              if (!waiters) {
                waiters = new Set();
                drainWaiters.set(key, waiters);
              }
              waiters.add(resolve);
            }),
        ),
    );
  };

  /**
   * Writes wait while no live owner has a complete fence set, and while any
   * live owner's set is incomplete: one that never snapshotted, or whose
   * publish was refused, so a stale earlier set is never enforced instead.
   */
  const awaitingOwner = (): boolean => {
    const live = Array.from(owners.values()).filter((fences) => fences.live);
    return (
      !live.some((fences) => fences.published) ||
      live.some((fences) => !fences.published)
    );
  };
  // Writes wait from the start until a live owner's set arrives.
  let awaitingSince: number | null = now();
  let overdueReported = false;
  /** Opens or closes the waiting spell after any change to the sets. */
  const noteState = (): void => {
    const waiting = awaitingOwner();
    if (waiting && awaitingSince === null) {
      awaitingSince = now();
      overdueReported = false;
    } else if (!waiting && awaitingSince !== null) {
      if (overdueReported)
        options.onAwaitingOwnerRecovered?.(now() - awaitingSince);
      awaitingSince = null;
      overdueReported = false;
    }
  };

  const hasLiveSnapshot = (): boolean =>
    Array.from(owners.values()).some(
      (fences) => fences.live && fences.published,
    );

  const resolveAll = async (
    targets: readonly CoreMutationFenceTarget[],
  ): Promise<Array<{ key: string; hold: MutationFenceHold }>> => {
    const keys: Array<{ key: string; hold: MutationFenceHold }> = [];
    for (const target of targets) {
      try {
        keys.push({ key: await resolveKey(target), hold: target.hold });
      } catch (error) {
        throw publishRefusal(
          'core.mutationFence.unresolved',
          'A fenced worktree could not be resolved; nothing was applied.',
          error,
        );
      }
    }
    return keys;
  };

  const apply = async (
    { clientInstanceId: owner, leaseId: lease }: MutationFenceOwner,
    params: CoreMutationFencePublishParams,
  ): Promise<CoreMutationFencePublishResult> => {
    if (endedWhilePublishing.has(lease)) throw leaseEndedRefusal();
    const digest = digestOf(params);
    const current = owners.get(owner);
    // A set this lease published; another lease's set is never extended.
    const own = current?.live === true && current.lease === lease;
    if (own) {
      if (params.epoch < current.epoch)
        throw publishRefusal(
          'core.mutationFence.staleEpoch',
          'This fence publish is older than one already applied.',
        );
      if (params.epoch === current.epoch) {
        if (digest === current.digest)
          return { acknowledged: true, epoch: params.epoch };
        // Nothing was applied at a refused epoch: its identical retry is
        // resolved again below.
        if (current.digest !== REFUSED + digest)
          throw publishRefusal(
            'core.mutationFence.staleEpoch',
            'This fence epoch was already applied with other targets.',
          );
      }
    }
    let fenced: Awaited<ReturnType<typeof resolveAll>>;
    let released: Awaited<ReturnType<typeof resolveAll>>;
    try {
      fenced = await resolveAll(params.fenced);
      released =
        params.kind === 'change' ? await resolveAll(params.released) : [];
    } catch (error) {
      // The owner's set is no longer known: writes wait for its next snapshot.
      if (own) current.published = false;
      // A new lease's set is unknown too, and the set it was replacing is
      // not trusted in its place: writes wait for this lease's snapshot.
      else if (!endedWhilePublishing.has(lease))
        owners.set(owner, {
          lease,
          epoch: params.epoch,
          digest: REFUSED + digest,
          keys: new Map(),
          published: false,
          live: true,
        });
      noteState();
      throw error;
    }
    // The lease ended while its targets resolved: nothing is installed.
    if (endedWhilePublishing.has(lease)) throw leaseEndedRefusal();
    const keys = new Map<string, Set<MutationFenceHold>>(
      params.kind === 'snapshot' || !own
        ? []
        : Array.from(current.keys, ([key, holds]) => [key, new Set(holds)]),
    );
    for (const { key, hold } of fenced) {
      const holds = keys.get(key) ?? new Set<MutationFenceHold>();
      holds.add(hold);
      keys.set(key, holds);
    }
    for (const { key, hold } of released) {
      const holds = keys.get(key);
      holds?.delete(hold);
      if (holds?.size === 0) keys.delete(key);
    }
    // A change from a lease that has not snapshotted leaves the set
    // incomplete, so writes wait for that lease's snapshot.
    const published = params.kind === 'snapshot' || (own && current.published);
    owners.set(owner, {
      lease,
      epoch: params.epoch,
      digest,
      keys,
      published,
      live: true,
    });
    // A live owner's snapshot is the whole truth; ended owners' fences go.
    if (published)
      for (const [id, fences] of owners) if (!fences.live) owners.delete(id);
    noteState();
    // New writes to these keys are refused from here; the ack waits for the
    // ones admitted before.
    await drained(fenced.map(({ key }) => key));
    return { acknowledged: true, epoch: params.epoch };
  };

  return {
    publish: (owner, params) => {
      const { clientInstanceId, leaseId } = owner;
      publishing.set(leaseId, (publishing.get(leaseId) ?? 0) + 1);
      const previous = queues.get(clientInstanceId) ?? Promise.resolve();
      const next = previous
        .then(
          () => apply(owner, params),
          () => apply(owner, params),
        )
        .finally(() => {
          const remaining = (publishing.get(leaseId) ?? 1) - 1;
          if (remaining > 0) {
            publishing.set(leaseId, remaining);
            return;
          }
          publishing.delete(leaseId);
          endedWhilePublishing.delete(leaseId);
        });
      queues.set(
        clientInstanceId,
        next.catch(() => undefined),
      );
      return next;
    },
    ownerLeaseEnded: (leaseId) => {
      if (publishing.has(leaseId)) endedWhilePublishing.add(leaseId);
      for (const [owner, fences] of owners) {
        if (fences.lease !== leaseId || !fences.live) continue;
        fences.live = false;
        if (hasLiveSnapshot()) owners.delete(owner);
      }
      noteState();
    },
    admit: (key) => {
      noteState();
      if (awaitingOwner()) {
        const waitedMs = awaitingSince === null ? 0 : now() - awaitingSince;
        if (!overdueReported && waitedMs >= boundMs) {
          overdueReported = true;
          options.onAwaitingOwnerOverdue?.(waitedMs);
        }
        throw refusal(
          'awaitingOwner',
          "Couldn't change these files because the desktop app hasn't reported which worktrees are locked. Open the desktop app, then try again.",
        );
      }
      for (const fences of owners.values())
        if (fences.keys.has(key))
          throw refusal(
            'held',
            'This worktree is locked while a pull request is being split.',
          );
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        const remaining = (inFlight.get(key) ?? 1) - 1;
        if (remaining > 0) {
          inFlight.set(key, remaining);
          return;
        }
        inFlight.delete(key);
        const waiters = drainWaiters.get(key);
        drainWaiters.delete(key);
        waiters?.forEach((resolve) => resolve());
      };
    },
  };
}

/**
 * A worktree's directory, from the same trusted records and catalog the
 * Files reads use: a Git worktree's checkout home or a Cowork home. A scope
 * the host refuses is refused with the host's typed error.
 */
export function daemonWorktreeRootLookup(
  resolveScope: FilesystemScopeResolver,
): WorktreeRootLookup<string | undefined> {
  return async (workspaceId, worktreeRef) => {
    // A Cowork scope names no worktree; its home is the workspace folder.
    const scope: CanopyWorkspaceScope =
      worktreeRef === undefined
        ? { workspaceId }
        : { workspaceId, worktreeId: worktreeRef };
    try {
      const catalog = await readFilesystemScope(
        scope,
        await resolveScope(scope, 'roots'),
      );
      const home =
        catalog.byId.get(WORKSPACE_ROOT_REPO_ID) ??
        catalog.byId.get(workspaceId) ??
        catalog.byId.get(COWORK_WORKSPACE_FILE_ROOT_ID);
      return home?.absolutePath;
    } catch (error) {
      // The host's own scope refusal, so a write the fence cannot place is
      // refused exactly as the Files host and the desktop refuse it.
      if (error instanceof CanopyOperationError) throw asWriteScopeError(error);
      return undefined;
    }
  };
}

function scopeOf(params: unknown): CanopyWorkspaceScope | undefined {
  if (typeof params !== 'object' || params === null || !('scope' in params))
    return undefined;
  const parsed = CanopyWorkspaceScopeSchema.safeParse(params.scope);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The core's guard on every forwarded `worker.filesystem.*` instruction
 * (CAN-4730 E2-G): every one is a write, so a future one is fenced by
 * default. A reserved workspace is refused as the desktop refuses it; any
 * other write needs a resolvable worktree that no owner has fenced.
 */
export function createMutationFenceGuard(options: {
  readonly registry: MutationFenceRegistry;
  readonly lookupWorktreeRoot: WorktreeRootLookup<string | undefined>;
}): RuntimeInstructionGuard {
  return async (operation, params) => {
    if (!operation.startsWith('worker.filesystem.')) return;
    const scope = scopeOf(params);
    if (!scope?.workspaceId)
      throw new CanopyOperationError({
        kind: 'failed_precondition',
        message: 'This write names no worktree, so it is treated as fenced.',
        details: { fence: 'unresolved' },
        retry: { kind: 'never' },
      });
    if (MUTATION_FENCE_RESERVED_WORKSPACE_IDS.has(scope.workspaceId))
      throw new CanopyOperationError({
        kind: 'permission_denied',
        message: 'This scope is read-only.',
        retry: { kind: 'never' },
      });
    const key = await worktreeFenceKey(
      scope.workspaceId,
      scope.worktreeId,
      options.lookupWorktreeRoot,
    );
    return options.registry.admit(key);
  };
}

/**
 * Serves `core.mutationFence.publish` on the daemon's core. The dispatcher
 * checks its owner-only grant and principal before this handler runs, and
 * the host binds the operation to a live client lease: each publish belongs
 * to the client instance and the lease it was admitted under.
 */
export function createMutationFenceModule(
  registry: MutationFenceRegistry,
): RuntimeModule {
  return defineRuntimeModule({
    name: 'core.mutationFence',
    plane: 'core',
    definitions: {
      queries: {},
      instructions: CORE_MUTATION_FENCE_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: {},
      instructions: {
        'core.mutationFence.publish': (params, context) => {
          // The host binds this operation to a lease; refused without one.
          if (!context.lease)
            throw new CanopyOperationError({
              kind: 'not_found',
              message:
                'This operation requires a live client lease on this connection.',
              retry: { kind: 'never' },
            });
          return registry.publish(
            {
              clientInstanceId: context.caller.clientInstanceId,
              leaseId: context.lease.leaseId,
            },
            params,
          );
        },
      },
      streams: {},
    },
  });
}

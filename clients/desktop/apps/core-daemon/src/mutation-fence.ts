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
  CORE_MUTATION_FENCE_PUBLISH_SCHEMA_REVISION,
  CORE_MUTATION_FENCE_STREAM_DEFINITIONS,
  CanopyWorkspaceScopeSchema,
  MUTATION_FENCE_RESERVED_WORKSPACE_IDS,
  type CanopyWorkspaceScope,
  type CoreMutationFenceActivityItem,
  type CoreMutationFencePublishParams,
  type CoreMutationFencePublishResult,
  type CoreMutationFenceTarget,
  type CoreMutationFenceWrite,
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
  /**
   * The key each fenced target resolved to, so the release of an archive or
   * Auto Delete hold frees it after the worktree itself is gone.
   */
  placed: Map<string, string>;
  /** A snapshot arrived, so this owner's fences are complete. */
  published: boolean;
  /**
   * The schema revision of the publish that last applied to this set. Below
   * revision 2 the owner cannot check an Auto Delete ack against the writes
   * it has counted, so its set admits no write.
   */
  revision: number;
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
   * Admits a write to `key`, or refuses it while the key is fenced, no owner
   * has published, or a live owner holds no activity stream. An admitted
   * write to a worktree is reported on its owners' streams. Call the
   * returned release once the write settles.
   */
  admit(key: string, scope?: CanopyWorkspaceScope): () => void;
  /**
   * Opens an activity stream for an owner's client instance. `emit` returns
   * false once the stream has ended. Call the returned close when it ends.
   */
  openActivity(
    clientInstanceId: string,
    emit: (item: CoreMutationFenceActivityItem) => boolean,
  ): () => void;
}

/** At most one activity item per worktree and stream in this span. */
export const MUTATION_FENCE_ACTIVITY_INTERVAL_MS = 1_000;

interface ActivitySubscriber {
  readonly emit: (item: CoreMutationFenceActivityItem) => boolean;
  /** When each key was last reported on this stream. */
  readonly sent: Map<string, number>;
}

/** The refusal each hold gives, worded as the desktop words that hold. */
const HELD_MESSAGES: Record<MutationFenceHold, string> = {
  autoDelete:
    'This workspace target is being automatically deleted. Retry after deletion finishes.',
  archive: 'This worktree is being archived. Retry after archiving finishes.',
  splitLock: 'This worktree is locked while a pull request is being split.',
};

/** Several holds on one worktree: the refusal names Auto Delete, then archive, then a split lock. */
function heldBy(holds: ReadonlySet<MutationFenceHold>): MutationFenceHold {
  if (holds.has('autoDelete')) return 'autoDelete';
  if (holds.has('archive')) return 'archive';
  return 'splitLock';
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
  code:
    | 'core.mutationFence.staleEpoch'
    | 'core.mutationFence.unresolved'
    | 'core.mutationFence.busy',
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

const targetId = (target: CoreMutationFenceTarget): string =>
  `${target.workspaceId}\0${target.worktreeId}\0${target.hold}`;

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
    params.revision ?? 1,
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
  /** When the last write to each key was admitted, since this daemon started. */
  const lastAdmitted = new Map<string, number>();
  /** Open activity streams, by the owner client instance that opened them. */
  const subscribers = new Map<string, Set<ActivitySubscriber>>();

  const writesFor = (
    targets: ReadonlyArray<{ target: CoreMutationFenceTarget; key: string }>,
  ): CoreMutationFenceWrite[] =>
    targets.flatMap(({ target, key }) => {
      const at = lastAdmitted.get(key);
      return target.hold === 'autoDelete' && at !== undefined
        ? [
            {
              workspaceId: target.workspaceId,
              worktreeId: target.worktreeId,
              at,
            },
          ]
        : [];
    });
  /** `writes` goes only to a revision 2 publisher (protocol rule 5). */
  const acknowledgement = (
    params: CoreMutationFencePublishParams,
    writes: CoreMutationFenceWrite[],
  ): CoreMutationFencePublishResult =>
    params.revision === CORE_MUTATION_FENCE_PUBLISH_SCHEMA_REVISION &&
    writes.length > 0
      ? { acknowledged: true, epoch: params.epoch, writes }
      : { acknowledged: true, epoch: params.epoch };

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
   * They wait too while a live owner holds no activity stream, or published
   * below revision 2, so no write goes unreported or unchecked by the owner
   * that would delete its worktree.
   */
  const awaitingOwner = (): boolean => {
    const live = Array.from(owners).filter(([, fences]) => fences.live);
    return (
      !live.some(([, fences]) => fences.published) ||
      live.some(
        ([owner, fences]) =>
          !fences.published ||
          fences.revision < CORE_MUTATION_FENCE_PUBLISH_SCHEMA_REVISION ||
          (subscribers.get(owner)?.size ?? 0) === 0,
      )
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
    placed?: ReadonlyMap<string, string>,
  ): Promise<Array<{ id: string; key: string; hold: MutationFenceHold }>> => {
    const keys: Array<{ id: string; key: string; hold: MutationFenceHold }> =
      [];
    for (const target of targets) {
      const id = targetId(target);
      try {
        keys.push({ id, key: await resolveKey(target), hold: target.hold });
      } catch (error) {
        // An archived or deleted worktree whose root no longer resolves has
        // nothing to fence: write admission resolves the same root and
        // refuses it. Its release frees the key it was fenced under. A split
        // lock still needs its worktree.
        if (target.hold !== 'splitLock') {
          const key = placed?.get(id);
          if (key !== undefined) keys.push({ id, key, hold: target.hold });
          continue;
        }
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
          return acknowledgement(
            params,
            writesFor(
              params.fenced.flatMap((target) => {
                const key = current.placed.get(targetId(target));
                return key === undefined ? [] : [{ target, key }];
              }),
            ),
          );
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
        params.kind === 'change'
          ? await resolveAll(params.released, own ? current.placed : undefined)
          : [];
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
          placed: new Map(),
          published: false,
          revision: params.revision ?? 1,
          live: true,
        });
      noteState();
      throw error;
    }
    // The lease ended while its targets resolved: nothing is installed.
    if (endedWhilePublishing.has(lease)) throw leaseEndedRefusal();
    // A new Auto Delete hold over a write still running is refused, as the
    // desktop refuses its lease while a write holds its reservation. The
    // set stays as it was; only this epoch is spent.
    if (
      own &&
      params.kind === 'change' &&
      fenced.some(
        ({ key, hold }) =>
          hold === 'autoDelete' &&
          current.keys.get(key)?.has('autoDelete') !== true &&
          (inFlight.get(key) ?? 0) > 0,
      )
    ) {
      current.epoch = params.epoch;
      current.digest = REFUSED + digest;
      throw publishRefusal(
        'core.mutationFence.busy',
        'A file change in this worktree is still running, so Auto Delete was not started.',
      );
    }
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
    const placed = new Map<string, string>(
      params.kind === 'snapshot' || !own ? [] : current.placed,
    );
    for (const { id, key } of fenced) placed.set(id, key);
    for (const { id } of released) placed.delete(id);
    // A change from a lease that has not snapshotted leaves the set
    // incomplete, so writes wait for that lease's snapshot.
    const published = params.kind === 'snapshot' || (own && current.published);
    owners.set(owner, {
      lease,
      epoch: params.epoch,
      digest,
      keys,
      placed,
      published,
      revision: params.revision ?? 1,
      live: true,
    });
    // A live owner's snapshot is the whole truth; ended owners' fences go.
    if (published)
      for (const [id, fences] of owners) if (!fences.live) owners.delete(id);
    noteState();
    // New writes to these keys are refused from here; the ack waits for the
    // ones admitted before.
    await drained(fenced.map(({ key }) => key));
    const named = new Map(
      params.fenced.map((target) => [targetId(target), target]),
    );
    return acknowledgement(
      params,
      writesFor(
        fenced.flatMap(({ id, key }) => {
          const target = named.get(id);
          return target ? [{ target, key }] : [];
        }),
      ),
    );
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
    openActivity: (clientInstanceId, emit) => {
      const subscriber: ActivitySubscriber = { emit, sent: new Map() };
      let streams = subscribers.get(clientInstanceId);
      if (!streams) {
        streams = new Set();
        subscribers.set(clientInstanceId, streams);
      }
      streams.add(subscriber);
      noteState();
      return (): void => {
        const open = subscribers.get(clientInstanceId);
        if (!open?.delete(subscriber)) return;
        if (open.size === 0) subscribers.delete(clientInstanceId);
        noteState();
      };
    },
    admit: (key, scope) => {
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
      const holds = new Set<MutationFenceHold>();
      for (const fences of owners.values())
        for (const hold of fences.keys.get(key) ?? []) holds.add(hold);
      if (holds.size > 0) throw refusal('held', HELD_MESSAGES[heldBy(holds)]);
      const at = now();
      lastAdmitted.set(key, at);
      // Only a worktree can be deleted for inactivity; a workspace-wide
      // write names none, so it has nothing to report.
      const worktreeId = scope?.worktreeId;
      if (scope?.workspaceId !== undefined && worktreeId !== undefined)
        for (const [owner, fences] of owners) {
          if (!fences.live) continue;
          for (const subscriber of subscribers.get(owner) ?? []) {
            const last = subscriber.sent.get(key);
            if (
              last !== undefined &&
              at - last < MUTATION_FENCE_ACTIVITY_INTERVAL_MS
            )
              continue;
            subscriber.sent.set(key, at);
            subscriber.emit({ workspaceId: scope.workspaceId, worktreeId, at });
          }
        }
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
    return options.registry.admit(key, scope);
  };
}

/**
 * Serves `core.mutationFence.publish` and `core.mutationFence.activity` on
 * the daemon's core. The dispatcher checks their owner-only grant and
 * principal before these handlers run, and the host binds the publish to a
 * live client lease: each publish belongs to the client instance and the
 * lease it was admitted under. An activity stream belongs to the client
 * instance that opened it, and enables writes only for that instance's live
 * fence set.
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
      streams: CORE_MUTATION_FENCE_STREAM_DEFINITIONS,
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
      streams: {
        'core.mutationFence.activity': (_params, context, sink) => {
          let close = (): void => undefined;
          close = registry.openActivity(
            context.caller.clientInstanceId,
            (item) => {
              if (sink.emit(item) !== null) return true;
              close();
              return false;
            },
          );
          return Promise.resolve(close);
        },
      },
    },
  });
}

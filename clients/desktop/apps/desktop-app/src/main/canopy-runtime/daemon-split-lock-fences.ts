import type {
  CoreMutationFencePublishParams,
  CoreMutationFencePublishResult,
  CoreMutationFenceTarget,
} from '@canopy/protocol/canopy-core';
import {
  getSplitLockedWorktrees,
  onSplitLockChange,
  setSplitLockFenceConfirmer,
  type HeldSplitLock,
} from '../services/split-lock-service';
import {
  daemonOwnerLifetime,
  getDaemonOwnerSession,
  isDaemonOwnerUnavailable,
  isDaemonPipelineOwnerPossible,
  type ElectronDaemonOwnerClient,
} from './electron-daemon-owner';
import type { ElectronDaemonSession } from './electron-daemon-connection';
import {
  setWorkspaceTargetHoldConfirmer,
  type WorkspaceTargetHold,
} from '../lib/workspace-target-exclusion';

/**
 * How long a Split PR start waits for the daemon to confirm its fence. The
 * measured publish round trip is a few milliseconds (p95 7.5 ms under load),
 * so this bound only trips when the daemon is stuck or gone.
 */
export const MUTATION_FENCE_ACK_TIMEOUT_MS = 2_000;

const PUBLISH = 'core.mutationFence.publish';
const REGISTRATION = 'split-lock-fences';

type PublishBody =
  | { kind: 'snapshot'; fenced: CoreMutationFenceTarget[] }
  | {
      kind: 'change';
      fenced: CoreMutationFenceTarget[];
      released: CoreMutationFenceTarget[];
    };

/** The slice of the owner client the publisher uses. */
export interface FenceOwnerClient {
  instruction(
    name: typeof PUBLISH,
    params: CoreMutationFencePublishParams,
  ): Promise<CoreMutationFencePublishResult>;
}

/** The slice of an owner session the publisher uses. */
export interface FenceOwnerSession {
  /** Aborts once the session ends, as when its daemon stops or restarts. */
  readonly signal: AbortSignal;
  readonly client: FenceOwnerClient;
  readonly lease: {
    register(
      key: string,
      issue: (lease: unknown, client: FenceOwnerClient) => void | Promise<void>,
    ): () => void;
  };
}

export interface SplitLockFencePublisherOptions {
  /** Whether this app spawned the running daemon, so it may be its owner. */
  ownerPossible(): boolean;
  /** Opens or reuses the owner session. */
  ownerSession(): Promise<FenceOwnerSession>;
  /** The refusal that means this app is not the daemon's owner after all. */
  isOwnerUnavailable(error: unknown): boolean;
  /** The split locks held now. */
  locks(): HeldSplitLock[];
  ackTimeoutMs?: number;
  /** A release that could not be delivered; the daemon keeps that fence. */
  onReleaseFailed?(error: unknown): void;
  /** Backoff while no owner session can be had: first and longest wait. */
  retryInitialMs?: number;
  retryMaxMs?: number;
  /** How often a live owner session is looked at again. */
  recheckMs?: number;
}

export interface SplitLockFencePublisher {
  /** Resolves once the daemon fences `held`, or at once with no owner. */
  confirmLocked(held: HeldSplitLock): Promise<void>;
  /** Publishes a release; never throws. */
  released(held: HeldSplitLock): void;
  /**
   * Resolves once the daemon fences `held` with an archive or Auto Delete
   * hold, or at once with no owner. Each confirm needs a matching release.
   */
  confirmHold(held: HeldSplitLock, hold: WorkspaceTargetHold): Promise<void>;
  /** Releases one confirm; the last one publishes the release. Never throws. */
  releaseHold(held: HeldSplitLock, hold: WorkspaceTargetHold): void;
  /** Publishes a snapshot on every new lease of `session`. */
  observe(session: FenceOwnerSession): void;
  /**
   * Observes the owner session from now on, and each one that replaces it
   * after a daemon restart, with no lock activity or user action, so the
   * daemon never waits for a snapshot it could have. Resolves once `stop`
   * aborts.
   */
  keepObserved(stop: AbortSignal): Promise<void>;
}

/** Resolves after `ms`, or sooner once `signal` aborts; at once if it has. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function target(
  held: HeldSplitLock,
  hold: CoreMutationFenceTarget['hold'] = 'splitLock',
): CoreMutationFenceTarget {
  return {
    workspaceId: held.workspaceId,
    worktreeId: held.worktreeId,
    hold,
  };
}

const holdKey = (fenced: CoreMutationFenceTarget): string =>
  `${fenced.workspaceId}\0${fenced.worktreeId}\0${fenced.hold}`;

function withTimeout<T>(run: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    run,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('The fence was not confirmed in time.')),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Electron main's split-lock fences on the daemon it owns (CAN-4730 E2-G):
 * a snapshot of every held lock on each new owner lease, then each lock and
 * release as it happens, in order and with rising epochs. Only an app that
 * spawned the daemon publishes; otherwise nothing is sent and the split lock
 * behaves as before.
 */
export function createSplitLockFencePublisher(
  options: SplitLockFencePublisherOptions,
): SplitLockFencePublisher {
  const ackTimeoutMs = options.ackTimeoutMs ?? MUTATION_FENCE_ACK_TIMEOUT_MS;
  let epoch = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const observed = new WeakSet<object>();
  // Archive and Auto Delete holds, counted: archives of one worktree nest.
  const holds = new Map<
    string,
    { target: CoreMutationFenceTarget; count: number }
  >();
  const fencedNow = (): CoreMutationFenceTarget[] => [
    ...options.locks().map((held) => target(held)),
    ...Array.from(holds.values(), (entry) => entry.target),
  ];

  const send = (
    client: FenceOwnerClient,
    body: PublishBody,
  ): Promise<CoreMutationFencePublishResult> => {
    const run = queue.then(() => {
      epoch += 1;
      return client.instruction(PUBLISH, { ...body, epoch });
    });
    queue = run.catch(() => undefined);
    // A refused change leaves the daemon waiting for a whole set: send one
    // snapshot of the locks held. A refused snapshot is not resent.
    if (body.kind === 'change')
      run.catch(() => {
        send(client, {
          kind: 'snapshot',
          fenced: fencedNow(),
        }).catch(() => undefined);
      });
    return run;
  };

  const observe = (session: FenceOwnerSession): void => {
    if (observed.has(session)) return;
    observed.add(session);
    session.lease.register(REGISTRATION, async (_lease, client) => {
      await send(client, {
        kind: 'snapshot',
        fenced: fencedNow(),
      });
    });
  };

  const ownerSession = async (): Promise<FenceOwnerSession | undefined> => {
    if (!options.ownerPossible()) return undefined;
    try {
      const session = await options.ownerSession();
      observe(session);
      return session;
    } catch (error) {
      if (options.isOwnerUnavailable(error)) return undefined;
      throw error;
    }
  };

  const keepObserved = async (stop: AbortSignal): Promise<void> => {
    const initialMs = options.retryInitialMs ?? 1_000;
    const maxMs = options.retryMaxMs ?? 30_000;
    const recheckMs = options.recheckMs ?? 5_000;
    let delayMs = initialMs;
    while (!stop.aborted) {
      const session = await ownerSession().catch(() => undefined);
      // Quit while the request was out: start no wait at all.
      if (stop.aborted) break;
      if (session && !session.signal.aborted) {
        delayMs = initialMs;
        // A session whose lease gave up stays open until the next request
        // replaces it, so look again now and then as well as when it ends.
        // A live session is reused, so its next look sends nothing.
        await pause(recheckMs, AbortSignal.any([session.signal, stop]));
        continue;
      }
      await pause(delayMs, stop);
      delayMs = Math.min(delayMs * 2, maxMs);
    }
  };

  const fence = (fenced: CoreMutationFenceTarget): Promise<void> =>
    withTimeout(
      (async (): Promise<void> => {
        const session = await ownerSession();
        if (!session) return;
        await send(session.client, {
          kind: 'change',
          fenced: [fenced],
          released: [],
        });
      })(),
      ackTimeoutMs,
    );
  const release = (released: CoreMutationFenceTarget): void => {
    void (async (): Promise<void> => {
      const session = await ownerSession();
      if (!session) return;
      await send(session.client, {
        kind: 'change',
        fenced: [],
        released: [released],
      });
    })().catch((error: unknown) => options.onReleaseFailed?.(error));
  };

  return {
    confirmLocked: (held) => fence(target(held)),
    released: (held): void => release(target(held)),
    confirmHold: (held, hold) => {
      const fenced = target(held, hold);
      const entry = holds.get(holdKey(fenced));
      if (entry) entry.count += 1;
      else holds.set(holdKey(fenced), { target: fenced, count: 1 });
      return fence(fenced);
    },
    releaseHold: (held, hold): void => {
      const fenced = target(held, hold);
      const entry = holds.get(holdKey(fenced));
      if (!entry) return;
      entry.count -= 1;
      if (entry.count > 0) return;
      holds.delete(holdKey(fenced));
      release(fenced);
    },
    observe,
    keepObserved,
  };
}

/**
 * Once the owner is disposed for good, no new lock can be fenced: every
 * acquire is refused, and the refusal is never replaced in this process.
 */
function refuseLocksAfterOwner(): void {
  setSplitLockFenceConfirmer(() =>
    Promise.reject(new Error('The daemon owner has been disposed.')),
  );
  setWorkspaceTargetHoldConfirmer(() =>
    Promise.reject(new Error('The daemon owner has been disposed.')),
  );
}

/** Confirms each new split lock through `publisher` and publishes each release. */
export function connectSplitLockFences(
  publisher: SplitLockFencePublisher,
): () => void {
  if (daemonOwnerLifetime().aborted) {
    refuseLocksAfterOwner();
    return (): void => undefined;
  }
  const stopConfirming = setSplitLockFenceConfirmer((held) =>
    publisher.confirmLocked(held),
  );
  const stopReleasing = onSplitLockChange((event) => {
    if (!event.locked) publisher.released(event);
  });
  const stopHolding = setWorkspaceTargetHoldConfirmer(
    async (projectId, worktreeId, hold) => {
      const held = { workspaceId: projectId, worktreeId };
      try {
        await publisher.confirmHold(held, hold);
      } catch (error) {
        // A late fence still lands; its release is queued behind it.
        publisher.releaseHold(held, hold);
        throw error;
      }
      return (): void => publisher.releaseHold(held, hold);
    },
  );
  return (): void => {
    stopHolding();
    stopReleasing();
    stopConfirming();
  };
}

/** The owner session as the publisher sees it. */
export function ownerFenceSession(
  session: ElectronDaemonSession<ElectronDaemonOwnerClient>,
): FenceOwnerSession {
  return {
    signal: session.signal,
    // The live client: lease recovery replaces it within one session.
    get client(): FenceOwnerClient {
      return session.client;
    },
    lease: {
      register: (key, issue) =>
        session.lease.register(key, (lease, client) => issue(lease, client)),
    },
  };
}

/**
 * Main startup: fence the daemon this app owns for every split lock. The
 * watch and its listeners stop when the owner is disposed at quit, alongside
 * the owner session itself, and a lock taken after that is refused.
 */
export function installSplitLockFencePublisher(): () => void {
  if (daemonOwnerLifetime().aborted) {
    refuseLocksAfterOwner();
    return (): void => undefined;
  }
  const sessions = new WeakMap<object, FenceOwnerSession>();
  const adapt = (
    session: ElectronDaemonSession<ElectronDaemonOwnerClient>,
  ): FenceOwnerSession => {
    let adapted = sessions.get(session);
    if (!adapted) {
      adapted = ownerFenceSession(session);
      sessions.set(session, adapted);
    }
    return adapted;
  };
  const publisher = createSplitLockFencePublisher({
    ownerPossible: isDaemonPipelineOwnerPossible,
    ownerSession: async () => adapt(await getDaemonOwnerSession()),
    isOwnerUnavailable: isDaemonOwnerUnavailable,
    locks: getSplitLockedWorktrees,
  });
  const stop = new AbortController();
  const ownerLifetime = daemonOwnerLifetime();
  const lifetime = AbortSignal.any([stop.signal, ownerLifetime]);
  void publisher.keepObserved(lifetime);
  const disconnect = connectSplitLockFences(publisher);
  lifetime.addEventListener(
    'abort',
    () => {
      disconnect();
      if (ownerLifetime.aborted) refuseLocksAfterOwner();
      // Stopped first: a later owner disposal still refuses new locks.
      else
        ownerLifetime.addEventListener('abort', refuseLocksAfterOwner, {
          once: true,
        });
    },
    { once: true },
  );
  return (): void => stop.abort();
}

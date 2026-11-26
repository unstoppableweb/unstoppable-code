import { AsyncLocalStorage } from 'node:async_hooks';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { BackgroundServiceUnreachableReason } from '@canopy/desktop-shared/lib/background-service-status';
import type {
  DaemonGitQueryClient,
  DaemonGitRoute,
  DaemonGitRouteOptions,
} from './daemon-git-route';
import { daemonUnreachableReason } from './electron-daemon-connection';
import type { DaemonRouteReason } from './daemon-route-telemetry';

/**
 * The shared background-service rule (CAN-5541) for daemon Git reads
 * (CAN-4729), one layer outside the route: a selected read falls back to the
 * in-process reader once, and only when the daemon was never reached and no
 * result arrived. Anything a reached daemon answers stays typed.
 *
 * The route is a black box. This layer supplies its repository, host and
 * connection inputs and watches them per request, so it knows whether the
 * request was selected, whether contact failed before the daemon answered,
 * and whether a result arrived, without reading the route's errors.
 */

export interface DaemonGitReachability {
  /** Selected reads skip the daemon and read in-process, with no notice. */
  readonly isLatched: () => boolean;
  /** Called before the in-process reader answers a selected read instead. */
  readonly noteFallback: (reason: BackgroundServiceUnreachableReason) => void;
}

/** The route inputs this layer watches. */
export interface DaemonGitRouteInputs {
  readonly hostContext: DaemonGitRouteOptions['hostContext'];
  readonly connections: DaemonGitRouteOptions['connections'];
  readonly repositoryPath: NonNullable<DaemonGitRouteOptions['repositoryPath']>;
}

export interface ReachableDaemonGitRouteOptions {
  readonly inputs: DaemonGitRouteInputs;
  readonly reachability: DaemonGitReachability;
  readonly createRoute: (inputs: DaemonGitRouteInputs) => DaemonGitRoute;
  readonly record: (reason: DaemonRouteReason<'git_reads'>) => void;
}

interface Attempt {
  /** The route took its first daemon step: it selected the daemon. */
  selected: boolean;
  bypassed: boolean;
  /** The route asked for the host, its first step toward the daemon. */
  contacting: boolean;
  notReached: BackgroundServiceUnreachableReason | null;
  client: { readonly signal: AbortSignal } | null;
  /** A reached daemon answered with a refusal. */
  answered: boolean;
  result: boolean;
  fellBack: boolean;
}

class DaemonGitBypass extends Error {
  constructor() {
    super(
      'Git reads run in-process while the background service is unavailable.',
    );
    this.name = 'DaemonGitBypass';
  }
}

function notReachedReason(
  attempt: Attempt,
): BackgroundServiceUnreachableReason | null {
  if (attempt.result || attempt.answered) return null;
  if (attempt.notReached) return attempt.notReached;
  return attempt.client?.signal.aborted ? 'connection_lost' : null;
}

/** The caller, its document or a deadline ended it: never a fallback. */
function endedByCaller(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError &&
    (error.payload.kind === 'cancelled' ||
      error.payload.kind === 'deadline_exceeded')
  );
}

function fallbackRecord(
  reason: BackgroundServiceUnreachableReason,
): DaemonRouteReason<'git_reads'> {
  return reason === 'host_unavailable' ? 'host_unavailable' : 'unreachable';
}

export function createReachableDaemonGitRoute(
  options: ReachableDaemonGitRouteOptions,
): DaemonGitRoute {
  const { inputs, reachability, record } = options;
  const attempts = new AsyncLocalStorage<Attempt>();

  /** The latch is read once, at a request's first daemon step. */
  const select = (attempt: Attempt): void => {
    if (attempt.selected) return;
    attempt.selected = true;
    if (!reachability.isLatched()) return;
    attempt.bypassed = true;
    throw new DaemonGitBypass();
  };

  const watched: DaemonGitRouteInputs = {
    // Branch lists resolve a repository first.
    repositoryPath: async (params) => {
      const attempt = attempts.getStore();
      if (attempt) select(attempt);
      return inputs.repositoryPath(params);
    },
    // Health checks start here.
    hostContext: async () => {
      const attempt = attempts.getStore();
      if (attempt) {
        select(attempt);
        attempt.contacting = true;
      }
      try {
        return await inputs.hostContext();
      } catch (error) {
        if (attempt) attempt.notReached ??= 'host_unavailable';
        throw error;
      }
    },
    connections: () => {
      const service = inputs.connections();
      return {
        get: async (caller, owner) => {
          const attempt = attempts.getStore();
          let client: DaemonGitQueryClient;
          try {
            // A reconnecting session's getter throws while its lease is
            // replaced: as unreachable as a failed attach.
            ({ client } = await service.get(caller, owner));
          } catch (error) {
            const reason = daemonUnreachableReason(error);
            if (attempt && reason) attempt.notReached ??= reason;
            throw error;
          }
          if (!attempt) return { client };
          attempt.client = client;
          return {
            client: {
              signal: client.signal,
              query: async (name, params, queryOptions) => {
                try {
                  const result = await client.query(name, params, queryOptions);
                  attempt.result = true;
                  return result;
                } catch (error) {
                  if (!client.signal.aborted) attempt.answered = true;
                  throw error;
                }
              },
            },
          };
        },
      };
    },
  };
  const route = options.createRoute(watched);

  const fallBack = (
    attempt: Attempt,
    reason: BackgroundServiceUnreachableReason,
  ): void => {
    attempt.fellBack = true;
    reachability.noteFallback(reason);
    record(fallbackRecord(reason));
  };

  const guarded = <T>(
    read: (routedDirect: () => Promise<T>) => Promise<T>,
    direct: () => Promise<T>,
  ): Promise<T> => {
    const attempt: Attempt = {
      selected: false,
      bypassed: false,
      contacting: false,
      notReached: null,
      client: null,
      answered: false,
      result: false,
      fellBack: false,
    };
    // A route that reads in-process itself after trying the daemon (a
    // pre-contact budget, CAN-6803) counts as not reached here, once.
    const routedDirect = (): Promise<T> => {
      if (attempt.contacting && !attempt.result && !attempt.fellBack)
        fallBack(attempt, attempt.notReached ?? 'connect_timeout');
      return direct();
    };
    return attempts.run(attempt, async () => {
      try {
        const result = await read(routedDirect);
        if (attempt.result) record('served');
        return result;
      } catch (error) {
        // Unselected, or the in-process read the route chose already failed.
        if (!attempt.selected || attempt.fellBack) throw error;
        if (attempt.bypassed) {
          record('latched');
          return direct();
        }
        const reason = notReachedReason(attempt);
        // A setup stage's own timeout is tagged unreachable; the request's
        // deadline or cancel reaches here untagged.
        if (
          reason === null ||
          (endedByCaller(error) && attempt.notReached === null)
        ) {
          record('refused');
          throw error;
        }
        fallBack(attempt, reason);
        return direct();
      }
    });
  };

  return {
    branchList: (params, context, request, direct) =>
      guarded(
        (routedDirect) =>
          route.branchList(params, context, request, routedDirect),
        direct,
      ),
    worktreeHealth: (params, context, request, direct, settle) =>
      guarded(
        (routedDirect) =>
          route.worktreeHealth(params, context, request, routedDirect, settle),
        direct,
      ),
    dispose: () => route.dispose(),
  };
}

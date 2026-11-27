import { AsyncLocalStorage } from 'node:async_hooks';
import { CanopyClientError } from '@canopy/core-client';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { BackgroundServiceUnreachableReason } from '@canopy/desktop-shared/lib/background-service-status';
import {
  CHANGED_FILES,
  untilAborted,
  type DaemonGitQueryClient,
  type DaemonGitRoute,
  type DaemonGitRouteOptions,
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
 *
 * Two exceptions read the daemon's own refusal of a changed-files diff: an
 * older daemon build that cannot serve its revision, and a missing object
 * the daemon will not fetch, which main lists once in process as Git there
 * fetches it (CAN-4729).
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
  /** This app's build, compared with the attached daemon's `buildVersion`; unknown never skews. */
  readonly appVersion: string | undefined;
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
  /** The daemon instance that cannot serve this build's diff revision. */
  skewed: string | null;
  /** The daemon would not fetch an object this diff needs. */
  objectMissing: boolean;
  /** A daemon read ended with no exit code: its Git host's request deadline. */
  readTimedOut: boolean;
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

/** One daemon instance: a restarted daemon has a new epoch. */
function instanceOf(client: DaemonGitQueryClient): string | null {
  return client.identity
    ? `${client.identity.runtimeId}\0${client.identity.daemonEpoch}`
    : null;
}

function payloadOf(
  error: unknown,
): { readonly kind: string; readonly code?: string } | null {
  return error instanceof CanopyClientError ||
    error instanceof CanopyOperationError
    ? error.payload
    : null;
}

function codeOf(error: unknown): string | undefined {
  return payloadOf(error)?.code;
}

/**
 * An older build rejects revision 3 at schema validation (`invalid_argument`)
 * or as unserved (`capability_unavailable`); the same build never does.
 */
function refusesThisRevision(
  client: DaemonGitQueryClient,
  error: unknown,
  appVersion: string | undefined,
): boolean {
  const kind = payloadOf(error)?.kind;
  return (
    (kind === 'invalid_argument' || kind === 'capability_unavailable') &&
    appVersion !== undefined &&
    client.identity !== undefined &&
    // shortcut: builds with the same CANOPY_VERSION (dev builds) still match; compare a build id once CANOPY_BUILD_ID is set and carried in the handshake
    client.identity.buildVersion !== appVersion
  );
}

/** A revision-3 answer holding a read that ended with no exit code. */
function hasUnfinishedRead(result: unknown): boolean {
  const reads: unknown = Reflect.get(Object(result), 'reads');
  return ['nameStatus', 'numstat', 'untracked', 'unmerged'].some((key) => {
    const read: unknown = Reflect.get(Object(reads), key);
    return (
      Reflect.get(Object(read), 'ok') === false &&
      Reflect.get(Object(read), 'exitCode') === null
    );
  });
}

function fallbackRecord(
  reason: BackgroundServiceUnreachableReason,
): DaemonRouteReason<'git_reads'> {
  return reason === 'host_unavailable' ? 'host_unavailable' : 'unreachable';
}

export function createReachableDaemonGitRoute(
  options: ReachableDaemonGitRouteOptions,
): DaemonGitRoute {
  const { inputs, reachability, record, appVersion } = options;
  const attempts = new AsyncLocalStorage<Attempt>();
  // An older daemon build refusing revision 3 lists diffs in process until it restarts (electron-daemon-access.ts:480).
  const skewedInstances = new Set<string>();

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
              ...(client.identity && { identity: client.identity }),
              query: async (name, params, queryOptions) => {
                const instance =
                  name === 'worker.git.diff.get' ? instanceOf(client) : null;
                if (instance !== null && skewedInstances.has(instance)) {
                  attempt.skewed = instance;
                  throw new DaemonGitBypass();
                }
                try {
                  const result = await client.query(name, params, queryOptions);
                  if (
                    name === 'worker.git.diff.get' &&
                    hasUnfinishedRead(result)
                  ) {
                    attempt.readTimedOut = true;
                    throw new DaemonGitBypass();
                  }
                  attempt.result = true;
                  return result;
                } catch (error) {
                  if (!client.signal.aborted) attempt.answered = true;
                  if (
                    instance !== null &&
                    refusesThisRevision(client, error, appVersion)
                  )
                    attempt.skewed = instance;
                  if (
                    name === 'worker.git.diff.get' &&
                    codeOf(error) === 'worker.git.diff.objectMissing'
                  )
                    attempt.objectMissing = true;
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
    // The in-process read after the daemon was tried.
    fallback: () => Promise<T> = direct,
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
      skewed: null,
      objectMissing: false,
      readTimedOut: false,
    };
    // A route that reads in-process itself after trying the daemon (a
    // pre-contact budget, CAN-6803) counts as not reached here, once.
    const routedDirect = (): Promise<T> => {
      if (!attempt.contacting || attempt.result || attempt.fellBack)
        return direct();
      fallBack(attempt, attempt.notReached ?? 'connect_timeout');
      return fallback();
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
          return fallback();
        }
        if (attempt.skewed !== null) {
          skewedInstances.add(attempt.skewed);
          attempt.fellBack = true;
          record('version_skew');
          return fallback();
        }
        if (attempt.objectMissing) {
          attempt.fellBack = true;
          record('object_missing');
          return fallback();
        }
        if (attempt.readTimedOut) {
          attempt.fellBack = true;
          record('read_timed_out');
          return fallback();
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
        return fallback();
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
    changeSet: (params, repoPath, context, request, direct) => {
      const owner = request.owner ?? route.ownerFor(request.sender);
      // After a refusal the in-process read is bounded by navigation, not the
      // deadline, as the unrouted read is: a slow large repository still lists.
      const ended = AbortSignal.any([
        owner,
        ...(context.signal ? [context.signal] : []),
      ]);
      return guarded(
        (routedDirect) =>
          route.changeSet(
            params,
            repoPath,
            context,
            { ...request, owner },
            routedDirect,
          ),
        direct,
        () => untilAborted(direct(), ended, CHANGED_FILES),
      );
    },
    ownerFor: (sender) => route.ownerFor(sender),
    dispose: () => route.dispose(),
  };
}

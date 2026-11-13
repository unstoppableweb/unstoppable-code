import type {
  CANOPY_STREAM_DEFINITIONS,
  CanopyInstructionHandlerMap,
  CanopyQueryHandlerMap,
  CanopyStreamCursor,
  UpdateChannel,
  UpdateCheckResult,
  UpdateComponent,
  UpdateComponentState,
  UpdateComponentStatus,
  UpdateOperationRef,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../runtime/errors';
import type {
  CanopyDispatcherStreamHandlerMap,
  CanopyHandlerContext,
} from '../runtime/types';
import type {
  CoreUpdateHost,
  DesktopReleaseFlavor,
  DesktopUpdatePhase,
} from './ports';

type UpdateQueryHandlers = Pick<
  CanopyQueryHandlerMap<CanopyHandlerContext>,
  'core.update.status.get'
>;
type UpdateInstructionHandlers = Pick<
  CanopyInstructionHandlerMap<CanopyHandlerContext>,
  | 'core.update.check'
  | 'core.update.download'
  | 'core.update.apply'
  | 'core.update.apply.cancel'
>;
type UpdateStreamHandlers = Pick<
  CanopyDispatcherStreamHandlerMap<typeof CANOPY_STREAM_DEFINITIONS>,
  'core.update.events'
>;

export interface CoreUpdateHandlers {
  queries: UpdateQueryHandlers;
  instructions: UpdateInstructionHandlers;
  streams: UpdateStreamHandlers;
}

/**
 * How this host treats paired computers that control it. They call as
 * `remote-device:<deviceId>` principals.
 */
export interface CoreUpdateRemotePolicy {
  /** The person at this host allows paired computers to update it. */
  readonly allowed: () => boolean;
  /** The paired computer's name, shown on this host and in the status. */
  readonly nameOf: (principalId: string) => string | null;
  /** The shortest gap between one computer's check, download or apply. */
  readonly minIntervalMs?: number;
  /** Calls the listener when `allowed()` may have changed. */
  readonly subscribe?: (listener: () => void) => () => void;
}

export interface CoreUpdateHandlerOptions {
  /** Without it, every remote write is refused. */
  readonly remote?: CoreUpdateRemotePolicy;
  /** Names this host's event stream; defaults to a random epoch. */
  readonly epoch?: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** The catalog channel each compiled flavor follows. */
export const UPDATE_CHANNEL_FOR_FLAVOR: Readonly<
  Record<DesktopReleaseFlavor, UpdateChannel>
> = {
  stable: 'stable',
  rc: 'candidate',
  internal: 'development',
};

const STATE_FOR_PHASE: Readonly<
  Record<DesktopUpdatePhase, UpdateComponentState>
> = {
  idle: 'idle',
  'not-available': 'idle',
  checking: 'checking',
  available: 'available',
  downloading: 'downloading',
  downloaded: 'ready',
  error: 'failed',
};

const DESKTOP: UpdateComponent = 'desktop';
const REMOTE_PRINCIPAL_PREFIX = 'remote-device:';
const DEFAULT_REMOTE_INTERVAL_MS = 10_000;

function isRemote(context: CanopyHandlerContext): boolean {
  return context.caller.principalId.startsWith(REMOTE_PRINCIPAL_PREFIX);
}

/** The longest free text a status field carries. */
const STATUS_TEXT_LIMIT = 4_096;

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message.length > 0 ? message.slice(0, 4_096) : 'The update failed.';
}

/** The host refused or failed a step; its own message is kept for the user. */
function hostFailure(error: unknown): CanopyOperationError {
  if (error instanceof CanopyOperationError) return error;
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'core.update.failed',
    message: messageOf(error),
    retry: { kind: 'never' },
  });
}

function onlyDesktop(component: string): void {
  if (component === DESKTOP) return;
  throw new CanopyOperationError({
    kind: 'not_found',
    code: 'core.update.notFound',
    message: `This host does not update the ${component} component.`,
    retry: { kind: 'never' },
  });
}

/** How many keyed results each operation keeps for retries. */
const KEYED_RESULT_LIMIT = 64;

type KeyedParams = { readonly _meta: { readonly idempotencyKey: string } };

/**
 * Runs a keyed request once per caller and key. A retry with the same
 * request gets the first result; the same key with another request is
 * refused. A request that failed may be sent again under its key.
 */
function keyedRuns<Result>(): <Params extends KeyedParams>(
  context: CanopyHandlerContext,
  params: Params,
  run: () => Result | Promise<Result>,
) => Promise<Result> {
  const results = new Map<
    string,
    { readonly fingerprint: string; readonly result: Promise<Result> }
  >();
  return (context, params, run) => {
    const key = JSON.stringify([
      context.caller.principalId,
      params._meta.idempotencyKey,
    ]);
    const fingerprint = JSON.stringify(
      Object.entries(params).filter(([name]) => name !== '_meta'),
    );
    const earlier = results.get(key);
    if (earlier) {
      if (earlier.fingerprint === fingerprint) return earlier.result;
      return Promise.reject(
        new CanopyOperationError({
          kind: 'failed_precondition',
          code: 'core.update.invalidState',
          message: 'This request key was already used for another request.',
          retry: { kind: 'never' },
        }),
      );
    }
    const result = Promise.resolve().then(run);
    if (results.size >= KEYED_RESULT_LIMIT) {
      const oldest = results.keys().next().value;
      if (oldest !== undefined) results.delete(oldest);
    }
    results.set(key, { fingerprint, result });
    result.catch(() => {
      if (results.get(key)?.result === result) results.delete(key);
    });
    return result;
  };
}

/**
 * `core.update.*` for one desktop host (CAN-5899). The host installs the
 * package; core reports its status, checks that a request names the host's
 * own channel and current candidate, and streams each status change.
 */
export function createCoreUpdateHandlers(
  host: CoreUpdateHost,
  options: CoreUpdateHandlerOptions = {},
): CoreUpdateHandlers {
  const now = options.now ?? ((): Date => new Date());
  const newId = options.newId ?? ((): string => crypto.randomUUID());
  const epoch = options.epoch ?? crypto.randomUUID();
  const channel = UPDATE_CHANNEL_FOR_FLAVOR[host.releaseFlavor];
  let sequence = 0;
  let updatedAt = now().toISOString();
  let applying = false;
  /** Who asked for the pending idle restart, when it was a paired computer. */
  let requester: { principalId: string; name: string } | null = null;
  const lastRemoteWrite = new Map<string, number>();
  const listeners = new Set<() => void>();

  const changed = (): void => {
    sequence += 1;
    updatedAt = now().toISOString();
    for (const listener of [...listeners]) listener();
  };
  // One subscription for the host's lifetime keeps the sequence counting
  // whether or not a stream is open.
  host.subscribe(() => {
    // An install that started can still fail after `installNow` returned;
    // the host then leaves the downloaded phase and reports why.
    if (applying && host.snapshot().phase !== 'downloaded') applying = false;
    changed();
  });
  // Status carries whether paired computers may update this host.
  options.remote?.subscribe?.(changed);

  // Keyed requests answer a retry with the first result instead of running
  // again, so a retried apply cannot undo a cancel that came after it.
  const checkOnce = keyedRuns<UpdateCheckResult>();
  const downloadOnce = keyedRuns<UpdateOperationRef>();
  const applyOnce = keyedRuns<UpdateOperationRef>();

  const status = (): UpdateComponentStatus => {
    const snapshot = host.snapshot();
    const support = host.support();
    const state: UpdateComponentState = applying
      ? 'applying'
      : STATE_FOR_PHASE[snapshot.phase];
    const progress =
      snapshot.phase === 'downloading' && snapshot.progressPercent !== null
        ? Math.min(1, Math.max(0, snapshot.progressPercent / 100))
        : null;
    return {
      component: DESKTOP,
      currentVersion: snapshot.currentVersion,
      availableVersion: snapshot.availableVersion,
      state,
      mandatory: false,
      progress,
      errorCode: state === 'failed' ? 'core.update.failed' : null,
      updatedAt,
      releaseFlavor: host.releaseFlavor,
      displayVersion: snapshot.displayVersion,
      availableDisplayVersion: snapshot.availableDisplayVersion,
      supported: support.supported,
      ...(support.supported
        ? {}
        : {
            unsupportedReason: support.reason,
            ...(support.manualInstructions
              ? {
                  manualInstructions: support.manualInstructions.slice(
                    0,
                    STATUS_TEXT_LIMIT,
                  ),
                }
              : {}),
          }),
      restartPending: snapshot.restartPending
        ? { policy: 'when_idle', requestedBy: requester }
        : null,
      blockers: host.blockers(),
      // Updater errors can carry a whole HTTP response body.
      message: snapshot.message?.slice(0, STATUS_TEXT_LIMIT) ?? null,
      remoteUpdatesAllowed: options.remote?.allowed() ?? false,
      lastAttempt: failedAttempt(),
    };
  };

  const failedAttempt = (): {
    targetVersion: string;
    at: string;
    requestedBy: string | null;
    outcome: 'failed';
  } | null => {
    const attempt = host.lastFailedAttempt?.() ?? null;
    return attempt
      ? {
          targetVersion: attempt.targetVersion,
          at: attempt.at,
          requestedBy: attempt.requestedBy,
          outcome: 'failed',
        }
      : null;
  };

  /** An idle restart core scheduled and recorded is still pending. */
  let deferredAttempt = false;
  // A pending restart this host's user or the updater withdrew has no
  // requester any more, and its install never started.
  host.subscribe(() => {
    if (host.snapshot().restartPending) return;
    requester = null;
    if (deferredAttempt && !applying) host.recordAttempt?.(null);
    deferredAttempt = false;
  });

  /**
   * A paired computer may write only while this host allows it, at most
   * once per interval, and never over a version someone here picked.
   */
  const admitRemoteWrite = (context: CanopyHandlerContext): void => {
    if (!isRemote(context)) return;
    const remote = options.remote;
    if (!remote?.allowed()) {
      throw new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'core.update.disabled',
        message: "This computer doesn't allow updates from other computers.",
        retry: { kind: 'never' },
      });
    }
    const principalId = context.caller.principalId;
    const interval = remote.minIntervalMs ?? DEFAULT_REMOTE_INTERVAL_MS;
    const at = now().getTime();
    const last = lastRemoteWrite.get(principalId);
    if (last !== undefined && at - last < interval) {
      throw new CanopyOperationError({
        kind: 'resource_exhausted',
        code: 'core.update.rateLimited',
        message: 'Wait a few seconds before asking this computer again.',
        retry: {
          kind: 'same_idempotency_key',
          delayMs: interval - (at - last),
        },
      });
    }
    if (host.snapshot().targeted) {
      throw new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'core.update.invalidState',
        message:
          'Someone at this computer picked a specific version to install. Finish or cancel it there.',
        retry: { kind: 'never' },
      });
    }
    lastRemoteWrite.set(principalId, at);
  };

  const requesterOf = (
    context: CanopyHandlerContext,
  ): { principalId: string; name: string } | null => {
    if (!isRemote(context)) return null;
    const principalId = context.caller.principalId;
    return {
      principalId,
      name: options.remote?.nameOf(principalId) ?? 'Another computer',
    };
  };

  const wantsDesktop = (components?: readonly UpdateComponent[]): boolean =>
    components === undefined || components.includes(DESKTOP);

  /** The request must name the candidate the host itself found. */
  const requireCandidate = (version: string): void => {
    const available = host.snapshot().availableVersion;
    if (available === null || available === version) return;
    throw new CanopyOperationError({
      kind: 'failed_precondition',
      code: 'core.update.invalidState',
      message: `Version ${version} is not this computer's current update.`,
      retry: { kind: 'never' },
    });
  };

  return {
    queries: {
      'core.update.status.get': (params) => ({
        components: wantsDesktop(params.components) ? [status()] : [],
        policyRevision: sequence,
      }),
    },
    instructions: {
      'core.update.check': (params, context) =>
        checkOnce(context, params, async () => {
          if (!params.components.includes(DESKTOP)) {
            onlyDesktop(params.components[0] ?? 'requested');
          }
          if (params.channel !== channel) {
            throw new CanopyOperationError({
              kind: 'failed_precondition',
              code: 'core.update.channelMismatch',
              message: `This computer follows the ${channel} channel, not ${params.channel}.`,
              retry: { kind: 'never' },
            });
          }
          if (params.requestedVersion !== null) {
            throw new CanopyOperationError({
              kind: 'capability_unavailable',
              code: 'core.update.unsupported',
              message:
                'Checking for an exact version is only available on this computer.',
              retry: { kind: 'never' },
            });
          }
          admitRemoteWrite(context);
          try {
            await host.check();
          } catch (error) {
            throw hostFailure(error);
          }
          return {
            operation: { operationId: newId(), state: 'succeeded' },
            checkedComponents: [DESKTOP],
          };
        }),
      'core.update.download': (params, context) =>
        downloadOnce(context, params, () => {
          onlyDesktop(params.component);
          requireCandidate(params.version);
          admitRemoteWrite(context);
          const alreadyDownloaded = host.snapshot().phase === 'downloaded';
          try {
            // The download settles later; its failure reaches clients through
            // the status the host reports.
            host.startDownload().catch(() => undefined);
          } catch (error) {
            throw hostFailure(error);
          }
          return {
            operationId: newId(),
            kind: 'core.update.download',
            status: alreadyDownloaded ? 'completed' : 'running',
          };
        }),
      'core.update.apply': (params, context) =>
        applyOnce(context, params, () => {
          onlyDesktop(params.component);
          requireCandidate(params.version);
          if (params.restartPolicy === 'prompt') {
            throw new CanopyOperationError({
              kind: 'capability_unavailable',
              code: 'core.update.unsupported',
              message: 'This computer has no restart prompt to show.',
              retry: { kind: 'never' },
            });
          }
          admitRemoteWrite(context);
          const askedBy = requesterOf(context);
          const snapshot = host.snapshot();
          if (params.restartPolicy === 'when_idle' && snapshot.restartPending) {
            // Joins the restart already waiting; whoever scheduled it keeps
            // it, so this caller cannot later withdraw it.
            return {
              operationId: newId(),
              kind: 'core.update.apply',
              status: 'queued',
            };
          }
          host.recordAttempt?.({
            targetVersion: snapshot.availableVersion ?? params.version,
            requestedBy: askedBy?.name ?? null,
          });
          if (params.restartPolicy === 'when_idle') {
            try {
              host.scheduleRestart();
            } catch (error) {
              host.recordAttempt?.(null);
              throw hostFailure(error);
            }
            requester = askedBy;
            deferredAttempt = true;
            changed();
            return {
              operationId: newId(),
              kind: 'core.update.apply',
              status: 'queued',
            };
          }
          deferredAttempt = false;
          applying = true;
          changed();
          try {
            // The install shuts this dispatcher down before the app quits,
            // so the call returns once it starts. A later failure moves the
            // host off the downloaded build, which clears `applying`.
            host.installNow().catch(() => {
              host.recordAttempt?.(null);
              if (!applying) return;
              applying = false;
              changed();
            });
          } catch (error) {
            applying = false;
            host.recordAttempt?.(null);
            changed();
            throw hostFailure(error);
          }
          return {
            operationId: newId(),
            kind: 'core.update.apply',
            status: 'running',
          };
        }),
      'core.update.apply.cancel': (params, context) => {
        onlyDesktop(params.component);
        const pending = host.snapshot().restartPending;
        // A paired computer withdraws only the restart it asked for; the
        // person at this host can withdraw any.
        const mine =
          !isRemote(context) ||
          requester?.principalId === context.caller.principalId;
        if (!pending || !mine) return { component: DESKTOP, cancelled: false };
        host.cancelScheduledRestart();
        host.recordAttempt?.(null);
        requester = null;
        changed();
        return { component: DESKTOP, cancelled: true };
      },
    },
    streams: {
      'core.update.events': (params, _context, sink) => {
        const cursorAt = (at: number): CanopyStreamCursor => ({
          daemonEpoch: epoch,
          sequence: at,
        });
        const cursor = params.cursor ?? null;
        if (
          cursor !== null &&
          (cursor.daemonEpoch !== epoch || cursor.sequence > sequence)
        ) {
          return Promise.reject(
            new CanopyOperationError({
              kind: 'failed_precondition',
              code: 'core.update.snapshotRequired',
              message:
                'The update cursor belongs to another stream. Reopen the stream without a cursor.',
              retry: { kind: 'after_refresh', resource: 'core.update.events' },
            }),
          );
        }
        if (!wantsDesktop(params.components)) return Promise.resolve();
        // The stream carries the latest state, so a resume only needs it
        // when something changed after the cursor.
        let last = cursor?.sequence ?? -1;
        const emitCurrent = (): boolean => {
          if (sequence <= last) return true;
          last = sequence;
          return sink.emitAt(cursorAt(sequence), status()) !== null;
        };
        if (!emitCurrent()) return Promise.resolve();
        const listener = (): void => {
          if (!emitCurrent()) listeners.delete(listener);
        };
        listeners.add(listener);
        return Promise.resolve(() => {
          listeners.delete(listener);
        });
      },
    },
  };
}

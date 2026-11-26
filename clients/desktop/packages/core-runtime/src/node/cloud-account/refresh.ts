import type {
  CloudAccountAuthority,
  CloudAccountAuthorityFailure,
} from './authority';
import type { CloudAccountProbe } from './probe';
import {
  hasCloudAccountCredential,
  hasCloudAccountIdentityChanged,
  type CloudAccountEntryJson,
  type CloudAccountRecord,
} from './record';

/**
 * Account and policy refresh (CAN-6997). At this pin the desktop OAuth bearer
 * is an opaque, non-expiring-by-default API credential: refresh re-probes the
 * account with it and saves the new snapshot. There is no refresh-token
 * exchange. Revocation surfaces as a rejected probe; replacement comes only
 * from explicit sign-in through the authority.
 */

export type CloudAccountRefreshOutcome =
  | 'applied'
  | 'superseded'
  | 'offline'
  | 'forbidden'
  | 'unauthenticated'
  | 'stale-probe'
  | 'no-key'
  | 'invalid-snapshot'
  | 'inactive'
  | 'unavailable';

export interface CloudAccountRefreshResult {
  readonly outcome: CloudAccountRefreshOutcome;
  /** Whether per-org billing state came from this response (see settings.ts). */
  readonly billingStatesRefreshed: boolean;
  readonly failure?: Extract<
    CloudAccountAuthorityFailure,
    { kind: 'unavailable' }
  >;
}

/**
 * Builds the refreshed entry from the current one and an authenticated
 * response, with the Electron store's replace-not-merge rules. Null when the
 * payload cannot produce an entry. Supplied by composition so the daemon and
 * the app share one normalizer.
 */
export type CloudAccountSnapshotBuilder = (input: {
  readonly current: CloudAccountRecord;
  readonly capabilities: readonly string[];
  readonly payload: unknown;
  readonly updatedAt: string;
}) => {
  readonly entry: CloudAccountEntryJson;
  readonly organizationsRefreshed: boolean;
  readonly billingStatesRefreshed: boolean;
} | null;

export interface CloudAccountRefresher {
  /**
   * One refresh. A call made while a probe runs queues one probe to start
   * after it, since the running probe may predate the change the caller is
   * reacting to; further calls before that probe starts join it.
   */
  refresh(signal?: AbortSignal): Promise<CloudAccountRefreshResult>;
  /** Periodic refresh; the returned function stops it. */
  start(intervalMs: number): () => void;
  /** Aborts requests and waits for all account writes before vault teardown. */
  dispose(): Promise<void>;
}

const result = (
  outcome: CloudAccountRefreshOutcome,
  billingStatesRefreshed = false,
): CloudAccountRefreshResult => ({ outcome, billingStatesRefreshed });

export function createCloudAccountRefresher(options: {
  readonly authority: CloudAccountAuthority;
  readonly probe: (
    apiKey: string,
    signal?: AbortSignal,
  ) => Promise<CloudAccountProbe>;
  readonly buildSnapshot: CloudAccountSnapshotBuilder;
  readonly now?: () => Date;
  readonly onResult?: (result: CloudAccountRefreshResult) => void;
}): CloudAccountRefresher {
  const now = options.now ?? ((): Date => new Date());
  const lifetime = new AbortController();
  const active = new Set<Promise<CloudAccountRefreshResult>>();
  const timers = new Set<ReturnType<typeof setInterval>>();
  const pending = new Map<
    string,
    {
      promise: Promise<CloudAccountRefreshResult>;
      waiting: boolean;
      credentialGeneration: number;
      probeGeneration: number;
    }
  >();

  async function run(
    expected: CloudAccountRecord,
    sessionProbe: ReturnType<CloudAccountAuthority['beginProbe']>,
    signal: AbortSignal | undefined,
  ): Promise<CloudAccountRefreshResult> {
    const { authority } = options;
    // A waiting refresh reads the active refresh's saved version, keeping the
    // caller's identity and credential fence across the wait.
    const read = await authority.read();
    if (signal?.aborted) return result('unavailable');
    if (read.kind === 'inactive') return result('inactive');
    if (read.kind !== 'ok') return { ...result('unavailable'), failure: read };
    const entry = read.record;
    if (
      !entry ||
      entry.apiKey !== expected.apiKey ||
      hasCloudAccountIdentityChanged(expected, entry)
    )
      return result('stale-probe');
    const probe = await options.probe(entry.apiKey, signal);
    if (signal?.aborted) return result('unavailable');
    if (probe.kind === 'offline') return result('offline');
    if (probe.kind === 'rejected' || probe.kind === 'forbidden') {
      const recorded = await authority.applyProbeResult(
        entry,
        sessionProbe,
        probe.kind,
        signal,
      );
      if (recorded.kind === 'unavailable')
        return { ...result('unavailable'), failure: recorded };
      if (recorded.kind === 'stale') return result('stale-probe');
    }
    if (probe.kind === 'rejected') return result('unauthenticated');
    if (probe.kind === 'forbidden') return result('forbidden');
    const built = options.buildSnapshot({
      current: entry,
      capabilities: probe.capabilities,
      payload: probe.payload,
      updatedAt: now().toISOString(),
    });
    if (!built) {
      const recorded = await authority.applyProbeResult(
        entry,
        sessionProbe,
        'unknown',
        signal,
      );
      if (recorded.kind === 'unavailable')
        return { ...result('unavailable'), failure: recorded };
      if (recorded.kind === 'stale') return result('stale-probe');
      return result('invalid-snapshot');
    }
    if (signal?.aborted) return result('unavailable');
    const saved = await authority.saveIfUnchanged(built.entry, entry, {
      probe: sessionProbe,
      ...(signal ? { signal } : {}),
      organizationsRefreshed: built.organizationsRefreshed,
    });
    switch (saved.kind) {
      case 'saved':
        return result('applied', built.billingStatesRefreshed);
      case 'superseded':
        return result('superseded');
      case 'invalid':
        return result('invalid-snapshot');
      case 'inactive':
        return result('inactive');
      case 'unavailable':
        return { ...result('unavailable'), failure: saved };
    }
  }

  async function refreshOnce(
    signal?: AbortSignal,
  ): Promise<CloudAccountRefreshResult> {
    // Capture before any read or wait: clear and same-key replacement
    // invalidate it.
    const sessionProbe = options.authority.beginProbe();
    const read = await options.authority.read();
    if (signal?.aborted) return result('unavailable');
    if (read.kind === 'inactive') return result('inactive');
    if (read.kind !== 'ok') return { ...result('unavailable'), failure: read };
    const expected = read.record;
    if (!hasCloudAccountCredential(expected)) return result('no-key');
    const held = pending.get(expected.apiKey);
    const previous =
      held?.credentialGeneration === read.credentialGeneration &&
      held.probeGeneration === sessionProbe.generation
        ? held
        : undefined;
    // Join a probe still queued; queue behind one already running.
    if (previous?.waiting) return previous.promise;
    const entry = {
      promise: Promise.resolve(result('stale-probe')),
      waiting: previous !== undefined,
      credentialGeneration: read.credentialGeneration,
      probeGeneration: sessionProbe.generation,
    };
    const start = (): Promise<CloudAccountRefreshResult> => {
      entry.waiting = false;
      return run(expected, sessionProbe, signal);
    };
    entry.promise = (
      previous ? previous.promise.catch(() => undefined).then(start) : start()
    )
      .catch(() => result('unavailable'))
      .then((outcome) => {
        try {
          options.onResult?.(outcome);
        } catch {
          // Observers never change a refresh outcome.
        }
        return outcome;
      })
      .finally(() => {
        if (pending.get(expected.apiKey) === entry)
          pending.delete(expected.apiKey);
      });
    pending.set(expected.apiKey, entry);
    return entry.promise;
  }

  function refresh(signal?: AbortSignal): Promise<CloudAccountRefreshResult> {
    if (lifetime.signal.aborted || signal?.aborted)
      return Promise.resolve(result('unavailable'));
    // Shared work belongs to the service; request cancellation ends only its wait.
    const request = refreshOnce(lifetime.signal);
    active.add(request);
    void request.finally(() => active.delete(request)).catch(() => undefined);
    if (!signal) return request;
    return new Promise((resolve, reject) => {
      const abort = (): void => resolve(result('unavailable'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void request.then(
        (outcome) => {
          signal.removeEventListener('abort', abort);
          resolve(outcome);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(
            error instanceof Error
              ? error
              : new Error('Account refresh failed.'),
          );
        },
      );
    });
  }

  function start(intervalMs: number): () => void {
    if (!Number.isFinite(intervalMs) || intervalMs < 1_000)
      throw new RangeError('Refresh interval must be at least one second.');
    const controller = new AbortController();
    if (lifetime.signal.aborted) return (): void => undefined;
    const timer = setInterval(() => {
      void refresh(controller.signal);
    }, intervalMs);
    timer.unref?.();
    timers.add(timer);
    void refresh(controller.signal);
    return (): void => {
      clearInterval(timer);
      timers.delete(timer);
      controller.abort();
    };
  }

  return {
    refresh,
    start,
    dispose: async (): Promise<void> => {
      lifetime.abort();
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      await Promise.allSettled([...active]);
    },
  };
}

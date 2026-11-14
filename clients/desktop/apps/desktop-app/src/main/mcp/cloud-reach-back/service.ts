import {
  isMcpHostRequestWithdrawal,
  type McpHostRequest,
  type McpHostRequestRespondParams,
  type McpHostRequestsItem,
  type McpHostServingServer,
} from '@canopy/protocol/canopy-core';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import type { ReachBackAllowList } from './allow-list';

/**
 * The reach-back service (CAN-6176 PR 7a, D22, D25): while this computer is
 * signed in, the `canopy-desktop-cloud-chats` flag is on and at least one
 * server is allowed, main holds its own web core connection and lease with
 * `core.integration.mcpHostRequests` open, serves each request and answers
 * it with `core.integration.mcpHostRequest.respond`. Otherwise it holds
 * nothing, so the cloud sees the desktop offline and answers at once.
 *
 * A request runs until its deadline, or until the web core withdraws it.
 * A dropped stream reconnects with backoff; the web core withdraws what the
 * dropped one delivered, never resends it.
 */

/** One open stream on main's own web core connection and lease. */
export interface ReachBackSession {
  readonly items: AsyncIterable<McpHostRequestsItem>;
  respond(answer: McpHostRequestRespondParams): Promise<void>;
  /**
   * Reports whether this desktop can serve each server now, over this
   * connection (CAN-6659); absent when the web core doesn't take reports, so
   * the stream was opened without `servingReports`. `not_owned`: some
   * server isn't one of this desktop's, and nothing was written.
   */
  readonly report?: (
    servers: readonly McpHostServingServer[],
  ) => Promise<'reported' | 'not_owned'>;
  close(): Promise<void>;
}

export interface ReachBackServiceDeps {
  readonly isEnabled: () => boolean;
  /** Called when the flag may have changed. */
  readonly onEnabledChange: (listener: () => void) => () => void;
  readonly currentAccountId: () => string | null;
  readonly onAccountChange: (listener: () => void) => () => void;
  readonly allowList: ReachBackAllowList;
  /** Opens the connection, lease and stream for the signed-in account. */
  readonly open: (signal: AbortSignal) => Promise<ReachBackSession>;
  readonly serve: (
    accountId: string,
    request: McpHostRequest,
    signal: AbortSignal,
  ) => Promise<McpHostRequestRespondParams>;
  /** Drops the account's routes when it stops serving. */
  readonly closeRoutes: (accountId: string) => void;
  /** Whether this desktop can serve each of the account's allowed servers. */
  readonly servingOf?: (accountId: string) => Promise<McpHostServingServer[]>;
  /** Called when a server's serving state may have changed. */
  readonly onServingChange?: (listener: () => void) => () => void;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

const RECONNECT_START_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Reports again this often, so a lapsed failure is offered again. */
const REPORT_REFRESH_MS = 60_000;
/** The most servers one report names (`McpHostStatusReportParamsSchema`). */
const REPORT_BATCH = 256;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function createReachBackService(deps: ReachBackServiceDeps): {
  start(): void;
  stop(): Promise<void>;
  /** Settles once the current state is applied; for tests. */
  settled(): Promise<void>;
} {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  let running = false;
  /** Ends the current serving run: an account, flag or allow list change. */
  let run: AbortController | null = null;
  /** The account the current run serves, or null while it holds nothing. */
  let serving: string | null = null;
  let loop: Promise<void> = Promise.resolve();
  const unsubscribe: (() => void)[] = [];

  const shouldServe = async (): Promise<string | null> => {
    if (!running || !deps.isEnabled()) return null;
    const accountId = deps.currentAccountId();
    if (accountId === null) return null;
    return (await deps.allowList.list(accountId)).length > 0 ? accountId : null;
  };

  /**
   * Reports this desktop's serving state over `session` (CAN-6659): once the
   * stream is open, whenever it may have changed, and every minute, one
   * report at a time. A report that names a server this desktop no longer
   * owns (removed in the cloud) is sent again server by server, so the rest
   * still land. Returns a stop that waits for the report in flight.
   */
  const startReporting = (
    accountId: string,
    session: ReachBackSession,
    signal: AbortSignal,
  ): (() => Promise<void>) => {
    const send = session.report;
    const servingOf = deps.servingOf;
    if (send === undefined || servingOf === undefined)
      return () => Promise.resolve();
    let chain: Promise<void> = Promise.resolve();
    const report = (): void => {
      chain = chain
        .then(async () => {
          if (signal.aborted) return;
          const servers = await servingOf(accountId);
          for (let at = 0; at < servers.length; at += REPORT_BATCH) {
            if (signal.aborted) return;
            const batch = servers.slice(at, at + REPORT_BATCH);
            if ((await send(batch)) === 'not_owned' && batch.length > 1)
              for (const server of batch) {
                if (signal.aborted) return;
                await send([server]);
              }
          }
        })
        .catch((error: unknown) => {
          if (!signal.aborted)
            logMainProcessWarn(
              '[cloud-reach-back] Serving state could not be reported.',
              error,
            );
        });
    };
    const stops = [
      deps.onServingChange?.(report),
      deps.allowList.onChange((changed) => {
        if (changed === accountId) report();
      }),
    ];
    const refresh = setInterval(report, REPORT_REFRESH_MS);
    report();
    return async () => {
      clearInterval(refresh);
      for (const stop of stops) stop?.();
      await chain;
    };
  };

  /** Serves one stream until it ends or `signal` aborts. */
  const serveStream = async (
    accountId: string,
    session: ReachBackSession,
    signal: AbortSignal,
  ): Promise<void> => {
    const inFlight = new Map<string, AbortController>();
    const answers: Promise<void>[] = [];
    const stopReporting = startReporting(accountId, session, signal);
    try {
      for await (const item of session.items) {
        if (signal.aborted) break;
        if (isMcpHostRequestWithdrawal(item)) {
          inFlight.get(item.requestId)?.abort();
          continue;
        }
        const request = new AbortController();
        inFlight.set(item.requestId, request);
        const deadline = setTimeout(
          () => request.abort(),
          Math.max(0, Date.parse(item.deadlineAt) - now()),
        );
        const stop = AbortSignal.any([request.signal, signal]);
        answers.push(
          deps
            .serve(accountId, item, stop)
            .then((answer) =>
              stop.aborted ? undefined : session.respond(answer),
            )
            .catch((error: unknown) =>
              logMainProcessWarn(
                '[cloud-reach-back] A request could not be answered.',
                error,
              ),
            )
            .finally(() => {
              clearTimeout(deadline);
              inFlight.delete(item.requestId);
            }),
        );
      }
    } finally {
      await stopReporting();
      for (const request of inFlight.values()) request.abort();
      await Promise.allSettled(answers);
    }
  };

  const apply = (): void => {
    run?.abort();
    const current = new AbortController();
    run = current;
    loop = loop.then(async () => {
      const accountId = await shouldServe();
      serving = accountId;
      if (accountId === null || current.signal.aborted) return;
      let backoff = RECONNECT_START_MS;
      try {
        while (!current.signal.aborted) {
          let session: ReachBackSession | null = null;
          try {
            session = await deps.open(current.signal);
            backoff = RECONNECT_START_MS;
            // Closing ends the stream's items, which the loop below awaits.
            const opened = session;
            current.signal.addEventListener(
              'abort',
              () => void opened.close().catch(() => undefined),
              { once: true },
            );
            await serveStream(accountId, session, current.signal);
          } catch (error) {
            if (!current.signal.aborted)
              logMainProcessWarn(
                '[cloud-reach-back] The request stream dropped.',
                error,
              );
          } finally {
            await session?.close().catch(() => undefined);
          }
          if (current.signal.aborted) break;
          await sleep(backoff, current.signal);
          backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
        }
      } finally {
        deps.closeRoutes(accountId);
      }
    });
  };

  /**
   * An allow list or flag change restarts the run only when it starts or
   * stops serving: a reconnect would lose the requests in flight. A server
   * turned off is refused by the next request's own allow list check.
   */
  const reconsider = (): void => {
    void shouldServe().then((next) => {
      if (next !== serving) apply();
    });
  };

  return {
    start() {
      if (running) return;
      running = true;
      unsubscribe.push(
        // A refresh of the same account (its teams, billing or profile)
        // keeps the stream: only a change of account restarts it.
        deps.onAccountChange(reconsider),
        deps.allowList.onChange(reconsider),
        // The flag reads false until it loads after a sign-in, and turning it
        // off must stop a stream already open.
        deps.onEnabledChange(reconsider),
      );
      apply();
    },
    async stop() {
      running = false;
      for (const stop of unsubscribe.splice(0)) stop();
      run?.abort();
      await loop;
    },
    settled: () => loop,
  };
}

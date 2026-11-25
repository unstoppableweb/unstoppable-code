import { canopyDaemonRefusal } from '@canopy/core-client/node';
import {
  CanopyClientError,
  createCanopyAuthorityRegistry,
  createCanopyClientLease,
  type CanopyAuthorityConnection,
  type CanopyClientLease,
  type CanopyLeaseClient,
} from '@canopy/core-client';
import {
  CanopyCallerDescriptorSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';
import type { BackgroundServiceUnreachableReason } from '@canopy/desktop-shared/lib/background-service-status';

type Connection = CanopyLeaseClient & CanopyAuthorityConnection;

/**
 * Whether the daemon could be reached, as the service observes it. A typed
 * refusal from a connected daemon is none of these.
 */
export type ElectronDaemonReachability =
  /** An attach (setup or lease reconnect) resolved with a usable client. */
  | { readonly kind: 'reached' }
  /**
   * A connected client dropped while its session was live or still in setup.
   * That session reports the restart's outcome: a reach,
   * `reconnect_failed` / `endpoint_repair_required`, or `abandoned`.
   */
  | { readonly kind: 'lost' }
  /**
   * The last session restarting after a `lost` closed before reporting its
   * outcome, e.g. its owner closed or replaced it. Nothing proves either way.
   */
  | { readonly kind: 'abandoned' }
  | {
      readonly kind: 'unreachable';
      readonly reason: BackgroundServiceUnreachableReason;
    };

export interface ElectronDaemonSession<C extends Connection> {
  /** Session lifetime, independent of the clients replaced during lease recovery. */
  readonly signal: AbortSignal;
  readonly client: C;
  readonly lease: Pick<CanopyClientLease<C>, 'state' | 'lease' | 'register'>;
  close(): Promise<void>;
}
export interface ElectronDaemonConnectionService<C extends Connection> {
  /** Caller and owner lifetime are resolved by trusted main, never renderer payloads. */
  get(
    caller: CanopyCallerDescriptor,
    owner: AbortSignal,
    options?: ElectronDaemonGetOptions,
  ): Promise<ElectronDaemonSession<C>>;
  dispose(): Promise<void>;
}
export interface ElectronDaemonConnectionOptions<C extends Connection> {
  readonly enabled: boolean;
  readonly authorityId: string | ((signal: AbortSignal) => Promise<string>);
  readonly attach: (signal: AbortSignal) => Promise<C>;
  readonly setupTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  /**
   * Observes each session a `get` resolves, new or reused. Observers ride the
   * session; they never open one (W5e's commit event subscriber).
   */
  readonly onSession?: (
    session: ElectronDaemonSession<C>,
    caller: CanopyCallerDescriptor,
  ) => void;
  /** Observes reachability across every caller's session. Never throws into a read. */
  readonly onReachability?: (event: ElectronDaemonReachability) => void;
  /**
   * Observes the failure behind each unreachable setup, once per attempt;
   * restart refusals and cancellations stay silent. Never throws into a read.
   */
  readonly onSetupFailure?: (
    error: unknown,
    reason: BackgroundServiceUnreachableReason,
  ) => void;
  /**
   * An attach rejection inside a restart the app runs itself: left untagged,
   * so it shows nothing (q-13). Not consulted once the lifetime aborted.
   */
  readonly isRestartRefusal?: (error: unknown) => boolean;
  /**
   * The lease's label and presence; defaults to an interactive `Desktop`
   * lease. The daemon owner session's is `Workflow host steps` (CAN-5771 D10).
   */
  readonly lease?: {
    readonly label: string;
    readonly interactive: boolean;
    readonly foreground: boolean;
  };
}
export interface ElectronDaemonGetOptions {
  /**
   * Attempt again even within a failed setup's 1 s reuse window (an explicit
   * Try again). A live or pending session is still reused.
   */
  readonly reprobe?: boolean;
}
const failure = (
  kind: CanopyClientError['payload']['kind'],
  message: string,
): CanopyClientError =>
  new CanopyClientError({ kind, message, retry: { kind: 'never' } });

const unreachable = new WeakMap<object, BackgroundServiceUnreachableReason>();

/**
 * Why a `get` failure means the daemon couldn't be reached, or `null` for a
 * refusal or cancellation. The failure keeps its identity.
 */
export function daemonUnreachableReason(
  error: unknown,
): BackgroundServiceUnreachableReason | null {
  return typeof error === 'object' && error !== null
    ? (unreachable.get(error) ?? null)
    : null;
}

/**
 * Tags a failure as an unreachable daemon; only connect, setup and host
 * stages tag. The first reason wins: a reconnect failure surfaced by acquire
 * keeps its own.
 */
export function markUnreachable(
  error: unknown,
  reason: BackgroundServiceUnreachableReason,
): unknown {
  const marked =
    typeof error === 'object' && error !== null
      ? error
      : failure('unavailable', 'Desktop daemon is unreachable.');
  if (!unreachable.has(marked)) unreachable.set(marked, reason);
  return marked;
}

/**
 * Any attach rejection (spawn, exit before ready, data root preparation)
 * means no session could exist, so the daemon is unreachable; `cancelled` is
 * not. Callers skip this once the session's lifetime is aborted: that
 * rejection is the owner closing, never the daemon.
 *
 * A handshake `unauthenticated` and an incompatible protocol
 * (`failed_precondition`) also map to `start_failed`, by decision, even
 * though a live daemon answered: no session results, so nothing can serve.
 */
function attachFailureReason(
  error: unknown,
): BackgroundServiceUnreachableReason | null {
  if (error instanceof CanopyClientError && error.payload.kind === 'cancelled')
    return null;
  if (canopyDaemonRefusal(error) === 'endpoint_repair_required')
    return 'endpoint_repair_required';
  if (!(error instanceof CanopyClientError)) return 'start_failed';
  return error.payload.kind === 'deadline_exceeded'
    ? 'connect_timeout'
    : 'start_failed';
}

/** One connection/lease per trusted caller lifetime, shared by its migrated consumers. */
export function createElectronDaemonConnectionService<C extends Connection>(
  options: ElectronDaemonConnectionOptions<C>,
): ElectronDaemonConnectionService<C> {
  type Entry = {
    scope: string;
    owner: AbortSignal;
    pending: Promise<ElectronDaemonSession<C>>;
    close: () => Promise<void>;
    usable: () => boolean;
    failedAt?: number;
  };
  const entries = new Map<string, Entry>();
  const admissions = new Map<string, Promise<unknown>>();
  let disposed = false;
  let disposing: Promise<void> | undefined;
  /** Open sessions between their `lost` and reporting the restart's outcome. */
  let restarts = 0;
  const observe = (event: ElectronDaemonReachability): void => {
    if (disposed) return;
    try {
      options.onReachability?.(event);
    } catch {
      // An observer never fails the session's consumer.
    }
  };
  async function get(
    raw: CanopyCallerDescriptor,
    owner: AbortSignal,
    { reprobe = false }: ElectronDaemonGetOptions = {},
  ): Promise<ElectronDaemonSession<C>> {
    if (disposed || owner.aborted)
      throw failure('cancelled', 'Desktop connection owner is closed.');
    if (!options.enabled)
      throw failure(
        'capability_unavailable',
        'Desktop daemon transport is disabled.',
      );
    const parsed = CanopyCallerDescriptorSchema.safeParse(raw);
    if (!parsed.success || parsed.data.interfaceKind !== 'desktop')
      throw failure('unauthenticated', 'Desktop caller identity is invalid.');
    const caller = parsed.data;
    const scope = stableStringify(caller);
    const existing = entries.get(caller.clientInstanceId);
    if (
      existing?.scope === scope &&
      existing.owner === owner &&
      (existing.failedAt === undefined
        ? existing.usable()
        : !reprobe && performance.now() - existing.failedAt < 1_000)
    )
      return existing.pending;
    if (existing) {
      await existing.close();
      entries.delete(caller.clientInstanceId);
    }
    if (disposed || owner.aborted)
      throw failure('cancelled', 'Desktop connection owner is closed.');
    const lifetime = new AbortController();
    let authorityId: string;
    const clients = new Set<C>();
    const attachments = new Set<Promise<C>>();
    let lease: CanopyClientLease<C> | undefined;
    let closing: Promise<void> | undefined;
    const stop = (): CanopyClientError =>
      lifetime.signal.reason instanceof CanopyClientError
        ? lifetime.signal.reason
        : failure('cancelled', 'Desktop connection owner is closed.');
    let rejectSetup = (): void => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectSetup = (): void => reject(stop());
      lifetime.signal.addEventListener('abort', rejectSetup, { once: true });
    });
    const setupTimer = setTimeout(
      () =>
        lifetime.abort(
          markUnreachable(
            failure('deadline_exceeded', 'Desktop connection setup timed out.'),
            'connect_timeout',
          ),
        ),
      options.setupTimeoutMs ?? 30_000,
    );
    // Set by this session's `lost` until it reports the restart's outcome:
    // health hides that restart until then, even before setup finished.
    let restarting = false;
    const setRestarting = (next: boolean): void => {
      if (restarting === next) return;
      restarting = next;
      restarts += next ? 1 : -1;
    };
    const close = (): Promise<void> => {
      if (closing) return closing;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (async (): Promise<void> => {
        lifetime.abort(stop());
        if (restarting) {
          setRestarting(false);
          if (restarts === 0) observe({ kind: 'abandoned' });
        }
        owner.removeEventListener('abort', onLoss);
        try {
          await lease?.release('normal_shutdown');
        } finally {
          const closings = Array.from(clients, (client) => client.close());
          await Promise.allSettled([...closings, ...Array.from(attachments)]);
          await Promise.all(closings);
        }
      })().then(() => {
        closing = Promise.resolve();
        const cached = entries.get(caller.clientInstanceId);
        if (cached?.pending !== pending) return;
        const retire = (): void => {
          if (entries.get(caller.clientInstanceId) === cached)
            entries.delete(caller.clientInstanceId);
        };
        if (cached.failedAt === undefined) retire();
        else
          setTimeout(
            retire,
            Math.max(0, 1_000 - (performance.now() - cached.failedAt)),
          ).unref();
      });
      closing = Promise.race([
        cleanup,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                failure(
                  'deadline_exceeded',
                  'Desktop connection cleanup timed out.',
                ),
              ),
            options.cleanupTimeoutMs ?? 5_000,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      return closing;
    };
    const onLoss = (): void => {
      void close().catch(() => undefined);
    };
    const connect = async (): Promise<C> => {
      if (lifetime.signal.aborted) throw stop();
      let client: C;
      try {
        client = await options.attach(lifetime.signal);
      } catch (error) {
        const reason =
          lifetime.signal.aborted || options.isRestartRefusal?.(error)
            ? null
            : attachFailureReason(error);
        throw reason ? markUnreachable(error, reason) : error;
      }
      clients.add(client);
      client.signal.addEventListener('abort', () => clients.delete(client), {
        once: true,
      });
      if (client.signal.aborted) clients.delete(client);
      if (
        lifetime.signal.aborted ||
        client.identity.authorityId !== authorityId ||
        client.identity.profile === 'worker'
      ) {
        await client.close();
        if (lifetime.signal.aborted)
          throw failure(
            'cancelled',
            'Desktop daemon authority is unavailable.',
          );
        throw markUnreachable(
          failure(
            'failed_precondition',
            'Desktop daemon authority is unavailable.',
          ),
          'start_failed',
        );
      }
      // Listened only after the checks: closing a rejected client is no loss,
      // nor is the lease closing a replacement it never adopted.
      client.signal.addEventListener(
        'abort',
        () => {
          if (
            !lifetime.signal.aborted &&
            (lease === undefined || lease.client === client)
          ) {
            setRestarting(true);
            observe({ kind: 'lost' });
          }
        },
        { once: true },
      );
      if (!client.signal.aborted) {
        setRestarting(false);
        observe({ kind: 'reached' });
      }
      return client;
    };
    const attach = (): Promise<C> => {
      const task = connect();
      attachments.add(task);
      void task.then(
        () => attachments.delete(task),
        () => attachments.delete(task),
      );
      return task;
    };
    let established = false;
    const setup = (async (): Promise<ElectronDaemonSession<C>> => {
      try {
        authorityId =
          typeof options.authorityId === 'string'
            ? options.authorityId
            : await options.authorityId(lifetime.signal);
      } catch (error) {
        throw lifetime.signal.aborted
          ? error
          : markUnreachable(error, 'host_unavailable');
      }
      if (caller.authorityId !== authorityId)
        throw failure(
          'failed_precondition',
          'Desktop caller selected a different authority.',
        );
      const client = await attach();
      let registryClient = client;
      let registry = createCanopyAuthorityRegistry({ primary: client });
      const fence = (connected: C): C => {
        const signal = AbortSignal.any([connected.signal, lifetime.signal]);
        const handler: ProxyHandler<object> = {
          get(target, key): unknown {
            const value: unknown = Reflect.get(target, key, target);
            if (key === 'signal') return signal;
            if (
              key === 'connection' &&
              typeof value === 'object' &&
              value !== null
            )
              return new Proxy(value, handler);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]): unknown => {
              if (lifetime.signal.aborted) throw stop();
              const result: unknown = Reflect.apply(value, target, args);
              return result instanceof Promise
                ? result.finally(() => {
                    if (lifetime.signal.aborted) throw stop();
                  })
                : result;
            };
          },
        };
        return new Proxy<C>(connected, handler);
      };
      let guardedClient = fence(client);
      const ownedLease = (lease = createCanopyClientLease({
        client,
        attach,
        identity: {
          clientInstanceId: caller.clientInstanceId,
          interfaceKind: 'desktop',
          label: options.lease?.label ?? 'Desktop',
        },
        renewalIntervalMs: 15_000,
        presence: () => ({
          interactive: options.lease?.interactive ?? true,
          foreground: options.lease?.foreground ?? false,
        }),
        onError: (error) => {
          if (lifetime.signal.aborted) return;
          // A replacement attach the lease retries with backoff ("Core exited
          // before it was ready."): still restarting, so nothing to show
          // (Mike, q-13 GA3-1). Giving up fails the lease, reported below.
          if (ownedLease.state === 'reconnecting') return;
          // Setup failures surface through `pending`; this sees later ones.
          if (!established || ownedLease.state !== 'failed') return;
          established = false;
          // A refusal on a connected client is not an unreachable daemon.
          if (
            daemonUnreachableReason(error) !== null ||
            ownedLease.client.signal.aborted
          ) {
            setRestarting(false);
            observe({
              kind: 'unreachable',
              reason:
                daemonUnreachableReason(error) === 'endpoint_repair_required'
                  ? 'endpoint_repair_required'
                  : 'reconnect_failed',
            });
          }
        },
      }));
      try {
        await ownedLease.acquire();
      } catch (error) {
        throw !lifetime.signal.aborted && ownedLease.client.signal.aborted
          ? markUnreachable(error, 'connection_lost')
          : error;
      }
      if (lifetime.signal.aborted) throw stop();
      established = true;
      return {
        signal: lifetime.signal,
        get client(): C {
          if (lifetime.signal.aborted) throw stop();
          try {
            if (registryClient !== ownedLease.client) {
              registryClient = ownedLease.client;
              registry = createCanopyAuthorityRegistry({
                primary: registryClient,
              });
              guardedClient = fence(registryClient);
            }
            registry.resolve({
              mode: 'authority',
              authorityId,
            });
          } catch (error) {
            // Down while the lease replaces it: as unreachable as a failed attach.
            throw ownedLease.client.signal.aborted
              ? markUnreachable(error, 'connection_lost')
              : error;
          }
          return guardedClient;
        },
        lease: {
          register: (key, issue) => ownedLease.register(key, issue),
          get state(): CanopyClientLease<C>['state'] {
            return ownedLease.state;
          },
          get lease(): CanopyClientLease<C>['lease'] {
            return ownedLease.lease;
          },
        },
        close,
      };
    })();
    const pending: Promise<ElectronDaemonSession<C>> = Promise.race([
      setup,
      cancelled,
    ]).finally(() => {
      clearTimeout(setupTimer);
      lifetime.signal.removeEventListener('abort', rejectSetup);
    });
    const entry: Entry = {
      scope,
      owner,
      pending,
      close,
      usable: () =>
        !lifetime.signal.aborted &&
        lease?.state !== 'failed' &&
        lease?.state !== 'released',
    };
    entries.set(caller.clientInstanceId, entry);
    owner.addEventListener('abort', onLoss, { once: true });
    if (owner.aborted) onLoss();
    void pending.catch(async (error: unknown) => {
      entry.failedAt = performance.now();
      const reason = daemonUnreachableReason(error);
      if (reason) {
        // Lost mid-setup, its restart failed: reported like an established
        // lease giving up, since health shows nothing else while it restarts.
        const shown =
          restarting && reason !== 'endpoint_repair_required'
            ? 'reconnect_failed'
            : reason;
        setRestarting(false);
        observe({ kind: 'unreachable', reason: shown });
        try {
          options.onSetupFailure?.(error, reason);
        } catch {
          // An observer never fails the session's consumer.
        }
      }
      // Release before allowing a later attempt; no background retry of failed setup.
      await close().catch(() => undefined);
    });
    return pending;
  }
  return {
    get(caller, owner, getOptions): Promise<ElectronDaemonSession<C>> {
      const previous =
        admissions.get(caller.clientInstanceId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() => get(caller, owner, getOptions))
        .then((session) => {
          try {
            options.onSession?.(session, caller);
          } catch {
            // An observer never fails the session's consumer.
          }
          return session;
        });
      admissions.set(caller.clientInstanceId, next);
      void next
        .finally(() => {
          if (admissions.get(caller.clientInstanceId) === next)
            admissions.delete(caller.clientInstanceId);
        })
        .catch(() => undefined);
      return next;
    },
    dispose(): Promise<void> {
      disposed = true;
      disposing ??= (async (): Promise<void> => {
        const owned = Array.from(entries.values());
        entries.clear();
        await Promise.all(owned.map((entry) => entry.close()));
        await Promise.allSettled(Array.from(admissions.values()));
      })();
      return disposing;
    },
  };
}

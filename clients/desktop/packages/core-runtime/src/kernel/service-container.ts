import type {
  CanopyJsonValue,
  CoreRuntimeDescriptor,
} from '@canopy/protocol/canopy-core';
import type { CanopyRuntimeProfile } from '../runtime/types';

export type ServiceStopPhase = 3 | 4 | 5 | 6 | 7;

// Type aliases (not interfaces) stay assignable to JSON value contracts.
export type RuntimeHealthCheck = {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string | null;
  /** A service's own machine-readable cause; `message` stays prose. */
  reason?: string;
  /** Closed machine-readable facts behind `reason`; never prose, paths or output. */
  details?: Readonly<Record<string, CanopyJsonValue>>;
};

export type RuntimeHealth = {
  state: CoreRuntimeDescriptor['state'];
  checks: RuntimeHealthCheck[];
};

type Hook = (signal: AbortSignal) => void | Promise<void>;

export interface RuntimeService {
  name: string;
  plane: 'core' | 'worker';
  dependsOn?: readonly string[];
  required?: boolean;
  migrations?: readonly { id: string; run: Hook }[];
  start?: Hook;
  health?(): RuntimeHealthCheck;
  stop?: Partial<Record<ServiceStopPhase, Hook>>;
}

export interface ServiceContainerOptions {
  profile: CanopyRuntimeProfile;
  services: readonly RuntimeService[];
  onChange?: (health: RuntimeHealth) => void;
}

export interface ServiceContainer {
  readonly order: readonly string[];
  start(signal?: AbortSignal): Promise<void>;
  /** Also publishes the snapshot to `onChange` when it changed. */
  health(): RuntimeHealth;
  markStopping(): void;
  stopPhase(phase: ServiceStopPhase, signal: AbortSignal): Promise<void>;
}

// Validated fields are copied so later caller mutation cannot bypass checks.
type Entry = {
  source: RuntimeService;
  name: string;
  dependsOn: readonly string[];
  required: boolean;
  migrations: NonNullable<RuntimeService['migrations']>;
};

type ServiceStatus = 'pending' | 'started' | { unavailable: string };

const STOPPED_EARLY = 'Service container stopped before startup completed';

// Formatting a hostile throw value must not escape as a second failure.
function describe(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return 'Unknown error';
  }
}

function withCause(message: string, cause: unknown): Error {
  return Object.assign(new Error(message), { cause });
}

/** Always invokes `run`; only the wait for its promise is bounded by `signal`. */
async function waitWithin(
  signal: AbortSignal,
  run: () => void | Promise<void>,
): Promise<void> {
  const result = run();
  if (result === undefined) return;
  // Assimilates cross-realm and structural promises that fail `instanceof`.
  const pending = Promise.resolve(result);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('Aborted'),
      );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    void pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function validateAndOrder(
  profile: CanopyRuntimeProfile,
  entries: readonly Entry[],
): Entry[] {
  const byName = new Map<string, Entry>();
  for (const entry of entries) {
    const { name } = entry;
    const { plane } = entry.source;
    if (byName.has(name)) throw new Error(`Duplicate service name ${name}`);
    byName.set(name, entry);
    if (profile !== 'core+worker' && profile !== plane)
      throw new Error(
        `Runtime profile ${profile} cannot host ${plane} service ${name}`,
      );
  }
  for (const entry of entries)
    for (const dependency of entry.dependsOn) {
      const target = byName.get(dependency);
      if (target === undefined)
        throw new Error(
          `Service ${entry.name} depends on unknown service ${dependency}`,
        );
      if (entry.required && !target.required)
        throw new Error(
          `Required service ${entry.name} cannot depend on optional service ${dependency}`,
        );
    }

  // Depth-first in declaration order: dependencies first, stable ties.
  const order: Entry[] = [];
  const path: string[] = [];
  const visit = (entry: Entry): void => {
    if (order.includes(entry)) return;
    const cycleStart = path.indexOf(entry.name);
    if (cycleStart !== -1)
      throw new Error(
        `Service dependency cycle: ${[...path.slice(cycleStart), entry.name].join(' -> ')}`,
      );
    path.push(entry.name);
    entry.dependsOn.forEach((dependency) => {
      const target = byName.get(dependency);
      if (target !== undefined) visit(target);
    });
    path.pop();
    order.push(entry);
  };
  entries.forEach(visit);
  return order;
}

export function createServiceContainer(
  options: ServiceContainerOptions,
): ServiceContainer {
  const ordered = validateAndOrder(
    options.profile,
    options.services.map((source) => ({
      source,
      name: source.name,
      dependsOn: [...(source.dependsOn ?? [])],
      required: source.required !== false,
      migrations: [...(source.migrations ?? [])],
    })),
  );
  const status = new Map<string, ServiceStatus>(
    ordered.map(({ name }) => [name, 'pending']),
  );
  const attempted = new Set<string>();
  const stopping = new AbortController();
  let startPromise: Promise<void> | null = null;
  let settled = false;
  let lastPublished: string | null = null;
  let publishing = false;
  let republish = false;

  const checkFor = ({ name, source, required }: Entry): RuntimeHealthCheck => {
    const current = status.get(name) ?? 'pending';
    if (typeof current === 'object')
      return {
        name,
        status: required ? 'fail' : 'warn',
        message: current.unavailable,
      };
    if (current === 'pending')
      return { name, status: 'warn', message: 'Not started' };
    try {
      const check = source.health?.();
      return check === undefined
        ? { name, status: 'pass', message: null }
        : {
            name,
            status: check.status,
            message: check.message,
            ...(check.reason !== undefined && { reason: check.reason }),
            ...(check.details !== undefined && { details: check.details }),
          };
    } catch (error) {
      const message = `Health check threw: ${describe(error)}`;
      return { name, status: 'warn', message };
    }
  };

  const snapshot = (): RuntimeHealth => {
    const checks = ordered.map(checkFor);
    return {
      state: stopping.signal.aborted
        ? 'stopping'
        : !settled
          ? 'starting'
          : checks.every((check) => check.status === 'pass')
            ? 'ready'
            : 'degraded',
      checks,
    };
  };

  const health = (): RuntimeHealth => {
    const current = snapshot();
    // Nested calls only read; lifecycle changes they flag are drained here.
    if (publishing) return current;
    publishing = true;
    try {
      for (let next = current; ; next = snapshot()) {
        republish = false;
        const key = JSON.stringify(next);
        if (key !== lastPublished) {
          lastPublished = key;
          try {
            options.onChange?.(next);
          } catch {
            // An observer failure must not alter container lifecycle.
          }
        }
        if (!republish) break;
      }
    } finally {
      publishing = false;
    }
    return current;
  };

  const changed = (): void => {
    republish = true;
    health();
  };

  const startService = async ({ source, migrations }: Entry): Promise<void> => {
    const signal = stopping.signal;
    for (const migration of migrations) {
      signal.throwIfAborted();
      try {
        await waitWithin(signal, () => migration.run(signal));
      } catch (error) {
        throw withCause(
          `Migration ${migration.id} failed: ${describe(error)}`,
          error,
        );
      }
    }
    signal.throwIfAborted();
    await waitWithin(signal, () => source.start?.(signal));
  };

  const runStartup = async (): Promise<void> => {
    try {
      changed();
      for (const entry of ordered) {
        const { name } = entry;
        if (stopping.signal.aborted) throw new Error(STOPPED_EARLY);
        const blocker = entry.dependsOn.find(
          (dependency) => status.get(dependency) !== 'started',
        );
        let cause: unknown = null;
        if (blocker !== undefined) {
          status.set(name, {
            unavailable: `Dependency ${blocker} is unavailable`,
          });
        } else {
          attempted.add(name);
          try {
            await startService(entry);
            status.set(name, 'started');
          } catch (error) {
            if (stopping.signal.aborted) throw new Error(STOPPED_EARLY);
            cause = error;
            status.set(name, { unavailable: describe(error) });
          }
        }
        changed();
        const outcome = status.get(name);
        if (typeof outcome === 'object' && entry.required)
          throw withCause(
            `Service ${name} ${blocker === undefined ? 'failed to start' : 'blocked'}: ${outcome.unavailable}`,
            cause,
          );
      }
      if (stopping.signal.aborted) throw new Error(STOPPED_EARLY);
    } finally {
      settled = true;
      changed();
    }
  };

  const markStopping = (): void => {
    if (stopping.signal.aborted) return;
    stopping.abort(new Error('Service container is stopping'));
    changed();
  };

  return {
    order: Object.freeze(ordered.map(({ name }) => name)),
    start(signal?: AbortSignal): Promise<void> {
      if (startPromise === null) {
        // Shared before any hook or observer runs, so reentry gets this promise.
        let adopt: (run: Promise<void>) => void = () => undefined;
        startPromise = new Promise<void>((resolve) => {
          adopt = resolve;
        });
        const abort = (): void => markStopping();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        adopt(
          stopping.signal.aborted
            ? Promise.reject(new Error(STOPPED_EARLY))
            : runStartup(),
        );
        void startPromise.then(
          () => signal?.removeEventListener('abort', abort),
          () => signal?.removeEventListener('abort', abort),
        );
      }
      return startPromise;
    },
    health,
    markStopping,
    async stopPhase(phase, signal): Promise<void> {
      markStopping();
      // Startup is already aborted; a deadline here must not skip cleanup.
      await waitWithin(signal, () =>
        startPromise?.catch(() => undefined),
      ).catch(() => undefined);
      const failures: string[] = [];
      const causes: unknown[] = [];
      for (const { name, source } of [...ordered].reverse()) {
        const hooks = source.stop;
        const hook = hooks?.[phase];
        if (hook === undefined || !attempted.has(name)) continue;
        try {
          await waitWithin(signal, () => hook.call(hooks, signal));
        } catch (error) {
          failures.push(`${name}: ${describe(error)}`);
          causes.push(error);
        }
      }
      if (failures.length > 0)
        throw withCause(
          `Service stop phase ${phase} failed: ${failures.join('; ')}`,
          causes,
        );
    },
  };
}

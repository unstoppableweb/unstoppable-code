import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

export interface CanopyStartupClaimOwner {
  readonly pid: number;
  readonly startIdentity: string;
}
export type CanopyStartupProcessInspection =
  | { readonly kind: 'alive'; readonly startIdentity: string }
  | { readonly kind: 'dead' | 'unknown' };
export interface CanopyStartupClaimOptions {
  readonly dataRoot: string;
  readonly owner: CanopyStartupClaimOwner;
  readonly inspectProcess: (
    pid: number,
    signal?: AbortSignal,
  ) => Promise<CanopyStartupProcessInspection>;
}
export interface CanopyStartupClaimAcquireOptions {
  /** Replaces a claim whose owner is proven departed: absent, or a changed start identity. */
  readonly recoverDeparted?: boolean;
  /** Supervisor-held token from a failed attempt whose child cleanup was confirmed. */
  readonly recoverOwnHandle?: object;
}
export interface CanopyStartupClaimRecovery {
  /** The departed lineage marked a bind at a path it had verified empty. */
  readonly endpointBound: boolean;
}
export type CanopyStartupClaimResult =
  | {
      readonly kind: 'acquired';
      readonly handle: object;
      /** Present only when this acquisition replaced a departed owner's claim. */
      readonly recovered?: CanopyStartupClaimRecovery;
    }
  | { readonly kind: 'held' }
  | {
      readonly kind: 'ambiguous';
      /** Why the guarded claim I/O could not be proven; absent otherwise. */
      readonly cause?: CanopyStartupClaimAmbiguity;
      /** Raw errno name of the I/O failure, when it had one. */
      readonly errno?: string;
    };
export type CanopyStartupClaimAmbiguity =
  | 'stale_guard'
  | 'guard_io'
  | 'record_io';
export type CanopyStartupClaimReleaseResult =
  | 'released'
  | 'not_owner'
  | 'ambiguous';
export interface CanopyStartupClaimIdentity {
  readonly dataRoot: string;
  readonly claimId: string;
}
export interface CanopyStartupClaimReleaseOptions {
  /** Launchers cannot clean up an endpoint marked by a departed lineage. */
  readonly preserveEndpointBind?: boolean;
}
export interface CanopyStartupClaimPort {
  tryAcquire(
    signal?: AbortSignal,
    options?: CanopyStartupClaimAcquireOptions,
  ): Promise<CanopyStartupClaimResult>;
  adopt(
    handle: object,
    signal?: AbortSignal,
  ): Promise<CanopyStartupClaimResult>;
  release(
    handle: object,
    options?: CanopyStartupClaimReleaseOptions | AbortSignal,
  ): Promise<CanopyStartupClaimReleaseResult>;
  identity(handle: object): Promise<CanopyStartupClaimIdentity | null>;
  verify(claim: CanopyStartupClaimIdentity): Promise<boolean>;
  /** The current owner records that it is about to bind at a path it verified empty. */
  markEndpointBind(handle: object): Promise<boolean>;
}

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  startIdentity: z.string().min(1),
});
const handleSchema = z.object({
  version: z.literal(1),
  dataRoot: z.string(),
  claimId: z.uuidv4(),
  launcher: ownerSchema,
});
const recordSchema = handleSchema.extend({
  owner: ownerSchema,
  endpointBound: z.literal(true).optional(),
});
type ClaimHandle = z.infer<typeof handleSchema>;
type ClaimRecord = z.infer<typeof recordSchema>;
function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
const ambiguous = (
  cause?: CanopyStartupClaimAmbiguity,
  errno?: string,
): CanopyStartupClaimResult => ({
  kind: 'ambiguous',
  ...(cause && { cause }),
  ...(errno && { errno }),
});
function sameOwner(
  left: CanopyStartupClaimOwner,
  right: CanopyStartupClaimOwner,
): boolean {
  return left.pid === right.pid && left.startIdentity === right.startIdentity;
}

/**
 * Caller supplies canonical dataRoot and an existing private dataRoot/runtime
 * directory, verified through host permissions (including ACLs). All cooperating
 * processes must use this helper; the directory must remain private/stable.
 * Handles are bearer capabilities: trusted supervisor only, never argv.
 * Atomic mkdir serializes record access; crashed guards need offline repair, and so
 * do crashed claims unless the caller opts into departed-owner recovery.
 * Release after handoff requires the supervisor to confirm child exit first.
 * This helper never touches an endpoint or inspects platform process state itself.
 */
export function createCanopyStartupClaimPort(
  options: CanopyStartupClaimOptions,
): CanopyStartupClaimPort {
  const { dataRoot, inspectProcess } = options;
  const owner = ownerSchema.parse(options.owner);
  if (!isAbsolute(dataRoot) || normalize(dataRoot) !== dataRoot)
    throw new Error('Expected a canonical absolute data root.');
  const runtimeDirectory = join(dataRoot, 'runtime');
  const guardPath = join(runtimeDirectory, 'startup-claim.guard');
  const recordPath = join(runtimeDirectory, 'startup-claim.json');
  async function guarded<T>(
    fallback: (cause?: CanopyStartupClaimAmbiguity, errno?: string) => T,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    // Allow filesystem/scheduler contention within the supervisor's cleanup budget.
    // Exhausted/crashed guards still need offline repair.
    const deadline = performance.now() + 2_000;
    for (;;) {
      if (signal?.aborted) return fallback();
      try {
        await mkdir(guardPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (!hasCode(error, 'EEXIST'))
          return fallback('guard_io', errnoOf(error));
        if (performance.now() >= deadline) return fallback('stale_guard');
        try {
          await delay(5, undefined, { signal });
        } catch {
          return fallback();
        }
      }
    }
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      // Uncertain I/O fails closed.
      result = fallback('record_io', errnoOf(error));
    }
    try {
      await rmdir(guardPath);
    } catch (error) {
      return fallback('guard_io', errnoOf(error));
    }
    return result;
  }
  async function read(): Promise<ClaimRecord | null> {
    try {
      const record = recordSchema.parse(
        JSON.parse(await readFile(recordPath, 'utf8')),
      );
      if (record.dataRoot !== dataRoot)
        throw new Error('Foreign startup claim.');
      return record;
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return null;
      throw error;
    }
  }
  async function ownerState(
    record: ClaimRecord,
    signal?: AbortSignal,
  ): Promise<'live' | 'departed' | 'unknown'> {
    const observed = await inspectProcess(record.owner.pid, signal);
    if (observed.kind !== 'alive')
      return observed.kind === 'dead' ? 'departed' : 'unknown';
    return observed.startIdentity === record.owner.startIdentity
      ? 'live'
      : 'departed';
  }
  async function live(
    record: ClaimRecord,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return (await ownerState(record, signal)) === 'live';
  }
  function freshHandle(): ClaimHandle {
    return {
      version: 1,
      dataRoot,
      claimId: randomUUID(),
      launcher: { ...owner },
    };
  }
  // Recovery evidence must survive a crash mid-write: replace by rename, never truncate.
  async function replaceRecord(record: ClaimRecord): Promise<void> {
    const temporary = join(
      runtimeDirectory,
      `.startup-claim-${randomUUID()}.tmp`,
    );
    await writeFile(temporary, JSON.stringify(record), {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    });
    try {
      await rename(temporary, recordPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
  function matches(record: ClaimRecord, handle: ClaimHandle): boolean {
    return (
      handle.dataRoot === dataRoot &&
      handle.claimId === record.claimId &&
      sameOwner(record.launcher, handle.launcher)
    );
  }
  async function tryAcquire(
    signal?: AbortSignal,
    acquireOptions: CanopyStartupClaimAcquireOptions = {},
  ): Promise<CanopyStartupClaimResult> {
    const snapshot = await guarded<
      CanopyStartupClaimResult | { kind: 'inspect'; record: ClaimRecord }
    >(
      ambiguous,
      async () => {
        if (signal?.aborted) return { kind: 'ambiguous' };
        const existing = await read();
        if (existing) return { kind: 'inspect', record: existing };
        if (signal?.aborted) return { kind: 'ambiguous' };
        const handle = freshHandle();
        await writeFile(recordPath, JSON.stringify({ ...handle, owner }), {
          flag: 'wx',
          mode: 0o600,
          flush: true,
        });
        return { kind: 'acquired', handle };
      },
      signal,
    );
    if (snapshot.kind !== 'inspect') return snapshot;
    try {
      const state = await ownerState(snapshot.record, signal);
      return guarded<CanopyStartupClaimResult>(
        ambiguous,
        async () => {
          if (signal?.aborted) return { kind: 'ambiguous' };
          const current = await read();
          // A concurrent release/adoption requires the launcher to re-probe.
          if (
            !current ||
            !matches(current, snapshot.record) ||
            !sameOwner(current.owner, snapshot.record.owner)
          )
            return { kind: 'held' };
          const own = handleSchema.safeParse(acquireOptions.recoverOwnHandle);
          const recoverOwn =
            state === 'live' &&
            own.success &&
            matches(current, own.data) &&
            sameOwner(current.launcher, owner) &&
            sameOwner(current.owner, owner);
          if (state === 'live' && !recoverOwn) return { kind: 'held' };
          if (
            state === 'unknown' ||
            (state === 'departed' && !acquireOptions.recoverDeparted)
          )
            return { kind: 'ambiguous' };
          // Token rotation also fences late adoption from a confirmed failed launch.
          const handle = freshHandle();
          const endpointBound = current.endpointBound === true;
          await replaceRecord({
            ...handle,
            owner,
            ...(endpointBound && { endpointBound }),
          });
          return { kind: 'acquired', handle, recovered: { endpointBound } };
        },
        signal,
      );
    } catch {
      return { kind: 'ambiguous' };
    }
  }
  async function adopt(
    handle: object,
    signal?: AbortSignal,
  ): Promise<CanopyStartupClaimResult> {
    return guarded<CanopyStartupClaimResult>(
      () => ({ kind: 'ambiguous' }),
      async () => {
        const parsed = handleSchema.parse(handle);
        if (signal?.aborted) return { kind: 'ambiguous' };
        const record = await read();
        // Token proof allows crash-after-spawn adoption without launcher liveness.
        if (
          !record ||
          !matches(record, parsed) ||
          (!sameOwner(record.owner, record.launcher) &&
            !sameOwner(record.owner, owner)) ||
          signal?.aborted
        )
          return { kind: 'ambiguous' };
        // Launchers never bind, so a marker before handoff is the departed lineage's.
        const departedBind =
          record.endpointBound === true &&
          sameOwner(record.owner, record.launcher) &&
          !sameOwner(record.owner, owner);
        await writeFile(recordPath, JSON.stringify({ ...record, owner }), {
          mode: 0o600,
          flush: true,
        });
        return {
          kind: 'acquired',
          handle: parsed,
          ...(departedBind && { recovered: { endpointBound: true } }),
        };
      },
      signal,
    );
  }
  async function release(
    handle: object,
    options: CanopyStartupClaimReleaseOptions | AbortSignal = {},
  ): Promise<CanopyStartupClaimReleaseResult> {
    const signal = 'aborted' in options ? options : undefined;
    const preserveEndpointBind =
      'preserveEndpointBind' in options &&
      options.preserveEndpointBind === true;
    return guarded<CanopyStartupClaimReleaseResult>(
      () => 'ambiguous',
      async () => {
        const parsed = handleSchema.safeParse(handle);
        if (!parsed.success || parsed.data.dataRoot !== dataRoot)
          return 'not_owner';
        const record = await read();
        if (!record || !matches(record, parsed.data)) return 'not_owner';
        if (signal?.aborted) return 'ambiguous';
        // After adoption, only the child can discard its endpoint recovery proof.
        if (
          record.endpointBound &&
          (preserveEndpointBind || !sameOwner(record.owner, owner))
        )
          return 'not_owner';
        await unlink(recordPath);
        return 'released';
      },
      signal,
    );
  }
  async function verify(claim: CanopyStartupClaimIdentity): Promise<boolean> {
    return (
      (await validatedRecord(
        (record) =>
          claim.dataRoot === dataRoot && claim.claimId === record.claimId,
      )) !== null
    );
  }
  async function validatedRecord(
    accepts: (record: ClaimRecord) => boolean,
  ): Promise<ClaimRecord | null> {
    const snapshot = await guarded<ClaimRecord | null>(
      () => null,
      async () => {
        const record = await read();
        return record && accepts(record) ? record : null;
      },
    );
    if (!snapshot) return null;
    try {
      // Host inspection can spawn a process; never hold the filesystem guard here.
      if (!(await live(snapshot))) return null;
      return guarded<ClaimRecord | null>(
        () => null,
        async () => {
          const current = await read();
          return current &&
            matches(current, snapshot) &&
            sameOwner(current.owner, snapshot.owner)
            ? current
            : null;
        },
      );
    } catch {
      return null;
    }
  }
  async function identity(
    handle: object,
  ): Promise<CanopyStartupClaimIdentity | null> {
    const parsed = handleSchema.safeParse(handle);
    if (!parsed.success) return null;
    const record = await validatedRecord((current) =>
      matches(current, parsed.data),
    );
    return record ? { dataRoot, claimId: record.claimId } : null;
  }
  async function markEndpointBind(handle: object): Promise<boolean> {
    const parsed = handleSchema.safeParse(handle);
    if (!parsed.success) return false;
    return guarded(
      () => false,
      async () => {
        const record = await read();
        if (
          !record ||
          !matches(record, parsed.data) ||
          !sameOwner(record.owner, owner)
        )
          return false;
        if (!record.endpointBound)
          await replaceRecord({ ...record, endpointBound: true });
        return true;
      },
    );
  }
  return { tryAcquire, adopt, release, identity, verify, markEndpointBind };
}

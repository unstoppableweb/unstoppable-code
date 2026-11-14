import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isRecord } from './commit-log/is-record';
import {
  relocationTransition,
  type RelocationTransition,
} from '../relocation/transition';

export interface W5RootEvidenceScope {
  readonly canonicalDataRoot: string;
  readonly device: string;
  readonly inode: string;
}

export interface W5ServiceHistory {
  readonly version: 1;
  readonly scope: W5RootEvidenceScope;
  readonly firstServiceAt: string;
  readonly historyId: string;
  /** Absence of an older artifact cannot establish absence of older service. */
  readonly priorHistory: 'unknown';
}

/** Frozen source evidence and destination admission supplied by the migration owner. */
export interface W5ServiceHistoryRelocation {
  readonly transition: RelocationTransition;
  readonly sourceHistory: W5ServiceHistory | undefined;
  /** Verifies the exact journaled transition and published destination identity. */
  admit(
    transition: RelocationTransition,
    scope: W5RootEvidenceScope,
  ): Promise<void>;
}

export class W5ServiceHistoryError extends Error {
  constructor(
    readonly reason:
      | 'invalid-evidence'
      | 'scope-mismatch'
      | 'publication-failed',
  ) {
    super(`W5 service history refused (${reason}).`);
    this.name = 'W5ServiceHistoryError';
  }
}

function errno(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

/** Unchanged-root provenance only; relocation must qualify its own mapping. */
export async function w5RootEvidenceScope(
  dataRoot: string,
): Promise<W5RootEvidenceScope> {
  const canonicalDataRoot = await realpath(dataRoot);
  const stat = await lstat(canonicalDataRoot, { bigint: true });
  if (!stat.isDirectory()) throw new W5ServiceHistoryError('scope-mismatch');
  return {
    canonicalDataRoot,
    device: String(stat.dev),
    inode: String(stat.ino),
  };
}

function isW5RootEvidenceScope(value: unknown): value is W5RootEvidenceScope {
  return (
    isRecord(value) &&
    typeof value.canonicalDataRoot === 'string' &&
    isAbsolute(value.canonicalDataRoot) &&
    resolve(value.canonicalDataRoot) === value.canonicalDataRoot &&
    typeof value.device === 'string' &&
    /^\d+$/.test(value.device) &&
    typeof value.inode === 'string' &&
    /^\d+$/.test(value.inode)
  );
}

export function sameW5RootEvidenceScope(
  value: unknown,
  scope: W5RootEvidenceScope,
): boolean {
  return (
    isW5RootEvidenceScope(value) &&
    value.canonicalDataRoot === scope.canonicalDataRoot &&
    value.device === scope.device &&
    value.inode === scope.inode
  );
}

/** Revalidate after awaited publication/exclusion work before admitting a host. */
export async function requireW5RootEvidenceScope(
  scope: W5RootEvidenceScope,
): Promise<void> {
  if (
    !sameW5RootEvidenceScope(
      await w5RootEvidenceScope(scope.canonicalDataRoot),
      scope,
    )
  )
    throw new W5ServiceHistoryError('scope-mismatch');
}

export function w5RootEvidenceId(scope: W5RootEvidenceScope): string {
  return createHash('sha256')
    .update(
      JSON.stringify([scope.canonicalDataRoot, scope.device, scope.inode]),
    )
    .digest('hex');
}

/** Missing is distinct from invalid/unreadable, and never proves pre-service history. */
export async function readW5RootEvidence(path: string): Promise<unknown> {
  let inspected: BigIntStats;
  try {
    inspected = await lstat(path, { bigint: true });
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    throw new W5ServiceHistoryError('invalid-evidence');
  }
  if (!inspected.isFile() || inspected.size > 64n * 1024n)
    throw new W5ServiceHistoryError('invalid-evidence');
  const unchanged = (stat: BigIntStats): boolean =>
    stat.isFile() &&
    stat.dev === inspected.dev &&
    stat.ino === inspected.ino &&
    stat.size === inspected.size &&
    stat.mtimeNs === inspected.mtimeNs &&
    stat.ctimeNs === inspected.ctimeNs;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!unchanged(await handle.stat({ bigint: true })))
        throw new W5ServiceHistoryError('invalid-evidence');
      const bytes = Buffer.alloc(Number(inspected.size) + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const read = await handle.read(
          bytes,
          bytesRead,
          bytes.length - bytesRead,
          bytesRead,
        );
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      if (
        bytesRead !== Number(inspected.size) ||
        !unchanged(await handle.stat({ bigint: true })) ||
        !unchanged(await lstat(path, { bigint: true }))
      )
        throw new W5ServiceHistoryError('invalid-evidence');
      const value: unknown = JSON.parse(
        bytes.subarray(0, bytesRead).toString('utf8'),
      );
      return value;
    } finally {
      await handle.close();
    }
  } catch {
    // Once observed, disappearance/replacement is uncertainty, not absence.
    throw new W5ServiceHistoryError('invalid-evidence');
  }
}

/**
 * Publishes complete bytes once; on a retry, flushes existing evidence again
 * so an earlier uncertain directory flush cannot become silent success.
 */
export async function publishW5RootEvidence(
  path: string,
  value: unknown,
  validate: (value: unknown) => void,
  syncDirectory: (path: string) => Promise<unknown>,
): Promise<unknown> {
  const directory = dirname(path);
  const temporary = join(directory, `.evidence-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
    }
    const evidence = await readW5RootEvidence(path);
    validate(evidence);
    const published = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      await published.sync();
    } finally {
      await published.close();
    }
    await syncDirectory(directory);
    const current = await readW5RootEvidence(path);
    validate(current);
    if (!isDeepStrictEqual(current, evidence))
      throw new W5ServiceHistoryError('invalid-evidence');
    return current;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function validateHistory(
  value: unknown,
  scope: W5RootEvidenceScope,
): asserts value is W5ServiceHistory {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isW5RootEvidenceScope(value.scope) ||
    value.priorHistory !== 'unknown' ||
    typeof value.historyId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.historyId) ||
    typeof value.firstServiceAt !== 'string' ||
    !Number.isFinite(Date.parse(value.firstServiceAt))
  )
    throw new W5ServiceHistoryError('invalid-evidence');
  if (!sameW5RootEvidenceScope(value.scope, scope))
    throw new W5ServiceHistoryError('scope-mismatch');
}

async function historyScope(
  scope: W5RootEvidenceScope,
  relocation: W5ServiceHistoryRelocation | undefined,
): Promise<W5RootEvidenceScope> {
  if (!relocation) return scope;
  const transition = relocationTransition(relocation.transition);
  if (
    scope.canonicalDataRoot !== transition.to.canonicalDataRoot ||
    (relocation.sourceHistory !== undefined &&
      relocation.sourceHistory.scope.canonicalDataRoot !==
        transition.from.canonicalDataRoot)
  )
    throw new W5ServiceHistoryError('scope-mismatch');
  await relocation.admit(transition, scope);
  await requireW5RootEvidenceScope(scope);
  return relocation.sourceHistory?.scope ?? scope;
}

function snapshotRelocation(
  relocation: W5ServiceHistoryRelocation | undefined,
): W5ServiceHistoryRelocation | undefined {
  if (!relocation) return undefined;
  let sourceHistory: W5ServiceHistory | undefined;
  if (relocation.sourceHistory !== undefined) {
    const snapshot: unknown = JSON.parse(
      JSON.stringify(relocation.sourceHistory),
    );
    validateHistory(snapshot, relocation.sourceHistory.scope);
    sourceHistory = snapshot;
  }
  return {
    transition: relocationTransition(relocation.transition),
    sourceHistory,
    admit: relocation.admit.bind(relocation),
  };
}

function validateRelocatedHistory(
  value: unknown,
  expectedScope: W5RootEvidenceScope,
  relocation: W5ServiceHistoryRelocation | undefined,
): asserts value is W5ServiceHistory {
  validateHistory(value, expectedScope);
  if (
    relocation?.sourceHistory !== undefined &&
    !isDeepStrictEqual(value, relocation.sourceHistory)
  )
    throw new W5ServiceHistoryError('invalid-evidence');
}

export async function readW5ServiceHistory(
  dataRoot: string,
  options?: W5ServiceHistoryRelocation,
): Promise<W5ServiceHistory | undefined> {
  const relocation = snapshotRelocation(options);
  const scope = Object.freeze(await w5RootEvidenceScope(dataRoot));
  const expectedScope = await historyScope(scope, relocation);
  const directory = join(scope.canonicalDataRoot, 'w5');
  // Never follow a redirected evidence directory.
  try {
    if ((await realpath(directory)) !== directory)
      throw new W5ServiceHistoryError('scope-mismatch');
  } catch (error) {
    if (errno(error) === 'ENOENT') {
      if (relocation?.sourceHistory !== undefined)
        throw new W5ServiceHistoryError('invalid-evidence');
      return undefined;
    }
    throw error;
  }
  const value = await readW5RootEvidence(
    join(directory, 'daemon-service-history.json'),
  );
  if (value === undefined) {
    if (relocation?.sourceHistory !== undefined)
      throw new W5ServiceHistoryError('invalid-evidence');
    return undefined;
  }
  validateRelocatedHistory(value, expectedScope, relocation);
  await historyScope(scope, relocation);
  return value;
}

/** Called under startup/endpoint protection before every recovery-capable worker start. */
export async function ensureW5ServiceHistory(
  canonicalDataRoot: string,
  syncDirectory: (path: string) => Promise<unknown>,
  options?: W5ServiceHistoryRelocation,
): Promise<void> {
  try {
    const relocation = snapshotRelocation(options);
    const scope = Object.freeze(await w5RootEvidenceScope(canonicalDataRoot));
    if (scope.canonicalDataRoot !== resolve(canonicalDataRoot))
      throw new W5ServiceHistoryError('scope-mismatch');
    const expectedScope = await historyScope(scope, relocation);
    const directory = join(canonicalDataRoot, 'w5');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await realpath(directory)) !== directory)
      throw new W5ServiceHistoryError('scope-mismatch');
    if (relocation?.sourceHistory !== undefined)
      await readW5ServiceHistory(canonicalDataRoot, relocation);
    const history: W5ServiceHistory = relocation?.sourceHistory ?? {
      version: 1,
      scope,
      firstServiceAt: new Date().toISOString(),
      historyId: randomUUID(),
      priorHistory: 'unknown',
    };
    const published = await publishW5RootEvidence(
      join(directory, 'daemon-service-history.json'),
      history,
      (value) => validateRelocatedHistory(value, expectedScope, relocation),
      syncDirectory,
    );
    await syncDirectory(canonicalDataRoot);
    await syncDirectory(dirname(canonicalDataRoot));
    await requireW5RootEvidenceScope(scope);
    if (
      !isDeepStrictEqual(
        await readW5ServiceHistory(canonicalDataRoot, relocation),
        published,
      )
    )
      throw new W5ServiceHistoryError('invalid-evidence');
  } catch (error) {
    if (error instanceof W5ServiceHistoryError) throw error;
    throw new W5ServiceHistoryError('publication-failed');
  }
}

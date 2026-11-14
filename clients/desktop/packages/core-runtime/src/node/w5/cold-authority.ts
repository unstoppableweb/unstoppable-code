import { assertStorageWriteAllowed, STORAGE_OWNERSHIP } from '../../storage';
import { bindW5Storage, type W5StorageAdmission } from './storage-binding';
import type { W5CommitLogRequest } from './commit-log/worker-contract';
import {
  requireW5RootEvidenceScope,
  w5RootEvidenceScope,
  type W5RootEvidenceScope,
} from './service-history';

export type W5ColdOperation =
  | 'diagnose'
  | 'reopen'
  | 'resolve'
  | 'restore'
  | 'backup-bootstrap';

export class W5ColdAuthorityRefusedError extends Error {
  constructor(
    readonly reason:
      | 'authority-not-held'
      | 'scope-mismatch'
      | 'authority-retired'
      | 'ownership-inconsistent',
    readonly underlying?: unknown,
  ) {
    super(`W5 cold authority refused (${reason}).`);
    this.name = 'W5ColdAuthorityRefusedError';
  }
}

async function requireScope(scope: W5RootEvidenceScope): Promise<void> {
  try {
    await requireW5RootEvidenceScope(scope);
  } catch (error) {
    throw new W5ColdAuthorityRefusedError('scope-mismatch', error);
  }
}

async function requireExclusion(
  assertExclusion: () => Promise<void>,
): Promise<void> {
  try {
    await assertExclusion();
  } catch (error) {
    throw new W5ColdAuthorityRefusedError('authority-not-held', error);
  }
}

/** Possession alone is insufficient: every use revalidates live host exclusion. */
export interface W5ColdAuthority {
  readonly kind: 'w5-cold-authority';
}
interface ColdState {
  readonly scope: W5RootEvidenceScope;
  readonly operation: W5ColdOperation;
  readonly assertExclusion: () => Promise<void>;
}
const authorities = new WeakMap<W5ColdAuthority, ColdState>();

/**
 * Trusted cold composition only. The host supplies startup/lifetime, historical
 * peer, migration and effect exclusion; no ordinary daemon/client can mint it.
 */
export async function createW5ColdAuthority(options: {
  readonly canonicalDataRoot: string;
  readonly operation: W5ColdOperation;
  readonly assertExclusion: () => Promise<void>;
}): Promise<{ readonly authority: W5ColdAuthority; revoke(): void }> {
  const { canonicalDataRoot, operation, assertExclusion } = options;
  await requireExclusion(assertExclusion);
  let scope: W5RootEvidenceScope;
  try {
    scope = await w5RootEvidenceScope(canonicalDataRoot);
  } catch (error) {
    throw new W5ColdAuthorityRefusedError('scope-mismatch', error);
  }
  if (scope.canonicalDataRoot !== canonicalDataRoot)
    throw new W5ColdAuthorityRefusedError('scope-mismatch');
  await requireExclusion(assertExclusion);
  await requireScope(scope);
  const authority: W5ColdAuthority = Object.freeze({
    kind: 'w5-cold-authority',
  });
  authorities.set(authority, {
    scope,
    operation,
    assertExclusion,
  });
  return {
    authority,
    revoke: () => {
      authorities.delete(authority);
    },
  };
}

export async function requireW5ColdAuthority(
  authority: W5ColdAuthority,
  canonicalDataRoot: string,
  operation: W5ColdOperation,
): Promise<void> {
  const state = authorities.get(authority);
  if (
    !state ||
    state.scope.canonicalDataRoot !== canonicalDataRoot ||
    state.operation !== operation
  )
    throw new W5ColdAuthorityRefusedError('authority-not-held');
  await requireExclusion(state.assertExclusion);
  await requireScope(state.scope);
  if (authorities.get(authority) !== state)
    throw new W5ColdAuthorityRefusedError('authority-retired');
  await requireExclusion(state.assertExclusion);
  await requireScope(state.scope);
  if (authorities.get(authority) !== state)
    throw new W5ColdAuthorityRefusedError('authority-retired');
}

/** Core-owned restore admission, never a process-global Electron bypass. */
export async function withW5ColdRestoreStorage<T>(
  authority: W5ColdAuthority,
  canonicalDataRoot: string,
  admit: W5StorageAdmission,
  run: () => Promise<T>,
): Promise<T> {
  await requireW5ColdAuthority(authority, canonicalDataRoot, 'restore');
  const namespaces = [
    'workspace_index',
    'workspace_manifest',
    'worktree_list',
  ] as const;
  const owners = namespaces.map(
    (id) => STORAGE_OWNERSHIP.find((row) => row.id === id)?.transitionOwner,
  );
  // Never admit a partial transfer. Legacy is retained only until all three move.
  const writer = owners.every((owner) => owner === 'daemon')
    ? 'daemon'
    : owners.every((owner) => owner === 'legacy')
      ? 'electron_main'
      : undefined;
  if (!writer) throw new W5ColdAuthorityRefusedError('ownership-inconsistent');
  for (const namespace of namespaces)
    assertStorageWriteAllowed(namespace, writer, STORAGE_OWNERSHIP);
  return admit(bindW5Storage(writer, admit).project, async () => {
    await requireW5ColdAuthority(authority, canonicalDataRoot, 'restore');
    return run();
  });
}

/** Only the held internal-root transaction may extend reopen's read-only calls. */
export interface W5InternalRootSettlement {
  readonly source: string;
  readonly transactionId: string;
  readonly assertHeld: () => Promise<void>;
  readonly abandonCommits: readonly number[];
}

interface ColdHostState {
  readonly authority: W5ColdAuthority;
  readonly operation: W5ColdOperation;
  readonly internalRootSettlement?: W5InternalRootSettlement;
}
const coldHosts = new WeakMap<object, ColdHostState>();

/** A warm worker does not retain authority after its cold binding retires. */
export async function admitW5ColdHostRequest(
  host: object,
  canonicalDataRoot: string,
  request: W5CommitLogRequest,
): Promise<void> {
  const state = coldHosts.get(host);
  if (!state || state.operation === 'diagnose')
    throw new W5ColdAuthorityRefusedError('authority-not-held');
  const { method } = request;
  const commit = request.args[0];
  const settlement = state.internalRootSettlement;
  const migrationPermitted =
    settlement !== undefined &&
    (method === 'capture' ||
      (method === 'commit' &&
        typeof commit === 'object' &&
        commit !== null &&
        'operation' in commit &&
        commit.operation === 'internal-root-migration.adopt-legacy-metadata') ||
      (method === 'abandonRecoveryRequiredCommit' &&
        typeof commit === 'number' &&
        settlement.abandonCommits.includes(commit)));
  const permitted =
    migrationPermitted ||
    method === 'snapshot' ||
    (state.operation !== 'backup-bootstrap' && method === 'recoveryReport') ||
    (state.operation === 'resolve' &&
      (method === 'resolveRecovery' ||
        method === 'retryRecoveryRequiredCommit' ||
        method === 'abandonRecoveryRequiredCommit')) ||
    (state.operation === 'restore' &&
      method === 'commit' &&
      typeof commit === 'object' &&
      commit !== null &&
      'operation' in commit &&
      commit.operation === 'w5.backup.restore');
  if (!permitted) throw new W5ColdAuthorityRefusedError('authority-not-held');
  if (settlement) await requireExclusion(settlement.assertHeld);
  if (!(await admitW5ColdHost(host, canonicalDataRoot, [state.operation])))
    throw new W5ColdAuthorityRefusedError('authority-not-held');
  if (coldHosts.get(host) !== state)
    throw new W5ColdAuthorityRefusedError('authority-retired');
}

/** No binding permits ordinary admission; an invalid binding never falls back. */
export async function admitW5ColdHost(
  host: object,
  canonicalDataRoot: string,
  operations?: readonly W5ColdOperation[],
): Promise<boolean> {
  const state = coldHosts.get(host);
  if (!state) return false;
  if (operations && !operations.includes(state.operation))
    throw new W5ColdAuthorityRefusedError('authority-not-held');
  await requireW5ColdAuthority(
    state.authority,
    canonicalDataRoot,
    state.operation,
  );
  if (coldHosts.get(host) !== state)
    throw new W5ColdAuthorityRefusedError('authority-retired');
  return true;
}

/** The trusted composition must confirm worker exit before releasing exclusion. */
export async function withW5ColdHost<T>(
  authority: W5ColdAuthority,
  canonicalDataRoot: string,
  operation: W5ColdOperation,
  host: object,
  run: () => Promise<T>,
  internalRootSettlement?: W5InternalRootSettlement,
): Promise<T> {
  const settlement =
    internalRootSettlement &&
    Object.freeze({
      source: internalRootSettlement.source,
      transactionId: internalRootSettlement.transactionId,
      assertHeld: internalRootSettlement.assertHeld,
      abandonCommits: Object.freeze([...internalRootSettlement.abandonCommits]),
    });
  if (
    settlement &&
    (operation !== 'reopen' ||
      settlement.source !== canonicalDataRoot ||
      !settlement.transactionId.trim() ||
      settlement.abandonCommits.some(
        (id) => !Number.isSafeInteger(id) || id < 1,
      ))
  )
    throw new W5ColdAuthorityRefusedError('authority-not-held');
  if (settlement) await requireExclusion(settlement.assertHeld);
  await requireW5ColdAuthority(authority, canonicalDataRoot, operation);
  if (coldHosts.has(host))
    throw new W5ColdAuthorityRefusedError('authority-not-held');
  const state = { authority, operation, internalRootSettlement: settlement };
  coldHosts.set(host, state);
  try {
    const result = await run();
    if (settlement) await requireExclusion(settlement.assertHeld);
    await requireW5ColdAuthority(authority, canonicalDataRoot, operation);
    return result;
  } finally {
    if (coldHosts.get(host) === state) coldHosts.delete(host);
  }
}

import { randomUUID } from 'node:crypto';
import type {
  VaultAdmission,
  VaultBlockReason,
  VaultEntryMetadata,
  VaultFamilyWriter,
  VaultMutationFailure,
  VaultRepository,
  VaultSecretPin,
} from '../../vault/contracts';
import type {
  GitHubCredentialAdmission,
  GitHubCredentialFenceReadFailure,
  GitHubCredentialUse,
  GitHubCredentialReason,
  GitHubCredentialResolution,
  GitHubCredentialSource,
} from '../git/github-credential-lease';

export interface GitHubCredentialIdentity {
  readonly brandId: string;
  /** Compiled product build (stable, rc, internal or dev), not an artifact ID. */
  readonly build: string;
}
export interface GitHubCredentialFence {
  readonly source: GitHubCredentialIdentity;
  readonly pin: VaultSecretPin;
  /** Generation of legacy ciphertext, never a digest of the PAT. */
  readonly legacyGeneration: string;
}
export interface GitHubCredentialFenceStore {
  /** Missing or well-formed rejected records return null; read failures throw. */
  read(): Promise<GitHubCredentialFence | null>;
  write(fence: GitHubCredentialFence): Promise<void>;
}

/** Only an errno-shaped code survives; anything else becomes read_failed. */
export function fenceReadFailureFromCode(
  code: unknown,
): GitHubCredentialFenceReadFailure {
  return typeof code === 'string' && /^E[A-Z0-9]{1,31}$/.test(code)
    ? `E${code.slice(1)}`
    : 'read_failed';
}

/** Carries only content-free diagnostics across the fence-store boundary. */
export class GitHubCredentialFenceReadError extends Error {
  readonly reason: GitHubCredentialFenceReadFailure;
  constructor(reason: GitHubCredentialFenceReadFailure) {
    super('Credential fence read unavailable.');
    this.reason = reason.startsWith('E')
      ? fenceReadFailureFromCode(reason)
      : reason;
  }
}
export interface GitHubCredentialWrite {
  readonly source: GitHubCredentialIdentity;
  readonly legacyGeneration: string;
  readonly material: Uint8Array;
}
export type GitHubCredentialMutation =
  | { readonly kind: 'committed' }
  | { readonly kind: 'unchanged' }
  | Exclude<GitHubCredentialResolution, { readonly kind: 'available' }>;
export interface GitHubCredentialAuthority extends GitHubCredentialSource {
  set(input: GitHubCredentialWrite): Promise<GitHubCredentialMutation>;
  clear(): Promise<GitHubCredentialMutation>;
  importIfAbsent(
    input: GitHubCredentialWrite,
  ): Promise<GitHubCredentialMutation>;
}
export interface GitHubCredentialAuthorityOptions {
  /** The daemon's own trusted composition identity, never a peer's. */
  readonly identity: GitHubCredentialIdentity;
  readonly repository: () => Promise<VaultRepository>;
  /** Trusted throttled, prompt-free probe when a write finds no held key. */
  readonly probeKeyIfDue: () => Promise<void>;
  /** Minted once by trusted daemon composition; this authority retains it. */
  readonly writer: () => Promise<VaultFamilyWriter>;
  readonly fences: GitHubCredentialFenceStore;
  /** A2 supplies the real legacy ciphertext generation reader. Null means gone. */
  readonly legacyGeneration: (
    source: GitHubCredentialIdentity,
  ) => Promise<string | null>;
}

type Failure = Exclude<
  GitHubCredentialResolution,
  { readonly kind: 'available' }
>;
const blocked = (
  reason: Exclude<GitHubCredentialReason, 'absent' | 'stale'>,
  fenceReadFailure?: GitHubCredentialFenceReadFailure,
): Failure =>
  fenceReadFailure
    ? { kind: 'blocked', reason, fenceReadFailure }
    : { kind: 'blocked', reason };
const absent = (reason: 'absent' | 'stale'): Failure => ({
  kind: 'absent',
  reason,
});
function blockReason(
  reason: VaultBlockReason,
): Exclude<GitHubCredentialReason, 'absent' | 'stale'> {
  return reason === 'corrupt' || reason === 'expired' ? 'unavailable' : reason;
}
function admission(outcome: VaultAdmission): GitHubCredentialAdmission {
  switch (outcome.kind) {
    case 'admitted':
      return outcome;
    case 'stale':
    case 'revoked':
      return { kind: 'refused', reason: 'stale' };
    case 'unconfirmed':
      return { kind: 'refused', reason: 'unconfirmed' };
    case 'blocked':
      return { kind: 'refused', reason: blockReason(outcome.reason) };
  }
}
function mutationFailure(outcome: VaultMutationFailure): Failure {
  switch (outcome.kind) {
    case 'not_found':
      return absent('absent');
    case 'outcome_unknown':
      return blocked('unconfirmed');
    case 'refused':
      return blocked(
        outcome.reason === 'managed_family' ? 'denied' : 'unconfirmed',
      );
    case 'unavailable':
      return outcome.step && outcome.io
        ? {
            kind: 'blocked',
            reason: 'unavailable',
            storage: { step: outcome.step, io: outcome.io },
          }
        : blocked('unavailable');
    default:
      return blocked('unconfirmed');
  }
}
function sameIdentity(
  a: GitHubCredentialIdentity,
  b: GitHubCredentialIdentity,
): boolean {
  return a.brandId === b.brandId && a.build === b.build;
}
function samePin(a: VaultSecretPin, b: VaultSecretPin): boolean {
  return (
    a.ref.vaultId === b.ref.vaultId &&
    a.ref.entryId === b.ref.entryId &&
    a.revision === b.revision
  );
}

export function createGitHubCredentialAuthority(
  options: GitHubCredentialAuthorityOptions,
): GitHubCredentialAuthority {
  const identity = Object.freeze({
    brandId: options.identity.brandId,
    build: options.identity.build,
  });
  const identityBound = Boolean(
    identity.brandId.trim() && identity.build.trim(),
  );
  let tail: Promise<unknown> = Promise.resolve();
  let writer: VaultFamilyWriter | undefined;
  const locallyUnconfirmed = new Set<string>();
  function serial<T>(run: () => Promise<T>, unavailable: T): Promise<T> {
    const operation = tail.then(run).catch(() => unavailable);
    tail = operation;
    return operation;
  }
  async function familyWriter(): Promise<VaultFamilyWriter> {
    writer ??= await options.writer();
    if (writer.family !== 'github-pat')
      throw new Error('Wrong credential writer.');
    return writer;
  }
  async function entries(
    repository: VaultRepository,
  ): Promise<readonly VaultEntryMetadata[]> {
    return (await repository.list()).filter(
      (entry) => entry.family === 'github-pat',
    );
  }
  async function remove(
    entry: VaultEntryMetadata,
  ): Promise<{ readonly kind: 'committed' } | Failure> {
    // Delete closes admission without loading the key. Fence read failures
    // never reach here: they block resolution and keep the credential.
    const result = await (
      await familyWriter()
    ).delete({
      ref: entry.ref,
      expectedRevision: entry.revision,
      idempotencyKey: randomUUID(),
    });
    if (result.kind === 'committed' || result.kind === 'not_found') {
      locallyUnconfirmed.delete(entry.ref.entryId);
      return { kind: 'committed' };
    }
    return mutationFailure(result);
  }
  async function lookup(
    repository: VaultRepository,
  ): Promise<{ readonly entry: VaultEntryMetadata } | Failure> {
    const rows = await entries(repository);
    if (!rows.length) return absent('absent');
    // Never pick a winner from a damaged family singleton.
    if (rows.length !== 1) return blocked('unconfirmed');
    const entry = rows[0];
    if (!entry) return absent('absent');
    let fence: GitHubCredentialFence | null;
    try {
      fence = await options.fences.read();
    } catch (error) {
      // Only a missing fence (null) is unbound; a failed read deletes nothing.
      return blocked(
        'unavailable',
        error instanceof GitHubCredentialFenceReadError
          ? error.reason
          : 'read_failed',
      );
    }
    const bound =
      fence &&
      sameIdentity(fence.source, identity) &&
      samePin(fence.pin, { ref: entry.ref, revision: entry.revision });
    const generation = bound ? await options.legacyGeneration(identity) : null;
    if (
      !fence ||
      !bound ||
      generation === null ||
      generation !== fence.legacyGeneration
    ) {
      const deleted = await remove(entry);
      return deleted.kind === 'committed' ? absent('stale') : deleted;
    }
    if (locallyUnconfirmed.has(entry.ref.entryId))
      return blocked('unconfirmed');
    return { entry };
  }
  async function admit(
    pin: VaultSecretPin,
  ): Promise<GitHubCredentialAdmission> {
    const repository = await options.repository();
    const found = await lookup(repository);
    if (!('entry' in found))
      return found.kind === 'blocked' && found.fenceReadFailure
        ? {
            kind: 'refused',
            reason: found.reason,
            fenceReadFailure: found.fenceReadFailure,
          }
        : { kind: 'refused', reason: found.reason };
    if (!samePin(pin, { ref: found.entry.ref, revision: found.entry.revision }))
      return { kind: 'refused', reason: 'stale' };
    return admission(repository.admit(pin));
  }
  function write(
    input: GitHubCredentialWrite,
    createOnly: boolean,
  ): Promise<GitHubCredentialMutation> {
    // Snapshot before queueing: the caller may zero its buffer immediately.
    const material = Uint8Array.from(input.material);
    const source = { ...input.source };
    const generation = input.legacyGeneration;
    return serial<GitHubCredentialMutation>(async () => {
      if (!identityBound || !sameIdentity(source, identity))
        return blocked('denied');
      if (!generation || !material.length || material.length > 1_000_000)
        return blocked('denied');
      const current = await options.legacyGeneration(identity);
      if (current === null || current !== generation) return absent('stale');
      const repository = await options.repository();
      const rows = await entries(repository);
      if (rows.length > 1) return blocked('unconfirmed');
      if (createOnly && rows.length) return { kind: 'unchanged' };
      const entry = rows[0];
      if (repository.status().protection.state !== 'available')
        await options.probeKeyIfDue();
      const result = await (
        await familyWriter()
      ).put({
        ...(entry
          ? { ref: entry.ref, expectedRevision: entry.revision }
          : { entryId: null, expectedRevision: null, family: 'github-pat' }),
        label: 'GitHub',
        material,
        expiresAt: null,
        idempotencyKey: randomUUID(),
      });
      if (result.kind === 'blocked') return blocked(blockReason(result.reason));
      if (result.kind !== 'committed') return mutationFailure(result);
      // Put commits first. Until the atomic fence write, the old/missing fence
      // mismatches this revision: every crash between the two deletes on resolve.
      locallyUnconfirmed.add(result.pin.ref.entryId);
      try {
        await options.fences.write({
          source: identity,
          pin: result.pin,
          legacyGeneration: generation,
        });
      } catch {
        return blocked('unconfirmed');
      }
      locallyUnconfirmed.delete(result.pin.ref.entryId);
      return { kind: 'committed' };
    }, blocked('unavailable')).finally(() => material.fill(0));
  }
  return {
    resolve: (purpose) =>
      serial<GitHubCredentialResolution>(async () => {
        if (!identityBound) return blocked('denied');
        if (purpose !== 'git-push' && purpose !== 'git-fetch')
          return blocked('denied');
        const repository = await options.repository();
        const found = await lookup(repository);
        if (!('entry' in found)) return found;
        const read = await repository.get(found.entry.ref);
        if (read.kind === 'not_found') return absent('absent');
        if (read.kind === 'unconfirmed') return blocked('unconfirmed');
        if (read.kind === 'blocked') return blocked(blockReason(read.reason));
        let delivered = false;
        try {
          const checked = await admit(read.pin);
          if (checked.kind !== 'admitted')
            return checked.reason === 'absent' || checked.reason === 'stale'
              ? absent(checked.reason)
              : blocked(checked.reason, checked.fenceReadFailure);
          delivered = true;
          return {
            kind: 'available',
            material: read.material,
            admit: <T>(use: () => T): Promise<GitHubCredentialUse<T>> =>
              serial<GitHubCredentialUse<T>>(
                async () => {
                  const checked = await admit(read.pin);
                  return checked.kind === 'admitted'
                    ? { kind: 'admitted', value: use() }
                    : checked;
                },
                { kind: 'refused', reason: 'unavailable' },
              ),
          };
        } finally {
          if (!delivered) read.material.fill(0);
        }
      }, blocked('unavailable')),
    set: (input) => write(input, false),
    importIfAbsent: (input) => write(input, true),
    clear: () =>
      serial<GitHubCredentialMutation>(async () => {
        if (!identityBound) return blocked('denied');
        const repository = await options.repository();
        for (const entry of await entries(repository)) {
          const result = await remove(entry);
          if (result.kind !== 'committed') return result;
        }
        // A retained fence names a deleted ref and cannot authorize a new create.
        return { kind: 'committed' };
      }, blocked('unavailable')),
  };
}

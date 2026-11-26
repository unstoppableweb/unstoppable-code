import { randomUUID } from 'node:crypto';
import type {
  VaultBlockReason,
  VaultEntryMetadata,
  VaultFamilyWriter,
  VaultRepository,
  VaultSecretPin,
} from '../../vault/contracts';
import { readCloudAccountRecord, type CloudAccountRecord } from './record';

/** The vault family holding the whole Cloud account (CAN-6997). */
export const CLOUD_ACCOUNT_VAULT_FAMILY = 'cloud-account';

/** Only the daemon owns this record; there is no client writer transfer. */
export type CloudAccountCustodyState = 'active';

export interface CloudAccountConnectReceipt {
  readonly credentialDigest: string;
  /** The credential state observed before the command's first probe. */
  readonly credentialGeneration: number;
  readonly completed: boolean;
}

/** Verified facts, atomically bound to the held credential generation. */
export interface CloudAccountProvenance {
  readonly credentialGeneration: number;
  readonly credential: 'unknown' | 'accepted' | 'rejected' | 'forbidden';
  readonly membership: boolean;
  readonly policy: boolean;
}

export interface CloudAccountCustodyDocument {
  readonly version: 1;
  /** Trusted Cloud endpoint and namespace binding, never supplied by a client. */
  readonly endpointAuthority: string | null;
  readonly state: CloudAccountCustodyState;
  /**
   * Advances on credential or account identity changes and sign-out.
   * Snapshot-only provisioning and refresh keep the generation. Brokered
   * requests carry the generation they used, so a late rejection cannot expire a replacement credential.
   */
  readonly credentialGeneration: number;
  readonly record: CloudAccountRecord | null;
  /** Old documents may instead carry recorded snapshot validity. */
  readonly provenance?: CloudAccountProvenance;
  /**
   * Connect command fences/results, atomically committed with custody. Oldest
   * write first; bounded to the 64 most recent.
   */
  readonly connectReceipts?: Readonly<
    Record<string, CloudAccountConnectReceipt>
  >;
}

export interface CloudAccountCustodyPin {
  readonly pin: VaultSecretPin;
}

export type CloudAccountCustodyUnavailable =
  | Exclude<VaultBlockReason, 'expired'>
  | 'unconfirmed'
  | 'ambiguous'
  | 'endpoint_mismatch'
  | 'malformed';

export type CloudAccountCustodyRead =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'ok';
      readonly document: CloudAccountCustodyDocument;
      readonly pin: CloudAccountCustodyPin;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: CloudAccountCustodyUnavailable;
    };

export type CloudAccountCustodyCommit =
  | {
      readonly kind: 'committed';
      readonly document: CloudAccountCustodyDocument;
      readonly pin: CloudAccountCustodyPin;
    }
  /** Another write won the compare-and-swap; nothing was written. */
  | { readonly kind: 'superseded' }
  | {
      readonly kind: 'unavailable';
      readonly reason: CloudAccountCustodyUnavailable;
    }
  /** May have committed; the caller must re-read rather than retry blindly. */
  | { readonly kind: 'outcome_unknown' };

export interface CloudAccountCustody {
  read(): Promise<CloudAccountCustodyRead>;
  /**
   * Compare-and-swap on the vault revision. `expected` null creates the only
   * entry and fails as superseded when one exists.
   */
  commit(input: {
    readonly expected: CloudAccountCustodyPin | null;
    readonly state: CloudAccountCustodyState;
    readonly credentialGeneration: number;
    readonly record: CloudAccountRecord | null;
    readonly provenance?: CloudAccountProvenance;
    readonly connectReceipts?: Readonly<
      Record<string, CloudAccountConnectReceipt>
    >;
    readonly signal?: AbortSignal;
  }): Promise<CloudAccountCustodyCommit>;
  /**
   * Replaces unreadable custody, corrupt entries included, with a fresh
   * signed-out entry (the daemon's counterpart of the app's quarantine reset).
   * Transient blocks such as a locked key are not reset, and a readable entry
   * is unchanged.
   */
  resetUnreadable(
    credentialGeneration: number,
    signal?: AbortSignal,
  ): Promise<CloudAccountCustodyReset>;
}

export interface CloudAccountCustodyOptions {
  /** Null only for a Cloud-less/test composition. Unbound records cannot travel. */
  readonly endpointAuthority?: string | null;
  readonly repository: () => Promise<VaultRepository>;
  /** Minted once by trusted daemon composition for this family only. */
  readonly writer: () => Promise<VaultFamilyWriter>;
  /** Trusted throttled, prompt-free probe when a write finds no held key. */
  readonly probeKeyIfDue?: () => Promise<void>;
}

/**
 * Labels are metadata the vault returns without decrypting, so the custody
 * state stays knowable when the material is unreadable: an unreadable active
 * entry is replaced, and the family is never left absent.
 */
const LABELS: Readonly<Record<CloudAccountCustodyState, string>> = {
  active: 'Cloud account',
};

function stateOfLabel(label: string): CloudAccountCustodyState | null {
  if (label === LABELS.active) return 'active';
  return null;
}

/** Unreadable reasons a reset may replace; the others are transient. */
const RESETTABLE: ReadonlySet<CloudAccountCustodyUnavailable> = new Set([
  'malformed',
  'ambiguous',
  'corrupt',
  'key_missing',
  'endpoint_mismatch',
]);

export type CloudAccountCustodyReset =
  | { readonly kind: 'absent' }
  | { readonly kind: 'readable' }
  | CloudAccountCustodyCommit;

const MAX_CONNECT_RECEIPTS = 64;

/**
 * Records a command's receipt as the most recent. Key order is recency: a
 * 64-hex command id is never an integer-like key, so it keeps insertion order.
 */
export function withConnectReceipt(
  receipts: CloudAccountCustodyDocument['connectReceipts'],
  commandId: string,
  receipt: CloudAccountConnectReceipt,
): Readonly<Record<string, CloudAccountConnectReceipt>> {
  const others = Object.entries(receipts ?? {}).filter(
    ([command]) => command !== commandId,
  );
  return Object.fromEntries([...others, [commandId, receipt]]);
}

/**
 * Keeps the most recently written receipts, whatever their outcome, so later
 * failed attempts cannot evict a newer completed one. Evicted commands are
 * fresh explicit sign-ins requiring a live probe.
 */
function retainedConnectReceipts(
  receipts: CloudAccountCustodyDocument['connectReceipts'],
): Readonly<Record<string, CloudAccountConnectReceipt>> {
  return Object.fromEntries(
    Object.entries(receipts ?? {}).slice(-MAX_CONNECT_RECEIPTS),
  );
}

function encode(
  document: {
    readonly state: CloudAccountCustodyState;
    readonly credentialGeneration: number;
    readonly record: CloudAccountRecord | null;
    readonly provenance?: CloudAccountProvenance;
    readonly connectReceipts?: Readonly<
      Record<string, CloudAccountConnectReceipt>
    >;
  },
  endpointAuthority: string | null,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      endpointAuthority,
      state: document.state,
      credentialGeneration: document.credentialGeneration,
      entry: document.record
        ? {
            ...document.record.entry,
            // Daemon custody has no detachment-handoff consumer. Desktop owns
            // its independent pending handoffs; retain only daemon membership.
            organizationAccessLossState: document.record
              .organizationAccessLossState
              ? { ...document.record.organizationAccessLossState, pending: [] }
              : undefined,
          }
        : null,
      provenance: document.provenance,
      connectReceipts: retainedConnectReceipts(document.connectReceipts),
    }),
  );
}

function decodeProvenance(
  value: unknown,
  generation: number,
): CloudAccountProvenance | undefined {
  if (value === undefined) return undefined;
  const unverified: CloudAccountProvenance = {
    credentialGeneration: generation,
    credential: 'unknown',
    membership: false,
    policy: false,
  };
  if (typeof value !== 'object' || value === null) return unverified;
  const credential: unknown = Reflect.get(value, 'credential');
  const membership: unknown = Reflect.get(value, 'membership');
  const policy: unknown = Reflect.get(value, 'policy');
  if (
    Reflect.get(value, 'credentialGeneration') !== generation ||
    (credential !== 'unknown' &&
      credential !== 'accepted' &&
      credential !== 'rejected' &&
      credential !== 'forbidden') ||
    typeof membership !== 'boolean' ||
    typeof policy !== 'boolean'
  )
    return unverified;
  return Object.freeze({
    credentialGeneration: generation,
    credential,
    membership,
    policy,
  });
}

function decode(material: Uint8Array): CloudAccountCustodyDocument | null {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(material),
    );
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const version: unknown = Reflect.get(value, 'version');
  const endpointAuthority: unknown =
    Reflect.get(value, 'endpointAuthority') ?? null;
  const state: unknown = Reflect.get(value, 'state');
  const generation: unknown = Reflect.get(value, 'credentialGeneration');
  const entry: unknown = Reflect.get(value, 'entry');
  const receipts: unknown = Reflect.get(value, 'connectReceipts') ?? {};
  if (
    typeof receipts !== 'object' ||
    receipts === null ||
    Array.isArray(receipts)
  )
    return null;
  const connectReceipts: Record<string, CloudAccountConnectReceipt> = {};
  for (const [command, payload] of Object.entries(receipts)) {
    if (
      !/^[a-f0-9]{64}$/.test(command) ||
      typeof payload !== 'object' ||
      payload === null
    )
      return null;
    const credentialDigest: unknown = Reflect.get(payload, 'credentialDigest');
    const credentialGeneration: unknown = Reflect.get(
      payload,
      'credentialGeneration',
    );
    const completed: unknown = Reflect.get(payload, 'completed');
    if (
      typeof credentialDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(credentialDigest) ||
      typeof credentialGeneration !== 'number' ||
      !Number.isSafeInteger(credentialGeneration) ||
      credentialGeneration < 0 ||
      typeof completed !== 'boolean'
    )
      return null;
    connectReceipts[command] = Object.freeze({
      credentialDigest,
      credentialGeneration,
      completed,
    });
  }

  if (
    version !== 1 ||
    (endpointAuthority !== null && typeof endpointAuthority !== 'string') ||
    state !== 'active' ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  )
    return null;
  if (entry === null)
    return Object.freeze({
      version: 1,
      endpointAuthority,
      state,
      credentialGeneration: generation,
      connectReceipts: Object.freeze(connectReceipts),
      record: null,
    });
  const rawProvenance: unknown = Reflect.get(value, 'provenance');
  const provenance = decodeProvenance(rawProvenance, generation);
  const record = readCloudAccountRecord(entry);
  return record
    ? Object.freeze({
        version: 1,
        endpointAuthority,
        state,
        credentialGeneration: generation,
        connectReceipts: Object.freeze(connectReceipts),
        record,
        ...(provenance ? { provenance } : {}),
      })
    : null;
}

/**
 * Whole-account custody over one entry of the daemon vault. It is a store, not
 * a policy owner: identity, guest and probe fences live in the authority.
 * Material copies are zeroed as soon as they are decoded or written.
 */
export function createCloudAccountCustody(
  options: CloudAccountCustodyOptions,
): CloudAccountCustody {
  const endpointAuthority = options.endpointAuthority ?? null;
  // The vault mints a family writer once: share one request, retry a failure.
  // Null when the vault could not mint one (typed by callers). A writer for
  // another family is a composition bug and still throws.
  let writer: Promise<VaultFamilyWriter> | undefined;
  async function familyWriter(): Promise<VaultFamilyWriter | null> {
    writer ??= options.writer().catch((error: unknown) => {
      writer = undefined;
      throw error;
    });
    let minted: VaultFamilyWriter;
    try {
      minted = await writer;
    } catch {
      return null;
    }
    if (minted.family !== CLOUD_ACCOUNT_VAULT_FAMILY)
      throw new Error('Wrong credential writer.');
    return minted;
  }
  // A thrown vault (disposed, unopened, or refusing this family a writer) is
  // a typed failure, never an exception to the authority's callers.
  const VAULT_THREW = Object.freeze({
    kind: 'unavailable',
    reason: 'unavailable',
  } as const);
  async function entries(
    repository: VaultRepository,
  ): Promise<readonly VaultEntryMetadata[]> {
    return (await repository.list()).filter(
      (entry) => entry.family === CLOUD_ACCOUNT_VAULT_FAMILY,
    );
  }

  async function read(): Promise<CloudAccountCustodyRead> {
    try {
      return await readHeld();
    } catch {
      return VAULT_THREW;
    }
  }

  async function readHeld(): Promise<CloudAccountCustodyRead> {
    const repository = await options.repository();
    const held = await entries(repository);
    if (held.length === 0) return { kind: 'absent' };
    // Two entries mean an interrupted create; never pick one by order.
    if (held.length > 1) return { kind: 'unavailable', reason: 'ambiguous' };
    const [metadata] = held;
    if (!metadata) return { kind: 'absent' };
    const outcome = await repository.get(metadata.ref);
    switch (outcome.kind) {
      case 'not_found':
        return { kind: 'absent' };
      case 'unconfirmed':
        return { kind: 'unavailable', reason: 'unconfirmed' };
      case 'blocked':
        return {
          kind: 'unavailable',
          reason: outcome.reason === 'expired' ? 'unavailable' : outcome.reason,
        };
      case 'available': {
        const document = decode(outcome.material);
        outcome.material.fill(0);
        if (document && document.endpointAuthority !== endpointAuthority)
          return { kind: 'unavailable', reason: 'endpoint_mismatch' };
        return document && stateOfLabel(metadata.label) === document.state
          ? { kind: 'ok', document, pin: { pin: outcome.pin } }
          : { kind: 'unavailable', reason: 'malformed' };
      }
    }
  }

  type CommitInput = Parameters<CloudAccountCustody['commit']>[0];

  async function commit(
    input: CommitInput,
  ): Promise<CloudAccountCustodyCommit> {
    if (
      !Number.isSafeInteger(input.credentialGeneration) ||
      input.credentialGeneration < 0
    )
      throw new TypeError('Invalid credential generation.');
    if (input.expected === null) {
      const current = await read();
      if (current.kind !== 'absent')
        return current.kind === 'unavailable'
          ? current
          : { kind: 'superseded' };
    }
    return write(input);
  }

  /** One put: a create when `expected` is null, else a revision CAS. */
  async function write(input: CommitInput): Promise<CloudAccountCustodyCommit> {
    const familyWriterValue = await familyWriter();
    if (!familyWriterValue) return VAULT_THREW;
    input.signal?.throwIfAborted();
    const material = encode(input, endpointAuthority);
    const put = (): ReturnType<VaultFamilyWriter['put']> =>
      familyWriterValue.put({
        label: LABELS[input.state],
        material,
        expiresAt: null,
        idempotencyKey: randomUUID(),
        ...(input.expected
          ? {
              ref: input.expected.pin.ref,
              expectedRevision: input.expected.pin.revision,
            }
          : {
              entryId: null,
              expectedRevision: null,
              family: CLOUD_ACCOUNT_VAULT_FAMILY,
            }),
      });
    const attempt = async (): Promise<
      Awaited<ReturnType<typeof put>> | { readonly kind: 'outcome_unknown' }
    > => {
      input.signal?.throwIfAborted();
      try {
        return await put();
      } catch {
        // Cancellation cannot roll back a put already initiated.
        return { kind: 'outcome_unknown' };
      }
    };
    try {
      let outcome = await attempt();
      if (outcome.kind === 'blocked' && options.probeKeyIfDue) {
        await options.probeKeyIfDue().catch(() => undefined);
        outcome = await attempt();
      }
      switch (outcome.kind) {
        case 'committed': {
          const document = decode(material);
          if (!document) return { kind: 'outcome_unknown' };
          return { kind: 'committed', document, pin: { pin: outcome.pin } };
        }
        case 'revision_conflict':
        case 'superseded':
        case 'not_found':
          return { kind: 'superseded' };
        case 'blocked':
          return { kind: 'unavailable', reason: outcome.reason };
        case 'outcome_unknown':
          return { kind: 'outcome_unknown' };
        case 'unavailable':
          return { kind: 'unavailable', reason: 'unavailable' };
        case 'refused':
          return {
            kind: 'unavailable',
            reason:
              outcome.reason === 'managed_family' ? 'denied' : 'unconfirmed',
          };
        case 'idempotency_conflict':
          return { kind: 'outcome_unknown' };
      }
    } finally {
      material.fill(0);
    }
  }

  /** Deletes one prior entry; a delete needs no key and is never blocked. */
  async function remove(metadata: VaultEntryMetadata): Promise<boolean> {
    const familyWriterValue = await familyWriter();
    if (!familyWriterValue) return false;
    try {
      const outcome = await familyWriterValue.delete({
        ref: metadata.ref,
        expectedRevision: metadata.revision,
        idempotencyKey: randomUUID(),
      });
      return outcome.kind === 'committed' || outcome.kind === 'not_found';
    } catch {
      return false;
    }
  }

  async function resetUnreadable(
    credentialGeneration: number,
    signal?: AbortSignal,
  ): Promise<CloudAccountCustodyReset> {
    if (!Number.isSafeInteger(credentialGeneration) || credentialGeneration < 0)
      throw new TypeError('Invalid credential generation.');
    let held: readonly VaultEntryMetadata[];
    try {
      held = await entries(await options.repository());
    } catch {
      return VAULT_THREW;
    }
    if (held.length === 0) return { kind: 'absent' };
    const current = await read();
    if (current.kind === 'absent') return { kind: 'absent' };
    if (current.kind === 'ok') return { kind: 'readable' };
    if (!RESETTABLE.has(current.reason)) return current;
    // An entry this family never labelled cannot be classified safely.
    if (held.some((metadata) => stateOfLabel(metadata.label) === null))
      return { kind: 'unavailable', reason: 'ambiguous' };
    // The vault refuses a put over a corrupt entry; its recovery is delete and
    // create. Create first, so the family is never absent: an absent family
    // would restart the credential generation. An interrupted reset reads
    // ambiguous and can be repeated; no backup of the old entry is kept.
    const replaced = await write({
      expected: null,
      state: 'active',
      credentialGeneration,
      record: null,
      ...(signal ? { signal } : {}),
    });
    if (replaced.kind !== 'committed') return replaced;
    // Not cancellable once the fresh entry exists: cleanup completes the reset.
    // A failed cleanup has already changed custody, so its outcome is unknown.
    for (const metadata of held)
      if (!(await remove(metadata))) return { kind: 'outcome_unknown' };
    return replaced;
  }

  return { read, commit, resetUnreadable };
}

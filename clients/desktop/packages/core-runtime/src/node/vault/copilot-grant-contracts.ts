import { VaultSecretPinSchema } from '@canopy/protocol/canopy-core';
import {
  CopilotHostSelectionSchema,
  type CopilotHostSelection,
} from '@canopy/protocol/copilot-selection';
import type {
  VaultFamilyWriter,
  VaultRepository,
  VaultSecretPin,
} from '../../vault/contracts';

export interface CopilotVaultAccount {
  host: string;
  login: string;
  id: string;
}
/** Internal custody DTO. Never a protocol result or recipient lease. */
export interface CopilotVaultGrant extends CopilotVaultAccount {
  version: 1;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}
interface CopilotGrantBinding {
  operationId: string;
  epoch: string;
  account: CopilotVaultAccount;
  origin: 'setup' | 'import';
}
export interface CopilotGrantHead extends CopilotGrantBinding {
  pin: VaultSecretPin;
  pinGeneration: string;
}
export interface CopilotGrantMutation extends CopilotGrantBinding {
  kind: 'create' | 'refresh' | 'replace' | 'delete';
  from: VaultSecretPin | null;
  committed: VaultSecretPin | null;
  probeConfirmed: boolean;
  cancelling: boolean;
}
export interface CopilotSetupLineageWitness {
  version: 1;
  /**
   * 'retired': the exact disabled receipt of the head the successor delete retired.
   * 'cancelled': the exact receipt that survived, the predecessor or the successor's own.
   */
  predecessor: CopilotHostSelection;
  /** 'retired': the completed delete; otherwise the setup successor. */
  successor: { operationId: string; epoch: string };
  phase: 'creating' | 'cancelling' | 'cancelled' | 'retired';
}
export interface CopilotAuthorityRecord {
  version: 1 | 2;
  sequence: number;
  head: CopilotGrantHead | null;
  mutation: CopilotGrantMutation | null;
  removal: { operationId: string; epoch: string } | null;
  completed: {
    operationId: string;
    epoch: string;
    kind: 'replace' | 'delete';
  } | null;
  /** Required in v2; forbidden in v1. Authenticated continuity, never grant material. */
  setupLineage?: CopilotSetupLineageWitness | null;
}

type Validation<T> = { success: true; data: T } | { success: false };
interface CustodySchema<T> {
  safeParse(value: unknown): Validation<T>;
  parse(value: unknown): T;
}
function custodySchema<T>(
  valid: (value: unknown) => value is T,
): CustodySchema<T> {
  function safeParse(value: unknown): Validation<T> {
    let snapshot: unknown;
    try {
      snapshot = structuredClone(value);
    } catch {
      return { success: false };
    }
    return valid(snapshot)
      ? { success: true, data: snapshot }
      : { success: false };
  }
  return {
    safeParse,
    parse(value): T {
      const parsed = safeParse(value);
      if (!parsed.success) throw new Error('Invalid Copilot custody record.');
      return parsed.data;
    },
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
function text(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function account(value: unknown): value is CopilotVaultAccount {
  return (
    object(value) &&
    exact(value, ['host', 'login', 'id']) &&
    accountFields(value)
  );
}
function accountFields(value: Record<string, unknown>): boolean {
  return (
    text(value.host) &&
    text(value.login) &&
    typeof value.id === 'string' &&
    /^[0-9]{1,128}$/.test(value.id)
  );
}
function datetime(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    )
  )
    return false;
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00.000Z`);
  return (
    Number.isFinite(Date.parse(value)) &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().startsWith(day)
  );
}
export const CopilotVaultGrantSchema = custodySchema<CopilotVaultGrant>(
  (value): value is CopilotVaultGrant =>
    object(value) &&
    exact(value, [
      'host',
      'login',
      'id',
      'version',
      'clientId',
      'accessToken',
      'refreshToken',
      'accessTokenExpiresAt',
      'refreshTokenExpiresAt',
    ]) &&
    accountFields(value) &&
    value.version === 1 &&
    text(value.clientId) &&
    text(value.accessToken, 100_000) &&
    text(value.refreshToken, 100_000) &&
    datetime(value.accessTokenExpiresAt) &&
    datetime(value.refreshTokenExpiresAt) &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= 1_000_000,
);
function binding(value: Record<string, unknown>): boolean {
  return (
    text(value.operationId) &&
    text(value.epoch) &&
    account(value.account) &&
    (value.origin === 'setup' || value.origin === 'import')
  );
}
function pin(value: unknown): value is VaultSecretPin {
  return VaultSecretPinSchema.safeParse(value).success;
}
function head(value: unknown): value is CopilotGrantHead {
  return (
    object(value) &&
    exact(value, [
      'operationId',
      'epoch',
      'account',
      'origin',
      'pin',
      'pinGeneration',
    ]) &&
    binding(value) &&
    pin(value.pin) &&
    text(value.pinGeneration)
  );
}
function mutation(value: unknown): value is CopilotGrantMutation {
  return (
    object(value) &&
    exact(value, [
      'operationId',
      'epoch',
      'account',
      'origin',
      'kind',
      'from',
      'committed',
      'probeConfirmed',
      'cancelling',
    ]) &&
    binding(value) &&
    (value.kind === 'create' ||
      value.kind === 'refresh' ||
      value.kind === 'replace' ||
      value.kind === 'delete') &&
    (value.from === null || pin(value.from)) &&
    (value.committed === null || pin(value.committed)) &&
    typeof value.probeConfirmed === 'boolean' &&
    typeof value.cancelling === 'boolean'
  );
}
function removal(
  value: unknown,
): value is NonNullable<CopilotAuthorityRecord['removal']> {
  return (
    object(value) &&
    exact(value, ['operationId', 'epoch']) &&
    text(value.operationId) &&
    text(value.epoch)
  );
}
function completed(
  value: unknown,
): value is NonNullable<CopilotAuthorityRecord['completed']> {
  return (
    object(value) &&
    exact(value, ['operationId', 'epoch', 'kind']) &&
    text(value.operationId) &&
    text(value.epoch) &&
    (value.kind === 'replace' || value.kind === 'delete')
  );
}
function lineage(value: unknown): value is CopilotSetupLineageWitness {
  if (
    !object(value) ||
    !exact(value, ['version', 'predecessor', 'successor', 'phase']) ||
    value.version !== 1 ||
    !removal(value.successor) ||
    (value.phase !== 'creating' &&
      value.phase !== 'cancelling' &&
      value.phase !== 'cancelled' &&
      value.phase !== 'retired')
  )
    return false;
  const predecessor = CopilotHostSelectionSchema.safeParse(value.predecessor);
  if (!predecessor.success || predecessor.data.state !== 'disabled')
    return false;
  const { identity, pin } = predecessor.data;
  if (identity.operationId === value.successor.operationId)
    // Only a cancellation can leave the successor's own receipt as the survivor.
    return (
      value.phase === 'cancelled' &&
      identity.epoch === value.successor.epoch &&
      identity.origin === 'setup'
    );
  return value.phase === 'retired'
    ? pin !== null && identity.epoch === value.successor.epoch
    : identity.epoch !== value.successor.epoch;
}
function lineageMatches(record: Record<string, unknown>): boolean {
  if (record.version === 1) return true;
  const witness = record.setupLineage;
  if (witness === null) return true;
  if (!lineage(witness) || record.head !== null) return false;
  const successor = witness.successor;
  if (witness.phase === 'retired')
    return (
      record.mutation === null &&
      record.removal === null &&
      completed(record.completed) &&
      record.completed.kind === 'delete' &&
      !record.completed.operationId.endsWith(':cancel') &&
      record.completed.operationId === successor.operationId &&
      record.completed.epoch === successor.epoch
    );
  if (witness.phase === 'cancelled')
    return (
      record.mutation === null &&
      completed(record.completed) &&
      record.completed.kind === 'delete' &&
      record.completed.operationId === `${successor.operationId}:cancel` &&
      record.completed.epoch === successor.epoch
    );
  const m = record.mutation;
  return (
    mutation(m) &&
    m.origin === 'setup' &&
    m.epoch === successor.epoch &&
    (witness.phase === 'creating'
      ? m.kind === 'create' &&
        !m.cancelling &&
        m.operationId === successor.operationId
      : (m.kind === 'create' &&
          m.cancelling &&
          m.operationId === successor.operationId) ||
        (m.kind === 'delete' &&
          m.operationId === `${successor.operationId}:cancel`))
  );
}
export const CopilotAuthorityRecordSchema =
  custodySchema<CopilotAuthorityRecord>(
    (value): value is CopilotAuthorityRecord =>
      object(value) &&
      exact(value, [
        'version',
        'sequence',
        'head',
        'mutation',
        'removal',
        'completed',
        ...(value.version === 2 ? ['setupLineage'] : []),
      ]) &&
      (value.version === 1 || value.version === 2) &&
      typeof value.sequence === 'number' &&
      Number.isSafeInteger(value.sequence) &&
      value.sequence >= 0 &&
      (value.head === null || head(value.head)) &&
      (value.mutation === null || mutation(value.mutation)) &&
      (value.removal === null || removal(value.removal)) &&
      (value.completed === null || completed(value.completed)) &&
      lineageMatches(value),
  );

/** Redacted journal failure; adapters must distinguish corrupt/missing authority. */
export class CopilotAuthorityJournalError extends Error {
  constructor(readonly reason: 'corrupt' | 'unconfirmed' | 'unavailable') {
    super('Copilot authority journal unavailable.');
    this.name = 'CopilotAuthorityJournalError';
  }
}

export interface CopilotAuthorityJournal {
  /** Trusted store composition only: currently holds the exclusive writer connection. */
  readonly lifetime?: { readonly familyId?: string; isExclusive(): boolean };
  /** Validated, integrity-protected state; absence/corruption must throw CopilotAuthorityJournalError, not reset. */
  read(): Promise<CopilotAuthorityRecord>;
  /** Atomic, durable CAS. A lost reply must be resolved by read, not a new identity. */
  compareExchange(
    expectedSequence: number,
    next: CopilotAuthorityRecord,
  ): Promise<boolean>;
  /** P1 resolves the exact family/idempotency identity after repository reconciliation. */
  reconcile(
    operationId: string,
  ): Promise<
    | { readonly kind: 'committed'; readonly pin: VaultSecretPin }
    | { readonly kind: 'not_accepted' }
    | { readonly kind: 'retryable' }
    | { readonly kind: 'unconfirmed' }
  >;
}

export interface CopilotSelectionRequest {
  readonly operationId: string;
  readonly epoch: string;
  readonly account: CopilotVaultAccount;
  readonly pin: VaultSecretPin;
  readonly origin: 'setup' | 'import';
}
export interface CopilotSelectionReceipt extends CopilotSelectionRequest {
  readonly pinGeneration: string;
}
export interface CopilotSelectionPort {
  /** Trusted host-owned disabled receipt; P4 checkpoints it with the successor intent. */
  setupPredecessor?(): Promise<CopilotHostSelection | undefined>;
  /** Exact prepared-intent CAS only. Reject uncertain cleanup so cancellation can retry. */
  abandon?(identity: CopilotGrantBinding): Promise<void>;
  /**
   * Lineage composition only: the durable disabled receipt left after this
   * setup's cancellation; P4 commits it as the cancelled witness. A failed
   * read rejects so cancellation retries.
   */
  cancelledReceipt?(
    identity: CopilotGrantBinding,
  ): Promise<CopilotHostSelection | undefined>;
  /**
   * Idempotently publish/reconcile this exact setup pin, or the P7 handoff.
   * A lost acknowledgement is unconfirmed. Account equality is insufficient.
   */
  confirm(
    request: CopilotSelectionRequest,
  ): Promise<
    | { readonly kind: 'confirmed'; readonly receipt: CopilotSelectionReceipt }
    | { readonly kind: 'unconfirmed' | 'superseded' }
  >;
  /**
   * CAS-disable only this epoch/pin generation; unrelated preferences are immaterial.
   * A lineage composition returns the durable disabled receipt; P4 retires it into the v2 witness.
   */
  disable(request: {
    readonly operationId: string;
    readonly head: CopilotGrantHead;
  }): Promise<
    | { readonly kind: 'disabled'; readonly receipt?: CopilotHostSelection }
    | { readonly kind: 'failed' | 'unconfirmed' }
  >;
}

export type CopilotGrantFailure = {
  readonly kind: 'blocked';
  readonly reason:
    | 'absent'
    | 'changed'
    | 'busy'
    | 'unconfirmed'
    | 'locked'
    | 'corrupt'
    | 'unavailable'
    | 'denied'
    | 'key_missing'
    | 'expired'
    | 'network'
    /** The refresh port threw; distinct from a reported network loss. */
    | 'refresh_failed';
};
export type CopilotGrantResult =
  | CopilotGrantFailure
  | { readonly kind: 'ready'; readonly head: CopilotGrantHead }
  | {
      readonly kind: 'pending';
      readonly operationId: string;
      readonly operation: {
        readonly kind: CopilotGrantMutation['kind'] | 'remove';
        readonly origin: CopilotGrantHead['origin'];
      };
    }
  | { readonly kind: 'removed' }
  | {
      readonly kind: 'delivered';
      readonly expiresAt: number;
      readonly committedPin: VaultSecretPin | null;
    };

export interface CopilotGrantAuthorityOptions {
  /** Trusted, exclusive daemon composition only. Production keeps the family reserved. */
  readonly repository: () => Promise<VaultRepository>;
  readonly writer: () => Promise<VaultFamilyWriter>;
  readonly probeKeyIfDue: () => Promise<void>;
  readonly journal: CopilotAuthorityJournal;
  /** Stable trusted owner token across factories in one family lifetime; never a wire input. */
  readonly familyLifetime?: object;
  /** Trusted process composition only. Default is this process's singleton, never a reset hook. */
  readonly processLifetime?: object;
  readonly selection: CopilotSelectionPort;
  /** Trusted device/identity adapter supplies setup material; probe must be real entitlement. */
  readonly probe: (
    accessToken: string,
    account: CopilotVaultAccount,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly refresh: (
    grant: CopilotVaultGrant,
    signal: AbortSignal,
  ) => Promise<
    | { readonly kind: 'success'; readonly grant: CopilotVaultGrant }
    | { readonly kind: 'rejected' }
    | { readonly kind: 'lost' }
  >;
  /** P5-owned access-only recipient, fixed by composition, never supplied by a wire caller. */
  readonly recipient: {
    admitted(
      handle: string,
      head: CopilotGrantHead,
      generation: number,
    ): boolean;
    deliver(handle: string, accessToken: string, expiresAt: number): void;
    revoke(): void;
  };
  readonly now?: () => number;
}

export interface CopilotVaultGrantAuthority {
  /** Trusted setup/migration ingress, not exposed on core.vault.*. Creates a new lineage. */
  create(
    grant: CopilotVaultGrant,
    origin: 'setup' | 'import',
    /** Synchronous redacted identity of this call's proposed CAS, before its acknowledgement. */
    onCheckpoint?: (operationId: string) => void,
    /** Caller cancellation fences setup publication, including after the probe. */
    signal?: AbortSignal,
  ): Promise<CopilotGrantResult>;
  /** Same operation across storage uncertainty, process restart and lost pin acknowledgement. */
  resume(operationId: string): Promise<CopilotGrantResult>;
  status(): Promise<CopilotGrantResult>;
  /** Supported demand only: exact local recovery/admission, never provider presentation. */
  demand(): Promise<CopilotGrantResult>;
  /** Synchronous, redacted live admission facts for the fixed local recipient. */
  recipientGeneration(): number | undefined;
  cancel(operationId: string): Promise<CopilotGrantResult>;
  present(handle: string, expectedEpoch: string): Promise<CopilotGrantResult>;
  /** Closes recipient admission synchronously, retaining an owned pending successor. */
  revoke(): void;
  /** Terminal admission fence; waits at most two seconds for already-owned rotation work. */
  quiesce(): Promise<void>;
  /** A new runtime generation does not change account authority. */
  reopen(): void;
  remove(expectedEpoch: string): Promise<CopilotGrantResult>;
  /** Explicit user removal of the currently pending operation, without secret material. */
  removePending(operationId: string): Promise<CopilotGrantResult>;
}

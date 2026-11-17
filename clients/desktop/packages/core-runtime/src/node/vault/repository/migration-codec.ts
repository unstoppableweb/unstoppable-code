import { createHmac, timingSafeEqual } from 'node:crypto';
import { VaultSecretPinSchema } from '@canopy/protocol/canopy-core';
import type { VaultSecretPin } from '../../../vault/contracts';
import { isWellFormedText } from './canonical-encoding';
import { withVaultSubkey, type VaultSubkeys } from './vault-keys';

export const MIGRATION_IMPORT_PREFIX = 'copilot-migration:';
export interface MigrationIdentity {
  readonly brand: string;
  readonly build: string;
  readonly sourceFlavor: string;
  readonly sourceMode: string;
  readonly slot: 'copilot-account';
  readonly generation: string;
}
export interface MigrationUseReceipt {
  readonly id: string;
  readonly pin: VaultSecretPin;
  readonly successorKeys: readonly string[];
  readonly provenance?: string;
}
export interface MigrationDeletion {
  readonly id: string;
  readonly generation: string;
  readonly phase: 'authorized' | 'submitted' | 'completed';
  readonly completionId: string | null;
}
export interface MigrationAttempt {
  readonly id: string;
  readonly identity: MigrationIdentity;
  readonly epoch: number;
  readonly state:
    | 'not_started'
    | 'imported_unverified'
    | 'verified'
    | 'legacy_deleted';
  readonly disposition:
    | 'prepared'
    | 'accepted'
    | 'not_committed'
    | 'committed'
    | 'cancelled';
  readonly destination: {
    readonly entryId: string;
    readonly importRevision: number | null;
  } | null;
  readonly use: MigrationUseReceipt | null;
  readonly deletion: MigrationDeletion | null;
  readonly cancellationReason: string | null;
}
export interface MigrationJournal {
  readonly version: 1;
  readonly vaultId: string;
  readonly revision: number;
  readonly head: {
    readonly epoch: number;
    readonly attemptId: string | null;
    readonly authority: 'fenced' | 'vault' | 'cleared';
  };
  readonly attempts: readonly MigrationAttempt[];
}

export function invalidMigration(): never {
  throw new Error('Migration metadata is unavailable.');
}
function object(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    return invalidMigration();
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (!isWellFormedText(value) || value.length < 1 || value.length > 4096)
    return invalidMigration();
  return value;
}
function uint(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return invalidMigration();
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  return choices.find((item) => item === value) ?? invalidMigration();
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1024) return invalidMigration();
  return value;
}
export function migrationIdentity(value: unknown): MigrationIdentity {
  const row = object(value, [
    'brand',
    'build',
    'sourceFlavor',
    'sourceMode',
    'slot',
    'generation',
  ]);
  return {
    brand: text(row.brand),
    build: text(row.build),
    sourceFlavor: text(row.sourceFlavor),
    sourceMode: text(row.sourceMode),
    slot: choice(row.slot, ['copilot-account']),
    generation: text(row.generation),
  };
}
export function migrationUse(value: unknown): MigrationUseReceipt {
  const hasProvenance =
    typeof value === 'object' && value !== null && 'provenance' in value;
  const row = object(
    value,
    hasProvenance
      ? ['id', 'pin', 'successorKeys', 'provenance']
      : ['id', 'pin', 'successorKeys'],
  );
  const pin = VaultSecretPinSchema.safeParse(row.pin);
  if (!pin.success) return invalidMigration();
  return {
    id: text(row.id),
    pin: pin.data,
    successorKeys: array(row.successorKeys).map(text),
    ...(hasProvenance ? { provenance: text(row.provenance) } : {}),
  };
}
function attempt(value: unknown, vaultId: string): MigrationAttempt {
  const row = object(value, [
    'id',
    'identity',
    'epoch',
    'state',
    'disposition',
    'destination',
    'use',
    'deletion',
    'cancellationReason',
  ]);
  let destination: MigrationAttempt['destination'] = null;
  if (row.destination !== null) {
    const dest = object(row.destination, ['entryId', 'importRevision']);
    const entryId = text(dest.entryId);
    // Reuse the vault's exact reference bounds, not a migration-specific approximation.
    if (
      !VaultSecretPinSchema.safeParse({
        ref: { vaultId, entryId },
        revision: 0,
      }).success
    )
      return invalidMigration();
    destination = {
      entryId,
      importRevision:
        dest.importRevision === null ? null : uint(dest.importRevision),
    };
  }
  let deletion: MigrationDeletion | null = null;
  if (row.deletion !== null) {
    const del = object(row.deletion, [
      'id',
      'generation',
      'phase',
      'completionId',
    ]);
    deletion = {
      id: text(del.id),
      generation: text(del.generation),
      phase: choice(del.phase, ['authorized', 'submitted', 'completed']),
      completionId: del.completionId === null ? null : text(del.completionId),
    };
  }
  const parsed: MigrationAttempt = {
    id: text(row.id),
    identity: migrationIdentity(row.identity),
    epoch: uint(row.epoch),
    state: choice(row.state, [
      'not_started',
      'imported_unverified',
      'verified',
      'legacy_deleted',
    ]),
    disposition: choice(row.disposition, [
      'prepared',
      'accepted',
      'not_committed',
      'committed',
      'cancelled',
    ]),
    destination,
    use: row.use === null ? null : migrationUse(row.use),
    deletion,
    cancellationReason:
      row.cancellationReason === null ? null : text(row.cancellationReason),
  };
  if (
    parsed.id.length > 128 ||
    (parsed.disposition === 'cancelled') !==
      (parsed.cancellationReason !== null) ||
    (parsed.disposition === 'prepared' && destination !== null) ||
    (['prepared', 'accepted', 'not_committed'].includes(parsed.disposition) &&
      parsed.state !== 'not_started') ||
    (['accepted', 'not_committed'].includes(parsed.disposition) &&
      destination?.importRevision !== null) ||
    (parsed.disposition === 'committed' && parsed.state === 'not_started') ||
    (parsed.disposition !== 'prepared' &&
      parsed.disposition !== 'cancelled' &&
      destination === null) ||
    (parsed.state !== 'not_started' && destination?.importRevision !== 0) ||
    (parsed.state !== 'not_started' &&
      !['committed', 'cancelled'].includes(parsed.disposition)) ||
    (parsed.state === 'verified' || parsed.state === 'legacy_deleted') !==
      (parsed.use !== null) ||
    (parsed.use !== null &&
      (parsed.use.pin.ref.vaultId !== vaultId ||
        parsed.use.pin.ref.entryId !== destination?.entryId)) ||
    (deletion !== null &&
      (parsed.use === null ||
        deletion.generation !== parsed.identity.generation)) ||
    (deletion !== null &&
      (deletion.phase === 'completed') !== (deletion.completionId !== null)) ||
    (parsed.state === 'legacy_deleted') !== (deletion?.phase === 'completed')
  )
    return invalidMigration();
  return parsed;
}
export function migrationJournal(
  value: unknown,
  vaultId: string,
): MigrationJournal {
  const row = object(value, [
    'version',
    'vaultId',
    'revision',
    'head',
    'attempts',
  ]);
  if (row.version !== 1 || row.vaultId !== vaultId) return invalidMigration();
  const head = object(row.head, ['epoch', 'attemptId', 'authority']);
  const parsed: MigrationJournal = {
    version: 1,
    vaultId,
    revision: uint(row.revision),
    head: {
      epoch: uint(head.epoch),
      attemptId: head.attemptId === null ? null : text(head.attemptId),
      authority: choice(head.authority, ['fenced', 'vault', 'cleared']),
    },
    attempts: array(row.attempts).map((value) => attempt(value, vaultId)),
  };
  const ids = new Set(parsed.attempts.map((item) => item.id));
  const generations = new Set(
    parsed.attempts.map((item) => JSON.stringify(item.identity)),
  );
  const current = parsed.attempts.find(
    (item) => item.id === parsed.head.attemptId,
  );
  if (
    ids.size !== parsed.attempts.length ||
    generations.size !== parsed.attempts.length ||
    parsed.attempts.some((item) => item.epoch > parsed.head.epoch) ||
    (parsed.head.authority === 'cleared'
      ? parsed.head.attemptId !== null
      : !current ||
        current.epoch !== parsed.head.epoch ||
        current.disposition === 'cancelled') ||
    (parsed.head.authority === 'vault' && current?.state === 'not_started') ||
    (current?.use !== null &&
      current?.use !== undefined &&
      parsed.head.authority !== 'vault') ||
    parsed.attempts.some(
      (item) =>
        item.id !== parsed.head.attemptId &&
        item.disposition !== 'cancelled' &&
        item.state !== 'legacy_deleted',
    )
  )
    return invalidMigration();
  return parsed;
}
function mac(keys: VaultSubkeys, payload: string): Buffer {
  return withVaultSubkey(keys, 'receipt', (key) =>
    createHmac('sha256', key)
      .update('canopy/vault/copilot-migration/v1\0')
      .update(payload, 'utf8')
      .digest(),
  );
}
export function encodeMigrationJournal(
  keys: VaultSubkeys,
  journal: MigrationJournal,
): string {
  const payload = JSON.stringify(migrationJournal(journal, keys.vaultId));
  return JSON.stringify({ payload, mac: mac(keys, payload).toString('hex') });
}
export function decodeMigrationJournal(
  keys: VaultSubkeys,
  stored: string,
): MigrationJournal {
  if (stored.length > 1_048_576) return invalidMigration();
  try {
    const envelope = object(JSON.parse(stored), ['payload', 'mac']);
    if (
      typeof envelope.payload !== 'string' ||
      typeof envelope.mac !== 'string' ||
      !/^[0-9a-f]{64}$/.test(envelope.mac)
    )
      return invalidMigration();
    if (
      !timingSafeEqual(
        mac(keys, envelope.payload),
        Buffer.from(envelope.mac, 'hex'),
      )
    )
      return invalidMigration();
    return migrationJournal(JSON.parse(envelope.payload), keys.vaultId);
  } catch {
    return invalidMigration();
  }
}

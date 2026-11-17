import { createHmac, timingSafeEqual } from 'node:crypto';
import { VaultSecretPinSchema } from '@canopy/protocol/canopy-core';
import {
  CopilotAuthorityJournalError,
  CopilotAuthorityRecordSchema,
  type CopilotAuthorityRecord,
  type CopilotVaultAccount,
} from '../copilot-grant-contracts';
import type { VaultSecretPin } from '../../../vault/contracts';
import { isWellFormedText } from './canonical-encoding';
import { migrationIdentity, type MigrationIdentity } from './migration-codec';
import { withVaultSubkey, type VaultSubkeys } from './vault-keys';

export interface CopilotImportBinding {
  readonly attemptId: string;
  readonly migrationEpoch: number;
  readonly operationId: string;
  readonly accountEpoch: string;
  readonly identity: MigrationIdentity;
  readonly account: CopilotVaultAccount;
  readonly predecessorGeneration: string | null;
  readonly phase:
    | 'pre_ingress'
    | 'ingress_accepted'
    | 'committed'
    | 'published'
    | 'cancelling'
    | 'retired';
  readonly destination: VaultSecretPin | null;
}
export interface CopilotRetirementControl {
  readonly kind: 'retirement' | 'deletion';
  readonly operationId: string;
  readonly attemptId: string;
  readonly migrationEpoch: number;
  readonly identity: MigrationIdentity;
  readonly accountEpoch: string;
  readonly destination: VaultSecretPin | null;
  readonly completionId: string | null;
  readonly phase:
    | 'cancelling'
    | 'retired'
    | 'authorized'
    | 'claim_ready'
    | 'source_detached'
    | 'remove_authorized'
    | 'completed';
}
export interface CopilotAuthorityBundle {
  readonly version: 1;
  readonly vaultId: string;
  readonly authority: CopilotAuthorityRecord;
  readonly migrationEpoch: number;
  readonly binding: CopilotImportBinding | null;
  readonly controls: readonly CopilotRetirementControl[];
}
export function corruptCopilotAuthority(): never {
  throw new CopilotAuthorityJournalError('corrupt');
}
function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    return corruptCopilotAuthority();
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (!isWellFormedText(value) || value.length < 1 || value.length > 512)
    return corruptCopilotAuthority();
  return value;
}
function uint(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return corruptCopilotAuthority();
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  return choices.find((item) => item === value) ?? corruptCopilotAuthority();
}
function pin(value: unknown, vaultId: string): VaultSecretPin | null {
  if (value === null) return null;
  const parsed = VaultSecretPinSchema.safeParse(value);
  if (!parsed.success || parsed.data.ref.vaultId !== vaultId)
    return corruptCopilotAuthority();
  text(parsed.data.ref.entryId);
  uint(parsed.data.revision);
  return parsed.data;
}
export function copilotAuthorityBundle(
  value: unknown,
  vaultId: string,
): CopilotAuthorityBundle {
  const input = row(value, [
    'version',
    'vaultId',
    'authority',
    'migrationEpoch',
    'binding',
    'controls',
  ]);
  if (input.version !== 1 || input.vaultId !== vaultId)
    return corruptCopilotAuthority();
  const authority = CopilotAuthorityRecordSchema.parse(input.authority);
  // P4 validates DTO shape; this persistence boundary additionally rejects lossy text and foreign pins.
  function validateTree(value: unknown): void {
    if (typeof value === 'string' && !isWellFormedText(value))
      return corruptCopilotAuthority();
    if (Array.isArray(value)) value.forEach(validateTree);
    else if (typeof value === 'object' && value !== null)
      Object.values(value).forEach(validateTree);
  }
  validateTree(authority);
  for (const value of [
    authority.head?.pin,
    authority.mutation?.from,
    authority.mutation?.committed,
  ])
    if (value) pin(value, vaultId);
  const migrationEpoch = uint(input.migrationEpoch);
  let binding: CopilotImportBinding | null = null;
  if (input.binding !== null) {
    const b = row(input.binding, [
      'attemptId',
      'migrationEpoch',
      'operationId',
      'accountEpoch',
      'identity',
      'account',
      'predecessorGeneration',
      'phase',
      'destination',
    ]);
    const a = row(b.account, ['host', 'login', 'id']);
    const account = {
      host: text(a.host),
      login: text(a.login),
      id: text(a.id),
    };
    if (!/^[0-9]{1,128}$/.test(account.id)) return corruptCopilotAuthority();
    binding = {
      attemptId: text(b.attemptId),
      migrationEpoch: uint(b.migrationEpoch),
      operationId: text(b.operationId),
      accountEpoch: text(b.accountEpoch),
      identity: migrationIdentity(b.identity),
      account,
      predecessorGeneration:
        b.predecessorGeneration === null ? null : text(b.predecessorGeneration),
      phase: choice(b.phase, [
        'pre_ingress',
        'ingress_accepted',
        'committed',
        'published',
        'cancelling',
        'retired',
      ]),
      destination: pin(b.destination, vaultId),
    };
    if (
      binding.migrationEpoch > migrationEpoch ||
      (!['cancelling', 'retired'].includes(binding.phase) &&
        binding.migrationEpoch !== migrationEpoch) ||
      binding.operationId !== `copilot-migration:${binding.attemptId}` ||
      (['committed', 'published'].includes(binding.phase) &&
        binding.destination === null)
    )
      return corruptCopilotAuthority();
    const owner =
      binding.phase === 'published' ? authority.head : authority.mutation;
    if (
      !['cancelling', 'retired'].includes(binding.phase) &&
      (!owner ||
        owner.origin !== 'import' ||
        (binding.phase !== 'published' &&
          owner.operationId !== binding.operationId) ||
        owner.epoch !== binding.accountEpoch ||
        canonicalCopilotJson(owner.account) !== canonicalCopilotJson(account))
    )
      return corruptCopilotAuthority();
    if (
      binding.phase === 'pre_ingress' &&
      (authority.mutation?.probeConfirmed !== false ||
        authority.mutation.kind !== 'create' ||
        authority.mutation.from !== null ||
        authority.mutation.committed !== null)
    )
      return corruptCopilotAuthority();
  }
  if (
    binding &&
    ['ingress_accepted', 'committed'].includes(binding.phase) &&
    (authority.mutation?.kind !== 'create' ||
      authority.mutation.from !== null ||
      !authority.mutation.probeConfirmed ||
      authority.mutation.cancelling)
  )
    return corruptCopilotAuthority();
  if (
    binding?.phase === 'committed' &&
    canonicalCopilotJson(binding.destination) !==
      canonicalCopilotJson(authority.mutation?.committed)
  )
    return corruptCopilotAuthority();
  if (
    binding?.phase === 'published' &&
    (!binding.destination ||
      !authority.head ||
      canonicalCopilotJson(binding.destination.ref) !==
        canonicalCopilotJson(authority.head.pin.ref) ||
      authority.head.pin.revision < binding.destination.revision)
  )
    return corruptCopilotAuthority();
  if (!Array.isArray(input.controls) || input.controls.length > 128)
    return corruptCopilotAuthority();
  const controls = input.controls.map((value): CopilotRetirementControl => {
    const c = row(value, [
      'kind',
      'operationId',
      'attemptId',
      'migrationEpoch',
      'identity',
      'accountEpoch',
      'destination',
      'completionId',
      'phase',
    ]);
    const control: CopilotRetirementControl = {
      kind: choice(c.kind, ['retirement', 'deletion']),
      operationId: text(c.operationId),
      attemptId: text(c.attemptId),
      migrationEpoch: uint(c.migrationEpoch),
      identity: migrationIdentity(c.identity),
      accountEpoch: text(c.accountEpoch),
      destination: pin(c.destination, vaultId),
      completionId: c.completionId === null ? null : text(c.completionId),
      phase: choice(c.phase, [
        'cancelling',
        'retired',
        'authorized',
        'claim_ready',
        'source_detached',
        'remove_authorized',
        'completed',
      ]),
    };
    if (
      control.migrationEpoch > migrationEpoch ||
      (control.phase === 'completed') !== (control.completionId !== null) ||
      (control.kind === 'retirement' &&
        (!['cancelling', 'retired'].includes(control.phase) ||
          control.operationId !== `copilot-migration:${control.attemptId}`)) ||
      (control.kind === 'deletion' &&
        (['cancelling', 'retired'].includes(control.phase) ||
          control.destination === null))
    )
      return corruptCopilotAuthority();
    return control;
  });
  if (new Set(controls.map((c) => c.operationId)).size !== controls.length)
    return corruptCopilotAuthority();
  return { version: 1, vaultId, authority, migrationEpoch, binding, controls };
}
/** Sorted object keys, exact validated DTOs and well-formed text make the JSON injective. */
export function canonicalCopilotJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalCopilotJson).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalCopilotJson(item)}`,
      )
      .join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return corruptCopilotAuthority();
  return encoded;
}
function mac(keys: VaultSubkeys, payload: string): Buffer {
  return withVaultSubkey(keys, 'receipt', (key) =>
    createHmac('sha256', key)
      .update('canopy/vault/copilot-authority/v1\0')
      .update(payload, 'utf8')
      .digest(),
  );
}
const MAX_BYTES = 262144;
export function encodeCopilotAuthority(
  keys: VaultSubkeys,
  value: CopilotAuthorityBundle,
): string {
  const payload = canonicalCopilotJson(
    copilotAuthorityBundle(value, keys.vaultId),
  );
  const encoded = JSON.stringify({
    payload,
    mac: mac(keys, payload).toString('hex'),
  });
  if (Buffer.byteLength(encoded) > MAX_BYTES) return corruptCopilotAuthority();
  return encoded;
}
export function decodeCopilotAuthority(
  keys: VaultSubkeys,
  stored: string,
): CopilotAuthorityBundle {
  try {
    if (Buffer.byteLength(stored) > MAX_BYTES) return corruptCopilotAuthority();
    const envelope = row(JSON.parse(stored), ['payload', 'mac']);
    if (
      typeof envelope.payload !== 'string' ||
      typeof envelope.mac !== 'string' ||
      !/^[0-9a-f]{64}$/.test(envelope.mac) ||
      !timingSafeEqual(
        mac(keys, envelope.payload),
        Buffer.from(envelope.mac, 'hex'),
      )
    )
      return corruptCopilotAuthority();
    if (
      stored !==
      JSON.stringify({ payload: envelope.payload, mac: envelope.mac })
    )
      return corruptCopilotAuthority();
    const parsed = copilotAuthorityBundle(
      JSON.parse(envelope.payload),
      keys.vaultId,
    );
    if (canonicalCopilotJson(parsed) !== envelope.payload)
      return corruptCopilotAuthority();
    return parsed;
  } catch {
    return corruptCopilotAuthority();
  }
}

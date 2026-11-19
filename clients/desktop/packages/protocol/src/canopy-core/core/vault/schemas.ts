import { z } from 'zod';

// Results use `z.object`, so the dispatcher strips undeclared result fields
// (including any planted secret) before they reach the wire. Params, refs and
// error details are strict: the dispatcher forwards a valid error payload
// unchanged, so nothing nested in one may carry extra fields.

const VaultOpaqueIdSchema = z.string().min(1).max(512);
const VaultTimestampSchema = z.iso.datetime({ offset: true });

/** Store-chosen per-entry compare-and-swap value; starts fresh at create. */
export const VaultRevisionSchema = z.number().int().nonnegative();
export type VaultRevision = z.output<typeof VaultRevisionSchema>;

/**
 * Durable, revision-free reference. `vaultId` is minted when an authority's
 * vault is initialized; `entryId` is minted by the store and never reissued.
 */
export const VaultSecretRefSchema = z.strictObject({
  vaultId: VaultOpaqueIdSchema,
  entryId: VaultOpaqueIdSchema,
});
export type VaultSecretRef = z.output<typeof VaultSecretRefSchema>;

/** Binds a reference to one confirmed revision. */
export const VaultSecretPinSchema = z.strictObject({
  ref: VaultSecretRefSchema,
  revision: VaultRevisionSchema,
});
export type VaultSecretPin = z.output<typeof VaultSecretPinSchema>;

/** Bounded identifier; the family allowlist and its writers are V5's. */
export const VaultFamilySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*$/);

export const VaultLabelSchema = z.string().min(1).max(256);

/**
 * Bounded backend identifier, open so web core (ADR 26) can share the wire.
 * Adapters must never report plaintext storage under any identifier.
 */
export const VaultBackendSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

export const VAULT_BACKENDS = {
  macosKeychain: 'macos_keychain',
  windowsCredentialManager: 'windows_credential_manager',
  windowsDpapi: 'windows_dpapi',
  linuxSecretService: 'linux_secret_service',
} as const;

export const VAULT_PROTECTION_UNAVAILABLE_REASONS = [
  'no_backend',
  'unsupported_session',
  'backend_failed',
  'authority_unavailable',
] as const;

/** Closed reason a shipped protection backend did not load; never a message. */
export const VAULT_PROTECTION_LOAD_FAILURES = [
  'identity_mismatch',
  'prepare_failed',
  'aborted',
  'owner_failed',
] as const;
export type VaultProtectionLoadFailure =
  (typeof VAULT_PROTECTION_LOAD_FAILURES)[number];

const lockedProtection = {
  state: z.literal('locked'),
  backend: VaultBackendSchema,
  evidence: z.enum(['reported', 'inferred']),
};
const deniedProtection = {
  state: z.literal('denied'),
  backend: VaultBackendSchema,
};
const unavailableProtection = {
  state: z.literal('unavailable'),
  backend: VaultBackendSchema.nullable(),
  reason: z.enum(VAULT_PROTECTION_UNAVAILABLE_REASONS),
  loadFailure: z.enum(VAULT_PROTECTION_LOAD_FAILURES).optional(),
};

/** Vault-wide protection, served from the last observation; never prompts. */
export const VaultProtectionStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('unknown'),
    backend: VaultBackendSchema.nullable(),
  }),
  z.object({ state: z.literal('available'), backend: VaultBackendSchema }),
  z.object(lockedProtection),
  z.object(deniedProtection),
  z.object(unavailableProtection),
  z.object({ state: z.literal('key_missing'), backend: VaultBackendSchema }),
]);
export type VaultProtectionStatus = z.output<
  typeof VaultProtectionStatusSchema
>;
export type VaultProtectionState = VaultProtectionStatus['state'];

/** The protection that refused a call, as carried in strict error details. */
export const VaultBlockingProtectionSchema = z.discriminatedUnion('state', [
  z.strictObject(lockedProtection),
  z.strictObject(deniedProtection),
  z.strictObject(unavailableProtection),
]);
export type VaultBlockingProtection = z.output<
  typeof VaultBlockingProtectionSchema
>;

/**
 * Closed entry states. `unconfirmed`: a create or replace whose save is not
 * confirmed. `delete_unconfirmed`: a delete whose outcome is not confirmed.
 * In both, no revision of the entry is usable or admitted.
 */
export const VAULT_ENTRY_STATES = [
  'available',
  'locked',
  'denied',
  'unavailable',
  'corrupt',
  'key_missing',
  'expired',
  'unconfirmed',
  'delete_unconfirmed',
] as const;
export const VaultEntryStateSchema = z.enum(VAULT_ENTRY_STATES);
export type VaultEntryState = z.output<typeof VaultEntryStateSchema>;

/** Redacted entry metadata; readable while the backend is locked. */
export const VaultEntryMetadataSchema = z.object({
  ref: VaultSecretRefSchema,
  family: VaultFamilySchema,
  label: VaultLabelSchema,
  revision: VaultRevisionSchema,
  state: VaultEntryStateSchema,
  expiresAt: VaultTimestampSchema.nullable(),
  createdAt: VaultTimestampSchema,
  updatedAt: VaultTimestampSchema,
});
export type VaultEntryMetadata = z.output<typeof VaultEntryMetadataSchema>;

/** Allowlist projection: copies only the redacted metadata fields. */
export function toVaultEntryMetadata(
  record: VaultEntryMetadata,
): VaultEntryMetadata {
  return {
    ref: { vaultId: record.ref.vaultId, entryId: record.ref.entryId },
    family: record.family,
    label: record.label,
    revision: record.revision,
    state: record.state,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export const VAULT_LIST_PAGE_MAX = 500;
const VaultCursorSchema = z.string().min(1).max(2_048);

// Write params carry no `_meta`: every host splits it off before dispatch and
// passes it as request metadata, where the dispatcher requires the idempotency
// key. The composed wire envelope adds `_meta` with a required key to each
// params branch.

export const VaultStatusGetParamsSchema = z.strictObject({});

export const VaultStatusGetResultSchema = z.object({
  protection: VaultProtectionStatusSchema,
  observedAt: VaultTimestampSchema.nullable(),
});
export type VaultStatusGetResult = z.output<typeof VaultStatusGetResultSchema>;

export const VaultEntryListParamsSchema = z.strictObject({
  family: VaultFamilySchema.optional(),
  pageSize: z.number().int().min(1).max(VAULT_LIST_PAGE_MAX).default(100),
  cursor: VaultCursorSchema.optional(),
});

export const VaultEntryListResultSchema = z.object({
  items: z.array(VaultEntryMetadataSchema).max(VAULT_LIST_PAGE_MAX),
  nextCursor: VaultCursorSchema.nullable(),
});
export type VaultEntryListResult = z.output<typeof VaultEntryListResultSchema>;

export const VaultEntryGetParamsSchema = z.strictObject({
  ref: VaultSecretRefSchema,
});

const VaultSecretMaterialSchema = z
  .string()
  .min(1)
  .max(1_000_000)
  .meta({ writeOnly: true });

/** Create: the store mints the entry ID; callers never choose it. */
export const VaultEntryCreateParamsSchema = z.strictObject({
  entryId: z.null(),
  expectedRevision: z.null(),
  family: VaultFamilySchema,
  label: VaultLabelSchema,
  secret: VaultSecretMaterialSchema,
  expiresAt: VaultTimestampSchema.nullable(),
});

/** Replace: compare-and-swap on an existing entry; its family is fixed. */
export const VaultEntryReplaceParamsSchema = z.strictObject({
  ref: VaultSecretRefSchema,
  expectedRevision: VaultRevisionSchema,
  label: VaultLabelSchema,
  secret: VaultSecretMaterialSchema,
  expiresAt: VaultTimestampSchema.nullable(),
});

export const VaultEntryPutParamsSchema = z.union([
  VaultEntryCreateParamsSchema,
  VaultEntryReplaceParamsSchema,
]);
export type VaultEntryPutParams = z.output<typeof VaultEntryPutParamsSchema>;

export const VaultEntryDeleteParamsSchema = z.strictObject({
  ref: VaultSecretRefSchema,
  expectedRevision: VaultRevisionSchema,
});
export type VaultEntryDeleteParams = z.output<
  typeof VaultEntryDeleteParamsSchema
>;

export const VaultEntryDeleteResultSchema = z.object({
  ref: VaultSecretRefSchema,
  tombstoneRevision: VaultRevisionSchema,
  revokedGrantCount: z.number().int().nonnegative(),
});
export type VaultEntryDeleteResult = z.output<
  typeof VaultEntryDeleteResultSchema
>;

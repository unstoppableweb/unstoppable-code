import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { canopyJsonValueSchemaWithin } from '../../errors';
import { inherentOperationErrorSchema } from '../shared';

/**
 * The daemon's own Cloud account record (CAN-6997), separate from any
 * client's sign-in. A client provisions it from its own sign-in, so one
 * desktop sign-in serves both; the daemon then refreshes it on its own and
 * uses it for runs that outlive the client. The daemon authority is the only
 * writer of this record, and no client writes go through it.
 *
 * No result, event or error carries the credential. Clients see a SHA-256
 * digest of it, so a client can tell whether the daemon holds the credential
 * it holds. The digest is not an authentication capability.
 *
 * Provision (including null to clear) and digest-bearing reads/results are
 * trusted-connection operations (Mike q-43 B). Trust belongs to the transport
 * connection, not an owner or a claimed interface kind. Today every same-user
 * local token-authenticated connection is trusted. E1 (CAN-4729) will tighten
 * designation, including designated remote connections; there is no UX here.
 */

export const CLOUD_ACCOUNT_TRUSTED_CONNECTION_GRANT =
  'core.integration.cloudAccount.trusted' as const;

/** Matches the vault's per-entry material limit with headroom for framing. */
export const CLOUD_ACCOUNT_ENTRY_MAX_BYTES = 900_000;
const EntryValueSchema = canopyJsonValueSchemaWithin(
  CLOUD_ACCOUNT_ENTRY_MAX_BYTES,
);

export const CloudAccountEntryJsonSchema = z
  .record(z.string(), EntryValueSchema)
  .refine(
    (entry) => EntryValueSchema.safeParse(entry).success,
    'The whole account entry exceeds the custody limit.',
  );

/** Canonical non-secret binding for both sides of the custody exchange. */
export function cloudAccountEndpointAuthority(endpoint: {
  readonly baseUrl: string;
  readonly wellKnownNamespace: string;
  readonly apiNamespace: string;
}): string {
  return JSON.stringify([
    new URL(endpoint.baseUrl).href.replace(/\/+$/, ''),
    endpoint.wellKnownNamespace,
    endpoint.apiNamespace,
  ]);
}

/** A whole account entry, credential included: input only. */
export const CloudAccountCustodyEntrySchema =
  CloudAccountEntryJsonSchema.refine(
    (entry) => typeof entry.apiKey === 'string' && entry.apiKey.length > 0,
    'An account entry carries its credential.',
  ).meta({ writeOnly: true });

/** The entry without its credential. */
export const CloudAccountRedactedEntrySchema =
  CloudAccountEntryJsonSchema.refine(
    (entry) => !('apiKey' in entry),
    'A redacted entry never carries the credential.',
  );

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const CLOUD_ACCOUNT_CUSTODY_STATES = [
  /** Nothing provisioned: the daemon holds no account. */
  'inactive',
  'active',
  'unavailable',
] as const;

export const CloudAccountCustodyViewSchema = z.strictObject({
  endpointAuthority: z.string().nullable(),
  state: z.enum(CLOUD_ACCOUNT_CUSTODY_STATES),
  credentialGeneration: z.number().int().min(0).nullable(),
  /** SHA-256 of the held credential; null when signed out or inactive. */
  credentialDigest: DigestSchema.nullable(),
  sessionExpired: z.boolean(),
  entry: CloudAccountRedactedEntrySchema.nullable(),
});

export type CloudAccountCustodyView = z.output<
  typeof CloudAccountCustodyViewSchema
>;

export const CoreCloudAccountProvisionParamsSchema = z.strictObject({
  /** Must match the daemon configuration; checked before any custody write. */
  endpointAuthority: z.string().nullable(),
  /** The client's current sign-in; null when it signed out. */
  entry: CloudAccountCustodyEntrySchema.nullable(),
  /**
   * The digest the client last saw this daemon hold (null for none), so two
   * clients, or two saves of one, cannot reorder: a stale provision answers
   * `superseded` with the current view and the client decides again.
   */
  expectedCredentialDigest: DigestSchema.nullable(),
  /** Custody observation fence, including clears; omitted by older clients. */
  expectedCredentialGeneration: z.number().int().nonnegative().optional(),
  /** A known client 401 is never imported as accepted verification. */
  credentialRejected: z.boolean().optional(),
});

export const CLOUD_ACCOUNT_PROVISION_STATUSES = [
  'provisioned',
  'unchanged',
  'cleared',
  'superseded',
  'invalid',
] as const;

export const CoreCloudAccountProvisionResultSchema = z.strictObject({
  status: z.enum(CLOUD_ACCOUNT_PROVISION_STATUSES),
  custody: CloudAccountCustodyViewSchema,
});

/** Inactive custody is `custodyInactive`, not an outcome. */
export const CLOUD_ACCOUNT_REFRESH_OUTCOMES = [
  'applied',
  'superseded',
  'offline',
  'forbidden',
  'unauthenticated',
  'stale-probe',
  'no-key',
  'invalid-snapshot',
  'unavailable',
] as const;

export const CoreCloudAccountRefreshResultSchema = z.strictObject({
  outcome: z.enum(CLOUD_ACCOUNT_REFRESH_OUTCOMES),
  billingStatesRefreshed: z.boolean(),
  custody: CloudAccountCustodyViewSchema,
});

export const CORE_CLOUD_ACCOUNT_CUSTODY_ERROR_CODES = [
  'core.integration.cloudAccount.custodyInactive',
  'core.integration.cloudAccount.storageUnavailable',
  'core.integration.cloudAccount.busy',
  'core.integration.cloudAccount.outcomeUnknown',
] as const;

export type CoreCloudAccountProvisionParams = z.output<
  typeof CoreCloudAccountProvisionParamsSchema
>;
export type CoreCloudAccountProvisionResult = z.output<
  typeof CoreCloudAccountProvisionResultSchema
>;
export type CoreCloudAccountRefreshResult = z.output<
  typeof CoreCloudAccountRefreshResultSchema
>;

/** Served by the daemon only; the web core has the hosted session instead. */
export const CORE_CLOUD_ACCOUNT_CUSTODY_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.integration.cloudAccount.custody.get': defineCanopyQuery({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: z.strictObject({ endpointAuthority: z.string().optional() }),
      result: CloudAccountCustodyViewSchema,
      error: inherentOperationErrorSchema(
        CORE_CLOUD_ACCOUNT_CUSTODY_ERROR_CODES,
      ),
      idempotency: 'inherent',
      requiredGrants: [
        'core.integration.read',
        CLOUD_ACCOUNT_TRUSTED_CONNECTION_GRANT,
      ],
    }),
  });

export const CORE_CLOUD_ACCOUNT_CUSTODY_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.integration.cloudAccount.provision': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: CoreCloudAccountProvisionParamsSchema,
      result: CoreCloudAccountProvisionResultSchema,
      error: inherentOperationErrorSchema(
        CORE_CLOUD_ACCOUNT_CUSTODY_ERROR_CODES,
      ),
      // A provision that may have committed is never replayed: a digest-only
      // replay is not ABA-proof and could undo a later clear or replacement.
      idempotency: 'none',
      requiredGrants: [
        'core.integration.write',
        CLOUD_ACCOUNT_TRUSTED_CONNECTION_GRANT,
      ],
    }),
    'core.integration.cloudAccount.refresh': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: z.strictObject({}),
      result: CoreCloudAccountRefreshResultSchema,
      error: inherentOperationErrorSchema(
        CORE_CLOUD_ACCOUNT_CUSTODY_ERROR_CODES,
      ),
      idempotency: 'inherent',
      requiredGrants: [
        'core.integration.write',
        CLOUD_ACCOUNT_TRUSTED_CONNECTION_GRANT,
      ],
    }),
  });
